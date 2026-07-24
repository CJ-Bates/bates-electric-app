// Route-level tests for the liveness/readiness probes (routes/health.js) that
// are the core of the auto-restart fix. /health must stay a static 200 (it did
// through the whole 2026-07-24 stall — that's the point). /readyz must return
// 200 only when the DB actually answers, and 503 — promptly, not by hanging —
// when the DB ping is wedged, which is what lets Render restart a stuck process.
require('./helpers/env');

const test = require('node:test');
const assert = require('node:assert/strict');

const { installMockSupabase } = require('./helpers/mockSupabase');
const { getRouteHandler, makeReq, makeRes } = require('./helpers/routeHandler');
const { supabaseAdmin } = require('../lib/supabase');
const healthRouter = require('../routes/health');

const health = getRouteHandler(healthRouter, 'get', '/health');
const readyz = getRouteHandler(healthRouter, 'get', '/readyz');

let restoreSupabase;
test.afterEach(() => {
  if (restoreSupabase) { restoreSupabase(); restoreSupabase = undefined; }
  delete process.env.READYZ_TIMEOUT_MS;
});

test('/health returns 200 static JSON with no dependency check', async () => {
  const res = makeRes();
  health(makeReq(), res);
  assert.equal(res.statusCode, 200);
  assert.match(res.body.status, /Bates Electric API is running/);
  assert.ok(res.body.timestamp);
});

test('/readyz returns 200 when the DB answers', async () => {
  restoreSupabase = installMockSupabase({
    profiles: () => ({ data: [{ id: 'p1' }], error: null }),
  });
  const res = makeRes();
  await readyz(makeReq(), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.status, 'ready');
});

test('/readyz returns 503 when the DB returns an error', async () => {
  restoreSupabase = installMockSupabase({
    profiles: () => ({ data: null, error: { message: 'relation missing' } }),
  });
  const res = makeRes();
  await readyz(makeReq(), res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.status, 'not ready');
});

test('/readyz returns 503 — promptly — when the DB ping hangs', async () => {
  process.env.READYZ_TIMEOUT_MS = '40';
  // A query builder whose terminal thenable never settles (a wedged socket).
  const original = supabaseAdmin.from;
  const hanging = {};
  ['select', 'in', 'eq', 'order', 'limit'].forEach((m) => { hanging[m] = () => hanging; });
  hanging.then = () => {}; // thenable that never resolves or rejects
  supabaseAdmin.from = () => hanging;
  restoreSupabase = () => { supabaseAdmin.from = original; };

  const started = Date.now();
  const res = makeRes();
  await readyz(makeReq(), res);
  assert.equal(res.statusCode, 503, 'a stuck DB ping must fail readiness');
  assert.match(res.body.error, /timed out/);
  assert.ok(Date.now() - started < 2000, 'must fail at the timeout, not hang');
});
