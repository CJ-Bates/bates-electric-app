// Brevo delivery-events webhook (routes/email-events.js) — offline unit tests
// through the real shipped route handler. Contract under test:
//   - no/-wrong secret is rejected (fail closed, incl. unset env),
//   - a delivered/bounce event stamps the matching row by provider message id,
//   - a transient event never overwrites a terminal delivery status,
//   - unknown message ids and handler errors still answer 200 (no Brevo
//     retry storms), and engagement events are ignored.
require('./helpers/env');

const test = require('node:test');
const assert = require('node:assert/strict');

const { installMockSupabase } = require('./helpers/mockSupabase');
const { getRouteHandler, makeReq, makeRes } = require('./helpers/routeHandler');

const emailEventsRouter = require('../routes/email-events');
const handler = getRouteHandler(emailEventsRouter, 'post', '/events');

const SECRET = 'test-webhook-secret';
const MSG_ID = '<202607301200.777@smtp-relay.mailin.fr>';

let restoreSupabase;
test.beforeEach(() => { process.env.EMAIL_WEBHOOK_SECRET = SECRET; });
test.afterEach(() => {
  if (restoreSupabase) { restoreSupabase(); restoreSupabase = undefined; }
  delete process.env.EMAIL_WEBHOOK_SECRET;
});

// existingStatus: current delivery_status of the matched row (undefined = no match)
function world({ existingStatus = null, found = true } = {}) {
  const w = { updates: [], selects: 0 };
  restoreSupabase = installMockSupabase({
    generator_email_messages: (chain) => {
      const upd = chain.find((c) => c.method === 'update');
      if (upd) {
        w.updates.push({ patch: upd.args[0], chain });
        return { data: null, error: null };
      }
      w.selects += 1;
      return { data: found ? [{ id: 'row-1', delivery_status: existingStatus }] : [], error: null };
    },
  });
  return w;
}

function eventReq(body, { secret = SECRET, viaQuery = false } = {}) {
  const req = makeReq({ body, query: viaQuery && secret ? { secret } : {} });
  req.headers = viaQuery ? {} : (secret ? { 'x-webhook-secret': secret } : {});
  return req;
}

test('rejects a POST with no secret', async () => {
  const w = world();
  const res = makeRes();
  await handler(eventReq({ event: 'delivered', 'message-id': MSG_ID }, { secret: null }), res);
  assert.equal(res.statusCode, 403);
  assert.equal(w.selects, 0, 'no DB access before auth');
});

test('rejects a wrong secret', async () => {
  const w = world();
  const res = makeRes();
  await handler(eventReq({ event: 'delivered', 'message-id': MSG_ID }, { secret: 'nope' }), res);
  assert.equal(res.statusCode, 403);
  assert.equal(w.selects, 0);
});

test('fails closed when EMAIL_WEBHOOK_SECRET is not configured', async () => {
  delete process.env.EMAIL_WEBHOOK_SECRET;
  const w = world();
  const res = makeRes();
  await handler(eventReq({ event: 'delivered', 'message-id': MSG_ID }), res);
  assert.equal(res.statusCode, 403);
  assert.equal(w.selects, 0);
});

test('accepts the secret via ?secret= query (Brevo config can only set a URL)', async () => {
  const w = world();
  const res = makeRes();
  await handler(eventReq({ event: 'delivered', 'message-id': MSG_ID }, { viaQuery: true }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(w.updates.length, 1);
});

test('a delivered event stamps the matching row', async () => {
  const w = world();
  const res = makeRes();
  await handler(eventReq({ event: 'delivered', 'message-id': MSG_ID, email: 'bill@example.com', date: '2026-07-30 10:00:00' }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true });
  assert.equal(w.updates.length, 1);
  assert.equal(w.updates[0].patch.delivery_status, 'delivered');
  assert.ok(w.updates[0].patch.delivery_at, 'delivery_at is stamped');
  // Update must target the matched row id, not the provider id.
  const eq = w.updates[0].chain.find((c) => c.method === 'eq');
  assert.deepEqual(eq.args, ['id', 'row-1']);
});

test('a hard bounce stamps status + scrubbed reason', async () => {
  const w = world();
  const res = makeRes();
  await handler(eventReq({
    event: 'hard_bounce', 'message-id': MSG_ID,
    reason: 'mailbox does not exist (token=abc should never persist)',
  }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(w.updates[0].patch.delivery_status, 'hard_bounce');
  assert.match(w.updates[0].patch.delivery_detail, /mailbox does not exist/);
  assert.ok(!w.updates[0].patch.delivery_detail.includes('abc'), 'token scrubbed from detail');
});

test('a transient event never downgrades a terminal status', async () => {
  const w = world({ existingStatus: 'delivered' });
  const res = makeRes();
  await handler(eventReq({ event: 'deferred', 'message-id': MSG_ID }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(w.updates.length, 0, 'delivered must not become deferred');
});

test('a spam complaint DOES overwrite delivered (real information)', async () => {
  const w = world({ existingStatus: 'delivered' });
  const res = makeRes();
  await handler(eventReq({ event: 'spam', 'message-id': MSG_ID }), res);
  assert.equal(w.updates.length, 1);
  assert.equal(w.updates[0].patch.delivery_status, 'spam');
});

test('an unknown message id answers 200 with no update (never a Brevo retry storm)', async () => {
  const w = world({ found: false });
  const res = makeRes();
  await handler(eventReq({ event: 'delivered', 'message-id': '<stranger@elsewhere>' }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true });
  assert.equal(w.updates.length, 0);
});

test('engagement events (opened/click/request) are acknowledged without DB access', async () => {
  const w = world();
  for (const event of ['request', 'click', 'opened', 'unique_opened']) {
    const res = makeRes();
    await handler(eventReq({ event, 'message-id': MSG_ID }), res);
    assert.equal(res.statusCode, 200);
  }
  assert.equal(w.selects, 0);
  assert.equal(w.updates.length, 0);
});

test('a handler error still answers 200', async () => {
  restoreSupabase = installMockSupabase({}); // any table access throws
  const res = makeRes();
  await handler(eventReq({ event: 'delivered', 'message-id': MSG_ID }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true });
});
