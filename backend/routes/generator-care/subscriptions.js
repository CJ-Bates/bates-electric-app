// backend/routes/generator-care/subscriptions.js
// Subscription lifecycle + billing: list/detail/edit, Stripe enrichment,
// plan/tier/fleet changes, cancel, receipts, portal + welcome emails, the
// Jonas work-order hand-off, and customer contact edits.
// Auth (requireAuth + office role) is applied by ./index.js.

const express = require('express');
const { requirePermission } = require('../../middleware/permissions');
const { supabaseAdmin } = require('../../lib/supabase');
const catalog = require('../../lib/generator-catalog');
const { sendReceiptEmail } = require('../../lib/receipts');
const {
  stripe,
  resolveSavedPaymentMethod,
  emailCardUpdateLinkForSub,
  sendCardUpdateLinkEmail,
} = require('../../lib/gcShared');
const { sendEmail, buildWelcomeEmail, buildCancellationEmail } = require('../../lib/emails');

const router = express.Router();

// Actual amount charged at signup = amount_paid of the customer's OLDEST paid
// invoice (the first/signup invoice), which reflects any promo-code discount.
// Returns cents, or null if it can't be read (callers fall back to plan price).
async function getSignupChargeCents(stripeCustomerId) {
  if (!stripeCustomerId) return null;
  try {
    const inv = await stripe.invoices.list({ customer: stripeCustomerId, status: 'paid', limit: 100 });
    const all = inv.data || [];
    if (!all.length) return null;
    return all[all.length - 1].amount_paid || 0; // list is newest-first; last = oldest = signup charge
  } catch (e) {
    console.error('[signup-charge] lookup failed:', e && e.message);
    return null;
  }
}

// GET /api/generator-care/subscriptions
// List of all subscriptions joined with customer info, sorted by next-visit-due ascending.
router.get('/subscriptions', async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('generator_subscriptions')
      .select(`
        id, plan, gen_class, gen_type_label, gen_model, gen_serial,
        fleet_monitoring, status, annual_price_cents,
        signup_date, next_visit_due, last_visit_date,
        stripe_subscription_id, stripe_customer_id, notes, created_at,
        customer:generator_customers(id, name, email, phone, install_address, install_city, install_state, install_zip),
        visits:generator_service_visits(id, status, appointment_at, completed_date, scheduled_date, visit_type)
      `)
      .order('next_visit_due', { ascending: true, nullsFirst: false });
    if (error) throw error;
    // Attach each sub's current OPEN (un-completed) visit so the list STATUS
    // column can show Needs scheduling vs Scheduled — without shipping every visit.
    const subscriptions = (data || []).map((s) => {
      const open = (s.visits || [])
        .filter((v) => v.status !== 'completed' && !v.completed_date)
        .sort((a, b) => String(a.appointment_at || a.scheduled_date || '').localeCompare(String(b.appointment_at || b.scheduled_date || '')))[0] || null;
      const { visits, ...rest } = s;
      return {
        ...rest,
        open_visit: open
          ? { id: open.id, status: open.status, appointment_at: open.appointment_at, scheduled_date: open.scheduled_date }
          : null,
      };
    });
    res.json({ subscriptions });
  } catch (err) {
    console.error('[generator-care] subscriptions error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/generator-care/subscriptions/:id
// Full detail: subscription, customer, scheduled/completed visits, pending add-ons.
router.get('/subscriptions/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const [subR, visitsR, addonsR, adhocR] = await Promise.all([
      supabaseAdmin
        .from('generator_subscriptions')
        .select(`*, customer:generator_customers(*)`)
        .eq('id', id)
        .single(),
      supabaseAdmin
        .from('generator_service_visits')
        .select('*')
        .eq('subscription_id', id)
        .order('scheduled_date', { ascending: true }),
      supabaseAdmin
        .from('generator_pending_addons')
        .select('*')
        .eq('subscription_id', id)
        .order('created_at', { ascending: true }),
      supabaseAdmin
        .from('generator_adhoc_charges')
        .select('*')
        .eq('subscription_id', id)
        .order('created_at', { ascending: false }),
    ]);
    if (subR.error) throw subR.error;
    if (visitsR.error) throw visitsR.error;
    if (addonsR.error) throw addonsR.error;
    if (adhocR.error) throw adhocR.error;

    // Pending customer appointment preferences for these visits (customer
    // dashboard v2). Graceful no-op when the 016 migration isn't applied yet.
    let visitPreferences = [];
    try {
      const visitIds = (visitsR.data || []).map((v) => v.id);
      if (visitIds.length) {
        const { data: prefRows, error: prefErr } = await supabaseAdmin
          .from('generator_visit_preferences')
          .select('id, visit_id, slots, note, created_at')
          .in('visit_id', visitIds)
          .eq('status', 'pending')
          .order('created_at', { ascending: false });
        if (!prefErr && prefRows) visitPreferences = prefRows;
      }
    } catch (e) {
      console.log('[generator-care] visit preferences unavailable (migration pending?):', e && e.message);
    }

    res.json({
      subscription: subR.data,
      visits: visitsR.data || [],
      pending_addons: addonsR.data || [],
      adhoc_charges: adhocR.data || [],
      visit_preferences: visitPreferences,
    });
  } catch (err) {
    console.error('[generator-care] subscription detail error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// === JONAS HAND-OFF (manual work order + AR invoicing) =====================
// Jonas has no import, so the work order is keyed in by hand. These endpoints
// track the hand-off ("Signed up -> Work order created -> Invoiced") and notify
// AR with the work-order packet when it's ready to invoice.

// POST /api/generator-care/subscriptions/:id/work-order-created
// Stamps work_order_created_at/by + the WO number — an INTERNAL Jonas record
// (Brenda keys the work order into Jonas). Customers are not invoiced, so this no
// longer notifies AR or relays anything for billing. Idempotent.
router.post('/subscriptions/:id/work-order-created', async (req, res) => {
  try {
    const { id } = req.params;
    const { data: sub, error: subErr } = await supabaseAdmin
      .from('generator_subscriptions')
      .select('*, customer:generator_customers(*)')
      .eq('id', id)
      .single();
    if (subErr) throw subErr;
    if (!sub) return res.status(404).json({ error: 'subscription not found' });

    const alreadyMarked = !!sub.work_order_created_at;
    const markedBy = (req.profile && req.profile.full_name) || (req.user && req.user.email) || 'office';
    const workOrderNumber = typeof req.body?.work_order_number === 'string' ? req.body.work_order_number.trim() : '';

    // The WO number identifies the order in Jonas, so require it on the first mark.
    if (!alreadyMarked && !workOrderNumber) {
      return res.status(400).json({ error: 'Work order number is required.' });
    }

    let updated = sub;
    if (!alreadyMarked) {
      const { data: upd, error: updErr } = await supabaseAdmin
        .from('generator_subscriptions')
        .update({ work_order_created_at: new Date().toISOString(), work_order_created_by: markedBy, work_order_number: workOrderNumber })
        .eq('id', id)
        .select('*, customer:generator_customers(*)')
        .single();
      if (updErr) throw updErr;
      updated = upd;
    }

    res.json({ ok: true, subscription: updated, already_marked: alreadyMarked });
  } catch (err) {
    console.error('[generator-care] work-order-created error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/generator-care/subscriptions/:id/work-order-created/undo  (misclick recovery)
router.post('/subscriptions/:id/work-order-created/undo', async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('generator_subscriptions')
      .update({ work_order_created_at: null, work_order_created_by: null })
      .eq('id', req.params.id)
      .select('*, customer:generator_customers(*)')
      .single();
    if (error) throw error;
    res.json({ ok: true, subscription: data });
  } catch (err) {
    console.error('[generator-care] work-order-created/undo error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// (Customer invoicing dropped: the "invoice sent" step + its undo were removed —
// Generator Care customers are not invoiced; the branded receipt is their record.)

// GET /api/generator-care/subscriptions/:id/stripe-data
// Lazy-loaded Stripe enrichments for the customer detail modal: payment
// method on file, lifetime billed total, and the 5 most recent invoices.
// The modal opens instantly from DB; this endpoint fills in skeletons
// after the fact. Two Stripe API calls in parallel (~150-300ms).
router.get('/subscriptions/:id/stripe-data', async (req, res) => {
  try {
    const { data: sub, error: subErr } = await supabaseAdmin
      .from('generator_subscriptions')
      .select('stripe_customer_id, stripe_subscription_id, plan, gen_class')
      .eq('id', req.params.id)
      .single();
    if (subErr) throw subErr;
    if (!sub || !sub.stripe_customer_id) {
      return res.json({
        payment_method: null,
        lifetime_billed_cents: 0,
        recent_invoices: [],
        plan_billing: null,
        note: 'No Stripe customer linked to this subscription.',
      });
    }
    const customerId = sub.stripe_customer_id;

    // Fetch in parallel: payment methods (cards) + paid invoices + the live
    // subscription (with any plan-change schedule attached).
    // limit:100 on invoices is enough to cover years of subs; if we ever
    // exceed it the lifetime total just slightly under-counts.
    const [pmResult, invoiceResult, subResult] = await Promise.allSettled([
      stripe.paymentMethods.list({ customer: customerId, type: 'card', limit: 1 }),
      // Expand the charge so we can report refund status per invoice (for the
      // dashboard Refund button + Refunded/Partial chips).
      stripe.invoices.list({ customer: customerId, status: 'paid', limit: 100, expand: ['data.charge'] }),
      sub.stripe_subscription_id
        ? stripe.subscriptions.retrieve(sub.stripe_subscription_id, { expand: ['schedule'] })
        : Promise.resolve(null),
    ]);

    // Payment method
    let payment_method = null;
    if (pmResult.status === 'fulfilled' && pmResult.value.data.length > 0) {
      const pm = pmResult.value.data[0];
      const card = pm.card || {};
      payment_method = {
        brand: card.brand || null,
        last4: card.last4 || null,
        exp_month: card.exp_month || null,
        exp_year: card.exp_year || null,
      };
    } else if (pmResult.status === 'rejected') {
      console.error('[stripe-data] paymentMethods.list failed:', pmResult.reason && pmResult.reason.message);
    }

    // Lifetime billed + recent invoices (both from the same list call)
    let lifetime_billed_cents = 0;
    let recent_invoices = [];
    let signup_charge_cents = null; // amount_paid of the oldest paid invoice = actual signup charge (promo-aware)
    if (invoiceResult.status === 'fulfilled') {
      const all = invoiceResult.value.data || [];
      lifetime_billed_cents = all.reduce((sum, inv) => sum + (inv.amount_paid || 0), 0);
      if (all.length) signup_charge_cents = all[all.length - 1].amount_paid || 0;
      recent_invoices = all.slice(0, 5).map((inv) => {
        const ch = inv.charge && typeof inv.charge === 'object' ? inv.charge : null;
        const chargeAmount = ch ? ch.amount : (inv.amount_paid || 0);
        const amountRefunded = ch ? (ch.amount_refunded || 0) : 0;
        // Card the charge settled on — what the refund posts back to. Shown in
        // the dashboard refund dialog ("to Mastercard ••3981").
        const card = (ch && ch.payment_method_details && ch.payment_method_details.card) || null;
        return {
          id: inv.id,
          created: inv.created,
          amount_paid: inv.amount_paid || 0,
          status: inv.status,
          hosted_invoice_url: inv.hosted_invoice_url || null,
          stripe_dashboard_url: `https://dashboard.stripe.com/invoices/${inv.id}`,
          charge_amount_cents: chargeAmount,
          amount_refunded_cents: amountRefunded,
          card_brand: card ? (card.brand || null) : null,
          card_last4: card ? (card.last4 || null) : null,
          // Refundable: a paid invoice with a charge that isn't already fully refunded.
          refundable: inv.status === 'paid' && !!ch && amountRefunded < chargeAmount,
        };
      });
    } else {
      console.error('[stripe-data] invoices.list failed:', invoiceResult.reason && invoiceResult.reason.message);
    }

    // Plan billing: next renewal date/amount + any pending (scheduled) plan change.
    let plan_billing = null;
    if (subResult.status === 'fulfilled' && subResult.value) {
      plan_billing = computePlanBilling(subResult.value);
    } else if (subResult.status === 'rejected') {
      console.error('[stripe-data] subscription retrieve failed:', subResult.reason && subResult.reason.message);
    }

    res.json({ payment_method, lifetime_billed_cents, recent_invoices, signup_charge_cents, plan_billing });
  } catch (err) {
    console.error('[generator-care] stripe-data error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Derive next-renewal + pending-plan-change info from a live Stripe subscription
// (expanded with its schedule). Amounts are best-effort display values from the
// catalog; the actual charge is always whatever the Stripe price is.
function computePlanBilling(subscription) {
  const items = (subscription.items && subscription.items.data) || [];
  // current_period_end was removed from the Subscription object in recent Stripe
  // API versions (stripe-node 18 pins 2025-03-31.basil) and now lives on each
  // item. Fall back so the renewal date + pending-change detection keep working.
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
    const future = (sched.phases || []).find(
      (p) => boundary && p.start_date >= boundary
    );
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

// POST /api/generator-care/subscriptions/:id/change-plan
// Body: { new_plan: 'semi_annual' | 'annual' }
// Schedules a cadence switch effective at the customer's NEXT renewal. No
// proration, no charge or credit today: a Stripe subscription schedule keeps the
// current price through the period end, then starts the new price/interval. If
// Fleet Monitoring is attached, its price is swapped to the matching cadence too
// (Stripe can't mix billing intervals in one subscription).
router.post('/subscriptions/:id/change-plan', requirePermission('billing_actions'), async (req, res) => {
  try {
    const { id } = req.params;
    const { new_plan } = req.body || {};
    if (!catalog.PLANS.includes(new_plan)) {
      return res.status(400).json({ error: "new_plan must be 'semi_annual' or 'annual'" });
    }

    const { data: sub, error: subErr } = await supabaseAdmin
      .from('generator_subscriptions')
      .select('id, stripe_subscription_id, gen_class, plan, status')
      .eq('id', id)
      .single();
    if (subErr) throw subErr;
    if (!sub) return res.status(404).json({ error: 'subscription not found' });
    if (sub.status === 'canceled') {
      return res.status(400).json({ error: 'subscription is canceled; cannot change plan' });
    }
    if (!sub.stripe_subscription_id) {
      return res.status(400).json({ error: 'no Stripe subscription linked' });
    }
    if (sub.plan === new_plan) {
      return res.status(400).json({ error: 'subscription is already on that plan' });
    }
    const newPlanEntry = catalog.planEntry(sub.gen_class, new_plan);
    if (!newPlanEntry) {
      return res.status(400).json({ error: `no ${new_plan} price for gen_class ${sub.gen_class}` });
    }

    const subscription = await stripe.subscriptions.retrieve(sub.stripe_subscription_id, { expand: ['schedule'] });
    if (subscription.status === 'canceled') {
      return res.status(400).json({ error: 'Stripe subscription is canceled' });
    }

    const items = (subscription.items && subscription.items.data) || [];
    const hasFleet = items.some((it) => catalog.isFleetPriceId(it.price.id));

    // Phase 0 = current items, preserved until the period end (no change today).
    const phase0Items = items.map((it) => ({ price: it.price.id, quantity: it.quantity || 1 }));
    // Phase 1 = new plan price (+ matching-cadence fleet price if attached).
    const phase1Items = [{ price: newPlanEntry.price_id, quantity: 1 }];
    if (hasFleet) phase1Items.push({ price: catalog.FLEET_CATALOG[new_plan].price_id, quantity: 1 });

    // Create the schedule from the subscription if it doesn't already have one.
    let scheduleId = subscription.schedule
      && (typeof subscription.schedule === 'string' ? subscription.schedule : subscription.schedule.id);
    if (!scheduleId) {
      const created = await stripe.subscriptionSchedules.create({ from_subscription: sub.stripe_subscription_id });
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

    return res.json({
      ok: true,
      new_plan,
      effective_date: new Date(curPhase.end_date * 1000).toISOString().slice(0, 10),
      schedule_id: scheduleId,
      new_renewal_amount_cents:
        newPlanEntry.amount_cents + (hasFleet ? catalog.FLEET_CATALOG[new_plan].amount_cents : 0),
    });
  } catch (err) {
    console.error('[generator-care] change-plan error:', err && err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/generator-care/subscriptions/:id/revert-plan-change
// Cancels a pending (not-yet-effective) plan change by releasing the schedule,
// returning the subscription to its current plan/price. Office-gated.
router.post('/subscriptions/:id/revert-plan-change', requirePermission('billing_actions'), async (req, res) => {
  try {
    const { id } = req.params;
    const { data: sub, error: subErr } = await supabaseAdmin
      .from('generator_subscriptions')
      .select('stripe_subscription_id')
      .eq('id', id)
      .single();
    if (subErr) throw subErr;
    if (!sub || !sub.stripe_subscription_id) {
      return res.status(404).json({ error: 'subscription not found' });
    }

    const subscription = await stripe.subscriptions.retrieve(sub.stripe_subscription_id, { expand: ['schedule'] });
    const sched = subscription.schedule;
    const scheduleId = sched && (typeof sched === 'string' ? sched : sched.id);
    const status = sched && typeof sched === 'object' ? sched.status : null;
    if (!scheduleId || (status && status !== 'active' && status !== 'not_started')) {
      return res.status(400).json({ error: 'no pending plan change to revert' });
    }

    // Releasing drops the scheduled future phase and returns the subscription to
    // a standalone sub at the CURRENT price. Safe while still in the current phase.
    const released = await stripe.subscriptionSchedules.release(scheduleId);
    return res.json({ ok: true, released: released.status });
  } catch (err) {
    console.error('[generator-care] revert-plan-change error:', err && err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

// --- Fleet Monitoring add-on, folded into the existing subscription ----------
// One subscription, one renewal date. The Fleet price MUST match the plan's
// billing interval (Stripe can't mix intervals in one sub), so we always pick the
// matching-cadence Fleet price from the SAME catalog the signup flow uses.

// Resolve { plan, fleet, planItem } from a live Stripe subscription's items, using
// the actual plan price on the sub (authoritative cadence), not the DB column.
function fleetContext(subscription) {
  const items = (subscription.items && subscription.items.data) || [];
  const planItem = items.find((it) => catalog.isPlanPriceId(it.price.id));
  const plan = planItem ? catalog.planForPriceId(planItem.price.id).plan : null;
  const fleet = plan ? catalog.FLEET_CATALOG[plan] : null;
  const hasFleet = items.some((it) => catalog.isFleetPriceId(it.price.id));
  return { items, planItem, plan, fleet, hasFleet };
}

// GET /api/generator-care/subscriptions/:id/fleet-preview
// Office-gated. Previews the prorated charge for adding the matching-cadence Fleet
// price now (no change made), plus the combined renewal. Optional ?customer_id=
// IDOR guard. Returns { already_has_fleet } if it's already attached.
router.get('/subscriptions/:id/fleet-preview', async (req, res) => {
  try {
    const { id } = req.params;
    const { data: sub, error: subErr } = await supabaseAdmin
      .from('generator_subscriptions')
      .select('customer_id, stripe_subscription_id, stripe_customer_id, gen_class, plan, status')
      .eq('id', id)
      .single();
    if (subErr) throw subErr;
    if (!sub) return res.status(404).json({ error: 'subscription not found' });
    if (req.query.customer_id && sub.customer_id !== req.query.customer_id) {
      return res.status(403).json({ error: 'subscription does not belong to that customer' });
    }
    if (!sub.stripe_subscription_id) return res.status(400).json({ error: 'no Stripe subscription linked' });

    const subscription = await stripe.subscriptions.retrieve(sub.stripe_subscription_id);
    if (subscription.status === 'canceled') return res.status(400).json({ error: 'subscription is canceled' });
    const { items, planItem, plan, fleet, hasFleet } = fleetContext(subscription);
    if (hasFleet) return res.json({ already_has_fleet: true });
    if (!planItem || !fleet) return res.status(400).json({ error: 'no recognized plan price on subscription' });

    const periodEnd = subscription.current_period_end || planItem.current_period_end || null;
    const periodStart = subscription.current_period_start || planItem.current_period_start || null;

    // Preview the proration with the SAME behavior the add uses (always_invoice),
    // pinned to a proration_date we hand back so the actual charge equals this
    // preview exactly. amount_due is the real card charge — it already reflects any
    // coupon discount and customer credit balance. (createPreview with
    // create_prorations would show ~$0 due now because it defers the proration to
    // the next cycle; and the old line.proration flag moved under
    // line.parent.*_details.proration in the 2025-03-31.basil API.)
    const prorationDate = Math.floor(Date.now() / 1000);
    let preview;
    try {
      const previewItems = items
        .map((it) => ({ id: it.id, price: it.price.id, quantity: it.quantity || 1 }))
        .concat([{ price: fleet.price_id, quantity: 1 }]);
      preview = await stripe.invoices.createPreview({
        customer: sub.stripe_customer_id,
        subscription: sub.stripe_subscription_id,
        subscription_details: {
          items: previewItems,
          proration_behavior: 'always_invoice',
          proration_date: prorationDate,
        },
      });
    } catch (e) {
      console.error('[fleet-preview] createPreview failed:', e && e.message);
      return res.status(502).json({ error: 'Could not preview the prorated charge from Stripe. Please try again.' });
    }

    const charge = typeof preview.amount_due === 'number' ? preview.amount_due : null;
    // What a full-period add would cost vs. what we expect for the remaining time
    // (Stripe prorates linearly by time) — used only to sanity-check `charge`.
    const frac = (periodStart && periodEnd)
      ? Math.max(0, Math.min(1, (periodEnd - prorationDate) / (periodEnd - periodStart)))
      : null;
    const expectedGross = frac != null ? Math.round(fleet.amount_cents * frac) : null;
    const daysRemaining = periodEnd ? Math.round((periodEnd - prorationDate) / 86400) : null;
    const hasCredit = typeof preview.starting_balance === 'number' && preview.starting_balance < 0;
    const hasDiscount = Array.isArray(preview.total_discount_amounts)
      && preview.total_discount_amounts.some((d) => (d.amount || 0) > 0);

    // Upper sanity bound: an immediate proration can't exceed one whole fleet period
    // (+ a little tax/rounding). A much larger number means the preview returned the
    // wrong invoice (e.g. a full next-cycle invoice) — don't show it.
    const upperSane = fleet.amount_cents + Math.round(fleet.amount_cents * 0.2) + 100;
    if (charge == null || charge > upperSane) {
      return res.status(502).json({ error: 'Stripe returned an unexpected preview amount; not showing a charge. Please retry.' });
    }
    // Lower guard: a ~$0 charge while meaningful time remains and no coupon/credit
    // explains it is a computation problem, not a real free add — block it.
    if (charge < 50 && expectedGross != null && expectedGross >= 100
        && (daysRemaining == null || daysRemaining > 14) && !hasCredit && !hasDiscount) {
      return res.status(422).json({
        error: `Computed a ~$0 charge, but about $${(expectedGross / 100).toFixed(2)} of proration is expected with ${daysRemaining} days left and no coupon or account credit explains it. Not charging $0 — check the subscription in Stripe and retry.`,
      });
    }

    const planEntry = catalog.planEntry(sub.gen_class, plan);
    return res.json({
      already_has_fleet: false,
      plan,
      proration_cents: charge,            // the exact amount the card will be charged
      expected_gross_cents: expectedGross, // time-based, before any coupon/credit
      reduced_by_credit: hasCredit,
      reduced_by_discount: hasDiscount,
      proration_date: prorationDate,       // echo to add-fleet for an exact match
      fleet_renewal_cents: fleet.amount_cents,
      combined_renewal_cents: (planEntry ? planEntry.amount_cents : 0) + fleet.amount_cents,
      period_end: periodEnd ? new Date(periodEnd * 1000).toISOString().slice(0, 10) : null,
    });
  } catch (err) {
    console.error('[generator-care] fleet-preview error:', err && err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/generator-care/subscriptions/:id/add-fleet
// Office-gated. Adds the matching-cadence Fleet price as a new subscription item,
// invoicing the proration NOW (charges the card on file) and aligning Fleet to the
// existing renewal date. Body: { customer_id?, proration_date? } — proration_date
// is echoed from fleet-preview so the charge equals the previewed amount exactly.
router.post('/subscriptions/:id/add-fleet', requirePermission('billing_actions'), async (req, res) => {
  try {
    const { id } = req.params;
    const { customer_id, proration_date } = req.body || {};
    const { data: sub, error: subErr } = await supabaseAdmin
      .from('generator_subscriptions')
      .select('customer_id, stripe_subscription_id, gen_class, plan, status')
      .eq('id', id)
      .single();
    if (subErr) throw subErr;
    if (!sub) return res.status(404).json({ error: 'subscription not found' });
    if (customer_id && sub.customer_id !== customer_id) {
      return res.status(403).json({ error: 'subscription does not belong to that customer' });
    }
    if (sub.status === 'canceled') return res.status(400).json({ error: 'subscription is canceled; cannot add Fleet Monitoring' });
    if (!sub.stripe_subscription_id) return res.status(400).json({ error: 'no Stripe subscription linked' });

    const subscription = await stripe.subscriptions.retrieve(sub.stripe_subscription_id, { expand: ['schedule'] });
    if (subscription.status === 'canceled') return res.status(400).json({ error: 'Stripe subscription is canceled' });
    const { planItem, plan, fleet, hasFleet } = fleetContext(subscription);
    if (hasFleet) return res.status(400).json({ error: 'Fleet Monitoring is already on this subscription' });
    if (!planItem || !fleet) return res.status(400).json({ error: 'no recognized plan price on subscription' });

    // A pending scheduled change makes a mid-cycle add ambiguous; resolve it first.
    const sched = subscription.schedule;
    const schedStatus = sched && typeof sched === 'object' ? sched.status : (sched ? 'active' : null);
    if (sched && (schedStatus === 'active' || schedStatus === 'not_started')) {
      return res.status(409).json({ error: 'This customer has a pending change at renewal. Undo it first, then add Fleet Monitoring.' });
    }

    // Add the matching-interval Fleet price; always_invoice bills the proration now.
    // Pin the same proration_date the preview used so the charge matches exactly.
    await stripe.subscriptionItems.create(Object.assign({
      subscription: sub.stripe_subscription_id,
      price: fleet.price_id,
      quantity: 1,
      proration_behavior: 'always_invoice',
    }, proration_date ? { proration_date: Number(proration_date) } : {}));

    // Reflect immediately (the subscription.updated webhook also syncs from items).
    const combined = catalog.annualPriceCents(sub.gen_class, plan, true);
    await supabaseAdmin
      .from('generator_subscriptions')
      .update(Object.assign({ fleet_monitoring: true }, combined != null ? { annual_price_cents: combined } : {}))
      .eq('id', id);

    const planEntry = catalog.planEntry(sub.gen_class, plan);
    const periodEnd = subscription.current_period_end || planItem.current_period_end || null;
    return res.json({
      ok: true,
      plan,
      combined_renewal_cents: (planEntry ? planEntry.amount_cents : 0) + fleet.amount_cents,
      period_end: periodEnd ? new Date(periodEnd * 1000).toISOString().slice(0, 10) : null,
    });
  } catch (err) {
    console.error('[generator-care] add-fleet error:', err && err.message);
    return res.status(500).json({ error: (err && err.message) || 'Server error' });
  }
});

// POST /api/generator-care/subscriptions/:id/remove-fleet
// Office-gated. Schedules Fleet removal effective at the NEXT renewal (no proration,
// no refund — fleet stays active through the paid period, then drops off). Mirrors
// the change-plan "at renewal" pattern; undo via revert-plan-change (release).
// Body: { customer_id? } (IDOR guard).
router.post('/subscriptions/:id/remove-fleet', requirePermission('billing_actions'), async (req, res) => {
  try {
    const { id } = req.params;
    const { customer_id } = req.body || {};
    const { data: sub, error: subErr } = await supabaseAdmin
      .from('generator_subscriptions')
      .select('customer_id, stripe_subscription_id, gen_class, plan, status')
      .eq('id', id)
      .single();
    if (subErr) throw subErr;
    if (!sub) return res.status(404).json({ error: 'subscription not found' });
    if (customer_id && sub.customer_id !== customer_id) {
      return res.status(403).json({ error: 'subscription does not belong to that customer' });
    }
    if (sub.status === 'canceled') return res.status(400).json({ error: 'subscription is canceled' });
    if (!sub.stripe_subscription_id) return res.status(400).json({ error: 'no Stripe subscription linked' });

    const subscription = await stripe.subscriptions.retrieve(sub.stripe_subscription_id, { expand: ['schedule'] });
    if (subscription.status === 'canceled') return res.status(400).json({ error: 'Stripe subscription is canceled' });
    const { items, planItem, plan } = fleetContext(subscription);
    if (!items.some((it) => catalog.isFleetPriceId(it.price.id))) {
      return res.status(400).json({ error: 'Fleet Monitoring is not on this subscription' });
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
      const created = await stripe.subscriptionSchedules.create({ from_subscription: sub.stripe_subscription_id });
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

    const planEntry = plan && catalog.planEntry(sub.gen_class, plan);
    return res.json({
      ok: true,
      effective_date: new Date(curPhase.end_date * 1000).toISOString().slice(0, 10),
      schedule_id: scheduleId,
      new_renewal_amount_cents: planEntry ? planEntry.amount_cents : null,
    });
  } catch (err) {
    console.error('[generator-care] remove-fleet error:', err && err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

// --- Change generator class / pricing tier (charge the FULL difference) -------
// Corrects a customer who signed up on the wrong tier. A misclassification means
// they were on the higher tier for the WHOLE term, so they owe the full flat
// catalog price difference (NOT a time-proration). The cadence is unchanged here
// (cadence is handled by Change plan), so Fleet Monitoring is untouched. The
// previewed amount is the exact catalog delta, so it equals the amount charged.

const TIER_LABELS = {
  air_cooled: 'Air Cooled (7–28 kW)',
  liquid_22_38: 'Liquid Cooled (22–45 kW)',
  liquid_48_150: 'Liquid Cooled (48–150 kW)',
};

// Shared validation/loading for both tier-change endpoints. Cadence stays as the
// subscription's current plan; only the generator class / kW tier changes.
async function loadForTierChange(req, res) {
  const { id } = req.params;
  const body = req.body || {};
  const newGenClass = body.new_gen_class;
  const customerId = body.customer_id;

  if (!catalog.SUBSCRIPTION_CATALOG[newGenClass]) {
    res.status(400).json({ error: 'invalid new_gen_class' }); return null;
  }
  const { data: sub, error } = await supabaseAdmin
    .from('generator_subscriptions')
    .select('id, customer_id, stripe_subscription_id, stripe_customer_id, gen_class, plan, status')
    .eq('id', id).single();
  if (error) throw error;
  if (!sub) { res.status(404).json({ error: 'subscription not found' }); return null; }
  if (customerId && sub.customer_id !== customerId) {
    res.status(403).json({ error: 'subscription does not belong to that customer' }); return null;
  }
  if (sub.status === 'canceled') { res.status(400).json({ error: 'subscription is canceled' }); return null; }
  if (!sub.stripe_subscription_id) { res.status(400).json({ error: 'no Stripe subscription linked' }); return null; }
  if (sub.gen_class === newGenClass) { res.status(400).json({ error: 'already on that generator class / tier' }); return null; }

  // Cadence is fixed to the current plan; resolve old/new tier prices at it.
  const curPlan = sub.plan;
  const oldEntry = catalog.planEntry(sub.gen_class, curPlan);
  const newEntry = catalog.planEntry(newGenClass, curPlan);
  if (!newEntry) { res.status(400).json({ error: `no ${newGenClass} price at ${curPlan} cadence` }); return null; }

  const subscription = await stripe.subscriptions.retrieve(sub.stripe_subscription_id, { expand: ['schedule'] });
  if (subscription.status === 'canceled') { res.status(400).json({ error: 'Stripe subscription is canceled' }); return null; }
  const sched = subscription.schedule;
  const schedStatus = sched && typeof sched === 'object' ? sched.status : (sched ? 'active' : null);
  if (sched && (schedStatus === 'active' || schedStatus === 'not_started')) {
    res.status(409).json({ error: 'This customer has a pending change at renewal. Undo it first, then change the tier.' });
    return null;
  }
  const items = (subscription.items && subscription.items.data) || [];
  const planItem = items.find((it) => catalog.isPlanPriceId(it.price.id));
  if (!planItem) { res.status(400).json({ error: 'no recognized plan price on subscription' }); return null; }
  const hasFleet = items.some((it) => catalog.isFleetPriceId(it.price.id));
  const periodEnd = subscription.current_period_end || planItem.current_period_end || null;
  // Flat catalog difference (signed): >0 = upgrade (charge), <0 = downgrade (credit).
  const diff = newEntry.amount_cents - (oldEntry ? oldEntry.amount_cents : 0);
  return { sub, planItem, newGenClass, curPlan, hasFleet, oldEntry, newEntry, diff, periodEnd };
}

// POST /api/generator-care/subscriptions/:id/tier-change-preview
// Body: { new_gen_class, customer_id? }. Previews the FULL flat catalog difference
// (new tier - old tier, at the current cadence). Deterministic — the amount shown
// equals exactly what is charged/credited on apply. No change made.
router.post('/subscriptions/:id/tier-change-preview', async (req, res) => {
  try {
    const loaded = await loadForTierChange(req, res);
    if (!loaded) return;
    const { newGenClass, curPlan, hasFleet, newEntry, diff, periodEnd } = loaded;

    const direction = diff < 0 ? 'credit' : 'charge';
    const newRenewalCents = newEntry.amount_cents
      + (hasFleet ? catalog.FLEET_CATALOG[curPlan].amount_cents : 0);

    return res.json({
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
    });
  } catch (err) {
    console.error('[generator-care] tier-change-preview error:', err && err.message);
    return res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/generator-care/subscriptions/:id/tier-change
// Body: { new_gen_class, customer_id? }. Charges the FULL flat tier difference now
// (upgrade) via an immediate invoice, or applies it as account credit toward the
// next invoice (downgrade), then swaps the recurring base price to the new tier
// with proration_behavior:'none' (no time-proration line). Cadence + Fleet are
// unchanged. Persists gen_class. The charged amount equals the catalog delta the
// preview showed.
router.post('/subscriptions/:id/tier-change', requirePermission('billing_actions'), async (req, res) => {
  try {
    const loaded = await loadForTierChange(req, res);
    if (!loaded) return;
    const { sub, planItem, newGenClass, curPlan, hasFleet, newEntry, diff } = loaded;
    const tierDesc = `Generator tier correction: ${TIER_LABELS[sub.gen_class] || sub.gen_class} → ${TIER_LABELS[newGenClass] || newGenClass}`;

    // 1. Settle the full flat difference now (independent of time elapsed).
    if (diff > 0) {
      // Upgrade: bill the difference immediately on a one-time invoice that
      // charges the card on file (flows through invoice.paid -> state-branded
      // receipt + Recent Invoices/Accounting, like every other charge).
      const pmId = await resolveSavedPaymentMethod(sub.stripe_subscription_id, sub.stripe_customer_id);
      if (!pmId) {
        const linkResult = await emailCardUpdateLinkForSub(sub.id);
        return res.status(402).json({ error: 'no saved card on file', reason: 'no saved card on file', card_update_email_sent: !!(linkResult && linkResult.sent) });
      }
      let invoice;
      try {
        invoice = await stripe.invoices.create({
          customer: sub.stripe_customer_id,
          collection_method: 'charge_automatically',
          default_payment_method: pmId,
          auto_advance: false,
          description: tierDesc,
          metadata: { tier_change: '1', subscription_id: sub.id, new_gen_class: newGenClass },
        });
        await stripe.invoiceItems.create({
          customer: sub.stripe_customer_id,
          invoice: invoice.id,
          amount: diff,
          currency: 'usd',
          description: tierDesc,
          metadata: { tier_change: '1', subscription_id: sub.id },
        });
        invoice = await stripe.invoices.finalizeInvoice(invoice.id);
        invoice = await stripe.invoices.pay(invoice.id);
      } catch (stripeErr) {
        const reason = (stripeErr && (stripeErr.message || stripeErr.code)) || 'charge failed';
        if (invoice && invoice.id) { try { await stripe.invoices.voidInvoice(invoice.id); } catch (e) {} }
        return res.status(402).json({ error: 'tier-correction charge failed', reason });
      }
    } else if (diff < 0) {
      // Downgrade: full difference becomes account credit toward the next invoice
      // (NOT a cash refund — the office uses the refund control for that).
      await stripe.customers.createBalanceTransaction({
        customer: sub.stripe_customer_id,
        amount: diff, // negative = credit
        currency: 'usd',
        description: tierDesc + ' (credit)',
      });
    }

    // 2. Swap the recurring base price to the new tier — NO time-proration.
    //    Only the plan item changes; Fleet (if any) is left untouched (cadence
    //    is unchanged, so no interval mismatch).
    await stripe.subscriptions.update(sub.stripe_subscription_id, {
      items: [{ id: planItem.id, price: newEntry.price_id }],
      proration_behavior: 'none',
    });

    // 3. Persist the new class locally (cadence unchanged; the subscription.updated
    //    webhook also re-syncs gen_class/price/fleet from the new items as a backstop).
    const annual = catalog.annualPriceCents(newGenClass, curPlan, hasFleet);
    await supabaseAdmin
      .from('generator_subscriptions')
      .update(Object.assign({ gen_class: newGenClass }, annual != null ? { annual_price_cents: annual } : {}))
      .eq('id', sub.id);

    return res.json({
      ok: true,
      new_gen_class: newGenClass,
      charged_cents: diff > 0 ? diff : 0,
      credited_cents: diff < 0 ? Math.abs(diff) : 0,
      new_renewal_cents: newEntry.amount_cents + (hasFleet ? catalog.FLEET_CATALOG[curPlan].amount_cents : 0),
    });
  } catch (err) {
    console.error('[generator-care] tier-change error:', err && err.message);
    return res.status(500).json({ error: (err && err.message) || 'Server error' });
  }
});

// POST /api/generator-care/subscriptions/:id/resend-receipt
// Body: { invoice_id }
// Re-sends OUR state-branded receipt for that paid invoice's charge, reusing the
// exact same builder + data path as the automatic invoice.paid receipt (real
// amount/date/last-4/description/receipt number; branded by the customer's CURRENT
// install_state; sent to their CURRENT email). Does NOT resend a Stripe-hosted
// invoice. Office-gated; ownership-checked.
router.post('/subscriptions/:id/resend-receipt', async (req, res) => {
  try {
    const { id } = req.params;
    const { invoice_id } = req.body || {};
    if (!invoice_id) return res.status(400).json({ error: 'invoice_id required' });

    const { data: sub, error: subErr } = await supabaseAdmin
      .from('generator_subscriptions')
      .select('stripe_customer_id')
      .eq('id', id)
      .single();
    if (subErr) throw subErr;
    if (!sub || !sub.stripe_customer_id) {
      return res.status(404).json({ error: 'subscription not found' });
    }

    let invoice;
    try {
      invoice = await stripe.invoices.retrieve(invoice_id);
    } catch (e) {
      return res.status(404).json({ error: 'invoice not found in Stripe' });
    }
    // Ownership guard: the invoice must belong to this subscription's customer.
    const invCustomer = typeof invoice.customer === 'string' ? invoice.customer : (invoice.customer && invoice.customer.id);
    if (!invCustomer || invCustomer !== sub.stripe_customer_id) {
      return res.status(403).json({ error: 'invoice does not belong to this customer' });
    }
    if (invoice.status !== 'paid') {
      return res.status(400).json({ error: 'can only resend a receipt for a paid invoice' });
    }

    const result = await sendReceiptEmail(invoice);
    if (!result || !result.sent) {
      return res.status(502).json({ ok: false, error: (result && result.reason) || 'receipt send failed' });
    }
    return res.json({ ok: true, sent: true });
  } catch (err) {
    console.error('[generator-care] resend-receipt error:', err && err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /api/generator-care/subscriptions/:id
// Edit subscription details: next_visit_due, status, notes, and the descriptive
// generator make/model + serial (gen_model, gen_serial). Office-gated (router).
// IDOR: pass customer_id to require the sub to belong to that customer.
// Deliberately whitelisted — gen_class, plan, price, and fleet are NOT editable
// here (they determine billing), so passing them has no effect.
router.patch('/subscriptions/:id', requirePermission('customer_edit'), async (req, res) => {
  try {
    const { id } = req.params;
    const { next_visit_due, status, notes, gen_model, gen_serial, customer_id } = req.body || {};

    // Build update payload (only include fields user actually passed)
    const updates = {};
    if (next_visit_due !== undefined) updates.next_visit_due = next_visit_due || null;
    if (status !== undefined) updates.status = status;
    if (notes !== undefined) updates.notes = notes;
    // Descriptive generator fields — trim, store null when blanked.
    if (gen_model !== undefined) updates.gen_model = (gen_model == null ? null : String(gen_model).trim()) || null;
    if (gen_serial !== undefined) updates.gen_serial = (gen_serial == null ? null : String(gen_serial).trim()) || null;
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'no editable fields provided' });
    }

    // Update the subscription. The optional customer_id filter is the IDOR guard:
    // if provided and it doesn't match, 0 rows update -> 404 (no cross-customer edit).
    let q = supabaseAdmin.from('generator_subscriptions').update(updates).eq('id', id);
    if (customer_id) q = q.eq('customer_id', customer_id);
    const { data: updated, error: subErr } = await q.select().maybeSingle();
    if (subErr) throw subErr;
    if (!updated) return res.status(404).json({ error: 'subscription not found for this customer' });

    // If next_visit_due changed, sync the most-recent scheduled visit row to match.
    if (next_visit_due !== undefined && next_visit_due) {
      await supabaseAdmin
        .from('generator_service_visits')
        .update({ scheduled_date: next_visit_due })
        .eq('subscription_id', id)
        .eq('status', 'scheduled');
    }

    res.json({ ok: true, subscription: updated });
  } catch (err) {
    console.error('[generator-care] subscription patch error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /api/generator-care/customers/:id
// Edit customer-level fields from the dashboard modal: the internal `notes`,
// plus Contact & Address (name, phone, email, install_*). Notes/contact live on
// the customer (not the subscription) so they persist if the customer ever
// resubscribes. Editing install_state to FL switches the customer to the
// "S.E. Bates Electric" DBA branding on future emails/receipts (companyName()).
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
router.patch('/customers/:id', requirePermission('customer_edit'), async (req, res) => {
  try {
    const { id } = req.params;
    const body = req.body || {};
    const { notes, name, phone, email, install_address, install_city, install_state, install_zip } = body;

    const updates = {};
    if (notes !== undefined) updates.notes = notes;

    // Core contact fields are required-not-empty when supplied (a blank name or
    // email would break receipts/branding). Address parts are trimmed as given.
    if (name !== undefined) {
      const v = String(name).trim();
      if (!v) return res.status(400).json({ error: 'Name cannot be empty.' });
      updates.name = v;
    }
    if (email !== undefined) {
      const v = String(email).trim();
      if (!v) return res.status(400).json({ error: 'Email cannot be empty.' });
      if (!EMAIL_RE.test(v)) return res.status(400).json({ error: 'Please enter a valid email address.' });
      updates.email = v;
    }
    if (phone !== undefined) {
      const v = String(phone).trim();
      if (!v) return res.status(400).json({ error: 'Phone cannot be empty.' });
      updates.phone = v;
    }
    if (install_address !== undefined) updates.install_address = String(install_address).trim();
    if (install_city !== undefined) updates.install_city = String(install_city).trim();
    // Normalize state to a clean 2-letter uppercase code — drives FL branding.
    if (install_state !== undefined) updates.install_state = String(install_state).trim().toUpperCase().slice(0, 2);
    if (install_zip !== undefined) updates.install_zip = String(install_zip).trim();

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'no editable fields provided' });
    }

    const { data: updated, error: custErr } = await supabaseAdmin
      .from('generator_customers')
      .update(updates)
      .eq('id', id)
      .select()
      .single();
    if (custErr) throw custErr;
    if (!updated) return res.status(404).json({ error: 'customer not found' });

    // Best-effort sync of email + phone to the Stripe customer so records stay
    // consistent (Stripe receipts, Customer Portal). NOT the address: per the
    // generator-webhook design note, Stripe holds the BILLING address while
    // install_address is the generator's physical/service location — they may
    // legitimately differ, so we never overwrite one with the other. A Stripe
    // hiccup must not block the local save (the DB update above already stuck).
    const contactChanged = updates.email !== undefined || updates.phone !== undefined || updates.name !== undefined;
    if (contactChanged && updated.stripe_customer_id) {
      try {
        const stripeUpdates = {};
        if (updates.email !== undefined) stripeUpdates.email = updated.email;
        if (updates.phone !== undefined) stripeUpdates.phone = updated.phone;
        if (updates.name !== undefined) stripeUpdates.name = updated.name;
        if (Object.keys(stripeUpdates).length) {
          await stripe.customers.update(updated.stripe_customer_id, stripeUpdates);
        }
      } catch (e) {
        console.error('[generator-care] Stripe customer sync failed (saved locally anyway):', e && e.message);
      }
    }

    res.json({ ok: true, customer: updated });
  } catch (err) {
    console.error('[generator-care] customer patch error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/generator-care/subscriptions/:id/cancel
// Cancel subscription at the end of the current billing period.
// Customer keeps service through paid-through date; Stripe stops auto-renewal.
// DB marks 'canceled' with optional reason in notes.
router.post('/subscriptions/:id/cancel', requirePermission('refunds'), async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body || {};

    const { data: sub, error: subErr } = await supabaseAdmin
      .from('generator_subscriptions')
      .select('*, customer:generator_customers(name, email, install_state)')
      .eq('id', id)
      .single();
    if (subErr) throw subErr;
    if (!sub) return res.status(404).json({ error: 'subscription not found' });
    if (sub.status === 'canceled') {
      return res.status(400).json({ error: 'subscription already canceled' });
    }
    if (!sub.stripe_subscription_id) {
      return res.status(400).json({ error: 'no Stripe subscription linked' });
    }

    // Cancel at period end in Stripe
    let stripeSub;
    try {
      stripeSub = await stripe.subscriptions.update(sub.stripe_subscription_id, {
        cancel_at_period_end: true,
        cancellation_details: reason ? { comment: reason } : undefined,
      });
    } catch (stripeErr) {
      console.error('[generator-care] Stripe cancel failed:', stripeErr);
      return res.status(502).json({ error: 'Stripe update failed', reason: stripeErr.message });
    }

    const today = new Date().toISOString().slice(0, 10);
    // current_period_end moved to the item level in recent Stripe API versions.
    const periodEndTs = stripeSub.current_period_end
      || (stripeSub.items && stripeSub.items.data && stripeSub.items.data[0] && stripeSub.items.data[0].current_period_end)
      || null;
    const periodEnd = periodEndTs ? new Date(periodEndTs * 1000).toISOString().slice(0, 10) : null;

    // Send the cancellation confirmation NOW. The cancel is at period end, so
    // customer.subscription.deleted won't fire until that date (potentially months
    // away) — waiting for it would leave the customer with no confirmation. Email
    // failure must never fail the cancel (same rule as the webhook side-effects).
    let cancellationEmailSent = false;
    try {
      const r = await sendCancellationEmail({
        customer: {
          name: sub.customer && sub.customer.name,
          email: sub.customer && sub.customer.email,
          install_state: sub.customer && sub.customer.install_state,
        },
        periodEndDate: periodEnd,
      });
      cancellationEmailSent = !!(r && r.sent);
    } catch (e) {
      console.error('[generator-care] cancellation email failed:', e && e.message);
    }

    const noteAddition = 'Canceled on ' + today + (reason ? ': ' + reason : '');
    const newNotes = sub.notes ? sub.notes + '\n\n' + noteAddition : noteAddition;
    // Stash the paid-through date (for the dashboard banner) and, if we sent the
    // confirmation, a dedupe marker so the eventual subscription.deleted event
    // doesn't send a second email.
    const newMeta = { ...(sub.raw_metadata || {}), service_through: periodEnd };
    if (cancellationEmailSent) newMeta.cancellation_email_sent_at = new Date().toISOString();

    const { data: updated, error: updErr } = await supabaseAdmin
      .from('generator_subscriptions')
      .update({
        status: 'canceled',
        canceled_at: new Date().toISOString(),
        notes: newNotes,
        raw_metadata: newMeta,
      })
      .eq('id', id)
      .select()
      .single();
    if (updErr) throw updErr;

    res.json({
      ok: true,
      subscription: updated,
      service_through: periodEnd,
      cancellation_email_sent: cancellationEmailSent,
    });
  } catch (err) {
    console.error('[generator-care] cancel subscription error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// === CUSTOMER PORTAL ===

// POST /subscriptions/:id/portal-session
// Creates a Stripe Customer Portal session for the subscription's customer.
// Returns a one-time URL that the customer can use to update their card,
// see invoice history, or change their email/phone/address.
router.post('/subscriptions/:id/portal-session', async (req, res) => {
  try {
    const { data: sub, error: subErr } = await supabaseAdmin
      .from('generator_subscriptions')
      .select('stripe_customer_id, customer:generator_customers(name, email, install_state)')
      .eq('id', req.params.id)
      .single();
    if (subErr) throw subErr;
    if (!sub || !sub.stripe_customer_id) {
      return res.status(404).json({ error: 'Subscription or Stripe customer not found' });
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: sub.stripe_customer_id,
      return_url: 'https://app.bates-electric.com/generator-care.html'
    });

    const customerName = (sub.customer && sub.customer.name) || null;
    const customerEmail = (sub.customer && sub.customer.email) || null;
    const customerState = (sub.customer && sub.customer.install_state) || null;

    // Auto-send the link to the customer (so Amy doesn't have to copy/paste).
    let emailSent = false;
    let emailReason = 'no email on file';
    if (customerEmail) {
      const r = await sendCardUpdateLinkEmail({
        name: customerName,
        email: customerEmail,
        portalUrl: session.url,
        companyState: customerState,
      });
      emailSent = r.sent;
      emailReason = r.reason || (r.sent ? 'sent' : 'failed');
    }

    res.json({
      url: session.url,
      customer_email: customerEmail,
      customer_name: customerName,
      expires_at: session.expires_at,
      email_sent: emailSent,
      email_status: emailReason,
    });
  } catch (err) {
    console.error('[portal-session] error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /subscriptions/:id/resend-welcome
// Re-renders the welcome email from the subscription's current data and sends
// it to the customer on file. Same template that fires from
// customer.subscription.created. Useful when a customer says they never got
// the original or accidentally deleted it.
router.post('/subscriptions/:id/resend-welcome', async (req, res) => {
  try {
    const { data: sub, error: subErr } = await supabaseAdmin
      .from('generator_subscriptions')
      .select(`
        id, plan, annual_price_cents, signup_date, next_visit_due, last_visit_date, fleet_monitoring,
        gen_class, gen_type_label, gen_model, gen_serial,
        raw_metadata,
        customer:generator_customers(name, email, install_address, install_city, install_state, install_zip)
      `)
      .eq('id', req.params.id)
      .single();
    if (subErr) throw subErr;
    if (!sub) return res.status(404).json({ error: 'Subscription not found' });

    const customer = sub.customer || {};
    if (!customer.email) {
      return res.status(400).json({
        ok: false,
        error: 'No email on file for this customer',
        customer_name: customer.name || null,
      });
    }

    // Prefer raw_metadata (what Stripe sent at signup); fall back to the
    // denormalized columns on the subscription/customer rows for older subs.
    const rawMeta = sub.raw_metadata || {};
    const meta = {
      gen_class: rawMeta.gen_class || sub.gen_class || '',
      gen_type: rawMeta.gen_type || sub.gen_type_label || '',
      gen_model: rawMeta.gen_model || sub.gen_model || '',
      gen_serial: rawMeta.gen_serial || sub.gen_serial || '',
      install_address: rawMeta.install_address || customer.install_address || '',
      install_city: rawMeta.install_city || customer.install_city || '',
      install_state: rawMeta.install_state || customer.install_state || '',
      install_zip: rawMeta.install_zip || customer.install_zip || '',
    };
    const planLabel = sub.plan === 'semi_annual' ? 'Semi-Annual' : (sub.plan === 'annual' ? 'Annual' : sub.plan);

    // If the first service visit has already happened, suppress the "First
    // visit:" row in the welcome email — showing a future date when there's
    // a prior last_visit_date would just confuse the customer.
    const nextVisitForEmail = sub.last_visit_date ? null : sub.next_visit_due;

    // On resend we don't re-fetch the original Stripe charge; use the per-period
    // amount from the plan (annual billed in full; semi-annual billed at half).
    // Correct for standard signups; a promo-discounted first charge isn't
    // reconstructed here (the signup-time welcome from the webhook uses the exact
    // charged amount).
    const resendPaidCents = sub.annual_price_cents != null
      ? (sub.plan === 'semi_annual' ? Math.round(sub.annual_price_cents / 2) : sub.annual_price_cents)
      : null;

    const { subject, html, text } = buildWelcomeEmail({
      customer,
      meta,
      planLabel,
      nextVisitDate: nextVisitForEmail,
      annualPriceCents: sub.annual_price_cents,
      fleetMonitoring: sub.fleet_monitoring,
      paidAmountCents: resendPaidCents,
      paidDate: sub.signup_date || null,
    });

    const result = await sendEmail({
      to: customer.email,
      subject,
      html,
      text,
      logTag: '[resend-welcome]',
      // From display name: brand on the customer's CURRENT state, not signup meta.
      companyState: customer.install_state || meta.install_state,
    });

    return res.json({
      ok: result.sent,
      sent: result.sent,
      customer_name: customer.name || null,
      customer_email: customer.email,
      email_status: result.reason || (result.sent ? 'sent' : 'failed'),
    });
  } catch (err) {
    console.error('[resend-welcome] error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Send the cancellation-confirmation email (period-end aware). Mirrors the
// webhook's sender so the dashboard cancel endpoint can confirm immediately
// instead of waiting for customer.subscription.deleted. Returns { sent, reason }.
async function sendCancellationEmail({ customer, periodEndDate }) {
  if (!customer || !customer.email) {
    console.log('[cancellation-email] no email on file, skipping');
    return { sent: false, reason: 'no email on file' };
  }
  const { subject, html, text } = buildCancellationEmail({ customer, periodEndDate });
  return sendEmail({
    to: customer.email,
    subject,
    html,
    text,
    logTag: '[cancellation-email]',
    companyState: customer.install_state,
  });
}

module.exports = router;
