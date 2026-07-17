// Office SMS history endpoint (GET /subscriptions/:id/sms-messages) — offline
// unit tests through the real shipped handler. The office-role gate itself is
// applied structurally by routes/generator-care/index.js (requireAuth +
// requireRole('office') before every sub-router), same as all routes here.
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
  { created_at: '2026-07-16T15:00:00Z', direction: 'in', status: 'received', detail: null, body: 'Y', related_visit_id: 'v1', provider_id: 'st_2' },
  { created_at: '2026-07-15T14:00:00Z', direction: 'out', status: 'sent', detail: null, body: 'Hi Sarah — your visit is booked. Reply Y to confirm.', related_visit_id: 'v1', provider_id: 'st_1' },
  { created_at: '2026-07-01T12:00:00Z', direction: 'out', status: 'no_consent', detail: 'customer has not opted in', body: 'Reminder body', related_visit_id: null, provider_id: null },
];

function world({ subRow, messages } = {}) {
  const w = { messageChains: [] };
  restoreSupabase = installMockSupabase({
    generator_subscriptions: () => ({ data: subRow === undefined ? { customer_id: CUSTOMER_ID } : subRow, error: null }),
    generator_sms_messages: (chain) => {
      w.messageChains.push(chain);
      return { data: messages || MESSAGES, error: null };
    },
  });
  return w;
}

test('returns the customer\'s full message history (safe fields, filtered by customer, newest-first, capped)', async () => {
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

  // Customer-safe column list only — phones stay out of the response shape,
  // and nothing secret-shaped (tokens) exists in this table to begin with.
  const select = chain.find((c) => c.method === 'select');
  const cols = select.args[0].split(',').map((s) => s.trim()).sort();
  assert.deepEqual(cols, ['body', 'created_at', 'detail', 'direction', 'provider_id', 'related_visit_id', 'status']);
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

test('customer with no texts yet returns an empty list', async () => {
  world({ messages: [] });
  const res = makeRes();
  await handler(makeReq({ params: { id: SUB_ID } }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.messages, []);
});
