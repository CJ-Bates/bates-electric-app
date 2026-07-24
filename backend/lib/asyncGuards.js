// backend/lib/asyncGuards.js
// Small, shared async safety primitives used to harden the backend against the
// stuck-I/O stall that silently froze production for ~a day (2026-07-24): the
// event loop stayed alive (the dependency-free /health kept passing) but every
// DB/Stripe call in the request path piled up behind wedged I/O with no
// per-call timeout, so requests hung forever instead of failing.
//
// Two primitives, one job each:
//   withTimeout(promise, ms, label) — bound any single promise so a stuck
//     socket / wedged query REJECTS at `ms` instead of hanging. The rejection
//     is a plain Error that callers already handle in their try/catch.
//   mapPool(items, concurrency, fn) — a bounded-concurrency Promise.all: same
//     ordered results, but never more than `concurrency` in flight at once, so
//     a wide report can't fan out into hundreds of simultaneous sockets and
//     exhaust the connection pool on the 512 MB instance.
//
// Deliberately dependency-free so it can wrap Stripe, Supabase, or anything.

class TimeoutError extends Error {
  constructor(label, ms) {
    super(`${label || 'operation'} timed out after ${ms}ms`);
    this.name = 'TimeoutError';
    this.code = 'ETIMEDOUT_GUARD';
  }
}

// Race `promise` against a rejecting timer. Resolves/rejects with the promise's
// own outcome if it settles first; otherwise rejects with a TimeoutError at
// `ms`. The timer is always cleared (both branches) and unref'd so the guard
// itself can never keep the process alive. Note: like all JS timeouts this does
// not CANCEL the underlying work — it just stops the caller waiting on it; the
// point is that the caller returns instead of hanging.
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(label, ms)), ms);
    if (timer && timer.unref) timer.unref();
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

// Run `fn` over `items` with at most `concurrency` promises in flight, returning
// results in input order (drop-in for `Promise.all(items.map(fn))`). Rejects on
// the first rejection, exactly like Promise.all — callers that want per-item
// failures to be non-fatal keep their own inner try/catch (as the accounting
// enrichment fan-outs already do).
async function mapPool(items, concurrency, fn) {
  const list = Array.from(items);
  const results = new Array(list.length);
  let next = 0;
  const worker = async () => {
    let i;
    while ((i = next++) < list.length) {
      results[i] = await fn(list[i], i);
    }
  };
  const n = Math.max(1, Math.min(concurrency, list.length));
  const workers = [];
  for (let w = 0; w < n; w++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

module.exports = { withTimeout, TimeoutError, mapPool };
