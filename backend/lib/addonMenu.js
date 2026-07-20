// backend/lib/addonMenu.js
// The ONE builder for the "add-on menu" every surface renders (office customer
// detail, tech visit panel, and — Phase 2 — the customer portal): for each
// catalog add-on that applies to the customer's generator class, its price and
// a single derived status. All surfaces call this so they always agree.
//
// Statuses:
//   not_in_plan — applicable but not selected in any form
//   every_visit — a STANDING recurring add-on (in generator_subscriptions.
//                 standing_addons), whether or not its pending row for the
//                 current cycle has materialized yet
//   this_visit  — a one-off row added for the current cycle (status 'pending')
//   performed   — the current cycle's row is performed (unbilled)
//   charged     — the current cycle's row is charged
//
// A performed/charged row always wins over the standing flag (more specific);
// a plain pending row on a standing type still reads every_visit (it IS the
// standing add-on, auto-materialized). Charged rows from PRIOR cycles are
// history, not menu state.

const catalog = require('./generator-catalog');

// How "advanced" a row is; the most advanced current-cycle row of a type is
// the one the menu reflects (e.g. a performed row beats a leftover pending).
const ROW_RANK = { pending: 1, performed: 2, charged: 3 };

// The current open visit from an already-loaded visits array: earliest
// not-completed, not-canceled visit, by scheduled_date with nulls last.
// MIRRORS the getOpenVisitId query in lib/gcCharges.js — keep in sync.
function openVisitIdFrom(visits) {
  const open = (visits || [])
    .filter((v) => !v.completed_date && v.status !== 'canceled')
    .sort((a, b) => String(a.scheduled_date || '9999-99-99').localeCompare(String(b.scheduled_date || '9999-99-99')))[0];
  return open ? open.id : null;
}

// Build the menu. pendingAddons = ALL generator_pending_addons rows for the
// subscription (any status); openVisitId scopes which charged rows are the
// current cycle's. Rows count toward the menu unless canceled or charged on a
// DIFFERENT (prior) visit — the same "current cycle" partition the office
// dashboard has always drawn.
function buildAddonMenu({ genClass, standingAddons, pendingAddons, openVisitId }) {
  const standing = new Set(standingAddons || []);
  const current = (pendingAddons || []).filter((a) =>
    a.status !== 'canceled'
    && a.status !== 'failed'
    && !(a.status === 'charged' && (!openVisitId || a.service_visit_id !== openVisitId)));

  const rowByType = new Map();
  for (const a of current) {
    const prev = rowByType.get(a.addon_type);
    if (!prev || (ROW_RANK[a.status] || 0) > (ROW_RANK[prev.status] || 0)) rowByType.set(a.addon_type, a);
  }

  const menu = [];
  for (const [addonType, entry] of Object.entries(catalog.ADDON_CATALOG)) {
    const price = catalog.lookupAddonPrice(addonType, genClass);
    if (!price) continue; // N/A for this generator class — not on the menu at all

    const row = rowByType.get(addonType) || null;
    let status = 'not_in_plan';
    if (row && row.status === 'charged') status = 'charged';
    else if (row && row.status === 'performed') status = 'performed';
    else if (row) status = standing.has(addonType) ? 'every_visit' : 'this_visit';
    else if (standing.has(addonType)) status = 'every_visit';

    menu.push({
      addon_type: addonType,
      label: entry.label,
      recurring: !!entry.recurring,
      amount_cents: row && row.amount_cents ? row.amount_cents : price.amount_cents,
      status,
      addon_id: row ? row.id : null,
      date_performed: (row && row.date_performed) || null,
      performed_by: (row && row.performed_by) || null,
    });
  }
  return menu;
}

module.exports = { buildAddonMenu, openVisitIdFrom };
