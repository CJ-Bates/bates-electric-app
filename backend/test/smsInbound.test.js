// routes/sms-inbound.js — the SimpleTexting webhook. Offline unit tests via
// the real shipped handlers (getRouteHandler bypasses the rate limiter only;
// the shared-secret check runs inside the handler and IS exercised here).
// Covers the reply router the launch plan verifies: Y confirms the right
// visit, STOP flips consent, HELP is log-only, anything else becomes a
// reschedule flag — and unmatched numbers (shared account!) get no reply.
require('./helpers/env');

const test = require('node:test');
const assert = require('node:assert/strict');

const { installMockSupabase } = require('./helpers/mockSupabase');
const { getRouteHandler, makeReq, makeRes } = require('./helpers/routeHandler');
const router = require('../routes/sms-inbound');
const { classifyReply } = require('../routes/sms-inbound')._test;

const postHandler = getRouteHandler(router, 'post', '/inbound');
const getHandler = getRouteHandler(router, 'get', '/inbound');

const CUSTOMER_ID = 'c0000000-0000-4000-8000-000000000001';
const VISIT_ID = 'a0000000-0000-4000-8000-000000000002';
const SECRET = 'test-webhook-secret';

let restoreSupabase;
let realFetch;
test.beforeEach(() => {
  process.env.SMS_WEBHOOK_SECRET = SECRET;
  // No send may escape these tests: SMS_ENABLED stays unset (replies get
  // logged as 'disabled') and any non-Brevo fetch is a failure.
  realFetch = global.fetch;
  global.fetch = async (url) => { throw new Error('unexpected fetch in offline test: ' + url); };
});
test.afterEach(() => {
  delete process.env.SMS_WEBHOOK_SECRET;
  if (restoreSupabase) { restoreSupabase(); restoreSupabase = undefined; }
  if (realFetch) { global.fetch = realFetch; realFetch = undefined; }
});

// ---------------------------------------------------------------------------
// classifyReply — the parser the launch plan says to unit-test
// ---------------------------------------------------------------------------
test('classifyReply: Y/YES variants confirm; keywords route; anything else is a reschedule intent', () => {
  assert.equal(classifyReply('Y'), 'confirm');
  assert.equal(classifyReply('y'), 'confirm');
  assert.equal(classifyReply(' YES '), 'confirm');
  assert.equal(classifyReply('Yes!'), 'confirm');
  assert.equal(classifyReply('y.'), 'confirm');
  assert.equal(classifyReply('STOP'), 'stop');
  assert.equal(classifyReply('unsubscribe'), 'stop');
  assert.equal(classifyReply('Quit'), 'stop');
  assert.equal(classifyReply('START'), 'start');
  assert.equal(classifyReply('help'), 'help');
  assert.equal(classifyReply(''), 'empty');
  assert.equal(classifyReply('   '), 'empty');
  assert.equal(classifyReply('Can we do Friday instead?'), 'other');
  assert.equal(classifyReply('Yes, but can it be later'), 'other', 'a sentence is not a bare Y — office should look');
  assert.equal(classifyReply('yellow'), 'other', 'Y must match the whole word, not a prefix');
});

// ---------------------------------------------------------------------------
// Shared-secret gate
// ---------------------------------------------------------------------------
test('webhook rejects a wrong or missing secret, and fails closed when unconfigured', async () => {
  restoreSupabase = installMockSupabase({}); // nothing may be touched

  let res = makeRes();
  await postHandler(makeReq({ query: { secret: 'wrong' }, body: {} }), res);
  assert.equal(res.statusCode, 403);

  res = makeRes();
  await postHandler(makeReq({ query: {}, body: {} }), res);
  assert.equal(res.statusCode, 403);

  delete process.env.SMS_WEBHOOK_SECRET;
  res = makeRes();
  await postHandler(makeReq({ query: { secret: '' }, body: {} }), res);
  assert.equal(res.statusCode, 403, 'unset env must reject everything, never allow');
});

// ---------------------------------------------------------------------------
// Mock world: one consented customer with one upcoming unconfirmed visit.
// ---------------------------------------------------------------------------
function makeWorld({ consentRows } = {}) {
  const world = {
    logged: [],           // generator_sms_messages inserts
    visitUpdates: [],     // generator_service_visits updates
    consentUpdates: [],   // generator_sms_consent updates
  };
  restoreSupabase = installMockSupabase({
    generator_sms_consent: (chain) => {
      const upd = chain.find((c) => c.method === 'update');
      if (upd) { world.consentUpdates.push({ patch: upd.args[0], chain }); return { data: [{ id: 'cons1' }], error: null }; }
      return {
        data: consentRows !== undefined ? consentRows : [{
          id: 'cons1', customer_id: CUSTOMER_ID, opted_in: true, opted_out: false,
          customer: { id: CUSTOMER_ID, name: 'Sarah Example', install_state: 'MO' },
        }],
        error: null,
      };
    },
    generator_sms_messages: (chain) => {
      const ins = chain.find((c) => c.method === 'insert');
      if (ins) world.logged.push(ins.args[0]);
      return { data: null, error: null };
    },
    generator_subscriptions: () => ({ data: [{ id: 'sub1' }], error: null }),
    generator_service_visits: (chain) => {
      const upd = chain.find((c) => c.method === 'update');
      if (upd) { world.visitUpdates.push(upd.args[0]); return { data: null, error: null }; }
      return {
        data: [{ id: VISIT_ID, subscription_id: 'sub1', appointment_at: '2026-08-12T13:00:00.000Z', arrival_window: '8-10', status: 'scheduled', sms_confirmed_at: null }],
        error: null,
      };
    },
  });
  return world;
}

function v2Body(text) {
  return {
    reportId: 'r1', webhookId: 'w1', type: 'INCOMING_MESSAGE',
    values: { messageId: 'm1', contactPhone: '6365550100', accountPhone: '8339425468', text },
  };
}

test('Y: stamps sms_confirmed_at on the next unconfirmed upcoming visit and replies copy (2)', async () => {
  const world = makeWorld();
  const res = makeRes();
  await postHandler(makeReq({ query: { secret: SECRET }, body: v2Body('Y') }), res);
  assert.equal(res.statusCode, 200);

  assert.equal(world.visitUpdates.length, 1);
  assert.ok(world.visitUpdates[0].sms_confirmed_at, 'visit must be stamped confirmed');

  const inbound = world.logged.find((l) => l.direction === 'in');
  assert.ok(inbound, 'inbound must be logged');
  assert.equal(inbound.from_phone, '+16365550100');
  assert.equal(inbound.customer_id, CUSTOMER_ID);

  // The reply went through sendSms with SMS_ENABLED unset -> logged 'disabled'
  // with the copy-(2) body; nothing hit the network (forbidden fetch).
  const reply = world.logged.find((l) => l.direction === 'out');
  assert.ok(reply, 'confirmation reply must be attempted (and logged)');
  assert.equal(reply.status, 'disabled');
  assert.ok(reply.body.includes("You're all set"), reply.body);
  assert.ok(reply.body.includes('Wed Aug 12, 8-10 AM'), reply.body);
  assert.equal(reply.related_visit_id, VISIT_ID);
});

test('Y with nothing to confirm: logged, no visit touched, no reply', async () => {
  const world = makeWorld();
  // Override: no upcoming visits.
  restoreSupabase();
  restoreSupabase = installMockSupabase({
    generator_sms_consent: () => ({ data: [{ id: 'cons1', customer_id: CUSTOMER_ID, opted_in: true, opted_out: false, customer: { id: CUSTOMER_ID, name: 'S', install_state: 'MO' } }], error: null }),
    generator_sms_messages: (chain) => { const ins = chain.find((c) => c.method === 'insert'); if (ins) world.logged.push(ins.args[0]); return { data: null, error: null }; },
    generator_subscriptions: () => ({ data: [{ id: 'sub1' }], error: null }),
    generator_service_visits: () => ({ data: [], error: null }),
  });
  const res = makeRes();
  await postHandler(makeReq({ query: { secret: SECRET }, body: v2Body('YES') }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(world.logged.filter((l) => l.direction === 'out').length, 0, 'no reply without a visit to confirm');
});

test('STOP: flips opted_out on the consent rows; no reply from us (platform sends copy 8)', async () => {
  const world = makeWorld();
  const res = makeRes();
  await postHandler(makeReq({ query: { secret: SECRET }, body: v2Body('STOP') }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(world.consentUpdates.length, 1);
  assert.equal(world.consentUpdates[0].patch.opted_out, true);
  assert.equal(world.logged.filter((l) => l.direction === 'out').length, 0);
  assert.equal(world.visitUpdates.length, 0);
});

test('UNSUBSCRIBE_REPORT (platform event): same opt-out flip, logged distinctly', async () => {
  const world = makeWorld();
  const res = makeRes();
  await postHandler(makeReq({
    query: { secret: SECRET },
    body: { reportId: 'r2', type: 'UNSUBSCRIBE_REPORT', values: { contactId: 'x', phone: '6365550100' } },
  }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(world.consentUpdates.length, 1);
  assert.equal(world.consentUpdates[0].patch.opted_out, true);
  const row = world.logged.find((l) => l.direction === 'in');
  assert.ok(row && row.body.includes('UNSUBSCRIBE_REPORT'));
});

test('HELP: logged only — platform auto-replies, we send nothing', async () => {
  const world = makeWorld();
  const res = makeRes();
  await postHandler(makeReq({ query: { secret: SECRET }, body: v2Body('HELP') }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(world.logged.filter((l) => l.direction === 'out').length, 0);
  assert.equal(world.visitUpdates.length, 0);
});

test('anything else: reschedule reply (copy 5) attempted + visit NEVER auto-changed', async () => {
  const world = makeWorld();
  const res = makeRes();
  await postHandler(makeReq({ query: { secret: SECRET }, body: v2Body('Could we do next Friday afternoon?') }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(world.visitUpdates.length, 0, 'the appointment must not change');
  const reply = world.logged.find((l) => l.direction === 'out');
  assert.ok(reply, 'reschedule-link reply must be attempted (and logged)');
  assert.ok(reply.body.includes('No problem'), reply.body);
  assert.ok(reply.body.includes('app.bates-electric.com/my'), reply.body);
});

test('unmatched number (shared SimpleTexting account): logged as unmatched, no reply, nothing written', async () => {
  const world = makeWorld({ consentRows: [] });
  const res = makeRes();
  await postHandler(makeReq({ query: { secret: SECRET }, body: v2Body('Y') }), res);
  assert.equal(res.statusCode, 200);
  const inbound = world.logged.find((l) => l.direction === 'in');
  assert.ok(inbound && inbound.detail.includes('unmatched'), 'must record that it was not ours');
  assert.equal(world.logged.filter((l) => l.direction === 'out').length, 0, 'never reply to someone else\'s conversation');
  assert.equal(world.visitUpdates.length, 0);
  assert.equal(world.consentUpdates.length, 0);
});

test('classic GET forwarding (?from&to&text) routes through the same logic', async () => {
  const world = makeWorld();
  const res = makeRes();
  await getHandler(makeReq({ query: { secret: SECRET, from: '(636) 555-0100', to: '8339425468', text: 'y' } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(world.visitUpdates.length, 1, 'GET Y must confirm the visit too');
});
