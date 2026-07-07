// backend/lib/emails.js
// Shared email scaffolding for the Generator Care program.
// All customer-facing transactional emails (welcome, card-failed, portal link,
// visit-scheduled, visit-complete, renewal-upcoming, resend-welcome, admin
// test-sends) go through this module so the brand header/logo/footer, phone
// number, sender identity, and mail transport config live in ONE place.
//
// When you want to change the phone number, brand color, logo URL, or any
// other surface detail: edit the BRAND object below. Don't hunt through
// template files.

const { sendViaBrevo } = require('./mailer');
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
  // Florida DBA logo (the "S.E. Bates Electric" wordmark), served from the
  // frontend static host (Netlify) at app.bates-electric.com. Absolute URL is
  // required — emails can't use relative paths. GENERATOR_SE_LOGO_URL overrides
  // it if ever set; if the image can't load, the header still shows the text
  // name (never a broken-looking header). Per the settlement (§2b) the logo is
  // used as provided — scaled proportionally only, never recolored/cropped/
  // de-emphasized.
  seLogoUrl: process.env.GENERATOR_SE_LOGO_URL || 'https://app.bates-electric.com/se-bates-electric-logo.jpg',
};

// Customer self-serve dashboard — the canonical URL used by every customer
// touchpoint (welcome, receipt, visit-complete, shared footer). No password:
// customers sign in with their email. my.bates-electric.com fronts the same
// page as https://app.bates-electric.com/my.html — if the my. domain ever
// lapses, app URLs stay valid. (my.bates-electric.com verified resolving
// 2026-07-07.)
const DASHBOARD_URL = 'https://my.bates-electric.com';
// Bare-host display form for quiet inline mentions in body copy and the footer.
const DASHBOARD_DISPLAY = 'my.bates-electric.com';

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
// Email transport (Brevo — see lib/mailer.js)
// ============================================================================

// Sends an email via Brevo. Returns { sent: boolean, reason?: string }.
// Never throws -- webhook callers must not surface failures as 500s
// (Stripe would retry on 500).
async function sendEmail({ to, subject, html, text, logTag, companyState }) {
  const tag = logTag || '[email]';
  if (!to || (Array.isArray(to) && to.length === 0)) {
    console.log(`${tag} no recipient, skipping`);
    return { sent: false, reason: 'no recipient' };
  }
  // The "From" display name is also a displayed company name, so it follows the
  // Florida DBA rule (S.E. Bates Electric for FL). The From ADDRESS is unchanged.
  // When companyState isn't supplied, the default Bates Electric sender name is used.
  const fromName = (companyState != null) ? (companyName(companyState) + ' Generator Care') : BRAND.fromName;

  const result = await sendViaBrevo({
    to,
    senderEmail: getFromEmail(),
    senderName: fromName,
    subject,
    html,
    text,
  });
  if (result.sent) {
    const recipients = Array.isArray(to) ? to.join(', ') : to;
    console.log(`${tag} sent to ${recipients} via Brevo`);
  } else {
    console.error(`${tag} Brevo send failed:`, result.reason);
  }
  return result;
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
        // Wordmark (FL S.E. logo) is used as-provided — only scaled
        // proportionally. It ships on a white background (JPEG, no transparency),
        // so it sits on a white tile rather than as a raw rectangle on the navy
        // band. The tile is container presentation only; the logo is untouched.
        ? `<img src="${b.logoUrl}" alt="${escHtml(company)}" width="240" ` +
            `style="display:block;margin:0 auto 12px;max-width:240px;width:240px;height:auto;` +
            `background:#FFFFFF;padding:12px 16px;border-radius:8px;border:0;outline:none;` +
            `text-decoration:none;-ms-interpolation-mode:bicubic;">`
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
      `<div style="font-family:${FONT_STACK};font-size:12px;color:${BRAND.textMuted};margin-top:4px;">Manage your plan: <a href="${DASHBOARD_URL}" style="color:${BRAND.textMuted};text-decoration:underline;">${DASHBOARD_DISPLAY}</a></div>` +
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
  // Brand on the customer's CURRENT install_state (like the receipt + every other
  // email), NOT the signup-time state in raw_metadata/meta — otherwise an FL
  // customer whose state was set/edited after signup gets the wrong (non-S.E.)
  // logo and name. meta.install_state is only a last-resort fallback.
  const state = (companyState != null)
    ? companyState
    : ((customer && customer.install_state) || safeMeta.install_state);
  const company = companyName(state);
  // Payment-confirmation line: our own proof of payment. Generator Care customers
  // are not invoiced — the branded receipt we email on every charge is their record.
  // paidAmountCents is the ACTUAL first charge (passed by the caller from the
  // real Stripe invoice — reflects any promo discount), not a hardcoded price.
  const showPaid = (typeof paidAmountCents === 'number');
  const paidDateStr = paidDate ? fmtFriendlyDate(paidDate) : '';
  // Class shown ONCE: gen_type already carries the signup form's class label
  // ("Air Cooled (7 – 28 KW)"), so also rendering the name derived from
  // gen_class stated the class twice ("Air cooled • Air Cooled (7 – 28 KW) •
  // …"). The derived name is only the fallback for subs missing gen_type.
  const genClass = safeMeta.gen_class === 'air_cooled'
    ? 'Air cooled'
    : (safeMeta.gen_class && safeMeta.gen_class.startsWith('liquid') ? 'Liquid cooled' : '');
  const genLine = [safeMeta.gen_type || genClass, safeMeta.gen_model, safeMeta.gen_serial && ('s/n ' + safeMeta.gen_serial)]
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

    (showPaid ? `<p style="${P}margin-top:18px;"><strong style="color:${BRAND.navy};">Payment received:</strong> ${fmtMoney(paidAmountCents)}${paidDateStr ? ' on ' + escHtml(paidDateStr) : ''}. A receipt has been emailed to you for your records.</p>` : '') +

    `<h3 style="${H3}">Your online dashboard</h3>` +
    `<p style="${P}">See your visits, technician notes, plan, and receipts anytime &mdash; no password, just your email.</p>` +
    ctaButton('Open my dashboard', DASHBOARD_URL) +

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
    (showPaid ? `\nPayment received: ${fmtMoney(paidAmountCents)}${paidDateStr ? ' on ' + paidDateStr : ''}. A receipt has been emailed to you for your records.\n` : '') +
    `\nYOUR ONLINE DASHBOARD\n` +
    `  See your visits, technician notes, plan, and receipts anytime -- no password, just your email.\n` +
    `  ${DASHBOARD_URL}\n` +
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
    `<p style="${P}">Here is a secure link to your generator care account. You can use it to update your card on file, view your billing history, or change your contact info &mdash; all in one place.</p>`;

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
    `You can use it to update your card on file, view your billing history, or change your contact info.\n\n` +
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

  // The dashboard hook — a completed visit is the moment the dashboard has
  // something new to show (this visit's notes and photos), so the pitch +
  // button go right after the notes.
  const dashboardSection =
    `<p style="${P}margin-top:20px;">See your full visit history and photos on your online dashboard &mdash; no password, just your email.</p>` +
    ctaButton('Open my dashboard', DASHBOARD_URL);

  const body =
    `<p style="${P}">Your generator service visit on <strong>${escHtml(completedStr)}</strong> is complete. Thanks for being a ${escHtml(company)} Generator Care customer.</p>` +
    notesSection +
    dashboardSection +
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
    `\nSee your full visit history and photos: ${DASHBOARD_URL} (no password -- just your email)\n` +
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

// (Section 8 removed: the AR "ready to invoice" hand-off email. Generator Care
// customers are no longer invoiced — Brenda keys the work order into Jonas as an
// internal record, and the customer's document of record is the branded receipt.)

// --- 9. Payment receipt (our own, state-branded) ----------------------------

// We send our own receipt for every successful charge (signup, renewal, add-on,
// ad-hoc) so it can be branded per customer — "Bates Electric" normally,
// "S.E. Bates Electric" for Florida — which Stripe's account-level automatic
// receipt cannot do. Mirrors what Stripe's receipt provides: company + logo,
// amount, date, card last-4, what it was for, and a receipt/confirmation number.
function buildReceiptEmail({ customer, companyState, amountCents, paidDate, cardBrand, cardLast4, description, receiptNumber, lineItems }) {
  const state = (companyState != null) ? companyState : (customer && customer.install_state);
  const company = companyName(state);
  const name = (customer && customer.name) || 'there';
  const dateStr = paidDate ? fmtFriendlyDate(paidDate) : '';
  const brandName = cardBrand ? (cardBrand.charAt(0).toUpperCase() + cardBrand.slice(1)) : '';
  const cardStr = cardLast4 ? `${brandName ? brandName + ' ' : ''}&bull;&bull;&bull;&bull; ${escHtml(cardLast4)}` : '';
  const cardText = cardLast4 ? `${brandName ? brandName + ' ' : ''}**** ${cardLast4}` : '';

  // Itemize when the charge has 2+ line items (e.g. a combined add-on charge): list
  // each item + its amount, then the total. Single-line charges keep the "For" row.
  const items = Array.isArray(lineItems) ? lineItems.filter((li) => li && li.description) : [];
  const itemized = items.length >= 2;
  const tailRows = [
    dateStr ? ['Date', escHtml(dateStr)] : null,
    cardStr ? ['Payment method', cardStr] : null,
    receiptNumber ? ['Receipt #', escHtml(receiptNumber)] : null,
  ].filter(Boolean);
  const rows = itemized
    ? items.map((li) => [li.description, fmtMoney(li.amountCents || 0)])
        .concat([['Amount paid', fmtMoney(amountCents)]])
        .concat(tailRows)
    : [
        ['Amount paid', fmtMoney(amountCents)],
        description ? ['For', escHtml(description)] : null,
      ].filter(Boolean).concat(tailRows);
  const rowsHtml = rows.map(([k, v]) =>
    `<tr><td style="${TABLE_LABEL};width:42%;">${escHtml(k)}</td><td style="${TABLE_VALUE}">${v}</td></tr>`
  ).join('');

  const body =
    `<p style="${P}">Thanks for your payment &mdash; this is your receipt from ${escHtml(company)} for your Generator Care account.</p>` +
    `<table cellpadding="0" cellspacing="0" border="0" width="100%" role="presentation" style="width:100%;border-collapse:collapse;margin-top:8px;">${rowsHtml}</table>` +
    `<p style="${P}margin-top:24px;">Keep this for your records. Questions about a charge? Give us a call at <strong>${BRAND.phone}</strong> or email us.</p>` +
    `<p style="margin:16px 0 0;font-family:${FONT_STACK};font-size:13px;line-height:1.6;color:${BRAND.textMuted};">View your account anytime: <a href="${DASHBOARD_URL}" style="color:${BRAND.textMuted};text-decoration:underline;">${DASHBOARD_DISPLAY}</a> &mdash; no password, just your email.</p>`;

  const html = renderBrandedEmail({
    heading: 'Your payment receipt',
    intro: `Hi ${escHtml(name)},`,
    body,
    companyState: state,
  });

  const textTail = [
    dateStr ? ['Date', dateStr] : null,
    cardText ? ['Payment method', cardText] : null,
    receiptNumber ? ['Receipt #', receiptNumber] : null,
  ].filter(Boolean);
  const textRows = itemized
    ? items.map((li) => [li.description, fmtMoney(li.amountCents || 0)])
        .concat([['Amount paid', fmtMoney(amountCents)]])
        .concat(textTail)
    : [
        ['Amount paid', fmtMoney(amountCents)],
        description ? ['For', description] : null,
      ].filter(Boolean).concat(textTail);
  const text =
    `Hi ${name},\n\n` +
    `Thanks for your payment -- this is your receipt from ${company} for your Generator Care account.\n\n` +
    `RECEIPT\n` +
    textRows.map(([k, v]) => `  ${k}: ${v}`).join('\n') + '\n\n' +
    `Keep this for your records. Questions about a charge? Call ${BRAND.phone} or email ${BRAND.email}.\n\n` +
    `View your account anytime: ${DASHBOARD_URL} -- no password, just your email.\n\n` +
    `-- ${company}`;

  return { subject: `Your payment receipt from ${company}`, html, text };
}

// --- 10. Refund receipt (our own, state-branded) ----------------------------

// We send our own refund confirmation for every refund so it can be branded per
// customer — "Bates Electric" normally, "S.E. Bates Electric" for Florida —
// which Stripe's account-level automatic refund email cannot do. Mirrors the
// payment receipt: company + logo, refunded amount, refund date, card last-4,
// what was refunded, and the original charge/receipt reference if available.
// Handles partial refunds — the caller passes the ACTUAL refunded amount (not
// the full original charge) and sets isPartial so the copy reads correctly.
function buildRefundReceiptEmail({ customer, companyState, amountCents, refundDate, cardBrand, cardLast4, description, originalReceiptNumber, isPartial }) {
  const state = (companyState != null) ? companyState : (customer && customer.install_state);
  const company = companyName(state);
  const name = (customer && customer.name) || 'there';
  const dateStr = refundDate ? fmtFriendlyDate(refundDate) : '';
  const brandName = cardBrand ? (cardBrand.charAt(0).toUpperCase() + cardBrand.slice(1)) : '';
  const cardStr = cardLast4 ? `${brandName ? brandName + ' ' : ''}&bull;&bull;&bull;&bull; ${escHtml(cardLast4)}` : '';
  const cardText = cardLast4 ? `${brandName ? brandName + ' ' : ''}**** ${cardLast4}` : '';

  const rows = [
    ['Amount refunded', fmtMoney(amountCents)],
    dateStr ? ['Refund date', escHtml(dateStr)] : null,
    description ? ['For', escHtml(description)] : null,
    cardStr ? ['Refunded to', cardStr] : null,
    originalReceiptNumber ? ['Original receipt #', escHtml(originalReceiptNumber)] : null,
  ].filter(Boolean);
  const rowsHtml = rows.map(([k, v]) =>
    `<tr><td style="${TABLE_LABEL};width:42%;">${escHtml(k)}</td><td style="${TABLE_VALUE}">${v}</td></tr>`
  ).join('');

  const body =
    `<p style="${P}">We&rsquo;ve issued a${isPartial ? ' partial' : ''} refund to your ${escHtml(company)} Generator Care account. Here are the details for your records.</p>` +
    `<table cellpadding="0" cellspacing="0" border="0" width="100%" role="presentation" style="width:100%;border-collapse:collapse;margin-top:8px;">${rowsHtml}</table>` +
    `<p style="${P}margin-top:18px;">Refunds usually take 5&ndash;10 business days to appear on your statement, depending on your bank.</p>` +
    `<p style="${P_LAST}margin-top:8px;">Questions about this refund? Give us a call at <strong>${BRAND.phone}</strong> or email us.</p>`;

  const html = renderBrandedEmail({
    heading: 'Your refund confirmation',
    intro: `Hi ${escHtml(name)},`,
    body,
    companyState: state,
  });

  const textRows = [
    ['Amount refunded', fmtMoney(amountCents)],
    dateStr ? ['Refund date', dateStr] : null,
    description ? ['For', description] : null,
    cardText ? ['Refunded to', cardText] : null,
    originalReceiptNumber ? ['Original receipt #', originalReceiptNumber] : null,
  ].filter(Boolean);
  const text =
    `Hi ${name},\n\n` +
    `We've issued a${isPartial ? ' partial' : ''} refund to your ${company} Generator Care account. Here are the details for your records.\n\n` +
    `REFUND\n` +
    textRows.map(([k, v]) => `  ${k}: ${v}`).join('\n') + '\n\n' +
    `Refunds usually take 5-10 business days to appear on your statement, depending on your bank.\n\n` +
    `Questions about this refund? Call ${BRAND.phone} or email ${BRAND.email}.\n\n` +
    `-- ${company}`;

  return { subject: `Your refund from ${company}`, html, text };
}

// ============================================================================
// Module exports
// ============================================================================
module.exports = {
  // Brand constants (single source of truth)
  BRAND,
  DASHBOARD_URL,

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
  buildReceiptEmail,
  buildRefundReceiptEmail,

  // Florida DBA helpers (re-exported for convenience)
  isFlorida,
  companyName,
};
