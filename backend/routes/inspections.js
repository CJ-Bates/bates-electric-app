const express = require('express');
const { supabaseForUser } = require('../lib/supabase');
const { requireAuth } = require('../middleware/auth');
const { Resend } = require('resend');

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

  // Send email if submitted and Resend is configured
  if (status === 'submitted' && resend) {
    try {
      const emailBody = buildEmailHTML(data);
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

  res.status(201).json({ inspection: inserted });
});

function buildEmailHTML(data) {
  const d = data || {};
  const date = d.job_date || new Date().toLocaleDateString();
  const techName = d.job_tech || 'Tech';
  const custName = d.job_cust || 'Customer';
  const custEmail = d.job_email || '';

  let html = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
<h2 style="color: #0B2545; border-bottom: 3px solid #F5B700; padding-bottom: 10px;">Bates Electric &mdash; Electrical Safety Inspection</h2>

<h3 style="color: #0B2545; margin-top: 20px;">Job Information</h3>
<table style="width: 100%; border-collapse: collapse;">
<tr><td style="padding: 6px; border: 1px solid #ddd;"><strong>Date:</strong></td><td style="padding: 6px; border: 1px solid #ddd;">${date}</td></tr>
<tr><td style="padding: 6px; border: 1px solid #ddd;"><strong>Job #:</strong></td><td style="padding: 6px; border: 1px solid #ddd;">${d.job_num || ''}</td></tr>
<tr><td style="padding: 6px; border: 1px solid #ddd;"><strong>Invoice #:</strong></td><td style="padding: 6px; border: 1px solid #ddd;">${d.job_inv || ''}</td></tr>
<tr><td style="padding: 6px; border: 1px solid #ddd;"><strong>Technician:</strong></td><td style="padding: 6px; border: 1px solid #ddd;">${techName}</td></tr>
<tr><td style="padding: 6px; border: 1px solid #ddd;"><strong>Customer:</strong></td><td style="padding: 6px; border: 1px solid #ddd;">${custName}</td></tr>
<tr><td style="padding: 6px; border: 1px solid #ddd;"><strong>Address:</strong></td><td style="padding: 6px; border: 1px solid #ddd;">${d.job_addr || ''}</td></tr>
<tr><td style="padding: 6px; border: 1px solid #ddd;"><strong>Email:</strong></td><td style="padding: 6px; border: 1px solid #ddd;">${custEmail}</td></tr>
<tr><td style="padding: 6px; border: 1px solid #ddd;"><strong>Year Built:</strong></td><td style="padding: 6px; border: 1px solid #ddd;">${d.job_yr || ''}</td></tr>
<tr><td style="padding: 6px; border: 1px solid #ddd;"><strong>Property Type:</strong></td><td style="padding: 6px; border: 1px solid #ddd;">${d.job_type || ''}</td></tr>
<tr><td style="padding: 6px; border: 1px solid #ddd;"><strong># Photos:</strong></td><td style="padding: 6px; border: 1px solid #ddd;">${d.job_photos || ''}</td></tr>
</table>
    `;

  // Helper to add section
  const addSection = (title, fields) => {
    html += `<h3 style="color: #0B2545; margin-top: 20px;">${title}</h3>
<table style="width: 100%; border-collapse: collapse;">`;
    fields.forEach(([label, key]) => {
      const val = d[key];
      if (val) {
        html += `<tr><td style="padding: 6px; border: 1px solid #ddd;"><strong>${label}:</strong></td><td style="padding: 6px; border: 1px solid #ddd;">${val}</td></tr>`;
      }
    });
    html += `</table>`;
  };

  // Main panels
  const mpFields = [
    ['Manufacturer', 'mp_mfr'], ['Voltage', 'mp_volt'], ['Amps', 'mp_amps'],
    ['Phase', 'mp_phase'], ['Age', 'mp_age'], ['Obsolete', 'mp_obs'],
    ['UL Listed', 'mp_ul'], ['Breakers sized', 'mp_sized'], ['Main breaker protected', 'mp_main_breaker'],
    ['Main breaker sized', 'mp_main_sized'], ['GFCI working', 'mp_gfci'], ['AFCI working', 'mp_afci'],
    ['Burning/corrosion', 'mp_burn'], ['Connections tight', 'mp_tight'], ['Wire type', 'mp_wiretype'],
    ['Grounding correct', 'mp_ground'], ['Surge device', 'mp_surge'], ['Clamps/bushings', 'mp_clamps'],
    ['Panel labeled', 'mp_labeled'], ['Knockouts sealed', 'mp_knockouts'], ['Bonded', 'mp_bonded'],
    ['Heat', 'mp_heat'], ['Corrosion', 'mp_corr'], ['Water/rust', 'mp_rust'],
    ['Double taps', 'mp_dbl_tap'], ['Surge protector', 'mp_surge2'], ['Breakers for wire', 'mp_wire_size'],
    ['Condition', 'mp_cond'], ['Exposed wires', 'mp_exposed'], ['Entries protected', 'mp_entries'],
    ['Overall rating', 'mp_rating']
  ];
  addSection('Main Electrical Panel', mpFields);

  const spFields = mpFields.map(([l, k]) => [l, k.replace('mp_', 'sp_')]);
  addSection('Secondary / Sub Panel', spFields);

  const svcFields = [
    ['Ampere Rating', 'svc_amps'], ['Phase', 'svc_phase'], ['Age', 'svc_age'],
    ['Riser Type', 'svc_riser'], ['POA Condition', 'svc_poa'],
    ['Entry', 'svc_entry'], ['Location', 'svc_loc'],
    ['Disconnect switch', 'svc_q01'], ['Eyebolt', 'svc_q02'], ['Weatherhead', 'svc_q03'],
    ['Flashing', 'svc_q04'], ['Utility connections', 'svc_q05'], ['Trees on wires', 'svc_q06'],
    ['Grounding', 'svc_q07'], ['Drip loop', 'svc_q08'], ['Components secured', 'svc_q09'],
    ['Meter/Service', 'svc_q10'], ['Entrance cable', 'svc_q11'], ['Overall rating', 'svc_rating']
  ];
  addSection('Main Electrical Service', svcFields);

  const gwFields = [
    ['GFCI in required', 'gw_q01'], ['Outside GFCI', 'gw_q02'], ['Bubble covers', 'gw_q03'],
    ['Outside wiring', 'gw_q04'], ['Open splices', 'gw_q05'], ['Stab wired', 'gw_q06'],
    ['Extension cords', 'gw_q07'], ['Outlets', 'gw_q08'], ['GFCI coverage', 'gw_q09'],
    ['AFCI coverage', 'gw_q10'], ['Fixtures', 'gw_q11'], ['Exhaust fans', 'gw_q12'],
    ['Charging stations', 'gw_q13'], ['Colors noted', 'gw_colors'], ['Overall rating', 'gw_rating']
  ];
  addSection('General Wiring', gwFields);

  const smFields = [
    ['Tested/working', 'sm_q01'], ['In required areas', 'sm_q02'], ['Hardwired/interconnected', 'sm_q03'],
    ['CO alarms', 'sm_q04'], ['Doorbell', 'sm_q05'], ['Detector age', 'sm_age'], ['Overall rating', 'sm_rating']
  ];
  addSection('Smoke & CO Alarms', smFields);

  const acFields = [
    ['Wiring correct', 'ac_q01'], ['Count', 'ac_count'], ['Improper methods', 'ac_q03'], ['Overall rating', 'ac_rating']
  ];
  addSection('Attic & Crawlspace', acFields);

  const hvFields = [
    ['AC Min', 'hv_min'], ['AC Max', 'hv_max'],
    ['AC breaker correct', 'hv_q01'], ['AC disconnect', 'hv_q02'], ['Furnace wiring', 'hv_q03'],
    ['Furnace disconnect', 'hv_q04'], ['Aluminum wiring', 'hv_q05'], ['Aluminum terminated', 'hv_q06'],
    ['A/C condition', 'hv_q07'], ['Furnace condition', 'hv_q08'], ['Overall rating', 'hv_rating']
  ];
  addSection('Furnace & A/C Wiring', hvFields);

  // Recommended services
  const checked = [];
  const upsellNames = [
    'up_panel', 'up_surge', 'up_breaker', 'up_gfci', 'up_afci', 'up_ev',
    'up_sub', 'up_circuit', 'up_smoke', 'up_co', 'up_alum', 'up_arc',
    'up_svc', 'up_gen', 'up_outdoor', 'up_covers', 'up_label', 'up_ground'
  ];
  upsellNames.forEach(n => {
    if (d[n]) checked.push(d[n]);
  });
  if (checked.length || d.up_other) {
    html += `<h3 style="color: #0B2545; margin-top: 20px;">Recommended Services</h3>`;
    if (checked.length) html += `<p>${checked.join(', ')}</p>`;
    if (d.up_other) html += `<p><strong>Other:</strong> ${d.up_other}</p>`;
  }

  // Notes
  if (d.insp_notes) {
    html += `<h3 style="color: #0B2545; margin-top: 20px;">Notes</h3><p>${d.insp_notes.replace(/\n/g, '<br>')}</p>`;
  }

  // Signatures
  html += `<h3 style="color: #0B2545; margin-top: 20px;">Signatures</h3>
<table style="width: 100%; border-collapse: collapse;">
<tr><td style="padding: 6px; border: 1px solid #ddd;"><strong>Technician Name:</strong></td><td style="padding: 6px; border: 1px solid #ddd;">${d.sig_tech_name || ''}</td></tr>
<tr><td style="padding: 6px; border: 1px solid #ddd;"><strong>Date:</strong></td><td style="padding: 6px; border: 1px solid #ddd;">${d.sig_date || ''}</td></tr>
<tr><td style="padding: 6px; border: 1px solid #ddd;"><strong>Customer Name:</strong></td><td style="padding: 6px; border: 1px solid #ddd;">${d.sig_cust_name || ''}</td></tr>
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
