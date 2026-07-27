// backend/routes/generator-care/visits.js
// Service-visit actions: book/reschedule an appointment, mark complete
// (shared logic in lib/completeVisit.js), and dispatch/assign a tech.
// Auth (requireAuth + office role) is applied by ./index.js.

const express = require('express');
const { requirePermission } = require('../../middleware/permissions');
const { supabaseAdmin } = require('../../lib/supabase');
const { completeServiceVisit } = require('../../lib/completeVisit');
const { scheduleServiceVisit } = require('../../lib/scheduleVisit');
const { arrivalWindow, arrivalWindowLabel } = require('../../lib/generator-catalog');
const { sendEmail, buildVisitScheduledEmail, DASHBOARD_URL } = require('../../lib/emails');
const { sendSms, buildBookingConfirmationSms } = require('../../lib/sms');
const { reportError } = require('../../middleware/error-reporter');
// Tighter limiter for the email-sending endpoint in this file.
const sensitiveLimiter = require('../../middleware/limiters').makeSensitiveLimiter();

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
    // Audit integrity: technician_id becomes the recorded actor, so a
    // client-supplied value must be a real, active tech (mirrors the /assign
    // route). An unknown/inactive/non-tech id is rejected rather than trusted.
    if (technician_id) {
      const { data: tech, error: techErr } = await supabaseAdmin
        .from('profiles')
        .select('id, role, active')
        .eq('id', technician_id)
        .single();
      if (techErr || !tech) return res.status(400).json({ error: 'tech not found' });
      if (tech.role !== 'tech') return res.status(400).json({ error: 'that user is not a tech' });
      if (tech.active === false) return res.status(400).json({ error: 'that tech is deactivated' });
    }
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
    reportError(err, { route: req.originalUrl, method: req.method, user: req.profile && req.profile.email }).catch(() => {});
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/generator-care/visits/:id/schedule
// Book (or reschedule) an appointment for a visit -> "Scheduled". The booking
// is a DATE + 2-hour ARRIVAL WINDOW (how Amy actually schedules): the client
// sends appointment_at as the window's start instant (the sortable machine
// key) plus the window code in arrival_window. Distinct from the plan-driven
// DUE date (which stays on the subscription). Records who booked it + when
// (audit). This is the single, clear "schedule appointment" action and the
// intended seam for a future SMS confirmation/reminder (NOT built here).
// Office-gated; the actor is recorded (not hard-coded), so a future
// field-tech role could reuse this endpoint without a rewrite.
router.post('/visits/:id/schedule', sensitiveLimiter, async (req, res) => {
  try {
    const { id } = req.params;
    const { appointment_at, arrival_window } = req.body || {};
    if (!appointment_at) return res.status(400).json({ error: 'appointment_at (date + time) is required' });
    const when = new Date(appointment_at);
    if (isNaN(when.getTime())) return res.status(400).json({ error: 'appointment_at is not a valid date/time' });
    // Window code must come from the shared list when present. Absent is
    // allowed (legacy clients) — the visit shows its stored time instead.
    if (arrival_window && !arrivalWindow(arrival_window)) {
      return res.status(400).json({ error: 'arrival_window is not one of the bookable windows' });
    }

    const bookedBy = (req.profile && req.profile.full_name) || (req.user && req.user.email) || 'office';

    // Core update lives in lib/scheduleVisit.js — shared with the field-tech
    // reschedule endpoint (which sends an internal email instead of this
    // customer email).
    const { visit: updated } = await scheduleServiceVisit({
      visitId: id,
      appointmentAt: when,
      arrivalWindow: arrival_window || null,
      bookedBy,
    });
    if (!updated) return res.status(404).json({ error: 'visit not found or already completed' });

    // Booking settles pending customer appointment preferences across the
    // WHOLE subscription — not just this visit — so a request that rode in on
    // an older (since-completed/rolled) visit clears from the Needs Attention
    // queue too. They flip to 'used' so the office modal and the customer's
    // hero stop showing them. Best-effort: booking must never fail because
    // the 016 migration isn't applied yet.
    try {
      const subId = updated.subscription_id || (updated.subscription && updated.subscription.id) || null;
      let visitIds = [id];
      if (subId) {
        const { data: vRows } = await supabaseAdmin
          .from('generator_service_visits')
          .select('id')
          .eq('subscription_id', subId);
        if (vRows && vRows.length) visitIds = vRows.map((v) => v.id);
      }
      const { error: prefErr } = await supabaseAdmin
        .from('generator_visit_preferences')
        .update({ status: 'used' })
        .in('visit_id', visitIds)
        .eq('status', 'pending');
      if (prefErr) console.log('[generator-care] preference mark-used skipped:', prefErr.message);
    } catch (e) {
      console.log('[generator-care] preference mark-used skipped:', e && e.message);
    }

    // Notify the customer their appointment is booked. The email leads with
    // the ARRIVAL WINDOW (never a single clock time) — this is the surface
    // Amy cares most about. Future SMS confirmation hangs off THIS point.
    const sub = updated.subscription;
    const customer = sub && sub.customer;
    if (customer && customer.email) {
      const { subject, html, text } = buildVisitScheduledEmail({
        customer,
        scheduledDate: updated.appointment_at ? updated.appointment_at.slice(0, 10) : null,
        arrivalWindowLabel: arrivalWindowLabel(updated.arrival_window),
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

    // SMS booking confirmation (Phase 1). sendSms owns every guard — consent,
    // the SMS_ENABLED kill-switch, quiet hours — and logs refused sends, so
    // this call is unconditional when a phone exists. Fire-and-forget: a text
    // hiccup must never fail the booking Amy just made.
    if (customer && customer.phone) {
      const body = buildBookingConfirmationSms({
        name: customer.name,
        installState: customer.install_state,
        dateStr: updated.appointment_at ? updated.appointment_at.slice(0, 10) : null,
        windowCode: updated.arrival_window,
        link: DASHBOARD_URL,
      });
      sendSms({
        toPhone: customer.phone,
        body,
        customerId: customer.id,
        relatedVisitId: updated.id,
      }).catch((e) => console.error('[visit-scheduled-sms] unexpected:', e && e.message));
    }

    res.json({ ok: true, visit: updated });
  } catch (err) {
    console.error('[generator-care] schedule visit error:', err && err.message);
    reportError(err, { route: req.originalUrl, method: req.method, user: req.profile && req.profile.email }).catch(() => {});
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/generator-care/visits/:id/assign  { assigned_tech_id | null }
// Dispatch a tech to a visit (or clear the assignment). Office-gated; logs who/when.
router.post('/visits/:id/assign', requirePermission('tech_manage'), async (req, res) => {
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
    reportError(err, { route: req.originalUrl, method: req.method, user: req.profile && req.profile.email }).catch(() => {});
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================================
// TECH-DASHBOARD PHASE 2 (additive block) — visit photos, office side.
// GET /api/generator-care/visits/:id/photos
// Photos techs attached to a visit (bucket generator-visit-photos, table
// generator_visit_photos — see sql/010_tech_phase2.sql). Returns short-lived
// signed URLs for the office modal's photo strip. Office-gated by ./index.js.
// ============================================================================
const VISIT_PHOTOS_BUCKET = 'generator-visit-photos';
const VISIT_PHOTO_URL_TTL_SECONDS = 60 * 60; // 1 hour — the modal is ephemeral

router.get('/visits/:id/photos', async (req, res) => {
  try {
    const { data: rows, error } = await supabaseAdmin
      .from('generator_visit_photos')
      .select('id, storage_path, uploaded_by, created_at')
      .eq('visit_id', req.params.id)
      .order('created_at', { ascending: true });
    if (error) throw error;
    if (!rows || !rows.length) return res.json({ photos: [] });

    const { data: signed, error: signErr } = await supabaseAdmin
      .storage
      .from(VISIT_PHOTOS_BUCKET)
      .createSignedUrls(rows.map((r) => r.storage_path), VISIT_PHOTO_URL_TTL_SECONDS);
    if (signErr) throw signErr;

    const bySigned = new Map((signed || []).map((s) => [s.path, s.signedUrl]));
    res.json({
      photos: rows.map((r) => ({
        id: r.id,
        created_at: r.created_at,
        url: bySigned.get(r.storage_path) || null,
      })).filter((p) => p.url),
    });
  } catch (err) {
    console.error('[generator-care] visit photos error:', err && err.message);
    reportError(err, { route: req.originalUrl, method: req.method, user: req.profile && req.profile.email }).catch(() => {});
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
