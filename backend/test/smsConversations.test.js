// Office texting inbox (sql/037) — lib/smsConversations.js, offline through
// the real shipped code against an in-memory Supabase stand-in:
//   - takeover by button, takeover from another member (both recorded),
//     taking over your own conversation is a no-op
//   - hand back writes the audit row and sends nothing
//   - IDLE TIMEOUT: an office row with no office text for 2h flips back to
//     auto on the next read, audit reason idle_timeout, and nothing is sent;
//     the clock is measured from the later of takeover / last office message
//   - recordInbound sets Needs reply only for human-answer intents and arms
//     the deferred owner alert only in office mode
//   - deliverOwnerAlert emails ONLY the owner, and only while unanswered
require('./helpers/env');

const test = require('node:test');
const assert = require('node:assert/strict');

const mailer = require('../lib/mailer');
const emails = [];
mailer.sendViaBrevo = async (args) => { emails.push(args); return { sent: true, messageId: 'm' }; };

const { installMockSupabase } = require('./helpers/mockSupabase');
const { memTable } = require('./helpers/memTable');
const conv = require('../lib/smsConversations');

const CUSTOMER_ID = 'c0000000-0000-4000-8000-000000000001';
const PHONE = '+16365550100';
const AMY = 'a0000000-0000-4000-8000-0000000000a1';
const BRENDA = 'a0000000-0000-4000-8000-0000000000b2';

let restore;
let realFetch;
let world;
test.beforeEach(() => {
  emails.length = 0;
  realFetch = global.fetch;
  global.fetch = async (url) => { throw new Error('unexpected fetch (nothing may be texted here): ' + url); };
  world = {
    convs: memTable([]),
    events: memTable([]),
    reads: memTable([]),
    messages: memTable([]),
    profiles: memTable([
      { id: AMY, full_name: 'Amy Pyatt', email: 'amy@example.com' },
      { id: BRENDA, full_name: 'Brenda', email: 'brenda@example.com' },
    ]),
    customers: memTable([{ id: CUSTOMER_ID, name: 'Jay King', phone: PHONE }]),
  };
  restore = installMockSupabase({
    generator_sms_conversations: world.convs.resolver,
    generator_sms_conversation_events: world.events.resolver,
    generator_sms_conversation_reads: world.reads.resolver,
    generator_sms_messages: world.messages.resolver,
    profiles: world.profiles.resolver,
    generator_customers: world.customers.resolver,
    generator_email_messages: () => ({ data: null, error: null }),
  });
});
test.afterEach(() => {
  if (restore) { restore(); restore = undefined; }
  if (realFetch) { global.fetch = realFetch; realFetch = undefined; }
});

const hoursAgo = (h, from) => new Date((from || Date.now()) - h * 3600 * 1000).toISOString();

test('ensureConversation: creates one auto row per (customer, phone), then reuses it', async () => {
  const a = await conv.ensureConversation({ customerId: CUSTOMER_ID, phone: PHONE });
  const b = await conv.ensureConversation({ customerId: CUSTOMER_ID, phone: PHONE });
  assert.equal(a.id, b.id);
  assert.equal(a.mode, 'auto');
  assert.equal(world.convs.rows.length, 1);
});

test('takeOver: button → office + manual event; same owner again is a no-op; another member takes over and both are recorded', async () => {
  let c = await conv.ensureConversation({ customerId: CUSTOMER_ID, phone: PHONE });
  c = await conv.takeOver({ conv: c, profileId: AMY, reason: 'manual' });
  assert.equal(c.mode, 'office');
  assert.equal(c.owner_profile_id, AMY);
  assert.ok(c.taken_over_at);
  assert.equal(world.events.rows.length, 1);
  assert.deepEqual(
    [world.events.rows[0].from_mode, world.events.rows[0].to_mode, world.events.rows[0].reason, world.events.rows[0].actor_profile_id, world.events.rows[0].new_owner_profile_id],
    ['auto', 'office', 'manual', AMY, AMY]
  );

  const again = await conv.takeOver({ conv: c, profileId: AMY, reason: 'manual' });
  assert.equal(again.owner_profile_id, AMY);
  assert.equal(world.events.rows.length, 1, 'no event for re-taking your own conversation');

  const b = await conv.takeOver({ conv: again, profileId: BRENDA, reason: 'sent_message' });
  assert.equal(b.owner_profile_id, BRENDA);
  assert.equal(world.events.rows.length, 2);
  const ev = world.events.rows[1];
  assert.equal(ev.from_mode, 'office');
  assert.equal(ev.previous_owner_profile_id, AMY);
  assert.equal(ev.new_owner_profile_id, BRENDA);
  assert.equal(ev.reason, 'sent_message');
  assert.match(ev.note, /another member/);
});

test('handBack: returns to auto with a manual audit row, owner cleared, nothing texted', async () => {
  let c = await conv.ensureConversation({ customerId: CUSTOMER_ID, phone: PHONE });
  c = await conv.takeOver({ conv: c, profileId: AMY, reason: 'manual' });
  c = await conv.handBack({ conv: c, profileId: AMY });
  assert.equal(c.mode, 'auto');
  assert.equal(c.owner_profile_id, null);
  const ev = world.events.rows[world.events.rows.length - 1];
  assert.deepEqual([ev.from_mode, ev.to_mode, ev.reason, ev.actor_profile_id, ev.previous_owner_profile_id], ['office', 'auto', 'manual', AMY, AMY]);
  assert.equal(world.messages.rows.length, 0, 'no message of any kind');
});

test('idle timeout: an office row with no office text for 2h+ returns to auto on the next read, audited, without sending anything', async () => {
  world.convs.rows.push({ id: 'conv-1', customer_id: CUSTOMER_ID, phone: PHONE, mode: 'office', owner_profile_id: AMY, taken_over_at: hoursAgo(3), last_office_message_at: null, created_at: hoursAgo(3), updated_at: hoursAgo(3) });
  assert.equal(await conv.isOfficeMode({ customerId: CUSTOMER_ID, phone: PHONE }), false);
  const row = world.convs.rows[0];
  assert.equal(row.mode, 'auto');
  assert.equal(row.owner_profile_id, null);
  assert.equal(world.events.rows.length, 1);
  assert.equal(world.events.rows[0].reason, 'idle_timeout');
  assert.equal(world.events.rows[0].actor_profile_id, null, 'the system, not a person');
  assert.equal(world.events.rows[0].previous_owner_profile_id, AMY);
  assert.equal(world.messages.rows.length, 0);
});

test('idle clock runs from the LATER of takeover and last office message', async () => {
  world.convs.rows.push({ id: 'conv-2', customer_id: CUSTOMER_ID, phone: PHONE, mode: 'office', owner_profile_id: AMY, taken_over_at: hoursAgo(5), last_office_message_at: hoursAgo(0.5), created_at: hoursAgo(5), updated_at: hoursAgo(0.5) });
  assert.equal(await conv.isOfficeMode({ customerId: CUSTOMER_ID, phone: PHONE }), true);
  assert.equal(world.convs.rows[0].mode, 'office');
  assert.equal(world.events.rows.length, 0);
  const deadline = conv.idleDeadline(world.convs.rows[0]);
  const expected = new Date(world.convs.rows[0].last_office_message_at).getTime() + conv.IDLE_MS;
  assert.equal(deadline.getTime(), expected);
});

test('isOfficeMode fails OPEN (auto) when conversation state cannot be read', async () => {
  restore();
  restore = installMockSupabase({
    generator_sms_conversations: () => ({ data: null, error: { message: 'relation does not exist' } }),
  });
  assert.equal(await conv.isOfficeMode({ customerId: CUSTOMER_ID, phone: PHONE }), false);
});

test('recordInbound: Needs reply only when a person must answer; owner alert armed only in office mode', async () => {
  let c = await conv.ensureConversation({ customerId: CUSTOMER_ID, phone: PHONE });
  c = await conv.recordInbound({ conv: c, needsReply: false });
  assert.ok(c.last_inbound_at);
  assert.equal(c.needs_reply_since, undefined === c.needs_reply_since ? undefined : null);
  assert.ok(!c.needs_reply_since, 'a Y does not need a reply');
  assert.ok(!c.owner_alert_due_at, 'auto mode: no owner to alert');

  c = await conv.recordInbound({ conv: c, needsReply: true });
  assert.ok(c.needs_reply_since, 'free text needs a reply');
  const first = c.needs_reply_since;
  c = await conv.recordInbound({ conv: c, needsReply: true });
  assert.equal(c.needs_reply_since, first, 'the stamp keeps the FIRST unanswered text');

  c = await conv.takeOver({ conv: c, profileId: AMY, reason: 'manual' });
  c = await conv.recordInbound({ conv: c, needsReply: true });
  assert.ok(c.owner_alert_due_at, 'office mode arms the deferred owner alert');
  const due = new Date(c.owner_alert_due_at).getTime() - new Date(c.last_inbound_at).getTime();
  assert.equal(due, conv.OWNER_ALERT_DELAY_MS);
});

test('recordOfficeSend: restarts the idle clock, clears Needs reply and any pending owner alert', async () => {
  let c = await conv.ensureConversation({ customerId: CUSTOMER_ID, phone: PHONE });
  c = await conv.takeOver({ conv: c, profileId: AMY, reason: 'manual' });
  c = await conv.recordInbound({ conv: c, needsReply: true });
  c = await conv.recordOfficeSend({ conv: c });
  assert.ok(c.last_office_message_at);
  assert.equal(c.needs_reply_since, null);
  assert.equal(c.owner_alert_due_at, null);
});

test('deliverOwnerAlert: emails only the owner while the text is unanswered; nothing once the owner replied', async () => {
  const past = hoursAgo(0.5);
  world.convs.rows.push({
    id: 'conv-3', customer_id: CUSTOMER_ID, phone: PHONE, mode: 'office', owner_profile_id: AMY,
    taken_over_at: past, last_office_message_at: null, last_inbound_at: past, needs_reply_since: past,
    owner_alert_due_at: hoursAgo(0.1), owner_alerted_at: null, created_at: past, updated_at: past,
  });
  world.messages.rows.push({ id: 'm1', direction: 'in', from_phone: PHONE, to_phone: '+18339425468', customer_id: CUSTOMER_ID, body: 'Is the tech still coming?', status: 'received', created_at: past });

  const r = await conv.deliverOwnerAlert('conv-3');
  assert.equal(r.sent, true);
  assert.equal(emails.length, 1);
  assert.deepEqual(emails[0].to, ['amy@example.com'], 'owner ONLY - not the office list');
  assert.match(emails[0].subject, /Text waiting on you - Jay King/);
  assert.match(emails[0].text, /Is the tech still coming\?/);
  assert.equal(world.convs.rows[0].owner_alert_due_at, null);
  assert.ok(world.convs.rows[0].owner_alerted_at);

  // Second inbound, but Amy answered in between -> no email, mark cleared.
  Object.assign(world.convs.rows[0], { owner_alert_due_at: hoursAgo(0.05), last_inbound_at: hoursAgo(0.2), last_office_message_at: hoursAgo(0.1) });
  const r2 = await conv.deliverOwnerAlert('conv-3');
  assert.equal(r2.sent, false);
  assert.equal(r2.reason, 'owner replied');
  assert.equal(emails.length, 1);
  assert.equal(world.convs.rows[0].owner_alert_due_at, null);
});

test('sweepOwnerAlerts: delivers only alerts that are due', async () => {
  const past = hoursAgo(1);
  world.convs.rows.push(
    { id: 'due', customer_id: CUSTOMER_ID, phone: PHONE, mode: 'office', owner_profile_id: AMY, taken_over_at: past, last_inbound_at: past, owner_alert_due_at: hoursAgo(0.2), created_at: past, updated_at: past },
    { id: 'later', customer_id: CUSTOMER_ID, phone: '+16365550199', mode: 'office', owner_profile_id: BRENDA, taken_over_at: past, last_inbound_at: past, owner_alert_due_at: new Date(Date.now() + 5 * 60000).toISOString(), created_at: past, updated_at: past },
  );
  const r = await conv.sweepOwnerAlerts({});
  assert.deepEqual(r, { checked: 1, delivered: 1 });
  assert.equal(emails.length, 1);
  assert.deepEqual(emails[0].to, ['amy@example.com']);
});
