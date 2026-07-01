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

const BREVO_ENDPOINT = 'https://api.brevo.com/v3/smtp/email';

// opts: { to, senderEmail, senderName, subject, html, text, replyTo? }
//   to: a string, an array of strings, or an array of { email, name } objects.
//   replyTo: optional string email or { email, name }.
// Returns { sent: boolean, reason?: string, messageId?: string, statusCode?: number }.
async function sendViaBrevo({ to, senderEmail, senderName, subject, html, text, replyTo }) {
  const key = process.env.BREVO_API_KEY;
  if (!key) {
    console.error('[mailer] BREVO_API_KEY is not set — cannot send email. Add BREVO_API_KEY to the Render environment.');
    return { sent: false, reason: 'BREVO_API_KEY not set' };
  }

  const recipients = (Array.isArray(to) ? to : [to])
    .filter(Boolean)
    .map((addr) => (typeof addr === 'string' ? { email: addr } : addr));
  if (!recipients.length) return { sent: false, reason: 'no recipient' };

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
      return { sent: false, reason: `Brevo ${resp.status}: ${body.slice(0, 300)}`, statusCode: resp.status };
    }
    const data = await resp.json().catch(() => ({}));
    return { sent: true, messageId: data && data.messageId, statusCode: resp.status };
  } catch (err) {
    return { sent: false, reason: (err && err.message) || 'brevo request failed' };
  }
}

module.exports = { sendViaBrevo };
