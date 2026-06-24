// backend/lib/receipts.js
// Build + send OUR state-branded receipt for a paid Stripe invoice. Shared by the
// invoice.paid webhook and the dashboard "Resend receipt" action so both use the
// exact same data path + builder (buildReceiptEmail) — branded by the customer's
// CURRENT install_state and sent to their CURRENT email. Real charge data only
// (actual amount paid, date, card last-4, description, receipt number); never plan
// defaults, so a $0.99 promo charge reads $0.99.

const { supabaseAdmin: supabase } = require('./supabase');
const { buildReceiptEmail, sendEmail } = require('./emails');
const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

async function sendReceiptEmail(invoice) {
  try {
    if (!invoice || !invoice.customer) return { sent: false, reason: 'no customer' };
    const amountCents = typeof invoice.amount_paid === 'number' ? invoice.amount_paid : 0;
    if (amountCents <= 0) {
      console.log('[receipt-email] amount_paid is 0, skipping');
      return { sent: false, reason: 'zero amount' };
    }

    const stripeCustomerId = typeof invoice.customer === 'string'
      ? invoice.customer
      : (invoice.customer && invoice.customer.id);

    // Only generator customers are in our table; non-generator invoices won't match.
    const { data: customer, error: custErr } = await supabase
      .from('generator_customers')
      .select('name, email, install_state')
      .eq('stripe_customer_id', stripeCustomerId)
      .maybeSingle();
    if (custErr) {
      console.error('[receipt-email] customer lookup error:', custErr.message);
      return { sent: false, reason: 'lookup error' };
    }
    if (!customer || !customer.email) {
      console.log('[receipt-email] no matching customer or email, skipping');
      return { sent: false, reason: 'no customer email' };
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

    // Description from invoice line items (e.g. "Generator Care — Annual" / "Add-on: …").
    const lineDescs = ((invoice.lines && invoice.lines.data) || [])
      .map((l) => l.description).filter(Boolean);
    const description = lineDescs.length ? lineDescs.join('; ') : 'Generator Care';
    const receiptNumber = invoice.number || invoice.receipt_number || invoice.id || null;

    const { subject, html, text } = buildReceiptEmail({
      customer,
      companyState: customer.install_state,
      amountCents,
      paidDate,
      cardBrand,
      cardLast4,
      description,
      receiptNumber,
    });
    return sendEmail({ to: customer.email, subject, html, text, logTag: '[receipt-email]', companyState: customer.install_state });
  } catch (e) {
    console.error('[receipt-email] build/send error:', e && e.message);
    return { sent: false, reason: 'error' };
  }
}

module.exports = { sendReceiptEmail };
