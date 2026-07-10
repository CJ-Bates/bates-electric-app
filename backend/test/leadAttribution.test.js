// Webhook lead attribution (Growth Engine WP2) — offline unit tests with
// Stripe (global fetch) and Supabase mocked. Exercises the REAL shipped
// handleSubscriptionCreated + attributeLeadConversion via the webhook module's
// _test seam:
//   (a) a subscription.created event carrying a valid lead_id marks that lead
//       converted and stamps our subscription row id on it;
//   (b) a re-delivered event (lead already converted -> update matches 0 rows)
//       is a no-op, never a double-write or an error;
//   (c) an event with NO lead_id never touches generator_leads and the
//       existing signup work (customer upsert, subscription + first-visit
//       inserts) still runs untouched;
//   (d) a lead_id for a missing/already-converted lead, or a non-UUID one,
//       doesn't throw (and non-UUIDs never reach the DB at all).
require('./helpers/env');

const test = require('node:test');
const assert = require('node:assert/strict');

const { installMockSupabase } = require('./helpers/mockSupabase');
const { handleSubscriptionCreated, attributeLeadConversion } = require('../routes/generator-webhook')._test;

const LEAD_ID = '123e4567-e89b-12d3-a456-426614174000';
const SUB_ROW_ID = 'a0000000-0000-4000-8000-000000000001';

// Minimal Stripe subscription payload shaped like the real
// customer.subscription.created event object (metadata comes from the signup
// site's checkout subscription_data.metadata).
function makeSubscription(metadataExtra = {}) {
  return {
    id: 'sub_stripe_1',
    customer: 'cus_1',
    status: 'active',
    default_payment_method: 'pm_1',
    latest_invoice: null, // skips the first-invoice amount lookup
    items: { data: [{ price: { unit_amount: 40000 } }] },
    metadata: {
      gen_class: 'air_cooled',
      plan: 'annual',
      customer_name: 'Jane Doe',
      install_state: 'MO',
      ...metadataExtra,
    },
  };
}

// Intercept the webhook's direct Stripe REST calls (stripeGet/stripePost use
// global fetch). Anything not aimed at api.stripe.com fails the test — these
// tests must run fully offline.
let realFetch;
function installMockStripeFetch() {
  realFetch = global.fetch;
  global.fetch = async (url) => {
    const u = String(url);
    assert.ok(u.startsWith('https://api.stripe.com/'), `unexpected fetch in offline test: ${u}`);
    let body = {};
    if (u.includes('/customers/cus_1')) {
      body = { id: 'cus_1', email: 'jane@example.com', name: 'Jane Doe', phone: '' };
    }
    return { ok: true, json: async () => body, text: async () => JSON.stringify(body) };
  };
}

let restoreSupabase;
test.afterEach(() => {
  if (restoreSupabase) { restoreSupabase(); restoreSupabase = undefined; }
  if (realFetch) { global.fetch = realFetch; realFetch = undefined; }
});

// Standard resolvers for the tables handleSubscriptionCreated always touches.
// Callers spread these and add (or omit) generator_leads per test.
function baseResolvers(calls) {
  return {
    generator_customers: (chain) => {
      calls.push(['generator_customers', chain[0].method]);
      return { data: { id: 'cust_row_1', email: 'jane@example.com', install_state: 'MO', name: 'Jane Doe' }, error: null };
    },
    generator_subscriptions: (chain) => {
      calls.push(['generator_subscriptions', chain[0].method]);
      if (chain[0].method === 'insert') {
        return { data: { id: SUB_ROW_ID }, error: null };
      }
      return { data: null, error: null }; // standing_addons seed update
    },
    generator_service_visits: (chain) => {
      calls.push(['generator_service_visits', chain[0].method]);
      return { data: { id: 'visit_row_1' }, error: null };
    },
  };
}

test('(a) subscription.created with a valid lead_id converts the lead and stamps our sub row id', async () => {
  installMockStripeFetch();
  const calls = [];
  let leadChain = null;
  restoreSupabase = installMockSupabase({
    ...baseResolvers(calls),
    generator_leads: (chain) => {
      leadChain = chain;
      return { data: { id: LEAD_ID }, error: null };
    },
  });

  await handleSubscriptionCreated(makeSubscription({ lead_id: LEAD_ID }));

  assert.ok(leadChain, 'generator_leads was never touched');
  const update = leadChain.find((c) => c.method === 'update');
  assert.ok(update, 'no update issued on generator_leads');
  assert.equal(update.args[0].status, 'converted');
  assert.equal(update.args[0].converted_subscription_id, SUB_ROW_ID, 'must stamp OUR subscription row id (the FK target), not the Stripe sub id');
  assert.ok(update.args[0].updated_at, 'updated_at must be stamped');
  assert.deepEqual(
    leadChain.find((c) => c.method === 'eq').args,
    ['id', LEAD_ID]
  );
  // The idempotency filter: only a not-yet-converted lead may be written.
  assert.deepEqual(
    leadChain.find((c) => c.method === 'neq').args,
    ['status', 'converted']
  );
});

test('(b) re-delivered event is a no-op: already-converted lead matches 0 rows, no error, no second write', async () => {
  let updates = 0;
  restoreSupabase = installMockSupabase({
    generator_leads: (chain) => {
      if (chain.some((c) => c.method === 'update')) updates += 1;
      // .neq('status','converted') filtered the row out — supabase returns
      // data:null from maybeSingle(), exactly what a redelivery sees.
      return { data: null, error: null };
    },
  });

  await attributeLeadConversion(makeSubscription({ lead_id: LEAD_ID }), SUB_ROW_ID);
  await attributeLeadConversion(makeSubscription({ lead_id: LEAD_ID }), SUB_ROW_ID);
  assert.equal(updates, 2, 'each delivery issues the same guarded update');
  // No assertion rejections above = no throw; the guard (.neq) is asserted in (a).
});

test('(c) event with no lead_id: generator_leads untouched, signup work still processes', async () => {
  installMockStripeFetch();
  const calls = [];
  restoreSupabase = installMockSupabase({
    ...baseResolvers(calls),
    generator_leads: () => {
      assert.fail('organic signup (no lead_id) must never touch generator_leads');
    },
  });

  await handleSubscriptionCreated(makeSubscription());

  // The pre-existing signup pipeline ran in full: customer upserted,
  // subscription row inserted, first visit created, standing add-ons seeded.
  assert.deepEqual(calls, [
    ['generator_customers', 'upsert'],
    ['generator_subscriptions', 'insert'],
    ['generator_service_visits', 'insert'],
    ['generator_subscriptions', 'update'],
  ]);
});

test('(d) missing lead and non-UUID lead_id both no-op without throwing', async () => {
  let touched = 0;
  restoreSupabase = installMockSupabase({
    generator_leads: () => { touched += 1; return { data: null, error: null }; },
  });

  // Valid UUID but no matching row: guarded update matches nothing, no throw.
  await attributeLeadConversion(makeSubscription({ lead_id: LEAD_ID }), SUB_ROW_ID);
  assert.equal(touched, 1);

  // Non-UUID junk (someone poking the public checkout endpoint directly):
  // dropped before any query — no Postgres uuid cast error possible.
  await attributeLeadConversion(makeSubscription({ lead_id: 'DROP TABLE;--' }), SUB_ROW_ID);
  await attributeLeadConversion(makeSubscription({ lead_id: '' }), SUB_ROW_ID);
  assert.equal(touched, 1, 'non-UUID lead_id must never reach the DB');
});

test('(d2) a DB error during attribution surfaces as a throw for the caller to report, never a partial write', async () => {
  restoreSupabase = installMockSupabase({
    generator_leads: () => ({ data: null, error: { message: 'connection reset' } }),
  });
  await assert.rejects(
    () => attributeLeadConversion(makeSubscription({ lead_id: LEAD_ID }), SUB_ROW_ID),
    /lead conversion update/
  );
  // (handleSubscriptionCreated wraps this in try/catch + reportError, so the
  // webhook itself still 200s — asserted implicitly by (a)/(c) not requiring it.)
});
