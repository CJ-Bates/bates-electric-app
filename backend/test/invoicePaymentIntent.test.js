// Basil PI capture + refund resolution — Stripe's Basil API (2025-03-31+,
// pinned in lib/gcShared.js) removed Invoice.payment_intent, which silently
// nulled the stored PI on every invoice-based charge and made those rows
// un-refundable from the dashboard. Pins:
//   - payOneInvoice resolves the PI from the Basil payments list (and via the
//     invoice_payments endpoint when pay's response lacks it) so charged rows
//     store a real pi_...
//   - the refund endpoints resolve legacy null-PI rows from the Stripe invoice
//     whose line metadata carries the row id, self-heal the row, and refund —
//     only genuinely unresolvable rows keep the "use Stripe Dashboard" 400
//   - the invoice.paid webhook resolves the PI the same way and NEVER
//     overwrites a stored PI with null
//   - resolveInvoiceCharge walks payments -> PI -> latest_charge (replaces the
//     removed expand:['charge'] used by invoice refunds + stripe-data)
require('./helpers/env');

const test = require('node:test');
const assert = require('node:assert/strict');

const { installMockSupabase } = require('./helpers/mockSupabase');
const { getRouteHandler, makeReq, makeRes } = require('./helpers/routeHandler');
const { stripe, paymentIntentIdFromPayments, resolveInvoiceCharge } = require('../lib/gcShared');
const { chargePerformedAddonsForSub } = require('../lib/gcCharges');

// Patch the receipt sender BEFORE the webhook router loads (it destructures at
// load; node --test isolates per file) so handleInvoicePaid never hits Stripe.
const receipts = require('../lib/receipts');
receipts.sendReceiptEmail = async () => ({ sent: false, reason: 'test-stub' });
const { handleInvoicePaid } = require('../routes/generator-webhook')._test;

const addonsRouter = require('../routes/generator-care/addons');
const chargesRouter = require('../routes/generator-care/charges');
const addonRefundHandler = getRouteHandler(addonsRouter, 'post', '/addons/:id/refund');
const adhocRefundHandler = getRouteHandler(chargesRouter, 'post', '/adhoc-charges/:id/refund');

// ---- Stripe stubbing (shared-instance patch, same as techCharges) ----
let restoreStripe = [];
function stubStripe(resource, method, impl) {
  const original = stripe[resource][method];
  const calls = [];
  stripe[resource][method] = async (...args) => { calls.push(args); return impl(...args); };
  restoreStripe.push(() => { stripe[resource][method] = original; });
  return calls;
}
const stubSavedCard = () => stubStripe('subscriptions', 'retrieve', () => ({ default_payment_method: 'pm_1' }));

let restoreSupabase;
test.afterEach(() => {
  if (restoreSupabase) { restoreSupabase(); restoreSupabase = undefined; }
  restoreStripe.forEach((r) => r());
  restoreStripe = [];
});

const SUB_ID = 'sub-1';
const subRow = {
  id: SUB_ID, customer_id: 'cust-1', stripe_subscription_id: 'ss_1', stripe_customer_id: 'cus_1',
  customer: { name: 'John Fort' },
};

const basilPayments = (pi) => ({ data: [{ status: 'paid', payment: { type: 'payment_intent', payment_intent: pi } }] });

// Tables for the batch-charge core: sub lookup + performed addons + updates.
function batchTables(seen, addons) {
  return {
    generator_subscriptions: () => ({ data: subRow, error: null }),
    generator_pending_addons: (chain) => {
      const update = chain.find((c) => c.method === 'update');
      if (update) {
        seen.updates = seen.updates || [];
        seen.updates.push({ patch: update.args[0], chain });
        return { data: null, error: null };
      }
      return { data: addons, error: null };
    },
  };
}

test('batch charge stores the PI from the Basil payments list', async () => {
  const seen = {};
  restoreSupabase = installMockSupabase(batchTables(seen, [
    { id: 'a1', addon_type: 'battery_replacement', amount_cents: 16500, stripe_invoice_item_id: null },
  ]));
  stubSavedCard();
  stubStripe('invoices', 'create', () => ({ id: 'inv_1' }));
  stubStripe('invoiceItems', 'create', () => ({ id: 'ii_x' }));
  stubStripe('invoices', 'finalizeInvoice', () => ({ id: 'inv_1' }));
  stubStripe('invoices', 'pay', () => ({ id: 'inv_1', payments: basilPayments('pi_basil') }));

  const result = await chargePerformedAddonsForSub({ subscriptionId: SUB_ID });
  assert.equal(result.ok, true);
  const mark = seen.updates.find((u) => u.patch.status === 'charged');
  assert.ok(mark);
  assert.equal(mark.patch.stripe_payment_intent_id, 'pi_basil', 'invoice charge persists a real pi_..., not null');
});

test('pay response without payments falls back to the invoice_payments endpoint', async () => {
  const seen = {};
  restoreSupabase = installMockSupabase(batchTables(seen, [
    { id: 'a1', addon_type: 'battery_replacement', amount_cents: 16500, stripe_invoice_item_id: null },
  ]));
  stubSavedCard();
  stubStripe('invoices', 'create', () => ({ id: 'inv_1' }));
  stubStripe('invoiceItems', 'create', () => ({ id: 'ii_x' }));
  stubStripe('invoices', 'finalizeInvoice', () => ({ id: 'inv_1' }));
  stubStripe('invoices', 'pay', () => ({ id: 'inv_1' }));
  const listCalls = stubStripe('invoicePayments', 'list', () => basilPayments('pi_fallback'));

  const result = await chargePerformedAddonsForSub({ subscriptionId: SUB_ID });
  assert.equal(result.ok, true);
  assert.equal(listCalls[0][0].invoice, 'inv_1');
  const mark = seen.updates.find((u) => u.patch.status === 'charged');
  assert.equal(mark.patch.stripe_payment_intent_id, 'pi_fallback');
});

// Tables for the refund endpoints: a charged row with a NULL PI (charged
// before the fix) + the sub's stripe_customer_id + updates recorded.
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

const legacyInvoice = (metadata) => ({
  id: 'inv_legacy',
  lines: { data: [{ metadata }] },
  payments: basilPayments('pi_leg'),
});

test('addon refund resolves a legacy null-PI row from its Stripe invoice and self-heals', async () => {
  const seen = {};
  restoreSupabase = installMockSupabase(refundTables(seen, {
    table: 'generator_pending_addons',
    row: { id: 'addon-1', status: 'charged', subscription_id: SUB_ID, stripe_payment_intent_id: null, amount_cents: 8500, notes: null },
  }));
  const listCalls = stubStripe('invoices', 'list', () => ({ data: [legacyInvoice({ addon_id: 'addon-1' })] }));
  const refundCalls = stubStripe('refunds', 'create', () => ({ id: 're_1', status: 'succeeded' }));

  const res = makeRes();
  await addonRefundHandler(makeReq({ params: { id: 'addon-1' } }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.amount_cents, 8500);
  assert.equal(listCalls[0][0].customer, 'cus_1');
  assert.equal(refundCalls[0][0].payment_intent, 'pi_leg', 'refund runs against the resolved PI');
  assert.ok(seen.updates.some((p) => p.stripe_payment_intent_id === 'pi_leg'), 'row self-heals with the resolved PI');
  assert.ok(seen.updates.some((p) => p.notes && p.notes.includes('REFUNDED $85.00')));
});

test('adhoc refund resolves a legacy null-PI cart line the same way', async () => {
  const seen = {};
  restoreSupabase = installMockSupabase(refundTables(seen, {
    table: 'generator_adhoc_charges',
    row: { id: 'c1', status: 'charged', subscription_id: SUB_ID, stripe_payment_intent_id: null, amount_cents: 100, notes: null },
  }));
  stubStripe('invoices', 'list', () => ({ data: [legacyInvoice({ adhoc_charge_id: 'c1' })] }));
  const refundCalls = stubStripe('refunds', 'create', () => ({ id: 're_1', status: 'succeeded' }));

  const res = makeRes();
  await adhocRefundHandler(makeReq({ params: { id: 'c1' } }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(refundCalls[0][0].payment_intent, 'pi_leg');
  assert.ok(seen.updates.some((p) => p.stripe_payment_intent_id === 'pi_leg'));
});

test('genuinely unresolvable null-PI row still 400s and never calls Stripe refunds', async () => {
  const seen = {};
  restoreSupabase = installMockSupabase(refundTables(seen, {
    table: 'generator_pending_addons',
    row: { id: 'addon-1', status: 'charged', subscription_id: SUB_ID, stripe_payment_intent_id: null, amount_cents: 8500, notes: null },
  }));
  stubStripe('invoices', 'list', () => ({ data: [] }));
  const refundCalls = stubStripe('refunds', 'create', () => ({ id: 're_x', status: 'succeeded' }));

  const res = makeRes();
  await addonRefundHandler(makeReq({ params: { id: 'addon-1' } }), res);

  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /Stripe Dashboard/);
  assert.equal(refundCalls.length, 0);
  assert.equal(seen.updates, undefined, 'no writes on the dead-end path');
});

test('rows that already have a PI refund directly — no invoice scan', async () => {
  const seen = {};
  restoreSupabase = installMockSupabase(refundTables(seen, {
    table: 'generator_pending_addons',
    row: { id: 'addon-1', status: 'charged', subscription_id: SUB_ID, stripe_payment_intent_id: 'pi_direct', amount_cents: 8500, notes: null },
  }));
  const listCalls = stubStripe('invoices', 'list', () => ({ data: [] }));
  const refundCalls = stubStripe('refunds', 'create', () => ({ id: 're_1', status: 'succeeded' }));

  const res = makeRes();
  await addonRefundHandler(makeReq({ params: { id: 'addon-1' } }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(refundCalls[0][0].payment_intent, 'pi_direct');
  assert.equal(listCalls.length, 0, 'no scan when the PI is already stored');
});

// ---- webhook: invoice.paid marks rows without ever nulling a stored PI ----

function webhookTables(seen) {
  return {
    generator_pending_addons: (chain) => {
      const update = chain.find((c) => c.method === 'update');
      if (update) { seen.addonPatch = update.args[0]; }
      return { data: null, error: null };
    },
    generator_adhoc_charges: (chain) => {
      const update = chain.find((c) => c.method === 'update');
      if (update) { seen.adhocPatch = update.args[0]; }
      return { data: null, error: null };
    },
  };
}

test('webhook resolves the PI via invoice_payments for Basil event payloads', async () => {
  const seen = {};
  restoreSupabase = installMockSupabase(webhookTables(seen));
  stubStripe('invoicePayments', 'list', () => basilPayments('pi_evt'));

  await handleInvoicePaid({
    id: 'inv_evt',
    lines: { data: [{ metadata: { addon_id: 'addon-1' } }, { metadata: { adhoc_charge_id: 'c1' } }] },
  });

  assert.equal(seen.addonPatch.status, 'charged');
  assert.equal(seen.addonPatch.stripe_payment_intent_id, 'pi_evt');
  assert.equal(seen.adhocPatch.stripe_payment_intent_id, 'pi_evt');
});

test('webhook marks rows charged but OMITS the PI field when unresolvable (never clobbers)', async () => {
  const seen = {};
  restoreSupabase = installMockSupabase(webhookTables(seen));
  stubStripe('invoicePayments', 'list', () => ({ data: [] }));

  await handleInvoicePaid({
    id: 'inv_evt',
    lines: { data: [{ metadata: { addon_id: 'addon-1' } }] },
  });

  assert.equal(seen.addonPatch.status, 'charged');
  assert.equal('stripe_payment_intent_id' in seen.addonPatch, false,
    'a null resolution must not overwrite the PI the charge core stored');
});

// ---- resolveInvoiceCharge: payments -> PI -> latest_charge ----

test('resolveInvoiceCharge walks the Basil payments list to the settling charge', async () => {
  const piCalls = stubStripe('paymentIntents', 'retrieve', () => ({
    id: 'pi_leg',
    latest_charge: { id: 'ch_1', amount: 8600, amount_refunded: 0 },
  }));
  const ch = await resolveInvoiceCharge({ id: 'inv_1', payments: basilPayments('pi_leg') });
  assert.equal(ch.id, 'ch_1');
  assert.deepEqual(piCalls[0][1], { expand: ['latest_charge'] });
});

test('paymentIntentIdFromPayments prefers paid entries and handles expanded objects', () => {
  assert.equal(paymentIntentIdFromPayments({
    data: [
      { status: 'canceled', payment: { payment_intent: 'pi_bad' } },
      { status: 'paid', payment: { payment_intent: { id: 'pi_good' } } },
    ],
  }), 'pi_good');
  assert.equal(paymentIntentIdFromPayments({ data: [] }), null);
  assert.equal(paymentIntentIdFromPayments(undefined), null);
});
