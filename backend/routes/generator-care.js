// backend/routes/generator-care.js
// Office dashboard data for the Generator Care program.
// All endpoints require office role.

const express = require('express');
const { supabaseAdmin } = require('../lib/supabase');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

// All routes require office role
const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

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
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
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
      .select('*, subscription:generator_subscriptions(id, plan)')
      .single();
    if (updErr) throw updErr;

    // 2. Roll the subscription forward + schedule the NEXT visit
    const sub = updated.subscription;
    if (sub) {
      const monthsAhead = sub.plan === 'semi_annual' ? 6 : 12;
      const next = new Date(today);
      next.setMonth(next.getMonth() + monthsAhead);
      const nextStr = next.toISOString().slice(0, 10);

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

    res.json({ ok: true, visit: updated });
  } catch (err) {
    console.error('[generator-care] visit complete error:', err);
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
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
      .select('*, subscription:generator_subscriptions(id)')
      .single();
    if (vErr) throw vErr;

    // If date was updated, keep subscription.next_visit_due in sync
    if (scheduled_date && updated.subscription) {
      await supabaseAdmin
        .from('generator_subscriptions')
        .update({ next_visit_due: scheduled_date })
        .eq('id', updated.subscription.id);
    }

    res.json({ ok: true, visit: updated });
  } catch (err) {
    console.error('[generator-care] confirm visit error:', err);
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
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
      .select('*, customer:generator_customers(name)')
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
    const noteAddition = 'Canceled on ' + today + (reason ? ': ' + reason : '');
    const newNotes = sub.notes ? sub.notes + '\n\n' + noteAddition : noteAddition;

    const { data: updated, error: updErr } = await supabaseAdmin
      .from('generator_subscriptions')
      .update({
        status: 'canceled',
        notes: newNotes,
      })
      .eq('id', id)
      .select()
      .single();
    if (updErr) throw updErr;

    const periodEnd = stripeSub.current_period_end
      ? new Date(stripeSub.current_period_end * 1000).toISOString().slice(0, 10)
      : null;

    res.json({
      ok: true,
      subscription: updated,
      service_through: periodEnd,
    });
  } catch (err) {
    console.error('[generator-care] cancel subscription error:', err);
    res.status(500).json({ error: err.message });
  }
});


// Hardcoded catalog of one-time add-ons by gen class.
// Mirrors the catalog in bates-generator/netlify/functions/create-checkout.js.
const ADDON_CATALOG = {
  battery_replacement: {
    label: 'Battery Replacement',
    prices: {
      air_cooled:    { price_id: 'price_1TdcRZBbX7QhpMgba4u78SyS', amount_cents: 16500 },
      liquid_22_38:  { price_id: 'price_1TdcRaBbX7QhpMgbpgDY7xUh', amount_cents: 23500 },
      liquid_48_150: { price_id: 'price_1TdcRaBbX7QhpMgbtb0YgpLt', amount_cents: 26500 },
    },
  },
  exterior_wash: {
    label: 'Exterior Wash & Interior Blow-Out',
    prices: { all: { price_id: 'price_1TdcRZBbX7QhpMgbJxnGgkBp', amount_cents: 8500 } },
  },
  outage_test: {
    label: 'Simulated Power Outage Test',
    prices: { all: { price_id: 'price_1TdcRZBbX7QhpMgbj4pU8wA9', amount_cents: 7500 } },
  },
  coolant_flush: {
    label: 'Coolant System Flush',
    prices: {
      liquid_22_38:  { price_id: 'price_1TdcRaBbX7QhpMgbDUyQKlCh', amount_cents: 59500 },
      liquid_48_150: { price_id: 'price_1TdcRbBbX7QhpMgbfeEKybBk', amount_cents: 69500 },
    },
  },
  ats_inspection: {
    label: 'Automatic Transfer Switch Inspection',
    prices: { all: { price_id: 'price_1TdysDBbX7QhpMgb3nlOtlLn', amount_cents: 7500 } },
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
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
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
      .select('id, stripe_subscription_id, stripe_customer_id, status, customer:generator_customers(name)')
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
      let intent;
      try {
        intent = await stripe.paymentIntents.create({
          customer: sub.stripe_customer_id,
          amount: amount_cents,
          currency: 'usd',
          payment_method_types: ['card'],
          off_session: true,
          confirm: true,
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
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
