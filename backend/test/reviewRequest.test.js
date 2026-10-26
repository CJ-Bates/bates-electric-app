// Review request the day after a completed visit (sql/038), through the real
// cron pass against the in-memory Supabase stand-in. Every skip rule, the
// Florida rule, the kill-switch, the 10 AM gate, the sent path (visit +
// customer stamped, approved copy, brand at the end only).
require('./helpers/env');

const test = require('node:test');
const assert = require('node:assert/strict');

const mailer = require('../lib/mailer');
mailer.sendViaBrevo = async () => ({ sent: true, messageId: 'm' });

const { installMockSupabase } = require('./helpers/mockSupabase');
const { memTable } = require('./helpers/memTable');
const cron = require('../routes/generator-care-cron');
const { runReviewRequestPass, REVIEW_HOUR } = cron._test;

const CUSTOMER_ID = 'c0000000-0000-4000-8000-000000000001';
const VISIT_ID = 'a0000000-0000-4000-8000-00000000000b';
const PHONE = '+16365550100';
const NOW = new Date('2026-10-27T15:15:00.000Z');       // 10:15 AM CDT
const EARLY = new Date('2026-10-27T14:15:00.000Z');     // 9:15 AM CDT

let restore;
let realFetch;
let smsCalls;
let world;
function setup({ customer = {}, visit = {}, messages = [], convs = [], fl = false } = {}) {
  process.env.SMS_ENABLED = 'true';
  process.env.SIMPLETEXTING_API_TOKEN = 'tok_secret';
  process.env.SIMPLETEXTING_ACCOUNT_PHONE = '8339425468';
  process.env.SMS_REVIEW_REQUESTS_ENABLED = 'true';
  process.env.GOOGLE_REVIEW_URL = 'https://g.page/r/bates-review';
  delete process.env.GOOGLE_REVIEW_URL_FL;
  smsCalls = [];
  realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    if (/simpletexting/.test(String(url))) { smsCalls.push(JSON.parse(opts.body)); return { ok: true, status: 201, json: async () => ({ id: 'prov_' + smsCalls.length }) }; }
    throw new Error('unexpected fetch in offline test: ' + url);
  };
  const cust = { id: CUSTOMER_ID, name: 'Jay King', phone: '636-555-0100', install_state: fl ? 'FL' : 'MO', last_review_request_at: null, sms_invalid_at: null, sms_invalid_phone: null, ...customer };
  world = {
    visits: memTable([{ id: VISIT_ID, status: 'completed', completed_date: '2026-10-26', running_late_at: null, review_request_at: null, review_request_outcome: null, subscription: { customer: cust }, ...visit }]),
    customers: memTable([cust]),
    messages: memTable(messages),
    convs: memTable(convs),
    events: memTable([]),
  };
  restore = installMockSupabase({
    generator_service_visits: world.visits.resolver,
    generator_customers: world.customers.resolver,
    generator_sms_messages: world.messages.resolver,
    generator_sms_conversations: world.convs.resolver,
    generator_sms_conversation_events: world.events.resolver,
    generator_sms_consent: () => ({ data: [{ id: 'cons1', customer_id: CUSTOMER_ID, phone: PHONE, opted_in: true, opted_out: false }], error: null }),
    generator_email_messages: () => ({ data: null, error: null }),
  });
}
test.afterEach(() => {
  for (const k of ['SMS_ENABLED', 'SIMPLETEXTING_API_TOKEN', 'SIMPLETEXTING_ACCOUNT_PHONE', 'SMS_REVIEW_REQUESTS_ENABLED', 'GOOGLE_REVIEW_URL', 'GOOGLE_REVIEW_URL_FL']) delete process.env[k];
  if (restore) { restore(); restore = undefined; }
  if (realFetch) { global.fetch = realFetch; realFetch = undefined; }
});
const v = () => world.visits.rows[0];

test('sent: day after completion at 10:15 AM, approved copy with the brand at the end only; visit + customer stamped', async () => {
  setup();
  const r = await runReviewRequestPass({ now: NOW });
  assert.deepEqual(r, { considered: 1, sent: 1, skipped: 0 });
  assert.equal(smsCalls[0].text, 'Thanks for having us out, Jay! If we took good care of you, a quick review helps a lot: https://g.page/r/bates-review. — Bates Generator Care');
  assert.ok(!smsCalls[0].text.startsWith('Bates'), 'brand at the end only');
  assert.equal(v().review_request_outcome, 'sent');
  assert.ok(v().review_request_at);
  assert.equal(world.customers.rows[0].last_review_request_at, NOW.toISOString());
  const row = world.messages.rows.find((m) => m.status === 'sent');
  assert.equal(row.related_visit_id, VISIT_ID);
  assert.equal(row.sent_by_profile_id, undefined, 'automated');
});

test('off by default (SMS_REVIEW_REQUESTS_ENABLED) and before 10 AM: nothing considered, nothing stamped', async () => {
  setup();
  delete process.env.SMS_REVIEW_REQUESTS_ENABLED;
  assert.deepEqual(await runReviewRequestPass({ now: NOW }), { skipped: 'disabled' });
  process.env.SMS_REVIEW_REQUESTS_ENABLED = 'true';
  assert.deepEqual(await runReviewRequestPass({ now: EARLY }), { skipped: 'before_' + REVIEW_HOUR });
  assert.equal(v().review_request_at, null);
  assert.equal(smsCalls.length, 0);
});

const SKIPS = [
  ['missed the day-after window', { visit: { completed_date: '2026-10-24' } }],
  ['no mobile number', { customer: { phone: null } }],
  ['no review link set', { noUrl: true }],
  ['Florida customer - no S.E. Bates review link set', { fl: true }],
  ['tech was running late', { visit: { running_late_at: '2026-10-26T15:00:00.000Z' } }],
  ['review request already sent in the last 12 months', { customer: { last_review_request_at: '2026-03-01T12:00:00.000Z' } }],
  ['office is handling the conversation', { convs: [{ id: 'conv-1', customer_id: CUSTOMER_ID, phone: PHONE, mode: 'office', owner_profile_id: 'x', taken_over_at: '2026-10-27T15:00:00.000Z', created_at: '2026-10-27T15:00:00.000Z', updated_at: '2026-10-27T15:00:00.000Z' }] }],
  ['customer texted something needing a reply in the last 7 days', { messages: [{ id: 'm1', direction: 'in', customer_id: CUSTOMER_ID, from_phone: PHONE, detail: 'intent: other', body: 'Still waiting on the invoice?', status: 'received', created_at: '2026-10-25T12:00:00.000Z' }] }],
];
for (const [why, opts] of SKIPS) {
  test('skip rule: ' + why, async () => {
    setup(opts);
    if (opts.noUrl) delete process.env.GOOGLE_REVIEW_URL;
    const r = await runReviewRequestPass({ now: NOW });
    assert.equal(r.sent, 0, JSON.stringify(r));
    assert.equal(r.skipped, 1);
    assert.equal(smsCalls.length, 0);
    assert.equal(v().review_request_outcome, 'skipped: ' + why);
    assert.ok(v().review_request_at, 'terminal - never re-considered');
    assert.notEqual(world.customers.rows[0].last_review_request_at, NOW.toISOString(), 'customer stamp untouched');
  });
}

test('a Y or an old text does not count as "needing a reply"; Florida sends when the FL link is set', async () => {
  setup({ fl: true, messages: [
    { id: 'm1', direction: 'in', customer_id: CUSTOMER_ID, from_phone: PHONE, detail: 'intent: confirm', body: 'Y', status: 'received', created_at: '2026-10-25T12:00:00.000Z' },
    { id: 'm2', direction: 'in', customer_id: CUSTOMER_ID, from_phone: PHONE, detail: 'intent: other', body: 'old complaint', status: 'received', created_at: '2026-10-01T12:00:00.000Z' },
  ] });
  process.env.GOOGLE_REVIEW_URL_FL = 'https://g.page/r/se-bates-review';
  const r = await runReviewRequestPass({ now: NOW });
  assert.equal(r.sent, 1, JSON.stringify(r));
  assert.match(smsCalls[0].text, /se-bates-review/);
  assert.match(smsCalls[0].text, /— S\.E\. Bates Generator Care$/);
});

test('a transient refusal (kill-switch) leaves the visit unstamped for the next hourly run', async () => {
  setup();
  process.env.SMS_ENABLED = 'false';
  const r = await runReviewRequestPass({ now: NOW });
  assert.equal(r.skipped, 1);
  assert.equal(v().review_request_at, null);
});
