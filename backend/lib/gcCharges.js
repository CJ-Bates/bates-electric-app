// backend/lib/gcCharges.js
// The ONE place money moves for Generator Care add-on/ad-hoc charges. Both the
// office routes (routes/generator-care/charges.js, addons.js) and the tech
// routes (routes/generator-tech.js) call these cores, so field and office
// charges are provably the same flow: same card resolution, same
// insert-then-charge idempotency, same failure handling (record failed + email
// the customer a card-update link, never partial/double charge).
//
// Cores return structured results instead of writing to `res` — each route maps
// them onto its own response shape (the office routes keep their exact
// pre-refactor bodies; the tech routes keep Stripe ids out of tech-facing JSON).
//   { ok: true, ... }                                 — charged
//   { ok: false, status, error, reason?, ... }        — map to res.status(status)
// Unexpected errors (DB down, etc.) THROW — callers keep their catch -> 500.

const { supabaseAdmin } = require('./supabase');
const catalog = require('./generator-catalog');
const {
  stripe,
  resolveSavedPaymentMethod,
  emailCardUpdateLinkForSub,
} = require('./gcShared');

const addonLabel = (t) =>
  (catalog.ADDON_CATALOG[t] && catalog.ADDON_CATALOG[t].label) || (t || 'add-on').replace(/_/g, ' ');

// The current OPEN visit new/active add-on rows belong to (the cycle): earliest
// not-completed, not-canceled visit; null if none. Shared by the office
// add-addon route and the tech menu/add/standing endpoints so every surface
// agrees on which visit is "this cycle".
async function getOpenVisitId(subscriptionId) {
  const { data } = await supabaseAdmin
    .from('generator_service_visits')
    .select('id')
    .eq('subscription_id', subscriptionId)
    .is('completed_date', null)
    .neq('status', 'canceled')
    .order('scheduled_date', { ascending: true, nullsFirst: false })
    .limit(1)
    .maybeSingle();
  return data ? data.id : null;
}

// Immediate ad-hoc charge core: insert the row as 'pending', resolve the saved
// card, charge it off-session, mark charged/failed. Verbatim extraction of the
// office adhoc-charge 'immediate' branch; technicianId (tech-initiated charges)
// is recorded on the row for provenance.
async function chargeAdhocImmediate({
  subscriptionId, description, amountCents,
  serviceVisitId = null, datePerformed = null, technicianId = null,
}) {
  const { data: sub, error: subErr } = await supabaseAdmin
    .from('generator_subscriptions')
    .select('id, stripe_subscription_id, stripe_customer_id, status, customer:generator_customers(name, email)')
    .eq('id', subscriptionId)
    .single();
  if (subErr) throw subErr;
  if (!sub) return { ok: false, status: 404, error: 'subscription not found' };
  if (!sub.stripe_customer_id) return { ok: false, status: 400, error: 'no Stripe customer linked' };

  const today = new Date().toISOString().slice(0, 10);
  const customerName = (sub.customer && sub.customer.name) || 'customer';
  const customerEmail = (sub.customer && sub.customer.email) || null;
  const stripeDescription = 'Bates Electric: ' + description.trim();

  // 1. Insert the row first as 'pending' (insert-then-charge idempotency: a
  //    crash after this point leaves an auditable row, never an untracked charge).
  const { data: row, error: insErr } = await supabaseAdmin
    .from('generator_adhoc_charges')
    .insert({
      subscription_id: subscriptionId,
      service_visit_id: serviceVisitId || null,
      description: description.trim(),
      amount_cents: amountCents,
      billing_method: 'immediate',
      status: 'pending',
      date_performed: datePerformed || today,
      technician_id: technicianId || null,
    })
    .select()
    .single();
  if (insErr) throw insErr;

  // 2. Resolve which saved card to charge — a bare paymentIntents.create can't
  //    find the card Checkout attached to the subscription.
  const paymentMethodId = await resolveSavedPaymentMethod(sub.stripe_subscription_id, sub.stripe_customer_id);
  if (!paymentMethodId) {
    await supabaseAdmin
      .from('generator_adhoc_charges')
      .update({ status: 'failed', notes: 'Charge failed on ' + today + ': no saved card on file' })
      .eq('id', row.id);
    const linkResult = await emailCardUpdateLinkForSub(subscriptionId);
    return {
      ok: false, status: 402, error: 'charge failed', reason: 'no saved card on file',
      adhocChargeId: row.id, cardUpdateEmailSent: !!(linkResult && linkResult.sent),
    };
  }

  let intent;
  try {
    intent = await stripe.paymentIntents.create({
      customer: sub.stripe_customer_id,
      amount: amountCents,
      currency: 'usd',
      payment_method: paymentMethodId,
      payment_method_types: ['card'],
      off_session: true,
      confirm: true,
      description: stripeDescription,
      // Stripe's automatic receipts for raw PaymentIntents key off receipt_email.
      ...(customerEmail ? { receipt_email: customerEmail } : {}),
      metadata: {
        adhoc_charge_id: row.id,
        subscription_id: subscriptionId,
        customer_name: customerName,
      },
    });
  } catch (stripeErr) {
    // Off-session charges can fail with authentication_required (3DS) or card
    // errors. Record FAILED with the message; the charge is never retried
    // automatically.
    const reason = stripeErr.message || stripeErr.code || 'unknown_error';
    await supabaseAdmin
      .from('generator_adhoc_charges')
      .update({ status: 'failed', notes: 'Charge failed on ' + today + ': ' + reason })
      .eq('id', row.id);
    return { ok: false, status: 402, error: 'charge failed', reason, adhocChargeId: row.id };
  }

  const { data: updated, error: updErr } = await supabaseAdmin
    .from('generator_adhoc_charges')
    .update({ status: 'charged', date_charged: today, stripe_payment_intent_id: intent.id })
    .eq('id', row.id)
    .select()
    .single();
  if (updErr) throw updErr;
  return { ok: true, adhocCharge: updated, paymentIntentId: intent.id, customerName };
}

// Batch "charge performed add-ons" core: bill ALL performed-but-unbilled
// add-ons for the subscription in ONE invoice (one line per add-on -> one
// payment -> one itemized receipt). Verbatim extraction of the office route.
// customerId (optional) is the office IDOR guard; the tech route derives the
// subscription from its assignedVisit instead.
async function chargePerformedAddonsForSub({ subscriptionId, customerId = null }) {
  const today = new Date().toISOString().slice(0, 10);

  const { data: sub, error: subErr } = await supabaseAdmin
    .from('generator_subscriptions')
    .select('id, customer_id, stripe_subscription_id, stripe_customer_id, customer:generator_customers(name)')
    .eq('id', subscriptionId)
    .single();
  if (subErr) throw subErr;
  if (!sub) return { ok: false, status: 404, error: 'subscription not found' };
  if (customerId && sub.customer_id !== customerId) {
    return { ok: false, status: 403, error: 'subscription does not belong to that customer' };
  }
  if (!sub.stripe_customer_id || !sub.stripe_subscription_id) {
    return { ok: false, status: 400, error: 'no Stripe subscription linked' };
  }

  const { data: addons, error: addErr } = await supabaseAdmin
    .from('generator_pending_addons')
    .select('id, addon_type, amount_cents, stripe_invoice_item_id')
    .eq('subscription_id', subscriptionId)
    .eq('status', 'performed');
  if (addErr) throw addErr;
  const billable = (addons || []).filter((a) => a.amount_cents && a.amount_cents > 0);
  if (!billable.length) return { ok: false, status: 400, error: 'no performed add-ons to charge' };

  const stripeCustomerId = sub.stripe_customer_id;
  const totalCents = billable.reduce((s, a) => s + a.amount_cents, 0);
  const descSummary = 'Generator add-ons: ' + billable.map((a) => addonLabel(a.addon_type)).join(', ');

  // 1. Card check first (don't disturb renewal items if there's no card).
  const pmId = await resolveSavedPaymentMethod(sub.stripe_subscription_id, stripeCustomerId);
  if (!pmId) {
    const linkResult = await emailCardUpdateLinkForSub(sub.id);
    return {
      ok: false, status: 402, error: 'no saved card on file', reason: 'no saved card on file',
      cardUpdateEmailSent: !!(linkResult && linkResult.sent),
    };
  }

  // 2. Delete any pending at-renewal invoice items so nothing is billed twice.
  for (const a of billable) {
    if (a.stripe_invoice_item_id) {
      try {
        await stripe.invoiceItems.del(a.stripe_invoice_item_id);
      } catch (delErr) {
        return {
          ok: false, status: 409,
          error: 'One of these add-ons is already on an invoice (billed at renewal); not charging again. Use the refund control if needed.',
          reason: delErr.message,
        };
      }
    }
  }

  // 3. ONE invoice, one line item per add-on, then charge the card on file.
  let invoice;
  try {
    invoice = await stripe.invoices.create({
      customer: stripeCustomerId,
      collection_method: 'charge_automatically',
      default_payment_method: pmId,
      auto_advance: false,
      description: descSummary,
      metadata: { addon_batch: '1', subscription_id: sub.id, addon_count: String(billable.length) },
    });
    for (const a of billable) {
      await stripe.invoiceItems.create({
        customer: stripeCustomerId,
        invoice: invoice.id,
        amount: a.amount_cents,
        currency: 'usd',
        description: 'Generator add-on: ' + addonLabel(a.addon_type),
        metadata: { addon_id: a.id, addon_type: a.addon_type, subscription_id: sub.id },
      });
    }
    invoice = await stripe.invoices.finalizeInvoice(invoice.id);
    invoice = await stripe.invoices.pay(invoice.id);
  } catch (stripeErr) {
    const reason = (stripeErr && (stripeErr.message || stripeErr.code)) || 'charge failed';
    if (invoice && invoice.id) { try { await stripe.invoices.voidInvoice(invoice.id); } catch (e) {} }
    // Items were deleted; leave the add-ons 'performed' (clear stale item ids) so
    // the batch can be retried and still charges exactly once.
    await supabaseAdmin.from('generator_pending_addons')
      .update({ stripe_invoice_item_id: null })
      .in('id', billable.map((a) => a.id));
    return { ok: false, status: 402, error: 'add-on charge failed', reason };
  }

  // 4. Mark all included add-ons charged against this one shared payment. (The
  //    invoice.paid webhook also marks them + sends the one itemized receipt.)
  const piId = typeof invoice.payment_intent === 'string'
    ? invoice.payment_intent
    : (invoice.payment_intent && invoice.payment_intent.id) || null;
  await supabaseAdmin.from('generator_pending_addons')
    .update({ status: 'charged', date_charged: today, stripe_payment_intent_id: piId, stripe_invoice_item_id: null })
    .in('id', billable.map((a) => a.id));

  return {
    ok: true,
    chargedCount: billable.length,
    totalCents,
    invoiceId: invoice.id,
    lineItems: billable.map((a) => ({ addon_type: a.addon_type, label: addonLabel(a.addon_type), amount_cents: a.amount_cents })),
    customerName: (sub.customer && sub.customer.name) || 'customer',
  };
}

module.exports = { chargeAdhocImmediate, chargePerformedAddonsForSub, getOpenVisitId, addonLabel };
