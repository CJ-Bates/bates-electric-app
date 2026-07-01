// backend/routes/generator-care/visits.js
// Service-visit actions: book/reschedule an appointment, mark complete
// (shared logic in lib/completeVisit.js), and dispatch/assign a tech.
// Auth (requireAuth + office role) is applied by ./index.js.

const express = require('express');
const { supabaseAdmin } = require('../../lib/supabase');
const { completeServiceVisit } = require('../../lib/completeVisit');
const { sendEmail, buildVisitScheduledEmail } = require('../../lib/emails');

const router = express.Router();

function planLabelFor(plan) {
  return plan === 'semi_annual' ? 'Semi-Annual' : (plan === 'annual' ? 'Annual' : plan);
}

// POST /api/generator-care/visits/:id/complete
// Office marks a service visit completed (actor-aware). Shared logic lives in
// lib/completeVisit.js so the field-tech endpoint behaves identically.
router.post('/visits/:id/complete', async (req, res) => {
  try {
    const { notes, internal_note, addons_performed, technician_id } = req.body || {};
    const result = await completeServiceVisit({
      visitId: req.params.id,
      completedDate: (req.body && req.body.completed_date) || null,
      notes,
      internalNote: internal_note,
      addonsPerformed: addons_performed,
      actorName: (req.profile && req.profile.full_name) || (req.user && req.user.email) || 'office',
      actorId: technician_id || (req.user && req.user.id),
    });
    res.json({ ok: true, visit: result.visit });
  } catch (err) {
    console.error('[generator-care] visit complete error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/generator-care/visits/:id/schedule
// Book (or reschedule) an appointment date+time for a visit -> "Scheduled".
// Distinct from the plan-driven DUE date (which stays on the subscription): this
// is the actual booked slot Amy confirmed with the customer by phone. Records who
// booked it + when (audit). This is the single, clear "schedule appointment"
// action and the intended seam for a future SMS confirmation/reminder (NOT built
// here). Office-gated; the actor is recorded (not hard-coded), so a future
// field-tech role could reuse this endpoint without a rewrite.
router.post('/visits/:id/schedule', async (req, res) => {
  try {
    const { id } = req.params;
    const { appointment_at } = req.body || {};
    if (!appointment_at) return res.status(400).json({ error: 'appointment_at (date + time) is required' });
    const when = new Date(appointment_at);
    if (isNaN(when.getTime())) return res.status(400).json({ error: 'appointment_at is not a valid date/time' });

    const bookedBy = (req.profile && req.profile.full_name) || (req.user && req.user.email) || 'office';

    const { data: updated, error: vErr } = await supabaseAdmin
      .from('generator_service_visits')
      .update({
        appointment_at: when.toISOString(),
        scheduled_by: bookedBy,
        scheduled_at: new Date().toISOString(),
        status: 'scheduled',
      })
      .eq('id', id)
      .neq('status', 'completed')
      .select('*, subscription:generator_subscriptions(id, plan, customer:generator_customers(name, email, install_state))')
      .maybeSingle();
    if (vErr) throw vErr;
    if (!updated) return res.status(404).json({ error: 'visit not found or already completed' });

    // Notify the customer their appointment is booked (existing template). Future
    // SMS confirmation hangs off THIS point. Pass the date part — template-safe.
    const sub = updated.subscription;
    const customer = sub && sub.customer;
    if (customer && customer.email) {
      const { subject, html, text } = buildVisitScheduledEmail({
        customer,
        scheduledDate: updated.appointment_at ? updated.appointment_at.slice(0, 10) : null,
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
    console.error('[generator-care] schedule visit error:', err && err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/generator-care/visits/:id/assign  { assigned_tech_id | null }
// Dispatch a tech to a visit (or clear the assignment). Office-gated; logs who/when.
router.post('/visits/:id/assign', async (req, res) => {
  try {
    const visitId = req.params.id;
    const techId = (req.body && req.body.assigned_tech_id) || null;

    if (techId) {
      // Validate the target is an active tech before assigning.
      const { data: tech, error: techErr } = await supabaseAdmin
        .from('profiles')
        .select('id, role, active, full_name')
        .eq('id', techId)
        .single();
      if (techErr || !tech) return res.status(400).json({ error: 'tech not found' });
      if (tech.role !== 'tech') return res.status(400).json({ error: 'that user is not a tech' });
      if (tech.active === false) return res.status(400).json({ error: 'that tech is deactivated' });
    }

    const assignedBy = (req.profile && req.profile.full_name) || (req.user && req.user.email) || 'office';
    const updates = techId
      ? { assigned_tech_id: techId, assigned_at: new Date().toISOString(), assigned_by: assignedBy }
      : { assigned_tech_id: null, assigned_at: null, assigned_by: null };

    const { data, error } = await supabaseAdmin
      .from('generator_service_visits')
      .update(updates)
      .eq('id', visitId)
      .select('id, assigned_tech_id, assigned_at, assigned_by')
      .single();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'visit not found' });
    res.json({ ok: true, visit: data });
  } catch (err) {
    console.error('[generator-care] assign visit error:', err && err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
