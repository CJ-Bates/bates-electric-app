// backend/lib/scheduleVisit.js
// Core "book/reschedule an appointment" update, shared by the office endpoint
// (routes/generator-care/visits.js — which adds the customer email) and the
// field-tech endpoint (routes/generator-tech.js — which adds an internal
// office email instead; no customer email in the tech flow).
//
// The CALLER authorizes the actor. Pass assignedTechId to additionally scope
// the update to visits assigned to that tech (the IDOR boundary for the tech
// path) — the check happens inside the same UPDATE statement, so there is no
// TOCTOU gap.
//
// opts: { visitId, appointmentAt (Date), arrivalWindow (code|null),
//         bookedBy (display name), assignedTechId? (uuid) }
// arrivalWindow is the human-facing 2-hour window code from
// generator-catalog ARRIVAL_WINDOWS (callers validate); appointmentAt is the
// window's start instant and stays the sortable machine key. Always written:
// a booking without a window clears any stale one.
// Returns { visit, previousAppointmentAt, previousArrivalWindow } — visit
// includes the subscription+customer join the office email path needs; null
// visit means not found / already completed / not assigned to that tech.

const { supabaseAdmin } = require('./supabase');

async function scheduleServiceVisit({ visitId, appointmentAt, arrivalWindow, bookedBy, assignedTechId }) {
  // Pre-read for the audit trail ("moved from X to Y") with the same scoping
  // the update uses; also lets callers distinguish 404 from 403-ish cases.
  let preQuery = supabaseAdmin
    .from('generator_service_visits')
    .select('id, appointment_at, arrival_window, status, assigned_tech_id')
    .eq('id', visitId);
  if (assignedTechId) preQuery = preQuery.eq('assigned_tech_id', assignedTechId);
  const { data: before, error: preErr } = await preQuery.maybeSingle();
  if (preErr) throw preErr;
  if (!before) return { visit: null, previousAppointmentAt: null, previousArrivalWindow: null };

  let update = supabaseAdmin
    .from('generator_service_visits')
    .update({
      appointment_at: appointmentAt.toISOString(),
      arrival_window: arrivalWindow || null,
      scheduled_by: bookedBy,
      scheduled_at: new Date().toISOString(),
      status: 'scheduled',
    })
    .eq('id', visitId)
    .neq('status', 'completed');
  if (assignedTechId) update = update.eq('assigned_tech_id', assignedTechId);

  const { data: updated, error } = await update
    .select('*, subscription:generator_subscriptions(id, plan, customer:generator_customers(name, email, install_state))')
    .maybeSingle();
  if (error) throw error;

  return {
    visit: updated || null,
    previousAppointmentAt: before.appointment_at || null,
    previousArrivalWindow: before.arrival_window || null,
  };
}

module.exports = { scheduleServiceVisit };
