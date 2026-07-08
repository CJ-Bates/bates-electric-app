// backend/lib/receipts.js
// Build + send OUR state-branded receipt for a paid Stripe invoice. Shared by the
// invoice.paid webhook and the dashboard "Resend receipt" action so both use the
// exact same data path + builder (buildReceiptEmail) — branded by the customer's
// CURRENT install_state and sent to their CURRENT email. Real charge data only
// (actual amount paid, date, card last-4, description, receipt number); never plan
// defaults, so a $0.99 promo charge reads $0.99.
//
// Reliability rules (the receipt is the customer's ONLY payment document):
//   * Signup race: on a brand-new signup Stripe often delivers invoice.paid
//     BEFORE our customer.subscription.created handler has inserted the customer
//     row. When the DB lookup misses and the invoice is fresh, the recipient is
//     built from Stripe data instead (receiptRecipientFromStripe) so webhook
//     ordering can't cost a customer their receipt.
//   * Never silent: every non-benign miss or send failure goes through
//     reportError (console + Sentry + alert email). Benign skips ($0 invoices,
//     already-sent dedupe, non-generator invoices) stay console-only.
//   * Exactly once: the webhook path ({ dedupe: true }) checks/stamps
//     receipt_sent_at on the Stripe invoice's metadata, so a retried delivery
//     can't double-send. Office/customer resends bypass the guard on purpose —
//     a resend is an intentional re-send.

const { supabaseAdmin: supabase } = require('./supabase');
const { buildReceiptEmail, sendEmail } = require('./emails');
const { reportError } = require('../middleware/error-reporter');
const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// How fresh an invoice must be for the "customer not in DB yet" fallback. The
// subscription.created handler normally lands within seconds of invoice.paid;
// 10 minutes is generous without letting genuinely stale invoices (whose DB
// miss is a data problem, not a race) quietly take the fallback path.
const SIGNUP_RACE_WINDOW_MS = 10 * 60 * 1000;

// Pure assembly of the receipt recipient from Stripe objects, for when the
// invoice beats our DB insert (signup race). Exported for unit tests.
// install_state comes from the signup metadata create-checkout puts on the
// SUBSCRIPTION (subscription_data.metadata.install_state); when unavailable,
// null falls through to the default Bates Electric (MO) branding downstream —
// a receipt with default branding beats no receipt at all.
function receiptRecipientFromStripe({ invoice, subscription, stripeCustomer }) {
  const subMeta = (subscription && subscription.metadata) || {};
  const email = (invoice && invoice.customer_email)
    || (stripeCustomer && stripeCustomer.email)
    || null;
  if (!email) return null;
  const name = (invoice && invoice.customer_name)
    || (stripeCustomer && stripeCustomer.name)
    || subMeta.customer_name
    || email;
  return { name, email, install_state: subMeta.install_state || null };
}

// DB miss. Decide: signup race (build recipient from Stripe), non-generator
// invoice (benign skip, matches old behavior), or a generator invoice we truly
// can't send for (alert — this used to be the silent "skipping" path).
async function resolveMissingCustomer(invoice, alert) {
  const subId = typeof invoice.subscription === 'string'
    ? invoice.subscription
    : (invoice.subscription && invoice.subscription.id);

  let subscription = null;
  if (subId) {
    try {
      subscription = await stripe.subscriptions.retrieve(subId);
    } catch (e) {
      console.error('[receipt-email] subscription lookup failed:', e && e.message);
      // Can't tell if this is a generator invoice — failing silent here is the
      // exact bug this path exists to kill, so alert.
      await alert(`subscription ${subId} lookup failed for invoice ${invoice.id} — cannot determine receipt recipient, receipt NOT sent`);
      return null;
    }
  }

  const isGenerator = !!(subscription && subscription.metadata && subscription.metadata.gen_class);
  if (subscription && !isGenerator) {
    // A real subscription with no gen_class metadata is not Generator Care:
    // same benign skip as before.
    console.log('[receipt-email] no matching customer or email, skipping (not a generator subscription)');
    return null;
  }
  if (!subscription) {
    // No subscription at all (standalone invoice) + no DB customer. Add-on and
    // ad-hoc invoices are only ever created for customers already in our DB, so
    // this shouldn't happen for generator activity — alert rather than skip.
    await alert(`invoice ${invoice.id} has no subscription and no matching DB customer — receipt NOT sent`);
    return null;
  }

  const ageMs = Date.now() - (invoice.created || 0) * 1000;
  if (ageMs > SIGNUP_RACE_WINDOW_MS) {
    // Generator invoice whose customer is missing long after signup: a data
    // problem, not a webhook race — alert, don't silently skip.
    await alert(`generator invoice ${invoice.id} has no matching DB customer (invoice is ${Math.round(ageMs / 60000)} min old) — receipt NOT sent`);
    return null;
  }

  // Signup race confirmed: invoice.paid beat subscription.created. The invoice
  // usually carries customer_email/customer_name; fetch the Stripe customer
  // only when it doesn't.
  let stripeCustomer = null;
  if (!invoice.customer_email) {
    try {
      const custId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer.id;
      stripeCustomer = await stripe.customers.retrieve(custId);
    } catch (e) {
      console.error('[receipt-email] stripe customer lookup failed:', e && e.message);
    }
  }
  const recipient = receiptRecipientFromStripe({ invoice, subscription, stripeCustomer });
  if (!recipient) {
    await alert(`signup-race fallback found no email anywhere for generator invoice ${invoice.id} — receipt NOT sent`);
    return null;
  }
  console.log(`[receipt-email] customer not in DB yet (signup race) — building receipt from Stripe data for invoice ${invoice.id}`);
  return recipient;
}

// opts.dedupe — webhook path only: skip if this invoice already has a receipt
//               stamped, and stamp it after a confirmed send.
// opts.source — label for alert context (which caller failed).
async function sendReceiptEmail(invoice, opts = {}) {
  const { dedupe = false, source = 'resend' } = opts;
  const alert = (message) => reportError(
    new Error(message),
    { route: `receipt-email (${source})`, method: 'POST', user: 'system' }
  ).catch(() => {});

  try {
    if (!invoice || !invoice.customer) return { sent: false, reason: 'no customer' };
    const amountCents = typeof invoice.amount_paid === 'number' ? invoice.amount_paid : 0;
    if (amountCents <= 0) {
      console.log('[receipt-email] amount_paid is 0, skipping');
      return { sent: false, reason: 'zero amount' };
    }

    // Dedupe guard: a retried webhook delivery carries a stale event snapshot,
    // so read the CURRENT invoice metadata. Fails open — if the check itself
    // errors, we still send (a rare duplicate beats a missing receipt).
    if (dedupe && invoice.id) {
      try {
        const fresh = await stripe.invoices.retrieve(invoice.id);
        if (fresh && fresh.metadata && fresh.metadata.receipt_sent_at) {
          console.log(`[receipt-email] receipt already sent for ${invoice.id} at ${fresh.metadata.receipt_sent_at}, skipping`);
          return { sent: false, reason: 'already sent' };
        }
      } catch (e) {
        console.error('[receipt-email] dedupe check failed (sending anyway):', e && e.message);
      }
    }

    const stripeCustomerId = typeof invoice.customer === 'string'
      ? invoice.customer
      : (invoice.customer && invoice.customer.id);

    // Only generator customers are in our table; non-generator invoices won't match.
    let { data: customer, error: custErr } = await supabase
      .from('generator_customers')
      .select('name, email, install_state')
      .eq('stripe_customer_id', stripeCustomerId)
      .maybeSingle();
    if (custErr) {
      console.error('[receipt-email] customer lookup error:', custErr.message);
      await alert(`receipt customer lookup failed for invoice ${invoice.id}: ${custErr.message}`);
      return { sent: false, reason: 'lookup error' };
    }
    if (!customer || !customer.email) {
      customer = await resolveMissingCustomer(invoice, alert);
      if (!customer) return { sent: false, reason: 'no customer email' };
    }

    const paidTs = (invoice.status_transitions && invoice.status_transitions.paid_at) || invoice.created;
    const paidDate = paidTs ? new Date(paidTs * 1000).toISOString().slice(0, 10) : null;

    // Card brand + last-4 from the settling charge (best-effort enrichment).
    let cardBrand = null;
    let cardLast4 = null;
    try {
      const chargeId = typeof invoice.charge === 'string' ? invoice.charge : (invoice.charge && invoice.charge.id);
      if (chargeId) {
        const ch = await stripe.charges.retrieve(chargeId);
        const card = ch && ch.payment_method_details && ch.payment_method_details.card;
        if (card) { cardBrand = card.brand || null; cardLast4 = card.last4 || null; }
      }
    } catch (e) {
      console.error('[receipt-email] charge lookup failed:', e && e.message);
    }

    // Line items (e.g. "Generator Care — Annual", or one row per add-on on a
    // combined charge). lineItems drives itemized receipts; description is the
    // single-line fallback.
    const invoiceLines = (invoice.lines && invoice.lines.data) || [];
    const lineItems = invoiceLines
      .filter((l) => l && l.description)
      .map((l) => ({ description: l.description, amountCents: typeof l.amount === 'number' ? l.amount : 0 }));
    const description = lineItems.length ? lineItems.map((li) => li.description).join('; ') : 'Generator Care';
    // Only a real invoice/receipt number — no invoice.id fallback (a raw in_… would
    // render as "Receipt #" once Stripe's account-level receipt is off). Null omits it.
    const receiptNumber = invoice.number || invoice.receipt_number || null;

    const { subject, html, text } = buildReceiptEmail({
      customer,
      companyState: customer.install_state,
      amountCents,
      paidDate,
      cardBrand,
      cardLast4,
      description,
      receiptNumber,
      lineItems,
    });
    const result = await sendEmail({ to: customer.email, subject, html, text, logTag: '[receipt-email]', companyState: customer.install_state });

    if (result && result.sent) {
      if (dedupe && invoice.id) {
        // Stamp AFTER a confirmed send. Stripe merges metadata keys on update,
        // so this can't clobber other invoice metadata. Best-effort: a failed
        // stamp only risks a duplicate on retry, never a missing receipt.
        try {
          await stripe.invoices.update(invoice.id, { metadata: { receipt_sent_at: new Date().toISOString() } });
        } catch (e) {
          console.error('[receipt-email] failed to stamp receipt_sent_at:', e && e.message);
        }
      }
    } else {
      // The mailer's {sent:false} (e.g. the Jun 30 "Maximum credits exceeded"
      // SendGrid-cap failures) used to be console-only — never again.
      await alert(`receipt email send FAILED for invoice ${invoice.id} to ${customer.email}: ${(result && result.reason) || 'unknown'}`);
    }
    return result;
  } catch (e) {
    console.error('[receipt-email] build/send error:', e && e.message);
    await alert(`receipt build/send error for invoice ${invoice && invoice.id}: ${e && e.message}`);
    return { sent: false, reason: 'error' };
  }
}

module.exports = { sendReceiptEmail, receiptRecipientFromStripe };
