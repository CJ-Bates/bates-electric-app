// backend/lib/sms.js
// Single SMS transport + message copy for the whole app: SimpleTexting
// (shared company account — the same account sends the service team's
// service-call reminders, so everything this module sends must stay
// self-contained: consent-gated, transactional Generator Care traffic only).
//
// Provider facts (confirmed against api-doc.simpletexting.com, 2026-07-15):
//   Send:    POST {base}/api/messages  body { contactPhone, accountPhone,
//            mode, text }, Authorization: Bearer <token>. 201 -> { id, credits }.
//   Inbound: the account's webhook POSTs JSON { type: 'INCOMING_MESSAGE' |
//            'UNSUBSCRIBE_REPORT' | ..., values: { contactPhone, accountPhone,
//            text, ... } } — handled in routes/sms-inbound.js.
//
// HARD RULES (see the Phase 1 spec):
//   - Nothing sends while SMS_ENABLED !== 'true' (kill-switch, default off).
//   - Sends go only to a phone with an opted_in && !opted_out consent row.
//   - No sends outside quiet hours (8am-9pm customer local time; every
//     customer is Central — there is no timezone column) unless the send is a
//     direct reply to a message the customer just sent us.
//   - EVERY outbound attempt is logged to generator_sms_messages, including
//     refused ones (status says why) — that's the office's visibility and the
//     SMS_ENABLED=false test surface.
//   - NEVER log or expose SIMPLETEXTING_API_TOKEN.
//
// Env (Render): SIMPLETEXTING_API_TOKEN (secret), SIMPLETEXTING_ACCOUNT_PHONE
// (the verified toll-free sender, e.g. 8339425468), SMS_ENABLED ('true' to
// arm). Missing token fails closed like lib/mailer.js: loud log, no throw.

const crypto = require('crypto');
const { supabaseAdmin } = require('./supabase');
const { isFlorida } = require('./branding');
const { arrivalWindow } = require('./generator-catalog');
const { reportError } = require('../middleware/error-reporter');

const SIMPLETEXTING_BASE = 'https://api-app2.simpletexting.com/v2';

// Approved copy uses a few non-GSM characters; the repo convention is "never
// paste literal special chars in JS" (mojibake history), so they're built here.
const MDASH = String.fromCharCode(0x2014); // em dash, in the approved copy

// ============================================================================
// Consent language — the EXACT text shown to the customer, stored verbatim on
// the consent row (the legal record). The signup checkbox in bates-generator's
// index.html MIRRORS the signup text — edit both together.
// ============================================================================
const CONSENT_TEXT = {
  signup: 'Text me appointment reminders and confirmations for my generator maintenance. ' +
    'Msg frequency varies; msg & data rates may apply. Reply STOP to cancel, HELP for help. ' +
    'Consent is not a condition of purchase. See our SMS Terms and Privacy Policy.',
  dashboard: 'Text me appointment reminders and confirmations for my generator maintenance. ' +
    'Msg frequency varies; msg & data rates may apply. Reply STOP to cancel, HELP for help. ' +
    'Consent is not a condition of purchase. See our SMS Terms and Privacy Policy.',
  office: 'Verbal consent recorded by the office: customer agreed to receive appointment ' +
    'reminder and confirmation texts for their generator maintenance. Msg frequency varies; ' +
    'msg & data rates may apply; reply STOP to cancel, HELP for help.',
};

// ============================================================================
// Phone normalization. Storage/matching format is E.164 (+1XXXXXXXXXX);
// SimpleTexting's API examples use bare 10-digit national numbers, so
// toProviderPhone strips the +1 for the wire.
// ============================================================================
function normalizePhone(raw) {
  const digits = String(raw == null ? '' : raw).replace(/\D/g, '');
  if (digits.length === 10) return '+1' + digits;
  if (digits.length === 11 && digits[0] === '1') return '+' + digits;
  return null;
}

function toProviderPhone(e164) {
  return e164.replace(/^\+1/, '');
}

// ============================================================================
// Gates
// ============================================================================
function smsEnabled() {
  return process.env.SMS_ENABLED === 'true';
}

// Quiet hours: sends allowed 8:00am-8:59pm in the customer's local time.
// Every Generator Care customer is Central (no timezone column exists;
// the whole app hardcodes America/Chicago — see fmtApptCentral etc.).
function withinQuietHours(now) {
  const hour = Number(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago', hour: 'numeric', hour12: false,
  }).format(now || new Date()));
  return hour >= 8 && hour < 21;
}

// ============================================================================
// Message copy (final wording from the approved "SMS Copy, Consent & A2P
// Pack", 2026-07-14). Strictly transactional. FL customers see "S.E. Bates"
// per the settlement branding rule, same as email.
// ============================================================================
function smsBrand(installState) {
  return (isFlorida(installState) ? 'S.E. Bates' : 'Bates') + ' Generator Care';
}

// 'YYYY-MM-DD' -> 'Tue Aug 12' (the A2P pack's sample-message date form).
// Noon-parse dodges timezone date rolls, same trick as emails.js.
function fmtSmsDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(String(dateStr).slice(0, 10) + 'T12:00:00');
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }).replace(',', '');
}

// Window code -> compact SMS form ('8-10 AM', '10 AM-12 PM') matching the
// approved sample "arriving 8-10 AM". The catalog label ('8:00-10:00 AM')
// is the long email form; SMS gets the short one. Null for unknown codes.
function smsWindowText(code) {
  const w = arrivalWindow(code);
  if (!w) return null;
  const part = (hhmm) => {
    const h = Number(hhmm.slice(0, 2));
    return { h12: ((h + 11) % 12) + 1, mer: h < 12 ? 'AM' : 'PM' };
  };
  const a = part(w.start);
  const b = part(w.end);
  return a.mer === b.mer
    ? a.h12 + '-' + b.h12 + ' ' + a.mer
    : a.h12 + ' ' + a.mer + '-' + b.h12 + ' ' + b.mer;
}

// First word of the customer's name — "Hi Sarah", never the full mailing name.
function firstName(name) {
  const first = String(name || '').trim().split(/\s+/)[0];
  return first || 'there';
}

// (1) BOOKING CONFIRMATION — sent when a visit is scheduled.
function buildBookingConfirmationSms({ name, installState, dateStr, windowCode, link }) {
  const windowText = smsWindowText(windowCode);
  const when = fmtSmsDate(dateStr) + (windowText ? ', arriving ' + windowText : '');
  return smsBrand(installState) + ': Hi ' + firstName(name) + ', your generator maintenance visit is set for ' +
    when + '. Reply Y to confirm, or tap ' + link + ' to pick a new time. Reply STOP to opt out.';
}

// (2) CONFIRMED — reply after the customer texts Y.
function buildConfirmedReplySms({ installState, dateStr, windowCode, link }) {
  const windowText = smsWindowText(windowCode);
  const when = fmtSmsDate(dateStr) + (windowText ? ', ' + windowText : '');
  return 'You\'re all set ' + MDASH + ' see you ' + when + '. Need to change it? Tap ' + link + '. ' +
    MDASH + ' ' + smsBrand(installState);
}

// (5) RESCHEDULE — reply when the inbound text isn't a Y (a reschedule intent).
function buildRescheduleReplySms({ installState, link }) {
  return 'No problem ' + MDASH + ' tap ' + link + ' to pick a new date and time and we\'ll lock it in. ' +
    MDASH + ' ' + smsBrand(installState);
}

// (3)/(4) APPOINTMENT REMINDER — the Phase 2 cron sends one 3 days out and
// one the morning of. Confirmation-aware: once the customer has replied Y
// (visit.sms_confirmed_at set) the reminder just reminds — it never re-asks
// for a Y. Legacy visits without an arrival window omit the window clause.
function buildReminderSms({ installState, dateStr, windowCode, link, confirmed, isToday }) {
  const windowText = smsWindowText(windowCode);
  const when = (isToday ? 'today' : 'on ' + fmtSmsDate(dateStr)) + (windowText ? ', ' + windowText : '');
  const lead = smsBrand(installState) + ' reminder: your generator maintenance is ' + when + '.';
  return confirmed
    ? lead + ' Need a different time? Tap ' + link + '.'
    : lead + ' Reply Y to confirm, or tap ' + link + ' to reschedule.';
}

// (6) OPT-IN CONFIRMATION — the moment a customer opts in (carrier-required
// disclosures: frequency, rates, HELP/STOP).
function buildOptInConfirmationSms({ installState }) {
  return smsBrand(installState) + ': You\'re signed up for appointment texts. Msg frequency varies. ' +
    'Msg & data rates may apply. Reply HELP for help, STOP to cancel.';
}

// (7) SCHEDULE NUDGE — Phase 3: sent around each renewal (invoice.upcoming)
// to open the cycle's scheduling. `link` is the auto-login magic link, so the
// tap lands the customer signed-in on the slot picker. Strictly transactional
// — no promotional line may ever be added here (it would reclassify the
// message as marketing under the A2P registration).
function buildScheduleNudgeSms({ installState, year, link }) {
  return smsBrand(installState) + ': it\'s time to schedule your generator maintenance' +
    (year ? ' for ' + year : '') + '. Tap to pick a date & time: ' + link + '. Reply STOP to opt out.';
}

// ============================================================================
// Message log — every attempt lands here, sent or refused. Non-throwing.
// ============================================================================
async function logSmsMessage(row) {
  try {
    const { error } = await supabaseAdmin.from('generator_sms_messages').insert(row);
    if (error) console.error('[sms] message log insert failed:', error.message);
  } catch (e) {
    console.error('[sms] message log insert failed:', e && e.message);
  }
}

// ============================================================================
// Consent ledger. Rows are never deleted — opt-in/out flip flags and stamp
// timestamps; consent_text keeps the exact language from the LAST opt-in.
// ============================================================================
async function getConsent({ phone, customerId }) {
  let q = supabaseAdmin
    .from('generator_sms_consent')
    .select('id, customer_id, phone, opted_in, opted_out')
    .eq('phone', phone);
  if (customerId) q = q.eq('customer_id', customerId);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

// Record an opt-in or opt-out for (customer, phone). Returns the row state,
// or null when it couldn't be written. Throws nothing.
async function recordConsent({ customerId, phone, optedIn, source, consentText }) {
  const e164 = normalizePhone(phone);
  if (!e164 || !customerId) return null;
  const now = new Date().toISOString();
  try {
    const { data: existing, error: selErr } = await supabaseAdmin
      .from('generator_sms_consent')
      .select('id, opted_in, opted_out')
      .eq('customer_id', customerId)
      .eq('phone', e164)
      .maybeSingle();
    if (selErr) throw selErr;

    if (existing) {
      const updates = optedIn
        ? { opted_in: true, opted_out: false, opted_in_at: now, source, consent_text: consentText, updated_at: now }
        // Opt-out keeps the original consent_text/source — that's the record
        // of what they agreed to before withdrawing.
        : { opted_out: true, opted_out_at: now, updated_at: now };
      const { data, error } = await supabaseAdmin
        .from('generator_sms_consent')
        .update(updates)
        .eq('id', existing.id)
        .select()
        .maybeSingle();
      if (error) throw error;
      return data;
    }

    const { data, error } = await supabaseAdmin
      .from('generator_sms_consent')
      .insert({
        customer_id: customerId,
        phone: e164,
        opted_in: !!optedIn,
        opted_out: !optedIn,
        source,
        consent_text: consentText || null,
        opted_in_at: optedIn ? now : null,
        opted_out_at: optedIn ? null : now,
      })
      .select()
      .maybeSingle();
    if (error) throw error;
    return data;
  } catch (e) {
    console.error('[sms] consent write failed:', e && e.message);
    reportError(new Error('sms consent write failed for customer ' + customerId + ': ' + ((e && e.message) || e)), { route: 'lib/sms recordConsent' }).catch(() => {});
    return null;
  }
}

// Flip opted_out for EVERY consent row on a phone (a STOP applies to the
// number, not one customer record). Returns how many rows were flipped.
async function optOutPhone(phone) {
  const e164 = normalizePhone(phone);
  if (!e164) return 0;
  try {
    const { data, error } = await supabaseAdmin
      .from('generator_sms_consent')
      .update({ opted_out: true, opted_out_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('phone', e164)
      .eq('opted_out', false)
      .select('id');
    if (error) throw error;
    return (data || []).length;
  } catch (e) {
    console.error('[sms] opt-out write failed:', e && e.message);
    return 0;
  }
}

// ============================================================================
// SimpleTexting contact naming — best-effort. Sending to a number the account
// has never seen makes SimpleTexting auto-create a bare contact with NO name,
// so the shared inbox shows "no name / (314) 409-5426" and the office can't
// tell customers apart. Whenever we have a name + phone (consent time), upsert
// the contact so it shows as "John Fort" before we ever text them.
//
// Provider facts (confirmed against api-doc.simpletexting.com OpenAPI spec,
// 2026-07-17):
//   POST {base}/api/contacts?upsert=true&listsReplacement=false
//   body (SingleContactUpdate): { contactPhone (10-digit national),
//   firstName?, lastName? } — omitted fields are left untouched. 201 -> {id}.
//   upsert=true turns "already exists" into an update instead of an error;
//   listsReplacement=false is load-bearing on this SHARED account: its
//   default (true) would remove the contact from every list it's already on
//   (the service team's lists included) — never send this without it.
//
// Name split: first space only — "John Fort" -> John/Fort, "Anna van Dyke" ->
// Anna/"van Dyke", "Cher" -> firstName only.
//
// NEVER throws and must never block a caller — a naming hiccup can't be
// allowed to fail a signup, consent write, or send. Missing input/config just
// skips quietly; a live API failure logs + reportErrors. Returns
// { ok, reason? } so unit tests can see why it skipped.
// ============================================================================
async function upsertSimpleTextingContact({ phone, name }) {
  try {
    const e164 = normalizePhone(phone);
    const trimmed = String(name || '').trim();
    if (!e164 || !trimmed) return { ok: false, reason: 'missing phone or name' };
    const token = process.env.SIMPLETEXTING_API_TOKEN;
    if (!token) return { ok: false, reason: 'SIMPLETEXTING_API_TOKEN not set' };

    const spaceAt = trimmed.search(/\s/);
    const contact = { contactPhone: toProviderPhone(e164) };
    if (spaceAt === -1) {
      contact.firstName = trimmed;
    } else {
      contact.firstName = trimmed.slice(0, spaceAt);
      contact.lastName = trimmed.slice(spaceAt + 1).trim();
    }

    const resp = await fetch(SIMPLETEXTING_BASE + '/api/contacts?upsert=true&listsReplacement=false', {
      method: 'POST',
      headers: {
        // Token lives ONLY in this header — never in a log or error detail.
        Authorization: 'Bearer ' + token,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(contact),
    });
    if (!resp.ok) {
      const errBody = await resp.text().catch(() => '');
      throw new Error('SimpleTexting ' + resp.status + ': ' + errBody.slice(0, 300));
    }
    return { ok: true };
  } catch (e) {
    const detail = 'contact name upsert failed: ' + ((e && e.message) || e);
    console.error('[sms] ' + detail);
    reportError(new Error('[sms] ' + detail), { route: 'lib/sms upsertSimpleTextingContact' }).catch(() => {});
    return { ok: false, reason: detail };
  }
}

// ============================================================================
// The send. Gate order: consent -> kill-switch -> quiet hours -> transport.
// Every refusal logs a generator_sms_messages row saying why, so booking with
// SMS_ENABLED=false still leaves the visible "would have sent" trail the
// verification plan relies on. Never throws; returns { sent, status, reason }.
//
// opts: { toPhone, body, customerId?, relatedVisitId?,
//         ignoreQuietHours? (direct replies to an inbound text only),
//         logBody? (what to store in generator_sms_messages instead of body —
//           used to redact secrets like magic-link URLs from the log; the
//           wire still carries the real body),
//         now? (test seam for the quiet-hours clock) }
// ============================================================================
async function sendSms({ toPhone, body, customerId, relatedVisitId, ignoreQuietHours, logBody, now }) {
  const accountPhone = normalizePhone(process.env.SIMPLETEXTING_ACCOUNT_PHONE) || null;
  const e164 = normalizePhone(toPhone);
  const base = {
    direction: 'out',
    to_phone: e164 || String(toPhone || '').slice(0, 30),
    from_phone: accountPhone,
    body: logBody || body,
    customer_id: customerId || null,
    related_visit_id: relatedVisitId || null,
  };
  const refuse = async (status, detail) => {
    await logSmsMessage({ ...base, status, detail: detail || null });
    return { sent: false, status, reason: detail || status };
  };

  if (!e164) return refuse('invalid_phone', 'could not normalize to E.164');

  // Consent gate — hard requirement for every send, replies included.
  let consentRows;
  try {
    consentRows = await getConsent({ phone: e164, customerId });
  } catch (e) {
    return refuse('failed', 'consent lookup failed: ' + ((e && e.message) || e));
  }
  if (consentRows.some((r) => r.opted_out)) return refuse('opted_out');
  if (!consentRows.some((r) => r.opted_in)) return refuse('no_consent');

  // Kill-switch: log the full would-be message, send nothing.
  if (!smsEnabled()) return refuse('disabled', 'SMS_ENABLED is not true');

  if (!ignoreQuietHours && !withinQuietHours(now)) {
    return refuse('quiet_hours', 'outside 8am-9pm Central');
  }

  const token = process.env.SIMPLETEXTING_API_TOKEN;
  if (!token) {
    console.error('[sms] SIMPLETEXTING_API_TOKEN is not set - cannot send. Add it to the Render environment.');
    return refuse('failed', 'SIMPLETEXTING_API_TOKEN not set');
  }
  if (!accountPhone) {
    console.error('[sms] SIMPLETEXTING_ACCOUNT_PHONE is not set - cannot send.');
    return refuse('failed', 'SIMPLETEXTING_ACCOUNT_PHONE not set');
  }

  try {
    const resp = await fetch(SIMPLETEXTING_BASE + '/api/messages', {
      method: 'POST',
      headers: {
        // The token lives ONLY in this header. It must never reach a log,
        // an error detail, or a response body.
        Authorization: 'Bearer ' + token,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        contactPhone: toProviderPhone(e164),
        accountPhone: toProviderPhone(accountPhone),
        // AUTO, not SINGLE_SMS_STRICTLY: the booking confirmation runs over
        // 160 chars (EXTENDED_SMS) and strict mode errors instead of sending.
        mode: 'AUTO',
        text: body,
      }),
    });
    if (!resp.ok) {
      const errBody = await resp.text().catch(() => '');
      const detail = 'SimpleTexting ' + resp.status + ': ' + errBody.slice(0, 300);
      reportError(new Error('[sms] send failed: ' + detail), { route: 'lib/sms sendSms' }).catch(() => {});
      return refuse('failed', detail);
    }
    const data = await resp.json().catch(() => ({}));
    await logSmsMessage({ ...base, status: 'sent', provider_id: (data && data.id) || null });
    console.log('[sms] sent to ' + e164 + (relatedVisitId ? ' (visit ' + relatedVisitId + ')' : ''));
    return { sent: true, status: 'sent' };
  } catch (e) {
    const detail = 'request failed: ' + ((e && e.message) || e);
    reportError(new Error('[sms] send failed: ' + detail), { route: 'lib/sms sendSms' }).catch(() => {});
    return refuse('failed', detail);
  }
}

// ============================================================================
// Auto-login magic link over SMS (Phase 3, Part A).
//
// Texts a single-use Supabase magic login link so the customer taps once and
// lands signed-in on the my. portal (frontend/my.js already handles the
// #access_token hash landing). GUARDRAILS — all load-bearing:
//   - The link goes ONLY to the phone number on file. Callers must pass the
//     customer's stored phone — never a number from an inbound SMS, request
//     body, or anything else the customer could influence. The inbound
//     webhook (routes/sms-inbound.js) must never call this.
//   - The customer is texted a SHORT BRANDED link — my.bates-electric.com/s/
//     <token> — not the raw supabase.co action_link (which reads like
//     phishing in an SMS). The token -> action_link map lives in
//     generator_magic_shortlinks (sql/028); GET /s/:token (routes/
//     magic-shortlink.js) 302-redirects to the real link. If the shortlink
//     row can't be stored, the send FAILS (non-terminal, so callers retry) —
//     falling back to texting the raw link is deliberately not allowed.
//   - Single-use + short-lived, twice over: the Supabase link has both
//     properties natively (the OTP expiry is a dashboard setting — keep it
//     low), and the shortlink adds its own used_at claim + 30-min expiry
//     (kept at/under the OTP expiry so the short link never outlives the
//     real one).
//   - The action_link / token is NEVER logged: not to the console, not to
//     generator_sms_messages (the logged copy carries a placeholder instead),
//     not in error details. Treat it like a password. The short link is a
//     credential too — same rule.
//   - The send still goes through sendSms, so consent, the SMS_ENABLED
//     kill-switch, quiet hours, and attempt logging all stay in force. The
//     link is minted before those gates run; a refused send just lets the
//     unused link expire, which is harmless — duplicating the gate logic
//     here to avoid that would be worse.
//
// `buildBody(link)` -> the final message text: the caller owns the copy (it
// must be strictly transactional), this helper owns the link. Called twice —
// once with the real link for the wire, once with a placeholder for the log.
// Returns sendSms's { sent, status, reason }; a link-minting failure returns
// the non-terminal { sent:false, status:'failed' } so callers retry later.
// ============================================================================
const MY_PORTAL_URL = 'https://my.bates-electric.com/';
const MAGIC_LINK_PLACEHOLDER = '[auto-login link]';
const SHORTLINK_BASE = MY_PORTAL_URL + 's/';
// 9 random bytes -> 12 base64url chars (72 bits) — unguessable at any
// realistic rate-limited probe rate within the 30-minute lifetime.
const SHORTLINK_TOKEN_BYTES = 9;
const SHORTLINK_TTL_MS = 30 * 60 * 1000;

async function sendMagicLoginSms({ customerId, phone, email, buildBody, relatedVisitId, now }) {
  const logBody = buildBody(MAGIC_LINK_PLACEHOLDER);

  // A phone that can't normalize can never receive the link — skip minting
  // one, but still route through sendSms so the invalid_phone refusal lands
  // in the message log like every other attempt.
  if (!normalizePhone(phone)) {
    return sendSms({ toPhone: phone, body: logBody, customerId, relatedVisitId, logBody, now });
  }

  let actionLink;
  try {
    const mint = () => supabaseAdmin.auth.admin.generateLink({
      type: 'magiclink',
      email,
      options: { redirectTo: MY_PORTAL_URL },
    });
    let { data, error } = await mint();
    if (error && /not.?found/i.test(error.message || '')) {
      // The customer has never signed in, so no auth account exists yet.
      // The portal's own sign-in form creates one on demand for exactly this
      // email (create_user: true OTP in frontend/my.js) — mirror that, then
      // mint again.
      const created = await supabaseAdmin.auth.admin.createUser({ email, email_confirm: true });
      if (created.error) throw new Error('createUser failed: ' + created.error.message);
      ({ data, error } = await mint());
    }
    if (error) throw new Error('generateLink failed: ' + error.message);
    actionLink = data && data.properties && data.properties.action_link;
    if (!actionLink) throw new Error('generateLink returned no action_link');
  } catch (e) {
    const detail = 'magic link generation failed: ' + ((e && e.message) || e);
    console.error('[sms] ' + detail);
    reportError(new Error('[sms] ' + detail + ' (customer ' + customerId + ')'), { route: 'lib/sms sendMagicLoginSms' }).catch(() => {});
    return { sent: false, status: 'failed', reason: detail };
  }

  // Wrap the raw link in a short branded /s/<token> URL. Storing the row is
  // load-bearing: without it the short link would 302 to "expired", so a
  // failed insert fails the send (non-terminal — callers retry) rather than
  // ever putting the raw supabase.co link on the wire. The error detail never
  // includes the token or target.
  const token = crypto.randomBytes(SHORTLINK_TOKEN_BYTES).toString('base64url');
  try {
    const mintedAt = now || new Date();
    const { error: linkErr } = await supabaseAdmin
      .from('generator_magic_shortlinks')
      .insert({
        token,
        target_url: actionLink,
        customer_id: customerId || null,
        expires_at: new Date(mintedAt.getTime() + SHORTLINK_TTL_MS).toISOString(),
      });
    if (linkErr) throw new Error(linkErr.message);
  } catch (e) {
    const detail = 'shortlink store failed: ' + ((e && e.message) || e);
    console.error('[sms] ' + detail);
    reportError(new Error('[sms] ' + detail + ' (customer ' + customerId + ')'), { route: 'lib/sms sendMagicLoginSms' }).catch(() => {});
    return { sent: false, status: 'failed', reason: detail };
  }

  return sendSms({
    toPhone: phone,
    body: buildBody(SHORTLINK_BASE + token),
    customerId,
    relatedVisitId,
    logBody,
    now,
  });
}

module.exports = {
  CONSENT_TEXT,
  normalizePhone,
  smsEnabled,
  withinQuietHours,
  smsBrand,
  fmtSmsDate,
  smsWindowText,
  buildBookingConfirmationSms,
  buildConfirmedReplySms,
  buildReminderSms,
  buildRescheduleReplySms,
  buildOptInConfirmationSms,
  buildScheduleNudgeSms,
  getConsent,
  recordConsent,
  optOutPhone,
  upsertSimpleTextingContact,
  sendSms,
  sendMagicLoginSms,
  logSmsMessage,
};
