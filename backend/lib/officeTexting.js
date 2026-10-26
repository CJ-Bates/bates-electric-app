// backend/lib/officeTexting.js
// ONE path for "a staff member texts a customer", shared by the customer
// record's reply box (routes/generator-care/subscriptions.js sms-reply) and
// the Texts inbox composer (routes/generator-care/texts.js). Both must behave
// identically, because the Phase 1 rule is "sending any manual message also
// takes over the conversation" - a path that forgot would leave automation
// talking over the staff member.
//
// Order: eligibility (consent / STOP / undeliverable / 30-day reply window)
// -> take over (audit reason 'sent_message') -> sendSms with sentBy ->
// stamp the conversation (idle clock restarts, needs-reply cleared). The
// takeover happens BEFORE the transport call on purpose: a send refused for
// a transient reason (quiet hours, kill-switch) still says "a person is on
// this", and the member can hand back if they change their mind.
//
// Returns { ok, status, basis?, error?, conversation? }. Never throws for a
// refused send; a real system error does throw (callers 500).

const { normalizePhone, operatorReplyEligibility, sendSms, OPERATOR_REPLY_WINDOW_DAYS } = require('./sms');
const { ensureConversation, takeOver, recordOfficeSend } = require('./smsConversations');

const OPERATOR_SMS_MAX_CHARS = 1000;

const REPLY_BLOCKED_MESSAGE = {
  opted_out: 'This customer has opted out of texts (STOP). Nothing can be sent to this number.',
  no_consent_no_recent_inbound: 'No text consent on file and no text from this customer in the last ' + OPERATOR_REPLY_WINDOW_DAYS + ' days. Record consent to text them, or wait for them to text first.',
  invalid_phone: 'No usable mobile number on file for this customer.',
  undeliverable: 'Texts to this number are not deliverable. Check the phone number on the customer record.',
};

const SEND_FAILED_MESSAGE = (status, reason) => ({
  opted_out: REPLY_BLOCKED_MESSAGE.opted_out,
  no_consent: REPLY_BLOCKED_MESSAGE.no_consent_no_recent_inbound,
  quiet_hours: 'Not sent: outside 8am-9pm Central and this customer has not texted recently. It was logged, not sent - try again after 8am.',
  disabled: 'Not sent: texting is switched off (SMS_ENABLED). The message was logged.',
  invalid_phone: REPLY_BLOCKED_MESSAGE.invalid_phone,
  undeliverable: REPLY_BLOCKED_MESSAGE.undeliverable,
}[status] || ('Not sent: ' + (reason || status)));

// Normalize the composer text; '' means "nothing to send".
function cleanOperatorText(raw) {
  return String(raw || '').replace(/\r\n/g, '\n').trim();
}

// customer: { id, phone } (from the DB, never the request). profileId: the
// office member. phoneOverride: the inbox passes the conversation's phone so
// a changed customer number can't redirect a thread's reply.
async function sendOperatorText({ customer, profileId, text, phoneOverride, now }) {
  const body = cleanOperatorText(text);
  if (!body) return { ok: false, httpStatus: 400, error: 'Type a message first.' };
  if (body.length > OPERATOR_SMS_MAX_CHARS) {
    return { ok: false, httpStatus: 400, error: 'Message is too long (max ' + OPERATOR_SMS_MAX_CHARS + ' characters).' };
  }

  const phone = normalizePhone(phoneOverride || customer.phone);
  const eligibility = await operatorReplyEligibility({ phone, customerId: customer.id, now });
  if (!eligibility.allowed) {
    return { ok: false, httpStatus: 409, error: REPLY_BLOCKED_MESSAGE[eligibility.reason] || 'Texting this customer is not allowed.', reason: eligibility.reason };
  }

  // Take over first (see header). Conversation state failing must not block
  // the text itself - log and carry on without it.
  let conversation = null;
  try {
    conversation = await ensureConversation({ customerId: customer.id, phone, now });
    conversation = await takeOver({ conv: conversation, profileId, reason: 'sent_message', now });
  } catch (e) {
    console.error('[office-texting] takeover failed (sending anyway):', e && e.message);
  }

  const result = await sendSms({
    toPhone: phone,
    body,
    customerId: customer.id,
    replyToInbound: true,
    ignoreQuietHours: eligibility.recent_inbound, // active conversation only - never a cold send
    sentBy: profileId,
    now,
  });
  if (!result.sent) {
    return { ok: false, httpStatus: 409, error: SEND_FAILED_MESSAGE(result.status, result.reason), status: result.status, conversation };
  }
  if (conversation) conversation = await recordOfficeSend({ conv: conversation, now });
  return { ok: true, status: result.status, basis: eligibility.reason, conversation };
}

module.exports = { sendOperatorText, cleanOperatorText, OPERATOR_SMS_MAX_CHARS, REPLY_BLOCKED_MESSAGE };
