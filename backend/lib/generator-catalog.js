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
};
