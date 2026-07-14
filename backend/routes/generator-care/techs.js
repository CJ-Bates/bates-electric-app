// backend/routes/generator-care/techs.js
// Field-tech account management: list/create/deactivate + set-password links.
// Auth (requireAuth + office role) is applied by ./index.js.

const express = require('express');
const { requirePermission } = require('../../middleware/permissions');
const { supabaseAdmin } = require('../../lib/supabase');
const { reportError } = require('../../middleware/error-reporter');
const { sendSetPasswordEmail } = require('../../lib/emails');

const router = express.Router();

// ============================================================================
// FIELD-TECH MANAGEMENT (office-gated, like the rest of this router)
// ============================================================================

// A tech account is a profile whose role is 'tech'. Role is assigned by the DB
// trigger from the email domain, so a tech's email MUST be *.bateselectric@gmail.com.
function isTechEmail(email) {
  return !!email && /\.bateselectric@gmail\.com$/i.test(String(email).trim());
}

// GET /api/generator-care/techs — list tech accounts (for the assign picker +
// the manage-techs screen). Office-gated.
router.get('/techs', requirePermission('tech_manage'), async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('profiles')
      .select('id, full_name, email, active, created_at')
      .eq('role', 'tech')
      .order('full_name', { ascending: true });
    if (error) throw error;
    res.json({ techs: data || [] });
  } catch (err) {
    console.error('[generator-care] list techs error:', err && err.message);
    reportError(err, { route: req.originalUrl, method: req.method, user: req.profile && req.profile.email }).catch(() => {});
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/generator-care/techs  { name, email }
// Creates the tech's auth account (role assigned by the DB trigger from the
// email domain) and emails them a set-password link. The office never sets the
// password. Office-gated.
router.post('/techs', requirePermission('tech_manage'), async (req, res) => {
  try {
    const name = (req.body && req.body.name || '').trim();
    const email = (req.body && req.body.email || '').trim().toLowerCase();
    if (!name) return res.status(400).json({ error: 'Tech name is required.' });
    if (!isTechEmail(email)) {
      return res.status(400).json({
        error: 'Tech email must be a *.bateselectric@gmail.com address (that domain is what assigns the tech role).',
      });
    }

    // Create the auth user; the on_auth_user_created trigger inserts the profile
    // with role='tech' and full_name from user_metadata. email_confirm:true so
    // they don't need to click a confirm link before setting a password.
    const { data: created, error: createErr } = await supabaseAdmin.auth.admin.createUser({
      email,
      email_confirm: true,
      user_metadata: { full_name: name },
    });
    if (createErr) {
      const msg = /already.*registered|already exists|duplicate/i.test(createErr.message || '')
        ? 'A user with that email already exists.'
        : createErr.message;
      return res.status(400).json({ error: msg });
    }

    // Send the tech our branded "Create your password" email.
    try {
      await sendSetPasswordEmail({ email, name, mode: 'create' });
    } catch (mailErr) {
      console.error('[generator-care] tech invite email failed:', mailErr.message);
      // Account exists; the office can resend the link. Surface a soft warning.
      return res.json({
        ok: true,
        tech: { id: created.user.id, email, full_name: name, active: true },
        warning: 'Account created, but the set-password email failed to send. Use "Resend set-password link".',
      });
    }

    res.json({ ok: true, tech: { id: created.user.id, email, full_name: name, active: true } });
  } catch (err) {
    console.error('[generator-care] create tech error:', err && err.message);
    reportError(err, { route: req.originalUrl, method: req.method, user: req.profile && req.profile.email }).catch(() => {});
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/generator-care/techs/:id/resend-invite — resend the set-password link.
router.post('/techs/:id/resend-invite', requirePermission('tech_manage'), async (req, res) => {
  try {
    const { data: tech, error } = await supabaseAdmin
      .from('profiles')
      .select('email, full_name, role')
      .eq('id', req.params.id)
      .single();
    if (error || !tech) return res.status(404).json({ error: 'tech not found' });
    if (tech.role !== 'tech') return res.status(400).json({ error: 'not a tech account' });
    try {
      await sendSetPasswordEmail({ email: tech.email, name: tech.full_name, mode: 'create' });
    } catch (mailErr) {
      console.error('[generator-care] resend tech invite email failed:', mailErr.message);
      return res.status(502).json({ error: 'Could not send the email. Try again shortly.' });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[generator-care] resend tech invite error:', err && err.message);
    reportError(err, { route: req.originalUrl, method: req.method, user: req.profile && req.profile.email }).catch(() => {});
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /api/generator-care/techs/:id  { active }  — deactivate / reactivate.
router.patch('/techs/:id', requirePermission('tech_manage'), async (req, res) => {
  try {
    const active = req.body && req.body.active;
    if (typeof active !== 'boolean') return res.status(400).json({ error: 'active (boolean) required' });
    const { data, error } = await supabaseAdmin
      .from('profiles')
      .update({ active })
      .eq('id', req.params.id)
      .eq('role', 'tech')
      .select('id, full_name, email, active')
      .single();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'tech not found' });
    res.json({ ok: true, tech: data });
  } catch (err) {
    console.error('[generator-care] update tech error:', err && err.message);
    reportError(err, { route: req.originalUrl, method: req.method, user: req.profile && req.profile.email }).catch(() => {});
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
