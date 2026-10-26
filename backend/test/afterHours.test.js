// Honest after-hours replies (lib/officeHours.js + routes/sms-inbound.js):
// office-hours parsing and phrases, and the holding reply swapping to the
// "our office is closed right now" copy outside hours. The reschedule-link
// reply is unchanged either way. Unconfirmed-visit helpers (038) ride along:
// listUnconfirmedSoon + the digest section + the phone-confirmed route.
require('./helpers/env');

const test = require('node:test');
const assert = require('node:assert/strict');

const mailer = require('../lib/mailer');
const emails = [];
mailer.sendViaBrevo = async (args) => { emails.push(args); return { sent: true, messageId: 'm' }; };

const { installMockSupabase } = require('./helpers/mockSupabase');
const { memTable } = require('./helpers/memTable');
const { getRouteHandler, makeReq, makeRes } = require('./helpers/routeHandler');
const oh = require('../lib/officeHours');
const inbound = require('../routes/sms-inbound');
const cron = require('../routes/generator-care-cron');
const visitsRouter = require('../routes/generator-care/visits');
const postHandler = getRouteHandler(inbound, 'post', '/inbound');
const phoneConfirmed = getRouteHandler(visitsRouter, 'post', '/visits/:id/phone-confirmed');

const CUSTOMER_ID = 'c0000000-0000-4000-8000-00000000000a';

test.afterEach(() => { delete process.env.OFFICE_HOURS; });

test('parseOfficeHours: default Mon-Fri 07:30-16:30, a day list, and garbage falls back', () => {
  const d = oh.parseOfficeHours('');
  assert.deepEqual([...d.days], [1, 2, 3, 4, 5]);
  assert.equal(d.open, 450); assert.equal(d.close, 990);
  const list = oh.parseOfficeHours('Mon,Wed,Fri 8:00-17:00');
  assert.deepEqual([...list.days], [1, 3, 5]);
  assert.equal(oh.parseOfficeHours('whenever'), null);
  process.env.OFFICE_HOURS = 'nonsense';
  assert.equal(oh.officeHours().source, oh.DEFAULT_HOURS);
});

test('isOfficeOpen + nextOpenPhrase in Central time', () => {
  process.env.OFFICE_HOURS = 'Mon-Fri 07:30-16:30';
  assert.equal(oh.isOfficeOpen(new Date('2026-10-27T15:00:00Z')), true, 'Tue 10 AM CDT');
  assert.equal(oh.isOfficeOpen(new Date('2026-10-27T11:00:00Z')), false, 'Tue 6 AM');
  assert.equal(oh.isOfficeOpen(new Date('2026-10-31T15:00:00Z')), false, 'Saturday');
  assert.equal(oh.nextOpenPhrase(new Date('2026-10-27T11:00:00Z')), 'later this morning', 'Tue 6 AM');
  assert.equal(oh.nextOpenPhrase(new Date('2026-10-27T23:00:00Z')), 'tomorrow morning', 'Tue 6 PM');
  assert.equal(oh.nextOpenPhrase(new Date('2026-10-30T23:00:00Z')), 'Monday morning', 'Fri 6 PM');
  assert.equal(oh.nextOpenPhrase(new Date('2026-10-31T16:00:00Z')), 'Monday morning', 'Saturday');
  assert.equal(oh.nextOpenPhrase(new Date('2026-11-01T16:00:00Z')), 'tomorrow morning', 'Sunday');
});

// ---------------------------------------------------------------------------
// Inbound: the holding reply swaps copy when the office is closed
// ---------------------------------------------------------------------------
let restore;
let realFetch;
let smsCalls;
function inboundWorld() {
  process.env.SMS_WEBHOOK_SECRET = 's';
  process.env.SMS_ENABLED = 'true';
  process.env.SIMPLETEXTING_API_TOKEN = 'tok';
  process.env.SIMPLETEXTING_ACCOUNT_PHONE = '8339425468';
  emails.length = 0;
  smsCalls = [];
  realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    if (/simpletexting/.test(String(url))) { smsCalls.push(JSON.parse(opts.body)); return { ok: true, status: 201, json: async () => ({ id: 'p' }) }; }
    throw new Error('unexpected fetch: ' + url);
  };
  const w = { messages: memTable([]), convs: memTable([]), events: memTable([]) };
  restore = installMockSupabase({
    generator_sms_consent: () => ({ data: [{ id: 'cons1', customer_id: CUSTOMER_ID, opted_in: true, opted_out: false, customer: { id: CUSTOMER_ID, name: 'Jay King', install_state: 'MO' } }], error: null }),
    generator_sms_conversations: w.convs.resolver,
    generator_sms_conversation_events: w.events.resolver,
    generator_sms_messages: w.messages.resolver,
    generator_subscriptions: () => ({ data: [{ id: 'sub1' }], error: null }),
    generator_service_visits: () => ({ data: [], error: null }),
    generator_customers: () => ({ data: { sms_invalid_at: null, sms_invalid_phone: null }, error: null }),
    generator_email_messages: () => ({ data: null, error: null }),
  });
  return w;
}
function teardownInbound() {
  for (const k of ['SMS_WEBHOOK_SECRET', 'SMS_ENABLED', 'SIMPLETEXTING_API_TOKEN', 'SIMPLETEXTING_ACCOUNT_PHONE']) delete process.env[k];
  if (restore) { restore(); restore = undefined; }
  if (realFetch) { global.fetch = realFetch; realFetch = undefined; }
}
async function text(msg) {
  const res = makeRes();
  await postHandler(makeReq({ query: { secret: 's' }, body: { type: 'INCOMING_MESSAGE', values: { contactPhone: '6365550100', accountPhone: '8339425468', text: msg } } }), res);
  assert.equal(res.statusCode, 200);
}

test('closed: free text gets the after-hours copy with the next-open phrase; the office is still emailed', async () => {
  inboundWorld();
  try {
    process.env.OFFICE_HOURS = 'Mon-Fri 00:00-00:01'; // effectively always closed
    await text('Is anyone there?');
    assert.equal(smsCalls.length, 1);
    assert.match(smsCalls[0].text, /^Thanks for your message, our office is closed right now\. We'll get back to you (later this morning|tomorrow morning|Monday morning|Tuesday morning|Wednesday morning|Thursday morning|Friday morning)\. — Bates Generator Care$/);
    assert.equal(emails.length, 1, 'office alert unchanged');
  } finally { teardownInbound(); }
});

test('open: the regular holding reply; a reschedule phrase gets the link reply either way', async () => {
  const w = inboundWorld();
  try {
    process.env.OFFICE_HOURS = 'Sun-Sat 00:00-23:59'; // always open
    await text('Is anyone there?');
    assert.match(smsCalls[0].text, /^Thanks — we've passed this to our office and someone will reach out shortly\./);
    w.messages.rows.length = 0; // reset the 30-min loop guard's view
    process.env.OFFICE_HOURS = 'Mon-Fri 00:00-00:01';
    await text('Can we reschedule?');
    assert.match(smsCalls[1].text, /^No problem — tap https:\/\/app\.bates-electric\.com\/my/);
  } finally { teardownInbound(); }
});

// ---------------------------------------------------------------------------
// Unconfirmed visits (038): digest list + section + phone-confirmed route
// ---------------------------------------------------------------------------
test('listUnconfirmedSoon: scheduled within 2 days, no Y and no phone confirmation; digest renders the call-to-confirm section', async () => {
  const NOW = new Date('2026-10-27T15:00:00.000Z'); // Tue 10 AM CDT
  const mk = (id, appt, extra = {}) => ({ id, status: 'scheduled', appointment_at: appt, arrival_window: '8-10', sms_confirmed_at: null, phone_confirmed_at: null, subscription: { id: 'sub-' + id, customer: { name: 'Cust ' + id, phone: '636-555-01' + id } }, ...extra });
  const visits = memTable([
    mk('01', '2026-10-27T13:00:00.000Z'),                                   // today
    mk('02', '2026-10-29T13:00:00.000Z'),                                   // 2 days
    mk('03', '2026-10-30T13:00:00.000Z'),                                   // 3 days: no
    mk('04', '2026-10-28T13:00:00.000Z', { sms_confirmed_at: '2026-10-26T12:00:00Z' }), // Y: no
    mk('05', '2026-10-28T13:00:00.000Z', { phone_confirmed_at: '2026-10-26T12:00:00Z' }), // phone: no
    mk('06', '2026-10-26T13:00:00.000Z'),                                   // yesterday: no
  ]);
  restore = installMockSupabase({ generator_service_visits: visits.resolver });
  try {
    const rows = await cron._test.listUnconfirmedSoon({ now: NOW });
    assert.deepEqual(rows.map((r) => r.visit_id), ['01', '02']);
    assert.equal(rows[0].phone, '636-555-0101');
    const { html, text } = cron._test.buildEmail({ upcoming: [], notConfirmed: rows, todayStr: '2026-10-27' });
    assert.match(html, /Not confirmed - call to confirm \(2\)/);
    assert.match(html, /Cust 01 - Tue, Oct 27 8:00.10:00 AM - 636-555-0101/);
    assert.match(text, /NOT CONFIRMED - CALL TO CONFIRM \(2\)/);
  } finally { restore(); restore = undefined; }
});

test('POST /visits/:id/phone-confirmed stamps a scheduled visit with who confirmed; a completed visit is refused', async () => {
  const visits = memTable([
    { id: 'v-sched', status: 'scheduled', phone_confirmed_at: null, phone_confirmed_by: null },
    { id: 'v-done', status: 'completed', phone_confirmed_at: null, phone_confirmed_by: null },
  ]);
  restore = installMockSupabase({ generator_service_visits: visits.resolver });
  try {
    let res = makeRes();
    await phoneConfirmed({ params: { id: 'v-sched' }, body: {}, profile: { id: 'amy' } }, res);
    assert.equal(res.statusCode, 200);
    assert.ok(visits.rows[0].phone_confirmed_at);
    assert.equal(visits.rows[0].phone_confirmed_by, 'amy');
    res = makeRes();
    await phoneConfirmed({ params: { id: 'v-done' }, body: {}, profile: { id: 'amy' } }, res);
    assert.equal(res.statusCode, 409);
    assert.equal(visits.rows[1].phone_confirmed_at, null);
  } finally { restore(); restore = undefined; }
});
