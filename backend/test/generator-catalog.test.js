// Catalog math: plan/fleet price lookups, yearly totals, add-on pricing, and
// the tier-change deltas the routes compute from planEntry() amounts.
// (The tier-change endpoint's charge/credit decision itself lives in
// backend/routes/generator-care/subscriptions.js — noted in the lane report;
// these tests pin the catalog arithmetic it is built on.)
require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');

const catalog = require('../lib/generator-catalog');

test('planEntry returns the catalog entry or null', () => {
  assert.equal(catalog.planEntry('air_cooled', 'annual').amount_cents, 39500);
  assert.equal(catalog.planEntry('air_cooled', 'semi_annual').amount_cents, 38000);
  assert.equal(catalog.planEntry('liquid_22_38', 'annual').amount_cents, 56500);
  assert.equal(catalog.planEntry('liquid_48_150', 'semi_annual').amount_cents, 65000);
  assert.equal(catalog.planEntry('nuclear', 'annual'), null);
  assert.equal(catalog.planEntry('air_cooled', 'weekly'), null);
});

test('planForPriceId round-trips every catalog entry', () => {
  for (const genClass of Object.keys(catalog.SUBSCRIPTION_CATALOG)) {
    for (const plan of catalog.PLANS) {
      const entry = catalog.SUBSCRIPTION_CATALOG[genClass][plan];
      const resolved = catalog.planForPriceId(entry.price_id);
      assert.deepEqual(
        resolved,
        { gen_class: genClass, plan, amount_cents: entry.amount_cents },
        `${genClass}/${plan}`
      );
      assert.ok(catalog.isPlanPriceId(entry.price_id));
    }
  }
  assert.equal(catalog.planForPriceId('price_nonexistent'), null);
  assert.equal(catalog.isPlanPriceId('price_nonexistent'), false);
  assert.equal(catalog.isPlanPriceId(null), false);
});

test('fleetForPriceId round-trips the fleet catalog and rejects plan ids', () => {
  for (const plan of catalog.PLANS) {
    const entry = catalog.FLEET_CATALOG[plan];
    assert.deepEqual(catalog.fleetForPriceId(entry.price_id), { plan, amount_cents: entry.amount_cents });
    assert.ok(catalog.isFleetPriceId(entry.price_id));
  }
  // A plan price id is not a fleet id and vice versa.
  const planId = catalog.SUBSCRIPTION_CATALOG.air_cooled.annual.price_id;
  assert.equal(catalog.isFleetPriceId(planId), false);
  assert.equal(catalog.isPlanPriceId(catalog.FLEET_CATALOG.annual.price_id), false);
});

test('annualPriceCents: yearly totals (semi bills twice; fleet adds $65/yr)', () => {
  const cases = [
    // [genClass, plan, hasFleet, expectedCents]
    ['air_cooled', 'annual', false, 39500],
    ['air_cooled', 'annual', true, 46000],
    ['air_cooled', 'semi_annual', false, 76000],   // 38000 * 2
    ['air_cooled', 'semi_annual', true, 82500],    // 76000 + 6500 (fleet yearly)
    ['liquid_22_38', 'annual', false, 56500],
    ['liquid_22_38', 'semi_annual', false, 108000], // 54000 * 2
    ['liquid_48_150', 'annual', true, 74000],       // 67500 + 6500
    ['liquid_48_150', 'semi_annual', true, 136500], // 130000 + 6500
    ['unknown_class', 'annual', false, null],
    ['air_cooled', 'unknown_plan', true, null],
  ];
  for (const [genClass, plan, hasFleet, expected] of cases) {
    assert.equal(catalog.annualPriceCents(genClass, plan, hasFleet), expected, `${genClass}/${plan}/fleet=${hasFleet}`);
  }
});

test('tier-change flat difference: catalog deltas at a fixed cadence', () => {
  // The tier-change endpoint charges (positive) or credits (negative) exactly
  // newEntry.amount_cents - oldEntry.amount_cents at the CURRENT cadence.
  const delta = (from, to, plan) =>
    catalog.planEntry(to, plan).amount_cents - catalog.planEntry(from, plan).amount_cents;

  const cases = [
    // [from, to, plan, expectedDelta, meaning]
    ['air_cooled', 'liquid_22_38', 'annual', 17000, 'upgrade -> charge $170.00'],
    ['air_cooled', 'liquid_48_150', 'annual', 28000, 'upgrade -> charge $280.00'],
    ['liquid_22_38', 'liquid_48_150', 'annual', 11000, 'upgrade -> charge $110.00'],
    ['liquid_48_150', 'air_cooled', 'annual', -28000, 'downgrade -> credit $280.00'],
    ['liquid_22_38', 'air_cooled', 'annual', -17000, 'downgrade -> credit $170.00'],
    ['air_cooled', 'liquid_48_150', 'semi_annual', 27000, 'semi upgrade -> charge $270.00'],
    ['liquid_48_150', 'liquid_22_38', 'semi_annual', -11000, 'semi downgrade -> credit $110.00'],
  ];
  for (const [from, to, plan, expected, meaning] of cases) {
    assert.equal(delta(from, to, plan), expected, `${from} -> ${to} @ ${plan}: ${meaning}`);
  }
  // Same tier at same cadence is always a zero delta (routes reject it earlier).
  for (const genClass of Object.keys(catalog.SUBSCRIPTION_CATALOG)) {
    for (const plan of catalog.PLANS) {
      assert.equal(delta(genClass, genClass, plan), 0);
    }
  }
});

test('lookupAddonPrice: class-specific, "all", and unavailable add-ons', () => {
  // "all" price applies to every class.
  for (const genClass of ['air_cooled', 'liquid_22_38', 'liquid_48_150']) {
    assert.equal(catalog.lookupAddonPrice('exterior_wash', genClass).amount_cents, 8500, genClass);
    assert.equal(catalog.lookupAddonPrice('ats_outage_combined', genClass).amount_cents, 11000, genClass);
  }
  // Class-priced add-on varies by class.
  assert.equal(catalog.lookupAddonPrice('battery_replacement', 'air_cooled').amount_cents, 16500);
  assert.equal(catalog.lookupAddonPrice('battery_replacement', 'liquid_48_150').amount_cents, 26500);
  // Coolant services don't exist for air-cooled units.
  assert.equal(catalog.lookupAddonPrice('coolant_flush', 'air_cooled'), null);
  assert.equal(catalog.lookupAddonPrice('coolant_topoff', 'air_cooled'), null);
  assert.equal(catalog.lookupAddonPrice('coolant_topoff', 'liquid_22_38').amount_cents, 9500);
  // Unknown addon type.
  assert.equal(catalog.lookupAddonPrice('gold_plating', 'air_cooled'), null);
});

test('recurring add-on flags drive the standing set', () => {
  assert.equal(catalog.isRecurringAddon('exterior_wash'), true);
  assert.equal(catalog.isRecurringAddon('coolant_topoff'), true);
  assert.equal(catalog.isRecurringAddon('ats_outage_combined'), true);
  assert.equal(catalog.isRecurringAddon('battery_replacement'), false);
  assert.equal(catalog.isRecurringAddon('coolant_flush'), false);
  assert.equal(catalog.isRecurringAddon('nonexistent'), false);
  assert.deepEqual(
    catalog.recurringAddonTypes().sort(),
    ['ats_outage_combined', 'coolant_topoff', 'exterior_wash']
  );
});

test('every add-on has a human label (what receipts/batch charges render)', () => {
  for (const [type, entry] of Object.entries(catalog.ADDON_CATALOG)) {
    assert.ok(entry.label && typeof entry.label === 'string' && entry.label.length > 3, type);
  }
});
