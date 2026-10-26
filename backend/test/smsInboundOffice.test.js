// Inbound webhook in OFFICE MODE (sql/037) — through the real shipped
// handler with an in-memory Supabase stand-in:
//   - free text while a staff member owns the conversation: NO automated
//     reply, NO immediate email (the owner is alerted ~10 min later if still
//     unanswered), inbound logged with the office-mode note, Needs reply set,
//     the deferred owner alert armed
//   - the same on visit day: URGENT email right away to the owner + the
//     office list, still no text
//   - Y in office mode stamps the visit confirmed, no reply goes out
//   - STOP in office mode still opts the number out
//   - auto mode is unchanged: holding reply + office email, Needs reply set
//   - an unmatched number (the service team's conversation on the shared
//     number) creates no conversation and triggers nothing
require('./helpers/env');

const test = require('node:test');
const assert = require('node:assert/strict');

const mailer = require('../lib/mailer');
const officeEmails = [];
mailer.sendViaBrevo = async (args) => { officeEmails.push(args); return { sent: true, messageId: 'm' }; };

process.env.SMS_AUTO_REPLY_WINDOW_MS = String(30 * 60 * 1000);
const { installMockSupabase } = require('./helpers/mockSupabase');
const { memTable } = require('./helpers/memTable');
const { getRouteHandler, makeReq, makeRes } = require('./helpers/routeHandler');
const router = require('../routes/sms-inbound');
const postHandler = getRouteHandler(router, 'post', '/inbound');

const SECRET = 'test-webhook-secret';
const CUSTOMER_ID = 'c0000000-0000-4000-8000-00000000000a';
const VISIT_ID = 'a0000000-0000-4000-8000-00000000000b';
const TECH_ID = 'd0000000-0000-4000-8000-00000000000c';
const AMY = 'a0000000-0000-4000-8000-0000000000a1';
const PHONE10 = '6365550100';
const E164 = '+16365550100';

let restoreSupabase;
let realFetch;
let smsCalls;
test.beforeEach(() => {
  process.env.SMS_WEBHOOK_SECRET = SECRET;
  process.env.SMS_ENABLED = 'true';
  process.env.SIMPLETEXTING_API_TOKEN = 'tok_secret';
  process.env.SIMPLETEXTING_ACCOUNT_PHONE = '8339425468';
  officeEmails.length = 0;
  smsCalls = [];
  realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    if (/simpletexting/.test(String(url))) {
      smsCalls.push(JSON.parse(opts.body));
      return { ok: true, status: 201, json: async () => ({ id: 'prov_' + smsCalls.length }) };
    }
    throw new Error('unexpected fetch in offline test: ' + url);
  };
});
test.afterEach(() => {
  delete process.env.SMS_WEBHOOK_SECRET;
  delete process.env.SMS_ENABLED;
  delete process.env.SIMPLETEXTING_API_TOKEN;
  delete process.env.SIMPLETEXTING_ACCOUNT_PHONE;
  if (restoreSupabase) { restoreSupabase(); restoreSupabase = undefined; }
  if (realFetch) { global.fetch = realFetch; realFetch = undefined; }
});

function todayCentralIso() {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
  return today + 'T12:00:00.000Z';
}
const hoursAgo = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();

// mode: 'office' | 'auto' | 'none' (no conversation row yet)
function makeWorld({ mode = 'office', visitToday = false, matched = true } = {}) {
  const convRows = mode === 'none' ? [] : [{
    id: 'conv-1', customer_id: CUSTOMER_ID, phone: E164, mode,
    owner_profile_id: mode === 'office' ? AMY : null,
    taken_over_at: mode === 'office' ? hoursAgo(0.25) : null,
    last_office_message_at: null, last_inbound_at: null, last_outbound_at: null,
    needs_reply_since: null, owner_alert_due_at: null, owner_alerted_at: null,
    created_at: hoursAgo(1), updated_at: hoursAgo(1),
  }];
  const w = {
    convs: memTable(convRows),
    events: memTable([]),
    messages: memTable([]),
    visits: memTable([{
      id: VISIT_ID, subscription_id: 'sub1', status: 'scheduled', sms_confirmed_at: null, technician_id: TECH_ID,
      arrival_window: '7-9',
      appointment_at: visitToday ? todayCentralIso() : new Date(Date.now() + 5 * 86400000).toISOString(),
    }]),
    profiles: memTable([
      { id: AMY, full_name: 'Amy Pyatt', email: 'amy@example.com' },
      { id: TECH_ID, full_name: 'Jacob Stimpson', email: 'tech@example.com' },
    ]),
    consentUpdates: [],
  };
  restoreSupabase = installMockSupabase({
    generator_sms_consent: (chain) => {
      const upd = chain.find((c) => c.method === 'update');
      if (upd) { w.consentUpdates.push(upd.args[0]); return { data: [{ id: 'cons1' }], error: null }; }
      return {
        data: matched ? [{ id: 'cons1', customer_id: CUSTOMER_ID, opted_in: true, opted_out: false, customer: { id: CUSTOMER_ID, name: 'Jay King', install_state: 'MO' } }] : [],
        error: null,
      };
    },
    generator_sms_conversations: w.convs.resolver,
    generator_sms_conversation_events: w.events.resolver,
    generator_sms_messages: w.messages.resolver,
    generator_subscriptions: () => ({ data: [{ id: 'sub1' }], error: null }),
    generator_service_visits: w.visits.resolver,
    profiles: w.profiles.resolver,
    generator_email_messages: () => ({ data: null, error: null }),
  });
  return w;
}

function v2Body(text) {
  return { reportId: 'r1', webhookId: 'w1', type: 'INCOMING_MESSAGE', values: { messageId: 'm1', contactPhone: PHONE10, accountPhone: '8339425468', text } };
}
async function text(msg) {
  const res = makeRes();
  await postHandler(makeReq({ query: { secret: SECRET }, body: v2Body(msg) }), res);
  assert.equal(res.statusCode, 200);
}
const inboundRows = (w) => w.messages.rows.filter((m) => m.direction === 'in');
const outboundRows = (w) => w.messages.rows.filter((m) => m.direction === 'out');

test('office mode, free text: no automated reply, no immediate email, inbound logged with the office-mode note, Needs reply + owner alert armed', async () => {
  const w = makeWorld({ mode: 'office' });
  await text('Is the tech still coming today?');
  assert.equal(smsCalls.length, 0, 'nothing texted');
  assert.equal(outboundRows(w).length, 0, 'no outbound row of any status');
  assert.equal(officeEmails.length, 0, 'owner is alerted later, not now');
  assert.equal(inboundRows(w).length, 1);
  assert.match(inboundRows(w)[0].detail, /intent: other; office mode - no automated reply/);
  const conv = w.convs.rows[0];
  assert.equal(conv.mode, 'office');
  assert.ok(conv.last_inbound_at);
  assert.ok(conv.needs_reply_since, 'Needs reply set');
  assert.ok(conv.owner_alert_due_at, 'deferred owner alert armed');
  assert.equal(w.visits.rows[0].sms_confirmed_at, null, 'appointment untouched');
});

test('office mode, reschedule phrase: still no reschedule link, Needs reply set', async () => {
  const w = makeWorld({ mode: 'office' });
  await text('Can we reschedule to next week');
  assert.equal(smsCalls.length, 0);
  assert.match(inboundRows(w)[0].detail, /intent: reschedule; office mode/);
  assert.ok(w.convs.rows[0].needs_reply_since);
});

test('office mode on VISIT DAY: URGENT email right away to the owner + office list, still no text', async () => {
  const w = makeWorld({ mode: 'office', visitToday: true });
  await text('No one has shown up.');
  assert.equal(smsCalls.length, 0);
  assert.equal(officeEmails.length, 1);
  const mail = officeEmails[0];
  assert.match(mail.subject, /^URGENT: customer texted on visit day - Jay King \(today 7:00.9:00 AM, Jacob Stimpson\)/);
  assert.ok(mail.to.includes('amy@example.com'), 'owner is a recipient');
  assert.ok(mail.to.some((a) => /bates-electric\.com/.test(a)), 'office list still gets the urgent one');
  assert.match(mail.text, /Office mode: Amy Pyatt owns this conversation, so no automated reply went out/);
  assert.match(mail.text, /No appointment was changed/);
  assert.equal(w.visits.rows[0].sms_confirmed_at, null);
});

test('office mode, Y: the visit is stamped confirmed and NO confirmation text goes out', async () => {
  const w = makeWorld({ mode: 'office' });
  await text('Y');
  assert.ok(w.visits.rows[0].sms_confirmed_at, 'confirmed');
  assert.equal(smsCalls.length, 0, 'no "You\'re all set" reply');
  assert.equal(officeEmails.length, 0);
  assert.equal(w.convs.rows[0].needs_reply_since, null, 'a Y does not need a human answer');
  assert.ok(w.convs.rows[0].owner_alert_due_at, 'but the owner is nudged to acknowledge it');
});

test('office mode, STOP: the number is opted out exactly as in auto mode', async () => {
  const w = makeWorld({ mode: 'office' });
  await text('STOP');
  assert.equal(w.consentUpdates.length, 1);
  assert.equal(w.consentUpdates[0].opted_out, true);
  assert.equal(smsCalls.length, 0);
  assert.equal(w.convs.rows[0].needs_reply_since, null);
  assert.equal(w.convs.rows[0].owner_alert_due_at, null, 'carrier plumbing does not page the owner');
});

test('auto mode is unchanged: holding reply goes out, office list emailed, Needs reply set on the conversation', async () => {
  const w = makeWorld({ mode: 'auto' });
  await text('Is the tech still coming today?');
  assert.equal(smsCalls.length, 1);
  assert.match(smsCalls[0].text, /passed this to our office/);
  assert.equal(officeEmails.length, 1);
  assert.match(officeEmails[0].subject, /Text reply needs a look: Jay King/);
  assert.ok(w.convs.rows[0].needs_reply_since);
  assert.equal(w.convs.rows[0].owner_alert_due_at, null);
  assert.ok(w.convs.rows[0].last_outbound_at, 'the sent holding reply stamps last_outbound_at');
});

test('first-ever text from a customer creates the conversation row in auto', async () => {
  const w = makeWorld({ mode: 'none' });
  await text('Hello?');
  assert.equal(w.convs.rows.length, 1);
  assert.equal(w.convs.rows[0].mode, 'auto');
  assert.equal(w.convs.rows[0].customer_id, CUSTOMER_ID);
  assert.equal(w.convs.rows[0].phone, E164);
  assert.equal(smsCalls.length, 1, 'holding reply as usual');
});

test('idle office row (taken over 3h ago, no office text) is treated as auto by the webhook: holding reply goes out, audit row written', async () => {
  const w = makeWorld({ mode: 'office' });
  w.convs.rows[0].taken_over_at = hoursAgo(3);
  await text('Anyone there?');
  assert.equal(w.convs.rows[0].mode, 'auto');
  assert.equal(w.events.rows.length, 1);
  assert.equal(w.events.rows[0].reason, 'idle_timeout');
  assert.equal(smsCalls.length, 1);
  assert.doesNotMatch(inboundRows(w)[0].detail, /office mode/);
});

test('unmatched number (someone else\'s conversation on the shared account): no conversation, no reply, no email', async () => {
  const w = makeWorld({ mode: 'none', matched: false });
  await text('Hey this is about my service call');
  assert.equal(w.convs.rows.length, 0, 'no conversation row for a non-customer');
  assert.equal(smsCalls.length, 0);
  assert.equal(officeEmails.length, 0);
  assert.equal(inboundRows(w).length, 1, 'still logged as unmatched');
  assert.match(inboundRows(w)[0].detail, /unmatched number/);
  assert.equal(inboundRows(w)[0].customer_id, null);
});
