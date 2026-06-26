// backend/routes/generator-tech.js
// Field-tech endpoints for Generator Care. Tech-gated (role='tech'); every query
// is scoped to visits ASSIGNED to the calling tech (assigned_tech_id = the tech's
// own user id) — the IDOR boundary. Returns ONLY curated, non-billing fields: a
// tech never sees Stripe ids, prices, fleet/annual billing, or other customers.
//
// Mounted at /api/generator-care/tech.

const express = require('express');
const { supabaseAdmin } = require('../lib/supabase');
const { requireAuth, requireRole } = require('../middleware/auth');
const { completeServiceVisit } = require('../lib/completeVisit');

const router = express.Router();

// Auth + tech role for everything here. (Deactivated accounts are already
// rejected in requireAuth via profiles.active.)
router.use(requireAuth, requireRole('tech'));

// Curated visit shape: what a tech needs in the field, nothing about billing.
const TECH_VISIT_SELECT = `
  id, status, visit_type, scheduled_date, appointment_at, completed_date, completed_by,
  notes, internal_note, assigned_at,
  subscription:generator_subscriptions(
    id, plan, gen_class, gen_type_label, gen_model, gen_serial,
    customer:generator_customers(name, phone, install_address, install_city, install_state, install_zip)
  )
`;

// GET /api/generator-care/tech/my-visits
// All visits dispatched to the calling tech (open + recently completed). The
// frontend groups Today / Upcoming / Completed by local date.
router.get('/my-visits', async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('generator_service_visits')
      .select(TECH_VISIT_SELECT)
      .eq('assigned_tech_id', req.user.id)
      .order('appointment_at', { ascending: true, nullsFirst: false })
      .order('scheduled_date', { ascending: true, nullsFirst: false });
    if (error) throw error;
    res.json({ visits: data || [] });
  } catch (err) {
    console.error('[generator-tech] my-visits error:', err && err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/generator-care/tech/my-visits/:id — one assigned visit (IDOR-scoped).
router.get('/my-visits/:id', async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('generator_service_visits')
      .select(TECH_VISIT_SELECT)
      .eq('id', req.params.id)
      .eq('assigned_tech_id', req.user.id)
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(403).json({ error: 'This visit is not assigned to you.' });
    res.json({ visit: data });
  } catch (err) {
    console.error('[generator-tech] my-visit detail error:', err && err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/generator-care/tech/my-visits/:id/complete
// Body: { completed_date?, notes?, internal_note? }. Reuses the shared completion
// logic (grid-anchored next due + customer email). IDOR-scoped to the tech.
router.post('/my-visits/:id/complete', async (req, res) => {
  try {
    // Ownership + state guard: must be assigned to this tech and not already done.
    const { data: visit, error: vErr } = await supabaseAdmin
      .from('generator_service_visits')
      .select('id, status, completed_date, assigned_tech_id')
      .eq('id', req.params.id)
      .eq('assigned_tech_id', req.user.id)
      .maybeSingle();
    if (vErr) throw vErr;
    if (!visit) return res.status(403).json({ error: 'This visit is not assigned to you.' });
    if (visit.status === 'completed' || visit.completed_date) {
      return res.status(400).json({ error: 'This visit is already completed.' });
    }

    const { notes, internal_note } = req.body || {};
    const result = await completeServiceVisit({
      visitId: req.params.id,
      completedDate: (req.body && req.body.completed_date) || null,
      notes,
      internalNote: internal_note,
      actorName: (req.profile && req.profile.full_name) || (req.user && req.user.email) || 'tech',
      actorId: req.user.id,
    });
    res.json({ ok: true, visit: result.visit });
  } catch (err) {
    console.error('[generator-tech] complete error:', err && err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
