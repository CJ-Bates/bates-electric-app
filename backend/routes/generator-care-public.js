// backend/routes/generator-care-public.js
// PUBLIC (no-auth) Generator Care routes — currently just the email
// unsubscribe link (Growth Engine WP4). Mounted by server.js at
// /generator-care, deliberately OUTSIDE the office router's
// requireAuth/requireRole('office') gate: the URL lives in a customer's
// inbox, so it must work with no session at all.
//
// Security shape: the link carries ONLY the lead's random unsubscribe_token
// (never a lead id), the route only ever sets email_opt_out=true (a click can
// opt someone out, never back in or read anything), and an unknown token gets
// the same confirmation page as a known one so the URL can't be used to probe
// which tokens exist.

const express = require('express');
const { supabaseAdmin } = require('../lib/supabase');
const { reportError } = require('../middleware/error-reporter');
const { makePublicLimiter } = require('../middleware/limiters');

const router = express.Router();

// Public + unauthenticated, and it performs a DB write (email_opt_out), so it
// gets an anti-enumeration limiter like the other public routes.
const publicLimiter = makePublicLimiter();

// Minimal branded confirmation page. Standalone (no app shell/auth), inline
// styles only, light/dark via prefers-color-scheme. No emoji.
function unsubscribePage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Unsubscribed &mdash; Bates Electric Generator Care</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
         background: #F4F6F9; color: #374151;
         font-family: system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }
  .card { background: #FFFFFF; border-radius: 12px; box-shadow: 0 1px 3px rgba(15,31,61,0.08);
          max-width: 460px; width: calc(100% - 32px); margin: 24px 16px; overflow: hidden; text-align: center; }
  .band { background: #1F3A5F; color: #FFFFFF; padding: 22px 24px; }
  .band .name { font-size: 18px; font-weight: 700; letter-spacing: 0.4px; }
  .band .eyebrow { color: #DFE6F0; font-size: 11px; letter-spacing: 2px; text-transform: uppercase; font-weight: 600; margin-top: 5px; }
  .body { padding: 30px 28px 34px; }
  h1 { margin: 0 0 12px; font-size: 20px; color: #1F3A5F; }
  p { margin: 0 0 10px; font-size: 15px; line-height: 1.6; }
  .fine { color: #6B7280; font-size: 13px; margin-top: 16px; }
  @media (prefers-color-scheme: dark) {
    body { background: #10151D; color: #C9D1DC; }
    .card { background: #1A212C; box-shadow: 0 1px 3px rgba(0,0,0,0.4); }
    h1 { color: #AFC6E4; }
    .fine { color: #8A94A3; }
  }
</style>
</head>
<body>
  <div class="card">
    <div class="band">
      <div class="name">Bates Electric</div>
      <div class="eyebrow">Generator Care</div>
    </div>
    <div class="body">
      <h1>You&rsquo;ve been unsubscribed</h1>
      <p>You won&rsquo;t receive any more Generator Care enrollment emails from us.</p>
      <p class="fine">Unsubscribed by mistake, or have a question? Call us at (636) 464-3939 or email generators@bates-electric.com.</p>
    </div>
  </div>
</body>
</html>`;
}

// GET /generator-care/unsubscribe?token=<unsubscribe_token>
// Sets email_opt_out on the matching lead. Idempotent: a repeat click finds
// the lead already opted out and just re-renders the page (opt_out_at keeps
// its original timestamp). Unknown/missing token still shows the neutral
// confirmation — never an error that reveals whether the token existed.
router.get('/unsubscribe', publicLimiter, async (req, res) => {
  try {
    const token = typeof req.query.token === 'string' ? req.query.token.trim() : '';
    if (token) {
      const { data: lead, error } = await supabaseAdmin
        .from('generator_leads')
        .select('id, email_opt_out')
        .eq('unsubscribe_token', token)
        .maybeSingle();
      if (error) throw error;
      if (lead && !lead.email_opt_out) {
        const { error: updErr } = await supabaseAdmin
          .from('generator_leads')
          .update({ email_opt_out: true, opt_out_at: new Date().toISOString(), updated_at: new Date().toISOString() })
          .eq('id', lead.id);
        if (updErr) throw updErr;
      }
    }
    res.status(200).type('html').send(unsubscribePage());
  } catch (err) {
    // A DB hiccup must not strand the customer on an error page mid-opt-out;
    // show the page anyway and let the error report tell us to re-check.
    console.error('[generator-care] unsubscribe error:', err && err.message);
    // req.path, not req.originalUrl — the unsubscribe token rides in ?token=.
    reportError(err, { route: req.path, method: req.method }).catch(() => {});
    res.status(200).type('html').send(unsubscribePage());
  }
});

module.exports = router;
