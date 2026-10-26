// backend/routes/generator-care/texts.js
// The office Texts inbox (Phase 1, sql/037): every Generator Care customer
// who has exchanged a text, one conversation per (customer, phone), with
// takeover / hand-back and a composer. Office-gated structurally by
// index.js (requireAuth + requireRole('office')); every mutating route here
// additionally requires the `texting` permission, and the frontend hides the
// tab when that flag is off (UI convenience - these checks are the gate).
//
// Scope is Generator Care customers ONLY: conversations exist only for
// customer_id-matched traffic. The service team's texts on the shared
// SimpleTexting number (unmatched rows, customer_id null) never appear here.
//
// Reads apply the idle timeout lazily (lib/smsConversations.js resolveMode),
// so a stale office-mode row is corrected the moment anyone looks at it.
//
// Routes:
//   GET  /texts/conversations              list (all; the UI filters/searches)
//   GET  /texts/unread-count               badge: unread + needs-reply counts
//   GET  /texts/conversations/:id          thread + header facts + audit
//   POST /texts/conversations/:id/read     my read receipt
//   POST /texts/conversations/:id/take-over
//   POST /texts/conversations/:id/hand-back
//   POST /texts/conversations/:id/send     { body }  (also takes over)
//   POST /texts/conversations/:id/mark-handled

const express = require('express');
const { supabaseAdmin } = require('../../lib/supabase');
const { requirePermission } = require('../../middleware/permissions');
const { makeSensitiveLimiter } = require('../../middleware/limiters');
const {
  operatorReplyEligibility, withinQuietHours, OPERATOR_REPLY_WINDOW_DAYS, smsEnabled,
} = require('../../lib/sms');
const {
  CONV_SELECT, IDLE_MS, findConversationById, resolveMode, takeOver, handBack, markHandled, markRead, idleDeadline,
} = require('../../lib/smsConversations');
const { sendOperatorText } = require('../../lib/officeTexting');
const { arrivalWindowLabel } = require('../../lib/generator-catalog');
const cron = require('../generator-care-cron');

const router = express.Router();
const sensitiveLimiter = makeSensitiveLimiter();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PREVIEW_SCAN_LIMIT = 1500; // newest message rows scanned for list previews

const OWNER_EMBED = 'owner:profiles!generator_sms_conversations_owner_profile_id_fkey(id, full_name, email)';
const CUSTOMER_EMBED = 'customer:generator_customers(id, name, phone, install_state)';

// Public shape of a conversation row for the UI. `unread` is per viewer.
function serializeConversation(conv, { readAt, viewerId } = {}) {
  const lastIn = conv.last_inbound_at ? new Date(conv.last_inbound_at).getTime() : null;
  const unread = !!(lastIn && (!readAt || new Date(readAt).getTime() < lastIn));
  const deadline = idleDeadline(conv);
  return {
    id: conv.id,
    customer_id: conv.customer_id,
    phone: conv.phone,
    mode: conv.mode,
    owner: conv.owner ? { id: conv.owner.id, name: conv.owner.full_name || null, email: conv.owner.email || null } : (conv.owner_profile_id ? { id: conv.owner_profile_id, name: null, email: null } : null),
    owned_by_me: !!(viewerId && conv.owner_profile_id === viewerId),
    taken_over_at: conv.taken_over_at,
    last_office_message_at: conv.last_office_message_at,
    last_inbound_at: conv.last_inbound_at,
    last_outbound_at: conv.last_outbound_at,
    last_activity_at: [conv.last_inbound_at, conv.last_outbound_at].filter(Boolean).sort().pop() || conv.created_at,
    needs_reply_since: conv.needs_reply_since,
    idle_returns_at: deadline ? deadline.toISOString() : null,
    unread,
    customer: conv.customer ? { id: conv.customer.id, name: conv.customer.name, phone: conv.customer.phone, install_state: conv.customer.install_state } : null,
  };
}

async function loadConversationFull(id) {
  const { data, error } = await supabaseAdmin
    .from('generator_sms_conversations')
    .select(CONV_SELECT + ', ' + CUSTOMER_EMBED + ', ' + OWNER_EMBED)
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function myReadMap(profileId, conversationIds) {
  if (!conversationIds.length) return {};
  const { data, error } = await supabaseAdmin
    .from('generator_sms_conversation_reads')
    .select('conversation_id, last_read_at')
    .eq('profile_id', profileId)
    .in('conversation_id', conversationIds);
  if (error) throw error;
  const map = {};
  for (const r of data || []) map[r.conversation_id] = r.last_read_at;
  return map;
}

// Subscription id per customer (the modal opens by subscription). Prefer an
// active one; any one is better than none.
async function subscriptionIdsByCustomer(customerIds) {
  if (!customerIds.length) return {};
  const { data, error } = await supabaseAdmin
    .from('generator_subscriptions')
    .select('id, customer_id, status, created_at')
    .in('customer_id', customerIds)
    .order('created_at', { ascending: false });
  if (error) throw error;
  const map = {};
  for (const s of data || []) {
    const cur = map[s.customer_id];
    if (!cur || (cur.status !== 'active' && s.status === 'active')) map[s.customer_id] = s;
  }
  const out = {};
  for (const k of Object.keys(map)) out[k] = map[k].id;
  return out;
}

// Newest message per (customer, phone) for the list preview. One bounded
// scan of recent rows, reduced in memory - volume is tiny and PostgREST has
// no DISTINCT ON.
async function previewsFor(conversations) {
  const customerIds = [...new Set(conversations.map((c) => c.customer_id))];
  if (!customerIds.length) return {};
  const { data, error } = await supabaseAdmin
    .from('generator_sms_messages')
    .select('customer_id, direction, to_phone, from_phone, body, status, created_at, sent_by_profile_id')
    .in('customer_id', customerIds)
    .order('created_at', { ascending: false })
    .limit(PREVIEW_SCAN_LIMIT);
  if (error) throw error;
  const out = {};
  for (const m of data || []) {
    const phone = m.direction === 'in' ? m.from_phone : m.to_phone;
    const key = m.customer_id + '|' + phone;
    if (!out[key]) out[key] = { direction: m.direction, body: String(m.body || '').slice(0, 140), status: m.status, created_at: m.created_at, by_staff: !!m.sent_by_profile_id };
  }
  return out;
}

// Apply the idle timeout to every office row in a list (lazy enforcement).
async function resolveAll(rows, now) {
  const out = [];
  for (const r of rows) {
    if (r.mode !== 'office') { out.push(r); continue; }
    try {
      const resolved = await resolveMode(r, now);
      out.push(resolved.mode === r.mode ? r : { ...r, ...resolved, owner: null });
    } catch (e) {
      console.error('[texts] mode resolve failed for ' + r.id + ':', e && e.message);
      out.push(r);
    }
  }
  return out;
}

// GET /texts/conversations
router.get('/texts/conversations', async (req, res) => {
  try {
    const now = new Date();
    const { data, error } = await supabaseAdmin
      .from('generator_sms_conversations')
      .select(CONV_SELECT + ', ' + CUSTOMER_EMBED + ', ' + OWNER_EMBED)
      .order('last_inbound_at', { ascending: false, nullsFirst: false })
      .limit(500);
    if (error) throw error;
    const rows = await resolveAll(data || [], now);
    const [reads, subIds, previews] = await Promise.all([
      myReadMap(req.profile.id, rows.map((r) => r.id)),
      subscriptionIdsByCustomer([...new Set(rows.map((r) => r.customer_id))]),
      previewsFor(rows),
    ]);
    const conversations = rows.map((r) => ({
      ...serializeConversation(r, { readAt: reads[r.id], viewerId: req.profile.id }),
      subscription_id: subIds[r.customer_id] || null,
      preview: previews[r.customer_id + '|' + r.phone] || null,
    }));
    conversations.sort((a, b) => String(b.last_activity_at).localeCompare(String(a.last_activity_at)));
    res.json({
      conversations,
      me: req.profile.id,
      idle_minutes: Math.round(IDLE_MS / 60000),
      sms_enabled: smsEnabled(),
    });
  } catch (err) {
    console.error('[texts] list error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /texts/unread-count - the tab badge, polled from anywhere in GC.
router.get('/texts/unread-count', async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('generator_sms_conversations')
      .select('id, last_inbound_at, needs_reply_since')
      .not('last_inbound_at', 'is', null)
      .limit(500);
    if (error) throw error;
    const rows = data || [];
    const reads = await myReadMap(req.profile.id, rows.map((r) => r.id));
    let unread = 0;
    let needsReply = 0;
    for (const r of rows) {
      const readAt = reads[r.id];
      if (!readAt || new Date(readAt).getTime() < new Date(r.last_inbound_at).getTime()) unread += 1;
      if (r.needs_reply_since) needsReply += 1;
    }
    res.json({ unread, needs_reply: needsReply });
  } catch (err) {
    console.error('[texts] unread-count error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// The customer's next scheduled visit, for the thread header.
async function nextVisitFor(customerId, now) {
  const { data: subs, error: subErr } = await supabaseAdmin
    .from('generator_subscriptions').select('id').eq('customer_id', customerId);
  if (subErr) throw subErr;
  const subIds = (subs || []).map((s) => s.id);
  if (!subIds.length) return null;
  const { data: visits, error: vErr } = await supabaseAdmin
    .from('generator_service_visits')
    .select('id, appointment_at, arrival_window, status, technician_id, sms_confirmed_at')
    .in('subscription_id', subIds)
    .eq('status', 'scheduled')
    .not('appointment_at', 'is', null)
    .gte('appointment_at', new Date(now.getTime() - 12 * 3600 * 1000).toISOString())
    .order('appointment_at', { ascending: true })
    .limit(1);
  if (vErr) throw vErr;
  const v = visits && visits[0];
  if (!v) return null;
  let tech = null;
  if (v.technician_id) {
    const { data: t } = await supabaseAdmin.from('profiles').select('full_name, email').eq('id', v.technician_id).maybeSingle();
    tech = (t && (t.full_name || t.email)) || null;
  }
  return {
    id: v.id,
    appointment_at: v.appointment_at,
    arrival_window: v.arrival_window,
    arrival_window_label: arrivalWindowLabel(v.arrival_window),
    tech,
    sms_confirmed_at: v.sms_confirmed_at,
  };
}

// GET /texts/conversations/:id
router.get('/texts/conversations/:id', async (req, res) => {
  try {
    if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'conversation not found' });
    const now = new Date();
    let conv = await loadConversationFull(req.params.id);
    if (!conv) return res.status(404).json({ error: 'conversation not found' });
    const resolved = await resolveMode(conv, now);
    if (resolved.mode !== conv.mode) conv = { ...conv, ...resolved, owner: null };

    const [{ data: messages, error: msgErr }, { data: events, error: evErr }, reads, subIds, nextVisit, eligibility] = await Promise.all([
      supabaseAdmin
        .from('generator_sms_messages')
        .select('id, created_at, direction, status, detail, body, related_visit_id, provider_id, sent_by_profile_id, sent_by:profiles!generator_sms_messages_sent_by_profile_id_fkey(full_name, email)')
        .eq('customer_id', conv.customer_id)
        .or('to_phone.eq.' + conv.phone + ',from_phone.eq.' + conv.phone)
        .order('created_at', { ascending: false })
        .limit(200),
      supabaseAdmin
        .from('generator_sms_conversation_events')
        .select('id, created_at, from_mode, to_mode, reason, note, actor:profiles!generator_sms_conversation_events_actor_profile_id_fkey(full_name, email), previous_owner:profiles!generator_sms_conversation_events_previous_owner_profile_id_fkey(full_name, email), new_owner:profiles!generator_sms_conversation_events_new_owner_profile_id_fkey(full_name, email)')
        .eq('conversation_id', conv.id)
        .order('created_at', { ascending: false })
        .limit(50),
      myReadMap(req.profile.id, [conv.id]),
      subscriptionIdsByCustomer([conv.customer_id]),
      nextVisitFor(conv.customer_id, now).catch((e) => { console.error('[texts] next-visit lookup failed:', e && e.message); return null; }),
      operatorReplyEligibility({ phone: conv.phone, customerId: conv.customer_id, now }),
    ]);
    if (msgErr) throw msgErr;
    if (evErr) throw evErr;

    res.json({
      conversation: { ...serializeConversation(conv, { readAt: reads[conv.id], viewerId: req.profile.id }), subscription_id: subIds[conv.customer_id] || null },
      messages: (messages || []).slice().reverse(), // oldest first for the thread
      events: (events || []).map((e) => ({
        id: e.id,
        created_at: e.created_at,
        from_mode: e.from_mode,
        to_mode: e.to_mode,
        reason: e.reason,
        note: e.note,
        actor: e.actor ? (e.actor.full_name || e.actor.email) : null,
        previous_owner: e.previous_owner ? (e.previous_owner.full_name || e.previous_owner.email) : null,
        new_owner: e.new_owner ? (e.new_owner.full_name || e.new_owner.email) : null,
      })),
      next_visit: nextVisit,
      reply: { ...eligibility, quiet_hours_now: !withinQuietHours(now), window_days: OPERATOR_REPLY_WINDOW_DAYS },
      me: req.profile.id,
      idle_minutes: Math.round(IDLE_MS / 60000),
    });
  } catch (err) {
    console.error('[texts] thread error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Shared: load + 404 for the mutating routes.
async function loadOr404(req, res) {
  if (!UUID_RE.test(req.params.id)) { res.status(404).json({ error: 'conversation not found' }); return null; }
  const conv = await findConversationById(req.params.id);
  if (!conv) { res.status(404).json({ error: 'conversation not found' }); return null; }
  return conv;
}

async function respondWithConversation(res, id, profileId, extra) {
  const full = await loadConversationFull(id);
  const reads = await myReadMap(profileId, [id]);
  res.json({ ok: true, conversation: full ? serializeConversation(full, { readAt: reads[id], viewerId: profileId }) : null, ...(extra || {}) });
}

// POST /texts/conversations/:id/read
router.post('/texts/conversations/:id/read', requirePermission('texting'), async (req, res) => {
  try {
    const conv = await loadOr404(req, res);
    if (!conv) return;
    await markRead({ conversationId: conv.id, profileId: req.profile.id });
    res.json({ ok: true });
  } catch (err) {
    console.error('[texts] read error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /texts/conversations/:id/take-over
router.post('/texts/conversations/:id/take-over', requirePermission('texting'), async (req, res) => {
  try {
    const conv = await loadOr404(req, res);
    if (!conv) return;
    await takeOver({ conv, profileId: req.profile.id, reason: 'manual' });
    await markRead({ conversationId: conv.id, profileId: req.profile.id });
    await respondWithConversation(res, conv.id, req.profile.id);
  } catch (err) {
    console.error('[texts] take-over error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /texts/conversations/:id/hand-back
// Returns the conversation to auto. Sends nothing itself; then runs the
// held-text sweep (fire-and-forget) so a reminder held during office mode
// goes out now if it is still relevant - or is dropped, on record, if not.
// Outside quiet hours / with the kill-switch off the sweep is skipped and
// the hourly cron picks it up.
router.post('/texts/conversations/:id/hand-back', requirePermission('texting'), async (req, res) => {
  try {
    const conv = await loadOr404(req, res);
    if (!conv) return;
    const was = conv.mode;
    await handBack({ conv, profileId: req.profile.id });
    let sweep = 'skipped';
    if (was === 'office' && typeof cron.runHeldSweep === 'function') {
      sweep = 'started';
      cron.runHeldSweep({ now: new Date() }).catch((e) => console.error('[texts] held sweep after hand-back failed:', e && e.message));
    }
    await respondWithConversation(res, conv.id, req.profile.id, { held_sweep: sweep });
  } catch (err) {
    console.error('[texts] hand-back error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /texts/conversations/:id/send { body }
// Composer. The phone is the CONVERSATION's phone (never the request); the
// customer id comes from the row. Takes over automatically (officeTexting).
router.post('/texts/conversations/:id/send', sensitiveLimiter, requirePermission('texting'), async (req, res) => {
  try {
    const conv = await loadOr404(req, res);
    if (!conv) return;
    const { data: customer, error: custErr } = await supabaseAdmin
      .from('generator_customers').select('id, phone').eq('id', conv.customer_id).maybeSingle();
    if (custErr) throw custErr;
    if (!customer) return res.status(404).json({ error: 'customer not found' });
    const r = await sendOperatorText({ customer, profileId: req.profile.id, text: req.body && req.body.body, phoneOverride: conv.phone });
    await markRead({ conversationId: conv.id, profileId: req.profile.id });
    if (!r.ok) {
      const out = { error: r.error };
      if (r.reason) out.reason = r.reason;
      if (r.status) out.status = r.status;
      return res.status(r.httpStatus || 409).json(out);
    }
    await respondWithConversation(res, conv.id, req.profile.id, { status: r.status, basis: r.basis });
  } catch (err) {
    console.error('[texts] send error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /texts/conversations/:id/mark-handled
router.post('/texts/conversations/:id/mark-handled', requirePermission('texting'), async (req, res) => {
  try {
    const conv = await loadOr404(req, res);
    if (!conv) return;
    await markHandled({ conv });
    await markRead({ conversationId: conv.id, profileId: req.profile.id });
    await respondWithConversation(res, conv.id, req.profile.id);
  } catch (err) {
    console.error('[texts] mark-handled error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
module.exports._test = { serializeConversation, previewsFor, nextVisitFor };
