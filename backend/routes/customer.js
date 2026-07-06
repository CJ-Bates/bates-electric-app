// backend/routes/customer.js
// Customer Dashboard v1 API — mounted at /api/my.
//
// Auth: requireAuth + requireRole('customer') (magic-link / Supabase OTP users;
// role assigned by the signup trigger when the email matches an ACTIVE
// Generator Care customer — see sql/011_customer_portal.sql).
//
// IDOR-proof by construction: every handler resolves the customer id from the
// AUTHENTICATED email server-side (never trusts a client-sent id), and every
// row it touches is scoped to that customer's subscription.
//
// Customers never see: internal_note, office notes, Stripe ids, other
// customers. All writes flow through here (no customer write policies in RLS);
// LIVE-Stripe-affecting actions mirror the office logic exactly
// (lib/planChange.js, cancel below) — proration none, no charge today,
// cancel_at_period_end only. Refunds remain office-only (ToS §5).

const express = require('express');
const rateLimit = require('express-rate-limit');
const { supabaseAdmin } = require('../lib/supabase');
const { requireAuth, requireRole } = require('../middleware/auth');
const { stripe } = require('../lib/gcShared');
const catalog = require('../lib/generator-catalog');
const { computePlanBilling } = require('../lib/planBilling');
const { changePlanAtRenewal } = require('../lib/planChange');
const { sendReceiptEmail } = require('../lib/receipts');
const { sendEmail, buildCancellationEmail } = require('../lib/emails');
const { companyName, isFlorida } = require('../lib/branding');

const router = express.Router();

const VISIT_PHOTOS_BUCKET = 'generator-visit-photos';
const PHOTO_URL_TTL_SECONDS = 60 * 30; // dashboard session-length

// Internal notifications land on the office role mailbox (digest convention).
const OFFICE_NOTIFY_TO = (process.env.GENERATOR_DIGEST_TO || 'cjbates@bates-electric.com,generators@bates-electric.com')
  .split(',').map((s) => s.trim()).filter(Boolean);

const RATE_MESSAGE = { error: 'Too many requests — please wait a few minutes and try again.' };
// Reads: generous (each dashboard load is 1 overview call).
const readLimiter = rateLimit({
  windowMs: 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false, message: RATE_MESSAGE,
});
// Writes / email-triggering endpoints: strict.
const writeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false, message: RATE_MESSAGE,
});

router.use(requireAuth, requireRole('customer'));

const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max || 500) : '');
const fmtDate = (d) => {
  if (!d) return null;
  try {
    const [y, m, day] = String(d).slice(0, 10).split('-').map(Number);
    return new Date(y, (m || 1) - 1, day || 1)
      .toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch (e) { return d; }
};

// ---------------------------------------------------------------------------
// Customer resolution — the security anchor for every handler.
// The email may match more than one customer row (edge case); we take them
// all and pick the most relevant subscription: active > past_due > other,
// then newest signup.
// ---------------------------------------------------------------------------
const SUB_RANK = { active: 0, past_due: 1 };
async function resolveCustomer(req) {
  const email = (req.user && req.user.email) || '';
  if (!email) return null;

  const { data: customers, error: cErr } = await supabaseAdmin
    .from('generator_customers')
    .select('id, name, email, phone, install_address, install_city, install_state, install_zip, stripe_customer_id')
    .ilike('email', email);
  if (cErr) throw cErr;
  if (!customers || !customers.length) return null;

  const ids = customers.map((c) => c.id);
  const { data: subs, error: sErr } = await supabaseAdmin
    .from('generator_subscriptions')
    .select('*')
    .in('customer_id', ids);
  if (sErr) throw sErr;
  if (!subs || !subs.length) return null;

  subs.sort((a, b) => {
    const ra = SUB_RANK[a.status] !== undefined ? SUB_RANK[a.status] : 9;
    const rb = SUB_RANK[b.status] !== undefined ? SUB_RANK[b.status] : 9;
    if (ra !== rb) return ra - rb;
    return String(b.signup_date || '').localeCompare(String(a.signup_date || ''));
  });
  const sub = subs[0];
  const customer = customers.find((c) => c.id === sub.customer_id) || customers[0];
  return { customer, sub, allStripeCustomerIds: customers.map((c) => c.stripe_customer_id).filter(Boolean) };
}

// Wrap resolution so handlers stay flat.
async function ctxOr403(req, res) {
  const ctx = await resolveCustomer(req);
  if (!ctx) {
    res.status(403).json({ error: 'No Generator Care account is linked to this email. Call (636) 464-3939 if that seems wrong.' });
    return null;
  }
  return ctx;
}

// ---------------------------------------------------------------------------
// GET /api/my/overview — everything the dashboard needs in one call.
// ---------------------------------------------------------------------------
router.get('/overview', readLimiter, async (req, res) => {
  try {
    const ctx = await ctxOr403(req, res);
    if (!ctx) return;
    const { customer, sub } = ctx;

    // Visits (customer-visible fields ONLY — never internal_note).
    const { data: visitRows, error: vErr } = await supabaseAdmin
      .from('generator_service_visits')
      .select('id, visit_type, status, scheduled_date, appointment_at, completed_date, notes')
      .eq('subscription_id', sub.id)
      .neq('status', 'canceled')
      .order('completed_date', { ascending: false, nullsFirst: true })
      .order('scheduled_date', { ascending: false, nullsFirst: false });
    if (vErr) throw vErr;
    const visits = visitRows || [];

    // Photos per visit — graceful no-op when the phase-2 migration isn't
    // applied yet (query errors → empty strips).
    const photosByVisit = {};
    try {
      const visitIds = visits.map((v) => v.id);
      if (visitIds.length) {
        const { data: photoRows, error: pErr } = await supabaseAdmin
          .from('generator_visit_photos')
          .select('id, visit_id, storage_path')
          .in('visit_id', visitIds)
          .order('created_at', { ascending: true });
        if (!pErr && photoRows && photoRows.length) {
          const { data: signed } = await supabaseAdmin
            .storage.from(VISIT_PHOTOS_BUCKET)
            .createSignedUrls(photoRows.map((r) => r.storage_path), PHOTO_URL_TTL_SECONDS);
          const byPath = new Map((signed || []).map((s) => [s.path, s.signedUrl]));
          for (const r of photoRows) {
            const url = byPath.get(r.storage_path);
            if (!url) continue;
            (photosByVisit[r.visit_id] = photosByVisit[r.visit_id] || []).push(url);
          }
        }
      }
    } catch (e) {
      console.log('[my] visit photos unavailable (migration pending?):', e && e.message);
    }

    // Add-ons: pending/performed one-time set + the standing (auto-return) set.
    const { data: addonRows, error: aErr } = await supabaseAdmin
      .from('generator_pending_addons')
      .select('id, addon_type, amount_cents, status, date_performed')
      .eq('subscription_id', sub.id)
      .in('status', ['pending', 'performed'])
      .order('created_at', { ascending: true });
    if (aErr) throw aErr;
    const labelFor = (t) => (catalog.ADDON_CATALOG[t] && catalog.ADDON_CATALOG[t].label) || t;
    const addons = (addonRows || []).map((a) => ({
      id: a.id,
      label: labelFor(a.addon_type),
      addon_type: a.addon_type,
      amount_cents: a.amount_cents,
      status: a.status,
      removable: a.status === 'pending',
    }));
    const standing = (sub.standing_addons || []).map((t) => {
      const price = catalog.lookupAddonPrice(t, sub.gen_class);
      return { addon_type: t, label: labelFor(t), amount_cents: price ? price.amount_cents : null };
    });
    // Catalog for the "+ Add a service" picker: priced for their gen class.
    const availableAddons = Object.keys(catalog.ADDON_CATALOG)
      .map((t) => {
        const price = catalog.lookupAddonPrice(t, sub.gen_class);
        return price ? { addon_type: t, label: labelFor(t), amount_cents: price.amount_cents } : null;
      })
      .filter(Boolean);

    // Live Stripe: renewal + pending plan change + paid invoices.
    let planBilling = null;
    let invoices = [];
    if (sub.stripe_customer_id) {
      const [subResult, invoiceResult] = await Promise.allSettled([
        sub.stripe_subscription_id
          ? stripe.subscriptions.retrieve(sub.stripe_subscription_id, { expand: ['schedule'] })
          : Promise.resolve(null),
        stripe.invoices.list({ customer: sub.stripe_customer_id, status: 'paid', limit: 24 }),
      ]);
      if (subResult.status === 'fulfilled' && subResult.value) {
        planBilling = computePlanBilling(subResult.value);
        planBilling.cancel_at_period_end = !!subResult.value.cancel_at_period_end;
      } else if (subResult.status === 'rejected') {
        console.error('[my] subscription retrieve failed:', subResult.reason && subResult.reason.message);
      }
      if (invoiceResult.status === 'fulfilled') {
        invoices = (invoiceResult.value.data || []).map((inv) => ({
          id: inv.id,
          date: inv.created ? new Date(inv.created * 1000).toISOString().slice(0, 10) : null,
          description: (inv.lines && inv.lines.data && inv.lines.data[0] && inv.lines.data[0].description) || 'Generator Care',
          amount_cents: inv.amount_paid || 0,
          hosted_invoice_url: inv.hosted_invoice_url || null,
        }));
      } else {
        console.error('[my] invoices.list failed:', invoiceResult.reason && invoiceResult.reason.message);
      }
    }

    // Next visit: earliest open one.
    const open = visits.filter((v) => v.status !== 'completed' && !v.completed_date);
    open.sort((a, b) => String(a.appointment_at || a.scheduled_date || '9999')
      .localeCompare(String(b.appointment_at || b.scheduled_date || '9999')));
    const nextVisit = open[0] || null;

    const planLabel = sub.plan === 'semi_annual'
      ? 'Semi-Annual — 2 visits/year'
      : (sub.plan === 'annual' ? 'Annual — 1 visit/year' : sub.plan);

    res.json({
      branding: {
        company_name: companyName(customer.install_state),
        is_florida: isFlorida(customer.install_state),
      },
      customer: {
        name: customer.name,
        email: customer.email,
        phone: customer.phone,
        install_address: customer.install_address,
        install_city: customer.install_city,
        install_state: customer.install_state,
        install_zip: customer.install_zip,
      },
      generator: {
        gen_class: sub.gen_class,
        type_label: sub.gen_type_label || null,
        model: sub.gen_model || null,
        serial: sub.gen_serial || null,
      },
      plan: {
        plan: sub.plan,
        label: planLabel,
        status: sub.status,
        service_through: (sub.raw_metadata && sub.raw_metadata.service_through) || null,
        billing: planBilling, // { current_period_end, current_renewal_amount_cents, pending_change, cancel_at_period_end }
        other_plan: sub.plan === 'annual' ? 'semi_annual' : 'annual',
      },
      next_visit: nextVisit && {
        id: nextVisit.id,
        appointment_at: nextVisit.appointment_at,
        due_date: nextVisit.scheduled_date,
        status: nextVisit.status,
      },
      visits: visits.map((v) => ({
        id: v.id,
        status: (v.completed_date || v.status === 'completed') ? 'completed'
          : (v.appointment_at ? 'scheduled' : 'upcoming'),
        appointment_at: v.appointment_at,
        due_date: v.scheduled_date,
        completed_date: v.completed_date,
        notes: v.notes || null,
        photos: photosByVisit[v.id] || [],
      })),
      addons: { pending: addons, standing, available: availableAddons },
      invoices,
    });
  } catch (err) {
    console.error('[my] overview error:', err && err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/my/reschedule-request — does NOT change the visit; emails the
// office + a confirmation to the customer.
// ---------------------------------------------------------------------------
router.post('/reschedule-request', writeLimiter, async (req, res) => {
  try {
    const ctx = await ctxOr403(req, res);
    if (!ctx) return;
    const { customer, sub } = ctx;

    const preferred = str(req.body && req.body.preferred, 120);
    const note = str(req.body && req.body.note, 1000);
    if (!preferred) return res.status(400).json({ error: 'Tell us your preferred day or time.' });

    // Their next open visit provides the "from" context (no visit id trusted
    // from the client).
    const { data: openVisit } = await supabaseAdmin
      .from('generator_service_visits')
      .select('id, appointment_at, scheduled_date')
      .eq('subscription_id', sub.id)
      .is('completed_date', null)
      .neq('status', 'canceled')
      .order('scheduled_date', { ascending: true, nullsFirst: false })
      .limit(1)
      .maybeSingle();

    const currentStr = openVisit
      ? (openVisit.appointment_at
        ? new Date(openVisit.appointment_at).toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' CT'
        : (openVisit.scheduled_date ? 'due ' + fmtDate(openVisit.scheduled_date) : 'unscheduled'))
      : 'unscheduled';

    const officeLine = `Customer ${customer.name} (${customer.email}) requests moving their visit from ${currentStr} to: ${preferred}.`
      + (note ? `\nNote: ${note}` : '');
    await sendEmail({
      to: OFFICE_NOTIFY_TO,
      subject: `[Generator Care] Reschedule request — ${customer.name}`,
      html: `<p style="font-family:system-ui,sans-serif;font-size:14px;white-space:pre-line;">${officeLine.replace(/</g, '&lt;')}</p>`,
      text: officeLine,
      logTag: '[my-reschedule-request]',
    });

    const custLine = `Got it — we received your request to move your service visit to: ${preferred}. `
      + `Our office will confirm the new time with you soon. Nothing changes until we confirm.`;
    sendEmail({
      to: customer.email,
      subject: 'We received your visit reschedule request',
      html: `<p style="font-family:system-ui,sans-serif;font-size:14px;">${custLine.replace(/</g, '&lt;')}</p>`,
      text: custLine,
      logTag: '[my-reschedule-confirm]',
      companyState: customer.install_state,
    }).catch((e) => console.error('[my-reschedule-confirm] unexpected:', e && e.message));

    res.json({ ok: true });
  } catch (err) {
    console.error('[my] reschedule-request error:', err && err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/my/change-plan — Semi-Annual <-> Annual at next renewal ONLY.
// ---------------------------------------------------------------------------
router.post('/change-plan', writeLimiter, async (req, res) => {
  try {
    const ctx = await ctxOr403(req, res);
    if (!ctx) return;
    const { sub } = ctx;

    const newPlan = str(req.body && req.body.new_plan, 20);
    const result = await changePlanAtRenewal({ stripe, subRow: sub, newPlan });
    if (result.error) return res.status(result.status || 400).json({ error: result.error });
    res.json(result);
  } catch (err) {
    console.error('[my] change-plan error:', err && err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/my/addons — add a pre-authorized add-on (pending; billed only when
// performed — never charges here). Mirrors the office add-addon handler.
// ---------------------------------------------------------------------------
router.post('/addons', writeLimiter, async (req, res) => {
  try {
    const ctx = await ctxOr403(req, res);
    if (!ctx) return;
    const { sub } = ctx;

    if (sub.status === 'canceled') {
      return res.status(400).json({ error: 'Your plan is canceled — call the office to add services.' });
    }
    const addonType = str(req.body && req.body.addon_type, 60);
    const price = catalog.lookupAddonPrice(addonType, sub.gen_class);
    if (!price) return res.status(400).json({ error: 'That service is not available for your generator.' });

    // Same open-visit attachment the office uses.
    const { data: openVisit } = await supabaseAdmin
      .from('generator_service_visits')
      .select('id')
      .eq('subscription_id', sub.id)
      .is('completed_date', null)
      .neq('status', 'canceled')
      .order('scheduled_date', { ascending: true, nullsFirst: false })
      .limit(1)
      .maybeSingle();

    const { data: inserted, error: insErr } = await supabaseAdmin
      .from('generator_pending_addons')
      .insert({
        subscription_id: sub.id,
        addon_type: addonType,
        stripe_price_id: price.price_id,
        amount_cents: price.amount_cents,
        status: 'pending',
        service_visit_id: openVisit ? openVisit.id : null,
        notes: 'Added by customer via dashboard on ' + new Date().toISOString().slice(0, 10),
      })
      .select('id, addon_type, amount_cents, status')
      .single();
    if (insErr) throw insErr;

    res.json({ ok: true, addon: inserted });
  } catch (err) {
    console.error('[my] add addon error:', err && err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/my/addons/:id — remove ONLY rows still pending (never performed/
// charged), scoped to the customer's own subscription.
router.delete('/addons/:id', writeLimiter, async (req, res) => {
  try {
    const ctx = await ctxOr403(req, res);
    if (!ctx) return;
    const { sub } = ctx;

    const { data: addon, error: aErr } = await supabaseAdmin
      .from('generator_pending_addons')
      .select('id, status, subscription_id')
      .eq('id', req.params.id)
      .eq('subscription_id', sub.id) // ownership — server-resolved
      .maybeSingle();
    if (aErr) throw aErr;
    if (!addon) return res.status(404).json({ error: 'Add-on not found.' });
    if (addon.status !== 'pending') {
      return res.status(400).json({ error: 'This service has already been performed — call the office if something looks wrong.' });
    }

    const { error: updErr } = await supabaseAdmin
      .from('generator_pending_addons')
      .update({
        status: 'canceled',
        notes: 'Removed by customer via dashboard on ' + new Date().toISOString().slice(0, 10),
      })
      .eq('id', addon.id)
      .eq('status', 'pending'); // no racing past a concurrent office action
    if (updErr) throw updErr;

    res.json({ ok: true });
  } catch (err) {
    console.error('[my] remove addon error:', err && err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/my/billing-portal — Stripe-hosted card & billing management.
// ---------------------------------------------------------------------------
router.get('/billing-portal', writeLimiter, async (req, res) => {
  try {
    const ctx = await ctxOr403(req, res);
    if (!ctx) return;
    const { sub } = ctx;
    if (!sub.stripe_customer_id) return res.status(404).json({ error: 'No billing account on file — call the office.' });

    const session = await stripe.billingPortal.sessions.create({
      customer: sub.stripe_customer_id,
      return_url: 'https://app.bates-electric.com/my.html',
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('[my] billing-portal error:', err && err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/my/cancel — cancel_at_period_end, exactly like the office control
// (confirmation email now; dedupe marker so the webhook doesn't re-send; the
// office sees the status change as it already does). No refund paths here.
// MIRRORS the office cancel handler in routes/generator-care/subscriptions.js.
// ---------------------------------------------------------------------------
router.post('/cancel', writeLimiter, async (req, res) => {
  try {
    const ctx = await ctxOr403(req, res);
    if (!ctx) return;
    const { customer, sub } = ctx;

    const reason = str(req.body && req.body.reason, 500);
    if (sub.status === 'canceled') return res.status(400).json({ error: 'Your plan is already canceled.' });
    if (!sub.stripe_subscription_id) return res.status(400).json({ error: 'No billing subscription on file — call the office.' });

    let stripeSub;
    try {
      stripeSub = await stripe.subscriptions.update(sub.stripe_subscription_id, {
        cancel_at_period_end: true,
        cancellation_details: { comment: reason ? `Customer via dashboard: ${reason}` : 'Customer via dashboard' },
      });
    } catch (stripeErr) {
      console.error('[my] Stripe cancel failed:', stripeErr && stripeErr.message);
      return res.status(502).json({ error: 'We could not reach billing — nothing changed. Please try again or call the office.' });
    }

    const today = new Date().toISOString().slice(0, 10);
    const periodEndTs = stripeSub.current_period_end
      || (stripeSub.items && stripeSub.items.data && stripeSub.items.data[0] && stripeSub.items.data[0].current_period_end)
      || null;
    const periodEnd = periodEndTs ? new Date(periodEndTs * 1000).toISOString().slice(0, 10) : null;

    let cancellationEmailSent = false;
    try {
      const { subject, html, text } = buildCancellationEmail({
        customer: { name: customer.name, email: customer.email, install_state: customer.install_state },
        periodEndDate: periodEnd,
        companyState: customer.install_state,
      });
      const r = await sendEmail({
        to: customer.email, subject, html, text,
        logTag: '[cancellation-email]', companyState: customer.install_state,
      });
      cancellationEmailSent = !!(r && r.sent);
    } catch (e) {
      console.error('[my] cancellation email failed:', e && e.message);
    }

    const noteAddition = 'Canceled by customer via dashboard on ' + today + (reason ? ': ' + reason : '');
    const newNotes = sub.notes ? sub.notes + '\n\n' + noteAddition : noteAddition;
    const newMeta = { ...(sub.raw_metadata || {}), service_through: periodEnd };
    if (cancellationEmailSent) newMeta.cancellation_email_sent_at = new Date().toISOString();

    const { error: updErr } = await supabaseAdmin
      .from('generator_subscriptions')
      .update({
        status: 'canceled',
        canceled_at: new Date().toISOString(),
        notes: newNotes,
        raw_metadata: newMeta,
      })
      .eq('id', sub.id);
    if (updErr) throw updErr;

    // Heads-up to the office (customers canceling silently is worth a ping).
    const line = `Customer ${customer.name} (${customer.email}) canceled their Generator Care plan via the dashboard.`
      + (periodEnd ? ` Service continues through ${periodEnd}.` : '') + (reason ? ` Reason: ${reason}` : '');
    sendEmail({
      to: OFFICE_NOTIFY_TO,
      subject: `[Generator Care] Customer cancellation — ${customer.name}`,
      html: `<p style="font-family:system-ui,sans-serif;font-size:14px;">${line.replace(/</g, '&lt;')}</p>`,
      text: line,
      logTag: '[my-cancel-notify]',
    }).catch((e) => console.error('[my-cancel-notify] unexpected:', e && e.message));

    res.json({ ok: true, service_through: periodEnd });
  } catch (err) {
    console.error('[my] cancel error:', err && err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/my/resend-receipt/:invoiceId — ownership-checked receipt resend.
// ---------------------------------------------------------------------------
router.post('/resend-receipt/:invoiceId', writeLimiter, async (req, res) => {
  try {
    const ctx = await ctxOr403(req, res);
    if (!ctx) return;
    const { allStripeCustomerIds } = ctx;

    let invoice;
    try {
      invoice = await stripe.invoices.retrieve(req.params.invoiceId);
    } catch (e) {
      return res.status(404).json({ error: 'Receipt not found.' });
    }
    const invCustomer = typeof invoice.customer === 'string' ? invoice.customer : (invoice.customer && invoice.customer.id);
    if (!invCustomer || !allStripeCustomerIds.includes(invCustomer)) {
      return res.status(403).json({ error: 'Receipt not found.' }); // same message — no enumeration
    }
    if (invoice.status !== 'paid') {
      return res.status(400).json({ error: 'Only paid invoices have receipts.' });
    }

    const result = await sendReceiptEmail(invoice);
    if (!result || !result.sent) {
      return res.status(502).json({ error: 'Could not send the receipt — try again or call the office.' });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[my] resend-receipt error:', err && err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
