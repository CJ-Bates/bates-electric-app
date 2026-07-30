// backend/lib/mailer.js
// Single transactional-email transport for the whole app: Brevo
// (https://api.brevo.com/v3/smtp/email). Every send path — receipts, welcome,
// refund, visit-complete, card-update link, the daily digest cron, the Admin
// "send test email", and inspection reports — goes through sendViaBrevo so there
// is exactly one place that talks to the mail provider.
//
// Plain REST (Node 18+ global fetch) so there's no SDK dependency. Reads
// BREVO_API_KEY from the env; if it's missing we fail loudly (a clear log line)
// and return { sent:false } — callers decide whether that's fatal. Never throws.
//
// Every attempt also writes a generator_email_messages row (sql/033) — the
// email twin of lib/sms.js's message log — so the office dashboard can answer
// "did the customer get their email?". Logging is strictly best-effort: a
// failed insert is a console line, never a thrown error, and NEVER blocks or
// fails the send itself. The row stores subject/recipient/kind/status/
// provider id — no HTML body, no API key, no tokens, no magic-link URLs
// (scrubDetail strips anything credential-shaped from failure details).

const { supabaseAdmin } = require('./supabase');

const BREVO_ENDPOINT = 'https://api.brevo.com/v3/smtp/email';

// Failure details can echo provider responses. Before a detail string is
// stored, strip anything secret-shaped: Brevo API keys (xkeysib-...) and
// token-carrying URL params (magic links, set-password links). Same
// discipline as lib/sms.js, which logs a placeholder instead of the link.
function scrubDetail(s) {
  if (!s) return s;
  return String(s)
    .replace(/xkeysib-[A-Za-z0-9-]+/g, '[redacted-key]')
    .replace(/(\b(?:access_|refresh_)?token(?:_hash)?=)[^&\s"')]+/gi, '$1[redacted]')
    .replace(/(\b(?:api-?key|code|secret)=)[^&\s"')]+/gi, '$1[redacted]')
    .slice(0, 500);
}

// Best-effort audit row. Never throws; a logging failure must never stop an
// email from going out (or change what the caller sees).
async function logEmailMessage(row) {
  try {
    const { error } = await supabaseAdmin.from('generator_email_messages').insert(row);
    if (error) console.error('[mailer] email log insert failed:', error.message);
  } catch (e) {
    console.error('[mailer] email log insert failed:', e && e.message);
  }
}

// opts: { to, senderEmail, senderName, subject, html, text, replyTo?, log? }
//   to: a string, an array of strings, or an array of { email, name } objects.
//   replyTo: optional string email or { email, name }.
//   log: optional audit context for the generator_email_messages row —
//     { kind?, customerId?, subscriptionId?, relatedVisitId? }. Callers pass
//     what they have; with nothing we still log recipient/subject/status.
// Returns { sent: boolean, reason?: string, messageId?: string, statusCode?: number }.
async function sendViaBrevo({ to, senderEmail, senderName, subject, html, text, replyTo, log }) {
  const ctx = log || {};
  const recipients = (Array.isArray(to) ? to : [to])
    .filter(Boolean)
    .map((addr) => (typeof addr === 'string' ? { email: addr } : addr));

  // One audit row per attempt, sent or failed, always the same shape.
  const baseRow = {
    to_email: recipients.map((r) => r.email).filter(Boolean).join(', ').slice(0, 500) || null,
    subject: subject ? String(subject).slice(0, 500) : null,
    kind: ctx.kind || null,
    customer_id: ctx.customerId || null,
    subscription_id: ctx.subscriptionId || null,
    related_visit_id: ctx.relatedVisitId || null,
  };
  const fail = async (reason, statusCode) => {
    await logEmailMessage({ ...baseRow, status: 'failed', detail: scrubDetail(reason) });
    return { sent: false, reason, ...(statusCode ? { statusCode } : {}) };
  };

  const key = process.env.BREVO_API_KEY;
  if (!key) {
    console.error('[mailer] BREVO_API_KEY is not set — cannot send email. Add BREVO_API_KEY to the Render environment.');
    return fail('BREVO_API_KEY not set');
  }

  if (!recipients.length) return fail('no recipient');

  const payload = {
    sender: { email: senderEmail, name: senderName },
    to: recipients,
    subject,
    htmlContent: html,
    // Brevo requires htmlContent OR textContent; include text when we have it.
    ...(text ? { textContent: text } : {}),
  };
  if (replyTo) payload.replyTo = typeof replyTo === 'string' ? { email: replyTo } : replyTo;

  try {
    const resp = await fetch(BREVO_ENDPOINT, {
      method: 'POST',
      headers: {
        'api-key': key,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      return fail(`Brevo ${resp.status}: ${body.slice(0, 300)}`, resp.status);
    }
    const data = await resp.json().catch(() => ({}));
    const messageId = (data && data.messageId) || null;
    await logEmailMessage({ ...baseRow, status: 'sent', provider_id: messageId });
    return { sent: true, messageId: data && data.messageId, statusCode: resp.status };
  } catch (err) {
    return fail((err && err.message) || 'brevo request failed');
  }
}

module.exports = { sendViaBrevo, scrubDetail, logEmailMessage };
