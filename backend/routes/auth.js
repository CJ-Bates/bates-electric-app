const express = require('express');
const { supabaseAnon, supabaseAdmin, supabaseForUser } = require('../lib/supabase');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// Mirror of the Postgres rule so we can fail fast with a clear message
// before even hitting Supabase. The DB trigger is still the source of truth.
function allowedBatesEmail(email) {
  if (!email) return false;
  const e = email.toLowerCase().trim();
  return e.endsWith('@bates-electric.com') || /\.bateselectric@gmail\.com$/.test(e);
}

// POST /auth/signup  { email, password, full_name?, phone? }
router.post('/signup', async (req, res) => {
  const { email, password, full_name, phone } = req.body || {};

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }
  if (!allowedBatesEmail(email)) {
    return res.status(403).json({
      error:
        'This email is not a Bates Electric address. Use your @bates-electric.com or *.bateselectric@gmail.com address.',
    });
  }

  const { data, error } = await supabaseAnon.auth.signUp({
    email,
    password,
    options: {
      data: { full_name: full_name || undefined, phone: phone || undefined },
    },
  });

  if (error) {
    return res.status(400).json({ error: error.message });
  }

  return res.json({
    message:
      'Account created. Check your email for a confirmation link before signing in.',
    user_id: data.user?.id ?? null,
  });
});

// POST /auth/login  { email, password }
router.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  const { data, error } = await supabaseAnon.auth.signInWithPassword({
    email,
    password,
  });

  if (error) {
    return res.status(401).json({ error: error.message });
  }

  const { data: profile } = await supabaseAdmin
    .from('profiles')
    .select('*')
    .eq('id', data.user.id)
    .single();

  return res.json({
    token: data.session.access_token,
    refresh_token: data.session.refresh_token,
    expires_at: data.session.expires_at,
    profile,
  });
});

// POST /auth/logout  (client-side is enough; this is for completeness)
router.post('/logout', requireAuth, async (req, res) => {
  await supabaseAnon.auth.signOut();
  res.json({ ok: true });
});

// GET /me  — current user's profile
router.get('/me', requireAuth, (req, res) => {
  res.json({ profile: req.profile });
});

// PATCH /me  { full_name }  — update the caller's own profile.
// RLS enforces self-update via the "profiles self update" policy.
router.patch('/me', requireAuth, async (req, res) => {
  const { full_name } = req.body || {};

  if (typeof full_name !== 'string') {
    return res.status(400).json({ error: 'full_name is required.' });
  }
  const trimmed = full_name.trim();
  if (trimmed.length < 1 || trimmed.length > 120) {
    return res.status(400).json({ error: 'Name must be 1–120 characters.' });
  }

  const supa = supabaseForUser(req.token);
  const { data, error } = await supa
    .from('profiles')
    .update({ full_name: trimmed })
    .eq('id', req.user.id)
    .select('*')
    .single();

  if (error) {
    return res.status(400).json({ error: error.message });
  }
  return res.json({ profile: data });
});

// POST /auth/change-password  { current_password, new_password }
// Re-verifies the current password by attempting a fresh sign-in, then
// updates via the admin client. We use the admin updateUserById path
// because it works server-side without needing the user's refreshed session.
router.post('/change-password', requireAuth, async (req, res) => {
  const { current_password, new_password } = req.body || {};

  if (!current_password || !new_password) {
    return res.status(400).json({ error: 'Current and new password are required.' });
  }
  if (new_password.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters.' });
  }
  if (new_password === current_password) {
    return res.status(400).json({ error: 'New password must differ from the current one.' });
  }

  const { error: verifyErr } = await supabaseAnon.auth.signInWithPassword({
    email: req.user.email,
    password: current_password,
  });
  if (verifyErr) {
    return res.status(401).json({ error: 'Current password is incorrect.' });
  }

  const { error: updateErr } = await supabaseAdmin.auth.admin.updateUserById(
    req.user.id,
    { password: new_password }
  );
  if (updateErr) {
    return res.status(400).json({ error: updateErr.message });
  }

  return res.json({ ok: true });
});

module.exports = router;
