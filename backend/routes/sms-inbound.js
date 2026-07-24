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
//   anything else -> reschedule intent: reply copy (5) with the dashboard
//               link and email the office. NEVER auto-change the appointment.
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
  sendSms,
  logSmsMessage,
  optOutPhone,
} = require('../lib/sms');
const { reportError } = require('../middleware/error-reporter');

const router = express.Router();

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
function classifyReply(text) {
  const t = String(text || '').trim().toUpperCase().replace(/[.!?,\s]+$/g, '').replace(/^[\s]+/g, '');
  if (!t) return 'empty';
  if (/^(Y|YES)$/.test(t)) return 'confirm';
  // Carrier-standard opt-out keywords (the platform intercepts most of these;
  // we mirror the flag so our own gate never depends on the provider).
  if (/^(STOP|STOPALL|UNSUBSCRIBE|CANCEL|END|QUIT)$/.test(t)) return 'stop';
  if (/^(START|UNSTOP|YES SUBSCRIBE)$/.test(t)) return 'start';
  if (/^(HELP|INFO)$/.test(t)) return 'help';
  return 'other';
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

  await logSmsMessage({
    direction: 'in',
    from_phone: e164,
    to_phone: normalizePhone(toPhone),
    body: String(text || '').slice(0, 1600),
    status: 'received',
    detail: matched ? 'intent: ' + intent : 'unmatched number (no Generator Care consent row)',
    customer_id: (customer && customer.id) || null,
  });

  // Not ours (shared account) — never reply to someone else's conversation.
  if (!matched) return;

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

  // Anything else = reschedule intent: point them at the dashboard slot
  // picker and flag the office. The appointment itself is NEVER auto-changed.
  await sendSms({
    toPhone: e164,
    body: buildRescheduleReplySms({
      installState: customer && customer.install_state,
      link: DASHBOARD_URL,
    }),
    customerId: (customer && customer.id) || null,
    ignoreQuietHours: true,
  });
  const name = (customer && customer.name) || e164;
  const line = 'Text reply from ' + name + ' (' + e164 + '): "' + String(text || '').slice(0, 500) + '" - they were sent the reschedule link; no appointment was changed.';
  sendEmail({
    to: OFFICE_NOTIFY_TO,
    subject: '[Generator Care] Text reply needs a look: ' + name,
    html: '<p style="font-family:system-ui,sans-serif;font-size:14px;">' + escHtml(line) + '</p>',
    text: line,
    logTag: '[sms-inbound-office-email]',
  }).catch((e) => console.error('[sms-inbound-office-email] unexpected:', e && e.message));
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
module.exports._test = { classifyReply, handleInbound, findVisitToConfirm };
