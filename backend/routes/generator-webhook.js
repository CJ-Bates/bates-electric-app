// backend/routes/generator-webhook.js
// Receives Stripe webhook events for the Generator Care program and
// writes corresponding rows into Supabase.
//
// Mounted in server.js with raw body parsing on this path only,
// so Stripe signature verification works.

const express = require('express');
const Stripe = require('stripe');
const { supabaseAdmin: supabase } = require('../lib/supabase');
const catalog = require('../lib/generator-catalog');
const { sendReceiptEmail } = require('../lib/receipts');
const { sendEmail, buildWelcomeEmail, buildCardFailedEmail, buildRenewalUpcomingEmail, buildCancellationEmail, buildRefundReceiptEmail } = require('../lib/emails');
const { reportError } = require('../middleware/error-reporter');

const router = express.Router();

const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY;
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;
const stripe = new Stripe(STRIPE_SECRET);

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
  const sig = req.headers['stripe-signature'];

  // Fail closed: never process an unsigned/unverifiable event. If the secret is
  // missing we refuse outright rather than silently skipping verification.
  if (!WEBHOOK_SECRET) {
    console.error('[generator-webhook] STRIPE_WEBHOOK_SECRET is not set — refusing to process webhooks');
    return res.status(500).send('Webhook secret not configured');
  }

  // constructEvent verifies the HMAC against the RAW body in constant time and
  // enforces Stripe's ~5-minute timestamp tolerance (replay protection).
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, WEBHOOK_SECRET);
  } catch (err) {
    console.error('[generator-webhook] signature verification failed:', err && err.message);
    return res.status(400).send('Webhook signature verification failed');
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
    } else if (event.type === 'charge.refunded') {
      await handleChargeRefunded(event.data.object);
    } else if (event.type === 'invoice.payment_failed') {
      await handleInvoicePaymentFailed(event.data.object);
    } else if (event.type === 'invoice.upcoming') {
      await handleInvoiceUpcoming(event.data.object);
    }
    return res.json({ received: true });
  } catch (err) {
    // Webhook failures are the highest-stakes place to lose visibility --
    // route them through the shared reporter (Sentry + alert email) too.
    console.error('[generator-webhook] handler error:', err);
    reportError(err, {
      route: `/webhooks/stripe (${event && event.type})`,
      method: 'POST',
      user: 'stripe-webhook',
    }).catch(() => {});
    return res.status(500).json({ error: 'Webhook handler error' });
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

  // 1b. Make the card from Checkout the customer's default payment method for
  // invoices and any future off-session charges (ad-hoc charges, renewals).
  // Checkout sets the card as the SUBSCRIPTION's default_payment_method but not
  // the CUSTOMER's invoice_settings default, so without this an ad-hoc charge
  // (paymentIntents.create) can't find a card. Non-fatal if it doesn't stick.
  try {
    let defaultPm = subscription.default_payment_method;
    if (defaultPm && typeof defaultPm !== 'string') defaultPm = defaultPm.id;
    if (!defaultPm) {
      const pms = await stripeGet(`/payment_methods?customer=${stripeCustomerId}&type=card&limit=1`);
      defaultPm = pms && pms.data && pms.data[0] && pms.data[0].id;
    }
    if (defaultPm) {
      await stripePost(`/customers/${stripeCustomerId}`, {
        'invoice_settings[default_payment_method]': defaultPm,
      });
      console.log(`[generator-webhook] set customer ${stripeCustomerId} default payment method`);
    }
  } catch (e) {
    console.error('[generator-webhook] set default_payment_method failed:', e && e.message);
  }

  // 2. Compute dates. The first tentative visit is set ~2 weeks out (Amy confirms
  // the real date with the customer by phone); the regular cadence (every 6 or 12
  // months) is applied later, when a visit is marked complete. If the 2-week date
  // lands on a weekend, roll forward to the next weekday.
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const firstVisit = new Date(today);
  firstVisit.setUTCDate(firstVisit.getUTCDate() + 14);
  const dow = firstVisit.getUTCDay(); // 0 = Sunday, 6 = Saturday
  if (dow === 6) firstVisit.setUTCDate(firstVisit.getUTCDate() + 2);      // Sat -> Mon
  else if (dow === 0) firstVisit.setUTCDate(firstVisit.getUTCDate() + 1); // Sun -> Mon
  const nextStr = firstVisit.toISOString().slice(0, 10);

  // 3. Compute annual price (sum of subscription line items, times 2 for semi-annual billed twice/year)
  const lineItems = subscription.items?.data || [];
  const perInvoiceCents = lineItems.reduce((sum, it) => sum + (it.price?.unit_amount || 0), 0);
  const annualPriceCents =
    meta.plan === 'semi_annual' ? perInvoiceCents * 2 : perInvoiceCents;
  const fleetMonitoring = lineItems.length > 1;

  // 3b. Actual amount charged on the first invoice, for the welcome email's
  // payment-confirmation line. We read the invoice's amount_paid (not the
  // line-item sum) so a promo-code discount is reflected — what the customer was
  // really charged today. Falls back to the line-item sum if the invoice can't
  // be read, so the confirmation line still appears.
  let paidAmountCents = perInvoiceCents;
  let paidDateStr = todayStr;
  try {
    const invId = typeof subscription.latest_invoice === 'string'
      ? subscription.latest_invoice
      : (subscription.latest_invoice && subscription.latest_invoice.id);
    if (invId) {
      const inv = await stripeGet(`/invoices/${invId}`);
      if (inv && typeof inv.amount_paid === 'number') {
        paidAmountCents = inv.amount_paid;
        const paidTs = (inv.status_transitions && inv.status_transitions.paid_at) || inv.created;
        if (paidTs) paidDateStr = new Date(paidTs * 1000).toISOString().slice(0, 10);
      }
    }
  } catch (e) {
    console.error('[welcome-email] first-invoice amount lookup failed:', e && e.message);
  }

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
      // Acquisition channel (from the signup form / marketing link). Null for
      // pre-005 signups; the metrics view reports "collecting since" until data accrues.
      signup_source: meta.signup_source || null,
      signup_utm_source: meta.signup_utm_source || null,
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
    paidAmountCents,
    paidDate: paidDateStr,
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

  const updates = { status: dbStatus };
  // Reactivation clears the cancellation stamp so it isn't counted as churned.
  if (dbStatus === 'active') updates.canceled_at = null;

  // Sync plan + yearly price from the current line items. This is how a scheduled
  // cadence change (Semi-Annual <-> Annual) lands in our DB: when the schedule
  // advances at renewal, Stripe fires subscription.updated with the new price.
  // planForPriceId returns null for non-generator subs, so this is a no-op there.
  const items = (subscription.items && subscription.items.data) || [];
  const planItem = items.find((it) => it.price && catalog.isPlanPriceId(it.price.id));
  if (planItem) {
    const info = catalog.planForPriceId(planItem.price.id);
    const hasFleet = items.some((it) => it.price && catalog.isFleetPriceId(it.price.id));
    updates.plan = info.plan;
    const annual = catalog.annualPriceCents(info.gen_class, info.plan, hasFleet);
    if (annual != null) updates.annual_price_cents = annual;
  }

  const { data, error } = await supabase
    .from('generator_subscriptions')
    .update(updates)
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

  // Stamp canceled_at only the FIRST time the sub enters canceled — a repeat
  // 'updated' delivery (or the later 'deleted' backstop) must not move the
  // original cancellation date the churn metrics rely on.
  if (dbStatus === 'canceled') {
    const { error: stampErr } = await supabase
      .from('generator_subscriptions')
      .update({ canceled_at: new Date().toISOString() })
      .eq('stripe_subscription_id', subscription.id)
      .is('canceled_at', null);
    if (stampErr) console.error('[generator-webhook] subscription.updated canceled_at stamp error:', stampErr.message);
  }

  console.log(`[generator-webhook] subscription ${data.id} status -> ${dbStatus} (stripe: ${subscription.status}, cancel_at_period_end: ${subscription.cancel_at_period_end})`);
}

async function handleSubscriptionDeleted(subscription) {
  // Final terminal event from Stripe — sub is fully gone. Mark canceled if
  // not already (the dashboard cancel + the updated handler usually beat us
  // here, but this is the backstop).
  // The .neq filter means we only touch rows transitioning IN to canceled, so
  // stamping canceled_at here can't overwrite an earlier (dashboard/updated) one.
  const { error } = await supabase
    .from('generator_subscriptions')
    .update({ status: 'canceled', canceled_at: new Date().toISOString() })
    .eq('stripe_subscription_id', subscription.id)
    .neq('status', 'canceled');
  if (error) {
    console.error('[generator-webhook] subscription.deleted update error:', error.message);
    // Don't return — still try to send/dedupe the confirmation below.
  }

  // Look up our subscription row for (a) the dedupe marker and (b) its id.
  const { data: subRow, error: subRowErr } = await supabase
    .from('generator_subscriptions')
    .select('id, raw_metadata')
    .eq('stripe_subscription_id', subscription.id)
    .maybeSingle();
  if (subRowErr) {
    console.error('[generator-webhook] subscription.deleted row lookup error:', subRowErr.message);
  }

  // Dedupe: the dashboard cancel endpoint sends the confirmation at cancel time
  // (cancel_at_period_end) and records cancellation_email_sent_at. If that already
  // happened, don't send a second email when the period actually ends here. We DO
  // still send for an outright cancel done directly in the Stripe dashboard, where
  // no endpoint ran and the marker was never set.
  if (subRow && subRow.raw_metadata && subRow.raw_metadata.cancellation_email_sent_at) {
    console.log(`[generator-webhook] subscription.deleted: cancellation email already sent at ${subRow.raw_metadata.cancellation_email_sent_at}, skipping`);
    return;
  }

  // Look up the customer and send. No periodEndDate here — by the time deleted
  // fires there's no future coverage window to advertise; use the plain
  // "has been cancelled" copy. Non-generator subs won't match a customer row.
  let canceledCustomer = null;
  if (subscription.customer) {
    const { data: cust, error: custErr } = await supabase
      .from('generator_customers')
      .select('name, email, install_state')
      .eq('stripe_customer_id', subscription.customer)
      .maybeSingle();
    if (custErr) {
      console.error('[generator-webhook] subscription.deleted customer lookup error:', custErr.message);
    } else {
      canceledCustomer = cust;
    }
  }

  // A failed email must never throw out of the webhook (Stripe retries on 500s).
  let sent = false;
  try {
    const r = await sendCancellationEmail({ customer: canceledCustomer });
    sent = !!(r && r.sent);
  } catch (e) {
    console.error('[cancellation-email] unexpected:', e && e.message);
  }

  // Record the marker so a retried/duplicate deleted delivery doesn't re-send.
  if (sent && subRow && subRow.id) {
    const meta = { ...(subRow.raw_metadata || {}), cancellation_email_sent_at: new Date().toISOString() };
    const { error: markErr } = await supabase
      .from('generator_subscriptions')
      .update({ raw_metadata: meta })
      .eq('id', subRow.id);
    if (markErr) console.error('[generator-webhook] subscription.deleted mark-sent error:', markErr.message);
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

  // Send OUR OWN receipt for this charge, branded by the customer's state
  // (Stripe's automatic receipt is account-level and can't vary per customer).
  // Covers signup, renewal, add-on, and ad-hoc — they all flow through invoices.
  // Non-blocking; a mail hiccup must never fail the webhook (Stripe retries 500s).
  sendReceiptEmail(invoice).catch((e) => console.error('[receipt-email] unexpected:', e && e.message));
}

async function handleChargeRefunded(charge) {
  // Send OUR OWN refund confirmation, branded by the customer's state, so CJ can
  // turn off Stripe's account-level "Bates Electric" refund email (which can't
  // vary per customer). Non-blocking; a mail hiccup must never fail the webhook
  // (Stripe retries 500s).
  sendRefundReceiptEmail(charge).catch((e) => console.error('[refund-receipt-email] unexpected:', e && e.message));
}

// Build + send our state-branded refund confirmation for a refunded charge.
async function sendRefundReceiptEmail(charge) {
  try {
    if (!charge || !charge.customer) return { sent: false, reason: 'no customer' };

    // The amount for THIS refund — use the latest refund object, not the charge's
    // cumulative amount_refunded (which would over-state a second partial refund).
    // Webhook payloads may not expand `refunds`, so fall back to the API.
    let latestRefund = null;
    if (charge.refunds && Array.isArray(charge.refunds.data) && charge.refunds.data.length) {
      latestRefund = charge.refunds.data[0];
    } else {
      try {
        const refunds = await stripeGet(`/refunds?charge=${charge.id}&limit=1`);
        latestRefund = refunds && refunds.data && refunds.data[0];
      } catch (e) {
        console.error('[refund-receipt-email] refund lookup failed:', e && e.message);
      }
    }

    const amountCents = (latestRefund && typeof latestRefund.amount === 'number')
      ? latestRefund.amount
      : (typeof charge.amount_refunded === 'number' ? charge.amount_refunded : 0);
    if (amountCents <= 0) {
      console.log('[refund-receipt-email] refund amount is 0, skipping');
      return { sent: false, reason: 'zero amount' };
    }

    // Partial = refunded less than the original charge total.
    const isPartial = typeof charge.amount === 'number' && amountCents < charge.amount;

    // Only generator customers are in our table; non-generator charges won't match.
    const { data: customer, error: custErr } = await supabase
      .from('generator_customers')
      .select('name, email, install_state')
      .eq('stripe_customer_id', charge.customer)
      .maybeSingle();
    if (custErr) {
      console.error('[refund-receipt-email] customer lookup error:', custErr.message);
      return { sent: false, reason: 'lookup error' };
    }
    if (!customer || !customer.email) {
      console.log('[refund-receipt-email] no matching customer or email, skipping');
      return { sent: false, reason: 'no customer email' };
    }

    const refundTs = (latestRefund && latestRefund.created) || charge.created;
    const refundDate = refundTs ? new Date(refundTs * 1000).toISOString().slice(0, 10) : null;

    // Card brand + last-4 are on the charge payload (no extra call needed).
    let cardBrand = null;
    let cardLast4 = null;
    const card = charge.payment_method_details && charge.payment_method_details.card;
    if (card) { cardBrand = card.brand || null; cardLast4 = card.last4 || null; }

    const description = charge.description || 'Generator Care';
    // Original charge/receipt reference, if Stripe has one.
    const originalReceiptNumber = charge.receipt_number || charge.id || null;

    const { subject, html, text } = buildRefundReceiptEmail({
      customer,
      companyState: customer.install_state,
      amountCents,
      refundDate,
      cardBrand,
      cardLast4,
      description,
      originalReceiptNumber,
      isPartial,
    });
    return sendEmail({ to: customer.email, subject, html, text, logTag: '[refund-receipt-email]', companyState: customer.install_state });
  } catch (e) {
    console.error('[refund-receipt-email] build/send error:', e && e.message);
    return { sent: false, reason: 'error' };
  }
}

// Stripe fires invoice.upcoming ahead of every renewal (default 7 days; configurable
// per Stripe account in Subscriptions settings). Wire this up by adding
// `invoice.upcoming` to the live webhook endpoint's event list in the Stripe Dashboard.
async function handleInvoiceUpcoming(invoice) {
  if (!invoice || !invoice.customer || !invoice.subscription) {
    console.log('[generator-webhook] invoice.upcoming: missing customer or subscription, skipping');
    return;
  }

  // Look up our customer + subscription rows.
  const stripeCustomerId = invoice.customer;
  const stripeSubId = typeof invoice.subscription === 'string' ? invoice.subscription : invoice.subscription.id;

  const { data: sub } = await supabase
    .from('generator_subscriptions')
    .select('id, plan, status, customer:generator_customers(name, email, install_state)')
    .eq('stripe_subscription_id', stripeSubId)
    .maybeSingle();
  if (!sub) {
    console.log(`[renewal-upcoming] no matching DB subscription for ${stripeSubId}, skipping`);
    return;
  }
  if (sub.status === 'canceled') {
    console.log(`[renewal-upcoming] subscription ${sub.id} is canceled, skipping`);
    return;
  }
  const customer = sub.customer || {};
  if (!customer.email) {
    console.log(`[renewal-upcoming] subscription ${sub.id} has no customer email, skipping`);
    return;
  }

  // Stripe period_end is a Unix seconds timestamp; convert to YYYY-MM-DD.
  const periodEndDate = invoice.period_end
    ? new Date(invoice.period_end * 1000).toISOString().slice(0, 10)
    : null;

  // Line items: each invoice.lines.data entry has { amount, description, ... }
  const lineItems = ((invoice.lines && invoice.lines.data) || []).map((line) => ({
    amount_cents: line.amount || 0,
    description: line.description || '',
  }));

  const planLabel = sub.plan === 'semi_annual' ? 'Semi-Annual' : (sub.plan === 'annual' ? 'Annual' : sub.plan);

  const { subject, html, text } = buildRenewalUpcomingEmail({
    customer,
    renewalDate: periodEndDate,
    amountCents: invoice.amount_due || 0,
    planLabel,
    lineItems,
  });

  await sendEmail({
    to: customer.email,
    subject,
    html,
    text,
    logTag: '[renewal-upcoming]',
    companyState: customer.install_state,
  });
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
        .select('id, name, email, stripe_customer_id, install_state')
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
async function sendWelcomeEmail({ customer, meta, planLabel, nextVisitDate, annualPriceCents, fleetMonitoring, paidAmountCents, paidDate }) {
  if (!customer || !customer.email) {
    console.log('[welcome-email] no email on file, skipping');
    return { sent: false, reason: 'no email on file' };
  }
  const { subject, html, text } = buildWelcomeEmail({
    customer, meta, planLabel, nextVisitDate, annualPriceCents, fleetMonitoring, paidAmountCents, paidDate,
  });
  return sendEmail({
    to: customer.email,
    subject,
    html,
    text,
    logTag: '[welcome-email]',
    // From display name: current customer state first, signup meta as fallback.
    companyState: (customer && customer.install_state) || (meta && meta.install_state),
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
    companyState: customer.install_state,
  });
}

// ---- Cancellation confirmation email send ----
async function sendCancellationEmail({ customer }) {
  if (!customer || !customer.email) {
    console.log('[cancellation-email] no email on file, skipping');
    return { sent: false, reason: 'no email on file' };
  }
  const { subject, html, text } = buildCancellationEmail({ customer });
  return sendEmail({
    to: customer.email,
    subject,
    html,
    text,
    logTag: '[cancellation-email]',
    companyState: customer.install_state,
  });
}

module.exports = router;
