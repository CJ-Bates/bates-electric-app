// backend/routes/sms-inbound.js
// PUBLIC (no-auth) webhook SimpleTexting calls for each inbound text on the
// shared company number, plus platform unsubscribe reports. Deliberately
// outside every authed router — SimpleTexting can't hold a session — but NOT
// open: every request must carry the shared secret in the X-Webhook-Secret
// header (preferred) or, for the classic GET forwarding integration that can
// only send a fixed URL, the ?secret=<SMS_WEBHOOK_SECRET> query param CJ
// configures in the SimpleTexting account. The route is rate-limited. Fails
// closed when the env var isn't set.
//
// Payload (confirmed against api-doc.simpletexting.com, 2026-07-15): v2
// webhooks POST JSON { type: 'INCOMING_MESSAGE', values: { contactPhone,
// accountPhone, text, ... } } / { type: 'UNSUBSCRIBE_REPORT', values:
// { phone, contactId } }. The account's OLDER "forward incoming messages"
// integration is a GET with ?from=&to=&text= query params — accepted too, so
// the feature works whichever integration style the account ends up using.
//
// Reply routing (approved copy pack):
//   Y / YES  -> stamp sms_confirmed_at on the customer's next unconfirmed
//               upcoming visit, reply copy (2) "You're all set".
//   STOP...  -> flip opted_out on every consent row for that phone (the
//               platform already sends its own STOP confirmation + blocks).
//   START    -> re-arm consent flags (platform handles the re-subscribe).
//   HELP     -> log only (platform auto-replies).
//   N / NO (whole message) or a clear reschedule phrase ("reschedule",
//            "change the time", "different day", "can't make it", "cancel my
//            appointment"...) -> reply copy (5) with the dashboard link and
//            email the office. NEVER auto-change the appointment.
//   anything else (free text: a complaint, a question, "No one has shown
//            up") -> ONE short holding reply (copy 5b, no link) and an
//            office alert. If the customer has a visit TODAY the alert is
//            marked URGENT with the visit time, tech, and message.
//   Loop guard: at most one automated reply per phone per 30 minutes; later
//   texts in that window only alert the office. (2026-10-26: a customer whose
//   tech was late texted three complaints and got the reschedule link three
//   times, which read as "we're treating this as a cancellation".)
//
//   Office mode (sql/037, lib/smsConversations.js): when a staff member owns
//   the conversation, STOP/START/HELP still run and a Y still stamps the
//   visit, but NO automated reply goes out (no holding reply, no reschedule
//   link, no confirmation) - the owner answers. Alerts go to the owner only,
//   ~10 minutes later if they still haven't replied; an URGENT visit-day
//   text is the exception and emails the owner + the office list at once.
//   The inbox's "Needs reply" flag is set for free text / reschedule intents.
//
// This is a SHARED account with the service team: an inbound from a number
// with no Generator Care consent row is somebody else's conversation — log it
// as unmatched and do nothing.

const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { supabaseAdmin } = require('../lib/supabase');
const { sendEmail, DASHBOARD_URL, escHtml } = require('../lib/emails');
const {
  normalizePhone,
  buildConfirmedReplySms,
  buildRescheduleReplySms,
  buildHoldingReplySms,
  buildAfterHoursReplySms,
  sendSms,
  logSmsMessage,
  optOutPhone,
} = require('../lib/sms');
const { reportError } = require('../middleware/error-reporter');
const { arrivalWindowLabel } = require('../lib/generator-catalog');
const { isOfficeOpen, nextOpenPhrase } = require('../lib/officeHours');
const {
  ensureConversation, resolveMode, recordInbound, scheduleOwnerAlert,
} = require('../lib/smsConversations');

const router = express.Router();

// One automated reply per phone per this window; further texts inside it
// only alert the office. Test seam via env.
const AUTO_REPLY_WINDOW_MS = Number(process.env.SMS_AUTO_REPLY_WINDOW_MS) || 30 * 60 * 1000;

const OFFICE_NOTIFY_TO = (process.env.GENERATOR_DIGEST_TO || 'cjbates@bates-electric.com,generators@bates-electric.com')
  .split(',').map((s) => s.trim()).filter(Boolean);

// SimpleTexting retries aren't documented; a webhook storm must not become a
// DB storm. Real traffic is a handful of replies a day.
const inboundLimiter = rateLimit({
  windowMs: 60 * 1000, limit: 60, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many requests' },
});

// Constant-time secret check. Preferred delivery is the X-Webhook-Secret header
// (kept out of URLs, access logs, and error reports). The ?secret= query form is
// still accepted ONLY because the classic "forward incoming messages" GET
// integration can send just a fixed URL, not headers — but the query string is
// no longer logged anywhere (error-reporter / request-timeout now log req.path).
// Missing env = fail closed, never "open while unconfigured".
function safeEqual(a, b) {
  const ba = Buffer.from(String(a == null ? '' : a));
  const bb = Buffer.from(String(b == null ? '' : b));
  if (ba.length !== bb.length) return false;      // timingSafeEqual requires equal length
  return crypto.timingSafeEqual(ba, bb);
}
function verifySecret(req, res) {
  const expected = process.env.SMS_WEBHOOK_SECRET;
  if (!expected) {
    console.error('[sms-inbound] SMS_WEBHOOK_SECRET is not set - rejecting all webhook calls.');
    res.status(403).json({ error: 'not configured' });
    return false;
  }
  // Read the header off req.headers (Node lowercases header names) rather than
  // req.get(), so this works with plain req objects too. Header preferred; the
  // query param is the fallback for the classic GET forwarding integration.
  const headerSecret = (req.headers && req.headers['x-webhook-secret']) || '';
  const provided = headerSecret || (req.query && req.query.secret) || '';
  if (!safeEqual(provided, expected)) {
    res.status(403).json({ error: 'forbidden' });
    return false;
  }
  return true;
}

// Reply classification. Uppercase, strip surrounding punctuation/whitespace.
// Exported for tests via _test below.
//   'confirm'    Y / YES as the whole message
//   'stop' / 'start' / 'help'  carrier keywords as the whole message (a bare
//                CANCEL is a carrier opt-out keyword the platform acts on
//                regardless of us, so it stays in this group)
//   'reschedule' N / NO as the whole message, or a clear reschedule phrase
//                that is not negated ("I did not cancel" is NOT a request)
//   'other'      everything else = free text for a human
//   'empty'      nothing to act on
const RESCHEDULE_PHRASES = [
  /\bRE-?SCHEDULE/,
  /\bCHANGE\b/,                                   // "can I change the time"
  /\b(DIFFERENT|ANOTHER|NEW|LATER|EARLIER)\s+(TIME|DAY|DATE|SLOT|APPOINTMENT|WEEK)\b/,
  /\b(CAN'?T|CANNOT|CAN NOT|WON'?T BE ABLE TO|UNABLE TO|NOT ABLE TO)\s+(MAKE|DO)\b/, // "can't make it"
  /\bCANCEL/,                                     // "cancel my appointment" (negation checked below)
  /\b(MOVE|PUSH|BUMP)\s+(IT|THE|MY|THAT|THIS|OUR)\b/, // "move it to Friday"
  /\bINSTEAD\b/,
  /\bPOSTPONE/,
];
// A keyword right after a negation is a denial, not a request.
const NEGATED_PHRASE = /\b(NOT|NEVER|DIDN'?T|DID NOT|DON'?T|DO NOT|HAVEN'?T|HAVE NOT|WASN'?T|WAS NOT|NO ONE|NOBODY)\s+(WANT(ED)? TO\s+|TRY(ING)? TO\s+|ASK(ED)? TO\s+|NEED TO\s+)?(RE-?SCHEDULE|CHANGE|CANCEL|MOVE|POSTPONE)/;
function classifyReply(text) {
  const t = String(text || '').trim().toUpperCase().replace(/[.!?,\s]+$/g, '').replace(/^[\s]+/g, '');
  if (!t) return 'empty';
  if (/^(Y|YES)$/.test(t)) return 'confirm';
  // Carrier-standard opt-out keywords (the platform intercepts most of these;
  // we mirror the flag so our own gate never depends on the provider).
  if (/^(STOP|STOPALL|UNSUBSCRIBE|CANCEL|END|QUIT)$/.test(t)) return 'stop';
  if (/^(START|UNSTOP|YES SUBSCRIBE)$/.test(t)) return 'start';
  if (/^(HELP|INFO)$/.test(t)) return 'help';
  if (/^(N|NO|NOPE)$/.test(t)) return 'reschedule';
  if (NEGATED_PHRASE.test(t)) return 'other';
  if (RESCHEDULE_PHRASES.some((re) => re.test(t))) return 'reschedule';
  return 'other';
}

// Loop guard: has an AUTOMATED text (not an operator reply) gone to this phone
// inside the window? Read from the message log; fails open on a lookup error
// (one extra reply beats a silent customer).
async function recentAutoReplyAt(e164, now) {
  const since = new Date((now || Date.now()) - AUTO_REPLY_WINDOW_MS).toISOString();
  const { data, error } = await supabaseAdmin
    .from('generator_sms_messages')
    .select('created_at, body')
    .eq('direction', 'out')
    .eq('to_phone', e164)
    .eq('status', 'sent')
    .is('sent_by_profile_id', null)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) throw error;
  return (data && data[0] && data[0].created_at) || null;
}

// Central-time calendar date ('YYYY-MM-DD') of an instant.
function centralDate(d) {
  return new Date(d).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
}
function centralTime(d) {
  return new Date(d).toLocaleTimeString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit' });
}

// The customer's scheduled visit TODAY (Central), if any, with the assigned
// tech's name — what makes a free-text reply urgent. Never throws.
async function findVisitToday(customerIds, now) {
  try {
    const { data: subs, error: subErr } = await supabaseAdmin
      .from('generator_subscriptions').select('id').in('customer_id', customerIds);
    if (subErr) throw subErr;
    const subIds = (subs || []).map((s) => s.id);
    if (!subIds.length) return null;
    const t = now || Date.now();
    const { data: visits, error: vErr } = await supabaseAdmin
      .from('generator_service_visits')
      .select('id, subscription_id, appointment_at, arrival_window, status, assigned_tech_id')
      .in('subscription_id', subIds)
      .eq('status', 'scheduled')
      .not('appointment_at', 'is', null)
      .gte('appointment_at', new Date(t - 36 * 3600 * 1000).toISOString())
      .lte('appointment_at', new Date(t + 36 * 3600 * 1000).toISOString())
      .order('appointment_at', { ascending: true });
    if (vErr) throw vErr;
    const today = centralDate(t);
    const visit = (visits || []).find((v) => v.appointment_at && centralDate(v.appointment_at) === today) || null;
    if (!visit) return null;
    let techName = null;
    if (visit.assigned_tech_id) { // the dispatched tech (technician_id = who completed it)
      try {
        const { data: tech } = await supabaseAdmin
          .from('profiles').select('full_name, email').eq('id', visit.assigned_tech_id).maybeSingle();
        techName = (tech && (tech.full_name || tech.email)) || null;
      } catch (e) { /* name is a nicety */ }
    }
    const windowLabel = arrivalWindowLabel(visit.arrival_window);
    return {
      id: visit.id,
      whenLabel: 'today ' + (windowLabel || centralTime(visit.appointment_at)),
      techName: techName || 'unassigned',
    };
  } catch (e) {
    console.error('[sms-inbound] visit-today lookup failed:', e && e.message);
    return null;
  }
}

// Office alert for a text that needs a human. `urgent` (visit today) goes out
// with the visit time + tech in the subject line so it can't be skimmed past.
// `urgent` = visit today AND this is the first text in the auto-reply window;
// follow-ups in the same window still name the visit but go out plain so the
// inbox shows one URGENT per incident, not one per message.
// `officeOwner` (office mode): { name, email } of the member who owns the
// conversation - the email goes to them (plus the list only when urgent) and
// says so, because no automated reply went out.
function sendOfficeAlert({ customer, e164, text, intent, replied, visitToday, urgent, officeOwner, to }) {
  const name = (customer && customer.name) || e164;
  const msg = String(text || '').slice(0, 500);
  const what = officeOwner
    ? 'Office mode: ' + (officeOwner.name || officeOwner.email || 'a staff member') + ' owns this conversation, so no automated reply went out - they are waiting on a person.'
    : intent === 'reschedule'
      ? (replied ? 'They were sent the reschedule link.' : 'Reschedule link NOT re-sent (one automated reply per 30 min).')
      : (replied ? 'They were sent the holding reply ("someone will reach out shortly").' : 'No automated reply (one per 30 min already sent); they are waiting to hear from a person.');
  const lines = [
    'Customer: ' + name + ' (' + e164 + ')',
    'Message: "' + msg + '"',
  ];
  if (visitToday) {
    lines.push('Visit: ' + visitToday.whenLabel + ' - assigned tech: ' + visitToday.techName);
  }
  lines.push(what + ' No appointment was changed.');
  const subject = urgent
    ? 'URGENT: customer texted on visit day - ' + name + ' (' + visitToday.whenLabel + ', ' + visitToday.techName + ')'
    : '[Generator Care] Text reply needs a look' + (visitToday ? ' (visit today)' : '') + ': ' + name;
  const html = '<div style="font-family:system-ui,sans-serif;font-size:14px;line-height:1.5;">' +
    (urgent ? '<p style="color:#B91C1C;font-weight:700;margin:0 0 8px;">URGENT - this customer has a visit today.</p>' : '') +
    lines.map((l) => '<p style="margin:0 0 6px;">' + escHtml(l) + '</p>').join('') + '</div>';
  return sendEmail({
    to: (to && to.length) ? to : OFFICE_NOTIFY_TO,
    subject,
    html,
    text: (urgent ? 'URGENT - this customer has a visit today.\n' : '') + lines.join('\n'),
    logTag: '[sms-inbound-office-email]',
    log: { customerId: (customer && customer.id) || null },
  }).catch((e) => console.error('[sms-inbound-office-email] unexpected:', e && e.message));
}

// Consent rows for a phone, with the customer joined (name/state for replies
// and the office email). Only consented-at-some-point numbers match — a
// stranger (or a service-team contact) has no row and stays unmatched.
async function matchCustomers(e164) {
  const { data, error } = await supabaseAdmin
    .from('generator_sms_consent')
    .select('id, customer_id, opted_in, opted_out, customer:generator_customers(id, name, install_state)')
    .eq('phone', e164);
  if (error) throw error;
  return data || [];
}

// The visit a "Y" confirms: the customer's next upcoming scheduled visit that
// hasn't been text-confirmed yet. Two-step query (subs then visits) keeps it
// readable; volume is tiny.
async function findVisitToConfirm(customerIds) {
  const { data: subs, error: subErr } = await supabaseAdmin
    .from('generator_subscriptions')
    .select('id')
    .in('customer_id', customerIds);
  if (subErr) throw subErr;
  const subIds = (subs || []).map((s) => s.id);
  if (!subIds.length) return null;

  const { data: visits, error: vErr } = await supabaseAdmin
    .from('generator_service_visits')
    .select('id, subscription_id, appointment_at, arrival_window, status, sms_confirmed_at')
    .in('subscription_id', subIds)
    .eq('status', 'scheduled')
    .is('sms_confirmed_at', null)
    .not('appointment_at', 'is', null)
    .gte('appointment_at', new Date().toISOString())
    .order('appointment_at', { ascending: true })
    .limit(1);
  if (vErr) throw vErr;
  return (visits && visits[0]) || null;
}

// The customer's conversation row (created on first contact), with the idle
// timeout already applied. Null when conversation state is unavailable
// (migration pending / query failure) - the webhook then behaves exactly as
// before the inbox existed. Never throws.
async function loadConversation({ customerId, e164, now }) {
  try {
    const conv = await ensureConversation({ customerId, phone: e164, now });
    return await resolveMode(conv, now);
  } catch (e) {
    console.error('[sms-inbound] conversation state unavailable (treating as auto):', e && e.message);
    return null;
  }
}

// Owner of an office-mode conversation, for the alert. Never throws.
async function ownerInfo(conv) {
  if (!conv || conv.mode !== 'office' || !conv.owner_profile_id) return null;
  try {
    const { data } = await supabaseAdmin
      .from('profiles').select('full_name, email').eq('id', conv.owner_profile_id).maybeSingle();
    return data ? { name: data.full_name || null, email: data.email || null } : { name: null, email: null };
  } catch (e) {
    return { name: null, email: null };
  }
}

// Core inbound processing, shared by the POST (v2 JSON) and GET (classic
// forwarding) shapes. Never throws — the webhook must always 200 so
// SimpleTexting doesn't consider us broken.
async function handleInbound({ fromPhone, toPhone, text, kind }) {
  const e164 = normalizePhone(fromPhone);
  if (!e164) {
    console.log('[sms-inbound] unparseable sender phone, ignoring');
    return;
  }

  // Platform unsubscribe report — no message text, just flip our flags.
  if (kind === 'unsubscribe') {
    const flipped = await optOutPhone(e164);
    await logSmsMessage({
      direction: 'in', from_phone: e164, to_phone: normalizePhone(toPhone),
      body: '[UNSUBSCRIBE_REPORT]', status: 'received',
      detail: 'platform unsubscribe; ' + flipped + ' consent row(s) opted out',
    });
    return;
  }

  let matches = [];
  try {
    matches = await matchCustomers(e164);
  } catch (e) {
    console.error('[sms-inbound] consent match failed:', e && e.message);
  }
  const matched = matches[0] || null; // a phone is nearly always one customer
  const customer = matched && matched.customer;
  const intent = classifyReply(text);
  const now = Date.now();

  // Inbox state (sql/037). Only for OUR customers - unmatched numbers get no
  // conversation row, exactly as before.
  let conv = (matched && customer && customer.id) ? await loadConversation({ customerId: customer.id, e164, now }) : null;
  const officeMode = !!(conv && conv.mode === 'office');

  await logSmsMessage({
    direction: 'in',
    from_phone: e164,
    to_phone: normalizePhone(toPhone),
    body: String(text || '').slice(0, 1600),
    status: 'received',
    detail: matched
      ? 'intent: ' + intent + (officeMode ? '; office mode - no automated reply' : '')
      : 'unmatched number (no Generator Care consent row)',
    customer_id: (customer && customer.id) || null,
  });

  // Not ours (shared account) — never reply to someone else's conversation.
  if (!matched) return;

  // Every text from the customer is activity; a Y needs no human answer,
  // free text and reschedule requests do. In office mode this also arms the
  // deferred owner alert for anything a person would answer (STOP/START/HELP
  // are carrier plumbing).
  if (conv) {
    const humanIntent = intent === 'confirm' || intent === 'reschedule' || intent === 'other';
    conv = await recordInbound({ conv, needsReply: intent === 'reschedule' || intent === 'other', armOwnerAlert: humanIntent, now });
    if (officeMode && humanIntent) scheduleOwnerAlert(conv);
  }

  if (intent === 'stop') {
    await optOutPhone(e164);
    return; // the platform sends the STOP confirmation (copy 8)
  }
  if (intent === 'start') {
    // Re-opt-in: the platform unblocks the number; re-arm our flags on every
    // row for the phone so sends resume.
    try {
      await supabaseAdmin
        .from('generator_sms_consent')
        .update({ opted_in: true, opted_out: false, opted_in_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .eq('phone', e164);
    } catch (e) {
      console.error('[sms-inbound] re-opt-in write failed:', e && e.message);
    }
    return;
  }
  if (intent === 'help' || intent === 'empty') return; // platform auto-replies to HELP

  const customerIds = matches.map((m) => m.customer_id).filter(Boolean);

  if (intent === 'confirm') {
    const visit = await findVisitToConfirm(customerIds).catch((e) => {
      console.error('[sms-inbound] visit lookup failed:', e && e.message);
      return null;
    });
    if (!visit) {
      console.log('[sms-inbound] Y from ' + e164 + ' but no unconfirmed upcoming visit - logged only');
      return;
    }
    const { error: confErr } = await supabaseAdmin
      .from('generator_service_visits')
      .update({ sms_confirmed_at: new Date().toISOString() })
      .eq('id', visit.id);
    if (confErr) {
      console.error('[sms-inbound] confirm stamp failed:', confErr.message);
      return;
    }
    if (officeMode) {
      // The visit is confirmed; the owner sees the Y in the inbox and answers.
      console.log('[sms-inbound] Y from ' + e164 + ' stamped visit ' + visit.id + ' - office mode, no automated reply');
      return;
    }
    await sendSms({
      toPhone: e164,
      body: buildConfirmedReplySms({
        installState: customer && customer.install_state,
        dateStr: visit.appointment_at ? visit.appointment_at.slice(0, 10) : null,
        windowCode: visit.arrival_window,
        link: DASHBOARD_URL,
      }),
      customerId: (customer && customer.id) || null,
      relatedVisitId: visit.id,
      ignoreQuietHours: true, // direct reply to a text they just sent
    });
    return;
  }

  // 'reschedule' or 'other' (free text). Both: NEVER auto-change the
  // appointment, always tell the office. The automated reply differs — the
  // dashboard link only for a clear reschedule request, a short holding
  // line for anything else — and is capped at one per 30 minutes per phone.
  //
  // OFFICE MODE: no automated reply at all. The owner is alerted ~10 minutes
  // later if they still haven't answered (recordInbound armed it above);
  // only an URGENT visit-day text emails right away - owner + office list.
  if (officeMode) {
    const visitTodayNow = await findVisitToday(customerIds, now);
    if (visitTodayNow) {
      const owner = await ownerInfo(conv);
      const to = [owner && owner.email].concat(OFFICE_NOTIFY_TO).filter(Boolean)
        .filter((addr, i, all) => all.findIndex((a) => a.toLowerCase() === addr.toLowerCase()) === i);
      await sendOfficeAlert({ customer, e164, text, intent, replied: false, visitToday: visitTodayNow, urgent: true, officeOwner: owner || { name: null, email: null }, to });
    } else {
      console.log('[sms-inbound] ' + intent + ' from ' + e164 + ' in office mode - no automated reply, owner alert deferred');
    }
    return;
  }

  let recentAt = null;
  try {
    recentAt = await recentAutoReplyAt(e164, now);
  } catch (e) {
    console.error('[sms-inbound] auto-reply window lookup failed (replying anyway):', e && e.message);
  }
  let replied = false;
  if (recentAt) {
    console.log('[sms-inbound] automated reply to ' + e164 + ' already sent at ' + recentAt + ' - alerting office only');
  } else {
    // Free text while the office is closed gets the honest version: closed
    // now, back "tomorrow morning" / "Monday morning" (lib/officeHours.js).
    // The reschedule link reply is unchanged either way.
    const body = intent === 'reschedule'
      ? buildRescheduleReplySms({ installState: customer && customer.install_state, link: DASHBOARD_URL })
      : (isOfficeOpen(now)
        ? buildHoldingReplySms({ installState: customer && customer.install_state })
        : buildAfterHoursReplySms({ installState: customer && customer.install_state, phrase: nextOpenPhrase(now) }));
    const r = await sendSms({
      toPhone: e164,
      body,
      customerId: (customer && customer.id) || null,
      ignoreQuietHours: true,
    });
    replied = !!(r && r.sent);
  }

  const visitToday = await findVisitToday(customerIds, now);
  await sendOfficeAlert({ customer, e164, text, intent, replied, visitToday, urgent: !!(visitToday && !recentAt) });
}

// POST — v2 "supercharged" webhook JSON.
router.post('/inbound', inboundLimiter, async (req, res) => {
  if (!verifySecret(req, res)) return;
  try {
    const b = req.body || {};
    const values = b.values || {};
    if (b.type === 'UNSUBSCRIBE_REPORT') {
      await handleInbound({ fromPhone: values.phone, toPhone: null, text: '', kind: 'unsubscribe' });
    } else if (!b.type || b.type === 'INCOMING_MESSAGE') {
      // Some integration styles POST flat { from, to, text } — accept both.
      await handleInbound({
        fromPhone: values.contactPhone || b.from || b.contactPhone,
        toPhone: values.accountPhone || b.to || b.accountPhone,
        text: values.text != null ? values.text : b.text,
        kind: 'message',
      });
    } // other report types (delivery etc.): acknowledge without action
    res.json({ ok: true });
  } catch (err) {
    console.error('[sms-inbound] handler error:', err && err.message);
    reportError(err, { route: '/api/sms/inbound', method: 'POST', user: 'simpletexting-webhook' }).catch(() => {});
    // Still 200 — a retry storm can't fix a code bug and would spam the log.
    res.json({ ok: true });
  }
});

// GET — classic "forward incoming messages" integration (?from=&to=&text=).
router.get('/inbound', inboundLimiter, async (req, res) => {
  if (!verifySecret(req, res)) return;
  try {
    await handleInbound({
      fromPhone: req.query.from,
      toPhone: req.query.to,
      text: req.query.text,
      kind: 'message',
    });
    res.json({ ok: true });
  } catch (err) {
    console.error('[sms-inbound] handler error:', err && err.message);
    reportError(err, { route: '/api/sms/inbound', method: 'GET', user: 'simpletexting-webhook' }).catch(() => {});
    res.json({ ok: true });
  }
});

module.exports = router;
// Test seam only (offline unit tests) — server.js mounts the router.
module.exports._test = { classifyReply, handleInbound, findVisitToConfirm, findVisitToday, recentAutoReplyAt, loadConversation };
