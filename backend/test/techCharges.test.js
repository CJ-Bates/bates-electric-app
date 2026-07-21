// Tech on-site charging, Phase 1.1 cart flow — custom charges become pending
// LINE ITEMS (no Stripe on add), lines are removable while uncharged, and ONE
// POST /my-visits/:id/charge bills this visit's performed add-ons + pending
// custom lines together via lib/gcCharges.js chargeVisitCart (one invoice ->
// one payment -> one receipt). Pins: assignedVisit before ANY Stripe call,
// strict this-visit scoping (renewal/other-visit rows never swept in), the
// no-card 402 + card-update flow, decline leaving every row uncharged for an
// exactly-once retry, both tables marked with the same payment_intent, the
// office email listing every line, and no Stripe ids in tech responses.
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

const addLineHandler = getRouteHandler(techRouter, 'post', '/my-visits/:id/custom-charges');
const removeLineHandler = getRouteHandler(techRouter, 'delete', '/my-visits/:id/custom-charges/:chargeId');
const chargeHandler = getRouteHandler(techRouter, 'post', '/my-visits/:id/charge');

function techReq({ body = {}, params = {} } = {}) {
  const req = makeReq({ params: { id: VISIT_ID, ...params }, body, user: { id: TECH_ID, email: 'chris@bates-electric.com' } });
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

// ---- Stripe stubbing (shared-instance patch, same as changePlanRoutes) ----
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
test.beforeEach(() => { brevoCalls = []; brevoImpl = async () => ({ sent: true, messageId: 'test-msg' }); });
test.afterEach(() => {
  if (restoreSupabase) { restoreSupabase(); restoreSupabase = undefined; }
  restoreStripe.forEach((r) => r());
  restoreStripe = [];
});

// Let fire-and-forget email promises settle before asserting on brevoCalls.
const settle = () => new Promise((resolve) => setImmediate(resolve));

// Distinguish adhoc-table query shapes by chain: insert / update / select-list.
function adhocResolver(seen, { cartRows = [] } = {}) {
  return (chain) => {
    const insert = chain.find((c) => c.method === 'insert');
    if (insert) { seen.insert = insert.args[0]; return { data: { id: 'adhoc-1', ...insert.args[0] }, error: null }; }
    const update = chain.find((c) => c.method === 'update');
    if (update) {
      seen.updates = seen.updates || [];
      seen.updates.push({ patch: update.args[0], filters: chain.filter((c) => ['eq', 'is', 'in'].includes(c.method)).map((c) => [c.method, ...c.args]) });
      // The DELETE route ends .select('id').maybeSingle() — echo a row unless
      // the test wants a no-match.
      return { data: seen.removeMatches === false ? null : { id: 'adhoc-1' }, error: null };
    }
    seen.cartQueries = seen.cartQueries || [];
    seen.cartQueries.push(chain.filter((c) => ['eq', 'is'].includes(c.method)).map((c) => [c.method, ...c.args]));
    return { data: cartRows, error: null };
  };
}

// ---- adding a line (no Stripe) ----

test('add custom line: pending row this visit with technician_id — Stripe NEVER touched, nothing emailed', async () => {
  const seen = {};
  let stripeTouched = false;
  restoreSupabase = installMockSupabase({
    generator_service_visits: () => ({ data: assignedVisitRow, error: null }),
    generator_adhoc_charges: adhocResolver(seen),
  });
  stubStripe('paymentIntents', 'create', () => { stripeTouched = true; return { id: 'pi_x' }; });
  stubStripe('invoices', 'create', () => { stripeTouched = true; return { id: 'inv_x' }; });

  const res = makeRes();
  await addLineHandler(techReq({ body: { description: '  Replaced battery cables ', amount_cents: 12550 } }), res);
  await settle();

  assert.equal(res.statusCode, 200);
  assert.equal(seen.insert.status, 'pending');
  assert.equal(seen.insert.billing_method, 'immediate');
  assert.equal(seen.insert.service_visit_id, VISIT_ID);
  assert.equal(seen.insert.subscription_id, SUB_ID);
  assert.equal(seen.insert.technician_id, TECH_ID);
  assert.equal(seen.insert.description, 'Replaced battery cables');
  assert.equal(seen.insert.amount_cents, 12550);
  assert.equal(stripeTouched, false, 'adding a line must never charge');
  assert.equal(brevoCalls.length, 0);
  assert.deepEqual(res.body.charge, { id: 'adhoc-1', description: 'Replaced battery cables', amount_cents: 12550 });
});

test('add custom line validation: empty description / non-integer / non-positive -> 400, nothing written', async () => {
  restoreSupabase = installMockSupabase({
    generator_service_visits: () => ({ data: assignedVisitRow, error: null }),
    generator_adhoc_charges: () => { throw new Error('must not touch'); },
  });
  for (const body of [
    { description: '   ', amount_cents: 100 },
    { description: 'work', amount_cents: 0 },
    { description: 'work', amount_cents: -500 },
    { description: 'work', amount_cents: 99.5 },
    { description: 'work' },
  ]) {
    const res = makeRes();
    await addLineHandler(techReq({ body }), res);
    assert.equal(res.statusCode, 400, JSON.stringify(body));
  }
});

// ---- removing a line ----

test('remove line: cancel is hard-scoped to this visit + pending + immediate + never-invoiced', async () => {
  const seen = {};
  restoreSupabase = installMockSupabase({
    generator_service_visits: () => ({ data: assignedVisitRow, error: null }),
    generator_adhoc_charges: adhocResolver(seen),
  });
  const res = makeRes();
  await removeLineHandler(techReq({ params: { chargeId: 'adhoc-1' } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(seen.updates.length, 1);
  assert.equal(seen.updates[0].patch.status, 'canceled');
  assert.deepEqual(seen.updates[0].filters, [
    ['eq', 'id', 'adhoc-1'],
    ['eq', 'subscription_id', SUB_ID],
    ['eq', 'service_visit_id', VISIT_ID],
    ['eq', 'status', 'pending'],
    ['eq', 'billing_method', 'immediate'],
    ['is', 'stripe_invoice_item_id', null],
    ['is', 'stripe_payment_intent_id', null],
  ]);
});

test('remove line: 404 when nothing matches (already charged / another visit)', async () => {
  const seen = { removeMatches: false };
  restoreSupabase = installMockSupabase({
    generator_service_visits: () => ({ data: assignedVisitRow, error: null }),
    generator_adhoc_charges: adhocResolver(seen),
  });
  const res = makeRes();
  await removeLineHandler(techReq({ params: { chargeId: 'adhoc-other' } }), res);
  assert.equal(res.statusCode, 404);
});

// ---- ownership ----

test('add / remove / charge: all 403 on an unassigned visit before any write or Stripe call', async () => {
  for (const [handler, req] of [
    [addLineHandler, techReq({ body: { description: 'x', amount_cents: 100 } })],
    [removeLineHandler, techReq({ params: { chargeId: 'adhoc-1' } })],
    [chargeHandler, techReq()],
  ]) {
    let stripeTouched = false;
    restoreSupabase = installMockSupabase({
      generator_service_visits: () => ({ data: null, error: null }),
      generator_adhoc_charges: () => { throw new Error('must not touch'); },
      generator_pending_addons: () => { throw new Error('must not touch'); },
      generator_subscriptions: () => { throw new Error('must not touch'); },
    });
    stubStripe('invoices', 'create', () => { stripeTouched = true; return { id: 'inv_x' }; });
    const res = makeRes();
    await handler(req, res);
    assert.equal(res.statusCode, 403);
    assert.equal(stripeTouched, false);
    restoreSupabase(); restoreSupabase = undefined;
    restoreStripe.forEach((r) => r()); restoreStripe = [];
  }
});

// ---- the cart charge ----

function cartTables(seen, { addons = [], cartRows = [] } = {}) {
  return {
    generator_service_visits: () => ({ data: assignedVisitRow, error: null }),
    generator_subscriptions: () => ({ data: subRow, error: null }),
    generator_pending_addons: (chain) => {
      const update = chain.find((c) => c.method === 'update');
      if (update) {
        seen.addonUpdates = seen.addonUpdates || [];
        seen.addonUpdates.push({ patch: update.args[0], ids: chain.find((c) => c.method === 'in').args[1] });
        return { data: null, error: null };
      }
      seen.addonFilters = chain.filter((c) => c.method === 'eq').map((c) => c.args);
      return { data: addons, error: null };
    },
    generator_adhoc_charges: adhocResolver(seen, { cartRows }),
  };
}

test('cart happy path: add-ons + customs on ONE invoice, both tables marked with the same PI, office email lists every line', async () => {
  const seen = {};
  restoreSupabase = installMockSupabase(cartTables(seen, {
    addons: [{ id: 'a1', addon_type: 'battery_replacement', amount_cents: 16500, stripe_invoice_item_id: null }],
    cartRows: [
      { id: 'c1', description: 'Replaced battery cables', amount_cents: 100, technician_id: TECH_ID },
      { id: 'c2', description: 'Surge protector install', amount_cents: 100, technician_id: TECH_ID },
    ],
  }));
  stubSavedCard();
  const invCreate = stubStripe('invoices', 'create', () => ({ id: 'inv_1' }));
  const itemCreate = stubStripe('invoiceItems', 'create', () => ({ id: 'ii_x' }));
  stubStripe('invoices', 'finalizeInvoice', () => ({ id: 'inv_1' }));
  // Basil pay shape: the PI lives in the payments list (invoice.payment_intent
  // is gone) — this pins the capture path real invoices take on stripe v18.
  const payCalls = stubStripe('invoices', 'pay', () => ({
    id: 'inv_1',
    payments: { data: [{ status: 'paid', payment: { type: 'payment_intent', payment_intent: 'pi_9' } }] },
  }));

  const res = makeRes();
  await chargeHandler(techReq(), res);
  await settle();

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true, total_cents: 16700, charged_addon_count: 1, charged_custom_count: 2 });
  assert.deepEqual(payCalls[0][1], { expand: ['payments'] }, 'pay expands payments so the PI is capturable');

  // Exactly ONE invoice, three lines, right metadata for the webhook.
  assert.equal(invCreate.length, 1);
  assert.equal(itemCreate.length, 3);
  const metas = itemCreate.map((c) => c[0].metadata);
  assert.equal(metas.filter((m) => m.addon_id).length, 1);
  assert.deepEqual(metas.filter((m) => m.adhoc_charge_id).map((m) => m.adhoc_charge_id).sort(), ['c1', 'c2']);
  const customLine = itemCreate.map((c) => c[0]).find((c) => c.metadata.adhoc_charge_id === 'c1');
  assert.equal(customLine.description, 'Replaced battery cables', 'custom line carries the tech’s text');

  // Cart scope: the addon query filtered on THIS visit; the custom query on
  // this visit + pending + immediate + never-invoiced.
  assert.ok(seen.addonFilters.some((f) => f[0] === 'service_visit_id' && f[1] === VISIT_ID));
  assert.ok(seen.cartQueries[0].some((f) => f[0] === 'eq' && f[1] === 'service_visit_id' && f[2] === VISIT_ID));
  assert.ok(seen.cartQueries[0].some((f) => f[0] === 'eq' && f[1] === 'billing_method' && f[2] === 'immediate'));
  assert.ok(seen.cartQueries[0].some((f) => f[0] === 'is' && f[1] === 'stripe_invoice_item_id' && f[2] === null));

  // Both tables marked charged with the SAME payment_intent.
  assert.equal(seen.addonUpdates.length, 1);
  assert.equal(seen.addonUpdates[0].patch.status, 'charged');
  assert.equal(seen.addonUpdates[0].patch.stripe_payment_intent_id, 'pi_9');
  const adhocMark = (seen.updates || []).find((u) => u.patch.status === 'charged');
  assert.ok(adhocMark);
  assert.equal(adhocMark.patch.stripe_payment_intent_id, 'pi_9');
  assert.ok(adhocMark.filters.some((f) => f[0] === 'in' && String(f[2]) === 'c1,c2'));

  // Office email: every line + the total.
  assert.equal(brevoCalls.length, 1);
  assert.match(brevoCalls[0].subject, /Chris Tech charged John Fort \$167\.00/);
  assert.match(brevoCalls[0].text, /Battery Replacement: \$165\.00/);
  assert.match(brevoCalls[0].text, /Replaced battery cables: \$1\.00/);
  assert.match(brevoCalls[0].text, /Surge protector install: \$1\.00/);
});

test('only-custom cart charges fine (no add-ons required)', async () => {
  const seen = {};
  restoreSupabase = installMockSupabase(cartTables(seen, {
    addons: [],
    cartRows: [{ id: 'c1', description: 'Trip charge', amount_cents: 100, technician_id: TECH_ID }],
  }));
  stubSavedCard();
  stubStripe('invoices', 'create', () => ({ id: 'inv_1' }));
  const itemCreate = stubStripe('invoiceItems', 'create', () => ({ id: 'ii_x' }));
  stubStripe('invoices', 'finalizeInvoice', () => ({ id: 'inv_1' }));
  // Legacy pre-Basil pay shape — deliberately kept to pin the payment_intent fallback.
  stubStripe('invoices', 'pay', () => ({ id: 'inv_1', payment_intent: 'pi_9' }));

  const res = makeRes();
  await chargeHandler(techReq(), res);
  await settle();
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true, total_cents: 100, charged_addon_count: 0, charged_custom_count: 1 });
  assert.equal(itemCreate.length, 1);
  assert.equal(seen.addonUpdates, undefined, 'no add-on rows to touch');
});

test('empty cart -> 400 "nothing to charge", no Stripe calls', async () => {
  const seen = {};
  let stripeTouched = false;
  restoreSupabase = installMockSupabase(cartTables(seen, { addons: [], cartRows: [] }));
  stubStripe('invoices', 'create', () => { stripeTouched = true; return { id: 'inv_x' }; });
  stubStripe('subscriptions', 'retrieve', () => { stripeTouched = true; return {}; });

  const res = makeRes();
  await chargeHandler(techReq(), res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /nothing to charge/);
  assert.equal(stripeTouched, false);
  assert.equal(brevoCalls.length, 0);
});

test('cart no-card: 402, card-update link emailed, every row left uncharged', async () => {
  const seen = {};
  restoreSupabase = installMockSupabase({
    ...cartTables(seen, {
      addons: [{ id: 'a1', addon_type: 'battery_replacement', amount_cents: 16500, stripe_invoice_item_id: null }],
      cartRows: [{ id: 'c1', description: 'Trip charge', amount_cents: 100, technician_id: TECH_ID }],
    }),
    // emailCardUpdateLinkForSub re-selects the sub with the customer joined.
    generator_subscriptions: () => ({ data: { ...subRow, customer: { ...subRow.customer, install_state: 'MO' } }, error: null }),
  });
  stubStripe('subscriptions', 'retrieve', () => ({ default_payment_method: null }));
  stubStripe('customers', 'retrieve', () => ({ invoice_settings: {} }));
  stubStripe('paymentMethods', 'list', () => ({ data: [] }));
  const origPortal = stripe.billingPortal.sessions.create;
  stripe.billingPortal.sessions.create = async () => ({ url: 'https://billing.stripe.com/session' });
  restoreStripe.push(() => { stripe.billingPortal.sessions.create = origPortal; });
  let invTouched = false;
  stubStripe('invoices', 'create', () => { invTouched = true; return { id: 'inv_x' }; });

  const res = makeRes();
  await chargeHandler(techReq(), res);
  await settle();

  assert.equal(res.statusCode, 402);
  assert.equal(res.body.reason, 'no saved card on file');
  assert.equal(res.body.card_update_email_sent, true);
  assert.equal(invTouched, false);
  assert.equal(seen.addonUpdates, undefined, 'add-on rows untouched');
  assert.equal((seen.updates || []).length, 0, 'custom rows untouched');
  assert.equal(brevoCalls.length, 1);
  assert.equal(brevoCalls[0].to, 'john@example.com');
});

test('cart decline: invoice voided, add-on item ids cleared, rows stay uncharged for an exactly-once retry', async () => {
  const seen = {};
  restoreSupabase = installMockSupabase(cartTables(seen, {
    addons: [{ id: 'a1', addon_type: 'battery_replacement', amount_cents: 16500, stripe_invoice_item_id: null }],
    cartRows: [{ id: 'c1', description: 'Trip charge', amount_cents: 100, technician_id: TECH_ID }],
  }));
  stubSavedCard();
  stubStripe('invoices', 'create', () => ({ id: 'inv_1' }));
  stubStripe('invoiceItems', 'create', () => ({ id: 'ii_1' }));
  stubStripe('invoices', 'finalizeInvoice', () => ({ id: 'inv_1' }));
  stubStripe('invoices', 'pay', () => { throw new Error('Your card was declined.'); });
  const voidCalls = stubStripe('invoices', 'voidInvoice', () => ({ id: 'inv_1', status: 'void' }));

  const res = makeRes();
  await chargeHandler(techReq(), res);
  await settle();

  assert.equal(res.statusCode, 402);
  assert.match(res.body.reason, /declined/);
  assert.equal(voidCalls.length, 1);
  assert.equal(seen.addonUpdates.length, 1);
  assert.deepEqual(seen.addonUpdates[0].patch, { stripe_invoice_item_id: null }, 'add-ons stay performed');
  assert.equal((seen.updates || []).filter((u) => u.patch.status === 'charged').length, 0, 'customs stay pending');
  assert.equal(brevoCalls.length, 0);
});

test('a mail failure never fails a successful cart charge', async () => {
  brevoImpl = async () => { throw new Error('Brevo down'); };
  const seen = {};
  restoreSupabase = installMockSupabase(cartTables(seen, {
    addons: [],
    cartRows: [{ id: 'c1', description: 'Trip charge', amount_cents: 100, technician_id: TECH_ID }],
  }));
  stubSavedCard();
  stubStripe('invoices', 'create', () => ({ id: 'inv_1' }));
  stubStripe('invoiceItems', 'create', () => ({ id: 'ii_x' }));
  stubStripe('invoices', 'finalizeInvoice', () => ({ id: 'inv_1' }));
  stubStripe('invoices', 'pay', () => ({ id: 'inv_1', payment_intent: 'pi_9' }));

  const res = makeRes();
  await chargeHandler(techReq(), res);
  await settle();
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
});
