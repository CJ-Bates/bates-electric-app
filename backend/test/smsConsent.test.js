// SMS Phase 1 consent capture + the booking-confirmation hook — offline unit
// tests through the REAL shipped handlers:
//   (a) office booking (POST /visits/:id/schedule) logs the confirmation text
//       against the visit with the kill-switch off (sends nothing), and logs
//       'no_consent' for a customer who never opted in;
//   (b) dashboard toggle (POST /api/my/sms-consent) writes a consent row with
//       source 'dashboard' and the exact shown language;
//   (c) office record-consent (POST /customers/:id/sms-consent) writes source
//       'office' and 400s without a phone on file;
//   (d) signup webhook: metadata sms_opt_in='true' writes source 'signup'.
require('./helpers/env');

const test = require('node:test');
const assert = require('node:assert/strict');

const { installMockSupabase } = require('./helpers/mockSupabase');
const { getRouteHandler, makeReq, makeRes } = require('./helpers/routeHandler');
const { CONSENT_TEXT } = require('../lib/sms');

const visitsRouter = require('../routes/generator-care/visits');
const customerRouter = require('../routes/customer');
const subscriptionsRouter = require('../routes/generator-care/subscriptions');
const { handleSubscriptionCreated } = require('../routes/generator-webhook')._test;

const scheduleHandler = getRouteHandler(visitsRouter, 'post', '/visits/:id/schedule');
const myConsentHandler = getRouteHandler(customerRouter, 'post', '/sms-consent');
const officeConsentHandler = getRouteHandler(subscriptionsRouter, 'post', '/customers/:id/sms-consent');

const CUSTOMER_ID = 'c0000000-0000-4000-8000-000000000001';
const VISIT_ID = 'a0000000-0000-4000-8000-000000000002';

let restoreSupabase;
let realFetch;
test.afterEach(() => {
  if (restoreSupabase) { restoreSupabase(); restoreSupabase = undefined; }
  if (realFetch) { global.fetch = realFetch; realFetch = undefined; }
  delete process.env.SMS_ENABLED;
  delete process.env.SIMPLETEXTING_API_TOKEN;
});

// Fire-and-forget sends settle a microtask/macrotask after the response; give
// them one tick before asserting the message log.
const settle = () => new Promise((r) => setTimeout(r, 20));

// ---------------------------------------------------------------------------
// (a) Booking hook
// ---------------------------------------------------------------------------
function bookingWorld({ consentRows }) {
  const world = { logged: [] };
  restoreSupabase = installMockSupabase({
    generator_service_visits: (chain) => {
      if (chain.some((c) => c.method === 'update')) {
        return {
          data: {
            id: VISIT_ID, subscription_id: 'sub1',
            appointment_at: '2026-08-12T13:00:00.000Z', arrival_window: '8-10', status: 'scheduled',
            subscription: { id: 'sub1', plan: 'annual', customer: { id: CUSTOMER_ID, name: 'Sarah Example', email: 'sarah@example.com', phone: '636-555-0100', install_state: 'MO' } },
          },
          error: null,
        };
      }
      // pre-read + the preferences visit-id sweep
      return { data: { id: VISIT_ID, appointment_at: null, arrival_window: null, status: 'tentative', assigned_tech_id: null }, error: null };
    },
    generator_visit_preferences: () => ({ data: null, error: null }),
    generator_sms_consent: () => ({ data: consentRows, error: null }),
    generator_sms_messages: (chain) => {
      const ins = chain.find((c) => c.method === 'insert');
      if (ins) world.logged.push(ins.args[0]);
      return { data: null, error: null };
    },
  });
  return world;
}

test('(a) booking with SMS_ENABLED off logs the exact confirmation text on the visit, sends nothing', async () => {
  realFetch = global.fetch;
  global.fetch = async (url) => { throw new Error('unexpected fetch in offline test: ' + url); };
  const world = bookingWorld({ consentRows: [{ opted_in: true, opted_out: false }] });

  const res = makeRes();
  await scheduleHandler(makeReq({
    params: { id: VISIT_ID },
    body: { appointment_at: '2026-08-12T08:00:00', arrival_window: '8-10' },
  }), res);
  await settle();

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(world.logged.length, 1, 'exactly one outbound row logged');
  const row = world.logged[0];
  assert.equal(row.status, 'disabled', 'kill-switch off = logged, not sent');
  assert.equal(row.related_visit_id, VISIT_ID);
  assert.equal(row.customer_id, CUSTOMER_ID);
  assert.equal(row.to_phone, '+16365550100');
  assert.ok(row.body.includes('Hi Sarah'), row.body);
  assert.ok(row.body.includes('Wed Aug 12, arriving 8-10 AM'), row.body);
  assert.ok(row.body.includes('Reply Y to confirm'), row.body);
});

test('(a) booking for a never-opted-in customer logs no_consent — visible, never sent', async () => {
  const world = bookingWorld({ consentRows: [] });
  const res = makeRes();
  await scheduleHandler(makeReq({
    params: { id: VISIT_ID },
    body: { appointment_at: '2026-08-12T08:00:00', arrival_window: '8-10' },
  }), res);
  await settle();
  assert.equal(res.statusCode, 200, 'a missing opt-in must never fail the booking');
  assert.equal(world.logged.length, 1);
  assert.equal(world.logged[0].status, 'no_consent');
});

// ---------------------------------------------------------------------------
// (b) Dashboard toggle
// ---------------------------------------------------------------------------
function consentWorld({ customerPhone } = {}) {
  const world = { consentInserts: [], logged: [] };
  restoreSupabase = installMockSupabase({
    generator_customers: (chain) => {
      // customer.js resolveCustomer (ilike list) AND the office route's
      // single-customer read share this resolver.
      const row = { id: CUSTOMER_ID, name: 'Sarah Example', email: 'sarah@example.com', phone: customerPhone !== undefined ? customerPhone : '636-555-0100', install_state: 'MO', install_address: 'x', install_city: 'x', install_zip: 'x', stripe_customer_id: 'cus_1' };
      const terminalIsSingle = chain.some((c) => c.method === 'eq');
      return { data: terminalIsSingle ? row : [row], error: null };
    },
    generator_subscriptions: () => ({ data: [{ id: 'sub1', customer_id: CUSTOMER_ID, status: 'active', signup_date: '2026-06-01', plan: 'annual' }], error: null }),
    generator_sms_consent: (chain, terminal) => {
      const ins = chain.find((c) => c.method === 'insert');
      if (ins) { world.consentInserts.push(ins.args[0]); return { data: { id: 'cons1', ...ins.args[0] }, error: null }; }
      if (terminal === 'maybeSingle') return { data: null, error: null }; // no row yet
      // sendSms's gate re-read: reflect the just-written opt-in.
      return { data: world.consentInserts.length ? [{ opted_in: true, opted_out: false }] : [], error: null };
    },
    generator_sms_messages: (chain) => {
      const ins = chain.find((c) => c.method === 'insert');
      if (ins) world.logged.push(ins.args[0]);
      return { data: null, error: null };
    },
  });
  return world;
}

test('(b) dashboard opt-in writes the legal row (source dashboard, exact language) + attempts copy (6)', async () => {
  const world = consentWorld();
  const res = makeRes();
  await myConsentHandler(makeReq({ body: { opt_in: true }, user: { email: 'sarah@example.com' } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.opted_in, true);
  assert.equal(world.consentInserts.length, 1);
  const row = world.consentInserts[0];
  assert.equal(row.source, 'dashboard');
  assert.equal(row.phone, '+16365550100');
  assert.equal(row.consent_text, CONSENT_TEXT.dashboard, 'the EXACT shown language is the record');
  const optinMsg = world.logged.find((l) => l.direction === 'out');
  assert.ok(optinMsg, 'opt-in confirmation attempted');
  assert.equal(optinMsg.status, 'disabled', 'kill-switch off in tests');
  assert.ok(optinMsg.body.includes("You're signed up for appointment texts"), optinMsg.body);
});

test('(b) dashboard toggle without a phone on file is a clean 400', async () => {
  consentWorld({ customerPhone: '' });
  const res = makeRes();
  await myConsentHandler(makeReq({ body: { opt_in: true }, user: { email: 'sarah@example.com' } }), res);
  assert.equal(res.statusCode, 400);
});

// ---------------------------------------------------------------------------
// (c) Office record-consent
// ---------------------------------------------------------------------------
test('(c) office record-consent writes source office; opt-out sends no text', async () => {
  const world = consentWorld();
  let res = makeRes();
  await officeConsentHandler(makeReq({ params: { id: CUSTOMER_ID }, body: { opt_in: true } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(world.consentInserts[0].source, 'office');
  assert.equal(world.consentInserts[0].consent_text, CONSENT_TEXT.office);

  const world2 = consentWorld();
  res = makeRes();
  await officeConsentHandler(makeReq({ params: { id: CUSTOMER_ID }, body: { opt_in: false } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(world2.consentInserts[0].opted_out, true);
  assert.equal(world2.logged.filter((l) => l.direction === 'out').length, 0, 'no text on an opt-out');
});

test('(c) office record-consent 400s when the customer has no phone', async () => {
  consentWorld({ customerPhone: null });
  const res = makeRes();
  await officeConsentHandler(makeReq({ params: { id: CUSTOMER_ID }, body: { opt_in: true } }), res);
  assert.equal(res.statusCode, 400);
});

// ---------------------------------------------------------------------------
// (d) Signup webhook
// ---------------------------------------------------------------------------
function installMockStripeFetch() {
  realFetch = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    assert.ok(u.startsWith('https://api.stripe.com/'), 'unexpected fetch in offline test: ' + u);
    let body = {};
    if (u.includes('/customers/cus_1')) body = { id: 'cus_1', email: 'sarah@example.com', name: 'Sarah Example', phone: '' };
    return { ok: true, json: async () => body, text: async () => JSON.stringify(body) };
  };
}

function signupWorld() {
  const world = { consentInserts: [], logged: [] };
  restoreSupabase = installMockSupabase({
    generator_customers: () => ({ data: { id: CUSTOMER_ID, email: 'sarah@example.com', name: 'Sarah Example', phone: '636-555-0100', install_state: 'MO' }, error: null }),
    generator_subscriptions: (chain) => {
      if (chain[0].method === 'insert') return { data: { id: 'subrow1' }, error: null };
      return { data: null, error: null };
    },
    generator_service_visits: () => ({ data: { id: VISIT_ID }, error: null }),
    generator_sms_consent: (chain, terminal) => {
      const ins = chain.find((c) => c.method === 'insert');
      if (ins) { world.consentInserts.push(ins.args[0]); return { data: { id: 'cons1', ...ins.args[0] }, error: null }; }
      if (terminal === 'maybeSingle') return { data: null, error: null };
      return { data: world.consentInserts.length ? [{ opted_in: true, opted_out: false }] : [], error: null };
    },
    generator_sms_messages: (chain) => {
      const ins = chain.find((c) => c.method === 'insert');
      if (ins) world.logged.push(ins.args[0]);
      return { data: null, error: null };
    },
  });
  return world;
}

function makeSubscription(metadataExtra = {}) {
  return {
    id: 'sub_stripe_1',
    customer: 'cus_1',
    status: 'active',
    default_payment_method: 'pm_1',
    latest_invoice: null,
    items: { data: [{ price: { unit_amount: 40000 } }] },
    metadata: { gen_class: 'air_cooled', plan: 'annual', customer_name: 'Sarah Example', install_state: 'MO', ...metadataExtra },
  };
}

test('(d) signup with sms_opt_in=true writes source signup with the checkbox language + attempts copy (6)', async () => {
  installMockStripeFetch();
  const world = signupWorld();
  await handleSubscriptionCreated(makeSubscription({ sms_opt_in: 'true', customer_phone: '636-555-0100' }));
  assert.equal(world.consentInserts.length, 1);
  assert.equal(world.consentInserts[0].source, 'signup');
  assert.equal(world.consentInserts[0].phone, '+16365550100');
  assert.equal(world.consentInserts[0].consent_text, CONSENT_TEXT.signup);
  const msg = world.logged.find((l) => l.direction === 'out');
  assert.ok(msg, 'opt-in confirmation attempted');
  assert.equal(msg.status, 'disabled');
});

test('(d) signup without the checkbox writes NO consent row and sends nothing', async () => {
  installMockStripeFetch();
  const world = signupWorld();
  await handleSubscriptionCreated(makeSubscription({ customer_phone: '636-555-0100' }));
  assert.equal(world.consentInserts.length, 0);
  assert.equal(world.logged.length, 0);
});

// ---------------------------------------------------------------------------
// (e) Contact-name hooks: every consent capture upserts the SimpleTexting
// contact with the customer's name (fire-and-forget), so the first text lands
// on "Sarah Example" instead of a bare "no name" number. The kill-switch off
// means the ONLY SimpleTexting call in these tests is the contacts upsert.
// ---------------------------------------------------------------------------
function captureContactUpserts({ allowStripe } = {}) {
  realFetch = global.fetch;
  const upserts = [];
  global.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('/api/contacts')) {
      upserts.push({ url: u, body: JSON.parse(opts.body) });
      return { ok: true, status: 201, json: async () => ({ id: 'contact_1' }) };
    }
    if (allowStripe && u.startsWith('https://api.stripe.com/')) {
      let body = {};
      if (u.includes('/customers/cus_1')) body = { id: 'cus_1', email: 'sarah@example.com', name: 'Sarah Example', phone: '' };
      return { ok: true, json: async () => body, text: async () => JSON.stringify(body) };
    }
    throw new Error('unexpected fetch in offline test: ' + u);
  };
  return upserts;
}

test('(e) dashboard opt-in fire-and-forgets the contact-name upsert with the customer name', async () => {
  process.env.SIMPLETEXTING_API_TOKEN = 'tok_secret';
  const upserts = captureContactUpserts();
  consentWorld();
  const res = makeRes();
  await myConsentHandler(makeReq({ body: { opt_in: true }, user: { email: 'sarah@example.com' } }), res);
  assert.equal(res.statusCode, 200, 'response never waits on the upsert');
  await settle();
  assert.equal(upserts.length, 1);
  assert.ok(upserts[0].url.includes('upsert=true'), upserts[0].url);
  assert.ok(upserts[0].url.includes('listsReplacement=false'), 'must never yank the contact off existing lists on the shared account');
  assert.deepEqual(upserts[0].body, { contactPhone: '6365550100', firstName: 'Sarah', lastName: 'Example' });
});

test('(e) office opt-in upserts the name; opt-out does not touch the contact', async () => {
  process.env.SIMPLETEXTING_API_TOKEN = 'tok_secret';
  let upserts = captureContactUpserts();
  consentWorld();
  let res = makeRes();
  await officeConsentHandler(makeReq({ params: { id: CUSTOMER_ID }, body: { opt_in: true } }), res);
  assert.equal(res.statusCode, 200);
  await settle();
  assert.equal(upserts.length, 1);
  assert.equal(upserts[0].body.firstName, 'Sarah');
  assert.equal(upserts[0].body.lastName, 'Example');

  upserts = captureContactUpserts();
  consentWorld();
  res = makeRes();
  await officeConsentHandler(makeReq({ params: { id: CUSTOMER_ID }, body: { opt_in: false } }), res);
  assert.equal(res.statusCode, 200);
  await settle();
  assert.equal(upserts.length, 0, 'no contact write on an opt-out');
});

test('(e) signup webhook with sms_opt_in=true upserts the contact name', async () => {
  process.env.SIMPLETEXTING_API_TOKEN = 'tok_secret';
  const upserts = captureContactUpserts({ allowStripe: true });
  signupWorld();
  await handleSubscriptionCreated(makeSubscription({ sms_opt_in: 'true', customer_phone: '636-555-0100' }));
  await settle();
  assert.equal(upserts.length, 1);
  assert.deepEqual(upserts[0].body, { contactPhone: '6365550100', firstName: 'Sarah', lastName: 'Example' });
});
