// backend/lib/planBilling.js
// Renewal date/amount + pending-plan-change reader for a live Stripe
// subscription (retrieved with { expand: ['schedule'] }).
//
// MIRRORS computePlanBilling in routes/generator-care/subscriptions.js —
// office routes are deliberately untouched by the customer-portal lane, so
// the logic is duplicated here for the customer API. If you change one,
// change both (they parse the same Stripe shapes).

const catalog = require('./generator-catalog');

function computePlanBilling(subscription) {
  const items = (subscription.items && subscription.items.data) || [];
  // current_period_end moved to the item level in recent Stripe API versions.
  const periodEnd = subscription.current_period_end
    || (items[0] && items[0].current_period_end)
    || null;

  const out = {
    current_period_end: periodEnd ? new Date(periodEnd * 1000).toISOString().slice(0, 10) : null,
    current_renewal_amount_cents: null,
    current_has_fleet: false,
    pending_change: null,
  };
  const curPlanItem = items.find((it) => catalog.isPlanPriceId(it.price.id));
  const curHasFleet = items.some((it) => catalog.isFleetPriceId(it.price.id));
  out.current_has_fleet = curHasFleet;
  if (curPlanItem) {
    const info = catalog.planForPriceId(curPlanItem.price.id);
    out.current_renewal_amount_cents =
      info.amount_cents + (curHasFleet ? catalog.FLEET_CATALOG[info.plan].amount_cents : 0);
  }

  const sched = subscription.schedule;
  if (sched && typeof sched === 'object' && (sched.status === 'active' || sched.status === 'not_started')) {
    const priceIdOf = (i) => (typeof i.price === 'string' ? i.price : (i.price && i.price.id) || null);
    const boundary = (sched.current_phase && sched.current_phase.end_date) || periodEnd || null;
    if (!out.current_period_end && boundary) {
      out.current_period_end = new Date(boundary * 1000).toISOString().slice(0, 10);
    }
    const future = (sched.phases || []).find((p) => boundary && p.start_date >= boundary);
    if (future) {
      const fItem = (future.items || []).find((i) => catalog.isPlanPriceId(priceIdOf(i)));
      const fId = fItem ? priceIdOf(fItem) : null;
      const fInfo = fId && catalog.planForPriceId(fId);
      const curId = curPlanItem ? curPlanItem.price.id : null;
      const fHasFleet = (future.items || []).some((i) => catalog.isFleetPriceId(priceIdOf(i)));
      const effInfo = fInfo || (curPlanItem && catalog.planForPriceId(curPlanItem.price.id));
      const planChanged = !!(fInfo && fId !== curId);
      const fleetChanged = fHasFleet !== curHasFleet;
      if (effInfo && (planChanged || fleetChanged)) {
        out.pending_change = {
          new_plan: effInfo.plan,
          plan_changed: planChanged,
          fleet_change: fleetChanged ? (fHasFleet ? 'adding' : 'removing') : null,
          new_has_fleet: fHasFleet,
          effective_date: new Date(future.start_date * 1000).toISOString().slice(0, 10),
          new_renewal_amount_cents:
            effInfo.amount_cents + (fHasFleet ? catalog.FLEET_CATALOG[effInfo.plan].amount_cents : 0),
        };
      }
    }
  }
  return out;
}

module.exports = { computePlanBilling };
