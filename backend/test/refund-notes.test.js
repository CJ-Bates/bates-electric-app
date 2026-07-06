// Refund bookkeeping helpers in lib/gcShared.js: buildRefundNote writes the
// structured "REFUNDED ..." marker; parseRefundedFromNotes reads the total
// back (it's what caps a second partial refund server-side). The two must
// round-trip exactly or over-refunds become possible.
require('./helpers/env'); // gcShared constructs its Stripe client at require time

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildRefundNote, parseRefundedFromNotes } = require('../lib/gcShared');

const TODAY = new Date().toISOString().slice(0, 10);

test('buildRefundNote: full refund format', () => {
  const note = buildRefundNote(11000, 11000, null, 're_456');
  assert.equal(note, `REFUNDED $110.00 on ${TODAY} (stripe_refund_id: re_456)`);
});

test('buildRefundNote: partial refund carries "X of Y" and the reason', () => {
  const note = buildRefundNote(8500, 11000, 'duplicate charge', 're_123');
  assert.equal(note, `REFUNDED $85.00 of $110.00 on ${TODAY}: duplicate charge (stripe_refund_id: re_123)`);
});

test('parseRefundedFromNotes: sums refund lines, ignores everything else', () => {
  const notes = [
    'Charge failed on 2026-06-01: card declined', // unrelated line
    buildRefundNote(2500, 11000, 'first partial', 're_1'),
    'Customer called about scheduling',            // unrelated line
    buildRefundNote(3000, 11000, null, 're_2'),
  ].join('\n');
  assert.equal(parseRefundedFromNotes(notes), 5500);
});

test('parseRefundedFromNotes: partial format parses the refunded amount, not the original', () => {
  const notes = buildRefundNote(8500, 11000, 'x', 're_1');
  assert.equal(parseRefundedFromNotes(notes), 8500, 'must read $85.00, not the $110.00 original');
});

test('parseRefundedFromNotes: empty and non-refund notes parse to zero', () => {
  assert.equal(parseRefundedFromNotes(null), 0);
  assert.equal(parseRefundedFromNotes(''), 0);
  assert.equal(parseRefundedFromNotes('Removed by office on 2026-06-01'), 0);
});

test('round-trip: N partial refunds accumulate to the exact remaining-balance cap', () => {
  const original = 26500; // battery replacement, liquid_48_150
  const partials = [10000, 9999, 1];
  let notes = 'Battery replaced under warranty adjustment';
  for (const cents of partials) {
    notes += '\n' + buildRefundNote(cents, original, 'adj', 're_x');
  }
  const total = parseRefundedFromNotes(notes);
  assert.equal(total, 20000);
  assert.equal(original - total, 6500, 'remaining refundable balance the endpoints enforce');
});
