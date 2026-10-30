// backend/routes/generator-care-cron.js
// Scheduled / cron endpoints for the Generator Care program.
// Hit by an external scheduler  -  protected by a shared secret instead of user JWT.

const crypto = require('crypto');
const express = require('express');
const { supabaseAdmin } = require('../lib/supabase');
const { sendViaBrevo } = require('../lib/mailer');
const { arrivalWindowLabel } = require('../lib/generator-catalog');
const {
  sendSms, sendMagicLoginSms, buildReminderSms, buildScheduleNudgeSms,
  buildBookingConfirmationSms, buildReviewRequestSms, withinQuietHours, smsEnabled, normalizePhone,
  logSmsMessage, SMS_TERMINAL_STATUSES,
} = require('../lib/sms');
const { isFlorida } = require('../lib/branding');
const { DASHBOARD_URL } = require('../lib/emails');
const { reportError } = require('../middleware/error-reporter');
const { sweepOwnerAlerts, listNeedingReplyForDigest, isOfficeMode, TEXTS_TAB_URL } = require('../lib/smsConversations');
const { closeStaleHeldTexts } = require('../lib/heldTexts');

const router = express.Router();

const CRON_SECRET = process.env.CRON_SECRET;
const FROM_EMAIL = process.env.GENERATOR_DIGEST_FROM || 'no-reply@bates-electric.com';
const TO_EMAILS = (process.env.GENERATOR_DIGEST_TO || 'cjbates@bates-electric.com,generators@bates-electric.com')
 .split(',').map(s => s.trim()).filter(Boolean);

// Healthchecks.io dead-man's-switch ping. Fire-and-forget: never awaited, never
// throws, never affects the cron response. If HEALTHCHECKS_URL is unset it's a
// no-op. Hitting the base URL signals success; "<url>/fail" signals a crash so
// Healthchecks alerts CJ. Set HEALTHCHECKS_URL in Render after creating the check.
function pingHealthcheck(suffix = '') {
  const base = process.env.HEALTHCHECKS_URL;
  if (!base) return;
  const url = base.replace(/\/$/, '') + suffix;
  // Node 18+ global fetch. Swallow everything -- this is a pure side channel.
  Promise.resolve()
    .then(() => fetch(url, { method: 'GET' }))
    .catch((e) => console.error('[gc-cron] healthcheck ping failed:', e && e.message));
}

// Constant-time secret compare (avoids leaking the secret via response timing).
// Length-guarded because timingSafeEqual throws on unequal-length buffers.
function secretsMatch(provided, expected) {
  const a = Buffer.from(String(provided == null ? '' : provided));
  const b = Buffer.from(String(expected == null ? '' : expected));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// Bearer-token auth for cron endpoints
function requireCronSecret(req, res, next) {
 if (!CRON_SECRET) return res.status(500).json({ error: 'CRON_SECRET not configured on server' });
 const header = req.headers.authorization || '';
 const token = header.startsWith('Bearer ') ? header.slice(7) : '';
 if (!secretsMatch(token, CRON_SECRET)) return res.status(401).json({ error: 'Invalid cron secret' });
 next();
}

// POST /api/cron/generator-care/daily-email
// Sends Amy + CJ a summary of service visits due in the next 14 days plus any overdue.
router.post('/daily-email', requireCronSecret, async (req, res) => {
 // Opportunistic hygiene riding the daily trigger: purge SMS auto-login
 // shortlinks (sql/028) a day past expiry. Rows are inert once used/expired,
 // so a failed purge must never touch the digest — own try/catch, no rethrow.
 try {
   const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
   const { error: purgeErr } = await supabaseAdmin
     .from('generator_magic_shortlinks')
     .delete()
     .lt('expires_at', cutoff);
   if (purgeErr) console.error('[gc-cron] shortlink purge failed:', purgeErr.message);
 } catch (e) {
   console.error('[gc-cron] shortlink purge failed:', e && e.message);
 }
 try {
 const today = new Date();
 today.setHours(0, 0, 0, 0);
 const horizon = new Date(today);
 horizon.setDate(horizon.getDate() + 14);
 const horizonStr = horizon.toISOString().slice(0, 10);

 // Pull every active subscription with next_visit_due in the next 14 days OR overdue
 const { data: subs, error } = await supabaseAdmin
 .from('generator_subscriptions')
 .select(`
 id, plan, gen_class, gen_model, gen_serial,
 fleet_monitoring, next_visit_due, last_visit_date, status,
 customer:generator_customers(name, phone, email, install_address, install_city, install_state, install_zip)
 `)
 .eq('status', 'active')
 .lte('next_visit_due', horizonStr)
 .order('next_visit_due', { ascending: true });
 if (error) throw error;

 const overdue = [];
 const upcoming = [];
 const todayStr = today.toISOString().slice(0, 10);
 for (const s of subs || []) {
 if (!s.next_visit_due) continue;
 if (s.next_visit_due < todayStr) overdue.push(s);
 else upcoming.push(s);
 }

    // Look up open (tentative/scheduled) visits for BOTH groups: upcoming subs
    // split tentative vs confirmed and carry the booked appointment; passed-due
    // subs split "needs scheduling" vs "awaiting completion" from the same rows.
    const lookupSubIds = overdue.concat(upcoming).map(s => s.id);
    const statusBySubId = {};
    const bookedBySubId = {};
    const visitsBySubId = {};
    if (lookupSubIds.length > 0) {
      const { data: visits } = await supabaseAdmin
        .from('generator_service_visits')
        .select('subscription_id, status, appointment_at, arrival_window')
        .in('subscription_id', lookupSubIds)
        .in('status', ['tentative', 'scheduled']);
      for (const v of (visits || [])) {
        (visitsBySubId[v.subscription_id] = visitsBySubId[v.subscription_id] || []).push(v);
        if (!statusBySubId[v.subscription_id]) statusBySubId[v.subscription_id] = v.status;
        if (!bookedBySubId[v.subscription_id] && v.status === 'scheduled' && v.appointment_at) {
          bookedBySubId[v.subscription_id] = { appointment_at: v.appointment_at, arrival_window: v.arrival_window };
        }
      }
    }
    const upcomingTentative = upcoming.filter(s => statusBySubId[s.id] === 'tentative');
    const upcomingConfirmed = upcoming.filter(s => statusBySubId[s.id] !== 'tentative');

    // A passed due date means two very different things depending on whether a
    // visit is on the books — split so red stays meaningful.
    const { needsScheduling, awaiting } = splitOverdue({ overdue, visitsBySubId, now: new Date() });

 // Also pull any failed addon charges + failed adhoc charges so we can surface them.
 // AND any past_due subscriptions (renewal charge failed; Stripe is retrying or
 // has given up). Without surfacing these here they disappear from Amy's view
 // entirely because the upcoming/overdue queries above filter status='active'.
    const [failedAddonsR, failedAdhocR, pastDueR] = await Promise.all([
      supabaseAdmin
        .from('generator_pending_addons')
        .select('id, addon_type, amount_cents, notes, subscription:generator_subscriptions(customer:generator_customers(name, phone))')
        .eq('status', 'failed')
        .order('created_at', { ascending: false }),
      supabaseAdmin
        .from('generator_adhoc_charges')
        .select('id, description, amount_cents, notes, subscription:generator_subscriptions(customer:generator_customers(name, phone))')
        .eq('status', 'failed')
        .order('created_at', { ascending: false }),
      supabaseAdmin
        .from('generator_subscriptions')
        .select('id, plan, gen_class, gen_model, annual_price_cents, customer:generator_customers(name, phone, email)')
        .eq('status', 'past_due')
        .order('next_visit_due', { ascending: true }),
    ]);
    const failedAddons = failedAddonsR.data || [];
    const failedAdhoc = failedAdhocR.data || [];
    const pastDue = pastDueR.data || [];
    const failedTotal = failedAddons.length + failedAdhoc.length;

    // Texts a person still has to answer (customer texted, nothing has
    // answered for 2+ hours - sql/037). Its own try/catch: the inbox tables
    // must never be able to take the digest down.
    let textsNeedingReply = [];
    try {
      textsNeedingReply = await listNeedingReplyForDigest({ now: new Date() });
    } catch (e) {
      console.error('[gc-cron] texts-needing-reply lookup failed (digest continues):', e && e.message);
    }

    // Booked within 2 days and not confirmed by text (Y) or by phone (038):
    // an office prompt to call. Own try/catch, same reason as above.
    let notConfirmed = [];
    try {
      notConfirmed = await listUnconfirmedSoon({ now: new Date() });
    } catch (e) {
      console.error('[gc-cron] not-confirmed lookup failed (digest continues):', e && e.message);
    }

    // The digest must go out EVERY day. Amy's runbook treats a missing email as
    // an outage signal, so on a genuinely quiet day we still send — just a short
    // "all quiet" note instead of suppressing the email entirely. overdue here
    // is the WHOLE passed-due set (needsScheduling + awaiting), so a day with
    // only awaiting-completion items still sends a full digest.
    const isQuiet = overdue.length === 0 && upcoming.length === 0 && failedTotal === 0 && pastDue.length === 0 && textsNeedingReply.length === 0 && notConfirmed.length === 0;

    const { subject, html, text } = isQuiet
      ? buildQuietEmail({ todayStr })
      : buildEmail({ needsScheduling, awaiting, upcoming, upcomingTentative, upcomingConfirmed, bookedBySubId, failedAddons, failedAdhoc, pastDue, textsNeedingReply, notConfirmed, todayStr });

 // Send via Brevo. A missing BREVO_API_KEY or a provider error throws below ->
 // caught -> 500 + Healthchecks '/fail' ping, so we hear about it.
 const sendResult = await sendViaBrevo({
 to: TO_EMAILS,
 senderEmail: FROM_EMAIL,
 senderName: 'Bates Electric Generator Care',
 subject,
 html,
 text,
 log: { kind: 'daily-digest' },
 });
 if (!sendResult.sent) throw new Error('digest send failed: ' + sendResult.reason);

 // Digest sent successfully -- signal the dead-man's switch.
 pingHealthcheck();

 res.json({ ok: true, sent: true, quiet: isQuiet, recipients: TO_EMAILS, overdue: overdue.length, needs_scheduling: needsScheduling.length, awaiting_completion: awaiting.length, upcoming: upcoming.length, upcoming_tentative: upcomingTentative.length, upcoming_confirmed: upcomingConfirmed.length, failed_addons: failedAddons.length, failed_adhoc: failedAdhoc.length, past_due: pastDue.length, texts_needing_reply: textsNeedingReply.length, not_confirmed: notConfirmed.length });
 } catch (err) {
 // Signal failure to Healthchecks first so we hear about a crashed cron.
 pingHealthcheck('/fail');
 console.error('[gc-cron] daily-email error:', err && (err.response?.body || err.message));
 reportError(err, { route: '/api/cron/generator-care/daily-email', method: 'POST', user: 'gc-cron' }).catch(() => {});
 res.status(500).json({ error: 'Server error' });
 }
});

// ============================================================================
// SMS appointment reminders (Phase 2) + retry sweeps for every queued
// customer text (035).
//
// POST /api/cron/generator-care/sms-reminders — designed for an HOURLY
// trigger (e.g. minute 15 of every hour). The endpoint self-guards: outside
// the 8am-9pm Central quiet-hours window it does nothing and says so, and
// while the SMS_ENABLED kill-switch is off it only records the day's
// reminder debts (queue marks — nothing sent, nothing logged), instead of
// letting every owed message log an hourly refusal. That guard is also why the trigger's
// exact firing time no longer matters: the old single daily ~8am trigger
// depended on landing inside the window — a couple of minutes of scheduler
// jitter (7:58) used to refuse EVERY reminder that day with no recovery.
// Hourly runs mean the first in-window run (~8:15am) does the day's work and
// later runs drain anything refused transiently since. A daily trigger still
// works, just with day-long retry latency — if kept daily, fire it at 9am so
// jitter can't push it outside the window.
//
// Two date-anchored passes (visits whose appointment is 3 days out / today)
// initiate reminders, then three sweeps retry what's still owed: queued
// booking confirmations (queued by routes/generator-care/visits.js at
// booking time), queued reminders, and the Phase 3 schedule nudge. Read-only
// except the per-visit stamp columns (026/027/035) — nothing here ever
// touches the appointment itself.
//
// Idempotency: every sender stamps its sent column ONLY on a TERMINAL
// sendSms result — 'sent', or the permanent refusals 'no_consent' /
// 'opted_out' / 'invalid_phone' (SMS_TERMINAL_STATUSES in lib/sms.js).
// Transient outcomes ('disabled' kill-switch, 'quiet_hours', 'failed') leave
// the sent column null so a later run retries; selection always requires the
// sent column to be null, so a stamped message can never send twice. Every
// attempt, refusals included, is already logged to generator_sms_messages by
// sendSms — never pre-filter consent here.
//
// Staleness: a retried message must still be TRUE when it finally sends. The
// sweeps drop (stamp + log a 'stale' generator_sms_messages row, so the
// office can see it) anything whose moment has passed instead of sending it
// late — the rules live on each sweep below.
// ============================================================================

const REMINDER_TERMINAL_STATUSES = SMS_TERMINAL_STATUSES;

// A calendar date in Central time, as 'YYYY-MM-DD' (en-CA renders ISO order).
function centralDateStr(d) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

// 'YYYY-MM-DD' + n days -> 'YYYY-MM-DD'. Noon-UTC parse dodges date rolls.
function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Central hour (0-23) of an instant.
function centralHour(d) {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: 'numeric', hour12: false }).format(d)) % 24;
}
// A Central wall-clock time on a Central date, as a UTC ISO instant
// ('2026-10-27' + '18:00' -> '2026-10-27T23:00:00.000Z' in CDT). Reads the
// zone offset in force on that date, so DST is handled by Intl, not by us.
function centralTimeToIso(dateStr, hhmm) {
  const probe = new Date(dateStr + 'T12:00:00Z');
  const off = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', timeZoneName: 'longOffset' })
    .formatToParts(probe).find((p) => p.type === 'timeZoneName').value; // 'GMT-05:00'
  const m = off.match(/([+-])(\d{2}):(\d{2})/);
  const offset = m ? m[1] + m[2] + ':' + m[3] : '-06:00';
  return new Date(dateStr + 'T' + hhmm + ':00' + offset).toISOString();
}

// Evening-before reminder (038): runs from EVE_HOUR Central for TOMORROW's
// visits. Review requests (038): from REVIEW_HOUR for visits completed
// yesterday. Both ride the hourly sms-reminders trigger.
const EVE_HOUR = Number(process.env.SMS_EVE_REMINDER_HOUR) || 18;
const REVIEW_HOUR = Number(process.env.SMS_REVIEW_HOUR) || 10;

// One reminder pass: every scheduled, unstamped visit whose appointment falls
// on targetDateStr IN CENTRAL TIME. appointment_at is a timestamptz, so the
// query grabs a UTC superset ([target-1d, target+2d) covers every instant
// that could render as the target Central date) and the exact Central-date
// match happens in JS — same Intl clock the rest of the app uses.
//
// queueColumn (035): stamped just before the attempt, marking "this visit
// was owed this reminder" — that mark is what lets runReminderRetryPass
// re-select the visit after its target day, when this date-anchored query no
// longer can. Only stamped when a send is (or would be) attempted: a visit
// with no phone stays unqueued (nothing is owed until a phone exists — and
// this pass still re-considers it while the target date holds).
//
// queueOnly: plant the queue marks and send NOTHING (no wire, no log rows).
// Used while the SMS_ENABLED kill-switch is off — the debt must still be
// recorded on the target day, or a reminder whose whole target day fell
// inside a disabled window would be silently lost when the switch comes
// back (this date-anchored query can't re-find it later; only the queue
// mark can).
// isTomorrow: the evening-before copy. lateBookingCutoff (ISO): a visit
// booked at/after this instant (scheduled_at) is NOT sent the reminder - the
// booking confirmation it just got covers it - and is settled on record.
async function runReminderPass({ targetDateStr, stampColumn, queueColumn, isToday, isTomorrow, queueOnly, lateBookingCutoff, now }) {
  const summary = { considered: 0, sent: 0, skipped: 0 };
  const { data: visits, error } = await supabaseAdmin
    .from('generator_service_visits')
    .select('id, appointment_at, arrival_window, sms_confirmed_at, scheduled_at, ' + queueColumn + ', subscription:generator_subscriptions(customer:generator_customers(id, name, phone, install_state))')
    .eq('status', 'scheduled')
    .is(stampColumn, null)
    .not('appointment_at', 'is', null)
    .gte('appointment_at', addDays(targetDateStr, -1) + 'T00:00:00Z')
    .lt('appointment_at', addDays(targetDateStr, 2) + 'T00:00:00Z');
  if (error) throw error;

  for (const v of visits || []) {
    if (centralDateStr(new Date(v.appointment_at)) !== targetDateStr) continue;
    summary.considered++;

    const customer = (v.subscription && v.subscription.customer) || null;
    if (!customer || !customer.phone) { summary.skipped++; continue; }

    // Booked after the evening cutoff (or on the day): the confirmation text
    // they just received is the reminder. Settle the debt on record.
    if (lateBookingCutoff && v.scheduled_at && v.scheduled_at >= lateBookingCutoff) {
      const dropped = await dropStaleQueuedSms({
        visitId: v.id,
        sentPatch: { [stampColumn]: (now || new Date()).toISOString() },
        customer,
        body: buildReminderSms({ installState: customer.install_state, dateStr: targetDateStr, windowCode: v.arrival_window, link: DASHBOARD_URL, confirmed: !!v.sms_confirmed_at, isToday, isTomorrow }),
        detail: 'evening reminder skipped: booked after 6 PM the day before - the booking confirmation covers it',
      });
      summary.late_booked = (summary.late_booked || 0) + (dropped ? 1 : 0);
      if (!dropped) summary.skipped++;
      continue;
    }

    // Queue BEFORE attempting (same rule as the nudge webhook): a process
    // death mid-send, or a transient refusal below, leaves the debt on
    // record for the retry sweep. A failed queue stamp (e.g. 035 not applied
    // yet) doesn't block the attempt — loud, because a transient refusal
    // would then be lost like pre-035.
    if (!v[queueColumn]) {
      const { error: queueErr } = await supabaseAdmin
        .from('generator_service_visits')
        .update({ [queueColumn]: (now || new Date()).toISOString() })
        .eq('id', v.id);
      if (queueErr) {
        console.error('[gc-cron] reminder queue stamp failed for visit ' + v.id + ':', queueErr.message);
        reportError(new Error('sms reminder queue stamp failed for visit ' + v.id + ': ' + queueErr.message), { route: '/api/cron/generator-care/sms-reminders' }).catch(() => {});
      }
    }

    if (queueOnly) { summary.skipped++; continue; }

    // sendSms owns every gate (consent, SMS_ENABLED, quiet hours) and logs
    // the attempt either way — the pass just builds the copy and reads the
    // verdict. Sequential on purpose: volume is tiny and it keeps the
    // stamp-after-send ordering obvious.
    const result = await sendSms({
      toPhone: customer.phone,
      body: buildReminderSms({
        installState: customer.install_state,
        dateStr: targetDateStr,
        windowCode: v.arrival_window,
        link: DASHBOARD_URL,
        confirmed: !!v.sms_confirmed_at,
        isToday,
        isTomorrow,
      }),
      customerId: customer.id,
      relatedVisitId: v.id,
      now,
    });
    if (result.status === 'sent') summary.sent++; else summary.skipped++;

    if (REMINDER_TERMINAL_STATUSES.includes(result.status)) {
      const { error: stampErr } = await supabaseAdmin
        .from('generator_service_visits')
        .update({ [stampColumn]: (now || new Date()).toISOString() })
        .eq('id', v.id);
      // A failed stamp risks a duplicate text tomorrow — make it loud.
      if (stampErr) {
        console.error('[gc-cron] reminder stamp failed for visit ' + v.id + ':', stampErr.message);
        reportError(new Error('sms reminder stamp failed for visit ' + v.id + ': ' + stampErr.message), { route: '/api/cron/generator-care/sms-reminders' }).catch(() => {});
      }
    }
  }
  return summary;
}

// Drop a queued message whose moment has passed: stamp its sent column (the
// debt is settled — by a decision, not a send) and log a 'stale' row to
// generator_sms_messages so the office can see in the customer's text thread
// WHY nothing went out. Stamp first: if the stamp fails, the sweep simply
// re-evaluates (and re-drops) next run — it can never send the stale text.
// Returns whether the drop stuck.
async function dropStaleQueuedSms({ visitId, sentPatch, customer, body, detail }) {
  const { error: stampErr } = await supabaseAdmin
    .from('generator_service_visits')
    .update(sentPatch)
    .eq('id', visitId);
  if (stampErr) {
    console.error('[gc-cron] stale-drop stamp failed for visit ' + visitId + ':', stampErr.message);
    reportError(new Error('stale-drop stamp failed for visit ' + visitId + ': ' + stampErr.message), { route: '/api/cron/generator-care/sms-reminders' }).catch(() => {});
    return false;
  }
  const rawPhone = (customer && customer.phone) || '';
  await logSmsMessage({
    direction: 'out',
    to_phone: normalizePhone(rawPhone) || String(rawPhone).slice(0, 30),
    from_phone: normalizePhone(process.env.SIMPLETEXTING_ACCOUNT_PHONE) || null,
    body,
    status: 'stale',
    detail,
    customer_id: (customer && customer.id) || null,
    related_visit_id: visitId,
  });
  return true;
}

// Booking-confirmation retry sweep (035). The office schedule endpoint
// queues a confirmation at booking time and attempts it fire-and-forget; a
// transient refusal (the live failure: a 7:58am booking refused by quiet
// hours) lands here. Staleness rule: a confirmation is meaningful up to and
// including the APPOINTMENT DAY, for a visit still on the books — the copy
// ("your visit is set for Tue Sep 1... Reply Y") is date-based and stays
// true right up to the visit. Once the day has passed, or the visit is no
// longer scheduled (canceled / completed / appointment cleared), it's
// dropped on record instead of sent late.
//
// The in-flight buffer exists because the booking endpoint's send is
// fire-and-forget: a booking made seconds before this sweep runs could have
// its send still on the wire (sent stamp pending). Skipping anything queued
// inside the buffer means the sweep can never race a just-made booking into
// a duplicate text; a genuinely refused one is picked up the following run.
const BOOKING_CONFIRM_INFLIGHT_BUFFER_MS = 2 * 60 * 1000;

async function runBookingConfirmRetryPass({ now }) {
  const summary = { considered: 0, sent: 0, skipped: 0, stale: 0 };
  const clock = now || new Date();
  const todayCentral = centralDateStr(clock);
  const inflightCutoff = new Date(clock.getTime() - BOOKING_CONFIRM_INFLIGHT_BUFFER_MS).toISOString();
  const { data: visits, error } = await supabaseAdmin
    .from('generator_service_visits')
    .select('id, status, appointment_at, arrival_window, booking_confirm_queued_at, subscription:generator_subscriptions(customer:generator_customers(id, name, phone, install_state))')
    .not('booking_confirm_queued_at', 'is', null)
    .is('booking_confirm_sent_at', null)
    .lt('booking_confirm_queued_at', inflightCutoff);
  if (error) throw error;

  for (const v of visits || []) {
    summary.considered++;
    const customer = (v.subscription && v.subscription.customer) || null;
    if (!customer || !customer.phone) { summary.skipped++; continue; }

    const apptDate = v.appointment_at ? centralDateStr(new Date(v.appointment_at)) : null;
    const body = buildBookingConfirmationSms({
      name: customer.name,
      installState: customer.install_state,
      dateStr: apptDate,
      windowCode: v.arrival_window,
      link: DASHBOARD_URL,
    });

    if (v.status !== 'scheduled' || !apptDate || apptDate < todayCentral) {
      const why = v.status !== 'scheduled'
        ? 'the visit is now ' + v.status
        : (!apptDate ? 'the appointment was cleared' : 'the appointment day (' + apptDate + ') passed');
      const dropped = await dropStaleQueuedSms({
        visitId: v.id,
        sentPatch: { booking_confirm_sent_at: clock.toISOString() },
        customer,
        body,
        detail: 'booking confirmation dropped as stale: ' + why + ' before it could send (queued ' + v.booking_confirm_queued_at + ')',
      });
      if (dropped) summary.stale++; else summary.skipped++;
      continue;
    }

    const result = await sendSms({
      toPhone: customer.phone,
      body,
      customerId: customer.id,
      relatedVisitId: v.id,
      now,
    });
    if (result.status === 'sent') summary.sent++; else summary.skipped++;

    if (SMS_TERMINAL_STATUSES.includes(result.status)) {
      const { error: stampErr } = await supabaseAdmin
        .from('generator_service_visits')
        .update({ booking_confirm_sent_at: (now || new Date()).toISOString() })
        .eq('id', v.id);
      // A failed stamp risks a duplicate text next run — make it loud.
      if (stampErr) {
        console.error('[gc-cron] booking confirm stamp failed for visit ' + v.id + ':', stampErr.message);
        reportError(new Error('booking confirm stamp failed for visit ' + v.id + ': ' + stampErr.message), { route: '/api/cron/generator-care/sms-reminders' }).catch(() => {});
      }
    }
  }
  return summary;
}

// Reminder retry sweep (035), one call per reminder kind. Selects by the
// queue mark instead of the target date — the fix for the old gap where a
// transiently refused reminder was never selected again because the next
// day's pass targets a different date. The DAILY pass still owns the target
// day itself (hourly runs re-attempt through it, since selection is by
// null sent-stamp) — this sweep deliberately skips target-day visits so one
// run never attempts the same reminder twice. Its jobs are the days AFTER:
//
//   3-day: retry while the appointment is still strictly in the future and
//     under 3 days out. The copy is date-based ("is on Tue Sep 3"), so it
//     stays true right up to the appointment day; a late 3-day reminder is
//     an accurate heads-up, better than the silence Kenneth got. Once the
//     appointment day arrives, the day-of reminder owns the messaging —
//     drop as stale, on record.
//   day-of: nothing to retry (the daily pass covers the whole target day,
//     hourly); drop as stale once the appointment day has passed.
//
//   Both: if the appointment was RESCHEDULED to a farther-out day, the old
//     queue mark no longer describes a real debt — clear it (re-arm) and let
//     the date-anchored pass re-initiate on the right day.
async function runReminderRetryPass({ kind, now }) {
  const cfg = kind === '3day'
    ? { queueColumn: 'sms_reminder_3day_queued_at', stampColumn: 'sms_reminder_3day_at', label: '3-day reminder' }
    : kind === 'eve'
      ? { queueColumn: 'sms_reminder_eve_queued_at', stampColumn: 'sms_reminder_eve_at', label: 'evening reminder' }
      : { queueColumn: 'sms_reminder_dayof_queued_at', stampColumn: 'sms_reminder_dayof_at', label: 'day-of reminder' };
  // The day the date-anchored pass owns; past it the debt is settled here.
  const horizon = kind === '3day' ? addDays(centralDateStr(now || new Date()), 3)
    : kind === 'eve' ? addDays(centralDateStr(now || new Date()), 1)
      : centralDateStr(now || new Date());
  const summary = { considered: 0, sent: 0, skipped: 0, stale: 0, rearmed: 0 };
  const clock = now || new Date();
  const todayCentral = centralDateStr(clock);
  const { data: visits, error } = await supabaseAdmin
    .from('generator_service_visits')
    .select('id, appointment_at, arrival_window, sms_confirmed_at, ' + cfg.queueColumn + ', subscription:generator_subscriptions(customer:generator_customers(id, name, phone, install_state))')
    .eq('status', 'scheduled')
    .not(cfg.queueColumn, 'is', null)
    .is(cfg.stampColumn, null)
    .not('appointment_at', 'is', null);
  if (error) throw error;

  for (const v of visits || []) {
    const apptDate = centralDateStr(new Date(v.appointment_at));
    const isTargetDay = apptDate === horizon;
    if (isTargetDay) continue; // the daily pass owns the target day

    summary.considered++;
    const customer = (v.subscription && v.subscription.customer) || null;
    if (!customer || !customer.phone) { summary.skipped++; continue; }

    // Rescheduled outward: not stale, just no longer owed for the old day.
    if (apptDate > todayCentral && apptDate > horizon) {
      const { error: rearmErr } = await supabaseAdmin
        .from('generator_service_visits')
        .update({ [cfg.queueColumn]: null })
        .eq('id', v.id);
      if (rearmErr) {
        console.error('[gc-cron] reminder re-arm failed for visit ' + v.id + ':', rearmErr.message);
        reportError(new Error('reminder re-arm failed for visit ' + v.id + ': ' + rearmErr.message), { route: '/api/cron/generator-care/sms-reminders' }).catch(() => {});
        summary.skipped++;
      } else {
        summary.rearmed++;
      }
      continue;
    }

    const body = buildReminderSms({
      installState: customer.install_state,
      dateStr: apptDate,
      windowCode: v.arrival_window,
      link: DASHBOARD_URL,
      confirmed: !!v.sms_confirmed_at,
      isToday: false,
      isTomorrow: kind === 'eve',
    });

    if (apptDate <= todayCentral) {
      const why = apptDate < todayCentral
        ? 'the appointment day (' + apptDate + ') passed'
        : (kind === 'eve' ? 'the appointment day arrived before it could send' : 'the appointment is today - the day-of reminder covers it');
      const dropped = await dropStaleQueuedSms({
        visitId: v.id,
        sentPatch: { [cfg.stampColumn]: clock.toISOString() },
        customer,
        body,
        detail: cfg.label + ' dropped as stale: ' + why + ' before it could send (queued ' + v[cfg.queueColumn] + ')',
      });
      if (dropped) summary.stale++; else summary.skipped++;
      continue;
    }

    // Still owed and still true: appointment strictly in the future, under
    // 3 days out (3-day kind only reaches here).
    const result = await sendSms({
      toPhone: customer.phone,
      body,
      customerId: customer.id,
      relatedVisitId: v.id,
      now,
    });
    if (result.status === 'sent') summary.sent++; else summary.skipped++;

    if (SMS_TERMINAL_STATUSES.includes(result.status)) {
      const { error: stampErr } = await supabaseAdmin
        .from('generator_service_visits')
        .update({ [cfg.stampColumn]: (now || new Date()).toISOString() })
        .eq('id', v.id);
      // A failed stamp risks a duplicate text next run — make it loud.
      if (stampErr) {
        console.error('[gc-cron] reminder retry stamp failed for visit ' + v.id + ':', stampErr.message);
        reportError(new Error('reminder retry stamp failed for visit ' + v.id + ': ' + stampErr.message), { route: '/api/cron/generator-care/sms-reminders' }).catch(() => {});
      }
    }
  }
  return summary;
}

// Phase 3 schedule-nudge retry sweep. The invoice.upcoming webhook QUEUES a
// nudge on the cycle's open visit (schedule_nudge_queued_at, sql/027) and
// attempts the send immediately, but that event fires once per cycle at
// whatever hour Stripe picks — a quiet-hours or kill-switch refusal there has
// no redelivery to lean on. This pass, riding the same sms-reminders trigger
// as the reminders (which only does work inside quiet hours by design),
// re-attempts every visit still queued-but-unsent: a fresh single-use auto-login link is minted per attempt
// (sendMagicLoginSms — the raw link never reaches a log), and
// schedule_nudge_sent_at is stamped on the same TERMINAL statuses as the
// reminder passes so permanent refusals drain from the queue while transient
// ones ('disabled', 'failed') retry the next day.
async function runNudgeRetryPass({ now }) {
  const summary = { considered: 0, sent: 0, skipped: 0 };
  const { data: visits, error } = await supabaseAdmin
    .from('generator_service_visits')
    .select('id, scheduled_date, subscription:generator_subscriptions(status, customer:generator_customers(id, name, email, phone, install_state))')
    .not('schedule_nudge_queued_at', 'is', null)
    .is('schedule_nudge_sent_at', null)
    .is('completed_date', null)
    .neq('status', 'canceled');
  if (error) throw error;

  for (const v of visits || []) {
    summary.considered++;
    // A subscription canceled after its nudge was queued must not be texted
    // "time to schedule" — skip, leaving the queue mark (harmless once the
    // visit is canceled/completed by the cancellation flow).
    if (v.subscription && v.subscription.status === 'canceled') { summary.skipped++; continue; }
    const customer = (v.subscription && v.subscription.customer) || null;
    // generateLink needs the account email; a customer without one can't get
    // an auto-login link — leave the visit queued and skip (Amy still sees
    // the cycle through the existing digest/dashboard).
    if (!customer || !customer.email) { summary.skipped++; continue; }

    const year = v.scheduled_date ? Number(String(v.scheduled_date).slice(0, 4)) : null;
    const result = await sendMagicLoginSms({
      customerId: customer.id,
      phone: customer.phone,
      email: customer.email,
      relatedVisitId: v.id,
      buildBody: (link) => buildScheduleNudgeSms({ installState: customer.install_state, year, link }),
      now,
    });
    if (result.status === 'sent') summary.sent++; else summary.skipped++;

    if (REMINDER_TERMINAL_STATUSES.includes(result.status)) {
      const { error: stampErr } = await supabaseAdmin
        .from('generator_service_visits')
        .update({ schedule_nudge_sent_at: (now || new Date()).toISOString() })
        .eq('id', v.id);
      // A failed stamp risks a duplicate text tomorrow — make it loud.
      if (stampErr) {
        console.error('[gc-cron] nudge stamp failed for visit ' + v.id + ':', stampErr.message);
        reportError(new Error('schedule nudge stamp failed for visit ' + v.id + ': ' + stampErr.message), { route: '/api/cron/generator-care/sms-reminders' }).catch(() => {});
      }
    }
  }
  return summary;
}

// POST /api/cron/generator-care/sms-reminders
// No Healthchecks ping here — HEALTHCHECKS_URL is the daily digest's
// dead-man's switch; pinging it from a second cron would mask digest outages.
router.post('/sms-reminders', requireCronSecret, async (req, res) => {
  try {
    const now = new Date();
    const todayCentral = centralDateStr(now);

    // Office-mode owner alerts (sql/037) are EMAILS, not texts, so they run
    // before the quiet-hours / kill-switch guards: this is the durable
    // backstop for the in-process 10-minute timer (lost on a restart).
    const ownerAlerts = await sweepOwnerAlerts({ now });
    // Held texts that can never go out get a terminal status (lib/heldTexts.js).
    // DB only, so it runs every hour regardless of quiet hours / kill-switch -
    // which also made it the one-time cleanup of rows held before it shipped.
    const heldClosed = await closeStaleHeldTexts({ now });
    const held = { checked: heldClosed.checked, dropped: heldClosed.dropped, released: heldClosed.released };

    // Hourly-trigger guards. Outside quiet hours nothing may send — skip
    // outright rather than write an hourly quiet_hours refusal row for
    // every owed message; the debts (queue marks) already exist and the
    // first in-window run drains them. (Booking-time attempts still log
    // their refusal rows — the would-have-sent trail lives there.)
    if (!withinQuietHours(now)) {
      return res.json({ ok: true, date: todayCentral, skipped: 'outside_quiet_hours', owner_alerts: ownerAlerts, held });
    }
    // Kill-switch off: nothing may send either, but the day's reminder
    // debts must still be RECORDED — the date-anchored passes can't select
    // a visit after its target day, so skipping outright would silently
    // lose any reminder whose whole target day fell inside a disabled
    // window. Plant the queue marks (no sends, no log rows); when the
    // switch comes back on, the retry sweeps drain what's still true and
    // stale-drop the rest, on record. Booking confirmations and nudges
    // queue at their own trigger points, so they need nothing here.
    const eveDue = centralHour(now) >= EVE_HOUR;
    const eveArgs = {
      targetDateStr: addDays(todayCentral, 1), stampColumn: 'sms_reminder_eve_at', queueColumn: 'sms_reminder_eve_queued_at',
      isTomorrow: true, lateBookingCutoff: centralTimeToIso(todayCentral, '18:00'), now,
    };
    if (!smsEnabled()) {
      const threeDayQueued = await runReminderPass({
        targetDateStr: addDays(todayCentral, 3), stampColumn: 'sms_reminder_3day_at', queueColumn: 'sms_reminder_3day_queued_at', isToday: false, queueOnly: true, now,
      });
      const eveQueued = eveDue ? await runReminderPass({ ...eveArgs, queueOnly: true }) : { skipped: 'before_' + EVE_HOUR };
      return res.json({ ok: true, date: todayCentral, skipped: 'sms_disabled', three_day_queued: threeDayQueued, eve_queued: eveQueued, owner_alerts: ownerAlerts, held });
    }

    // Confirmations first (a booking's "it's set" should precede any
    // reminder about it), then the date-anchored reminder passes, then the
    // sweeps for anything those passes can no longer select.
    const bookingConfirmRetry = await runBookingConfirmRetryPass({ now });
    const threeDay = await runReminderPass({
      targetDateStr: addDays(todayCentral, 3), stampColumn: 'sms_reminder_3day_at', queueColumn: 'sms_reminder_3day_queued_at', isToday: false, now,
    });
    // The final reminder goes the EVENING BEFORE (038) - the morning-of pass
    // is retired: a 7-9 AM window got its reminder after the window started.
    const eve = eveDue ? await runReminderPass(eveArgs) : { skipped: 'before_' + EVE_HOUR };
    const threeDayRetry = await runReminderRetryPass({ kind: '3day', now });
    const eveRetry = await runReminderRetryPass({ kind: 'eve', now });
    const nudgeRetry = await runNudgeRetryPass({ now });
    const review = await runReviewRequestPass({ now });
    res.json({
      ok: true, date: todayCentral, three_day: threeDay, eve,
      three_day_retry: threeDayRetry, eve_retry: eveRetry,
      booking_confirm_retry: bookingConfirmRetry, nudge_retry: nudgeRetry, owner_alerts: ownerAlerts, review, held,
    });
  } catch (err) {
    console.error('[gc-cron] sms-reminders error:', err && err.message);
    reportError(err, { route: '/api/cron/generator-care/sms-reminders', method: 'POST', user: 'gc-cron' }).catch(() => {});
    res.status(500).json({ error: 'Server error' });
  }
});

// Helpers --------------------------------------------------

// Split passed-due subscriptions by what their OPEN visits (tentative/scheduled)
// say, not by next_visit_due alone:
//   needsScheduling — no dated open visit at all. The customer is actually
//     falling through the cracks; this keeps the red, urgent treatment.
//     NOTE: completing a visit auto-creates a tentative placeholder with a NULL
//     appointment_at for the next cycle — a NULL-dated visit never counts as
//     covering a passed due date, so those land here too.
//   awaiting — a dated open visit exists. Either its appointment already passed
//     (tech was there, record just isn't closed — paperwork lag) or it's booked
//     for a future date (e.g. rescheduled past the due date). Both are handled;
//     amber, not red. Each entry: { sub, visit, futureBooked }. When both a
//     stale past visit and a future rebooked one exist, the future one is shown
//     (the sub stays in this bucket until a completion advances the due date).
function splitOverdue({ overdue, visitsBySubId, now }) {
  const needsScheduling = [];
  const awaiting = [];
  const nowMs = now.getTime();
  for (const s of overdue) {
    const dated = (visitsBySubId[s.id] || []).filter(v => v.appointment_at);
    if (!dated.length) { needsScheduling.push(s); continue; }
    const future = dated
      .filter(v => new Date(v.appointment_at).getTime() > nowMs)
      .sort((a, b) => new Date(a.appointment_at) - new Date(b.appointment_at))[0];
    const past = dated
      .filter(v => new Date(v.appointment_at).getTime() <= nowMs)
      .sort((a, b) => new Date(b.appointment_at) - new Date(a.appointment_at))[0];
    awaiting.push({ sub: s, visit: future || past, futureBooked: !!future });
  }
  return { needsScheduling, awaiting };
}

// Subject reflects the passed-due split so red mornings and paperwork mornings
// read differently at a glance: urgent buckets SHOUT (PAST DUE / FAILED CHARGES
// / NEEDS SCHEDULING), awaiting-completion stays lowercase.
function buildSubject({ pastDueCount = 0, failedCount = 0, needsSchedulingCount = 0, awaitingCount = 0, upcomingCount = 0 }) {
  const parts = [];
  if (pastDueCount) parts.push(pastDueCount + ' PAST DUE');
  if (failedCount) parts.push(failedCount + ' FAILED CHARGE' + (failedCount === 1 ? '' : 'S'));
  if (needsSchedulingCount) parts.push(needsSchedulingCount + ' NEED' + (needsSchedulingCount === 1 ? 'S' : '') + ' SCHEDULING');
  if (awaitingCount) parts.push(awaitingCount + ' awaiting completion');
  if (!parts.length) return 'Generator Care: ' + upcomingCount + ' visit' + (upcomingCount === 1 ? '' : 's') + ' due in the next 14 days';
  parts.push(upcomingCount + ' due soon');
  return 'Generator Care: ' + parts.join(', ');
}

// Scheduled visits within the next 2 days (Central) with neither a text
// confirmation (Y) nor a phone confirmation (038) - the office calls.
async function listUnconfirmedSoon({ now }) {
  const clock = now || new Date();
  const todayCentral = centralDateStr(clock);
  const lastDay = addDays(todayCentral, 2);
  const { data, error } = await supabaseAdmin
    .from('generator_service_visits')
    .select('id, appointment_at, arrival_window, subscription:generator_subscriptions(id, customer:generator_customers(name, phone))')
    .eq('status', 'scheduled')
    .is('sms_confirmed_at', null)
    .is('phone_confirmed_at', null)
    .not('appointment_at', 'is', null)
    .gte('appointment_at', addDays(todayCentral, -1) + 'T00:00:00Z')
    .lt('appointment_at', addDays(lastDay, 2) + 'T00:00:00Z')
    .order('appointment_at', { ascending: true });
  if (error) throw error;
  return (data || []).filter((v) => {
    const d = centralDateStr(new Date(v.appointment_at));
    return d >= todayCentral && d <= lastDay;
  }).map((v) => ({
    visit_id: v.id,
    subscription_id: v.subscription && v.subscription.id,
    appointment_at: v.appointment_at,
    arrival_window: v.arrival_window,
    name: (v.subscription && v.subscription.customer && v.subscription.customer.name) || 'Customer',
    phone: (v.subscription && v.subscription.customer && v.subscription.customer.phone) || '',
  }));
}

function notConfirmedLine(n) {
  const day = new Date(n.appointment_at).toLocaleDateString('en-US', { timeZone: 'America/Chicago', weekday: 'short', month: 'short', day: 'numeric' });
  const win = arrivalWindowLabel(n.arrival_window);
  return `${n.name} - ${day}${win ? ' ' + win : ''} - ${n.phone || 'no phone on file'}`;
}

function renderNotConfirmedSection(items) {
  if (!items || !items.length) return '';
  const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const rows = items.map((n) => `<li style="margin:0 0 4px;">${esc(notConfirmedLine(n))}</li>`).join('');
  return `<div style="margin:18px 0 6px;padding:12px 14px;border-left:4px solid #D97706;background:#fffbeb;border-radius:4px;">
 <div style="font-weight:700;color:#92400e;font-size:14px;margin-bottom:6px;">Not confirmed - call to confirm (${items.length})</div>
 <div style="color:#4b5563;font-size:12px;margin-bottom:8px;">Booked within 2 days with no Y reply and no phone confirmation. Call, then click <strong>Mark confirmed (by phone)</strong> on the visit.</div>
 <ul style="margin:0;padding-left:18px;color:#374151;font-size:13px;line-height:1.5;">${rows}</ul>
 </div>`;
}

// Digest line per conversation that still needs a human answer (sql/037).
function textsReplyLine(t) {
  const name = (t.customer && t.customer.name) || t.phone || 'Unknown';
  const since = t.needs_reply_since ? new Date(t.needs_reply_since).toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
  const who = t.mode === 'office' && t.owner ? ' - ' + (t.owner.full_name || t.owner.email) + ' has it' : ' - automated (no owner)';
  return `${name} (${t.phone || ''}) - waiting since ${since}${who}`;
}

function renderTextsNeedingReplySection(items) {
  if (!items || !items.length) return '';
  const esc = (v) => String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const rows = items.map((t) => `<li style="margin:0 0 4px;">${esc(textsReplyLine(t))}</li>`).join('');
  return `<div style="margin:18px 0 6px;padding:12px 14px;border-left:4px solid #7c3aed;background:#f5f3ff;border-radius:4px;">
 <div style="font-weight:700;color:#5b21b6;font-size:14px;margin-bottom:6px;">Texts needing a reply (${items.length})</div>
 <div style="color:#4b5563;font-size:12px;margin-bottom:8px;">A customer texted and nothing has answered for 2+ hours.</div>
 <ul style="margin:0;padding-left:18px;color:#374151;font-size:13px;line-height:1.5;">${rows}</ul>
 <p style="margin:8px 0 0;font-size:12px;"><a href="${TEXTS_TAB_URL}" style="color:#5b21b6;">Open the Texts inbox</a></p>
 </div>`;
}

function buildEmail({ needsScheduling = [], awaiting = [], upcoming, upcomingTentative = [], upcomingConfirmed = [], bookedBySubId = {}, failedAddons = [], failedAdhoc = [], pastDue = [], textsNeedingReply = [], notConfirmed = [], todayStr }) {
 const total = needsScheduling.length + awaiting.length + upcoming.length;
 const subject = buildSubject({
   pastDueCount: pastDue.length,
   failedCount: failedAddons.length + failedAdhoc.length,
   needsSchedulingCount: needsScheduling.length,
   awaitingCount: awaiting.length,
   upcomingCount: upcoming.length,
 });

 const dashboardUrl = 'https://app.bates-electric.com/generator-care.html';

 const planLabel = (p) => p === 'semi_annual' ? 'Semi-Annual' : 'Annual';
 const genClassLabel = (c) => ({
 air_cooled: 'Air Cooled',
 liquid_22_38: 'Liquid 22-45 KW',
 liquid_48_150: 'Liquid 48-150 KW',
 })[c] || c;

 const daysUntil = (dateStr) => {
 const target = new Date(dateStr + 'T00:00:00');
 const t = new Date(todayStr + 'T00:00:00');
 return Math.floor((target - t) / 86400000);
 };
 const fmtDate = (s) => new Date(s + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

 // Booked appointment -> "Tue, Jul 21 · 8:00–10:00 AM arrival" (window when
 // set; legacy exact time otherwise). The whole app speaks arrival windows.
 const fmtBooked = (b) => {
 if (!b || !b.appointment_at) return '';
 const winLabel = arrivalWindowLabel(b.arrival_window);
 const day = new Date(b.appointment_at).toLocaleDateString('en-US', { timeZone: 'America/Chicago', weekday: 'short', month: 'short', day: 'numeric' });
 if (winLabel) return `${day} · ${winLabel} arrival`;
 const time = new Date(b.appointment_at).toLocaleTimeString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit' });
 return `${day} · ${time} CT`;
 };

 // kind: 'needs_scheduling' (red, nothing booked), 'awaiting' (amber, visit on
 // the books — awaitInfo carries which visit), 'upcoming' (tentative/confirmed).
 const rowHtml = (s, kind, awaitInfo) => {
 const c = s.customer || {};
 const d = daysUntil(s.next_visit_due);
 const dueText = kind === 'needs_scheduling'
 ? `${Math.abs(d)} day${Math.abs(d) === 1 ? '' : 's'} OVERDUE`
 : kind === 'awaiting'
 ? `Due ${fmtDate(s.next_visit_due)} - ${Math.abs(d)} day${Math.abs(d) === 1 ? '' : 's'} ago`
 : (d === 0 ? 'Today' : d === 1 ? 'Tomorrow' : `In ${d} days  | ${fmtDate(s.next_visit_due)}`);
 const dueColor = kind === 'needs_scheduling' ? '#b91c1c' : kind === 'awaiting' ? '#b45309' : (d <= 7 ? '#b45309' : '#1F3A5F');
 // The appointment is the whole point of an awaiting row: show when the tech
 // was there (or will be). Needs-scheduling rows have nothing to show.
 let bookedLine = '';
 if (kind === 'awaiting' && awaitInfo && awaitInfo.visit) {
 const when = fmtBooked(awaitInfo.visit);
 bookedLine = awaitInfo.futureBooked
 ? (awaitInfo.visit.status === 'tentative' ? 'Tentatively booked ' : 'Booked ') + when
 : 'Visit was ' + when + ' - not marked complete';
 } else if (kind === 'upcoming') {
 const b = fmtBooked(bookedBySubId[s.id]);
 if (b) bookedLine = 'Booked ' + b;
 }
 const bookedColor = kind === 'awaiting' ? '#b45309' : '#1F3A5F';
 const addr = [c.install_city, c.install_state].filter(Boolean).join(', ');
 return `
 <tr>
 <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;vertical-align:top;">
 <div style="font-weight:600;color:#1F3A5F;font-size:14px;">${escapeHtml(c.name || ' - ')}</div>
 <div style="color:#6b7280;font-size:12px;">${escapeHtml(addr)}  | ${escapeHtml(c.phone || '')}</div>
 </td>
 <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;vertical-align:top;color:#374151;font-size:13px;">
 ${escapeHtml(genClassLabel(s.gen_class))}<br>
 <span style="color:#6b7280;font-size:12px;">${escapeHtml(s.gen_model || 'model n/a')}  | ${escapeHtml(planLabel(s.plan))}</span>
 </td>
 <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;vertical-align:top;color:${dueColor};font-size:13px;font-weight:600;text-align:right;white-space:nowrap;">
 ${dueText}
 ${bookedLine ? `<div style="color:${bookedColor};font-size:12px;font-weight:600;margin-top:2px;">${escapeHtml(bookedLine)}</div>` : ''}
 </td>
 </tr>
 `;
 };

 function renderPastDueSection(subs) {
        if (!subs.length) return '';
        const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        let h = '<div style="margin-top:1.5rem;">';
        h += '<h2 style="color:#7c2d12;font-size:1rem;margin-bottom:0.5rem;border-bottom:2px solid #7c2d12;padding-bottom:0.25rem;">';
        h += 'Past-due renewals (' + subs.length + ') - card update needed</h2>';
        h += '<p style="margin:0 0 0.5rem;color:#6b7280;font-size:0.85rem;">Stripe is retrying the renewal charge. Customer was auto-emailed a card-update link. Follow up by phone if it stays past-due more than a few days.</p>';
        for (const s of subs) {
          const c = s.customer || {};
          h += '<div style="padding:0.5rem 0;border-bottom:1px solid #eee;font-size:0.9rem;">';
          h += '<strong>' + esc(c.name || 'Unknown') + '</strong> - ' + esc(genClassLabel(s.gen_class)) + ' ' + esc(s.gen_model || 'model n/a') + ' - ' + esc(planLabel(s.plan));
          if (c.phone) h += '<div style="color:#6b7280;font-size:0.8rem;">' + esc(c.phone) + (c.email ? ' &middot; ' + esc(c.email) : '') + '</div>';
          else if (c.email) h += '<div style="color:#6b7280;font-size:0.8rem;">' + esc(c.email) + '</div>';
          h += '</div>';
        }
        h += '</div>';
        return h;
      }

 function renderFailedSection(addons, adhoc) {
        if (!addons.length && !adhoc.length) return '';
        const labelFor = (t) => ({
          battery_diagnostics: 'Battery Diagnostics / Load Test',
          battery_replacement: 'Battery Replacement',
          exterior_wash: 'Exterior Wash & Interior Blow-Out',
          outage_test: 'Simulated Power Outage Test',
          coolant_flush: 'Coolant System Flush',
          coolant_topoff: 'Coolant Top-Off Service',
          ats_inspection: 'ATS Inspection',
          ats_outage_combined: 'Transfer Switch Inspection & Simulated Outage Test',
        })[t] || t;
        const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        const total = addons.length + adhoc.length;
        let h = '<div style="margin-top:1.5rem;">';
        h += '<h2 style="color:#DC2626;font-size:1rem;margin-bottom:0.5rem;border-bottom:2px solid #DC2626;padding-bottom:0.25rem;">';
        h += 'Failed charges (' + total + ') - needs attention</h2>';
        const rowHtml = (name, phone, description, amt, notes) => {
          let r = '<div style="padding:0.5rem 0;border-bottom:1px solid #eee;font-size:0.9rem;">';
          r += '<strong>' + esc(name || 'Unknown') + '</strong> - ' + esc(description) + ' - ' + esc(amt);
          if (notes) r += '<div style="color:#6b7280;font-size:0.8rem;">' + esc(notes) + '</div>';
          if (phone) r += '<div style="color:#6b7280;font-size:0.8rem;">' + esc(phone) + '</div>';
          r += '</div>';
          return r;
        };
        for (const a of addons) {
          const c = (a.subscription && a.subscription.customer) || {};
          const amt = a.amount_cents ? '$' + (a.amount_cents / 100).toFixed(2) : '';
          h += rowHtml(c.name, c.phone, labelFor(a.addon_type), amt, a.notes);
        }
        for (const a of adhoc) {
          const c = (a.subscription && a.subscription.customer) || {};
          const amt = a.amount_cents ? '$' + (a.amount_cents / 100).toFixed(2) : '';
          h += rowHtml(c.name, c.phone, a.description, amt, a.notes);
        }
        h += '</div>';
        return h;
      }

      // 'awaiting' rows arrive as { sub, visit, futureBooked } wrappers; the
      // other kinds are plain subscription rows.
      const section = (title, rows, color, kind = 'upcoming') => {
 if (!rows.length) return '';
 return `
 <h3 style="margin:24px 0 8px;color:${color};font-size:14px;text-transform:uppercase;letter-spacing:0.06em;">${title} (${rows.length})</h3>
 <table cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;background:#fff;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
 ${rows.map(r => kind === 'awaiting' ? rowHtml(r.sub, kind, r) : rowHtml(r, kind)).join('')}
 </table>
 `;
 };

 const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#111827;background:#f9fafb;">
 <div style="max-width:680px;margin:0 auto;">
 <div style="background:#1F3A5F;color:#fff;padding:20px 24px;border-radius:8px 8px 0 0;">
 <div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;opacity:0.7;margin-bottom:4px;">Bates Electric, Inc.</div>
        <h1 style="margin:0;font-size:22px;letter-spacing:-0.3px;">Generator Care Digest</h1>
 <p style="margin:6px 0 0;opacity:0.85;font-size:13px;">${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</p>
 </div>
 <div style="background:#fff;padding:20px 24px;border-radius:0 0 8px 8px;border:1px solid #e5e7eb;border-top:none;">
 <p style="margin:0;color:#374151;font-size:14px;">
 ${total} customer${total === 1 ? '' : 's'} need attention in the next 14 days.
 ${needsScheduling.length ? `<strong style="color:#b91c1c;">${needsScheduling.length} need${needsScheduling.length === 1 ? 's' : ''} scheduling.</strong>` : ''}
 ${awaiting.length ? `<span style="color:#b45309;font-weight:600;">${awaiting.length} awaiting completion.</span>` : ''}
 </p>
 ${renderPastDueSection(pastDue)}
 ${renderTextsNeedingReplySection(textsNeedingReply)}
 ${renderNotConfirmedSection(notConfirmed)}
 ${section('Overdue - needs scheduling', needsScheduling, '#b91c1c', 'needs_scheduling')}
 ${section('Awaiting completion', awaiting, '#b45309', 'awaiting')}
          ${awaiting.length ? `<p style="margin:6px 0 14px;color:#6b7280;font-size:12px;line-height:1.5;">These had a visit on the books when the due date passed. If the visit already happened, mark it complete in the dashboard &mdash; that clears it and advances the next due date.</p>` : ''}
 ${section('Tentative - please confirm with customer', upcomingTentative, '#D97706')}
          ${upcomingTentative.length ? `<p style="margin:6px 0 14px;color:#6b7280;font-size:12px;line-height:1.5;">New signups land here first. For each: create the Jonas work order (internal record), then open the customer in the dashboard and click <strong>Mark work order created</strong> &mdash; that stamps it and gives you a copy-paste work-order packet. (Customers aren&rsquo;t invoiced &mdash; the branded receipt is their record.)</p>` : ''}
          ${section('Confirmed visits - due in next 14 days', upcomingConfirmed, '#1F3A5F')}
          ${renderFailedSection(failedAddons, failedAdhoc)}
 <p style="margin:24px 0 0;text-align:center;">
 <a href="${dashboardUrl}" style="display:inline-block;background:#1F3A5F;color:#fff;text-decoration:none;padding:10px 20px;border-radius:6px;font-weight:600;font-size:14px;">Open Generator Care dashboard -></a>
 </p>
 <p style="margin:24px 0 0;color:#6b7280;font-size:12px;text-align:center;">
 From the dashboard you can mark visits complete (next visit auto-schedules) and view full customer details.
 </p>
 </div>

 <div style="margin-top:24px;padding:16px 24px;text-align:center;color:#9ca3af;font-size:11px;line-height:1.6;">
   <div style="font-weight:600;color:#6b7280;letter-spacing:0.5px;">BATES ELECTRIC, INC.</div>
   <div>Commercial &middot; Residential &middot; Industrial &middot; Restorative</div>
   <div style="margin-top:6px;">(636) 464-3939 &middot; bates-electric.com</div>
 </div>
 </div>
</body></html>`;

 // Plain-text fallback
 const textLines = [];
 textLines.push(`Generator Care  -  daily digest`);
 textLines.push(`${total} customer${total === 1 ? '' : 's'} need attention in next 14 days.`);
 if (pastDue.length) {
 textLines.push('');
 textLines.push(`PAST DUE (${pastDue.length}) - card update needed:`);
 for (const s of pastDue) {
 const c = s.customer || {};
 textLines.push(`- ${c.name}  -  ${genClassLabel(s.gen_class)} ${s.gen_model || ''}  -  ${planLabel(s.plan)}  -  ${c.phone || c.email || ''}`);
 }
 }
 if (notConfirmed.length) {
 textLines.push('');
 textLines.push(`NOT CONFIRMED - CALL TO CONFIRM (${notConfirmed.length}) - booked within 2 days, no Y and no phone confirmation:`);
 for (const n of notConfirmed) {
 textLines.push(`- ${notConfirmedLine(n)}`);
 }
 }
 if (textsNeedingReply.length) {
 textLines.push('');
 textLines.push(`TEXTS NEEDING A REPLY (${textsNeedingReply.length}) - customer texted, nothing has answered for 2+ hours:`);
 for (const t of textsNeedingReply) {
 textLines.push(`- ${textsReplyLine(t)}`);
 }
 textLines.push(`  Open the Texts inbox: ${TEXTS_TAB_URL}`);
 }
 if (needsScheduling.length) {
 textLines.push('');
 textLines.push(`OVERDUE - NEEDS SCHEDULING (${needsScheduling.length}):`);
 for (const s of needsScheduling) {
 const c = s.customer || {};
 const d = daysUntil(s.next_visit_due);
 textLines.push(`- ${c.name}  -  ${genClassLabel(s.gen_class)}  -  ${Math.abs(d)} days overdue  -  ${c.phone || ''}`);
 }
 }
 if (awaiting.length) {
 textLines.push('');
 textLines.push(`AWAITING COMPLETION (${awaiting.length}):`);
 for (const a of awaiting) {
 const s = a.sub;
 const c = s.customer || {};
 const when = fmtBooked(a.visit);
 const visitStr = a.futureBooked ? `booked ${when}` : `visit was ${when} - not marked complete`;
 textLines.push(`- ${c.name}  -  ${genClassLabel(s.gen_class)}  -  due ${fmtDate(s.next_visit_due)}  -  ${visitStr}  -  ${c.phone || ''}`);
 }
 }
 if (upcomingTentative.length) {
 textLines.push('');
 textLines.push(`TENTATIVE - PLEASE CONFIRM (${upcomingTentative.length}):`);
 for (const s of upcomingTentative) {
 const c = s.customer || {};
 const d = daysUntil(s.next_visit_due);
 textLines.push(`- ${c.name}  -  ${genClassLabel(s.gen_class)}  -  ${d === 0 ? 'today' : d === 1 ? 'tomorrow' : `in ${d} days`} (${fmtDate(s.next_visit_due)})  -  ${c.phone || ''}`);
 }
 }
 textLines.push('');
 textLines.push(`Dashboard: ${dashboardUrl}`);

 if (upcomingConfirmed.length) {
        textLines.push('');
        textLines.push(`CONFIRMED - DUE IN NEXT 14 DAYS (${upcomingConfirmed.length}):`);
        for (const s of upcomingConfirmed) {
          const d = Math.round((new Date(s.next_visit_due) - new Date(todayStr)) / 86400000);
          const c = s.customer || {};
          const bookedStr = fmtBooked(bookedBySubId[s.id]);
          textLines.push(`- ${c.name}  -  ${genClassLabel(s.gen_class)}  -  in ${d} days${bookedStr ? `  -  booked ${bookedStr}` : ''}  -  ${c.phone || ''}`);
        }
      }

 if (failedAddons.length || failedAdhoc.length) {
        textLines.push('');
        textLines.push('FAILED CHARGES (' + (failedAddons.length + failedAdhoc.length) + '):');
        for (const a of failedAddons) {
          const c = (a.subscription && a.subscription.customer) || {};
          const amt = a.amount_cents ? '$' + (a.amount_cents / 100).toFixed(2) : '';
          textLines.push('- ' + (c.name || 'Unknown') + ' - ' + a.addon_type + ' - ' + amt + (a.notes ? ' - ' + a.notes : ''));
        }
        for (const a of failedAdhoc) {
          const c = (a.subscription && a.subscription.customer) || {};
          const amt = a.amount_cents ? '$' + (a.amount_cents / 100).toFixed(2) : '';
          textLines.push('- ' + (c.name || 'Unknown') + ' - ' + a.description + ' - ' + amt + (a.notes ? ' - ' + a.notes : ''));
        }
      }

      return { subject, html, text: textLines.join('\n') };
}

// Quiet-day digest: same branded shell as the full digest (so Amy recognizes the
// daily email arrived) with a single "all clear" line. Sending this every quiet
// day is what keeps a missing email meaningful as an outage signal.
function buildQuietEmail({ todayStr }) {
  const dashboardUrl = 'https://app.bates-electric.com/generator-care.html';
  const dateLine = new Date(todayStr + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  const subject = 'Generator Care: all quiet - nothing due today';

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#111827;background:#f9fafb;">
  <div style="max-width:680px;margin:0 auto;">
    <div style="background:#1F3A5F;color:#fff;padding:20px 24px;border-radius:8px 8px 0 0;">
      <div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;opacity:0.7;margin-bottom:4px;">Bates Electric, Inc.</div>
      <h1 style="margin:0;font-size:22px;letter-spacing:-0.3px;">Generator Care Digest</h1>
      <p style="margin:6px 0 0;opacity:0.85;font-size:13px;">${dateLine}</p>
    </div>
    <div style="background:#fff;padding:28px 24px;border-radius:0 0 8px 8px;border:1px solid #e5e7eb;border-top:none;text-align:center;">
      <div style="font-size:30px;line-height:1;margin-bottom:8px;">&#9989;</div>
      <p style="margin:0;color:#1F3A5F;font-size:16px;font-weight:600;">All quiet</p>
      <p style="margin:8px 0 0;color:#374151;font-size:14px;">No new signups, no visits due, no failed charges.</p>
      <p style="margin:22px 0 0;">
        <a href="${dashboardUrl}" style="display:inline-block;background:#1F3A5F;color:#fff;text-decoration:none;padding:10px 20px;border-radius:6px;font-weight:600;font-size:14px;">Open Generator Care dashboard -></a>
      </p>
    </div>
    <div style="margin-top:24px;padding:16px 24px;text-align:center;color:#9ca3af;font-size:11px;line-height:1.6;">
      <div style="font-weight:600;color:#6b7280;letter-spacing:0.5px;">BATES ELECTRIC, INC.</div>
      <div>Commercial &middot; Residential &middot; Industrial &middot; Restorative</div>
      <div style="margin-top:6px;">(636) 464-3939 &middot; bates-electric.com</div>
    </div>
  </div>
</body></html>`;

  const text = [
    'Generator Care  -  daily digest',
    '',
    'All quiet - no new signups, no visits due, no failed charges.',
    '',
    `Dashboard: ${dashboardUrl}`,
  ].join('\n');

  return { subject, html, text };
}

function escapeHtml(s) {
 return String(s == null ? '' : s)
 .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
 .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

module.exports = router;
// Review request the day after a completed visit (038). Off unless
// SMS_REVIEW_REQUESTS_ENABLED=true (CJ confirms carrier registration covers
// it first). From REVIEW_HOUR Central, for visits completed YESTERDAY; one
// terminal stamp per visit with the outcome ('sent' or 'skipped: why') so the
// office can see in the record why one did not go. Skip rules, in order:
// missed the day-after window, no phone, no review link (Florida needs its
// own S.E. Bates link), tech was running late, a review request in the last
// 12 months, office owns the conversation, the customer texted something
// needing a reply in the last 7 days. Then the usual sendSms gates.
async function runReviewRequestPass({ now }) {
  if (process.env.SMS_REVIEW_REQUESTS_ENABLED !== 'true') return { skipped: 'disabled' };
  const clock = now || new Date();
  if (centralHour(clock) < REVIEW_HOUR) return { skipped: 'before_' + REVIEW_HOUR };
  const todayCentral = centralDateStr(clock);
  const yesterday = addDays(todayCentral, -1);
  const summary = { considered: 0, sent: 0, skipped: 0 };
  const { data: visits, error } = await supabaseAdmin
    .from('generator_service_visits')
    .select('id, completed_date, running_late_at, subscription:generator_subscriptions(customer:generator_customers(id, name, phone, install_state, last_review_request_at))')
    .eq('status', 'completed')
    .is('review_request_at', null)
    .gte('completed_date', addDays(todayCentral, -3))
    .lte('completed_date', yesterday);
  if (error) throw error;

  for (const v of visits || []) {
    summary.considered++;
    const customer = (v.subscription && v.subscription.customer) || null;
    const stamp = async (outcome) => {
      const { error: stErr } = await supabaseAdmin
        .from('generator_service_visits')
        .update({ review_request_at: clock.toISOString(), review_request_outcome: outcome })
        .eq('id', v.id);
      if (stErr) {
        console.error('[gc-cron] review stamp failed for visit ' + v.id + ':', stErr.message);
        reportError(new Error('review stamp failed for visit ' + v.id + ': ' + stErr.message), { route: '/api/cron/generator-care/sms-reminders' }).catch(() => {});
      }
    };
    const skip = async (why) => { await stamp('skipped: ' + why); summary.skipped++; };

    if (v.completed_date < yesterday) { await skip('missed the day-after window'); continue; }
    if (!customer || !normalizePhone(customer.phone)) { await skip('no mobile number'); continue; }
    const fl = isFlorida(customer.install_state);
    const link = fl ? process.env.GOOGLE_REVIEW_URL_FL : process.env.GOOGLE_REVIEW_URL;
    if (!link) { await skip(fl ? 'Florida customer - no S.E. Bates review link set' : 'no review link set'); continue; }
    if (v.running_late_at) { await skip('tech was running late'); continue; }
    if (customer.last_review_request_at && new Date(customer.last_review_request_at).getTime() > clock.getTime() - 365 * 86400000) {
      await skip('review request already sent in the last 12 months'); continue;
    }
    const phone = normalizePhone(customer.phone);
    if (await isOfficeMode({ customerId: customer.id, phone, now: clock })) { await skip('office is handling the conversation'); continue; }
    const { data: recent, error: rErr } = await supabaseAdmin
      .from('generator_sms_messages')
      .select('detail, created_at')
      .eq('direction', 'in')
      .eq('customer_id', customer.id)
      .gte('created_at', new Date(clock.getTime() - 7 * 86400000).toISOString());
    if (rErr) throw rErr;
    if ((recent || []).some((m) => /^intent: (other|reschedule)/.test(String(m.detail || '')))) {
      await skip('customer texted something needing a reply in the last 7 days'); continue;
    }

    const result = await sendSms({
      toPhone: customer.phone,
      body: buildReviewRequestSms({ name: customer.name, installState: customer.install_state, link }),
      customerId: customer.id,
      relatedVisitId: v.id,
      now: clock,
    });
    if (result.sent) {
      await stamp('sent');
      summary.sent++;
      const { error: cErr } = await supabaseAdmin.from('generator_customers').update({ last_review_request_at: clock.toISOString() }).eq('id', customer.id);
      if (cErr) console.error('[gc-cron] last_review_request_at stamp failed:', cErr.message);
    } else if (SMS_TERMINAL_STATUSES.includes(result.status)) {
      await skip(result.status);
    } else {
      summary.skipped++; // transient (held / disabled / failed): the next hourly run retries
    }
  }
  return summary;
}

// Held-text sweep after a hand-back (routes/generator-care/texts.js): the
// four retry passes, exactly as the hourly trigger runs them, so a text held
// during office mode goes out now if still relevant or is stale-dropped on
// record. Guarded like the endpoint: outside quiet hours or with the
// kill-switch off nothing is attempted (the hourly run will). Never throws.
async function runHeldSweep({ now } = {}) {
  const t = now || new Date();
  if (!withinQuietHours(t) || !smsEnabled()) {
    // Nothing may send, but a held text that no longer applies is still closed now.
    await closeStaleHeldTexts({ now: t });
    return { skipped: !smsEnabled() ? 'sms_disabled' : 'outside_quiet_hours' };
  }
  try {
    const bookingConfirm = await runBookingConfirmRetryPass({ now: t });
    const threeDay = await runReminderRetryPass({ kind: '3day', now: t });
    const eve = await runReminderRetryPass({ kind: 'eve', now: t });
    const nudge = await runNudgeRetryPass({ now: t });
    // Then close out the held rows those passes just settled (sent or dropped).
    const held = await closeStaleHeldTexts({ now: t });
    return { booking_confirm: bookingConfirm, three_day: threeDay, eve, nudge, held: { checked: held.checked, dropped: held.dropped, released: held.released } };
  } catch (e) {
    console.error('[gc-cron] held sweep failed:', e && e.message);
    reportError(e, { route: 'gc-cron runHeldSweep' }).catch(() => {});
    return { error: e && e.message };
  }
}
module.exports.runHeldSweep = runHeldSweep;

// Offline-test seam (same pattern as generator-webhook.js) — lets the reminder
// pass run with a pinned clock and mocked supabase, no HTTP/cron secret needed.
module.exports._test = { runReminderPass, runNudgeRetryPass, runBookingConfirmRetryPass, runReminderRetryPass, runReviewRequestPass, runHeldSweep, listUnconfirmedSoon, centralDateStr, addDays, centralHour, centralTimeToIso, EVE_HOUR, REVIEW_HOUR, REMINDER_TERMINAL_STATUSES, splitOverdue, buildSubject, buildEmail, textsReplyLine, notConfirmedLine };
