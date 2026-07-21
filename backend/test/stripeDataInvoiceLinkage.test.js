// Bundled-charge legibility (office dashboard): each recent invoice in
// GET /subscriptions/:id/stripe-data now carries
//   - line_items: [{ description, amount_cents }] from the Stripe invoice's
//     own lines (so the dashboard can itemize an $86 invoice into its $85
//     add-on + $1 custom charge), capped, and
//   - payment_intent_id: the invoice's settling PI, so charged add-on/adhoc
//     rows (which store the same PI) can point at their invoice.
// Display-only; every pre-existing field keeps its shape.
require('./helpers/env');

const test = require('node:test');
const assert = require('node:assert/strict');

const { installMockSupabase } = require('./helpers/mockSupabase');
const { getRouteHandler, makeReq, makeRes } = require('./helpers/routeHandler');
const { stripe, invoiceLineItems } = require('../lib/gcShared');

const subscriptionsRouter = require('../routes/generator-care/subscriptions');
const handler = getRouteHandler(subscriptionsRouter, 'get', '/subscriptions/:id/stripe-data');

const SUB_ID = 'b0000000-0000-4000-8000-000000000010';

// ---- Stripe stubbing (shared-instance patch, same as invoicePaymentIntent) ----
let restoreStripe = [];
function stubStripe(resource, method, impl) {
  const original = stripe[resource][method];
  const calls = [];
  stripe[resource][method] = async (...args) => { calls.push(args); return impl(...args); };
  restoreStripe.push(() => { stripe[resource][method] = original; });
  return calls;
}

let restoreSupabase;
test.afterEach(() => {
  if (restoreSupabase) { restoreSupabase(); restoreSupabase = undefined; }
  restoreStripe.forEach((r) => r());
  restoreStripe = [];
});

const basilPayments = (pi) => ({ data: [{ status: 'paid', payment: { type: 'payment_intent', payment_intent: pi } }] });

// A paid Stripe invoice as invoices.list returns it (Basil: payments expanded,
// no top-level payment_intent/charge).
function paidInvoice({ id, pi, lines, amount }) {
  return {
    id,
    created: 1752969600, // 2025-07-20
    amount_paid: amount,
    status: 'paid',
    hosted_invoice_url: `https://stripe.test/${id}`,
    lines: { data: lines },
    payments: pi ? basilPayments(pi) : { data: [] },
  };
}

function world({ invoices }) {
  restoreSupabase = installMockSupabase({
    // stripe_subscription_id null: plan_billing branch stays out of these tests.
    generator_subscriptions: () => ({
      data: { stripe_customer_id: 'cus_1', stripe_subscription_id: null, plan: 'annual', gen_class: 'air_10_24' },
      error: null,
    }),
  });
  stubStripe('paymentMethods', 'list', () => ({ data: [] }));
  stubStripe('invoices', 'list', () => ({ data: invoices }));
  stubStripe('paymentIntents', 'retrieve', (piId) => ({
    id: piId,
    latest_charge: {
      amount: 8600,
      amount_refunded: 0,
      payment_intent: piId,
      payment_method_details: { card: { brand: 'visa', last4: '4242' } },
    },
  }));
  // Legacy fallback path (invoice with no inline payments) — resolves nothing.
  stubStripe('invoicePayments', 'list', () => ({ data: [] }));
}

test('a bundled invoice carries its line items and settling PI', async () => {
  world({
    invoices: [paidInvoice({
      id: 'inv_bundle',
      pi: 'pi_bundle',
      amount: 8600,
      lines: [
        { description: 'Exterior Wash & Interior Blow-Out', amount: 8500 },
        { description: 'test charge', amount: 100 },
      ],
    })],
  });
  const res = makeRes();
  await handler(makeReq({ params: { id: SUB_ID } }), res);

  assert.equal(res.statusCode, 200);
  const inv = res.body.recent_invoices[0];
  assert.equal(inv.payment_intent_id, 'pi_bundle');
  assert.deepEqual(inv.line_items, [
    { description: 'Exterior Wash & Interior Blow-Out', amount_cents: 8500 },
    { description: 'test charge', amount_cents: 100 },
  ]);
  // Pre-existing fields keep their shape next to the new ones.
  assert.equal(inv.amount_paid, 8600);
  assert.equal(inv.charge_amount_cents, 8600);
  assert.equal(inv.refundable, true);
  assert.equal(inv.card_last4, '4242');
});

test('an invoice whose PI cannot be resolved still renders — null PI, never a broken row', async () => {
  world({
    invoices: [paidInvoice({
      id: 'inv_orphan',
      pi: null, // no inline payments, and invoicePayments.list finds nothing
      amount: 100,
      lines: [{ description: 'test charge', amount: 100 }],
    })],
  });
  const res = makeRes();
  await handler(makeReq({ params: { id: SUB_ID } }), res);

  assert.equal(res.statusCode, 200);
  const inv = res.body.recent_invoices[0];
  assert.equal(inv.payment_intent_id, null);
  assert.deepEqual(inv.line_items, [{ description: 'test charge', amount_cents: 100 }]);
  assert.equal(inv.refundable, false, 'no charge resolved — refund state falls back as before');
});

test('invoiceLineItems maps defensively and caps the list', () => {
  assert.deepEqual(invoiceLineItems(null), []);
  assert.deepEqual(invoiceLineItems({}), []);
  assert.deepEqual(
    invoiceLineItems({ lines: { data: [{ amount: 500 }] } }),
    [{ description: null, amount_cents: 500 }],
    'a line with no description stays renderable'
  );
  const many = { lines: { data: Array.from({ length: 14 }, (_, i) => ({ description: `line ${i}`, amount: i })) } };
  assert.equal(invoiceLineItems(many).length, 10, 'capped at 10');
});
