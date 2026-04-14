const express = require('express');
const { supabaseAnon, supabaseAdmin } = require('../lib/supabase');
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

module.exports = router;
