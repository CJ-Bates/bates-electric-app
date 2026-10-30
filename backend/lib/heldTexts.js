// backend/lib/heldTexts.js
// Closing out 'held' texts that will never go out (2026-10-30).
//
// lib/sms.js logs ONE 'held' row per automated message refused while the
// office owns a conversation; 'held' is non-terminal and the queue-and-sweep
// passes retry after hand-back. Those passes settle their own debt (send it,
// or stale-drop it with a NEW 'stale' row) but never touched the original
// held row, so it read "Held - will send if still relevant" forever. Live
// (2026-10-26, TEST customer Cj): a booking confirmation for Mon Oct 26 was
// held, the visit moved to Oct 27 and was handed back; the Oct 27 text went
// out, the Oct 26 one rightly didn't - and its row stayed 'held' for days.
//
// This module gives every held row a terminal answer once one exists:
//   'released' - the same message went out later (separate 'sent' row)
//   'dropped'  - it no longer applies; `detail` is the reason the thread
//                shows as "Not sent - {reason}"
// and leaves a row 'held' only while it may still send. Status is free text
// (no migration). A rule here must never drop a message a sweep would still
// send: that would make heldAlreadyLogged() miss it and log a fresh held row
// every hour. So each rule mirrors a case the sweeps no longer attempt.
//
// Runs from the hourly sms-reminders cron (DB only - outside quiet hours
// too, which is also the one-time cleanup of rows left before this shipped),
// after the hand-back sweep, and - for the rescheduled visit only - from
// lib/scheduleVisit.js the moment an appointment moves.

const { supabaseAdmin } = require('./supabase');
const { fmtSmsDate } = require('./sms');

// A held row older than the visit's latest (re)booking by more than this was
// for the previous appointment. The margin absorbs app-vs-database clock skew
// (scheduled_at is stamped by Node, created_at by Postgres) so a confirmation
// held seconds after its own booking is never mistaken for an old one.
const RESCHEDULE_MARGIN_MS = 60 * 1000;
// Later outcomes that settle the same message for good. Transient refusals
// (quiet_hours / disabled / failed) don't - the debt is still owed.
const SETTLED = new Set(['stale', 'no_consent', 'opted_out', 'invalid_phone', 'undeliverable', 'dropped']);
const KIND_LABEL = { booking_confirm: 'booking confirmation', reminder: 'reminder', nudge: 'scheduling text', review: 'review request' };

// Which automated text a body is, from the copy lib/sms.js builds. Only the
// held-able (automated, visit-tied) kinds matter; anything else is 'other'.
function heldKind(body) {
  const b = String(body || '');
  if (/your generator maintenance visit is set for /.test(b)) return 'booking_confirm';
  if (/ reminder: your generator maintenance is /.test(b)) return 'reminder';
  if (/it's time to schedule your generator maintenance/.test(b)) return 'nudge';
  if (/^Thanks for having us out/.test(b)) return 'review';
  return 'other';
}
const isAppointmentKind = (k) => k === 'booking_confirm' || k === 'reminder';

const centralDate = (d) => new Date(d).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
const ms = (iso) => new Date(iso).getTime();

// The terminal answer for one held row, or null to leave it held.
// later: this phone's outbound rows created after it (or in the same instant).
function decide(row, visit, later, todayCentral) {
  const kind = heldKind(row.body);
  const sameBody = later.filter((m) => m.body === row.body && (m.related_visit_id || null) === (row.related_visit_id || null));
  const sent = sameBody.find((m) => m.status === 'sent');
  if (sent) return { status: 'released', detail: 'sent after hand-back (' + sent.created_at + ')' };

  if (row.related_visit_id) {
    if (!visit) return { status: 'dropped', detail: 'the visit is no longer on the books' };
    if (visit.status === 'canceled') return { status: 'dropped', detail: 'the visit was canceled' };
    // Moved before anything else happened to it: that is the real reason.
    if (isAppointmentKind(kind) && visit.appointment_at && visit.scheduled_at && ms(visit.scheduled_at) > ms(row.created_at) + RESCHEDULE_MARGIN_MS) {
      return { status: 'dropped', detail: 'the visit was rescheduled to ' + fmtSmsDate(centralDate(visit.appointment_at)) };
    }
    if (visit.status === 'completed' && kind !== 'review') return { status: 'dropped', detail: 'the visit was completed' };
    if (isAppointmentKind(kind)) {
      if (visit.status !== 'scheduled' || !visit.appointment_at) return { status: 'dropped', detail: 'the visit is no longer scheduled' };
      const day = centralDate(visit.appointment_at);
      if (day < todayCentral) return { status: 'dropped', detail: 'the appointment day (' + fmtSmsDate(day) + ') passed' };
    }
    // A newer text of the same kind for the same visit replaced it (e.g. a
    // reminder rebuilt after the customer replied Y).
    if (kind !== 'other' && later.some((m) => m.related_visit_id === row.related_visit_id && m.body !== row.body && heldKind(m.body) === kind)) {
      return { status: 'dropped', detail: 'replaced by a newer ' + KIND_LABEL[kind] };
    }
  }

  const settled = sameBody.find((m) => SETTLED.has(m.status));
  if (settled) {
    return { status: 'dropped', detail: settled.status === 'stale' || settled.status === 'dropped' ? 'too late to send after hand-back' : 'a later attempt was refused (' + settled.status + ')' };
  }
  return null;
}

// Mark the row terminal - only while it is still 'held', so a concurrent
// close can't be overwritten. Returns whether it stuck.
async function closeRow(row, verdict) {
  const { error } = await supabaseAdmin
    .from('generator_sms_messages')
    .update({ status: verdict.status, detail: verdict.detail })
    .eq('id', row.id)
    .eq('status', 'held');
  if (error) {
    console.error('[held-texts] could not close held row ' + row.id + ':', error.message);
    return false;
  }
  return true;
}

// The sweep. opts: { now, visitId? (only that visit's rows), dryRun? (decide,
// write nothing) }. Never throws - a failure here must not stop the cron's
// sends. Returns { checked, dropped, released, closed: [{ id, status, detail }] }.
async function closeStaleHeldTexts({ now, visitId, dryRun } = {}) {
  const clock = now || new Date();
  const summary = { checked: 0, dropped: 0, released: 0, closed: [] };
  try {
    let q = supabaseAdmin
      .from('generator_sms_messages')
      .select('id, created_at, to_phone, body, related_visit_id')
      .eq('direction', 'out')
      .eq('status', 'held')
      .order('created_at', { ascending: true })
      .limit(500);
    if (visitId) q = q.eq('related_visit_id', visitId);
    const { data: held, error } = await q;
    if (error) throw error;
    if (!held || !held.length) return summary;

    const visitIds = [...new Set(held.map((r) => r.related_visit_id).filter(Boolean))];
    const phones = [...new Set(held.map((r) => r.to_phone).filter(Boolean))];
    const since = held[0].created_at;
    const [visitsRes, laterRes] = await Promise.all([
      visitIds.length
        ? supabaseAdmin.from('generator_service_visits').select('id, status, appointment_at, scheduled_at').in('id', visitIds)
        : Promise.resolve({ data: [], error: null }),
      supabaseAdmin
        .from('generator_sms_messages')
        .select('id, created_at, to_phone, body, status, related_visit_id')
        .eq('direction', 'out')
        .in('to_phone', phones)
        .gte('created_at', since)
        .limit(5000),
    ]);
    if (visitsRes.error) throw visitsRes.error;
    if (laterRes.error) throw laterRes.error;
    const visitById = new Map((visitsRes.data || []).map((v) => [v.id, v]));
    const outbound = laterRes.data || [];
    const todayCentral = centralDate(clock);

    for (const row of held) {
      summary.checked++;
      const later = outbound.filter((m) => m.id !== row.id && m.to_phone === row.to_phone && m.created_at >= row.created_at && m.status !== 'note');
      const verdict = decide(row, row.related_visit_id ? visitById.get(row.related_visit_id) || null : null, later, todayCentral);
      if (!verdict) continue;
      if (!dryRun && !(await closeRow(row, verdict))) continue;
      summary[verdict.status]++;
      summary.closed.push({ id: row.id, status: verdict.status, detail: verdict.detail });
    }
  } catch (e) {
    console.error('[held-texts] sweep failed:', e && e.message);
    summary.error = (e && e.message) || String(e);
  }
  return summary;
}

// A visit just moved: every held appointment text for it (confirmation,
// reminders) described the OLD slot. Drop them now, before the caller sends
// the new booking confirmation. Never throws; returns the count dropped.
async function dropHeldForReschedule({ visitId, appointmentAt }) {
  try {
    const { data: held, error } = await supabaseAdmin
      .from('generator_sms_messages')
      .select('id, body')
      .eq('direction', 'out')
      .eq('status', 'held')
      .eq('related_visit_id', visitId);
    if (error) throw error;
    const detail = 'the visit was rescheduled' + (appointmentAt ? ' to ' + fmtSmsDate(centralDate(appointmentAt)) : '');
    let n = 0;
    for (const row of held || []) {
      if (!isAppointmentKind(heldKind(row.body))) continue;
      if (await closeRow(row, { status: 'dropped', detail })) n++;
    }
    return n;
  } catch (e) {
    console.error('[held-texts] reschedule drop failed for visit ' + visitId + ':', e && e.message);
    return 0;
  }
}

module.exports = { closeStaleHeldTexts, dropHeldForReschedule, heldKind, decide, RESCHEDULE_MARGIN_MS };
