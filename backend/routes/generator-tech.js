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
const { requirePermission } = require('../middleware/permissions');
const { completeServiceVisit } = require('../lib/completeVisit');
const { scheduleServiceVisit } = require('../lib/scheduleVisit');
const { sendEmail, buildSignupLinkEmail } = require('../lib/emails');
const { ADDON_CATALOG, arrivalWindow, arrivalWindowLabel } = require('../lib/generator-catalog');
const { reportError } = require('../middleware/error-reporter');

const router = express.Router();

// Internal notifications (tech reschedules) go to the office role mailbox —
// same recipient convention as the daily digest cron.
const OFFICE_NOTIFY_TO = (process.env.GENERATOR_DIGEST_TO || 'cjbates@bates-electric.com,generators@bates-electric.com')
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
// Body: { customer_name (required), customer_phone?, customer_email?,
//         install_address/city/state/zip?, generator_info?, send_email? }.
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
    if (!row.customer_name) {
      return res.status(400).json({ error: 'Customer name is required.' });
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
