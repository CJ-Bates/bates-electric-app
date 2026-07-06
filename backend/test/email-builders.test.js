// Customer-facing email builders: FL vs MO branding on EVERY builder, amount
// formatting (fmtMoney + rendered line items), and HTML escaping of
// user-supplied values. Builders are pure ({subject, html, text} from args) —
// no network, no Stripe, no Brevo.
require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');

const emails = require('../lib/emails');

const CUSTOMER = { name: 'Eric Gerhardt', email: 'eric@example.com' };

// One representative invocation per customer-facing builder. companyState is
// the branding input under test; every other arg is realistic fixture data.
const BUILDERS = [
  ['buildWelcomeEmail', (state) => emails.buildWelcomeEmail({
    customer: CUSTOMER,
    meta: { gen_class: 'air_cooled', gen_model: 'Generac 22kW', install_city: 'Imperial', install_state: state, install_zip: '63052' },
    planLabel: 'Annual', nextVisitDate: '2026-08-15', annualPriceCents: 39500,
    fleetMonitoring: true, paidAmountCents: 39500, paidDate: '2026-07-01', companyState: state,
  })],
  ['buildCardFailedEmail', (state) => emails.buildCardFailedEmail({
    customer: CUSTOMER, amountCents: 11000, description: 'ATS Inspection',
    portalUrl: 'https://billing.stripe.com/p/session/test', companyState: state,
  })],
  ['buildCardUpdateLinkEmail', (state) => emails.buildCardUpdateLinkEmail({
    name: CUSTOMER.name, portalUrl: 'https://billing.stripe.com/p/session/test', companyState: state,
  })],
  ['buildVisitScheduledEmail', (state) => emails.buildVisitScheduledEmail({
    customer: CUSTOMER, scheduledDate: '2026-08-15', planLabel: 'Annual', companyState: state,
  })],
  ['buildVisitCompletedEmail', (state) => emails.buildVisitCompletedEmail({
    customer: CUSTOMER, completedDate: '2026-07-01', nextVisitDate: '2027-07-01',
    planLabel: 'Annual', notes: 'Ran clean under load.', companyState: state,
  })],
  ['buildRenewalUpcomingEmail', (state) => emails.buildRenewalUpcomingEmail({
    customer: CUSTOMER, renewalDate: '2026-08-15', amountCents: 50500, planLabel: 'Annual',
    lineItems: [
      { amount_cents: 39500, description: 'Air Cooled Generator Care — Annual' },
      { amount_cents: 11000, description: 'Transfer Switch Inspection & Simulated Outage Test' },
    ],
    companyState: state,
  })],
  ['buildCancellationEmail', (state) => emails.buildCancellationEmail({
    customer: CUSTOMER, periodEndDate: '2026-12-11', companyState: state,
  })],
  ['buildReceiptEmail', (state) => emails.buildReceiptEmail({
    customer: CUSTOMER, companyState: state, amountCents: 19500, paidDate: '2026-07-01',
    cardBrand: 'visa', cardLast4: '5041', description: 'Generator add-ons',
    receiptNumber: 'INV-0042',
    lineItems: [
      { description: 'Exterior Wash & Interior Blow-Out', amountCents: 8500 },
      { description: 'ATS Inspection', amountCents: 11000 },
    ],
  })],
  ['buildRefundReceiptEmail', (state) => emails.buildRefundReceiptEmail({
    customer: CUSTOMER, companyState: state, amountCents: 8500, refundDate: '2026-07-03',
    cardBrand: 'visa', cardLast4: '5041', description: 'Exterior Wash',
    originalReceiptNumber: 'INV-0042', isPartial: true,
  })],
];

test('every customer-facing builder brands FL as S.E. Bates Electric', () => {
  for (const [name, build] of BUILDERS) {
    const fl = build('FL');
    assert.ok(fl.html.includes('S.E. Bates Electric'), `${name}: FL html carries the S.E. name`);
    assert.ok(fl.subject && fl.html && fl.text, `${name}: returns subject/html/text`);
  }
});

test('every customer-facing builder brands MO as plain Bates Electric', () => {
  for (const [name, build] of BUILDERS) {
    const mo = build('MO');
    assert.ok(!mo.html.includes('S.E. Bates Electric'), `${name}: MO html must NOT carry the S.E. name`);
    assert.ok(mo.html.includes('Bates Electric'), `${name}: MO html carries the standard name`);
    assert.ok(!mo.text.includes('S.E. Bates Electric'), `${name}: MO text must NOT carry the S.E. name`);
  }
});

test('welcome email: state precedence is companyState > customer.install_state', () => {
  const viaCustomer = emails.buildWelcomeEmail({
    customer: { ...CUSTOMER, install_state: 'FL' },
    meta: {}, planLabel: 'Annual', annualPriceCents: 39500,
  });
  assert.ok(viaCustomer.html.includes('S.E. Bates Electric'), 'falls back to customer.install_state');

  const overridden = emails.buildWelcomeEmail({
    customer: { ...CUSTOMER, install_state: 'FL' },
    meta: {}, planLabel: 'Annual', annualPriceCents: 39500, companyState: 'MO',
  });
  assert.ok(!overridden.html.includes('S.E. Bates Electric'), 'explicit companyState wins');
});

test('fmtMoney formats cents as US dollars', () => {
  const cases = [
    [0, '$0.00'],
    [null, '$0.00'],
    [undefined, '$0.00'],
    [99, '$0.99'],
    [8500, '$85.00'],
    [39500, '$395.00'],
    [199000, '$1,990.00'],
    [123456789, '$1,234,567.89'],
  ];
  for (const [cents, expected] of cases) {
    assert.equal(emails.fmtMoney(cents), expected, String(cents));
  }
});

test('receipt renders each line item amount and the total', () => {
  const [, build] = BUILDERS.find(([n]) => n === 'buildReceiptEmail');
  const r = build('MO');
  for (const expected of ['$85.00', '$110.00', '$195.00', 'INV-0042', '5041']) {
    assert.ok(r.html.includes(expected), `html includes ${expected}`);
    assert.ok(r.text.includes(expected), `text includes ${expected}`);
  }
});

test('renewal-upcoming renders line-item amounts and the total due', () => {
  const [, build] = BUILDERS.find(([n]) => n === 'buildRenewalUpcomingEmail');
  const r = build('MO');
  for (const expected of ['$395.00', '$110.00', '$505.00']) {
    assert.ok(r.html.includes(expected), `html includes ${expected}`);
  }
});

test('welcome email renders the promo-aware first charge, not the plan price', () => {
  const r = emails.buildWelcomeEmail({
    customer: CUSTOMER, meta: {}, planLabel: 'Annual',
    annualPriceCents: 39500, paidAmountCents: 99, paidDate: '2026-07-01', companyState: 'MO',
  });
  assert.ok(r.html.includes('$0.99'), 'actual charged amount appears');
  assert.ok(r.text.includes('$0.99'), 'text too');
});

test('refund receipt formats the refunded amount', () => {
  const [, build] = BUILDERS.find(([n]) => n === 'buildRefundReceiptEmail');
  const r = build('MO');
  assert.ok(r.html.includes('$85.00'));
  assert.ok(r.text.includes('$85.00'));
});

test('escHtml: user-supplied values are escaped in rendered HTML', () => {
  const hostile = { name: `<script>alert('x')</script>`, email: 'x@example.com' };
  const r = emails.buildVisitScheduledEmail({
    customer: hostile, scheduledDate: '2026-08-15', planLabel: 'Annual', companyState: 'MO',
  });
  assert.ok(!r.html.includes('<script>'), 'raw script tag must not survive');
  assert.ok(emails.escHtml('<b>&"\'').includes('&lt;b&gt;&amp;&quot;&#39;'));
});
