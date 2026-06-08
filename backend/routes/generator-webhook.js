// backend/routes/generator-webhook.js
// Receives Stripe webhook events for the Generator Care program and
// writes corresponding rows into Supabase.
//
// Mounted in server.js with raw body parsing on this path only,
// so Stripe signature verification works.

const express = require('express');
const crypto = require('crypto');
const { supabaseAdmin: supabase } = require('../lib/supabase');
const { sendEmail, buildWelcomeEmail, buildCardFailedEmail } = require('../lib/emails');

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

async function stripePost(path, params) {
  const body = new URLSearchParams(params).toString();
  const r = await fetch('https://api.stripe.com/v1' + path, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + STRIPE_SECRET,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  if (!r.ok) {
    const errBody = await r.text();
    throw new Error(`stripe POST ${path}: ${r.status} ${errBody.substring(0, 200)}`);
  }
  return r.json();
}

// POST /webhooks/stripe - Stripe sends events here
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
    } else if (event.type === 'customer.subscription.updated') {
      await handleSubscriptionUpdated(event.data.object);
    } else if (event.type === 'customer.subscription.deleted') {
      await handleSubscriptionDeleted(event.data.object);
    } else if (event.type === 'customer.updated') {
      await handleCustomerUpdated(event.data.object);
    } else if (event.type === 'invoice.paid' || event.type === 'invoice.payment_succeeded') {
      await handleInvoicePaid(event.data.object);
    } else if (event.type === 'invoice.payment_failed') {
      await handleInvoicePaymentFailed(event.data.object);
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
    console.log('[generator-webhook] subscription has no gen_class metadata - skipping');
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

  // Welcome email (non-blocking — failures shouldn't break the webhook).
  sendWelcomeEmail({
    customer,
    meta,
    planLabel: meta.plan === 'semi_annual' ? 'Semi-Annual' : (meta.plan === 'annual' ? 'Annual' : meta.plan),
    nextVisitDate: nextStr,
    annualPriceCents,
    fleetMonitoring,
  }).catch((e) => console.error('[welcome-email] unexpected:', e && e.message));

  console.log(`[generator-webhook] created subscription ${sub.id} for customer ${customer.id}`);
}


// Map a Stripe subscription status to one of our DB-allowed values.
// Our schema allows: active, past_due, incomplete, canceled (see migration 004).
// Returns null when the status doesn't need to be synced (unknown / unhandled).
function mapStripeStatusToDbStatus(stripeStatus, cancelAtPeriodEnd) {
  if (stripeStatus === 'active' || stripeStatus === 'trialing') {
    // Treat "cancel at period end" as already-canceled in our DB; matches the
    // behavior of the office-dashboard cancel endpoint, which immediately sets
    // status='canceled' even though Stripe keeps the sub active until period end.
    return cancelAtPeriodEnd ? 'canceled' : 'active';
  }
  if (stripeStatus === 'past_due' || stripeStatus === 'unpaid') return 'past_due';
  if (stripeStatus === 'canceled' || stripeStatus === 'incomplete_expired') return 'canceled';
  if (stripeStatus === 'incomplete') return 'incomplete';
  return null;
}

async function handleSubscriptionUpdated(subscription) {
  const dbStatus = mapStripeStatusToDbStatus(
    subscription.status,
    subscription.cancel_at_period_end === true,
  );
  if (!dbStatus) {
    console.log(`[generator-webhook] subscription.updated: unhandled status ${subscription.status}, ignoring`);
    return;
  }

  const { data, error } = await supabase
    .from('generator_subscriptions')
    .update({ status: dbStatus })
    .eq('stripe_subscription_id', subscription.id)
    .select('id, status')
    .maybeSingle();
  if (error) {
    console.error('[generator-webhook] subscription.updated update error:', error.message);
    return;
  }
  if (!data) {
    console.log(`[generator-webhook] subscription.updated: no matching DB row for ${subscription.id}`);
    return;
  }
  console.log(`[generator-webhook] subscription ${data.id} status -> ${dbStatus} (stripe: ${subscription.status}, cancel_at_period_end: ${subscription.cancel_at_period_end})`);
}

async function handleSubscriptionDeleted(subscription) {
  // Final terminal event from Stripe — sub is fully gone. Mark canceled if
  // not already (the dashboard cancel + the updated handler usually beat us
  // here, but this is the backstop).
  const { data, error } = await supabase
    .from('generator_subscriptions')
    .update({ status: 'canceled' })
    .eq('stripe_subscription_id', subscription.id)
    .neq('status', 'canceled')
    .select('id')
    .maybeSingle();
  if (error) {
    console.error('[generator-webhook] subscription.deleted update error:', error.message);
    return;
  }
  if (data) {
    console.log(`[generator-webhook] subscription ${data.id} -> canceled (via subscription.deleted)`);
  }
}

async function handleCustomerUpdated(customer) {
  // Sync customer email/name/phone from Stripe portal edits back to our DB.
  //
  // Intentionally NOT syncing install_address: Stripe holds BILLING address,
  // our generator_customers.install_address holds the SERVICE-site address.
  // They can legitimately differ (e.g. owner billed at home, generator at
  // a vacation property). If a customer wants their service address updated,
  // they have to call Amy. Document this in CLAUDE.md for staff awareness.
  const updates = {};
  if (typeof customer.email === 'string' && customer.email.length > 0) {
    updates.email = customer.email;
  }
  if (typeof customer.name === 'string' && customer.name.length > 0) {
    updates.name = customer.name;
  }
  if (typeof customer.phone === 'string' && customer.phone.length > 0) {
    updates.phone = customer.phone;
  }
  if (Object.keys(updates).length === 0) return;

  const { data, error } = await supabase
    .from('generator_customers')
    .update(updates)
    .eq('stripe_customer_id', customer.id)
    .select('id')
    .maybeSingle();
  if (error) {
    console.error('[generator-webhook] customer.updated update error:', error.message);
    return;
  }
  if (data) {
    console.log(`[generator-webhook] customer ${data.id} synced fields: ${Object.keys(updates).join(', ')}`);
  }
}


async function handleInvoicePaid(invoice) {
  if (!invoice || !invoice.lines || !invoice.lines.data) return;
  const paymentIntentId = invoice.payment_intent || null;
  const today = new Date().toISOString().slice(0, 10);

  for (const line of invoice.lines.data) {
    const meta = (line.metadata || {});
    const addonId = meta.addon_id;
    const adhocId = meta.adhoc_charge_id;
    if (addonId) {
      const { error } = await supabase
        .from('generator_pending_addons')
        .update({
          status: 'charged',
          date_charged: today,
          stripe_payment_intent_id: paymentIntentId,
        })
        .eq('id', addonId);
      if (error) {
        console.error('[generator-webhook] failed to mark addon charged:', addonId, error.message);
      }
    }
    if (adhocId) {
      const { error } = await supabase
        .from('generator_adhoc_charges')
        .update({
          status: 'charged',
          date_charged: today,
          stripe_payment_intent_id: paymentIntentId,
        })
        .eq('id', adhocId);
      if (error) {
        console.error('[generator-webhook] failed to mark adhoc charged:', adhocId, error.message);
      }
    }
  }
}

async function handleInvoicePaymentFailed(invoice) {
  if (!invoice || !invoice.lines || !invoice.lines.data) return;
  const today = new Date().toISOString().slice(0, 10);
  const reason = (invoice.last_finalization_error && invoice.last_finalization_error.message)
    || (invoice.charge && invoice.charge.failure_message)
    || 'Payment failed at renewal';

  for (const line of invoice.lines.data) {
    const meta = (line.metadata || {});
    const addonId = meta.addon_id;
    const adhocId = meta.adhoc_charge_id;
    if (addonId) {
      const { error } = await supabase
        .from('generator_pending_addons')
        .update({
          status: 'failed',
          notes: 'Renewal charge failed on ' + today + ': ' + reason,
        })
        .eq('id', addonId);
      if (error) {
        console.error('[generator-webhook] failed to mark addon failed:', addonId, error.message);
      }
    }
    if (adhocId) {
      const { error } = await supabase
        .from('generator_adhoc_charges')
        .update({
          status: 'failed',
          notes: 'Renewal charge failed on ' + today + ': ' + reason,
        })
        .eq('id', adhocId);
      if (error) {
        console.error('[generator-webhook] failed to mark adhoc failed:', adhocId, error.message);
      }
    }
  }

  // Auto-email the customer a Customer Portal link so they can update their card.
  try {
    const stripeCustomerId = invoice.customer;
    if (stripeCustomerId) {
      const { data: cust } = await supabase
        .from('generator_customers')
        .select('id, name, email, stripe_customer_id')
        .eq('stripe_customer_id', stripeCustomerId)
        .maybeSingle();
      if (cust && cust.email) {
        const firstLine = (invoice.lines && invoice.lines.data && invoice.lines.data[0]) || null;
        const description = (firstLine && firstLine.description) || 'a charge on your account';
        sendCardFailedEmail({
          customer: cust,
          amountCents: invoice.amount_due,
          description,
        }).catch((e) => console.error('[card-failed-email] unexpected:', e && e.message));
      } else {
        console.log('[card-failed-email] no matching customer or email, skipping');
      }
    }
  } catch (e) {
    console.error('[card-failed-email] lookup error:', e && e.message);
  }
}


// ---- Welcome email send (templates live in lib/emails.js) ----
async function sendWelcomeEmail({ customer, meta, planLabel, nextVisitDate, annualPriceCents, fleetMonitoring }) {
  if (!customer || !customer.email) {
    console.log('[welcome-email] no email on file, skipping');
    return { sent: false, reason: 'no email on file' };
  }
  const { subject, html, text } = buildWelcomeEmail({
    customer, meta, planLabel, nextVisitDate, annualPriceCents, fleetMonitoring,
  });
  return sendEmail({
    to: customer.email,
    subject,
    html,
    text,
    logTag: '[welcome-email]',
  });
}

// ---- Card-failed email send ----
async function sendCardFailedEmail({ customer, amountCents, description }) {
  if (!customer || !customer.email || !customer.stripe_customer_id) {
    console.log('[card-failed-email] missing email or stripe_customer_id, skipping');
    return { sent: false, reason: 'missing email or stripe_customer_id' };
  }
  let portalUrl;
  try {
    const portalSession = await stripePost('/billing_portal/sessions', {
      customer: customer.stripe_customer_id,
      return_url: 'https://app.bates-electric.com/home.html',
    });
    portalUrl = portalSession.url;
  } catch (err) {
    console.error('[card-failed-email] portal session error:', err && err.message);
    return { sent: false, reason: 'portal session failed' };
  }
  const { subject, html, text } = buildCardFailedEmail({
    customer, amountCents, description, portalUrl,
  });
  return sendEmail({
    to: customer.email,
    subject,
    html,
    text,
    logTag: '[card-failed-email]',
  });
}

module.exports = router;
