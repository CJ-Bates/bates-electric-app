const express = require('express');
const archiver = require('archiver');
const { supabaseForUser, supabaseAdmin } = require('../lib/supabase');
const { requireAuth } = require('../middleware/auth');
const { Resend } = require('resend');
const { buildInspectionPdf } = require('../lib/buildPdf');
const { SECTIONS, UPSELL_NAMES, JOB_FIELDS } = require('../lib/inspectionFields');

const PHOTOS_BUCKET = 'inspection-photos';
const PDF_SIGNED_URL_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

const router = express.Router();

// Initialize Resend email service
const resendApiKey = process.env.RESEND_API_KEY;
const resend = resendApiKey ? new Resend(resendApiKey) : null;

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

// POST /inspections  { data: {...}, status?: 'draft' | 'submitted' }
router.post('/', requireAuth, async (req, res) => {
  const { data, status } = req.body || {};
  if (!data || typeof data !== 'object') {
    return res.status(400).json({ error: 'Missing form data' });
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

  if (row.status === 'submitted' && resend) {
    try {
      const emailBody = buildEmailHTML(data, pdfSignedUrl);
      const custEmail = data.job_email || '';
      const custName = data.job_cust || 'Customer';
      const date = data.job_date || new Date().toLocaleDateString();
      const officeEmail = process.env.OFFICE_EMAIL || 'office@bates-electric.com';
      const fromEmail = process.env.EMAIL_FROM || 'noreply@bates-electric.com';

      const toAddresses = [officeEmail];
      if (custEmail && custEmail.trim()) {
        toAddresses.push(custEmail);
      }

      await resend.emails.send({
        from: fromEmail,
        to: toAddresses,
        subject: `Bates Electric Safety Inspection — ${custName} — ${date}`,
        html: emailBody,
      });

      console.log('Email sent successfully for inspection', inserted.id);
    } catch (emailErr) {
      console.error('Failed to send email:', emailErr);
      // Don't fail the API response if email fails — the inspection was still created
    }
  }

  res.status(201).json({ inspection: inserted, pdfUrl: pdfSignedUrl });
});

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

  const checked = UPSELL_NAMES.map((n) => d[n]).filter(Boolean);
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
  res.json({ inspections: data });
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
    // List everything in the inspection's folder.
    const { data: objects, error: listErr } = await supabaseAdmin
      .storage
      .from(PHOTOS_BUCKET)
      .list(inspectionId, { limit: 1000 });
    if (listErr) throw listErr;

    const allNames = (objects || []).map((o) => o.name);
    const pdfExists = allNames.includes('report.pdf');

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

    const photoNames = allNames.filter((n) => n !== 'report.pdf');

    const pdfPath = `${inspectionId}/report.pdf`;
    const { data: pdfSigned, error: pdfSignErr } = await supabaseAdmin
      .storage
      .from(PHOTOS_BUCKET)
      .createSignedUrl(pdfPath, PDF_SIGNED_URL_TTL_SECONDS);
    if (pdfSignErr) throw pdfSignErr;

    const photos = [];
    for (const name of photoNames) {
      const path = `${inspectionId}/${name}`;
      const { data: signed, error: signErr } = await supabaseAdmin
        .storage
        .from(PHOTOS_BUCKET)
        .createSignedUrl(path, PDF_SIGNED_URL_TTL_SECONDS);
      if (signErr) continue;
      photos.push({ name, url: signed.signedUrl });
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
    const { data: objects, error: listErr } = await supabaseAdmin
      .storage
      .from(PHOTOS_BUCKET)
      .list(inspectionId, { limit: 1000 });
    if (listErr) throw listErr;

    const photoNames = (objects || [])
      .map((o) => o.name)
      .filter((n) => n !== 'report.pdf');

    if (photoNames.length === 0) {
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

    for (const name of photoNames) {
      const path = `${inspectionId}/${name}`;
      const { data: blob, error: dlErr } = await supabaseAdmin
        .storage
        .from(PHOTOS_BUCKET)
        .download(path);
      if (dlErr || !blob) {
        console.warn('skip photo, download failed', path, dlErr);
        continue;
      }
      const arrayBuf = await blob.arrayBuffer();
      archive.append(Buffer.from(arrayBuf), { name });
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
  if (req.body?.data && typeof req.body.data === 'object') {
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
