// backend/lib/generator-catalog.js
// Single source of truth for Generator Care SUBSCRIPTION plan prices, mirroring
// the live Stripe prices the signup site uses (bates-generator
// netlify/functions/create-checkout.js -> CATALOG.subscriptions). Used to change
// a customer's plan cadence at renewal and to map a Stripe price id back to our
// plan/gen_class. amount_cents is the per-installment (per-renewal) charge.

// gen_class -> cadence -> { price_id, amount_cents }
const SUBSCRIPTION_CATALOG = {
  air_cooled: {
    semi_annual: { price_id: 'price_1Tg78LBbX7QhpMgb20ADNc75', amount_cents: 38000 },
    annual:      { price_id: 'price_1Tg78KBbX7QhpMgb3Rnm9BUP', amount_cents: 39500 },
  },
  liquid_22_38: {
    semi_annual: { price_id: 'price_1Tg78JBbX7QhpMgbkYZQXgMD', amount_cents: 54000 },
    annual:      { price_id: 'price_1Tg78IBbX7QhpMgbvOug1So6', amount_cents: 56500 },
  },
  liquid_48_150: {
    semi_annual: { price_id: 'price_1Tg78IBbX7QhpMgbbBG0A1MM', amount_cents: 65000 },
    annual:      { price_id: 'price_1Tg78HBbX7QhpMgbmXanyqtY', amount_cents: 67500 },
  },
};

// Fleet Monitoring recurring add-on: cadence -> { price_id, amount_cents }.
// Stripe can't mix billing intervals in one subscription, so a plan-cadence
// change MUST swap the fleet price to the matching cadence as well.
const FLEET_CATALOG = {
  semi_annual: { price_id: 'price_1Tg78GBbX7QhpMgbuFaxy6yC', amount_cents: 3250 },
  annual:      { price_id: 'price_1Tg78GBbX7QhpMgbj2RyDTuN', amount_cents: 6500 },
};

const PLANS = ['semi_annual', 'annual'];

function planEntry(genClass, plan) {
  return (SUBSCRIPTION_CATALOG[genClass] && SUBSCRIPTION_CATALOG[genClass][plan]) || null;
}

// Stripe plan price id -> { gen_class, plan, amount_cents } | null
function planForPriceId(priceId) {
  for (const genClass of Object.keys(SUBSCRIPTION_CATALOG)) {
    for (const plan of PLANS) {
      const e = SUBSCRIPTION_CATALOG[genClass][plan];
      if (e && e.price_id === priceId) return { gen_class: genClass, plan, amount_cents: e.amount_cents };
    }
  }
  return null;
}

function isPlanPriceId(priceId) {
  return !!planForPriceId(priceId);
}

// Stripe fleet price id -> { plan, amount_cents } | null
function fleetForPriceId(priceId) {
  for (const plan of PLANS) {
    if (FLEET_CATALOG[plan].price_id === priceId) return { plan, amount_cents: FLEET_CATALOG[plan].amount_cents };
  }
  return null;
}

function isFleetPriceId(priceId) {
  return !!fleetForPriceId(priceId);
}

// Yearly total stored in generator_subscriptions.annual_price_cents for a given
// plan + whether fleet is attached. Mirrors the signup webhook's math (semi
// installment * 2, annual installment * 1; fleet is $65/yr either cadence).
function annualPriceCents(genClass, plan, hasFleet) {
  const e = planEntry(genClass, plan);
  if (!e) return null;
  const planYearly = plan === 'semi_annual' ? e.amount_cents * 2 : e.amount_cents;
  const fleetYearly = hasFleet ? FLEET_CATALOG.annual.amount_cents : 0;
  return planYearly + fleetYearly;
}

// One-time / per-visit add-ons by gen class. Mirrors the catalog in
// bates-generator/netlify/functions/create-checkout.js. Live-mode price IDs as of
// the 2026-06-08 Stripe cutover.
//   recurring: true  -> a STANDING add-on that auto-returns as Pending each visit
//                       cycle (every-visit maintenance).
//   recurring: false -> as-needed; added per-visit via "+ Add Add-on" only.
// Fleet Monitoring is the recurring SUBSCRIPTION item (FLEET_CATALOG), separate.
const ADDON_CATALOG = {
  battery_replacement: {
    label: 'Battery Replacement',
    recurring: false,
    prices: {
      air_cooled:    { price_id: 'price_1Tg78FBbX7QhpMgbGVRxRJNo', amount_cents: 16500 },
      liquid_22_38:  { price_id: 'price_1Tg78EBbX7QhpMgbFvIrYuD1', amount_cents: 23500 },
      liquid_48_150: { price_id: 'price_1Tg78EBbX7QhpMgbOhRdCUUe', amount_cents: 26500 },
    },
  },
  exterior_wash: {
    label: 'Exterior Wash & Interior Blow-Out',
    recurring: true,
    prices: { all: { price_id: 'price_1Tg78FBbX7QhpMgbzrM2AE2n', amount_cents: 8500 } },
  },
  coolant_flush: {
    label: 'Coolant System Flush',
    recurring: false,
    prices: {
      liquid_22_38:  { price_id: 'price_1Tg78DBbX7QhpMgbhESS9Wyp', amount_cents: 59500 },
      liquid_48_150: { price_id: 'price_1Tg78DBbX7QhpMgb7VtP2hGx', amount_cents: 69500 },
    },
  },
  coolant_topoff: {
    label: 'Coolant Top-Off Service',
    recurring: true,
    prices: {
      // Same Stripe price reused for both liquid tiers; service cost doesn't vary by
      // size. No air_cooled entry: air-cooled units don't get coolant service.
      liquid_22_38:  { price_id: 'price_1Tg78CBbX7QhpMgbXptyAaje', amount_cents: 9500 },
      liquid_48_150: { price_id: 'price_1Tg78CBbX7QhpMgbXptyAaje', amount_cents: 9500 },
    },
  },
  ats_outage_combined: {
    label: 'Transfer Switch Inspection & Simulated Outage Test',
    recurring: true,
    prices: { all: { price_id: 'price_1Tg78DBbX7QhpMgby14G5PiY', amount_cents: 11000 } },
  },
};

// Standard services performed on EVERY plan visit, by gen class — the
// "Included in your plan" checklist the customer dashboard itemizes on each
// completed visit. Wording mirrors the official included-services list the
// customer agreed to at signup (bates-generator index.html GENERATORS[..]
// .included); both liquid-cooled tiers share one checklist.
const PLAN_VISIT_ITEMS = {
  air_cooled: [
    'Inspect enclosure louvers for dirt and debris',
    'Check fuel and oil lines for leaks',
    'Check engine oil level',
    'Inspect for water intrusion',
    'Perform fuel system leak test',
    'Check battery voltage and amperage',
    'Replace engine oil and filter',
    'Replace engine air filter',
    'Replace spark plugs',
  ],
  liquid_22_38: [
    'Inspect enclosure slots and openings',
    'Inspect fuel hoses',
    'Inspect coolant level and hoses',
    'Inspect radiator for clogging',
    'Inspect lubricating oil level and drain hose',
    'Check battery voltage and amperage',
    'Replace lubricating oil and oil filter',
    'Inspect accessory drive belt for wear',
    'Replace air filter element',
    'Replace spark plugs',
    'Tighten critical fasteners',
  ],
};
PLAN_VISIT_ITEMS.liquid_48_150 = PLAN_VISIT_ITEMS.liquid_22_38;

// Checklist for a gen class (empty array when the class is unknown).
function planVisitItems(genClass) {
  return PLAN_VISIT_ITEMS[genClass] || [];
}

// Price (price_id + amount_cents) for an add-on at a gen class, or null if N/A.
function lookupAddonPrice(addonType, genClass) {
  const entry = ADDON_CATALOG[addonType];
  if (!entry) return null;
  if (entry.prices.all) return entry.prices.all;
  return entry.prices[genClass] || null;
}

function isRecurringAddon(addonType) {
  const e = ADDON_CATALOG[addonType];
  return !!(e && e.recurring);
}

// All add-on types flagged recurring (the auto-return candidates).
function recurringAddonTypes() {
  return Object.keys(ADDON_CATALOG).filter((t) => ADDON_CATALOG[t].recurring);
}

module.exports = {
  SUBSCRIPTION_CATALOG,
  FLEET_CATALOG,
  PLANS,
  planEntry,
  planForPriceId,
  isPlanPriceId,
  fleetForPriceId,
  isFleetPriceId,
  annualPriceCents,
  ADDON_CATALOG,
  PLAN_VISIT_ITEMS,
  planVisitItems,
  lookupAddonPrice,
  isRecurringAddon,
  recurringAddonTypes,
};
