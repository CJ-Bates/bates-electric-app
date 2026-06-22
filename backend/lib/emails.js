// backend/lib/emails.js
// Shared email scaffolding for the Generator Care program.
// All customer-facing transactional emails (welcome, card-failed, portal link,
// visit-scheduled, visit-complete, renewal-upcoming, resend-welcome, admin
// test-sends) go through this module so the brand header/logo/footer, phone
// number, sender identity, and SendGrid config live in ONE place.
//
// When you want to change the phone number, brand color, logo URL, or any
// other surface detail: edit the BRAND object below. Don't hunt through
// template files.

const sgMail = require('@sendgrid/mail');
const { isFlorida, companyName } = require('./branding');

// ============================================================================
// Brand constants -- single source of truth for everything visible
// ============================================================================
const BRAND = {
  name: 'Bates Electric',
  tagline: 'Generator Care',
  phone: '(636) 464-3939',
  email: 'generators@bates-electric.com',   // monitored role mailbox (contact, not sender)
  logoUrl: 'https://app.bates-electric.com/logo-icon-192.png',
  navy: '#1F3A5F',          // primary brand color (header, CTA, headings)
  accent: '#5B95C9',        // links, secondary accents (rarely used)
  bgPage: '#F4F6F9',        // soft gray page background behind the card
  bgCard: '#FFFFFF',        // card body
  bgFooter: '#F9FAFB',      // slightly different gray for footer band
  textBody: '#374151',      // main paragraph text
  textMuted: '#6B7280',     // sign-off, fine print
  textFine: '#9CA3AF',      // bottom-of-footer fine print
  borderLight: '#E5E7EB',   // hairline separator between body + footer
  eyebrow: '#DFE6F0',       // pale blue eyebrow text on navy header
  fromEmail: 'no-reply@bates-electric.com',
  fromName: 'Bates Electric Generator Care',
  // Florida DBA logo (the "S.E. Bates Electric" wordmark). Set via env once the
  // asset is deployed to the static host, e.g.
  //   GENERATOR_SE_LOGO_URL=https://app.bates-electric.com/se-bates-electric-logo.png
  // When unset, Florida emails gracefully fall back to the text name only —
  // never a broken image. Per the settlement (§2b) the S.E. logo is used as
  // provided (scaled proportionally, never recolored/cropped/de-emphasized).
  seLogoUrl: process.env.GENERATOR_SE_LOGO_URL || null,
};

// Resolve the per-customer brand from an install-address state. Florida =>
// "S.E. Bates Electric" + its logo (if configured); everywhere else the default.
function brandFor(state) {
  const fl = isFlorida(state);
  return {
    fl,
    company: companyName(state),
    // Non-FL: the square brand icon. FL: the S.E. wordmark if configured, else
    // null (header renders the text name only — no broken image).
    logoUrl: fl ? (BRAND.seLogoUrl || null) : BRAND.logoUrl,
    logoIsWordmark: fl && !!BRAND.seLogoUrl,
  };
}

// Legacy exports -- kept for any callers that still reach in for these directly.
const COMPANY_PHONE = BRAND.phone;
const SENDER_NAME = BRAND.fromName;

function getFromEmail() {
  return process.env.GENERATOR_DIGEST_FROM || BRAND.fromEmail;
}

// Font stack used in every email; defined once so the brand stays consistent.
const FONT_STACK = `system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif`;

// ============================================================================
// SendGrid plumbing
// ============================================================================
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

// Sends an email via SendGrid. Returns { sent: boolean, reason?: string }.
// Never throws -- webhook callers must not surface failures as 500s
// (Stripe would retry on 500).
async function sendEmail({ to, subject, html, text, logTag, companyState }) {
  const tag = logTag || '[email]';
  if (!ensureSendGridKey()) {
    console.log(`${tag} SENDGRID_API_KEY not set, skipping`);
    return { sent: false, reason: 'SENDGRID_API_KEY not set' };
  }
  if (!to || (Array.isArray(to) && to.length === 0)) {
    console.log(`${tag} no recipient, skipping`);
    return { sent: false, reason: 'no recipient' };
  }
  // The "From" display name is also a displayed company name, so it follows the
  // Florida DBA rule. Domain is unchanged. When companyState isn't supplied (e.g.
  // internal AR mail), the default Bates Electric sender name is used.
  const fromName = (companyState != null) ? (companyName(companyState) + ' Generator Care') : BRAND.fromName;
  try {
    const response = await sgMail.send({
      to,
      from: { email: getFromEmail(), name: fromName },
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

// ============================================================================
// Utility helpers
// ============================================================================
function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function fmtFriendlyDate(s) {
  if (!s) return '';
  const d = new Date(s + 'T12:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

function fmtMoney(cents) {
  return '$' + ((cents || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ============================================================================
// Rendering primitives -- branded shell + CTA button
// ============================================================================

// Renders the navy CTA pill button using the "bulletproof email button"
// pattern: a VML <v:roundrect> rendered only by Outlook desktop (which
// ignores CSS border-radius on <a>), and a standard inline-block <a> for
// every other client. End result: a true pill in every major email client
// including Outlook 2007-2019.
//
// VML width is fixed (260px) since Outlook can't auto-size a <v:roundrect>
// around its text. Fits "Manage my account" with comfortable margins;
// re-tune if a future button label needs more.
function ctaButton(text, url) {
  if (!text || !url) return '';
  const safeText = escHtml(text);
  const vmlWidth = 260;
  const vmlHeight = 48;
  return (
    `<div style="text-align:center;margin:32px 0 12px;">` +
      // ----- Outlook desktop only: VML pill -----
      `<!--[if mso]>` +
      `<v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" ` +
        `href="${url}" ` +
        `style="height:${vmlHeight}px;v-text-anchor:middle;width:${vmlWidth}px;" ` +
        `arcsize="50%" stroke="f" fillcolor="${BRAND.navy}">` +
        `<w:anchorlock/>` +
        `<center style="color:#FFFFFF;font-family:Arial,sans-serif;font-size:15px;font-weight:bold;">${safeText}</center>` +
      `</v:roundrect>` +
      `<![endif]-->` +
      // ----- All other clients: standard inline-block pill -----
      `<!--[if !mso]><!-- -->` +
      `<a href="${url}" ` +
        `style="background-color:${BRAND.navy};color:#FFFFFF;text-decoration:none;` +
        `padding:14px 32px;border-radius:999px;font-weight:600;font-size:15px;` +
        `font-family:${FONT_STACK};letter-spacing:0.2px;display:inline-block;` +
        `mso-padding-alt:0;line-height:1.2;">` +
        `${safeText}` +
      `</a>` +
      `<!--<![endif]-->` +
    `</div>`
  );
}

// Default sign-off appears at the bottom of the body (above the footer band).
// Callers can pass their own `signoff` HTML to override (e.g. to add a
// contextual reminder paragraph above the tagline). `company` is state-aware.
function defaultSignoff(company) {
  return (
    `<p style="margin:28px 0 0;color:${BRAND.textMuted};font-size:14px;line-height:1.6;">` +
      `&mdash; The ${escHtml(company || BRAND.name)} team` +
    `</p>`
  );
}
const DEFAULT_SIGNOFF = defaultSignoff(BRAND.name);

// Build the navy header band (logo + company name + "GENERATOR CARE" eyebrow).
// `brand` is a brandFor() result; defaults to the standard Bates Electric brand.
function renderHeader(brand) {
  const b = brand || { company: BRAND.name, logoUrl: BRAND.logoUrl, logoIsWordmark: false };
  const company = b.company || BRAND.name;
  // Wordmark (FL S.E. logo) is shown as-provided: scaled proportionally, never
  // forced square. The square brand icon keeps its 56x56. If there's no logo URL
  // (FL with the asset not yet configured), show the text name only.
  const logoImg = b.logoUrl
    ? (b.logoIsWordmark
        ? `<img src="${b.logoUrl}" alt="${escHtml(company)}" width="240" ` +
            `style="display:block;margin:0 auto 12px;max-width:240px;width:240px;height:auto;border:0;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic;">`
        : `<img src="${b.logoUrl}" alt="${escHtml(company)}" width="56" height="56" ` +
            `style="display:block;margin:0 auto 12px;border:0;outline:none;text-decoration:none;-ms-interpolation-mode:bicubic;">`)
    : '';
  return (
    `<tr><td align="center" style="background:${BRAND.navy};padding:30px 28px 24px;">` +
      logoImg +
      `<div style="color:#FFFFFF;font-family:${FONT_STACK};font-size:20px;font-weight:700;letter-spacing:0.4px;line-height:1.2;">${escHtml(company)}</div>` +
      `<div style="color:${BRAND.eyebrow};font-family:${FONT_STACK};font-size:11px;letter-spacing:2px;text-transform:uppercase;font-weight:600;margin-top:6px;">${escHtml(BRAND.tagline)}</div>` +
    `</td></tr>`
  );
}

// Footer band: company name + phone, restrained. Contact details never change.
function renderFooter(brand) {
  const company = (brand && brand.company) || BRAND.name;
  return (
    `<tr><td align="center" style="background:${BRAND.bgFooter};padding:22px 28px;border-top:1px solid ${BRAND.borderLight};">` +
      `<div style="font-family:${FONT_STACK};font-size:13px;color:${BRAND.textBody};font-weight:600;">${escHtml(company)}, Inc.</div>` +
      `<div style="font-family:${FONT_STACK};font-size:12px;color:${BRAND.textMuted};margin-top:4px;">Questions? Call <a href="tel:${BRAND.phone.replace(/[^0-9+]/g, '')}" style="color:${BRAND.textMuted};text-decoration:none;">${escHtml(BRAND.phone)}</a> or email <a href="mailto:${BRAND.email}" style="color:${BRAND.textMuted};text-decoration:none;">${escHtml(BRAND.email)}</a></div>` +
    `</td></tr>`
  );
}

// Wraps a body in the branded shell.
//   heading  -- bold h1 at top of body (REQUIRED)
//   intro    -- optional opener paragraph (e.g. "Hi Jane,")
//   body     -- main HTML body (REQUIRED, inserted verbatim)
//   ctaText  -- optional button label
//   ctaUrl   -- optional button URL
//   signoff  -- optional HTML below the body (defaults to "-- The Bates Electric team")
//
// All caller-provided strings inserted as HTML -- caller must escape any
// user-supplied values (use escHtml).
function renderBrandedEmail({ heading, intro, body, ctaText, ctaUrl, signoff, companyState }) {
  const brand = brandFor(companyState);
  const introHtml = intro
    ? `<p style="margin:0 0 14px;font-family:${FONT_STACK};line-height:1.6;color:${BRAND.textBody};font-size:15px;">${intro}</p>`
    : '';
  const bodyHtml = body || '';
  const ctaHtml = ctaButton(ctaText, ctaUrl);
  const signoffHtml = (signoff != null) ? signoff : defaultSignoff(brand.company);

  return (
    `<!DOCTYPE html>` +
    `<html lang="en"><head>` +
    `<meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="x-apple-disable-message-reformatting">` +
    `<title>${escHtml(brand.company)} &mdash; ${escHtml(BRAND.tagline)}</title>` +
    `</head>` +
    `<body style="margin:0;padding:0;background:${BRAND.bgPage};font-family:${FONT_STACK};color:${BRAND.navy};-webkit-font-smoothing:antialiased;">` +

    // Outer page padding
    `<table cellpadding="0" cellspacing="0" border="0" width="100%" role="presentation" style="background:${BRAND.bgPage};">` +
    `<tr><td align="center" style="padding:24px 12px;">` +

    // Card
    `<table cellpadding="0" cellspacing="0" border="0" width="600" role="presentation" style="max-width:600px;width:100%;background:${BRAND.bgCard};border-radius:12px;overflow:hidden;box-shadow:0 1px 3px rgba(15,31,61,0.08);">` +

    renderHeader(brand) +

    // Body cell
    `<tr><td style="padding:36px 32px 28px;font-family:${FONT_STACK};">` +
      `<h1 style="margin:0 0 18px;font-family:${FONT_STACK};font-size:22px;color:${BRAND.navy};font-weight:700;line-height:1.3;">${heading}</h1>` +
      introHtml +
      bodyHtml +
      ctaHtml +
      signoffHtml +
    `</td></tr>` +

    renderFooter(brand) +

    `</table>` +
    `</td></tr></table>` +

    `</body></html>`
  );
}

// Alias for back-compat -- earlier code called this renderEmail with a slightly
// different signature. New callers should use renderBrandedEmail directly.
function renderEmail({ heading, bodyHtml, ctaText, ctaUrl }) {
  return renderBrandedEmail({ heading, body: bodyHtml, ctaText, ctaUrl });
}

// ============================================================================
// Template builders (pure functions)
// Each returns { subject, html, text } from primitive inputs so the templates
// can be rendered by webhook handlers, the resend-welcome endpoint, and the
// admin test-send endpoint without duplication.
// ============================================================================

// Common body-paragraph style used inside template bodies.
const P = `margin:0 0 14px;font-family:${FONT_STACK};line-height:1.6;color:${BRAND.textBody};font-size:15px;`;
const P_LAST = `margin:0;font-family:${FONT_STACK};line-height:1.6;color:${BRAND.textBody};font-size:15px;`;
const H3 = `margin:28px 0 10px;font-family:${FONT_STACK};font-size:12px;color:${BRAND.textMuted};text-transform:uppercase;letter-spacing:0.1em;font-weight:600;`;
const TABLE_LABEL = `padding:8px 0;color:${BRAND.textMuted};font-size:14px;vertical-align:top;`;
const TABLE_VALUE = `padding:8px 0;font-weight:600;color:${BRAND.textBody};font-size:14px;`;

// --- 1. Welcome -------------------------------------------------------------

function buildWelcomeEmail({ customer, meta, planLabel, nextVisitDate, annualPriceCents, fleetMonitoring, paidAmountCents, paidDate, companyState }) {
  const safeMeta = meta || {};
  const state = (companyState != null) ? companyState : safeMeta.install_state;
  const company = companyName(state);
  // Payment-confirmation line: our own proof of payment, since Stripe's customer
  // invoice/receipt email is turned off (Jonas is the invoice system of record).
  // paidAmountCents is the ACTUAL first charge (passed by the caller from the
  // real Stripe invoice — reflects any promo discount), not a hardcoded price.
  const showPaid = (typeof paidAmountCents === 'number');
  const paidDateStr = paidDate ? fmtFriendlyDate(paidDate) : '';
  const genClass = safeMeta.gen_class === 'air_cooled'
    ? 'Air cooled'
    : (safeMeta.gen_class && safeMeta.gen_class.startsWith('liquid') ? 'Liquid cooled' : '');
  const genLine = [genClass, safeMeta.gen_type, safeMeta.gen_model, safeMeta.gen_serial && ('s/n ' + safeMeta.gen_serial)]
    .filter(Boolean).join(' • ');
  const addr = [safeMeta.install_address, safeMeta.install_city, safeMeta.install_state, safeMeta.install_zip]
    .filter(Boolean).join(', ');
  const name = (customer && customer.name) || 'there';

  const body =
    `<p style="${P}">Thanks for signing up for ${escHtml(company)}&rsquo;s Generator Care program. We&rsquo;ve got everything we need on our end and your subscription is active.</p>` +

    `<h3 style="${H3}">What happens next</h3>` +
    `<ol style="margin:0;padding-left:20px;color:${BRAND.textBody};font-family:${FONT_STACK};font-size:15px;line-height:1.7;">` +
      `<li>One of our team will reach out within the next few business days to schedule your first maintenance visit.</li>` +
      `<li>Our technicians will perform a full inspection and any included services per your plan.</li>` +
      `<li>From there, we&rsquo;ll auto-schedule your recurring visits based on your plan.</li>` +
    `</ol>` +

    `<h3 style="${H3}">Your plan</h3>` +
    `<table cellpadding="0" cellspacing="0" border="0" width="100%" role="presentation" style="width:100%;border-collapse:collapse;">` +
      `<tr><td style="${TABLE_LABEL};width:40%;">Plan</td><td style="${TABLE_VALUE}">${escHtml(planLabel)}</td></tr>` +
      (genLine ? `<tr><td style="${TABLE_LABEL}">Generator</td><td style="${TABLE_VALUE}">${escHtml(genLine)}</td></tr>` : '') +
      (addr ? `<tr><td style="${TABLE_LABEL}">Service address</td><td style="${TABLE_VALUE}">${escHtml(addr)}</td></tr>` : '') +
      (nextVisitDate ? `<tr><td style="${TABLE_LABEL}">First visit</td><td style="${TABLE_VALUE}">${escHtml(fmtFriendlyDate(nextVisitDate))}<br><span style="color:${BRAND.textMuted};font-weight:400;font-size:13px;">We&rsquo;ll confirm the exact time when we call.</span></td></tr>` : '') +
      `<tr><td style="${TABLE_LABEL}">Annual billing</td><td style="${TABLE_VALUE}">${escHtml(fmtMoney(annualPriceCents))}/year</td></tr>` +
      (fleetMonitoring ? `<tr><td style="${TABLE_LABEL}">Add-on</td><td style="${TABLE_VALUE}">Fleet Monitoring (Mobile Link)</td></tr>` : '') +
    `</table>` +

    (showPaid ? `<p style="${P}margin-top:18px;"><strong style="color:${BRAND.navy};">Payment received:</strong> ${fmtMoney(paidAmountCents)}${paidDateStr ? ' on ' + escHtml(paidDateStr) : ''}. This is your confirmation of payment &mdash; your formal invoice comes separately from our office.</p>` : '') +

    `<p style="${P}margin-top:28px;">Have questions, need to reschedule, or want to update your card? Give us a call at <strong>${BRAND.phone}</strong> or email us.</p>`;

  const html = renderBrandedEmail({
    heading: `Welcome aboard, ${escHtml(name)}!`,
    body,
    companyState: state,
  });

  const text =
    `Welcome to ${company} Generator Care, ${name}!\n\n` +
    `Thanks for signing up. Your subscription is active and we've got everything we need on our end.\n\n` +
    `WHAT HAPPENS NEXT\n` +
    `  1. We'll reach out within the next few business days to schedule your first visit.\n` +
    `  2. Our technicians will perform a full inspection and any included services per your plan.\n` +
    `  3. From there, we'll auto-schedule your recurring visits.\n\n` +
    `YOUR PLAN\n` +
    `  Plan: ${planLabel}\n` +
    (genLine ? `  Generator: ${genLine}\n` : '') +
    (addr ? `  Service address: ${addr}\n` : '') +
    (nextVisitDate ? `  First visit: ${fmtFriendlyDate(nextVisitDate)} (we will confirm time)\n` : '') +
    `  Annual billing: ${fmtMoney(annualPriceCents)}/year\n` +
    (fleetMonitoring ? `  Add-on: Fleet Monitoring (Mobile Link)\n` : '') +
    (showPaid ? `\nPayment received: ${fmtMoney(paidAmountCents)}${paidDateStr ? ' on ' + paidDateStr : ''}. This is your confirmation of payment -- your formal invoice comes separately from our office.\n` : '') +
    `\nQuestions? Call us at ${BRAND.phone} or email ${BRAND.email}.\n\n` +
    `-- ${company}`;

  return { subject: `Welcome to ${company} Generator Care!`, html, text };
}

// --- 2. Failed charge -------------------------------------------------------

function buildCardFailedEmail({ customer, amountCents, description, portalUrl, companyState }) {
  const amountLine = amountCents ? ' of ' + fmtMoney(amountCents) : '';
  const descLine = description ? ' for ' + description : '';
  const name = (customer && customer.name) || 'there';
  const company = companyName(companyState != null ? companyState : (customer && customer.install_state));

  const body =
    `<p style="${P}">We tried to charge your card on file${escHtml(amountLine)}${escHtml(descLine)} and it didn&rsquo;t go through. Usually it&rsquo;s something simple &mdash; an expired card, a daily limit, or the bank flagging the charge.</p>` +
    `<p style="${P}">Update your card on file with one click. The link is good for a few days:</p>`;

  const signoff =
    `<p style="${P}margin-top:24px;">If you&rsquo;d rather handle it over the phone, give us a call at <strong>${BRAND.phone}</strong>.</p>` +
    DEFAULT_SIGNOFF;

  const html = renderBrandedEmail({
    heading: `Quick favor &mdash; your card didn&rsquo;t go through`,
    intro: `Hi ${escHtml(name)},`,
    body,
    ctaText: 'Update your card',
    ctaUrl: portalUrl,
    signoff,
    companyState: companyState != null ? companyState : (customer && customer.install_state),
  });

  const text =
    `Hi ${name},\n\n` +
    `We tried to charge your card on file${amountLine}${descLine} and it didn't go through. ` +
    `Usually it's something simple -- expired card, daily limit, or the bank flagging the charge.\n\n` +
    `Update your card here:\n${portalUrl}\n\n` +
    `If you'd rather handle it over the phone, give us a call at ${BRAND.phone}.\n\n` +
    `-- ${company}`;

  return { subject: 'Your card on file needs an update', html, text };
}

// --- 3. Card update link (Amy-triggered "Send Card-Update Link") ------------

function buildCardUpdateLinkEmail({ name, portalUrl, companyState }) {
  const safeName = name || 'there';
  const company = companyName(companyState);

  const body =
    `<p style="${P}">Here is a secure link to your generator care account. You can use it to update your card on file, view your invoice history, or change your contact info &mdash; all in one place.</p>`;

  const signoff =
    `<p style="${P}margin-top:24px;">The link is good for about an hour. If it expires before you click it, give us a call at <strong>${BRAND.phone}</strong> and we&rsquo;ll get you a fresh one.</p>` +
    DEFAULT_SIGNOFF;

  const html = renderBrandedEmail({
    heading: 'Manage your generator care account',
    intro: `Hi ${escHtml(safeName)},`,
    body,
    ctaText: 'Manage my account',
    ctaUrl: portalUrl,
    signoff,
    companyState,
  });

  const text =
    `Hi ${safeName},\n\n` +
    `Here is a secure link to your ${company} generator care account. ` +
    `You can use it to update your card on file, view your invoice history, or change your contact info.\n\n` +
    `${portalUrl}\n\n` +
    `The link is good for about an hour. If it expires, give us a call at ${BRAND.phone} and we'll get you a fresh one.\n\n` +
    `-- ${company}`;

  return { subject: `Manage your ${company} generator care account`, html, text };
}

// --- 4. Visit scheduled -----------------------------------------------------

function buildVisitScheduledEmail({ customer, scheduledDate, planLabel, companyState }) {
  const name = (customer && customer.name) || 'there';
  const dateStr = fmtFriendlyDate(scheduledDate);
  const planText = planLabel ? `${planLabel} ` : '';
  const company = companyName(companyState != null ? companyState : (customer && customer.install_state));

  const body =
    `<p style="${P}">Your ${escHtml(planText)}generator service visit is confirmed for <strong>${escHtml(dateStr)}</strong>.</p>` +
    `<p style="${P}">Our technician will be on-site to perform a full inspection and any services included in your plan. You don&rsquo;t need to be there as long as the generator is accessible &mdash; though we&rsquo;re happy to walk you through what we did if you are.</p>` +
    `<p style="${P_LAST}">Need to reschedule or have a question? Give us a call at <strong>${BRAND.phone}</strong> or email us.</p>`;

  const html = renderBrandedEmail({
    heading: 'Your service visit is confirmed',
    intro: `Hi ${escHtml(name)},`,
    body,
    companyState: companyState != null ? companyState : (customer && customer.install_state),
  });

  const text =
    `Hi ${name},\n\n` +
    `Your ${planText}generator service visit is confirmed for ${dateStr}.\n\n` +
    `Our technician will perform a full inspection and any included services. ` +
    `You don't need to be there as long as the generator is accessible.\n\n` +
    `Need to reschedule? Give us a call at ${BRAND.phone} or email ${BRAND.email}.\n\n` +
    `-- ${company}`;

  return { subject: 'Your generator service visit is confirmed', html, text };
}

// --- 5. Visit complete ------------------------------------------------------

function buildVisitCompletedEmail({ customer, completedDate, nextVisitDate, planLabel, notes, companyState }) {
  const name = (customer && customer.name) || 'there';
  const completedStr = fmtFriendlyDate(completedDate);
  const planText = planLabel ? `${planLabel} ` : '';
  const company = companyName(companyState != null ? companyState : (customer && customer.install_state));

  const notesSection = (typeof notes === 'string' && notes.trim().length > 0)
    ? (
        `<div style="margin:20px 0 0;padding:16px 18px;background:${BRAND.bgPage};border-left:3px solid ${BRAND.navy};border-radius:4px;">` +
          `<div style="${H3}margin:0 0 8px;">Notes from the visit</div>` +
          `<div style="font-family:${FONT_STACK};color:${BRAND.textBody};font-size:14px;line-height:1.6;white-space:pre-wrap;">${escHtml(notes.trim())}</div>` +
        `</div>`
      )
    : '';

  const nextVisitSection = nextVisitDate
    ? `<p style="${P}margin-top:20px;">Your next ${escHtml(planText)}service is tentatively scheduled for <strong>${escHtml(fmtFriendlyDate(nextVisitDate))}</strong>. We&rsquo;ll confirm the exact date with you closer to the time.</p>`
    : '';

  const body =
    `<p style="${P}">Your generator service visit on <strong>${escHtml(completedStr)}</strong> is complete. Thanks for being a ${escHtml(company)} Generator Care customer.</p>` +
    notesSection +
    nextVisitSection +
    `<p style="${P_LAST}margin-top:20px;">Questions about the work, or noticed something we missed? Give us a call at <strong>${BRAND.phone}</strong> or email us.</p>`;

  const html = renderBrandedEmail({
    heading: 'Service visit complete',
    intro: `Hi ${escHtml(name)},`,
    body,
    companyState: companyState != null ? companyState : (customer && customer.install_state),
  });

  const notesText = (typeof notes === 'string' && notes.trim().length > 0)
    ? `\nNOTES FROM THE VISIT\n  ${notes.trim().replace(/\n/g, '\n  ')}\n`
    : '';
  const nextVisitText = nextVisitDate
    ? `\nYour next ${planText}service is tentatively scheduled for ${fmtFriendlyDate(nextVisitDate)}. We'll confirm closer to the time.\n`
    : '';

  const text =
    `Hi ${name},\n\n` +
    `Your generator service visit on ${completedStr} is complete. Thanks for being a ${company} Generator Care customer.\n` +
    notesText +
    nextVisitText +
    `\nQuestions? Call us at ${BRAND.phone} or email ${BRAND.email}.\n\n` +
    `-- ${company}`;

  return { subject: 'Your generator service visit is complete', html, text };
}

// --- 6. Renewal upcoming ----------------------------------------------------

function buildRenewalUpcomingEmail({ customer, renewalDate, amountCents, planLabel, lineItems, companyState }) {
  const name = (customer && customer.name) || 'there';
  const dateStr = fmtFriendlyDate(renewalDate);
  const amountStr = fmtMoney(amountCents);
  const planText = planLabel ? `${planLabel} ` : '';
  const company = companyName(companyState != null ? companyState : (customer && customer.install_state));

  // Render a line-item breakdown only if there's more than one item (e.g.
  // base sub plus a performed addon being billed at renewal).
  const items = Array.isArray(lineItems) ? lineItems.filter(x => x && x.amount_cents) : [];
  let lineItemSection = '';
  let lineItemTextSection = '';
  if (items.length > 1) {
    lineItemSection =
      `<h3 style="${H3}">This includes</h3>` +
      `<table cellpadding="0" cellspacing="0" border="0" width="100%" role="presentation" style="width:100%;border-collapse:collapse;">` +
      items.map(it =>
        `<tr>` +
          `<td style="${TABLE_LABEL}color:${BRAND.textBody};">${escHtml(it.description || 'Service')}</td>` +
          `<td style="${TABLE_VALUE}text-align:right;">${escHtml(fmtMoney(it.amount_cents))}</td>` +
        `</tr>`
      ).join('') +
      `</table>`;
    lineItemTextSection =
      `\nTHIS INCLUDES\n` +
      items.map(it => `  ${it.description || 'Service'}: ${fmtMoney(it.amount_cents)}`).join('\n') + '\n';
  }

  const body =
    `<p style="${P}">Just a heads up &mdash; your ${escHtml(planText)}generator care subscription renews on <strong>${escHtml(dateStr)}</strong>. We&rsquo;ll charge <strong>${escHtml(amountStr)}</strong> to your card on file.</p>` +
    lineItemSection +
    `<p style="${P_LAST}margin-top:24px;">No action needed if everything looks right. If you need to update your card or have any questions, give us a call at <strong>${BRAND.phone}</strong> or email us.</p>`;

  const html = renderBrandedEmail({
    heading: 'Your subscription renews soon',
    intro: `Hi ${escHtml(name)},`,
    body,
    companyState: companyState != null ? companyState : (customer && customer.install_state),
  });

  const text =
    `Hi ${name},\n\n` +
    `Just a heads up -- your ${planText}generator care subscription renews on ${dateStr}. ` +
    `We'll charge ${amountStr} to your card on file.\n` +
    lineItemTextSection +
    `\nNo action needed if everything looks right. If you need to update your card or have any questions, give us a call at ${BRAND.phone} or email us at ${BRAND.email}.\n\n` +
    `-- ${company}`;

  return { subject: `Your ${company} subscription renews soon`, html, text };
}

// --- 7. Cancellation confirmation -------------------------------------------

// periodEndDate (optional, 'YYYY-MM-DD'): when the cancel takes effect at the end
// of the current billing period, the email says coverage stays active through that
// date. When omitted (e.g. an outright cancel that's already terminal), it uses the
// plain "has been cancelled" wording.
function buildCancellationEmail({ customer, periodEndDate, companyState }) {
  const name = (customer && customer.name) || 'there';
  const throughStr = periodEndDate ? fmtFriendlyDate(periodEndDate) : null;
  const company = companyName(companyState != null ? companyState : (customer && customer.install_state));

  const heading = throughStr
    ? 'Your Generator Care plan is scheduled to cancel'
    : 'Your Generator Care plan has been cancelled';
  const subject = throughStr
    ? 'Your Generator Care plan is scheduled to cancel'
    : 'Your Generator Care plan has been cancelled';

  const firstParaHtml = throughStr
    ? `<p style="${P}">This confirms that your ${escHtml(company)} Generator Care plan is set to cancel. <strong>Your plan stays active through ${escHtml(throughStr)}</strong> &mdash; you keep your remaining coverage until then, and <strong>you won&rsquo;t be charged again</strong> (no renewal at the end of the period).</p>`
    : `<p style="${P}">This confirms that your ${escHtml(company)} Generator Care plan has been cancelled. <strong>You won&rsquo;t be charged again</strong> &mdash; no future renewals or recurring charges will be made to your card on file.</p>`;

  const body =
    firstParaHtml +
    `<p style="${P}">Per our <a href="https://generator.bates-electric.com/terms.html" style="color:${BRAND.navy};">Terms of Service</a> (Section 5), any pre-paid maintenance visits that haven&rsquo;t been performed yet are not refunded. If you have a visit already scheduled, we&rsquo;ll be in touch to wrap it up.</p>` +
    `<p style="${P_LAST}margin-top:24px;">Changed your mind, or cancelled by mistake? We&rsquo;d love to have you back &mdash; just give us a call at <strong>${BRAND.phone}</strong> and we&rsquo;ll get you set back up.</p>`;

  const html = renderBrandedEmail({
    heading,
    intro: `Hi ${escHtml(name)},`,
    body,
    companyState: companyState != null ? companyState : (customer && customer.install_state),
  });

  const firstParaText = throughStr
    ? `This confirms that your ${company} Generator Care plan is set to cancel. Your plan stays active through ${throughStr} -- you keep your remaining coverage until then, and you won't be charged again (no renewal at the end of the period).`
    : `This confirms that your ${company} Generator Care plan has been cancelled. You won't be charged again -- no future renewals or recurring charges will be made to your card on file.`;

  const text =
    `Hi ${name},\n\n` +
    firstParaText + `\n\n` +
    `Per our Terms of Service (Section 5, https://generator.bates-electric.com/terms.html), any pre-paid ` +
    `maintenance visits that haven't been performed yet are not refunded. If you have a visit already ` +
    `scheduled, we'll be in touch to wrap it up.\n\n` +
    `Changed your mind, or cancelled by mistake? We'd love to have you back -- just give us a call at ` +
    `${BRAND.phone} and we'll get you set back up.\n\n` +
    `-- ${company}`;

  return { subject, html, text };
}

// --- 8. AR "ready to invoice" hand-off (internal) ---------------------------

// Internal notification to Accounts Receivable when the office marks a Jonas
// work order created. Body is the full work-order packet so AR can generate the
// paid invoice without digging. `addons` is the generator_pending_addons rows
// (optional). `markedBy` is the office user who marked it.
function buildArReadyToInvoiceEmail({ subscription, customer, addons, markedBy, chargedAtSignupCents, companyState }) {
  const sub = subscription || {};
  const c = customer || {};
  // Operating name for THIS customer (Florida => S.E. Bates Electric) so AR keys
  // the Jonas work order + invoice under the legally-correct name.
  const company = companyName(companyState != null ? companyState : c.install_state);
  const PLAN = { semi_annual: 'Semi-Annual', annual: 'Annual' };
  const GENC = { air_cooled: 'Air-cooled', liquid_22_38: 'Liquid-cooled (22–45 kW)', liquid_48_150: 'Liquid-cooled (48–150 kW)' };
  const ADDON = {
    fleet_monitoring: 'Fleet Monitoring', battery_replacement: 'Battery Replacement',
    battery_diagnostics: 'Battery Diagnostics', exterior_wash: 'Exterior Wash',
    coolant_flush: 'Coolant Flush', coolant_topoff: 'Coolant Top-Off',
    ats_inspection: 'ATS Inspection', ats_outage_combined: 'ATS + Outage Test',
    outage_test: 'Outage Test',
  };

  const name = c.name || 'Customer';
  const addr = [c.install_address, c.install_city, c.install_state, c.install_zip].filter(Boolean).join(', ');
  const planLabel = PLAN[sub.plan] || sub.plan || '';
  const cadence = sub.plan === 'semi_annual' ? 'every 6 months' : (sub.plan === 'annual' ? 'annually' : '');
  // Renewal price = the standard per-period charge. annual_price_cents is the
  // annualized total (semi-annual is billed at half that, twice a year).
  const annual = sub.annual_price_cents || 0;
  const renewalCents = sub.plan === 'semi_annual' ? Math.round(annual / 2) : annual;
  // What the customer was ACTUALLY charged at signup (reflects any promo
  // discount). Falls back to the plan price if the real charge wasn't passed.
  const signupCents = (typeof chargedAtSignupCents === 'number') ? chargedAtSignupCents : renewalCents;
  const addonList = []
    .concat(sub.fleet_monitoring ? ['Fleet Monitoring'] : [])
    .concat((addons || []).filter(a => a && a.status !== 'canceled').map(a => ADDON[a.addon_type] || a.addon_type));
  const generator = [GENC[sub.gen_class] || sub.gen_class, sub.gen_model, sub.gen_serial && ('s/n ' + sub.gen_serial)].filter(Boolean).join(' • ');

  const woNum = (sub.work_order_number || '').trim();
  const fields = [
    ['Work order #', woNum || '—'],
    ['Bill under', company + (isFlorida(companyState != null ? companyState : c.install_state) ? ' (Florida DBA)' : '')],
    ['Customer', name],
    ['Phone', c.phone || '—'],
    ['Email', c.email || '—'],
    ['Install address', addr || '—'],
    ['Plan', planLabel + (cadence ? ` (billed ${cadence})` : '')],
    ['Generator', generator || '—'],
    ['Add-ons', addonList.length ? addonList.join(', ') : 'None'],
    ['Signed up', sub.signup_date ? fmtFriendlyDate(sub.signup_date) : '—'],
    ['Amount charged at signup', fmtMoney(signupCents)],
    ['Renews at', `${fmtMoney(renewalCents)}${cadence ? ' ' + cadence : ''}`],
  ];

  const rowsHtml = fields.map(([k, v]) =>
    `<tr><td style="${TABLE_LABEL};width:42%;">${escHtml(k)}</td><td style="${TABLE_VALUE}">${escHtml(v)}</td></tr>`
  ).join('');

  const body =
    (woNum ? `<p style="${P}font-size:18px;margin-bottom:6px;"><strong style="color:${BRAND.navy};">Work order #${escHtml(woNum)}</strong> created for <strong>${escHtml(name)}</strong> &mdash; ready to invoice.</p>` : '') +
    `<p style="${P}">${escHtml(markedBy || 'The office')} marked the Jonas work order created for <strong>${escHtml(name)}</strong>. Here&rsquo;s the work-order packet &mdash; everything needed to generate and send the paid invoice from Jonas.</p>` +
    `<table cellpadding="0" cellspacing="0" border="0" width="100%" role="presentation" style="width:100%;border-collapse:collapse;margin-top:8px;">${rowsHtml}</table>` +
    `<p style="${P_LAST}margin-top:24px;">Once the invoice is sent, the office will mark it invoiced in the dashboard to close the loop.</p>`;

  const html = renderBrandedEmail({
    heading: 'Ready to invoice',
    intro: `Generator Care &mdash; ${escHtml(name)}`,
    body,
    companyState: companyState != null ? companyState : c.install_state,
  });

  // Plain-text packet — the copy-paste-friendly version for keying into Jonas.
  const text =
    (woNum ? `WORK ORDER #${woNum} — READY TO INVOICE\n` : `READY TO INVOICE — Generator Care\n`) +
    `${markedBy || 'The office'} marked the Jonas work order created.\n\n` +
    `WORK ORDER PACKET\n` +
    fields.map(([k, v]) => `  ${k}: ${v}`).join('\n') + '\n\n' +
    `Once the invoice is sent, it will be marked invoiced in the dashboard.\n\n` +
    `-- ${company} Generator Care`;

  const subject = woNum
    ? `Work order #${woNum} — ready to invoice: ${name}`
    : `Generator Care — ready to invoice: ${name}`;
  return { subject, html, text };
}

// --- 9. Payment receipt (our own, state-branded) ----------------------------

// We send our own receipt for every successful charge (signup, renewal, add-on,
// ad-hoc) so it can be branded per customer — "Bates Electric" normally,
// "S.E. Bates Electric" for Florida — which Stripe's account-level automatic
// receipt cannot do. Mirrors what Stripe's receipt provides: company + logo,
// amount, date, card last-4, what it was for, and a receipt/confirmation number.
function buildReceiptEmail({ customer, companyState, amountCents, paidDate, cardBrand, cardLast4, description, receiptNumber }) {
  const state = (companyState != null) ? companyState : (customer && customer.install_state);
  const company = companyName(state);
  const name = (customer && customer.name) || 'there';
  const dateStr = paidDate ? fmtFriendlyDate(paidDate) : '';
  const brandName = cardBrand ? (cardBrand.charAt(0).toUpperCase() + cardBrand.slice(1)) : '';
  const cardStr = cardLast4 ? `${brandName ? brandName + ' ' : ''}&bull;&bull;&bull;&bull; ${escHtml(cardLast4)}` : '';
  const cardText = cardLast4 ? `${brandName ? brandName + ' ' : ''}**** ${cardLast4}` : '';

  const rows = [
    ['Amount paid', fmtMoney(amountCents)],
    dateStr ? ['Date', escHtml(dateStr)] : null,
    description ? ['For', escHtml(description)] : null,
    cardStr ? ['Payment method', cardStr] : null,
    receiptNumber ? ['Receipt #', escHtml(receiptNumber)] : null,
  ].filter(Boolean);
  const rowsHtml = rows.map(([k, v]) =>
    `<tr><td style="${TABLE_LABEL};width:42%;">${escHtml(k)}</td><td style="${TABLE_VALUE}">${v}</td></tr>`
  ).join('');

  const body =
    `<p style="${P}">Thanks for your payment &mdash; this is your receipt from ${escHtml(company)} for your Generator Care account.</p>` +
    `<table cellpadding="0" cellspacing="0" border="0" width="100%" role="presentation" style="width:100%;border-collapse:collapse;margin-top:8px;">${rowsHtml}</table>` +
    `<p style="${P_LAST}margin-top:24px;">Keep this for your records. Questions about a charge? Give us a call at <strong>${BRAND.phone}</strong> or email us.</p>`;

  const html = renderBrandedEmail({
    heading: 'Your payment receipt',
    intro: `Hi ${escHtml(name)},`,
    body,
    companyState: state,
  });

  const textRows = [
    ['Amount paid', fmtMoney(amountCents)],
    dateStr ? ['Date', dateStr] : null,
    description ? ['For', description] : null,
    cardText ? ['Payment method', cardText] : null,
    receiptNumber ? ['Receipt #', receiptNumber] : null,
  ].filter(Boolean);
  const text =
    `Hi ${name},\n\n` +
    `Thanks for your payment -- this is your receipt from ${company} for your Generator Care account.\n\n` +
    `RECEIPT\n` +
    textRows.map(([k, v]) => `  ${k}: ${v}`).join('\n') + '\n\n' +
    `Keep this for your records. Questions about a charge? Call ${BRAND.phone} or email ${BRAND.email}.\n\n` +
    `-- ${company}`;

  return { subject: `Your payment receipt from ${company}`, html, text };
}

// ============================================================================
// Module exports
// ============================================================================
module.exports = {
  // Brand constants (single source of truth)
  BRAND,

  // Back-compat exports (derived from BRAND)
  COMPANY_PHONE,
  SENDER_NAME,
  getFromEmail,

  // Rendering primitives
  escHtml,
  fmtFriendlyDate,
  fmtMoney,
  ctaButton,
  renderBrandedEmail,
  renderEmail,        // alias for older callers
  sendEmail,

  // Template builders
  buildWelcomeEmail,
  buildCardFailedEmail,
  buildCardUpdateLinkEmail,
  buildVisitScheduledEmail,
  buildVisitCompletedEmail,
  buildRenewalUpcomingEmail,
  buildCancellationEmail,
  buildArReadyToInvoiceEmail,
  buildReceiptEmail,

  // Florida DBA helpers (re-exported for convenience)
  isFlorida,
  companyName,
};
