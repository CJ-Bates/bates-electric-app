// upsertSimpleTextingContact 409 recovery — the create race (live 2026-08-12,
// Edwin S.): a concurrent auto-create beats our name-bearing POST, SimpleTexting
// answers 409 CONTACT_CREATE_FAILED instead of updating, and the contact stays
// "no name". On exactly that 409 the function must recover with the documented
// per-contact PUT (addressed by phone) and NOT alert; every other failure —
// including a PUT that then fails, or a 409 that means something else — must
// still reach reportError.
//
// reportError is destructured by lib/sms.js at require time, so this file gets
// its own process (node --test runs each file separately) and plants a counting
// stub in the require cache BEFORE lib/sms.js loads. That makes "reportError
// was called N times" a direct assertion, not a console-output proxy.
require('./helpers/env');

const test = require('node:test');
const assert = require('node:assert/strict');

const reporterPath = require.resolve('../middleware/error-reporter');
const reportErrorCalls = [];
require.cache[reporterPath] = {
  id: reporterPath,
  filename: reporterPath,
  loaded: true,
  exports: {
    reportError: async (err, context) => { reportErrorCalls.push({ err, context }); },
    errorReporter: (err, req, res, next) => next(err),
    initSentry: () => null,
  },
};

const sms = require('../lib/sms');

const EXISTS_409_BODY = JSON.stringify({
  status: 'CONFLICT',
  errorCode: 'CONTACT_CREATE_FAILED',
  message: 'contactPhone=6365550100, errorMessage=Contact with contact phone 6365550100 already exists',
  path: '/v2',
});

let realFetch;
test.beforeEach(() => {
  reportErrorCalls.length = 0;
  process.env.SIMPLETEXTING_API_TOKEN = 'tok_secret_409';
  realFetch = global.fetch;
});
test.afterEach(() => {
  if (realFetch) { global.fetch = realFetch; realFetch = undefined; }
  delete process.env.SIMPLETEXTING_API_TOKEN;
});

// Mock provider: scripted responses keyed by method, capturing every request.
function scriptFetch(script) {
  const requests = [];
  global.fetch = async (url, opts) => {
    requests.push({ url: String(url), opts });
    const step = script.shift();
    if (!step) throw new Error('unexpected extra fetch: ' + url);
    if (step.throw) throw step.throw;
    return {
      ok: step.status >= 200 && step.status < 300,
      status: step.status,
      json: async () => step.body ? JSON.parse(step.body) : {},
      text: async () => step.body || '',
    };
  };
  return requests;
}

test('409 "already exists" recovers via per-contact PUT, returns ok, zero reportError calls', async () => {
  const requests = scriptFetch([
    { status: 409, body: EXISTS_409_BODY },
    { status: 200, body: '{"id":"contact_1"}' },
  ]);
  const r = await sms.upsertSimpleTextingContact({ phone: '(636) 555-0100', name: 'Edwin Soteropoulos' });

  assert.deepEqual(r, { ok: true, reason: 'updated existing' });
  assert.equal(requests.length, 2, 'exactly one POST then one PUT');
  assert.equal(requests[0].opts.method, 'POST');
  assert.equal(requests[1].opts.method, 'PUT');
  // PUT addresses the contact by 10-digit phone in the path; listsReplacement
  // =false is load-bearing on the shared account (its default is true).
  assert.ok(requests[1].url.endsWith('/api/contacts/6365550100?upsert=true&listsReplacement=false'), requests[1].url);
  assert.equal(requests[1].opts.headers.Authorization, 'Bearer tok_secret_409');
  assert.deepEqual(JSON.parse(requests[1].opts.body), {
    contactPhone: '6365550100', firstName: 'Edwin', lastName: 'Soteropoulos',
  });
  assert.equal(reportErrorCalls.length, 0, 'a resolved 409 must not alert');
});

test('409 whose recovery PUT then fails still logs and still alerts', async () => {
  scriptFetch([
    { status: 409, body: EXISTS_409_BODY },
    { status: 500, body: 'server exploded' },
  ]);
  const r = await sms.upsertSimpleTextingContact({ phone: '6365550100', name: 'John Fort' });

  assert.equal(r.ok, false);
  assert.ok(r.reason.includes('409 recovery update failed 500'), r.reason);
  assert.ok(!r.reason.includes('tok_secret_409'), 'token must never appear in the failure detail');
  assert.equal(reportErrorCalls.length, 1, 'an unresolved 409 is a real failure');
});

test('a 409 with an unrelated body is NOT treated as the race: no PUT, still alerts', async () => {
  const requests = scriptFetch([
    { status: 409, body: '{"status":"CONFLICT","errorCode":"SOMETHING_ELSE","message":"quota exceeded"}' },
  ]);
  const r = await sms.upsertSimpleTextingContact({ phone: '6365550100', name: 'John Fort' });

  assert.equal(r.ok, false);
  assert.equal(requests.length, 1, 'must not attempt the recovery PUT');
  assert.equal(reportErrorCalls.length, 1);
});

test('401, 500, and a network throw all still alert (one reportError each)', async () => {
  scriptFetch([{ status: 401, body: 'unauthorized' }]);
  assert.equal((await sms.upsertSimpleTextingContact({ phone: '6365550100', name: 'John Fort' })).ok, false);

  scriptFetch([{ status: 500, body: 'oops' }]);
  assert.equal((await sms.upsertSimpleTextingContact({ phone: '6365550100', name: 'John Fort' })).ok, false);

  scriptFetch([{ throw: new Error('socket hang up') }]);
  assert.equal((await sms.upsertSimpleTextingContact({ phone: '6365550100', name: 'John Fort' })).ok, false);

  assert.equal(reportErrorCalls.length, 3);
});

test('a normal first-time create is unchanged: single POST, no PUT, no alert', async () => {
  const requests = scriptFetch([
    { status: 201, body: '{"id":"contact_1"}' },
  ]);
  const r = await sms.upsertSimpleTextingContact({ phone: '6365550100', name: 'John Fort' });

  assert.deepEqual(r, { ok: true });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].opts.method, 'POST');
  assert.ok(requests[0].url.endsWith('/api/contacts?upsert=true&listsReplacement=false'), requests[0].url);
  assert.equal(reportErrorCalls.length, 0);
});

test('two concurrent calls for the same new phone both resolve ok and the loser lands the name', async () => {
  // Provider model of the live race: whichever POST arrives second hits the
  // conflict; its recovery PUT then succeeds against the now-existing contact.
  let contactExists = false;
  const requests = [];
  global.fetch = async (url, opts) => {
    requests.push({ url: String(url), opts });
    if (opts.method === 'POST') {
      if (contactExists) return { ok: false, status: 409, text: async () => EXISTS_409_BODY, json: async () => ({}) };
      contactExists = true;
      return { ok: true, status: 201, text: async () => '', json: async () => ({ id: 'contact_1' }) };
    }
    return { ok: true, status: 200, text: async () => '', json: async () => ({ id: 'contact_1' }) };
  };

  const [a, b] = await Promise.all([
    sms.upsertSimpleTextingContact({ phone: '7577840848', name: 'Edwin Soteropoulos' }),
    sms.upsertSimpleTextingContact({ phone: '7577840848', name: 'Edwin Soteropoulos' }),
  ]);

  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  const put = requests.find((r) => r.opts.method === 'PUT');
  assert.ok(put, 'the losing call must recover with a PUT');
  assert.deepEqual(JSON.parse(put.opts.body), {
    contactPhone: '7577840848', firstName: 'Edwin', lastName: 'Soteropoulos',
  });
  assert.equal(reportErrorCalls.length, 0, 'the race must not alert');
});
