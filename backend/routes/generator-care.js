// backend/routes/generator-care.js
// Office dashboard data for the Generator Care program.
// All endpoints require office role.

const express = require('express');
const { supabaseAdmin } = require('../lib/supabase');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

// All routes require office role
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
        status: 'scheduled',
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

module.exports = router;
