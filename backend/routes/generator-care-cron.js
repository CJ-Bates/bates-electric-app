// backend/routes/generator-care-cron.js
// Scheduled / cron endpoints for the Generator Care program.
// Hit by an external scheduler  -  protected by a shared secret instead of user JWT.

const crypto = require('crypto');
const express = require('express');
const { supabaseAdmin } = require('../lib/supabase');
const { sendViaBrevo } = require('../lib/mailer');
const { arrivalWindowLabel } = require('../lib/generator-catalog');
const { sendSms, sendMagicLoginSms, buildReminderSms, buildScheduleNudgeSms } = require('../lib/sms');
const { DASHBOARD_URL } = require('../lib/emails');
const { reportError } = require('../middleware/error-reporter');

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

    // Look up visit statuses for upcoming subs to split tentative vs confirmed,
    // and carry the booked appointment (date + arrival window) so confirmed
    // rows can show WHEN the visit is booked, not just when it's due.
    const upcomingSubIds = upcoming.map(s => s.id);
    const statusBySubId = {};
    const bookedBySubId = {};
    if (upcomingSubIds.length > 0) {
      const { data: visits } = await supabaseAdmin
        .from('generator_service_visits')
        .select('subscription_id, status, appointment_at, arrival_window')
        .in('subscription_id', upcomingSubIds)
        .in('status', ['tentative', 'scheduled']);
      for (const v of (visits || [])) {
        if (!statusBySubId[v.subscription_id]) statusBySubId[v.subscription_id] = v.status;
        if (!bookedBySubId[v.subscription_id] && v.status === 'scheduled' && v.appointment_at) {
          bookedBySubId[v.subscription_id] = { appointment_at: v.appointment_at, arrival_window: v.arrival_window };
        }
      }
    }
    const upcomingTentative = upcoming.filter(s => statusBySubId[s.id] === 'tentative');
    const upcomingConfirmed = upcoming.filter(s => statusBySubId[s.id] !== 'tentative');

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

    // The digest must go out EVERY day. Amy's runbook treats a missing email as
    // an outage signal, so on a genuinely quiet day we still send — just a short
    // "all quiet" note instead of suppressing the email entirely.
    const isQuiet = overdue.length === 0 && upcoming.length === 0 && failedTotal === 0 && pastDue.length === 0;

    const { subject, html, text } = isQuiet
      ? buildQuietEmail({ todayStr })
      : buildEmail({ overdue, upcoming, upcomingTentative, upcomingConfirmed, bookedBySubId, failedAddons, failedAdhoc, pastDue, todayStr });

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

 res.json({ ok: true, sent: true, quiet: isQuiet, recipients: TO_EMAILS, overdue: overdue.length, upcoming: upcoming.length, upcoming_tentative: upcomingTentative.length, upcoming_confirmed: upcomingConfirmed.length, failed_addons: failedAddons.length, failed_adhoc: failedAdhoc.length, past_due: pastDue.length });
 } catch (err) {
 // Signal failure to Healthchecks first so we hear about a crashed cron.
 pingHealthcheck('/fail');
 console.error('[gc-cron] daily-email error:', err && (err.response?.body || err.message));
 reportError(err, { route: '/api/cron/generator-care/daily-email', method: 'POST', user: 'gc-cron' }).catch(() => {});
 res.status(500).json({ error: 'Server error' });
 }
});

// ============================================================================
// SMS appointment reminders (Phase 2).
// POST /api/cron/generator-care/sms-reminders — fired daily at ~8am Central
// (must land inside the 8am-9pm quiet-hours window or sendSms refuses every
// send). Two passes: visits whose appointment falls 3 days from now, and
// visits whose appointment is today. Read-only except the per-visit stamp
// columns (026) — reminders never touch the appointment itself.
//
// Idempotency: each pass only selects visits whose stamp column is null, and
// stamps it ONLY on a TERMINAL sendSms result — 'sent', or the permanent
// refusals 'no_consent' / 'opted_out' / 'invalid_phone'. Transient outcomes
// ('disabled' kill-switch, 'quiet_hours', 'failed') leave the column null so
// the next daily run retries. Every attempt, refusals included, is already
// logged to generator_sms_messages by sendSms — never pre-filter consent here.
// ============================================================================

const REMINDER_TERMINAL_STATUSES = ['sent', 'no_consent', 'opted_out', 'invalid_phone'];

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

// One reminder pass: every scheduled, unstamped visit whose appointment falls
// on targetDateStr IN CENTRAL TIME. appointment_at is a timestamptz, so the
// query grabs a UTC superset ([target-1d, target+2d) covers every instant
// that could render as the target Central date) and the exact Central-date
// match happens in JS — same Intl clock the rest of the app uses.
async function runReminderPass({ targetDateStr, stampColumn, isToday, now }) {
  const summary = { considered: 0, sent: 0, skipped: 0 };
  const { data: visits, error } = await supabaseAdmin
    .from('generator_service_visits')
    .select('id, appointment_at, arrival_window, sms_confirmed_at, subscription:generator_subscriptions(customer:generator_customers(id, name, phone, install_state))')
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

// Phase 3 schedule-nudge retry sweep. The invoice.upcoming webhook QUEUES a
// nudge on the cycle's open visit (schedule_nudge_queued_at, sql/027) and
// attempts the send immediately, but that event fires once per cycle at
// whatever hour Stripe picks — a quiet-hours or kill-switch refusal there has
// no redelivery to lean on. This pass, riding the same daily ~8am trigger as
// the reminders (inside quiet hours by design), re-attempts every visit still
// queued-but-unsent: a fresh single-use auto-login link is minted per attempt
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
    const threeDay = await runReminderPass({
      targetDateStr: addDays(todayCentral, 3), stampColumn: 'sms_reminder_3day_at', isToday: false, now,
    });
    const dayOf = await runReminderPass({
      targetDateStr: todayCentral, stampColumn: 'sms_reminder_dayof_at', isToday: true, now,
    });
    const nudgeRetry = await runNudgeRetryPass({ now });
    res.json({ ok: true, date: todayCentral, three_day: threeDay, day_of: dayOf, nudge_retry: nudgeRetry });
  } catch (err) {
    console.error('[gc-cron] sms-reminders error:', err && err.message);
    reportError(err, { route: '/api/cron/generator-care/sms-reminders', method: 'POST', user: 'gc-cron' }).catch(() => {});
    res.status(500).json({ error: 'Server error' });
  }
});

// Helpers --------------------------------------------------

function buildEmail({ overdue, upcoming, upcomingTentative = [], upcomingConfirmed = [], bookedBySubId = {}, failedAddons = [], failedAdhoc = [], pastDue = [], todayStr }) {
 const total = overdue.length + upcoming.length;
 const failedTotalForSubject = failedAddons.length + failedAdhoc.length;
      const subject = pastDue.length > 0
        ? 'Generator Care: ' + pastDue.length + ' PAST DUE' + (failedTotalForSubject ? ', ' + failedTotalForSubject + ' failed charge' + (failedTotalForSubject === 1 ? '' : 's') : '') + ', ' + overdue.length + ' overdue, ' + upcoming.length + ' due soon'
        : failedTotalForSubject > 0
        ? 'Generator Care: ' + failedTotalForSubject + ' FAILED CHARGE' + (failedTotalForSubject === 1 ? '' : 'S') + ', ' + overdue.length + ' overdue, ' + upcoming.length + ' due soon'
        : overdue.length
 ? `Generator Care: ${overdue.length} OVERDUE, ${upcoming.length} due soon`
 : `Generator Care: ${upcoming.length} visit${upcoming.length === 1 ? '' : 's'} due in the next 14 days`;

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

 const rowHtml = (s, kind) => {
 const c = s.customer || {};
 const d = daysUntil(s.next_visit_due);
 const dueText = kind === 'overdue'
 ? `${Math.abs(d)} day${Math.abs(d) === 1 ? '' : 's'} OVERDUE`
 : (d === 0 ? 'Today' : d === 1 ? 'Tomorrow' : `In ${d} days  | ${fmtDate(s.next_visit_due)}`);
 const dueColor = kind === 'overdue' ? '#b91c1c' : (d <= 7 ? '#b45309' : '#1F3A5F');
 const bookedStr = kind === 'overdue' ? '' : fmtBooked(bookedBySubId[s.id]);
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
 ${bookedStr ? `<div style="color:#1F3A5F;font-size:12px;font-weight:600;margin-top:2px;">Booked ${escapeHtml(bookedStr)}</div>` : ''}
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

      const section = (title, rows, color) => {
 if (!rows.length) return '';
 return `
 <h3 style="margin:24px 0 8px;color:${color};font-size:14px;text-transform:uppercase;letter-spacing:0.06em;">${title} (${rows.length})</h3>
 <table cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;background:#fff;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
 ${rows.map(r => rowHtml(r, color === '#b91c1c' ? 'overdue' : 'upcoming')).join('')}
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
 ${overdue.length ? `<strong style="color:#b91c1c;">${overdue.length} overdue.</strong>` : ''}
 </p>
 ${renderPastDueSection(pastDue)}
 ${section('Overdue', overdue, '#b91c1c')}
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
 if (overdue.length) {
 textLines.push('');
 textLines.push(`OVERDUE (${overdue.length}):`);
 for (const s of overdue) {
 const c = s.customer || {};
 const d = daysUntil(s.next_visit_due);
 textLines.push(`- ${c.name}  -  ${genClassLabel(s.gen_class)}  -  ${Math.abs(d)} days overdue  -  ${c.phone || ''}`);
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
// Offline-test seam (same pattern as generator-webhook.js) — lets the reminder
// pass run with a pinned clock and mocked supabase, no HTTP/cron secret needed.
module.exports._test = { runReminderPass, runNudgeRetryPass, centralDateStr, addDays, REMINDER_TERMINAL_STATUSES };
