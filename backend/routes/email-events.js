// backend/routes/email-events.js
// PUBLIC (no-auth) webhook Brevo calls with transactional-email delivery
// events (delivered, bounced, spam, deferred...). "Sent" in
// generator_email_messages only means Brevo ACCEPTED the message; this
// endpoint records what actually happened afterwards, keyed by Brevo's
// message id, so the office Email History card can show "Delivered" or
// "Bounced" instead of a hopeful "Sent".
//
// Same security posture as routes/sms-inbound.js: deliberately outside every
// authed router (Brevo can't hold a session) but NOT open — every request
// must carry the shared secret. PREFER the X-Webhook-Secret header: Brevo's
// webhooks API (POST /v3/webhooks) accepts custom headers on the webhook
// definition, and a header stays out of URLs and anything that captures
// them. The ?secret=<EMAIL_WEBHOOK_SECRET> query form is the fallback for a
// webhook created in the Brevo UI, which only takes a URL — and is why
// middleware/error-reporter.js scrubs secret-shaped query params from every
// Sentry event (the SDK otherwise attaches full request URLs). Timing-safe
// compare, rate-limited, fails closed when the env var isn't set. Handler
// errors and unmatched message ids still return 200 — a non-2xx makes Brevo
// retry (up to 24h of storms) and a retry can't fix a code bug.
//
// Payload (Brevo transactional webhook, one JSON object per POST):
//   { event: 'delivered' | 'soft_bounce' | 'hard_bounce' | 'blocked' |
//     'spam' | 'invalid_email' | 'deferred' | 'error' | 'request' |
//     'click' | 'opened' | ..., email, 'message-id': '<...@smtp-relay...>',
//     reason?, date?, ts_event?, subject?, tag? }
// Engagement events (request/click/opened/proxy variants) are acknowledged
// and ignored — this log tracks delivery, not tracking pixels.

const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const { supabaseAdmin } = require('../lib/supabase');
const { scrubDetail } = require('../lib/mailer');
const { reportError } = require('../middleware/error-reporter');

const router = express.Router();

// Real traffic is one event per email sent (plus retries); a digest or invite
// batch can burst a few dozen at once. Cap well above that.
const eventsLimiter = rateLimit({
  windowMs: 60 * 1000, limit: 240, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many requests' },
});

// Constant-time secret check — same shape as routes/sms-inbound.js.
// Missing env = fail closed, never "open while unconfigured".
function safeEqual(a, b) {
  const ba = Buffer.from(String(a == null ? '' : a));
  const bb = Buffer.from(String(b == null ? '' : b));
  if (ba.length !== bb.length) return false;      // timingSafeEqual requires equal length
  return crypto.timingSafeEqual(ba, bb);
}
function verifySecret(req, res) {
  const expected = process.env.EMAIL_WEBHOOK_SECRET;
  if (!expected) {
    console.error('[email-events] EMAIL_WEBHOOK_SECRET is not set - rejecting all webhook calls.');
    res.status(403).json({ error: 'not configured' });
    return false;
  }
  const headerSecret = (req.headers && req.headers['x-webhook-secret']) || '';
  const provided = headerSecret || (req.query && req.query.secret) || '';
  if (!safeEqual(provided, expected)) {
    res.status(403).json({ error: 'forbidden' });
    return false;
  }
  return true;
}

// Brevo event -> our delivery_status. Terminal statuses are final answers;
// transient ones (still in flight / retrying) never overwrite a terminal one.
// A terminal event always writes — so a spam complaint that arrives after
// 'delivered' still surfaces (that's real information for the office).
const TERMINAL = new Set(['delivered', 'hard_bounce', 'blocked', 'spam', 'invalid_email']);
const TRANSIENT = new Set(['soft_bounce', 'deferred', 'error']);
const EVENT_MAP = {
  delivered: 'delivered',
  hard_bounce: 'hard_bounce',
  soft_bounce: 'soft_bounce',
  blocked: 'blocked',
  spam: 'spam',
  complaint: 'spam',
  invalid_email: 'invalid_email',
  deferred: 'deferred',
  error: 'error',
};

// Core event processing. Never throws — callers already 200 regardless.
async function handleEvent(b) {
  const status = EVENT_MAP[b && b.event];
  if (!status) return; // request/click/opened/etc. — acknowledge, no action

  const messageId = (b['message-id'] || b.messageId || b.message_id || '').toString().trim();
  if (!messageId) {
    console.log('[email-events] ' + b.event + ' event with no message-id, ignoring');
    return;
  }

  const { data: rows, error: selErr } = await supabaseAdmin
    .from('generator_email_messages')
    .select('id, delivery_status')
    .eq('provider_id', messageId)
    .limit(1);
  if (selErr) {
    console.error('[email-events] lookup failed:', selErr.message);
    return;
  }
  const row = rows && rows[0];
  if (!row) {
    // Not ours (pre-033 sends, or another sender on the same Brevo account) —
    // record the miss in the server log and move on. Never an error to Brevo.
    console.log('[email-events] no logged email matches message-id ' + messageId + ' (event: ' + b.event + ')');
    return;
  }

  // Precedence: a transient event never overwrites a terminal answer.
  if (TRANSIENT.has(status) && TERMINAL.has(row.delivery_status)) return;

  const when = b.date ? new Date(b.date) : (b.ts_event ? new Date(b.ts_event * 1000) : new Date());
  const { error: updErr } = await supabaseAdmin
    .from('generator_email_messages')
    .update({
      delivery_status: status,
      delivery_detail: b.reason ? scrubDetail(String(b.reason)) : null,
      delivery_at: isNaN(when.getTime()) ? new Date().toISOString() : when.toISOString(),
    })
    .eq('id', row.id);
  if (updErr) console.error('[email-events] update failed:', updErr.message);
}

// POST /api/email/events — Brevo posts one event object per call; a JSON
// array is accepted too in case a batch style ever shows up.
router.post('/events', eventsLimiter, async (req, res) => {
  if (!verifySecret(req, res)) return;
  try {
    const body = req.body;
    const events = Array.isArray(body) ? body : [body];
    for (const b of events) {
      if (b && typeof b === 'object') await handleEvent(b);
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[email-events] handler error:', err && err.message);
    reportError(err, { route: '/api/email/events', method: 'POST', user: 'brevo-webhook' }).catch(() => {});
    // Still 200 — a retry storm can't fix a code bug and would spam the log.
    res.json({ ok: true });
  }
});

module.exports = router;
// Test seam only (offline unit tests) — server.js mounts the router.
module.exports._test = { handleEvent, verifySecret, EVENT_MAP };
