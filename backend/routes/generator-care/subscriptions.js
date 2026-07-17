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
const { normalizePhone, recordConsent, sendSms, buildOptInConfirmationSms, upsertSimpleTextingContact, CONSENT_TEXT } = require('../../lib/sms');
const planChange = require('../../lib/planChange');

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
// List of all subscriptions joined with customer info, sorted by next-visit-due
// ascending. Also carries the attention signals the Needs Attention queue and
// the "Where they're at" column derive from: performed-unbilled + failed
// add-ons, failed ad-hoc charges, and pending customer visit preferences.
// Those are THREE batched queries across the whole book — never per-customer —
// so this endpoint stays one round-trip-bounded at hundreds of customers.
router.get('/subscriptions', async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('generator_subscriptions')
      .select(`
        id, plan, gen_class, gen_type_label, gen_model, gen_serial,
        fleet_monitoring, status, annual_price_cents,
        signup_date, next_visit_due, last_visit_date,
        stripe_subscription_id, stripe_customer_id, notes, created_at,
        work_order_created_at, work_order_number, canceled_at,
        service_through:raw_metadata->>service_through,
        customer:generator_customers(id, name, email, phone, install_address, install_city, install_state, install_zip),
        visits:generator_service_visits(id, status, appointment_at, arrival_window, completed_date, scheduled_date, visit_type)
      `)
      .order('next_visit_due', { ascending: true, nullsFirst: false });
    if (error) throw error;

    const subIds = (data || []).map((s) => s.id);

    // Attention signals, batched. Each result is optional: if one query fails
    // (e.g. a migration not applied), the list still renders without it.
    let addonRows = [];
    let adhocRows = [];
    let prefRows = [];
    if (subIds.length) {
      const [addonR, adhocR, prefR] = await Promise.all([
        supabaseAdmin
          .from('generator_pending_addons')
          .select('subscription_id, addon_type, amount_cents, status')
          .in('status', ['performed', 'failed'])
          .in('subscription_id', subIds),
        supabaseAdmin
          .from('generator_adhoc_charges')
          .select('subscription_id, description, amount_cents, status')
          .eq('status', 'failed')
          .in('subscription_id', subIds),
        supabaseAdmin
          .from('generator_visit_preferences')
          .select('visit_id, slots, note, created_at, visit:generator_service_visits(subscription_id)')
          .eq('status', 'pending')
          .order('created_at', { ascending: false }),
      ]);
      if (!addonR.error && addonR.data) addonRows = addonR.data;
      if (!adhocR.error && adhocR.data) adhocRows = adhocR.data;
      if (!prefR.error && prefR.data) prefRows = prefR.data;
    }

    const addonsBySub = new Map();
    for (const a of addonRows) {
      if (!addonsBySub.has(a.subscription_id)) addonsBySub.set(a.subscription_id, []);
      addonsBySub.get(a.subscription_id).push(a);
    }
    const adhocBySub = new Map();
    for (const c of adhocRows) {
      if (!adhocBySub.has(c.subscription_id)) adhocBySub.set(c.subscription_id, []);
      adhocBySub.get(c.subscription_id).push(c);
    }
    // Pending prefs resolve to their subscription DIRECTLY (via the visit join
    // in the query above) — never through the s.visits join below, whose scope
    // must not decide whether a customer's request surfaces. Newest wins.
    const prefBySub = new Map();
    for (const p of prefRows) {
      const sid = p.visit && p.visit.subscription_id;
      if (sid && !prefBySub.has(sid)) prefBySub.set(sid, p); // rows sorted newest-first
    }

    // Attach each sub's current OPEN (un-completed) visit so the list STATUS
    // column can show Needs scheduling vs Scheduled — without shipping every visit.
    const subscriptions = (data || []).map((s) => {
      const open = (s.visits || [])
        .filter((v) => v.status !== 'completed' && !v.completed_date)
        .sort((a, b) => String(a.appointment_at || a.scheduled_date || '').localeCompare(String(b.appointment_at || b.scheduled_date || '')))[0] || null;
      // Newest pending customer preference for this sub (booking marks prefs
      // used, resubmits dismiss older ones, so this is ~the open visit's).
      const pref = prefBySub.get(s.id) || null;
      const addons = addonsBySub.get(s.id) || [];
      const { visits, ...rest } = s;
      return {
        ...rest,
        open_visit: open
          ? { id: open.id, status: open.status, appointment_at: open.appointment_at, arrival_window: open.arrival_window || null, scheduled_date: open.scheduled_date }
          : null,
        attention: {
          performed_addons: addons
            .filter((a) => a.status === 'performed' && (a.amount_cents || 0) > 0)
            .map((a) => ({ addon_type: a.addon_type, amount_cents: a.amount_cents })),
          failed_addons: addons
            .filter((a) => a.status === 'failed')
            .map((a) => ({ addon_type: a.addon_type, amount_cents: a.amount_cents })),
          failed_charges: (adhocBySub.get(s.id) || [])
            .map((c) => ({ description: c.description, amount_cents: c.amount_cents })),
          pending_prefs: pref
            ? { visit_id: pref.visit_id, slots: pref.slots, note: pref.note, created_at: pref.created_at }
            : null,
        },
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

    // SMS state (Phase 1): the customer's consent row + the latest outbound
    // text per visit, so the visit rows can show sent/blocked/confirmed and
    // the contact card shows opted-in/out. Graceful no-op pre-025.
    let smsConsent = null;
    let visitSms = {};
    try {
      const customerId = subR.data && subR.data.customer && subR.data.customer.id;
      if (customerId) {
        const { data: consentRows, error: consentErr } = await supabaseAdmin
          .from('generator_sms_consent')
          .select('phone, opted_in, opted_out, source, opted_in_at, opted_out_at')
          .eq('customer_id', customerId)
          .order('updated_at', { ascending: false });
        if (!consentErr && consentRows && consentRows.length) smsConsent = consentRows[0];
      }
      const visitIds = (visitsR.data || []).map((v) => v.id);
      if (visitIds.length) {
        const { data: msgRows, error: msgErr } = await supabaseAdmin
          .from('generator_sms_messages')
          .select('related_visit_id, direction, status, detail, created_at')
          .in('related_visit_id', visitIds)
          .eq('direction', 'out')
          .order('created_at', { ascending: false });
        if (!msgErr && msgRows) {
          for (const m of msgRows) {
            if (!visitSms[m.related_visit_id]) visitSms[m.related_visit_id] = m; // newest wins
          }
        }
      }
    } catch (e) {
      console.log('[generator-care] sms state unavailable (migration pending?):', e && e.message);
    }

    res.json({
      subscription: subR.data,
      visits: visitsR.data || [],
      pending_addons: addonsR.data || [],
      adhoc_charges: adhocR.data || [],
      visit_preferences: visitPreferences,
      sms_consent: smsConsent,
      visit_sms: visitSms,
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
      plan_billing = planChange.computePlanBilling(subResult.value);
    } else if (subResult.status === 'rejected') {
      console.error('[stripe-data] subscription retrieve failed:', subResult.reason && subResult.reason.message);
    }

    res.json({ payment_method, lifetime_billed_cents, recent_invoices, signup_charge_cents, plan_billing });
  } catch (err) {
    console.error('[generator-care] stripe-data error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/generator-care/billing-snapshot
// Batched Stripe enrichment for the Needs Attention queue: renewal date,
// cancel-at-period-end flag, and card-on-file expiry for EVERY subscription,
// via paginated subscriptions.list calls (100 per call — a handful of round
// trips at hundreds of customers, never one call per customer). The dashboard
// loads this lazily in parallel with the Supabase list; when Stripe is
// unreachable we return an empty map with `unavailable: true` so the queue
// still renders its DB-derived items instead of failing the page.
router.get('/billing-snapshot', async (req, res) => {
  try {
    const billing = {};
    // The customer's card usually rides on the SUBSCRIPTION default payment
    // method (Checkout attaches it there), but fall back to the customer's
    // invoice-settings default — same order as resolveSavedPaymentMethod().
    // The 4-level customer expand is at Stripe's depth limit; if it's ever
    // rejected, retry with the shallow expand rather than losing the snapshot.
    const expands = [
      ['data.default_payment_method', 'data.customer.invoice_settings.default_payment_method'],
      ['data.default_payment_method'],
    ];
    let subs = null;
    let lastErr = null;
    for (const expand of expands) {
      try {
        const collected = [];
        for await (const s of stripe.subscriptions.list({ status: 'all', limit: 100, expand })) {
          collected.push(s);
          if (collected.length >= 1000) break; // runaway safety cap
        }
        subs = collected;
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        subs = null;
      }
    }
    if (!subs) throw lastErr || new Error('subscriptions.list failed');

    for (const s of subs) {
      if (!s || s.status === 'canceled' || s.status === 'incomplete_expired') continue;
      const items = (s.items && s.items.data) || [];
      // current_period_end moved onto items in 2025-03-31.basil (see planChange.computePlanBilling).
      const periodEnd = s.current_period_end || (items[0] && items[0].current_period_end) || null;
      let pm = s.default_payment_method;
      if (!pm || typeof pm !== 'object') {
        const cust = s.customer;
        const invPm = cust && typeof cust === 'object' && cust.invoice_settings
          ? cust.invoice_settings.default_payment_method
          : null;
        pm = invPm && typeof invPm === 'object' ? invPm : null;
      }
      const card = pm && pm.card ? pm.card : null;
      billing[s.id] = {
        stripe_status: s.status,
        cancel_at_period_end: !!s.cancel_at_period_end,
        period_end: periodEnd ? new Date(periodEnd * 1000).toISOString().slice(0, 10) : null,
        card: card
          ? {
              brand: card.brand || null,
              last4: card.last4 || null,
              exp_month: card.exp_month || null,
              exp_year: card.exp_year || null,
            }
          : null,
      };
    }
    res.json({ billing });
  } catch (err) {
    console.error('[generator-care] billing-snapshot error:', err && err.message);
    res.json({ billing: {}, unavailable: true });
  }
});

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

    const { data: sub, error: subErr } = await supabaseAdmin
      .from('generator_subscriptions')
      .select('id, stripe_subscription_id, gen_class, plan, status')
      .eq('id', id)
      .single();
    if (subErr) throw subErr;
    if (!sub) return res.status(404).json({ error: 'subscription not found' });

    const result = await planChange.changePlanAtRenewal({ stripe, subRow: sub, newPlan: new_plan });
    if (result.error) return res.status(result.status || 400).json({ error: result.error });

    return res.json({
      ok: true,
      new_plan: result.new_plan,
      effective_date: result.effective_date,
      schedule_id: result.schedule_id,
      new_renewal_amount_cents: result.new_renewal_amount_cents,
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

    const result = await planChange.revertPlanChange({ stripe, subRow: sub });
    if (result.error) return res.status(result.status || 400).json({ error: result.error });
    return res.json({ ok: true, released: result.released });
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
    const { items, planItem, plan, fleet, hasFleet } = planChange.fleetContext(subscription);
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
    const result = await planChange.addFleetNow({ stripe, subRow: { ...sub, id }, prorationDate: proration_date });
    if (result.error) return res.status(result.status || 400).json({ error: result.error });

    return res.json({
      ok: true,
      plan: result.plan,
      combined_renewal_cents: result.combined_renewal_cents,
      period_end: result.period_end,
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
    const result = await planChange.removeFleetAtRenewal({ stripe, subRow: sub });
    if (result.error) return res.status(result.status || 400).json({ error: result.error });

    return res.json({
      ok: true,
      effective_date: result.effective_date,
      schedule_id: result.schedule_id,
      new_renewal_amount_cents: result.new_renewal_amount_cents,
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
const tierLabel = (genClass) => TIER_LABELS[genClass] || genClass;

// Shared row-loading + IDOR guard for both tier-change endpoints (the Stripe
// guards, diff computation, and mutation live in lib/planChange.js).
async function loadTierChangeRow(req, res) {
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
  return { sub, newGenClass };
}

// POST /api/generator-care/subscriptions/:id/tier-change-preview
// Body: { new_gen_class, customer_id? }. Previews the FULL flat catalog difference
// (new tier - old tier, at the current cadence). Deterministic — the amount shown
// equals exactly what is charged/credited on apply. No change made.
router.post('/subscriptions/:id/tier-change-preview', async (req, res) => {
  try {
    const loaded = await loadTierChangeRow(req, res);
    if (!loaded) return;
    const { sub, newGenClass } = loaded;

    const result = await planChange.tierChangePreview({ stripe, subRow: sub, newGenClass });
    if (result.error) return res.status(result.status || 400).json({ error: result.error });
    return res.json(result);
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
    const loaded = await loadTierChangeRow(req, res);
    if (!loaded) return;
    const { sub, newGenClass } = loaded;

    const result = await planChange.applyTierChange({
      stripe, subRow: sub, newGenClass, resolveSavedPaymentMethod, emailCardUpdateLinkForSub, tierLabel,
    });
    if (result.error) {
      // reason / card_update_email_sent are only present on the card-on-file
      // failure paths — pass them through when set, omit otherwise (matches
      // the pre-unification response shapes exactly).
      const body = { error: result.error };
      if (result.reason !== undefined) body.reason = result.reason;
      if (result.card_update_email_sent !== undefined) body.card_update_email_sent = result.card_update_email_sent;
      return res.status(result.status || 400).json(body);
    }
    return res.json(result);
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

// POST /api/generator-care/customers/:id/sms-consent { opt_in: boolean }
// Office records SMS consent for a customer (SMS Phase 1) — the "customer
// agreed verbally on the phone / at the door" path. Writes the legal consent
// row (source 'office') against the phone we have on file; opting in sends
// the carrier-required confirmation text (copy 6), still behind the
// SMS_ENABLED kill-switch inside sendSms. Same permission as editing the
// customer's contact info — it's a customer-record change, no money moved.
router.post('/customers/:id/sms-consent', requirePermission('customer_edit'), async (req, res) => {
  try {
    const { id } = req.params;
    const optIn = !!(req.body && req.body.opt_in === true);

    const { data: customer, error: custErr } = await supabaseAdmin
      .from('generator_customers')
      .select('id, name, phone, install_state')
      .eq('id', id)
      .maybeSingle();
    if (custErr) throw custErr;
    if (!customer) return res.status(404).json({ error: 'customer not found' });

    const phone = normalizePhone(customer.phone);
    if (!phone) return res.status(400).json({ error: 'No usable mobile number on file for this customer. Add a phone first.' });

    const row = await recordConsent({
      customerId: customer.id,
      phone,
      optedIn: optIn,
      source: 'office',
      consentText: CONSENT_TEXT.office,
    });
    if (!row) return res.status(500).json({ error: 'Could not save consent. Try again.' });

    if (optIn) {
      // Name their SimpleTexting contact up front so the first text lands on
      // "John Fort", not a bare number. Fire-and-forget: best-effort and
      // non-throwing, never blocks the response or the confirmation text.
      upsertSimpleTextingContact({ phone, name: customer.name });
      await sendSms({
        toPhone: phone,
        body: buildOptInConfirmationSms({ installState: customer.install_state }),
        customerId: customer.id,
        ignoreQuietHours: true, // immediate ack of consent the customer just gave
      });
    }

    res.json({ ok: true, sms_consent: { opted_in: !!(row.opted_in && !row.opted_out), phone } });
  } catch (err) {
    console.error('[generator-care] sms-consent error:', err);
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
