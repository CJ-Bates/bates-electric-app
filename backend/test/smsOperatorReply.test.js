// Two-way SMS: office replies from the customer record — offline unit tests
// through the REAL shipped code:
//   - lib/sms.js operatorReplyEligibility: the consent rules, in order
//       opted_out (absolute) > opted_in > texted-us-recently > blocked
//   - sendSms replyToInbound: the recency check runs INSIDE the transport, so
//     a caller's flag alone can't unlock a send; opted_out still refuses
//   - the sent_by_profile_id audit column is written for operator replies
//     only (automated rows keep their pre-034 shape)
//   - POST /customers/:id/sms-reply (the last handler in the stack — the
//     limiter and requirePermission are asserted structurally below)
//   - GET /subscriptions/:id/sms-messages `reply` block + phone-matched
//     inbound rows
//   - role/permission gates: tech + customer profiles 403 (requireRole),
//     an office member without customer_edit 403s (requirePermission)
require('./helpers/env');

const test = require('node:test');
const assert = require('node:assert/strict');

const { installMockSupabase } = require('./helpers/mockSupabase');
const { getRouteHandler, makeReq, makeRes } = require('./helpers/routeHandler');
const sms = require('../lib/sms');
const { requireRole } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');

const subscriptionsRouter = require('../routes/generator-care/subscriptions');
const replyHandler = getRouteHandler(subscriptionsRouter, 'post', '/customers/:id/sms-reply');
const threadHandler = getRouteHandler(subscriptionsRouter, 'get', '/subscriptions/:id/sms-messages');

const CUSTOMER_ID = 'c0000000-0000-4000-8000-000000000001';
const SUB_ID = 'b0000000-0000-4000-8000-000000000010';
const PROFILE_ID = 'p0000000-0000-4000-8000-000000000099';
const PHONE = '+16365550100';

let restoreSupabase;
let realFetch;
let restoreClock;
test.afterEach(() => {
  if (restoreSupabase) { restoreSupabase(); restoreSupabase = undefined; }
  if (realFetch) { global.fetch = realFetch; realFetch = undefined; }
  if (restoreClock) { restoreClock(); restoreClock = undefined; }
  delete process.env.SMS_ENABLED;
  delete process.env.SIMPLETEXTING_API_TOKEN;
  delete process.env.SIMPLETEXTING_ACCOUNT_PHONE;
});

function forbidFetch() {
  realFetch = global.fetch;
  global.fetch = async (url) => { throw new Error('unexpected fetch in offline test: ' + url); };
}
function armTransport() {
  process.env.SMS_ENABLED = 'true';
  process.env.SIMPLETEXTING_API_TOKEN = 'tok_secret';
  process.env.SIMPLETEXTING_ACCOUNT_PHONE = '8339425468';
  realFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, opts) => {
    calls.push({ url: String(url), body: JSON.parse(opts.body) });
    return { ok: true, status: 201, json: async () => ({ id: 'prov_1' }) };
  };
  return calls;
}

// The route handlers read the wall clock (quiet hours + the reply window);
// pin it so those tests are deterministic. Aug 2026 = CDT = UTC-5.
const SIX_AM_CDT = '2026-08-20T11:00:00Z';
const TWO_PM_CDT = '2026-08-20T19:00:00Z';
function freezeClock(iso) {
  const RealDate = Date;
  const fixed = new RealDate(iso).getTime();
  global.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [fixed])); }
    static now() { return fixed; }
  };
  restoreClock = () => { global.Date = RealDate; };
}

// Mock world. `inbound` = rows the reply-window lookup returns (the query is
// direction='in' + from_phone + created_at >= cutoff); `thread` = what the
// office thread GET returns; every insert lands in `logged`.
function world({ consentRows = [], inbound = [], thread = [], customer } = {}) {
  const w = { logged: [], messageChains: [] };
  restoreSupabase = installMockSupabase({
    generator_customers: () => ({ data: customer === undefined ? { id: CUSTOMER_ID, phone: '636-555-0100' } : customer, error: null }),
    generator_subscriptions: () => ({ data: { customer_id: CUSTOMER_ID, customer: { id: CUSTOMER_ID, phone: '636-555-0100' } }, error: null }),
    generator_sms_consent: () => ({ data: consentRows, error: null }),
    generator_sms_messages: (chain) => {
      w.messageChains.push(chain);
      const ins = chain.find((c) => c.method === 'insert');
      if (ins) { w.logged.push(ins.args[0]); return { data: null, error: null }; }
      const isRecency = chain.some((c) => c.method === 'eq' && c.args[0] === 'direction' && c.args[1] === 'in');
      return { data: isRecency ? inbound : thread, error: null };
    },
  });
  return w;
}

const RECENT = [{ created_at: '2026-08-18T15:00:00Z' }];

// ---------------------------------------------------------------------------
// operatorReplyEligibility — the rules, in priority order
// ---------------------------------------------------------------------------
test('eligibility: opted in -> allowed on consent', async () => {
  world({ consentRows: [{ opted_in: true, opted_out: false }] });
  const e = await sms.operatorReplyEligibility({ phone: '636-555-0100', customerId: CUSTOMER_ID });
  assert.equal(e.allowed, true);
  assert.equal(e.reason, 'consent');
});

test('eligibility: opted out is absolute — even with a text from them yesterday', async () => {
  world({ consentRows: [{ opted_in: true, opted_out: true }], inbound: RECENT });
  const e = await sms.operatorReplyEligibility({ phone: PHONE, customerId: CUSTOMER_ID });
  assert.equal(e.allowed, false);
  assert.equal(e.reason, 'opted_out');
  assert.equal(e.recent_inbound, true, 'the recent text is reported but does not unlock anything');
});

test('eligibility: no consent row but they texted within the window -> allowed on recent_inbound', async () => {
  const w = world({ consentRows: [], inbound: RECENT });
  const now = new Date(TWO_PM_CDT);
  const e = await sms.operatorReplyEligibility({ phone: PHONE, customerId: CUSTOMER_ID, now });
  assert.equal(e.allowed, true);
  assert.equal(e.reason, 'recent_inbound');
  assert.equal(e.last_inbound_at, RECENT[0].created_at);
  // The window is OPERATOR_REPLY_WINDOW_DAYS back from `now`, by phone.
  const chain = w.messageChains.find((c) => c.some((s) => s.method === 'gte'));
  const gte = chain.find((s) => s.method === 'gte');
  assert.equal(gte.args[0], 'created_at');
  assert.equal(gte.args[1], new Date(now.getTime() - sms.OPERATOR_REPLY_WINDOW_DAYS * 86400000).toISOString());
  assert.deepEqual(chain.find((s) => s.method === 'eq' && s.args[0] === 'from_phone').args, ['from_phone', PHONE]);
});

test('eligibility: no consent and nothing recent from them -> blocked with its own reason', async () => {
  world({ consentRows: [], inbound: [] });
  const e = await sms.operatorReplyEligibility({ phone: PHONE, customerId: CUSTOMER_ID });
  assert.equal(e.allowed, false);
  assert.equal(e.reason, 'no_consent_no_recent_inbound');
});

test('eligibility: unusable phone -> invalid_phone, no queries', async () => {
  const w = world();
  const e = await sms.operatorReplyEligibility({ phone: '555-0100', customerId: CUSTOMER_ID });
  assert.equal(e.reason, 'invalid_phone');
  assert.equal(w.messageChains.length, 0);
});

// ---------------------------------------------------------------------------
// sendSms replyToInbound + sentBy — enforcement lives in the transport
// ---------------------------------------------------------------------------
test('sendSms replyToInbound: no opt-in + recent inbound sends, logs the basis and the sender', async () => {
  const w = world({ consentRows: [], inbound: RECENT });
  const calls = armTransport();
  const r = await sms.sendSms({ toPhone: PHONE, body: 'Yes, 10-12 works.', customerId: CUSTOMER_ID, replyToInbound: true, ignoreQuietHours: true, sentBy: PROFILE_ID });
  assert.equal(r.sent, true);
  assert.equal(calls.length, 1);
  const row = w.logged.find((l) => l.status === 'sent');
  assert.equal(row.sent_by_profile_id, PROFILE_ID);
  assert.ok(row.detail.includes('customer-initiated'), row.detail);
  assert.ok(row.detail.includes(RECENT[0].created_at), row.detail);
});

test('sendSms replyToInbound: no opt-in and no recent inbound refuses no_consent, never touches the network', async () => {
  forbidFetch();
  const w = world({ consentRows: [], inbound: [] });
  process.env.SMS_ENABLED = 'true';
  process.env.SIMPLETEXTING_API_TOKEN = 'tok_secret';
  const r = await sms.sendSms({ toPhone: PHONE, body: 'hi', customerId: CUSTOMER_ID, replyToInbound: true, sentBy: PROFILE_ID });
  assert.equal(r.status, 'no_consent');
  assert.equal(w.logged[0].status, 'no_consent');
  assert.ok(w.logged[0].detail.includes(String(sms.OPERATOR_REPLY_WINDOW_DAYS)), w.logged[0].detail);
});

test('sendSms replyToInbound: opted out refuses no matter what (flag + recent inbound + quiet-hours override)', async () => {
  forbidFetch();
  const w = world({ consentRows: [{ opted_in: true, opted_out: true }], inbound: RECENT });
  process.env.SMS_ENABLED = 'true';
  process.env.SIMPLETEXTING_API_TOKEN = 'tok_secret';
  const r = await sms.sendSms({ toPhone: PHONE, body: 'hi', customerId: CUSTOMER_ID, replyToInbound: true, ignoreQuietHours: true, sentBy: PROFILE_ID });
  assert.equal(r.status, 'opted_out');
  assert.equal(w.logged[0].status, 'opted_out');
  assert.equal(w.messageChains.filter((c) => c.some((s) => s.method === 'gte')).length, 0, 'recency never consulted once opted_out');
});

test('sendSms without sentBy (every automated send) writes no sent_by_profile_id key at all', async () => {
  forbidFetch();
  const w = world({ consentRows: [{ opted_in: true, opted_out: false }] });
  await sms.sendSms({ toPhone: PHONE, body: 'reminder', customerId: CUSTOMER_ID }); // kill-switch off -> 'disabled'
  assert.equal(w.logged.length, 1);
  assert.equal(w.logged[0].status, 'disabled');
  assert.ok(!('sent_by_profile_id' in w.logged[0]), 'automated rows keep their pre-034 shape');
  assert.ok(!('replyToInbound' in w.logged[0]));
});

// ---------------------------------------------------------------------------
// POST /customers/:id/sms-reply
// ---------------------------------------------------------------------------
function replyReq(body, profile) {
  const req = makeReq({ params: { id: CUSTOMER_ID }, body: { body } });
  req.profile = profile || { id: PROFILE_ID, role: 'office' };
  return req;
}

test('reply: opted-in customer -> sent, logged with the office user, and the phone came from the record', async () => {
  freezeClock(TWO_PM_CDT);
  const w = world({ consentRows: [{ opted_in: true, opted_out: false }] });
  const calls = armTransport();
  const res = makeRes();
  await replyHandler(replyReq('  Yes, 10-12 works.  '), res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.ok, true);
  assert.equal(res.body.basis, 'consent');
  assert.equal(calls[0].body.contactPhone, '6365550100');
  assert.equal(calls[0].body.text, 'Yes, 10-12 works.');
  const row = w.logged.find((l) => l.status === 'sent');
  assert.equal(row.direction, 'out');
  assert.equal(row.to_phone, PHONE);
  assert.equal(row.customer_id, CUSTOMER_ID);
  assert.equal(row.sent_by_profile_id, PROFILE_ID);
  assert.equal(row.body, 'Yes, 10-12 works.');
});

test('reply: opted-out customer -> 409 opted_out; a forged request sends nothing and logs nothing', async () => {
  forbidFetch();
  freezeClock(TWO_PM_CDT);
  const w = world({ consentRows: [{ opted_in: true, opted_out: true }], inbound: RECENT });
  process.env.SMS_ENABLED = 'true';
  process.env.SIMPLETEXTING_API_TOKEN = 'tok_secret';
  const res = makeRes();
  await replyHandler(replyReq('hello?'), res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.reason, 'opted_out');
  assert.ok(/opted out/i.test(res.body.error), res.body.error);
  assert.equal(w.logged.length, 0);
});

test('reply: not opted in, texted us 2 days ago -> allowed (consumer-initiated), sent even at 6am', async () => {
  freezeClock(SIX_AM_CDT);
  const w = world({ consentRows: [], inbound: RECENT });
  const calls = armTransport();
  const res = makeRes();
  await replyHandler(replyReq('Sure - Tuesday morning works. We will confirm the window by text.'), res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.basis, 'recent_inbound');
  assert.equal(calls.length, 1, 'active conversation: quiet hours do not apply');
  const row = w.logged.find((l) => l.status === 'sent');
  assert.equal(row.sent_by_profile_id, PROFILE_ID);
  assert.ok(row.detail.includes('customer-initiated'), row.detail);
});

test('reply: not opted in, no recent text -> 409 with the DISTINCT reason, nothing sent or logged', async () => {
  forbidFetch();
  freezeClock(TWO_PM_CDT);
  const w = world({ consentRows: [], inbound: [] });
  process.env.SMS_ENABLED = 'true';
  process.env.SIMPLETEXTING_API_TOKEN = 'tok_secret';
  const res = makeRes();
  await replyHandler(replyReq('hello?'), res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.reason, 'no_consent_no_recent_inbound');
  assert.ok(/no text consent/i.test(res.body.error), res.body.error);
  assert.ok(!/opted out/i.test(res.body.error), 'must not be confused with an opt-out');
  assert.equal(w.logged.length, 0);
});

test('reply: opted in but no recent text is a COLD send — refused by quiet hours at 6am and logged as such', async () => {
  forbidFetch();
  freezeClock(SIX_AM_CDT);
  const w = world({ consentRows: [{ opted_in: true, opted_out: false }], inbound: [] });
  process.env.SMS_ENABLED = 'true';
  process.env.SIMPLETEXTING_API_TOKEN = 'tok_secret';
  process.env.SIMPLETEXTING_ACCOUNT_PHONE = '8339425468';
  const res = makeRes();
  await replyHandler(replyReq('Reminder: we are coming Tuesday.'), res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.status, 'quiet_hours');
  assert.equal(w.logged.length, 1);
  assert.equal(w.logged[0].status, 'quiet_hours');
  assert.equal(w.logged[0].sent_by_profile_id, PROFILE_ID, 'refused operator attempts are audited too');
});

test('reply: opted in + recent text at 6am sends (inside an active conversation)', async () => {
  freezeClock(SIX_AM_CDT);
  world({ consentRows: [{ opted_in: true, opted_out: false }], inbound: RECENT });
  const calls = armTransport();
  const res = makeRes();
  await replyHandler(replyReq('Yes, see you at 10.'), res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(calls.length, 1);
});

test('reply: kill-switch off -> 409 disabled, the would-be message is logged', async () => {
  forbidFetch();
  freezeClock(TWO_PM_CDT);
  const w = world({ consentRows: [{ opted_in: true, opted_out: false }] });
  const res = makeRes();
  await replyHandler(replyReq('hello'), res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.status, 'disabled');
  assert.equal(w.logged[0].status, 'disabled');
  assert.equal(w.logged[0].body, 'hello');
});

test('reply: empty / oversize body -> 400 before any lookup; unknown customer -> 404', async () => {
  forbidFetch();
  const w = world();
  let res = makeRes();
  await replyHandler(replyReq('   '), res);
  assert.equal(res.statusCode, 400);
  res = makeRes();
  await replyHandler(replyReq('x'.repeat(1001)), res);
  assert.equal(res.statusCode, 400);
  assert.equal(w.messageChains.length, 0);

  restoreSupabase(); restoreSupabase = undefined;
  world({ customer: null });
  res = makeRes();
  await replyHandler(replyReq('hello'), res);
  assert.equal(res.statusCode, 404);
});

test('reply: no usable phone on the record -> 409 invalid_phone', async () => {
  forbidFetch();
  world({ customer: { id: CUSTOMER_ID, phone: '' } });
  const res = makeRes();
  await replyHandler(replyReq('hello'), res);
  assert.equal(res.statusCode, 409);
  assert.equal(res.body.reason, 'invalid_phone');
});

// ---------------------------------------------------------------------------
// Gates: role (index.js requireRole('office')), permission, limiter
// ---------------------------------------------------------------------------
test('route stack: sensitive limiter + requirePermission(customer_edit) sit in front of the handler', () => {
  const layer = subscriptionsRouter.stack.find((l) => l.route && l.route.path === '/customers/:id/sms-reply' && l.route.methods.post);
  assert.ok(layer, 'route exists');
  assert.equal(layer.route.stack.length, 3, 'limiter, permission check, handler');
  // Same limiter INSTANCE as the file's other money/email routes (the
  // sensitiveLimiter const) — not the loose general limiter, not a new one.
  const resend = subscriptionsRouter.stack.find((l) => l.route && l.route.path === '/subscriptions/:id/resend-receipt' && l.route.methods.post);
  assert.equal(layer.route.stack[0].handle, resend.route.stack[0].handle, 'shares sensitiveLimiter with resend-receipt');
});

test('a tech token and a customer token both 403 at the office role gate', () => {
  const gate = requireRole('office');
  for (const role of ['tech', 'customer']) {
    const res = makeRes();
    let nexted = false;
    gate({ profile: { id: 'x', role } }, res, () => { nexted = true; });
    assert.equal(res.statusCode, 403, role);
    assert.equal(nexted, false, role);
  }
  const res = makeRes();
  gate({}, res, () => {});
  assert.equal(res.statusCode, 403, 'no profile at all');
});

test('an office member whose customer_edit flag is off gets 403 from requirePermission', async () => {
  restoreSupabase = installMockSupabase({
    member_permissions: () => ({ data: { profile_id: PROFILE_ID, customer_edit: false }, error: null }),
  });
  const check = requirePermission('customer_edit');
  const res = makeRes();
  let nexted = false;
  await check({ profile: { id: PROFILE_ID, role: 'office', is_admin: false } }, res, () => { nexted = true; });
  assert.equal(res.statusCode, 403);
  assert.equal(nexted, false);
});

// ---------------------------------------------------------------------------
// GET thread: reply block + phone-matched inbound
// ---------------------------------------------------------------------------
test('thread: returns messages, the reply eligibility block, and matches inbound by the customer phone', async () => {
  freezeClock(TWO_PM_CDT);
  const thread = [
    { created_at: '2026-08-18T15:00:00Z', direction: 'in', status: 'received', body: '<img src=x onerror=alert(1)>', customer_id: null, sent_by_profile_id: null, sent_by: null },
    { created_at: '2026-08-15T14:00:00Z', direction: 'out', status: 'sent', body: 'Booked.', sent_by_profile_id: PROFILE_ID, sent_by: { full_name: 'Amy Kraus', email: 'amy@bates-electric.com' } },
  ];
  const w = world({ consentRows: [], inbound: RECENT, thread });
  const res = makeRes();
  await threadHandler(makeReq({ params: { id: SUB_ID } }), res);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.messages, thread, 'bodies are returned verbatim — the browser escapes them');
  assert.equal(res.body.reply.allowed, true);
  assert.equal(res.body.reply.reason, 'recent_inbound');
  assert.equal(res.body.reply.quiet_hours_now, false);
  assert.equal(res.body.reply.window_days, sms.OPERATOR_REPLY_WINDOW_DAYS);

  const chain = w.messageChains.find((c) => c.some((s) => s.method === 'or'));
  assert.ok(chain, 'thread query uses an OR of customer_id and inbound-by-phone');
  const or = chain.find((s) => s.method === 'or');
  // Phone match is restricted to UNMATCHED rows: a shared number (spouses,
  // property manager) must not pull another record's attributed texts in.
  assert.equal(or.args[0], 'customer_id.eq.' + CUSTOMER_ID + ',and(direction.eq.in,from_phone.eq.' + PHONE + ',customer_id.is.null)');
  const select = chain.find((s) => s.method === 'select');
  assert.ok(select.args[0].includes('sent_by:profiles!generator_sms_messages_sent_by_profile_id_fkey(full_name, email)'));
  assert.ok(!select.args[0].includes('to_phone') && !select.args[0].includes('from_phone'), 'phones stay out of the response');
});

test('thread: opted-out customer -> reply block says opted_out', async () => {
  freezeClock(TWO_PM_CDT);
  world({ consentRows: [{ opted_in: true, opted_out: true }], thread: [] });
  const res = makeRes();
  await threadHandler(makeReq({ params: { id: SUB_ID } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.reply.allowed, false);
  assert.equal(res.body.reply.reason, 'opted_out');
});

test('thread: quiet_hours_now reflects the clock', async () => {
  freezeClock(SIX_AM_CDT);
  world({ consentRows: [{ opted_in: true, opted_out: false }], thread: [] });
  const res = makeRes();
  await threadHandler(makeReq({ params: { id: SUB_ID } }), res);
  assert.equal(res.body.reply.quiet_hours_now, true);
  assert.equal(res.body.reply.recent_inbound, false);
});
