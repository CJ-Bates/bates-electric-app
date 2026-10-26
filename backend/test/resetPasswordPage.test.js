// frontend/reset-password.js — the set-password page must NEVER sit on
// "Checking your link". It is loaded here, unmodified, into a tiny fake DOM
// (only the handful of DOM APIs the page touches) with fetch/timers under
// test control. Pins, per the Oct 26 tech-invite hang:
//   - valid invite link / valid resend link (both ?token_hash=&type=recovery)
//     -> form enabled, email filled, spinner gone
//   - used / expired link -> "expired or already used" + Send me a new link
//   - network failure -> "couldn't reach" + Try again + resend
//   - server never answers -> aborted after the timeout, "taking too long"
//   - 5xx -> "couldn't reach" (NOT expired); 429 -> "too many attempts"
//   - Supabase-style ?error=...&error_code=otp_expired -> expired
//   - other link shapes: type=invite token_hash, legacy #access_token with
//     any type, PKCE ?code= -> never a hang
//   - the script itself throwing during init -> error state, not a spinner
require('./helpers/env');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PAGE_JS = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'reset-password.js'), 'utf8');
const PAGE_HTML = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'reset-password.html'), 'utf8');
const IDS = Array.from(PAGE_HTML.matchAll(/\sid="([^"]+)"/g)).map((m) => m[1]);

class FakeEl {
  constructor(id) {
    this.id = id;
    this.hidden = false;
    this.disabled = false;
    this.textContent = '';
    this.className = '';
    this.value = '';
    this.dataset = {};
    this.attrs = {};
    this.listeners = {};
    this.children = {};
    this.focused = 0;
    this.classList = { add: () => {}, remove: () => {} };
  }
  addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); }
  dispatch(ev, e) { for (const fn of this.listeners[ev] || []) fn(e || { preventDefault() {} }); }
  focus() { this.focused += 1; }
  setAttribute(k, v) { this.attrs[k] = v; }
  querySelector(sel) { return this.children[sel] || null; }
}

// Builds the page environment and runs reset-password.js in it.
//   url:   { search, hash }
//   fetch: async (url, opts) => Response-like, or a function returning a
//          promise that never resolves (listens for opts.signal abort)
//   missing: ids to leave OUT of the DOM (simulates a script/markup mismatch)
function loadPage({ search = '', hash = '', fetch, missing = [], verifyTimeoutMs = 60 } = {}) {
  const els = {};
  for (const id of IDS) if (!missing.includes(id)) els[id] = new FakeEl(id);
  // Initial markup state: spinner visible, form visible-but-disabled, others hidden.
  for (const id of ['link-dead', 'link-success', 'link-retry']) if (els[id]) els[id].hidden = true;
  for (const id of ['reset-new', 'reset-confirm', 'reset-submit']) if (els[id]) els[id].disabled = true;
  if (els['reset-submit']) els['reset-submit'].children['.btn-label'] = new FakeEl('submit-label');
  if (els['resend-submit']) els['resend-submit'].children['.btn-label'] = new FakeEl('resend-label');
  if (els['link-dead']) els['link-dead'].children['.link-panel-foot'] = new FakeEl('foot');

  const windowListeners = {};
  const fetchCalls = [];
  const win = {
    __RESET_VERIFY_TIMEOUT_MS: verifyTimeoutMs,
    location: { hostname: 'app.bates-electric.com', search, hash, replace() {} },
    addEventListener(ev, fn) { (windowListeners[ev] = windowListeners[ev] || []).push(fn); },
  };
  const doc = {
    readyState: 'complete',
    getElementById: (id) => els[id] || null,
    addEventListener() {},
  };
  const ctx = {
    window: win, document: doc, location: win.location,
    URLSearchParams, atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    JSON, Date, Number, Math, String, Promise, Buffer,
    setTimeout, clearTimeout, AbortController,
    console: { error() {}, log() {} },
    fetch: async (url, opts) => { fetchCalls.push({ url, opts }); return fetch(url, opts); },
  };
  vm.createContext(ctx);
  vm.runInContext(PAGE_JS, ctx, { filename: 'reset-password.js' });
  return { els, win, fetchCalls, windowListeners };
}

const settle = async (ms = 0) => { await new Promise((r) => setTimeout(r, ms)); await new Promise((r) => setImmediate(r)); };
const okResponse = (body) => ({ ok: true, status: 200, json: async () => body });
const errResponse = (status, body) => ({ ok: false, status, json: async () => body || {} });

function expectDead(els, kind, { resend, retry }) {
  assert.equal(els['link-checking'].hidden, true, 'spinner hidden');
  assert.equal(els['reset-form'].hidden, true, 'form hidden');
  assert.equal(els['link-dead'].hidden, false, 'dead panel shown');
  assert.equal(els['link-dead'].dataset.kind, kind);
  assert.equal(els['resend-form'].hidden, !resend, 'resend form visibility');
  assert.equal(els['link-retry'].hidden, !retry, 'retry button visibility');
  assert.equal(els['reset-new'].disabled, true, 'password field stays disabled');
}

test('valid invite link (?token_hash&type=recovery) -> spinner gone, form enabled, email filled', async () => {
  const { els, fetchCalls } = loadPage({
    search: '?token_hash=HASH1&type=recovery',
    fetch: async () => okResponse({ access_token: 'jwt', email: 'owen@example.com' }),
  });
  assert.equal(els['link-checking'].hidden, false, 'spinner while in flight');
  await settle();
  assert.equal(els['link-checking'].hidden, true);
  assert.equal(els['reset-form'].hidden, false);
  assert.equal(els['reset-new'].disabled, false);
  assert.equal(els['reset-submit'].disabled, false);
  assert.equal(els['reset-email'].value, 'owen@example.com');
  assert.equal(els['link-dead'].hidden, true);
  const sent = JSON.parse(fetchCalls[0].opts.body);
  assert.deepEqual(sent, { token_hash: 'HASH1', type: 'recovery' });
  assert.match(fetchCalls[0].url, /\/auth\/verify-recovery$/);
});

test('valid RESEND link is the same shape and also lands on the form', async () => {
  const { els } = loadPage({
    search: '?token_hash=HASH2&type=recovery',
    fetch: async () => okResponse({ access_token: 'jwt2', email: 'owen@example.com' }),
  });
  await settle();
  assert.equal(els['reset-form'].hidden, false);
  assert.equal(els['reset-new'].disabled, false);
});

test('used / expired link (400) -> "expired or already used" with Send me a new link, no spinner', async () => {
  const { els } = loadPage({
    search: '?token_hash=OLD&type=recovery',
    fetch: async () => errResponse(400, { error: 'This reset link is invalid or expired. Request a new one.' }),
  });
  await settle();
  expectDead(els, 'expired', { resend: true, retry: false });
  assert.match(els['link-dead-title'].textContent, /expired or was already used/);
  assert.match(els['link-dead-body'].textContent, /only the newest one works/);
});

test('network failure (fetch rejects) -> "couldn’t reach" with Try again AND resend', async () => {
  const { els } = loadPage({
    search: '?token_hash=HASH&type=recovery',
    fetch: async () => { throw new TypeError('Failed to fetch'); },
  });
  await settle();
  expectDead(els, 'network', { resend: true, retry: true });
  assert.match(els['link-dead-title'].textContent, /Couldn.t check your link/);
});

test('server never answers -> request aborted after the timeout, "taking too long", Try again + resend', async () => {
  let aborted = false;
  const { els } = loadPage({
    search: '?token_hash=HASH&type=recovery',
    verifyTimeoutMs: 40,
    fetch: (url, opts) => new Promise((resolve, reject) => {
      opts.signal.addEventListener('abort', () => { aborted = true; reject(new Error('AbortError')); });
    }),
  });
  await settle(10);
  assert.equal(els['link-checking'].hidden, false, 'still checking before the deadline');
  await settle(80);
  assert.equal(aborted, true, 'fetch was aborted');
  expectDead(els, 'timeout', { resend: true, retry: true });
  assert.match(els['link-dead-body'].textContent, /We waited \d+ seconds/);
});

test('Try again re-runs the same check and can succeed', async () => {
  let n = 0;
  const { els, fetchCalls } = loadPage({
    search: '?token_hash=HASH&type=recovery',
    fetch: async () => { n += 1; if (n === 1) throw new Error('offline'); return okResponse({ access_token: 'jwt', email: 'o@x.com' }); },
  });
  await settle();
  expectDead(els, 'network', { resend: true, retry: true });
  els['link-retry'].dispatch('click');
  await settle();
  assert.equal(fetchCalls.length, 2);
  assert.equal(els['reset-form'].hidden, false);
  assert.equal(els['reset-new'].disabled, false);
});

test('5xx from the backend is "couldn’t reach" (not expired); 429 is "too many attempts"', async () => {
  const a = loadPage({ search: '?token_hash=H&type=recovery', fetch: async () => errResponse(503, { error: 'slow' }) });
  await settle();
  expectDead(a.els, 'network', { resend: true, retry: true });

  const b = loadPage({ search: '?token_hash=H&type=recovery', fetch: async () => errResponse(429, { error: 'Too many attempts' }) });
  await settle();
  expectDead(b.els, 'busy', { resend: false, retry: true });
});

test('Supabase redirect-style failure in the query (?error_code=otp_expired) -> expired, no request made', async () => {
  const { els, fetchCalls } = loadPage({
    search: '?error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired',
    fetch: async () => okResponse({}),
  });
  await settle();
  expectDead(els, 'expired', { resend: true, retry: false });
  assert.equal(fetchCalls.length, 0);
});

test('other link shapes never hang: type=invite token_hash verifies as invite; legacy #access_token (any type) is accepted; PKCE ?code= is "incomplete"', async () => {
  const inv = loadPage({ search: '?token_hash=H&type=invite', fetch: async () => okResponse({ access_token: 'jwt', email: 'o@x.com' }) });
  await settle();
  assert.equal(JSON.parse(inv.fetchCalls[0].opts.body).type, 'invite');
  assert.equal(inv.els['reset-form'].hidden, false);

  const payload = Buffer.from(JSON.stringify({ email: 'o@x.com', exp: Math.floor(Date.now() / 1000) + 600 })).toString('base64url');
  const legacy = loadPage({ hash: `#access_token=h.${payload}.s&type=invite`, fetch: async () => okResponse({}) });
  await settle();
  assert.equal(legacy.fetchCalls.length, 0);
  assert.equal(legacy.els['reset-form'].hidden, false);
  assert.equal(legacy.els['reset-email'].value, 'o@x.com');

  const pkce = loadPage({ search: '?code=abc123', fetch: async () => okResponse({}) });
  await settle();
  expectDead(pkce.els, 'missing', { resend: true, retry: false });

  const none = loadPage({ fetch: async () => okResponse({}) });
  await settle();
  expectDead(none.els, 'missing', { resend: true, retry: false });
});

test('the script throwing during init (markup mismatch) -> error takeover, never a spinner', async () => {
  // A stale/mismatched page where the password field is missing makes init
  // throw at newInput.addEventListener — the exact kind of silent failure
  // that used to leave "Checking your link" on screen forever.
  const { els, win } = loadPage({ search: '?token_hash=H&type=recovery', missing: ['reset-new'], fetch: async () => okResponse({}) });
  await settle();
  assert.equal(win.__resetPageInitDone, true, 'watchdog told the script started');
  assert.equal(els['link-checking'].hidden, true);
  assert.equal(els['reset-form'].hidden, true);
  assert.equal(els['link-dead'].hidden, false);
  assert.equal(els['link-dead'].dataset.kind, 'error');
  assert.match(els['link-dead-body'].textContent, /regular browser/);
});

test('reset-password.html uses only root-absolute asset paths and no <base> (CSP base-uri none); nested email URL 301s to it', () => {
  assert.doesNotMatch(PAGE_HTML, /<base\s/i, 'no <base> tag: the CSP base-uri none makes it a no-op');
  const refs = Array.from(PAGE_HTML.matchAll(/\s(?:href|src)="([^"]+)"/g)).map((m) => m[1]);
  const local = refs.filter((r) => !/^(https?:)?\/\//.test(r) && !r.startsWith('#'));
  assert.ok(local.length >= 8, 'found the local asset refs');
  for (const r of local) assert.ok(r.startsWith('/'), `asset ref must be root-absolute: ${r}`);
  const redirects = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', '_redirects'), 'utf8');
  assert.match(redirects, /^\/auth\/reset-password-page\s+\/reset-password\.html\s+301\s*$/m);
});

test('inline watchdog exists in the HTML, is ES5, and keys off the same ready flag', () => {
  const idx = PAGE_HTML.indexOf('__resetPageInitDone');
  assert.ok(idx > 0, 'watchdog references __resetPageInitDone');
  const watchdog = PAGE_HTML.slice(PAGE_HTML.lastIndexOf('<script>'), PAGE_HTML.lastIndexOf('</script>'));
  assert.match(watchdog, /setTimeout\(function/);
  assert.doesNotMatch(watchdog, /=>|\blet\b|\bconst\b|`/, 'watchdog must stay ES5 so it runs where the main script cannot');
  assert.match(watchdog, /10000\)/);
  assert.match(PAGE_JS, /window\.__resetPageInitDone = true/);
});
