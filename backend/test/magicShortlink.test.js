// Branded SMS short links (sql/028 + routes/magic-shortlink.js) — offline.
// Covers the spec's verification list:
//   - sendMagicLoginSms stores a shortlink row (crypto-random token,
//     target_url = the raw action_link, 30-min expiry) and the SMS body
//     carries https://my.bates-electric.com/s/<token>, never a supabase.co
//     URL; the logged message row keeps the [auto-login link] placeholder
//     (no raw link, no short link)
//   - a failed shortlink insert FAILS the send (non-terminal, retries) —
//     the raw link must never fall back onto the wire
//   - redeem route: valid unused token -> 302 to the stored target; reuse,
//     expiry, unknown, and malformed tokens all -> the same neutral
//     /?link=expired redirect; the target_url never appears outside the
//     Location header
require('./helpers/env');

const test = require('node:test');
const assert = require('node:assert/strict');

const { installMockSupabase } = require('./helpers/mockSupabase');
const { getRouteHandler, makeReq } = require('./helpers/routeHandler');
const { supabaseAdmin } = require('../lib/supabase');
const sms = require('../lib/sms');
const shortlinkRouter = require('../routes/magic-shortlink');

const redeem = getRouteHandler(shortlinkRouter, 'get', '/:token');

const CUSTOMER_ID = 'c0000000-0000-4000-8000-000000000001';
const ACTION_LINK = 'https://dummy.supabase.co/auth/v1/verify?token=SECRET-OTP-TOKEN' +
  '&type=magiclink&redirect_to=https%3A%2F%2Fmy.bates-electric.com%2F';
const SHORT_PREFIX = 'https://my.bates-electric.com/s/';
const EXPIRED_REDIRECT = 'https://my.bates-electric.com/?link=expired';

// Pinned clock inside quiet hours (8:30am CDT) so only the mocks gate sends.
const NOW = new Date('2026-07-15T13:30:00Z');

let restoreSupabase;
let realFetch;
let realGenerateLink;

test.afterEach(() => {
  if (restoreSupabase) { restoreSupabase(); restoreSupabase = undefined; }
  if (realFetch) { global.fetch = realFetch; realFetch = undefined; }
  if (realGenerateLink) { supabaseAdmin.auth.admin.generateLink = realGenerateLink; realGenerateLink = undefined; }
  delete process.env.SMS_ENABLED;
  delete process.env.SIMPLETEXTING_API_TOKEN;
  delete process.env.SIMPLETEXTING_ACCOUNT_PHONE;
});

function armTransport() {
  process.env.SMS_ENABLED = 'true';
  process.env.SIMPLETEXTING_API_TOKEN = 'tok_secret';
  process.env.SIMPLETEXTING_ACCOUNT_PHONE = '8339425468';
}

function mockGenerateLink() {
  realGenerateLink = supabaseAdmin.auth.admin.generateLink;
  supabaseAdmin.auth.admin.generateLink = async () =>
    ({ data: { properties: { action_link: ACTION_LINK } }, error: null });
}

function captureTexts(world) {
  realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    if (String(url).includes('simpletexting.com')) {
      world.texts.push(JSON.parse(opts.body));
      return { ok: true, status: 201, json: async () => ({ id: 'prov_1' }) };
    }
    throw new Error('unexpected fetch in offline test: ' + url);
  };
}

// Mint-side world: consent granted, shortlink inserts recorded (or failed).
function makeMintWorld({ shortlinkError } = {}) {
  const world = { texts: [], logged: [], shortlinks: [] };
  restoreSupabase = installMockSupabase({
    generator_sms_consent: () => ({
      data: [{ id: 'cons1', customer_id: CUSTOMER_ID, opted_in: true, opted_out: false }],
      error: null,
    }),
    generator_sms_messages: (chain) => {
      const ins = chain.find((c) => c.method === 'insert');
      if (ins) world.logged.push(ins.args[0]);
      return { data: null, error: null };
    },
    generator_magic_shortlinks: (chain) => {
      const ins = chain.find((c) => c.method === 'insert');
      if (ins) {
        if (shortlinkError) return { data: null, error: { message: shortlinkError } };
        world.shortlinks.push(ins.args[0]);
      }
      return { data: null, error: null };
    },
  });
  return world;
}

async function mintSend() {
  return sms.sendMagicLoginSms({
    customerId: CUSTOMER_ID,
    phone: '6365550100',
    email: 'sarah@example.com',
    buildBody: (link) => 'Tap: ' + link + '. Reply STOP to opt out.',
    now: NOW,
  });
}

// ---------------------------------------------------------------------------
// Mint + store (sendMagicLoginSms)
// ---------------------------------------------------------------------------
test('mint: shortlink row stored, wire carries /s/<token> (never supabase.co), log keeps the placeholder', async () => {
  armTransport();
  const world = makeMintWorld();
  captureTexts(world);
  mockGenerateLink();

  const result = await mintSend();
  assert.equal(result.status, 'sent');

  // The stored row: crypto-random url-safe token, the raw link as target,
  // audit customer_id, and a 30-minute expiry off the pinned clock.
  assert.equal(world.shortlinks.length, 1);
  const row = world.shortlinks[0];
  assert.match(row.token, /^[A-Za-z0-9_-]{12}$/, 'url-safe ~12-char token');
  assert.equal(row.target_url, ACTION_LINK);
  assert.equal(row.customer_id, CUSTOMER_ID);
  assert.equal(row.expires_at, new Date(NOW.getTime() + 30 * 60 * 1000).toISOString());

  // The wire: short branded link only.
  assert.equal(world.texts.length, 1);
  assert.ok(world.texts[0].text.includes(SHORT_PREFIX + row.token), world.texts[0].text);
  assert.ok(!world.texts[0].text.includes('supabase.co'), world.texts[0].text);

  // The log: placeholder only — neither the raw link nor the short one.
  assert.equal(world.logged.length, 1);
  assert.ok(world.logged[0].body.includes('[auto-login link]'), world.logged[0].body);
  assert.ok(!world.logged[0].body.includes('SECRET-OTP-TOKEN'), world.logged[0].body);
  assert.ok(!world.logged[0].body.includes(SHORT_PREFIX), world.logged[0].body);
  assert.ok(!world.logged[0].body.includes(row.token), world.logged[0].body);
});

test('mint: tokens are unique per send', async () => {
  armTransport();
  const world = makeMintWorld();
  captureTexts(world);
  mockGenerateLink();

  await mintSend();
  await mintSend();
  assert.equal(world.shortlinks.length, 2);
  assert.notEqual(world.shortlinks[0].token, world.shortlinks[1].token);
});

test('mint: shortlink insert failure fails the send — the raw link NEVER falls back onto the wire', async () => {
  armTransport();
  const world = makeMintWorld({ shortlinkError: 'insert exploded' });
  captureTexts(world);
  mockGenerateLink();

  const result = await mintSend();
  assert.equal(result.sent, false);
  assert.equal(result.status, 'failed', 'non-terminal so the cron sweep retries');
  assert.equal(world.texts.length, 0, 'nothing on the wire');
  assert.ok(!String(result.reason).includes('SECRET-OTP-TOKEN'), result.reason);
});

// ---------------------------------------------------------------------------
// Redeem (GET /s/:token)
// ---------------------------------------------------------------------------
function makeRedirectRes() {
  const res = { statusCode: null, location: null, body: undefined };
  res.redirect = (code, url) => { res.statusCode = code; res.location = url; return res; };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  return res;
}

// Stateful shortlink store replaying the route's atomic claim: update matches
// only an unused, unexpired row (ISO strings compare lexicographically).
function makeLinkStore(rows) {
  const store = rows.map((r) => ({ ...r }));
  let queried = false;
  const resolver = (chain) => {
    queried = true;
    const upd = chain.find((c) => c.method === 'update');
    if (!upd) return { data: null, error: null };
    const eqTok = chain.find((c) => c.method === 'eq' && c.args[0] === 'token');
    const isUnused = chain.find((c) => c.method === 'is' && c.args[0] === 'used_at');
    const gtExp = chain.find((c) => c.method === 'gt' && c.args[0] === 'expires_at');
    const row = store.find((r) => r.token === (eqTok && eqTok.args[1]));
    const claimable = row
      && (!isUnused || row.used_at == null)
      && (!gtExp || row.expires_at > gtExp.args[1]);
    if (!claimable) return { data: null, error: null };
    Object.assign(row, upd.args[0]);
    return { data: { target_url: row.target_url }, error: null };
  };
  return { store, resolver, wasQueried: () => queried };
}

function liveRow(token) {
  return {
    token,
    target_url: ACTION_LINK,
    customer_id: CUSTOMER_ID,
    expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    used_at: null,
  };
}

test('redeem: valid unused token -> 302 to the stored target, single-use claim stamped', async () => {
  const { store, resolver } = makeLinkStore([liveRow('AbC123_-Xyz9')]);
  restoreSupabase = installMockSupabase({ generator_magic_shortlinks: resolver });

  const res = makeRedirectRes();
  await redeem(makeReq({ params: { token: 'AbC123_-Xyz9' } }), res);

  assert.equal(res.statusCode, 302);
  assert.equal(res.location, ACTION_LINK, 'target only ever appears in the redirect Location');
  assert.equal(res.body, undefined, 'no response body');
  assert.ok(store[0].used_at, 'claimed');
});

test('redeem: second hit on the same token -> neutral expired redirect', async () => {
  const { resolver } = makeLinkStore([liveRow('AbC123_-Xyz9')]);
  restoreSupabase = installMockSupabase({ generator_magic_shortlinks: resolver });

  await redeem(makeReq({ params: { token: 'AbC123_-Xyz9' } }), makeRedirectRes());
  const res = makeRedirectRes();
  await redeem(makeReq({ params: { token: 'AbC123_-Xyz9' } }), res);

  assert.equal(res.statusCode, 302);
  assert.equal(res.location, EXPIRED_REDIRECT);
});

test('redeem: expired token -> expired redirect, row left unclaimed', async () => {
  const { store, resolver } = makeLinkStore([
    { ...liveRow('AbC123_-Xyz9'), expires_at: new Date(Date.now() - 60 * 1000).toISOString() },
  ]);
  restoreSupabase = installMockSupabase({ generator_magic_shortlinks: resolver });

  const res = makeRedirectRes();
  await redeem(makeReq({ params: { token: 'AbC123_-Xyz9' } }), res);

  assert.equal(res.location, EXPIRED_REDIRECT);
  assert.equal(store[0].used_at, null);
});

test('redeem: unknown token -> the SAME expired redirect (no existence probe)', async () => {
  const { resolver } = makeLinkStore([liveRow('AbC123_-Xyz9')]);
  restoreSupabase = installMockSupabase({ generator_magic_shortlinks: resolver });

  const res = makeRedirectRes();
  await redeem(makeReq({ params: { token: 'zzzzzzzzzzzz' } }), res);

  assert.equal(res.statusCode, 302);
  assert.equal(res.location, EXPIRED_REDIRECT);
});

test('redeem: malformed token -> expired redirect without touching the database', async () => {
  const { resolver, wasQueried } = makeLinkStore([]);
  restoreSupabase = installMockSupabase({ generator_magic_shortlinks: resolver });

  for (const bad of ['ab', 'has spaces in it', 'semi;colon../x', '']) {
    const res = makeRedirectRes();
    await redeem(makeReq({ params: { token: bad } }), res);
    assert.equal(res.location, EXPIRED_REDIRECT, JSON.stringify(bad));
  }
  assert.equal(wasQueried(), false);
});

test('redeem: database error -> expired redirect, never a 500 or a leaked detail', async () => {
  restoreSupabase = installMockSupabase({
    generator_magic_shortlinks: () => ({ data: null, error: { message: 'db down' } }),
  });

  const res = makeRedirectRes();
  await redeem(makeReq({ params: { token: 'AbC123_-Xyz9' } }), res);

  assert.equal(res.statusCode, 302);
  assert.equal(res.location, EXPIRED_REDIRECT);
  assert.equal(res.body, undefined);
});
