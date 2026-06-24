// backend/scripts/verify-change-plan.js
// Reversible, no-charge verification for the "change plan at next renewal" feature.
// Exercises the SAME Stripe subscription-schedule operations the change-plan
// endpoint performs, against a real (test) subscription, then RELEASES the
// schedule so nothing persists. Confirms: no charge today, the schedule shows the
// switch effective at the period end, and revert (release) restores the original.
//
// Usage (run where STRIPE_SECRET_KEY is set — e.g. a Render shell, or set it inline):
//   STRIPE_SECRET_KEY=sk_live_xxx node scripts/verify-change-plan.js sub_123
//
// Pass the Stripe subscription id (sub_...). Make it a throwaway TEST subscription
// you'll clean up afterward. This script does NOT delete or charge anything.

const Stripe = require('stripe');
const catalog = require('../lib/generator-catalog');

const KEY = process.env.STRIPE_SECRET_KEY;
const subId = process.argv[2];

function die(msg) { console.error('ERROR: ' + msg); process.exit(1); }
if (!KEY) die('STRIPE_SECRET_KEY is not set in the environment.');
if (!subId || !subId.startsWith('sub_')) die('Pass a Stripe subscription id, e.g. node scripts/verify-change-plan.js sub_123');

const stripe = new Stripe(KEY);
const money = (c) => '$' + ((c || 0) / 100).toFixed(2);
const date = (ts) => (ts ? new Date(ts * 1000).toISOString().slice(0, 10) : 'n/a');

(async () => {
  console.log('Stripe mode:', KEY.startsWith('sk_live') ? 'LIVE' : 'TEST');

  let sub = await stripe.subscriptions.retrieve(subId, { expand: ['schedule'] });
  const items = sub.items.data;
  const planItem = items.find((it) => catalog.isPlanPriceId(it.price.id));
  if (!planItem) die('This subscription has no recognized Generator Care plan price. Is it a generator sub?');
  const cur = catalog.planForPriceId(planItem.price.id);
  const hasFleet = items.some((it) => catalog.isFleetPriceId(it.price.id));
  const target = cur.plan === 'semi_annual' ? 'annual' : 'semi_annual';
  const newEntry = catalog.planEntry(cur.gen_class, target);

  console.log('\n--- BEFORE ---');
  console.log('  gen_class:', cur.gen_class, '| current plan:', cur.plan, '| fleet:', hasFleet);
  console.log('  current_period_end (renews):', date(sub.current_period_end));
  console.log('  items:', items.map((i) => i.price.id).join(', '));
  console.log('  existing schedule:', sub.schedule ? (typeof sub.schedule === 'string' ? sub.schedule : sub.schedule.id) : 'none');

  const invBefore = await stripe.invoices.list({ subscription: subId, limit: 100 });
  console.log('  invoice count:', invBefore.data.length);

  if (sub.schedule) die('Subscription already has a schedule attached. Release it first or use a clean test sub.');

  // 1) Schedule the switch (mirrors the change-plan endpoint exactly).
  console.log('\n--- SCHEDULING switch to', target, '(no proration) ---');
  const created = await stripe.subscriptionSchedules.create({ from_subscription: subId });
  const sched0 = await stripe.subscriptionSchedules.retrieve(created.id);
  const curPhase = sched0.phases[0];
  const phase0Items = items.map((it) => ({ price: it.price.id, quantity: it.quantity || 1 }));
  const phase1Items = [{ price: newEntry.price_id, quantity: 1 }];
  if (hasFleet) phase1Items.push({ price: catalog.FLEET_CATALOG[target].price_id, quantity: 1 });
  const sched = await stripe.subscriptionSchedules.update(created.id, {
    end_behavior: 'release',
    proration_behavior: 'none',
    phases: [
      { items: phase0Items, start_date: curPhase.start_date, end_date: curPhase.end_date },
      { items: phase1Items },
    ],
  });

  const future = sched.phases[1];
  console.log('  schedule id:', sched.id, '| status:', sched.status);
  console.log('  phase 0 (current):', sched.phases[0].items.map((i) => i.price).join(', '), '| ends', date(sched.phases[0].end_date));
  console.log('  phase 1 (new):    ', future.items.map((i) => i.price).join(', '), '| starts', date(future.start_date));
  console.log('  expected new plan price:', newEntry.price_id, hasFleet ? '+ fleet ' + catalog.FLEET_CATALOG[target].price_id : '');
  console.log('  new renews-at amount:', money(newEntry.amount_cents + (hasFleet ? catalog.FLEET_CATALOG[target].amount_cents : 0)), target === 'semi_annual' ? 'every 6 months' : 'annually');

  const invAfter = await stripe.invoices.list({ subscription: subId, limit: 100 });
  const noCharge = invAfter.data.length === invBefore.data.length;
  console.log('\n  invoice count after scheduling:', invAfter.data.length, noCharge ? '(UNCHANGED — no charge today PASS)' : '(CHANGED — UNEXPECTED CHARGE!)');

  // 2) Revert (release the schedule) — restores the original subscription.
  console.log('\n--- REVERTING (release schedule) ---');
  const released = await stripe.subscriptionSchedules.release(sched.id);
  const subAfter = await stripe.subscriptions.retrieve(subId, { expand: ['schedule'] });
  const planAfter = subAfter.items.data.find((it) => catalog.isPlanPriceId(it.price.id));
  console.log('  schedule status:', released.status, '| sub.schedule now:', subAfter.schedule || 'none');
  console.log('  plan after revert:', planAfter ? catalog.planForPriceId(planAfter.price.id).plan : '?', '(expect unchanged:', cur.plan + ')');
  const invFinal = await stripe.invoices.list({ subscription: subId, limit: 100 });
  console.log('  invoice count final:', invFinal.data.length, invFinal.data.length === invBefore.data.length ? '(still unchanged PASS)' : '(CHANGED!)');

  const pass = noCharge
    && future.items.some((i) => i.price === newEntry.price_id)
    && (!hasFleet || future.items.some((i) => i.price === catalog.FLEET_CATALOG[target].price_id))
    && released.status === 'released'
    && !subAfter.schedule
    && invFinal.data.length === invBefore.data.length;
  console.log('\n=== RESULT:', pass ? 'PASS — schedule + no-charge + revert all verified' : 'CHECK OUTPUT ABOVE', '===');
})().catch((e) => die(e && e.message ? e.message : String(e)));
