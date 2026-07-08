// Unit tests for lib/planChange.js — the single owner of every Generator Care
// subscription plan/tier/fleet mutation (formerly duplicated between the
// office and customer routes; see git history for the pre-unification split).
// Stripe is a hand-rolled recording fake passed in as a parameter; Supabase is
// mocked by swapping lib/supabase.js's shared client — nothing here makes a
// live call.
require('./helpers/env');

const test = require('node:test');
const assert = require('node:assert/strict');

const { installMockSupabase } = require('./helpers/mockSupabase');
const { createMockStripe } = require('./helpers/mockStripe');
const planChange = require('../lib/planChange');
const catalog = require('../lib/generator-catalog');

const AIR_SEMI = catalog.SUBSCRIPTION_CATALOG.air_cooled.semi_annual; // 38000
const AIR_ANNUAL = catalog.SUBSCRIPTION_CATALOG.air_cooled.annual; // 39500
const LIQ_SEMI = catalog.SUBSCRIPTION_CATALOG.liquid_22_38.semi_annual; // 54000
const FLEET_SEMI = catalog.FLEET_CATALOG.semi_annual; // 3250
const FLEET_ANNUAL = catalog.FLEET_CATALOG.annual; // 6500

function planItem(entry, overrides = {}) {
  return { id: 'si_plan', price: { id: entry.price_id }, quantity: 1, ...overrides };
}
function fleetItem(entry, overrides = {}) {
  return { id: 'si_fleet', price: { id: entry.price_id }, quantity: 1, ...overrides };
}

let restoreSupabase;
test.afterEach(() => {
  if (restoreSupabase) { restoreSupabase(); restoreSupabase = undefined; }
});

// =====================================================================
// changePlanAtRenewal
// =====================================================================

test('changePlanAtRenewal: rejects an invalid new_plan without touching Stripe', async () => {
  const stripe = createMockStripe();
  const result = await planChange.changePlanAtRenewal({
    stripe, subRow: { status: 'active', stripe_subscription_id: 'sub_1', gen_class: 'air_cooled', plan: 'semi_annual' },
    newPlan: 'monthly',
  });
  assert.equal(result.status, 400);
  assert.match(result.error, /new_plan must be/);
  assert.equal(stripe.subscriptions.retrieve.calls.length, 0);
});

test('changePlanAtRenewal: refuses on a canceled subscription row', async () => {
  const stripe = createMockStripe();
  const result = await planChange.changePlanAtRenewal({
    stripe, subRow: { status: 'canceled', stripe_subscription_id: 'sub_1', gen_class: 'air_cooled', plan: 'semi_annual' },
    newPlan: 'annual',
  });
  assert.equal(result.status, 400);
  assert.match(result.error, /canceled/);
});

test('changePlanAtRenewal: refuses when already on the requested plan', async () => {
  const stripe = createMockStripe();
  const result = await planChange.changePlanAtRenewal({
    stripe, subRow: { status: 'active', stripe_subscription_id: 'sub_1', gen_class: 'air_cooled', plan: 'annual' },
    newPlan: 'annual',
  });
  assert.equal(result.status, 400);
  assert.match(result.error, /already on that plan/);
});

test('changePlanAtRenewal: refuses when the live Stripe subscription is canceled', async () => {
  const stripe = createMockStripe({
    subscriptionsRetrieve: async () => ({ status: 'canceled', items: { data: [] } }),
  });
  const result = await planChange.changePlanAtRenewal({
    stripe, subRow: { status: 'active', stripe_subscription_id: 'sub_1', gen_class: 'air_cooled', plan: 'semi_annual' },
    newPlan: 'annual',
  });
  assert.equal(result.status, 400);
  assert.match(result.error, /Stripe subscription is canceled/);
});

test('changePlanAtRenewal: 409s with a typed code when a schedule is already pending', async () => {
  const stripe = createMockStripe({
    subscriptionsRetrieve: async () => ({
      status: 'active',
      items: { data: [planItem(AIR_SEMI)] },
      schedule: { id: 'sub_sched_1', status: 'active' },
    }),
  });
  const result = await planChange.changePlanAtRenewal({
    stripe, subRow: { status: 'active', stripe_subscription_id: 'sub_1', gen_class: 'air_cooled', plan: 'semi_annual' },
    newPlan: 'annual',
  });
  assert.equal(result.status, 409);
  assert.equal(result.code, 'pending_schedule');
  assert.equal(result.error, planChange.PENDING_SCHEDULE_MESSAGE);
  // Refuses before touching the schedule further.
  assert.equal(stripe.subscriptionSchedules.update.calls.length, 0);
});

test('changePlanAtRenewal: also 409s when the pending schedule is not_started', async () => {
  const stripe = createMockStripe({
    subscriptionsRetrieve: async () => ({
      status: 'active',
      items: { data: [planItem(AIR_SEMI)] },
      schedule: { id: 'sub_sched_1', status: 'not_started' },
    }),
  });
  const result = await planChange.changePlanAtRenewal({
    stripe, subRow: { status: 'active', stripe_subscription_id: 'sub_1', gen_class: 'air_cooled', plan: 'semi_annual' },
    newPlan: 'annual',
  });
  assert.equal(result.status, 409);
  assert.equal(result.code, 'pending_schedule');
});

test('changePlanAtRenewal: happy path creates a schedule and rebuilds phases (no fleet)', async () => {
  const stripe = createMockStripe({
    subscriptionsRetrieve: async () => ({
      status: 'active', schedule: null, items: { data: [planItem(AIR_SEMI)] },
    }),
    schedulesCreate: async () => ({ id: 'sub_sched_new' }),
    schedulesRetrieve: async () => ({ phases: [{ start_date: 1000, end_date: 2000 }] }),
    schedulesUpdate: async (id, params) => ({ id, ...params }),
  });
  const result = await planChange.changePlanAtRenewal({
    stripe, subRow: { status: 'active', stripe_subscription_id: 'sub_1', gen_class: 'air_cooled', plan: 'semi_annual' },
    newPlan: 'annual',
  });
  assert.equal(result.ok, true);
  assert.equal(result.new_plan, 'annual');
  assert.equal(result.schedule_id, 'sub_sched_new');
  assert.equal(result.new_renewal_amount_cents, AIR_ANNUAL.amount_cents);
  assert.equal(result.effective_date, new Date(2000 * 1000).toISOString().slice(0, 10));

  assert.deepEqual(stripe.subscriptionSchedules.create.calls[0][0], { from_subscription: 'sub_1' });
  const [scheduleId, updateParams] = stripe.subscriptionSchedules.update.calls[0];
  assert.equal(scheduleId, 'sub_sched_new');
  assert.equal(updateParams.end_behavior, 'release');
  assert.equal(updateParams.proration_behavior, 'none');
  assert.deepEqual(updateParams.phases, [
    { items: [{ price: AIR_SEMI.price_id, quantity: 1 }], start_date: 1000, end_date: 2000 },
    { items: [{ price: AIR_ANNUAL.price_id, quantity: 1 }] },
  ]);
});

test('changePlanAtRenewal: happy path carries Fleet to the matching new-cadence price', async () => {
  const stripe = createMockStripe({
    subscriptionsRetrieve: async () => ({
      status: 'active', schedule: null, items: { data: [planItem(AIR_SEMI), fleetItem(FLEET_SEMI)] },
    }),
    schedulesCreate: async () => ({ id: 'sub_sched_new' }),
    schedulesRetrieve: async () => ({ phases: [{ start_date: 1000, end_date: 2000 }] }),
    schedulesUpdate: async () => ({}),
  });
  const result = await planChange.changePlanAtRenewal({
    stripe, subRow: { status: 'active', stripe_subscription_id: 'sub_1', gen_class: 'air_cooled', plan: 'semi_annual' },
    newPlan: 'annual',
  });
  assert.equal(result.new_renewal_amount_cents, AIR_ANNUAL.amount_cents + FLEET_ANNUAL.amount_cents);
  const [, updateParams] = stripe.subscriptionSchedules.update.calls[0];
  assert.deepEqual(updateParams.phases[1].items, [
    { price: AIR_ANNUAL.price_id, quantity: 1 },
    { price: FLEET_ANNUAL.price_id, quantity: 1 },
  ]);
});

test('changePlanAtRenewal: reuses an existing (non-pending) schedule instead of creating a new one', async () => {
  const stripe = createMockStripe({
    subscriptionsRetrieve: async () => ({
      status: 'active',
      schedule: { id: 'sub_sched_old', status: 'completed' },
      items: { data: [planItem(AIR_SEMI)] },
    }),
    schedulesRetrieve: async () => ({ phases: [{ start_date: 1000, end_date: 2000 }] }),
    schedulesUpdate: async () => ({}),
  });
  const result = await planChange.changePlanAtRenewal({
    stripe, subRow: { status: 'active', stripe_subscription_id: 'sub_1', gen_class: 'air_cooled', plan: 'semi_annual' },
    newPlan: 'annual',
  });
  assert.equal(result.ok, true);
  assert.equal(stripe.subscriptionSchedules.create.calls.length, 0);
  assert.equal(stripe.subscriptionSchedules.retrieve.calls[0][0], 'sub_sched_old');
});

// =====================================================================
// revertPlanChange
// =====================================================================

test('revertPlanChange: 404s without a linked Stripe subscription', async () => {
  const stripe = createMockStripe();
  const result = await planChange.revertPlanChange({ stripe, subRow: { stripe_subscription_id: null } });
  assert.equal(result.status, 404);
});

test('revertPlanChange: refuses when there is nothing pending', async () => {
  const stripe = createMockStripe({
    subscriptionsRetrieve: async () => ({ schedule: null }),
  });
  const result = await planChange.revertPlanChange({ stripe, subRow: { stripe_subscription_id: 'sub_1' } });
  assert.equal(result.status, 400);
  assert.match(result.error, /no pending plan change/);
});

test('revertPlanChange: releases an active schedule', async () => {
  const stripe = createMockStripe({
    subscriptionsRetrieve: async () => ({ schedule: { id: 'sub_sched_1', status: 'active' } }),
    schedulesRelease: async () => ({ status: 'released' }),
  });
  const result = await planChange.revertPlanChange({ stripe, subRow: { stripe_subscription_id: 'sub_1' } });
  assert.equal(result.ok, true);
  assert.equal(result.released, 'released');
  assert.equal(stripe.subscriptionSchedules.release.calls[0][0], 'sub_sched_1');
});

// =====================================================================
// addFleetNow
// =====================================================================

test('addFleetNow: refuses on a canceled subscription row', async () => {
  const stripe = createMockStripe();
  const result = await planChange.addFleetNow({
    stripe, subRow: { id: 'row_1', status: 'canceled', stripe_subscription_id: 'sub_1', gen_class: 'air_cooled' },
  });
  assert.equal(result.status, 400);
});

test('addFleetNow: refuses when Fleet is already attached', async () => {
  const stripe = createMockStripe({
    subscriptionsRetrieve: async () => ({
      status: 'active', schedule: null, items: { data: [planItem(AIR_SEMI), fleetItem(FLEET_SEMI)] },
    }),
  });
  const result = await planChange.addFleetNow({
    stripe, subRow: { id: 'row_1', status: 'active', stripe_subscription_id: 'sub_1', gen_class: 'air_cooled' },
  });
  assert.equal(result.status, 400);
  assert.match(result.error, /already on this subscription/);
});

test('addFleetNow: 409s with a typed code when a schedule is already pending', async () => {
  const stripe = createMockStripe({
    subscriptionsRetrieve: async () => ({
      status: 'active',
      schedule: { id: 'sub_sched_1', status: 'active' },
      items: { data: [planItem(AIR_SEMI)] },
    }),
  });
  const result = await planChange.addFleetNow({
    stripe, subRow: { id: 'row_1', status: 'active', stripe_subscription_id: 'sub_1', gen_class: 'air_cooled' },
  });
  assert.equal(result.status, 409);
  assert.equal(result.code, 'pending_schedule');
  assert.equal(stripe.subscriptionItems.create.calls.length, 0);
});

test('addFleetNow: happy path invoices the proration now and persists fleet_monitoring', async () => {
  restoreSupabase = installMockSupabase({
    generator_subscriptions: (chain) => {
      const isUpdate = chain.some((c) => c.method === 'update');
      assert.equal(isUpdate, true, 'addFleetNow should only touch generator_subscriptions via update');
      const updateCall = chain.find((c) => c.method === 'update');
      assert.equal(updateCall.args[0].fleet_monitoring, true);
      const eqCall = chain.find((c) => c.method === 'eq');
      assert.deepEqual(eqCall.args, ['id', 'row_1']);
      return { data: null, error: null };
    },
  });
  const stripe = createMockStripe({
    subscriptionsRetrieve: async () => ({
      status: 'active', schedule: null, items: { data: [planItem(AIR_SEMI)] },
      current_period_end: 5000,
    }),
  });
  const result = await planChange.addFleetNow({
    stripe, subRow: { id: 'row_1', status: 'active', stripe_subscription_id: 'sub_1', gen_class: 'air_cooled' },
    prorationDate: 4500,
  });
  assert.equal(result.ok, true);
  assert.equal(result.plan, 'semi_annual');
  assert.equal(result.combined_renewal_cents, AIR_SEMI.amount_cents + FLEET_SEMI.amount_cents);
  const [itemParams] = stripe.subscriptionItems.create.calls[0];
  assert.equal(itemParams.subscription, 'sub_1');
  assert.equal(itemParams.price, FLEET_SEMI.price_id);
  assert.equal(itemParams.proration_behavior, 'always_invoice');
  assert.equal(itemParams.proration_date, 4500);
});

// =====================================================================
// removeFleetAtRenewal
// =====================================================================

test('removeFleetAtRenewal: refuses when Fleet is not attached', async () => {
  const stripe = createMockStripe({
    subscriptionsRetrieve: async () => ({ status: 'active', schedule: null, items: { data: [planItem(AIR_SEMI)] } }),
  });
  const result = await planChange.removeFleetAtRenewal({
    stripe, subRow: { id: 'row_1', status: 'active', stripe_subscription_id: 'sub_1', gen_class: 'air_cooled' },
  });
  assert.equal(result.status, 400);
  assert.match(result.error, /not on this subscription/);
});

test('removeFleetAtRenewal: 409s with a typed code when a schedule is already pending', async () => {
  const stripe = createMockStripe({
    subscriptionsRetrieve: async () => ({
      status: 'active',
      schedule: { id: 'sub_sched_1', status: 'active' },
      items: { data: [planItem(AIR_SEMI), fleetItem(FLEET_SEMI)] },
    }),
  });
  const result = await planChange.removeFleetAtRenewal({
    stripe, subRow: { id: 'row_1', status: 'active', stripe_subscription_id: 'sub_1', gen_class: 'air_cooled' },
  });
  assert.equal(result.status, 409);
  assert.equal(result.code, 'pending_schedule');
});

test('removeFleetAtRenewal: happy path schedules Fleet off at renewal, no DB write', async () => {
  restoreSupabase = installMockSupabase({
    generator_subscriptions: () => { throw new Error('removeFleetAtRenewal must not touch the DB (matches pre-unification behavior)'); },
  });
  const stripe = createMockStripe({
    subscriptionsRetrieve: async () => ({
      status: 'active', schedule: null, items: { data: [planItem(AIR_SEMI), fleetItem(FLEET_SEMI)] },
    }),
    schedulesCreate: async () => ({ id: 'sub_sched_new' }),
    schedulesRetrieve: async () => ({ phases: [{ start_date: 1000, end_date: 2000 }] }),
    schedulesUpdate: async () => ({}),
  });
  const result = await planChange.removeFleetAtRenewal({
    stripe, subRow: { id: 'row_1', status: 'active', stripe_subscription_id: 'sub_1', gen_class: 'air_cooled' },
  });
  assert.equal(result.ok, true);
  assert.equal(result.new_renewal_amount_cents, AIR_SEMI.amount_cents);
  const [, updateParams] = stripe.subscriptionSchedules.update.calls[0];
  assert.deepEqual(updateParams.phases[1].items, [{ price: AIR_SEMI.price_id, quantity: 1 }]);
});

// =====================================================================
// tierChangePreview / applyTierChange
// =====================================================================

const TIER_SUB_ROW = {
  id: 'row_1', stripe_subscription_id: 'sub_1', stripe_customer_id: 'cus_1',
  gen_class: 'air_cooled', plan: 'semi_annual', status: 'active',
};

test('tierChangePreview: refuses when already on that tier', async () => {
  const stripe = createMockStripe();
  const result = await planChange.tierChangePreview({ stripe, subRow: TIER_SUB_ROW, newGenClass: 'air_cooled' });
  assert.equal(result.status, 400);
});

test('tierChangePreview: 409s with a typed code when a schedule is already pending', async () => {
  const stripe = createMockStripe({
    subscriptionsRetrieve: async () => ({
      status: 'active',
      schedule: { id: 'sub_sched_1', status: 'active' },
      items: { data: [planItem(AIR_SEMI)] },
    }),
  });
  const result = await planChange.tierChangePreview({ stripe, subRow: TIER_SUB_ROW, newGenClass: 'liquid_22_38' });
  assert.equal(result.status, 409);
  assert.equal(result.code, 'pending_schedule');
});

test('tierChangePreview: upgrade previews a charge for the flat catalog difference', async () => {
  const stripe = createMockStripe({
    subscriptionsRetrieve: async () => ({ status: 'active', schedule: null, items: { data: [planItem(AIR_SEMI)] } }),
  });
  const result = await planChange.tierChangePreview({ stripe, subRow: TIER_SUB_ROW, newGenClass: 'liquid_22_38' });
  assert.equal(result.ok, true);
  assert.equal(result.direction, 'charge');
  assert.equal(result.charge_now_cents, LIQ_SEMI.amount_cents - AIR_SEMI.amount_cents);
  assert.equal(result.credit_cents, 0);
  assert.equal(result.new_renewal_cents, LIQ_SEMI.amount_cents);
});

test('tierChangePreview: downgrade previews a credit for the flat catalog difference', async () => {
  const stripe = createMockStripe({
    subscriptionsRetrieve: async () => ({ status: 'active', schedule: null, items: { data: [planItem(LIQ_SEMI)] } }),
  });
  const result = await planChange.tierChangePreview({
    stripe, subRow: { ...TIER_SUB_ROW, gen_class: 'liquid_22_38' }, newGenClass: 'air_cooled',
  });
  assert.equal(result.direction, 'credit');
  assert.equal(result.credit_cents, LIQ_SEMI.amount_cents - AIR_SEMI.amount_cents);
  assert.equal(result.charge_now_cents, 0);
});

test('applyTierChange: upgrade with no saved card blocks the charge and emails a card-update link', async () => {
  const stripe = createMockStripe({
    subscriptionsRetrieve: async () => ({ status: 'active', schedule: null, items: { data: [planItem(AIR_SEMI)] } }),
  });
  const result = await planChange.applyTierChange({
    stripe, subRow: TIER_SUB_ROW, newGenClass: 'liquid_22_38',
    resolveSavedPaymentMethod: async () => null,
    emailCardUpdateLinkForSub: async () => ({ sent: true }),
    tierLabel: (gc) => gc,
  });
  assert.equal(result.status, 402);
  assert.equal(result.error, 'no saved card on file');
  assert.equal(result.card_update_email_sent, true);
  assert.equal(stripe.invoices.create.calls.length, 0);
});

test('applyTierChange: upgrade happy path charges the exact catalog delta and swaps the price', async () => {
  restoreSupabase = installMockSupabase({
    generator_subscriptions: (chain) => {
      const updateCall = chain.find((c) => c.method === 'update');
      assert.equal(updateCall.args[0].gen_class, 'liquid_22_38');
      return { data: null, error: null };
    },
  });
  const stripe = createMockStripe({
    subscriptionsRetrieve: async () => ({ status: 'active', schedule: null, items: { data: [planItem(AIR_SEMI)] } }),
    invoicesCreate: async () => ({ id: 'in_1' }),
    invoicesFinalize: async (id) => ({ id }),
    invoicesPay: async (id) => ({ id, status: 'paid' }),
  });
  const result = await planChange.applyTierChange({
    stripe, subRow: TIER_SUB_ROW, newGenClass: 'liquid_22_38',
    resolveSavedPaymentMethod: async () => 'pm_1',
    emailCardUpdateLinkForSub: async () => ({ sent: false }),
    tierLabel: (gc) => gc,
  });
  assert.equal(result.ok, true);
  assert.equal(result.new_gen_class, 'liquid_22_38');
  assert.equal(result.charged_cents, LIQ_SEMI.amount_cents - AIR_SEMI.amount_cents);
  assert.equal(result.credited_cents, 0);

  const [invoiceItemParams] = stripe.invoices.create.calls[0];
  assert.equal(invoiceItemParams.customer, 'cus_1');
  assert.equal(invoiceItemParams.default_payment_method, 'pm_1');
  const [, subUpdateParams] = stripe.subscriptions.update.calls[0];
  assert.equal(subUpdateParams.items[0].price, LIQ_SEMI.price_id);
  assert.equal(subUpdateParams.proration_behavior, 'none');
});

test('applyTierChange: a failed charge voids the draft invoice and reports the reason', async () => {
  const stripe = createMockStripe({
    subscriptionsRetrieve: async () => ({ status: 'active', schedule: null, items: { data: [planItem(AIR_SEMI)] } }),
    invoicesCreate: async () => ({ id: 'in_1' }),
    invoicesFinalize: async () => { throw new Error('card declined'); },
  });
  const result = await planChange.applyTierChange({
    stripe, subRow: TIER_SUB_ROW, newGenClass: 'liquid_22_38',
    resolveSavedPaymentMethod: async () => 'pm_1',
    emailCardUpdateLinkForSub: async () => ({ sent: false }),
    tierLabel: (gc) => gc,
  });
  assert.equal(result.status, 402);
  assert.equal(result.error, 'tier-correction charge failed');
  assert.equal(result.reason, 'card declined');
  assert.equal(stripe.invoices.voidInvoice.calls[0][0], 'in_1');
  assert.equal(stripe.subscriptions.update.calls.length, 0, 'must not swap the price after a failed charge');
});

test('applyTierChange: downgrade happy path credits the account and swaps the price', async () => {
  restoreSupabase = installMockSupabase({
    generator_subscriptions: () => ({ data: null, error: null }),
  });
  const stripe = createMockStripe({
    subscriptionsRetrieve: async () => ({ status: 'active', schedule: null, items: { data: [planItem(LIQ_SEMI)] } }),
  });
  const result = await planChange.applyTierChange({
    stripe, subRow: { ...TIER_SUB_ROW, gen_class: 'liquid_22_38' }, newGenClass: 'air_cooled',
    resolveSavedPaymentMethod: async () => { throw new Error('must not be called on a downgrade'); },
    emailCardUpdateLinkForSub: async () => ({ sent: false }),
    tierLabel: (gc) => gc,
  });
  assert.equal(result.ok, true);
  assert.equal(result.credited_cents, LIQ_SEMI.amount_cents - AIR_SEMI.amount_cents);
  assert.equal(result.charged_cents, 0);
  const [balanceParams] = stripe.customers.createBalanceTransaction.calls[0];
  assert.equal(balanceParams.amount, AIR_SEMI.amount_cents - LIQ_SEMI.amount_cents); // negative = credit
  const [, subUpdateParams] = stripe.subscriptions.update.calls[0];
  assert.equal(subUpdateParams.items[0].price, AIR_SEMI.price_id);
});

// =====================================================================
// computePlanBilling
// =====================================================================

test('computePlanBilling: no schedule -> current renewal only, no pending_change', () => {
  const billing = planChange.computePlanBilling({
    current_period_end: 5000,
    items: { data: [planItem(AIR_SEMI)] },
    schedule: null,
  });
  assert.equal(billing.current_period_end, new Date(5000 * 1000).toISOString().slice(0, 10));
  assert.equal(billing.current_renewal_amount_cents, AIR_SEMI.amount_cents);
  assert.equal(billing.current_has_fleet, false);
  assert.equal(billing.pending_change, null);
});

test('computePlanBilling: fleet attached is reflected in the current renewal amount', () => {
  const billing = planChange.computePlanBilling({
    current_period_end: 5000,
    items: { data: [planItem(AIR_SEMI), fleetItem(FLEET_SEMI)] },
    schedule: null,
  });
  assert.equal(billing.current_has_fleet, true);
  assert.equal(billing.current_renewal_amount_cents, AIR_SEMI.amount_cents + FLEET_SEMI.amount_cents);
});

test('computePlanBilling: an active schedule with a future plan change surfaces pending_change', () => {
  const billing = planChange.computePlanBilling({
    current_period_end: 2000,
    items: { data: [planItem(AIR_SEMI)] },
    schedule: {
      status: 'active',
      current_phase: { end_date: 2000 },
      phases: [
        { start_date: 1000, end_date: 2000, items: [{ price: AIR_SEMI.price_id }] },
        { start_date: 2000, items: [{ price: AIR_ANNUAL.price_id }] },
      ],
    },
  });
  assert.ok(billing.pending_change);
  assert.equal(billing.pending_change.new_plan, 'annual');
  assert.equal(billing.pending_change.plan_changed, true);
  assert.equal(billing.pending_change.fleet_change, null);
  assert.equal(billing.pending_change.new_renewal_amount_cents, AIR_ANNUAL.amount_cents);
});

test('computePlanBilling: a schedule that only removes Fleet surfaces fleet_change without plan_changed', () => {
  const billing = planChange.computePlanBilling({
    current_period_end: 2000,
    items: { data: [planItem(AIR_SEMI), fleetItem(FLEET_SEMI)] },
    schedule: {
      status: 'active',
      current_phase: { end_date: 2000 },
      phases: [
        { start_date: 1000, end_date: 2000, items: [{ price: AIR_SEMI.price_id }, { price: FLEET_SEMI.price_id }] },
        { start_date: 2000, items: [{ price: AIR_SEMI.price_id }] },
      ],
    },
  });
  assert.ok(billing.pending_change);
  assert.equal(billing.pending_change.plan_changed, false);
  assert.equal(billing.pending_change.fleet_change, 'removing');
  assert.equal(billing.pending_change.new_has_fleet, false);
});

test('computePlanBilling: a released/completed schedule does not surface a pending_change', () => {
  const billing = planChange.computePlanBilling({
    current_period_end: 2000,
    items: { data: [planItem(AIR_SEMI)] },
    schedule: { status: 'released', phases: [] },
  });
  assert.equal(billing.pending_change, null);
});
