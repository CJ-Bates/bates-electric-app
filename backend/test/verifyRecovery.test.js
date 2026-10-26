// POST /auth/verify-recovery — the token exchange behind the set-password
// page. The page keys its whole UI off this status contract, so pin it:
//   200 valid link (any whitelisted OTP type; default recovery)
//   400 used / expired / unknown token (dead link)
//   429 GoTrue's own verification rate limit -> "too many attempts"
//   503 GoTrue unreachable OR the call exceeds the bounded timeout -> "slow",
//       never reported as a dead link, never waits for the 90s global ceiling
// Offline: supabaseAnon.auth.verifyOtp is stubbed on the shared client.
require('./helpers/env');

const test = require('node:test');
const assert = require('node:assert/strict');

const { supabaseAnon } = require('../lib/supabase');
const { getRouteHandler, makeReq, makeRes } = require('./helpers/routeHandler');

process.env.VERIFY_OTP_TIMEOUT_MS = '40';
const authRouter = require('../routes/auth');
const verify = getRouteHandler(authRouter, 'post', '/verify-recovery');

let originalVerifyOtp;
let calls;
function stubVerifyOtp(impl) {
  calls = [];
  originalVerifyOtp = supabaseAnon.auth.verifyOtp;
  supabaseAnon.auth.verifyOtp = async (args) => { calls.push(args); return impl(args); };
}
test.afterEach(() => {
  if (originalVerifyOtp) { supabaseAnon.auth.verifyOtp = originalVerifyOtp; originalVerifyOtp = null; }
});

const SESSION = { data: { session: { access_token: 'jwt-1' }, user: { email: 'owen@example.com' } }, error: null };

test('valid invite/resend link (type=recovery, the shape our emails send) -> 200 with access_token + email', async () => {
  stubVerifyOtp(async () => SESSION);
  const res = makeRes();
  await verify(makeReq({ body: { token_hash: 'abc', type: 'recovery' } }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { access_token: 'jwt-1', email: 'owen@example.com' });
  assert.deepEqual(calls[0], { token_hash: 'abc', type: 'recovery' });
});

test('missing type defaults to recovery; unknown type is coerced to recovery; invite is passed through', async () => {
  stubVerifyOtp(async () => SESSION);
  await verify(makeReq({ body: { token_hash: 'abc' } }), makeRes());
  await verify(makeReq({ body: { token_hash: 'abc', type: 'bogus' } }), makeRes());
  await verify(makeReq({ body: { token_hash: 'abc', type: 'invite' } }), makeRes());
  assert.deepEqual(calls.map((c) => c.type), ['recovery', 'recovery', 'invite']);
});

test('used / expired token -> 400 dead link', async () => {
  stubVerifyOtp(async () => ({ data: { session: null, user: null }, error: { message: 'Token has expired or is invalid', status: 403 } }));
  const res = makeRes();
  await verify(makeReq({ body: { token_hash: 'old' } }), res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /invalid or expired/);
});

test('missing / non-string token -> 400 without calling Supabase', async () => {
  stubVerifyOtp(async () => SESSION);
  const r1 = makeRes(); await verify(makeReq({ body: {} }), r1);
  const r2 = makeRes(); await verify(makeReq({ body: { token_hash: { $gt: '' } } }), r2);
  assert.equal(r1.statusCode, 400);
  assert.equal(r2.statusCode, 400);
  assert.equal(calls.length, 0);
});

test('GoTrue verification rate limit -> 429 (not a dead link)', async () => {
  stubVerifyOtp(async () => ({ data: {}, error: { message: 'Request rate limit reached', status: 429, name: 'AuthApiError' } }));
  const res = makeRes();
  await verify(makeReq({ body: { token_hash: 'abc' } }), res);
  assert.equal(res.statusCode, 429);
  assert.match(res.body.error, /Too many attempts/);
});

test('GoTrue unreachable (retryable fetch error) -> 503 slow, not 400', async () => {
  stubVerifyOtp(async () => ({ data: {}, error: { message: 'fetch failed', status: 0, name: 'AuthRetryableFetchError' } }));
  const res = makeRes();
  await verify(makeReq({ body: { token_hash: 'abc' } }), res);
  assert.equal(res.statusCode, 503);
  assert.match(res.body.error, /slow right now/);
});

test('verifyOtp that never answers -> 503 after the bounded timeout (never the 90s global ceiling)', async () => {
  stubVerifyOtp(() => new Promise(() => {})); // hangs forever
  const res = makeRes();
  const t0 = Date.now();
  await verify(makeReq({ body: { token_hash: 'abc' } }), res);
  const elapsed = Date.now() - t0;
  assert.equal(res.statusCode, 503);
  assert.ok(elapsed < 2000, `answered in ${elapsed}ms`);
});
