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

// ---- the ONE invoice flow ------------------------------------------------
// Every batch/cart charge builds its invoice here: create -> one invoiceItem
// per line -> finalize -> pay. On any Stripe failure the half-built invoice is
// voided and { ok:false, reason } comes back — the CALLER resets its rows so a
// retry charges exactly once. Line metadata (addon_id / adhoc_charge_id) is
// what the invoice.paid webhook uses to mark rows charged and what
// lib/receipts.js itemizes on the one receipt.
async function payOneInvoice({ stripeCustomerId, pmId, description, invoiceMetadata, lines }) {
  let invoice;
  try {
    invoice = await stripe.invoices.create({
      customer: stripeCustomerId,
      collection_method: 'charge_automatically',
      default_payment_method: pmId,
      auto_advance: false,
      description,
      metadata: invoiceMetadata,
    });
    for (const l of lines) {
      await stripe.invoiceItems.create({
        customer: stripeCustomerId,
        invoice: invoice.id,
        amount: l.amount_cents,
        currency: 'usd',
        description: l.description,
        metadata: l.metadata,
      });
    }
    invoice = await stripe.invoices.finalizeInvoice(invoice.id);
    invoice = await stripe.invoices.pay(invoice.id);
    return { ok: true, invoice };
  } catch (stripeErr) {
    const reason = (stripeErr && (stripeErr.message || stripeErr.code)) || 'charge failed';
    if (invoice && invoice.id) { try { await stripe.invoices.voidInvoice(invoice.id); } catch (e) {} }
    return { ok: false, reason };
  }
}

// Payment-intent id off a paid invoice (string or expanded object).
function invoicePaymentIntentId(invoice) {
  return typeof invoice.payment_intent === 'string'
    ? invoice.payment_intent
    : (invoice.payment_intent && invoice.payment_intent.id) || null;
}

// Delete any pending at-renewal invoice items on add-on rows so nothing is
// billed twice. Returns null on success, or a structured 409 failure.
async function deleteStaleRenewalItems(addons) {
  for (const a of addons) {
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
  return null;
}

// Batch "charge performed add-ons" core: bill ALL performed-but-unbilled
// add-ons for the subscription in ONE invoice (one line per add-on -> one
// payment -> one itemized receipt). Behavior identical to the pre-refactor
// office route. customerId (optional) is the office IDOR guard; the tech
// route derives the subscription from its assignedVisit instead.
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

  const totalCents = billable.reduce((s, a) => s + a.amount_cents, 0);

  // 1. Card check first (don't disturb renewal items if there's no card).
  const pmId = await resolveSavedPaymentMethod(sub.stripe_subscription_id, sub.stripe_customer_id);
  if (!pmId) {
    const linkResult = await emailCardUpdateLinkForSub(sub.id);
    return {
      ok: false, status: 402, error: 'no saved card on file', reason: 'no saved card on file',
      cardUpdateEmailSent: !!(linkResult && linkResult.sent),
    };
  }

  // 2. Delete any pending at-renewal invoice items so nothing is billed twice.
  const staleFail = await deleteStaleRenewalItems(billable);
  if (staleFail) return staleFail;

  // 3. ONE invoice, one line item per add-on, then charge the card on file.
  const paid = await payOneInvoice({
    stripeCustomerId: sub.stripe_customer_id,
    pmId,
    description: 'Generator add-ons: ' + billable.map((a) => addonLabel(a.addon_type)).join(', '),
    invoiceMetadata: { addon_batch: '1', subscription_id: sub.id, addon_count: String(billable.length) },
    lines: billable.map((a) => ({
      amount_cents: a.amount_cents,
      description: 'Generator add-on: ' + addonLabel(a.addon_type),
      metadata: { addon_id: a.id, addon_type: a.addon_type, subscription_id: sub.id },
    })),
  });
  if (!paid.ok) {
    // Renewal items were deleted; leave the add-ons 'performed' (clear stale
    // item ids) so the batch can be retried and still charges exactly once.
    await supabaseAdmin.from('generator_pending_addons')
      .update({ stripe_invoice_item_id: null })
      .in('id', billable.map((a) => a.id));
    return { ok: false, status: 402, error: 'add-on charge failed', reason: paid.reason };
  }

  // 4. Mark all included add-ons charged against this one shared payment. (The
  //    invoice.paid webhook also marks them + sends the one itemized receipt.)
  const piId = invoicePaymentIntentId(paid.invoice);
  await supabaseAdmin.from('generator_pending_addons')
    .update({ status: 'charged', date_charged: today, stripe_payment_intent_id: piId, stripe_invoice_item_id: null })
    .in('id', billable.map((a) => a.id));

  return {
    ok: true,
    chargedCount: billable.length,
    totalCents,
    invoiceId: paid.invoice.id,
    lineItems: billable.map((a) => ({ addon_type: a.addon_type, label: addonLabel(a.addon_type), amount_cents: a.amount_cents })),
    customerName: (sub.customer && sub.customer.name) || 'customer',
  };
}

// The cart rows for a visit: pending custom charges built in the field (tech
// cart lines are status pending + billing_method immediate + this visit + not
// yet on any invoice). Renewal ad-hoc rows (which carry a
// stripe_invoice_item_id) and other visits' rows can never match.
async function getVisitCartCharges(subscriptionId, serviceVisitId) {
  const { data, error } = await supabaseAdmin
    .from('generator_adhoc_charges')
    .select('id, description, amount_cents, technician_id, created_at')
    .eq('subscription_id', subscriptionId)
    .eq('service_visit_id', serviceVisitId)
    .eq('status', 'pending')
    .eq('billing_method', 'immediate')
    .is('stripe_invoice_item_id', null)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data || [];
}

// Cart charge core (Phase 1.1): bill THIS visit's performed-but-unbilled
// catalog add-ons AND its pending custom charges together on ONE invoice ->
// one payment -> one itemized receipt. Scope is strictly the visit: renewal
// ad-hoc rows and other visits' rows are never swept in.
async function chargeVisitCart({ subscriptionId, serviceVisitId }) {
  const today = new Date().toISOString().slice(0, 10);

  const { data: sub, error: subErr } = await supabaseAdmin
    .from('generator_subscriptions')
    .select('id, customer_id, stripe_subscription_id, stripe_customer_id, customer:generator_customers(name)')
    .eq('id', subscriptionId)
    .single();
  if (subErr) throw subErr;
  if (!sub) return { ok: false, status: 404, error: 'subscription not found' };
  if (!sub.stripe_customer_id || !sub.stripe_subscription_id) {
    return { ok: false, status: 400, error: 'no Stripe subscription linked' };
  }

  const { data: addons, error: addErr } = await supabaseAdmin
    .from('generator_pending_addons')
    .select('id, addon_type, amount_cents, stripe_invoice_item_id')
    .eq('subscription_id', subscriptionId)
    .eq('service_visit_id', serviceVisitId)
    .eq('status', 'performed');
  if (addErr) throw addErr;
  const billableAddons = (addons || []).filter((a) => a.amount_cents && a.amount_cents > 0);

  const customs = await getVisitCartCharges(subscriptionId, serviceVisitId);

  if (!billableAddons.length && !customs.length) {
    return { ok: false, status: 400, error: 'nothing to charge' };
  }

  const lineItems = [
    ...billableAddons.map((a) => ({ label: addonLabel(a.addon_type), amount_cents: a.amount_cents })),
    ...customs.map((c) => ({ label: c.description, amount_cents: c.amount_cents })),
  ];
  const totalCents = lineItems.reduce((s, l) => s + l.amount_cents, 0);

  // 1. Card check first (don't disturb renewal items if there's no card).
  const pmId = await resolveSavedPaymentMethod(sub.stripe_subscription_id, sub.stripe_customer_id);
  if (!pmId) {
    const linkResult = await emailCardUpdateLinkForSub(sub.id);
    return {
      ok: false, status: 402, error: 'no saved card on file', reason: 'no saved card on file',
      cardUpdateEmailSent: !!(linkResult && linkResult.sent),
    };
  }

  // 2. Same double-billing guard as the batch core (add-on rows only — cart
  //    customs are is-null-filtered on stripe_invoice_item_id already).
  const staleFail = await deleteStaleRenewalItems(billableAddons);
  if (staleFail) return staleFail;

  // 3. ONE invoice: a line per add-on + a line per custom charge. Metadata is
  //    what the invoice.paid webhook keys on to mark BOTH tables' rows.
  const paid = await payOneInvoice({
    stripeCustomerId: sub.stripe_customer_id,
    pmId,
    description: 'Generator service charges: ' + lineItems.map((l) => l.label).join(', '),
    invoiceMetadata: { visit_cart: '1', subscription_id: sub.id, service_visit_id: serviceVisitId, line_count: String(lineItems.length) },
    lines: [
      ...billableAddons.map((a) => ({
        amount_cents: a.amount_cents,
        description: 'Generator add-on: ' + addonLabel(a.addon_type),
        metadata: { addon_id: a.id, addon_type: a.addon_type, subscription_id: sub.id },
      })),
      ...customs.map((c) => ({
        amount_cents: c.amount_cents,
        description: c.description,
        metadata: { adhoc_charge_id: c.id, subscription_id: sub.id },
      })),
    ],
  });
  if (!paid.ok) {
    // Leave every row uncharged for a clean retry that charges exactly once
    // (add-ons stay 'performed', customs stay 'pending'); clear the deleted
    // renewal item ids like the batch core.
    if (billableAddons.length) {
      await supabaseAdmin.from('generator_pending_addons')
        .update({ stripe_invoice_item_id: null })
        .in('id', billableAddons.map((a) => a.id));
    }
    return { ok: false, status: 402, error: 'charge failed', reason: paid.reason };
  }

  // 4. Mark BOTH tables' rows charged against the one shared payment
  //    (belt-and-suspenders — the invoice.paid webhook also marks by line
  //    metadata; both writes are idempotent).
  const piId = invoicePaymentIntentId(paid.invoice);
  if (billableAddons.length) {
    await supabaseAdmin.from('generator_pending_addons')
      .update({ status: 'charged', date_charged: today, stripe_payment_intent_id: piId, stripe_invoice_item_id: null })
      .in('id', billableAddons.map((a) => a.id));
  }
  if (customs.length) {
    await supabaseAdmin.from('generator_adhoc_charges')
      .update({ status: 'charged', date_charged: today, stripe_payment_intent_id: piId })
      .in('id', customs.map((c) => c.id));
  }

  return {
    ok: true,
    totalCents,
    lineItems,
    invoiceId: paid.invoice.id,
    chargedAddonCount: billableAddons.length,
    chargedCustomCount: customs.length,
    customerName: (sub.customer && sub.customer.name) || 'customer',
  };
}

module.exports = {
  chargeAdhocImmediate,
  chargePerformedAddonsForSub,
  chargeVisitCart,
  getVisitCartCharges,
  getOpenVisitId,
  addonLabel,
};
