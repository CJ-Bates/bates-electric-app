// backend/lib/smsConversations.js
// Conversation state for the office texting inbox (sql/037): one row per
// (customer, phone) in generator_sms_conversations, with a MODE that decides
// who answers the customer.
//
//   auto    the system answers (holding reply, reschedule link, confirmations,
//           reminders, nudges) exactly as it did before the inbox existed.
//   office  a staff member owns the conversation. NOTHING automated goes out
//           to that customer: webhook auto-replies are suppressed outright
//           (routes/sms-inbound.js), and scheduled texts that come due are
//           refused by lib/sms.js with the non-terminal status 'held' so the
//           existing queue-and-sweep retries them after hand-back (and drops
//           them, on record, if they are stale by then). Carrier compliance
//           traffic (STOP/HELP/START handling, the opt-in disclosure) is the
//           only exception and always runs.
//
// Rules (Phase 1 spec, 2026-10-26):
//   - Take over: a button, OR sending any manual message (so staff can never
//     forget). Anyone with the `texting` permission may take over from anyone
//     else; the audit row records who.
//   - Hand back: a button, or the IDLE TIMEOUT - no office message for
//     SMS_OFFICE_IDLE_MS (default 2h, measured from the later of takeover and
//     the last office message). Returning to auto never sends a message by
//     itself. The timeout is enforced LAZILY: every read of a conversation
//     (inbox list, thread, the inbound webhook, the lib/sms.js hold gate)
//     goes through resolveMode(), which flips an expired row to auto and
//     writes the audit event. No extra cron is needed: the first automated
//     send attempt after the window (the hourly sweep) expires it.
//   - Needs reply: set when the customer sends something a person has to
//     answer (free text or a reschedule request - the intents that email the
//     office today); cleared by an office send or "Mark handled". A Y never
//     sets it. The holding reply does NOT clear it: the customer is still
//     waiting on a person.
//   - Office-mode alerts: an inbound emails ONLY the owner, and only if they
//     have not replied SMS_OWNER_ALERT_DELAY_MS (default 10 min) later. The
//     check is scheduled in-process (setTimeout) with owner_alert_due_at as
//     the durable record, and sweepOwnerAlerts() (hourly cron) catches any
//     timer lost to a restart. URGENT visit-day alerts are NOT deferred - the
//     webhook sends those immediately to the owner + the office list.
//   - Every mode change lands in generator_sms_conversation_events.
//
// Every function here is non-throwing unless noted; a conversation-state
// hiccup must never block a text or the webhook. Lookups FAIL OPEN
// (= 'auto'): a missing table (migration pending) means today's behavior,
// loudly logged, not silence.

const { supabaseAdmin } = require('./supabase');
const { sendEmail, escHtml } = require('./emails');
const { reportError } = require('../middleware/error-reporter');

const IDLE_MS = Number(process.env.SMS_OFFICE_IDLE_MS) || 2 * 60 * 60 * 1000;
const OWNER_ALERT_DELAY_MS = Number(process.env.SMS_OWNER_ALERT_DELAY_MS) || 10 * 60 * 1000;
// Digest line: "customer texted, nothing has answered for 2+ hours".
const NEEDS_REPLY_DIGEST_AGE_MS = 2 * 60 * 60 * 1000;

const TEXTS_TAB_URL = 'https://app.bates-electric.com/generator-care#texts';

const CONV_SELECT = 'id, customer_id, phone, mode, owner_profile_id, taken_over_at, last_office_message_at, last_inbound_at, last_outbound_at, needs_reply_since, owner_alert_due_at, owner_alerted_at, created_at, updated_at';

const iso = (d) => (d instanceof Date ? d : new Date(d || Date.now())).toISOString();

// ----------------------------------------------------------------------------
// Lookup / create
// ----------------------------------------------------------------------------
// Throws on a query error (callers decide how to degrade).
async function findConversation({ customerId, phone }) {
  if (!customerId || !phone) return null;
  const { data, error } = await supabaseAdmin
    .from('generator_sms_conversations')
    .select(CONV_SELECT)
    .eq('customer_id', customerId)
    .eq('phone', phone)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function findConversationById(id) {
  const { data, error } = await supabaseAdmin
    .from('generator_sms_conversations')
    .select(CONV_SELECT)
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

// The row for (customer, phone), created in 'auto' if it does not exist yet.
// Two concurrent creators are harmless: the unique index makes the loser's
// insert fail and we re-read. Throws on a query error.
async function ensureConversation({ customerId, phone, now }) {
  const existing = await findConversation({ customerId, phone });
  if (existing) return existing;
  const { data, error } = await supabaseAdmin
    .from('generator_sms_conversations')
    .insert({ customer_id: customerId, phone, mode: 'auto', created_at: iso(now), updated_at: iso(now) })
    .select(CONV_SELECT)
    .maybeSingle();
  if (!error && data) return data;
  const again = await findConversation({ customerId, phone });
  if (again) return again;
  throw error || new Error('conversation insert returned nothing');
}

// ----------------------------------------------------------------------------
// Mode resolution (lazy idle timeout)
// ----------------------------------------------------------------------------
function idleDeadline(conv) {
  if (!conv || conv.mode !== 'office') return null;
  const anchors = [conv.taken_over_at, conv.last_office_message_at].filter(Boolean).map((t) => new Date(t).getTime());
  if (!anchors.length) return null; // malformed office row: treat as never-expiring, hand-back is manual
  return new Date(Math.max(...anchors) + IDLE_MS);
}

function idleExpired(conv, now) {
  const deadline = idleDeadline(conv);
  return !!deadline && deadline.getTime() <= (now ? new Date(now).getTime() : Date.now());
}

async function writeEvent(row) {
  const { error } = await supabaseAdmin.from('generator_sms_conversation_events').insert(row);
  if (error) throw error;
}

// The conversation as it stands NOW: an office row whose idle window has
// passed is flipped back to auto here (audit reason 'idle_timeout'), with an
// optimistic guard so two concurrent readers can't double-flip. Returns the
// (possibly updated) row. Throws on a query error.
async function resolveMode(conv, now) {
  if (!conv || !idleExpired(conv, now)) return conv;
  const at = iso(now);
  const previousOwner = conv.owner_profile_id || null; // snapshot before the write
  const patch = { mode: 'auto', owner_profile_id: null, owner_alert_due_at: null, updated_at: at };
  const { data, error } = await supabaseAdmin
    .from('generator_sms_conversations')
    .update(patch)
    .eq('id', conv.id)
    .eq('mode', 'office')
    .select(CONV_SELECT)
    .maybeSingle();
  if (error) throw error;
  if (!data) return (await findConversationById(conv.id)) || { ...conv, ...patch }; // someone else flipped it first
  await writeEvent({
    conversation_id: conv.id,
    from_mode: 'office',
    to_mode: 'auto',
    reason: 'idle_timeout',
    actor_profile_id: null,
    previous_owner_profile_id: previousOwner,
    new_owner_profile_id: null,
    note: 'no office message for ' + Math.round(IDLE_MS / 60000) + ' minutes',
    created_at: at,
  });
  console.log('[sms-conv] conversation ' + conv.id + ' returned to auto (idle timeout)');
  return data;
}

// Is this (customer, phone) owned by the office right now? FAILS OPEN to
// false: a state lookup problem must never silence an automated text, and
// the result is logged loudly so a missing table is noticed.
async function isOfficeMode({ customerId, phone, now }) {
  try {
    const conv = await findConversation({ customerId, phone });
    if (!conv) return false;
    const resolved = await resolveMode(conv, now);
    return resolved.mode === 'office';
  } catch (e) {
    console.error('[sms-conv] office-mode lookup failed (treating as auto):', e && e.message);
    return false;
  }
}

// ----------------------------------------------------------------------------
// Mode changes
// ----------------------------------------------------------------------------
// Take over for `profileId`. reason: 'manual' (button) | 'sent_message'
// (sending from the inbox or the customer record). Taking over a conversation
// another member owns re-assigns it and records both parties. Taking over
// your own office-mode conversation is a no-op (no event). Throws on error.
async function takeOver({ conv, profileId, reason, now }) {
  const at = iso(now);
  const current = await resolveMode(conv, now);
  if (current.mode === 'office' && current.owner_profile_id === profileId) return current;
  const fromMode = current.mode;                           // snapshot before the write
  const previousOwner = current.owner_profile_id || null;
  const { data, error } = await supabaseAdmin
    .from('generator_sms_conversations')
    .update({ mode: 'office', owner_profile_id: profileId, taken_over_at: at, updated_at: at })
    .eq('id', current.id)
    .select(CONV_SELECT)
    .maybeSingle();
  if (error) throw error;
  await writeEvent({
    conversation_id: current.id,
    from_mode: fromMode,
    to_mode: 'office',
    reason,
    actor_profile_id: profileId,
    previous_owner_profile_id: previousOwner,
    new_owner_profile_id: profileId,
    note: fromMode === 'office' ? 'taken over from another member' : null,
    created_at: at,
  });
  return data || { ...current, mode: 'office', owner_profile_id: profileId, taken_over_at: at };
}

// Hand back to auto (button). Never sends anything itself; the caller may
// run the held-text sweep afterwards. Throws on error.
async function handBack({ conv, profileId, now }) {
  const at = iso(now);
  const current = await resolveMode(conv, now);
  if (current.mode !== 'office') return current;
  const previousOwner = current.owner_profile_id || null; // snapshot before the write
  const { data, error } = await supabaseAdmin
    .from('generator_sms_conversations')
    .update({ mode: 'auto', owner_profile_id: null, owner_alert_due_at: null, updated_at: at })
    .eq('id', current.id)
    .select(CONV_SELECT)
    .maybeSingle();
  if (error) throw error;
  await writeEvent({
    conversation_id: current.id,
    from_mode: 'office',
    to_mode: 'auto',
    reason: 'manual',
    actor_profile_id: profileId,
    previous_owner_profile_id: previousOwner,
    new_owner_profile_id: null,
    note: null,
    created_at: at,
  });
  return data || { ...current, mode: 'auto', owner_profile_id: null };
}

// ----------------------------------------------------------------------------
// Activity stamps
// ----------------------------------------------------------------------------
// A text FROM the customer landed. needsReply: a person has to answer it.
// armOwnerAlert (default true): in office mode, arm the deferred owner alert
// unless one is already pending for an earlier unanswered text - the webhook
// passes false for carrier plumbing (STOP/START/HELP). Returns the updated
// row; never throws (logs).
async function recordInbound({ conv, needsReply, armOwnerAlert = true, now }) {
  if (!conv) return null;
  const at = iso(now);
  const patch = { last_inbound_at: at, updated_at: at };
  if (needsReply && !conv.needs_reply_since) patch.needs_reply_since = at;
  if (armOwnerAlert && conv.mode === 'office' && !conv.owner_alert_due_at) {
    patch.owner_alert_due_at = new Date(new Date(at).getTime() + OWNER_ALERT_DELAY_MS).toISOString();
  }
  try {
    const { data, error } = await supabaseAdmin
      .from('generator_sms_conversations')
      .update(patch)
      .eq('id', conv.id)
      .select(CONV_SELECT)
      .maybeSingle();
    if (error) throw error;
    return data || { ...conv, ...patch };
  } catch (e) {
    console.error('[sms-conv] inbound stamp failed:', e && e.message);
    return { ...conv, ...patch };
  }
}

// A staff member's text went out: the idle clock restarts, the customer has
// been answered, and any pending owner alert is cancelled. Never throws.
async function recordOfficeSend({ conv, now }) {
  if (!conv) return null;
  const at = iso(now);
  const patch = { last_office_message_at: at, last_outbound_at: at, needs_reply_since: null, owner_alert_due_at: null, updated_at: at };
  try {
    const { data, error } = await supabaseAdmin
      .from('generator_sms_conversations')
      .update(patch)
      .eq('id', conv.id)
      .select(CONV_SELECT)
      .maybeSingle();
    if (error) throw error;
    return data || { ...conv, ...patch };
  } catch (e) {
    console.error('[sms-conv] office-send stamp failed:', e && e.message);
    return { ...conv, ...patch };
  }
}

// Any text actually SENT to the customer (automated or operator). Creates the
// conversation if this is the first contact, so the inbox lists everyone who
// has ever been texted. Never throws.
async function recordOutbound({ customerId, phone, now }) {
  if (!customerId || !phone) return;
  try {
    const conv = await ensureConversation({ customerId, phone, now });
    const { error } = await supabaseAdmin
      .from('generator_sms_conversations')
      .update({ last_outbound_at: iso(now), updated_at: iso(now) })
      .eq('id', conv.id);
    if (error) throw error;
  } catch (e) {
    console.error('[sms-conv] outbound stamp failed:', e && e.message);
  }
}

// "Mark handled": the office dealt with it without texting (a phone call).
async function markHandled({ conv, now }) {
  const at = iso(now);
  const { data, error } = await supabaseAdmin
    .from('generator_sms_conversations')
    .update({ needs_reply_since: null, owner_alert_due_at: null, updated_at: at })
    .eq('id', conv.id)
    .select(CONV_SELECT)
    .maybeSingle();
  if (error) throw error;
  return data || { ...conv, needs_reply_since: null, owner_alert_due_at: null };
}

// Per-staff read receipt. Never throws.
async function markRead({ conversationId, profileId, now }) {
  try {
    const { error } = await supabaseAdmin
      .from('generator_sms_conversation_reads')
      .upsert({ conversation_id: conversationId, profile_id: profileId, last_read_at: iso(now) }, { onConflict: 'conversation_id,profile_id' });
    if (error) throw error;
  } catch (e) {
    console.error('[sms-conv] read receipt failed:', e && e.message);
  }
}

// ----------------------------------------------------------------------------
// Deferred owner alert
// ----------------------------------------------------------------------------
// Re-reads the conversation at delivery time and emails the owner ONLY if it
// is still in office mode, still owned, the alert is still due, and no office
// message has gone out since the customer's last text. Otherwise the pending
// mark is just cleared. Never throws.
async function deliverOwnerAlert(conversationId, now) {
  try {
    const conv = await findConversationById(conversationId);
    if (!conv || !conv.owner_alert_due_at) return { sent: false, reason: 'nothing pending' };
    const t = now ? new Date(now).getTime() : Date.now();
    if (new Date(conv.owner_alert_due_at).getTime() > t) return { sent: false, reason: 'not due yet' };
    const clear = async () => {
      await supabaseAdmin.from('generator_sms_conversations')
        .update({ owner_alert_due_at: null, updated_at: iso(t) }).eq('id', conv.id);
    };
    const resolved = await resolveMode(conv, t);
    if (resolved.mode !== 'office' || !resolved.owner_profile_id) { await clear(); return { sent: false, reason: 'not in office mode' }; }
    const answered = resolved.last_office_message_at && resolved.last_inbound_at &&
      new Date(resolved.last_office_message_at).getTime() >= new Date(resolved.last_inbound_at).getTime();
    if (answered) { await clear(); return { sent: false, reason: 'owner replied' }; }

    const [{ data: owner }, { data: customer }, { data: inbound }] = await Promise.all([
      supabaseAdmin.from('profiles').select('id, email, full_name').eq('id', resolved.owner_profile_id).maybeSingle(),
      supabaseAdmin.from('generator_customers').select('id, name').eq('id', resolved.customer_id).maybeSingle(),
      supabaseAdmin.from('generator_sms_messages').select('body, created_at')
        .eq('direction', 'in').eq('from_phone', resolved.phone).eq('customer_id', resolved.customer_id)
        .order('created_at', { ascending: false }).limit(3),
    ]);
    if (!owner || !owner.email) { await clear(); return { sent: false, reason: 'owner has no email' }; }

    const name = (customer && customer.name) || resolved.phone;
    const minutes = Math.round(OWNER_ALERT_DELAY_MS / 60000);
    const lines = (inbound || []).slice().reverse().map((m) => '"' + String(m.body || '').slice(0, 300) + '"');
    const intro = 'You own the text conversation with ' + name + ' (' + resolved.phone + '). They texted ' + minutes +
      '+ minutes ago and nothing has gone back to them. Automated replies are off while you hold it.';
    const html = '<div style="font-family:system-ui,sans-serif;font-size:14px;line-height:1.5;">' +
      '<p style="margin:0 0 8px;">' + escHtml(intro) + '</p>' +
      lines.map((l) => '<p style="margin:0 0 6px;color:#374151;">' + escHtml(l) + '</p>').join('') +
      '<p style="margin:12px 0 0;"><a href="' + TEXTS_TAB_URL + '">Open the Texts inbox</a></p></div>';
    await sendEmail({
      to: [owner.email],
      subject: '[Generator Care] Text waiting on you - ' + name,
      html,
      text: intro + '\n' + lines.join('\n') + '\n' + TEXTS_TAB_URL,
      logTag: '[sms-owner-alert]',
      log: { customerId: resolved.customer_id },
    });
    await supabaseAdmin.from('generator_sms_conversations')
      .update({ owner_alert_due_at: null, owner_alerted_at: iso(t), updated_at: iso(t) }).eq('id', conv.id);
    return { sent: true };
  } catch (e) {
    console.error('[sms-conv] owner alert failed:', e && e.message);
    reportError(new Error('[sms-conv] owner alert failed for conversation ' + conversationId + ': ' + ((e && e.message) || e)), { route: 'lib/smsConversations deliverOwnerAlert' }).catch(() => {});
    return { sent: false, reason: 'error' };
  }
}

// In-process timer for the deferred check. unref'd so it never holds the
// process open (tests, shutdown); sweepOwnerAlerts is the durable backstop.
const pendingTimers = new Map();
function scheduleOwnerAlert(conv) {
  if (!conv || !conv.owner_alert_due_at || pendingTimers.has(conv.id)) return;
  const delay = Math.max(0, new Date(conv.owner_alert_due_at).getTime() - Date.now());
  const timer = setTimeout(() => {
    pendingTimers.delete(conv.id);
    deliverOwnerAlert(conv.id).catch(() => {});
  }, delay);
  if (typeof timer.unref === 'function') timer.unref();
  pendingTimers.set(conv.id, timer);
}

// Hourly backstop: deliver every alert that is due and still pending.
async function sweepOwnerAlerts({ now } = {}) {
  const t = iso(now);
  let delivered = 0;
  let checked = 0;
  try {
    const { data, error } = await supabaseAdmin
      .from('generator_sms_conversations')
      .select('id')
      .not('owner_alert_due_at', 'is', null)
      .lte('owner_alert_due_at', t);
    if (error) throw error;
    for (const row of data || []) {
      checked += 1;
      const r = await deliverOwnerAlert(row.id, now);
      if (r && r.sent) delivered += 1;
    }
  } catch (e) {
    console.error('[sms-conv] owner alert sweep failed:', e && e.message);
  }
  return { checked, delivered };
}

// ----------------------------------------------------------------------------
// Digest: conversations a person still needs to answer (2+ hours).
// ----------------------------------------------------------------------------
async function listNeedingReplyForDigest({ now } = {}) {
  const cutoff = new Date((now ? new Date(now).getTime() : Date.now()) - NEEDS_REPLY_DIGEST_AGE_MS).toISOString();
  const { data, error } = await supabaseAdmin
    .from('generator_sms_conversations')
    .select('id, phone, mode, needs_reply_since, last_inbound_at, customer:generator_customers(name), owner:profiles!owner_profile_id(full_name, email)')
    .not('needs_reply_since', 'is', null)
    .lte('needs_reply_since', cutoff)
    .order('needs_reply_since', { ascending: true });
  if (error) throw error;
  return data || [];
}

module.exports = {
  IDLE_MS,
  OWNER_ALERT_DELAY_MS,
  NEEDS_REPLY_DIGEST_AGE_MS,
  TEXTS_TAB_URL,
  CONV_SELECT,
  findConversation,
  findConversationById,
  ensureConversation,
  idleDeadline,
  idleExpired,
  resolveMode,
  isOfficeMode,
  takeOver,
  handBack,
  recordInbound,
  recordOfficeSend,
  recordOutbound,
  markHandled,
  markRead,
  deliverOwnerAlert,
  scheduleOwnerAlert,
  sweepOwnerAlerts,
  listNeedingReplyForDigest,
};
