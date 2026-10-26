// Evening-before reminder (sql/038) replacing the morning-of pass, through
// the real cron code against the in-memory Supabase stand-in:
//   - at 6:15 PM Central the pass texts TOMORROW's visits the "tomorrow,
//     8-10 AM" copy (confirmation-aware); the 3-day pass is unchanged
//   - before 6 PM nothing is attempted (no queue marks either)
//   - booked after 6 PM the day before: NOT reminded - settled on record
//     ("booked after 6 PM ... the booking confirmation covers it")
//   - booked the same day: never selected by any pass
//   - no double reminders: the morning-of pass is gone from the endpoint,
//     and a second run after the send attempts nothing
//   - eve retry: appointment day arrived unsent -> dropped as stale;
//     rescheduled farther out -> re-armed
//   - centralTimeToIso handles CDT and CST
require('./helpers/env');

const test = require('node:test');
const assert = require('node:assert/strict');

const mailer = require('../lib/mailer');
mailer.sendViaBrevo = async () => ({ sent: true, messageId: 'm' });

const { installMockSupabase } = require('./helpers/mockSupabase');
const { memTable } = require('./helpers/memTable');
const { getRouteHandler, makeRes } = require('./helpers/routeHandler');
const cron = require('../routes/generator-care-cron');
const { runReminderPass, runReminderRetryPass, centralTimeToIso, addDays, EVE_HOUR } = cron._test;
const smsHandler = getRouteHandler(cron, 'post', '/sms-reminders');

const CUSTOMER_ID = 'c0000000-0000-4000-8000-000000000001';
const PHONE = '+16365550100';
// Monday 2026-10-26 (CDT). 6:15 PM = 23:15Z; 5:15 PM = 22:15Z; next morning 8:15 AM = 13:15Z on the 27th.
const TODAY = '2026-10-26';
const EVE = new Date('2026-10-26T23:15:00.000Z');
const BEFORE_EVE = new Date('2026-10-26T22:15:00.000Z');
const NEXT_MORNING = new Date('2026-10-27T13:15:00.000Z');
const cutoff = centralTimeToIso(TODAY, '18:00');

let restore;
let realFetch;
let smsCalls;
let world;
function setup(visits) {
  process.env.SMS_ENABLED = 'true';
  process.env.SIMPLETEXTING_API_TOKEN = 'tok_secret';
  process.env.SIMPLETEXTING_ACCOUNT_PHONE = '8339425468';
  process.env.SMS_REVIEW_REQUESTS_ENABLED = 'false';
  smsCalls = [];
  realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    if (/simpletexting/.test(String(url))) { smsCalls.push(JSON.parse(opts.body)); return { ok: true, status: 201, json: async () => ({ id: 'prov_' + smsCalls.length }) }; }
    throw new Error('unexpected fetch in offline test: ' + url);
  };
  world = { visits: memTable(visits), messages: memTable([]), convs: memTable([]), events: memTable([]) };
  restore = installMockSupabase({
    generator_service_visits: world.visits.resolver,
    generator_sms_messages: world.messages.resolver,
    generator_sms_conversations: world.convs.resolver,
    generator_sms_conversation_events: world.events.resolver,
    generator_sms_consent: () => ({ data: [{ id: 'cons1', customer_id: CUSTOMER_ID, phone: PHONE, opted_in: true, opted_out: false }], error: null }),
    generator_customers: () => ({ data: { sms_invalid_at: null, sms_invalid_phone: null }, error: null }),
    generator_email_messages: () => ({ data: null, error: null }),
  });
}
test.afterEach(() => {
  delete process.env.SMS_ENABLED; delete process.env.SIMPLETEXTING_API_TOKEN; delete process.env.SIMPLETEXTING_ACCOUNT_PHONE; delete process.env.SMS_REVIEW_REQUESTS_ENABLED;
  if (restore) { restore(); restore = undefined; }
  if (realFetch) { global.fetch = realFetch; realFetch = undefined; }
});

function visit(id, apptIso, extra = {}) {
  return {
    id, status: 'scheduled', appointment_at: apptIso, arrival_window: '8-10', sms_confirmed_at: null,
    scheduled_at: '2026-10-20T15:00:00.000Z',
    sms_reminder_3day_at: null, sms_reminder_3day_queued_at: null,
    sms_reminder_dayof_at: null, sms_reminder_dayof_queued_at: null,
    sms_reminder_eve_at: null, sms_reminder_eve_queued_at: null,
    booking_confirm_queued_at: null, booking_confirm_sent_at: null,
    schedule_nudge_queued_at: null, schedule_nudge_sent_at: null,
    subscription: { customer: { id: CUSTOMER_ID, name: 'Jay King', phone: '636-555-0100', install_state: 'MO' } },
    ...extra,
  };
}
async function runEndpoint(now) {
  const res = makeRes();
  // The real clock: the handler reads new Date(); pin it for the call.
  const RealDate = global.Date;
  global.Date = class extends RealDate { constructor(...a) { return a.length ? new RealDate(...a) : new RealDate(now); } static now() { return now.getTime(); } };
  try { await smsHandler({ headers: { authorization: 'Bearer x' }, body: {}, query: {} }, res); } finally { global.Date = RealDate; }
  return res;
}
const eveArgs = (now) => ({ targetDateStr: addDays(TODAY, 1), stampColumn: 'sms_reminder_eve_at', queueColumn: 'sms_reminder_eve_queued_at', isTomorrow: true, lateBookingCutoff: cutoff, now });

test('centralTimeToIso: 6 PM Central is 23:00Z in CDT and 00:00Z next day in CST', () => {
  assert.equal(centralTimeToIso('2026-10-26', '18:00'), '2026-10-26T23:00:00.000Z');
  assert.equal(centralTimeToIso('2026-12-15', '18:00'), '2026-12-16T00:00:00.000Z');
  assert.equal(EVE_HOUR, 18);
});

test('6:15 PM: tomorrow\'s visit gets the "tomorrow, 8-10 AM" reminder (Reply Y when unconfirmed, not when confirmed)', async () => {
  setup([
    visit('v-tomorrow', '2026-10-27T13:00:00.000Z'),
    visit('v-tomorrow-confirmed', '2026-10-27T15:00:00.000Z', { sms_confirmed_at: '2026-10-25T12:00:00.000Z', arrival_window: '10-12' }),
    visit('v-today', '2026-10-26T13:00:00.000Z'),
    visit('v-2days', '2026-10-28T13:00:00.000Z'),
  ]);
  const r = await runReminderPass(eveArgs(EVE));
  assert.deepEqual(r, { considered: 2, sent: 2, skipped: 0 });
  assert.equal(smsCalls[0].text, 'Bates Generator Care reminder: your generator maintenance is tomorrow, 8-10 AM. Reply Y to confirm, or tap https://app.bates-electric.com/my to reschedule.');
  assert.equal(smsCalls[1].text, 'Bates Generator Care reminder: your generator maintenance is tomorrow, 10 AM-12 PM. Need a different time? Tap https://app.bates-electric.com/my.');
  assert.ok(world.visits.rows[0].sms_reminder_eve_at && world.visits.rows[0].sms_reminder_eve_queued_at);
  assert.equal(world.visits.rows[2].sms_reminder_eve_at, null, 'today is not tomorrow');
  assert.equal(world.visits.rows[3].sms_reminder_eve_at, null, '2 days out waits for its evening');
});

test('booked after 6 PM the day before: settled on record, NOT reminded (the confirmation covers it); booked earlier the same day IS reminded', async () => {
  setup([
    visit('v-late-booked', '2026-10-27T13:00:00.000Z', { scheduled_at: '2026-10-26T23:40:00.000Z' }), // booked 6:40 PM
    visit('v-afternoon-booked', '2026-10-27T15:00:00.000Z', { scheduled_at: '2026-10-26T19:00:00.000Z' }), // booked 2 PM
  ]);
  const r = await runReminderPass(eveArgs(new Date('2026-10-27T00:15:00.000Z'))); // 7:15 PM run
  assert.equal(r.sent, 1);
  assert.equal(r.late_booked, 1);
  assert.equal(smsCalls.length, 1);
  assert.match(smsCalls[0].text, /tomorrow, 8-10 AM/, 'the afternoon booking got its reminder');
  const late = world.visits.rows[0];
  assert.ok(late.sms_reminder_eve_at, 'settled so no later run re-considers it');
  const stale = world.messages.rows.find((m) => m.status === 'stale');
  assert.ok(stale);
  assert.match(stale.detail, /booked after 6 PM the day before - the booking confirmation covers it/);
});

test('endpoint: 5:15 PM attempts nothing for tomorrow; 6:15 PM sends; the next-morning run sends NOTHING more (no morning-of reminder)', async () => {
  setup([visit('v-tomorrow', '2026-10-27T13:00:00.000Z')]);
  let res = await runEndpoint(BEFORE_EVE);
  assert.equal(res.statusCode, 200, JSON.stringify(res.body));
  assert.equal(res.body.eve.skipped, 'before_18');
  assert.equal(world.visits.rows[0].sms_reminder_eve_queued_at, null, 'no queue mark before the hour');
  assert.equal(smsCalls.length, 0);

  res = await runEndpoint(EVE);
  assert.equal(res.body.eve.sent, 1, JSON.stringify(res.body));
  assert.equal(smsCalls.length, 1);
  assert.equal(res.body.day_of, undefined, 'morning-of pass is gone');

  res = await runEndpoint(NEXT_MORNING);
  assert.equal(smsCalls.length, 1, 'no second reminder the morning of');
  assert.equal(res.body.three_day.sent, 0);
  assert.equal(world.visits.rows[0].sms_reminder_dayof_queued_at, null, 'nothing touches the retired columns');
});

test('endpoint with the kill-switch off at 6:15 PM plants the eve queue mark only (no wire, no rows)', async () => {
  setup([visit('v-tomorrow', '2026-10-27T13:00:00.000Z')]);
  process.env.SMS_ENABLED = 'false';
  const res = await runEndpoint(EVE);
  assert.equal(res.body.skipped, 'sms_disabled');
  assert.ok(world.visits.rows[0].sms_reminder_eve_queued_at);
  assert.equal(world.visits.rows[0].sms_reminder_eve_at, null);
  assert.equal(smsCalls.length, 0);
  assert.equal(world.messages.rows.length, 0);
});

test('eve retry: queued but unsent when the appointment day arrives -> dropped as stale; rescheduled farther out -> re-armed', async () => {
  setup([
    visit('v-stale', '2026-10-27T13:00:00.000Z', { sms_reminder_eve_queued_at: '2026-10-26T23:15:00.000Z' }),
    visit('v-moved', '2026-10-30T13:00:00.000Z', { sms_reminder_eve_queued_at: '2026-10-26T23:15:00.000Z' }),
  ]);
  const r = await runReminderRetryPass({ kind: 'eve', now: NEXT_MORNING });
  assert.equal(r.stale, 1);
  assert.equal(r.rearmed, 1);
  assert.equal(smsCalls.length, 0);
  assert.ok(world.visits.rows[0].sms_reminder_eve_at);
  assert.match(world.messages.rows.find((m) => m.status === 'stale').detail, /appointment day arrived before it could send/);
  assert.equal(world.visits.rows[1].sms_reminder_eve_queued_at, null, 're-armed for its own evening');
});
