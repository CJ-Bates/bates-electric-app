// Office email history endpoint (GET /subscriptions/:id/email-messages) —
// offline unit tests through the real shipped handler, mirroring
// officeSmsHistory.test.js. The office-role gate is applied structurally by
// routes/generator-care/index.js (requireAuth + requireRole('office') before
// every sub-router), same as all routes here.
require('./helpers/env');

const test = require('node:test');
const assert = require('node:assert/strict');

const { installMockSupabase } = require('./helpers/mockSupabase');
const { getRouteHandler, makeReq, makeRes } = require('./helpers/routeHandler');

const subscriptionsRouter = require('../routes/generator-care/subscriptions');
const handler = getRouteHandler(subscriptionsRouter, 'get', '/subscriptions/:id/email-messages');

const SUB_ID = 'b0000000-0000-4000-8000-000000000010';
const CUSTOMER_ID = 'c0000000-0000-4000-8000-000000000001';

let restoreSupabase;
test.afterEach(() => {
  if (restoreSupabase) { restoreSupabase(); restoreSupabase = undefined; }
});

const MESSAGES = [
  { created_at: '2026-07-30T15:00:00Z', kind: 'visit-scheduled-email', status: 'sent', detail: null, subject: 'Your visit is booked', to_email: 'bill@example.com', delivery_status: 'delivered', delivery_detail: null, delivery_at: '2026-07-30T15:00:05Z', related_visit_id: 'v1' },
  { created_at: '2026-07-01T12:00:00Z', kind: 'receipt-email', status: 'failed', detail: 'Brevo 402: Maximum credits exceeded', subject: 'Your receipt', to_email: 'bill@example.com', delivery_status: null, delivery_detail: null, delivery_at: null, related_visit_id: null },
];

function world({ subRow, messages } = {}) {
  const w = { messageChains: [] };
  restoreSupabase = installMockSupabase({
    generator_subscriptions: () => ({ data: subRow === undefined ? { customer_id: CUSTOMER_ID } : subRow, error: null }),
    generator_email_messages: (chain) => {
      w.messageChains.push(chain);
      return { data: messages || MESSAGES, error: null };
    },
  });
  return w;
}

test('returns the customer\'s email history (safe fields, filtered by customer, newest-first, capped)', async () => {
  const w = world();
  const res = makeRes();
  await handler(makeReq({ params: { id: SUB_ID } }), res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.messages, MESSAGES);

  // The query must scope to THIS customer, order newest-first, and cap rows.
  const chain = w.messageChains[0];
  const eq = chain.find((c) => c.method === 'eq');
  assert.deepEqual(eq.args, ['customer_id', CUSTOMER_ID]);
  const order = chain.find((c) => c.method === 'order');
  assert.equal(order.args[0], 'created_at');
  assert.equal(order.args[1].ascending, false);
  const limit = chain.find((c) => c.method === 'limit');
  assert.equal(limit.args[0], 100);

  // Column list stays deliberate: display fields only — no provider_id (an
  // internal correlation key) and no ids beyond related_visit_id.
  const select = chain.find((c) => c.method === 'select');
  const cols = select.args[0].split(',').map((s) => s.trim()).sort();
  assert.deepEqual(cols, ['created_at', 'delivery_at', 'delivery_detail', 'delivery_status', 'detail', 'kind', 'related_visit_id', 'status', 'subject', 'to_email']);
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
  assert.equal(w.messageChains.length, 0);
});

test('customer with no logged emails yet returns an empty list', async () => {
  world({ messages: [] });
  const res = makeRes();
  await handler(makeReq({ params: { id: SUB_ID } }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.messages, []);
});
