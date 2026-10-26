// Texts inbox routes (routes/generator-care/texts.js, sql/037) — offline
// through the real shipped handlers with an in-memory Supabase stand-in:
//   - every mutating route carries requirePermission('texting'); send also
//     carries the sensitive limiter; a member with texting=false gets 403
//   - take over by button, then a second member takes over (both audited)
//   - sending from the inbox takes the conversation over, sends through the
//     one operator path, stamps the conversation, clears Needs reply
//   - hand back returns to auto and kicks off the held sweep
//   - list: unread is per viewer, an idle office row reads as auto, previews
//     + subscription ids are attached; unread-count matches
//   - digest: the "Texts needing a reply" section + plain-text block
require('./helpers/env');

const test = require('node:test');
const assert = require('node:assert/strict');

const mailer = require('../lib/mailer');
mailer.sendViaBrevo = async () => ({ sent: true, messageId: 'm' });

const { installMockSupabase } = require('./helpers/mockSupabase');
const { memTable } = require('./helpers/memTable');
const { getRouteHandler, makeRes } = require('./helpers/routeHandler');
const { requirePermission } = require('../middleware/permissions');
const cron = require('../routes/generator-care-cron');
const texts = require('../routes/generator-care/texts');

const CUSTOMER_ID = 'c0000000-0000-4000-8000-000000000001';
const CONV_ID = 'e0000000-0000-4000-8000-000000000001';
const CONV2_ID = 'e0000000-0000-4000-8000-000000000002';
const SUB_ID = 'b0000000-0000-4000-8000-000000000010';
const AMY = 'a0000000-0000-4000-8000-0000000000a1';
const BRENDA = 'a0000000-0000-4000-8000-0000000000b2';
const PHONE = '+16365550100';
const PHONE2 = '+16365550199';

const h = (m, p) => getRouteHandler(texts, m, p);
const listHandler = h('get', '/texts/conversations');
const countHandler = h('get', '/texts/unread-count');
const threadHandler = h('get', '/texts/conversations/:id');
const takeOverHandler = h('post', '/texts/conversations/:id/take-over');
const handBackHandler = h('post', '/texts/conversations/:id/hand-back');
const sendHandler = h('post', '/texts/conversations/:id/send');
const handledHandler = h('post', '/texts/conversations/:id/mark-handled');
const ensureHandler = h('post', '/texts/conversations/ensure');

const hoursAgo = (hrs) => new Date(Date.now() - hrs * 3600 * 1000).toISOString();
const profile = (id) => ({ id, role: 'office', is_admin: false });

let restore;
let realFetch;
let smsCalls;
let world;
function setup() {
  process.env.SMS_ENABLED = 'true';
  process.env.SIMPLETEXTING_API_TOKEN = 'tok_secret';
  process.env.SIMPLETEXTING_ACCOUNT_PHONE = '8339425468';
  smsCalls = [];
  realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    if (/simpletexting/.test(String(url))) {
      smsCalls.push(JSON.parse(opts.body));
      return { ok: true, status: 201, json: async () => ({ id: 'prov_' + smsCalls.length }) };
    }
    throw new Error('unexpected fetch in offline test: ' + url);
  };
  const customer = { id: CUSTOMER_ID, name: 'Jay King', phone: PHONE, install_state: 'MO', sms_invalid_at: null, sms_invalid_phone: null };
  world = {
    convs: memTable([
      { id: CONV_ID, customer_id: CUSTOMER_ID, phone: PHONE, mode: 'auto', owner_profile_id: null, taken_over_at: null, last_office_message_at: null, last_inbound_at: hoursAgo(1), last_outbound_at: hoursAgo(2), needs_reply_since: hoursAgo(1), owner_alert_due_at: null, created_at: hoursAgo(3), updated_at: hoursAgo(1), customer, owner: null },
      // Office row whose idle window has long passed - must read as auto.
      { id: CONV2_ID, customer_id: CUSTOMER_ID, phone: PHONE2, mode: 'office', owner_profile_id: BRENDA, taken_over_at: hoursAgo(5), last_office_message_at: hoursAgo(4), last_inbound_at: hoursAgo(6), last_outbound_at: hoursAgo(4), needs_reply_since: null, owner_alert_due_at: null, created_at: hoursAgo(9), updated_at: hoursAgo(4), customer, owner: { id: BRENDA, full_name: 'Brenda', email: 'brenda@example.com' } },
    ]),
    events: memTable([]),
    reads: memTable([{ conversation_id: CONV2_ID, profile_id: AMY, last_read_at: hoursAgo(0.5) }]),
    messages: memTable([
      { id: 'm1', direction: 'in', from_phone: PHONE, to_phone: '+18339425468', customer_id: CUSTOMER_ID, body: 'Is the tech still coming?', status: 'received', created_at: hoursAgo(1), sent_by_profile_id: null },
      { id: 'm0', direction: 'out', from_phone: '+18339425468', to_phone: PHONE, customer_id: CUSTOMER_ID, body: 'Reminder body', status: 'sent', created_at: hoursAgo(2), sent_by_profile_id: null },
      { id: 'm2', direction: 'out', from_phone: '+18339425468', to_phone: PHONE2, customer_id: CUSTOMER_ID, body: 'Brenda here', status: 'sent', created_at: hoursAgo(4), sent_by_profile_id: BRENDA },
    ]),
    subs: memTable([{ id: SUB_ID, customer_id: CUSTOMER_ID, status: 'active', created_at: hoursAgo(100) }]),
    visits: memTable([]),
    customers: memTable([customer]),
    profiles: memTable([
      { id: AMY, full_name: 'Amy Pyatt', email: 'amy@example.com' },
      { id: BRENDA, full_name: 'Brenda', email: 'brenda@example.com' },
    ]),
  };
  restore = installMockSupabase({
    generator_sms_conversations: world.convs.resolver,
    generator_sms_conversation_events: world.events.resolver,
    generator_sms_conversation_reads: world.reads.resolver,
    generator_sms_messages: world.messages.resolver,
    generator_subscriptions: world.subs.resolver,
    generator_service_visits: world.visits.resolver,
    generator_customers: world.customers.resolver,
    generator_sms_consent: () => ({ data: [{ id: 'cons1', customer_id: CUSTOMER_ID, phone: PHONE, opted_in: true, opted_out: false }], error: null }),
    profiles: world.profiles.resolver,
    generator_email_messages: () => ({ data: null, error: null }),
  });
}
test.beforeEach(setup);
test.afterEach(() => {
  delete process.env.SMS_ENABLED;
  delete process.env.SIMPLETEXTING_API_TOKEN;
  delete process.env.SIMPLETEXTING_ACCOUNT_PHONE;
  if (restore) { restore(); restore = undefined; }
  if (realFetch) { global.fetch = realFetch; realFetch = undefined; }
});

async function call(handler, { id, body, who }) {
  const res = makeRes();
  await handler({ params: { id }, body: body || {}, query: {}, profile: profile(who || AMY) }, res);
  return res;
}

// ---------------------------------------------------------------------------
test('route stack: every mutating texts route requires texting; send also has the sensitive limiter', () => {
  const posts = texts.stack.filter((l) => l.route && l.route.methods.post);
  assert.equal(posts.length, 6);
  for (const l of posts) {
    const expected = l.route.path.endsWith('/send') ? 3 : 2;
    assert.equal(l.route.stack.length, expected, l.route.path);
  }
  const gets = texts.stack.filter((l) => l.route && l.route.methods.get);
  assert.equal(gets.length, 3);
});

test('an office member whose texting flag is off gets 403 from requirePermission', async () => {
  restore();
  restore = installMockSupabase({ member_permissions: () => ({ data: { profile_id: AMY, texting: false }, error: null }) });
  const res = makeRes();
  let nexted = false;
  await requirePermission('texting')({ profile: profile(AMY) }, res, () => { nexted = true; });
  assert.equal(res.statusCode, 403);
  assert.equal(nexted, false);
});

// ---------------------------------------------------------------------------
test('take over by button; a second member takes over from the first; both audited', async () => {
  let res = await call(takeOverHandler, { id: CONV_ID, who: AMY });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.conversation.mode, 'office');
  assert.equal(res.body.conversation.owned_by_me, true);
  assert.ok(res.body.conversation.idle_returns_at, 'idle deadline shown');

  res = await call(takeOverHandler, { id: CONV_ID, who: BRENDA });
  assert.equal(res.body.conversation.owner.id, BRENDA);
  assert.equal(res.body.conversation.owned_by_me, true, 'from Brenda\'s point of view');
  assert.equal(world.events.rows.length, 2);
  assert.equal(world.events.rows[1].previous_owner_profile_id, AMY);
  assert.equal(world.events.rows[1].new_owner_profile_id, BRENDA);
  assert.equal(smsCalls.length, 0, 'taking over texts nobody');
  assert.ok(world.reads.rows.find((r) => r.conversation_id === CONV_ID && r.profile_id === BRENDA), 'read receipt stamped');
});

test('send from the inbox: takes over (audit reason sent_message), sends with sent_by, stamps the conversation, clears Needs reply', async () => {
  const res = await call(sendHandler, { id: CONV_ID, who: AMY, body: { body: 'Hi Jay, Amy here. The tech is 15 minutes out.' } });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.status, 'sent');
  assert.equal(smsCalls.length, 1);
  assert.equal(smsCalls[0].contactPhone, '6365550100');
  const conv = world.convs.rows.find((c) => c.id === CONV_ID);
  assert.equal(conv.mode, 'office');
  assert.equal(conv.owner_profile_id, AMY);
  assert.ok(conv.last_office_message_at);
  assert.equal(conv.needs_reply_since, null, 'answered');
  assert.equal(world.events.rows[0].reason, 'sent_message');
  const sent = world.messages.rows.find((m) => m.status === 'sent' && m.sent_by_profile_id === AMY);
  assert.ok(sent, 'operator row carries sent_by');
  assert.equal(res.body.conversation.unread, false);
});

test('send: empty body 400, too long 400, nothing sent', async () => {
  let res = await call(sendHandler, { id: CONV_ID, body: { body: '   ' } });
  assert.equal(res.statusCode, 400);
  res = await call(sendHandler, { id: CONV_ID, body: { body: 'x'.repeat(1001) } });
  assert.equal(res.statusCode, 400);
  assert.equal(smsCalls.length, 0);
});

test('hand back: returns to auto, audited, and starts the held sweep (which is what may send a held reminder)', async () => {
  await call(takeOverHandler, { id: CONV_ID, who: AMY });
  const realSweep = cron.runHeldSweep;
  const sweeps = [];
  cron.runHeldSweep = async (args) => { sweeps.push(args); return { ok: true }; };
  try {
    const res = await call(handBackHandler, { id: CONV_ID, who: AMY });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.conversation.mode, 'auto');
    assert.equal(res.body.conversation.owner, null);
    assert.equal(res.body.held_sweep, 'started');
    assert.equal(sweeps.length, 1);
  } finally {
    cron.runHeldSweep = realSweep;
  }
  assert.equal(world.events.rows[world.events.rows.length - 1].reason, 'manual');
  assert.equal(smsCalls.length, 0);

  // Handing back an auto conversation is a harmless no-op (no sweep).
  const again = await call(handBackHandler, { id: CONV_ID, who: AMY });
  assert.equal(again.body.held_sweep, 'skipped');
});

test('ensure: returns the existing conversation for a customer, or creates an auto one for a customer who never texted; bad input 400/404/409', async () => {
  let res = await call(ensureHandler, { body: { customer_id: CUSTOMER_ID } });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.conversation.id, CONV_ID, 'existing row for the phone on file');
  assert.equal(res.body.conversation.subscription_id, SUB_ID);
  assert.equal(world.convs.rows.length, 2, 'nothing created');

  const NEW_CUST = 'c0000000-0000-4000-8000-000000000002';
  world.customers.rows.push({ id: NEW_CUST, name: 'Pat New', phone: '(636) 555-0142', install_state: 'MO' });
  res = await call(ensureHandler, { body: { customer_id: NEW_CUST } });
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.conversation.mode, 'auto');
  assert.equal(res.body.conversation.phone, '+16365550142');
  assert.equal(world.convs.rows.length, 3, 'created once');
  assert.equal(smsCalls.length, 0, 'ensure never texts');
  assert.equal(world.events.rows.length, 0, 'ensure never changes mode');

  const NO_PHONE = 'c0000000-0000-4000-8000-000000000003';
  world.customers.rows.push({ id: NO_PHONE, name: 'No Phone', phone: null });
  assert.equal((await call(ensureHandler, { body: { customer_id: NO_PHONE } })).statusCode, 409);
  assert.equal((await call(ensureHandler, { body: { customer_id: 'nope' } })).statusCode, 400);
  assert.equal((await call(ensureHandler, { body: { customer_id: 'c0000000-0000-4000-8000-0000000000ff' } })).statusCode, 404);
});

test('mark handled clears Needs reply without sending', async () => {
  const res = await call(handledHandler, { id: CONV_ID });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.conversation.needs_reply_since, null);
  assert.equal(smsCalls.length, 0);
});

test('unknown / malformed ids 404', async () => {
  assert.equal((await call(takeOverHandler, { id: 'not-a-uuid' })).statusCode, 404);
  assert.equal((await call(threadHandler, { id: 'e0000000-0000-4000-8000-0000000000ff' })).statusCode, 404);
});

// ---------------------------------------------------------------------------
test('list: per-viewer unread, idle office row reads as auto, previews + subscription ids attached, sorted by latest activity', async () => {
  const res = await call(listHandler, { who: AMY });
  assert.equal(res.statusCode, 200);
  const { conversations, me } = res.body;
  assert.equal(me, AMY);
  assert.equal(conversations.length, 2);
  const [first, second] = conversations;
  assert.equal(first.id, CONV_ID, 'most recent activity first');
  assert.equal(first.unread, true, 'Amy never read it');
  assert.ok(first.needs_reply_since);
  assert.equal(first.mode, 'auto');
  assert.equal(first.subscription_id, SUB_ID);
  assert.equal(first.preview.body, 'Is the tech still coming?');
  assert.equal(first.preview.direction, 'in');
  assert.equal(first.customer.name, 'Jay King');

  assert.equal(second.id, CONV2_ID);
  assert.equal(second.mode, 'auto', 'idle timeout applied on read');
  assert.equal(second.owner, null);
  assert.equal(second.unread, false, 'Amy read it after the last inbound');
  assert.equal(second.preview.by_staff, true);
  assert.equal(world.events.rows.filter((e) => e.reason === 'idle_timeout').length, 1);
});

test('unread-count: counts conversations with an inbound newer than my read receipt, plus Needs reply', async () => {
  const res = await call(countHandler, { who: AMY });
  assert.deepEqual(res.body, { unread: 1, needs_reply: 1 });
  const brenda = await call(countHandler, { who: BRENDA });
  assert.deepEqual(brenda.body, { unread: 2, needs_reply: 1 });
});

test('thread: oldest-first messages scoped to the conversation phone, reply eligibility, header facts', async () => {
  const res = await call(threadHandler, { id: CONV_ID, who: AMY });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.messages.map((m) => m.id), ['m0', 'm1'], 'only this phone, oldest first');
  assert.equal(res.body.reply.allowed, true);
  assert.equal(res.body.reply.reason, 'consent');
  assert.equal(res.body.next_visit, null);
  assert.equal(res.body.conversation.subscription_id, SUB_ID);
  assert.equal(typeof res.body.idle_minutes, 'number');
});

// ---------------------------------------------------------------------------
test('digest: "Texts needing a reply" section in HTML and plain text', () => {
  const { buildEmail, textsReplyLine } = cron._test;
  const item = { phone: PHONE, mode: 'office', needs_reply_since: hoursAgo(3), customer: { name: 'Jay King' }, owner: { full_name: 'Amy Pyatt', email: 'amy@example.com' } };
  const { html, text } = buildEmail({ upcoming: [], textsNeedingReply: [item], todayStr: '2026-10-27' });
  assert.match(html, /Texts needing a reply \(1\)/);
  assert.match(html, /Jay King/);
  assert.match(html, /Amy Pyatt has it/);
  assert.match(html, /generator-care#texts/);
  assert.match(text, /TEXTS NEEDING A REPLY \(1\)/);
  assert.match(textsReplyLine({ ...item, mode: 'auto', owner: null }), /automated \(no owner\)/);
  const quiet = buildEmail({ upcoming: [], textsNeedingReply: [], todayStr: '2026-10-27' });
  assert.doesNotMatch(quiet.html, /Texts needing a reply/);
});
