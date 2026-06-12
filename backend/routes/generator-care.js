// backend/routes/generator-care.js
// Office dashboard data for the Generator Care program.
// All endpoints require office role.

const express = require('express');
const { supabaseAdmin } = require('../lib/supabase');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();

// All routes require office role
const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const {
  sendEmail,
  buildCardUpdateLinkEmail,
  buildWelcomeEmail,
  buildCardFailedEmail,
  buildVisitScheduledEmail,
  buildVisitCompletedEmail,
  buildRenewalUpcomingEmail,
  buildCancellationEmail,
} = require('../lib/emails');

function planLabelFor(plan) {
  return plan === 'semi_annual' ? 'Semi-Annual' : (plan === 'annual' ? 'Annual' : plan);
}

router.use(requireAuth, requireRole('office'));

// GET /api/generator-care/subscriptions
// List of all subscriptions joined with customer info, sorted by next-visit-due ascending.
router.get('/subscriptions', async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('generator_subscriptions')
      .select(`
        id, plan, gen_class, gen_type_label, gen_model, gen_serial,
        fleet_monitoring, status, annual_price_cents,
        signup_date, next_visit_due, last_visit_date,
        stripe_subscription_id, stripe_customer_id, notes, created_at,
        customer:generator_customers(id, name, email, phone, install_address, install_city, install_state, install_zip)
      `)
      .order('next_visit_due', { ascending: true, nullsFirst: false });
    if (error) throw error;
    res.json({ subscriptions: data || [] });
  } catch (err) {
    console.error('[generator-care] subscriptions error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/generator-care/subscriptions/:id
// Full detail: subscription, customer, scheduled/completed visits, pending add-ons.
router.get('/subscriptions/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const [subR, visitsR, addonsR, adhocR] = await Promise.all([
      supabaseAdmin
        .from('generator_subscriptions')
        .select(`*, customer:generator_customers(*)`)
        .eq('id', id)
        .single(),
      supabaseAdmin
        .from('generator_service_visits')
        .select('*')
        .eq('subscription_id', id)
        .order('scheduled_date', { ascending: true }),
      supabaseAdmin
        .from('generator_pending_addons')
        .select('*')
        .eq('subscription_id', id)
        .order('created_at', { ascending: true }),
      supabaseAdmin
        .from('generator_adhoc_charges')
        .select('*')
        .eq('subscription_id', id)
        .order('created_at', { ascending: false }),
    ]);
    if (subR.error) throw subR.error;
    if (visitsR.error) throw visitsR.error;
    if (addonsR.error) throw addonsR.error;
    if (adhocR.error) throw adhocR.error;
    res.json({
      subscription: subR.data,
      visits: visitsR.data || [],
      pending_addons: addonsR.data || [],
      adhoc_charges: adhocR.data || [],
    });
  } catch (err) {
    console.error('[generator-care] subscription detail error:', err);
    res.status(500).json({ error: err.message });
  }
});


// GET /api/generator-care/subscriptions/:id/stripe-data
// Lazy-loaded Stripe enrichments for the customer detail modal: payment
// method on file, lifetime billed total, and the 5 most recent invoices.
// The modal opens instantly from DB; this endpoint fills in skeletons
// after the fact. Two Stripe API calls in parallel (~150-300ms).
router.get('/subscriptions/:id/stripe-data', async (req, res) => {
  try {
    const { data: sub, error: subErr } = await supabaseAdmin
      .from('generator_subscriptions')
      .select('stripe_customer_id')
      .eq('id', req.params.id)
      .single();
    if (subErr) throw subErr;
    if (!sub || !sub.stripe_customer_id) {
      return res.json({
        payment_method: null,
        lifetime_billed_cents: 0,
        recent_invoices: [],
        note: 'No Stripe customer linked to this subscription.',
      });
    }
    const customerId = sub.stripe_customer_id;

    // Fetch in parallel: payment methods (cards) + paid invoices.
    // limit:100 on invoices is enough to cover years of subs; if we ever
    // exceed it the lifetime total just slightly under-counts.
    const [pmResult, invoiceResult] = await Promise.allSettled([
      stripe.paymentMethods.list({ customer: customerId, type: 'card', limit: 1 }),
      // Expand the charge so we can report refund status per invoice (for the
      // dashboard Refund button + Refunded/Partial chips).
      stripe.invoices.list({ customer: customerId, status: 'paid', limit: 100, expand: ['data.charge'] }),
    ]);

    // Payment method
    let payment_method = null;
    if (pmResult.status === 'fulfilled' && pmResult.value.data.length > 0) {
      const pm = pmResult.value.data[0];
      const card = pm.card || {};
      payment_method = {
        brand: card.brand || null,
        last4: card.last4 || null,
        exp_month: card.exp_month || null,
        exp_year: card.exp_year || null,
      };
    } else if (pmResult.status === 'rejected') {
      console.error('[stripe-data] paymentMethods.list failed:', pmResult.reason && pmResult.reason.message);
    }

    // Lifetime billed + recent invoices (both from the same list call)
    let lifetime_billed_cents = 0;
    let recent_invoices = [];
    if (invoiceResult.status === 'fulfilled') {
      const all = invoiceResult.value.data || [];
      lifetime_billed_cents = all.reduce((sum, inv) => sum + (inv.amount_paid || 0), 0);
      recent_invoices = all.slice(0, 5).map((inv) => {
        const ch = inv.charge && typeof inv.charge === 'object' ? inv.charge : null;
        const chargeAmount = ch ? ch.amount : (inv.amount_paid || 0);
        const amountRefunded = ch ? (ch.amount_refunded || 0) : 0;
        return {
          id: inv.id,
          created: inv.created,
          amount_paid: inv.amount_paid || 0,
          status: inv.status,
          hosted_invoice_url: inv.hosted_invoice_url || null,
          stripe_dashboard_url: `https://dashboard.stripe.com/invoices/${inv.id}`,
          charge_amount_cents: chargeAmount,
          amount_refunded_cents: amountRefunded,
          // Refundable: a paid invoice with a charge that isn't already fully refunded.
          refundable: inv.status === 'paid' && !!ch && amountRefunded < chargeAmount,
        };
      });
    } else {
      console.error('[stripe-data] invoices.list failed:', invoiceResult.reason && invoiceResult.reason.message);
    }

    res.json({ payment_method, lifetime_billed_cents, recent_invoices });
  } catch (err) {
    console.error('[generator-care] stripe-data error:', err);
    res.status(500).json({ error: err.message });
  }
});


// POST /api/generator-care/subscriptions/:id/resend-invoice
// Resends the most recent invoice (paid or open) via Stripe. Useful when a
// customer says they never got their receipt or needs a copy for their
// records. Stripe's own email goes out -- not one of our branded templates.
router.post('/subscriptions/:id/resend-invoice', async (req, res) => {
  try {
    const { data: sub, error: subErr } = await supabaseAdmin
      .from('generator_subscriptions')
      .select('stripe_customer_id')
      .eq('id', req.params.id)
      .single();
    if (subErr) throw subErr;
    if (!sub || !sub.stripe_customer_id) {
      return res.status(400).json({ error: 'No Stripe customer linked to this subscription.' });
    }

    const invoices = await stripe.invoices.list({
      customer: sub.stripe_customer_id,
      limit: 1,
    });
    const invoice = invoices.data[0];
    if (!invoice) {
      return res.status(404).json({ error: 'No invoices on file for this customer yet.' });
    }

    // sendInvoice works on open invoices; for already-paid ones it returns
    // the invoice unchanged (no email re-sent). Surface that distinction.
    if (invoice.status === 'paid') {
      // For a paid invoice, the right action is to email the receipt URL.
      // We don't have a dedicated Stripe API for "resend paid receipt" --
      // best we can do is point the customer at the hosted invoice URL.
      return res.json({
        ok: true,
        invoice_id: invoice.id,
        status: invoice.status,
        note: 'Most recent invoice is already paid. No re-send needed -- share hosted_invoice_url with the customer if they want a copy.',
        hosted_invoice_url: invoice.hosted_invoice_url || null,
      });
    }

    const sent = await stripe.invoices.sendInvoice(invoice.id);
    res.json({
      ok: true,
      invoice_id: invoice.id,
      status: sent.status,
      hosted_invoice_url: sent.hosted_invoice_url || null,
    });
  } catch (err) {
    console.error('[generator-care] resend-invoice error:', err);
    res.status(500).json({ error: err.message });
  }
});


// POST /api/generator-care/visits/:id/complete
// Mark a service visit completed and roll the subscription's next_visit_due forward.
router.post('/visits/:id/complete', async (req, res) => {
  try {
    const id = req.params.id;
    const { notes, addons_performed, technician_id } = req.body || {};
    const today = (req.body && req.body.completed_date) || new Date().toISOString().slice(0, 10);

    // 1. Update the visit
    const { data: updated, error: updErr } = await supabaseAdmin
      .from('generator_service_visits')
      .update({
        status: 'completed',
        completed_date: today,
        notes: notes || null,
        addons_performed: addons_performed || null,
        technician_id: technician_id || req.user.id,
      })
      .eq('id', id)
      .select('*, subscription:generator_subscriptions(id, plan, customer:generator_customers(name, email))')
      .single();
    if (updErr) throw updErr;

    // 2. Roll the subscription forward + schedule the NEXT visit
    const sub = updated.subscription;
    let nextStr = null;
    if (sub) {
      const monthsAhead = sub.plan === 'semi_annual' ? 6 : 12;
      const next = new Date(today);
      next.setMonth(next.getMonth() + monthsAhead);
      nextStr = next.toISOString().slice(0, 10);

      await supabaseAdmin
        .from('generator_subscriptions')
        .update({ last_visit_date: today, next_visit_due: nextStr })
        .eq('id', sub.id);

      await supabaseAdmin.from('generator_service_visits').insert({
        subscription_id: sub.id,
        visit_type: 'regular_service',
        scheduled_date: nextStr,
        status: 'tentative',
      });
    }

    // 3. Email the customer a completion confirmation (fire-and-forget).
    const customer = sub && sub.customer;
    if (customer && customer.email) {
      const { subject, html, text } = buildVisitCompletedEmail({
        customer,
        completedDate: today,
        nextVisitDate: nextStr,
        planLabel: planLabelFor(sub.plan),
        notes,
      });
      sendEmail({
        to: customer.email,
        subject,
        html,
        text,
        logTag: '[visit-complete-email]',
      }).catch((e) => console.error('[visit-complete-email] unexpected:', e && e.message));
    }

    res.json({ ok: true, visit: updated });
  } catch (err) {
    console.error('[generator-care] visit complete error:', err);
    res.status(500).json({ error: err.message });
  }
});


// PATCH /api/generator-care/subscriptions/:id
// Edit subscription details (currently: next_visit_due, status, notes).
// When next_visit_due changes, also update the matching scheduled visit row.
router.patch('/subscriptions/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { next_visit_due, status, notes } = req.body || {};

    // Build update payload (only include fields user actually passed)
    const updates = {};
    if (next_visit_due !== undefined) updates.next_visit_due = next_visit_due || null;
    if (status !== undefined) updates.status = status;
    if (notes !== undefined) updates.notes = notes;
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'no editable fields provided' });
    }

    // Update the subscription
    const { data: updated, error: subErr } = await supabaseAdmin
      .from('generator_subscriptions')
      .update(updates)
      .eq('id', id)
      .select()
      .single();
    if (subErr) throw subErr;

    // If next_visit_due changed, sync the most-recent scheduled visit row to match.
    if (next_visit_due !== undefined && next_visit_due) {
      await supabaseAdmin
        .from('generator_service_visits')
        .update({ scheduled_date: next_visit_due })
        .eq('subscription_id', id)
        .eq('status', 'scheduled');
    }

    res.json({ ok: true, subscription: updated });
  } catch (err) {
    console.error('[generator-care] subscription patch error:', err);
    res.status(500).json({ error: err.message });
  }
});


// PATCH /api/generator-care/customers/:id
// Edit customer-level fields. Currently scoped to `notes` (the internal-note
// textarea on the dashboard modal); add more fields here as needed. Notes here
// persist across subscriptions if the customer ever resubscribes, which is
// why this lives on customers and not subscriptions.
router.patch('/customers/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { notes } = req.body || {};

    const updates = {};
    if (notes !== undefined) updates.notes = notes;
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'no editable fields provided' });
    }

    const { data: updated, error: custErr } = await supabaseAdmin
      .from('generator_customers')
      .update(updates)
      .eq('id', id)
      .select()
      .single();
    if (custErr) throw custErr;
    if (!updated) return res.status(404).json({ error: 'customer not found' });

    res.json({ ok: true, customer: updated });
  } catch (err) {
    console.error('[generator-care] customer patch error:', err);
    res.status(500).json({ error: err.message });
  }
});


// POST /api/generator-care/visits/:id/confirm
// Promote a tentative visit to scheduled. Optionally update the scheduled_date in the same call.
router.post('/visits/:id/confirm', async (req, res) => {
  try {
    const { id } = req.params;
    const { scheduled_date } = req.body || {};

    const updates = { status: 'scheduled' };
    if (scheduled_date) updates.scheduled_date = scheduled_date;

    const { data: updated, error: vErr } = await supabaseAdmin
      .from('generator_service_visits')
      .update(updates)
      .eq('id', id)
      .select('*, subscription:generator_subscriptions(id, plan, customer:generator_customers(name, email))')
      .single();
    if (vErr) throw vErr;

    // If date was updated, keep subscription.next_visit_due in sync
    if (scheduled_date && updated.subscription) {
      await supabaseAdmin
        .from('generator_subscriptions')
        .update({ next_visit_due: scheduled_date })
        .eq('id', updated.subscription.id);
    }

    // Email the customer a confirmation (fire-and-forget).
    const sub = updated.subscription;
    const customer = sub && sub.customer;
    if (customer && customer.email) {
      const { subject, html, text } = buildVisitScheduledEmail({
        customer,
        scheduledDate: updated.scheduled_date,
        planLabel: planLabelFor(sub && sub.plan),
      });
      sendEmail({
        to: customer.email,
        subject,
        html,
        text,
        logTag: '[visit-scheduled-email]',
      }).catch((e) => console.error('[visit-scheduled-email] unexpected:', e && e.message));
    }

    res.json({ ok: true, visit: updated });
  } catch (err) {
    console.error('[generator-care] confirm visit error:', err);
    res.status(500).json({ error: err.message });
  }
});


// POST /api/generator-care/addons/:id/mark-performed
// Records that a pending add-on was performed during a visit + adds it as an invoice item
// on the customer's next subscription invoice. Will be charged when subscription renews.
// Webhooks (invoice.paid / invoice.payment_failed) flip status to charged/failed.
router.post('/addons/:id/mark-performed', async (req, res) => {
  try {
    const { id } = req.params;
    const { date_performed } = req.body || {};
    const today = new Date().toISOString().slice(0, 10);
    const performedDate = date_performed || today;

    const { data: addon, error: addonErr } = await supabaseAdmin
      .from('generator_pending_addons')
      .select('*, subscription:generator_subscriptions(id, stripe_subscription_id, stripe_customer_id, customer:generator_customers(name))')
      .eq('id', id)
      .single();
    if (addonErr) throw addonErr;
    if (!addon) return res.status(404).json({ error: 'addon not found' });

    if (addon.status === 'performed' || addon.status === 'charged') {
      return res.status(400).json({ error: 'addon already ' + addon.status });
    }
    if (!addon.amount_cents || addon.amount_cents <= 0) {
      return res.status(400).json({ error: 'no charge amount' });
    }
    if (!addon.subscription || !addon.subscription.stripe_customer_id || !addon.subscription.stripe_subscription_id) {
      return res.status(400).json({ error: 'no Stripe subscription linked' });
    }

    const customerId = addon.subscription.stripe_customer_id;
    const subId = addon.subscription.stripe_subscription_id;
    const label = (addon.addon_type || 'add-on').replace(/_/g, ' ');

    // Create Stripe invoice item attached to subscription's next invoice
    let item;
    try {
      item = await stripe.invoiceItems.create({
        customer: customerId,
        subscription: subId,
        amount: addon.amount_cents,
        currency: 'usd',
        description: 'Generator add-on: ' + label,
        metadata: {
          addon_id: id,
          addon_type: addon.addon_type,
          subscription_id: addon.subscription.id,
          performed_date: performedDate,
        },
      });
    } catch (stripeErr) {
      const reason = stripeErr.message || stripeErr.code || 'unknown_error';
      console.error('[generator-care] invoice item create failed:', stripeErr);
      return res.status(502).json({ error: 'Stripe invoice item create failed', reason });
    }

    const { data: updated, error: updErr } = await supabaseAdmin
      .from('generator_pending_addons')
      .update({
        status: 'performed',
        date_performed: performedDate,
        stripe_invoice_item_id: item.id,
      })
      .eq('id', id)
      .select()
      .single();
    if (updErr) throw updErr;

    res.json({ ok: true, addon: updated, invoice_item_id: item.id });
  } catch (err) {
    console.error('[generator-care] mark-performed error:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/generator-care/addons/:id/unmark-performed
// Reverse: deletes the Stripe invoice item (if still removable) and resets addon to pending.
router.post('/addons/:id/unmark-performed', async (req, res) => {
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
    res.status(500).json({ error: err.message });
  }
});


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


// POST /api/generator-care/addons/:id/refund
// Body: { amount_cents?, reason? }
// amount_cents omitted = full refund. Stripe supports multiple partial refunds
// up to the original total; we don't enforce that here -- Stripe will reject.
router.post('/addons/:id/refund', async (req, res) => {
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

    let result;
    try {
      result = await executeStripeRefund({
        paymentIntentId: addon.stripe_payment_intent_id,
        originalAmountCents: addon.amount_cents,
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
      stripe_status: result.refund.status,
    });
  } catch (err) {
    console.error('[generator-care] addon refund error:', err);
    res.status(500).json({ error: err.message });
  }
});


// POST /api/generator-care/subscriptions/:id/cancel
// Cancel subscription at the end of the current billing period.
// Customer keeps service through paid-through date; Stripe stops auto-renewal.
// DB marks 'canceled' with optional reason in notes.
router.post('/subscriptions/:id/cancel', async (req, res) => {
  try {
    const { id } = req.params;
    const { reason } = req.body || {};

    const { data: sub, error: subErr } = await supabaseAdmin
      .from('generator_subscriptions')
      .select('*, customer:generator_customers(name, email)')
      .eq('id', id)
      .single();
    if (subErr) throw subErr;
    if (!sub) return res.status(404).json({ error: 'subscription not found' });
    if (sub.status === 'canceled') {
      return res.status(400).json({ error: 'subscription already canceled' });
    }
    if (!sub.stripe_subscription_id) {
      return res.status(400).json({ error: 'no Stripe subscription linked' });
    }

    // Cancel at period end in Stripe
    let stripeSub;
    try {
      stripeSub = await stripe.subscriptions.update(sub.stripe_subscription_id, {
        cancel_at_period_end: true,
        cancellation_details: reason ? { comment: reason } : undefined,
      });
    } catch (stripeErr) {
      console.error('[generator-care] Stripe cancel failed:', stripeErr);
      return res.status(502).json({ error: 'Stripe update failed', reason: stripeErr.message });
    }

    const today = new Date().toISOString().slice(0, 10);
    const periodEnd = stripeSub.current_period_end
      ? new Date(stripeSub.current_period_end * 1000).toISOString().slice(0, 10)
      : null;

    // Send the cancellation confirmation NOW. The cancel is at period end, so
    // customer.subscription.deleted won't fire until that date (potentially months
    // away) — waiting for it would leave the customer with no confirmation. Email
    // failure must never fail the cancel (same rule as the webhook side-effects).
    let cancellationEmailSent = false;
    try {
      const r = await sendCancellationEmail({
        customer: { name: sub.customer && sub.customer.name, email: sub.customer && sub.customer.email },
        periodEndDate: periodEnd,
      });
      cancellationEmailSent = !!(r && r.sent);
    } catch (e) {
      console.error('[generator-care] cancellation email failed:', e && e.message);
    }

    const noteAddition = 'Canceled on ' + today + (reason ? ': ' + reason : '');
    const newNotes = sub.notes ? sub.notes + '\n\n' + noteAddition : noteAddition;
    // Stash the paid-through date (for the dashboard banner) and, if we sent the
    // confirmation, a dedupe marker so the eventual subscription.deleted event
    // doesn't send a second email.
    const newMeta = { ...(sub.raw_metadata || {}), service_through: periodEnd };
    if (cancellationEmailSent) newMeta.cancellation_email_sent_at = new Date().toISOString();

    const { data: updated, error: updErr } = await supabaseAdmin
      .from('generator_subscriptions')
      .update({
        status: 'canceled',
        notes: newNotes,
        raw_metadata: newMeta,
      })
      .eq('id', id)
      .select()
      .single();
    if (updErr) throw updErr;

    res.json({
      ok: true,
      subscription: updated,
      service_through: periodEnd,
      cancellation_email_sent: cancellationEmailSent,
    });
  } catch (err) {
    console.error('[generator-care] cancel subscription error:', err);
    res.status(500).json({ error: err.message });
  }
});


// Hardcoded catalog of one-time add-ons by gen class.
// Mirrors the catalog in bates-generator/netlify/functions/create-checkout.js.
// Live-mode price IDs as of the 2026-06-08 Stripe cutover.
const ADDON_CATALOG = {
  battery_replacement: {
    label: 'Battery Replacement',
    prices: {
      air_cooled:    { price_id: 'price_1Tg78FBbX7QhpMgbGVRxRJNo', amount_cents: 16500 },
      liquid_22_38:  { price_id: 'price_1Tg78EBbX7QhpMgbFvIrYuD1', amount_cents: 23500 },
      liquid_48_150: { price_id: 'price_1Tg78EBbX7QhpMgbOhRdCUUe', amount_cents: 26500 },
    },
  },
  exterior_wash: {
    label: 'Exterior Wash & Interior Blow-Out',
    prices: { all: { price_id: 'price_1Tg78FBbX7QhpMgbzrM2AE2n', amount_cents: 8500 } },
  },
  coolant_flush: {
    label: 'Coolant System Flush',
    prices: {
      liquid_22_38:  { price_id: 'price_1Tg78DBbX7QhpMgbhESS9Wyp', amount_cents: 59500 },
      liquid_48_150: { price_id: 'price_1Tg78DBbX7QhpMgb7VtP2hGx', amount_cents: 69500 },
    },
  },
  coolant_topoff: {
    label: 'Coolant Top-Off Service',
    prices: {
      // Same Stripe price reused for both liquid tiers; service cost
      // doesn't vary by size. No air_cooled entry: air-cooled units
      // don't get coolant service.
      liquid_22_38:  { price_id: 'price_1Tg78CBbX7QhpMgbXptyAaje', amount_cents: 9500 },
      liquid_48_150: { price_id: 'price_1Tg78CBbX7QhpMgbXptyAaje', amount_cents: 9500 },
    },
  },
  ats_outage_combined: {
    label: 'Transfer Switch Inspection & Simulated Outage Test',
    prices: { all: { price_id: 'price_1Tg78DBbX7QhpMgby14G5PiY', amount_cents: 11000 } },
  },
};

function lookupAddonPrice(addonType, genClass) {
  const entry = ADDON_CATALOG[addonType];
  if (!entry) return null;
  if (entry.prices.all) return entry.prices.all;
  return entry.prices[genClass] || null;
}

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
    res.status(500).json({ error: err.message });
  }
});

// POST /api/generator-care/subscriptions/:id/add-addon
// Add a new pending add-on to an existing subscription mid-cycle.
// Body: { addon_type }
router.post('/subscriptions/:id/add-addon', async (req, res) => {
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

    const { data: inserted, error: insErr } = await supabaseAdmin
      .from('generator_pending_addons')
      .insert({
        subscription_id: id,
        addon_type,
        stripe_price_id: price.price_id,
        amount_cents: price.amount_cents,
        status: 'pending',
      })
      .select()
      .single();
    if (insErr) throw insErr;

    res.json({ ok: true, addon: inserted });
  } catch (err) {
    console.error('[generator-care] add-addon error:', err);
    res.status(500).json({ error: err.message });
  }
});


// POST /api/generator-care/addons/:id/remove
// Soft-delete a pending add-on (sets status='canceled'). Only allowed for status='pending'.
// Performed addons should use /unmark-performed first to revert to pending.
// Charged addons can't be removed (need a refund flow).
router.post('/addons/:id/remove', async (req, res) => {
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
    res.status(500).json({ error: err.message });
  }
});


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
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
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

    let result;
    try {
      result = await executeStripeRefund({
        paymentIntentId: charge.stripe_payment_intent_id,
        originalAmountCents: charge.amount_cents,
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
      stripe_status: result.refund.status,
    });
  } catch (err) {
    console.error('[generator-care] adhoc-charges refund error:', err);
    res.status(500).json({ error: err.message });
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
      stripe_status: result.refund.status,
      invoice_id: invoiceId,
    });
  } catch (err) {
    console.error('[generator-care] invoice refund error:', err);
    res.status(500).json({ error: err.message });
  }
});


// === ACCOUNTING ENDPOINTS ===

// GET /accounting/transactions?from=YYYY-MM-DD&to=YYYY-MM-DD
// Pulls succeeded charges from Stripe in the date range, joins with our DB
// for customer name + install address, and returns per-charge gross / Stripe fee / net.
router.get('/accounting/transactions', async (req, res) => {
  try {
    const today = new Date();
    const defaultFrom = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
    const fromDate = req.query.from ? new Date(req.query.from + 'T00:00:00Z') : defaultFrom;
    const toDate = req.query.to ? new Date(req.query.to + 'T23:59:59Z') : today;
    const fromTs = Math.floor(fromDate.getTime() / 1000);
    const toTs = Math.floor(toDate.getTime() / 1000);

    // Page through all charges in the range
    let allCharges = [];
    let starting_after = undefined;
    let safety = 0;
    do {
      const page = await stripe.charges.list({
        created: { gte: fromTs, lte: toTs },
        limit: 100,
        starting_after,
        expand: ['data.balance_transaction', 'data.invoice']
      });
      allCharges = allCharges.concat(page.data);
      starting_after = page.has_more ? page.data[page.data.length - 1].id : undefined;
      safety++;
      if (safety > 20) break;
    } while (starting_after);

    // Page through refunds in the same range too. Refunds don't change the
    // original charge's amount, so without surfacing them here, money returned to
    // customers (plan/invoice refunds AND ad-hoc refunds) would be invisible in
    // the books — the tab would overstate net revenue.
    let allRefunds = [];
    {
      let after = undefined;
      let guard = 0;
      do {
        const page = await stripe.refunds.list({
          created: { gte: fromTs, lte: toTs },
          limit: 100,
          starting_after: after,
          expand: ['data.balance_transaction', 'data.charge'],
        });
        allRefunds = allRefunds.concat(page.data);
        after = page.has_more ? page.data[page.data.length - 1].id : undefined;
        guard++;
        if (guard > 20) break;
      } while (after);
    }
    // Defensive: keep only refunds actually created in range, in case the list
    // endpoint ignores the created filter.
    allRefunds = allRefunds.filter(r => r.created >= fromTs && r.created <= toTs);

    // Look up customer info for all stripe customers in the result set (charges + refunds)
    const refundCustomerIds = allRefunds.map(r => (r.charge && typeof r.charge === 'object') ? r.charge.customer : null);
    const customerIds = [...new Set([...allCharges.map(c => c.customer), ...refundCustomerIds].filter(Boolean))];
    let customerMap = {};
    if (customerIds.length > 0) {
      const { data: subs, error: subErr } = await supabaseAdmin
        .from('generator_subscriptions')
        .select('stripe_customer_id, customer:generator_customers(name, install_address, install_city, install_state, install_zip)')
        .in('stripe_customer_id', customerIds);
      if (subErr) throw subErr;
      (subs || []).forEach(s => {
        if (s.customer) customerMap[s.stripe_customer_id] = s.customer;
      });
    }

    const chargeTxns = allCharges
      .filter(c => c.status === 'succeeded')
      .map(c => {
        const bt = c.balance_transaction;
        const cust = customerMap[c.customer] || {};
        const address = [cust.install_address, cust.install_city, cust.install_state, cust.install_zip].filter(Boolean).join(', ');
        let description = '';
        if (c.invoice && typeof c.invoice === 'object') {
          if (c.invoice.description) description = c.invoice.description;
          else if (c.invoice.subscription) description = 'Subscription renewal';
          else description = 'Invoice payment';
        } else if (c.description) {
          description = c.description;
        } else if (c.metadata && c.metadata.adhoc_charge_id) {
          description = 'Ad-hoc charge';
        } else {
          description = 'Card charge';
        }
        return {
          date: new Date(c.created * 1000).toISOString().slice(0, 10),
          customer_name: cust.name || '(unmatched)',
          address,
          description,
          gross_cents: c.amount,
          fee_cents: bt ? bt.fee : 0,
          net_cents: bt ? bt.net : c.amount,
          stripe_charge_id: c.id,
          stripe_customer_id: c.customer,
          is_refund: false
        };
      });

    // Refunds as negative entries. Stripe doesn't return the original processing
    // fee on a standard refund (balance_transaction.fee is 0), so net is the
    // negative refund amount — correctly leaving the business out the original fee.
    const refundTxns = allRefunds.map(r => {
      const bt = r.balance_transaction && typeof r.balance_transaction === 'object' ? r.balance_transaction : null;
      const ch = r.charge && typeof r.charge === 'object' ? r.charge : null;
      const custId = ch ? ch.customer : null;
      const cust = customerMap[custId] || {};
      const address = [cust.install_address, cust.install_city, cust.install_state, cust.install_zip].filter(Boolean).join(', ');
      const isInvoice = !!(ch && ch.invoice);
      const isAdhoc = !!(ch && ch.metadata && ch.metadata.adhoc_charge_id);
      return {
        date: new Date(r.created * 1000).toISOString().slice(0, 10),
        customer_name: cust.name || '(unmatched)',
        address,
        description: 'Refund' + (isInvoice ? ' (plan/invoice)' : isAdhoc ? ' (ad-hoc charge)' : ''),
        gross_cents: -r.amount,
        fee_cents: bt ? bt.fee : 0,
        net_cents: bt ? bt.net : -r.amount,
        stripe_charge_id: ch ? ch.id : (typeof r.charge === 'string' ? r.charge : null),
        stripe_customer_id: custId,
        is_refund: true
      };
    });

    const transactions = [...chargeTxns, ...refundTxns].sort((a, b) => a.date.localeCompare(b.date));

    res.json({
      from: fromDate.toISOString().slice(0, 10),
      to: toDate.toISOString().slice(0, 10),
      transactions,
      totals: {
        count: transactions.length,
        gross_cents: transactions.reduce((s, t) => s + t.gross_cents, 0),
        fee_cents: transactions.reduce((s, t) => s + t.fee_cents, 0),
        net_cents: transactions.reduce((s, t) => s + t.net_cents, 0)
      }
    });
  } catch (err) {
    console.error('[accounting] transactions error:', err);
    res.status(500).json({ error: err.message });
  }
});

// === CUSTOMER PORTAL ===

// POST /subscriptions/:id/portal-session
// Creates a Stripe Customer Portal session for the subscription's customer.
// Returns a one-time URL that the customer can use to update their card,
// see invoice history, or change their email/phone/address.
router.post('/subscriptions/:id/portal-session', async (req, res) => {
  try {
    const { data: sub, error: subErr } = await supabaseAdmin
      .from('generator_subscriptions')
      .select('stripe_customer_id, customer:generator_customers(name, email)')
      .eq('id', req.params.id)
      .single();
    if (subErr) throw subErr;
    if (!sub || !sub.stripe_customer_id) {
      return res.status(404).json({ error: 'Subscription or Stripe customer not found' });
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: sub.stripe_customer_id,
      return_url: 'https://app.bates-electric.com/generator-care.html'
    });

    const customerName = (sub.customer && sub.customer.name) || null;
    const customerEmail = (sub.customer && sub.customer.email) || null;

    // Auto-send the link to the customer (so Amy doesn't have to copy/paste).
    let emailSent = false;
    let emailReason = 'no email on file';
    if (customerEmail) {
      const r = await sendCardUpdateLinkEmail({
        name: customerName,
        email: customerEmail,
        portalUrl: session.url,
      });
      emailSent = r.sent;
      emailReason = r.reason || (r.sent ? 'sent' : 'failed');
    }

    res.json({
      url: session.url,
      customer_email: customerEmail,
      customer_name: customerName,
      expires_at: session.expires_at,
      email_sent: emailSent,
      email_status: emailReason,
    });
  } catch (err) {
    console.error('[portal-session] error:', err);
    res.status(500).json({ error: err.message });
  }
});


// POST /subscriptions/:id/resend-welcome
// Re-renders the welcome email from the subscription's current data and sends
// it to the customer on file. Same template that fires from
// customer.subscription.created. Useful when a customer says they never got
// the original or accidentally deleted it.
router.post('/subscriptions/:id/resend-welcome', async (req, res) => {
  try {
    const { data: sub, error: subErr } = await supabaseAdmin
      .from('generator_subscriptions')
      .select(`
        id, plan, annual_price_cents, next_visit_due, last_visit_date, fleet_monitoring,
        gen_class, gen_type_label, gen_model, gen_serial,
        raw_metadata,
        customer:generator_customers(name, email, install_address, install_city, install_state, install_zip)
      `)
      .eq('id', req.params.id)
      .single();
    if (subErr) throw subErr;
    if (!sub) return res.status(404).json({ error: 'Subscription not found' });

    const customer = sub.customer || {};
    if (!customer.email) {
      return res.status(400).json({
        ok: false,
        error: 'No email on file for this customer',
        customer_name: customer.name || null,
      });
    }

    // Prefer raw_metadata (what Stripe sent at signup); fall back to the
    // denormalized columns on the subscription/customer rows for older subs.
    const rawMeta = sub.raw_metadata || {};
    const meta = {
      gen_class: rawMeta.gen_class || sub.gen_class || '',
      gen_type: rawMeta.gen_type || sub.gen_type_label || '',
      gen_model: rawMeta.gen_model || sub.gen_model || '',
      gen_serial: rawMeta.gen_serial || sub.gen_serial || '',
      install_address: rawMeta.install_address || customer.install_address || '',
      install_city: rawMeta.install_city || customer.install_city || '',
      install_state: rawMeta.install_state || customer.install_state || '',
      install_zip: rawMeta.install_zip || customer.install_zip || '',
    };
    const planLabel = sub.plan === 'semi_annual' ? 'Semi-Annual' : (sub.plan === 'annual' ? 'Annual' : sub.plan);

    // If the first service visit has already happened, suppress the "First
    // visit:" row in the welcome email — showing a future date when there's
    // a prior last_visit_date would just confuse the customer.
    const nextVisitForEmail = sub.last_visit_date ? null : sub.next_visit_due;

    const { subject, html, text } = buildWelcomeEmail({
      customer,
      meta,
      planLabel,
      nextVisitDate: nextVisitForEmail,
      annualPriceCents: sub.annual_price_cents,
      fleetMonitoring: sub.fleet_monitoring,
    });

    const result = await sendEmail({
      to: customer.email,
      subject,
      html,
      text,
      logTag: '[resend-welcome]',
    });

    return res.json({
      ok: result.sent,
      sent: result.sent,
      customer_name: customer.name || null,
      customer_email: customer.email,
      email_status: result.reason || (result.sent ? 'sent' : 'failed'),
    });
  } catch (err) {
    console.error('[resend-welcome] error:', err);
    res.status(500).json({ error: err.message });
  }
});


// ---- Send "manage your account" email with portal link ----
async function sendCardUpdateLinkEmail({ name, email, portalUrl }) {
  const { subject, html, text } = buildCardUpdateLinkEmail({ name, portalUrl });
  return sendEmail({
    to: email,
    subject,
    html,
    text,
    logTag: '[card-update-link]',
  });
}

// Send the cancellation-confirmation email (period-end aware). Mirrors the
// webhook's sender so the dashboard cancel endpoint can confirm immediately
// instead of waiting for customer.subscription.deleted. Returns { sent, reason }.
async function sendCancellationEmail({ customer, periodEndDate }) {
  if (!customer || !customer.email) {
    console.log('[cancellation-email] no email on file, skipping');
    return { sent: false, reason: 'no email on file' };
  }
  const { subject, html, text } = buildCancellationEmail({ customer, periodEndDate });
  return sendEmail({
    to: customer.email,
    subject,
    html,
    text,
    logTag: '[cancellation-email]',
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
      .select('stripe_customer_id, customer:generator_customers(name, email)')
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
    });
  } catch (e) {
    console.error('[adhoc-charge] emailCardUpdateLinkForSub failed:', e && e.message);
    return { sent: false, reason: e && e.message };
  }
}


// POST /api/generator-care/admin/send-test-email
// Renders one of the customer-facing templates with fixture data and sends
// it to the supplied address. Lets us visually verify templates before
// flipping Stripe to live mode without triggering real customer events.
// Body: { template: 'welcome' | 'failed_charge' | 'portal_link', to: '...' }
const TEST_EMAIL_TEMPLATES = ['welcome', 'failed_charge', 'portal_link', 'visit_scheduled', 'visit_complete', 'renewal_upcoming', 'cancellation'];
const FAKE_PORTAL_URL = 'https://billing.stripe.com/p/session/test_PLACEHOLDER';

function buildTestTemplate(template) {
  if (template === 'welcome') {
    return buildWelcomeEmail({
      customer: { name: 'Sample Customer', email: 'sample@example.com' },
      meta: {
        gen_class: 'air_cooled',
        gen_type: 'Standby',
        gen_model: 'Generac Guardian 22kW',
        gen_serial: 'TEST-12345',
        install_address: '123 Main St',
        install_city: 'Imperial',
        install_state: 'MO',
        install_zip: '63052',
      },
      planLabel: 'Annual Care',
      nextVisitDate: '2026-08-15',
      annualPriceCents: 49900,
      fleetMonitoring: true,
    });
  }
  if (template === 'failed_charge') {
    return buildCardFailedEmail({
      customer: { name: 'Sample Customer' },
      amountCents: 11000,
      description: 'Transfer Switch Inspection & Simulated Outage Test',
      portalUrl: FAKE_PORTAL_URL,
    });
  }
  if (template === 'portal_link') {
    return buildCardUpdateLinkEmail({
      name: 'Sample Customer',
      portalUrl: FAKE_PORTAL_URL,
    });
  }
  if (template === 'visit_scheduled') {
    return buildVisitScheduledEmail({
      customer: { name: 'Sample Customer' },
      scheduledDate: '2026-08-15',
      planLabel: 'Annual',
    });
  }
  if (template === 'visit_complete') {
    return buildVisitCompletedEmail({
      customer: { name: 'Sample Customer' },
      completedDate: '2026-06-08',
      nextVisitDate: '2027-06-08',
      planLabel: 'Annual',
      notes: 'Replaced battery. Tested generator under load — ran cleanly for 15 minutes. Topped off coolant.',
    });
  }
  if (template === 'cancellation') {
    return buildCancellationEmail({
      customer: { name: 'Sample Customer', email: 'sample@example.com' },
      periodEndDate: '2026-12-11',
    });
  }
  if (template === 'renewal_upcoming') {
    return buildRenewalUpcomingEmail({
      customer: { name: 'Sample Customer' },
      renewalDate: '2026-08-15',
      amountCents: 50500,
      planLabel: 'Annual',
      lineItems: [
        { amount_cents: 39500, description: 'Air Cooled Generator Care -- Annual' },
        { amount_cents: 11000, description: 'Transfer Switch Inspection & Simulated Outage Test' },
      ],
    });
  }
  return null;
}

router.post('/admin/send-test-email', async (req, res) => {
  try {
    const { template, to } = req.body || {};
    if (!template || !TEST_EMAIL_TEMPLATES.includes(template)) {
      return res.status(400).json({ error: `template must be one of: ${TEST_EMAIL_TEMPLATES.join(', ')}` });
    }
    if (!to || typeof to !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to.trim())) {
      return res.status(400).json({ error: 'to must be a valid email address' });
    }
    const built = buildTestTemplate(template);
    if (!built) {
      return res.status(400).json({ error: 'unknown template' });
    }
    const subjectWithPrefix = `[TEST] ${built.subject}`;
    const result = await sendEmail({
      to: to.trim(),
      subject: subjectWithPrefix,
      html: built.html,
      text: built.text,
      logTag: `[test-email:${template}]`,
    });
    if (!result.sent) {
      return res.status(502).json({ ok: false, template, to: to.trim(), error: result.reason });
    }
    return res.json({ ok: true, sent: true, template, to: to.trim(), subject: subjectWithPrefix });
  } catch (err) {
    console.error('[admin/send-test-email] error:', err);
    return res.status(500).json({ error: err.message || 'unknown error' });
  }
});

module.exports = router;
