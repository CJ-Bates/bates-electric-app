// lib/addonMenu.js — the shared add-on menu builder (add-ons menu Phase 1).
// Every surface (office detail, tech visit panel, Phase 2 customer portal)
// renders from this one builder, so these tests pin the derivation rules:
// applicability by gen class, the five statuses, standing-vs-row precedence,
// and the current-cycle partition (prior-cycle charged rows are history).
require('./helpers/env');

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildAddonMenu, openVisitIdFrom } = require('../lib/addonMenu');
const catalog = require('../lib/generator-catalog');

const OPEN_VISIT = 'visit-open';
const OLD_VISIT = 'visit-old';

const byType = (menu) => Object.fromEntries(menu.map((m) => [m.addon_type, m]));

test('no add-ons at all (the John Fort case): every applicable add-on shows not_in_plan WITH its price', () => {
  const menu = buildAddonMenu({ genClass: 'liquid_48_150', standingAddons: [], pendingAddons: [], openVisitId: OPEN_VISIT });
  // liquid_48_150 gets the full catalog (all 5).
  assert.equal(menu.length, 5);
  for (const m of menu) {
    assert.equal(m.status, 'not_in_plan');
    assert.equal(m.amount_cents, catalog.lookupAddonPrice(m.addon_type, 'liquid_48_150').amount_cents);
    assert.ok(m.label);
    assert.equal(m.addon_id, null);
  }
});

test('air-cooled unit omits coolant add-ons entirely (not shown as unavailable — just absent)', () => {
  const menu = buildAddonMenu({ genClass: 'air_cooled', standingAddons: [], pendingAddons: [], openVisitId: null });
  const types = menu.map((m) => m.addon_type);
  assert.ok(!types.includes('coolant_flush'));
  assert.ok(!types.includes('coolant_topoff'));
  assert.deepEqual(types.sort(), ['ats_outage_combined', 'battery_replacement', 'exterior_wash'].sort());
});

test('standing add-on with no materialized row reads every_visit', () => {
  const menu = byType(buildAddonMenu({
    genClass: 'air_cooled', standingAddons: ['exterior_wash'], pendingAddons: [], openVisitId: OPEN_VISIT,
  }));
  assert.equal(menu.exterior_wash.status, 'every_visit');
  assert.equal(menu.exterior_wash.recurring, true);
});

test('standing add-on with a pending row STILL reads every_visit; a one-off pending row reads this_visit', () => {
  const rows = [
    { id: 'a1', addon_type: 'exterior_wash', status: 'pending', amount_cents: 8500, service_visit_id: OPEN_VISIT },
    { id: 'a2', addon_type: 'battery_replacement', status: 'pending', amount_cents: 16500, service_visit_id: OPEN_VISIT },
  ];
  const menu = byType(buildAddonMenu({
    genClass: 'air_cooled', standingAddons: ['exterior_wash'], pendingAddons: rows, openVisitId: OPEN_VISIT,
  }));
  assert.equal(menu.exterior_wash.status, 'every_visit');
  assert.equal(menu.exterior_wash.addon_id, 'a1');
  assert.equal(menu.battery_replacement.status, 'this_visit');
  assert.equal(menu.battery_replacement.addon_id, 'a2');
});

test('performed and charged rows override the standing flag (more specific wins)', () => {
  const rows = [
    { id: 'a1', addon_type: 'exterior_wash', status: 'performed', amount_cents: 8500, service_visit_id: OPEN_VISIT, date_performed: '2026-07-20', performed_by: 'Chris Tech' },
    { id: 'a2', addon_type: 'ats_outage_combined', status: 'charged', amount_cents: 11000, service_visit_id: OPEN_VISIT },
  ];
  const menu = byType(buildAddonMenu({
    genClass: 'air_cooled', standingAddons: ['exterior_wash', 'ats_outage_combined'], pendingAddons: rows, openVisitId: OPEN_VISIT,
  }));
  assert.equal(menu.exterior_wash.status, 'performed');
  assert.equal(menu.exterior_wash.date_performed, '2026-07-20');
  assert.equal(menu.exterior_wash.performed_by, 'Chris Tech');
  assert.equal(menu.ats_outage_combined.status, 'charged');
});

test('charged on a PRIOR visit is history, not menu state; canceled and failed rows never drive status', () => {
  const rows = [
    { id: 'a1', addon_type: 'battery_replacement', status: 'charged', amount_cents: 16500, service_visit_id: OLD_VISIT },
    { id: 'a2', addon_type: 'exterior_wash', status: 'canceled', amount_cents: 8500, service_visit_id: OPEN_VISIT },
    { id: 'a3', addon_type: 'ats_outage_combined', status: 'failed', amount_cents: 11000, service_visit_id: OPEN_VISIT },
  ];
  const menu = byType(buildAddonMenu({
    genClass: 'air_cooled', standingAddons: [], pendingAddons: rows, openVisitId: OPEN_VISIT,
  }));
  assert.equal(menu.battery_replacement.status, 'not_in_plan');
  assert.equal(menu.exterior_wash.status, 'not_in_plan');
  assert.equal(menu.ats_outage_combined.status, 'not_in_plan');
});

test('with NO open visit, any charged row is prior-cycle history', () => {
  const rows = [{ id: 'a1', addon_type: 'battery_replacement', status: 'charged', amount_cents: 16500, service_visit_id: OLD_VISIT }];
  const menu = byType(buildAddonMenu({ genClass: 'air_cooled', standingAddons: [], pendingAddons: rows, openVisitId: null }));
  assert.equal(menu.battery_replacement.status, 'not_in_plan');
});

test('most-advanced row of a type wins (performed beats a stray pending duplicate)', () => {
  const rows = [
    { id: 'a1', addon_type: 'battery_replacement', status: 'pending', amount_cents: 16500, service_visit_id: OPEN_VISIT },
    { id: 'a2', addon_type: 'battery_replacement', status: 'performed', amount_cents: 16500, service_visit_id: OPEN_VISIT },
  ];
  const menu = byType(buildAddonMenu({ genClass: 'air_cooled', standingAddons: [], pendingAddons: rows, openVisitId: OPEN_VISIT }));
  assert.equal(menu.battery_replacement.status, 'performed');
  assert.equal(menu.battery_replacement.addon_id, 'a2');
});

test('row amount_cents (the price locked at add time) wins over the current catalog price', () => {
  const rows = [{ id: 'a1', addon_type: 'battery_replacement', status: 'pending', amount_cents: 9999, service_visit_id: OPEN_VISIT }];
  const menu = byType(buildAddonMenu({ genClass: 'air_cooled', standingAddons: [], pendingAddons: rows, openVisitId: OPEN_VISIT }));
  assert.equal(menu.battery_replacement.amount_cents, 9999);
});

test('openVisitIdFrom mirrors the DB open-visit pick: earliest open by scheduled_date, nulls last', () => {
  assert.equal(openVisitIdFrom([
    { id: 'done', status: 'completed', completed_date: '2026-01-05', scheduled_date: '2026-01-01' },
    { id: 'canceled', status: 'canceled', completed_date: null, scheduled_date: '2026-01-02' },
    { id: 'later', status: 'tentative', completed_date: null, scheduled_date: '2026-08-01' },
    { id: 'sooner', status: 'scheduled', completed_date: null, scheduled_date: '2026-07-25' },
    { id: 'undated', status: 'tentative', completed_date: null, scheduled_date: null },
  ]), 'sooner');
  assert.equal(openVisitIdFrom([]), null);
  assert.equal(openVisitIdFrom([{ id: 'undated', status: 'tentative', completed_date: null, scheduled_date: null }]), 'undated');
});
