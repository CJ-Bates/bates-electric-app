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
    const [subR, visitsR, addonsR] = await Promise.all([
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
    ]);
    if (subR.error) throw subR.error;
    if (visitsR.error) throw visitsR.error;
    if (addonsR.error) throw addonsR.error;
    res.json({
      subscription: subR.data,
      visits: visitsR.data || [],
      pending_addons: addonsR.data || [],
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


// POST /api/generator-care/addons/:id/charge
// Charge the customer's saved card for a pending add-on (off-session, default payment method).
// On success: marks addon 'charged'. On failure (declined etc.): marks 'failed' with reason in notes.
router.post('/addons/:id/charge', async (req, res) => {
  try {
    const { id } = req.params;

    // 1. Fetch the addon + sub + customer
    const { data: addon, error: addonErr } = await supabaseAdmin
      .from('generator_pending_addons')
      .select('*, subscription:generator_subscriptions(id, stripe_customer_id, customer:generator_customers(name))')
      .eq('id', id)
      .single();
    if (addonErr) throw addonErr;
    if (!addon) return res.status(404).json({ error: 'addon not found' });

    if (addon.status === 'charged') {
      return res.status(400).json({ error: 'addon already charged' });
    }
    if (!addon.amount_cents || addon.amount_cents <= 0) {
      return res.status(400).json({ error: 'no charge amount on this addon' });
    }
    if (!addon.subscription || !addon.subscription.stripe_customer_id) {
      return res.status(400).json({ error: 'no Stripe customer linked' });
    }

    const customerId = addon.subscription.stripe_customer_id;
    const customerName = (addon.subscription.customer && addon.subscription.customer.name) || 'customer';
    const today = new Date().toISOString().slice(0, 10);

    // 2. Create PaymentIntent on saved card (off-session)
    let intent;
    try {
      intent = await stripe.paymentIntents.create({
        customer: customerId,
        amount: addon.amount_cents,
        currency: 'usd',
        payment_method_types: ['card'],
        off_session: true,
        confirm: true,
        description: 'Generator add-on: ' + addon.addon_type + ' (' + customerName + ')',
        metadata: {
          addon_id: id,
          subscription_id: addon.subscription.id,
          addon_type: addon.addon_type,
        },
      });
    } catch (stripeErr) {
      const reason = stripeErr.message || stripeErr.code || 'unknown_error';
      await supabaseAdmin
        .from('generator_pending_addons')
        .update({
          status: 'failed',
          notes: 'Charge failed on ' + today + ': ' + reason,
        })
        .eq('id', id);
      return res.status(402).json({ error: 'charge failed', reason, addon_id: id });
    }

    // 3. Charge succeeded - record it
    const { data: updated, error: updErr } = await supabaseAdmin
      .from('generator_pending_addons')
      .update({
        status: 'charged',
        date_performed: addon.date_performed || today,
        date_charged: today,
        stripe_payment_intent_id: intent.id,
      })
      .eq('id', id)
      .select()
      .single();
    if (updErr) throw updErr;

    res.json({ ok: true, addon: updated, payment_intent_id: intent.id, amount_cents: intent.amount });
  } catch (err) {
    console.error('[generator-care] addon charge error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
