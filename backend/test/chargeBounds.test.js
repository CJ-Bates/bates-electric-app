// SEC-P1 §2: server-side backstops on a single charge amount + description,
// shared by both charge entry points (office adhoc + tech custom) and the
// per-visit cart total. These pure helpers are the source of truth for the cap.
require('./helpers/env'); // gcCharges -> gcShared constructs its Stripe client at require time

const test = require('node:test');
const assert = require('node:assert/strict');

const { MAX_CHARGE_CENTS, chargeAmountError, sanitizeChargeDescription } = require('../lib/gcCharges');

test('MAX_CHARGE_CENTS defaults to $10,000', () => {
  // (No env override in the test env — helpers/env doesn't set MAX_CHARGE_CENTS.)
  assert.equal(MAX_CHARGE_CENTS, 1000000);
});

test('chargeAmountError: a normal field/office charge passes', () => {
  assert.equal(chargeAmountError(12500), null);   // $125.00
  assert.equal(chargeAmountError(1), null);       // $0.01
  assert.equal(chargeAmountError(MAX_CHARGE_CENTS), null); // exactly at the cap is allowed
});

test('chargeAmountError: non-positive / non-integer is rejected', () => {
  assert.match(chargeAmountError(0), /positive integer/);
  assert.match(chargeAmountError(-500), /positive integer/);
  assert.match(chargeAmountError(12.5), /positive integer/);
  assert.match(chargeAmountError('100'), /positive integer/);
});

test('chargeAmountError: anything above the cap is rejected with a clear message', () => {
  const err = chargeAmountError(MAX_CHARGE_CENTS + 1);
  assert.ok(err, 'over-cap must return an error string');
  assert.match(err, /maximum/);
  assert.match(err, /\$10,000/);
});

test('sanitizeChargeDescription: trims and hard-caps at 200 chars', () => {
  assert.equal(sanitizeChargeDescription('  hello  '), 'hello');
  const long = 'x'.repeat(500);
  assert.equal(sanitizeChargeDescription(long).length, 200);
});

test('sanitizeChargeDescription: null/undefined become empty string, never throw', () => {
  assert.equal(sanitizeChargeDescription(null), '');
  assert.equal(sanitizeChargeDescription(undefined), '');
});
