// POST /tech/enroll (Growth Engine WP6 — field enrollment) — offline route
// tests via the real shipped handler (test/helpers/routeHandler bypasses the
// requireAuth/requireRole('tech') mounted via router.use in
// routes/generator-tech.js). Covers: field-lead creation with the tech's
// attribution + the pre-tagged ?lead= URL, the label fallback, WP6.1's
// every-field-optional posture (an EMPTY enroll succeeds; email is still
// shape-checked when present), the optional-send path (advance to
// signup_sent + invited_at stamp, FL branding) vs QR-only, and a failed send
// still returning the URL without advancing the lead.
require('./helpers/env');

const test = require('node:test');
const assert = require('node:assert/strict');

// Patch the mail transport BEFORE the router (and therefore lib/emails) is
// first required: emails.js destructures sendViaBrevo at load. node --test
// runs each file in its own process, so this can't leak elsewhere.
const mailer = require('../lib/mailer');
let brevoImpl = async () => ({ sent: true, messageId: 'test-msg' });
let brevoCalls = [];
mailer.sendViaBrevo = async (args) => { brevoCalls.push(args); return brevoImpl(args); };

const { installMockSupabase } = require('./helpers/mockSupabase');
const { getRouteHandler, makeReq, makeRes } = require('./helpers/routeHandler');
const techRouter = require('../routes/generator-tech');

const LEAD_ID = '123e4567-e89b-12d3-a456-426614174000';
const TECH_ID = '00000000-0000-4000-8000-000000000042';
const EXPECTED_URL = `https://generator.bates-electric.com/?lead=${LEAD_ID}`;

const handler = getRouteHandler(techRouter, 'post', '/enroll');

// The tech's request: routeHandler bypasses requireAuth, so user/profile are
// stubbed the way the middleware would have left them.
function techReq(body, { fullName = 'Chris Tech' } = {}) {
  const req = makeReq({ body, user: { id: TECH_ID, email: 'chris@bates-electric.com' } });
  if (fullName !== null) req.profile = { full_name: fullName };
  return req;
}

// Resolver: the insert returns a new lead id and records the row; an update
// (the optional-send advance) records its patch.
function leadResolvers(seen) {
  return {
    generator_leads: (chain) => {
      const insert = chain.find((c) => c.method === 'insert');
      if (insert) {
        seen.insert = insert.args[0];
        return { data: { id: LEAD_ID }, error: null };
      }
      const update = chain.find((c) => c.method === 'update');
      if (update) {
        seen.update = update.args[0];
        seen.updateEq = chain.find((c) => c.method === 'eq').args;
        return { data: null, error: null };
      }
      return { data: null, error: null };
    },
  };
}

let restoreSupabase;
test.beforeEach(() => { brevoCalls = []; brevoImpl = async () => ({ sent: true, messageId: 'test-msg' }); });
test.afterEach(() => {
  if (restoreSupabase) { restoreSupabase(); restoreSupabase = undefined; }
});

test('creates a field lead with the tech attribution and returns the pre-tagged URL', async () => {
  const seen = {};
  restoreSupabase = installMockSupabase(leadResolvers(seen));

  const res = makeRes();
  await handler(techReq({
    customer_name: '  Jane Doe  ',
    customer_phone: '(314) 555-0123',
    customer_email: 'jane@example.com',
    install_address: '123 Main St',
    install_city: 'St. Louis',
    install_state: 'MO',
    install_zip: '63101',
    generator_info: 'Generac 24kW',
  }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.lead_id, LEAD_ID);
  assert.equal(res.body.signup_url, EXPECTED_URL);
  assert.equal(res.body.emailed, false);
  assert.equal(res.body.email_error, null);

  // The inserted row: field source, new status, the tech's machine link +
  // display label, every captured field trimmed.
  assert.equal(seen.insert.source, 'field');
  assert.equal(seen.insert.status, 'new');
  assert.equal(seen.insert.referred_by_user_id, TECH_ID);
  assert.equal(seen.insert.referred_by_label, 'Chris Tech');
  assert.equal(seen.insert.customer_name, 'Jane Doe');
  assert.equal(seen.insert.generator_info, 'Generac 24kW');
  assert.equal(seen.insert.maintenance_month, undefined, 'field leads are not campaign-cohort leads');

  // QR-only: nothing emailed, lead left at `new` (no advance write).
  assert.equal(brevoCalls.length, 0);
  assert.equal(seen.update, undefined);
});

test('referred_by_label falls back to the email local-part without a profile name', async () => {
  const seen = {};
  restoreSupabase = installMockSupabase(leadResolvers(seen));

  const res = makeRes();
  await handler(techReq({ customer_name: 'Jane Doe' }, { fullName: null }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(seen.insert.referred_by_label, 'chris');
});

test('empty/whitespace optional fields stay off the row (columns stay null)', async () => {
  const seen = {};
  restoreSupabase = installMockSupabase(leadResolvers(seen));

  const res = makeRes();
  await handler(techReq({ customer_name: 'Jane Doe', customer_phone: '   ', customer_email: '' }), res);

  assert.equal(res.statusCode, 200);
  assert.equal('customer_phone' in seen.insert, false);
  assert.equal('customer_email' in seen.insert, false);
});

test('WP6.1: an EMPTY enroll succeeds — bare field lead, only the server-set columns', async () => {
  const seen = {};
  restoreSupabase = installMockSupabase(leadResolvers(seen));

  const res = makeRes();
  await handler(techReq({}), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.signup_url, EXPECTED_URL, 'a no-field enroll still returns a working ?lead= URL');

  // Exactly the server-set columns — source/status/attribution — nothing else.
  assert.deepEqual(Object.keys(seen.insert).sort(),
    ['referred_by_label', 'referred_by_user_id', 'source', 'status']);
  assert.equal(seen.insert.source, 'field');
  assert.equal(seen.insert.status, 'new');
  assert.equal(seen.insert.referred_by_user_id, TECH_ID);
  assert.equal(brevoCalls.length, 0);
});

test('malformed email -> 400, nothing inserted', async () => {
  const seen = {};
  restoreSupabase = installMockSupabase(leadResolvers(seen));

  const res = makeRes();
  await handler(techReq({ customer_name: 'Jane Doe', customer_email: '3145550123' }), res);

  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /email/i);
  assert.equal(seen.insert, undefined);
  assert.equal(brevoCalls.length, 0);
});

test('optional send: emails the signup link, advances to signup_sent + invited_at', async () => {
  const seen = {};
  restoreSupabase = installMockSupabase(leadResolvers(seen));

  const res = makeRes();
  await handler(techReq({
    customer_name: 'Jane Doe',
    customer_email: 'jane@example.com',
    send_email: true,
  }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.emailed, true);
  assert.equal(res.body.email_error, null);
  assert.equal(res.body.signup_url, EXPECTED_URL);

  // One real send carrying the pre-tagged link in both bodies.
  assert.equal(brevoCalls.length, 1);
  assert.deepEqual(brevoCalls[0].to, 'jane@example.com');
  assert.ok(brevoCalls[0].html.includes(EXPECTED_URL), 'html body must contain the ?lead= URL');
  assert.ok(brevoCalls[0].text.includes(EXPECTED_URL), 'text body must contain the ?lead= URL');

  // The WP4.2 invariant: a confirmed invite send writes signup_sent AND
  // stamps invited_at (the "Needs follow-up" clock), on THIS lead.
  assert.equal(seen.update.status, 'signup_sent');
  assert.ok(seen.update.invited_at, 'enroll send must stamp invited_at');
  assert.equal(seen.update.invited_at, seen.update.updated_at);
  assert.deepEqual(Object.keys(seen.update).sort(), ['invited_at', 'status', 'updated_at']);
  assert.deepEqual(seen.updateEq, ['id', LEAD_ID]);
});

test('FL lead: the emailed link is S.E. Bates branded', async () => {
  const seen = {};
  restoreSupabase = installMockSupabase(leadResolvers(seen));

  const res = makeRes();
  await handler(techReq({
    customer_name: 'Jane Doe',
    customer_email: 'jane@example.com',
    install_state: 'FL',
    send_email: true,
  }), res);

  assert.equal(res.body.emailed, true);
  assert.equal(brevoCalls[0].senderName, 'S.E. Bates Electric Generator Care');
  assert.match(brevoCalls[0].subject, /S\.E\. Bates Electric/);
});

test('failed send: URL still returned for the QR, lead NOT advanced', async () => {
  brevoImpl = async () => ({ sent: false, reason: 'Brevo 503' });
  const seen = {};
  restoreSupabase = installMockSupabase(leadResolvers(seen));

  const res = makeRes();
  await handler(techReq({
    customer_name: 'Jane Doe',
    customer_email: 'jane@example.com',
    send_email: true,
  }), res);

  assert.equal(res.statusCode, 200, 'a mail hiccup must never block the QR');
  assert.equal(res.body.ok, true);
  assert.equal(res.body.signup_url, EXPECTED_URL);
  assert.equal(res.body.emailed, false);
  assert.match(res.body.email_error, /scan the QR/);
  assert.equal(seen.update, undefined, 'an unsent invite must not advance the lead');
});

test('send_email without an email on file: no send attempted, QR-only result', async () => {
  const seen = {};
  restoreSupabase = installMockSupabase(leadResolvers(seen));

  const res = makeRes();
  await handler(techReq({ customer_name: 'Jane Doe', send_email: true }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.emailed, false);
  assert.equal(res.body.email_error, null);
  assert.equal(brevoCalls.length, 0);
  assert.equal(seen.update, undefined);
});

test('insert failure -> 500', async () => {
  restoreSupabase = installMockSupabase({
    generator_leads: () => ({ data: null, error: new Error('boom') }),
  });

  const res = makeRes();
  await handler(techReq({ customer_name: 'Jane Doe' }), res);

  assert.equal(res.statusCode, 500);
  assert.equal(brevoCalls.length, 0);
});
