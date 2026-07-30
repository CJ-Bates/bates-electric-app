// lib/mailer.js send logging (sql/033) — offline unit tests through the real
// shipped sendViaBrevo. The contract under test:
//   - every attempt writes ONE generator_email_messages row (sent AND failed),
//   - the row never contains the HTML body, the API key, or a token,
//   - a logging failure never breaks or fails the send itself.
require('./helpers/env');

const test = require('node:test');
const assert = require('node:assert/strict');

const { installMockSupabase } = require('./helpers/mockSupabase');
const { sendViaBrevo, scrubDetail } = require('../lib/mailer');

const CUSTOMER_ID = 'c0000000-0000-4000-8000-000000000001';
const SUB_ID = 'b0000000-0000-4000-8000-000000000010';
const VISIT_ID = 'a0000000-0000-4000-8000-000000000020';

let restoreSupabase;
let realFetch;
test.afterEach(() => {
  if (restoreSupabase) { restoreSupabase(); restoreSupabase = undefined; }
  if (realFetch) { global.fetch = realFetch; realFetch = undefined; }
  delete process.env.BREVO_API_KEY;
});

// Captures generator_email_messages inserts; optionally fails them.
function world({ insertError, insertThrows } = {}) {
  const w = { inserts: [] };
  restoreSupabase = installMockSupabase({
    generator_email_messages: (chain) => {
      if (insertThrows) throw new Error('supabase exploded');
      const ins = chain.find((c) => c.method === 'insert');
      if (ins) w.inserts.push(ins.args[0]);
      return { data: null, error: insertError ? { message: insertError } : null };
    },
  });
  return w;
}

function mockBrevo({ ok = true, status = 201, body } = {}) {
  realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    assert.match(String(url), /api\.brevo\.com/);
    return {
      ok,
      status,
      json: async () => body || { messageId: '<msg-1@smtp-relay.example>' },
      text: async () => JSON.stringify(body || { message: 'bad request' }),
    };
  };
}

const SEND_OPTS = {
  to: 'bill@example.com',
  senderEmail: 'no-reply@bates-electric.com',
  senderName: 'Bates Electric Generator Care',
  subject: 'Your generator maintenance visit is booked',
  html: '<p>SECRET-HTML-BODY with https://my.bates-electric.com/auth?token=abc123</p>',
  text: 'plain text',
  log: { kind: 'visit-scheduled-email', customerId: CUSTOMER_ID, subscriptionId: SUB_ID, relatedVisitId: VISIT_ID },
};

test('successful send writes a sent row with provider id + context, and no HTML body', async () => {
  process.env.BREVO_API_KEY = 'xkeysib-test-key';
  const w = world();
  mockBrevo({});

  const result = await sendViaBrevo(SEND_OPTS);
  assert.equal(result.sent, true);
  assert.equal(result.messageId, '<msg-1@smtp-relay.example>');

  assert.equal(w.inserts.length, 1);
  const row = w.inserts[0];
  assert.equal(row.status, 'sent');
  assert.equal(row.provider_id, '<msg-1@smtp-relay.example>');
  assert.equal(row.to_email, 'bill@example.com');
  assert.equal(row.subject, 'Your generator maintenance visit is booked');
  assert.equal(row.kind, 'visit-scheduled-email');
  assert.equal(row.customer_id, CUSTOMER_ID);
  assert.equal(row.subscription_id, SUB_ID);
  assert.equal(row.related_visit_id, VISIT_ID);
  // The stored row must never carry the body, the key, or any token.
  const flat = JSON.stringify(row);
  assert.ok(!flat.includes('SECRET-HTML-BODY'), 'HTML body must not be stored');
  assert.ok(!flat.includes('xkeysib'), 'API key must not be stored');
  assert.ok(!flat.includes('abc123'), 'token must not be stored');
});

test('Brevo API failure keeps the existing error return AND writes a failed row', async () => {
  process.env.BREVO_API_KEY = 'xkeysib-test-key';
  const w = world();
  mockBrevo({ ok: false, status: 402, body: { message: 'Maximum credits exceeded' } });

  const result = await sendViaBrevo(SEND_OPTS);
  assert.equal(result.sent, false);
  assert.match(result.reason, /Brevo 402/);
  assert.equal(result.statusCode, 402);

  assert.equal(w.inserts.length, 1);
  assert.equal(w.inserts[0].status, 'failed');
  assert.match(w.inserts[0].detail, /Brevo 402/);
});

test('missing BREVO_API_KEY still logs a failed row (fail-closed with a visible trail)', async () => {
  const w = world();
  const result = await sendViaBrevo(SEND_OPTS);
  assert.equal(result.sent, false);
  assert.equal(result.reason, 'BREVO_API_KEY not set');
  assert.equal(w.inserts.length, 1);
  assert.equal(w.inserts[0].status, 'failed');
});

test('no recipient logs a failed row instead of a silent skip', async () => {
  process.env.BREVO_API_KEY = 'xkeysib-test-key';
  const w = world();
  const result = await sendViaBrevo({ ...SEND_OPTS, to: [] });
  assert.equal(result.sent, false);
  assert.equal(result.reason, 'no recipient');
  assert.equal(w.inserts.length, 1);
  assert.equal(w.inserts[0].status, 'failed');
  assert.equal(w.inserts[0].detail, 'no recipient');
});

test('a logging failure (error result) never breaks the send', async () => {
  process.env.BREVO_API_KEY = 'xkeysib-test-key';
  world({ insertError: 'permission denied' });
  mockBrevo({});
  const result = await sendViaBrevo(SEND_OPTS);
  assert.equal(result.sent, true, 'email must still go out when the audit row fails');
});

test('a logging failure (thrown) never breaks the send', async () => {
  process.env.BREVO_API_KEY = 'xkeysib-test-key';
  world({ insertThrows: true });
  mockBrevo({});
  const result = await sendViaBrevo(SEND_OPTS);
  assert.equal(result.sent, true);
});

test('multiple recipients are comma-joined in the row', async () => {
  process.env.BREVO_API_KEY = 'xkeysib-test-key';
  const w = world();
  mockBrevo({});
  await sendViaBrevo({ ...SEND_OPTS, to: ['a@example.com', { email: 'b@example.com', name: 'B' }] });
  assert.equal(w.inserts[0].to_email, 'a@example.com, b@example.com');
});

test('scrubDetail redacts Brevo keys and token-bearing URLs, and caps length', () => {
  assert.equal(scrubDetail('key xkeysib-abc-123 leaked'), 'key [redacted-key] leaked');
  assert.match(scrubDetail('see https://x.co/auth?token=deadbeef&x=1'), /token=\[redacted\]/);
  assert.ok(!scrubDetail('https://x.co/reset?token_hash=t123&type=recovery').includes('t123'));
  assert.match(scrubDetail('https://x.co/p?access_token=aaa'), /access_token=\[redacted\]/);
  assert.equal(scrubDetail('x'.repeat(600)).length, 500);
  assert.equal(scrubDetail(null), null);
});
