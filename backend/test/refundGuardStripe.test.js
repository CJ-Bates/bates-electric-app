// Stripe-derived over-refund guard — the per-row refund endpoints derive
// "already refunded" from the actual Stripe charge behind the row's
// PaymentIntent, not just the row's notes. Notes only record refunds issued
// through the per-row endpoints; a refund made at the invoice level or
// straight from the Stripe dashboard never annotates the row, so the
// notes-only guard believed $0 had been refunded in exactly the cases it
// exists for (Stripe still rejected the excess, but our guard was decorative,
// total_refunded_cents over-reported, and the operator got a raw Stripe
// error). Pins:
//   - whole-payment charge (amount <= row amount): charge.amount_refunded IS
//     the row's refunded total, never below the notes figure
//   - bundled cart charge (amount > row amount): the notes figure stays the
//     row attribution, but no refund may pass the payment's remaining balance
//   - Stripe read failure degrades to the notes figure (never blocks a
//     legitimate refund on a transient error) — and never LOOSENS the guard
require('./helpers/env');

const test = require('node:test');
const assert = require('node:assert/strict');

const { installMockSupabase } = require('./helpers/mockSupabase');
const { getRouteHandler, makeReq, makeRes } = require('./helpers/routeHandler');
const { stripe, buildRefundNote } = require('../lib/gcShared');

const addonsRouter = require('../routes/generator-care/addons');
const chargesRouter = require('../routes/generator-care/charges');
const addonRefundHandler = getRouteHandler(addonsRouter, 'post', '/addons/:id/refund');
const adhocRefundHandler = getRouteHandler(chargesRouter, 'post', '/adhoc-charges/:id/refund');
const invoiceRefundHandler = getRouteHandler(chargesRouter, 'post', '/invoices/:invoiceId/refund');

// ---- Stripe stubbing (shared-instance patch, same as invoicePaymentIntent) ----
let restoreStripe = [];
function stubStripe(resource, method, impl) {
  const original = stripe[resource][method];
  const calls = [];
  stripe[resource][method] = async (...args) => { calls.push(args); return impl(...args); };
  restoreStripe.push(() => { stripe[resource][method] = original; });
  return calls;
}

// The charge behind the row's PI: `amount` is the WHOLE payment (equals the
// row for a solo charge, larger for a bundled cart), `amountRefunded` is the
// payment's cumulative refund total from any source (per-row endpoint,
// invoice-level refund, Stripe dashboard).
const stubCharge = (amount, amountRefunded) => stubStripe('paymentIntents', 'retrieve',
  () => ({ id: 'pi_1', latest_charge: { id: 'ch_1', amount, amount_refunded: amountRefunded } }));

let restoreSupabase;
test.afterEach(() => {
  if (restoreSupabase) { restoreSupabase(); restoreSupabase = undefined; }
  restoreStripe.forEach((r) => r());
  restoreStripe = [];
});

// Charged row + sub lookup + update capture (same shape as invoicePaymentIntent).
function refundTables(seen, { table, row }) {
  return {
    [table]: (chain) => {
      const update = chain.find((c) => c.method === 'update');
      if (update) {
        seen.updates = seen.updates || [];
        seen.updates.push(update.args[0]);
        return { data: null, error: null };
      }
      return { data: row, error: null };
    },
    generator_subscriptions: () => ({ data: { stripe_customer_id: 'cus_1' }, error: null }),
  };
}

function installAddonRow(seen, over) {
  restoreSupabase = installMockSupabase(refundTables(seen, {
    table: 'generator_pending_addons',
    row: {
      id: 'addon-1', status: 'charged', subscription_id: 'sub-1',
      stripe_payment_intent_id: 'pi_1', amount_cents: 8500, notes: null, ...over,
    },
  }));
}

test('invoice-level refund: further per-row refund is rejected by OUR guard, not Stripe', async () => {
  const seen = {};
  installAddonRow(seen); // notes null - the invoice-level refund never annotated the row
  stubCharge(8500, 8500);
  const refundCalls = stubStripe('refunds', 'create', () => ({ id: 're_x', status: 'succeeded' }));

  const res = makeRes();
  await addonRefundHandler(makeReq({ params: { id: 'addon-1' } }), res);

  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /already refunded/);
  assert.match(res.body.error, /\$85\.00 of this \$85\.00 charge/);
  assert.equal(refundCalls.length, 0, 'blocked before any Stripe refund call');
  assert.equal(seen.updates, undefined, 'no note written for a blocked refund');
});

test('dashboard partial refund corrects the figures: remainder refunds, totals true up', async () => {
  const seen = {};
  installAddonRow(seen, { amount_cents: 11000 }); // $50 refunded in the dashboard, notes blank
  stubCharge(11000, 5000);
  const refundCalls = stubStripe('refunds', 'create', () => ({ id: 're_1', status: 'succeeded' }));

  const res = makeRes();
  await addonRefundHandler(makeReq({ params: { id: 'addon-1' } }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.amount_cents, 6000, 'full refund = remainder after the dashboard refund');
  assert.equal(res.body.total_refunded_cents, 11000);
  assert.equal(refundCalls[0][0].amount, 6000);
  assert.ok(seen.updates.some((p) => p.notes && p.notes.includes('REFUNDED $60.00 of $110.00')));
});

test('request exceeding the remaining balance gets a plain-language 400 with the amounts', async () => {
  const seen = {};
  installAddonRow(seen, { amount_cents: 11000 });
  stubCharge(11000, 5000);
  const refundCalls = stubStripe('refunds', 'create', () => ({ id: 're_x', status: 'succeeded' }));

  const res = makeRes();
  await addonRefundHandler(makeReq({ params: { id: 'addon-1' }, body: { amount_cents: 8000 } }), res);

  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /\$50\.00 of this \$110\.00 charge has already been refunded/);
  assert.match(res.body.error, /up to \$60\.00 can still be refunded/);
  assert.equal(refundCalls.length, 0);
});

test('normal first partial, then a second partial up to the remaining balance, both work', async () => {
  const seen = {};
  installAddonRow(seen, { amount_cents: 11000 });
  stubCharge(11000, 0);
  stubStripe('refunds', 'create', () => ({ id: 're_1', status: 'succeeded' }));

  const res1 = makeRes();
  await addonRefundHandler(makeReq({ params: { id: 'addon-1' }, body: { amount_cents: 2500 } }), res1);
  assert.equal(res1.statusCode, 200);
  assert.equal(res1.body.total_refunded_cents, 2500);

  // Second call: the first partial is now on the charge AND in the notes.
  restoreSupabase();
  restoreStripe.forEach((r) => r()); restoreStripe = [];
  installAddonRow(seen, { amount_cents: 11000, notes: buildRefundNote(2500, 11000, 'adj', 're_1') });
  stubCharge(11000, 2500);
  const refundCalls = stubStripe('refunds', 'create', () => ({ id: 're_2', status: 'succeeded' }));

  const res2 = makeRes();
  await addonRefundHandler(makeReq({ params: { id: 'addon-1' }, body: { amount_cents: 8500 } }), res2);
  assert.equal(res2.statusCode, 200);
  assert.equal(res2.body.amount_cents, 8500);
  assert.equal(res2.body.total_refunded_cents, 11000);
  assert.equal(refundCalls[0][0].amount, 8500);
});

test('bundled cart charge: another row\'s refund does not block this row or inflate its total', async () => {
  const seen = {};
  installAddonRow(seen); // $85 row on an $86 payment; the $1 line was already refunded
  stubCharge(8600, 100);
  const refundCalls = stubStripe('refunds', 'create', () => ({ id: 're_1', status: 'succeeded' }));

  const res = makeRes();
  await addonRefundHandler(makeReq({ params: { id: 'addon-1' } }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.amount_cents, 8500);
  assert.equal(res.body.total_refunded_cents, 8500, 'the other line\'s $1 refund is not attributed to this row');
  assert.equal(refundCalls[0][0].amount, 8500);
});

test('bundled cart charge: ambiguous partial refund is blocked with the combined-payment message', async () => {
  const seen = {};
  installAddonRow(seen); // $85 row on an $86 payment already $50 refunded - only $36 left
  stubCharge(8600, 5000);
  const refundCalls = stubStripe('refunds', 'create', () => ({ id: 're_x', status: 'succeeded' }));

  const res = makeRes();
  await addonRefundHandler(makeReq({ params: { id: 'addon-1' } }), res);

  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /\$50\.00 of the original \$86\.00 payment has already been refunded/);
  assert.match(res.body.error, /bundled with others into one payment/);
  assert.match(res.body.error, /up to \$36\.00 can still be refunded/);
  assert.equal(refundCalls.length, 0);
});

test('Stripe read failure degrades to the notes figure and the refund still succeeds', async () => {
  const seen = {};
  installAddonRow(seen, { amount_cents: 11000, notes: buildRefundNote(2500, 11000, 'adj', 're_1') });
  stubStripe('paymentIntents', 'retrieve', () => { throw new Error('stripe unreachable'); });
  const refundCalls = stubStripe('refunds', 'create', () => ({ id: 're_2', status: 'succeeded' }));

  const res = makeRes();
  await addonRefundHandler(makeReq({ params: { id: 'addon-1' } }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.amount_cents, 8500, 'notes-capped remainder, exactly the pre-Stripe-check behavior');
  assert.equal(res.body.total_refunded_cents, 11000);
  assert.equal(refundCalls[0][0].amount, 8500);
});

test('Stripe figure never LOOSENS the guard: notes above charge.amount_refunded still cap', async () => {
  const seen = {};
  installAddonRow(seen, { amount_cents: 11000, notes: buildRefundNote(2500, 11000, 'adj', 're_1') });
  stubCharge(11000, 0); // e.g. the refund from the notes is still settling on Stripe's side
  const refundCalls = stubStripe('refunds', 'create', () => ({ id: 're_x', status: 'succeeded' }));

  const res = makeRes();
  await addonRefundHandler(makeReq({ params: { id: 'addon-1' }, body: { amount_cents: 9000 } }), res);

  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /up to \$85\.00 can still be refunded/);
  assert.equal(refundCalls.length, 0);
});

test('adhoc endpoint has the same guard: dashboard-refunded charge is blocked cleanly', async () => {
  const seen = {};
  restoreSupabase = installMockSupabase(refundTables(seen, {
    table: 'generator_adhoc_charges',
    row: {
      id: 'c1', status: 'charged', subscription_id: 'sub-1',
      stripe_payment_intent_id: 'pi_1', amount_cents: 100, notes: null,
    },
  }));
  stubCharge(100, 100);
  const refundCalls = stubStripe('refunds', 'create', () => ({ id: 're_x', status: 'succeeded' }));

  const res = makeRes();
  await adhocRefundHandler(makeReq({ params: { id: 'c1' } }), res);

  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /already refunded/);
  assert.match(res.body.error, /\$1\.00 of this \$1\.00 charge/);
  assert.equal(refundCalls.length, 0);
});

test('invoice refund endpoint: over-large request gets the plain-language message too', async () => {
  restoreSupabase = installMockSupabase({
    generator_subscriptions: () => ({ data: { id: 'sub-1' }, error: null }),
  });
  stubStripe('invoices', 'retrieve', () => ({
    id: 'in_1', status: 'paid', customer: 'cus_1',
    payments: { data: [{ status: 'paid', payment: { type: 'payment_intent', payment_intent: 'pi_1' } }] },
  }));
  stubCharge(8600, 5000);
  const refundCalls = stubStripe('refunds', 'create', () => ({ id: 're_x', status: 'succeeded' }));

  const res = makeRes();
  await invoiceRefundHandler(makeReq({ params: { invoiceId: 'in_1' }, body: { amount_cents: 5000 } }), res);

  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /\$50\.00 of this \$86\.00 charge has already been refunded/);
  assert.match(res.body.error, /up to \$36\.00 can still be refunded/);
  assert.equal(refundCalls.length, 0);
});
