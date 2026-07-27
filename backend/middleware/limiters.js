// backend/middleware/limiters.js
// Shared rate-limiter factories for the staff/office/tech/public routers.
//
// Why a shared module: SEC-P1 adds limiters to five routers that had none
// (generator-care office, generator-tech, members, inspections, and the public
// unsubscribe route). Keeping the ceilings in ONE place makes them easy to
// review and tune, and matches the existing per-route attach style used in
// routes/customer.js and routes/auth.js.
//
// Why FACTORIES, not shared instances: each express-rate-limit instance owns
// its own in-memory counter store. If two routers imported the SAME instance,
// a burst on one would consume the other's budget for the same IP. Each router
// calls a factory to get its OWN isolated limiter.
//
// Ceilings are deliberately GENEROUS — these are staff tools and must not break
// an office user doing bulk work or a tech working a full day of visits. They
// are an abuse/cost/outbound-reputation backstop, not a workflow throttle. The
// tighter `sensitiveLimiter` is applied ONLY to the money-, email-, and
// PDF-generating endpoints; everything else rides the loose general limiter.

const rateLimit = require('express-rate-limit');

const RATE_MESSAGE = { error: 'Too many requests — please wait a few minutes and try again.' };

const COMMON = { standardHeaders: true, legacyHeaders: false, message: RATE_MESSAGE };

// General staff traffic (reads + ordinary writes). 300/min ≈ 5 req/s sustained
// per IP — no human office/field workflow reaches this; only scripted abuse.
function makeGeneralLimiter() {
  return rateLimit({ windowMs: 60 * 1000, limit: 300, ...COMMON });
}

// Money, email, and PDF/zip endpoints — the cost + outbound-reputation surface.
// 30 per 15 min per IP is far above any real ad-hoc-charge or invite cadence
// (bulk email endpoints batch many recipients into a single request) but stops
// a burst cold.
function makeSensitiveLimiter() {
  return rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, ...COMMON });
}

// Public, unauthenticated endpoints (the unsubscribe link) — anti-enumeration,
// mirrors routes/magic-shortlink.js and routes/sms-inbound.js (30–60/min).
function makePublicLimiter() {
  return rateLimit({ windowMs: 60 * 1000, limit: 30, ...COMMON });
}

module.exports = { makeGeneralLimiter, makeSensitiveLimiter, makePublicLimiter, RATE_MESSAGE };
