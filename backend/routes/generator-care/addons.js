// backend/routes/generator-care/addons.js
// Per-visit add-ons: availability, add/remove, performed tracking, the
// combined batch charge, refunds, and the standing (auto-return) set.
// Auth (requireAuth + office role) is applied by ./index.js.

const express = require('express');
const { requirePermission } = require('../../middleware/permissions');
const { supabaseAdmin } = require('../../lib/supabase');
const catalog = require('../../lib/generator-catalog');
const {
  stripe,
  resolveSavedPaymentMethod,
  emailCardUpdateLinkForSub,
  executeStripeRefund,
  buildRefundNote,
  parseRefundedFromNotes,
} = require('../../lib/gcShared');

const router = express.Router();

// POST /api/generator-care/addons/:id/mark-performed
// Mark a pending add-on PERFORMED (unbilled) — does NOT charge. Performed add-ons
// are billed together per visit via /subscriptions/:id/charge-performed-addons.
// Undo (/unmark-performed) reverts to pending. Office-gated; IDOR via customer_id.
router.post('/addons/:id/mark-performed', requirePermission('billing_actions'), async (req, res) => {
  try {
    const { id } = req.params;
    const body = req.body || {};
    const performedDate = body.date_performed || new Date().toISOString().slice(0, 10);
    const customerId = body.customer_id;

    const { data: addon, error: addonErr } = await supabaseAdmin
      .from('generator_pending_addons')
      .select('id, status, subscription:generator_subscriptions(customer_id)')
      .eq('id', id)
      .single();
    if (addonErr) throw addonErr;
    if (!addon) return res.status(404).json({ error: 'addon not found' });
    if (addon.status === 'charged') return res.status(400).json({ error: 'addon already charged' });
    if (addon.status === 'canceled') return res.status(400).json({ error: 'addon is canceled' });
    if (customerId && addon.subscription && addon.subscription.customer_id !== customerId) {
      return res.status(403).json({ error: 'addon does not belong to that customer' });
    }

    const { data: updated, error: updErr } = await supabaseAdmin
      .from('generator_pending_addons')
      .update({ status: 'performed', date_performed: performedDate })
      .eq('id', id)
      .select()
      .single();
    if (updErr) throw updErr;
    res.json({ ok: true, addon: updated });
  } catch (err) {
    console.error('[generator-care] mark-performed error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/generator-care/subscriptions/:id/charge-performed-addons
// Bill ALL performed-but-unbilled add-ons for the subscription in ONE invoice (one
// line item per add-on -> one payment -> one itemized state-branded receipt + one
// Accounting entry). Any pending at-renewal invoice items are DELETED first so
// nothing is billed twice. Office-gated; IDOR via optional customer_id.
router.post('/subscriptions/:id/charge-performed-addons', requirePermission('billing_actions'), async (req, res) => {
  try {
    const { id } = req.params;
    const customerId = req.body && req.body.customer_id;
    const today = new Date().toISOString().slice(0, 10);

    const { data: sub, error: subErr } = await supabaseAdmin
      .from('generator_subscriptions')
      .select('id, customer_id, stripe_subscription_id, stripe_customer_id')
      .eq('id', id)
      .single();
    if (subErr) throw subErr;
    if (!sub) return res.status(404).json({ error: 'subscription not found' });
    if (customerId && sub.customer_id !== customerId) {
      return res.status(403).json({ error: 'subscription does not belong to that customer' });
    }
    if (!sub.stripe_customer_id || !sub.stripe_subscription_id) {
      return res.status(400).json({ error: 'no Stripe subscription linked' });
    }

    const { data: addons, error: addErr } = await supabaseAdmin
      .from('generator_pending_addons')
      .select('id, addon_type, amount_cents, stripe_invoice_item_id')
      .eq('subscription_id', id)
      .eq('status', 'performed');
    if (addErr) throw addErr;
    const billable = (addons || []).filter((a) => a.amount_cents && a.amount_cents > 0);
    if (!billable.length) return res.status(400).json({ error: 'no performed add-ons to charge' });

    const stripeCustomerId = sub.stripe_customer_id;
    const labelFor = (t) => (ADDON_CATALOG[t] && ADDON_CATALOG[t].label) || (t || 'add-on').replace(/_/g, ' ');
    const totalCents = billable.reduce((s, a) => s + a.amount_cents, 0);
    const descSummary = 'Generator add-ons: ' + billable.map((a) => labelFor(a.addon_type)).join(', ');

    // 1. Card check first (don't disturb renewal items if there's no card).
    const pmId = await resolveSavedPaymentMethod(sub.stripe_subscription_id, stripeCustomerId);
    if (!pmId) {
      const linkResult = await emailCardUpdateLinkForSub(sub.id);
      return res.status(402).json({ error: 'no saved card on file', reason: 'no saved card on file', card_update_email_sent: !!(linkResult && linkResult.sent) });
    }

    // 2. Delete any pending at-renewal invoice items so nothing is billed twice.
    for (const a of billable) {
      if (a.stripe_invoice_item_id) {
        try {
          await stripe.invoiceItems.del(a.stripe_invoice_item_id);
        } catch (delErr) {
          return res.status(409).json({
            error: 'One of these add-ons is already on an invoice (billed at renewal); not charging again. Use the refund control if needed.',
            reason: delErr.message,
          });
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
          description: 'Generator add-on: ' + labelFor(a.addon_type),
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
      return res.status(402).json({ error: 'add-on charge failed', reason });
    }

    // 4. Mark all included add-ons charged against this one shared payment. (The
    //    invoice.paid webhook also marks them + sends the one itemized receipt.)
    const piId = typeof invoice.payment_intent === 'string'
      ? invoice.payment_intent
      : (invoice.payment_intent && invoice.payment_intent.id) || null;
    await supabaseAdmin.from('generator_pending_addons')
      .update({ status: 'charged', date_charged: today, stripe_payment_intent_id: piId, stripe_invoice_item_id: null })
      .in('id', billable.map((a) => a.id));

    res.json({ ok: true, charged_count: billable.length, total_cents: totalCents, invoice_id: invoice.id });
  } catch (err) {
    console.error('[generator-care] charge-performed-addons error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/generator-care/addons/:id/unmark-performed
// Reverse: deletes the Stripe invoice item (if still removable) and resets addon to pending.
router.post('/addons/:id/unmark-performed', requirePermission('billing_actions'), async (req, res) => {
  try {
    const { id } = req.params;
    const { data: addon, error: addonErr } = await supabaseAdmin
      .from('generator_pending_addons')
      .select('*')
      .eq('id', id)
      .single();
    if (addonErr) throw addonErr;
    if (!addon) return res.status(404).json({ error: 'addon not found' });
    if (addon.status !== 'performed') {
      return res.status(400).json({ error: 'addon is not in performed status' });
    }

    // Try to delete invoice item from Stripe (works only while invoice is still draft / pending)
    if (addon.stripe_invoice_item_id) {
      try {
        await stripe.invoiceItems.del(addon.stripe_invoice_item_id);
      } catch (stripeErr) {
        return res.status(400).json({
          error: 'cannot unmark: invoice item already billed or not removable',
          reason: stripeErr.message,
        });
      }
    }

    const { data: updated, error: updErr } = await supabaseAdmin
      .from('generator_pending_addons')
      .update({
        status: 'pending',
        date_performed: null,
        stripe_invoice_item_id: null,
      })
      .eq('id', id)
      .select()
      .single();
    if (updErr) throw updErr;

    res.json({ ok: true, addon: updated });
  } catch (err) {
    console.error('[generator-care] unmark-performed error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/generator-care/addons/:id/refund
// Body: { amount_cents?, reason? }
// amount_cents omitted = full refund. Stripe supports multiple partial refunds
// up to the original total; we don't enforce that here -- Stripe will reject.
router.post('/addons/:id/refund', requirePermission('refunds'), async (req, res) => {
  try {
    const { id } = req.params;
    const { amount_cents, reason } = req.body || {};

    const { data: addon, error: addonErr } = await supabaseAdmin
      .from('generator_pending_addons')
      .select('*')
      .eq('id', id)
      .single();
    if (addonErr) throw addonErr;
    if (!addon) return res.status(404).json({ error: 'addon not found' });
    if (addon.status !== 'charged') {
      return res.status(400).json({ error: `cannot refund addon with status '${addon.status}' (must be 'charged')` });
    }
    if (!addon.stripe_payment_intent_id) {
      return res.status(400).json({ error: 'addon has no stripe_payment_intent_id; refund must be issued from Stripe Dashboard' });
    }

    const alreadyRefundedCents = parseRefundedFromNotes(addon.notes);
    let result;
    try {
      result = await executeStripeRefund({
        paymentIntentId: addon.stripe_payment_intent_id,
        originalAmountCents: addon.amount_cents,
        alreadyRefundedCents,
        requestedAmountCents: amount_cents,
        reason,
      });
    } catch (refundErr) {
      return res.status(400).json({ error: refundErr.message });
    }

    const refundNote = buildRefundNote(result.refundAmount, addon.amount_cents, reason, result.refund.id);
    const newNotes = (addon.notes ? addon.notes + '\n' : '') + refundNote;
    await supabaseAdmin.from('generator_pending_addons').update({ notes: newNotes }).eq('id', id);

    res.json({
      ok: true,
      refund_id: result.refund.id,
      amount_cents: result.refundAmount,
      total_refunded_cents: alreadyRefundedCents + result.refundAmount,
      original_amount_cents: addon.amount_cents,
      stripe_status: result.refund.status,
    });
  } catch (err) {
    console.error('[generator-care] addon refund error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Add-on catalog (one-time/per-visit add-ons + their recurring flag) now lives in
// the shared lib/generator-catalog.js so the roll-forward (lib/completeVisit.js)
// can use it too.
const { ADDON_CATALOG, lookupAddonPrice } = catalog;

// GET /api/generator-care/subscriptions/:id/available-addons
// Lists which add-ons can be added for this customer's gen class.
router.get('/subscriptions/:id/available-addons', async (req, res) => {
  try {
    const { id } = req.params;
    const { data: sub, error: subErr } = await supabaseAdmin
      .from('generator_subscriptions')
      .select('id, gen_class')
      .eq('id', id)
      .single();
    if (subErr) throw subErr;
    if (!sub) return res.status(404).json({ error: 'subscription not found' });

    const available = [];
    for (const [addonType, entry] of Object.entries(ADDON_CATALOG)) {
      const price = lookupAddonPrice(addonType, sub.gen_class);
      if (price) {
        available.push({ addon_type: addonType, label: entry.label, amount_cents: price.amount_cents });
      }
    }
    res.json({ ok: true, gen_class: sub.gen_class, addons: available });
  } catch (err) {
    console.error('[generator-care] available-addons error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/generator-care/subscriptions/:id/add-addon
// Add a new pending add-on to an existing subscription mid-cycle.
// Body: { addon_type }
// The current OPEN visit a new/active add-on belongs to (the cycle). Earliest
// not-completed, not-canceled visit; null if none.
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

router.post('/subscriptions/:id/add-addon', requirePermission('billing_actions'), async (req, res) => {
  try {
    const { id } = req.params;
    const { addon_type } = req.body || {};
    if (!addon_type) return res.status(400).json({ error: 'addon_type required' });

    const { data: sub, error: subErr } = await supabaseAdmin
      .from('generator_subscriptions')
      .select('id, gen_class, status')
      .eq('id', id)
      .single();
    if (subErr) throw subErr;
    if (!sub) return res.status(404).json({ error: 'subscription not found' });
    if (sub.status === 'canceled') {
      return res.status(400).json({ error: 'subscription is canceled; cannot add new add-ons' });
    }

    const price = lookupAddonPrice(addon_type, sub.gen_class);
    if (!price) {
      return res.status(400).json({ error: 'add-on not available for this gen class', addon_type, gen_class: sub.gen_class });
    }

    // Belongs to the current cycle (the open visit).
    const serviceVisitId = await getOpenVisitId(id);

    const { data: inserted, error: insErr } = await supabaseAdmin
      .from('generator_pending_addons')
      .insert({
        subscription_id: id,
        addon_type,
        stripe_price_id: price.price_id,
        amount_cents: price.amount_cents,
        status: 'pending',
        service_visit_id: serviceVisitId,
      })
      .select()
      .single();
    if (insErr) throw insErr;

    res.json({ ok: true, addon: inserted });
  } catch (err) {
    console.error('[generator-care] add-addon error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/generator-care/subscriptions/:id/standing-addons
// The customer's standing (auto-return every visit) recurring add-ons + the
// recurring types available for their gen class (for the editor).
router.get('/subscriptions/:id/standing-addons', async (req, res) => {
  try {
    const { id } = req.params;
    const { data: sub, error } = await supabaseAdmin
      .from('generator_subscriptions')
      .select('id, gen_class, standing_addons')
      .eq('id', id)
      .single();
    if (error) throw error;
    if (!sub) return res.status(404).json({ error: 'subscription not found' });
    const available = catalog.recurringAddonTypes()
      .filter((t) => catalog.lookupAddonPrice(t, sub.gen_class))
      .map((t) => ({ addon_type: t, label: catalog.ADDON_CATALOG[t].label, amount_cents: catalog.lookupAddonPrice(t, sub.gen_class).amount_cents }));
    res.json({ ok: true, standing_addons: sub.standing_addons || [], available_recurring: available });
  } catch (err) {
    console.error('[generator-care] get standing-addons error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /api/generator-care/subscriptions/:id/standing-addons
// Body: { standing_addons: [addon_type, ...] }. Sets which recurring add-ons
// auto-return each cycle. Only recurring types available for the gen class are
// kept. Office-gated; optional customer_id IDOR guard.
router.patch('/subscriptions/:id/standing-addons', requirePermission('billing_actions'), async (req, res) => {
  try {
    const { id } = req.params;
    const body = req.body || {};
    if (!Array.isArray(body.standing_addons)) {
      return res.status(400).json({ error: 'standing_addons (array) required' });
    }
    const { data: sub, error: subErr } = await supabaseAdmin
      .from('generator_subscriptions')
      .select('id, customer_id, gen_class')
      .eq('id', id)
      .single();
    if (subErr) throw subErr;
    if (!sub) return res.status(404).json({ error: 'subscription not found' });
    if (body.customer_id && sub.customer_id !== body.customer_id) {
      return res.status(403).json({ error: 'subscription does not belong to that customer' });
    }
    // Keep only recurring types valid for this gen class; de-dupe.
    const cleaned = Array.from(new Set(
      body.standing_addons.filter((t) => catalog.isRecurringAddon(t) && catalog.lookupAddonPrice(t, sub.gen_class))
    ));
    const { data: updated, error: updErr } = await supabaseAdmin
      .from('generator_subscriptions')
      .update({ standing_addons: cleaned })
      .eq('id', id)
      .select('id, standing_addons')
      .single();
    if (updErr) throw updErr;
    res.json({ ok: true, standing_addons: updated.standing_addons || [] });
  } catch (err) {
    console.error('[generator-care] patch standing-addons error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/generator-care/addons/:id/remove
// Soft-delete a pending add-on (sets status='canceled'). Only allowed for status='pending'.
// Performed addons should use /unmark-performed first to revert to pending.
// Charged addons can't be removed (need a refund flow).
router.post('/addons/:id/remove', requirePermission('billing_actions'), async (req, res) => {
  try {
    const { id } = req.params;
    const { data: addon, error: addonErr } = await supabaseAdmin
      .from('generator_pending_addons')
      .select('id, status')
      .eq('id', id)
      .single();
    if (addonErr) throw addonErr;
    if (!addon) return res.status(404).json({ error: 'addon not found' });
    if (addon.status !== 'pending') {
      return res.status(400).json({
        error: 'can only remove pending add-ons',
        current_status: addon.status,
        hint: addon.status === 'performed' ? 'use /unmark-performed first' : 'addon is past the pending stage',
      });
    }

    const today = new Date().toISOString().slice(0, 10);
    const { data: updated, error: updErr } = await supabaseAdmin
      .from('generator_pending_addons')
      .update({
        status: 'canceled',
        notes: 'Removed by office on ' + today,
      })
      .eq('id', id)
      .select()
      .single();
    if (updErr) throw updErr;

    res.json({ ok: true, addon: updated });
  } catch (err) {
    console.error('[generator-care] remove addon error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
