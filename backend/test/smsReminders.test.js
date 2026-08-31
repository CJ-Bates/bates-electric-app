// SMS Phase 2 (appointment reminders) — fully offline. Covers the spec's
// verification list:
//   - buildReminderSms copy: confirmed omits "Reply Y", unconfirmed asks for
//     it, isToday swaps "today" vs "on {date}", FL DBA brand, windowless form
//   - date-window selection: a visit exactly 3 days out is picked by the
//     3-day pass, one today by the morning-of pass, others by neither —
//     measured on the CENTRAL calendar date, not the UTC one
//   - idempotency: a second run after a 'sent' stamp sends nothing
//   - terminal-status rule: 'sent'/'no_consent' stamp the column;
//     'disabled'/'failed' leave it null so the next run retries
require('./helpers/env');

const test = require('node:test');
const assert = require('node:assert/strict');

const { installMockSupabase } = require('./helpers/mockSupabase');
const sms = require('../lib/sms');
const router = require('../routes/generator-care-cron');
const { runReminderPass, centralDateStr, addDays } = router._test;

const CUSTOMER_ID = 'c0000000-0000-4000-8000-000000000001';

// Pinned clock: 8:30am CDT on Wed 2026-07-15 — inside quiet hours, so the
// only thing between a consented visit and 'sent' is the transport mock.
const NOW = new Date('2026-07-15T13:30:00Z');
const TODAY_CENTRAL = '2026-07-15';

let restoreSupabase;
let realFetch;
test.afterEach(() => {
  if (restoreSupabase) { restoreSupabase(); restoreSupabase = undefined; }
  if (realFetch) { global.fetch = realFetch; realFetch = undefined; }
  delete process.env.SMS_ENABLED;
  delete process.env.SIMPLETEXTING_API_TOKEN;
  delete process.env.SIMPLETEXTING_ACCOUNT_PHONE;
});

function forbidFetch() {
  realFetch = global.fetch;
  global.fetch = async (url) => { throw new Error('unexpected fetch in offline test: ' + url); };
}

function armTransport() {
  process.env.SMS_ENABLED = 'true';
  process.env.SIMPLETEXTING_API_TOKEN = 'tok_secret';
  process.env.SIMPLETEXTING_ACCOUNT_PHONE = '8339425468';
}

// ---------------------------------------------------------------------------
// Copy builder
// ---------------------------------------------------------------------------
test('buildReminderSms: unconfirmed 3-day reminder asks for the Y', () => {
  const body = sms.buildReminderSms({
    installState: 'MO', dateStr: '2026-07-18', windowCode: '8-10',
    link: 'https://app.bates-electric.com/my', confirmed: false, isToday: false,
  });
  assert.ok(body.startsWith('Bates Generator Care reminder:'), body);
  assert.ok(body.includes('is on Sat Jul 18, 8-10 AM.'), body);
  assert.ok(body.includes('Reply Y to confirm, or tap https://app.bates-electric.com/my to reschedule.'), body);
  assert.ok(!body.includes('Need a different time'), body);
});

test('buildReminderSms: confirmed reminder just reminds — no "Reply Y"', () => {
  const body = sms.buildReminderSms({
    installState: 'MO', dateStr: '2026-07-18', windowCode: '8-10',
    link: 'L', confirmed: true, isToday: false,
  });
  assert.ok(!body.includes('Reply Y'), body);
  assert.ok(body.includes('Need a different time? Tap L.'), body);
});

test('buildReminderSms: isToday says "today", never a date', () => {
  const body = sms.buildReminderSms({
    installState: 'MO', dateStr: '2026-07-15', windowCode: '12-2',
    link: 'L', confirmed: true, isToday: true,
  });
  assert.ok(body.includes('is today, 12-2 PM.'), body);
  assert.ok(!body.includes('Jul 15'), body);
});

test('buildReminderSms: FL brand swap and windowless (legacy visit) form', () => {
  const fl = sms.buildReminderSms({ installState: 'FL', dateStr: '2026-07-18', windowCode: '8-10', link: 'L', confirmed: false, isToday: false });
  assert.ok(fl.startsWith('S.E. Bates Generator Care reminder:'), fl);
  const noWin = sms.buildReminderSms({ installState: 'MO', dateStr: '2026-07-18', windowCode: null, link: 'L', confirmed: false, isToday: false });
  assert.ok(noWin.includes('is on Sat Jul 18.'), noWin);
  assert.ok(!noWin.includes('null'), noWin);
});

// ---------------------------------------------------------------------------
// Date helpers
// ---------------------------------------------------------------------------
test('centralDateStr/addDays: Central calendar dates, not UTC ones', () => {
  assert.equal(centralDateStr(NOW), '2026-07-15');
  // 10pm CDT Jul 17 is already Jul 18 in UTC — Central must win.
  assert.equal(centralDateStr(new Date('2026-07-18T03:00:00Z')), '2026-07-17');
  assert.equal(addDays('2026-07-15', 3), '2026-07-18');
  assert.equal(addDays('2026-07-31', 3), '2026-08-03', 'month rollover');
});

// ---------------------------------------------------------------------------
// Mock world for the pass. The visits resolver REPLAYS the recorded query
// chain against an in-memory table (eq/is/not/gte/lt), so the pass's own
// filters — status, the null stamp column, the UTC date bounds — are what
// select the rows, and a stamped visit really disappears from the next run.
// ---------------------------------------------------------------------------
function makeWorld({ visits, consentRows } = {}) {
  const world = {
    visits: visits || [],
    stamps: [],   // { id, patch } for every generator_service_visits update
    logged: [],   // generator_sms_messages inserts
  };
  restoreSupabase = installMockSupabase({
    generator_service_visits: (chain) => {
      const upd = chain.find((c) => c.method === 'update');
      if (upd) {
        const idEq = chain.find((c) => c.method === 'eq' && c.args[0] === 'id');
        const visit = world.visits.find((v) => v.id === (idEq && idEq.args[1]));
        if (visit) Object.assign(visit, upd.args[0]);
        world.stamps.push({ id: idEq && idEq.args[1], patch: upd.args[0] });
        return { data: null, error: null };
      }
      let rows = world.visits.slice();
      for (const c of chain) {
        if (c.method === 'eq') rows = rows.filter((r) => r[c.args[0]] === c.args[1]);
        if (c.method === 'is' && c.args[1] === null) rows = rows.filter((r) => r[c.args[0]] == null);
        if (c.method === 'not' && c.args[0] === 'appointment_at') rows = rows.filter((r) => r.appointment_at != null);
        if (c.method === 'gte') rows = rows.filter((r) => r[c.args[0]] >= c.args[1]);
        if (c.method === 'lt') rows = rows.filter((r) => r[c.args[0]] < c.args[1]);
      }
      return { data: rows, error: null };
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

function makeVisit(id, appointmentAtUtc, extra = {}) {
  return {
    id,
    status: 'scheduled',
    appointment_at: appointmentAtUtc,
    arrival_window: '8-10',
    sms_confirmed_at: null,
    sms_reminder_3day_at: null,
    sms_reminder_dayof_at: null,
    sms_reminder_3day_queued_at: null,
    sms_reminder_dayof_queued_at: null,
    subscription: { customer: { id: CUSTOMER_ID, name: 'Sarah Example', phone: '6365550100', install_state: 'MO' } },
    ...extra,
  };
}

// 035 queue-then-send: every attempted visit writes a queue stamp first, so
// stamp assertions filter by which column the patch carries.
function stampsWith(world, column) {
  return world.stamps.filter((s) => s.patch[column] != null);
}

// ---------------------------------------------------------------------------
// Date-window selection + the two variants going over the wire
// ---------------------------------------------------------------------------
test('3-day pass picks exactly the visit 3 days out (Central); day-of picks today; 2/5-day picked by neither', async () => {
  armTransport();
  const world = makeWorld({
    visits: [
      makeVisit('v-today', '2026-07-15T17:00:00Z'),                          // noon CDT today
      makeVisit('v-2day', '2026-07-17T13:00:00Z'),                           // 2 days out
      makeVisit('v-3day', '2026-07-18T13:00:00Z'),                           // 3 days out
      makeVisit('v-edge', '2026-07-18T03:00:00Z'),                           // 10pm CDT Jul 17: Jul 18 in UTC, Jul 17 Central
      makeVisit('v-5day', '2026-07-20T13:00:00Z'),                           // 5 days out
    ],
  });
  const texts = [];
  realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    texts.push(JSON.parse(opts.body).text);
    return { ok: true, status: 201, json: async () => ({ id: 'prov_1' }) };
  };

  const threeDay = await runReminderPass({ targetDateStr: addDays(TODAY_CENTRAL, 3), stampColumn: 'sms_reminder_3day_at', queueColumn: 'sms_reminder_3day_queued_at', isToday: false, now: NOW });
  assert.deepEqual(threeDay, { considered: 1, sent: 1, skipped: 0 });
  assert.deepEqual(stampsWith(world, 'sms_reminder_3day_queued_at').map((s) => s.id), ['v-3day'], 'queued before the send');
  assert.deepEqual(stampsWith(world, 'sms_reminder_3day_at').map((s) => s.id), ['v-3day'], 'the 3-day column is what gets stamped');
  assert.ok(texts[0].includes('is on Sat Jul 18'), texts[0]);
  assert.ok(texts[0].includes('Reply Y to confirm'), texts[0]);

  const dayOf = await runReminderPass({ targetDateStr: TODAY_CENTRAL, stampColumn: 'sms_reminder_dayof_at', queueColumn: 'sms_reminder_dayof_queued_at', isToday: true, now: NOW });
  assert.deepEqual(dayOf, { considered: 1, sent: 1, skipped: 0 });
  assert.deepEqual(stampsWith(world, 'sms_reminder_dayof_queued_at').map((s) => s.id), ['v-today']);
  assert.deepEqual(stampsWith(world, 'sms_reminder_dayof_at').map((s) => s.id), ['v-today'], 'the day-of column is what gets stamped');
  assert.ok(texts[1].includes('is today'), texts[1]);
});

test('a customer who already replied Y gets the reminder-only variant', async () => {
  armTransport();
  makeWorld({
    visits: [makeVisit('v-today', '2026-07-15T17:00:00Z', { sms_confirmed_at: '2026-07-13T15:00:00Z' })],
  });
  let text;
  realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    text = JSON.parse(opts.body).text;
    return { ok: true, status: 201, json: async () => ({ id: 'prov_1' }) };
  };
  const r = await runReminderPass({ targetDateStr: TODAY_CENTRAL, stampColumn: 'sms_reminder_dayof_at', queueColumn: 'sms_reminder_dayof_queued_at', isToday: true, now: NOW });
  assert.equal(r.sent, 1);
  assert.ok(!text.includes('Reply Y'), text);
  assert.ok(text.includes('Need a different time'), text);
});

// ---------------------------------------------------------------------------
// Idempotency: after a sent stamp the visit vanishes from the next run
// ---------------------------------------------------------------------------
test('second run after a sent stamp considers nothing and sends nothing', async () => {
  armTransport();
  const world = makeWorld({ visits: [makeVisit('v-3day', '2026-07-18T13:00:00Z')] });
  realFetch = global.fetch;
  global.fetch = async () => ({ ok: true, status: 201, json: async () => ({ id: 'prov_1' }) });

  const first = await runReminderPass({ targetDateStr: '2026-07-18', stampColumn: 'sms_reminder_3day_at', queueColumn: 'sms_reminder_3day_queued_at', isToday: false, now: NOW });
  assert.deepEqual(first, { considered: 1, sent: 1, skipped: 0 });

  global.fetch = async (url) => { throw new Error('second run must not send: ' + url); };
  const second = await runReminderPass({ targetDateStr: '2026-07-18', stampColumn: 'sms_reminder_3day_at', queueColumn: 'sms_reminder_3day_queued_at', isToday: false, now: NOW });
  assert.deepEqual(second, { considered: 0, sent: 0, skipped: 0 });
  assert.equal(world.stamps.length, 2, 'first run wrote queue + sent stamps; second run wrote nothing');
});

// ---------------------------------------------------------------------------
// Terminal-status rule: stamp on sent + permanent refusals, retry the rest
// ---------------------------------------------------------------------------
test('kill-switch off ("disabled") does NOT stamp — the visit retries next run', async () => {
  forbidFetch(); // SMS_ENABLED deliberately unset
  const world = makeWorld({ visits: [makeVisit('v-3day', '2026-07-18T13:00:00Z')] });
  const r = await runReminderPass({ targetDateStr: '2026-07-18', stampColumn: 'sms_reminder_3day_at', queueColumn: 'sms_reminder_3day_queued_at', isToday: false, now: NOW });
  assert.deepEqual(r, { considered: 1, sent: 0, skipped: 1 });
  assert.equal(stampsWith(world, 'sms_reminder_3day_at').length, 0, 'sent column stays null — retries');
  assert.equal(stampsWith(world, 'sms_reminder_3day_queued_at').length, 1, 'but the debt is queued for the sweep');
  assert.equal(world.logged[0].status, 'disabled', 'the refusal still lands in the message log');
});

test('a failed provider send does NOT stamp — retries next run', async () => {
  armTransport();
  const world = makeWorld({ visits: [makeVisit('v-3day', '2026-07-18T13:00:00Z')] });
  realFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 500, text: async () => 'provider down' });
  const r = await runReminderPass({ targetDateStr: '2026-07-18', stampColumn: 'sms_reminder_3day_at', queueColumn: 'sms_reminder_3day_queued_at', isToday: false, now: NOW });
  assert.deepEqual(r, { considered: 1, sent: 0, skipped: 1 });
  assert.equal(stampsWith(world, 'sms_reminder_3day_at').length, 0, 'sent column stays null — retries');
});

test('no_consent is terminal: refused, logged, and stamped so it never re-tries', async () => {
  forbidFetch();
  armTransport();
  const world = makeWorld({ visits: [makeVisit('v-3day', '2026-07-18T13:00:00Z')], consentRows: [] });
  const r = await runReminderPass({ targetDateStr: '2026-07-18', stampColumn: 'sms_reminder_3day_at', queueColumn: 'sms_reminder_3day_queued_at', isToday: false, now: NOW });
  assert.deepEqual(r, { considered: 1, sent: 0, skipped: 1 });
  assert.equal(stampsWith(world, 'sms_reminder_3day_at').length, 1, 'permanent refusal stamps — no point retrying');
  assert.equal(world.logged[0].status, 'no_consent');
});

test('opted_out is terminal too', async () => {
  forbidFetch();
  armTransport();
  const world = makeWorld({
    visits: [makeVisit('v-3day', '2026-07-18T13:00:00Z')],
    consentRows: [{ id: 'cons1', customer_id: CUSTOMER_ID, opted_in: true, opted_out: true }],
  });
  const r = await runReminderPass({ targetDateStr: '2026-07-18', stampColumn: 'sms_reminder_3day_at', queueColumn: 'sms_reminder_3day_queued_at', isToday: false, now: NOW });
  assert.deepEqual(r, { considered: 1, sent: 0, skipped: 1 });
  assert.equal(stampsWith(world, 'sms_reminder_3day_at').length, 1);
  assert.equal(world.logged[0].status, 'opted_out');
});

test('a visit with no customer phone is counted skipped, nothing sent or stamped', async () => {
  forbidFetch();
  armTransport();
  const world = makeWorld({
    visits: [makeVisit('v-3day', '2026-07-18T13:00:00Z', {
      subscription: { customer: { id: CUSTOMER_ID, name: 'No Phone', phone: null, install_state: 'MO' } },
    })],
  });
  const r = await runReminderPass({ targetDateStr: '2026-07-18', stampColumn: 'sms_reminder_3day_at', queueColumn: 'sms_reminder_3day_queued_at', isToday: false, now: NOW });
  assert.deepEqual(r, { considered: 1, sent: 0, skipped: 1 });
  assert.equal(world.stamps.length, 0, 'no send attempted, so nothing queued or stamped');
  assert.equal(world.logged.length, 0);
});

// ---------------------------------------------------------------------------
// Route wiring
// ---------------------------------------------------------------------------
test('POST /sms-reminders is registered behind requireCronSecret', () => {
  const layer = router.stack.find((l) => l.route && l.route.path === '/sms-reminders' && l.route.methods.post);
  assert.ok(layer, 'route exists');
  assert.equal(layer.route.stack.length, 2, 'requireCronSecret middleware + handler');
});
