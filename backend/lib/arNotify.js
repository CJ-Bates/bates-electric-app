// backend/lib/arNotify.js
// Internal Accounts Receivable notice for every Generator Care MONEY event,
// driven by the Stripe webhooks so nothing is missed:
//
//   invoice.paid               -> "Payment received"  (signup, renewal, tier
//                                 change difference, batched add-ons, Fleet
//                                 Monitoring proration, cart charges)
//   payment_intent.succeeded   -> "Payment received"  (ad-hoc IMMEDIATE charges
//                                 are raw PaymentIntents, not invoices — see
//                                 lib/gcCharges.js chargeAdhocImmediate)
//   charge.refunded            -> "Refund issued"     (full or partial)
//   invoice.payment_failed     -> "Payment FAILED"    (clearly marked; AR must
//                                 not post it)
//
// AR (Ally) is not a Stripe user; this email is her only view of Generator
// Care money, which she posts in Jonas. We do NOT invoice generator customers
// (the card already paid), so the notice never asks anyone to invoice.
//
// Rules (every path):
//   * Never throws, never blocks: the customer receipt and the webhook's 200
//     do not depend on this. A send failure is logged AND reported through
//     reportError (Sentry + alert email); the webhook still succeeds.
//   * Idempotent per Stripe event: the same metadata-stamp pattern as
//     lib/receipts.js (read the CURRENT object, skip if stamped, stamp only
//     after a confirmed send). Fails open: a rare duplicate beats a missing
//     notice that AR would never know to ask about.
//   * The customer receipt is untouched. This is an additional internal email.

const { supabaseAdmin: supabase } = require('./supabase');
const emails = require('./emails');
const catalog = require('./generator-catalog');
const { reportError } = require('../middleware/error-reporter');
const { stripe, resolveInvoiceCharge } = require('./gcShared');

// Accounts Receivable mailbox. AR_EMAIL is the documented var (.env.example);
// GENERATOR_AR_EMAIL is honored for anyone who still has the pre-June-30 name.
const AR_EMAIL = process.env.AR_EMAIL || process.env.GENERATOR_AR_EMAIL || 'AR@bates-electric.com';
const LOG_TAG = '[ar-payment-notice]';

// Dedupe metadata keys (one per event family). The failed-payment key holds
// the invoice's attempt_count, so each distinct failed attempt notifies once
// while a redelivery of the same attempt does not.
const STAMP = {
  invoicePaid: 'ar_notice_sent_at',
  paymentIntent: 'ar_notice_sent_at',
  refund: 'ar_refund_notice_sent_at',
  failedAttempt: 'ar_failed_notice_attempt',
};

const CENTRAL_FMT = {
  timeZone: 'America/Chicago', month: 'short', day: 'numeric', year: 'numeric',
  hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
};
function whenLabelFromUnix(seconds) {
  if (!seconds) return null;
  return new Date(seconds * 1000).toLocaleString('en-US', CENTRAL_FMT);
}
function planLabelFor(plan) {
  return plan === 'semi_annual' ? 'Semi-Annual' : (plan === 'annual' ? 'Annual' : (plan || null));
}
function periodEndDate(stripeSub) {
  if (!stripeSub) return null;
  const items = (stripeSub.items && stripeSub.items.data) || [];
  const end = stripeSub.current_period_end || (items[0] && items[0].current_period_end) || null;
  return end ? new Date(end * 1000).toISOString().slice(0, 10) : null;
}
function idOf(ref) {
  return typeof ref === 'string' ? ref : (ref && ref.id) || null;
}
// Basil invoice lines carry the price under pricing.price_details.price; older
// payloads under line.price.id. Returns the price id or null.
function linePriceId(line) {
  if (!line) return null;
  if (line.price) return idOf(line.price);
  const pd = line.pricing && line.pricing.price_details;
  return (pd && idOf(pd.price)) || null;
}

// ---------------------------------------------------------------------------
// Context: who the money belongs to. Prefers our DB rows (name, service
// address, Jonas WO#), with Stripe as the fallback for the signup race
// (invoice.paid routinely lands BEFORE customer.subscription.created has
// inserted the rows; the notice must still go out, and WO# reads "not created
// yet", which is exactly true for a brand-new signup).
//
// Returns null for activity that is not Generator Care (no DB customer AND
// no gen_class on the Stripe subscription), a benign skip.
// ---------------------------------------------------------------------------
async function loadContext({ stripeCustomerId, stripeSubscriptionId, dbSubscriptionId }) {
  let customer = null;
  if (stripeCustomerId) {
    const { data, error } = await supabase
      .from('generator_customers')
      .select('id, name, email, phone, install_address, install_city, install_state, install_zip')
      .eq('stripe_customer_id', stripeCustomerId)
      .maybeSingle();
    if (error) console.error(`${LOG_TAG} customer lookup error:`, error.message);
    customer = data || null;
  }

  const SUB_COLS = 'id, plan, gen_class, fleet_monitoring, work_order_number, status, stripe_subscription_id, customer_id';
  let sub = null;
  if (stripeSubscriptionId) {
    const { data, error } = await supabase
      .from('generator_subscriptions').select(SUB_COLS)
      .eq('stripe_subscription_id', stripeSubscriptionId).maybeSingle();
    if (error) console.error(`${LOG_TAG} subscription lookup error:`, error.message);
    sub = data || null;
  }
  if (!sub && dbSubscriptionId) {
    const { data, error } = await supabase
      .from('generator_subscriptions').select(SUB_COLS)
      .eq('id', dbSubscriptionId).maybeSingle();
    if (error) console.error(`${LOG_TAG} subscription lookup error:`, error.message);
    sub = data || null;
  }
  if (!sub && customer) {
    // Fall back to the customer's most recent subscription (WO# + plan).
    const { data, error } = await supabase
      .from('generator_subscriptions').select(SUB_COLS)
      .eq('customer_id', customer.id)
      .order('created_at', { ascending: false }).limit(1).maybeSingle();
    if (error) console.error(`${LOG_TAG} subscription fallback lookup error:`, error.message);
    sub = data || null;
  }

  // Live Stripe subscription: next renewal date, and the signup-race fallback
  // for identity (create-checkout puts the service address in its metadata).
  let stripeSub = null;
  const stripeSubId = stripeSubscriptionId || (sub && sub.stripe_subscription_id) || null;
  if (stripeSubId) {
    try {
      stripeSub = await stripe.subscriptions.retrieve(stripeSubId);
    } catch (e) {
      console.error(`${LOG_TAG} stripe subscription lookup failed:`, e && e.message);
    }
  }
  const meta = (stripeSub && stripeSub.metadata) || {};

  if (!customer) {
    if (!meta.gen_class && !sub) return null; // not Generator Care activity
    let stripeCust = null;
    if (stripeCustomerId) {
      try { stripeCust = await stripe.customers.retrieve(stripeCustomerId); } catch (e) {
        console.error(`${LOG_TAG} stripe customer lookup failed:`, e && e.message);
      }
    }
    customer = {
      id: null,
      name: meta.customer_name || (stripeCust && stripeCust.name) || (stripeCust && stripeCust.email) || 'Customer',
      email: (stripeCust && stripeCust.email) || '',
      phone: meta.customer_phone || (stripeCust && stripeCust.phone) || '',
      install_address: meta.install_address || '',
      install_city: meta.install_city || '',
      install_state: meta.install_state || '',
      install_zip: meta.install_zip || '',
    };
  }

  return {
    customer,
    sub,
    stripeSub,
    workOrderNumber: (sub && sub.work_order_number) || null,
    planLabel: planLabelFor((sub && sub.plan) || meta.plan || null),
    renewalDate: periodEndDate(stripeSub),
  };
}

// ---------------------------------------------------------------------------
// Classification of a paid invoice into AR's "Type" line. Pure; exported for
// tests. Stripe's billing_reason covers the subscription-driven cases; our own
// invoice/line metadata (lib/gcCharges.js, lib/planChange.js) covers the rest.
// ---------------------------------------------------------------------------
function classifyInvoice(invoice) {
  const lines = (invoice && invoice.lines && invoice.lines.data) || [];
  const md = (invoice && invoice.metadata) || {};
  const hasAddon = lines.some((l) => l && l.metadata && l.metadata.addon_id);
  const hasAdhoc = lines.some((l) => l && l.metadata && l.metadata.adhoc_charge_id);
  const hasFleet = lines.some((l) => { const p = linePriceId(l); return p && catalog.isFleetPriceId(p); });
  switch (invoice && invoice.billing_reason) {
    case 'subscription_create': return 'Signup';
    case 'subscription_cycle': return 'Renewal';
    case 'subscription_update': return hasFleet ? 'Fleet Monitoring (proration)' : 'Other (subscription change)';
    default:
      if (md.tier_change) return 'Tier change';
      if (hasAddon && hasAdhoc) return 'Add-on charge + ad-hoc service charge';
      if (hasAddon) return 'Add-on charge';
      if (hasAdhoc) return 'Other (ad-hoc service charge)';
      return hasFleet ? 'Fleet Monitoring' : 'Other';
  }
}

function invoiceLines(invoice) {
  return ((invoice && invoice.lines && invoice.lines.data) || [])
    .filter((l) => l && l.description)
    .map((l) => ({ description: l.description, amountCents: typeof l.amount === 'number' ? l.amount : 0 }));
}

// ---------------------------------------------------------------------------
// Dedupe helpers (metadata stamps on the Stripe object). Both fail open.
// ---------------------------------------------------------------------------
async function readStamp(resource, id, key) {
  if (!id) return null;
  try {
    const fresh = await stripe[resource].retrieve(id);
    return (fresh && fresh.metadata && fresh.metadata[key]) || null;
  } catch (e) {
    console.error(`${LOG_TAG} dedupe check failed for ${id} (sending anyway):`, e && e.message);
    return null;
  }
}
async function writeStamp(resource, id, key, value) {
  if (!id) return;
  try {
    await stripe[resource].update(id, { metadata: { [key]: value } });
  } catch (e) {
    console.error(`${LOG_TAG} failed to stamp ${key} on ${id}:`, e && e.message);
  }
}

// Send to AR. Never throws. A {sent:false} from the mailer is reported (Sentry
// + alert email) so a Brevo outage can't silently starve AR of notices.
async function deliver({ built, ref, ctx, log }) {
  const result = await emails.sendEmail({
    to: AR_EMAIL, subject: built.subject, html: built.html, text: built.text,
    logTag: LOG_TAG, log: log || {},
  });
  if (!result || !result.sent) {
    await reportError(
      new Error(`AR payment notice send FAILED for ${ref} to ${AR_EMAIL}: ${(result && result.reason) || 'unknown'}`),
      ctx
    ).catch(() => {});
  }
  return result || { sent: false, reason: 'unknown' };
}

function errCtx(eventType) {
  return { route: `/webhooks/stripe (${eventType}) ar-notice`, method: 'POST', user: 'stripe-webhook' };
}

function stripStatementPrefix(description, fallback) {
  // "Bates Electric: <what>" is the Stripe statement description we set on
  // ad-hoc PaymentIntents; AR only needs the <what>.
  return String(description || fallback).replace(/^Bates Electric:\s*/i, '');
}

// ---------------------------------------------------------------------------
// invoice.paid -> Payment received
// ---------------------------------------------------------------------------
async function notifyArInvoicePaid(invoice) {
  const ctx = errCtx('invoice.paid');
  try {
    if (!invoice || !invoice.customer) return { sent: false, reason: 'no customer' };
    const amountCents = typeof invoice.amount_paid === 'number' ? invoice.amount_paid : 0;
    if (amountCents <= 0) return { sent: false, reason: 'zero amount' };

    const stamped = await readStamp('invoices', invoice.id, STAMP.invoicePaid);
    if (stamped) {
      console.log(`${LOG_TAG} already sent for invoice ${invoice.id} at ${stamped}, skipping`);
      return { sent: false, reason: 'already sent' };
    }

    const md = invoice.metadata || {};
    const context = await loadContext({
      stripeCustomerId: idOf(invoice.customer),
      stripeSubscriptionId: idOf(invoice.subscription),
      dbSubscriptionId: md.subscription_id || null,
    });
    if (!context) {
      console.log(`${LOG_TAG} invoice ${invoice.id} is not Generator Care activity, skipping`);
      return { sent: false, reason: 'not generator' };
    }

    let cardBrand = null; let cardLast4 = null; let chargeId = null; let receiptNumber = null;
    try {
      const ch = await resolveInvoiceCharge(invoice);
      if (ch) {
        chargeId = ch.id || null;
        receiptNumber = ch.receipt_number || null;
        const card = ch.payment_method_details && ch.payment_method_details.card;
        if (card) { cardBrand = card.brand || null; cardLast4 = card.last4 || null; }
      }
    } catch (e) {
      console.error(`${LOG_TAG} charge lookup failed:`, e && e.message);
    }

    const paidTs = (invoice.status_transitions && invoice.status_transitions.paid_at) || invoice.created;
    const built = emails.buildArPaymentNoticeEmail({
      kind: 'paid',
      customer: context.customer,
      workOrderNumber: context.workOrderNumber,
      chargeType: classifyInvoice(invoice),
      lineItems: invoiceLines(invoice),
      amountCents,
      whenLabel: whenLabelFromUnix(paidTs),
      cardBrand, cardLast4,
      receiptNumber,
      invoiceNumber: invoice.number || null,
      chargeId,
      planLabel: context.planLabel,
      renewalDate: context.renewalDate,
    });
    const result = await deliver({
      built, ref: `invoice ${invoice.id}`, ctx,
      log: { customerId: context.customer.id || null, subscriptionId: (context.sub && context.sub.id) || null },
    });
    if (result.sent) await writeStamp('invoices', invoice.id, STAMP.invoicePaid, new Date().toISOString());
    return result;
  } catch (e) {
    console.error(`${LOG_TAG} invoice.paid build/send error:`, e && e.message);
    await reportError(new Error(`AR payment notice error for invoice ${invoice && invoice.id}: ${e && e.message}`), ctx).catch(() => {});
    return { sent: false, reason: 'error' };
  }
}

// ---------------------------------------------------------------------------
// payment_intent.succeeded -> Payment received (ad-hoc immediate charges only)
// Invoice-backed PaymentIntents are skipped here: invoice.paid covers them.
// ---------------------------------------------------------------------------
async function notifyArPaymentIntentSucceeded(pi) {
  const ctx = errCtx('payment_intent.succeeded');
  try {
    if (!pi || !pi.customer) return { sent: false, reason: 'no customer' };
    if (pi.invoice) return { sent: false, reason: 'invoice-backed (covered by invoice.paid)' };
    const md = pi.metadata || {};
    if (!md.adhoc_charge_id) return { sent: false, reason: 'not a generator ad-hoc charge' };
    const amountCents = typeof pi.amount_received === 'number' ? pi.amount_received : (pi.amount || 0);
    if (amountCents <= 0) return { sent: false, reason: 'zero amount' };

    const stamped = await readStamp('paymentIntents', pi.id, STAMP.paymentIntent);
    if (stamped) {
      console.log(`${LOG_TAG} already sent for payment intent ${pi.id} at ${stamped}, skipping`);
      return { sent: false, reason: 'already sent' };
    }

    const context = await loadContext({ stripeCustomerId: idOf(pi.customer), dbSubscriptionId: md.subscription_id || null });
    if (!context) return { sent: false, reason: 'not generator' };

    let cardBrand = null; let cardLast4 = null; let receiptNumber = null;
    const chargeId = idOf(pi.latest_charge);
    if (chargeId) {
      try {
        const ch = typeof pi.latest_charge === 'object' ? pi.latest_charge : await stripe.charges.retrieve(chargeId);
        receiptNumber = (ch && ch.receipt_number) || null;
        const card = ch && ch.payment_method_details && ch.payment_method_details.card;
        if (card) { cardBrand = card.brand || null; cardLast4 = card.last4 || null; }
      } catch (e) {
        console.error(`${LOG_TAG} charge lookup failed:`, e && e.message);
      }
    }

    const description = stripStatementPrefix(pi.description, 'Ad-hoc service charge');
    const built = emails.buildArPaymentNoticeEmail({
      kind: 'paid',
      customer: context.customer,
      workOrderNumber: context.workOrderNumber,
      chargeType: 'Other (ad-hoc service charge)',
      lineItems: [{ description, amountCents }],
      amountCents,
      whenLabel: whenLabelFromUnix(pi.created),
      cardBrand, cardLast4,
      receiptNumber,
      chargeId,
      paymentIntentId: pi.id,
      planLabel: context.planLabel,
      renewalDate: context.renewalDate,
    });
    const result = await deliver({
      built, ref: `payment intent ${pi.id}`, ctx,
      log: { customerId: context.customer.id || null, subscriptionId: (context.sub && context.sub.id) || null },
    });
    if (result.sent) await writeStamp('paymentIntents', pi.id, STAMP.paymentIntent, new Date().toISOString());
    return result;
  } catch (e) {
    console.error(`${LOG_TAG} payment_intent.succeeded build/send error:`, e && e.message);
    await reportError(new Error(`AR payment notice error for payment intent ${pi && pi.id}: ${e && e.message}`), ctx).catch(() => {});
    return { sent: false, reason: 'error' };
  }
}

// ---------------------------------------------------------------------------
// charge.refunded -> Refund issued (full or partial). Keyed on the REFUND
// object (a later partial refund of the same charge is a new event and gets
// its own notice).
// ---------------------------------------------------------------------------
async function notifyArChargeRefunded(charge) {
  const ctx = errCtx('charge.refunded');
  try {
    if (!charge || !charge.customer) return { sent: false, reason: 'no customer' };

    let latestRefund = null;
    if (charge.refunds && Array.isArray(charge.refunds.data) && charge.refunds.data.length) {
      latestRefund = charge.refunds.data[0];
    } else {
      try {
        const refunds = await stripe.refunds.list({ charge: charge.id, limit: 1 });
        latestRefund = refunds && refunds.data && refunds.data[0];
      } catch (e) {
        console.error(`${LOG_TAG} refund lookup failed:`, e && e.message);
      }
    }
    const amountCents = (latestRefund && typeof latestRefund.amount === 'number')
      ? latestRefund.amount
      : (typeof charge.amount_refunded === 'number' ? charge.amount_refunded : 0);
    if (amountCents <= 0) return { sent: false, reason: 'zero amount' };
    const refundId = (latestRefund && latestRefund.id) || null;

    const stamped = await readStamp('refunds', refundId, STAMP.refund);
    if (stamped) {
      console.log(`${LOG_TAG} already sent for refund ${refundId} at ${stamped}, skipping`);
      return { sent: false, reason: 'already sent' };
    }

    // What was refunded: the original invoice when there is one (number +
    // subscription), else the PaymentIntent's metadata (ad-hoc immediate).
    let invoice = null;
    const invoiceId = idOf(charge.invoice);
    if (invoiceId) {
      try { invoice = await stripe.invoices.retrieve(invoiceId); } catch (e) {
        console.error(`${LOG_TAG} original invoice lookup failed:`, e && e.message);
      }
    }
    const chargeMeta = charge.metadata || {};
    const context = await loadContext({
      stripeCustomerId: idOf(charge.customer),
      stripeSubscriptionId: invoice ? idOf(invoice.subscription) : null,
      dbSubscriptionId: (invoice && invoice.metadata && invoice.metadata.subscription_id) || chargeMeta.subscription_id || null,
    });
    if (!context) {
      console.log(`${LOG_TAG} refund on charge ${charge.id} is not Generator Care activity, skipping`);
      return { sent: false, reason: 'not generator' };
    }

    const isPartial = typeof charge.amount === 'number' && amountCents < charge.amount;
    const card = charge.payment_method_details && charge.payment_method_details.card;
    const refundedWhat = invoice ? classifyInvoice(invoice) : stripStatementPrefix(charge.description, 'charge');
    const lineItems = invoice
      ? invoiceLines(invoice)
      : [{ description: refundedWhat, amountCents: typeof charge.amount === 'number' ? charge.amount : amountCents }];

    const built = emails.buildArPaymentNoticeEmail({
      kind: 'refund',
      customer: context.customer,
      workOrderNumber: context.workOrderNumber,
      chargeType: refundedWhat,
      lineItems,
      amountCents,
      isPartial,
      whenLabel: whenLabelFromUnix((latestRefund && latestRefund.created) || charge.created),
      cardBrand: (card && card.brand) || null,
      cardLast4: (card && card.last4) || null,
      receiptNumber: charge.receipt_number || null,
      originalInvoiceNumber: (invoice && invoice.number) || null,
      chargeId: charge.id,
      paymentIntentId: idOf(charge.payment_intent),
      planLabel: context.planLabel,
      renewalDate: context.renewalDate,
    });
    const result = await deliver({
      built, ref: `refund ${refundId || charge.id}`, ctx,
      log: { customerId: context.customer.id || null, subscriptionId: (context.sub && context.sub.id) || null },
    });
    if (result.sent) await writeStamp('refunds', refundId, STAMP.refund, new Date().toISOString());
    return result;
  } catch (e) {
    console.error(`${LOG_TAG} charge.refunded build/send error:`, e && e.message);
    await reportError(new Error(`AR refund notice error for charge ${charge && charge.id}: ${e && e.message}`), ctx).catch(() => {});
    return { sent: false, reason: 'error' };
  }
}

// ---------------------------------------------------------------------------
// invoice.payment_failed -> Payment FAILED (not collected). Once per failed
// ATTEMPT: Stripe retries a failing renewal several times over days, each a
// genuine new failure; a redelivery of the same attempt is deduped.
// ---------------------------------------------------------------------------
async function notifyArInvoicePaymentFailed(invoice) {
  const ctx = errCtx('invoice.payment_failed');
  try {
    if (!invoice || !invoice.customer) return { sent: false, reason: 'no customer' };
    const amountCents = typeof invoice.amount_due === 'number' ? invoice.amount_due : 0;
    const attempt = String(invoice.attempt_count || 1);

    const stamped = await readStamp('invoices', invoice.id, STAMP.failedAttempt);
    if (stamped === attempt) {
      console.log(`${LOG_TAG} failed-payment notice already sent for invoice ${invoice.id} attempt ${attempt}, skipping`);
      return { sent: false, reason: 'already sent' };
    }

    const md = invoice.metadata || {};
    const context = await loadContext({
      stripeCustomerId: idOf(invoice.customer),
      stripeSubscriptionId: idOf(invoice.subscription),
      dbSubscriptionId: md.subscription_id || null,
    });
    if (!context) return { sent: false, reason: 'not generator' };

    const reason = (invoice.last_finalization_error && invoice.last_finalization_error.message)
      || (invoice.charge && typeof invoice.charge === 'object' && invoice.charge.failure_message)
      || 'Card payment failed';
    const built = emails.buildArPaymentNoticeEmail({
      kind: 'failed',
      customer: context.customer,
      workOrderNumber: context.workOrderNumber,
      chargeType: classifyInvoice(invoice),
      lineItems: invoiceLines(invoice),
      amountCents,
      whenLabel: whenLabelFromUnix(Math.floor(Date.now() / 1000)),
      failureReason: `${reason} (attempt ${attempt})`,
      invoiceNumber: invoice.number || null,
      planLabel: context.planLabel,
      renewalDate: context.renewalDate,
    });
    const result = await deliver({
      built, ref: `failed invoice ${invoice.id} attempt ${attempt}`, ctx,
      log: { customerId: context.customer.id || null, subscriptionId: (context.sub && context.sub.id) || null },
    });
    if (result.sent) await writeStamp('invoices', invoice.id, STAMP.failedAttempt, attempt);
    return result;
  } catch (e) {
    console.error(`${LOG_TAG} invoice.payment_failed build/send error:`, e && e.message);
    await reportError(new Error(`AR failed-payment notice error for invoice ${invoice && invoice.id}: ${e && e.message}`), ctx).catch(() => {});
    return { sent: false, reason: 'error' };
  }
}

// ---------------------------------------------------------------------------
// Admin Tools sample: render the notice with fixture data so AR can confirm
// delivery/format without a real charge. kinds: payment_mo, payment_fl,
// refund, failed.
// ---------------------------------------------------------------------------
const SAMPLE_KINDS = ['payment_mo', 'payment_fl', 'refund', 'failed'];
function buildSampleArNotice(kind) {
  if (!SAMPLE_KINDS.includes(kind)) return null;
  const fl = kind === 'payment_fl';
  const customer = fl
    ? { name: 'Sample Customer (FL)', email: 'sample@example.com', phone: '(727) 555-0142', install_address: '88 Gulf Breeze Dr', install_city: 'Clearwater', install_state: 'FL', install_zip: '33767' }
    : { name: 'Sample Customer', email: 'sample@example.com', phone: '(636) 555-0199', install_address: '123 Main St', install_city: 'Imperial', install_state: 'MO', install_zip: '63052' };
  const common = {
    customer,
    workOrderNumber: kind === 'failed' ? null : 'WO-20461',
    cardBrand: 'visa', cardLast4: '4242',
    planLabel: 'Annual', renewalDate: '2027-06-18',
    whenLabel: whenLabelFromUnix(Math.floor(Date.now() / 1000)),
  };
  const addonLines = [
    { description: 'Generator add-on: Exterior Wash', amountCents: 8500 },
    { description: 'Generator add-on: ATS + Outage Test', amountCents: 11000 },
  ];
  if (kind === 'refund') {
    return emails.buildArPaymentNoticeEmail({
      ...common, kind: 'refund', chargeType: 'Add-on charge', isPartial: true,
      lineItems: addonLines,
      amountCents: 8500, receiptNumber: '2041-7788', originalInvoiceNumber: 'A1B2C3D4-0007',
      chargeId: 'ch_SAMPLE000000000000', paymentIntentId: 'pi_SAMPLE000000000000',
    });
  }
  if (kind === 'failed') {
    return emails.buildArPaymentNoticeEmail({
      ...common, kind: 'failed', chargeType: 'Renewal',
      lineItems: [{ description: 'Air Cooled Generator Care — Annual', amountCents: 39500 }],
      amountCents: 39500, failureReason: 'Your card was declined. (attempt 1)', invoiceNumber: 'A1B2C3D4-0009',
    });
  }
  return emails.buildArPaymentNoticeEmail({
    ...common, kind: 'paid', chargeType: 'Add-on charge',
    lineItems: addonLines,
    amountCents: 19500, receiptNumber: '2041-7788', invoiceNumber: 'A1B2C3D4-0007', chargeId: 'ch_SAMPLE000000000000',
  });
}

module.exports = {
  AR_EMAIL,
  notifyArInvoicePaid,
  notifyArPaymentIntentSucceeded,
  notifyArChargeRefunded,
  notifyArInvoicePaymentFailed,
  buildSampleArNotice,
  SAMPLE_KINDS,
  // Pure helpers, exported for unit tests.
  classifyInvoice,
  loadContext,
};
