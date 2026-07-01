// backend/lib/gcShared.js
// Shared plumbing for the Generator Care office routers
// (backend/routes/generator-care/*): the one Stripe client, the refund
// helpers, saved-card resolution, and the card-update-link email flow. Moved
// verbatim from the former single-file routes/generator-care.js.

const Stripe = require('stripe');
const { supabaseAdmin } = require('./supabase');
const { sendEmail, buildCardUpdateLinkEmail } = require('./emails');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ===== REFUND HELPERS (shared by /addons/:id/refund + /adhoc-charges/:id/refund) =====

// Refund against a payment_intent OR a charge. originalAmountCents is the full
// charge; alreadyRefundedCents (default 0) lets callers cap a partial top-up to
// the remaining balance. requestedAmountCents omitted = refund the remainder.
async function executeStripeRefund({ paymentIntentId, chargeId, originalAmountCents, alreadyRefundedCents = 0, requestedAmountCents, reason, metadata }) {
  const maxRefundable = originalAmountCents - (alreadyRefundedCents || 0);
  const refundAmount = requestedAmountCents || maxRefundable;
  if (!Number.isInteger(refundAmount) || refundAmount <= 0 || refundAmount > maxRefundable) {
    throw new Error(`refund amount must be between 1 cent and $${(maxRefundable/100).toFixed(2)}`);
  }
  const params = {
    amount: refundAmount,
    reason: 'requested_by_customer',
    metadata: { ...(reason ? { bates_reason: String(reason).slice(0, 500) } : {}), ...(metadata || {}) },
  };
  if (paymentIntentId) params.payment_intent = paymentIntentId;
  else if (chargeId) params.charge = chargeId;
  else throw new Error('no payment_intent or charge to refund against');
  const refund = await stripe.refunds.create(params);
  return { refund, refundAmount };
}

// Structured marker the frontend parses to render "Refunded" / "Partial refund" badges.
function buildRefundNote(refundAmountCents, originalAmountCents, reason, stripeRefundId) {
  const today = new Date().toISOString().slice(0, 10);
  const isPartial = refundAmountCents < originalAmountCents;
  const amtPart = isPartial
    ? `$${(refundAmountCents/100).toFixed(2)} of $${(originalAmountCents/100).toFixed(2)}`
    : `$${(refundAmountCents/100).toFixed(2)}`;
  let note = `REFUNDED ${amtPart} on ${today}`;
  if (reason) note += `: ${reason}`;
  note += ` (stripe_refund_id: ${stripeRefundId})`;
  return note;
}

// Sum of prior refunds recorded in a row's notes (mirrors the frontend parser).
// Lets the addon/adhoc refund endpoints cap a second partial refund server-side
// instead of relying solely on Stripe rejecting an over-refund.
function parseRefundedFromNotes(notes) {
  if (!notes) return 0;
  let total = 0;
  for (const m of String(notes).matchAll(/REFUNDED \$(\d+(?:\.\d+)?)/g)) {
    total += Math.round(parseFloat(m[1]) * 100);
  }
  return total;
}

// ---- Send "manage your account" email with portal link ----
async function sendCardUpdateLinkEmail({ name, email, portalUrl, companyState }) {
  const { subject, html, text } = buildCardUpdateLinkEmail({ name, portalUrl, companyState });
  return sendEmail({
    to: email,
    subject,
    html,
    text,
    logTag: '[card-update-link]',
    companyState,
  });
}

// Resolve which saved card to charge for an off-session payment. Stripe Checkout
// attaches the card as the SUBSCRIPTION's default_payment_method but does not
// always set the CUSTOMER's invoice_settings default, so a bare
// paymentIntents.create({ customer, confirm }) finds no payment method and fails
// with "missing a payment method". Try, in order: subscription default ->
// customer invoice-settings default -> first saved card. Returns a pm id or null.
async function resolveSavedPaymentMethod(stripeSubscriptionId, stripeCustomerId) {
  if (stripeSubscriptionId) {
    try {
      const subObj = await stripe.subscriptions.retrieve(stripeSubscriptionId);
      const pm = subObj && subObj.default_payment_method;
      if (pm) return typeof pm === 'string' ? pm : pm.id;
    } catch (e) {
      console.error('[adhoc-charge] subscription retrieve failed:', e && e.message);
    }
  }
  try {
    const cust = await stripe.customers.retrieve(stripeCustomerId);
    const pm = cust && cust.invoice_settings && cust.invoice_settings.default_payment_method;
    if (pm) return typeof pm === 'string' ? pm : pm.id;
  } catch (e) {
    console.error('[adhoc-charge] customer retrieve failed:', e && e.message);
  }
  try {
    const list = await stripe.paymentMethods.list({ customer: stripeCustomerId, type: 'card', limit: 1 });
    if (list && list.data && list.data.length) return list.data[0].id;
  } catch (e) {
    console.error('[adhoc-charge] paymentMethods.list failed:', e && e.message);
  }
  return null;
}

// Create a Customer Portal session for a subscription and email the card-update
// link to the customer (same flow as POST /subscriptions/:id/portal-session).
// Used when an off-session charge can't find a card. Returns { sent, reason }.
async function emailCardUpdateLinkForSub(subscriptionId) {
  try {
    const { data: sub } = await supabaseAdmin
      .from('generator_subscriptions')
      .select('stripe_customer_id, customer:generator_customers(name, email, install_state)')
      .eq('id', subscriptionId)
      .single();
    if (!sub || !sub.stripe_customer_id) return { sent: false, reason: 'no stripe customer' };
    const email = sub.customer && sub.customer.email;
    if (!email) return { sent: false, reason: 'no email on file' };
    const session = await stripe.billingPortal.sessions.create({
      customer: sub.stripe_customer_id,
      return_url: 'https://app.bates-electric.com/generator-care.html',
    });
    return await sendCardUpdateLinkEmail({
      name: (sub.customer && sub.customer.name) || null,
      email,
      portalUrl: session.url,
      companyState: (sub.customer && sub.customer.install_state) || null,
    });
  } catch (e) {
    console.error('[adhoc-charge] emailCardUpdateLinkForSub failed:', e && e.message);
    return { sent: false, reason: e && e.message };
  }
}

module.exports = {
  stripe,
  executeStripeRefund,
  buildRefundNote,
  parseRefundedFromNotes,
  sendCardUpdateLinkEmail,
  resolveSavedPaymentMethod,
  emailCardUpdateLinkForSub,
};
