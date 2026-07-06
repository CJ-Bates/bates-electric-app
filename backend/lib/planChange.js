// backend/lib/planChange.js
// Change a subscription's plan (semi_annual <-> annual) AT NEXT RENEWAL via a
// Stripe subscription schedule: phase 0 preserves today's items to period end,
// phase 1 starts the new plan (+ matching-cadence fleet price when attached).
// proration none, no charge today, end_behavior release.
//
// MIRRORS the office POST /subscriptions/:id/change-plan handler in
// routes/generator-care/subscriptions.js — office routes are deliberately
// untouched by the customer-portal lane, so the mechanics are duplicated here.
// If you change one, change both.
//
// opts: { stripe, subRow: { stripe_subscription_id, gen_class, plan, status },
//         newPlan }
// Returns { ok, effective_date, new_renewal_amount_cents } or
//         { error, status } for caller-facing 4xx conditions. Throws on
//         unexpected Stripe/DB failures.

const catalog = require('./generator-catalog');

async function changePlanAtRenewal({ stripe, subRow, newPlan }) {
  if (!catalog.PLANS.includes(newPlan)) {
    return { error: "new_plan must be 'semi_annual' or 'annual'", status: 400 };
  }
  if (subRow.status === 'canceled') {
    return { error: 'subscription is canceled; cannot change plan', status: 400 };
  }
  if (!subRow.stripe_subscription_id) {
    return { error: 'no Stripe subscription linked', status: 400 };
  }
  if (subRow.plan === newPlan) {
    return { error: 'subscription is already on that plan', status: 400 };
  }
  const newPlanEntry = catalog.planEntry(subRow.gen_class, newPlan);
  if (!newPlanEntry) {
    return { error: `no ${newPlan} price for gen_class ${subRow.gen_class}`, status: 400 };
  }

  const subscription = await stripe.subscriptions.retrieve(
    subRow.stripe_subscription_id, { expand: ['schedule'] }
  );
  if (subscription.status === 'canceled') {
    return { error: 'Stripe subscription is canceled', status: 400 };
  }

  const items = (subscription.items && subscription.items.data) || [];
  const hasFleet = items.some((it) => catalog.isFleetPriceId(it.price.id));

  // Phase 0 = current items, preserved until the period end (no change today).
  const phase0Items = items.map((it) => ({ price: it.price.id, quantity: it.quantity || 1 }));
  // Phase 1 = new plan price (+ matching-cadence fleet price if attached).
  const phase1Items = [{ price: newPlanEntry.price_id, quantity: 1 }];
  if (hasFleet) phase1Items.push({ price: catalog.FLEET_CATALOG[newPlan].price_id, quantity: 1 });

  let scheduleId = subscription.schedule
    && (typeof subscription.schedule === 'string' ? subscription.schedule : subscription.schedule.id);
  if (!scheduleId) {
    const created = await stripe.subscriptionSchedules.create({ from_subscription: subRow.stripe_subscription_id });
    scheduleId = created.id;
  }
  const sched = await stripe.subscriptionSchedules.retrieve(scheduleId);
  const curPhase = sched.phases[0];

  await stripe.subscriptionSchedules.update(scheduleId, {
    end_behavior: 'release',
    proration_behavior: 'none',
    phases: [
      { items: phase0Items, start_date: curPhase.start_date, end_date: curPhase.end_date },
      { items: phase1Items },
    ],
  });

  return {
    ok: true,
    new_plan: newPlan,
    effective_date: new Date(curPhase.end_date * 1000).toISOString().slice(0, 10),
    schedule_id: scheduleId,
    new_renewal_amount_cents:
      newPlanEntry.amount_cents + (hasFleet ? catalog.FLEET_CATALOG[newPlan].amount_cents : 0),
  };
}

module.exports = { changePlanAtRenewal };
