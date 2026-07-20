// Tech on-site charging (add-ons menu Phase 1) — the two tech money endpoints,
// which run through the SHARED charge cores in lib/gcCharges.js (the same code
// path as the office routes). Pins: the assignedVisit guard runs before ANY
// Stripe call, insert-then-charge idempotency (row pending -> charged/failed),
// technician_id provenance, the no-card 402 + card-update-link flow, the
// decline path, the one-invoice batch, the office notification email on every
// successful tech charge (and mail failure never failing a charge), and that
// tech-facing responses carry no Stripe ids.
require('./helpers/env');

const test = require('node:test');
const assert = require('node:assert/strict');

// Patch the mail transport BEFORE the router loads (emails.js destructures at
// load; node --test isolates per file).
const mailer = require('../lib/mailer');
let brevoCalls = [];
let brevoImpl = async () => ({ sent: true, messageId: 'test-msg' });
mailer.sendViaBrevo = async (args) => { brevoCalls.push(args); return brevoImpl(args); };

const { installMockSupabase } = require('./helpers/mockSupabase');
const { getRouteHandler, makeReq, makeRes } = require('./helpers/routeHandler');
const { stripe } = require('../lib/gcShared');
const techRouter = require('../routes/generator-tech');

const TECH_ID = '00000000-0000-4000-8000-000000000042';
const VISIT_ID = 'visit-1';
const SUB_ID = 'sub-1';

const adhocHandler = getRouteHandler(techRouter, 'post', '/my-visits/:id/adhoc-charge');
const batchHandler = getRouteHandler(techRouter, 'post', '/my-visits/:id/charge-performed-addons');

function techReq(body = {}) {
  const req = makeReq({ params: { id: VISIT_ID }, body, user: { id: TECH_ID, email: 'chris@bates-electric.com' } });
  req.profile = { full_name: 'Chris Tech' };
  return req;
}

const assignedVisitRow = {
  id: VISIT_ID, status: 'scheduled', completed_date: null, assigned_tech_id: TECH_ID,
  appointment_at: null, subscription_id: SUB_ID,
};

const subRow = {
  id: SUB_ID, customer_id: 'cust-1', stripe_subscription_id: 'stripe_sub_1', stripe_customer_id: 'cus_1',
  status: 'active', customer: { name: 'John Fort', email: 'john@example.com' },
};

// ---- Stripe stubbing (same shared-instance patch pattern as changePlanRoutes) ----
let restoreStripe = [];
function stubStripe(resource, method, impl) {
  const original = stripe[resource][method];
  const calls = [];
  stripe[resource][method] = async (...args) => { calls.push(args); return impl(...args); };
  restoreStripe.push(() => { stripe[resource][method] = original; });
  return calls;
}
// A saved card resolves on the first try (subscription default_payment_method).
const stubSavedCard = () => stubStripe('subscriptions', 'retrieve', () => ({ default_payment_method: 'pm_1' }));

let restoreSupabase;
test.beforeEach(() => { brevoCalls = []; brevoImpl = async () => ({ sent: true, messageId: 'test-msg' }); });
test.afterEach(() => {
  if (restoreSupabase) { restoreSupabase(); restoreSupabase = undefined; }
  restoreStripe.forEach((r) => r());
  restoreStripe = [];
});

// Let fire-and-forget email promises settle before asserting on brevoCalls.
const settle = () => new Promise((resolve) => setImmediate(resolve));

// ---- custom (ad-hoc) charge ----

test('custom charge happy path: row pending -> charged with technician_id; office emailed; no Stripe ids in the response', async () => {
  const seen = { updates: [] };
  restoreSupabase = installMockSupabase({
    generator_service_visits: () => ({ data: assignedVisitRow, error: null }),
    generator_subscriptions: () => ({ data: subRow, error: null }),
    generator_adhoc_charges: (chain) => {
      const insert = chain.find((c) => c.method === 'insert');
      if (insert) { seen.insert = insert.args[0]; return { data: { id: 'adhoc-1', ...insert.args[0] }, error: null }; }
      const update = chain.find((c) => c.method === 'update');
      if (update) {
        seen.updates.push(update.args[0]);
        return { data: { id: 'adhoc-1', ...seen.insert, ...update.args[0], stripe_payment_intent_id: 'pi_1' }, error: null };
      }
      return { data: null, error: null };
    },
  });
  stubSavedCard();
  const piCalls = stubStripe('paymentIntents', 'create', () => ({ id: 'pi_1' }));

  const res = makeRes();
  await adhocHandler(techReq({ description: 'Replaced battery cables', amount_cents: 12550 }), res);
  await settle();

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  // Insert-then-charge: pending row first, with the tech recorded.
  assert.equal(seen.insert.status, 'pending');
  assert.equal(seen.insert.billing_method, 'immediate');
  assert.equal(seen.insert.technician_id, TECH_ID);
  assert.equal(seen.insert.service_visit_id, VISIT_ID);
  assert.equal(seen.insert.amount_cents, 12550);
  // Exactly one charge, off-session, with the receipt email.
  assert.equal(piCalls.length, 1);
  assert.equal(piCalls[0][0].amount, 12550);
  assert.equal(piCalls[0][0].off_session, true);
  assert.equal(piCalls[0][0].receipt_email, 'john@example.com');
  // Row flipped to charged.
  assert.equal(seen.updates.length, 1);
  assert.equal(seen.updates[0].status, 'charged');
  assert.equal(seen.updates[0].stripe_payment_intent_id, 'pi_1');
  // Tech-facing response: curated, no Stripe/internal ids.
  assert.deepEqual(Object.keys(res.body.charge).sort(), ['amount_cents', 'date_charged', 'description']);
  // Office notified with tech, customer, amount.
  assert.equal(brevoCalls.length, 1);
  assert.match(brevoCalls[0].subject, /Chris Tech charged John Fort \$125\.50/);
  assert.match(brevoCalls[0].text, /Replaced battery cables: \$125\.50/);
});

test('custom charge: 403 on an unassigned visit BEFORE any Stripe call or DB write', async () => {
  let stripeTouched = false;
  restoreSupabase = installMockSupabase({
    generator_service_visits: () => ({ data: null, error: null }),
    generator_subscriptions: () => ({ data: subRow, error: null }),
    generator_adhoc_charges: () => { throw new Error('must not insert'); },
  });
  stubStripe('paymentIntents', 'create', () => { stripeTouched = true; return { id: 'pi_x' }; });

  const res = makeRes();
  await adhocHandler(techReq({ description: 'x', amount_cents: 100 }), res);
  assert.equal(res.statusCode, 403);
  assert.equal(stripeTouched, false);
  assert.equal(brevoCalls.length, 0);
});

test('custom charge validation: empty description / non-integer / non-positive amounts -> 400, nothing written', async () => {
  restoreSupabase = installMockSupabase({
    generator_service_visits: () => ({ data: assignedVisitRow, error: null }),
    generator_adhoc_charges: () => { throw new Error('must not touch'); },
    generator_subscriptions: () => { throw new Error('must not touch'); },
  });
  for (const body of [
    { description: '   ', amount_cents: 100 },
    { description: 'work', amount_cents: 0 },
    { description: 'work', amount_cents: -500 },
    { description: 'work', amount_cents: 99.5 },
    { description: 'work' },
  ]) {
    const res = makeRes();
    await adhocHandler(techReq(body), res);
    assert.equal(res.statusCode, 400, JSON.stringify(body));
  }
});

test('custom charge no-card: row failed, 402 + card-update link emailed to the customer, no charge attempted', async () => {
  const seen = { updates: [] };
  restoreSupabase = installMockSupabase({
    generator_service_visits: () => ({ data: assignedVisitRow, error: null }),
    generator_subscriptions: () => ({ data: { ...subRow, customer: { ...subRow.customer, install_state: 'MO' } }, error: null }),
    generator_adhoc_charges: (chain) => {
      const insert = chain.find((c) => c.method === 'insert');
      if (insert) { seen.insert = insert.args[0]; return { data: { id: 'adhoc-1', ...insert.args[0] }, error: null }; }
      const update = chain.find((c) => c.method === 'update');
      if (update) seen.updates.push(update.args[0]);
      return { data: null, error: null };
    },
  });
  stubStripe('subscriptions', 'retrieve', () => ({ default_payment_method: null }));
  stubStripe('customers', 'retrieve', () => ({ invoice_settings: {} }));
  stubStripe('paymentMethods', 'list', () => ({ data: [] }));
  // billingPortal.sessions nests one level deeper than stubStripe handles.
  const origPortal = stripe.billingPortal.sessions.create;
  stripe.billingPortal.sessions.create = async () => ({ url: 'https://billing.stripe.com/session' });
  restoreStripe.push(() => { stripe.billingPortal.sessions.create = origPortal; });
  let piTouched = false;
  stubStripe('paymentIntents', 'create', () => { piTouched = true; return { id: 'pi_x' }; });

  const res = makeRes();
  await adhocHandler(techReq({ description: 'Surge protector', amount_cents: 5000 }), res);
  await settle();

  assert.equal(res.statusCode, 402);
  assert.equal(res.body.reason, 'no saved card on file');
  assert.equal(res.body.card_update_email_sent, true);
  assert.equal(piTouched, false, 'no charge is ever attempted without a card');
  assert.equal(seen.updates.length, 1);
  assert.equal(seen.updates[0].status, 'failed');
  // The one email is the customer's card-update link — NOT an office charge
  // notification (nothing was charged).
  assert.equal(brevoCalls.length, 1);
  assert.equal(brevoCalls[0].to, 'john@example.com');
});

test('custom charge decline: row failed with the reason, 402, exactly one charge attempt', async () => {
  const seen = { updates: [] };
  restoreSupabase = installMockSupabase({
    generator_service_visits: () => ({ data: assignedVisitRow, error: null }),
    generator_subscriptions: () => ({ data: subRow, error: null }),
    generator_adhoc_charges: (chain) => {
      const insert = chain.find((c) => c.method === 'insert');
      if (insert) return { data: { id: 'adhoc-1', ...insert.args[0] }, error: null };
      const update = chain.find((c) => c.method === 'update');
      if (update) seen.updates.push(update.args[0]);
      return { data: null, error: null };
    },
  });
  stubSavedCard();
  const piCalls = stubStripe('paymentIntents', 'create', () => { throw new Error('Your card was declined.'); });

  const res = makeRes();
  await adhocHandler(techReq({ description: 'Surge protector', amount_cents: 5000 }), res);
  await settle();

  assert.equal(res.statusCode, 402);
  assert.match(res.body.reason, /declined/);
  assert.equal(piCalls.length, 1);
  assert.equal(seen.updates.length, 1);
  assert.equal(seen.updates[0].status, 'failed');
  assert.match(seen.updates[0].notes, /declined/);
  assert.equal(brevoCalls.length, 0, 'a failed charge never notifies the office as a success');
});

test('a mail failure never fails a successful charge', async () => {
  brevoImpl = async () => { throw new Error('Brevo down'); };
  restoreSupabase = installMockSupabase({
    generator_service_visits: () => ({ data: assignedVisitRow, error: null }),
    generator_subscriptions: () => ({ data: subRow, error: null }),
    generator_adhoc_charges: (chain) => {
      const insert = chain.find((c) => c.method === 'insert');
      if (insert) return { data: { id: 'adhoc-1', ...insert.args[0] }, error: null };
      return { data: { id: 'adhoc-1', description: 'x', amount_cents: 100, status: 'charged', date_charged: '2026-07-20' }, error: null };
    },
  });
  stubSavedCard();
  stubStripe('paymentIntents', 'create', () => ({ id: 'pi_1' }));

  const res = makeRes();
  await adhocHandler(techReq({ description: 'x', amount_cents: 100 }), res);
  await settle();
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
});

// ---- batch: charge performed add-ons ----

test('charge-performed happy path: ONE invoice, one line per add-on, rows charged, office emailed, no invoice id in response', async () => {
  const seen = { addonUpdates: [] };
  restoreSupabase = installMockSupabase({
    generator_service_visits: () => ({ data: assignedVisitRow, error: null }),
    generator_subscriptions: () => ({ data: subRow, error: null }),
    generator_pending_addons: (chain) => {
      const update = chain.find((c) => c.method === 'update');
      if (update) { seen.addonUpdates.push({ patch: update.args[0], ids: chain.find((c) => c.method === 'in').args[1] }); return { data: null, error: null }; }
      return {
        data: [
          { id: 'a1', addon_type: 'battery_replacement', amount_cents: 16500, stripe_invoice_item_id: null },
          { id: 'a2', addon_type: 'exterior_wash', amount_cents: 8500, stripe_invoice_item_id: null },
        ],
        error: null,
      };
    },
  });
  stubSavedCard();
  const invCreate = stubStripe('invoices', 'create', () => ({ id: 'inv_1' }));
  const itemCreate = stubStripe('invoiceItems', 'create', () => ({ id: 'ii_x' }));
  stubStripe('invoices', 'finalizeInvoice', () => ({ id: 'inv_1' }));
  stubStripe('invoices', 'pay', () => ({ id: 'inv_1', payment_intent: 'pi_9' }));

  const res = makeRes();
  await batchHandler(techReq(), res);
  await settle();

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true, charged_count: 2, total_cents: 25000 });
  assert.equal(invCreate.length, 1, 'exactly ONE invoice');
  assert.equal(itemCreate.length, 2, 'one line item per add-on');
  assert.equal(seen.addonUpdates.length, 1);
  assert.equal(seen.addonUpdates[0].patch.status, 'charged');
  assert.equal(seen.addonUpdates[0].patch.stripe_payment_intent_id, 'pi_9');
  assert.deepEqual(seen.addonUpdates[0].ids, ['a1', 'a2']);
  // Office notification itemizes both add-ons and the total.
  assert.equal(brevoCalls.length, 1);
  assert.match(brevoCalls[0].subject, /Chris Tech charged John Fort \$250\.00/);
  assert.match(brevoCalls[0].text, /Battery Replacement: \$165\.00/);
  assert.match(brevoCalls[0].text, /Exterior Wash & Interior Blow-Out: \$85\.00/);
});

test('charge-performed: 403 on an unassigned visit before any Stripe call', async () => {
  let stripeTouched = false;
  restoreSupabase = installMockSupabase({
    generator_service_visits: () => ({ data: null, error: null }),
  });
  stubStripe('invoices', 'create', () => { stripeTouched = true; return { id: 'inv_x' }; });

  const res = makeRes();
  await batchHandler(techReq(), res);
  assert.equal(res.statusCode, 403);
  assert.equal(stripeTouched, false);
});

test('charge-performed: 400 when nothing is performed-unbilled (menu toggles alone never charge)', async () => {
  restoreSupabase = installMockSupabase({
    generator_service_visits: () => ({ data: assignedVisitRow, error: null }),
    generator_subscriptions: () => ({ data: subRow, error: null }),
    generator_pending_addons: () => ({ data: [], error: null }),
  });
  const res = makeRes();
  await batchHandler(techReq(), res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /no performed add-ons/);
  assert.equal(brevoCalls.length, 0);
});

test('charge-performed failure mid-invoice: invoice voided, item ids cleared, rows stay performed (retry-safe)', async () => {
  const seen = { addonUpdates: [] };
  restoreSupabase = installMockSupabase({
    generator_service_visits: () => ({ data: assignedVisitRow, error: null }),
    generator_subscriptions: () => ({ data: subRow, error: null }),
    generator_pending_addons: (chain) => {
      const update = chain.find((c) => c.method === 'update');
      if (update) { seen.addonUpdates.push(update.args[0]); return { data: null, error: null }; }
      return { data: [{ id: 'a1', addon_type: 'battery_replacement', amount_cents: 16500, stripe_invoice_item_id: null }], error: null };
    },
  });
  stubSavedCard();
  stubStripe('invoices', 'create', () => ({ id: 'inv_1' }));
  stubStripe('invoiceItems', 'create', () => ({ id: 'ii_1' }));
  stubStripe('invoices', 'finalizeInvoice', () => ({ id: 'inv_1' }));
  stubStripe('invoices', 'pay', () => { throw new Error('Your card was declined.'); });
  const voidCalls = stubStripe('invoices', 'voidInvoice', () => ({ id: 'inv_1', status: 'void' }));

  const res = makeRes();
  await batchHandler(techReq(), res);
  await settle();

  assert.equal(res.statusCode, 402);
  assert.match(res.body.reason, /declined/);
  assert.equal(voidCalls.length, 1);
  assert.equal(seen.addonUpdates.length, 1);
  assert.deepEqual(seen.addonUpdates[0], { stripe_invoice_item_id: null }, 'rows keep status performed for a clean retry');
  assert.equal(brevoCalls.length, 0);
});
