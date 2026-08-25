// Office SMS thread endpoint (GET /subscriptions/:id/sms-messages) — offline
// unit tests through the real shipped handler. The office-role gate itself is
// applied structurally by routes/generator-care/index.js (requireAuth +
// requireRole('office') before every sub-router), same as all routes here.
// The two-way-SMS additions (reply eligibility block, inbound matched by
// phone, sent_by) are covered in smsOperatorReply.test.js.
require('./helpers/env');

const test = require('node:test');
const assert = require('node:assert/strict');

const { installMockSupabase } = require('./helpers/mockSupabase');
const { getRouteHandler, makeReq, makeRes } = require('./helpers/routeHandler');

const subscriptionsRouter = require('../routes/generator-care/subscriptions');
const handler = getRouteHandler(subscriptionsRouter, 'get', '/subscriptions/:id/sms-messages');

const SUB_ID = 'b0000000-0000-4000-8000-000000000010';
const CUSTOMER_ID = 'c0000000-0000-4000-8000-000000000001';

let restoreSupabase;
test.afterEach(() => {
  if (restoreSupabase) { restoreSupabase(); restoreSupabase = undefined; }
});

const MESSAGES = [
  { created_at: '2026-07-16T15:00:00Z', direction: 'in', status: 'received', detail: null, body: 'Y', related_visit_id: 'v1', provider_id: 'st_2', sent_by_profile_id: null, sent_by: null },
  { created_at: '2026-07-15T14:00:00Z', direction: 'out', status: 'sent', detail: null, body: 'Hi Sarah — your visit is booked. Reply Y to confirm.', related_visit_id: 'v1', provider_id: 'st_1', sent_by_profile_id: null, sent_by: null },
  { created_at: '2026-07-01T12:00:00Z', direction: 'out', status: 'no_consent', detail: 'customer has not opted in', body: 'Reminder body', related_visit_id: null, provider_id: null, sent_by_profile_id: null, sent_by: null },
];

// subRow: the subscription row (customer_id + embedded customer phone).
function world({ subRow, messages } = {}) {
  const w = { messageChains: [] };
  restoreSupabase = installMockSupabase({
    generator_subscriptions: () => ({
      data: subRow === undefined ? { customer_id: CUSTOMER_ID, customer: { id: CUSTOMER_ID, phone: '636-555-0100' } } : subRow,
      error: null,
    }),
    generator_sms_consent: () => ({ data: [{ opted_in: true, opted_out: false }], error: null }),
    generator_sms_messages: (chain) => {
      w.messageChains.push(chain);
      // The reply-window recency probe (direction='in' + from_phone) vs the thread read.
      const isRecency = chain.some((c) => c.method === 'eq' && c.args[0] === 'direction' && c.args[1] === 'in');
      return { data: isRecency ? [] : (messages || MESSAGES), error: null };
    },
  });
  return w;
}

test('returns the customer\'s full message history (safe fields, scoped to the customer, newest-first, capped)', async () => {
  const w = world();
  const res = makeRes();
  await handler(makeReq({ params: { id: SUB_ID } }), res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.messages, MESSAGES);
  assert.equal(res.body.reply.allowed, true);

  // The thread query must scope to THIS customer (by id, or an inbound from
  // their phone), order newest-first, and cap rows.
  const chain = w.messageChains.find((c) => c.some((s) => s.method === 'or'));
  const or = chain.find((c) => c.method === 'or');
  assert.equal(or.args[0], 'customer_id.eq.' + CUSTOMER_ID + ',and(direction.eq.in,from_phone.eq.+16365550100,customer_id.is.null)');
  const order = chain.find((c) => c.method === 'order');
  assert.equal(order.args[0], 'created_at');
  assert.equal(order.args[1].ascending, false);
  const limit = chain.find((c) => c.method === 'limit');
  assert.equal(limit.args[0], 100);

  // Customer-safe column list only — phones stay out of the response shape,
  // and nothing secret-shaped (tokens) exists in this table to begin with.
  const select = chain.find((c) => c.method === 'select');
  const cols = select.args[0].split(/,(?![^(]*\))/).map((s) => s.trim()).sort();
  assert.deepEqual(cols, [
    'body', 'created_at', 'detail', 'direction', 'provider_id', 'related_visit_id',
    'sent_by:profiles!generator_sms_messages_sent_by_profile_id_fkey(full_name, email)', 'sent_by_profile_id', 'status',
  ]);
});

test('a customer with no usable phone falls back to a plain customer_id filter', async () => {
  const w = world({ subRow: { customer_id: CUSTOMER_ID, customer: { id: CUSTOMER_ID, phone: null } } });
  const res = makeRes();
  await handler(makeReq({ params: { id: SUB_ID } }), res);
  assert.equal(res.statusCode, 200);
  const chain = w.messageChains[0];
  assert.ok(!chain.some((c) => c.method === 'or'));
  assert.deepEqual(chain.find((c) => c.method === 'eq').args, ['customer_id', CUSTOMER_ID]);
  assert.equal(res.body.reply.reason, 'invalid_phone');
});

test('404s for a missing subscription', async () => {
  const w = world({ subRow: null });
  const res = makeRes();
  await handler(makeReq({ params: { id: SUB_ID } }), res);
  assert.equal(res.statusCode, 404);
  assert.equal(w.messageChains.length, 0, 'no message query for an unknown subscription');
});

test('subscription without a linked customer returns an empty list without querying messages', async () => {
  const w = world({ subRow: { customer_id: null } });
  const res = makeRes();
  await handler(makeReq({ params: { id: SUB_ID } }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.messages, []);
  assert.equal(res.body.reply, null);
  assert.equal(w.messageChains.length, 0);
});

test('customer with no texts yet returns an empty list', async () => {
  world({ messages: [] });
  const res = makeRes();
  await handler(makeReq({ params: { id: SUB_ID } }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.messages, []);
});
