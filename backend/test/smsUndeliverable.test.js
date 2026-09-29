// SimpleTexting INVALID_CONTACT ("Contact marked as invalid") — fully offline.
// Live incident 2026-09-29: a booking confirmation to a number SimpleTexting
// had marked invalid 409'd, was logged as the TRANSIENT 'failed', and so was
// re-sent — and re-alerted — by the hourly sms-reminders sweep. Covers:
//   - the 409 is a handled outcome: status 'undeliverable' (terminal), ZERO
//     reportError calls, exactly one warning carrying the customer id + the
//     last 4 digits (never the full number), and the customer is flagged
//   - a flagged number is refused before the network on every later send
//   - the flag follows the NUMBER: a different phone sends normally
//   - the incident replay: the sweep drains the queue on the first run and
//     never re-attempts
//   - every other provider failure (auth, 5xx, rate limit, a different 409,
//     a non-JSON 409) still alerts and stays retryable
//   - the office contact edit clears the flag when the number changes, and
//     only then
//
// reportError is destructured by lib/sms.js at require time, so this file
// plants a counting stub in the require cache BEFORE anything loads it (same
// approach as sms-contact-409.test.js; node --test gives each file its own
// process).
require('./helpers/env');

const test = require('node:test');
const assert = require('node:assert/strict');

const reporterPath = require.resolve('../middleware/error-reporter');
const reportErrorCalls = [];
require.cache[reporterPath] = {
  id: reporterPath,
  filename: reporterPath,
  loaded: true,
  exports: {
    reportError: async (err, context) => { reportErrorCalls.push({ err, context }); },
    errorReporter: (err, req, res, next) => next(err),
    initSentry: () => null,
  },
};

const { installMockSupabase } = require('./helpers/mockSupabase');
const { getRouteHandler, makeReq, makeRes } = require('./helpers/routeHandler');
const sms = require('../lib/sms');
const cronRouter = require('../routes/generator-care-cron');
const subscriptionsRouter = require('../routes/generator-care/subscriptions');
const { runBookingConfirmRetryPass } = cronRouter._test;
const patchCustomerHandler = getRouteHandler(subscriptionsRouter, 'patch', '/customers/:id');

const CUSTOMER_ID = 'c0000000-0000-4000-8000-000000000001';
const SUB_ID = 's0000000-0000-4000-8000-000000000001';
const PHONE = '3145550100';
const PHONE_E164 = '+13145550100';
const NOW = new Date('2026-09-29T16:15:00Z'); // 11:15am CDT — the hourly sweep

// The exact body SimpleTexting returned in the live incident.
const INVALID_CONTACT_BODY = JSON.stringify({
  status: 'CONFLICT',
  errorCode: 'INVALID_CONTACT',
  code: 'INVALID_CONTACT',
  message: 'Contact marked as invalid',
});

let restoreSupabase;
let realFetch;
let realWarn;
let warnings;
test.beforeEach(() => {
  reportErrorCalls.length = 0;
  warnings = [];
  realWarn = console.warn;
  console.warn = (...args) => { warnings.push(args.join(' ')); };
  process.env.SMS_ENABLED = 'true';
  process.env.SIMPLETEXTING_API_TOKEN = 'tok_secret';
  process.env.SIMPLETEXTING_ACCOUNT_PHONE = '8339425468';
});
test.afterEach(() => {
  console.warn = realWarn;
  if (restoreSupabase) { restoreSupabase(); restoreSupabase = undefined; }
  if (realFetch) { global.fetch = realFetch; realFetch = undefined; }
  delete process.env.SMS_ENABLED;
  delete process.env.SIMPLETEXTING_API_TOKEN;
  delete process.env.SIMPLETEXTING_ACCOUNT_PHONE;
});

// Provider answers every send with one scripted response; counts the calls.
function provider(status, body) {
  const wire = { calls: 0 };
  realFetch = global.fetch;
  global.fetch = async () => {
    wire.calls++;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => JSON.parse(body || '{}'),
      text: async () => body || '',
    };
  };
  return wire;
}

function forbidFetch() {
  realFetch = global.fetch;
  global.fetch = async (url) => { throw new Error('unexpected fetch in offline test: ' + url); };
}

// In-memory customers + visits, so a flag written by one send is what the
// next send (and the next sweep) reads back.
function makeWorld({ customer, visits, customersError } = {}) {
  const world = {
    customers: [{ id: CUSTOMER_ID, name: 'Marie Example', phone: PHONE, install_state: 'MO', sms_invalid_at: null, sms_invalid_phone: null, ...(customer || {}) }],
    visits: visits || [],
    customerUpdates: [],
    logged: [],
  };
  restoreSupabase = installMockSupabase({
    generator_customers: (chain) => {
      if (customersError) return { data: null, error: { message: customersError } };
      const idEq = chain.find((c) => c.method === 'eq' && c.args[0] === 'id');
      const row = world.customers.find((c) => c.id === (idEq && idEq.args[1])) || null;
      const upd = chain.find((c) => c.method === 'update');
      if (upd) {
        if (row) Object.assign(row, upd.args[0]);
        world.customerUpdates.push(upd.args[0]);
      }
      return { data: row, error: null };
    },
    generator_service_visits: (chain) => {
      const upd = chain.find((c) => c.method === 'update');
      if (upd) {
        const idEq = chain.find((c) => c.method === 'eq' && c.args[0] === 'id');
        const visit = world.visits.find((v) => v.id === (idEq && idEq.args[1]));
        if (visit) Object.assign(visit, upd.args[0]);
        return { data: null, error: null };
      }
      let rows = world.visits.slice();
      for (const c of chain) {
        if (c.method === 'is' && c.args[1] === null) rows = rows.filter((r) => r[c.args[0]] == null);
        if (c.method === 'not' && c.args[1] === 'is' && c.args[2] === null) rows = rows.filter((r) => r[c.args[0]] != null);
        if (c.method === 'lt') rows = rows.filter((r) => r[c.args[0]] < c.args[1]);
      }
      // The join reads the customer as it is NOW (a changed phone included).
      return { data: rows.map((v) => ({ ...v, subscription: { id: SUB_ID, customer: world.customers[0] } })), error: null };
    },
    generator_sms_consent: () => ({ data: [{ id: 'cons1', customer_id: CUSTOMER_ID, opted_in: true, opted_out: false }], error: null }),
    generator_sms_messages: (chain) => {
      const ins = chain.find((c) => c.method === 'insert');
      if (ins) world.logged.push(ins.args[0]);
      return { data: [], error: null };
    },
  });
  return world;
}

const send = (extra = {}) => sms.sendSms({ toPhone: PHONE, body: 'your visit is set', customerId: CUSTOMER_ID, now: NOW, ...extra });

// ---------------------------------------------------------------------------
// The 409 itself
// ---------------------------------------------------------------------------
test('INVALID_CONTACT: handled quietly - undeliverable, no alert, one warning, customer flagged', async () => {
  const world = makeWorld();
  const wire = provider(409, INVALID_CONTACT_BODY);

  const r = await send();

  assert.equal(r.sent, false);
  assert.equal(r.status, 'undeliverable');
  assert.equal(wire.calls, 1);
  assert.equal(reportErrorCalls.length, 0, 'no backend-error alert for an invalid contact');

  assert.equal(warnings.length, 1, 'exactly one warning line');
  assert.ok(warnings[0].includes(CUSTOMER_ID), warnings[0]);
  assert.ok(warnings[0].includes('phone ending 0100'), warnings[0]);
  assert.ok(!warnings[0].includes(PHONE), 'never the full number in the warning');

  assert.deepEqual(world.customerUpdates, [{ sms_invalid_at: NOW.toISOString(), sms_invalid_phone: PHONE_E164 }]);

  assert.equal(world.logged.length, 1, 'the attempt is still on the office record');
  assert.equal(world.logged[0].status, 'undeliverable');
  assert.ok(world.logged[0].detail.includes('INVALID_CONTACT'), world.logged[0].detail);
});

test('undeliverable is a TERMINAL status - queued messages drain instead of retrying', () => {
  assert.ok(sms.SMS_TERMINAL_STATUSES.includes('undeliverable'));
  assert.ok(!sms.SMS_TERMINAL_STATUSES.includes('failed'), 'real failures stay retryable');
});

test('INVALID_CONTACT with no customer id: still quiet and terminal, nothing to flag', async () => {
  const world = makeWorld();
  provider(409, INVALID_CONTACT_BODY);

  const r = await sms.sendSms({ toPhone: PHONE, body: 'x', now: NOW });

  assert.equal(r.status, 'undeliverable');
  assert.equal(reportErrorCalls.length, 0);
  assert.equal(world.customerUpdates.length, 0);
  assert.equal(warnings.length, 1);
});

test('a flag write that fails IS reported - the send outcome stays undeliverable', async () => {
  makeWorld();
  restoreSupabase();
  restoreSupabase = installMockSupabase({
    generator_customers: (chain) => (chain.find((c) => c.method === 'update')
      ? { data: null, error: { message: 'column "sms_invalid_at" does not exist' } }
      : { data: null, error: null }),
    generator_sms_consent: () => ({ data: [{ opted_in: true, opted_out: false }], error: null }),
    generator_sms_messages: () => ({ data: null, error: null }),
  });
  provider(409, INVALID_CONTACT_BODY);

  const r = await send();

  assert.equal(r.status, 'undeliverable');
  assert.equal(reportErrorCalls.length, 1);
  assert.equal(reportErrorCalls[0].context.route, 'lib/sms flagUndeliverable');
  assert.ok(!reportErrorCalls[0].err.message.includes(PHONE), 'no full number in the alert');
});

// ---------------------------------------------------------------------------
// The flag gates later sends
// ---------------------------------------------------------------------------
test('a flagged number is refused before the network, with no warning and no alert', async () => {
  const world = makeWorld({ customer: { sms_invalid_at: '2026-09-29T15:11:35.000Z', sms_invalid_phone: PHONE_E164 } });
  forbidFetch();

  const r = await send();

  assert.equal(r.status, 'undeliverable');
  assert.equal(world.logged.length, 1);
  assert.equal(world.logged[0].status, 'undeliverable');
  assert.equal(warnings.length, 0);
  assert.equal(reportErrorCalls.length, 0);
});

test('the flag outranks the kill-switch and quiet hours (a permanent answer, so the queue drains)', async () => {
  makeWorld({ customer: { sms_invalid_at: '2026-09-29T15:11:35.000Z', sms_invalid_phone: PHONE_E164 } });
  forbidFetch();
  delete process.env.SMS_ENABLED;

  const r = await send({ now: new Date('2026-09-29T09:00:00Z') }); // 4am CDT

  assert.equal(r.status, 'undeliverable');
});

test('the flag follows the number: a different phone on the same customer sends normally', async () => {
  const world = makeWorld({ customer: { phone: '3145550199', sms_invalid_at: '2026-09-29T15:11:35.000Z', sms_invalid_phone: PHONE_E164 } });
  const wire = provider(201, '{"id":"prov_9"}');

  const r = await send({ toPhone: '3145550199' });

  assert.equal(r.sent, true);
  assert.equal(wire.calls, 1);
  assert.equal(world.logged[0].status, 'sent');
});

test('a normal valid SMS still sends (unflagged customer)', async () => {
  const world = makeWorld();
  const wire = provider(201, '{"id":"prov_1"}');

  const r = await send();

  assert.equal(r.sent, true);
  assert.equal(r.status, 'sent');
  assert.equal(wire.calls, 1);
  assert.equal(world.customerUpdates.length, 0);
  assert.equal(reportErrorCalls.length, 0);
});

test('a flag lookup failure never blocks a text (fails open)', async () => {
  makeWorld({ customersError: 'connection reset' });
  const wire = provider(201, '{"id":"prov_1"}');

  const r = await send();

  assert.equal(r.sent, true);
  assert.equal(wire.calls, 1);
});

test('smsUndeliverableSince: applies only while the phone on file is the flagged one', () => {
  const flagged = { phone: '(314) 555-0100', sms_invalid_at: '2026-09-29T15:11:35.000Z', sms_invalid_phone: PHONE_E164 };
  assert.equal(sms.smsUndeliverableSince(flagged), '2026-09-29T15:11:35.000Z', 'formatting differences are the same number');
  assert.equal(sms.smsUndeliverableSince({ ...flagged, phone: '3145550199' }), null, 'number changed by any path');
  assert.equal(sms.smsUndeliverableSince({ phone: PHONE, sms_invalid_at: null, sms_invalid_phone: null }), null);
  assert.equal(sms.smsUndeliverableSince(null), null);
});

test('operator reply eligibility: a flagged number is blocked with its own reason', async () => {
  makeWorld({ customer: { sms_invalid_at: '2026-09-29T15:11:35.000Z', sms_invalid_phone: PHONE_E164 } });
  const e = await sms.operatorReplyEligibility({ phone: PHONE, customerId: CUSTOMER_ID, now: NOW });
  assert.equal(e.allowed, false);
  assert.equal(e.reason, 'undeliverable');
});

// ---------------------------------------------------------------------------
// Real failures stay loud and retryable
// ---------------------------------------------------------------------------
for (const c of [
  { name: 'auth error (401)', status: 401, body: '{"status":"UNAUTHORIZED","message":"bad token"}' },
  { name: 'outage (500)', status: 500, body: 'provider down' },
  { name: 'bad gateway (502)', status: 502, body: '' },
  { name: 'rate limit (429)', status: 429, body: '{"status":"TOO_MANY_REQUESTS"}' },
  { name: 'a 409 that means something else', status: 409, body: '{"status":"CONFLICT","errorCode":"SOMETHING_ELSE","message":"nope"}' },
  { name: 'a 409 with a non-JSON body', status: 409, body: 'INVALID_CONTACT' },
  { name: 'INVALID_CONTACT on a non-409 status', status: 400, body: INVALID_CONTACT_BODY },
]) {
  test('still alerts: ' + c.name, async () => {
    const world = makeWorld();
    provider(c.status, c.body);

    const r = await send();

    assert.equal(r.status, 'failed', 'transient - the sweep may retry it');
    assert.equal(reportErrorCalls.length, 1, 'real failures raise the alert');
    assert.equal(reportErrorCalls[0].context.route, 'lib/sms sendSms');
    assert.equal(world.customerUpdates.length, 0, 'the customer is not flagged');
    assert.equal(world.logged[0].status, 'failed');
  });
}

test('still alerts: the request itself failing (network error)', async () => {
  makeWorld();
  realFetch = global.fetch;
  global.fetch = async () => { throw new Error('ECONNRESET'); };

  const r = await send();

  assert.equal(r.status, 'failed');
  assert.equal(reportErrorCalls.length, 1);
});

// ---------------------------------------------------------------------------
// Incident replay: the hourly sweep
// ---------------------------------------------------------------------------
test('INCIDENT REPLAY: the sweep flags + settles on the first run and never re-sends', async () => {
  const world = makeWorld({
    visits: [{
      id: 'v1',
      status: 'scheduled',
      appointment_at: '2026-09-30T17:00:00Z',
      arrival_window: '12-2',
      booking_confirm_queued_at: '2026-09-29T15:11:34Z',
      booking_confirm_sent_at: null,
    }],
  });
  const wire = provider(409, INVALID_CONTACT_BODY);

  const first = await runBookingConfirmRetryPass({ now: NOW });
  assert.deepEqual(first, { considered: 1, sent: 0, skipped: 1, stale: 0 });
  assert.ok(world.visits[0].booking_confirm_sent_at, 'debt settled - out of the retry queue');
  assert.equal(world.customers[0].sms_invalid_phone, PHONE_E164, 'customer flagged');

  const nextHour = await runBookingConfirmRetryPass({ now: new Date('2026-09-29T17:15:00Z') });
  assert.deepEqual(nextHour, { considered: 0, sent: 0, skipped: 0, stale: 0 });

  assert.equal(wire.calls, 1, 'SimpleTexting was asked exactly once');
  assert.equal(warnings.length, 1);
  assert.equal(reportErrorCalls.length, 0);

  // Tomorrow's day-of reminder to the same number: refused from the flag.
  const later = await send({ now: new Date('2026-09-30T13:15:00Z') });
  assert.equal(later.status, 'undeliverable');
  assert.equal(wire.calls, 1, 'still only the one provider call');
  assert.equal(reportErrorCalls.length, 0);
});

// ---------------------------------------------------------------------------
// Office contact edit resets the flag
// ---------------------------------------------------------------------------
async function patchCustomer(body) {
  const res = makeRes();
  await patchCustomerHandler(makeReq({ params: { id: CUSTOMER_ID }, body }), res);
  return res;
}

test('contact edit: a changed number clears the flag, and texts go out again', async () => {
  const world = makeWorld({ customer: { sms_invalid_at: '2026-09-29T15:11:35.000Z', sms_invalid_phone: PHONE_E164 } });

  const res = await patchCustomer({ phone: '(314) 555-0199' });

  assert.equal(res.statusCode, 200);
  assert.equal(world.customers[0].phone, '(314) 555-0199');
  assert.equal(world.customers[0].sms_invalid_at, null);
  assert.equal(world.customers[0].sms_invalid_phone, null);
  assert.equal(sms.smsUndeliverableSince(world.customers[0]), null);

  const wire = provider(201, '{"id":"prov_2"}');
  const r = await send({ toPhone: world.customers[0].phone });
  assert.equal(r.sent, true);
  assert.equal(wire.calls, 1);
});

test('contact edit: re-saving the same number (any formatting) keeps the flag', async () => {
  const world = makeWorld({ customer: { sms_invalid_at: '2026-09-29T15:11:35.000Z', sms_invalid_phone: PHONE_E164 } });

  const res = await patchCustomer({ phone: '314-555-0100', name: 'Marie Example' });

  assert.equal(res.statusCode, 200);
  assert.equal(world.customers[0].sms_invalid_at, '2026-09-29T15:11:35.000Z');
  assert.ok(!('sms_invalid_at' in world.customerUpdates[0]), 'flag columns untouched');
});

test('contact edit: a save that does not touch the phone leaves the flag alone', async () => {
  const world = makeWorld({ customer: { sms_invalid_at: '2026-09-29T15:11:35.000Z', sms_invalid_phone: PHONE_E164 } });

  const res = await patchCustomer({ notes: 'called, left voicemail' });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(world.customerUpdates, [{ notes: 'called, left voicemail' }]);
  assert.equal(world.customers[0].sms_invalid_phone, PHONE_E164);
});
