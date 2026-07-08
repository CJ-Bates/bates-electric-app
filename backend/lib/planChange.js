// backend/lib/planChange.js
// Single owner of every Generator Care subscription plan/tier/fleet mutation,
// plus the billing reader that describes the result. Both the office dashboard
// (routes/generator-care/subscriptions.js) and the customer portal
// (routes/customer.js) call these — the mechanics, error shapes, and safety
// guards live in exactly ONE place so the two surfaces can't drift apart.
//
// Convention: every mutator takes plain inputs ({ stripe, subRow, ... }) where
// subRow is an ALREADY-LOADED generator_subscriptions row (the caller does the
// DB select + any ownership/permission check — see routes for the pattern).
// Each mutator does the Stripe + DB work and returns either a success object
// ({ ok: true, ... }) or a typed error ({ error, status, code? }) for
// caller-facing conditions. It throws on unexpected Stripe/DB failures.
//
// `code` is set on errors a caller may need to branch on (e.g. rendering a
// different message for a different audience) — see 'pending_schedule' below.

const { supabaseAdmin } = require('./supabase');
const catalog = require('./generator-catalog');

const PENDING_SCHEDULE_MESSAGE =
  'This customer has a pending change at renewal. Undo it first, then change the plan.';

// A schedule in 'active' or 'not_started' status has a future phase that a
// fresh schedule.update() would silently overwrite (every mutator below
// rebuilds phases from the subscription's CURRENT live items). Refuse instead
// of clobbering whatever is already scheduled.
function hasPendingSchedule(subscription) {
  const sched = subscription.schedule;
  const status = sched && typeof sched === 'object' ? sched.status : (sched ? 'active' : null);
  return !!(sched && (status === 'active' || status === 'not_started'));
}

// Derive next-renewal + pending-plan-change info from a live Stripe subscription
// (expanded with its schedule). Amounts are best-effort display values from the
// catalog; the actual charge is always whatever the Stripe price is.
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
  out.current_has_fleet = curHasFleet; // Stripe items are the source of truth for fleet.
  if (curPlanItem) {
    const info = catalog.planForPriceId(curPlanItem.price.id);
    out.current_renewal_amount_cents =
      info.amount_cents + (curHasFleet ? catalog.FLEET_CATALOG[info.plan].amount_cents : 0);
  }

  const sched = subscription.schedule;
  if (sched && typeof sched === 'object' && (sched.status === 'active' || sched.status === 'not_started')) {
    const priceIdOf = (i) => (typeof i.price === 'string' ? i.price : (i.price && i.price.id) || null);
    // The switch lands when the current schedule phase ends; the pending phase is
    // the one starting then. Use the schedule's own current_phase boundary (the
    // most reliable signal), falling back to the subscription period end.
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
      // The effective future plan (the schedule may only change fleet, leaving the
      // plan price as-is — then fInfo is the same plan as today).
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

// Change a subscription's plan (semi_annual <-> annual) AT NEXT RENEWAL via a
// Stripe subscription schedule: phase 0 preserves today's items to period end,
// phase 1 starts the new plan (+ matching-cadence fleet price when attached).
// proration none, no charge today, end_behavior release.
//
// opts: { stripe, subRow: { stripe_subscription_id, gen_class, plan, status },
//         newPlan }
// Returns { ok, effective_date, new_renewal_amount_cents } or
//         { error, status, code? } for caller-facing 4xx conditions. Throws on
//         unexpected Stripe/DB failures.
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

  // A pending scheduled change would be silently overwritten below: this
  // mutator rebuilds ALL phases from the CURRENT live items, so stacking a
  // second change erases the first (e.g. re-adding Fleet over a scheduled
  // removal). Refuse — same guard every other mutator here uses.
  if (hasPendingSchedule(subscription)) {
    return { error: PENDING_SCHEDULE_MESSAGE, status: 409, code: 'pending_schedule' };
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

// Cancels a pending (not-yet-effective) plan/fleet change by releasing the
// schedule, returning the subscription to its current plan/price.
// opts: { stripe, subRow: { stripe_subscription_id } }
// Returns { ok, released } or { error, status }. Throws on unexpected failures.
async function revertPlanChange({ stripe, subRow }) {
  if (!subRow || !subRow.stripe_subscription_id) {
    return { error: 'subscription not found', status: 404 };
  }

  const subscription = await stripe.subscriptions.retrieve(subRow.stripe_subscription_id, { expand: ['schedule'] });
  const sched = subscription.schedule;
  const scheduleId = sched && (typeof sched === 'string' ? sched : sched.id);
  const status = sched && typeof sched === 'object' ? sched.status : null;
  if (!scheduleId || (status && status !== 'active' && status !== 'not_started')) {
    return { error: 'no pending plan change to revert', status: 400 };
  }

  // Releasing drops the scheduled future phase and returns the subscription to
  // a standalone sub at the CURRENT price. Safe while still in the current phase.
  const released = await stripe.subscriptionSchedules.release(scheduleId);
  return { ok: true, released: released.status };
}

// Resolve { plan, fleet, planItem, items, hasFleet } from a live Stripe
// subscription's items, using the actual plan price on the sub (authoritative
// cadence), not the DB column.
function fleetContext(subscription) {
  const items = (subscription.items && subscription.items.data) || [];
  const planItem = items.find((it) => catalog.isPlanPriceId(it.price.id));
  const plan = planItem ? catalog.planForPriceId(planItem.price.id).plan : null;
  const fleet = plan ? catalog.FLEET_CATALOG[plan] : null;
  const hasFleet = items.some((it) => catalog.isFleetPriceId(it.price.id));
  return { items, planItem, plan, fleet, hasFleet };
}

// Adds the matching-cadence Fleet price as a new subscription item, invoicing
// the proration NOW (charges the card on file) and aligning Fleet to the
// existing renewal date.
// opts: { stripe, subRow: { id, stripe_subscription_id, gen_class, status },
//         prorationDate? } — prorationDate is echoed from a fleet-preview call
// so the charge equals the previewed amount exactly.
// Returns { ok, plan, combined_renewal_cents, period_end } or { error, status }.
async function addFleetNow({ stripe, subRow, prorationDate }) {
  if (subRow.status === 'canceled') {
    return { error: 'subscription is canceled; cannot add Fleet Monitoring', status: 400 };
  }
  if (!subRow.stripe_subscription_id) {
    return { error: 'no Stripe subscription linked', status: 400 };
  }

  const subscription = await stripe.subscriptions.retrieve(subRow.stripe_subscription_id, { expand: ['schedule'] });
  if (subscription.status === 'canceled') {
    return { error: 'Stripe subscription is canceled', status: 400 };
  }
  const { planItem, plan, fleet, hasFleet } = fleetContext(subscription);
  if (hasFleet) return { error: 'Fleet Monitoring is already on this subscription', status: 400 };
  if (!planItem || !fleet) return { error: 'no recognized plan price on subscription', status: 400 };

  // A pending scheduled change makes a mid-cycle add ambiguous; resolve it first.
  if (hasPendingSchedule(subscription)) {
    return {
      error: 'This customer has a pending change at renewal. Undo it first, then add Fleet Monitoring.',
      status: 409,
      code: 'pending_schedule',
    };
  }

  // Add the matching-interval Fleet price; always_invoice bills the proration now.
  // Pin the same proration_date the preview used so the charge matches exactly.
  await stripe.subscriptionItems.create(Object.assign({
    subscription: subRow.stripe_subscription_id,
    price: fleet.price_id,
    quantity: 1,
    proration_behavior: 'always_invoice',
  }, prorationDate ? { proration_date: Number(prorationDate) } : {}));

  // Reflect immediately (the subscription.updated webhook also syncs from items).
  const combined = catalog.annualPriceCents(subRow.gen_class, plan, true);
  await supabaseAdmin
    .from('generator_subscriptions')
    .update(Object.assign({ fleet_monitoring: true }, combined != null ? { annual_price_cents: combined } : {}))
    .eq('id', subRow.id);

  const planEntry = catalog.planEntry(subRow.gen_class, plan);
  const periodEnd = subscription.current_period_end || planItem.current_period_end || null;
  return {
    ok: true,
    plan,
    combined_renewal_cents: (planEntry ? planEntry.amount_cents : 0) + fleet.amount_cents,
    period_end: periodEnd ? new Date(periodEnd * 1000).toISOString().slice(0, 10) : null,
  };
}

// Schedules Fleet removal effective at the NEXT renewal (no proration, no
// refund — fleet stays active through the paid period, then drops off).
// Mirrors the change-plan "at renewal" pattern; undo via revertPlanChange.
// opts: { stripe, subRow: { id, stripe_subscription_id, gen_class, status } }
// Returns { ok, effective_date, schedule_id, new_renewal_amount_cents } or
//         { error, status, code? }.
async function removeFleetAtRenewal({ stripe, subRow }) {
  if (subRow.status === 'canceled') {
    return { error: 'subscription is canceled', status: 400 };
  }
  if (!subRow.stripe_subscription_id) {
    return { error: 'no Stripe subscription linked', status: 400 };
  }

  const subscription = await stripe.subscriptions.retrieve(subRow.stripe_subscription_id, { expand: ['schedule'] });
  if (subscription.status === 'canceled') {
    return { error: 'Stripe subscription is canceled', status: 400 };
  }
  const { items, plan } = fleetContext(subscription);
  if (!items.some((it) => catalog.isFleetPriceId(it.price.id))) {
    return { error: 'Fleet Monitoring is not on this subscription', status: 400 };
  }

  // A pending scheduled change would be silently overwritten below: this
  // mutator rebuilds ALL phases from the CURRENT live items, so stacking it on
  // top of an existing schedule erases that pending change. Refuse — same
  // guard every other mutator here uses.
  if (hasPendingSchedule(subscription)) {
    return {
      error: 'This customer has a pending change at renewal. Undo it first, then remove Fleet Monitoring.',
      status: 409,
      code: 'pending_schedule',
    };
  }

  // Phase 0 = current items (Fleet stays through the paid period). Phase 1 = same
  // items minus Fleet, starting at renewal. No proration, no refund.
  const phase0Items = items.map((it) => ({ price: it.price.id, quantity: it.quantity || 1 }));
  const phase1Items = items
    .filter((it) => !catalog.isFleetPriceId(it.price.id))
    .map((it) => ({ price: it.price.id, quantity: it.quantity || 1 }));

  let scheduleId = subscription.schedule
    && (typeof subscription.schedule === 'string' ? subscription.schedule : subscription.schedule.id);
  if (!scheduleId) {
    const created = await stripe.subscriptionSchedules.create({ from_subscription: subRow.stripe_subscription_id });
    scheduleId = created.id;
  }
  const schedule = await stripe.subscriptionSchedules.retrieve(scheduleId);
  const curPhase = schedule.phases[0];
  await stripe.subscriptionSchedules.update(scheduleId, {
    end_behavior: 'release',
    proration_behavior: 'none',
    phases: [
      { items: phase0Items, start_date: curPhase.start_date, end_date: curPhase.end_date },
      { items: phase1Items },
    ],
  });

  const planEntry = plan && catalog.planEntry(subRow.gen_class, plan);
  return {
    ok: true,
    effective_date: new Date(curPhase.end_date * 1000).toISOString().slice(0, 10),
    schedule_id: scheduleId,
    new_renewal_amount_cents: planEntry ? planEntry.amount_cents : null,
  };
}

// --- Change generator class / pricing tier (charge the FULL difference) -------
// Corrects a customer who signed up on the wrong tier. A misclassification means
// they were on the higher tier for the WHOLE term, so they owe the full flat
// catalog price difference (NOT a time-proration). The cadence is unchanged here
// (cadence is handled by changePlanAtRenewal), so Fleet Monitoring is untouched.
// The previewed amount is the exact catalog delta, so it equals the amount charged.

// Shared validation/loading for both tier-change entry points below. Cadence
// stays as the subscription's current plan; only the generator class / kW tier
// changes. subRow must already be loaded + ownership-checked by the caller.
// opts: { stripe, subRow, newGenClass }
// Returns the resolved context, or { error, status } for caller-facing 4xx.
async function resolveTierChange({ stripe, subRow, newGenClass }) {
  if (subRow.status === 'canceled') return { error: 'subscription is canceled', status: 400 };
  if (!subRow.stripe_subscription_id) return { error: 'no Stripe subscription linked', status: 400 };
  if (subRow.gen_class === newGenClass) return { error: 'already on that generator class / tier', status: 400 };

  // Cadence is fixed to the current plan; resolve old/new tier prices at it.
  const curPlan = subRow.plan;
  const oldEntry = catalog.planEntry(subRow.gen_class, curPlan);
  const newEntry = catalog.planEntry(newGenClass, curPlan);
  if (!newEntry) return { error: `no ${newGenClass} price at ${curPlan} cadence`, status: 400 };
  // Hard-fail when the CURRENT tier isn't in the catalog: treating a missing old
  // price as $0 would charge the customer the ENTIRE new-tier price instead of the
  // difference. Refuse rather than over-charge.
  if (!oldEntry) {
    return {
      error: `current tier ${subRow.gen_class} has no ${curPlan} price in the catalog; cannot compute a tier-change difference`,
      status: 400,
    };
  }

  const subscription = await stripe.subscriptions.retrieve(subRow.stripe_subscription_id, { expand: ['schedule'] });
  if (subscription.status === 'canceled') return { error: 'Stripe subscription is canceled', status: 400 };
  if (hasPendingSchedule(subscription)) {
    return {
      error: 'This customer has a pending change at renewal. Undo it first, then change the tier.',
      status: 409,
      code: 'pending_schedule',
    };
  }
  const items = (subscription.items && subscription.items.data) || [];
  const planItem = items.find((it) => catalog.isPlanPriceId(it.price.id));
  if (!planItem) return { error: 'no recognized plan price on subscription', status: 400 };
  const hasFleet = items.some((it) => catalog.isFleetPriceId(it.price.id));
  const periodEnd = subscription.current_period_end || planItem.current_period_end || null;
  // Flat catalog difference (signed): >0 = upgrade (charge), <0 = downgrade (credit).
  // oldEntry is guaranteed non-null above, so this is always the true tier delta.
  const diff = newEntry.amount_cents - oldEntry.amount_cents;
  return { planItem, curPlan, hasFleet, newEntry, diff, periodEnd };
}

// Previews the FULL flat catalog difference (new tier - old tier, at the
// current cadence). Deterministic — the amount shown equals exactly what is
// charged/credited on apply. No change made.
// opts: { stripe, subRow, newGenClass }
async function tierChangePreview({ stripe, subRow, newGenClass }) {
  const loaded = await resolveTierChange({ stripe, subRow, newGenClass });
  if (loaded.error) return loaded;
  const { curPlan, hasFleet, newEntry, diff, periodEnd } = loaded;

  const direction = diff < 0 ? 'credit' : 'charge';
  const newRenewalCents = newEntry.amount_cents + (hasFleet ? catalog.FLEET_CATALOG[curPlan].amount_cents : 0);

  return {
    ok: true,
    direction,                                 // 'charge' (upgrade) | 'credit' (downgrade)
    flat_difference_cents: Math.abs(diff),     // the full tier-price difference
    charge_now_cents: diff > 0 ? diff : 0,     // charged now on an upgrade
    credit_cents: diff < 0 ? Math.abs(diff) : 0, // credit to next invoice on a downgrade
    new_renewal_cents: newRenewalCents,        // per-renewal amount on the new tier (+ existing FM)
    cadence: curPlan,                          // unchanged
    has_fleet: hasFleet,
    new_gen_class: newGenClass,
    period_end: periodEnd ? new Date(periodEnd * 1000).toISOString().slice(0, 10) : null,
  };
}

// Charges the FULL flat tier difference now (upgrade) via an immediate invoice,
// or applies it as account credit toward the next invoice (downgrade), then
// swaps the recurring base price to the new tier with proration_behavior:'none'
// (no time-proration line). Cadence + Fleet are unchanged. Persists gen_class.
// The charged amount equals the catalog delta tierChangePreview showed.
//
// opts: { stripe, subRow: { id, gen_class, stripe_subscription_id,
//         stripe_customer_id, status, plan }, newGenClass,
//         resolveSavedPaymentMethod, emailCardUpdateLinkForSub, tierLabel }
// resolveSavedPaymentMethod/emailCardUpdateLinkForSub are injected (Stripe
// payment-method lookup + card-update email live in lib/gcShared, office-only
// today) so this module has no dependency on office-only helpers.
// tierLabel(genClass) formats a generator class for the invoice description.
async function applyTierChange({
  stripe, subRow, newGenClass, resolveSavedPaymentMethod, emailCardUpdateLinkForSub, tierLabel,
}) {
  const loaded = await resolveTierChange({ stripe, subRow, newGenClass });
  if (loaded.error) return loaded;
  const { planItem, curPlan, hasFleet, newEntry, diff } = loaded;
  const label = tierLabel || ((gc) => gc);
  const tierDesc = `Generator tier correction: ${label(subRow.gen_class)} → ${label(newGenClass)}`;

  // 1. Settle the full flat difference now (independent of time elapsed).
  if (diff > 0) {
    // Upgrade: bill the difference immediately on a one-time invoice that
    // charges the card on file (flows through invoice.paid -> state-branded
    // receipt + Recent Invoices/Accounting, like every other charge).
    const pmId = await resolveSavedPaymentMethod(subRow.stripe_subscription_id, subRow.stripe_customer_id);
    if (!pmId) {
      const linkResult = await emailCardUpdateLinkForSub(subRow.id);
      return {
        error: 'no saved card on file',
        status: 402,
        reason: 'no saved card on file',
        card_update_email_sent: !!(linkResult && linkResult.sent),
      };
    }
    let invoice;
    try {
      invoice = await stripe.invoices.create({
        customer: subRow.stripe_customer_id,
        collection_method: 'charge_automatically',
        default_payment_method: pmId,
        auto_advance: false,
        description: tierDesc,
        metadata: { tier_change: '1', subscription_id: subRow.id, new_gen_class: newGenClass },
      });
      await stripe.invoiceItems.create({
        customer: subRow.stripe_customer_id,
        invoice: invoice.id,
        amount: diff,
        currency: 'usd',
        description: tierDesc,
        metadata: { tier_change: '1', subscription_id: subRow.id },
      });
      invoice = await stripe.invoices.finalizeInvoice(invoice.id);
      invoice = await stripe.invoices.pay(invoice.id);
    } catch (stripeErr) {
      const reason = (stripeErr && (stripeErr.message || stripeErr.code)) || 'charge failed';
      if (invoice && invoice.id) { try { await stripe.invoices.voidInvoice(invoice.id); } catch (e) {} }
      return { error: 'tier-correction charge failed', status: 402, reason };
    }
  } else if (diff < 0) {
    // Downgrade: full difference becomes account credit toward the next invoice
    // (NOT a cash refund — the office uses the refund control for that).
    await stripe.customers.createBalanceTransaction({
      customer: subRow.stripe_customer_id,
      amount: diff, // negative = credit
      currency: 'usd',
      description: tierDesc + ' (credit)',
    });
  }

  // 2. Swap the recurring base price to the new tier — NO time-proration.
  //    Only the plan item changes; Fleet (if any) is left untouched (cadence
  //    is unchanged, so no interval mismatch).
  await stripe.subscriptions.update(subRow.stripe_subscription_id, {
    items: [{ id: planItem.id, price: newEntry.price_id }],
    proration_behavior: 'none',
  });

  // 3. Persist the new class locally (cadence unchanged; the subscription.updated
  //    webhook also re-syncs gen_class/price/fleet from the new items as a backstop).
  const annual = catalog.annualPriceCents(newGenClass, curPlan, hasFleet);
  await supabaseAdmin
    .from('generator_subscriptions')
    .update(Object.assign({ gen_class: newGenClass }, annual != null ? { annual_price_cents: annual } : {}))
    .eq('id', subRow.id);

  return {
    ok: true,
    new_gen_class: newGenClass,
    charged_cents: diff > 0 ? diff : 0,
    credited_cents: diff < 0 ? Math.abs(diff) : 0,
    new_renewal_cents: newEntry.amount_cents + (hasFleet ? catalog.FLEET_CATALOG[curPlan].amount_cents : 0),
  };
}

module.exports = {
  computePlanBilling,
  changePlanAtRenewal,
  revertPlanChange,
  fleetContext,
  addFleetNow,
  removeFleetAtRenewal,
  tierChangePreview,
  applyTierChange,
  PENDING_SCHEDULE_MESSAGE,
};
