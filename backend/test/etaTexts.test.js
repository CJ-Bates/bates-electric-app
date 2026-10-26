// Tech "On my way" / "Running late" texts (sql/038, lib/etaTexts.js) through
// the real shipped code against the in-memory Supabase stand-in:
//   - On my way: sent with the approved copy, the thread row carries the
//     tech as sent_by, the visit is stamped (en_route_at / eta_at); a second
//     tap sends the UPDATED-ETA copy
//   - allowed from 7 AM Central on the visit day, refused at 6:30
//   - office mode does NOT hold these (operational texts the customer wants)
//   - no consent -> can_text=false with the number to call; Running late
//     still alerts the office (email + thread note) and stamps the visit
//   - Running late in the normal case: text + office email + system note
//   - not today / not scheduled / bad ETA -> 409 / 400 shaped results
//   - routes: tech route behind the limiter; office routes allowlisted
require('./helpers/env');

const test = require('node:test');
const assert = require('node:assert/strict');

const mailer = require('../lib/mailer');
const emails = [];
mailer.sendViaBrevo = async (args) => { emails.push(args); return { sent: true, messageId: 'm' }; };

const { installMockSupabase } = require('./helpers/mockSupabase');
const { memTable } = require('./helpers/memTable');
const { getRouteHandler } = require('./helpers/routeHandler');
const { sendEtaText, resolveEta } = require('../lib/etaTexts');
const techRouter = require('../routes/generator-tech');
const visitsRouter = require('../routes/generator-care/visits');

const CUSTOMER_ID = 'c0000000-0000-4000-8000-000000000001';
const VISIT_ID = 'a0000000-0000-4000-8000-00000000000b';
const TECH_ID = 'd0000000-0000-4000-8000-00000000000c';
const AMY = 'a0000000-0000-4000-8000-0000000000a1';
const PHONE = '+16365550100';
const TECH = { id: TECH_ID, role: 'tech', full_name: 'Jacob Stimpson', email: 'jacob@example.com' };

// 9:30 AM CDT on 2026-10-27 (14:30Z); the visit is 8-10 AM that day.
const NOW = new Date('2026-10-27T14:30:00.000Z');
const SIX_THIRTY = new Date('2026-10-27T11:30:00.000Z');
const SEVEN_FIFTEEN = new Date('2026-10-27T12:15:00.000Z');

let restore;
let realFetch;
let smsCalls;
let world;
function setup({ consent = 'in', officeMode = false, appointmentAt = '2026-10-27T13:00:00.000Z', status = 'scheduled', enRouteAt = null } = {}) {
  process.env.SMS_ENABLED = 'true';
  process.env.SIMPLETEXTING_API_TOKEN = 'tok_secret';
  process.env.SIMPLETEXTING_ACCOUNT_PHONE = '8339425468';
  emails.length = 0;
  smsCalls = [];
  realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    if (/simpletexting/.test(String(url))) { smsCalls.push(JSON.parse(opts.body)); return { ok: true, status: 201, json: async () => ({ id: 'prov_' + smsCalls.length }) }; }
    throw new Error('unexpected fetch in offline test: ' + url);
  };
  const consentRows = consent === 'in' ? [{ id: 'cons1', customer_id: CUSTOMER_ID, phone: PHONE, opted_in: true, opted_out: false }]
    : consent === 'out' ? [{ id: 'cons1', customer_id: CUSTOMER_ID, phone: PHONE, opted_in: true, opted_out: true }] : [];
  world = {
    visits: memTable([{
      id: VISIT_ID, status, appointment_at: appointmentAt, arrival_window: '8-10', assigned_tech_id: TECH_ID,
      en_route_at: enRouteAt, eta_at: null, running_late_at: null, late_reason: null, completed_date: null, subscription_id: 'sub1',
      subscription: { id: 'sub1', customer: { id: CUSTOMER_ID, name: 'Jay King', phone: '636-555-0100', install_state: 'MO' } },
    }]),
    messages: memTable([]),
    convs: memTable(officeMode ? [{ id: 'conv-1', customer_id: CUSTOMER_ID, phone: PHONE, mode: 'office', owner_profile_id: AMY, taken_over_at: new Date(NOW.getTime() - 600000).toISOString(), created_at: NOW.toISOString(), updated_at: NOW.toISOString() }] : []),
    events: memTable([]),
    profiles: memTable([{ id: TECH_ID, full_name: 'Jacob Stimpson', email: 'jacob@example.com' }, { id: AMY, full_name: 'Amy Pyatt', email: 'amy@example.com' }]),
    customers: memTable([{ id: CUSTOMER_ID, name: 'Jay King', phone: '636-555-0100', sms_invalid_at: null, sms_invalid_phone: null }]),
  };
  restore = installMockSupabase({
    generator_service_visits: world.visits.resolver,
    generator_sms_messages: world.messages.resolver,
    generator_sms_conversations: world.convs.resolver,
    generator_sms_conversation_events: world.events.resolver,
    generator_sms_consent: () => ({ data: consentRows, error: null }),
    profiles: world.profiles.resolver,
    generator_customers: world.customers.resolver,
    generator_email_messages: () => ({ data: null, error: null }),
  });
}
test.afterEach(() => {
  delete process.env.SMS_ENABLED; delete process.env.SIMPLETEXTING_API_TOKEN; delete process.env.SIMPLETEXTING_ACCOUNT_PHONE;
  if (restore) { restore(); restore = undefined; }
  if (realFetch) { global.fetch = realFetch; realFetch = undefined; }
});
const visit = () => world.visits.rows[0];
const notes = () => world.messages.rows.filter((m) => m.status === 'note');

test('On my way: approved copy, sent as the tech, visit stamped; second tap = updated-ETA copy', async () => {
  setup();
  const r = await sendEtaText({ visitId: VISIT_ID, kind: 'on_my_way', etaMinutes: 30, sender: TECH, now: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.sent, true);
  assert.equal(r.can_text, true);
  assert.equal(smsCalls.length, 1);
  assert.equal(smsCalls[0].text, 'Bates Generator Care: Jacob is on the way and should arrive around 10:00 AM.');
  const row = world.messages.rows.find((m) => m.status === 'sent');
  assert.equal(row.sent_by_profile_id, TECH_ID, 'thread labels it with the tech');
  assert.equal(row.related_visit_id, VISIT_ID);
  assert.equal(visit().en_route_at, NOW.toISOString());
  assert.equal(visit().eta_at, new Date(NOW.getTime() + 30 * 60000).toISOString());
  assert.equal(visit().eta_sent_by, TECH_ID);
  assert.equal(emails.length, 0, 'on my way does not email the office');

  const r2 = await sendEtaText({ visitId: VISIT_ID, kind: 'on_my_way', etaMinutes: 45, sender: TECH, now: NOW });
  assert.equal(r2.sent, true);
  assert.equal(smsCalls[1].text, 'Bates Generator Care: Jacob\'s arrival time is now around 10:15 AM.');
  assert.equal(visit().en_route_at, NOW.toISOString(), 'first en-route time kept');
  assert.equal(visit().eta_at, new Date(NOW.getTime() + 45 * 60000).toISOString(), 'ETA updated');
});

test('7 AM rule: allowed at 7:15 AM Central on the visit day, refused (quiet hours) at 6:30', async () => {
  setup();
  const early = await sendEtaText({ visitId: VISIT_ID, kind: 'on_my_way', etaMinutes: 30, sender: TECH, now: SIX_THIRTY });
  assert.equal(early.sent, false);
  assert.equal(early.status, 'quiet_hours');
  assert.equal(early.can_text, true, 'not a "call them" case - just too early');
  assert.equal(visit().en_route_at, null);
  const ok = await sendEtaText({ visitId: VISIT_ID, kind: 'on_my_way', etaMinutes: 30, sender: TECH, now: SEVEN_FIFTEEN });
  assert.equal(ok.sent, true);
  assert.equal(smsCalls.length, 1);
});

test('office mode does NOT hold ETA texts', async () => {
  setup({ officeMode: true });
  const r = await sendEtaText({ visitId: VISIT_ID, kind: 'on_my_way', etaMinutes: 20, sender: TECH, now: NOW });
  assert.equal(r.sent, true);
  assert.equal(smsCalls.length, 1);
  assert.equal(world.messages.rows.filter((m) => m.status === 'held').length, 0);
});

test('Running late: text + office email + system note in the thread, visit flagged with the reason', async () => {
  setup({ enRouteAt: '2026-10-27T13:30:00.000Z' });
  const r = await sendEtaText({ visitId: VISIT_ID, kind: 'running_late', etaMinutes: 40, reason: 'traffic', sender: TECH, now: NOW });
  assert.equal(r.sent, true);
  assert.equal(smsCalls[0].text, 'Bates Generator Care: Jacob is running a little behind and should now arrive around 10:10 AM. Sorry for the wait.');
  assert.equal(visit().running_late_at, NOW.toISOString());
  assert.equal(visit().late_reason, 'traffic');
  assert.equal(emails.length, 1);
  assert.match(emails[0].subject, /^\[Generator Care\] Running late: Jacob Stimpson for Jay King \(new ETA 10:10 AM\)/);
  assert.match(emails[0].text, /traffic/);
  assert.equal(notes().length, 1);
  assert.match(notes()[0].body, /Running late: Jacob Stimpson texted a new ETA of 10:10 AM \(traffic\)\./);
  assert.equal(notes()[0].customer_id, CUSTOMER_ID);
  assert.equal(notes()[0].detail, 'system note - not a text');
});

for (const [label, consent, why] of [['no consent', 'none', 'no text consent on file'], ['opted out', 'out', 'they replied STOP']]) {
  test(`${label}: can_text=false with the number to call; Running late still alerts the office`, async () => {
    setup({ consent });
    const omw = await sendEtaText({ visitId: VISIT_ID, kind: 'on_my_way', etaMinutes: 30, sender: TECH, now: NOW });
    assert.equal(omw.sent, false);
    assert.equal(omw.can_text, false);
    assert.equal(omw.call_phone, PHONE);
    assert.match(omw.message, new RegExp("This customer doesn't get texts \\(" + why + "\\) - call them"));
    assert.equal(visit().en_route_at, null, 'nothing reached the customer, nothing stamped');
    assert.equal(emails.length, 0);

    const late = await sendEtaText({ visitId: VISIT_ID, kind: 'running_late', etaMinutes: 30, reason: 'previous_job', sender: TECH, now: NOW });
    assert.equal(late.sent, false);
    assert.equal(late.can_text, false);
    assert.equal(smsCalls.length, 0);
    assert.equal(visit().running_late_at, NOW.toISOString(), 'late flag recorded regardless');
    assert.equal(emails.length, 1, 'office still told');
    assert.match(emails[0].text, /could NOT be texted/);
    assert.match(notes()[0].body, /could not be texted \(/);
    assert.match(notes()[0].body, /call them/);
  });
}

test('guards: not today -> 409, not scheduled -> 409, unknown kind / bad ETA / bad reason -> 400', async () => {
  setup({ appointmentAt: '2026-10-29T13:00:00.000Z' });
  let r = await sendEtaText({ visitId: VISIT_ID, kind: 'on_my_way', etaMinutes: 30, sender: TECH, now: NOW });
  assert.equal(r.ok, false); assert.equal(r.httpStatus, 409);
  restore();
  setup({ status: 'completed' });
  r = await sendEtaText({ visitId: VISIT_ID, kind: 'on_my_way', etaMinutes: 30, sender: TECH, now: NOW });
  assert.equal(r.httpStatus, 409);
  restore();
  setup();
  assert.equal((await sendEtaText({ visitId: VISIT_ID, kind: 'teleport', etaMinutes: 30, sender: TECH, now: NOW })).httpStatus, 400);
  assert.equal((await sendEtaText({ visitId: VISIT_ID, kind: 'on_my_way', etaMinutes: 999, sender: TECH, now: NOW })).httpStatus, 400);
  assert.equal((await sendEtaText({ visitId: VISIT_ID, kind: 'running_late', etaMinutes: 30, reason: 'dog', sender: TECH, now: NOW })).httpStatus, 400);
  assert.equal(smsCalls.length, 0);
  assert.equal(resolveEta({ etaAt: 'garbage', now: NOW }), null);
  assert.equal(resolveEta({ etaMinutes: 15, now: NOW }).toISOString(), new Date(NOW.getTime() + 15 * 60000).toISOString());
});

test('routes: tech ETA route is behind the sensitive limiter; office ETA + phone-confirmed exist and are allowlisted', () => {
  const tech = techRouter.stack.find((l) => l.route && l.route.path === '/my-visits/:id/eta' && l.route.methods.post);
  assert.ok(tech);
  assert.equal(tech.route.stack.length, 2, 'limiter + handler');
  assert.ok(getRouteHandler(visitsRouter, 'post', '/visits/:id/eta'));
  assert.ok(getRouteHandler(visitsRouter, 'post', '/visits/:id/phone-confirmed'));
  const scan = require('fs').readFileSync(require('path').join(__dirname, '..', 'scripts', 'check-gc-permissions.js'), 'utf8');
  assert.match(scan, /'\/visits\/:id\/eta'/);
  assert.match(scan, /'\/visits\/:id\/phone-confirmed'/);
});
