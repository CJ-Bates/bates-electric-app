const express = require('express');
const { supabaseForUser } = require('../lib/supabase');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

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

  res.status(201).json({ inspection: inserted });
});

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

module.exports = router;
