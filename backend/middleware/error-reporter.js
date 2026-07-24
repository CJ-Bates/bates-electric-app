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

// Lazily require + init Sentry. Idempotent. Returns the Sentry module or null.
// Gated on SENTRY_DSN so it's a no-op until CJ adds the env var in Render.
function initSentry() {
  if (_sentryTried) return _sentry;
  _sentryTried = true;
  if (!process.env.SENTRY_DSN) return null;
  try {
    const Sentry = require('@sentry/node');
    Sentry.init({ dsn: process.env.SENTRY_DSN });
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
