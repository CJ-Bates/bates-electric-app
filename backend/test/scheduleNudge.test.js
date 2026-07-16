// SMS Phase 3 (schedule nudge + auto-login magic link) — fully offline.
// Covers the spec's verification list:
//   - sendMagicLoginSms mints via generateLink({type:'magiclink'}) with the
//     my. redirect, routes the send through sendSms, and the raw link NEVER
//     appears in the logged generator_sms_messages row (redaction)
//   - nudge idempotency: an open visit already stamped gets no second nudge;
//     a fresh one does; 'disabled' does NOT stamp (retries via the cron
//     sweep), 'sent'/'no_consent' do
//   - open-visit creation: invoice.upcoming with no open visit creates
//     exactly one tentative visit; an existing open visit is reused
//   - copy: transactional, FL brand swap, contains the link and STOP
//   - consent gating: an opted-out customer gets the renewal email but no
//     text (and the nudge is stamped terminal so it never re-tries)
//   - cron retry sweep: a queued-but-unsent visit (e.g. the webhook landed in
//     quiet hours) is retried by runNudgeRetryPass and stamped on terminal
require('./helpers/env');

const test = require('node:test');
const assert = require('node:assert/strict');

const { installMockSupabase } = require('./helpers/mockSupabase');
const { supabaseAdmin } = require('../lib/supabase');
const sms = require('../lib/sms');
const webhook = require('../routes/generator-webhook');
const cron = require('../routes/generator-care-cron');
const { maybeSendScheduleNudge, handleInvoiceUpcoming } = webhook._test;
const { runNudgeRetryPass } = cron._test;

const CUSTOMER_ID = 'c0000000-0000-4000-8000-000000000001';
const SUB_ID = 's0000000-0000-4000-8000-000000000001';

// What a real generateLink returns: the Supabase-hosted verify URL carrying
// the one-time token. The token marker is what the redaction asserts on.
const ACTION_LINK = 'https://dummy.supabase.co/auth/v1/verify?token=SECRET-OTP-TOKEN' +
  '&type=magiclink&redirect_to=https%3A%2F%2Fmy.bates-electric.com%2F';

// Pinned clock: 8:30am CDT — inside quiet hours, so the only thing between a
// consented customer and 'sent' is the transport mock.
const NOW = new Date('2026-07-15T13:30:00Z');

let restoreSupabase;
let realFetch;
let realGenerateLink;
let realCreateUser;
let linkCalls;
let createUserCalls;

test.afterEach(() => {
  if (restoreSupabase) { restoreSupabase(); restoreSupabase = undefined; }
  if (realFetch) { global.fetch = realFetch; realFetch = undefined; }
  if (realGenerateLink) { supabaseAdmin.auth.admin.generateLink = realGenerateLink; realGenerateLink = undefined; }
  if (realCreateUser) { supabaseAdmin.auth.admin.createUser = realCreateUser; realCreateUser = undefined; }
  delete process.env.SMS_ENABLED;
  delete process.env.SIMPLETEXTING_API_TOKEN;
  delete process.env.SIMPLETEXTING_ACCOUNT_PHONE;
  delete process.env.BREVO_API_KEY;
});

function armTransport() {
  process.env.SMS_ENABLED = 'true';
  process.env.SIMPLETEXTING_API_TOKEN = 'tok_secret';
  process.env.SIMPLETEXTING_ACCOUNT_PHONE = '8339425468';
}

function mockGenerateLink(impl) {
  linkCalls = [];
  createUserCalls = [];
  realGenerateLink = supabaseAdmin.auth.admin.generateLink;
  supabaseAdmin.auth.admin.generateLink = async (args) => {
    linkCalls.push(args);
    return impl
      ? impl(args)
      : { data: { properties: { action_link: ACTION_LINK } }, error: null };
  };
  realCreateUser = supabaseAdmin.auth.admin.createUser;
  supabaseAdmin.auth.admin.createUser = async (args) => {
    createUserCalls.push(args);
    return { data: { user: { id: 'u1' } }, error: null };
  };
}

// Routes every fetch by host: Brevo (renewal email) and SimpleTexting (the
// nudge) are captured; anything else is a test bug.
function routeFetch(world) {
  realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('api.brevo.com')) {
      world.emails.push(JSON.parse(opts.body));
      return { ok: true, status: 201, json: async () => ({ messageId: 'm1' }) };
    }
    if (u.includes('simpletexting.com')) {
      world.texts.push(JSON.parse(opts.body));
      return { ok: true, status: 201, json: async () => ({ id: 'prov_1' }) };
    }
    throw new Error('unexpected fetch in offline test: ' + u);
  };
}

function makeCustomer(extra = {}) {
  return { id: CUSTOMER_ID, name: 'Sarah Example', email: 'sarah@example.com', phone: '6365550100', install_state: 'MO', ...extra };
}

function makeVisit(id, extra = {}) {
  return {
    id,
    subscription_id: SUB_ID,
    status: 'tentative',
    completed_date: null,
    scheduled_date: '2027-01-15',
    schedule_nudge_queued_at: null,
    schedule_nudge_sent_at: null,
    ...extra,
  };
}

// Mock world. The visits resolver REPLAYS the recorded query chain against an
// in-memory table, so the code's own filters (open = not completed, not
// canceled; queued-unsent for the sweep) are what select rows, and a stamped
// visit really disappears from the next pass.
function makeWorld({ visits, consentRows, subRow } = {}) {
  const world = {
    visits: visits || [],
    inserts: [],  // generator_service_visits inserts
    updates: [],  // { id, patch } for every visit update (queue + stamp)
    logged: [],   // generator_sms_messages inserts
    emails: [],   // Brevo payloads
    texts: [],    // SimpleTexting payloads
  };
  restoreSupabase = installMockSupabase({
    generator_subscriptions: () => ({ data: subRow !== undefined ? subRow : null, error: null }),
    generator_service_visits: (chain, terminal) => {
      const ins = chain.find((c) => c.method === 'insert');
      if (ins) {
        world.inserts.push(ins.args[0]);
        const created = makeVisit('v-created', { ...ins.args[0] });
        world.visits.push(created);
        return { data: created, error: null };
      }
      const upd = chain.find((c) => c.method === 'update');
      if (upd) {
        const idEq = chain.find((c) => c.method === 'eq' && c.args[0] === 'id');
        const visit = world.visits.find((v) => v.id === (idEq && idEq.args[1]));
        if (visit) Object.assign(visit, upd.args[0]);
        world.updates.push({ id: idEq && idEq.args[1], patch: upd.args[0] });
        return { data: null, error: null };
      }
      let rows = world.visits.slice();
      for (const c of chain) {
        if (c.method === 'eq') rows = rows.filter((r) => r[c.args[0]] === c.args[1]);
        if (c.method === 'neq') rows = rows.filter((r) => r[c.args[0]] !== c.args[1]);
        if (c.method === 'is' && c.args[1] === null) rows = rows.filter((r) => r[c.args[0]] == null);
        if (c.method === 'not' && c.args[1] === 'is' && c.args[2] === null) rows = rows.filter((r) => r[c.args[0]] != null);
      }
      if (terminal === 'maybeSingle' || terminal === 'single') return { data: rows[0] || null, error: null };
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

// ---------------------------------------------------------------------------
// Copy builder
// ---------------------------------------------------------------------------
test('buildScheduleNudgeSms: transactional, has the link, the year, and STOP', () => {
  const body = sms.buildScheduleNudgeSms({ installState: 'MO', year: 2027, link: 'https://x.example/L' });
  assert.equal(body,
    'Bates Generator Care: it\'s time to schedule your generator maintenance for 2027. ' +
    'Tap to pick a date & time: https://x.example/L. Reply STOP to opt out.');
});

test('buildScheduleNudgeSms: FL brand swap; yearless form omits "for"', () => {
  const fl = sms.buildScheduleNudgeSms({ installState: 'FL', year: 2027, link: 'L' });
  assert.ok(fl.startsWith('S.E. Bates Generator Care:'), fl);
  const noYear = sms.buildScheduleNudgeSms({ installState: 'MO', year: null, link: 'L' });
  assert.ok(noYear.includes('your generator maintenance. Tap'), noYear);
  assert.ok(!noYear.includes('for '), noYear);
});

// ---------------------------------------------------------------------------
// Part A: sendMagicLoginSms
// ---------------------------------------------------------------------------
test('sendMagicLoginSms: magiclink type + my. redirect, real link on the wire, REDACTED link in the log', async () => {
  armTransport();
  const world = makeWorld();
  routeFetch(world);
  mockGenerateLink();

  const result = await sms.sendMagicLoginSms({
    customerId: CUSTOMER_ID,
    phone: '6365550100',
    email: 'sarah@example.com',
    buildBody: (link) => 'Tap: ' + link + '. Reply STOP to opt out.',
    now: NOW,
  });

  assert.equal(result.status, 'sent');
  assert.equal(linkCalls.length, 1);
  assert.equal(linkCalls[0].type, 'magiclink');
  assert.equal(linkCalls[0].email, 'sarah@example.com');
  assert.equal(linkCalls[0].options.redirectTo, 'https://my.bates-electric.com/');

  // The wire carries the real single-use link...
  assert.equal(world.texts.length, 1);
  assert.ok(world.texts[0].text.includes(ACTION_LINK), world.texts[0].text);

  // ...but the logged copy never does — placeholder only. This is the
  // treat-it-like-a-password guarantee.
  assert.equal(world.logged.length, 1);
  assert.equal(world.logged[0].status, 'sent');
  assert.ok(!world.logged[0].body.includes('SECRET-OTP-TOKEN'), world.logged[0].body);
  assert.ok(!world.logged[0].body.includes(ACTION_LINK), world.logged[0].body);
  assert.ok(world.logged[0].body.includes('[auto-login link]'), world.logged[0].body);
});

test('sendMagicLoginSms: never-signed-in customer — auth account created on demand, then link mints', async () => {
  armTransport();
  const world = makeWorld();
  routeFetch(world);
  // First mint: no auth user yet (the portal creates accounts on first
  // sign-in, so a customer who never signed in has none). Second: success.
  mockGenerateLink(() => (linkCalls.length === 1
    ? { data: null, error: { message: 'User not found' } }
    : { data: { properties: { action_link: ACTION_LINK } }, error: null }));

  const result = await sms.sendMagicLoginSms({
    customerId: CUSTOMER_ID, phone: '6365550100', email: 'sarah@example.com',
    buildBody: (link) => 'Tap: ' + link + '. Reply STOP to opt out.', now: NOW,
  });

  assert.equal(result.status, 'sent');
  assert.deepEqual(createUserCalls, [{ email: 'sarah@example.com', email_confirm: true }]);
  assert.equal(linkCalls.length, 2, 'minted again after creating the account');
  assert.equal(world.texts.length, 1);
});

test('sendMagicLoginSms: generateLink failure returns non-terminal failed, sends nothing', async () => {
  armTransport();
  const world = makeWorld();
  routeFetch(world);
  mockGenerateLink(() => ({ data: null, error: { message: 'auth service unavailable' } }));

  const result = await sms.sendMagicLoginSms({
    customerId: CUSTOMER_ID, phone: '6365550100', email: 'sarah@example.com',
    buildBody: (link) => 'Tap: ' + link, now: NOW,
  });
  assert.equal(result.sent, false);
  assert.equal(result.status, 'failed', 'non-terminal so callers retry');
  assert.equal(createUserCalls.length, 0, 'only a user-not-found error creates an account');
  assert.equal(world.texts.length, 0);
});

test('sendMagicLoginSms: unusable phone never mints a link; refusal logged with placeholder', async () => {
  armTransport();
  const world = makeWorld();
  routeFetch(world);
  mockGenerateLink();

  const result = await sms.sendMagicLoginSms({
    customerId: CUSTOMER_ID, phone: null, email: 'sarah@example.com',
    buildBody: (link) => 'Tap: ' + link, now: NOW,
  });
  assert.equal(result.status, 'invalid_phone');
  assert.equal(linkCalls.length, 0, 'no link minted for an unsendable phone');
  assert.equal(world.texts.length, 0);
  assert.equal(world.logged.length, 1);
  assert.ok(world.logged[0].body.includes('[auto-login link]'), world.logged[0].body);
});

// ---------------------------------------------------------------------------
// Part B: maybeSendScheduleNudge (the invoice.upcoming hook)
// ---------------------------------------------------------------------------
test('fresh open visit: queued, nudged, and stamped sent', async () => {
  armTransport();
  const world = makeWorld({ visits: [makeVisit('v-open')] });
  routeFetch(world);
  mockGenerateLink();

  await maybeSendScheduleNudge({ sub: { id: SUB_ID }, customer: makeCustomer(), periodEndDate: '2027-01-15', now: NOW });

  assert.equal(world.inserts.length, 0, 'existing open visit is reused');
  assert.equal(world.texts.length, 1);
  assert.ok(world.texts[0].text.includes('for 2027'), world.texts[0].text);
  assert.ok(world.texts[0].text.includes(ACTION_LINK), world.texts[0].text);
  const v = world.visits[0];
  assert.ok(v.schedule_nudge_queued_at, 'queued before the send');
  assert.ok(v.schedule_nudge_sent_at, 'stamped on sent');
});

test('no open visit: exactly one tentative regular_service visit is created and nudged', async () => {
  armTransport();
  // A completed and a canceled visit exist — neither counts as open.
  const world = makeWorld({
    visits: [
      makeVisit('v-done', { status: 'completed', completed_date: '2026-06-01' }),
      makeVisit('v-cx', { status: 'canceled' }),
    ],
  });
  routeFetch(world);
  mockGenerateLink();

  await maybeSendScheduleNudge({ sub: { id: SUB_ID }, customer: makeCustomer(), periodEndDate: '2027-01-15', now: NOW });

  assert.equal(world.inserts.length, 1);
  assert.deepEqual(world.inserts[0], {
    subscription_id: SUB_ID,
    visit_type: 'regular_service',
    scheduled_date: '2027-01-15',
    status: 'tentative',
  }, 'mirrors the subscription.created first-visit shape');
  assert.equal(world.texts.length, 1);
  const created = world.visits.find((v) => v.id === 'v-created');
  assert.ok(created.schedule_nudge_sent_at, 'stamped on the created visit');
});

test('idempotency: an already-stamped open visit gets no second nudge', async () => {
  armTransport();
  const world = makeWorld({
    visits: [makeVisit('v-open', { schedule_nudge_queued_at: '2027-01-08T14:00:00Z', schedule_nudge_sent_at: '2027-01-08T14:00:01Z' })],
  });
  routeFetch(world);
  mockGenerateLink();

  await maybeSendScheduleNudge({ sub: { id: SUB_ID }, customer: makeCustomer(), periodEndDate: '2027-01-15', now: NOW });

  assert.equal(linkCalls.length, 0, 'no link minted');
  assert.equal(world.texts.length, 0);
  assert.equal(world.updates.length, 0, 'nothing re-queued or re-stamped');
});

test('kill-switch off: refusal logged, visit stays queued-unsent so the cron sweep retries', async () => {
  // SMS_ENABLED deliberately unset.
  const world = makeWorld({ visits: [makeVisit('v-open')] });
  routeFetch(world);
  mockGenerateLink();

  await maybeSendScheduleNudge({ sub: { id: SUB_ID }, customer: makeCustomer(), periodEndDate: '2027-01-15', now: NOW });

  assert.equal(world.texts.length, 0);
  assert.equal(world.logged[0].status, 'disabled');
  const v = world.visits[0];
  assert.ok(v.schedule_nudge_queued_at, 'queued');
  assert.equal(v.schedule_nudge_sent_at, null, 'NOT stamped — retries');
});

test('no_consent is terminal: stamped so it never re-tries, nothing on the wire', async () => {
  armTransport();
  const world = makeWorld({ visits: [makeVisit('v-open')], consentRows: [] });
  routeFetch(world);
  mockGenerateLink();

  await maybeSendScheduleNudge({ sub: { id: SUB_ID }, customer: makeCustomer(), periodEndDate: '2027-01-15', now: NOW });

  assert.equal(world.texts.length, 0);
  assert.equal(world.logged[0].status, 'no_consent');
  assert.ok(world.visits[0].schedule_nudge_sent_at, 'permanent refusal stamps');
});

// ---------------------------------------------------------------------------
// Full invoice.upcoming flow: the renewal email is never gated on SMS
// ---------------------------------------------------------------------------
test('opted-out customer: renewal email still sends, no text, nudge stamped terminal', async () => {
  armTransport();
  process.env.BREVO_API_KEY = 'brevo_dummy';
  const world = makeWorld({
    visits: [makeVisit('v-open')],
    consentRows: [{ id: 'cons1', customer_id: CUSTOMER_ID, opted_in: true, opted_out: true }],
    subRow: { id: SUB_ID, plan: 'annual', status: 'active', customer: makeCustomer() },
  });
  routeFetch(world);
  mockGenerateLink();

  await handleInvoiceUpcoming({
    customer: 'cus_1',
    subscription: 'sub_stripe_1',
    period_end: Math.floor(Date.parse('2027-01-15T12:00:00Z') / 1000),
    amount_due: 32900,
    lines: { data: [{ amount: 32900, description: 'Generator Care Annual' }] },
  });

  assert.equal(world.emails.length, 1, 'renewal email went out');
  assert.ok(world.emails[0].subject, 'a real email payload');
  assert.equal(world.texts.length, 0, 'no text to an opted-out customer');
  assert.equal(world.logged[0].status, 'opted_out');
  assert.ok(world.visits[0].schedule_nudge_sent_at, 'opt-out is terminal — no daily retry');
});

test('unknown subscription: handler skips quietly (no email, no text, no throw)', async () => {
  const world = makeWorld({ subRow: null });
  routeFetch(world);
  await handleInvoiceUpcoming({ customer: 'cus_1', subscription: 'sub_unknown', period_end: 1, lines: { data: [] } });
  assert.equal(world.emails.length, 0);
  assert.equal(world.texts.length, 0);
});

// ---------------------------------------------------------------------------
// Cron retry sweep (runNudgeRetryPass)
// ---------------------------------------------------------------------------
function sweepVisit(id, extra = {}) {
  return makeVisit(id, {
    schedule_nudge_queued_at: '2027-01-08T03:00:00Z', // webhook landed at night
    subscription: { customer: makeCustomer() },
    ...extra,
  });
}

test('sweep retries exactly the queued-but-unsent open visits, with a fresh link, and stamps', async () => {
  armTransport();
  const world = makeWorld({
    visits: [
      sweepVisit('v-queued'),
      sweepVisit('v-already-sent', { schedule_nudge_sent_at: '2027-01-09T14:00:00Z' }),
      sweepVisit('v-completed', { status: 'completed', completed_date: '2027-01-10' }),
      sweepVisit('v-canceled', { status: 'canceled' }),
      makeVisit('v-never-queued', { subscription: { customer: makeCustomer() } }),
    ],
  });
  routeFetch(world);
  mockGenerateLink();

  const summary = await runNudgeRetryPass({ now: NOW });
  assert.deepEqual(summary, { considered: 1, sent: 1, skipped: 0 });
  assert.equal(world.texts.length, 1);
  assert.ok(world.texts[0].text.includes(ACTION_LINK), 'fresh link on the wire');
  assert.ok(!world.logged[0].body.includes('SECRET-OTP-TOKEN'), 'sweep log is redacted too');
  const v = world.visits.find((x) => x.id === 'v-queued');
  assert.ok(v.schedule_nudge_sent_at);

  // Second sweep: the stamp makes it disappear.
  const again = await runNudgeRetryPass({ now: NOW });
  assert.deepEqual(again, { considered: 0, sent: 0, skipped: 0 });
});

test('sweep with kill-switch off: nothing stamped, retries tomorrow', async () => {
  const world = makeWorld({ visits: [sweepVisit('v-queued')] });
  routeFetch(world);
  mockGenerateLink();

  const summary = await runNudgeRetryPass({ now: NOW });
  assert.deepEqual(summary, { considered: 1, sent: 0, skipped: 1 });
  assert.equal(world.logged[0].status, 'disabled');
  assert.equal(world.visits[0].schedule_nudge_sent_at, null);
});

test('sweep skips a subscription canceled after its nudge was queued', async () => {
  armTransport();
  const world = makeWorld({
    visits: [sweepVisit('v-queued', { subscription: { status: 'canceled', customer: makeCustomer() } })],
  });
  routeFetch(world);
  mockGenerateLink();

  const summary = await runNudgeRetryPass({ now: NOW });
  assert.deepEqual(summary, { considered: 1, sent: 0, skipped: 1 });
  assert.equal(linkCalls.length, 0);
  assert.equal(world.texts.length, 0);
  assert.equal(world.visits[0].schedule_nudge_sent_at, null);
});

test('sweep skips a customer with no email (cannot mint a login link) and leaves them queued', async () => {
  armTransport();
  const world = makeWorld({
    visits: [sweepVisit('v-queued', { subscription: { customer: makeCustomer({ email: null }) } })],
  });
  routeFetch(world);
  mockGenerateLink();

  const summary = await runNudgeRetryPass({ now: NOW });
  assert.deepEqual(summary, { considered: 1, sent: 0, skipped: 1 });
  assert.equal(linkCalls.length, 0);
  assert.equal(world.visits[0].schedule_nudge_sent_at, null);
});
