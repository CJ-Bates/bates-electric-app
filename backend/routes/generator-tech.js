// backend/routes/generator-tech.js
// Field-tech endpoints for Generator Care. Tech-gated (role='tech'); every query
// is scoped to visits ASSIGNED to the calling tech (assigned_tech_id = the tech's
// own user id) — the IDOR boundary. Techs see the add-on MENU (labels + prices +
// statuses) and can add/enroll/charge on their assigned visit (add-ons menu
// redesign, Phase 1) — but responses still never carry Stripe ids, fleet/annual
// billing, or other customers' data.
//
// Mounted at /api/generator-care/tech.

const express = require('express');
const { supabaseAdmin } = require('../lib/supabase');
const { requireAuth, requireRole } = require('../middleware/auth');
const { requirePermission } = require('../middleware/permissions');
const { completeServiceVisit, generateStandingAddons } = require('../lib/completeVisit');
const { scheduleServiceVisit } = require('../lib/scheduleVisit');
const { sendEmail, buildSignupLinkEmail } = require('../lib/emails');
const { ADDON_CATALOG, arrivalWindow, arrivalWindowLabel, lookupAddonPrice, isRecurringAddon } = require('../lib/generator-catalog');
const { chargeVisitCart, getVisitCartCharges, getOpenVisitId } = require('../lib/gcCharges');
const { buildAddonMenu } = require('../lib/addonMenu');
const { reportError } = require('../middleware/error-reporter');

const router = express.Router();

// Internal notifications (tech reschedules) go to the office role mailbox —
// same recipient convention as the daily digest cron.
const OFFICE_NOTIFY_TO = (process.env.GENERATOR_DIGEST_TO || 'cjbates@bates-electric.com,generators@bates-electric.com')
  .split(',').map((s) => s.trim()).filter(Boolean);

// Tech-initiated CHARGES notify the office inbox (OFFICE_EMAIL — the same
// mailbox inspection reports go to), so every dollar a tech moves in the field
// lands in front of the office the same day.
const CHARGE_NOTIFY_TO = (process.env.OFFICE_EMAIL || 'amyp@bates-electric.com,cjbates@bates-electric.com')
  .split(',').map((s) => s.trim()).filter(Boolean);

const VISIT_PHOTOS_BUCKET = 'generator-visit-photos';
const VISIT_PHOTO_URL_TTL_SECONDS = 60 * 60 * 8; // signed URLs last a field day

// The public signup site (bates-generator repo) — same env override the
// office send-signup route uses (routes/generator-care/leads.js).
const SIGNUP_BASE_URL =
  (process.env.GENERATOR_SIGNUP_URL || 'https://generator.bates-electric.com').replace(/\/+$/, '');

// Same deliberately-loose shape check as the office leads routes (and their
// frontend mirror LEAD_EMAIL_RE): catches a phone number typed into the email
// box, doesn't police RFC 5322.
const EMAIL_RE = /^\S+@\S+\.\S+$/;

// Visit-photo storage objects are namespaced `<visit_id>/<filename>` (see the
// frontend uploader + sql/010_tech_phase2.sql). The generator_visit_photos
// INSERT policy checks visit_id + uploaded_by but never binds storage_path's
// prefix to visit_id — so a tech can insert a row on their OWN assigned visit
// whose storage_path points at ANOTHER visit's object. The backend then signs
// or removes that path with the SERVICE ROLE (supabaseAdmin), which bypasses
// storage RLS. Re-bind the prefix here before signing/removing anything to
// close that confused-deputy. (A DB CHECK binding the prefix at insert time is
// the belt-and-suspenders follow-up — see sql/019.)
function pathBelongsToVisit(storagePath, visitId) {
  return typeof storagePath === 'string' && storagePath.startsWith(visitId + '/');
}

// Readable Central-time stamp for internal emails ("moved from X to Y").
function fmtCentral(iso) {
  if (!iso) return 'unscheduled';
  try {
    return new Date(iso).toLocaleString('en-US', {
      timeZone: 'America/Chicago',
      month: 'short', day: 'numeric', year: 'numeric',
      hour: 'numeric', minute: '2-digit',
    }) + ' CT';
  } catch (e) { return iso; }
}

// Appointment display for internal emails: date + arrival window ("Tue,
// Jul 21 · 8:00–10:00 AM arrival") when the visit has one; otherwise the
// legacy exact-time stamp.
function fmtApptCentral(iso, windowCode) {
  if (!iso) return 'unscheduled';
  const label = arrivalWindowLabel(windowCode);
  if (!label) return fmtCentral(iso);
  try {
    const day = new Date(iso).toLocaleDateString('en-US', {
      timeZone: 'America/Chicago',
      weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
    });
    return `${day} · ${label} arrival`;
  } catch (e) { return fmtCentral(iso); }
}

// Ownership guard shared by the phase-2 endpoints: the visit must be assigned
// to the calling tech (the IDOR boundary). Returns the visit row or null.
async function assignedVisit(req, extraCols) {
  const cols = 'id, status, completed_date, assigned_tech_id, appointment_at, subscription_id'
    + (extraCols ? ', ' + extraCols : '');
  const { data, error } = await supabaseAdmin
    .from('generator_service_visits')
    .select(cols)
    .eq('id', req.params.id)
    .eq('assigned_tech_id', req.user.id)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

// Auth + tech role for everything here. (Deactivated accounts are already
// rejected in requireAuth via profiles.active.)
router.use(requireAuth, requireRole('tech'));

// Curated visit shape: what a tech needs in the field, nothing about billing.
const TECH_VISIT_SELECT = `
  id, status, visit_type, scheduled_date, appointment_at, arrival_window, completed_date, completed_by,
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
// Body: { completed_date?, notes?, internal_note?, parts_note? }. Reuses the
// shared completion logic (grid-anchored next due + customer email).
// IDOR-scoped to the tech. parts_note ("Parts used / needs quote") appends
// into internal_note as a "[Field]"-prefixed line — never customer-visible.
router.post('/my-visits/:id/complete', async (req, res) => {
  try {
    // Ownership + state guard: must be assigned to this tech and not already done.
    const { data: visit, error: vErr } = await supabaseAdmin
      .from('generator_service_visits')
      .select('id, status, completed_date, assigned_tech_id, internal_note')
      .eq('id', req.params.id)
      .eq('assigned_tech_id', req.user.id)
      .maybeSingle();
    if (vErr) throw vErr;
    if (!visit) return res.status(403).json({ error: 'This visit is not assigned to you.' });
    if (visit.status === 'completed' || visit.completed_date) {
      return res.status(400).json({ error: 'This visit is already completed.' });
    }

    const { notes, internal_note, parts_note } = req.body || {};
    const actorName = (req.profile && req.profile.full_name) || (req.user && req.user.email) || 'tech';

    // Compose the internal note: the dialog's internal field behaves as before
    // (set/clear); a non-empty parts note APPENDS a stamped [Field] line so the
    // office sees exactly who reported what from the job site.
    let internalNote = internal_note;
    if (parts_note && String(parts_note).trim()) {
      const stamp = new Date().toISOString().slice(0, 10);
      // Length-capped server-side — this lands in a shared office note field.
      const fieldLine = `[Field] ${actorName} ${stamp}: ${String(parts_note).trim().slice(0, 4000)}`;
      const base = (internal_note !== undefined && internal_note !== null)
        ? String(internal_note).trim()
        : (visit.internal_note || '');
      internalNote = base ? `${base}\n${fieldLine}` : fieldLine;
    }

    const result = await completeServiceVisit({
      visitId: req.params.id,
      completedDate: (req.body && req.body.completed_date) || null,
      notes,
      internalNote,
      actorName,
      actorId: req.user.id,
    });
    res.json({ ok: true, visit: result.visit });
  } catch (err) {
    console.error('[generator-tech] complete error:', err && err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================================
// PHASE 2 — Feature 2: tech reschedules their OWN assigned appointment.
// POST /api/generator-care/tech/my-visits/:id/schedule
// Body: { appointment_at, arrival_window } — a date + 2-hour arrival window
// (same booking shape as the office; appointment_at is the window's start
// instant). Same core update as the office seam (lib/scheduleVisit.js) with
// the assignment check inside the UPDATE, and scheduled_by = the tech's name
// so the office audit line reads "Booked by <tech>". Sends a plain INTERNAL
// email to the office mailbox; deliberately NO customer email in this phase.
// ============================================================================
router.post('/my-visits/:id/schedule', requirePermission('tech_reschedule'), async (req, res) => {
  try {
    const { appointment_at, arrival_window } = req.body || {};
    if (!appointment_at) return res.status(400).json({ error: 'appointment_at (date + time) is required' });
    const when = new Date(appointment_at);
    if (isNaN(when.getTime())) return res.status(400).json({ error: 'appointment_at is not a valid date/time' });
    if (arrival_window && !arrivalWindow(arrival_window)) {
      return res.status(400).json({ error: 'arrival_window is not one of the bookable windows' });
    }

    const techName = (req.profile && req.profile.full_name) || (req.user && req.user.email) || 'tech';

    const { visit, previousAppointmentAt, previousArrivalWindow } = await scheduleServiceVisit({
      visitId: req.params.id,
      appointmentAt: when,
      arrivalWindow: arrival_window || null,
      bookedBy: techName,
      assignedTechId: req.user.id, // IDOR boundary, enforced inside the UPDATE
    });
    if (!visit) return res.status(403).json({ error: 'This visit is not assigned to you (or is already completed).' });

    // Internal heads-up to the office. Fire-and-forget: a mail hiccup must not
    // fail the reschedule the tech just made from a job site.
    const customerName = (visit.subscription && visit.subscription.customer && visit.subscription.customer.name) || 'customer';
    const fromStr = fmtApptCentral(previousAppointmentAt, previousArrivalWindow);
    const toStr = fmtApptCentral(visit.appointment_at, visit.arrival_window);
    const line = `Visit for ${customerName} moved from ${fromStr} to ${toStr} by ${techName}.`;
    sendEmail({
      to: OFFICE_NOTIFY_TO,
      subject: `[Generator Care] Visit rescheduled by ${techName} \u2014 ${customerName}`,
      html: `<p style="font-family:system-ui,sans-serif;font-size:14px;">${line}</p>`,
      text: line,
      logTag: '[tech-reschedule-email]',
    }).catch((e) => console.error('[tech-reschedule-email] unexpected:', e && e.message));

    res.json({ ok: true, visit: { id: visit.id, appointment_at: visit.appointment_at, arrival_window: visit.arrival_window || null, status: visit.status } });
  } catch (err) {
    console.error('[generator-tech] schedule error:', err && err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================================
// PHASE 2 — Feature 1: visit photos.
// Upload happens DIRECTLY from the phone to Supabase Storage with the tech's
// JWT (same pattern as inspection photos) — RLS on the bucket + table is the
// gate (sql/010_tech_phase2.sql). These endpoints cover read (signed URLs)
// and delete-own-before-complete, both IDOR-scoped to the assigned tech.
// ============================================================================

// GET /api/generator-care/tech/my-visits/:id/photos
router.get('/my-visits/:id/photos', async (req, res) => {
  try {
    const visit = await assignedVisit(req);
    if (!visit) return res.status(403).json({ error: 'This visit is not assigned to you.' });

    const { data: rows, error } = await supabaseAdmin
      .from('generator_visit_photos')
      .select('id, storage_path, uploaded_by, created_at')
      .eq('visit_id', visit.id)
      .order('created_at', { ascending: true });
    if (error) throw error;
    if (!rows || !rows.length) return res.json({ photos: [] });

    // Never sign an object that doesn't live under this visit's prefix. In
    // normal operation every row matches (uploads are `<visit_id>/...`); a
    // mismatch is a tampered/confused-deputy row, so we drop it (rather than
    // fail the whole list) and log it as a security signal.
    const ownRows = rows.filter((r) => pathBelongsToVisit(r.storage_path, visit.id));
    if (ownRows.length !== rows.length) {
      const foreign = rows.filter((r) => !pathBelongsToVisit(r.storage_path, visit.id));
      console.warn('[generator-tech] photos list: dropped %d visit-photo row(s) with storage_path outside visit %s (ids: %s)',
        foreign.length, visit.id, foreign.map((r) => r.id).join(','));
    }
    if (!ownRows.length) return res.json({ photos: [] });

    const { data: signed, error: signErr } = await supabaseAdmin
      .storage
      .from(VISIT_PHOTOS_BUCKET)
      .createSignedUrls(ownRows.map((r) => r.storage_path), VISIT_PHOTO_URL_TTL_SECONDS);
    if (signErr) throw signErr;

    const bySigned = new Map((signed || []).map((s) => [s.path, s.signedUrl]));
    res.json({
      photos: ownRows.map((r) => ({
        id: r.id,
        created_at: r.created_at,
        mine: r.uploaded_by === req.user.id,
        deletable: r.uploaded_by === req.user.id && visit.status !== 'completed',
        url: bySigned.get(r.storage_path) || null,
      })).filter((p) => p.url),
    });
  } catch (err) {
    console.error('[generator-tech] photos list error:', err && err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/generator-care/tech/my-visits/:id/photos/:photoId
// Delete-own-before-complete: only the uploader, only while the visit is open.
router.delete('/my-visits/:id/photos/:photoId', async (req, res) => {
  try {
    const visit = await assignedVisit(req);
    if (!visit) return res.status(403).json({ error: 'This visit is not assigned to you.' });
    if (visit.status === 'completed') {
      return res.status(400).json({ error: 'This visit is completed \u2014 photos are locked.' });
    }

    const { data: photo, error: pErr } = await supabaseAdmin
      .from('generator_visit_photos')
      .select('id, visit_id, uploaded_by, storage_path')
      .eq('id', req.params.photoId)
      .eq('visit_id', visit.id)
      .maybeSingle();
    if (pErr) throw pErr;
    if (!photo) return res.status(404).json({ error: 'Photo not found on this visit.' });
    if (photo.uploaded_by !== req.user.id) {
      return res.status(403).json({ error: 'You can only delete photos you uploaded.' });
    }
    // Confused-deputy guard: the row's visit_id is this visit, but its
    // storage_path was never bound to visit_id at insert. Refuse to remove an
    // object outside this visit's prefix — the service role bypasses storage
    // RLS, so without this a tech could permanently delete another visit's photo.
    if (!pathBelongsToVisit(photo.storage_path, visit.id)) {
      console.warn('[generator-tech] photo delete: refused storage_path outside visit %s (photo %s)',
        visit.id, photo.id);
      return res.status(403).json({ error: 'This photo does not belong to this visit.' });
    }

    const { error: rmErr } = await supabaseAdmin
      .storage.from(VISIT_PHOTOS_BUCKET).remove([photo.storage_path]);
    if (rmErr) throw rmErr;
    const { error: delErr } = await supabaseAdmin
      .from('generator_visit_photos').delete().eq('id', photo.id);
    if (delErr) throw delErr;

    res.json({ ok: true });
  } catch (err) {
    console.error('[generator-tech] photo delete error:', err && err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================================
// PHASE 2 — Feature 3: field flags on pending add-ons.
// Techs see the visit's pending/performed add-ons as a checklist (labels only —
// NEVER amounts or Stripe ids; billing is office-only) and can flip
// pending -> performed (and undo their flip while it's still unbilled). The
// office bills later via "Charge performed add-ons", unchanged.
// ============================================================================

// Curated add-on shape for techs: no amounts, no Stripe ids.
function techAddonShape(a) {
  const cat = ADDON_CATALOG[a.addon_type];
  return {
    id: a.id,
    label: (cat && cat.label) || a.addon_type,
    status: a.status,
    date_performed: a.date_performed || null,
    performed_by: a.performed_by || null,
  };
}

// GET /api/generator-care/tech/my-visits/:id/addons
router.get('/my-visits/:id/addons', async (req, res) => {
  try {
    const visit = await assignedVisit(req);
    if (!visit) return res.status(403).json({ error: 'This visit is not assigned to you.' });

    const { data: addons, error } = await supabaseAdmin
      .from('generator_pending_addons')
      .select('id, addon_type, status, date_performed, performed_by')
      .eq('subscription_id', visit.subscription_id)
      .in('status', ['pending', 'performed'])
      .order('created_at', { ascending: true });
    if (error) throw error;
    res.json({ addons: (addons || []).map(techAddonShape) });
  } catch (err) {
    console.error('[generator-tech] addons list error:', err && err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/generator-care/tech/my-visits/:id/addons/:addonId/perform
// Body: { undo? } — undo reverts performed -> pending (only while unbilled).
// Actor recorded in performed_by. Billing state (charged/canceled) is
// untouchable from this endpoint.
router.post('/my-visits/:id/addons/:addonId/perform', async (req, res) => {
  try {
    const visit = await assignedVisit(req);
    if (!visit) return res.status(403).json({ error: 'This visit is not assigned to you.' });
    if (visit.status === 'completed') {
      return res.status(400).json({ error: 'This visit is completed \u2014 flag add-ons before completing.' });
    }

    const undo = !!(req.body && req.body.undo);
    const techName = (req.profile && req.profile.full_name) || (req.user && req.user.email) || 'tech';

    // The add-on must belong to THIS visit's subscription (IDOR) and be in a
    // flippable state.
    const { data: addon, error: aErr } = await supabaseAdmin
      .from('generator_pending_addons')
      .select('id, status, subscription_id, addon_type, date_performed, performed_by')
      .eq('id', req.params.addonId)
      .eq('subscription_id', visit.subscription_id)
      .maybeSingle();
    if (aErr) throw aErr;
    if (!addon) return res.status(404).json({ error: 'Add-on not found on this customer.' });

    if (!undo && addon.status !== 'pending') {
      return res.status(400).json({ error: `Add-on is ${addon.status}, not pending.` });
    }
    if (undo && addon.status !== 'performed') {
      return res.status(400).json({ error: `Add-on is ${addon.status}, not performed.` });
    }

    const patch = undo
      ? { status: 'pending', date_performed: null, performed_by: null }
      : { status: 'performed', date_performed: new Date().toISOString().slice(0, 10), performed_by: techName };

    const { data: updated, error: uErr } = await supabaseAdmin
      .from('generator_pending_addons')
      .update(patch)
      .eq('id', addon.id)
      .eq('status', addon.status) // no racing past a concurrent office charge
      .select('id, addon_type, status, date_performed, performed_by')
      .maybeSingle();
    if (uErr) throw uErr;
    if (!updated) return res.status(409).json({ error: 'Add-on changed underneath you \u2014 refresh and retry.' });

    res.json({ ok: true, addon: techAddonShape(updated) });
  } catch (err) {
    console.error('[generator-tech] addon perform error:', err && err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================================
// ADD-ONS MENU (Phase 1) — the complete, always-visible menu + on-site
// add/enroll/charge. Every endpoint here is assignedVisit-gated (the IDOR
// boundary); the two money endpoints charge through the SHARED cores in
// lib/gcCharges.js — the exact code path the office uses — and every
// successful tech-initiated charge emails the office (best-effort, never
// blocks or reverses the charge).
// ============================================================================

// Central-time "when it happened" stamp for the office charge email.
function chargeTimeCentral() {
  return fmtCentral(new Date().toISOString());
}

// Best-effort office heads-up for a tech-initiated charge. Fire-and-forget:
// a mail hiccup must NEVER fail (or reverse) a charge that already succeeded.
function notifyOfficeOfTechCharge({ techName, customerName, lineItems, totalCents }) {
  const money = (c) => '$' + ((c || 0) / 100).toFixed(2);
  const itemLines = (lineItems || []).map((li) => `- ${li.label}: ${money(li.amount_cents)}`);
  const text = [
    `${techName} charged ${customerName}'s card on file ${money(totalCents)} on-site (${chargeTimeCentral()}).`,
    '',
    ...itemLines,
    '',
    'The customer gets a Stripe receipt automatically. Full detail is on their card in the Generator Care dashboard.',
  ].join('\n');
  const escapeHtml = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const html = `<div style="font-family:system-ui,sans-serif;font-size:14px;">
    <p>${escapeHtml(techName)} charged <b>${escapeHtml(customerName)}</b>&rsquo;s card on file <b>${money(totalCents)}</b> on-site (${escapeHtml(chargeTimeCentral())}).</p>
    <ul>${(lineItems || []).map((li) => `<li>${escapeHtml(li.label)} &mdash; ${money(li.amount_cents)}</li>`).join('')}</ul>
    <p>The customer gets a Stripe receipt automatically. Full detail is on their card in the Generator Care dashboard.</p>
  </div>`;
  sendEmail({
    to: CHARGE_NOTIFY_TO,
    subject: `[Generator Care] ${techName} charged ${customerName} ${money(totalCents)} on-site`,
    html,
    text,
    logTag: '[tech-charge-email]',
  }).catch((e) => console.error('[tech-charge-email] unexpected:', e && e.message));
}

// GET /api/generator-care/tech/my-visits/:id/addon-menu
// The complete add-on menu for this visit's subscription: every catalog add-on
// that applies to the generator class, with price + derived status
// (not_in_plan | every_visit | this_visit | performed | charged). Built by the
// same lib/addonMenu.js builder the office detail endpoint uses.
// Phase 1.1: the payload is also the CART — it includes this visit's pending
// custom charges and a computed cart total (performed-but-unbilled add-ons +
// pending customs), which is exactly what POST …/charge would bill.
router.get('/my-visits/:id/addon-menu', async (req, res) => {
  try {
    const visit = await assignedVisit(req);
    if (!visit) return res.status(403).json({ error: 'This visit is not assigned to you.' });

    const [{ data: sub, error: subErr }, { data: addons, error: aErr }, customs] = await Promise.all([
      supabaseAdmin
        .from('generator_subscriptions')
        .select('id, gen_class, standing_addons, status')
        .eq('id', visit.subscription_id)
        .single(),
      supabaseAdmin
        .from('generator_pending_addons')
        .select('id, addon_type, status, amount_cents, service_visit_id, date_performed, performed_by')
        .eq('subscription_id', visit.subscription_id)
        .order('created_at', { ascending: true }),
      getVisitCartCharges(visit.subscription_id, visit.id),
    ]);
    if (subErr) throw subErr;
    if (aErr) throw aErr;
    if (!sub) return res.status(404).json({ error: 'Subscription not found.' });

    const openVisitId = await getOpenVisitId(visit.subscription_id);
    const menu = buildAddonMenu({
      genClass: sub.gen_class,
      standingAddons: sub.standing_addons,
      pendingAddons: addons,
      openVisitId,
    });

    // Cart total mirrors chargeVisitCart's scope: THIS visit's performed
    // unbilled add-ons + THIS visit's pending customs.
    const performedCents = (addons || [])
      .filter((a) => a.status === 'performed' && a.service_visit_id === visit.id && a.amount_cents > 0)
      .reduce((s, a) => s + a.amount_cents, 0);
    const customCents = customs.reduce((s, c) => s + c.amount_cents, 0);

    res.json({
      ok: true,
      menu,
      custom_charges: customs.map((c) => ({ id: c.id, description: c.description, amount_cents: c.amount_cents })),
      cart_total_cents: performedCents + customCents,
      subscription_canceled: sub.status === 'canceled',
    });
  } catch (err) {
    console.error('[generator-tech] addon-menu error:', err && err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/generator-care/tech/my-visits/:id/addons
// Body: { addon_type } — add a catalog add-on for THIS visit (a pending row on
// the open cycle at the catalog price). Never charges; billing happens when the
// work is performed and "Charge now" runs.
router.post('/my-visits/:id/addons', async (req, res) => {
  try {
    const visit = await assignedVisit(req);
    if (!visit) return res.status(403).json({ error: 'This visit is not assigned to you.' });
    if (visit.status === 'completed') {
      return res.status(400).json({ error: 'This visit is completed — the office can add add-ons for the next one.' });
    }

    const addonType = req.body && req.body.addon_type;
    if (!addonType || !ADDON_CATALOG[addonType]) {
      return res.status(400).json({ error: 'Unknown add-on.' });
    }

    const { data: sub, error: subErr } = await supabaseAdmin
      .from('generator_subscriptions')
      .select('id, gen_class, status')
      .eq('id', visit.subscription_id)
      .single();
    if (subErr) throw subErr;
    if (!sub) return res.status(404).json({ error: 'Subscription not found.' });
    if (sub.status === 'canceled') {
      return res.status(400).json({ error: 'This subscription is canceled — no add-ons can be added.' });
    }

    const price = lookupAddonPrice(addonType, sub.gen_class);
    if (!price) {
      return res.status(400).json({ error: 'That add-on doesn’t apply to this generator.' });
    }

    // Double-tap / already-selected guard: one uncharged row of a type at a time.
    const { data: existing, error: exErr } = await supabaseAdmin
      .from('generator_pending_addons')
      .select('id, status')
      .eq('subscription_id', visit.subscription_id)
      .eq('addon_type', addonType)
      .in('status', ['pending', 'performed'])
      .limit(1)
      .maybeSingle();
    if (exErr) throw exErr;
    if (existing) return res.status(409).json({ error: 'That add-on is already on this visit.' });

    const serviceVisitId = await getOpenVisitId(visit.subscription_id);
    const { data: inserted, error: insErr } = await supabaseAdmin
      .from('generator_pending_addons')
      .insert({
        subscription_id: visit.subscription_id,
        addon_type: addonType,
        stripe_price_id: price.price_id,
        amount_cents: price.amount_cents,
        status: 'pending',
        service_visit_id: serviceVisitId,
      })
      .select('id, addon_type, status')
      .single();
    if (insErr) throw insErr;

    res.json({ ok: true, addon: { id: inserted.id, addon_type: inserted.addon_type, status: inserted.status } });
  } catch (err) {
    console.error('[generator-tech] add addon error:', err && err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST   /api/generator-care/tech/my-visits/:id/standing/:addon_type — enroll
// DELETE /api/generator-care/tech/my-visits/:id/standing/:addon_type — unenroll
// Every-visit (standing) add-ons: recurring types only. Enrolling updates the
// subscription's standing set AND materializes a pending row on the current
// open visit (via the same generateStandingAddons the cycle roll-forward uses)
// so it can be performed today. Unenrolling removes it from the set and cancels
// a still-PENDING materialized row on the open visit (the tech's symmetric
// undo — performed/charged rows are never touched).
async function setStandingAddon(req, res, enroll) {
  try {
    const visit = await assignedVisit(req);
    if (!visit) return res.status(403).json({ error: 'This visit is not assigned to you.' });
    if (visit.status === 'completed') {
      return res.status(400).json({ error: 'This visit is completed — ask the office to change standing add-ons.' });
    }

    const addonType = req.params.addon_type;
    if (!ADDON_CATALOG[addonType] || !isRecurringAddon(addonType)) {
      return res.status(400).json({ error: 'That add-on can’t be set to every visit.' });
    }

    const { data: sub, error: subErr } = await supabaseAdmin
      .from('generator_subscriptions')
      .select('id, gen_class, status, standing_addons')
      .eq('id', visit.subscription_id)
      .single();
    if (subErr) throw subErr;
    if (!sub) return res.status(404).json({ error: 'Subscription not found.' });
    if (sub.status === 'canceled') {
      return res.status(400).json({ error: 'This subscription is canceled.' });
    }
    if (!lookupAddonPrice(addonType, sub.gen_class)) {
      return res.status(400).json({ error: 'That add-on doesn’t apply to this generator.' });
    }

    // Same clean rules as the office standing-addons PATCH: recurring types
    // valid for the gen class, de-duped.
    const next = new Set((sub.standing_addons || [])
      .filter((t) => isRecurringAddon(t) && lookupAddonPrice(t, sub.gen_class)));
    if (enroll) next.add(addonType); else next.delete(addonType);

    const { error: updErr } = await supabaseAdmin
      .from('generator_subscriptions')
      .update({ standing_addons: Array.from(next) })
      .eq('id', sub.id);
    if (updErr) throw updErr;

    const openVisitId = await getOpenVisitId(sub.id);
    if (enroll && openVisitId) {
      // Materialize on the current cycle so it can be performed today.
      // Idempotent per (visit, type) — a re-tap won't duplicate the row.
      await generateStandingAddons({
        subscriptionId: sub.id,
        genClass: sub.gen_class,
        standingAddons: [addonType],
        serviceVisitId: openVisitId,
      });
    } else if (!enroll && openVisitId) {
      await supabaseAdmin
        .from('generator_pending_addons')
        .update({ status: 'canceled', notes: 'Removed with every-visit unenroll on ' + new Date().toISOString().slice(0, 10) })
        .eq('subscription_id', sub.id)
        .eq('service_visit_id', openVisitId)
        .eq('addon_type', addonType)
        .eq('status', 'pending');
    }

    res.json({ ok: true, standing: enroll });
  } catch (err) {
    console.error('[generator-tech] standing addon error:', err && err.message);
    res.status(500).json({ error: 'Server error' });
  }
}
router.post('/my-visits/:id/standing/:addon_type', (req, res) => setStandingAddon(req, res, true));
router.delete('/my-visits/:id/standing/:addon_type', (req, res) => setStandingAddon(req, res, false));

// POST /api/generator-care/tech/my-visits/:id/custom-charges
// Body: { description, amount_cents } — add a custom LINE ITEM to this visit's
// cart. Phase 1.1: this NEVER hits Stripe — it inserts a pending
// generator_adhoc_charges row (billing_method 'immediate', this visit, the
// tech recorded) that POST …/charge later bills together with the performed
// add-ons on ONE invoice. Any positive amount, no cap — the UI confirm at
// charge time is the safeguard. (The old immediate-charging
// /adhoc-charge route is GONE on purpose: a stale cached PWA calling it gets
// a 404 failure, never a charge it didn't show the tech.)
router.post('/my-visits/:id/custom-charges', async (req, res) => {
  try {
    const visit = await assignedVisit(req);
    if (!visit) return res.status(403).json({ error: 'This visit is not assigned to you.' });

    const { description, amount_cents } = req.body || {};
    if (!description || !String(description).trim()) {
      return res.status(400).json({ error: 'Describe the work so it shows on the customer’s receipt.' });
    }
    if (!Number.isInteger(amount_cents) || amount_cents <= 0) {
      return res.status(400).json({ error: 'Amount must be a positive dollar amount.' });
    }

    const { data: row, error: insErr } = await supabaseAdmin
      .from('generator_adhoc_charges')
      .insert({
        subscription_id: visit.subscription_id,
        service_visit_id: visit.id,
        description: String(description).trim(),
        amount_cents,
        billing_method: 'immediate',
        status: 'pending',
        date_performed: new Date().toISOString().slice(0, 10),
        technician_id: req.user.id,
      })
      .select('id, description, amount_cents')
      .single();
    if (insErr) throw insErr;

    res.json({ ok: true, charge: { id: row.id, description: row.description, amount_cents: row.amount_cents } });
  } catch (err) {
    console.error('[generator-tech] custom-charge add error:', err && err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/generator-care/tech/my-visits/:id/custom-charges/:chargeId
// Remove a still-uncharged cart line. Hard-scoped in the UPDATE itself: this
// visit, status pending, immediate, never on an invoice/PI — charged or
// failed rows (and renewal ad-hoc rows) can never match.
router.delete('/my-visits/:id/custom-charges/:chargeId', async (req, res) => {
  try {
    const visit = await assignedVisit(req);
    if (!visit) return res.status(403).json({ error: 'This visit is not assigned to you.' });

    const { data: removed, error } = await supabaseAdmin
      .from('generator_adhoc_charges')
      .update({ status: 'canceled', notes: 'Removed from the visit cart on ' + new Date().toISOString().slice(0, 10) })
      .eq('id', req.params.chargeId)
      .eq('subscription_id', visit.subscription_id)
      .eq('service_visit_id', visit.id)
      .eq('status', 'pending')
      .eq('billing_method', 'immediate')
      .is('stripe_invoice_item_id', null)
      .is('stripe_payment_intent_id', null)
      .select('id')
      .maybeSingle();
    if (error) throw error;
    if (!removed) return res.status(404).json({ error: 'That line isn’t removable (already charged, or not on this visit).' });

    res.json({ ok: true });
  } catch (err) {
    console.error('[generator-tech] custom-charge delete error:', err && err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/generator-care/tech/my-visits/:id/charge
// Charge the whole visit cart — THIS visit's performed-but-unbilled catalog
// add-ons + its pending custom lines — in ONE invoice -> one payment -> one
// itemized receipt, via the shared chargeVisitCart core. Replaces the
// Phase-1 per-group charge buttons. A successful charge emails the office
// with every line + the total.
router.post('/my-visits/:id/charge', async (req, res) => {
  try {
    const visit = await assignedVisit(req);
    if (!visit) return res.status(403).json({ error: 'This visit is not assigned to you.' });

    const techName = (req.profile && req.profile.full_name) || (req.user && req.user.email) || 'tech';
    const result = await chargeVisitCart({
      subscriptionId: visit.subscription_id,
      serviceVisitId: visit.id,
    });

    if (!result.ok) {
      // Curated failure shape: no Stripe/internal ids in tech-facing JSON.
      return res.status(result.status).json({
        error: result.error,
        reason: result.reason || null,
        card_update_email_sent: !!result.cardUpdateEmailSent,
      });
    }

    notifyOfficeOfTechCharge({
      techName,
      customerName: result.customerName,
      lineItems: result.lineItems,
      totalCents: result.totalCents,
    });

    // No invoice/Stripe ids in the tech-facing response.
    res.json({
      ok: true,
      total_cents: result.totalCents,
      charged_addon_count: result.chargedAddonCount,
      charged_custom_count: result.chargedCustomCount,
    });
  } catch (err) {
    console.error('[generator-tech] cart charge error:', err && err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================================
// GROWTH ENGINE WP6 — field enrollment: a tech on any job enrolls a generator
// customer on the spot. Creates a `field`-source lead attributed to the tech
// and returns the pre-tagged ?lead= signup URL, which the tech shows as a QR
// the customer scans on their own phone. The signup site forwards the lead id
// into Stripe metadata (WP2) and the webhook auto-converts the lead on signup
// — no new attribution logic here.
//
// Tech-gated by the router.use above; no requirePermission flag, same basis
// as the office leads routes: creates a prospect row and hands out a PUBLIC
// signup URL — no money moves, no Stripe object is created, no existing
// customer's data is touched. (The office scan in check-gc-permissions only
// reads routes/generator-care/*; this route is noted in its ALLOWLIST comment.)
// ============================================================================

// Contact/detail fields a tech can capture in the driveway — a subset of the
// office EDITABLE_FIELDS (routes/generator-care/leads.js). maintenance_month
// stays null on purpose: field leads aren't part of the monthly campaign cohort.
const ENROLL_FIELDS = [
  'customer_name', 'customer_phone', 'customer_email',
  'install_address', 'install_city', 'install_state', 'install_zip',
  'generator_info',
];

// POST /api/generator-care/tech/enroll
// Body: { customer_name?, customer_phone?, customer_email?,
//         install_address/city/state/zip?, generator_info?, send_email? }.
// EVERY customer field is optional (WP6.1): the customer re-enters their
// details at signup anyway, so capture only exists for follow-up if they
// DON'T sign up on the spot. An empty enroll is a valid `field` lead — it
// converts with real data on signup, and the office can delete an empty
// non-converted one. (Deliberately looser than the office POST /leads,
// which requires name/email/phone — that row is worked by hand; this one's
// ?lead= URL is usually consumed within minutes.)
// Returns { ok, lead_id, signup_url, emailed, email_error }. With
// send_email:true (and an email on file) the existing FL-aware signup-link
// email goes out too; a failed send still returns the URL — the QR is the
// headline and must never be blocked on a mail hiccup.
router.post('/enroll', async (req, res) => {
  try {
    const body = req.body || {};
    const row = { source: 'field', status: 'new' };
    for (const f of ENROLL_FIELDS) {
      const v = typeof body[f] === 'string' ? body[f].trim() : '';
      if (v) row[f] = v; // trimmed empties -> column stays null
    }
    if (row.customer_email && !EMAIL_RE.test(row.customer_email)) {
      return res.status(400).json({ error: 'That email address doesn\u2019t look right.' });
    }

    // Attribution: the machine link is the tech's profile id; the label is
    // what the office lead card shows, so provenance survives even if the
    // profile is later deactivated.
    row.referred_by_user_id = req.user.id;
    row.referred_by_label =
      (req.profile && req.profile.full_name)
      || (req.user.email ? req.user.email.split('@')[0] : 'tech');

    const { data: lead, error } = await supabaseAdmin
      .from('generator_leads')
      .insert(row)
      .select('id')
      .single();
    if (error) throw error;

    const signupUrl = `${SIGNUP_BASE_URL}/?lead=${lead.id}`;

    // Optional send — reuses the office's signup-link email (FL-aware via the
    // captured install state). Failure is reported but never blocks the QR.
    let emailed = false;
    let emailError = null;
    if (body.send_email && row.customer_email) {
      try {
        const { subject, html, text } = buildSignupLinkEmail({
          name: row.customer_name,
          signupUrl,
          companyState: row.install_state,
        });
        const result = await sendEmail({
          to: row.customer_email,
          subject,
          html,
          text,
          logTag: '[tech-enroll-signup-email]',
          companyState: row.install_state,
        });
        emailed = !!(result && result.sent);
        if (!emailed) throw new Error(`signup-link email send failed for lead ${lead.id} to ${row.customer_email}: ${(result && result.reason) || 'unknown'}`);
      } catch (mailErr) {
        emailError = 'The email didn\u2019t send \u2014 have them scan the QR instead.';
        reportError(mailErr, { route: req.originalUrl, method: req.method, user: req.user && req.user.email }).catch(() => {});
      }
      // A CONFIRMED send is an invite like the office's — advance to
      // signup_sent and stamp invited_at, the "Needs follow-up" clock (the
      // WP4.2 invariant: every signup_sent writer stamps it). QR-only or a
      // failed send leaves the lead `new` so the office pipeline shows it
      // untouched.
      if (emailed) {
        const now = new Date().toISOString();
        const { error: updErr } = await supabaseAdmin
          .from('generator_leads')
          .update({ status: 'signup_sent', invited_at: now, updated_at: now })
          .eq('id', lead.id);
        if (updErr) {
          // The email went out; a failed stamp must not fail the enrollment.
          console.error('[generator-tech] enroll advance error:', updErr.message);
          reportError(updErr, { route: req.originalUrl, method: req.method, user: req.user && req.user.email }).catch(() => {});
        }
      }
    }

    res.json({ ok: true, lead_id: lead.id, signup_url: signupUrl, emailed, email_error: emailError });
  } catch (err) {
    console.error('[generator-tech] enroll error:', err && err.message);
    reportError(err, { route: req.originalUrl, method: req.method, user: req.user && req.user.email }).catch(() => {});
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
