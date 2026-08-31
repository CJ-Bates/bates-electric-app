// 035 queue-and-sweep for transiently refused customer texts — fully offline.
// Covers the spec's verify list:
//   - the office schedule endpoint QUEUES a booking confirmation before the
//     attempt and settles the debt only on a terminal sendSms result, so a
//     quiet-hours / kill-switch / provider refusal leaves it owed
//   - runBookingConfirmRetryPass drains the queue: Kenneth's exact case
//     (booked 7:58am for a next-day appointment, refused by quiet hours)
//     goes out at the first in-window sweep the SAME morning
//   - staleness: a confirmation whose appointment day passed (or whose visit
//     is no longer scheduled) is dropped ON RECORD ('stale' log row), never
//     sent late; same for reminders
//   - reminder retry sweeps re-select by queue mark (the date-anchored daily
//     pass can't), skip the target day (the daily pass owns it), and re-arm
//     instead of sending when the appointment was rescheduled outward
//   - idempotency: a double sweep run never re-sends
//
// Clock pinned to Mon 2026-08-31 8:15am CDT (13:15Z) — the first in-window
// hourly run on the morning of the real incident.
require('./helpers/env');

const test = require('node:test');
const assert = require('node:assert/strict');

const { installMockSupabase } = require('./helpers/mockSupabase');
const { getRouteHandler, makeReq, makeRes } = require('./helpers/routeHandler');
const visitsRouter = require('../routes/generator-care/visits');
const cronRouter = require('../routes/generator-care-cron');
const { runBookingConfirmRetryPass, runReminderRetryPass } = cronRouter._test;

const scheduleHandler = getRouteHandler(visitsRouter, 'post', '/visits/:id/schedule');
const smsRemindersHandler = getRouteHandler(cronRouter, 'post', '/sms-reminders');

const CUSTOMER_ID = 'c0000000-0000-4000-8000-000000000001';
const SUB_ID = 's0000000-0000-4000-8000-000000000001';

const NOW = new Date('2026-08-31T13:15:00Z'); // 8:15am CDT Mon Aug 31

let restoreSupabase;
let realFetch;
test.afterEach(() => {
  if (restoreSupabase) { restoreSupabase(); restoreSupabase = undefined; }
  if (realFetch) { global.fetch = realFetch; realFetch = undefined; }
  delete process.env.SMS_ENABLED;
  delete process.env.SIMPLETEXTING_API_TOKEN;
  delete process.env.SIMPLETEXTING_ACCOUNT_PHONE;
});

function armTransport() {
  process.env.SMS_ENABLED = 'true';
  process.env.SIMPLETEXTING_API_TOKEN = 'tok_secret';
  process.env.SIMPLETEXTING_ACCOUNT_PHONE = '8339425468';
}

function captureWire(world) {
  realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    world.texts.push(JSON.parse(opts.body).text);
    return { ok: true, status: 201, json: async () => ({ id: 'prov_1' }) };
  };
}

function forbidFetch() {
  realFetch = global.fetch;
  global.fetch = async (url) => { throw new Error('unexpected fetch in offline test: ' + url); };
}

// The schedule endpoint's send-and-stamp chain is fire-and-forget — drain
// the microtask/macrotask queue before asserting on its writes.
async function settle() {
  for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r));
}

// ---------------------------------------------------------------------------
// Mock world. The visits resolver replays the recorded query chain against an
// in-memory table (eq/neq/is/not-is/gte/lt), so the sweeps' own filters —
// queue mark set, sent stamp null, the in-flight buffer — do the selecting,
// and a stamped visit really disappears from the next run.
// ---------------------------------------------------------------------------
function makeWorld({ visits, consentRows } = {}) {
  const world = {
    visits: visits || [],
    stamps: [],   // { id, patch } for every generator_service_visits update
    logged: [],   // generator_sms_messages inserts
    texts: [],    // bodies that actually reached the wire
    prefUpdates: 0,
  };
  restoreSupabase = installMockSupabase({
    generator_service_visits: (chain, terminal) => {
      const upd = chain.find((c) => c.method === 'update');
      if (upd) {
        const idEq = chain.find((c) => c.method === 'eq' && c.args[0] === 'id');
        const visit = world.visits.find((v) => v.id === (idEq && idEq.args[1]));
        if (visit) Object.assign(visit, upd.args[0]);
        world.stamps.push({ id: idEq && idEq.args[1], patch: upd.args[0] });
        // The schedule endpoint's core update ends .select().maybeSingle()
        // and needs the joined row back; stamp updates resolve bare.
        const wantsRow = chain.some((c) => c.method === 'select');
        return { data: wantsRow ? visit : null, error: null };
      }
      let rows = world.visits.slice();
      for (const c of chain) {
        if (c.method === 'eq') rows = rows.filter((r) => r[c.args[0]] === c.args[1]);
        if (c.method === 'neq') rows = rows.filter((r) => r[c.args[0]] !== c.args[1]);
        if (c.method === 'is' && c.args[1] === null) rows = rows.filter((r) => r[c.args[0]] == null);
        if (c.method === 'not' && c.args[1] === 'is' && c.args[2] === null) rows = rows.filter((r) => r[c.args[0]] != null);
        if (c.method === 'gte') rows = rows.filter((r) => r[c.args[0]] >= c.args[1]);
        if (c.method === 'lt') rows = rows.filter((r) => r[c.args[0]] < c.args[1]);
      }
      if (terminal === 'maybeSingle' || terminal === 'single') return { data: rows[0] || null, error: null };
      return { data: rows, error: null };
    },
    generator_visit_preferences: (chain) => {
      if (chain.find((c) => c.method === 'update')) world.prefUpdates++;
      return { data: null, error: null };
    },
    generator_sms_consent: () => ({
      data: consentRows !== undefined ? consentRows : [{ id: 'cons1', customer_id: CUSTOMER_ID, opted_in: true, opted_out: false }],
      error: null,
    }),
    generator_sms_messages: (chain) => {
      const ins = chain.find((c) => c.method === 'insert');
      if (ins) world.logged.push(ins.args[0]);
      return { data: null, error: null };
    },
  });
  return world;
}

function makeCustomer(extra = {}) {
  return { id: CUSTOMER_ID, name: 'Kenneth Arnsmeyer', email: null, phone: '3145550100', install_state: 'MO', ...extra };
}

// A visit as the sweeps see it (flat row + subscription/customer join).
function makeVisit(id, extra = {}) {
  return {
    id,
    status: 'scheduled',
    appointment_at: null,
    arrival_window: '12-2',
    sms_confirmed_at: null,
    subscription_id: SUB_ID,
    booking_confirm_queued_at: null,
    booking_confirm_sent_at: null,
    sms_reminder_3day_at: null,
    sms_reminder_dayof_at: null,
    sms_reminder_3day_queued_at: null,
    sms_reminder_dayof_queued_at: null,
    subscription: { id: SUB_ID, plan: 'annual', customer: makeCustomer() },
    ...extra,
  };
}

function stampsWith(world, column) {
  return world.stamps.filter((s) => s.patch[column] !== undefined && s.patch[column] !== null);
}

// ---------------------------------------------------------------------------
// Office schedule endpoint: queue-then-send
// ---------------------------------------------------------------------------
test('booking queues the confirmation BEFORE the send; a transient refusal (kill-switch) leaves it owed', async () => {
  forbidFetch(); // SMS_ENABLED deliberately unset -> 'disabled', a transient refusal
  const world = makeWorld({ visits: [makeVisit('v1')] });

  const res = makeRes();
  await scheduleHandler(makeReq({ params: { id: 'v1' }, body: { appointment_at: '2026-09-01T17:00:00Z', arrival_window: '12-2' } }), res);
  await settle();

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true, 'a text hiccup never fails the booking');
  const queue = stampsWith(world, 'booking_confirm_queued_at');
  assert.equal(queue.length, 1, 'queued exactly once');
  assert.equal(queue[0].patch.booking_confirm_sent_at, null, 'the queue stamp re-arms sent_at (reschedule owes a fresh text)');
  assert.equal(world.visits[0].booking_confirm_sent_at, null, 'transient refusal does NOT settle the debt');
  assert.equal(world.logged[0].status, 'disabled', 'the refusal still lands in the message log');
});

test('booking: a terminal refusal (opted_out) settles the debt so the sweep never retries it', async () => {
  forbidFetch();
  armTransport();
  const world = makeWorld({
    visits: [makeVisit('v1')],
    consentRows: [{ id: 'cons1', customer_id: CUSTOMER_ID, opted_in: true, opted_out: true }],
  });

  const res = makeRes();
  await scheduleHandler(makeReq({ params: { id: 'v1' }, body: { appointment_at: '2026-09-01T17:00:00Z', arrival_window: '12-2' } }), res);
  await settle();

  assert.equal(res.body.ok, true);
  assert.ok(world.visits[0].booking_confirm_queued_at, 'still queued first');
  assert.ok(world.visits[0].booking_confirm_sent_at, 'permanent refusal stamps — opted_out is never retried');
  assert.equal(world.logged[0].status, 'opted_out');
});

// ---------------------------------------------------------------------------
// Booking-confirmation retry sweep
// ---------------------------------------------------------------------------
test('KENNETH REPRO: confirmation refused at 7:58am for a next-day visit goes out at the 8:15am sweep', async () => {
  armTransport();
  const world = makeWorld({
    visits: [makeVisit('v1', {
      appointment_at: '2026-09-01T17:00:00Z',           // noon CDT Tue Sep 1
      booking_confirm_queued_at: '2026-08-31T12:58:00Z', // booked 7:58am CDT, refused by quiet hours
    })],
  });
  captureWire(world);

  const r = await runBookingConfirmRetryPass({ now: NOW });
  assert.deepEqual(r, { considered: 1, sent: 1, skipped: 0, stale: 0 });
  assert.ok(world.texts[0].includes('your generator maintenance visit is set for Tue Sep 1, arriving 12-2 PM'), world.texts[0]);
  assert.ok(world.texts[0].includes('Reply Y to confirm'), world.texts[0]);
  assert.ok(world.visits[0].booking_confirm_sent_at, 'debt settled');
});

test('sweep is idempotent: a second run after the send considers nothing', async () => {
  armTransport();
  const world = makeWorld({
    visits: [makeVisit('v1', { appointment_at: '2026-09-01T17:00:00Z', booking_confirm_queued_at: '2026-08-31T12:58:00Z' })],
  });
  captureWire(world);

  await runBookingConfirmRetryPass({ now: NOW });
  global.fetch = async (url) => { throw new Error('second run must not send: ' + url); };
  const second = await runBookingConfirmRetryPass({ now: NOW });
  assert.deepEqual(second, { considered: 0, sent: 0, skipped: 0, stale: 0 });
  assert.equal(world.texts.length, 1, 'exactly one text ever hit the wire');
});

test('stale: appointment day already passed — dropped on record, never sent late', async () => {
  armTransport();
  forbidFetch();
  const world = makeWorld({
    visits: [makeVisit('v1', {
      appointment_at: '2026-08-30T17:00:00Z',            // yesterday
      booking_confirm_queued_at: '2026-08-29T12:58:00Z',
    })],
  });

  const r = await runBookingConfirmRetryPass({ now: NOW });
  assert.deepEqual(r, { considered: 1, sent: 0, skipped: 0, stale: 1 });
  assert.ok(world.visits[0].booking_confirm_sent_at, 'stamped so it never re-drops');
  assert.equal(world.logged[0].status, 'stale');
  assert.ok(world.logged[0].detail.includes('passed'), world.logged[0].detail);
  assert.equal(world.logged[0].related_visit_id, 'v1');
});

test('stale: a visit canceled after queueing is dropped, not texted', async () => {
  armTransport();
  forbidFetch();
  const world = makeWorld({
    visits: [makeVisit('v1', {
      status: 'canceled',
      appointment_at: '2026-09-01T17:00:00Z',
      booking_confirm_queued_at: '2026-08-31T12:58:00Z',
    })],
  });

  const r = await runBookingConfirmRetryPass({ now: NOW });
  assert.deepEqual(r, { considered: 1, sent: 0, skipped: 0, stale: 1 });
  assert.equal(world.logged[0].status, 'stale');
  assert.ok(world.logged[0].detail.includes('canceled'), world.logged[0].detail);
});

test('in-flight buffer: a confirmation queued seconds ago is left alone (its own send may still be on the wire)', async () => {
  armTransport();
  forbidFetch();
  const world = makeWorld({
    visits: [makeVisit('v1', {
      appointment_at: '2026-09-01T17:00:00Z',
      booking_confirm_queued_at: '2026-08-31T13:14:30Z', // 30s before the sweep
    })],
  });

  const r = await runBookingConfirmRetryPass({ now: NOW });
  assert.deepEqual(r, { considered: 0, sent: 0, skipped: 0, stale: 0 });
  assert.equal(world.stamps.length, 0);
});

test('a transiently failed retry stays queued for the next run', async () => {
  armTransport();
  const world = makeWorld({
    visits: [makeVisit('v1', { appointment_at: '2026-09-01T17:00:00Z', booking_confirm_queued_at: '2026-08-31T12:58:00Z' })],
  });
  realFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 500, text: async () => 'provider down' });
  const r = await runBookingConfirmRetryPass({ now: NOW });
  assert.deepEqual(r, { considered: 1, sent: 0, skipped: 1, stale: 0 });
  assert.equal(world.visits[0].booking_confirm_sent_at, null, 'still owed');
});

test('a terminal refusal (no_consent) drains the queue without a send', async () => {
  armTransport();
  forbidFetch();
  const world = makeWorld({
    visits: [makeVisit('v2', { appointment_at: '2026-09-01T17:00:00Z', booking_confirm_queued_at: '2026-08-31T12:58:00Z' })],
    consentRows: [],
  });
  const r = await runBookingConfirmRetryPass({ now: NOW });
  assert.deepEqual(r, { considered: 1, sent: 0, skipped: 1, stale: 0 });
  assert.ok(world.visits[0].booking_confirm_sent_at, 'no_consent stamps');
  assert.equal(world.logged[0].status, 'no_consent');
});

// ---------------------------------------------------------------------------
// Reminder retry sweeps
// ---------------------------------------------------------------------------
test('3-day retry: refused on the target day, sent the next (appointment 2 days out, copy still true)', async () => {
  armTransport();
  const world = makeWorld({
    visits: [makeVisit('v1', {
      appointment_at: '2026-09-02T17:00:00Z',                // Wed, 2 days out
      sms_reminder_3day_queued_at: '2026-08-30T13:20:00Z',   // queued on its target day, refused transiently
    })],
  });
  captureWire(world);

  const r = await runReminderRetryPass({ kind: '3day', now: NOW });
  assert.deepEqual(r, { considered: 1, sent: 1, skipped: 0, stale: 0, rearmed: 0 });
  assert.ok(world.texts[0].includes('is on Wed Sep 2'), world.texts[0]);
  assert.ok(world.visits[0].sms_reminder_3day_at, 'sent column stamped');
});

test('3-day retry: target-day visits are skipped — the daily pass owns them (no double attempt in one run)', async () => {
  armTransport();
  forbidFetch();
  makeWorld({
    visits: [makeVisit('v1', {
      appointment_at: '2026-09-03T17:00:00Z', // exactly today+3
      sms_reminder_3day_queued_at: '2026-08-31T13:15:00Z',
    })],
  });
  const r = await runReminderRetryPass({ kind: '3day', now: NOW });
  assert.deepEqual(r, { considered: 0, sent: 0, skipped: 0, stale: 0, rearmed: 0 });
});

test('3-day retry: appointment day arrived — dropped as stale (day-of reminder covers today)', async () => {
  armTransport();
  forbidFetch();
  const world = makeWorld({
    visits: [makeVisit('v1', {
      appointment_at: '2026-08-31T19:00:00Z', // today 2pm CDT
      sms_reminder_3day_queued_at: '2026-08-28T13:20:00Z',
    })],
  });
  const r = await runReminderRetryPass({ kind: '3day', now: NOW });
  assert.deepEqual(r, { considered: 1, sent: 0, skipped: 0, stale: 1, rearmed: 0 });
  assert.ok(world.visits[0].sms_reminder_3day_at, 'stamped');
  assert.equal(world.logged[0].status, 'stale');
  assert.ok(world.logged[0].detail.includes('day-of'), world.logged[0].detail);
});

test('3-day retry: rescheduled farther out — re-armed (queue cleared), nothing sent, the daily pass re-initiates', async () => {
  armTransport();
  forbidFetch();
  const world = makeWorld({
    visits: [makeVisit('v1', {
      appointment_at: '2026-09-05T17:00:00Z', // 5 days out now
      sms_reminder_3day_queued_at: '2026-08-28T13:20:00Z',
    })],
  });
  const r = await runReminderRetryPass({ kind: '3day', now: NOW });
  assert.deepEqual(r, { considered: 1, sent: 0, skipped: 0, stale: 0, rearmed: 1 });
  assert.equal(world.visits[0].sms_reminder_3day_queued_at, null, 'queue mark cleared');
  assert.equal(world.visits[0].sms_reminder_3day_at, null, 'NOT stamped — the reminder is still owed, on the right day');
  assert.equal(world.logged.length, 0);
});

test('day-of retry: appointment day passed unsent — dropped as stale, on record', async () => {
  armTransport();
  forbidFetch();
  const world = makeWorld({
    visits: [makeVisit('v1', {
      appointment_at: '2026-08-30T17:00:00Z', // yesterday
      sms_reminder_dayof_queued_at: '2026-08-30T13:20:00Z',
    })],
  });
  const r = await runReminderRetryPass({ kind: 'dayof', now: NOW });
  assert.deepEqual(r, { considered: 1, sent: 0, skipped: 0, stale: 1, rearmed: 0 });
  assert.ok(world.visits[0].sms_reminder_dayof_at, 'stamped');
  assert.equal(world.logged[0].status, 'stale');
});

test('day-of retry: today is the daily pass\'s job (skipped); a future rebook re-arms', async () => {
  armTransport();
  forbidFetch();
  const world = makeWorld({
    visits: [
      makeVisit('v-today', { appointment_at: '2026-08-31T19:00:00Z', sms_reminder_dayof_queued_at: '2026-08-31T13:15:00Z' }),
      makeVisit('v-future', { appointment_at: '2026-09-04T17:00:00Z', sms_reminder_dayof_queued_at: '2026-08-30T13:20:00Z' }),
    ],
  });
  const r = await runReminderRetryPass({ kind: 'dayof', now: NOW });
  assert.deepEqual(r, { considered: 1, sent: 0, skipped: 0, stale: 0, rearmed: 1 });
  assert.equal(world.visits[1].sms_reminder_dayof_queued_at, null, 're-armed for the new day');
  assert.equal(world.visits[0].sms_reminder_dayof_queued_at, '2026-08-31T13:15:00Z', 'target-day visit untouched');
});

// ---------------------------------------------------------------------------
// Kill-switch: debts are recorded while disabled, and drain on re-enable
// ---------------------------------------------------------------------------
test('queue-only pass plants the reminder debt with no wire and no log rows', async () => {
  forbidFetch(); // SMS_ENABLED deliberately unset
  const cronTest = cronRouter._test;
  const world = makeWorld({
    visits: [makeVisit('v1', { appointment_at: '2026-09-03T17:00:00Z' })], // today+3
  });
  const r = await cronTest.runReminderPass({
    targetDateStr: '2026-09-03', stampColumn: 'sms_reminder_3day_at', queueColumn: 'sms_reminder_3day_queued_at', isToday: false, queueOnly: true, now: NOW,
  });
  assert.deepEqual(r, { considered: 1, sent: 0, skipped: 1 });
  assert.ok(world.visits[0].sms_reminder_3day_queued_at, 'debt recorded');
  assert.equal(world.visits[0].sms_reminder_3day_at, null, 'not settled');
  assert.equal(world.logged.length, 0, 'no hourly disabled-refusal spam');
});

test('kill-switch recovery: a reminder queued while disabled drains via the retry sweep once re-enabled', async () => {
  const world = makeWorld({
    visits: [makeVisit('v1', {
      appointment_at: '2026-09-03T17:00:00Z',              // was today+3 when queued
      sms_reminder_3day_queued_at: '2026-08-31T13:15:00Z', // planted by a queue-only run
    })],
  });
  armTransport(); // switch back on the next day
  captureWire(world);
  const NEXT_DAY = new Date('2026-09-01T13:15:00Z'); // appointment now 2 days out
  const r = await runReminderRetryPass({ kind: '3day', now: NEXT_DAY });
  assert.deepEqual(r, { considered: 1, sent: 1, skipped: 0, stale: 0, rearmed: 0 });
  assert.ok(world.texts[0].includes('is on Thu Sep 3'), world.texts[0]);
  assert.ok(world.visits[0].sms_reminder_3day_at, 'settled');
});

// ---------------------------------------------------------------------------
// Endpoint guards (hourly-trigger safety)
// ---------------------------------------------------------------------------
test('sms-reminders endpoint sends nothing when nothing could send (guard skip)', async () => {
  // SMS_ENABLED is unset. Whatever the wall clock says, one of the two
  // guards fires: outside 8am-9pm Central -> outside_quiet_hours (no table
  // touched at all), inside -> sms_disabled (queue-plant only). Either way:
  // ok, a skipped marker, nothing on the wire, nothing in the message log.
  forbidFetch();
  const world = makeWorld({ visits: [] });
  const res = makeRes();
  await smsRemindersHandler(makeReq({}), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.ok(['outside_quiet_hours', 'sms_disabled'].includes(res.body.skipped), JSON.stringify(res.body));
  assert.equal(world.logged.length, 0);
  assert.equal(world.texts.length, 0);
});
