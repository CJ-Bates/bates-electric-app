// Sentry beforeSend scrubbing (middleware/error-reporter.js) — webhook
// shared secrets and tokens ride in query strings (?secret= on the Brevo and
// SimpleTexting webhooks, ?token= on unsubscribe links), and @sentry/node
// v8+ attaches the full request URL to events. The scrubber must redact the
// values everywhere they can appear on an event, and must never throw.
require('./helpers/env');

const test = require('node:test');
const assert = require('node:assert/strict');

const { _test } = require('../middleware/error-reporter');
const { scrubSentryEvent, scrubSecretParams } = _test;

test('redacts secret-shaped query param values in URLs, keeps the rest', () => {
  assert.equal(
    scrubSecretParams('https://x.co/api/email/events?secret=abc123&foo=1'),
    'https://x.co/api/email/events?secret=[redacted]&foo=1'
  );
  assert.equal(
    scrubSecretParams('/generator-care/unsubscribe?token=deadbeef'),
    '/generator-care/unsubscribe?token=[redacted]'
  );
  assert.equal(scrubSecretParams('/api/thing?plain=ok'), '/api/thing?plain=ok');
  assert.equal(scrubSecretParams(null), null);
});

test('scrubs event.request url, query_string (string and object), and the secret header', () => {
  const event = {
    request: {
      url: 'https://api.example.com/api/email/events?secret=s3cr3t',
      query_string: 'secret=s3cr3t&x=1',
      headers: { 'X-Webhook-Secret': 's3cr3t', accept: 'application/json' },
    },
  };
  const out = scrubSentryEvent(event);
  assert.ok(!JSON.stringify(out).includes('s3cr3t'), 'secret must not survive anywhere on the event');
  assert.equal(out.request.headers.accept, 'application/json', 'non-secret headers untouched');

  const objEvent = { request: { query_string: { secret: 's3cr3t', page: '2' } } };
  const outObj = scrubSentryEvent(objEvent);
  assert.equal(outObj.request.query_string.secret, '[redacted]');
  assert.equal(outObj.request.query_string.page, '2');
});

test('scrubs http breadcrumb URLs', () => {
  const event = {
    breadcrumbs: [
      { category: 'http', data: { url: '/api/sms/inbound?secret=shh', 'http.query': 'secret=shh' } },
      { category: 'console', message: 'unrelated' },
    ],
  };
  const out = scrubSentryEvent(event);
  assert.ok(!JSON.stringify(out).includes('shh'));
});

test('never throws and always returns the event, even on hostile shapes', () => {
  for (const weird of [{}, { request: 42 }, { request: { headers: null, query_string: 7 } }, { breadcrumbs: [null, 1, {}] }]) {
    assert.equal(scrubSentryEvent(weird), weird);
  }
});
