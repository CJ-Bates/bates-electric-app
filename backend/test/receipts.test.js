// Signup-race fallback: when invoice.paid beats customer.subscription.created,
// the receipt recipient is assembled from Stripe data (receiptRecipientFromStripe)
// instead of the not-yet-inserted DB row. These tests cover that pure assembly
// plus the branding it drives: FL signup metadata → S.E. Bates Electric,
// missing state → default Bates Electric (MO). Pure — no network, no Stripe.
require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');

const { receiptRecipientFromStripe } = require('../lib/receipts');
const { buildReceiptEmail } = require('../lib/emails');

// A realistic first-signup invoice snapshot: the invoice carries the checkout
// email/name, the subscription carries create-checkout's signup metadata.
const INVOICE = {
  id: 'in_test_123',
  customer: 'cus_test_123',
  customer_email: 'susan@example.com',
  customer_name: 'Susan High',
  amount_paid: 39500,
  created: 1751846400,
};
const SUBSCRIPTION = (state) => ({
  id: 'sub_test_123',
  metadata: {
    gen_class: 'air_cooled',
    customer_name: 'Susan High',
    install_state: state,
  },
});

test('recipient comes from invoice + subscription metadata (customer not in DB yet)', () => {
  const r = receiptRecipientFromStripe({ invoice: INVOICE, subscription: SUBSCRIPTION('MO') });
  assert.deepEqual(r, { name: 'Susan High', email: 'susan@example.com', install_state: 'MO' });
});

test('falls back to the Stripe customer object when the invoice has no email', () => {
  const bare = { ...INVOICE, customer_email: null, customer_name: null };
  const r = receiptRecipientFromStripe({
    invoice: bare,
    subscription: SUBSCRIPTION('FL'),
    stripeCustomer: { email: 'susan@example.com', name: 'Susan H.' },
  });
  assert.deepEqual(r, { name: 'Susan H.', email: 'susan@example.com', install_state: 'FL' });
});

test('no email anywhere -> null (caller alerts instead of sending blind)', () => {
  const bare = { ...INVOICE, customer_email: null, customer_name: null };
  assert.equal(receiptRecipientFromStripe({ invoice: bare, subscription: SUBSCRIPTION('MO') }), null);
});

test('missing install_state -> null state -> MO-branded receipt (never blocks the send)', () => {
  const sub = { id: 'sub_test_123', metadata: { gen_class: 'air_cooled' } };
  const r = receiptRecipientFromStripe({ invoice: INVOICE, subscription: sub });
  assert.equal(r.install_state, null);

  const { html, text } = buildReceiptEmail({
    customer: r,
    companyState: r.install_state,
    amountCents: INVOICE.amount_paid,
    paidDate: '2026-07-06',
    description: 'Air Cooled Generator Care — Annual',
    receiptNumber: 'ABC-0001',
    lineItems: [{ description: 'Air Cooled Generator Care — Annual', amountCents: 39500 }],
  });
  assert.match(html, /Bates Electric/);
  assert.doesNotMatch(html, /S\.E\. Bates Electric/);
  assert.doesNotMatch(text, /S\.E\. Bates Electric/);
});

test('FL signup metadata -> S.E. Bates Electric branding on the fallback receipt', () => {
  const r = receiptRecipientFromStripe({ invoice: INVOICE, subscription: SUBSCRIPTION('FL') });
  assert.equal(r.install_state, 'FL');

  const { html, text } = buildReceiptEmail({
    customer: r,
    companyState: r.install_state,
    amountCents: INVOICE.amount_paid,
    paidDate: '2026-07-06',
    description: 'Air Cooled Generator Care — Annual',
    receiptNumber: 'ABC-0001',
    lineItems: [{ description: 'Air Cooled Generator Care — Annual', amountCents: 39500 }],
  });
  assert.match(html, /S\.E\. Bates Electric/);
  assert.match(text, /S\.E\. Bates Electric/);
});
