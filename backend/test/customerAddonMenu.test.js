// Customer portal add-on self-enroll (add-ons menu Phase 2) — offline route
// tests through the REAL shipped handlers in routes/customer.js. Pins:
//   - the ownership anchor: everything resolves from the AUTHENTICATED email
//     (403 with no linked account; client-smuggled sub ids never reach a query);
//   - the menu payload (shared lib/addonMenu.js statuses, catalog prices,
//     customer-safe fields — no performed_by / staff ids);
//   - one-time self-enroll: pending row at the CATALOG price on the open visit
//     (client-sent prices ignored), idempotent 409, gen-class applicability,
//     canceled-sub rejection — and NO charge anywhere;
//   - standing self-enroll/unenroll: recurring types only, standing set update
//     + materialized pending row on the open visit, consent line on the sub,
//     unenroll cancels ONLY a still-pending row on the open visit;
//   - pending-only self-removal (performed rows can't be removed).
require('./helpers/env');

const test = require('node:test');
const assert = require('node:assert/strict');

const { installMockSupabase } = require('./helpers/mockSupabase');
const { getRouteHandler, makeReq, makeRes } = require('./helpers/routeHandler');
const customerRouter = require('../routes/customer');

const CUSTOMER_ID = 'c0000000-0000-4000-8000-000000000001';
const SUB_ID = 'sub-1';
const VISIT_ID = 'visit-1';
const EMAIL = 'customer@example.com';

const menuHandler = getRouteHandler(customerRouter, 'get', '/addon-menu');
const addHandler = getRouteHandler(customerRouter, 'post', '/addons');
const removeHandler = getRouteHandler(customerRouter, 'delete', '/addons/:id');
const standingOn = getRouteHandler(customerRouter, 'post', '/standing/:addon_type');
const standingOff = getRouteHandler(customerRouter, 'delete', '/standing/:addon_type');

const custReq = (over = {}) => makeReq({ user: { email: EMAIL }, ...over });

let restore;
test.afterEach(() => { if (restore) { restore(); restore = undefined; } });

// One configurable world per test: the customer + sub resolve from the email
// (the security anchor), and every write against subs/addons is captured.
function customerWorld(over = {}) {
  const world = { addonInserts: [], addonPatches: [], addonReadFilters: [], subPatches: [] };
  const sub = {
    id: SUB_ID, customer_id: CUSTOMER_ID, status: 'active', signup_date: '2026-06-01',
    plan: 'annual', gen_class: 'air_cooled', standing_addons: [], notes: null,
    raw_metadata: {}, stripe_customer_id: 'cus_1', stripe_subscription_id: 'stripe-sub-1',
    ...over.sub,
  };
  restore = installMockSupabase({
    generator_customers: () => ({
      data: over.noCustomer ? [] : [{
        id: CUSTOMER_ID, name: 'Sarah Example', email: EMAIL, phone: '636-555-0100',
        install_address: 'x', install_city: 'x', install_state: 'MO', install_zip: 'x',
        stripe_customer_id: 'cus_1',
      }],
      error: null,
    }),
    generator_subscriptions: (chain) => {
      const update = chain.find((c) => c.method === 'update');
      if (update) {
        world.subPatches.push({ patch: update.args[0], filters: chain.filter((c) => c.method === 'eq').map((c) => c.args) });
        return { data: null, error: null };
      }
      return { data: [sub], error: null };
    },
    // Only getOpenVisitId reads this table in these handlers.
    generator_service_visits: () => ({ data: over.openVisitId !== undefined ? (over.openVisitId && { id: over.openVisitId }) : { id: VISIT_ID }, error: null }),
    generator_pending_addons: (chain, terminal) => {
      const insert = chain.find((c) => c.method === 'insert');
      if (insert) {
        world.addonInserts.push(insert.args[0]);
        const row = Array.isArray(insert.args[0]) ? {} : insert.args[0];
        return { data: { id: 'new-1', ...row }, error: null };
      }
      const update = chain.find((c) => c.method === 'update');
      if (update) {
        world.addonPatches.push({ patch: update.args[0], filters: chain.filter((c) => c.method === 'eq').map((c) => c.args) });
        return { data: null, error: null };
      }
      world.addonReadFilters.push(chain.filter((c) => c.method === 'eq').map((c) => c.args));
      if (terminal === 'maybeSingle') return { data: over.existingRow !== undefined ? over.existingRow : null, error: null };
      return { data: over.addonRows || [], error: null };
    },
  });
  return world;
}

// ---- ownership (the IDOR boundary) ----

test('every endpoint 403s when the email has no linked Generator Care account', async () => {
  for (const [handler, req] of [
    [menuHandler, custReq()],
    [addHandler, custReq({ body: { addon_type: 'battery_replacement' } })],
    [removeHandler, custReq({ params: { id: 'a1' } })],
    [standingOn, custReq({ params: { addon_type: 'ats_outage_combined' } })],
    [standingOff, custReq({ params: { addon_type: 'ats_outage_combined' } })],
  ]) {
    customerWorld({ noCustomer: true });
    const res = makeRes();
    await handler(req, res);
    assert.equal(res.statusCode, 403);
    restore(); restore = undefined;
  }
});

test('client-smuggled subscription/customer ids are ignored — every query scopes to the email-resolved sub', async () => {
  const world = customerWorld({ sub: { gen_class: 'liquid_48_150' } });
  const res = makeRes();
  await menuHandler(custReq({
    query: { subscription_id: 'evil-sub', customer_id: 'evil-cust' },
    body: { subscription_id: 'evil-sub' },
  }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(world.addonReadFilters.length, 1);
  assert.deepEqual(world.addonReadFilters[0], [['subscription_id', SUB_ID]],
    'the add-on read is scoped to the resolved sub, never a client-sent id');
});

// ---- the menu ----

test('addon-menu: full menu with catalog prices + statuses, customer-safe fields only', async () => {
  customerWorld({
    sub: { gen_class: 'liquid_48_150', standing_addons: ['exterior_wash'] },
    addonRows: [
      { id: 'a1', addon_type: 'battery_replacement', status: 'pending', amount_cents: 26500, service_visit_id: VISIT_ID, date_performed: null },
      { id: 'a2', addon_type: 'ats_outage_combined', status: 'performed', amount_cents: 11000, service_visit_id: VISIT_ID, date_performed: '2026-07-20' },
    ],
  });
  const res = makeRes();
  await menuHandler(custReq(), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.menu.length, 5, 'liquid_48_150 sees all 5 catalog add-ons');
  const menu = Object.fromEntries(res.body.menu.map((m) => [m.addon_type, m]));
  assert.equal(menu.battery_replacement.status, 'this_visit');
  assert.equal(menu.battery_replacement.addon_id, 'a1', 'a still-pending one-off row is self-removable');
  assert.equal(menu.ats_outage_combined.status, 'performed');
  assert.equal(menu.ats_outage_combined.addon_id, null, 'performed rows carry no removable id');
  assert.equal(menu.exterior_wash.status, 'every_visit');
  assert.equal(menu.coolant_flush.status, 'not_in_plan');
  assert.equal(menu.coolant_flush.amount_cents, 69500, 'catalog price for the class');
  assert.equal(menu.coolant_topoff.recurring, true);
  for (const m of res.body.menu) {
    assert.ok(!('performed_by' in m), 'staff ids never reach the customer payload');
  }
  assert.equal(res.body.subscription_canceled, false);
});

test('addon-menu: air-cooled menu excludes liquid-only services entirely', async () => {
  customerWorld({ sub: { gen_class: 'air_cooled' } });
  const res = makeRes();
  await menuHandler(custReq(), res);
  assert.equal(res.statusCode, 200);
  const types = res.body.menu.map((m) => m.addon_type);
  assert.ok(!types.includes('coolant_flush'), 'no coolant flush on an air-cooled menu');
  assert.ok(!types.includes('coolant_topoff'));
  assert.ok(types.includes('battery_replacement'));
});

// ---- one-time self-enroll (incl. battery — no office gatekeeping) ----

test('add: pending row at the CATALOG price on the open visit; client-sent price/id fields ignored; consent note recorded', async () => {
  const world = customerWorld();
  const res = makeRes();
  await addHandler(custReq({
    body: { addon_type: 'battery_replacement', amount_cents: 1, price_id: 'evil', subscription_id: 'evil-sub' },
  }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(world.addonInserts.length, 1);
  const row = world.addonInserts[0];
  assert.equal(row.subscription_id, SUB_ID);
  assert.equal(row.addon_type, 'battery_replacement');
  assert.equal(row.amount_cents, 16500, 'air-cooled battery CATALOG price — the client-sent 1 cent never sticks');
  assert.equal(row.status, 'pending', 'scheduled, not charged — money moves only when performed');
  assert.equal(row.service_visit_id, VISIT_ID);
  assert.ok(/customer/i.test(row.notes) && /customer_portal/.test(row.notes), 'opt-in source recorded');
  assert.match(row.notes, /\d{4}-\d{2}-\d{2}T/, 'opt-in timestamp recorded');
});

test('add: 409 when an uncharged row of that type already exists (idempotent double-tap)', async () => {
  const world = customerWorld({ existingRow: { id: 'a1', status: 'pending' } });
  const res = makeRes();
  await addHandler(custReq({ body: { addon_type: 'battery_replacement' } }), res);
  assert.equal(res.statusCode, 409);
  assert.equal(world.addonInserts.length, 0);
});

test('add: 400 for a type that does not apply to the gen class, and on a canceled plan', async () => {
  let world = customerWorld();
  let res = makeRes();
  await addHandler(custReq({ body: { addon_type: 'coolant_flush' } }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(world.addonInserts.length, 0);
  restore();

  world = customerWorld({ sub: { status: 'canceled' } });
  res = makeRes();
  await addHandler(custReq({ body: { addon_type: 'battery_replacement' } }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(world.addonInserts.length, 0);
});

// ---- standing (every-visit) self-enroll/unenroll ----

test('standing opt-in: updates the standing set, records consent on the sub, materializes a pending row on the open visit', async () => {
  const world = customerWorld({ sub: { standing_addons: ['exterior_wash'] } });
  const res = makeRes();
  await standingOn(custReq({ params: { addon_type: 'ats_outage_combined' } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.standing, true);

  assert.equal(world.subPatches.length, 1);
  const { patch, filters } = world.subPatches[0];
  assert.deepEqual(patch.standing_addons.sort(), ['ats_outage_combined', 'exterior_wash']);
  assert.ok(/opted into every-visit/.test(patch.notes) && /customer_portal/.test(patch.notes), 'consent line on the sub');
  assert.deepEqual(filters, [['id', SUB_ID]], 'own sub only');

  assert.equal(world.addonInserts.length, 1, 'materialized via generateStandingAddons');
  const rows = world.addonInserts[0];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].addon_type, 'ats_outage_combined');
  assert.equal(rows[0].service_visit_id, VISIT_ID);
  assert.equal(rows[0].status, 'pending', 'scheduled only — bills when performed');
  assert.equal(rows[0].amount_cents, 11000, 'catalog price');
});

test('standing opt-in: no open visit -> set still updates, nothing materializes (returns next cycle)', async () => {
  const world = customerWorld({ openVisitId: null });
  const res = makeRes();
  await standingOn(custReq({ params: { addon_type: 'ats_outage_combined' } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(world.subPatches.length, 1);
  assert.equal(world.addonInserts.length, 0);
});

test('standing opt-in: 400 for a non-recurring type and for a type not applicable to the class', async () => {
  for (const addonType of ['battery_replacement', 'coolant_topoff']) { // one-time / liquid-only on air_cooled
    const world = customerWorld();
    const res = makeRes();
    await standingOn(custReq({ params: { addon_type: addonType } }), res);
    assert.equal(res.statusCode, 400, addonType);
    assert.equal(world.subPatches.length, 0);
    restore(); restore = undefined;
  }
});

test('standing opt-out: removes from the set and cancels ONLY a still-pending materialized row on the open visit', async () => {
  const world = customerWorld({ sub: { standing_addons: ['exterior_wash', 'ats_outage_combined'] } });
  const res = makeRes();
  await standingOff(custReq({ params: { addon_type: 'ats_outage_combined' } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.standing, false);
  assert.deepEqual(world.subPatches[0].patch.standing_addons, ['exterior_wash']);
  assert.ok(/opted out of every-visit/.test(world.subPatches[0].patch.notes));

  assert.equal(world.addonPatches.length, 1);
  assert.equal(world.addonPatches[0].patch.status, 'canceled');
  assert.deepEqual(world.addonPatches[0].filters, [
    ['subscription_id', SUB_ID],
    ['service_visit_id', VISIT_ID],
    ['addon_type', 'ats_outage_combined'],
    ['status', 'pending'],
  ], 'performed/charged rows can never be swept by the customer opt-out');
});

test('standing: 400 on a canceled plan', async () => {
  const world = customerWorld({ sub: { status: 'canceled' } });
  const res = makeRes();
  await standingOn(custReq({ params: { addon_type: 'ats_outage_combined' } }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(world.subPatches.length, 0);
});

// ---- pending-only self-removal (existing route, now load-bearing for the menu) ----

test('remove: a performed row cannot be removed by the customer', async () => {
  const world = customerWorld({ existingRow: { id: 'a1', status: 'performed', subscription_id: SUB_ID } });
  const res = makeRes();
  await removeHandler(custReq({ params: { id: 'a1' } }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(world.addonPatches.length, 0);
});
