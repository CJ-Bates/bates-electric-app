// lib/sms.js unit tests (SMS Phase 1) — fully offline. Covers the guard
// stack the launch plan's verification list depends on:
//   - phone normalization to E.164
//   - quiet hours (8am-9pm Central)
//   - message builders (approved copy: brand, FL DBA swap, date + window form)
//   - sendSms gate order: consent -> kill-switch -> quiet hours -> transport,
//     with EVERY refusal logged to generator_sms_messages
//   - the API token never leaking into the message log
// env.js deliberately does NOT set SIMPLETEXTING_API_TOKEN / SMS_ENABLED, so
// the transport fails closed unless a test arms it explicitly.
require('./helpers/env');

const test = require('node:test');
const assert = require('node:assert/strict');

const { installMockSupabase } = require('./helpers/mockSupabase');
const sms = require('../lib/sms');

const CUSTOMER_ID = 'c0000000-0000-4000-8000-000000000001';
const VISIT_ID = 'a0000000-0000-4000-8000-000000000002';

let restoreSupabase;
let realFetch;
test.afterEach(() => {
  if (restoreSupabase) { restoreSupabase(); restoreSupabase = undefined; }
  if (realFetch) { global.fetch = realFetch; realFetch = undefined; }
  delete process.env.SMS_ENABLED;
  delete process.env.SIMPLETEXTING_API_TOKEN;
  delete process.env.SIMPLETEXTING_ACCOUNT_PHONE;
});

// Any fetch in a test that didn't opt into one is a leak — sends must be
// impossible unless the test armed the transport on purpose.
function forbidFetch() {
  realFetch = global.fetch;
  global.fetch = async (url) => {
    throw new Error('unexpected fetch in offline test: ' + url);
  };
}

// ---------------------------------------------------------------------------
// normalizePhone
// ---------------------------------------------------------------------------
test('normalizePhone: 10-digit, formatted, 11-digit, and junk inputs', () => {
  assert.equal(sms.normalizePhone('6365550100'), '+16365550100');
  assert.equal(sms.normalizePhone('(636) 555-0100'), '+16365550100');
  assert.equal(sms.normalizePhone('1-636-555-0100'), '+16365550100');
  assert.equal(sms.normalizePhone('+16365550100'), '+16365550100');
  assert.equal(sms.normalizePhone('555-0100'), null);
  assert.equal(sms.normalizePhone(''), null);
  assert.equal(sms.normalizePhone(null), null);
  assert.equal(sms.normalizePhone('26365550100'), null, '11 digits not starting with 1 is not a US number');
});

// ---------------------------------------------------------------------------
// Quiet hours — instants chosen in UTC that land on known Central hours (July
// = CDT = UTC-5).
// ---------------------------------------------------------------------------
test('withinQuietHours: 8am-9pm Central sendable window', () => {
  assert.equal(sms.withinQuietHours(new Date('2026-07-15T13:00:00Z')), true, '8:00am CDT opens the window');
  assert.equal(sms.withinQuietHours(new Date('2026-07-15T12:59:00Z')), false, '7:59am CDT is too early');
  assert.equal(sms.withinQuietHours(new Date('2026-07-16T01:59:00Z')), true, '8:59pm CDT still sendable');
  assert.equal(sms.withinQuietHours(new Date('2026-07-16T02:00:00Z')), false, '9:00pm CDT is quiet');
  assert.equal(sms.withinQuietHours(new Date('2026-07-16T08:00:00Z')), false, '3:00am CDT is quiet');
});

// ---------------------------------------------------------------------------
// Copy builders
// ---------------------------------------------------------------------------
test('smsWindowText: compact AM/PM forms from the shared window list', () => {
  assert.equal(sms.smsWindowText('7-9'), '7-9 AM');
  assert.equal(sms.smsWindowText('8-10'), '8-10 AM');
  assert.equal(sms.smsWindowText('10-12'), '10 AM-12 PM');
  assert.equal(sms.smsWindowText('12-2'), '12-2 PM');
  assert.equal(sms.smsWindowText('1-3'), '1-3 PM');
  assert.equal(sms.smsWindowText('nope'), null);
  assert.equal(sms.smsWindowText(null), null);
});

test('booking confirmation: approved copy shape, first name only, date + window', () => {
  const body = sms.buildBookingConfirmationSms({
    name: 'Sarah Example', installState: 'MO', dateStr: '2026-08-12',
    windowCode: '8-10', link: 'https://app.bates-electric.com/my',
  });
  assert.ok(body.startsWith('Bates Generator Care: Hi Sarah,'), body);
  assert.ok(body.includes('set for Wed Aug 12, arriving 8-10 AM'), body);
  assert.ok(body.includes('Reply Y to confirm'), body);
  assert.ok(body.includes('https://app.bates-electric.com/my'), body);
  assert.ok(body.includes('Reply STOP to opt out'), body);
});

test('FL customers get the S.E. Bates DBA brand in every message', () => {
  const conf = sms.buildBookingConfirmationSms({ name: 'Al', installState: 'FL', dateStr: '2026-08-12', windowCode: '8-10', link: 'x' });
  assert.ok(conf.startsWith('S.E. Bates Generator Care:'), conf);
  const optin = sms.buildOptInConfirmationSms({ installState: 'FL' });
  assert.ok(optin.startsWith('S.E. Bates Generator Care:'), optin);
  const resched = sms.buildRescheduleReplySms({ installState: 'fl', link: 'x' });
  assert.ok(resched.includes('S.E. Bates Generator Care'), resched);
});

test('opt-in confirmation carries the carrier-required disclosures', () => {
  const body = sms.buildOptInConfirmationSms({ installState: 'MO' });
  assert.ok(body.includes('Msg frequency varies'), body);
  assert.ok(body.includes('Msg & data rates may apply'), body);
  assert.ok(body.includes('Reply HELP for help, STOP to cancel'), body);
});

test('confirmed reply includes the booked date and window', () => {
  const body = sms.buildConfirmedReplySms({ installState: 'MO', dateStr: '2026-08-12', windowCode: '12-2', link: 'L' });
  assert.ok(body.includes('Wed Aug 12, 12-2 PM'), body);
  assert.ok(body.includes('Bates Generator Care'), body);
});

// ---------------------------------------------------------------------------
// sendSms gates. Consent resolver state is per-test; every refusal must land
// a generator_sms_messages row with the reason status.
// ---------------------------------------------------------------------------
function consentAndLog({ consentRows }) {
  const logged = [];
  restoreSupabase = installMockSupabase({
    generator_sms_consent: () => ({ data: consentRows, error: null }),
    generator_sms_messages: (chain) => {
      const ins = chain.find((c) => c.method === 'insert');
      if (ins) logged.push(ins.args[0]);
      return { data: null, error: null };
    },
  });
  return logged;
}

test('sendSms refuses without a consent row (no_consent) and never touches the network', async () => {
  forbidFetch();
  const logged = consentAndLog({ consentRows: [] });
  process.env.SMS_ENABLED = 'true';
  process.env.SIMPLETEXTING_API_TOKEN = 'tok_secret';
  process.env.SIMPLETEXTING_ACCOUNT_PHONE = '8339425468';

  const r = await sms.sendSms({ toPhone: '6365550100', body: 'hello', customerId: CUSTOMER_ID });
  assert.equal(r.sent, false);
  assert.equal(r.status, 'no_consent');
  assert.equal(logged.length, 1);
  assert.equal(logged[0].status, 'no_consent');
  assert.equal(logged[0].direction, 'out');
  assert.equal(logged[0].to_phone, '+16365550100');
});

test('sendSms refuses an opted-out phone even when consent was once given', async () => {
  forbidFetch();
  const logged = consentAndLog({ consentRows: [{ opted_in: true, opted_out: true }] });
  process.env.SMS_ENABLED = 'true';
  process.env.SIMPLETEXTING_API_TOKEN = 'tok_secret';

  const r = await sms.sendSms({ toPhone: '6365550100', body: 'hello' });
  assert.equal(r.status, 'opted_out');
  assert.equal(logged[0].status, 'opted_out');
});

test('kill-switch: consented send with SMS_ENABLED unset logs the full row, sends nothing', async () => {
  forbidFetch();
  const logged = consentAndLog({ consentRows: [{ opted_in: true, opted_out: false }] });
  // SMS_ENABLED deliberately not set

  const r = await sms.sendSms({ toPhone: '6365550100', body: 'the confirmation text', relatedVisitId: VISIT_ID });
  assert.equal(r.sent, false);
  assert.equal(r.status, 'disabled');
  assert.equal(logged.length, 1);
  assert.equal(logged[0].status, 'disabled');
  assert.equal(logged[0].body, 'the confirmation text', 'the would-be message is visible for testing');
  assert.equal(logged[0].related_visit_id, VISIT_ID);
});

test('quiet hours: armed + consented send at 6am Central is skipped (and an inbound-reply override works)', async () => {
  const logged = consentAndLog({ consentRows: [{ opted_in: true, opted_out: false }] });
  process.env.SMS_ENABLED = 'true';
  process.env.SIMPLETEXTING_API_TOKEN = 'tok_secret';
  process.env.SIMPLETEXTING_ACCOUNT_PHONE = '8339425468';
  const sixAmCentral = new Date('2026-07-15T11:00:00Z');

  forbidFetch();
  const r = await sms.sendSms({ toPhone: '6365550100', body: 'x', now: sixAmCentral });
  assert.equal(r.status, 'quiet_hours');
  assert.equal(logged[0].status, 'quiet_hours');

  // Same instant with ignoreQuietHours (a direct reply) reaches the transport.
  global.fetch = async (url, opts) => {
    assert.ok(String(url).includes('simpletexting.com'), url);
    const body = JSON.parse(opts.body);
    assert.equal(body.contactPhone, '6365550100');
    assert.equal(body.accountPhone, '8339425468');
    return { ok: true, status: 201, json: async () => ({ id: 'prov_1' }) };
  };
  const r2 = await sms.sendSms({ toPhone: '6365550100', body: 'x', now: sixAmCentral, ignoreQuietHours: true });
  assert.equal(r2.sent, true);
  const sent = logged.find((l) => l.status === 'sent');
  assert.ok(sent, 'sent row logged');
  assert.equal(sent.provider_id, 'prov_1');
});

test('armed send posts the confirmed SimpleTexting shape and logs the provider id', async () => {
  const logged = consentAndLog({ consentRows: [{ opted_in: true, opted_out: false }] });
  process.env.SMS_ENABLED = 'true';
  process.env.SIMPLETEXTING_API_TOKEN = 'tok_secret';
  process.env.SIMPLETEXTING_ACCOUNT_PHONE = '(833) 942-5468';

  realFetch = global.fetch;
  let captured;
  global.fetch = async (url, opts) => {
    captured = { url: String(url), opts };
    return { ok: true, status: 201, json: async () => ({ id: 'prov_42', credits: 1 }) };
  };
  const r = await sms.sendSms({ toPhone: '636-555-0100', body: 'hi', ignoreQuietHours: true });
  assert.equal(r.sent, true);
  assert.equal(captured.url, 'https://api-app2.simpletexting.com/v2/api/messages');
  assert.equal(captured.opts.headers.Authorization, 'Bearer tok_secret');
  const body = JSON.parse(captured.opts.body);
  assert.deepEqual(body, { contactPhone: '6365550100', accountPhone: '8339425468', mode: 'AUTO', text: 'hi' });
  assert.equal(logged[0].status, 'sent');
  assert.equal(logged[0].provider_id, 'prov_42');
});

test('a failed provider response is logged WITHOUT the API token anywhere', async () => {
  const logged = consentAndLog({ consentRows: [{ opted_in: true, opted_out: false }] });
  process.env.SMS_ENABLED = 'true';
  process.env.SIMPLETEXTING_API_TOKEN = 'tok_super_secret_value';
  process.env.SIMPLETEXTING_ACCOUNT_PHONE = '8339425468';

  realFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 401, text: async () => 'unauthorized request' });
  const r = await sms.sendSms({ toPhone: '6365550100', body: 'hi', ignoreQuietHours: true });
  assert.equal(r.sent, false);
  assert.equal(r.status, 'failed');
  assert.equal(logged.length, 1);
  const row = JSON.stringify(logged[0]);
  assert.ok(!row.includes('tok_super_secret_value'), 'token must never reach the message log');
  assert.ok(logged[0].detail.includes('401'), logged[0].detail);
});

test('missing token fails closed (logged as failed, nothing sent)', async () => {
  forbidFetch();
  const logged = consentAndLog({ consentRows: [{ opted_in: true, opted_out: false }] });
  process.env.SMS_ENABLED = 'true'; // armed, but no token

  const r = await sms.sendSms({ toPhone: '6365550100', body: 'x', ignoreQuietHours: true });
  assert.equal(r.status, 'failed');
  assert.ok(logged[0].detail.includes('SIMPLETEXTING_API_TOKEN not set'));
});

// ---------------------------------------------------------------------------
// recordConsent — the legal ledger writes
// ---------------------------------------------------------------------------
test('recordConsent: first opt-in inserts a full row with the exact shown language', async () => {
  let inserted;
  restoreSupabase = installMockSupabase({
    generator_sms_consent: (chain) => {
      const ins = chain.find((c) => c.method === 'insert');
      if (ins) { inserted = ins.args[0]; return { data: { id: 'row1', ...inserted }, error: null }; }
      return { data: null, error: null }; // the existence pre-read: no row yet
    },
  });
  const row = await sms.recordConsent({
    customerId: CUSTOMER_ID, phone: '(636) 555-0100', optedIn: true,
    source: 'dashboard', consentText: sms.CONSENT_TEXT.dashboard,
  });
  assert.ok(row);
  assert.equal(inserted.phone, '+16365550100');
  assert.equal(inserted.opted_in, true);
  assert.equal(inserted.opted_out, false);
  assert.equal(inserted.source, 'dashboard');
  assert.equal(inserted.consent_text, sms.CONSENT_TEXT.dashboard);
  assert.ok(inserted.opted_in_at);
});

test('recordConsent: opt-out on an existing row flips flags but PRESERVES the original consent_text', async () => {
  let updated;
  restoreSupabase = installMockSupabase({
    generator_sms_consent: (chain) => {
      const upd = chain.find((c) => c.method === 'update');
      if (upd) { updated = upd.args[0]; return { data: { id: 'row1', opted_in: true, opted_out: true }, error: null }; }
      return { data: { id: 'row1', opted_in: true, opted_out: false }, error: null };
    },
  });
  await sms.recordConsent({ customerId: CUSTOMER_ID, phone: '6365550100', optedIn: false, source: 'office' });
  assert.ok(updated);
  assert.equal(updated.opted_out, true);
  assert.ok(updated.opted_out_at);
  assert.equal(updated.consent_text, undefined, 'withdrawal must not overwrite what they originally agreed to');
  assert.equal(updated.opted_in, undefined, 'opt-out only flips the opt-out flag');
});
