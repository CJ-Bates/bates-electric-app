const express = require('express');
const archiver = require('archiver');
const { sendViaBrevo } = require('../lib/mailer');
const { supabaseForUser, supabaseAdmin } = require('../lib/supabase');
const { requireAuth } = require('../middleware/auth');
const { buildInspectionPdf } = require('../lib/buildPdf');
const { SECTIONS, UPSELL_ITEMS, JOB_FIELDS } = require('../lib/inspectionFields');

const PHOTOS_BUCKET = 'inspection-photos';
const PDF_SIGNED_URL_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

const router = express.Router();

// Inspection report emails go out via Brevo. The From must be on a Brevo-
// authenticated domain (bates-electric.com), so we use no-reply@bates-electric.com
// rather than the old @gmail.com sender (Gmail's DMARC would reject that via Brevo).
const emailFrom = process.env.INSPECTION_FROM_EMAIL || 'no-reply@bates-electric.com';

// Pulls the indexed columns out of the form blob so the office dashboard
// can filter fast. Everything else stays in `data`.
function extractIndexed(data) {
  const d = data || {};
  return {
    job_date: d.job_date || null,
    job_number: d.job_num || null,
    customer_name: d.job_cust || null,
    customer_email: d.job_email || null,
  };
}

// The four data keys extractIndexed() denormalizes into real columns — these
// must be strings (when present) and reasonably short, or the row is rejected.
const INDEXED_KEYS = ['job_date', 'job_num', 'job_cust', 'job_email'];
const INDEXED_MAX_LEN = 300;

// Light shape validation for the JSONB form blob. The express.json 1mb limit
// (see server.js) is the real size cap; this checks key sanity: `data` must be
// a plain object whose top-level values are JSON scalars, arrays, or plain
// objects, and the indexed fields must be strings capped at 300 chars.
// Returns an error message, or null when the payload is acceptable.
function validateInspectionData(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return 'Form data must be an object.';
  }
  for (const [key, value] of Object.entries(data)) {
    const t = typeof value;
    const ok =
      value === null ||
      t === 'string' || t === 'number' || t === 'boolean' ||
      Array.isArray(value) ||
      (t === 'object' && Object.getPrototypeOf(value) === Object.prototype);
    if (!ok) return `Form field "${key}" has an unsupported value type.`;
  }
  for (const key of INDEXED_KEYS) {
    const value = data[key];
    if (value == null) continue;
    if (typeof value !== 'string') return `Form field "${key}" must be a string.`;
    if (value.length > INDEXED_MAX_LEN) return `Form field "${key}" is too long (max ${INDEXED_MAX_LEN} characters).`;
  }
  return null;
}

// POST /inspections  { data: {...}, status?: 'draft' | 'submitted' }
router.post('/', requireAuth, async (req, res) => {
  const { data, status } = req.body || {};
  if (!data || typeof data !== 'object') {
    return res.status(400).json({ error: 'Missing form data' });
  }
  const dataErr = validateInspectionData(data);
  if (dataErr) {
    return res.status(400).json({ error: dataErr });
  }
  if (status !== undefined && status !== 'draft' && status !== 'submitted') {
    return res.status(400).json({ error: "status must be 'draft' or 'submitted'." });
  }

  const client = supabaseForUser(req.token);
  const row = {
    technician_id: req.user.id,
    status: status === 'draft' ? 'draft' : 'submitted',
    data,
    ...extractIndexed(data),
  };

  const { data: inserted, error } = await client
    .from('inspections')
    .insert(row)
    .select()
    .single();

  if (error) {
    console.error('inspection insert failed', error);
    return res.status(500).json({ error: error.message });
  }

  // Generate the PDF, upload it to storage, and email it (best-effort).
  let pdfSignedUrl = null;
  if (row.status === 'submitted') {
    pdfSignedUrl = await generateAndStorePdf(inserted.id, data).catch((err) => {
      console.error('PDF generation/upload failed:', err);
      return null;
    });
  }

  if (row.status === 'submitted' && process.env.BREVO_API_KEY) {
    try {
      const emailBody = buildEmailHTML(data, pdfSignedUrl);
      const custEmail = data.job_email || '';
      const custName = data.job_cust || 'Customer';
      const date = data.job_date || new Date().toLocaleDateString();
      const officeRecipients = (process.env.OFFICE_EMAIL || 'amyp@bates-electric.com,cjbates@bates-electric.com')
        .split(',').map(s => s.trim()).filter(Boolean);

      const toAddresses = [...officeRecipients];
      if (custEmail && custEmail.trim()) {
        toAddresses.push(custEmail.trim());
      }

      const sendResult = await sendViaBrevo({
        to: toAddresses,
        senderEmail: emailFrom,
        senderName: 'Bates Electric',
        subject: `Bates Electric Safety Inspection — ${custName} — ${date}`,
        html: emailBody,
      });
      if (sendResult.sent) {
        console.log('Email sent successfully for inspection', inserted.id, '| to:', toAddresses.join(', '));
      } else {
        console.error('Failed to send inspection email:', sendResult.reason);
      }
    } catch (emailErr) {
      console.error('Failed to send email:', emailErr && emailErr.message);
      // Don't fail the API response if email fails — the inspection was still created
    }
  }

  res.status(201).json({ inspection: inserted, pdfUrl: pdfSignedUrl });
});

// Photos now live under `${inspectionId}/${sectionKey}/...`. `report.pdf` is
// still at the top level. Supabase `.list(prefix)` only returns one level, so
// we recurse one step into each subfolder. Returns relative paths (i.e. without
// the inspectionId prefix), e.g. `mp/123-0-foo.jpg` or `legacy.jpg`.
async function listAllPhotoPaths(inspectionId) {
  const { data: top, error: topErr } = await supabaseAdmin
    .storage
    .from(PHOTOS_BUCKET)
    .list(inspectionId, { limit: 1000 });
  if (topErr) throw topErr;

  const out = [];
  for (const entry of top || []) {
    if (entry.name === 'report.pdf') continue;
    // Files have a non-null id; "folders" have id === null.
    if (entry.id) {
      out.push(entry.name);
      continue;
    }
    const { data: sub, error: subErr } = await supabaseAdmin
      .storage
      .from(PHOTOS_BUCKET)
      .list(`${inspectionId}/${entry.name}`, { limit: 1000 });
    if (subErr) {
      console.warn('subfolder list failed', entry.name, subErr);
      continue;
    }
    for (const file of sub || []) {
      if (!file.id) continue;
      out.push(`${entry.name}/${file.name}`);
    }
  }
  return out;
}

async function generateAndStorePdf(inspectionId, data) {
  const buffer = await buildInspectionPdf(data);
  const path = `${inspectionId}/report.pdf`;

  const { error: uploadErr } = await supabaseAdmin
    .storage
    .from(PHOTOS_BUCKET)
    .upload(path, buffer, {
      contentType: 'application/pdf',
      upsert: true,
    });
  if (uploadErr) throw uploadErr;

  const { data: signed, error: signErr } = await supabaseAdmin
    .storage
    .from(PHOTOS_BUCKET)
    .createSignedUrl(path, PDF_SIGNED_URL_TTL_SECONDS);
  if (signErr) throw signErr;

  return signed.signedUrl;
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function rowHtml(label, value) {
  return `<tr>
    <td style="padding: 6px; border: 1px solid #ddd;"><strong>${escapeHtml(label)}:</strong></td>
    <td style="padding: 6px; border: 1px solid #ddd;">${escapeHtml(value || '')}</td>
  </tr>`;
}

function buildEmailHTML(data, pdfUrl) {
  const d = data || {};

  let html = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
<h2 style="color: #0B2545; border-bottom: 3px solid #F5B700; padding-bottom: 10px;">Bates Electric &mdash; Electrical Safety Inspection</h2>`;

  if (pdfUrl) {
    html += `
<p style="margin: 16px 0;">
  <a href="${escapeHtml(pdfUrl)}"
     style="background:#0B2545;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:bold;display:inline-block;">
    Download PDF Report
  </a>
  <span style="color:#666;font-size:12px;margin-left:8px;">(link valid 30 days)</span>
</p>`;
  }

  html += `<h3 style="color: #0B2545; margin-top: 20px;">Job Information</h3>
<table style="width: 100%; border-collapse: collapse;">`;
  for (const [label, key] of JOB_FIELDS) {
    html += rowHtml(label, d[key]);
  }
  html += `</table>`;

  for (const [title, fields] of SECTIONS) {
    const present = fields.filter(([, k]) => d[k]);
    if (present.length === 0) continue;
    html += `<h3 style="color: #0B2545; margin-top: 20px;">${escapeHtml(title)}</h3>
<table style="width: 100%; border-collapse: collapse;">`;
    for (const [label, k] of present) {
      html += rowHtml(label, d[k]);
    }
    html += `</table>`;
  }

  // Newer drafts store the label string per checkbox; older drafts stored
  // `true`. Fall back to the canonical label when we see the legacy shape.
  const checked = UPSELL_ITEMS
    .map(([n, label]) => {
      const v = d[n];
      if (!v) return null;
      return typeof v === 'string' ? v : label;
    })
    .filter(Boolean);
  if (checked.length || d.up_other) {
    html += `<h3 style="color: #0B2545; margin-top: 20px;">Recommended Services</h3>`;
    if (checked.length) html += `<p>${escapeHtml(checked.join(', '))}</p>`;
    if (d.up_other) html += `<p><strong>Other:</strong> ${escapeHtml(d.up_other)}</p>`;
  }

  if (d.insp_notes) {
    html += `<h3 style="color: #0B2545; margin-top: 20px;">Notes</h3>
<p>${escapeHtml(d.insp_notes).replace(/\n/g, '<br>')}</p>`;
  }

  html += `<h3 style="color: #0B2545; margin-top: 20px;">Signatures</h3>
<table style="width: 100%; border-collapse: collapse;">
${rowHtml('Technician Name', d.sig_tech_name)}
${rowHtml('Date', d.sig_date)}
${rowHtml('Customer Name', d.sig_cust_name)}
</table>`;

  html += `</body></html>`;
  return html;
}

// GET /inspections?limit=50&status=submitted
// RLS handles who sees what: techs only see their own; office sees all.
router.get('/', requireAuth, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const status = req.query.status;

  const client = supabaseForUser(req.token);
  let q = client
    .from('inspections')
    .select('id, technician_id, job_date, job_number, customer_name, customer_email, status, created_at, updated_at')
    .order('created_at', { ascending: false })
    .limit(limit);

  if (status === 'draft' || status === 'submitted') {
    q = q.eq('status', status);
  }

  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });

  // Resolve technician_id -> display name so the dashboard doesn't show raw
  // UUIDs. Admin client is fine here: it only reads names for rows RLS already
  // released to this caller; it grants no extra row visibility.
  const inspections = data || [];
  const techIds = [...new Set(inspections.map((i) => i.technician_id).filter(Boolean))];
  if (techIds.length) {
    const { data: profiles, error: profErr } = await supabaseAdmin
      .from('profiles')
      .select('id, full_name, email')
      .in('id', techIds);
    if (profErr) {
      console.warn('technician name lookup failed:', profErr.message);
    } else {
      const nameById = new Map((profiles || []).map((p) => [p.id, p.full_name || p.email || null]));
      for (const insp of inspections) {
        insp.technician_name = nameById.get(insp.technician_id) || null;
      }
    }
  }

  res.json({ inspections });
});

// GET /inspections/:id/files
// Returns signed URLs for the report PDF and every photo in the bucket.
// Regenerates the PDF on the fly if it's missing (covers older inspections).
router.get('/:id/files', requireAuth, async (req, res) => {
  const inspectionId = req.params.id;

  // Verify caller can read this inspection (RLS does the work).
  const userClient = supabaseForUser(req.token);
  const { data: inspection, error: readErr } = await userClient
    .from('inspections')
    .select('id, data')
    .eq('id', inspectionId)
    .single();
  if (readErr || !inspection) {
    return res.status(404).json({ error: 'Not found' });
  }

  try {
    // Check whether the PDF is at the top level.
    const { data: topLevel, error: topErr } = await supabaseAdmin
      .storage
      .from(PHOTOS_BUCKET)
      .list(inspectionId, { limit: 1000 });
    if (topErr) throw topErr;

    const pdfExists = (topLevel || []).some((o) => o.name === 'report.pdf' && o.id);

    // Fall back to regenerating the PDF if it's missing.
    if (!pdfExists) {
      const buffer = await buildInspectionPdf(inspection.data || {});
      const { error: uploadErr } = await supabaseAdmin
        .storage
        .from(PHOTOS_BUCKET)
        .upload(`${inspectionId}/report.pdf`, buffer, {
          contentType: 'application/pdf',
          upsert: true,
        });
      if (uploadErr) throw uploadErr;
    }

    const photoRelPaths = await listAllPhotoPaths(inspectionId);

    const pdfPath = `${inspectionId}/report.pdf`;
    const { data: pdfSigned, error: pdfSignErr } = await supabaseAdmin
      .storage
      .from(PHOTOS_BUCKET)
      .createSignedUrl(pdfPath, PDF_SIGNED_URL_TTL_SECONDS);
    if (pdfSignErr) throw pdfSignErr;

    const photos = [];
    for (const rel of photoRelPaths) {
      const path = `${inspectionId}/${rel}`;
      const { data: signed, error: signErr } = await supabaseAdmin
        .storage
        .from(PHOTOS_BUCKET)
        .createSignedUrl(path, PDF_SIGNED_URL_TTL_SECONDS);
      if (signErr) continue;
      photos.push({ name: rel, url: signed.signedUrl });
    }

    res.json({ pdfUrl: pdfSigned.signedUrl, photos });
  } catch (err) {
    console.error('files endpoint failed', err);
    res.status(500).json({ error: err.message || 'Failed to gather files' });
  }
});

// GET /inspections/:id/photos.zip  — streams a zip of all photos.
router.get('/:id/photos.zip', requireAuth, async (req, res) => {
  const inspectionId = req.params.id;

  const userClient = supabaseForUser(req.token);
  const { data: inspection, error: readErr } = await userClient
    .from('inspections')
    .select('id, customer_name, job_number')
    .eq('id', inspectionId)
    .single();
  if (readErr || !inspection) {
    return res.status(404).json({ error: 'Not found' });
  }

  try {
    const photoRelPaths = await listAllPhotoPaths(inspectionId);

    if (photoRelPaths.length === 0) {
      return res.status(404).json({ error: 'No photos for this inspection' });
    }

    const safeName = (s) => String(s || 'photos').replace(/[^A-Za-z0-9._-]+/g, '_');
    const zipName = `${safeName(inspection.job_number || inspection.customer_name || inspectionId)}-photos.zip`;

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${zipName}"`);

    const archive = archiver('zip', { zlib: { level: 6 } });
    archive.on('warning', (e) => console.warn('zip warning', e));
    archive.on('error', (e) => {
      console.error('zip error', e);
      try { res.status(500).end(); } catch (_) {}
    });
    archive.pipe(res);

    for (const rel of photoRelPaths) {
      const path = `${inspectionId}/${rel}`;
      const { data: blob, error: dlErr } = await supabaseAdmin
        .storage
        .from(PHOTOS_BUCKET)
        .download(path);
      if (dlErr || !blob) {
        console.warn('skip photo, download failed', path, dlErr);
        continue;
      }
      const arrayBuf = await blob.arrayBuffer();
      archive.append(Buffer.from(arrayBuf), { name: rel });
    }

    await archive.finalize();
  } catch (err) {
    console.error('zip endpoint failed', err);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message || 'Failed to build zip' });
    } else {
      try { res.end(); } catch (_) {}
    }
  }
});

// GET /inspections/:id  — full row including the JSONB data blob
router.get('/:id', requireAuth, async (req, res) => {
  const client = supabaseForUser(req.token);
  const { data, error } = await client
    .from('inspections')
    .select('*')
    .eq('id', req.params.id)
    .single();

  if (error) {
    if (error.code === 'PGRST116') return res.status(404).json({ error: 'Not found' });
    return res.status(500).json({ error: error.message });
  }
  res.json({ inspection: data });
});

// PATCH /inspections/:id  { data?, status? } — for autosave of drafts
router.patch('/:id', requireAuth, async (req, res) => {
  const patch = {};
  if (req.body?.data !== undefined) {
    const dataErr = validateInspectionData(req.body.data);
    if (dataErr) {
      return res.status(400).json({ error: dataErr });
    }
    patch.data = req.body.data;
    Object.assign(patch, extractIndexed(req.body.data));
  }
  if (req.body?.status === 'draft' || req.body?.status === 'submitted') {
    patch.status = req.body.status;
  }
  if (Object.keys(patch).length === 0) {
    return res.status(400).json({ error: 'Nothing to update' });
  }

  const client = supabaseForUser(req.token);
  const { data, error } = await client
    .from('inspections')
    .update(patch)
    .eq('id', req.params.id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: error.message });
  res.json({ inspection: data });
});

// DELETE /inspections/:id  — office only
router.delete('/:id', requireAuth, async (req, res) => {
  const client = supabaseForUser(req.token);
  const { error } = await client
    .from('inspections')
    .delete()
    .eq('id', req.params.id);

  if (error) {
    if (error.code === 'PGRST116') return res.status(404).json({ error: 'Not found' });
    return res.status(500).json({ error: error.message });
  }
  res.json({ ok: true });
});

module.exports = router;
