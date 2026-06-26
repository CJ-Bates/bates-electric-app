// backend/lib/completeVisit.js
// Shared "mark a Generator Care service visit complete" logic, used by BOTH the
// office dashboard and the field-tech endpoint so the behavior is identical no
// matter who completes the visit:
//   1) mark the visit completed (actor-aware: completed_by + technician_id),
//   2) roll the subscription's next_visit_due onto the plan's fixed cadence grid
//      (drift-free; anchored to signup, not the date performed),
//   3) create the next tentative visit UNASSIGNED (the office dispatches it later),
//   4) email the customer a state-branded completion confirmation (fire-and-forget).
//
// Note columns on generator_service_visits:
//   notes         = CUSTOMER-VISIBLE note (feeds the email + future customer view)
//   internal_note = office/tech-only note, NEVER sent to the customer.

const { supabaseAdmin } = require('./supabase');
const { sendEmail, buildVisitCompletedEmail } = require('./emails');

function planLabelFor(plan) {
  return plan === 'semi_annual' ? 'Semi-Annual' : (plan === 'annual' ? 'Annual' : plan);
}

// Next visit-due on the plan's fixed cadence grid (signup + k*interval), so it
// tracks payments instead of drifting with late completions. Earliest grid point
// strictly AFTER both the just-completed visit's due and the date performed.
function gridAnchoredNextDue(anchorStr, priorDueStr, performedStr, intervalMonths) {
  if (!anchorStr) return null;
  const d = new Date(anchorStr + 'T00:00:00Z');
  if (isNaN(d.getTime())) return null;
  const priorMs = priorDueStr ? new Date(priorDueStr + 'T00:00:00Z').getTime() : -Infinity;
  const performedMs = performedStr ? new Date(performedStr + 'T00:00:00Z').getTime() : -Infinity;
  let guard = 0;
  while (d.getTime() <= priorMs && guard++ < 4000) d.setUTCMonth(d.getUTCMonth() + intervalMonths);
  while (d.getTime() <= performedMs && guard++ < 4000) d.setUTCMonth(d.getUTCMonth() + intervalMonths);
  return d.toISOString().slice(0, 10);
}

// Complete a visit. The CALLER must have already authorized the actor and
// verified ownership (office role, or the tech this visit is assigned to).
// opts: { visitId, completedDate?, notes?, internalNote?, addonsPerformed?,
//         actorName, actorId }
//   internalNote: pass undefined to leave the existing note untouched; pass a
//   string (or '') to set/clear it.
// Returns { visit, nextVisitDate }.
async function completeServiceVisit(opts) {
  const {
    visitId, completedDate, notes, internalNote, addonsPerformed, actorName, actorId,
  } = opts || {};
  const today = completedDate || new Date().toISOString().slice(0, 10);

  // 1. Update the visit.
  const updatePayload = {
    status: 'completed',
    completed_date: today,
    completed_by: actorName || 'office',
    notes: notes || null,
    addons_performed: addonsPerformed || null,
    technician_id: actorId || null,
  };
  if (internalNote !== undefined) updatePayload.internal_note = internalNote || null;

  const { data: updated, error: updErr } = await supabaseAdmin
    .from('generator_service_visits')
    .update(updatePayload)
    .eq('id', visitId)
    .select('*, subscription:generator_subscriptions(id, plan, signup_date, next_visit_due, customer:generator_customers(name, email, install_state))')
    .single();
  if (updErr) throw updErr;

  // 2. Grid-anchored next due + create the next (unassigned) tentative visit.
  const sub = updated.subscription;
  let nextStr = null;
  if (sub) {
    const monthsAhead = sub.plan === 'semi_annual' ? 6 : 12;
    const anchorStr = sub.signup_date || updated.scheduled_date || sub.next_visit_due || today;
    const priorDueStr = updated.scheduled_date || sub.next_visit_due || null;
    nextStr = gridAnchoredNextDue(anchorStr, priorDueStr, today, monthsAhead);
    if (!nextStr) {
      const f = new Date(today + 'T00:00:00Z');
      f.setUTCMonth(f.getUTCMonth() + monthsAhead);
      nextStr = f.toISOString().slice(0, 10);
    }

    await supabaseAdmin
      .from('generator_subscriptions')
      .update({ last_visit_date: today, next_visit_due: nextStr })
      .eq('id', sub.id);

    // Unassigned on purpose — the office schedules + dispatches the next one.
    await supabaseAdmin.from('generator_service_visits').insert({
      subscription_id: sub.id,
      visit_type: 'regular_service',
      scheduled_date: nextStr,
      status: 'tentative',
    });
  }

  // 3. Customer completion email — uses the CUSTOMER-VISIBLE note only.
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
      to: customer.email, subject, html, text,
      logTag: '[visit-complete-email]',
      companyState: customer.install_state,
    }).catch((e) => console.error('[visit-complete-email] unexpected:', e && e.message));
  }

  return { visit: updated, nextVisitDate: nextStr };
}

module.exports = { completeServiceVisit, gridAnchoredNextDue, planLabelFor };
