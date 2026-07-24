// backend/middleware/request-timeout.js
// Global per-request timeout — the client-facing half of the stuck-I/O
// hardening. Any request that hasn't finished within `ms` is answered 503 so a
// single wedged request can't tie up a worker indefinitely (during the
// 2026-07-24 stall, real requests piled up forever behind dead I/O). The
// per-call timeouts (lib/asyncGuards + the Stripe client timeout) are what let
// the wedged handler's own awaits finally settle and release resources; this
// just guarantees the CALLER gets a timely response either way.
//
// Exempt paths keep their existing, legitimately longer-running behavior:
//   /webhooks/stripe — Stripe retries on non-2xx; we don't want a 503 mid-work
//   /api/cron/*      — the daily digest fans out many sequential email sends
// The /readyz probe is the real backstop for a genuinely stuck process: it
// fails its bounded DB ping and Render restarts the instance.
//
// Node timers can't cancel an in-flight handler, so on timeout we only respond
// if nothing else has (headersSent guard); a late write from the original
// handler is swallowed rather than crashing the process.

function createRequestTimeout({ ms = 90000, exempt = [] } = {}) {
  return function requestTimeout(req, res, next) {
    const p = req.path || req.url || '';
    if (exempt.some((re) => re.test(p))) return next();

    const timer = setTimeout(() => {
      if (res.headersSent) return;
      console.error(`[request-timeout] ${req.method} ${req.originalUrl || req.url} exceeded ${ms}ms — responding 503`);
      try {
        res.status(503).json({ error: 'Request timed out' });
      } catch (_) {
        // Response already in flight — nothing safe to do.
      }
    }, ms);
    if (timer && timer.unref) timer.unref();

    const clear = () => clearTimeout(timer);
    res.on('finish', clear);
    res.on('close', clear);
    next();
  };
}

module.exports = { createRequestTimeout };
