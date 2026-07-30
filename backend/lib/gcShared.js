// backend/lib/gcShared.js
// Shared plumbing for the Generator Care office routers
// (backend/routes/generator-care/*): the one Stripe client, the refund
// helpers, saved-card resolution, and the card-update-link email flow. Moved
// verbatim from the former single-file routes/generator-care.js.

const Stripe = require('stripe');
const { supabaseAdmin } = require('./supabase');
const { sendEmail, buildCardUpdateLinkEmail } = require('./emails');
const { STRIPE_CLIENT_OPTIONS } = require('./stripeConfig');

// The one office/tech/cron Stripe client (everything imports `stripe` from
// here). Options — API version pin + the 20s reliability timeout — live in
// lib/stripeConfig.js so the receipts + webhook clients share them verbatim.
// Basil (2025-03-31+) removed Invoice.payment_intent / Invoice.charge — paid
// invoices surface their payment through the `payments` list instead; the
// resolvers below handle both generations.
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, STRIPE_CLIENT_OPTIONS);

// The PaymentIntent id inside an InvoicePayment list ({ data: [...] }).
// Prefers paid entries (Basil allows multiple partial payments; ours have
// exactly one — the default payment created at finalization).
function paymentIntentIdFromPayments(payments) {
  const data = (payments && payments.data) || [];
  const ranked = [...data.filter((p) => p && p.status === 'paid'), ...data];
  for (const p of ranked) {
    const pi = p && p.payment && p.payment.payment_intent;
    if (pi) return typeof pi === 'string' ? pi : pi.id || null;
  }
  return null;
}

// Payment-intent id of a paid invoice, across API generations: pre-Basil
// top-level payment_intent -> Basil payments list (present when the invoice
// was fetched with expand:['payments']) -> the invoice_payments endpoint.
// Never throws (callers run after money has already moved).
async function resolveInvoicePaymentIntentId(invoice) {
  if (!invoice) return null;
  const legacy = typeof invoice.payment_intent === 'string'
    ? invoice.payment_intent
    : (invoice.payment_intent && invoice.payment_intent.id) || null;
  if (legacy) return legacy;
  const inline = paymentIntentIdFromPayments(invoice.payments);
  if (inline) return inline;
  if (!invoice.id) return null;
  try {
    const payments = await stripe.invoicePayments.list({ invoice: invoice.id, limit: 100 });
    return paymentIntentIdFromPayments(payments);
  } catch (e) {
    console.error('[gc-shared] invoicePayments.list failed for', invoice.id, '-', e && e.message);
    return null;
  }
}

// The settling charge behind a PaymentIntent (throws on API failure — callers
// that must not fail wrap it).
async function retrievePaymentIntentCharge(paymentIntentId) {
  const pi = await stripe.paymentIntents.retrieve(paymentIntentId, { expand: ['latest_charge'] });
  const ch = pi && pi.latest_charge;
  return ch && typeof ch === 'object' ? ch : null;
}

// The settling charge of a paid invoice (amounts/refund state/card), across
// API generations: legacy expanded invoice.charge -> PaymentIntent's
// latest_charge. Returns the charge OBJECT or null; never throws.
async function resolveInvoiceCharge(invoice) {
  if (!invoice) return null;
  if (invoice.charge && typeof invoice.charge === 'object') return invoice.charge;
  const piId = await resolveInvoicePaymentIntentId(invoice);
  if (!piId) return null;
  try {
    return await retrievePaymentIntentCharge(piId);
  } catch (e) {
    console.error('[gc-shared] latest_charge resolve failed for', invoice.id, '-', e && e.message);
    return null;
  }
}

// Display line items of an invoice ({ description, amount_cents }), for the
// office dashboard's per-invoice breakdown (a bundled cart charge — add-on +
// custom on ONE invoice — otherwise reads as separate money). All lines,
// capped; the frontend decides when a breakdown is worth showing.
const INVOICE_LINE_ITEMS_MAX = 10;
function invoiceLineItems(invoice) {
  const lines = (invoice && invoice.lines && invoice.lines.data) || [];
  return lines.slice(0, INVOICE_LINE_ITEMS_MAX).map((l) => ({
    description: (l && l.description) || null,
    amount_cents: (l && l.amount) || 0,
  }));
}

// Resolve the PaymentIntent for a charged row that predates the Basil
// PI-capture fix (stripe_payment_intent_id null): scan the customer's paid
// invoices for the line item carrying this row's id in its metadata (the same
// metadata the invoice.paid webhook keys on), then resolve that invoice's
// PaymentIntent. Returns pi_... or null; never throws.
async function findChargedRowPaymentIntent({ stripeCustomerId, metadataKey, rowId }) {
  if (!stripeCustomerId || !metadataKey || !rowId) return null;
  try {
    const invoices = await stripe.invoices.list({ customer: stripeCustomerId, status: 'paid', limit: 100, expand: ['data.payments'] });
    for (const inv of (invoices && invoices.data) || []) {
      const lines = (inv.lines && inv.lines.data) || [];
      if (lines.some((l) => l && l.metadata && l.metadata[metadataKey] === rowId)) {
        return await resolveInvoicePaymentIntentId(inv);
      }
    }
  } catch (e) {
    console.error('[gc-shared] charged-row PI lookup failed for', rowId, '-', e && e.message);
  }
  return null;
}

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

// Authoritative refund state for a charged addon/adhoc row. The row's notes
// only record refunds issued through the per-row endpoints — a refund made at
// the invoice level or straight from the Stripe dashboard never annotates the
// row, so the notes figure under-counts in exactly the cases the over-refund
// guard exists for. Read the actual refunded total off the Stripe charge
// behind the row's PaymentIntent and use the stricter figure.
//
// One Stripe charge can settle SEVERAL rows (a bundled cart = one payment,
// multiple lines), so charge.amount_refunded is the refund total for the whole
// PAYMENT, not necessarily this row:
//   - payment amount <= row amount -> the payment IS this row; the charge's
//     refunded total is the row's refunded total (never below notes).
//   - payment amount >  row amount -> bundled; per-row attribution is
//     ambiguous, so keep the row-attributed notes figure but never allow a
//     refund past the payment's remaining refundable balance.
// A Stripe read failure degrades to the notes-only figure (a transient API
// error must not block a legitimate refund) and logs loudly — degrading can
// only relax the guard back to its pre-Stripe-check behavior, never below it.
async function resolveRowRefundState({ paymentIntentId, rowAmountCents, notesRefundedCents }) {
  const notes = notesRefundedCents || 0;
  let charge = null;
  try {
    charge = await retrievePaymentIntentCharge(paymentIntentId);
  } catch (e) {
    console.error('[gc-shared] refund guard could not read the charge for', paymentIntentId,
      '- degrading to the row-notes figure:', e && e.message);
  }
  if (!charge || !Number.isInteger(charge.amount)) {
    return {
      stripeChecked: false,
      bundledPayment: false,
      alreadyRefundedCents: notes,
      maxRefundableCents: Math.max(0, rowAmountCents - notes),
      paymentAmountCents: null,
      paymentRefundedCents: null,
    };
  }
  const paymentAmountCents = charge.amount;
  const paymentRefundedCents = charge.amount_refunded || 0;
  const paymentRemainingCents = Math.max(0, paymentAmountCents - paymentRefundedCents);
  const bundledPayment = paymentAmountCents > rowAmountCents;
  const alreadyRefundedCents = bundledPayment ? notes : Math.max(paymentRefundedCents, notes);
  return {
    stripeChecked: true,
    bundledPayment,
    alreadyRefundedCents,
    maxRefundableCents: Math.min(Math.max(0, rowAmountCents - alreadyRefundedCents), paymentRemainingCents),
    paymentAmountCents,
    paymentRefundedCents,
  };
}

// Plain-language 400 message when a refund request exceeds what is still
// refundable, or null when the request is fine. requestedCents null/undefined
// means "refund the row's remainder". Malformed amounts (non-integer, <= 0)
// are left for executeStripeRefund's own validation message.
function refundBlockedMessage(state, rowAmountCents, requestedCents) {
  const fmt = (c) => '$' + ((c || 0) / 100).toFixed(2);
  const refundedSoFar = state.bundledPayment
    ? fmt(state.paymentRefundedCents) + ' of the original ' + fmt(state.paymentAmountCents)
      + ' payment has already been refunded (this charge was bundled with others into one payment)'
    : fmt(state.alreadyRefundedCents) + ' of this ' + fmt(rowAmountCents) + ' charge has already been refunded';
  if (state.maxRefundableCents <= 0) {
    return 'already refunded: ' + refundedSoFar + '; nothing is left to refund';
  }
  const wanted = (requestedCents === undefined || requestedCents === null)
    ? Math.max(0, rowAmountCents - state.alreadyRefundedCents)
    : requestedCents;
  if (Number.isInteger(wanted) && wanted > state.maxRefundableCents) {
    return 'refund exceeds the remaining balance: ' + refundedSoFar
      + '; up to ' + fmt(state.maxRefundableCents) + ' can still be refunded';
  }
  return null;
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
  paymentIntentIdFromPayments,
  resolveInvoicePaymentIntentId,
  retrievePaymentIntentCharge,
  resolveInvoiceCharge,
  resolveRowRefundState,
  refundBlockedMessage,
  invoiceLineItems,
  findChargedRowPaymentIntent,
  executeStripeRefund,
  buildRefundNote,
  parseRefundedFromNotes,
  sendCardUpdateLinkEmail,
  resolveSavedPaymentMethod,
  emailCardUpdateLinkForSub,
};
