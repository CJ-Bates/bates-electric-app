// Inbound SMS: free text vs reschedule intent (2026-10-26 incident). A
// customer whose tech was late texted three complaints on visit morning and
// got the reschedule link three times. Pins, with his exact messages:
//   - none of the three is a reschedule request -> no reschedule link
//   - ONE holding reply total (one automated reply per phone per 30 min)
//   - one URGENT office alert (visit today: time + tech + message), then
//     plain alerts for the follow-ups
//   - the appointment is untouched
// Plus: Y/yes/YES! still confirm; "reschedule please", "can I change the
// time", a bare "No" still get the link; STOP/HELP unchanged; a second
// reschedule text inside the window is alert-only.
// Offline: Supabase mocked, SimpleTexting + Brevo stubbed at fetch/mailer.
require('./helpers/env');

const test = require('node:test');
const assert = require('node:assert/strict');

// Capture office emails (lib/emails.js destructures sendViaBrevo at load).
const mailer = require('../lib/mailer');
const officeEmails = [];
mailer.sendViaBrevo = async (args) => { officeEmails.push(args); return { sent: true, messageId: 'm' }; };

process.env.SMS_AUTO_REPLY_WINDOW_MS = String(30 * 60 * 1000);
const { installMockSupabase } = require('./helpers/mockSupabase');
const { getRouteHandler, makeReq, makeRes } = require('./helpers/routeHandler');
const router = require('../routes/sms-inbound');
const { classifyReply } = router._test;
const postHandler = getRouteHandler(router, 'post', '/inbound');

const SECRET = 'test-webhook-secret';
const JAY_ID = 'c0000000-0000-4000-8000-00000000000a';
const VISIT_ID = 'a0000000-0000-4000-8000-00000000000b';
const TECH_ID = 'd0000000-0000-4000-8000-00000000000c';
const JAY_PHONE = '3144958704';
const JAY_E164 = '+13144958704';

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

// Today's visit, 7-9 AM Central: noon UTC is 7 AM CDT / 6 AM CST — same
// Central calendar day either way.
function todayCentralIso() {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
  return today + 'T12:00:00.000Z';
}

// Jay's world. The message log is REAL enough for the loop guard: outbound
// rows the handler inserts are served back to the "recent automated reply"
// lookup, exactly as the database would.
function makeWorld({ visitToday = true } = {}) {
  const world = { logged: [], visitUpdates: [] };
  restoreSupabase = installMockSupabase({
    generator_sms_consent: () => ({
      data: [{ id: 'cons1', customer_id: JAY_ID, opted_in: true, opted_out: false, customer: { id: JAY_ID, name: 'Jay King', install_state: 'MO' } }],
      error: null,
    }),
    generator_sms_messages: (chain) => {
      const ins = chain.find((c) => c.method === 'insert');
      if (ins) { world.logged.push({ ...ins.args[0], created_at: new Date().toISOString() }); return { data: null, error: null }; }
      // The loop-guard select: outbound, sent, automated, recent.
      const wantsOut = chain.some((c) => c.method === 'eq' && c.args[0] === 'direction' && c.args[1] === 'out');
      if (wantsOut) {
        const rows = world.logged.filter((l) => l.direction === 'out' && l.status === 'sent' && !l.sent_by_profile_id);
        return { data: rows.slice(-1), error: null };
      }
      return { data: [], error: null };
    },
    generator_subscriptions: () => ({ data: [{ id: 'sub1' }], error: null }),
    generator_service_visits: (chain) => {
      const upd = chain.find((c) => c.method === 'update');
      if (upd) { world.visitUpdates.push(upd.args[0]); return { data: null, error: null }; }
      return {
        data: visitToday
          ? [{ id: VISIT_ID, subscription_id: 'sub1', appointment_at: todayCentralIso(), arrival_window: '7-9', status: 'scheduled', sms_confirmed_at: null, assigned_tech_id: TECH_ID }]
          : [],
        error: null,
      };
    },
    profiles: () => ({ data: { full_name: 'Jacob Stimpson', email: 'jstimpson.bateselectric@gmail.com' }, error: null }),
    generator_email_messages: () => ({ data: null, error: null }),
  });
  return world;
}

function v2Body(text) {
  return { reportId: 'r1', webhookId: 'w1', type: 'INCOMING_MESSAGE', values: { messageId: 'm1', contactPhone: JAY_PHONE, accountPhone: '8339425468', text } };
}
async function text(msg) {
  const res = makeRes();
  await postHandler(makeReq({ query: { secret: SECRET }, body: v2Body(msg) }), res);
  assert.equal(res.statusCode, 200);
}

const JAY_MESSAGES = [
  'No one has shown up.',
  'I did not cancel.',
  'The technician is supposed to be here, but has not arrived.',
];

test('Jay’s three texts: no reschedule link, one holding reply total, one URGENT alert then plain, appointment untouched', async () => {
  const world = makeWorld();
  for (const m of JAY_MESSAGES) await text(m);

  // Classification: all free text.
  for (const m of JAY_MESSAGES) assert.equal(classifyReply(m), 'other', m);

  // Exactly one automated reply went out, and it is the holding line.
  assert.equal(smsCalls.length, 1, 'one SMS total for three texts');
  assert.match(smsCalls[0].text, /passed this to our office and someone will reach out shortly/);
  assert.doesNotMatch(smsCalls[0].text, /app\.bates-electric\.com\/my|No problem|pick a new date/);
  const outRows = world.logged.filter((l) => l.direction === 'out');
  assert.equal(outRows.length, 1);
  assert.equal(outRows[0].status, 'sent');

  // Three inbound rows logged with intent.
  const inRows = world.logged.filter((l) => l.direction === 'in');
  assert.equal(inRows.length, 3);
  assert.ok(inRows.every((r) => r.detail === 'intent: other'));

  // Office: 3 alerts; the first URGENT with visit time + tech + message, then plain.
  assert.equal(officeEmails.length, 3);
  assert.match(officeEmails[0].subject, /^URGENT: customer texted on visit day - Jay King \(today 7:00.9:00 AM, Jacob Stimpson\)/);
  assert.match(officeEmails[0].text, /Visit: today 7:00.9:00 AM - assigned tech: Jacob Stimpson/);
  assert.match(officeEmails[0].text, /Message: "No one has shown up\."/);
  assert.match(officeEmails[0].text, /holding reply/);
  assert.match(officeEmails[0].text, /\+13144958704/);
  assert.doesNotMatch(officeEmails[0].subject, /^URGENT: URGENT/);
  assert.match(officeEmails[1].subject, /^\[Generator Care\] Text reply needs a look \(visit today\): Jay King$/);
  assert.match(officeEmails[1].text, /No automated reply \(one per 30 min already sent\)/);
  assert.match(officeEmails[1].text, /Message: "I did not cancel\."/);
  assert.match(officeEmails[2].subject, /^\[Generator Care\] Text reply needs a look \(visit today\): Jay King$/);
  assert.ok(officeEmails.every((e) => /No appointment was changed/.test(e.text)));

  // The appointment was never touched.
  assert.equal(world.visitUpdates.length, 0);
});

test('free text with NO visit today: holding reply + plain (non-urgent) alert', async () => {
  const world = makeWorld({ visitToday: false });
  await text('Does the tech need access to the garage?');
  assert.equal(smsCalls.length, 1);
  assert.match(smsCalls[0].text, /someone will reach out shortly/);
  assert.equal(officeEmails.length, 1);
  assert.match(officeEmails[0].subject, /^\[Generator Care\] Text reply needs a look: Jay King$/);
  assert.doesNotMatch(officeEmails[0].subject, /URGENT/);
  assert.doesNotMatch(officeEmails[0].text, /Visit:/);
  assert.equal(world.visitUpdates.length, 0);
});

test('clear reschedule intent still gets the link: "reschedule please", "can I change the time", bare "No"', async () => {
  for (const m of ['reschedule please', 'can I change the time', 'No']) {
    const world = makeWorld({ visitToday: false });
    smsCalls = []; officeEmails.length = 0;
    await text(m);
    assert.equal(classifyReply(m), 'reschedule', m);
    assert.equal(smsCalls.length, 1, m);
    assert.match(smsCalls[0].text, /No problem .* tap https:\/\/app\.bates-electric\.com\/my to pick a new date and time/);
    assert.equal(officeEmails.length, 1);
    assert.match(officeEmails[0].text, /They were sent the reschedule link/);
    assert.equal(world.visitUpdates.length, 0, 'the appointment is never auto-changed');
    restoreSupabase(); restoreSupabase = undefined;
  }
});

test('loop guard applies to reschedule replies too: second request within 30 min is alert-only', async () => {
  makeWorld({ visitToday: false });
  await text('Can we reschedule?');
  await text('Hello? reschedule please');
  assert.equal(smsCalls.length, 1, 'link sent once');
  assert.equal(officeEmails.length, 2);
  assert.match(officeEmails[1].text, /Reschedule link NOT re-sent \(one automated reply per 30 min\)/);
});

test('an operator reply does not count toward the automated-reply window', async () => {
  const world = makeWorld({ visitToday: false });
  // Office replied by hand 5 minutes ago (sent_by_profile_id set).
  world.logged.push({ direction: 'out', to_phone: JAY_E164, status: 'sent', sent_by_profile_id: 'office-1', body: 'Hi Jay, on our way', created_at: new Date(Date.now() - 5 * 60000).toISOString() });
  await text('Any update?');
  assert.equal(smsCalls.length, 1, 'automated holding reply still allowed');
});

test('Y / yes / YES! still confirm the visit; STOP and HELP unchanged', async () => {
  for (const m of ['Y', 'yes', 'YES!']) assert.equal(classifyReply(m), 'confirm', m);
  assert.equal(classifyReply('STOP'), 'stop');
  assert.equal(classifyReply('HELP'), 'help');

  const world = makeWorld();
  await text('YES!');
  assert.equal(world.visitUpdates.length, 1, 'visit stamped confirmed');
  assert.ok(world.visitUpdates[0].sms_confirmed_at);
  assert.equal(smsCalls.length, 1);
  assert.match(smsCalls[0].text, /You're all set/);
  assert.equal(officeEmails.length, 0, 'a confirmation needs no office alert');
});

test('classifier edge cases: negated keywords are free text; sentence-initial No is free text', () => {
  assert.equal(classifyReply('I did not cancel'), 'other');
  assert.equal(classifyReply("I didn't ask to reschedule"), 'other');
  assert.equal(classifyReply('No one has shown up'), 'other');
  assert.equal(classifyReply('Nobody came'), 'other');
  assert.equal(classifyReply('I need to cancel my appointment'), 'reschedule');
  assert.equal(classifyReply("Can't make it tomorrow"), 'reschedule');
  assert.equal(classifyReply('Different day please'), 'reschedule');
  assert.equal(classifyReply('N'), 'reschedule');
  assert.equal(classifyReply('Nope'), 'reschedule');
  assert.equal(classifyReply('CANCEL'), 'stop', 'bare CANCEL is a carrier opt-out keyword the platform acts on');
});
