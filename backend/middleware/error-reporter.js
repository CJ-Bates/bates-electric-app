// backend/middleware/error-reporter.js
// Global error reporting for the Bates Electric backend.
//
// Three escalating sinks, all optional except the console:
//   1. console      -- always; logs route, method, user, message, stack.
//   2. Sentry       -- if process.env.SENTRY_DSN is set (@sentry/node).
//   3. email alert  -- if process.env.ALERT_EMAIL is set (via Brevo).
//
// With NO env vars set this degrades cleanly to console-only logging, so the
// app runs identically in dev and in prod-before-CJ-adds-the-keys. The Sentry
// require is lazy + guarded so a missing @sentry/node module can never crash
// the server on boot.
//
// Two entry points:
//   errorReporter(err, req, res, next) -- Express error-handling middleware.
//   reportError(err, context)          -- callable directly (e.g. from the
//                                         Stripe webhook try/catch, where we
//                                         can't lose visibility).

const { sendEmail } = require('../lib/emails');

let _sentry = null;
let _sentryTried = false;

// ============================================================================
// Sentry event scrubbing. Our own sinks log req.path (never originalUrl), but
// @sentry/node v8+ auto-instruments incoming HTTP and attaches the FULL
// request URL + query string to captured events — which would ship webhook
// shared secrets (?secret= on /api/email/events and /api/sms/inbound) and
// tokens (?token= on the unsubscribe link) off-site. beforeSend redacts the
// VALUES of secret-shaped query params and of credential-bearing headers
// (X-Webhook-Secret, Authorization — Supabase JWTs ride there on every authed
// call — and Cookie) from the event before it leaves the process. We do not
// rely on Sentry's server-side default scrubbing for any of these. If
// scrubbing itself throws, the event still goes out — but with its request
// data and breadcrumbs DROPPED (fail closed on the payload that might hold a
// secret) while the exception + stack are kept for visibility.
// ============================================================================
const SECRET_PARAM_RE = /^(secret|token|token_hash|access_token|refresh_token|code|api-?key)$/i;
const SECRET_HEADER_RE = /^(x-webhook-secret|authorization|cookie)$/i;

function scrubSecretParams(s) {
  if (typeof s !== 'string' || !s) return s;
  return s.replace(/(\b(?:secret|token|token_hash|access_token|refresh_token|code|api-?key)=)[^&\s"']*/gi, '$1[redacted]');
}

function scrubSentryEvent(event) {
  try {
    const req = event && event.request;
    if (req) {
      if (typeof req.url === 'string') req.url = scrubSecretParams(req.url);
      if (typeof req.query_string === 'string') {
        req.query_string = scrubSecretParams(req.query_string);
      } else if (req.query_string && typeof req.query_string === 'object') {
        for (const k of Object.keys(req.query_string)) {
          if (SECRET_PARAM_RE.test(k)) req.query_string[k] = '[redacted]';
        }
      }
      if (req.headers && typeof req.headers === 'object') {
        for (const k of Object.keys(req.headers)) {
          if (SECRET_HEADER_RE.test(k)) req.headers[k] = '[redacted]';
        }
      }
    }
    // http breadcrumbs carry URLs too (incoming and outgoing).
    if (Array.isArray(event && event.breadcrumbs)) {
      for (const b of event.breadcrumbs) {
        if (b && b.data) {
          if (typeof b.data.url === 'string') b.data.url = scrubSecretParams(b.data.url);
          if (typeof b.data['http.query'] === 'string') b.data['http.query'] = scrubSecretParams(b.data['http.query']);
        }
      }
    }
  } catch (e) {
    // Fail closed: if the scrub itself broke, the request data / breadcrumbs
    // may still hold a secret — drop them and send the event without them
    // (exception + stack survive, which is what debugging actually needs).
    console.error('[error-reporter] Sentry scrub failed (request data dropped from event):', (e && e.message) || e);
    try {
      if (event && typeof event === 'object') {
        delete event.request;
        delete event.breadcrumbs;
      }
    } catch (e2) {
      console.error('[error-reporter] Sentry scrub cleanup failed:', (e2 && e2.message) || e2);
    }
  }
  return event;
}

// Lazily require + init Sentry. Idempotent. Returns the Sentry module or null.
// Gated on SENTRY_DSN so it's a no-op until CJ adds the env var in Render.
function initSentry() {
  if (_sentryTried) return _sentry;
  _sentryTried = true;
  if (!process.env.SENTRY_DSN) return null;
  try {
    const Sentry = require('@sentry/node');
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      // Strip webhook secrets / tokens from every outbound event (see above).
      beforeSend: scrubSentryEvent,
      beforeSendTransaction: scrubSentryEvent,
    });
    _sentry = Sentry;
    console.log('[error-reporter] Sentry initialized');
  } catch (e) {
    // Module not installed / init failed -- log and carry on console-only.
    console.error('[error-reporter] Sentry unavailable:', (e && e.message) || e);
    _sentry = null;
  }
  return _sentry;
}

function buildAlertEmail(err, { route, method, user }) {
  const message = (err && err.message) || String(err);
  const stack = (err && err.stack) || '(no stack)';
  const when = new Date().toISOString();
  const rows = [
    ['Time', when],
    ['Route', `${method || '?'} ${route || '?'}`],
    ['User', user || '(unauthenticated)'],
    ['Message', message],
  ];
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const html =
    `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#111827;">` +
    `<h2 style="color:#b91c1c;font-size:16px;margin:0 0 12px;">Backend error</h2>` +
    `<table cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:13px;">` +
    rows.map(([k, v]) =>
      `<tr><td style="padding:3px 12px 3px 0;color:#6b7280;vertical-align:top;">${esc(k)}</td>` +
      `<td style="padding:3px 0;color:#111827;font-weight:600;">${esc(v)}</td></tr>`
    ).join('') +
    `</table>` +
    `<pre style="margin:16px 0 0;padding:12px;background:#f9fafb;border:1px solid #e5e7eb;` +
    `border-radius:6px;font-size:12px;white-space:pre-wrap;overflow-x:auto;color:#374151;">${esc(stack)}</pre>` +
    `</div>`;
  const text =
    `Backend error\n\n` +
    rows.map(([k, v]) => `${k}: ${v}`).join('\n') +
    `\n\nStack:\n${stack}\n`;
  return { subject: `[Bates Electric] Backend error: ${message}`, html, text };
}

// Core reporter. Never throws. Safe to call without awaiting (webhook path).
async function reportError(err, context = {}) {
  const { route, method, user } = context;
  const message = (err && err.message) || String(err);

  // 1. Console -- always.
  console.error(
    `[error-reporter] ${method || ''} ${route || ''}` +
    (user ? ` user=${user}` : '') + ` :: ${message}`
  );
  if (err && err.stack) console.error(err.stack);

  // 2. Sentry -- if configured.
  const Sentry = initSentry();
  if (Sentry) {
    try {
      Sentry.withScope((scope) => {
        if (route) scope.setTag('route', route);
        if (method) scope.setTag('method', method);
        if (user) scope.setUser({ email: user });
        Sentry.captureException(err);
      });
    } catch (e) {
      console.error('[error-reporter] Sentry capture failed:', (e && e.message) || e);
    }
  }

  // 3. Email alert -- if configured. Fire-and-forget; failures only logged.
  if (process.env.ALERT_EMAIL) {
    try {
      const { subject, html, text } = buildAlertEmail(err, context);
      await sendEmail({
        to: process.env.ALERT_EMAIL,
        subject,
        html,
        text,
        logTag: '[error-alert]',
      });
    } catch (e) {
      console.error('[error-reporter] alert email failed:', (e && e.message) || e);
    }
  }
}

// Express error-handling middleware (4-arg signature). Mount LAST, after all
// routes. Returns a generic 500 -- never leaks the stack to the client.
function errorReporter(err, req, res, next) {
  // Errors that middleware marked as client-caused (body-parser's malformed
  // JSON = 400, over-limit body = 413, etc.) are not server faults: return the
  // real status with a clean message and skip the Sentry/alert escalation.
  const clientStatus = err && (err.status || err.statusCode);
  if (clientStatus >= 400 && clientStatus < 500) {
    console.warn(
      `[error-reporter] client error ${clientStatus} on ` +
      // req.path (never req.originalUrl) so query strings — which can carry
      // secrets/tokens (SMS webhook secret, unsubscribe token) — never reach logs.
      `${(req && req.method) || '?'} ${(req && (req.path || req.url)) || '?'}: ` +
      ((err && err.message) || err)
    );
    if (res.headersSent) return next(err);
    const message = err.type === 'entity.too.large'
      ? 'Request body too large.'
      : 'Invalid request.';
    return res.status(clientStatus).json({ error: message });
  }

  reportError(err, {
    // req.path, not req.originalUrl — keep query-string secrets/tokens out of
    // the console/Sentry/alert-email sinks.
    route: (req && (req.path || req.url)) || undefined,
    method: req && req.method,
    user: (req && req.profile && req.profile.email)
      || (req && req.user && req.user.email)
      || undefined,
  }).catch(() => {});

  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Server error' });
}

module.exports = { errorReporter, reportError, initSentry };
// Test seam only (offline unit tests).
module.exports._test = { scrubSentryEvent, scrubSecretParams };
