const express = require('express');
const { Resend } = require('resend');
const { supabaseAnon, supabaseAdmin, supabaseForUser } = require('../lib/supabase');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const resendApiKey = process.env.RESEND_API_KEY;
const resend = resendApiKey ? new Resend(resendApiKey) : null;

const PROD_ORIGIN = 'https://bates-electric-app.onrender.com';

// Pick a safe origin for links we email. Honor the caller's Origin header
// when it looks like one of ours, otherwise fall back to the prod URL.
function resolveOrigin(req) {
  const origin = (req.headers.origin || '').replace(/\/+$/, '');
  const allowed = [
    PROD_ORIGIN,
    'http://localhost:4000',
    'http://localhost:3000',
    'http://localhost:5173',
    'http://127.0.0.1:4000',
    'http://127.0.0.1:3000',
    'http://127.0.0.1:5173',
  ];
  if (origin && allowed.includes(origin)) return origin;
  return PROD_ORIGIN;
}

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

// POST /auth/forgot-password  { email }
// Always returns { ok: true } regardless of whether the account exists,
// so a caller can't probe for valid emails. On the backend we try to
// generate a Supabase recovery link and email it via Resend.
router.post('/forgot-password', async (req, res) => {
  const { email } = req.body || {};
  if (!email || typeof email !== 'string') {
    return res.status(400).json({ error: 'Email is required.' });
  }

  const normalized = email.toLowerCase().trim();
  const debug = req.query.debug === '1';

  const result = {
    allowed: false,
    linkGenerated: false,
    hasResend: !!resend,
    fromEmail: null,
    redirectTo: null,
    sendAttempted: false,
    sendError: null,
    linkError: null,
  };

  try {
    if (!allowedBatesEmail(normalized)) {
      if (debug) return res.json({ ok: true, _debug: result, reason: 'not-bates-email' });
      return res.json({ ok: true });
    }
    result.allowed = true;

    const origin = resolveOrigin(req);
    const redirectTo = `${origin}/reset-password.html`;
    result.redirectTo = redirectTo;

    const { data: linkData, error: linkErr } = await supabaseAdmin.auth.admin.generateLink({
      type: 'recovery',
      email: normalized,
      options: { redirectTo },
    });
    if (linkErr) {
      result.linkError = linkErr.message || String(linkErr);
      console.error('generateLink failed:', result.linkError);
      if (debug) return res.json({ ok: true, _debug: result });
      return res.json({ ok: true });
    }
    const actionLink = linkData?.properties?.action_link;
    if (!actionLink) {
      result.linkError = 'no action_link in response';
      console.error(result.linkError);
      if (debug) return res.json({ ok: true, _debug: result });
      return res.json({ ok: true });
    }
    result.linkGenerated = true;
    if (debug) result.actionLink = actionLink;

    if (!resend) {
      console.warn('Resend not configured — skipping password reset email');
      if (debug) return res.json({ ok: true, _debug: result });
      return res.json({ ok: true });
    }

    const fromEmail = process.env.EMAIL_FROM || 'noreply@bates-electric.com';
    result.fromEmail = fromEmail;

    const html = `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#1B2D5B;">
        <h2 style="margin:0 0 12px;font-size:20px;">Reset your Bates Electric password</h2>
        <p style="font-size:15px;line-height:1.5;color:#5A6577;">
          Someone (hopefully you) asked to reset the password for this account.
          Click the button below to choose a new one. The link is good for one use
          and expires shortly.
        </p>
        <p style="margin:24px 0;">
          <a href="${actionLink}" style="display:inline-block;padding:12px 22px;background:#1B2D5B;color:#fff;text-decoration:none;border-radius:10px;font-weight:700;">
            Reset password
          </a>
        </p>
        <p style="font-size:13px;color:#8C939A;">
          If you didn't request this, you can safely ignore this email — your
          current password will keep working.
        </p>
      </div>
    `;

    result.sendAttempted = true;
    const { data: sendData, error: sendErr } = await resend.emails.send({
      from: fromEmail,
      to: [normalized],
      subject: 'Reset your Bates Electric password',
      html,
    });
    if (sendErr) {
      result.sendError = sendErr.message || JSON.stringify(sendErr);
      console.error('Resend send failed:', result.sendError);
    } else {
      result.sendResult = sendData;
    }
  } catch (err) {
    result.sendError = err && err.message ? err.message : String(err);
    console.error('forgot-password failed:', err);
  }

  if (debug) return res.json({ ok: true, _debug: result });
  return res.json({ ok: true });
});

// POST /auth/reset-password  { access_token, new_password }
// Consumes a Supabase recovery access_token (delivered via the email link)
// and sets the new password via the admin client.
router.post('/reset-password', async (req, res) => {
  const { access_token, new_password } = req.body || {};

  if (!access_token || !new_password) {
    return res.status(400).json({ error: 'Missing token or new password.' });
  }
  if (new_password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  }

  const { data: userData, error: userErr } = await supabaseAdmin.auth.getUser(access_token);
  if (userErr || !userData?.user) {
    return res.status(401).json({ error: 'This reset link is invalid or expired. Request a new one.' });
  }

  const { error: updateErr } = await supabaseAdmin.auth.admin.updateUserById(
    userData.user.id,
    { password: new_password }
  );
  if (updateErr) {
    return res.status(400).json({ error: updateErr.message });
  }

  return res.json({ ok: true });
});

module.exports = router;
