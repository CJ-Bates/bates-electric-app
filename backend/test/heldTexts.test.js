// Closing out held texts (lib/heldTexts.js, 2026-10-30) through the real
// shipped code against the in-memory Supabase stand-in:
//   - a reschedule drops the held confirmation for the OLD slot right away,
//     and the new slot's confirmation is untouched
//   - the sweep closes the live case (held Oct 26 confirmation, visit moved
//     to Oct 27, handed back, Oct 27 confirmation sent): 'dropped' with the
//     reason, and the Oct 27 held row 'released' (it went out)
//   - day passed / canceled / completed / superseded -> 'dropped' + reason
//   - a held text that may still send stays 'held' (never dropped early);
//     a held review request on a completed visit is left to its own pass
//   - a later terminal refusal of the same message settles it
require('./helpers/env');

const test = require('node:test');
const assert = require('node:assert/strict');

const { installMockSupabase } = require('./helpers/mockSupabase');
const { memTable } = require('./helpers/memTable');
const { closeStaleHeldTexts, heldKind } = require('../lib/heldTexts');
const { scheduleServiceVisit } = require('../lib/scheduleVisit');
const { buildBookingConfirmationSms, buildReminderSms, buildReviewRequestSms } = require('../lib/sms');

const CUSTOMER_ID = 'c0000000-0000-4000-8000-000000000001';
const VISIT_ID = 'a0000000-0000-4000-8000-00000000000b';
const PHONE = '+13144097833';
const LINK = 'https://app.bates-electric.com/customer';

// Fri Oct 30 2026, 11:00 AM CDT.
const NOW = new Date('2026-10-30T16:00:00.000Z');
const confirm = (dateStr) => buildBookingConfirmationSms({ name: 'Cj', installState: 'MO', dateStr, windowCode: '13-15', link: LINK });
const reminder = (dateStr, confirmed) => buildReminderSms({ installState: 'MO', dateStr, windowCode: '13-15', link: LINK, confirmed, isTomorrow: true });

let restore;
let world;
function setup({ visit, messages = [] } = {}) {
  world = {
    visits: memTable(visit ? [{
      id: VISIT_ID, status: 'scheduled', appointment_at: '2026-11-03T18:00:00.000Z', arrival_window: '13-15',
      scheduled_at: '2026-10-29T15:00:00.000Z', assigned_tech_id: null, subscription_id: 'sub1',
      subscription: { id: 'sub1', customer: { id: CUSTOMER_ID, name: 'Cj', phone: PHONE, install_state: 'MO' } },
      ...visit,
    }] : []),
    messages: memTable(messages.map((m, i) => ({ id: 'm' + i, direction: 'out', to_phone: PHONE, customer_id: CUSTOMER_ID, related_visit_id: VISIT_ID, detail: null, ...m }))),
  };
  restore = installMockSupabase({
    generator_service_visits: world.visits.resolver,
    generator_sms_messages: world.messages.resolver,
  });
}
test.afterEach(() => { if (restore) { restore(); restore = undefined; } });
const row = (id) => world.messages.rows.find((m) => m.id === id);

test('kinds are read from the shipped copy', () => {
  assert.equal(heldKind(confirm('2026-10-26')), 'booking_confirm');
  assert.equal(heldKind(reminder('2026-10-26', false)), 'reminder');
  assert.equal(heldKind(buildReviewRequestSms({ name: 'Cj', installState: 'MO', link: 'https://g.page/r' })), 'review');
  assert.equal(heldKind('Hi, Amy here'), 'other');
});

test('reschedule drops the held confirmation for the OLD slot immediately; other texts untouched', async () => {
  setup({
    visit: { appointment_at: '2026-10-26T18:00:00.000Z' },
    messages: [
      { status: 'held', body: confirm('2026-10-26'), created_at: '2026-10-25T15:00:00.000Z' },
      { status: 'held', body: reminder('2026-10-26', false), created_at: '2026-10-25T23:00:00.000Z' },
      { status: 'held', body: 'Bates Generator Care: it\'s time to schedule your generator maintenance for 2026. Tap to pick a date & time: [link]. Reply STOP to opt out.', created_at: '2026-10-20T15:00:00.000Z' },
      { status: 'sent', body: 'earlier text', created_at: '2026-10-20T15:00:00.000Z' },
    ],
  });
  const { visit } = await scheduleServiceVisit({ visitId: VISIT_ID, appointmentAt: new Date('2026-10-27T18:00:00.000Z'), arrivalWindow: '13-15', bookedBy: 'Amy' });
  assert.ok(visit);
  assert.equal(row('m0').status, 'dropped');
  assert.equal(row('m0').detail, 'the visit was rescheduled to Tue Oct 27');
  assert.equal(row('m1').status, 'dropped', 'the old reminder too');
  assert.equal(row('m2').status, 'held', 'a scheduling nudge is not about the old slot');
  assert.equal(row('m3').status, 'sent');
});

test('live case: held Oct 26 confirmation, visit moved to Oct 27, Oct 27 confirmation sent -> dropped with reason / released', async () => {
  setup({
    visit: { appointment_at: '2026-10-27T18:00:00.000Z', scheduled_at: '2026-10-26T14:00:00.000Z' },
    messages: [
      { status: 'held', body: confirm('2026-10-26'), created_at: '2026-10-25T15:00:00.000Z' },
      { status: 'held', body: confirm('2026-10-27'), created_at: '2026-10-26T14:00:01.000Z' },
      { status: 'sent', body: confirm('2026-10-27'), created_at: '2026-10-26T21:15:00.000Z' },
    ],
  });
  const r = await closeStaleHeldTexts({ now: NOW });
  assert.equal(r.checked, 2);
  assert.equal(r.dropped, 1);
  assert.equal(r.released, 1);
  assert.equal(row('m0').status, 'dropped');
  assert.equal(row('m0').detail, 'the visit was rescheduled to Tue Oct 27');
  assert.equal(row('m1').status, 'released');
  assert.match(row('m1').detail, /^sent after hand-back/);
  // Same verdict after the Oct 27 visit was completed (as it was live).
  world.messages.rows[0].status = 'held';
  world.visits.rows[0].status = 'completed';
  await closeStaleHeldTexts({ now: NOW });
  assert.equal(row('m0').detail, 'the visit was rescheduled to Tue Oct 27', 'the reschedule is the reason, not the later completion');
  // Idempotent: nothing left to close.
  const again = await closeStaleHeldTexts({ now: NOW });
  assert.equal(again.checked, 0);
});

test('appointment day passed / visit canceled / visit completed -> dropped with the reason', async () => {
  for (const [visit, reason] of [
    [{ appointment_at: '2026-10-28T18:00:00.000Z' }, 'the appointment day (Wed Oct 28) passed'],
    [{ status: 'canceled' }, 'the visit was canceled'],
    [{ status: 'completed' }, 'the visit was completed'],
  ]) {
    setup({ visit, messages: [{ status: 'held', body: confirm('2026-10-28'), created_at: '2026-10-29T16:00:00.000Z' }] });
    const r = await closeStaleHeldTexts({ now: NOW });
    assert.equal(r.dropped, 1, reason);
    assert.equal(row('m0').status, 'dropped');
    assert.equal(row('m0').detail, reason);
    restore(); restore = undefined;
  }
});

test('superseded by a newer text of the same kind for the same visit -> dropped', async () => {
  setup({
    visit: {},
    messages: [
      { status: 'held', body: reminder('2026-11-03', false), created_at: '2026-10-29T23:00:00.000Z' },
      { status: 'held', body: reminder('2026-11-03', true), created_at: '2026-10-30T00:00:00.000Z' },
    ],
  });
  await closeStaleHeldTexts({ now: NOW });
  assert.equal(row('m0').status, 'dropped');
  assert.equal(row('m0').detail, 'replaced by a newer reminder');
  assert.equal(row('m1').status, 'held', 'the current one may still send after hand-back');
});

test('still owed (visit ahead, same slot, nothing newer) -> stays held; held review request on a completed visit is left alone', async () => {
  setup({
    visit: {},
    messages: [{ status: 'held', body: confirm('2026-11-03'), created_at: '2026-10-29T15:00:10.000Z' }],
  });
  const r = await closeStaleHeldTexts({ now: NOW });
  assert.equal(r.checked, 1);
  assert.equal(r.dropped + r.released, 0);
  assert.equal(row('m0').status, 'held', 'a confirmation held seconds after its own booking is not "rescheduled"');
  restore(); restore = undefined;

  setup({
    visit: { status: 'completed' },
    messages: [{ status: 'held', body: buildReviewRequestSms({ name: 'Cj', installState: 'MO', link: 'https://g.page/r' }), created_at: '2026-10-30T15:00:00.000Z' }],
  });
  await closeStaleHeldTexts({ now: NOW });
  assert.equal(row('m0').status, 'held');
});

test('a later terminal refusal of the same message settles it; a transient one does not', async () => {
  setup({
    visit: {},
    messages: [
      { status: 'held', body: confirm('2026-11-03'), created_at: '2026-10-29T16:00:00.000Z' },
      { status: 'quiet_hours', body: confirm('2026-11-03'), created_at: '2026-10-30T02:00:00.000Z' },
    ],
  });
  await closeStaleHeldTexts({ now: NOW });
  assert.equal(row('m0').status, 'held', 'quiet hours keeps it owed');
  world.messages.rows.push({ id: 'm9', direction: 'out', to_phone: PHONE, related_visit_id: VISIT_ID, status: 'opted_out', body: confirm('2026-11-03'), created_at: '2026-10-30T15:00:00.000Z' });
  await closeStaleHeldTexts({ now: NOW });
  assert.equal(row('m0').status, 'dropped');
  assert.equal(row('m0').detail, 'a later attempt was refused (opted_out)');
});

test('dryRun decides without writing; a database error never throws', async () => {
  setup({ visit: { status: 'canceled' }, messages: [{ status: 'held', body: confirm('2026-11-03'), created_at: '2026-10-29T16:00:00.000Z' }] });
  const dry = await closeStaleHeldTexts({ now: NOW, dryRun: true });
  assert.equal(dry.dropped, 1);
  assert.equal(row('m0').status, 'held');
  restore();
  restore = installMockSupabase({ generator_sms_messages: () => ({ data: null, error: { message: 'boom' } }) });
  const r = await closeStaleHeldTexts({ now: NOW });
  assert.equal(r.error, 'boom');
});
