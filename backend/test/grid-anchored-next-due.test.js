// gridAnchoredNextDue: the drift-free next-visit-due math. The invariant under
// test: result is the EARLIEST point on the signup-anchored cadence grid
// (anchor + k*intervalMonths) strictly AFTER both the prior due date and the
// date performed. Late completions must not push the grid; early completions
// must not pull the next due closer.
require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');

const { gridAnchoredNextDue, planLabelFor } = require('../lib/completeVisit');

test('gridAnchoredNextDue: table-driven grid anchoring', () => {
  const cases = [
    // [anchor, priorDue, performed, intervalMonths, expected, label]

    // On-time completions roll exactly one grid step.
    ['2025-06-25', '2026-06-25', '2026-06-25', 12, '2027-06-25', 'annual, performed on the due date'],
    ['2026-01-15', '2026-07-15', '2026-07-15', 6, '2027-01-15', 'semi-annual, performed on the due date'],

    // LATE completion: next due stays on the grid (no drift from the late date).
    ['2025-06-25', '2026-06-25', '2026-08-10', 12, '2027-06-25', 'annual, 6 weeks late'],
    ['2026-01-15', '2026-07-15', '2026-09-01', 6, '2027-01-15', 'semi-annual, ~7 weeks late'],

    // VERY late completion: skips as many grid points as needed — strictly after
    // the performed date.
    ['2025-06-25', '2026-06-25', '2027-07-01', 12, '2028-06-25', 'annual, performed after the next grid point'],
    ['2026-01-15', '2026-07-15', '2027-01-15', 6, '2027-07-15', 'semi-annual, performed exactly ON a later grid point (strictly after)'],

    // EARLY completion: still advances past the prior due (no pulling forward).
    ['2025-06-25', '2026-06-25', '2026-06-10', 12, '2027-06-25', 'annual, 2 weeks early'],
    ['2026-01-15', '2026-07-15', '2026-05-01', 6, '2027-01-15', 'semi-annual, 10 weeks early'],

    // First visit: prior due = first grid point after signup.
    ['2026-06-25', '2026-06-25', '2026-06-27', 12, '2027-06-25', 'anchor equals prior due'],

    // No prior due / performed at all: the anchor itself is the earliest point.
    ['2026-06-25', null, null, 12, '2026-06-25', 'no prior due, no performed date'],

    // Leap-year anchor: Feb 29 has no Feb 29 next year — JS date math lands on
    // Mar 1 and the grid keeps that day from then on (documented behavior).
    ['2024-02-29', '2024-02-29', '2024-03-05', 12, '2025-03-01', 'leap-day anchor rolls to Mar 1'],
    ['2024-02-29', '2025-03-01', '2025-03-01', 12, '2026-03-01', 'leap-day grid stays Mar 1 in later years'],

    // Month-end anchor crossing a short month at semi-annual cadence: Aug 31 + 6
    // months = "Feb 31" -> normalizes into early March (Mar 2 in a leap year).
    ['2023-08-31', '2023-08-31', '2023-09-01', 6, '2024-03-02', 'Aug 31 anchor + 6mo normalizes across short Feb (leap year)'],
  ];

  for (const [anchor, priorDue, performed, interval, expected, label] of cases) {
    assert.equal(
      gridAnchoredNextDue(anchor, priorDue, performed, interval),
      expected,
      label
    );
  }
});

test('gridAnchoredNextDue: null/invalid anchors return null', () => {
  assert.equal(gridAnchoredNextDue(null, '2026-06-25', '2026-06-25', 12), null);
  assert.equal(gridAnchoredNextDue('', '2026-06-25', '2026-06-25', 12), null);
  assert.equal(gridAnchoredNextDue('not-a-date', '2026-06-25', '2026-06-25', 12), null);
});

test('gridAnchoredNextDue: result is always strictly after both inputs', () => {
  // Property-style sweep across offsets: whatever the performed date, the
  // result must be a grid point strictly after prior-due AND performed.
  const anchor = '2025-01-10';
  const priorDue = '2026-01-10';
  const performedDates = ['2025-12-01', '2026-01-09', '2026-01-10', '2026-01-11', '2026-06-30', '2027-01-10', '2028-05-05'];
  for (const performed of performedDates) {
    const result = gridAnchoredNextDue(anchor, priorDue, performed, 12);
    assert.ok(result > priorDue, `(${performed}) result ${result} > prior due`);
    assert.ok(result > performed, `(${performed}) result ${result} > performed`);
    // Grid membership: month/day match the anchor's (Jan 10) in a later year.
    assert.match(result, /^\d{4}-01-10$/, `(${performed}) result ${result} stays on the Jan-10 grid`);
  }
});

test('planLabelFor maps plans to display labels', () => {
  assert.equal(planLabelFor('semi_annual'), 'Semi-Annual');
  assert.equal(planLabelFor('annual'), 'Annual');
  assert.equal(planLabelFor('weird_plan'), 'weird_plan'); // passthrough
});
