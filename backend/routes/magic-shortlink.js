// backend/routes/magic-shortlink.js
// PUBLIC (no-auth) redeemer for the branded SMS auto-login short links.
// Mounted by server.js at /s; the customer-facing URL is
// https://my.bates-electric.com/s/<token> (a Netlify proxy rewrite in
// frontend/_redirects forwards it here so the branded domain stays in front).
//
// The row's target_url is the REAL Supabase magic login link — a credential.
// It only ever leaves this route inside the Location header of the 302; it is
// never rendered in a body, never logged, never put in an error detail
// (lib/sms.js sendMagicLoginSms is the only writer of these rows).
//
// Redeem is SINGLE-USE and neutral on failure: a missing, already-used, or
// expired token all get the same redirect to the sign-in page's gentle
// "that link expired" note — the response never reveals which check failed,
// so the route can't be used to probe which tokens exist. Rate-limited
// against enumeration (72-bit tokens make brute force hopeless anyway).

const express = require('express');
const rateLimit = require('express-rate-limit');
const { supabaseAdmin } = require('../lib/supabase');
const { reportError } = require('../middleware/error-reporter');

const router = express.Router();

const EXPIRED_REDIRECT = 'https://my.bates-electric.com/?link=expired';

// Real traffic is one tap per nudge text (a handful a day). Anything beyond
// a stray double-tap + retry is a probe.
const redeemLimiter = rateLimit({
  windowMs: 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many requests' },
});

// GET /s/:token — claim the token and bounce to the stored magic link.
router.get('/:token', redeemLimiter, async (req, res) => {
  try {
    const token = String(req.params.token || '');
    // Tokens are short base64url; anything else can't be ours — skip the DB.
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(token)) return res.redirect(302, EXPIRED_REDIRECT);

    // Single atomic claim: stamp used_at only where it's still null and the
    // link hasn't expired. Two taps racing on the same token means exactly
    // one UPDATE matches — the loser (and any expired/unknown token) gets
    // back no row and lands on the expired page.
    const nowIso = new Date().toISOString();
    const { data: row, error } = await supabaseAdmin
      .from('generator_magic_shortlinks')
      .update({ used_at: nowIso })
      .eq('token', token)
      .is('used_at', null)
      .gt('expires_at', nowIso)
      .select('target_url')
      .maybeSingle();
    if (error) throw new Error('shortlink lookup failed: ' + error.message);

    if (!row || !row.target_url) return res.redirect(302, EXPIRED_REDIRECT);
    return res.redirect(302, row.target_url);
  } catch (err) {
    // No token/target in the report — the message above carries neither.
    console.error('[magic-shortlink] redeem error:', err && err.message);
    reportError(err, { route: '/s/:token', method: 'GET' }).catch(() => {});
    return res.redirect(302, EXPIRED_REDIRECT);
  }
});

module.exports = router;
