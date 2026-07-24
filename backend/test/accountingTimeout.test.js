// Route-level tests proving the accounting reconciliation endpoint — the one
// that wedged during the 2026-07-24 stall — now (1) returns an error instead of
// hanging when a downstream DB call is stuck, and (2) degrades gracefully on an
// absurdly wide date range (clamps + notes) instead of fanning out unbounded
// work. Calls the REAL shipped handler via test/helpers/routeHandler.js,
// bypassing the requireAuth/requirePermission middleware one layer up.
require('./helpers/env');

const test = require('node:test');
const assert = require('node:assert/strict');

const { getRouteHandler, makeReq, makeRes } = require('./helpers/routeHandler');
const accountingRouter = require('../routes/generator-care/accounting');
const { stripe } = require('../lib/gcShared');
const { supabaseAdmin } = require('../lib/supabase');

const transactions = getRouteHandler(accountingRouter, 'get', '/accounting/transactions');

// Monkey-patch the shared Stripe singleton the router imports (same seam the
// change-plan route tests use — the routes don't take Stripe as a parameter).
let restoreStripe = [];
function patchStripe(overrides) {
  for (const [resource, methods] of Object.entries(overrides)) {
    for (const [method, impl] of Object.entries(methods)) {
      const original = stripe[resource][method];
      stripe[resource][method] = impl;
      restoreStripe.push(() => { stripe[resource][method] = original; });
    }
  }
}

let restoreSupabase;
test.afterEach(() => {
  restoreStripe.forEach((r) => r());
  restoreStripe = [];
  if (restoreSupabase) { restoreSupabase(); restoreSupabase = undefined; }
  delete process.env.ACCOUNTING_DB_TIMEOUT_MS;
});

const emptyPage = async () => ({ data: [], has_more: false });

test('a stuck DB lookup makes the endpoint return 500 — it does NOT hang', async () => {
  process.env.ACCOUNTING_DB_TIMEOUT_MS = '40';
  const nowSec = Math.floor(Date.now() / 1000);
  // One in-range succeeded charge with a customer, so the customer DB join runs.
  patchStripe({
    charges: {
      list: async () => ({
        data: [{ id: 'ch_1', status: 'succeeded', customer: 'cus_1', amount: 1000, created: nowSec - 3600, balance_transaction: { fee: 30, net: 970 } }],
        has_more: false,
      }),
      retrieve: async () => ({ id: 'ch_1' }),
    },
    refunds: { list: emptyPage },
    balanceTransactions: { list: emptyPage },
  });
  // Supabase query builder whose terminal thenable never settles (wedged I/O).
  const originalFrom = supabaseAdmin.from;
  const hanging = {};
  ['select', 'in', 'eq', 'order', 'limit'].forEach((m) => { hanging[m] = () => hanging; });
  hanging.then = () => {};
  supabaseAdmin.from = () => hanging;
  restoreSupabase = () => { supabaseAdmin.from = originalFrom; };

  const started = Date.now();
  const res = makeRes();
  await transactions(makeReq({ query: {} }), res);
  assert.equal(res.statusCode, 500, 'wedged DB call must surface as an error, not a hang');
  assert.deepEqual(res.body, { error: 'Server error' });
  assert.ok(Date.now() - started < 3000, 'must return near the DB timeout, not hang');
});

test('an absurdly wide range is clamped to the most recent window + a note, not a 500', async () => {
  // No charges => no DB join => success path; we only exercise the range bound.
  patchStripe({
    charges: { list: emptyPage, retrieve: async () => ({}) },
    refunds: { list: emptyPage },
    balanceTransactions: { list: emptyPage },
  });
  const res = makeRes();
  await transactions(makeReq({ query: { from: '2019-01-01', to: '2026-07-01' } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.range_capped, true);
  assert.match(res.body.note, /wider than 400 days/);
  // Clamped `from` is ~400 days before `to`, not the requested 2019 date.
  const spanDays = (new Date(res.body.to) - new Date(res.body.from)) / (24 * 60 * 60 * 1000);
  assert.ok(spanDays <= 401 && spanDays >= 399, `clamped span ${spanDays} should be ~400 days`);
});

test('a normal in-range request is not flagged as capped', async () => {
  patchStripe({
    charges: { list: emptyPage, retrieve: async () => ({}) },
    refunds: { list: emptyPage },
    balanceTransactions: { list: emptyPage },
  });
  const res = makeRes();
  await transactions(makeReq({ query: { from: '2026-06-01', to: '2026-06-30' } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.range_capped, false);
  assert.equal(res.body.note, undefined);
});
