// Surfacing the tech's completed service checklist (sql/029) on the customer
// dashboard + office visit detail — offline tests through the real shipped
// handlers. Pins CJ's display rule at the payload layer:
//   - completed_services = ONLY the labels the tech CHECKED, intersected with
//     the current planVisitItems list (catalog order, de-duped, stale labels
//     dropped) — nothing about unchecked items ever leaves the backend;
//   - legacy/empty visits send completed_services: [] while plan.visit_items
//     (the static fallback list) keeps flowing, so old history never blanks;
//   - open visits send [] (mid-visit ticks never surface early);
//   - office subscription detail carries the same normalized list per visit.
require('./helpers/env');

const test = require('node:test');
const assert = require('node:assert/strict');

const { installMockSupabase } = require('./helpers/mockSupabase');
const { getRouteHandler, makeReq, makeRes } = require('./helpers/routeHandler');
const { planVisitItems } = require('../lib/generator-catalog');

const customerRouter = require('../routes/customer');
const subscriptionsRouter = require('../routes/generator-care/subscriptions');

const overviewHandler = getRouteHandler(customerRouter, 'get', '/overview');
const detailHandler = getRouteHandler(subscriptionsRouter, 'get', '/subscriptions/:id');

const CUSTOMER_ID = 'c0000000-0000-4000-8000-000000000001';
const SUB_ID = 'b0000000-0000-4000-8000-000000000010';
const EMAIL = 'customer@example.com';

const AIR = planVisitItems('air_cooled'); // 9 items, canonical order

let restore;
test.afterEach(() => { if (restore) { restore(); restore = undefined; } });

// ---- customer /overview ----

function overviewWorld({ visits } = {}) {
  restore = installMockSupabase({
    generator_customers: () => ({
      data: [{
        id: CUSTOMER_ID, name: 'Sarah Example', email: EMAIL, phone: null,
        install_address: 'x', install_city: 'x', install_state: 'MO', install_zip: 'x',
        stripe_customer_id: 'cus_1',
      }],
      error: null,
    }),
    generator_subscriptions: () => ({
      data: [{
        id: SUB_ID, customer_id: CUSTOMER_ID, status: 'active', signup_date: '2026-06-01',
        plan: 'annual', gen_class: 'air_cooled', standing_addons: [], raw_metadata: {},
        stripe_customer_id: 'cus_1', stripe_subscription_id: 'stripe-sub-1',
      }],
      error: null,
    }),
    generator_service_visits: () => ({ data: visits || [], error: null }),
    generator_visit_photos: () => ({ data: [], error: null }),
    generator_pending_addons: () => ({ data: [], error: null }),
    generator_visit_preferences: () => ({ data: null, error: null }),
  });
}

const custReq = () => makeReq({ user: { email: EMAIL } });

test('completed visit: completed_services = only the CHECKED labels, catalog order, de-duped, stale labels dropped', async () => {
  overviewWorld({
    visits: [{
      id: 'v1', visit_type: 'regular_service', status: 'completed',
      scheduled_date: '2026-07-01', appointment_at: null, arrival_window: null,
      completed_date: '2026-07-02', notes: null,
      // Out of catalog order, one duplicate, one label no longer in the catalog.
      completed_checklist: [AIR[6], 'A removed legacy item', AIR[2], AIR[2], AIR[0]],
    }],
  });
  const res = makeRes();
  await overviewHandler(custReq(), res);

  assert.equal(res.statusCode, 200);
  const v = res.body.visits[0];
  assert.deepEqual(v.completed_services, [AIR[0], AIR[2], AIR[6]],
    'exactly the checked-and-current labels, in catalog order');
  assert.ok(!v.completed_services.includes('A removed legacy item'),
    'a removed catalog label never surfaces');
  // The static fallback list keeps flowing unchanged next to it.
  assert.deepEqual(res.body.plan.visit_items, AIR);
});

test('legacy completed visit (no checklist): completed_services is [] so the frontend falls back to the static list', async () => {
  overviewWorld({
    visits: [{
      id: 'v1', visit_type: 'regular_service', status: 'completed',
      scheduled_date: '2026-01-01', appointment_at: null, arrival_window: null,
      completed_date: '2026-01-02', notes: null,
      completed_checklist: null, // pre-029 rows read as null through the select
    }],
  });
  const res = makeRes();
  await overviewHandler(custReq(), res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.visits[0].completed_services, []);
  assert.deepEqual(res.body.plan.visit_items, AIR, 'the fallback list is still there');
});

test('open visit: mid-visit ticks never surface — completed_services is [] until the visit completes', async () => {
  overviewWorld({
    visits: [{
      id: 'v1', visit_type: 'regular_service', status: 'scheduled',
      scheduled_date: '2026-08-01', appointment_at: '2026-08-01T13:00:00Z', arrival_window: '8-10',
      completed_date: null, notes: null,
      completed_checklist: [AIR[0], AIR[1]], // tech is mid-visit
    }],
  });
  const res = makeRes();
  await overviewHandler(custReq(), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.visits[0].status, 'scheduled');
  assert.deepEqual(res.body.visits[0].completed_services, []);
});

test('completed on-demand visit: checked services still surface (accurate record of what was done)', async () => {
  overviewWorld({
    visits: [{
      id: 'v1', visit_type: 'on_demand', status: 'completed',
      scheduled_date: '2026-07-01', appointment_at: null, arrival_window: null,
      completed_date: '2026-07-02', notes: null,
      completed_checklist: [AIR[5]],
    }],
  });
  const res = makeRes();
  await overviewHandler(custReq(), res);

  assert.equal(res.statusCode, 200);
  const v = res.body.visits[0];
  assert.equal(v.is_plan_visit, false);
  assert.deepEqual(v.completed_services, [AIR[5]]);
});

// ---- office subscription detail ----

test('office detail: every visit carries completed_services normalized against the current plan list', async () => {
  restore = installMockSupabase({
    generator_subscriptions: () => ({
      data: {
        id: SUB_ID, gen_class: 'air_cooled', standing_addons: [], plan: 'annual',
        customer: { id: CUSTOMER_ID, name: 'Sarah Example' },
      },
      error: null,
    }),
    generator_service_visits: () => ({
      data: [
        {
          id: 'v1', subscription_id: SUB_ID, status: 'completed', visit_type: 'regular_service',
          scheduled_date: '2026-07-01', completed_date: '2026-07-02',
          completed_checklist: [AIR[3], 'A removed legacy item', AIR[1]],
        },
        {
          id: 'v2', subscription_id: SUB_ID, status: 'scheduled', visit_type: 'regular_service',
          scheduled_date: '2026-12-01', completed_date: null,
          completed_checklist: null,
        },
      ],
      error: null,
    }),
    generator_pending_addons: () => ({ data: [], error: null }),
    generator_adhoc_charges: () => ({ data: [], error: null }),
    generator_visit_preferences: () => ({ data: [], error: null }),
    generator_sms_consent: () => ({ data: [], error: null }),
    generator_sms_messages: () => ({ data: [], error: null }),
  });
  const res = makeRes();
  await detailHandler(makeReq({ params: { id: SUB_ID } }), res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.visits[0].completed_services, [AIR[1], AIR[3]],
    'checked-and-current labels only, catalog order');
  assert.deepEqual(res.body.visits[1].completed_services, [],
    'a visit with no checklist reads as an empty list, never breaks the payload');
});
