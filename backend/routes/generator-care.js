// backend/routes/generator-care.js
// Office dashboard data for the Generator Care program.
// All endpoints require office role.

const express = require('express');
const { supabaseAdmin } = require('../lib/supabase');
const { requireAuth, requireRole } = require('../middleware/auth');
const catalog = require('../lib/generator-catalog');

const router = express.Router();

// All routes require office role
const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const {
  sendEmail,
  buildCardUpdateLinkEmail,
  buildWelcomeEmail,
  buildCardFailedEmail,
  buildVisitScheduledEmail,
  buildVisitCompletedEmail,
  buildRenewalUpcomingEmail,
  buildCancellationEmail,
  buildArReadyToInvoiceEmail,
} = require('../lib/emails');

// Accounts Receivable mailbox — notified when a Jonas work order is marked
// created so AR can generate + send the paid invoice. Env-overridable.
const AR_EMAIL = process.env.GENERATOR_AR_EMAIL || 'ar@bates-electric.com';

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

function planLabelFor(plan) {
  return plan === 'semi_annual' ? 'Semi-Annual' : (plan === 'annual' ? 'Annual' : plan);
}

// ---- Accounting helpers (shared by the date-range and payout views) ----
// Issuer card authorization (approval) code on a charge — what Brenda reconciles
// against. Only present on the fully-retrieved charge, not always on list results.
function authCodeOf(ch) {
  return (ch && ch.payment_method_details && ch.payment_method_details.card
    && ch.payment_method_details.card.authorization_code) || null;
}
// Best-effort human label for a charge. The payout view doesn't expand the
// invoice object, so a charge tied to an invoice is labeled generically.
function chargeDescription(ch) {
  if (!ch) return 'Card charge';
  if (ch.invoice && typeof ch.invoice === 'object') {
    if (ch.invoice.description) return ch.invoice.description;
    if (ch.invoice.subscription) return 'Subscription renewal';
    return 'Invoice payment';
  }
  if (ch.invoice) return 'Subscription invoice';
  if (ch.description) return ch.description;
  if (ch.metadata && ch.metadata.adhoc_charge_id) return 'Ad-hoc charge';
  return 'Card charge';
}

// ---- Metrics helpers (date math + month bucketing for /metrics) ----
function todayYmd() { return new Date().toISOString().slice(0, 10); }
function isYmd(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s); }
// Subtract n whole months from a YYYY-MM-DD string (UTC).
function ymdMonthsAgo(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, (m - 1) - n, d)).toISOString().slice(0, 10);
}
// Dense month series [{month:'YYYY-MM', count}] spanning fromStr..toStr, counting
// how many of `dates` (YYYY-MM-DD strings) fall in each month. Empty months = 0.
function bucketByMonth(dates, fromStr, toStr) {
  const counts = {};
  for (const d of dates) { if (!d) continue; const k = d.slice(0, 7); counts[k] = (counts[k] || 0) + 1; }
  const series = [];
  let [y, m] = fromStr.slice(0, 7).split('-').map(Number);
  const [ty, tm] = toStr.slice(0, 7).split('-').map(Number);
  for (let i = 0; i < 120; i++) { // cap guards against a malformed range
    series.push({ month: `${y}-${String(m).padStart(2, '0')}`, count: counts[`${y}-${String(m).padStart(2, '0')}`] || 0 });
    if (y === ty && m === tm) break;
    m++; if (m > 12) { m = 1; y++; }
    if (y > ty || (y === ty && m > tm)) break;
  }
  return series;
}

router.use(requireAuth, requireRole('office'));

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
        customer:generator_customers(id, name, email, phone, install_address, install_city, install_state, install_zip)
      `)
      .order('next_visit_due', { ascending: true, nullsFirst: false });
    if (error) throw error;
    res.json({ subscriptions: data || [] });
  } catch (err) {
    console.error('[generator-care] subscriptions error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/generator-care/metrics?from=YYYY-MM-DD&to=YYYY-MM-DD
// Pre-computed aggregates for the Metrics / Insights dashboard. All math is done
// here (server-side), never in the browser. Two groups of metrics:
//   * SNAPSHOT (active count, ARR, plan mix, gen-class mix, add-on attach +
//     popularity) reflect the CURRENT active book and ignore from/to.
//   * FLOW (signups-by-month, channel breakdown, canceled trend) respect the
//     range. "New this month" is always the current calendar month.
const GEN_CLASS_LABELS = {
  air_cooled:    'Air-cooled (7–28 kW)',
  liquid_22_38:  'Liquid (22–45 kW)',
  liquid_48_150: 'Liquid (48–150 kW)',
};
const ADDON_LABELS = {
  fleet_monitoring:    'Fleet monitoring',
  battery_replacement: 'Battery replacement',
  battery_diagnostics: 'Battery diagnostics',
  exterior_wash:       'Exterior wash',
  coolant_flush:       'Coolant flush',
  coolant_topoff:      'Coolant top-off',
  ats_inspection:      'ATS inspection',
  ats_outage_combined: 'ATS + outage test',
  outage_test:         'Outage test',
};

router.get('/metrics', async (req, res) => {
  try {
    const toStr = isYmd(req.query.to) ? req.query.to : todayYmd();
    const fromStr = isYmd(req.query.from) ? req.query.from : ymdMonthsAgo(toStr, 12);

    // ===== Snapshot: the current active book =====
    const { data: activeSubs, error: activeErr } = await supabaseAdmin
      .from('generator_subscriptions')
      .select('id, plan, gen_class, fleet_monitoring, annual_price_cents')
      .eq('status', 'active');
    if (activeErr) throw activeErr;
    const active = activeSubs || [];
    const activeCount = active.length;
    const arrCents = active.reduce((s, r) => s + (r.annual_price_cents || 0), 0);

    const planMix = { semi_annual: 0, annual: 0 };
    const genClassMix = {};
    for (const r of active) {
      if (r.plan in planMix) planMix[r.plan]++;
      genClassMix[r.gen_class] = (genClassMix[r.gen_class] || 0) + 1;
    }

    // Add-ons: fleet_monitoring is a boolean on the sub; the rest are
    // generator_pending_addons rows (excluding canceled/failed = not opted in).
    const activeIds = active.map(r => r.id);
    const fleetCount = active.filter(r => r.fleet_monitoring).length;
    let pendingAddons = [];
    if (activeIds.length) {
      const { data: pa, error: paErr } = await supabaseAdmin
        .from('generator_pending_addons')
        .select('subscription_id, addon_type')
        .in('subscription_id', activeIds)
        .not('status', 'in', '(canceled,failed)');
      if (paErr) throw paErr;
      pendingAddons = pa || [];
    }
    const addonSubSets = {};            // addon_type -> Set(subId), so dupes per sub count once
    const subsWithAnyAddon = new Set();
    for (const a of pendingAddons) {
      (addonSubSets[a.addon_type] = addonSubSets[a.addon_type] || new Set()).add(a.subscription_id);
      subsWithAnyAddon.add(a.subscription_id);
    }
    for (const r of active) if (r.fleet_monitoring) subsWithAnyAddon.add(r.id);

    const addonPopularity = [];
    if (fleetCount > 0) addonPopularity.push({ key: 'fleet_monitoring', label: ADDON_LABELS.fleet_monitoring, count: fleetCount });
    for (const [type, set] of Object.entries(addonSubSets)) {
      addonPopularity.push({ key: type, label: ADDON_LABELS[type] || type, count: set.size });
    }
    addonPopularity.sort((a, b) => b.count - a.count);
    const attachRate = activeCount ? subsWithAnyAddon.size / activeCount : 0;

    // ===== Flow: signups in range, by month + by channel =====
    const { data: rangeSubs, error: rangeErr } = await supabaseAdmin
      .from('generator_subscriptions')
      .select('signup_date, created_at, signup_source')
      .gte('signup_date', fromStr)
      .lte('signup_date', toStr);
    if (rangeErr) throw rangeErr;
    const signupsByMonth = bucketByMonth(
      (rangeSubs || []).map(r => r.signup_date || (r.created_at || '').slice(0, 10)),
      fromStr, toStr,
    );
    const channelCounts = {};
    let channelKnown = 0;
    for (const r of (rangeSubs || [])) {
      if (r.signup_source) { channelCounts[r.signup_source] = (channelCounts[r.signup_source] || 0) + 1; channelKnown++; }
    }
    const channelBreakdown = Object.entries(channelCounts)
      .map(([source, count]) => ({ source, count }))
      .sort((a, b) => b.count - a.count);
    const { data: firstSrc } = await supabaseAdmin
      .from('generator_subscriptions')
      .select('signup_date')
      .not('signup_source', 'is', null)
      .order('signup_date', { ascending: true })
      .limit(1)
      .maybeSingle();
    const collectingSince = firstSrc ? firstSrc.signup_date : null;

    // New this month vs last month (current calendar month, range-independent).
    const monthStart = todayYmd().slice(0, 7) + '-01';
    const lastMonthStart = ymdMonthsAgo(monthStart, 1);
    const [{ count: newThisMonth }, { count: newLastMonth }] = await Promise.all([
      supabaseAdmin.from('generator_subscriptions').select('id', { count: 'exact', head: true })
        .gte('signup_date', monthStart).lte('signup_date', todayYmd()),
      supabaseAdmin.from('generator_subscriptions').select('id', { count: 'exact', head: true })
        .gte('signup_date', lastMonthStart).lt('signup_date', monthStart),
    ]);

    // ===== Churn =====
    const { count: canceledTotal } = await supabaseAdmin
      .from('generator_subscriptions')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'canceled');
    const denom = activeCount + (canceledTotal || 0);
    const overallChurn = denom > 0 ? (canceledTotal || 0) / denom : 0;

    // Canceled in range + monthly trend (needs canceled_at; null pre-005).
    const { data: canceledRows, error: canErr } = await supabaseAdmin
      .from('generator_subscriptions')
      .select('canceled_at')
      .not('canceled_at', 'is', null)
      .gte('canceled_at', fromStr)
      .lte('canceled_at', toStr + 'T23:59:59.999Z');
    if (canErr) throw canErr;
    const canceledByMonth = bucketByMonth((canceledRows || []).map(r => (r.canceled_at || '').slice(0, 10)), fromStr, toStr);
    const { data: firstCancel } = await supabaseAdmin
      .from('generator_subscriptions')
      .select('canceled_at')
      .not('canceled_at', 'is', null)
      .order('canceled_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    const cancelTrackingSince = firstCancel ? (firstCancel.canceled_at || '').slice(0, 10) : null;

    res.json({
      from: fromStr,
      to: toStr,
      generated_at: new Date().toISOString(),
      headline: {
        active_subscriptions: activeCount,
        new_this_month: newThisMonth || 0,
        new_last_month: newLastMonth || 0,
        arr_cents: arrCents,
        attach_rate: attachRate,           // 0..1
      },
      plan_mix: [
        { key: 'semi_annual', label: 'Semi-Annual', count: planMix.semi_annual },
        { key: 'annual',      label: 'Annual',      count: planMix.annual },
      ],
      gen_class_mix: Object.entries(genClassMix).map(([key, count]) => ({ key, label: GEN_CLASS_LABELS[key] || key, count })),
      addon_popularity: addonPopularity,
      signups_by_month: signupsByMonth,
      churn: {
        overall_rate: overallChurn,        // 0..1, point-in-time (NOT first-renewal)
        canceled_total: canceledTotal || 0,
        canceled_in_range: (canceledRows || []).length,
        by_month: canceledByMonth,
        tracking_since: cancelTrackingSince,
      },
      channel: {
        breakdown: channelBreakdown,
        known_count: channelKnown,
        collecting_since: collectingSince,
      },
    });
  } catch (err) {
    console.error('[generator-care] metrics error:', err);
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
    res.json({
      subscription: subR.data,
      visits: visitsR.data || [],
      pending_addons: addonsR.data || [],
      adhoc_charges: adhocR.data || [],
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
// Stamps work_order_created_at/by and emails AR the packet. Idempotent: if it's
// already marked, we don't re-notify. Email never fails the status update.
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

    // The WO number is what makes the AR email useful (she pulls the order up in
    // Jonas with it), so require it on the first mark.
    if (!alreadyMarked && !workOrderNumber) {
      return res.status(400).json({ error: 'Work order number is required.' });
    }

    let updated = sub;
    let arNotified = false;
    if (!alreadyMarked) {
      const { data: upd, error: updErr } = await supabaseAdmin
        .from('generator_subscriptions')
        .update({ work_order_created_at: new Date().toISOString(), work_order_created_by: markedBy, work_order_number: workOrderNumber })
        .eq('id', id)
        .select('*, customer:generator_customers(*)')
        .single();
      if (updErr) throw updErr;
      updated = upd;

      // Notify AR with the work-order packet. A mail hiccup must NOT fail the
      // status update — the stamp already succeeded.
      try {
        const { data: addons } = await supabaseAdmin
          .from('generator_pending_addons')
          .select('addon_type, status')
          .eq('subscription_id', id);
        const chargedAtSignupCents = await getSignupChargeCents(updated.stripe_customer_id);
        const { subject, html, text } = buildArReadyToInvoiceEmail({
          subscription: updated,
          customer: updated.customer,
          addons: addons || [],
          markedBy,
          chargedAtSignupCents,
        });
        const r = await sendEmail({ to: AR_EMAIL, subject, html, text, logTag: '[ar-ready-to-invoice]' });
        arNotified = !!(r && r.sent);
      } catch (e) {
        console.error('[ar-ready-to-invoice] unexpected:', e && e.message);
      }
    }

    res.json({ ok: true, subscription: updated, already_marked: alreadyMarked, ar_notified: arNotified, ar_email: AR_EMAIL });
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

// POST /api/generator-care/subscriptions/:id/invoice-sent  (closes the loop)
router.post('/subscriptions/:id/invoice-sent', async (req, res) => {
  try {
    const markedBy = (req.profile && req.profile.full_name) || (req.user && req.user.email) || 'office';
    const { data, error } = await supabaseAdmin
      .from('generator_subscriptions')
      .update({ invoice_sent_at: new Date().toISOString(), invoice_sent_by: markedBy })
      .eq('id', req.params.id)
      .select('*, customer:generator_customers(*)')
      .single();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'subscription not found' });
    res.json({ ok: true, subscription: data });
  } catch (err) {
    console.error('[generator-care] invoice-sent error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/generator-care/subscriptions/:id/invoice-sent/undo  (misclick recovery)
router.post('/subscriptions/:id/invoice-sent/undo', async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('generator_subscriptions')
      .update({ invoice_sent_at: null, invoice_sent_by: null })
      .eq('id', req.params.id)
      .select('*, customer:generator_customers(*)')
      .single();
    if (error) throw error;
    res.json({ ok: true, subscription: data });
  } catch (err) {
    console.error('[generator-care] invoice-sent/undo error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});


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
    pending_change: null,
  };
  const curPlanItem = items.find((it) => catalog.isPlanPriceId(it.price.id));
  const curHasFleet = items.some((it) => catalog.isFleetPriceId(it.price.id));
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
      const info = fId && catalog.planForPriceId(fId);
      const curId = curPlanItem ? curPlanItem.price.id : null;
      if (info && fId !== curId) {
        const fHasFleet = (future.items || []).some((i) => catalog.isFleetPriceId(priceIdOf(i)));
        out.pending_change = {
          new_plan: info.plan,
          effective_date: new Date(future.start_date * 1000).toISOString().slice(0, 10),
          new_renewal_amount_cents:
            info.amount_cents + (fHasFleet ? catalog.FLEET_CATALOG[info.plan].amount_cents : 0),
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
router.post('/subscriptions/:id/change-plan', async (req, res) => {
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
router.post('/subscriptions/:id/revert-plan-change', async (req, res) => {
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


// POST /api/generator-care/subscriptions/:id/resend-invoice
// Resends the most recent invoice (paid or open) via Stripe. Useful when a
// customer says they never got their receipt or needs a copy for their
// records. Stripe's own email goes out -- not one of our branded templates.
router.post('/subscriptions/:id/resend-invoice', async (req, res) => {
  try {
    const { data: sub, error: subErr } = await supabaseAdmin
      .from('generator_subscriptions')
      .select('stripe_customer_id')
      .eq('id', req.params.id)
      .single();
    if (subErr) throw subErr;
    if (!sub || !sub.stripe_customer_id) {
      return res.status(400).json({ error: 'No Stripe customer linked to this subscription.' });
    }

    const invoices = await stripe.invoices.list({
      customer: sub.stripe_customer_id,
      limit: 1,
    });
    const invoice = invoices.data[0];
    if (!invoice) {
      return res.status(404).json({ error: 'No invoices on file for this customer yet.' });
    }

    // sendInvoice works on open invoices; for already-paid ones it returns
    // the invoice unchanged (no email re-sent). Surface that distinction.
    if (invoice.status === 'paid') {
      // For a paid invoice, the right action is to email the receipt URL.
      // We don't have a dedicated Stripe API for "resend paid receipt" --
      // best we can do is point the customer at the hosted invoice URL.
      return res.json({
        ok: true,
        invoice_id: invoice.id,
        status: invoice.status,
        note: 'Most recent invoice is already paid. No re-send needed -- share hosted_invoice_url with the customer if they want a copy.',
        hosted_invoice_url: invoice.hosted_invoice_url || null,
      });
    }

    const sent = await stripe.invoices.sendInvoice(invoice.id);
    res.json({
      ok: true,
      invoice_id: invoice.id,
      status: sent.status,
      hosted_invoice_url: sent.hosted_invoice_url || null,
    });
  } catch (err) {
    console.error('[generator-care] resend-invoice error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});


// POST /api/generator-care/visits/:id/complete
// Mark a service visit completed and roll the subscription's next_visit_due forward.
router.post('/visits/:id/complete', async (req, res) => {
  try {
    const id = req.params.id;
    const { notes, addons_performed, technician_id } = req.body || {};
    const today = (req.body && req.body.completed_date) || new Date().toISOString().slice(0, 10);

    // 1. Update the visit
    const { data: updated, error: updErr } = await supabaseAdmin
      .from('generator_service_visits')
      .update({
        status: 'completed',
        completed_date: today,
        notes: notes || null,
        addons_performed: addons_performed || null,
        technician_id: technician_id || req.user.id,
      })
      .eq('id', id)
      .select('*, subscription:generator_subscriptions(id, plan, customer:generator_customers(name, email, install_state))')
      .single();
    if (updErr) throw updErr;

    // 2. Roll the subscription forward + schedule the NEXT visit
    const sub = updated.subscription;
    let nextStr = null;
    if (sub) {
      const monthsAhead = sub.plan === 'semi_annual' ? 6 : 12;
      const next = new Date(today);
      next.setMonth(next.getMonth() + monthsAhead);
      nextStr = next.toISOString().slice(0, 10);

      await supabaseAdmin
        .from('generator_subscriptions')
        .update({ last_visit_date: today, next_visit_due: nextStr })
        .eq('id', sub.id);

      await supabaseAdmin.from('generator_service_visits').insert({
        subscription_id: sub.id,
        visit_type: 'regular_service',
        scheduled_date: nextStr,
        status: 'tentative',
      });
    }

    // 3. Email the customer a completion confirmation (fire-and-forget).
    const customer = sub && sub.customer;
    if (customer && customer.email) {
      const { subject, html, text } = buildVisitCompletedEmail({
        customer,
        completedDate: today,
        nextVisitDate: nextStr,
        planLabel: planLabelFor(sub.plan),
        notes,
      });
      sendEmail({
        to: customer.email,
        subject,
        html,
        text,
        logTag: '[visit-complete-email]',
        companyState: customer.install_state,
      }).catch((e) => console.error('[visit-complete-email] unexpected:', e && e.message));
    }

    res.json({ ok: true, visit: updated });
  } catch (err) {
    console.error('[generator-care] visit complete error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});


// PATCH /api/generator-care/subscriptions/:id
// Edit subscription details (currently: next_visit_due, status, notes).
// When next_visit_due changes, also update the matching scheduled visit row.
router.patch('/subscriptions/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { next_visit_due, status, notes } = req.body || {};

    // Build update payload (only include fields user actually passed)
    const updates = {};
    if (next_visit_due !== undefined) updates.next_visit_due = next_visit_due || null;
    if (status !== undefined) updates.status = status;
    if (notes !== undefined) updates.notes = notes;
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'no editable fields provided' });
    }

    // Update the subscription
    const { data: updated, error: subErr } = await supabaseAdmin
      .from('generator_subscriptions')
      .update(updates)
      .eq('id', id)
      .select()
      .single();
    if (subErr) throw subErr;

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
router.patch('/customers/:id', async (req, res) => {
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


// POST /api/generator-care/visits/:id/confirm
// Promote a tentative visit to scheduled. Optionally update the scheduled_date in the same call.
router.post('/visits/:id/confirm', async (req, res) => {
  try {
    const { id } = req.params;
    const { scheduled_date } = req.body || {};

    const updates = { status: 'scheduled' };
    if (scheduled_date) updates.scheduled_date = scheduled_date;

    const { data: updated, error: vErr } = await supabaseAdmin
      .from('generator_service_visits')
      .update(updates)
      .eq('id', id)
      .select('*, subscription:generator_subscriptions(id, plan, customer:generator_customers(name, email, install_state))')
      .single();
    if (vErr) throw vErr;

    // If date was updated, keep subscription.next_visit_due in sync
    if (scheduled_date && updated.subscription) {
      await supabaseAdmin
        .from('generator_subscriptions')
        .update({ next_visit_due: scheduled_date })
        .eq('id', updated.subscription.id);
    }

    // Email the customer a confirmation (fire-and-forget).
    const sub = updated.subscription;
    const customer = sub && sub.customer;
    if (customer && customer.email) {
      const { subject, html, text } = buildVisitScheduledEmail({
        customer,
        scheduledDate: updated.scheduled_date,
        planLabel: planLabelFor(sub && sub.plan),
      });
      sendEmail({
        to: customer.email,
        subject,
        html,
        text,
        logTag: '[visit-scheduled-email]',
        companyState: customer.install_state,
      }).catch((e) => console.error('[visit-scheduled-email] unexpected:', e && e.message));
    }

    res.json({ ok: true, visit: updated });
  } catch (err) {
    console.error('[generator-care] confirm visit error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});


// POST /api/generator-care/addons/:id/mark-performed
// Records that a pending add-on was performed during a visit + adds it as an invoice item
// on the customer's next subscription invoice. Will be charged when subscription renews.
// Webhooks (invoice.paid / invoice.payment_failed) flip status to charged/failed.
router.post('/addons/:id/mark-performed', async (req, res) => {
  try {
    const { id } = req.params;
    const { date_performed } = req.body || {};
    const today = new Date().toISOString().slice(0, 10);
    const performedDate = date_performed || today;

    const { data: addon, error: addonErr } = await supabaseAdmin
      .from('generator_pending_addons')
      .select('*, subscription:generator_subscriptions(id, stripe_subscription_id, stripe_customer_id, customer:generator_customers(name))')
      .eq('id', id)
      .single();
    if (addonErr) throw addonErr;
    if (!addon) return res.status(404).json({ error: 'addon not found' });

    if (addon.status === 'performed' || addon.status === 'charged') {
      return res.status(400).json({ error: 'addon already ' + addon.status });
    }
    if (!addon.amount_cents || addon.amount_cents <= 0) {
      return res.status(400).json({ error: 'no charge amount' });
    }
    if (!addon.subscription || !addon.subscription.stripe_customer_id || !addon.subscription.stripe_subscription_id) {
      return res.status(400).json({ error: 'no Stripe subscription linked' });
    }

    const customerId = addon.subscription.stripe_customer_id;
    const subId = addon.subscription.stripe_subscription_id;
    const label = (addon.addon_type || 'add-on').replace(/_/g, ' ');

    // Create Stripe invoice item attached to subscription's next invoice
    let item;
    try {
      item = await stripe.invoiceItems.create({
        customer: customerId,
        subscription: subId,
        amount: addon.amount_cents,
        currency: 'usd',
        description: 'Generator add-on: ' + label,
        metadata: {
          addon_id: id,
          addon_type: addon.addon_type,
          subscription_id: addon.subscription.id,
          performed_date: performedDate,
        },
      });
    } catch (stripeErr) {
      const reason = stripeErr.message || stripeErr.code || 'unknown_error';
      console.error('[generator-care] invoice item create failed:', stripeErr);
      return res.status(502).json({ error: 'Stripe invoice item create failed', reason });
    }

    const { data: updated, error: updErr } = await supabaseAdmin
      .from('generator_pending_addons')
      .update({
        status: 'performed',
        date_performed: performedDate,
        stripe_invoice_item_id: item.id,
      })
      .eq('id', id)
      .select()
      .single();
    if (updErr) throw updErr;

    res.json({ ok: true, addon: updated, invoice_item_id: item.id });
  } catch (err) {
    console.error('[generator-care] mark-performed error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/generator-care/addons/:id/unmark-performed
// Reverse: deletes the Stripe invoice item (if still removable) and resets addon to pending.
router.post('/addons/:id/unmark-performed', async (req, res) => {
  try {
    const { id } = req.params;
    const { data: addon, error: addonErr } = await supabaseAdmin
      .from('generator_pending_addons')
      .select('*')
      .eq('id', id)
      .single();
    if (addonErr) throw addonErr;
    if (!addon) return res.status(404).json({ error: 'addon not found' });
    if (addon.status !== 'performed') {
      return res.status(400).json({ error: 'addon is not in performed status' });
    }

    // Try to delete invoice item from Stripe (works only while invoice is still draft / pending)
    if (addon.stripe_invoice_item_id) {
      try {
        await stripe.invoiceItems.del(addon.stripe_invoice_item_id);
      } catch (stripeErr) {
        return res.status(400).json({
          error: 'cannot unmark: invoice item already billed or not removable',
          reason: stripeErr.message,
        });
      }
    }

    const { data: updated, error: updErr } = await supabaseAdmin
      .from('generator_pending_addons')
      .update({
        status: 'pending',
        date_performed: null,
        stripe_invoice_item_id: null,
      })
      .eq('id', id)
      .select()
      .single();
    if (updErr) throw updErr;

    res.json({ ok: true, addon: updated });
  } catch (err) {
    console.error('[generator-care] unmark-performed error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});


// ===== REFUND HELPERS (shared by /addons/:id/refund + /adhoc-charges/:id/refund) =====

// Refund against a payment_intent OR a charge. originalAmountCents is the full
// charge; alreadyRefundedCents (default 0) lets callers cap a partial top-up to
// the remaining balance. requestedAmountCents omitted = refund the remainder.
async function executeStripeRefund({ paymentIntentId, chargeId, originalAmountCents, alreadyRefundedCents = 0, requestedAmountCents, reason, metadata }) {
  const maxRefundable = originalAmountCents - (alreadyRefundedCents || 0);
  const refundAmount = requestedAmountCents || maxRefundable;
  if (!Number.isInteger(refundAmount) || refundAmount <= 0 || refundAmount > maxRefundable) {
    throw new Error(`refund amount must be between 1 cent and $${(maxRefundable/100).toFixed(2)}`);
  }
  const params = {
    amount: refundAmount,
    reason: 'requested_by_customer',
    metadata: { ...(reason ? { bates_reason: String(reason).slice(0, 500) } : {}), ...(metadata || {}) },
  };
  if (paymentIntentId) params.payment_intent = paymentIntentId;
  else if (chargeId) params.charge = chargeId;
  else throw new Error('no payment_intent or charge to refund against');
  const refund = await stripe.refunds.create(params);
  return { refund, refundAmount };
}

// Structured marker the frontend parses to render "Refunded" / "Partial refund" badges.
function buildRefundNote(refundAmountCents, originalAmountCents, reason, stripeRefundId) {
  const today = new Date().toISOString().slice(0, 10);
  const isPartial = refundAmountCents < originalAmountCents;
  const amtPart = isPartial
    ? `$${(refundAmountCents/100).toFixed(2)} of $${(originalAmountCents/100).toFixed(2)}`
    : `$${(refundAmountCents/100).toFixed(2)}`;
  let note = `REFUNDED ${amtPart} on ${today}`;
  if (reason) note += `: ${reason}`;
  note += ` (stripe_refund_id: ${stripeRefundId})`;
  return note;
}

// Sum of prior refunds recorded in a row's notes (mirrors the frontend parser).
// Lets the addon/adhoc refund endpoints cap a second partial refund server-side
// instead of relying solely on Stripe rejecting an over-refund.
function parseRefundedFromNotes(notes) {
  if (!notes) return 0;
  let total = 0;
  for (const m of String(notes).matchAll(/REFUNDED \$(\d+(?:\.\d+)?)/g)) {
    total += Math.round(parseFloat(m[1]) * 100);
  }
  return total;
}


// POST /api/generator-care/addons/:id/refund
// Body: { amount_cents?, reason? }
// amount_cents omitted = full refund. Stripe supports multiple partial refunds
// up to the original total; we don't enforce that here -- Stripe will reject.
router.post('/addons/:id/refund', async (req, res) => {
  try {
    const { id } = req.params;
    const { amount_cents, reason } = req.body || {};

    const { data: addon, error: addonErr } = await supabaseAdmin
      .from('generator_pending_addons')
      .select('*')
      .eq('id', id)
      .single();
    if (addonErr) throw addonErr;
    if (!addon) return res.status(404).json({ error: 'addon not found' });
    if (addon.status !== 'charged') {
      return res.status(400).json({ error: `cannot refund addon with status '${addon.status}' (must be 'charged')` });
    }
    if (!addon.stripe_payment_intent_id) {
      return res.status(400).json({ error: 'addon has no stripe_payment_intent_id; refund must be issued from Stripe Dashboard' });
    }

    const alreadyRefundedCents = parseRefundedFromNotes(addon.notes);
    let result;
    try {
      result = await executeStripeRefund({
        paymentIntentId: addon.stripe_payment_intent_id,
        originalAmountCents: addon.amount_cents,
        alreadyRefundedCents,
        requestedAmountCents: amount_cents,
        reason,
      });
    } catch (refundErr) {
      return res.status(400).json({ error: refundErr.message });
    }

    const refundNote = buildRefundNote(result.refundAmount, addon.amount_cents, reason, result.refund.id);
    const newNotes = (addon.notes ? addon.notes + '\n' : '') + refundNote;
    await supabaseAdmin.from('generator_pending_addons').update({ notes: newNotes }).eq('id', id);

    res.json({
      ok: true,
      refund_id: result.refund.id,
      amount_cents: result.refundAmount,
      total_refunded_cents: alreadyRefundedCents + result.refundAmount,
      original_amount_cents: addon.amount_cents,
      stripe_status: result.refund.status,
    });
  } catch (err) {
    console.error('[generator-care] addon refund error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});


// POST /api/generator-care/subscriptions/:id/cancel
// Cancel subscription at the end of the current billing period.
// Customer keeps service through paid-through date; Stripe stops auto-renewal.
// DB marks 'canceled' with optional reason in notes.
router.post('/subscriptions/:id/cancel', async (req, res) => {
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


// Hardcoded catalog of one-time add-ons by gen class.
// Mirrors the catalog in bates-generator/netlify/functions/create-checkout.js.
// Live-mode price IDs as of the 2026-06-08 Stripe cutover.
const ADDON_CATALOG = {
  battery_replacement: {
    label: 'Battery Replacement',
    prices: {
      air_cooled:    { price_id: 'price_1Tg78FBbX7QhpMgbGVRxRJNo', amount_cents: 16500 },
      liquid_22_38:  { price_id: 'price_1Tg78EBbX7QhpMgbFvIrYuD1', amount_cents: 23500 },
      liquid_48_150: { price_id: 'price_1Tg78EBbX7QhpMgbOhRdCUUe', amount_cents: 26500 },
    },
  },
  exterior_wash: {
    label: 'Exterior Wash & Interior Blow-Out',
    prices: { all: { price_id: 'price_1Tg78FBbX7QhpMgbzrM2AE2n', amount_cents: 8500 } },
  },
  coolant_flush: {
    label: 'Coolant System Flush',
    prices: {
      liquid_22_38:  { price_id: 'price_1Tg78DBbX7QhpMgbhESS9Wyp', amount_cents: 59500 },
      liquid_48_150: { price_id: 'price_1Tg78DBbX7QhpMgb7VtP2hGx', amount_cents: 69500 },
    },
  },
  coolant_topoff: {
    label: 'Coolant Top-Off Service',
    prices: {
      // Same Stripe price reused for both liquid tiers; service cost
      // doesn't vary by size. No air_cooled entry: air-cooled units
      // don't get coolant service.
      liquid_22_38:  { price_id: 'price_1Tg78CBbX7QhpMgbXptyAaje', amount_cents: 9500 },
      liquid_48_150: { price_id: 'price_1Tg78CBbX7QhpMgbXptyAaje', amount_cents: 9500 },
    },
  },
  ats_outage_combined: {
    label: 'Transfer Switch Inspection & Simulated Outage Test',
    prices: { all: { price_id: 'price_1Tg78DBbX7QhpMgby14G5PiY', amount_cents: 11000 } },
  },
};

function lookupAddonPrice(addonType, genClass) {
  const entry = ADDON_CATALOG[addonType];
  if (!entry) return null;
  if (entry.prices.all) return entry.prices.all;
  return entry.prices[genClass] || null;
}

// GET /api/generator-care/subscriptions/:id/available-addons
// Lists which add-ons can be added for this customer's gen class.
router.get('/subscriptions/:id/available-addons', async (req, res) => {
  try {
    const { id } = req.params;
    const { data: sub, error: subErr } = await supabaseAdmin
      .from('generator_subscriptions')
      .select('id, gen_class')
      .eq('id', id)
      .single();
    if (subErr) throw subErr;
    if (!sub) return res.status(404).json({ error: 'subscription not found' });

    const available = [];
    for (const [addonType, entry] of Object.entries(ADDON_CATALOG)) {
      const price = lookupAddonPrice(addonType, sub.gen_class);
      if (price) {
        available.push({ addon_type: addonType, label: entry.label, amount_cents: price.amount_cents });
      }
    }
    res.json({ ok: true, gen_class: sub.gen_class, addons: available });
  } catch (err) {
    console.error('[generator-care] available-addons error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/generator-care/subscriptions/:id/add-addon
// Add a new pending add-on to an existing subscription mid-cycle.
// Body: { addon_type }
router.post('/subscriptions/:id/add-addon', async (req, res) => {
  try {
    const { id } = req.params;
    const { addon_type } = req.body || {};
    if (!addon_type) return res.status(400).json({ error: 'addon_type required' });

    const { data: sub, error: subErr } = await supabaseAdmin
      .from('generator_subscriptions')
      .select('id, gen_class, status')
      .eq('id', id)
      .single();
    if (subErr) throw subErr;
    if (!sub) return res.status(404).json({ error: 'subscription not found' });
    if (sub.status === 'canceled') {
      return res.status(400).json({ error: 'subscription is canceled; cannot add new add-ons' });
    }

    const price = lookupAddonPrice(addon_type, sub.gen_class);
    if (!price) {
      return res.status(400).json({ error: 'add-on not available for this gen class', addon_type, gen_class: sub.gen_class });
    }

    const { data: inserted, error: insErr } = await supabaseAdmin
      .from('generator_pending_addons')
      .insert({
        subscription_id: id,
        addon_type,
        stripe_price_id: price.price_id,
        amount_cents: price.amount_cents,
        status: 'pending',
      })
      .select()
      .single();
    if (insErr) throw insErr;

    res.json({ ok: true, addon: inserted });
  } catch (err) {
    console.error('[generator-care] add-addon error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});


// POST /api/generator-care/addons/:id/remove
// Soft-delete a pending add-on (sets status='canceled'). Only allowed for status='pending'.
// Performed addons should use /unmark-performed first to revert to pending.
// Charged addons can't be removed (need a refund flow).
router.post('/addons/:id/remove', async (req, res) => {
  try {
    const { id } = req.params;
    const { data: addon, error: addonErr } = await supabaseAdmin
      .from('generator_pending_addons')
      .select('id, status')
      .eq('id', id)
      .single();
    if (addonErr) throw addonErr;
    if (!addon) return res.status(404).json({ error: 'addon not found' });
    if (addon.status !== 'pending') {
      return res.status(400).json({
        error: 'can only remove pending add-ons',
        current_status: addon.status,
        hint: addon.status === 'performed' ? 'use /unmark-performed first' : 'addon is past the pending stage',
      });
    }

    const today = new Date().toISOString().slice(0, 10);
    const { data: updated, error: updErr } = await supabaseAdmin
      .from('generator_pending_addons')
      .update({
        status: 'canceled',
        notes: 'Removed by office on ' + today,
      })
      .eq('id', id)
      .select()
      .single();
    if (updErr) throw updErr;

    res.json({ ok: true, addon: updated });
  } catch (err) {
    console.error('[generator-care] remove addon error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});


// POST /api/generator-care/subscriptions/:id/adhoc-charge
// Add an ad-hoc charge to a subscription for non-program work.
// Body: { description, amount_cents, billing_method: 'immediate' | 'renewal', service_visit_id?, date_performed? }
// 'immediate': charges the saved card now via PaymentIntent (off-session).
// 'renewal':   adds a Stripe invoice item that bills at next subscription renewal.
router.post('/subscriptions/:id/adhoc-charge', async (req, res) => {
  try {
    const { id } = req.params;
    const { description, amount_cents, billing_method, service_visit_id, date_performed } = req.body || {};

    // Validate
    if (!description || !description.trim()) {
      return res.status(400).json({ error: 'description required' });
    }
    if (!amount_cents || !Number.isInteger(amount_cents) || amount_cents <= 0) {
      return res.status(400).json({ error: 'amount_cents must be a positive integer' });
    }
    if (!['immediate', 'renewal'].includes(billing_method)) {
      return res.status(400).json({ error: "billing_method must be 'immediate' or 'renewal'" });
    }

    const { data: sub, error: subErr } = await supabaseAdmin
      .from('generator_subscriptions')
      .select('id, stripe_subscription_id, stripe_customer_id, status, customer:generator_customers(name, email)')
      .eq('id', id)
      .single();
    if (subErr) throw subErr;
    if (!sub) return res.status(404).json({ error: 'subscription not found' });
    if (sub.status === 'canceled' && billing_method === 'renewal') {
      return res.status(400).json({ error: 'subscription is canceled; no future renewal to bill against. Use billing_method=immediate.' });
    }
    if (!sub.stripe_customer_id) {
      return res.status(400).json({ error: 'no Stripe customer linked' });
    }

    const today = new Date().toISOString().slice(0, 10);
    const performedDate = date_performed || today;
    const customerName = (sub.customer && sub.customer.name) || 'customer';
    const customerEmail = (sub.customer && sub.customer.email) || null;
    const stripeDescription = 'Bates Electric: ' + description.trim();

    // 1. Insert the row first as 'pending'
    const { data: row, error: insErr } = await supabaseAdmin
      .from('generator_adhoc_charges')
      .insert({
        subscription_id: id,
        service_visit_id: service_visit_id || null,
        description: description.trim(),
        amount_cents,
        billing_method,
        status: 'pending',
        date_performed: performedDate,
      })
      .select()
      .single();
    if (insErr) throw insErr;

    // 2. Hit Stripe based on billing_method
    if (billing_method === 'immediate') {
      // Resolve which saved card to charge first — a bare
      // paymentIntents.create({ customer }) can't find the card Checkout attached
      // to the subscription, which is what was failing in the field.
      const paymentMethodId = await resolveSavedPaymentMethod(sub.stripe_subscription_id, sub.stripe_customer_id);
      if (!paymentMethodId) {
        // No card on file at all: record the failure and auto-email the
        // card-update link so the customer can add one.
        await supabaseAdmin
          .from('generator_adhoc_charges')
          .update({ status: 'failed', notes: 'Charge failed on ' + today + ': no saved card on file' })
          .eq('id', row.id);
        const linkResult = await emailCardUpdateLinkForSub(id);
        return res.status(402).json({
          error: 'charge failed',
          reason: 'no saved card on file',
          adhoc_charge_id: row.id,
          card_update_email_sent: !!linkResult.sent,
        });
      }

      let intent;
      try {
        intent = await stripe.paymentIntents.create({
          customer: sub.stripe_customer_id,
          amount: amount_cents,
          currency: 'usd',
          payment_method: paymentMethodId,
          payment_method_types: ['card'],
          off_session: true,
          confirm: true,
          description: stripeDescription,
          // Stripe's automatic receipts for raw PaymentIntents key off receipt_email;
          // without it ad-hoc charges won't generate a receipt even with the
          // "Successful payments" email setting enabled.
          ...(customerEmail ? { receipt_email: customerEmail } : {}),
          metadata: {
            adhoc_charge_id: row.id,
            subscription_id: id,
            customer_name: customerName,
          },
        });
      } catch (stripeErr) {
        // Off-session charges can fail with authentication_required (3DS) or card
        // errors (declined, expired, etc.). Record FAILED with the message and do
        // not throw; Amy can re-send a card-update link from the dashboard.
        const reason = stripeErr.message || stripeErr.code || 'unknown_error';
        await supabaseAdmin
          .from('generator_adhoc_charges')
          .update({ status: 'failed', notes: 'Charge failed on ' + today + ': ' + reason })
          .eq('id', row.id);
        return res.status(402).json({ error: 'charge failed', reason, adhoc_charge_id: row.id });
      }
      const { data: updated, error: updErr } = await supabaseAdmin
        .from('generator_adhoc_charges')
        .update({
          status: 'charged',
          date_charged: today,
          stripe_payment_intent_id: intent.id,
        })
        .eq('id', row.id)
        .select()
        .single();
      if (updErr) throw updErr;
      return res.json({ ok: true, adhoc_charge: updated, payment_intent_id: intent.id });
    }

    // billing_method === 'renewal' - create invoice item
    if (!sub.stripe_subscription_id) {
      await supabaseAdmin
        .from('generator_adhoc_charges')
        .update({ status: 'failed', notes: 'No Stripe subscription linked' })
        .eq('id', row.id);
      return res.status(400).json({ error: 'no Stripe subscription linked; cannot bill at renewal' });
    }
    let item;
    try {
      item = await stripe.invoiceItems.create({
        customer: sub.stripe_customer_id,
        subscription: sub.stripe_subscription_id,
        amount: amount_cents,
        currency: 'usd',
        description: stripeDescription,
        metadata: {
          adhoc_charge_id: row.id,
          subscription_id: id,
          customer_name: customerName,
        },
      });
    } catch (stripeErr) {
      const reason = stripeErr.message || stripeErr.code || 'unknown_error';
      await supabaseAdmin
        .from('generator_adhoc_charges')
        .update({ status: 'failed', notes: 'Invoice item create failed: ' + reason })
        .eq('id', row.id);
      return res.status(502).json({ error: 'Stripe invoice item create failed', reason });
    }
    const { data: updated, error: updErr2 } = await supabaseAdmin
      .from('generator_adhoc_charges')
      .update({
        stripe_invoice_item_id: item.id,
      })
      .eq('id', row.id)
      .select()
      .single();
    if (updErr2) throw updErr2;

    return res.json({ ok: true, adhoc_charge: updated, invoice_item_id: item.id });
  } catch (err) {
    console.error('[generator-care] adhoc-charge error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/generator-care/adhoc-charges/:id/cancel
// Soft-cancel an ad-hoc charge.
// If it's already charged: refuses (need refund flow).
// If it's a pending renewal charge: also deletes the Stripe invoice item.
router.post('/adhoc-charges/:id/cancel', async (req, res) => {
  try {
    const { id } = req.params;
    const { data: charge, error: chErr } = await supabaseAdmin
      .from('generator_adhoc_charges')
      .select('*')
      .eq('id', id)
      .single();
    if (chErr) throw chErr;
    if (!charge) return res.status(404).json({ error: 'charge not found' });
    if (charge.status === 'charged') {
      return res.status(400).json({ error: 'already charged - cannot remove. Refund must be handled separately.' });
    }
    if (charge.status === 'canceled') {
      return res.json({ ok: true, adhoc_charge: charge, info: 'already canceled' });
    }

    // If it had an invoice item, try to delete it from Stripe
    if (charge.stripe_invoice_item_id) {
      try {
        await stripe.invoiceItems.del(charge.stripe_invoice_item_id);
      } catch (stripeErr) {
        return res.status(400).json({
          error: 'cannot cancel: invoice item already billed or not removable',
          reason: stripeErr.message,
        });
      }
    }

    const today = new Date().toISOString().slice(0, 10);
    const { data: updated, error: updErr } = await supabaseAdmin
      .from('generator_adhoc_charges')
      .update({
        status: 'canceled',
        notes: (charge.notes ? charge.notes + '\n' : '') + 'Canceled on ' + today,
      })
      .eq('id', id)
      .select()
      .single();
    if (updErr) throw updErr;

    res.json({ ok: true, adhoc_charge: updated });
  } catch (err) {
    console.error('[generator-care] adhoc-charges cancel error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});


// POST /api/generator-care/adhoc-charges/:id/refund
// Body: { amount_cents?, reason? }
// amount_cents omitted = full refund.
router.post('/adhoc-charges/:id/refund', async (req, res) => {
  try {
    const { id } = req.params;
    const { amount_cents, reason } = req.body || {};

    const { data: charge, error: chErr } = await supabaseAdmin
      .from('generator_adhoc_charges')
      .select('*')
      .eq('id', id)
      .single();
    if (chErr) throw chErr;
    if (!charge) return res.status(404).json({ error: 'charge not found' });
    if (charge.status !== 'charged') {
      return res.status(400).json({ error: `cannot refund charge with status '${charge.status}' (must be 'charged')` });
    }
    if (!charge.stripe_payment_intent_id) {
      return res.status(400).json({ error: 'charge has no stripe_payment_intent_id; refund must be issued from Stripe Dashboard' });
    }

    const alreadyRefundedCents = parseRefundedFromNotes(charge.notes);
    let result;
    try {
      result = await executeStripeRefund({
        paymentIntentId: charge.stripe_payment_intent_id,
        originalAmountCents: charge.amount_cents,
        alreadyRefundedCents,
        requestedAmountCents: amount_cents,
        reason,
      });
    } catch (refundErr) {
      return res.status(400).json({ error: refundErr.message });
    }

    const refundNote = buildRefundNote(result.refundAmount, charge.amount_cents, reason, result.refund.id);
    const newNotes = (charge.notes ? charge.notes + '\n' : '') + refundNote;
    await supabaseAdmin.from('generator_adhoc_charges').update({ notes: newNotes }).eq('id', id);

    res.json({
      ok: true,
      refund_id: result.refund.id,
      amount_cents: result.refundAmount,
      total_refunded_cents: alreadyRefundedCents + result.refundAmount,
      original_amount_cents: charge.amount_cents,
      stripe_status: result.refund.status,
    });
  } catch (err) {
    console.error('[generator-care] adhoc-charges refund error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});


// POST /api/generator-care/invoices/:invoiceId/refund
// Body: { amount_cents?, reason? }
// Refunds a paid subscription/plan invoice's charge to the customer's card.
// amount_cents omitted = full refund of the remaining (un-refunded) balance.
// NOTE: refunding an invoice does NOT cancel the subscription — they're
// independent actions (the customer keeps their plan unless separately canceled).
router.post('/invoices/:invoiceId/refund', async (req, res) => {
  try {
    const { invoiceId } = req.params;
    const { amount_cents, reason } = req.body || {};

    let invoice;
    try {
      invoice = await stripe.invoices.retrieve(invoiceId, { expand: ['charge'] });
    } catch (e) {
      return res.status(404).json({ error: 'invoice not found in Stripe: ' + (e && e.message ? e.message : 'unknown') });
    }
    if (invoice.status !== 'paid') {
      return res.status(400).json({ error: `cannot refund invoice with status '${invoice.status}' (must be 'paid')` });
    }
    const charge = invoice.charge && typeof invoice.charge === 'object' ? invoice.charge : null;
    if (!charge || !charge.id) {
      return res.status(400).json({ error: 'invoice has no captured charge to refund' });
    }

    // Ownership guard (prevent IDOR): only refund invoices that belong to a
    // Generator Care customer. Without this, a valid office token could refund
    // ANY invoice id in the connected Stripe account.
    const invoiceCustomerId = typeof invoice.customer === 'string'
      ? invoice.customer
      : (invoice.customer && invoice.customer.id) || null;
    const { data: ownerSub, error: ownerErr } = await supabaseAdmin
      .from('generator_subscriptions')
      .select('id')
      .eq('stripe_customer_id', invoiceCustomerId)
      .limit(1)
      .maybeSingle();
    if (ownerErr) throw ownerErr;
    if (!invoiceCustomerId || !ownerSub) {
      return res.status(403).json({ error: 'invoice does not belong to a Generator Care customer' });
    }

    const originalAmountCents = charge.amount;
    const alreadyRefundedCents = charge.amount_refunded || 0;
    if (alreadyRefundedCents >= originalAmountCents) {
      return res.status(400).json({ error: 'invoice is already fully refunded' });
    }

    let result;
    try {
      result = await executeStripeRefund({
        chargeId: charge.id,
        originalAmountCents,
        alreadyRefundedCents,
        requestedAmountCents: amount_cents,
        reason,
        metadata: { generator_invoice_id: invoiceId },
      });
    } catch (refundErr) {
      return res.status(400).json({ error: refundErr.message });
    }

    // No DB row to annotate (invoices live in Stripe). Accounting visibility
    // comes from the Stripe refund itself, surfaced by /accounting/transactions.
    res.json({
      ok: true,
      refund_id: result.refund.id,
      amount_cents: result.refundAmount,
      total_refunded_cents: alreadyRefundedCents + result.refundAmount,
      original_amount_cents: originalAmountCents,
      stripe_status: result.refund.status,
      invoice_id: invoiceId,
    });
  } catch (err) {
    console.error('[generator-care] invoice refund error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});


// === ACCOUNTING ENDPOINTS ===

// GET /accounting/transactions?from=YYYY-MM-DD&to=YYYY-MM-DD
// Pulls succeeded charges from Stripe in the date range, joins with our DB
// for customer name + install address, and returns per-charge gross / Stripe fee / net.
router.get('/accounting/transactions', async (req, res) => {
  try {
    const today = new Date();
    const defaultFrom = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
    const fromDate = req.query.from ? new Date(req.query.from + 'T00:00:00Z') : defaultFrom;
    const toDate = req.query.to ? new Date(req.query.to + 'T23:59:59Z') : today;
    const fromTs = Math.floor(fromDate.getTime() / 1000);
    const toTs = Math.floor(toDate.getTime() / 1000);

    // Page through all charges in the range
    let allCharges = [];
    let starting_after = undefined;
    let safety = 0;
    do {
      const page = await stripe.charges.list({
        created: { gte: fromTs, lte: toTs },
        limit: 100,
        starting_after,
        expand: ['data.balance_transaction', 'data.invoice']
      });
      allCharges = allCharges.concat(page.data);
      starting_after = page.has_more ? page.data[page.data.length - 1].id : undefined;
      safety++;
      if (safety > 20) break;
    } while (starting_after);

    // Page through refunds in the same range too. Refunds don't change the
    // original charge's amount, so without surfacing them here, money returned to
    // customers (plan/invoice refunds AND ad-hoc refunds) would be invisible in
    // the books — the tab would overstate net revenue.
    let allRefunds = [];
    {
      let after = undefined;
      let guard = 0;
      do {
        const page = await stripe.refunds.list({
          created: { gte: fromTs, lte: toTs },
          limit: 100,
          starting_after: after,
          expand: ['data.balance_transaction', 'data.charge'],
        });
        allRefunds = allRefunds.concat(page.data);
        after = page.has_more ? page.data[page.data.length - 1].id : undefined;
        guard++;
        if (guard > 20) break;
      } while (after);
    }
    // Defensive: keep only refunds actually created in range, in case the list
    // endpoint ignores the created filter.
    allRefunds = allRefunds.filter(r => r.created >= fromTs && r.created <= toTs);

    // Page through standalone Stripe account fees (e.g. Billing "Usage Fee", the
    // 0.7% of subscription invoice volume) in the range. Stripe deducts these
    // straight from our balance — they never appear as charges or refunds — so
    // without them the Net here is short of what actually moves toward payouts,
    // and Brenda's bank deposits won't reconcile. type:'stripe_fee' is exactly
    // these account-level fees; it excludes the per-charge processing fees (which
    // live inside each charge's balance transaction and are already shown in the
    // fee column), so there is no double counting.
    let allFees = [];
    {
      let after = undefined;
      let guard = 0;
      do {
        const page = await stripe.balanceTransactions.list({
          type: 'stripe_fee',
          created: { gte: fromTs, lte: toTs },
          limit: 100,
          starting_after: after,
        });
        allFees = allFees.concat(page.data);
        after = page.has_more ? page.data[page.data.length - 1].id : undefined;
        guard++;
        if (guard > 20) break;
      } while (after);
    }
    // Same client-side date-range defense as refunds.
    allFees = allFees.filter(t => t.created >= fromTs && t.created <= toTs);

    // Look up customer info for all stripe customers in the result set (charges + refunds)
    const refundCustomerIds = allRefunds.map(r => (r.charge && typeof r.charge === 'object') ? r.charge.customer : null);
    const customerIds = [...new Set([...allCharges.map(c => c.customer), ...refundCustomerIds].filter(Boolean))];
    let customerMap = {};
    if (customerIds.length > 0) {
      const { data: subs, error: subErr } = await supabaseAdmin
        .from('generator_subscriptions')
        .select('stripe_customer_id, customer:generator_customers(name, install_address, install_city, install_state, install_zip)')
        .in('stripe_customer_id', customerIds);
      if (subErr) throw subErr;
      (subs || []).forEach(s => {
        if (s.customer) customerMap[s.stripe_customer_id] = s.customer;
      });
    }

    // Issuer card authorization (approval) code — what Brenda reconciles against.
    const authCodeOf = (ch) =>
      (ch && ch.payment_method_details && ch.payment_method_details.card
        && ch.payment_method_details.card.authorization_code) || null;

    // Build chargeId -> auth code. The charge objects from charges.list /
    // refund.charge don't reliably surface payment_method_details.card
    // .authorization_code, so for any charge whose listed object didn't carry it
    // we retrieve the charge (which returns it definitively). Deduped across
    // charges + the originating charges of refunds, and bounded so a huge range
    // can't fan out into unbounded API calls.
    const authByChargeId = {};
    const needRetrieve = new Set();
    const noteCharge = (chargeObj, chargeId) => {
      if (!chargeId) return;
      const fromObj = authCodeOf(chargeObj);
      if (fromObj) authByChargeId[chargeId] = fromObj;
      else if (!(chargeId in authByChargeId)) needRetrieve.add(chargeId);
    };
    allCharges.forEach(c => { if (c.status === 'succeeded') noteCharge(c, c.id); });
    allRefunds.forEach(r => {
      const ch = r.charge && typeof r.charge === 'object' ? r.charge : null;
      noteCharge(ch, ch ? ch.id : (typeof r.charge === 'string' ? r.charge : null));
    });

    const RETRIEVE_CAP = 300;
    const toRetrieve = [...needRetrieve].slice(0, RETRIEVE_CAP);
    if (needRetrieve.size > RETRIEVE_CAP) {
      console.warn(`[accounting] auth-code retrieve capped at ${RETRIEVE_CAP}; ${needRetrieve.size - RETRIEVE_CAP} charges will have no code`);
    }
    await Promise.all(toRetrieve.map(async (id) => {
      try {
        const full = await stripe.charges.retrieve(id);
        const code = authCodeOf(full);
        if (code) authByChargeId[id] = code;
      } catch (e) {
        console.error('[accounting] charge retrieve for auth code failed:', id, e && e.message);
      }
    }));

    const chargeTxns = allCharges
      .filter(c => c.status === 'succeeded')
      .map(c => {
        const bt = c.balance_transaction;
        const cust = customerMap[c.customer] || {};
        const address = [cust.install_address, cust.install_city, cust.install_state, cust.install_zip].filter(Boolean).join(', ');
        let description = '';
        if (c.invoice && typeof c.invoice === 'object') {
          if (c.invoice.description) description = c.invoice.description;
          else if (c.invoice.subscription) description = 'Subscription renewal';
          else description = 'Invoice payment';
        } else if (c.description) {
          description = c.description;
        } else if (c.metadata && c.metadata.adhoc_charge_id) {
          description = 'Ad-hoc charge';
        } else {
          description = 'Card charge';
        }
        return {
          date: new Date(c.created * 1000).toISOString().slice(0, 10),
          customer_name: cust.name || '(unmatched)',
          address,
          description,
          gross_cents: c.amount,
          fee_cents: bt ? bt.fee : 0,
          net_cents: bt ? bt.net : c.amount,
          auth_code: authByChargeId[c.id] || null,
          stripe_charge_id: c.id,        // kept in the API response for debugging; not shown in the table/CSV
          stripe_customer_id: c.customer,
          is_refund: false
        };
      });

    // Refunds as negative entries. Stripe doesn't return the original processing
    // fee on a standard refund (balance_transaction.fee is 0), so net is the
    // negative refund amount — correctly leaving the business out the original fee.
    const refundTxns = allRefunds.map(r => {
      const bt = r.balance_transaction && typeof r.balance_transaction === 'object' ? r.balance_transaction : null;
      const ch = r.charge && typeof r.charge === 'object' ? r.charge : null;
      const custId = ch ? ch.customer : null;
      const cust = customerMap[custId] || {};
      const address = [cust.install_address, cust.install_city, cust.install_state, cust.install_zip].filter(Boolean).join(', ');
      const isInvoice = !!(ch && ch.invoice);
      const isAdhoc = !!(ch && ch.metadata && ch.metadata.adhoc_charge_id);
      const origChargeId = ch ? ch.id : (typeof r.charge === 'string' ? r.charge : null);
      return {
        date: new Date(r.created * 1000).toISOString().slice(0, 10),
        customer_name: cust.name || '(unmatched)',
        address,
        description: 'Refund' + (isInvoice ? ' (plan/invoice)' : isAdhoc ? ' (ad-hoc charge)' : ''),
        gross_cents: -r.amount,
        fee_cents: bt ? bt.fee : 0,
        net_cents: bt ? bt.net : -r.amount,
        auth_code: origChargeId ? (authByChargeId[origChargeId] || null) : null,  // original charge's approval code (ties the refund back)
        stripe_charge_id: origChargeId,
        stripe_customer_id: custId,
        is_refund: true
      };
    });

    // Standalone Stripe account fees as negative entries. A balance transaction's
    // amount/net are already signed (negative for a fee), and fee==0 because the
    // transaction IS the fee — so we use them directly without negating.
    const feeTxns = allFees.map(t => ({
      date: new Date(t.created * 1000).toISOString().slice(0, 10),
      customer_name: 'Stripe',
      address: '',
      description: t.description || 'Stripe fee',
      gross_cents: t.amount,
      fee_cents: 0,
      net_cents: typeof t.net === 'number' ? t.net : t.amount,
      auth_code: null,                   // account-level fee, no card authorization
      stripe_charge_id: t.id,
      stripe_customer_id: null,
      is_fee: true
    }));

    const transactions = [...chargeTxns, ...refundTxns, ...feeTxns].sort((a, b) => a.date.localeCompare(b.date));

    res.json({
      from: fromDate.toISOString().slice(0, 10),
      to: toDate.toISOString().slice(0, 10),
      transactions,
      totals: {
        count: transactions.length,
        gross_cents: transactions.reduce((s, t) => s + t.gross_cents, 0),
        fee_cents: transactions.reduce((s, t) => s + t.fee_cents, 0),
        net_cents: transactions.reduce((s, t) => s + t.net_cents, 0)
      }
    });
  } catch (err) {
    console.error('[accounting] transactions error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /accounting/payouts?from=YYYY-MM-DD&to=YYYY-MM-DD
// Reconcile by Stripe PAYOUT instead of by calendar date. Stripe moves money
// to/from the bank in settlement batches (payouts) on its own schedule, so a
// calendar-date "Net to Bank" total rarely matches any single bank line. This
// view groups balance transactions by the payout that settled them, so each
// group sums to the exact amount that hit the bank — and surfaces the unsettled
// balance (not yet assigned to a payout) separately as `pending`.
//
// The date range filters by payout ARRIVAL DATE (when money moves at the bank),
// not by transaction date. Mirrors Stripe's own balance/payout reconciliation.
//
// Correctness note: every row's amounts are read straight from its balance
// transaction (amount/fee/net, already signed by Stripe), so a group's net ties
// to its payout by construction. Customer/description/auth-code enrichment is
// layered on top and can never move the totals.
router.get('/accounting/payouts', async (req, res) => {
  // Each Stripe section is isolated so one failing call (or one bad payout)
  // degrades to empty instead of 500ing the whole view. Real errors are always
  // logged server-side; ?debug=1 also returns them to the (office) caller.
  const debug = req.query.debug === '1';
  const errors = [];
  const note = (where, e) => {
    console.error('[payouts]', where, '—', (e && e.stack) ? e.stack : e);
    errors.push({ where, message: e && e.message, type: e && e.type, code: e && e.code, param: e && e.param });
  };
  try {
    const today = new Date();
    const defaultFrom = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
    const fromDate = req.query.from ? new Date(req.query.from + 'T00:00:00Z') : defaultFrom;
    const toDate = req.query.to ? new Date(req.query.to + 'T23:59:59Z') : today;
    const fromTs = Math.floor(fromDate.getTime() / 1000);
    const toTs = Math.floor(toDate.getTime() / 1000);

    // 1) Payouts whose arrival_date falls in the range (paged). Stripe wants
    //    epoch seconds for the gt/lt filters, which fromTs/toTs already are.
    let payouts = [];
    try {
      let after; let guard = 0;
      do {
        const page = await stripe.payouts.list({
          arrival_date: { gte: fromTs, lte: toTs },
          limit: 100,
          starting_after: after,
        });
        payouts = payouts.concat(page.data);
        after = page.has_more ? page.data[page.data.length - 1].id : undefined;
        guard++;
        if (guard > 20) break;
      } while (after);
    } catch (e) { note('payouts.list', e); }

    const payoutById = {};
    payouts.forEach((p) => { payoutById[p.id] = p; });
    const inRange = new Set(payouts.map((p) => p.id));

    // 2) Group by the balance transaction's `payout` FIELD, not the per-payout
    //    reconciliation report (balanceTransactions.list({payout})) — that report
    //    is unsupported for auto-debit payouts and throws. Listing balance
    //    transactions over the window and reading bt.payout works for normal
    //    deposits AND auto-debits. The lower bound is widened so a payout
    //    arriving early in the range still captures its slightly-earlier
    //    constituents. The settlement entry (type 'payout') is the balancing
    //    line, not a constituent.
    const payoutBts = {};
    payouts.forEach((p) => { payoutBts[p.id] = []; });
    let pendingBts = [];
    const btById = {};
    try {
      const btFromTs = fromTs - 14 * 24 * 60 * 60;
      let after; let guard = 0;
      do {
        const page = await stripe.balanceTransactions.list({
          created: { gte: btFromTs, lte: toTs },
          limit: 100,
          starting_after: after,
        });
        page.data.forEach((bt) => {
          btById[bt.id] = bt;
          if (bt.type === 'payout') return;                         // settlement line
          if (bt.payout && inRange.has(bt.payout)) payoutBts[bt.payout].push(bt);
          else if (!bt.payout) pendingBts.push(bt);                 // not yet settled
          // else: settled by a payout outside this range — neither here nor pending
        });
        after = page.has_more ? page.data[page.data.length - 1].id : undefined;
        guard++;
        if (guard > 30) break;
      } while (after);
    } catch (e) { note('balanceTransactions.list window', e); }

    // 3) Authoritative signed bank movement per payout, from the payout's own
    //    settlement balance transaction. A bt's `amount` is the change to the
    //    Stripe balance; the bank sees the opposite, so bank = -pbt.amount:
    //    a normal payout lowers the Stripe balance (pbt.amount < 0) => money to
    //    bank (+); an auto-debit raises it (pbt.amount > 0) => money from bank (−).
    //    Retrieving a single bt is supported even for auto-debits (only the list
    //    report isn't). Reuse btById where the settlement bt is already in window.
    const payoutBankCents = {};
    {
      const needPbt = payouts.filter((p) => p.balance_transaction && !btById[p.balance_transaction]);
      await Promise.all(needPbt.slice(0, 100).map(async (p) => {
        try { btById[p.balance_transaction] = await stripe.balanceTransactions.retrieve(p.balance_transaction); }
        catch (e) { note('balanceTransactions.retrieve ' + p.balance_transaction, e); }
      }));
      payouts.forEach((p) => {
        const pbt = p.balance_transaction ? btById[p.balance_transaction] : null;
        if (pbt && typeof pbt.amount === 'number') payoutBankCents[p.id] = -pbt.amount;
      });
    }

    // 4) Enrichment via bounded retrieves (no expand). Each balance transaction's
    //    `source` is just an id string here: charge/payment -> the charge id;
    //    refund -> the refund id (retrieved to find its originating charge). Then
    //    each charge is retrieved once for its auth code, customer, and a
    //    description. Amounts never depend on any of this, so failures here only
    //    leave a row less-labeled, never wrong.
    const allBts = [...Object.values(payoutBts).reduce((a, b) => a.concat(b), []), ...pendingBts];
    const srcIdOf = (bt) => (typeof bt.source === 'string' ? bt.source : (bt.source && bt.source.id)) || null;
    const refundIds = new Set();
    const chargeIds = new Set();
    allBts.forEach((bt) => {
      const sid = srcIdOf(bt);
      if (!sid) return;
      if (bt.type === 'charge' || bt.type === 'payment') chargeIds.add(sid);
      else if (bt.type === 'refund' || bt.type === 'payment_refund') refundIds.add(sid);
    });

    const RETRIEVE_CAP = 300;
    // refund id -> originating charge id
    const refundToCharge = {};
    await Promise.all([...refundIds].slice(0, RETRIEVE_CAP).map(async (rid) => {
      try {
        const rf = await stripe.refunds.retrieve(rid);
        const cid = typeof rf.charge === 'string' ? rf.charge : (rf.charge && rf.charge.id);
        if (cid) { refundToCharge[rid] = cid; chargeIds.add(cid); }
      } catch (e) { note('refunds.retrieve ' + rid, e); }
    }));

    // charge id -> auth code / customer id / description
    const authByChargeId = {};
    const chargeCustomerId = {};
    const chargeDescById = {};
    await Promise.all([...chargeIds].slice(0, RETRIEVE_CAP).map(async (cid) => {
      try {
        const ch = await stripe.charges.retrieve(cid);
        const code = authCodeOf(ch);
        if (code) authByChargeId[cid] = code;
        const custId = typeof ch.customer === 'string' ? ch.customer : (ch.customer && ch.customer.id);
        if (custId) chargeCustomerId[cid] = custId;
        chargeDescById[cid] = chargeDescription(ch);
      } catch (e) { note('charges.retrieve ' + cid, e); }
    }));

    // Customer directory (one query for all stripe customers seen).
    const customerIds = [...new Set(Object.values(chargeCustomerId).filter(Boolean))];
    let customerMap = {};
    if (customerIds.length) {
      try {
        const { data: subs, error: subErr } = await supabaseAdmin
          .from('generator_subscriptions')
          .select('stripe_customer_id, customer:generator_customers(name, install_address, install_city, install_state, install_zip)')
          .in('stripe_customer_id', customerIds);
        if (subErr) throw subErr;
        (subs || []).forEach((s) => { if (s.customer) customerMap[s.stripe_customer_id] = s.customer; });
      } catch (e) { note('supabase customer lookup', e); }
    }

    // A display row built straight from a balance transaction. amount/fee/net
    // are Stripe's signed figures — used verbatim so groups always tie.
    function rowFromBt(bt) {
      const sid = srcIdOf(bt);
      let chargeId = null; let custId = null; let description = ''; let fallbackName = '';
      if (bt.type === 'charge' || bt.type === 'payment') {
        chargeId = sid;
        custId = chargeId ? chargeCustomerId[chargeId] : null;
        description = (chargeId && chargeDescById[chargeId]) || 'Card charge';
      } else if (bt.type === 'refund' || bt.type === 'payment_refund') {
        chargeId = sid ? refundToCharge[sid] : null;
        custId = chargeId ? chargeCustomerId[chargeId] : null;
        description = 'Refund';
      } else if (bt.type === 'stripe_fee') {
        fallbackName = 'Stripe';
        description = bt.description || 'Stripe fee';
      } else {
        description = bt.description || (bt.type || 'Transaction');
      }
      const cust = custId ? (customerMap[custId] || {}) : {};
      const address = [cust.install_address, cust.install_city, cust.install_state, cust.install_zip].filter(Boolean).join(', ');
      return {
        date: bt.created ? new Date(bt.created * 1000).toISOString().slice(0, 10) : '',
        customer_name: cust.name || fallbackName || '(unmatched)',
        address,
        description,
        gross_cents: typeof bt.amount === 'number' ? bt.amount : 0,
        fee_cents: bt.fee || 0,
        net_cents: typeof bt.net === 'number' ? bt.net : (typeof bt.amount === 'number' ? bt.amount : 0),
        auth_code: chargeId ? (authByChargeId[chargeId] || null) : null,
        type: bt.type,
      };
    }

    // 5) Assemble payout groups. Normal deposits itemize via bt.payout. Auto-debits
    //    are special: Stripe does NOT set bt.payout on the balance transactions an
    //    auto-debit recovers, so they come back with 0 constituents. For an
    //    unconstituted DEBIT, attribute the not-yet-paid-out transactions whose
    //    available_on is on/before the payout's arrival — but ONLY if they sum
    //    EXACTLY to the payout's bank amount. If they don't, keep the honest note
    //    and leave them in Pending (never force a wrong/partial attribution).
    const nowTs = Math.floor(today.getTime() / 1000);
    let pendingPool = pendingBts.slice();
    const procOrder = payouts.slice().sort((a, b) => (a.arrival_date || 0) - (b.arrival_date || 0)); // oldest claims first
    const groupById = {};
    for (const p of procOrder) {
      let rows = (payoutBts[p.id] || []).map(rowFromBt).sort((a, b) => a.date.localeCompare(b.date));
      // Signed bank amount from the payout's own settlement bt (authoritative for
      // deposits AND auto-debits); fall back to |amount| signed by net.
      let bankAmount = payoutBankCents[p.id];
      if (typeof bankAmount !== 'number') {
        const n0 = rows.reduce((s, r) => s + r.net_cents, 0);
        const mag = Math.abs(typeof p.amount === 'number' ? p.amount : 0);
        bankAmount = (n0 < 0 ? -1 : 1) * mag;
      }
      const direction = bankAmount < 0 ? 'debit' : 'deposit';
      let unconstituted = rows.length === 0;
      let groupNote = null;

      if (unconstituted && direction === 'debit') {
        const arrivalTs = typeof p.arrival_date === 'number' ? p.arrival_date : nowTs;
        const candidates = pendingPool
          .filter((bt) => typeof bt.available_on === 'number' && bt.available_on <= arrivalTs)
          .sort((a, b) => (a.created - b.created) || (a.available_on - b.available_on));
        const candNet = candidates.reduce((s, bt) => s + (typeof bt.net === 'number' ? bt.net : 0), 0);
        if (candidates.length && candNet === bankAmount) {
          // Exact reconciliation: itemize under the payout and pull from Pending.
          const claimed = new Set(candidates.map((b) => b.id));
          pendingPool = pendingPool.filter((b) => !claimed.has(b.id));
          rows = candidates.map(rowFromBt).sort((a, b) => a.date.localeCompare(b.date));
          unconstituted = false;
        } else {
          groupNote = 'Auto-debit recovering a prior negative balance. Its itemized transactions settled in an earlier period and aren’t listed here.';
        }
      } else if (unconstituted) {
        groupNote = 'No itemized transactions reference this payout in the selected range.';
      }

      const transactionsNet = rows.reduce((s, r) => s + r.net_cents, 0);
      groupById[p.id] = {
        id: p.id,
        arrival_date: p.arrival_date ? new Date(p.arrival_date * 1000).toISOString().slice(0, 10) : '',
        status: p.status, // paid | in_transit | pending | failed | canceled
        direction,
        bank_amount_cents: bankAmount,            // signed: + deposit, − debit
        transactions_net_cents: transactionsNet,  // signed sum of the rows
        ties: rows.length > 0 ? transactionsNet === bankAmount : false,
        unconstituted,
        note: groupNote,
        gross_cents: rows.reduce((s, r) => s + r.gross_cents, 0),
        fee_cents: rows.reduce((s, r) => s + r.fee_cents, 0),
        count: rows.length,
        transactions: rows,
      };
    }
    const payoutGroups = payouts.map((p) => groupById[p.id]).sort((a, b) => b.arrival_date.localeCompare(a.arrival_date));

    // 6) Pending group (after window attribution removed any settled items).
    const pendingRows = pendingPool.map(rowFromBt).sort((a, b) => a.date.localeCompare(b.date));
    const pendingNet = pendingRows.reduce((s, r) => s + r.net_cents, 0);

    res.json({
      from: fromDate.toISOString().slice(0, 10),
      to: toDate.toISOString().slice(0, 10),
      payouts: payoutGroups,
      pending: {
        net_cents: pendingNet,
        gross_cents: pendingRows.reduce((s, r) => s + r.gross_cents, 0),
        fee_cents: pendingRows.reduce((s, r) => s + r.fee_cents, 0),
        count: pendingRows.length,
        transactions: pendingRows,
      },
      totals: {
        payout_count: payoutGroups.length,
        settled_net_cents: payoutGroups.reduce((s, g) => s + g.bank_amount_cents, 0),
        untied_count: payoutGroups.filter((g) => !g.ties).length,
      },
      // Surfaced only with ?debug=1: section errors + per-payout signals so we
      // can confirm grouping/direction without Render log access.
      ...(debug ? { _debug: {
        errors,
        payouts_fetched: payouts.length,
        pending_fetched: pendingBts.length,
        pending_after_attribution: pendingRows.length,
        payouts_seen: payoutGroups.map((g) => ({
          id: g.id, date: g.arrival_date, dir: g.direction, amount: g.bank_amount_cents,
          txns: g.count, net: g.transactions_net_cents, ties: g.ties, unconstituted: g.unconstituted,
          bt_payout_grouped: (payoutBts[g.id] || []).length, // raw bt.payout matches before window attribution
        })),
      } } : {}),
    });
  } catch (err) {
    // Log the full stack so we're never blind again; keep the client message
    // generic unless ?debug=1 is set (office-gated route).
    console.error('[accounting] payouts error:', (err && err.stack) ? err.stack : err);
    const body = { error: 'Server error' };
    if (req.query.debug === '1') {
      body.detail = { message: err && err.message, type: err && err.type, code: err && err.code, param: err && err.param, stack: err && err.stack };
      body.section_errors = errors;
    }
    res.status(500).json(body);
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
      companyState: meta.install_state,
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


// ---- Send "manage your account" email with portal link ----
async function sendCardUpdateLinkEmail({ name, email, portalUrl, companyState }) {
  const { subject, html, text } = buildCardUpdateLinkEmail({ name, portalUrl, companyState });
  return sendEmail({
    to: email,
    subject,
    html,
    text,
    logTag: '[card-update-link]',
    companyState,
  });
}

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

// Resolve which saved card to charge for an off-session payment. Stripe Checkout
// attaches the card as the SUBSCRIPTION's default_payment_method but does not
// always set the CUSTOMER's invoice_settings default, so a bare
// paymentIntents.create({ customer, confirm }) finds no payment method and fails
// with "missing a payment method". Try, in order: subscription default ->
// customer invoice-settings default -> first saved card. Returns a pm id or null.
async function resolveSavedPaymentMethod(stripeSubscriptionId, stripeCustomerId) {
  if (stripeSubscriptionId) {
    try {
      const subObj = await stripe.subscriptions.retrieve(stripeSubscriptionId);
      const pm = subObj && subObj.default_payment_method;
      if (pm) return typeof pm === 'string' ? pm : pm.id;
    } catch (e) {
      console.error('[adhoc-charge] subscription retrieve failed:', e && e.message);
    }
  }
  try {
    const cust = await stripe.customers.retrieve(stripeCustomerId);
    const pm = cust && cust.invoice_settings && cust.invoice_settings.default_payment_method;
    if (pm) return typeof pm === 'string' ? pm : pm.id;
  } catch (e) {
    console.error('[adhoc-charge] customer retrieve failed:', e && e.message);
  }
  try {
    const list = await stripe.paymentMethods.list({ customer: stripeCustomerId, type: 'card', limit: 1 });
    if (list && list.data && list.data.length) return list.data[0].id;
  } catch (e) {
    console.error('[adhoc-charge] paymentMethods.list failed:', e && e.message);
  }
  return null;
}

// Create a Customer Portal session for a subscription and email the card-update
// link to the customer (same flow as POST /subscriptions/:id/portal-session).
// Used when an off-session charge can't find a card. Returns { sent, reason }.
async function emailCardUpdateLinkForSub(subscriptionId) {
  try {
    const { data: sub } = await supabaseAdmin
      .from('generator_subscriptions')
      .select('stripe_customer_id, customer:generator_customers(name, email, install_state)')
      .eq('id', subscriptionId)
      .single();
    if (!sub || !sub.stripe_customer_id) return { sent: false, reason: 'no stripe customer' };
    const email = sub.customer && sub.customer.email;
    if (!email) return { sent: false, reason: 'no email on file' };
    const session = await stripe.billingPortal.sessions.create({
      customer: sub.stripe_customer_id,
      return_url: 'https://app.bates-electric.com/generator-care.html',
    });
    return await sendCardUpdateLinkEmail({
      name: (sub.customer && sub.customer.name) || null,
      email,
      portalUrl: session.url,
      companyState: (sub.customer && sub.customer.install_state) || null,
    });
  } catch (e) {
    console.error('[adhoc-charge] emailCardUpdateLinkForSub failed:', e && e.message);
    return { sent: false, reason: e && e.message };
  }
}


// POST /api/generator-care/admin/send-test-email
// Renders one of the customer-facing templates with fixture data and sends
// it to the supplied address. Lets us visually verify templates before
// flipping Stripe to live mode without triggering real customer events.
// Body: { template: 'welcome' | 'failed_charge' | 'portal_link', to: '...' }
const TEST_EMAIL_TEMPLATES = ['welcome', 'failed_charge', 'portal_link', 'visit_scheduled', 'visit_complete', 'renewal_upcoming', 'cancellation'];
const FAKE_PORTAL_URL = 'https://billing.stripe.com/p/session/test_PLACEHOLDER';

function buildTestTemplate(template) {
  if (template === 'welcome') {
    return buildWelcomeEmail({
      customer: { name: 'Sample Customer', email: 'sample@example.com' },
      meta: {
        gen_class: 'air_cooled',
        gen_type: 'Standby',
        gen_model: 'Generac Guardian 22kW',
        gen_serial: 'TEST-12345',
        install_address: '123 Main St',
        install_city: 'Imperial',
        install_state: 'MO',
        install_zip: '63052',
      },
      planLabel: 'Annual Care',
      nextVisitDate: '2026-08-15',
      annualPriceCents: 49900,
      fleetMonitoring: true,
      paidAmountCents: 49900,
      paidDate: '2026-06-18',
    });
  }
  if (template === 'failed_charge') {
    return buildCardFailedEmail({
      customer: { name: 'Sample Customer' },
      amountCents: 11000,
      description: 'Transfer Switch Inspection & Simulated Outage Test',
      portalUrl: FAKE_PORTAL_URL,
    });
  }
  if (template === 'portal_link') {
    return buildCardUpdateLinkEmail({
      name: 'Sample Customer',
      portalUrl: FAKE_PORTAL_URL,
    });
  }
  if (template === 'visit_scheduled') {
    return buildVisitScheduledEmail({
      customer: { name: 'Sample Customer' },
      scheduledDate: '2026-08-15',
      planLabel: 'Annual',
    });
  }
  if (template === 'visit_complete') {
    return buildVisitCompletedEmail({
      customer: { name: 'Sample Customer' },
      completedDate: '2026-06-08',
      nextVisitDate: '2027-06-08',
      planLabel: 'Annual',
      notes: 'Replaced battery. Tested generator under load — ran cleanly for 15 minutes. Topped off coolant.',
    });
  }
  if (template === 'cancellation') {
    return buildCancellationEmail({
      customer: { name: 'Sample Customer', email: 'sample@example.com' },
      periodEndDate: '2026-12-11',
    });
  }
  if (template === 'renewal_upcoming') {
    return buildRenewalUpcomingEmail({
      customer: { name: 'Sample Customer' },
      renewalDate: '2026-08-15',
      amountCents: 50500,
      planLabel: 'Annual',
      lineItems: [
        { amount_cents: 39500, description: 'Air Cooled Generator Care -- Annual' },
        { amount_cents: 11000, description: 'Transfer Switch Inspection & Simulated Outage Test' },
      ],
    });
  }
  return null;
}

router.post('/admin/send-test-email', async (req, res) => {
  try {
    const { template, to } = req.body || {};
    if (!template || !TEST_EMAIL_TEMPLATES.includes(template)) {
      return res.status(400).json({ error: `template must be one of: ${TEST_EMAIL_TEMPLATES.join(', ')}` });
    }
    if (!to || typeof to !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to.trim())) {
      return res.status(400).json({ error: 'to must be a valid email address' });
    }
    const built = buildTestTemplate(template);
    if (!built) {
      return res.status(400).json({ error: 'unknown template' });
    }
    const subjectWithPrefix = `[TEST] ${built.subject}`;
    const result = await sendEmail({
      to: to.trim(),
      subject: subjectWithPrefix,
      html: built.html,
      text: built.text,
      logTag: `[test-email:${template}]`,
    });
    if (!result.sent) {
      return res.status(502).json({ ok: false, template, to: to.trim(), error: result.reason });
    }
    return res.json({ ok: true, sent: true, template, to: to.trim(), subject: subjectWithPrefix });
  } catch (err) {
    console.error('[admin/send-test-email] error:', err);
    return res.status(500).json({ error: err.message || 'unknown error' });
  }
});

module.exports = router;
