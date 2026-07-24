// Tests for the global per-request timeout (middleware/request-timeout.js): a
// request that never finishes is answered 503 so it can't wedge a worker, a
// normal request is untouched, and exempt paths (webhook/cron) never get a
// timer at all.
require('./helpers/env');

const test = require('node:test');
const assert = require('node:assert/strict');

const { createRequestTimeout } = require('../middleware/request-timeout');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Minimal fake res that emits 'finish' when a response is sent, mirroring the
// signals the real middleware listens on to clear its timer.
function makeFakeRes() {
  const handlers = {};
  const res = { statusCode: 200, body: undefined, headersSent: false };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => {
    res.body = b;
    res.headersSent = true;
    (handlers.finish || []).forEach((f) => f());
    return res;
  };
  res.on = (ev, cb) => { (handlers[ev] = handlers[ev] || []).push(cb); return res; };
  return res;
}

test('a request that never responds is answered 503 after the ceiling', async () => {
  const mw = createRequestTimeout({ ms: 40 });
  const req = { path: '/api/generator-care/accounting/payouts', method: 'GET', originalUrl: '/api/generator-care/accounting/payouts' };
  const res = makeFakeRes();
  let nextCalled = false;
  mw(req, res, () => { nextCalled = true; }); // handler intentionally never responds
  assert.ok(nextCalled, 'middleware must pass control on to the handler');
  await delay(90);
  assert.equal(res.statusCode, 503);
  assert.deepEqual(res.body, { error: 'Request timed out' });
});

test('a normal request that responds in time is left untouched', async () => {
  const mw = createRequestTimeout({ ms: 40 });
  const req = { path: '/api/generator-care/subscriptions', method: 'GET', originalUrl: '/api/generator-care/subscriptions' };
  const res = makeFakeRes();
  mw(req, res, () => { res.status(200).json({ ok: true }); }); // responds immediately
  await delay(90);
  assert.equal(res.statusCode, 200, 'the 503 timer must not override a completed response');
  assert.deepEqual(res.body, { ok: true });
});

test('exempt paths (cron/webhook) never get a timeout', async () => {
  const mw = createRequestTimeout({ ms: 40, exempt: [/^\/webhooks\/stripe/, /^\/api\/cron\//] });
  const req = { path: '/api/cron/generator-care/daily-digest', method: 'POST', originalUrl: '/api/cron/generator-care/daily-digest' };
  const res = makeFakeRes();
  let nextCalled = false;
  mw(req, res, () => { nextCalled = true; }); // long-running cron, never responds in window
  assert.ok(nextCalled);
  await delay(90);
  assert.equal(res.statusCode, 200, 'an exempt path must never be aborted with 503');
});
