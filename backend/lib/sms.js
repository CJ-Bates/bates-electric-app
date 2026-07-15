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

// (6) OPT-IN CONFIRMATION — the moment a customer opts in (carrier-required
// disclosures: frequency, rates, HELP/STOP).
function buildOptInConfirmationSms({ installState }) {
  return smsBrand(installState) + ': You\'re signed up for appointment texts. Msg frequency varies. ' +
    'Msg & data rates may apply. Reply HELP for help, STOP to cancel.';
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
// The send. Gate order: consent -> kill-switch -> quiet hours -> transport.
// Every refusal logs a generator_sms_messages row saying why, so booking with
// SMS_ENABLED=false still leaves the visible "would have sent" trail the
// verification plan relies on. Never throws; returns { sent, status, reason }.
//
// opts: { toPhone, body, customerId?, relatedVisitId?,
//         ignoreQuietHours? (direct replies to an inbound text only),
//         now? (test seam for the quiet-hours clock) }
// ============================================================================
async function sendSms({ toPhone, body, customerId, relatedVisitId, ignoreQuietHours, now }) {
  const accountPhone = normalizePhone(process.env.SIMPLETEXTING_ACCOUNT_PHONE) || null;
  const e164 = normalizePhone(toPhone);
  const base = {
    direction: 'out',
    to_phone: e164 || String(toPhone || '').slice(0, 30),
    from_phone: accountPhone,
    body,
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
  buildRescheduleReplySms,
  buildOptInConfirmationSms,
  getConsent,
  recordConsent,
  optOutPhone,
  sendSms,
  logSmsMessage,
};
