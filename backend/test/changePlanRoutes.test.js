// Route-level tests for the office and customer change-plan endpoints. These
// call the REAL, shipped Express handlers directly (extracted off the router
// via test/helpers/routeHandler.js, bypassing the requireAuth/requirePermission
// middleware that's applied one layer up — see routes/generator-care/index.js
// and routes/customer.js's own router.use) with a fake req/res.
//
// The point: prove BOTH entry points share the exact same 409 pending-schedule
// guard now that they both call lib/planChange.js, while each surface still
// renders its own audience-appropriate message — office keeps the original
// "undo it first" text, the customer gets a message that routes them to the
// office instead of a dead-end self-service instruction.
require('./helpers/env');

const test = require('node:test');
const assert = require('node:assert/strict');

const { installMockSupabase } = require('./helpers/mockSupabase');
const { getRouteHandler, makeReq, makeRes } = require('./helpers/routeHandler');
const { PENDING_SCHEDULE_MESSAGE } = require('../lib/planChange');
const catalog = require('../lib/generator-catalog');

const AIR_SEMI = catalog.SUBSCRIPTION_CATALOG.air_cooled.semi_annual;
const AIR_ANNUAL = catalog.SUBSCRIPTION_CATALOG.air_cooled.annual;

let restoreSupabase;
let restoreStripe = [];
test.afterEach(() => {
  if (restoreSupabase) { restoreSupabase(); restoreSupabase = undefined; }
  restoreStripe.forEach((r) => r());
  restoreStripe = [];
});

// Monkey-patches specific methods on the shared lib/gcShared.js Stripe
// singleton both routers import — the routes don't accept Stripe as a
// parameter, so this is the only seam available without changing the routes.
function patchStripe(overrides) {
  const { stripe } = require('../lib/gcShared');
  for (const [resource, methods] of Object.entries(overrides)) {
    for (const [method, impl] of Object.entries(methods)) {
      const original = stripe[resource][method];
      stripe[resource][method] = impl;
      restoreStripe.push(() => { stripe[resource][method] = original; });
    }
  }
}

function pendingScheduleStripe() {
  patchStripe({
    subscriptions: {
      retrieve: async () => ({
        status: 'active',
        schedule: { id: 'sub_sched_1', status: 'active' },
        items: { data: [{ id: 'si_1', price: { id: AIR_SEMI.price_id }, quantity: 1 }] },
      }),
    },
  });
}

function happyPathStripe() {
  patchStripe({
    subscriptions: {
      retrieve: async () => ({
        status: 'active',
        schedule: null,
        items: { data: [{ id: 'si_1', price: { id: AIR_SEMI.price_id }, quantity: 1 }] },
      }),
    },
    subscriptionSchedules: {
      create: async () => ({ id: 'sub_sched_new' }),
      retrieve: async () => ({ phases: [{ start_date: 1000, end_date: 2000 }] }),
      update: async () => ({}),
    },
  });
}

const SUB_ROW = {
  id: 'row_1', stripe_subscription_id: 'sub_1', gen_class: 'air_cooled', plan: 'semi_annual', status: 'active',
};

test('office change-plan: pending schedule -> 409 with the original office message, no field leak', async () => {
  restoreSupabase = installMockSupabase({
    generator_subscriptions: () => ({ data: SUB_ROW, error: null }),
  });
  pendingScheduleStripe();

  const subscriptionsRouter = require('../routes/generator-care/subscriptions');
  const handler = getRouteHandler(subscriptionsRouter, 'post', '/subscriptions/:id/change-plan');
  const req = makeReq({ params: { id: 'row_1' }, body: { new_plan: 'annual' } });
  const res = makeRes();
  await handler(req, res);

  assert.equal(res.statusCode, 409);
  assert.deepEqual(res.body, { error: PENDING_SCHEDULE_MESSAGE });
});

test('customer change-plan: pending schedule -> 409 with a friendly office-referral message, no field leak', async () => {
  restoreSupabase = installMockSupabase({
    generator_customers: () => ({ data: [{ id: 'cust_1', name: 'Jane Doe', email: 'jane@example.com' }], error: null }),
    generator_subscriptions: () => ({ data: [SUB_ROW], error: null }),
  });
  pendingScheduleStripe();

  const customerRouter = require('../routes/customer');
  const handler = getRouteHandler(customerRouter, 'post', '/change-plan');
  const req = makeReq({ body: { new_plan: 'annual' }, user: { email: 'jane@example.com' } });
  const res = makeRes();
  await handler(req, res);

  assert.equal(res.statusCode, 409);
  assert.notEqual(res.body.error, PENDING_SCHEDULE_MESSAGE, 'customer must not see the office-facing "undo it first" text — they cannot self-clear it');
  assert.match(res.body.error, /contact our office/i);
  assert.deepEqual(Object.keys(res.body), ['error'], 'no code/status leak into the JSON body');
});

test('office change-plan: happy path returns the full field set including schedule_id', async () => {
  restoreSupabase = installMockSupabase({
    generator_subscriptions: () => ({ data: SUB_ROW, error: null }),
  });
  happyPathStripe();

  const subscriptionsRouter = require('../routes/generator-care/subscriptions');
  const handler = getRouteHandler(subscriptionsRouter, 'post', '/subscriptions/:id/change-plan');
  const req = makeReq({ params: { id: 'row_1' }, body: { new_plan: 'annual' } });
  const res = makeRes();
  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.new_plan, 'annual');
  assert.equal(res.body.schedule_id, 'sub_sched_new');
  assert.equal(res.body.new_renewal_amount_cents, AIR_ANNUAL.amount_cents);
});

test('customer change-plan: happy path never leaks the Stripe schedule id', async () => {
  restoreSupabase = installMockSupabase({
    generator_customers: () => ({ data: [{ id: 'cust_1', name: 'Jane Doe', email: 'jane@example.com' }], error: null }),
    generator_subscriptions: () => ({ data: [SUB_ROW], error: null }),
  });
  happyPathStripe();

  const customerRouter = require('../routes/customer');
  const handler = getRouteHandler(customerRouter, 'post', '/change-plan');
  const req = makeReq({ body: { new_plan: 'annual' }, user: { email: 'jane@example.com' } });
  const res = makeRes();
  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.new_plan, 'annual');
  assert.equal(res.body.new_renewal_amount_cents, AIR_ANNUAL.amount_cents);
  assert.equal('schedule_id' in res.body, false, 'customer-facing response must never include the Stripe schedule id');
});
