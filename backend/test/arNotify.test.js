// Internal AR payment notice (lib/arNotify.js): one email to AR_EMAIL per
// Stripe money event, driven by the webhooks. Pins:
//   - paid / refund / failed each render the right subject, type, entity (MO
//     vs FL), WO#, line items, card, Stripe refs, plan + renewal, footer
//   - idempotent on webhook retry (metadata stamp read before, written after)
//   - a failed AR send is reported (reportError) and never throws, so the
//     webhook handlers that fire it still resolve
//   - signup race (no DB rows yet) still notifies from Stripe metadata
//   - non-Generator-Care activity is skipped quietly
// Fully offline: Stripe (shared gcShared instance), Supabase, Brevo and the
// error reporter are all stubbed.
require('./helpers/env');

const test = require('node:test');
const assert = require('node:assert/strict');

// Error reporter: swap the module BEFORE anything requires it so "reportError
// was called" is a direct assertion.
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

// Mailer: patched before lib/emails.js loads (it destructures sendViaBrevo).
const mailer = require('../lib/mailer');
const sentEmails = [];
let mailerBehavior = 'sent'; // 'sent' | 'fail' | 'throw'
mailer.sendViaBrevo = async (args) => {
  if (mailerBehavior === 'throw') throw new Error('brevo exploded');
  sentEmails.push(args);
  return mailerBehavior === 'fail' ? { sent: false, reason: 'Brevo 402: credits' } : { sent: true, messageId: 'm1' };
};

const { installMockSupabase } = require('./helpers/mockSupabase');
const { stripe } = require('../lib/gcShared');
const arNotify = require('../lib/arNotify');

// Keep the webhook's own receipt sender offline (same seam invoicePaymentIntent uses).
const receipts = require('../lib/receipts');
receipts.sendReceiptEmail = async () => ({ sent: false, reason: 'test-stub' });
const webhook = require('../routes/generator-webhook')._test;

// Webhook helpers use global fetch for raw Stripe GET/POSTs; reject fast.
global.fetch = async () => { throw new Error('offline test'); };

// ---- Stripe stubbing (shared-instance patch) -------------------------------
let restoreStripe = [];
function stubStripe(resource, method, impl) {
  if (!stripe[resource]) stripe[resource] = {};
  const original = stripe[resource][method];
  const calls = [];
  stripe[resource][method] = async (...args) => { calls.push(args); return impl(...args); };
  restoreStripe.push(() => { stripe[resource][method] = original; });
  return calls;
}

let restoreSupabase;
test.beforeEach(() => {
  sentEmails.length = 0;
  reportErrorCalls.length = 0;
  mailerBehavior = 'sent';
});
test.afterEach(() => {
  if (restoreSupabase) { restoreSupabase(); restoreSupabase = undefined; }
  restoreStripe.forEach((r) => r());
  restoreStripe = [];
});

// ---- Fixtures ----------------------------------------------------------------
const CUSTOMER = (state) => ({
  id: 'cust-1', name: 'John Fort', email: 'john@example.com', phone: '(636) 555-0100',
  install_address: '123 Main St', install_city: 'Imperial', install_state: state, install_zip: '63052',
});
const SUB_ROW = { id: 'sub-db-1', plan: 'annual', gen_class: 'air_cooled', fleet_monitoring: false, work_order_number: 'WO-778', status: 'active', stripe_subscription_id: 'sub_1', customer_id: 'cust-1' };
const STRIPE_SUB = { id: 'sub_1', metadata: { gen_class: 'air_cooled', plan: 'annual' }, items: { data: [{ current_period_end: 1813536000 }] } }; // 2027-06-21

function tables({ customer = CUSTOMER('MO'), sub = SUB_ROW } = {}) {
  return {
    generator_customers: () => ({ data: customer, error: null }),
    generator_subscriptions: () => ({ data: sub, error: null }),
  };
}

const CHARGE_OBJ = { id: 'ch_1', receipt_number: '1234-5678', payment_method_details: { card: { brand: 'visa', last4: '4242' } } };
const PAID_INVOICE = (over = {}) => ({
  id: 'in_1', number: 'ABC-0007', customer: 'cus_1', subscription: 'sub_1', billing_reason: 'subscription_cycle',
  amount_paid: 39500, created: 1760000000, status_transitions: { paid_at: 1760000000 },
  charge: CHARGE_OBJ, metadata: {},
  lines: { data: [{ description: 'Air Cooled Generator Care — Annual', amount: 39500, metadata: {} }] },
  ...over,
});

function stubHappyPath({ invoiceMeta = {} } = {}) {
  const retrieve = stubStripe('invoices', 'retrieve', async (id) => ({ id, metadata: invoiceMeta }));
  const update = stubStripe('invoices', 'update', async () => ({}));
  stubStripe('subscriptions', 'retrieve', async () => STRIPE_SUB);
  return { retrieve, update };
}

// ---- classifyInvoice (pure) ---------------------------------------------------
test('classifyInvoice: billing_reason + our metadata map to the AR Type line', () => {
  const c = arNotify.classifyInvoice;
  assert.equal(c({ billing_reason: 'subscription_create' }), 'Signup');
  assert.equal(c({ billing_reason: 'subscription_cycle' }), 'Renewal');
  assert.equal(c({ billing_reason: 'manual', metadata: { tier_change: '1' } }), 'Tier change');
  assert.equal(c({ billing_reason: 'manual', lines: { data: [{ metadata: { addon_id: 'a1' } }] } }), 'Add-on charge');
  assert.equal(c({ billing_reason: 'manual', lines: { data: [{ metadata: { adhoc_charge_id: 'c1' } }] } }), 'Other (ad-hoc service charge)');
  assert.equal(c({ billing_reason: 'manual', lines: { data: [{ metadata: { addon_id: 'a1' } }, { metadata: { adhoc_charge_id: 'c1' } }] } }), 'Add-on charge + ad-hoc service charge');
  assert.equal(c({ billing_reason: 'subscription_update', lines: { data: [{ metadata: {} }] } }), 'Other (subscription change)');
  assert.equal(c({}), 'Other');
});

// ---- invoice.paid ---------------------------------------------------------------
test('invoice.paid: one notice to AR with every line AR needs, then the invoice is stamped', async () => {
  restoreSupabase = installMockSupabase(tables());
  const { update } = stubHappyPath();

  const r = await arNotify.notifyArInvoicePaid(PAID_INVOICE());
  assert.equal(r.sent, true);
  assert.equal(sentEmails.length, 1);
  const m = sentEmails[0];
  assert.equal(m.to, arNotify.AR_EMAIL);
  assert.equal(arNotify.AR_EMAIL, 'AR@bates-electric.com'); // default when unset
  assert.equal(m.senderEmail, 'no-reply@bates-electric.com');
  assert.equal(m.subject, '[Generator Care] Payment received — John Fort — $395.00');
  const t = m.text;
  assert.match(t, /Install address: 123 Main St, Imperial, MO, 63052/);
  assert.match(t, /Phone \/ email: \(636\) 555-0100 \/ john@example.com/);
  assert.match(t, /Branding entity: Bates Electric\n/);
  assert.match(t, /Jonas WO#: WO-778/);
  assert.match(t, /Type: Renewal/);
  assert.match(t, /Line items: Air Cooled Generator Care — Annual \$395\.00/);
  assert.match(t, /Amount paid: \$395\.00/);
  assert.match(t, /Paid at: Oct \d+, 2025, .* C[DS]T/);
  assert.match(t, /Card: Visa \*\*\*\* 4242/);
  assert.match(t, /Stripe receipt #: 1234-5678/);
  assert.match(t, /Stripe invoice #: ABC-0007/);
  assert.match(t, /Charge ID: ch_1/);
  assert.match(t, /Plan: Annual — next renewal Monday, June 21, 2027/);
  assert.match(t, /Internal AR notice — customer has already paid by card\. Do not invoice\./);
  assert.doesNotMatch(t, /please invoice|Mark invoice sent/i);
  assert.match(m.html, /Payment received/);
  assert.match(m.html, /WO-778/);
  // Dedupe stamp written AFTER the confirmed send.
  assert.equal(update.length, 1);
  assert.equal(update[0][0], 'in_1');
  assert.ok(update[0][1].metadata.ar_notice_sent_at);
  assert.equal(reportErrorCalls.length, 0);
});

test('invoice.paid: Florida install address -> S.E. Bates Electric (FL) entity', async () => {
  restoreSupabase = installMockSupabase(tables({ customer: CUSTOMER('FL') }));
  stubHappyPath();
  await arNotify.notifyArInvoicePaid(PAID_INVOICE({ billing_reason: 'subscription_create' }));
  assert.equal(sentEmails.length, 1);
  assert.match(sentEmails[0].text, /Branding entity: S\.E\. Bates Electric \(FL\)/);
  assert.match(sentEmails[0].text, /Type: Signup/);
  assert.match(sentEmails[0].html, /S\.E\. Bates Electric/);
});

test('invoice.paid retry: an already-stamped invoice sends nothing and is not re-stamped', async () => {
  restoreSupabase = installMockSupabase(tables());
  const { update } = stubHappyPath({ invoiceMeta: { ar_notice_sent_at: '2026-10-23T12:00:00Z' } });
  const r = await arNotify.notifyArInvoicePaid(PAID_INVOICE());
  assert.equal(r.sent, false);
  assert.equal(r.reason, 'already sent');
  assert.equal(sentEmails.length, 0);
  assert.equal(update.length, 0);
});

test('invoice.paid: mailer {sent:false} -> reportError, no stamp, no throw', async () => {
  restoreSupabase = installMockSupabase(tables());
  const { update } = stubHappyPath();
  mailerBehavior = 'fail';
  const r = await arNotify.notifyArInvoicePaid(PAID_INVOICE());
  assert.equal(r.sent, false);
  assert.equal(update.length, 0);
  assert.equal(reportErrorCalls.length, 1);
  assert.match(reportErrorCalls[0].err.message, /AR payment notice send FAILED for invoice in_1 to AR@bates-electric\.com: Brevo 402/);
});

test('invoice.paid signup race: no DB rows yet -> notice built from Stripe metadata, WO not created yet', async () => {
  restoreSupabase = installMockSupabase({
    generator_customers: () => ({ data: null, error: null }),
    generator_subscriptions: () => ({ data: null, error: null }),
  });
  stubStripe('invoices', 'retrieve', async (id) => ({ id, metadata: {} }));
  stubStripe('invoices', 'update', async () => ({}));
  stubStripe('subscriptions', 'retrieve', async () => ({
    id: 'sub_1',
    metadata: { gen_class: 'liquid_22_38', plan: 'semi_annual', customer_name: 'Susan High', customer_phone: '(727) 555-0101', install_address: '9 Bay St', install_city: 'Tampa', install_state: 'FL', install_zip: '33601' },
    items: { data: [{ current_period_end: 1813536000 }] },
  }));
  stubStripe('customers', 'retrieve', async () => ({ email: 'susan@example.com', name: 'Susan High' }));

  await arNotify.notifyArInvoicePaid(PAID_INVOICE({ billing_reason: 'subscription_create' }));
  assert.equal(sentEmails.length, 1);
  const t = sentEmails[0].text;
  assert.match(t, /Customer: Susan High/);
  assert.match(t, /Install address: 9 Bay St, Tampa, FL, 33601/);
  assert.match(t, /Branding entity: S\.E\. Bates Electric \(FL\)/);
  assert.match(t, /Jonas WO#: WO not created yet/);
  assert.match(t, /Type: Signup/);
  assert.match(t, /Plan: Semi-Annual — next renewal/);
});

test('invoice.paid: not Generator Care (no DB customer, no gen_class) -> quiet skip', async () => {
  restoreSupabase = installMockSupabase({
    generator_customers: () => ({ data: null, error: null }),
    generator_subscriptions: () => ({ data: null, error: null }),
  });
  stubStripe('invoices', 'retrieve', async (id) => ({ id, metadata: {} }));
  stubStripe('subscriptions', 'retrieve', async () => ({ id: 'sub_other', metadata: {}, items: { data: [] } }));
  const r = await arNotify.notifyArInvoicePaid(PAID_INVOICE());
  assert.equal(r.reason, 'not generator');
  assert.equal(sentEmails.length, 0);
  assert.equal(reportErrorCalls.length, 0);
});

// ---- charge.refunded ------------------------------------------------------------
const REFUNDED_CHARGE = (over = {}) => ({
  id: 'ch_1', customer: 'cus_1', invoice: 'in_1', payment_intent: 'pi_1', amount: 19500, amount_refunded: 8500,
  created: 1760000000, receipt_number: '1234-5678', description: 'Generator add-ons: Exterior Wash, ATS + Outage Test',
  payment_method_details: { card: { brand: 'mastercard', last4: '9999' } },
  refunds: { data: [{ id: 're_1', amount: 8500, created: 1760003600, metadata: {} }] },
  ...over,
});

test('charge.refunded: partial refund -> "Refund issued" with the refund amount, original invoice, then the refund is stamped', async () => {
  restoreSupabase = installMockSupabase(tables());
  const retrieveRefund = stubStripe('refunds', 'retrieve', async (id) => ({ id, metadata: {} }));
  const updateRefund = stubStripe('refunds', 'update', async () => ({}));
  stubStripe('invoices', 'retrieve', async () => ({
    id: 'in_1', number: 'ABC-0007', subscription: null, billing_reason: 'manual', metadata: { addon_batch: '1', subscription_id: 'sub-db-1' },
    lines: { data: [{ description: 'Generator add-on: Exterior Wash', amount: 8500, metadata: { addon_id: 'a1' } }, { description: 'Generator add-on: ATS + Outage Test', amount: 11000, metadata: { addon_id: 'a2' } }] },
  }));
  stubStripe('subscriptions', 'retrieve', async () => STRIPE_SUB);

  const r = await arNotify.notifyArChargeRefunded(REFUNDED_CHARGE());
  assert.equal(r.sent, true);
  assert.equal(retrieveRefund[0][0], 're_1');
  const m = sentEmails[0];
  assert.equal(m.subject, '[Generator Care] Refund issued — John Fort — $85.00');
  const t = m.text;
  assert.match(t, /Type: Refund of Add-on charge/);
  assert.match(t, /Amount refunded \(partial\): \$85\.00/);
  assert.match(t, /Card: Mastercard \*\*\*\* 9999/);
  assert.match(t, /Original invoice #: ABC-0007/);
  assert.match(t, /Charge ID: ch_1/);
  assert.match(t, /Payment ID: pi_1/);
  assert.match(t, /Jonas WO#: WO-778/);
  assert.match(t, /refund returned to the customer.s card\. Do not invoice\./);
  assert.equal(updateRefund.length, 1);
  assert.equal(updateRefund[0][0], 're_1');
  assert.ok(updateRefund[0][1].metadata.ar_refund_notice_sent_at);
});

test('charge.refunded retry: stamped refund sends nothing', async () => {
  restoreSupabase = installMockSupabase(tables());
  stubStripe('refunds', 'retrieve', async (id) => ({ id, metadata: { ar_refund_notice_sent_at: 'x' } }));
  const updateRefund = stubStripe('refunds', 'update', async () => ({}));
  const r = await arNotify.notifyArChargeRefunded(REFUNDED_CHARGE());
  assert.equal(r.reason, 'already sent');
  assert.equal(sentEmails.length, 0);
  assert.equal(updateRefund.length, 0);
});

// ---- invoice.payment_failed -------------------------------------------------------
const FAILED_INVOICE = (attempt) => ({
  id: 'in_9', number: 'ABC-0009', customer: 'cus_1', subscription: 'sub_1', billing_reason: 'subscription_cycle',
  amount_due: 39500, attempt_count: attempt, metadata: {},
  last_finalization_error: null, charge: { failure_message: 'Your card was declined.' },
  lines: { data: [{ description: 'Air Cooled Generator Care — Annual', amount: 39500, metadata: {} }] },
});

test('invoice.payment_failed: clearly marked FAILED / not collected; once per attempt', async () => {
  restoreSupabase = installMockSupabase(tables());
  let stampedAttempt = null;
  stubStripe('invoices', 'retrieve', async (id) => ({ id, metadata: stampedAttempt ? { ar_failed_notice_attempt: stampedAttempt } : {} }));
  const update = stubStripe('invoices', 'update', async (id, { metadata }) => { stampedAttempt = metadata.ar_failed_notice_attempt; return {}; });
  stubStripe('subscriptions', 'retrieve', async () => STRIPE_SUB);

  const r1 = await arNotify.notifyArInvoicePaymentFailed(FAILED_INVOICE(1));
  assert.equal(r1.sent, true);
  const m = sentEmails[0];
  assert.equal(m.subject, '[Generator Care] Payment FAILED — John Fort — $395.00');
  assert.match(m.text, /FAILED — not collected\. Do not post this in Jonas\./);
  assert.match(m.text, /Amount attempted \(NOT collected\): \$395\.00/);
  assert.match(m.text, /Failure reason: Your card was declined\. \(attempt 1\)/);
  assert.match(m.text, /Type: Renewal/);
  assert.match(m.html, /FAILED &mdash; not collected/);
  assert.equal(update[0][1].metadata.ar_failed_notice_attempt, '1');

  // Same attempt redelivered -> deduped.
  const r2 = await arNotify.notifyArInvoicePaymentFailed(FAILED_INVOICE(1));
  assert.equal(r2.reason, 'already sent');
  assert.equal(sentEmails.length, 1);

  // Stripe's next retry is a NEW failure -> notified again.
  const r3 = await arNotify.notifyArInvoicePaymentFailed(FAILED_INVOICE(2));
  assert.equal(r3.sent, true);
  assert.equal(sentEmails.length, 2);
  assert.match(sentEmails[1].text, /\(attempt 2\)/);
});

// ---- payment_intent.succeeded (ad-hoc immediate) ------------------------------------
test('payment_intent.succeeded: invoice-backed PI is skipped (invoice.paid owns it); ad-hoc PI notifies', async () => {
  restoreSupabase = installMockSupabase(tables());
  const retrievePi = stubStripe('paymentIntents', 'retrieve', async (id) => ({ id, metadata: {} }));
  const updatePi = stubStripe('paymentIntents', 'update', async () => ({}));
  stubStripe('subscriptions', 'retrieve', async () => STRIPE_SUB);

  const skipped = await arNotify.notifyArPaymentIntentSucceeded({ id: 'pi_inv', customer: 'cus_1', invoice: 'in_1', amount_received: 100, metadata: { adhoc_charge_id: 'x' } });
  assert.equal(skipped.sent, false);
  assert.equal(retrievePi.length, 0);

  const r = await arNotify.notifyArPaymentIntentSucceeded({
    id: 'pi_adhoc', customer: 'cus_1', invoice: null, amount: 7500, amount_received: 7500, created: 1760000000,
    description: 'Bates Electric: Replace block heater cord', metadata: { adhoc_charge_id: 'c1', subscription_id: 'sub-db-1' },
    latest_charge: { id: 'ch_7', receipt_number: '7777-0001', payment_method_details: { card: { brand: 'amex', last4: '0005' } } },
  });
  assert.equal(r.sent, true);
  const t = sentEmails[0].text;
  assert.match(t, /Type: Other \(ad-hoc service charge\)/);
  assert.match(t, /Line items: Replace block heater cord \$75\.00/);
  assert.match(t, /Card: Amex \*\*\*\* 0005/);
  assert.match(t, /Charge ID: ch_7/);
  assert.match(t, /Payment ID: pi_adhoc/);
  assert.equal(updatePi[0][0], 'pi_adhoc');
});

// ---- Through the webhook handlers: an AR failure never breaks the webhook --------------
test('webhook handleInvoicePaid resolves even when the AR send throws (receipt path unaffected)', async () => {
  restoreSupabase = installMockSupabase(tables());
  stubHappyPath();
  mailerBehavior = 'throw';
  await assert.doesNotReject(() => webhook.handleInvoicePaid(PAID_INVOICE()));
  // Fire-and-forget: let the detached notice settle, then check it was reported.
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(sentEmails.length, 0);
  assert.equal(reportErrorCalls.length, 1);
  assert.match(reportErrorCalls[0].err.message, /AR payment notice error for invoice in_1: brevo exploded/);
});

test('webhook handleInvoicePaymentFailed resolves when the AR context lookup itself throws', async () => {
  restoreSupabase = installMockSupabase({
    generator_customers: () => { throw new Error('db down'); },
    generator_subscriptions: () => ({ data: null, error: null }),
    generator_pending_addons: () => ({ data: null, error: null }),
    generator_adhoc_charges: () => ({ data: null, error: null }),
  });
  stubStripe('invoices', 'retrieve', async (id) => ({ id, metadata: {} }));
  await assert.doesNotReject(() => webhook.handleInvoicePaymentFailed(FAILED_INVOICE(1)));
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(sentEmails.length, 0);
  assert.ok(reportErrorCalls.some((c) => /AR failed-payment notice error for invoice in_9: db down/.test(c.err.message)));
});

test('webhook handlePaymentIntentSucceeded ignores invoice-backed PIs without touching Stripe', async () => {
  const retrievePi = stubStripe('paymentIntents', 'retrieve', async () => { throw new Error('should not be called'); });
  await webhook.handlePaymentIntentSucceeded({ id: 'pi_1', invoice: 'in_1', customer: 'cus_1', metadata: { adhoc_charge_id: 'c1' } });
  await new Promise((r) => setImmediate(r));
  assert.equal(retrievePi.length, 0);
  assert.equal(sentEmails.length, 0);
});

// ---- Admin sample ------------------------------------------------------------------
test('buildSampleArNotice renders all four kinds; MO and FL differ only by entity/address', () => {
  for (const kind of arNotify.SAMPLE_KINDS) {
    const b = arNotify.buildSampleArNotice(kind);
    assert.ok(b && b.subject && b.html && b.text, kind);
    assert.match(b.subject, /^\[Generator Care\] /);
  }
  assert.match(arNotify.buildSampleArNotice('payment_mo').text, /Branding entity: Bates Electric\n/);
  assert.match(arNotify.buildSampleArNotice('payment_fl').text, /Branding entity: S\.E\. Bates Electric \(FL\)/);
  assert.match(arNotify.buildSampleArNotice('failed').text, /FAILED — not collected/);
  assert.equal(arNotify.buildSampleArNotice('nope'), null);
});
