// Tech add-on menu endpoints (add-ons menu Phase 1) — offline route tests via
// the real shipped handlers (routeHandler bypasses the router.use auth, so
// user/profile are stubbed the way requireAuth leaves them). Pins the
// assignedVisit ownership boundary (403 before anything else happens), the
// gen-class applicability check, the duplicate-add guard, and the standing
// enroll/unenroll semantics (enroll materializes on the open visit; unenroll
// cancels only a still-pending materialized row).
require('./helpers/env');

const test = require('node:test');
const assert = require('node:assert/strict');

const mailer = require('../lib/mailer');
mailer.sendViaBrevo = async () => ({ sent: true, messageId: 'test-msg' });

const { installMockSupabase } = require('./helpers/mockSupabase');
const { getRouteHandler, makeReq, makeRes } = require('./helpers/routeHandler');
const techRouter = require('../routes/generator-tech');

const TECH_ID = '00000000-0000-4000-8000-000000000042';
const VISIT_ID = 'visit-1';
const SUB_ID = 'sub-1';

const menuHandler = getRouteHandler(techRouter, 'get', '/my-visits/:id/addon-menu');
const addHandler = getRouteHandler(techRouter, 'post', '/my-visits/:id/addons');
const standingOn = getRouteHandler(techRouter, 'post', '/my-visits/:id/standing/:addon_type');
const standingOff = getRouteHandler(techRouter, 'delete', '/my-visits/:id/standing/:addon_type');

function techReq({ params = {}, body = {} } = {}) {
  const req = makeReq({ params: { id: VISIT_ID, ...params }, body, user: { id: TECH_ID, email: 'chris@bates-electric.com' } });
  req.profile = { full_name: 'Chris Tech' };
  return req;
}

const openVisit = (over = {}) => ({
  id: VISIT_ID, status: 'scheduled', completed_date: null, assigned_tech_id: TECH_ID,
  appointment_at: null, subscription_id: SUB_ID, ...over,
});

// Resolver builders. The visits table serves two query shapes: assignedVisit
// (has an eq('assigned_tech_id', ...)) and getOpenVisitId (eq('subscription_id')).
function visitResolver({ assigned = openVisit(), openVisitId = VISIT_ID } = {}) {
  return (chain) => {
    if (chain.some((c) => c.method === 'eq' && c.args[0] === 'assigned_tech_id')) {
      return { data: assigned, error: null };
    }
    return { data: openVisitId ? { id: openVisitId } : null, error: null };
  };
}

let restore;
test.afterEach(() => { if (restore) { restore(); restore = undefined; } });

// ---- ownership (the IDOR boundary) ----

test('addon-menu: 403 when the visit is not assigned to the caller — nothing else queried', async () => {
  let touchedOtherTables = false;
  restore = installMockSupabase({
    generator_service_visits: () => ({ data: null, error: null }),
    generator_subscriptions: () => { touchedOtherTables = true; return { data: null, error: null }; },
    generator_pending_addons: () => { touchedOtherTables = true; return { data: null, error: null }; },
  });
  const res = makeRes();
  await menuHandler(techReq(), res);
  assert.equal(res.statusCode, 403);
  assert.equal(touchedOtherTables, false);
});

test('add addon / standing enroll / standing unenroll: all 403 on an unassigned visit', async () => {
  for (const [handler, req] of [
    [addHandler, techReq({ body: { addon_type: 'battery_replacement' } })],
    [standingOn, techReq({ params: { addon_type: 'exterior_wash' } })],
    [standingOff, techReq({ params: { addon_type: 'exterior_wash' } })],
  ]) {
    restore = installMockSupabase({
      generator_service_visits: () => ({ data: null, error: null }),
    });
    const res = makeRes();
    await handler(req, res);
    assert.equal(res.statusCode, 403);
    restore(); restore = undefined;
  }
});

// ---- the menu ----

test('addon-menu: full menu with prices + statuses from the shared builder', async () => {
  restore = installMockSupabase({
    generator_service_visits: visitResolver(),
    generator_subscriptions: () => ({ data: { id: SUB_ID, gen_class: 'liquid_48_150', standing_addons: ['exterior_wash'], status: 'active' }, error: null }),
    generator_pending_addons: () => ({
      data: [{ id: 'a1', addon_type: 'battery_replacement', status: 'pending', amount_cents: 26500, service_visit_id: VISIT_ID, date_performed: null, performed_by: null }],
      error: null,
    }),
  });
  const res = makeRes();
  await menuHandler(techReq(), res);
  assert.equal(res.statusCode, 200);
  const menu = Object.fromEntries(res.body.menu.map((m) => [m.addon_type, m]));
  assert.equal(res.body.menu.length, 5, 'liquid_48_150 sees all 5 catalog add-ons');
  assert.equal(menu.battery_replacement.status, 'this_visit');
  assert.equal(menu.battery_replacement.amount_cents, 26500);
  assert.equal(menu.exterior_wash.status, 'every_visit');
  assert.equal(menu.coolant_flush.status, 'not_in_plan');
  assert.equal(menu.coolant_flush.amount_cents, 69500);
  assert.equal(res.body.subscription_canceled, false);
});

// ---- add a catalog add-on this visit ----

test('add addon: inserts a pending row at the catalog price on the open visit', async () => {
  const seen = {};
  restore = installMockSupabase({
    generator_service_visits: visitResolver(),
    generator_subscriptions: () => ({ data: { id: SUB_ID, gen_class: 'air_cooled', status: 'active' }, error: null }),
    generator_pending_addons: (chain) => {
      const insert = chain.find((c) => c.method === 'insert');
      if (insert) { seen.insert = insert.args[0]; return { data: { id: 'new-1', addon_type: 'battery_replacement', status: 'pending' }, error: null }; }
      return { data: null, error: null }; // duplicate check -> none
    },
  });
  const res = makeRes();
  await addHandler(techReq({ body: { addon_type: 'battery_replacement' } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(seen.insert.subscription_id, SUB_ID);
  assert.equal(seen.insert.addon_type, 'battery_replacement');
  assert.equal(seen.insert.amount_cents, 16500, 'air-cooled battery price from the catalog');
  assert.equal(seen.insert.status, 'pending');
  assert.equal(seen.insert.service_visit_id, VISIT_ID);
});

test('add addon: rejects a type that does not apply to the gen class (air-cooled coolant flush)', async () => {
  let inserted = false;
  restore = installMockSupabase({
    generator_service_visits: visitResolver(),
    generator_subscriptions: () => ({ data: { id: SUB_ID, gen_class: 'air_cooled', status: 'active' }, error: null }),
    generator_pending_addons: (chain) => {
      if (chain.some((c) => c.method === 'insert')) inserted = true;
      return { data: null, error: null };
    },
  });
  const res = makeRes();
  await addHandler(techReq({ body: { addon_type: 'coolant_flush' } }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(inserted, false);
});

test('add addon: 409 when an uncharged row of that type already exists (double-tap guard)', async () => {
  let inserted = false;
  restore = installMockSupabase({
    generator_service_visits: visitResolver(),
    generator_subscriptions: () => ({ data: { id: SUB_ID, gen_class: 'air_cooled', status: 'active' }, error: null }),
    generator_pending_addons: (chain) => {
      if (chain.some((c) => c.method === 'insert')) { inserted = true; return { data: null, error: null }; }
      return { data: { id: 'a1', status: 'pending' }, error: null }; // duplicate found
    },
  });
  const res = makeRes();
  await addHandler(techReq({ body: { addon_type: 'battery_replacement' } }), res);
  assert.equal(res.statusCode, 409);
  assert.equal(inserted, false);
});

test('add addon: 400 on a completed visit and on a canceled subscription', async () => {
  restore = installMockSupabase({
    generator_service_visits: visitResolver({ assigned: openVisit({ status: 'completed', completed_date: '2026-07-01' }) }),
  });
  let res = makeRes();
  await addHandler(techReq({ body: { addon_type: 'battery_replacement' } }), res);
  assert.equal(res.statusCode, 400);
  restore();

  restore = installMockSupabase({
    generator_service_visits: visitResolver(),
    generator_subscriptions: () => ({ data: { id: SUB_ID, gen_class: 'air_cooled', status: 'canceled' }, error: null }),
  });
  res = makeRes();
  await addHandler(techReq({ body: { addon_type: 'battery_replacement' } }), res);
  assert.equal(res.statusCode, 400);
});

// ---- standing (every-visit) enroll/unenroll ----

test('standing enroll: adds to standing_addons AND materializes a pending row on the open visit', async () => {
  const seen = { inserts: [] };
  restore = installMockSupabase({
    generator_service_visits: visitResolver(),
    generator_subscriptions: (chain) => {
      const update = chain.find((c) => c.method === 'update');
      if (update) { seen.subPatch = update.args[0]; return { data: null, error: null }; }
      return { data: { id: SUB_ID, gen_class: 'liquid_22_38', status: 'active', standing_addons: ['exterior_wash'] }, error: null };
    },
    generator_pending_addons: (chain) => {
      const insert = chain.find((c) => c.method === 'insert');
      if (insert) { seen.inserts.push(insert.args[0]); return { data: null, error: null }; }
      return { data: [], error: null }; // generateStandingAddons existing-rows check
    },
  });
  const res = makeRes();
  await standingOn(techReq({ params: { addon_type: 'coolant_topoff' } }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(seen.subPatch.standing_addons.sort(), ['coolant_topoff', 'exterior_wash']);
  assert.equal(seen.inserts.length, 1);
  const rows = seen.inserts[0];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].addon_type, 'coolant_topoff');
  assert.equal(rows[0].service_visit_id, VISIT_ID);
  assert.equal(rows[0].status, 'pending');
  assert.equal(rows[0].amount_cents, 9500);
});

test('standing enroll: rejects a non-recurring type', async () => {
  restore = installMockSupabase({
    generator_service_visits: visitResolver(),
  });
  const res = makeRes();
  await standingOn(techReq({ params: { addon_type: 'battery_replacement' } }), res);
  assert.equal(res.statusCode, 400);
});

test('standing unenroll: removes from the set and cancels ONLY a still-pending row on the open visit', async () => {
  const seen = {};
  restore = installMockSupabase({
    generator_service_visits: visitResolver(),
    generator_subscriptions: (chain) => {
      const update = chain.find((c) => c.method === 'update');
      if (update) { seen.subPatch = update.args[0]; return { data: null, error: null }; }
      return { data: { id: SUB_ID, gen_class: 'air_cooled', status: 'active', standing_addons: ['exterior_wash', 'ats_outage_combined'] }, error: null };
    },
    generator_pending_addons: (chain) => {
      const update = chain.find((c) => c.method === 'update');
      if (update) {
        seen.rowPatch = update.args[0];
        seen.rowFilters = chain.filter((c) => c.method === 'eq').map((c) => c.args);
      }
      return { data: null, error: null };
    },
  });
  const res = makeRes();
  await standingOff(techReq({ params: { addon_type: 'exterior_wash' } }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(seen.subPatch.standing_addons, ['ats_outage_combined']);
  assert.equal(seen.rowPatch.status, 'canceled');
  // The cancel is scoped: this sub, this open visit, this type, pending only.
  assert.deepEqual(seen.rowFilters, [
    ['subscription_id', SUB_ID],
    ['service_visit_id', VISIT_ID],
    ['addon_type', 'exterior_wash'],
    ['status', 'pending'],
  ]);
});
