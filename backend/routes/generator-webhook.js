// backend/routes/generator-webhook.js
// Receives Stripe webhook events for the Generator Care program and
// writes corresponding rows into Supabase.
//
// Mounted in server.js with raw body parsing on this path only,
// so Stripe signature verification works.

const express = require('express');
const crypto = require('crypto');
const { supabaseAdmin: supabase } = require('../lib/supabase');

const router = express.Router();

const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY;
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

// Verify Stripe signature header
function verifySignature(payload, header, secret) {
  if (!header || !secret) return false;
  const parts = header.split(',').reduce((acc, p) => {
    const [k, v] = p.split('=');
    acc[k] = v;
    return acc;
  }, {});
  if (!parts.t || !parts.v1) return false;
  const signed = parts.t + '.' + payload;
  const expected = crypto.createHmac('sha256', secret).update(signed).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(parts.v1, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

// Helper: fetch a Stripe object by ID
async function stripeGet(path) {
  const r = await fetch('https://api.stripe.com/v1' + path, {
    headers: { Authorization: 'Bearer ' + STRIPE_SECRET },
  });
  if (!r.ok) throw new Error(`stripe GET ${path}: ${r.status}`);
  return r.json();
}

// POST /webhooks/stripe â Stripe sends events here
router.post('/', async (req, res) => {
  const payload = req.body.toString('utf8');
  const sig = req.headers['stripe-signature'];

  if (WEBHOOK_SECRET && !verifySignature(payload, sig, WEBHOOK_SECRET)) {
    console.error('[generator-webhook] bad signature');
    return res.status(400).send('Invalid signature');
  }

  let event;
  try {
    event = JSON.parse(payload);
  } catch {
    return res.status(400).send('Invalid JSON');
  }

  console.log(`[generator-webhook] received ${event.type}`);

  try {
    if (event.type === 'customer.subscription.created') {
      await handleSubscriptionCreated(event.data.object);
    }
    return res.json({ received: true });
  } catch (err) {
    console.error('[generator-webhook] handler error:', err);
    return res.status(500).json({ error: err.message });
  }
});

async function handleSubscriptionCreated(subscription) {
  const meta = subscription.metadata || {};
  // Only handle generator-program subscriptions (identified by gen_class metadata)
  if (!meta.gen_class) {
    console.log('[generator-webhook] subscription has no gen_class metadata â skipping');
    return;
  }

  const stripeCustomerId = subscription.customer;
  const stripeCust = await stripeGet(`/customers/${stripeCustomerId}`);

  // 1. Upsert customer
  const { data: customer, error: custErr } = await supabase
    .from('generator_customers')
    .upsert(
      {
        stripe_customer_id: stripeCustomerId,
        name: meta.customer_name || stripeCust.name || stripeCust.email || 'Unknown',
        email: stripeCust.email || '',
        phone: meta.customer_phone || stripeCust.phone || '',
        install_address: meta.install_address || '',
        install_city: meta.install_city || '',
        install_state: meta.install_state || '',
        install_zip: meta.install_zip || '',
      },
      { onConflict: 'stripe_customer_id' }
    )
    .select()
    .single();
  if (custErr) throw new Error('upsert customer: ' + custErr.message);

  // 2. Compute next-visit date
  const today = new Date();
  const monthsAhead = meta.plan === 'semi_annual' ? 6 : 12;
  const next = new Date(today);
  // First visit: schedule for signup day so dashboard shows 'needs scheduling now'.
  // monthsAhead cadence kicks in only after first visit is marked complete.
  next.setMonth(next.getMonth() + 0);
  const todayStr = today.toISOString().slice(0, 10);
  const nextStr = next.toISOString().slice(0, 10);

  // 3. Compute annual price (sum of subscription line items, times 2 for semi-annual billed twice/year)
  const lineItems = subscription.items?.data || [];
  const perInvoiceCents = lineItems.reduce((sum, it) => sum + (it.price?.unit_amount || 0), 0);
  const annualPriceCents =
    meta.plan === 'semi_annual' ? perInvoiceCents * 2 : perInvoiceCents;
  const fleetMonitoring = lineItems.length > 1;

  // 4. Insert subscription
  const { data: sub, error: subErr } = await supabase
    .from('generator_subscriptions')
    .insert({
      customer_id: customer.id,
      stripe_subscription_id: subscription.id,
      stripe_customer_id: stripeCustomerId,
      plan: meta.plan,
      gen_class: meta.gen_class,
      gen_type_label: meta.gen_type || '',
      gen_model: meta.gen_model || '',
      gen_serial: meta.gen_serial || '',
      fleet_monitoring: fleetMonitoring,
      status: subscription.status === 'active' || subscription.status === 'trialing' ? 'active' : 'incomplete',
      annual_price_cents: annualPriceCents,
      signup_date: todayStr,
      next_visit_due: nextStr,
      raw_metadata: meta,
    })
    .select()
    .single();
  if (subErr) throw new Error('insert subscription: ' + subErr.message);

  // 5. First scheduled service visit
  await supabase.from('generator_service_visits').insert({
    subscription_id: sub.id,
    visit_type: 'regular_service',
    scheduled_date: nextStr,
    status: 'tentative',
  });

  // 6. Pending add-ons (charged later off saved card when performed)
  let onDemand = [];
  if (meta.on_demand_addons) {
    try { onDemand = JSON.parse(meta.on_demand_addons); } catch {}
  }
  for (const item of onDemand) {
    let amountCents = null;
    try {
      const price = await stripeGet(`/prices/${item.price_id}`);
      amountCents = price.unit_amount || null;
    } catch {}
    await supabase.from('generator_pending_addons').insert({
      subscription_id: sub.id,
      addon_type: item.addon,
      stripe_price_id: item.price_id,
      amount_cents: amountCents,
      status: 'pending',
    });
  }

  console.log(`[generator-webhook] created subscription ${sub.id} for customer ${customer.id}`);
}

module.exports = router;
