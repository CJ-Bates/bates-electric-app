// backend/routes/generator-webhook.js
// Receives Stripe webhook events for the Generator Care program and
// writes corresponding rows into Supabase.
//
// Mounted in server.js with raw body parsing on this path only,
// so Stripe signature verification works.

const express = require('express');
const crypto = require('crypto');
const sgMail = require('@sendgrid/mail');
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


// ---- Welcome email ----
function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

async function sendWelcomeEmail({ customer, meta, planLabel, nextVisitDate, annualPriceCents, fleetMonitoring }) {
  const SENDGRID_KEY = process.env.SENDGRID_API_KEY;
  if (!SENDGRID_KEY) {
    console.log('[welcome-email] SENDGRID_API_KEY not set, skipping');
    return;
  }
  if (!customer || !customer.email) {
    console.log('[welcome-email] no email on file, skipping');
    return;
  }
  try {
    const fmtMoney = (c) => '$' + ((c || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const fmtDate = (s) => {
      if (!s) return '';
      const d = new Date(s + 'T12:00:00');
      return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    };
    const genClass = meta.gen_class === 'air_cooled' ? 'Air cooled' : (meta.gen_class && meta.gen_class.startsWith('liquid') ? 'Liquid cooled' : '');
    const genLine = [genClass, meta.gen_type, meta.gen_model, meta.gen_serial && ('s/n ' + meta.gen_serial)].filter(Boolean).join(' \u2022 ');
    const addr = [meta.install_address, meta.install_city, meta.install_state, meta.install_zip].filter(Boolean).join(', ');

    const html = '<!DOCTYPE html>' +
      '<html><body style="margin:0;padding:0;background:#F4F6F9;font-family:system-ui,-apple-system,sans-serif;color:#1F3A5F;">' +
      '<div style="max-width:600px;margin:0 auto;background:#fff;">' +
      '<div style="background:#1F3A5F;padding:24px 28px;text-align:center;">' +
      '<h1 style="color:#fff;margin:0;font-size:22px;letter-spacing:0.5px;">Bates Electric</h1>' +
      '<p style="color:#DFE6F0;margin:6px 0 0;font-size:13px;letter-spacing:1px;text-transform:uppercase;">Generator Care</p>' +
      '</div>' +
      '<div style="padding:28px;">' +
      '<h2 style="margin:0 0 14px;font-size:20px;color:#1F3A5F;">Welcome aboard, ' + escHtml(customer.name || 'there') + '!</h2>' +
      '<p style="margin:0 0 18px;line-height:1.55;color:#374151;">Thanks for signing up for Bates Electric\'s Generator Care program. We\'ve got everything we need on our end and your subscription is active.</p>' +
      '<h3 style="margin:24px 0 10px;font-size:13px;color:#6B7280;text-transform:uppercase;letter-spacing:0.08em;">What happens next</h3>' +
      '<ol style="margin:0;padding-left:20px;color:#374151;line-height:1.7;">' +
      '<li>One of our team will reach out within the next few business days to schedule your first maintenance visit.</li>' +
      '<li>Our technicians will perform a full inspection and any included services per your plan.</li>' +
      '<li>From there, we\'ll auto-schedule your recurring visits based on your plan.</li>' +
      '</ol>' +
      '<h3 style="margin:28px 0 10px;font-size:13px;color:#6B7280;text-transform:uppercase;letter-spacing:0.08em;">Your plan</h3>' +
      '<table style="width:100%;border-collapse:collapse;font-size:14px;color:#374151;">' +
      '<tr><td style="padding:6px 0;color:#6B7280;width:40%;">Plan</td><td style="padding:6px 0;font-weight:600;">' + escHtml(planLabel) + '</td></tr>' +
      (genLine ? '<tr><td style="padding:6px 0;color:#6B7280;">Generator</td><td style="padding:6px 0;font-weight:600;">' + escHtml(genLine) + '</td></tr>' : '') +
      (addr ? '<tr><td style="padding:6px 0;color:#6B7280;vertical-align:top;">Service address</td><td style="padding:6px 0;font-weight:600;">' + escHtml(addr) + '</td></tr>' : '') +
      (nextVisitDate ? '<tr><td style="padding:6px 0;color:#6B7280;vertical-align:top;">First visit</td><td style="padding:6px 0;font-weight:600;">' + escHtml(fmtDate(nextVisitDate)) + '<br><span style="color:#6B7280;font-weight:400;font-size:12px;">We\'ll confirm the exact time when we call.</span></td></tr>' : '') +
      '<tr><td style="padding:6px 0;color:#6B7280;">Annual billing</td><td style="padding:6px 0;font-weight:600;">' + escHtml(fmtMoney(annualPriceCents)) + '/year</td></tr>' +
      (fleetMonitoring ? '<tr><td style="padding:6px 0;color:#6B7280;">Add-on</td><td style="padding:6px 0;font-weight:600;">Fleet Monitoring (Mobile Link)</td></tr>' : '') +
      '</table>' +
      '<p style="margin:28px 0 0;line-height:1.55;color:#374151;">Have questions, need to reschedule, or want to update your card? Just reply to this email or give us a call at <strong>(636) 464-3939</strong>.</p>' +
      '<p style="margin:18px 0 0;color:#6B7280;font-size:14px;">\u2014 The Bates Electric team</p>' +
      '</div>' +
      '<div style="background:#F4F6F9;padding:18px 28px;text-align:center;border-top:1px solid #E5E7EB;">' +
      '<p style="margin:0;font-size:12px;color:#6B7280;">Bates Electric, Inc. \u00b7 (636) 464-3939</p>' +
      '</div>' +
      '</div></body></html>';

    const text = 'Welcome to Bates Electric Generator Care, ' + (customer.name || 'there') + '!\n\n' +
      'Thanks for signing up. Your subscription is active and we\'ve got everything we need on our end.\n\n' +
      'What happens next:\n' +
      '1. We\'ll reach out within the next few business days to schedule your first visit.\n' +
      '2. Our technicians will perform a full inspection and any included services per your plan.\n' +
      '3. From there, we\'ll auto-schedule your recurring visits.\n\n' +
      'Your plan: ' + planLabel + '\n' +
      (genLine ? 'Generator: ' + genLine + '\n' : '') +
      (addr ? 'Service address: ' + addr + '\n' : '') +
      (nextVisitDate ? 'First visit: ' + fmtDate(nextVisitDate) + ' (we will confirm time)\n' : '') +
      'Annual billing: ' + fmtMoney(annualPriceCents) + '/year\n' +
      (fleetMonitoring ? 'Add-on: Fleet Monitoring (Mobile Link)\n' : '') +
      '\nQuestions? Reply here or call (636) 464-3939.\n\n\u2014 Bates Electric';

    sgMail.setApiKey(SENDGRID_KEY);
    await sgMail.send({
      to: customer.email,
      from: { email: process.env.GENERATOR_DIGEST_FROM || 'no-reply@bates-electric.com', name: 'Bates Electric Generator Care' },
      subject: 'Welcome to Bates Electric Generator Care!',
      text: text,
      html: html,
    });
    console.log('[welcome-email] sent to ' + customer.email);
  } catch (err) {
    console.error('[welcome-email] error:', err && err.message);
  }
}


async function sendCardFailedEmail({ customer, amountCents, description }) {
  const SENDGRID_KEY = process.env.SENDGRID_API_KEY;
  if (!SENDGRID_KEY) {
    console.log('[card-failed-email] SENDGRID_API_KEY not set, skipping');
    return;
  }
  if (!customer || !customer.email || !customer.stripe_customer_id) {
    console.log('[card-failed-email] missing email or stripe_customer_id, skipping');
    return;
  }
  try {
    const portalSession = await stripePost('/billing_portal/sessions', {
      customer: customer.stripe_customer_id,
      return_url: 'https://app.bates-electric.com/home.html',
    });
    const portalUrl = portalSession.url;

    const fmtMoney = (c) => '$' + ((c || 0) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const amountLine = amountCents ? ' of ' + fmtMoney(amountCents) : '';
    const descLine = description ? ' for ' + description : '';

    const html = '<!DOCTYPE html>' +
      '<html><body style="margin:0;padding:0;background:#F4F6F9;font-family:system-ui,-apple-system,sans-serif;color:#1F3A5F;">' +
      '<div style="max-width:600px;margin:0 auto;background:#fff;">' +
      '<div style="background:#1F3A5F;padding:24px 28px;text-align:center;">' +
      '<h1 style="color:#fff;margin:0;font-size:22px;letter-spacing:0.5px;">Bates Electric</h1>' +
      '<p style="color:#DFE6F0;margin:6px 0 0;font-size:13px;letter-spacing:1px;text-transform:uppercase;">Generator Care</p>' +
      '</div>' +
      '<div style="padding:28px;">' +
      '<h2 style="margin:0 0 14px;font-size:20px;color:#1F3A5F;">Quick favor \u2014 your card didn\'t go through</h2>' +
      '<p style="margin:0 0 14px;line-height:1.55;color:#374151;">Hi ' + escHtml(customer.name || 'there') + ',</p>' +
      '<p style="margin:0 0 14px;line-height:1.55;color:#374151;">We tried to charge your card on file' + escHtml(amountLine) + escHtml(descLine) + ' and it didn\'t go through. Usually it\'s something simple \u2014 an expired card, a daily limit, or the bank flagging the charge.</p>' +
      '<p style="margin:0 0 14px;line-height:1.55;color:#374151;">You can update your card on file with one click:</p>' +
      '<p style="text-align:center;margin:24px 0;">' +
      '<a href="' + portalUrl + '" style="display:inline-block;background:#1F3A5F;color:#fff;text-decoration:none;padding:14px 28px;border-radius:6px;font-weight:600;font-size:15px;">Update your card</a>' +
      '</p>' +
      '<p style="margin:0 0 10px;color:#6B7280;font-size:13px;line-height:1.5;">The link is good for a few days. While you\'re in there you can also see your invoice history or update your contact info.</p>' +
      '<p style="margin:16px 0 0;color:#374151;font-size:14px;line-height:1.55;">If you\'d rather handle it over the phone or have any questions, just call us at <strong>(636) 464-3939</strong>.</p>' +
      '<p style="margin:18px 0 0;color:#6B7280;font-size:14px;">\u2014 The Bates Electric team</p>' +
      '</div>' +
      '<div style="background:#F4F6F9;padding:18px 28px;text-align:center;border-top:1px solid #E5E7EB;">' +
      '<p style="margin:0;font-size:12px;color:#6B7280;">Bates Electric, Inc. \u00b7 (636) 464-3939</p>' +
      '</div>' +
      '</div></body></html>';

    const text = 'Hi ' + (customer.name || 'there') + ',\n\n' +
      'We tried to charge your card on file' + amountLine + descLine + ' and it didn\'t go through. Usually it\'s something simple \u2014 expired card, daily limit, or the bank flagging the charge.\n\n' +
      'You can update your card here:\n' + portalUrl + '\n\n' +
      'If you\'d rather handle it over the phone, just call (636) 464-3939.\n\n' +
      '\u2014 Bates Electric';

    sgMail.setApiKey(SENDGRID_KEY);
    await sgMail.send({
      to: customer.email,
      from: { email: process.env.GENERATOR_DIGEST_FROM || 'no-reply@bates-electric.com', name: 'Bates Electric Generator Care' },
      subject: 'Your card on file needs an update',
      text,
      html,
    });
    console.log('[card-failed-email] sent to ' + customer.email);
  } catch (err) {
    console.error('[card-failed-email] error:', err && err.message);
  }
}

module.exports = router;
