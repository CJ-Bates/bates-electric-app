// backend/lib/emails.js
// Shared email scaffolding for the Generator Care program.
// All customer-facing transactional emails (welcome, card-failed, portal link,
// resend-welcome, admin test-sends) go through this module so the brand
// header/footer, phone number, and SendGrid config live in one place.

const sgMail = require('@sendgrid/mail');

// Single source of truth for branding details surfaced inside email bodies.
const COMPANY_PHONE = '(636) 464-3939';
const SENDER_NAME = 'Bates Electric Generator Care';

function getFromEmail() {
  return process.env.GENERATOR_DIGEST_FROM || 'no-reply@bates-electric.com';
}

let _keyConfigured = false;
function ensureSendGridKey() {
  const key = process.env.SENDGRID_API_KEY;
  if (!key) return false;
  if (!_keyConfigured) {
    sgMail.setApiKey(key);
    _keyConfigured = true;
  }
  return true;
}

function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// Renders the centered navy CTA button as a standalone <p>...</p> block.
// Use inside bodyHtml when the button is not the last visual element.
function ctaButton(text, url) {
  if (!text || !url) return '';
  return `<p style="text-align:center;margin:24px 0;">` +
    `<a href="${url}" style="display:inline-block;background:#1F3A5F;color:#fff;text-decoration:none;padding:14px 28px;border-radius:6px;font-weight:600;font-size:15px;">${escHtml(text)}</a>` +
    `</p>`;
}

// Wraps a body in the branded navy-header/light-footer shell.
// heading and bodyHtml are inserted verbatim as HTML — caller must
// escape any user-provided values (use escHtml).
// ctaText/ctaUrl are optional; when both present, renders a centered
// navy CTA button between the body and the footer (use ctaButton()
// directly inside bodyHtml if the button needs to appear elsewhere).
function renderEmail({ heading, bodyHtml, ctaText, ctaUrl }) {
  const ctaBlock = ctaButton(ctaText, ctaUrl);
  return '<!DOCTYPE html>' +
    '<html><body style="margin:0;padding:0;background:#F4F6F9;font-family:system-ui,-apple-system,sans-serif;color:#1F3A5F;">' +
    '<div style="max-width:600px;margin:0 auto;background:#fff;">' +
    '<div style="background:#1F3A5F;padding:24px 28px;text-align:center;">' +
    '<h1 style="color:#fff;margin:0;font-size:22px;letter-spacing:0.5px;">Bates Electric</h1>' +
    '<p style="color:#DFE6F0;margin:6px 0 0;font-size:13px;letter-spacing:1px;text-transform:uppercase;">Generator Care</p>' +
    '</div>' +
    `<div style="padding:28px;">` +
    `<h2 style="margin:0 0 14px;font-size:20px;color:#1F3A5F;">${heading}</h2>` +
    bodyHtml +
    ctaBlock +
    '</div>' +
    '<div style="background:#F4F6F9;padding:18px 28px;text-align:center;border-top:1px solid #E5E7EB;">' +
    `<p style="margin:0;font-size:12px;color:#6B7280;">Bates Electric, Inc. · ${COMPANY_PHONE}</p>` +
    '</div>' +
    '</div></body></html>';
}

// Sends an email via SendGrid. Returns { sent: boolean, reason?: string }.
// Never throws — webhook callers must not surface failures as 500s
// (Stripe would retry on 500).
async function sendEmail({ to, subject, html, text, logTag }) {
  const tag = logTag || '[email]';
  if (!ensureSendGridKey()) {
    console.log(`${tag} SENDGRID_API_KEY not set, skipping`);
    return { sent: false, reason: 'SENDGRID_API_KEY not set' };
  }
  if (!to || (Array.isArray(to) && to.length === 0)) {
    console.log(`${tag} no recipient, skipping`);
    return { sent: false, reason: 'no recipient' };
  }
  try {
    const response = await sgMail.send({
      to,
      from: { email: getFromEmail(), name: SENDER_NAME },
      subject,
      text,
      html,
    });
    const recipients = Array.isArray(to) ? to.join(', ') : to;
    console.log(`${tag} sent to ${recipients}`);
    return { sent: true, response };
  } catch (err) {
    const detail = err && err.response ? JSON.stringify(err.response.body) : (err && err.message) || String(err);
    console.error(`${tag} error:`, detail);
    return { sent: false, reason: (err && err.message) || 'unknown' };
  }
}

// ---- Template builders (pure functions) ----
// Each returns { subject, html, text } from primitive inputs so the templates
// can be rendered by the webhook handlers, the resend-welcome endpoint, and
// the admin test-send endpoint without duplication.

function buildWelcomeEmail({ customer, meta, planLabel, nextVisitDate, annualPriceCents, fleetMonitoring }) {
  const fmtMoney = (c) => '$' + ((c || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtDate = (s) => {
    if (!s) return '';
    const d = new Date(s + 'T12:00:00');
    return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  };
  const safeMeta = meta || {};
  const genClass = safeMeta.gen_class === 'air_cooled'
    ? 'Air cooled'
    : (safeMeta.gen_class && safeMeta.gen_class.startsWith('liquid') ? 'Liquid cooled' : '');
  const genLine = [genClass, safeMeta.gen_type, safeMeta.gen_model, safeMeta.gen_serial && ('s/n ' + safeMeta.gen_serial)]
    .filter(Boolean).join(' • ');
  const addr = [safeMeta.install_address, safeMeta.install_city, safeMeta.install_state, safeMeta.install_zip]
    .filter(Boolean).join(', ');
  const name = (customer && customer.name) || 'there';

  const bodyHtml =
    `<p style="margin:0 0 18px;line-height:1.55;color:#374151;">Thanks for signing up for Bates Electric&rsquo;s Generator Care program. We&rsquo;ve got everything we need on our end and your subscription is active.</p>` +
    `<h3 style="margin:24px 0 10px;font-size:13px;color:#6B7280;text-transform:uppercase;letter-spacing:0.08em;">What happens next</h3>` +
    `<ol style="margin:0;padding-left:20px;color:#374151;line-height:1.7;">` +
    `<li>One of our team will reach out within the next few business days to schedule your first maintenance visit.</li>` +
    `<li>Our technicians will perform a full inspection and any included services per your plan.</li>` +
    `<li>From there, we&rsquo;ll auto-schedule your recurring visits based on your plan.</li>` +
    `</ol>` +
    `<h3 style="margin:28px 0 10px;font-size:13px;color:#6B7280;text-transform:uppercase;letter-spacing:0.08em;">Your plan</h3>` +
    `<table style="width:100%;border-collapse:collapse;font-size:14px;color:#374151;">` +
    `<tr><td style="padding:6px 0;color:#6B7280;width:40%;">Plan</td><td style="padding:6px 0;font-weight:600;">${escHtml(planLabel)}</td></tr>` +
    (genLine ? `<tr><td style="padding:6px 0;color:#6B7280;">Generator</td><td style="padding:6px 0;font-weight:600;">${escHtml(genLine)}</td></tr>` : '') +
    (addr ? `<tr><td style="padding:6px 0;color:#6B7280;vertical-align:top;">Service address</td><td style="padding:6px 0;font-weight:600;">${escHtml(addr)}</td></tr>` : '') +
    (nextVisitDate ? `<tr><td style="padding:6px 0;color:#6B7280;vertical-align:top;">First visit</td><td style="padding:6px 0;font-weight:600;">${escHtml(fmtDate(nextVisitDate))}<br><span style="color:#6B7280;font-weight:400;font-size:12px;">We&rsquo;ll confirm the exact time when we call.</span></td></tr>` : '') +
    `<tr><td style="padding:6px 0;color:#6B7280;">Annual billing</td><td style="padding:6px 0;font-weight:600;">${escHtml(fmtMoney(annualPriceCents))}/year</td></tr>` +
    (fleetMonitoring ? `<tr><td style="padding:6px 0;color:#6B7280;">Add-on</td><td style="padding:6px 0;font-weight:600;">Fleet Monitoring (Mobile Link)</td></tr>` : '') +
    `</table>` +
    `<p style="margin:28px 0 0;line-height:1.55;color:#374151;">Have questions, need to reschedule, or want to update your card? Give us a call at <strong>${COMPANY_PHONE}</strong>.</p>` +
    `<p style="margin:18px 0 0;color:#6B7280;font-size:14px;">— The Bates Electric team</p>`;

  const html = renderEmail({
    heading: `Welcome aboard, ${escHtml(name)}!`,
    bodyHtml,
  });

  const text = `Welcome to Bates Electric Generator Care, ${name}!\n\n` +
    `Thanks for signing up. Your subscription is active and we’ve got everything we need on our end.\n\n` +
    `What happens next:\n` +
    `1. We’ll reach out within the next few business days to schedule your first visit.\n` +
    `2. Our technicians will perform a full inspection and any included services per your plan.\n` +
    `3. From there, we’ll auto-schedule your recurring visits.\n\n` +
    `Your plan: ${planLabel}\n` +
    (genLine ? `Generator: ${genLine}\n` : '') +
    (addr ? `Service address: ${addr}\n` : '') +
    (nextVisitDate ? `First visit: ${fmtDate(nextVisitDate)} (we will confirm time)\n` : '') +
    `Annual billing: ${fmtMoney(annualPriceCents)}/year\n` +
    (fleetMonitoring ? `Add-on: Fleet Monitoring (Mobile Link)\n` : '') +
    `\nQuestions? Give us a call at ${COMPANY_PHONE}.\n\n— Bates Electric`;

  return { subject: 'Welcome to Bates Electric Generator Care!', html, text };
}

function buildCardFailedEmail({ customer, amountCents, description, portalUrl }) {
  const fmtMoney = (c) => '$' + ((c || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const amountLine = amountCents ? ' of ' + fmtMoney(amountCents) : '';
  const descLine = description ? ' for ' + description : '';
  const name = (customer && customer.name) || 'there';

  const bodyHtml =
    `<p style="margin:0 0 14px;line-height:1.55;color:#374151;">Hi ${escHtml(name)},</p>` +
    `<p style="margin:0 0 14px;line-height:1.55;color:#374151;">We tried to charge your card on file${escHtml(amountLine)}${escHtml(descLine)} and it didn&rsquo;t go through. Usually it&rsquo;s something simple — an expired card, a daily limit, or the bank flagging the charge.</p>` +
    `<p style="margin:0 0 14px;line-height:1.55;color:#374151;">You can update your card on file with one click:</p>` +
    ctaButton('Update your card', portalUrl) +
    `<p style="margin:0 0 10px;color:#6B7280;font-size:13px;line-height:1.5;">The link is good for a few days. While you&rsquo;re in there you can also see your invoice history or update your contact info.</p>` +
    `<p style="margin:16px 0 0;color:#374151;font-size:14px;line-height:1.55;">If you&rsquo;d rather handle it over the phone or have any questions, just call us at <strong>${COMPANY_PHONE}</strong>.</p>` +
    `<p style="margin:18px 0 0;color:#6B7280;font-size:14px;">— The Bates Electric team</p>`;

  const html = renderEmail({
    heading: `Quick favor — your card didn’t go through`,
    bodyHtml,
  });

  const text = `Hi ${name},\n\n` +
    `We tried to charge your card on file${amountLine}${descLine} and it didn’t go through. Usually it’s something simple — expired card, daily limit, or the bank flagging the charge.\n\n` +
    `You can update your card here:\n${portalUrl}\n\n` +
    `If you’d rather handle it over the phone, just call ${COMPANY_PHONE}.\n\n` +
    `— Bates Electric`;

  return { subject: 'Your card on file needs an update', html, text };
}

function buildCardUpdateLinkEmail({ name, portalUrl }) {
  const safeName = name || 'there';

  const bodyHtml =
    `<p style="margin:0 0 14px;line-height:1.55;color:#374151;">Hi ${escHtml(safeName)},</p>` +
    `<p style="margin:0 0 14px;line-height:1.55;color:#374151;">Here is a secure link to your generator care account. You can use it to update your card on file, view your invoice history, or change your contact info — all in one place.</p>` +
    ctaButton('Manage my account', portalUrl) +
    `<p style="margin:0 0 10px;color:#6B7280;font-size:13px;line-height:1.5;">The link is good for about an hour. If it expires before you click it, give us a call at <strong>${COMPANY_PHONE}</strong> and we&rsquo;ll get you a fresh one.</p>` +
    `<p style="margin:16px 0 0;color:#374151;font-size:14px;line-height:1.55;">Questions? Give us a call at <strong>${COMPANY_PHONE}</strong>.</p>` +
    `<p style="margin:18px 0 0;color:#6B7280;font-size:14px;">— The Bates Electric team</p>`;

  const html = renderEmail({
    heading: 'Manage your generator care account',
    bodyHtml,
  });

  const text = `Hi ${safeName},\n\n` +
    `Here is a secure link to your Bates Electric generator care account. You can use it to update your card on file, view your invoice history, or change your contact info.\n\n` +
    `${portalUrl}\n\n` +
    `The link is good for about an hour. If it expires, give us a call at ${COMPANY_PHONE} and we'll get you a fresh one.\n\n` +
    `Questions? Give us a call at ${COMPANY_PHONE}.\n\n— Bates Electric`;

  return { subject: 'Manage your Bates Electric generator care account', html, text };
}

function fmtFriendlyDate(s) {
  if (!s) return '';
  const d = new Date(s + 'T12:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

function buildVisitScheduledEmail({ customer, scheduledDate, planLabel }) {
  const name = (customer && customer.name) || 'there';
  const dateStr = fmtFriendlyDate(scheduledDate);
  const planText = planLabel ? `${planLabel} ` : '';

  const bodyHtml =
    `<p style="margin:0 0 14px;line-height:1.55;color:#374151;">Hi ${escHtml(name)},</p>` +
    `<p style="margin:0 0 14px;line-height:1.55;color:#374151;">Your ${escHtml(planText)}generator service visit is confirmed for <strong>${escHtml(dateStr)}</strong>.</p>` +
    `<p style="margin:0 0 14px;line-height:1.55;color:#374151;">Our technician will be on-site to perform a full inspection and any services included in your plan. You don&rsquo;t need to be there as long as the generator is accessible &mdash; though we&rsquo;re happy to walk you through what we did if you are.</p>` +
    `<p style="margin:16px 0 0;color:#374151;font-size:14px;line-height:1.55;">Need to reschedule or have a question? Give us a call at <strong>${COMPANY_PHONE}</strong>.</p>` +
    `<p style="margin:18px 0 0;color:#6B7280;font-size:14px;">— The Bates Electric team</p>`;

  const html = renderEmail({
    heading: 'Your service visit is confirmed',
    bodyHtml,
  });

  const text = `Hi ${name},\n\n` +
    `Your ${planText}generator service visit is confirmed for ${dateStr}.\n\n` +
    `Our technician will perform a full inspection and any included services. You don't need to be there as long as the generator is accessible.\n\n` +
    `Need to reschedule? Give us a call at ${COMPANY_PHONE}.\n\n— Bates Electric`;

  return { subject: 'Your generator service visit is confirmed', html, text };
}

function buildVisitCompletedEmail({ customer, completedDate, nextVisitDate, planLabel, notes }) {
  const name = (customer && customer.name) || 'there';
  const completedStr = fmtFriendlyDate(completedDate);
  const planText = planLabel ? `${planLabel} ` : '';

  const notesSection = (typeof notes === 'string' && notes.trim().length > 0)
    ? `<p style="margin:16px 0 0;color:#374151;font-size:14px;line-height:1.55;"><strong>Notes from the visit:</strong><br>${escHtml(notes.trim())}</p>`
    : '';

  const nextVisitSection = nextVisitDate
    ? `<p style="margin:16px 0 0;line-height:1.55;color:#374151;">Your next ${escHtml(planText)}service is tentatively scheduled for <strong>${escHtml(fmtFriendlyDate(nextVisitDate))}</strong>. We&rsquo;ll confirm the exact date with you closer to the time.</p>`
    : '';

  const bodyHtml =
    `<p style="margin:0 0 14px;line-height:1.55;color:#374151;">Hi ${escHtml(name)},</p>` +
    `<p style="margin:0 0 14px;line-height:1.55;color:#374151;">Your generator service visit on <strong>${escHtml(completedStr)}</strong> is complete. Thanks for being a Bates Electric Generator Care customer.</p>` +
    notesSection +
    nextVisitSection +
    `<p style="margin:16px 0 0;color:#374151;font-size:14px;line-height:1.55;">Questions about the work, or noticed something we missed? Give us a call at <strong>${COMPANY_PHONE}</strong>.</p>` +
    `<p style="margin:18px 0 0;color:#6B7280;font-size:14px;">— The Bates Electric team</p>`;

  const html = renderEmail({
    heading: 'Service visit complete',
    bodyHtml,
  });

  const notesText = (typeof notes === 'string' && notes.trim().length > 0)
    ? `\nNotes from the visit: ${notes.trim()}\n`
    : '';
  const nextVisitText = nextVisitDate
    ? `\nYour next ${planText}service is tentatively scheduled for ${fmtFriendlyDate(nextVisitDate)}. We'll confirm closer to the time.\n`
    : '';

  const text = `Hi ${name},\n\n` +
    `Your generator service visit on ${completedStr} is complete. Thanks for being a Bates Electric Generator Care customer.\n` +
    notesText +
    nextVisitText +
    `\nQuestions? Give us a call at ${COMPANY_PHONE}.\n\n— Bates Electric`;

  return { subject: 'Your generator service visit is complete', html, text };
}

module.exports = {
  COMPANY_PHONE,
  SENDER_NAME,
  getFromEmail,
  escHtml,
  ctaButton,
  renderEmail,
  sendEmail,
  buildWelcomeEmail,
  buildCardFailedEmail,
  buildCardUpdateLinkEmail,
  buildVisitScheduledEmail,
  buildVisitCompletedEmail,
};
