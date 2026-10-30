// Office-mode HOLD for scheduled texts (sql/037) — lib/sms.js gate + the
// cron sweeps, offline through the real shipped code:
//   - an automated send to a customer whose conversation the office owns is
//     refused as 'held' (non-terminal), logged ONCE per message even when
//     re-attempted hourly
//   - operator sends (sentBy) and compliance disclosures are never held
//   - a queued 3-day reminder attempted during office mode is held (stamp
//     untouched); after hand-back the held sweep SENDS it when the visit is
//     still ahead, or stale-DROPS it on record when the day has passed -
//     nothing is sent by the hand-back itself
require('./helpers/env');

const test = require('node:test');
const assert = require('node:assert/strict');

const mailer = require('../lib/mailer');
mailer.sendViaBrevo = async () => ({ sent: true, messageId: 'm' });

const { installMockSupabase } = require('./helpers/mockSupabase');
const { memTable } = require('./helpers/memTable');
const sms = require('../lib/sms');
const conv = require('../lib/smsConversations');
const cron = require('../routes/generator-care-cron');
const { runReminderRetryPass, runHeldSweep, centralDateStr } = cron._test;

const CUSTOMER_ID = 'c0000000-0000-4000-8000-000000000001';
const VISIT_ID = 'a0000000-0000-4000-8000-00000000000b';
const AMY = 'a0000000-0000-4000-8000-0000000000a1';
const PHONE = '+16365550100';

// 11:00 AM Central on a fixed calendar day (CDT: 16:00Z) - inside quiet hours.
const NOW = new Date('2026-10-27T16:00:00.000Z');
const daysFromNow = (d) => new Date(NOW.getTime() + d * 86400000).toISOString();
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3600 * 1000).toISOString();

let restore;
let realFetch;
let smsCalls;
let world;
function setup({ mode = 'office', visit } = {}) {
  process.env.SMS_ENABLED = 'true';
  process.env.SIMPLETEXTING_API_TOKEN = 'tok_secret';
  process.env.SIMPLETEXTING_ACCOUNT_PHONE = '8339425468';
  smsCalls = [];
  realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    if (/simpletexting/.test(String(url))) {
      smsCalls.push(JSON.parse(opts.body));
      return { ok: true, status: 201, json: async () => ({ id: 'prov_' + smsCalls.length }) };
    }
    throw new Error('unexpected fetch in offline test: ' + url);
  };
  world = {
    convs: memTable(mode === 'none' ? [] : [{
      id: 'conv-1', customer_id: CUSTOMER_ID, phone: PHONE, mode,
      owner_profile_id: mode === 'office' ? AMY : null, taken_over_at: mode === 'office' ? hoursAgo(0.5) : null,
      last_office_message_at: null, created_at: hoursAgo(1), updated_at: hoursAgo(1),
    }]),
    events: memTable([]),
    messages: memTable([]),
    visits: memTable(visit ? [visit] : []),
    customers: memTable([{ id: CUSTOMER_ID, name: 'Jay King', phone: PHONE, sms_invalid_at: null, sms_invalid_phone: null }]),
  };
  restore = installMockSupabase({
    generator_sms_consent: () => ({ data: [{ id: 'cons1', customer_id: CUSTOMER_ID, phone: PHONE, opted_in: true, opted_out: false }], error: null }),
    generator_sms_conversations: world.convs.resolver,
    generator_sms_conversation_events: world.events.resolver,
    generator_sms_messages: world.messages.resolver,
    generator_service_visits: world.visits.resolver,
    generator_customers: world.customers.resolver,
    generator_email_messages: () => ({ data: null, error: null }),
  });
}
test.afterEach(() => {
  delete process.env.SMS_ENABLED;
  delete process.env.SIMPLETEXTING_API_TOKEN;
  delete process.env.SIMPLETEXTING_ACCOUNT_PHONE;
  if (restore) { restore(); restore = undefined; }
  if (realFetch) { global.fetch = realFetch; realFetch = undefined; }
});

const outRows = () => world.messages.rows.filter((m) => m.direction === 'out');

test('automated send in office mode -> status held, NON-terminal, logged once even when re-attempted', async () => {
  setup({ mode: 'office' });
  const r1 = await sms.sendSms({ toPhone: PHONE, body: 'Reminder: your visit is Thu Oct 29, 8-10 AM.', customerId: CUSTOMER_ID, relatedVisitId: VISIT_ID, now: NOW });
  assert.equal(r1.sent, false);
  assert.equal(r1.status, 'held');
  assert.equal(sms.SMS_TERMINAL_STATUSES.includes('held'), false, 'held keeps the message owed');
  assert.equal(smsCalls.length, 0);
  assert.equal(outRows().length, 1);
  assert.equal(outRows()[0].status, 'held');
  assert.match(outRows()[0].detail, /office is handling this conversation/);

  // The hourly sweep tries again: same answer, no second row.
  const r2 = await sms.sendSms({ toPhone: PHONE, body: 'Reminder: your visit is Thu Oct 29, 8-10 AM.', customerId: CUSTOMER_ID, relatedVisitId: VISIT_ID, now: new Date(NOW.getTime() + 3600 * 1000) });
  assert.equal(r2.status, 'held');
  assert.equal(outRows().length, 1, 'one held row per message, not one per hour');
});

test('operator sends (sentBy) and compliance disclosures are never held', async () => {
  setup({ mode: 'office' });
  const op = await sms.sendSms({ toPhone: PHONE, body: 'Hi Jay, Amy here - the tech is 15 minutes out.', customerId: CUSTOMER_ID, sentBy: AMY, now: NOW });
  assert.equal(op.sent, true);
  const disclosure = await sms.sendSms({ toPhone: PHONE, body: sms.buildOptInConfirmationSms({ installState: 'MO' }), customerId: CUSTOMER_ID, compliance: true, ignoreQuietHours: true, now: NOW });
  assert.equal(disclosure.sent, true);
  assert.equal(smsCalls.length, 2);
  assert.equal(outRows().filter((m) => m.status === 'held').length, 0);
});

test('auto mode: the same automated send goes out normally', async () => {
  setup({ mode: 'auto' });
  const r = await sms.sendSms({ toPhone: PHONE, body: 'Reminder body', customerId: CUSTOMER_ID, now: NOW });
  assert.equal(r.sent, true);
  assert.equal(smsCalls.length, 1);
  assert.ok(world.convs.rows[0].last_outbound_at, 'conversation stamped');
});

function reminderVisit(apptIso) {
  return {
    id: VISIT_ID, status: 'scheduled', appointment_at: apptIso, arrival_window: '8-10', sms_confirmed_at: null,
    sms_reminder_3day_queued_at: hoursAgo(2), sms_reminder_3day_at: null,
    sms_reminder_dayof_queued_at: null, sms_reminder_dayof_at: null,
    booking_confirm_queued_at: null, booking_confirm_sent_at: null,
    schedule_nudge_queued_at: null, schedule_nudge_sent_at: null,
    subscription: { customer: { id: CUSTOMER_ID, name: 'Jay King', phone: PHONE, install_state: 'MO' } },
  };
}

test('queued 3-day reminder during office mode: held (stamp untouched); after hand-back the sweep SENDS it because the visit is still ahead', async () => {
  setup({ mode: 'office', visit: reminderVisit(daysFromNow(2)) });
  const held = await runReminderRetryPass({ kind: '3day', now: NOW });
  assert.equal(held.sent, 0);
  assert.equal(held.skipped, 1, 'held counts as skipped (still owed)');
  assert.equal(world.visits.rows[0].sms_reminder_3day_at, null, 'not stamped - still owed');
  assert.equal(outRows().length, 1);
  assert.equal(outRows()[0].status, 'held');
  assert.equal(smsCalls.length, 0);

  // Hand back: the mode flip sends nothing on its own...
  const c = await conv.handBack({ conv: world.convs.rows[0], profileId: AMY, now: NOW });
  assert.equal(c.mode, 'auto');
  assert.equal(smsCalls.length, 0, 'hand-back itself texts nobody');

  // ...the sweep that follows does, because the reminder is still relevant.
  const swept = await runHeldSweep({ now: NOW });
  assert.equal(swept.three_day.sent, 1);
  assert.equal(smsCalls.length, 1);
  assert.match(smsCalls[0].text, /reminder: your generator maintenance is on/);
  assert.ok(world.visits.rows[0].sms_reminder_3day_at, 'stamped terminal after the real send');
  const statuses = outRows().map((m) => m.status);
  assert.deepEqual(statuses, ['released', 'sent'], 'the held row is closed out once the real send happened');
  assert.match(outRows()[0].detail, /sent after hand-back/);
});

test('held reminder whose appointment day has passed by hand-back is DROPPED on record, never sent late', async () => {
  setup({ mode: 'office', visit: reminderVisit(daysFromNow(-1)) });
  // (While in office mode the retry pass would stale-drop too - the hold
  // gate is only reached for sends. Simulate the realistic path: the hold
  // happened earlier, the day then passed.)
  world.messages.rows.push({ id: 'h1', direction: 'out', to_phone: PHONE, customer_id: CUSTOMER_ID, related_visit_id: VISIT_ID, status: 'held', body: 'old reminder', created_at: hoursAgo(30) });
  await conv.handBack({ conv: world.convs.rows[0], profileId: AMY, now: NOW });
  const swept = await runHeldSweep({ now: NOW });
  assert.equal(swept.three_day.stale, 1);
  assert.equal(smsCalls.length, 0, 'nothing sent late');
  assert.ok(world.visits.rows[0].sms_reminder_3day_at, 'stamped so it drains from the queue');
  const stale = outRows().find((m) => m.status === 'stale');
  assert.ok(stale, 'a stale row explains the drop in the thread');
  assert.match(stale.detail, /dropped as stale/);
});

test('runHeldSweep does nothing outside quiet hours or with the kill-switch off (the hourly cron picks it up)', async () => {
  setup({ mode: 'auto', visit: reminderVisit(daysFromNow(2)) });
  const night = new Date('2026-10-28T04:00:00.000Z'); // 11 PM Central
  assert.deepEqual(await runHeldSweep({ now: night }), { skipped: 'outside_quiet_hours' });
  process.env.SMS_ENABLED = 'false';
  assert.deepEqual(await runHeldSweep({ now: NOW }), { skipped: 'sms_disabled' });
  assert.equal(smsCalls.length, 0);
  assert.equal(centralDateStr(NOW), '2026-10-27');
});
