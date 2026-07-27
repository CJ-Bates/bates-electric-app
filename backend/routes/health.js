// backend/routes/health.js
// Two probes, deliberately different in what they prove:
//
//   GET /health  — LIVENESS. Static JSON, no dependencies. Answers as long as
//                  the event loop is turning. This is what stayed green through
//                  the entire 2026-07-24 stall (the process wasn't CPU-blocked;
//                  its I/O layer was wedged), which is exactly why it can't be
//                  the health check Render restarts on.
//
//   GET /readyz  — READINESS. Touches the DB with a hard, bounded timeout, so a
//                  stuck-I/O process FAILS it. Returns 200 only if Supabase
//                  answers a trivial indexed read within READYZ_TIMEOUT_MS,
//                  else 503. Point Render's Health Check Path here to turn a
//                  silent day-long outage into a ~minute auto-restart. Kept
//                  cheap and short so it only fails on a genuine stall, never on
//                  one slow response — Render's consecutive-failure threshold
//                  guards against restart loops.
//
// Both are unauthenticated by necessity (Render's prober has no token) and
// mounted before all heavier middleware so a probe is never itself delayed.

const express = require('express');
const { supabaseAdmin } = require('../lib/supabase');
const { withTimeout } = require('../lib/asyncGuards');
const { makePublicLimiter } = require('../middleware/limiters');

const router = express.Router();

// /readyz runs a DB query per hit, so give it a light limiter (generous for
// Render's periodic prober, blocks a flood). /health is static and stays open.
const readyzLimiter = makePublicLimiter();

router.get('/health', (req, res) => {
  res.json({
    status: 'Bates Electric API is running!',
    timestamp: new Date().toISOString(),
  });
});

router.get('/readyz', readyzLimiter, async (req, res) => {
  const ms = Number(process.env.READYZ_TIMEOUT_MS) || 4000;
  try {
    // Cheapest possible dependency check: one indexed row from a table that
    // always exists. supabase-js returns { error } instead of throwing on a
    // query error, so we inspect it; a wedged socket is caught by withTimeout.
    const { error } = await withTimeout(
      supabaseAdmin.from('profiles').select('id').limit(1),
      ms,
      'readyz db ping',
    );
    if (error) throw new Error(error.message || 'db error');
    res.json({ status: 'ready', timestamp: new Date().toISOString() });
  } catch (e) {
    // Log the real driver detail; return a generic message to unauthenticated
    // callers so the underlying DB/driver error text isn't leaked.
    console.error('[readyz] dependency check failed:', (e && e.message) || e);
    res.status(503).json({ status: 'not ready', error: 'dependency check failed' });
  }
});

module.exports = router;
