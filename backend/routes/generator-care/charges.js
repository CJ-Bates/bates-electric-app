// backend/routes/generator-care/charges.js
// Money movement outside the plan price: ad-hoc charges (immediate or bill-at-
// renewal), their cancel/refund, and refunds of paid subscription invoices.
// Auth (requireAuth + office role) is applied by ./index.js.

const express = require('express');
const { supabaseAdmin } = require('../../lib/supabase');
const {
  stripe,
  resolveSavedPaymentMethod,
  emailCardUpdateLinkForSub,
  executeStripeRefund,
  buildRefundNote,
  parseRefundedFromNotes,
} = require('../../lib/gcShared');

const router = express.Router();

// POST /api/generator-care/subscriptions/:id/adhoc-charge
// Add an ad-hoc charge to a subscription for non-program work.
// Body: { description, amount_cents, billing_method: 'immediate' | 'renewal', service_visit_id?, date_performed? }
// 'immediate': charges the saved card now via PaymentIntent (off-session).
// 'renewal':   adds a Stripe invoice item that bills at next subscription renewal.
router.post('/subscriptions/:id/adhoc-charge', async (req, res) => {
  try {
    const { id } = req.params;
    const { description, amount_cents, billing_method, service_visit_id, date_performed } = req.body || {};

    // Validate
    if (!description || !description.trim()) {
      return res.status(400).json({ error: 'description required' });
    }
    if (!amount_cents || !Number.isInteger(amount_cents) || amount_cents <= 0) {
      return res.status(400).json({ error: 'amount_cents must be a positive integer' });
    }
    if (!['immediate', 'renewal'].includes(billing_method)) {
      return res.status(400).json({ error: "billing_method must be 'immediate' or 'renewal'" });
    }

    const { data: sub, error: subErr } = await supabaseAdmin
      .from('generator_subscriptions')
      .select('id, stripe_subscription_id, stripe_customer_id, status, customer:generator_customers(name, email)')
      .eq('id', id)
      .single();
    if (subErr) throw subErr;
    if (!sub) return res.status(404).json({ error: 'subscription not found' });
    if (sub.status === 'canceled' && billing_method === 'renewal') {
      return res.status(400).json({ error: 'subscription is canceled; no future renewal to bill against. Use billing_method=immediate.' });
    }
    if (!sub.stripe_customer_id) {
      return res.status(400).json({ error: 'no Stripe customer linked' });
    }

    const today = new Date().toISOString().slice(0, 10);
    const performedDate = date_performed || today;
    const customerName = (sub.customer && sub.customer.name) || 'customer';
    const customerEmail = (sub.customer && sub.customer.email) || null;
    const stripeDescription = 'Bates Electric: ' + description.trim();

    // 1. Insert the row first as 'pending'
    const { data: row, error: insErr } = await supabaseAdmin
      .from('generator_adhoc_charges')
      .insert({
        subscription_id: id,
        service_visit_id: service_visit_id || null,
        description: description.trim(),
        amount_cents,
        billing_method,
        status: 'pending',
        date_performed: performedDate,
      })
      .select()
      .single();
    if (insErr) throw insErr;

    // 2. Hit Stripe based on billing_method
    if (billing_method === 'immediate') {
      // Resolve which saved card to charge first — a bare
      // paymentIntents.create({ customer }) can't find the card Checkout attached
      // to the subscription, which is what was failing in the field.
      const paymentMethodId = await resolveSavedPaymentMethod(sub.stripe_subscription_id, sub.stripe_customer_id);
      if (!paymentMethodId) {
        // No card on file at all: record the failure and auto-email the
        // card-update link so the customer can add one.
        await supabaseAdmin
          .from('generator_adhoc_charges')
          .update({ status: 'failed', notes: 'Charge failed on ' + today + ': no saved card on file' })
          .eq('id', row.id);
        const linkResult = await emailCardUpdateLinkForSub(id);
        return res.status(402).json({
          error: 'charge failed',
          reason: 'no saved card on file',
          adhoc_charge_id: row.id,
          card_update_email_sent: !!linkResult.sent,
        });
      }

      let intent;
      try {
        intent = await stripe.paymentIntents.create({
          customer: sub.stripe_customer_id,
          amount: amount_cents,
          currency: 'usd',
          payment_method: paymentMethodId,
          payment_method_types: ['card'],
          off_session: true,
          confirm: true,
          description: stripeDescription,
          // Stripe's automatic receipts for raw PaymentIntents key off receipt_email;
          // without it ad-hoc charges won't generate a receipt even with the
          // "Successful payments" email setting enabled.
          ...(customerEmail ? { receipt_email: customerEmail } : {}),
          metadata: {
            adhoc_charge_id: row.id,
            subscription_id: id,
            customer_name: customerName,
          },
        });
      } catch (stripeErr) {
        // Off-session charges can fail with authentication_required (3DS) or card
        // errors (declined, expired, etc.). Record FAILED with the message and do
        // not throw; Amy can re-send a card-update link from the dashboard.
        const reason = stripeErr.message || stripeErr.code || 'unknown_error';
        await supabaseAdmin
          .from('generator_adhoc_charges')
          .update({ status: 'failed', notes: 'Charge failed on ' + today + ': ' + reason })
          .eq('id', row.id);
        return res.status(402).json({ error: 'charge failed', reason, adhoc_charge_id: row.id });
      }
      const { data: updated, error: updErr } = await supabaseAdmin
        .from('generator_adhoc_charges')
        .update({
          status: 'charged',
          date_charged: today,
          stripe_payment_intent_id: intent.id,
        })
        .eq('id', row.id)
        .select()
        .single();
      if (updErr) throw updErr;
      return res.json({ ok: true, adhoc_charge: updated, payment_intent_id: intent.id });
    }

    // billing_method === 'renewal' - create invoice item
    if (!sub.stripe_subscription_id) {
      await supabaseAdmin
        .from('generator_adhoc_charges')
        .update({ status: 'failed', notes: 'No Stripe subscription linked' })
        .eq('id', row.id);
      return res.status(400).json({ error: 'no Stripe subscription linked; cannot bill at renewal' });
    }
    let item;
    try {
      item = await stripe.invoiceItems.create({
        customer: sub.stripe_customer_id,
        subscription: sub.stripe_subscription_id,
        amount: amount_cents,
        currency: 'usd',
        description: stripeDescription,
        metadata: {
          adhoc_charge_id: row.id,
          subscription_id: id,
          customer_name: customerName,
        },
      });
    } catch (stripeErr) {
      const reason = stripeErr.message || stripeErr.code || 'unknown_error';
      await supabaseAdmin
        .from('generator_adhoc_charges')
        .update({ status: 'failed', notes: 'Invoice item create failed: ' + reason })
        .eq('id', row.id);
      return res.status(502).json({ error: 'Stripe invoice item create failed', reason });
    }
    const { data: updated, error: updErr2 } = await supabaseAdmin
      .from('generator_adhoc_charges')
      .update({
        stripe_invoice_item_id: item.id,
      })
      .eq('id', row.id)
      .select()
      .single();
    if (updErr2) throw updErr2;

    return res.json({ ok: true, adhoc_charge: updated, invoice_item_id: item.id });
  } catch (err) {
    console.error('[generator-care] adhoc-charge error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/generator-care/adhoc-charges/:id/cancel
// Soft-cancel an ad-hoc charge.
// If it's already charged: refuses (need refund flow).
// If it's a pending renewal charge: also deletes the Stripe invoice item.
router.post('/adhoc-charges/:id/cancel', async (req, res) => {
  try {
    const { id } = req.params;
    const { data: charge, error: chErr } = await supabaseAdmin
      .from('generator_adhoc_charges')
      .select('*')
      .eq('id', id)
      .single();
    if (chErr) throw chErr;
    if (!charge) return res.status(404).json({ error: 'charge not found' });
    if (charge.status === 'charged') {
      return res.status(400).json({ error: 'already charged - cannot remove. Refund must be handled separately.' });
    }
    if (charge.status === 'canceled') {
      return res.json({ ok: true, adhoc_charge: charge, info: 'already canceled' });
    }

    // If it had an invoice item, try to delete it from Stripe
    if (charge.stripe_invoice_item_id) {
      try {
        await stripe.invoiceItems.del(charge.stripe_invoice_item_id);
      } catch (stripeErr) {
        return res.status(400).json({
          error: 'cannot cancel: invoice item already billed or not removable',
          reason: stripeErr.message,
        });
      }
    }

    const today = new Date().toISOString().slice(0, 10);
    const { data: updated, error: updErr } = await supabaseAdmin
      .from('generator_adhoc_charges')
      .update({
        status: 'canceled',
        notes: (charge.notes ? charge.notes + '\n' : '') + 'Canceled on ' + today,
      })
      .eq('id', id)
      .select()
      .single();
    if (updErr) throw updErr;

    res.json({ ok: true, adhoc_charge: updated });
  } catch (err) {
    console.error('[generator-care] adhoc-charges cancel error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/generator-care/adhoc-charges/:id/refund
// Body: { amount_cents?, reason? }
// amount_cents omitted = full refund.
router.post('/adhoc-charges/:id/refund', async (req, res) => {
  try {
    const { id } = req.params;
    const { amount_cents, reason } = req.body || {};

    const { data: charge, error: chErr } = await supabaseAdmin
      .from('generator_adhoc_charges')
      .select('*')
      .eq('id', id)
      .single();
    if (chErr) throw chErr;
    if (!charge) return res.status(404).json({ error: 'charge not found' });
    if (charge.status !== 'charged') {
      return res.status(400).json({ error: `cannot refund charge with status '${charge.status}' (must be 'charged')` });
    }
    if (!charge.stripe_payment_intent_id) {
      return res.status(400).json({ error: 'charge has no stripe_payment_intent_id; refund must be issued from Stripe Dashboard' });
    }

    const alreadyRefundedCents = parseRefundedFromNotes(charge.notes);
    let result;
    try {
      result = await executeStripeRefund({
        paymentIntentId: charge.stripe_payment_intent_id,
        originalAmountCents: charge.amount_cents,
        alreadyRefundedCents,
        requestedAmountCents: amount_cents,
        reason,
      });
    } catch (refundErr) {
      return res.status(400).json({ error: refundErr.message });
    }

    const refundNote = buildRefundNote(result.refundAmount, charge.amount_cents, reason, result.refund.id);
    const newNotes = (charge.notes ? charge.notes + '\n' : '') + refundNote;
    await supabaseAdmin.from('generator_adhoc_charges').update({ notes: newNotes }).eq('id', id);

    res.json({
      ok: true,
      refund_id: result.refund.id,
      amount_cents: result.refundAmount,
      total_refunded_cents: alreadyRefundedCents + result.refundAmount,
      original_amount_cents: charge.amount_cents,
      stripe_status: result.refund.status,
    });
  } catch (err) {
    console.error('[generator-care] adhoc-charges refund error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/generator-care/invoices/:invoiceId/refund
// Body: { amount_cents?, reason? }
// Refunds a paid subscription/plan invoice's charge to the customer's card.
// amount_cents omitted = full refund of the remaining (un-refunded) balance.
// NOTE: refunding an invoice does NOT cancel the subscription — they're
// independent actions (the customer keeps their plan unless separately canceled).
router.post('/invoices/:invoiceId/refund', async (req, res) => {
  try {
    const { invoiceId } = req.params;
    const { amount_cents, reason } = req.body || {};

    let invoice;
    try {
      invoice = await stripe.invoices.retrieve(invoiceId, { expand: ['charge'] });
    } catch (e) {
      return res.status(404).json({ error: 'invoice not found in Stripe: ' + (e && e.message ? e.message : 'unknown') });
    }
    if (invoice.status !== 'paid') {
      return res.status(400).json({ error: `cannot refund invoice with status '${invoice.status}' (must be 'paid')` });
    }
    const charge = invoice.charge && typeof invoice.charge === 'object' ? invoice.charge : null;
    if (!charge || !charge.id) {
      return res.status(400).json({ error: 'invoice has no captured charge to refund' });
    }

    // Ownership guard (prevent IDOR): only refund invoices that belong to a
    // Generator Care customer. Without this, a valid office token could refund
    // ANY invoice id in the connected Stripe account.
    const invoiceCustomerId = typeof invoice.customer === 'string'
      ? invoice.customer
      : (invoice.customer && invoice.customer.id) || null;
    const { data: ownerSub, error: ownerErr } = await supabaseAdmin
      .from('generator_subscriptions')
      .select('id')
      .eq('stripe_customer_id', invoiceCustomerId)
      .limit(1)
      .maybeSingle();
    if (ownerErr) throw ownerErr;
    if (!invoiceCustomerId || !ownerSub) {
      return res.status(403).json({ error: 'invoice does not belong to a Generator Care customer' });
    }

    const originalAmountCents = charge.amount;
    const alreadyRefundedCents = charge.amount_refunded || 0;
    if (alreadyRefundedCents >= originalAmountCents) {
      return res.status(400).json({ error: 'invoice is already fully refunded' });
    }

    let result;
    try {
      result = await executeStripeRefund({
        chargeId: charge.id,
        originalAmountCents,
        alreadyRefundedCents,
        requestedAmountCents: amount_cents,
        reason,
        metadata: { generator_invoice_id: invoiceId },
      });
    } catch (refundErr) {
      return res.status(400).json({ error: refundErr.message });
    }

    // No DB row to annotate (invoices live in Stripe). Accounting visibility
    // comes from the Stripe refund itself, surfaced by /accounting/transactions.
    res.json({
      ok: true,
      refund_id: result.refund.id,
      amount_cents: result.refundAmount,
      total_refunded_cents: alreadyRefundedCents + result.refundAmount,
      original_amount_cents: originalAmountCents,
      stripe_status: result.refund.status,
      invoice_id: invoiceId,
    });
  } catch (err) {
    console.error('[generator-care] invoice refund error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
