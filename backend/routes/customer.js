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
const { computePlanBilling, changePlanAtRenewal } = require('../lib/planChange');
const { sendReceiptEmail } = require('../lib/receipts');
const { sendEmail, buildCancellationEmail } = require('../lib/emails');
const { companyName, isFlorida } = require('../lib/branding');
const { normalizePhone, recordConsent, sendSms, buildOptInConfirmationSms, CONSENT_TEXT } = require('../lib/sms');

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
// GET /api/my/overview — everything the dashboard needs that lives in OUR
// database. Deliberately NO Stripe calls here: live billing (renewal amount,
// pending plan change, invoices) comes from GET /api/my/billing, which the
// page fires right after this one — visits/photos/plan paint immediately and
// billing fills in a beat later.
// ---------------------------------------------------------------------------
router.get('/overview', readLimiter, async (req, res) => {
  try {
    const ctx = await ctxOr403(req, res);
    if (!ctx) return;
    const { customer, sub } = ctx;

    // Visits (customer-visible fields ONLY — never internal_note).
    const { data: visitRows, error: vErr } = await supabaseAdmin
      .from('generator_service_visits')
      .select('id, visit_type, status, scheduled_date, appointment_at, arrival_window, completed_date, notes')
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
    // Charged rows are ALSO fetched — not for the add-ons card, but so each
    // completed visit can itemize the add-on work done that day.
    const { data: addonRows, error: aErr } = await supabaseAdmin
      .from('generator_pending_addons')
      .select('id, addon_type, amount_cents, status, date_performed, service_visit_id')
      .eq('subscription_id', sub.id)
      .in('status', ['pending', 'performed', 'charged'])
      .order('created_at', { ascending: true });
    if (aErr) throw aErr;
    const labelFor = (t) => (catalog.ADDON_CATALOG[t] && catalog.ADDON_CATALOG[t].label) || t;
    const addons = (addonRows || [])
      .filter((a) => a.status === 'pending' || a.status === 'performed')
      .map((a) => ({
        id: a.id,
        label: labelFor(a.addon_type),
        addon_type: a.addon_type,
        amount_cents: a.amount_cents,
        status: a.status,
        removable: a.status === 'pending',
      }));
    // Add-on work by visit: performed or charged, attached to a visit. Names
    // only — never amounts-owed language on the visit history.
    const performedByVisit = {};
    for (const a of addonRows || []) {
      if (!a.service_visit_id) continue;
      if (a.status !== 'performed' && a.status !== 'charged') continue;
      (performedByVisit[a.service_visit_id] = performedByVisit[a.service_visit_id] || [])
        .push({ label: labelFor(a.addon_type), date_performed: a.date_performed });
    }
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

    // Next visit: earliest open one.
    const open = visits.filter((v) => v.status !== 'completed' && !v.completed_date);
    open.sort((a, b) => String(a.appointment_at || a.scheduled_date || '9999')
      .localeCompare(String(b.appointment_at || b.scheduled_date || '9999')));
    const nextVisit = open[0] || null;

    // The customer's pending appointment preferences for that visit — graceful
    // no-op when the 016 migration isn't applied yet (same pattern as photos).
    let preferences = null;
    if (nextVisit) {
      try {
        const { data: prefRow, error: prefErr } = await supabaseAdmin
          .from('generator_visit_preferences')
          .select('slots, note, created_at')
          .eq('visit_id', nextVisit.id)
          .eq('status', 'pending')
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (!prefErr && prefRow) {
          preferences = { slots: prefRow.slots || [], note: prefRow.note || '', created_at: prefRow.created_at };
        }
      } catch (e) {
        console.log('[my] visit preferences unavailable (migration pending?):', e && e.message);
      }
    }

    // SMS consent state for the "Text me appointment reminders" toggle.
    // Graceful no-op when the 025 migration isn't applied yet.
    let sms = { available: false, opted_in: false };
    try {
      const smsPhone = normalizePhone(customer.phone);
      if (smsPhone) {
        sms.available = true;
        const { data: consentRow, error: consentErr } = await supabaseAdmin
          .from('generator_sms_consent')
          .select('opted_in, opted_out')
          .eq('customer_id', customer.id)
          .eq('phone', smsPhone)
          .maybeSingle();
        if (!consentErr && consentRow) {
          sms.opted_in = !!(consentRow.opted_in && !consentRow.opted_out);
        }
      }
    } catch (e) {
      console.log('[my] sms consent unavailable (migration pending?):', e && e.message);
      sms = { available: false, opted_in: false };
    }

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
      // { available (a usable phone is on file), opted_in } — drives the
      // "Text me appointment reminders" toggle.
      sms,
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
        billing: null, // live Stripe billing arrives via GET /api/my/billing
        other_plan: sub.plan === 'annual' ? 'semi_annual' : 'annual',
        // Standard services performed on every plan visit (keyed by gen class)
        // — the "Included in your plan" checklist on completed visits.
        visit_items: catalog.planVisitItems(sub.gen_class),
      },
      next_visit: nextVisit && {
        id: nextVisit.id,
        appointment_at: nextVisit.appointment_at,
        arrival_window: nextVisit.arrival_window || null,
        due_date: nextVisit.scheduled_date,
        status: nextVisit.status,
        preferences, // { slots, note, created_at } | null — pending only
      },
      visits: visits.map((v) => ({
        id: v.id,
        // The plan checklist only applies to regular plan visits — an
        // on-demand trip didn't include the full service list.
        is_plan_visit: v.visit_type === 'regular_service',
        status: (v.completed_date || v.status === 'completed') ? 'completed'
          : (v.appointment_at ? 'scheduled' : 'upcoming'),
        appointment_at: v.appointment_at,
        arrival_window: v.arrival_window || null,
        due_date: v.scheduled_date,
        completed_date: v.completed_date,
        notes: v.notes || null,
        photos: photosByVisit[v.id] || [],
        performed_addons: performedByVisit[v.id] || [],
      })),
      addons: { pending: addons, standing, available: availableAddons },
    });
  } catch (err) {
    console.error('[my] overview error:', err && err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/my/billing — the live-Stripe half of the dashboard: renewal amount,
// pending plan change, cancel-at-period-end, paid invoices. Fired by the page
// right after /overview so the Stripe round-trips never block first paint.
// Independent reads run in parallel; if one fails the other still returns
// (billing: null / invoices: []) — never a 500 for a partial outage.
// ---------------------------------------------------------------------------
router.get('/billing', readLimiter, async (req, res) => {
  try {
    const ctx = await ctxOr403(req, res);
    if (!ctx) return;
    const { sub } = ctx;

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

    res.json({ billing: planBilling, invoices });
  } catch (err) {
    console.error('[my] billing error:', err && err.message);
    res.status(500).json({ error: 'Server error' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/my/visit-preferences — the customer proposes up to three
// date + arrival-window slots for their next open visit, from the SAME
// window list Amy books from (generator-catalog ARRIVAL_WINDOWS), so a
// proposed slot maps 1:1 to a bookable appointment. Stores them (replacing
// any still-pending submission for that visit) + emails the office. The
// office confirms via the existing booking flow — typically about two weeks
// before the visit is due — which marks these used and sends the
// confirmation email.
// ---------------------------------------------------------------------------
// Slots submitted by pre-arrival-window clients (cached my.js) used 'AM'/'PM';
// still accepted + labeled so nothing breaks mid-rollout.
const LEGACY_PREF_WINDOWS = { AM: 'morning (8am–noon)', PM: 'afternoon (noon–4pm)' };

// Human label for a preference slot's window (arrival-window code or legacy
// AM/PM), or null when it isn't a recognized value.
function prefWindowLabel(w) {
  return catalog.arrivalWindowLabel(w) || LEGACY_PREF_WINDOWS[w] || null;
}

router.post('/visit-preferences', writeLimiter, async (req, res) => {
  try {
    const ctx = await ctxOr403(req, res);
    if (!ctx) return;
    const { customer, sub } = ctx;

    // Validate: 1-3 future dates, each with an arrival window (or legacy
    // AM/PM from a stale client). Today (Central) is the cutoff — same-day
    // proposals aren't schedulable anyway.
    const raw = Array.isArray(req.body && req.body.slots) ? req.body.slots.slice(0, 3) : [];
    const todayCentral = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
    const slots = [];
    const seen = new Set();
    for (const s of raw) {
      const date = str(s && s.date, 10);
      const window = str(s && s.window, 8);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(new Date(date + 'T12:00:00').getTime())) {
        return res.status(400).json({ error: 'One of the dates is not valid.' });
      }
      if (date <= todayCentral) {
        return res.status(400).json({ error: 'Preferred dates need to be in the future.' });
      }
      if (!prefWindowLabel(window)) {
        return res.status(400).json({ error: 'Pick an arrival window for each date.' });
      }
      const key = date + window;
      if (seen.has(key)) continue; // silently drop exact duplicates
      seen.add(key);
      slots.push({ date, window });
    }
    if (!slots.length) return res.status(400).json({ error: 'Pick at least one preferred date.' });
    const note = str(req.body && req.body.note, 500);

    // Their next open visit — server-resolved, never a client-sent visit id.
    const { data: openVisit, error: ovErr } = await supabaseAdmin
      .from('generator_service_visits')
      .select('id, appointment_at, scheduled_date')
      .eq('subscription_id', sub.id)
      .is('completed_date', null)
      .neq('status', 'canceled')
      .order('scheduled_date', { ascending: true, nullsFirst: false })
      .limit(1)
      .maybeSingle();
    if (ovErr) throw ovErr;
    if (!openVisit) {
      return res.status(400).json({ error: 'No upcoming visit to schedule yet — we’ll reach out when your next one comes due.' });
    }

    // Resubmit replaces: clear any still-pending submission for this visit,
    // then store the new one. Used/dismissed rows stay for history.
    const { error: clearErr } = await supabaseAdmin
      .from('generator_visit_preferences')
      .update({ status: 'dismissed' })
      .eq('visit_id', openVisit.id)
      .eq('status', 'pending');
    if (clearErr) throw clearErr;
    const { data: inserted, error: insErr } = await supabaseAdmin
      .from('generator_visit_preferences')
      .insert({ visit_id: openVisit.id, slots, note: note || null, status: 'pending' })
      .select('slots, note, created_at')
      .single();
    if (insErr) throw insErr;

    // Heads-up to the office mailbox (same convention as reschedule requests).
    const slotLines = slots.map((s, i) => `  ${i + 1}) ${fmtDate(s.date)} — ${prefWindowLabel(s.window)} arrival`).join('\n');
    const dueStr = openVisit.scheduled_date ? `due ${fmtDate(openVisit.scheduled_date)}` : 'no due date on record';
    const officeLine = `Customer ${customer.name} (${customer.email}) proposed appointment times for their next visit (${dueStr}):\n${slotLines}`
      + (note ? `\nNote: ${note}` : '')
      + '\n\nOpen their card in the dashboard to book one — booking marks these handled and emails the customer their confirmation.';
    await sendEmail({
      to: OFFICE_NOTIFY_TO,
      subject: `[Generator Care] Appointment preferences — ${customer.name}`,
      html: `<p style="font-family:system-ui,sans-serif;font-size:14px;white-space:pre-line;">${officeLine.replace(/</g, '&lt;')}</p>`,
      text: officeLine,
      logTag: '[my-visit-preferences]',
    });

    res.json({ ok: true, preferences: { slots: inserted.slots, note: inserted.note || '', created_at: inserted.created_at } });
  } catch (err) {
    console.error('[my] visit-preferences error:', err && err.message);
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
    const { data: openVisit, error: ovErr } = await supabaseAdmin
      .from('generator_service_visits')
      .select('id, appointment_at, arrival_window, scheduled_date')
      .eq('subscription_id', sub.id)
      .is('completed_date', null)
      .neq('status', 'canceled')
      .order('scheduled_date', { ascending: true, nullsFirst: false })
      .limit(1)
      .maybeSingle();
    if (ovErr) throw ovErr;

    // Persist as a pending preference row — the SAME path /visit-preferences
    // writes — so the office Needs Attention queue surfaces this request; the
    // email alone is easy to lose. Free-text goes in the note (no structured
    // slots, so the office books manually rather than one-tap). Must succeed
    // BEFORE the emails go out: a request the customer believes was received
    // has to be visible in the queue.
    if (openVisit) {
      const { error: clearErr } = await supabaseAdmin
        .from('generator_visit_preferences')
        .update({ status: 'dismissed' })
        .eq('visit_id', openVisit.id)
        .eq('status', 'pending');
      if (clearErr) throw clearErr;
      const { error: insErr } = await supabaseAdmin
        .from('generator_visit_preferences')
        .insert({
          visit_id: openVisit.id,
          slots: [],
          note: 'Requested: ' + preferred + (note ? '\n' + note : ''),
          status: 'pending',
        });
      if (insErr) throw insErr;
    }

    // Booked appointments read as date + arrival window (how the whole app
    // speaks now); legacy bookings without a window fall back to the exact time.
    const windowLabel = openVisit && catalog.arrivalWindowLabel(openVisit.arrival_window);
    const currentStr = openVisit
      ? (openVisit.appointment_at
        ? (windowLabel
          ? new Date(openVisit.appointment_at).toLocaleDateString('en-US', { timeZone: 'America/Chicago', weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }) + ` · ${windowLabel} arrival`
          : new Date(openVisit.appointment_at).toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' CT')
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
// POST /api/my/sms-consent { opt_in: boolean } — the dashboard "Text me
// appointment reminders" toggle (SMS Phase 1). Writes the legal consent row
// (source 'dashboard', exact shown language stored) for the phone we have on
// file; the phone itself is never taken from the client. Opting in sends the
// carrier-required confirmation text (copy 6) — still behind the SMS_ENABLED
// kill-switch inside sendSms.
// ---------------------------------------------------------------------------
router.post('/sms-consent', writeLimiter, async (req, res) => {
  try {
    const ctx = await ctxOr403(req, res);
    if (!ctx) return;
    const { customer } = ctx;

    const optIn = !!(req.body && req.body.opt_in === true);
    const phone = normalizePhone(customer.phone);
    if (!phone) {
      return res.status(400).json({ error: "We don't have a mobile number on file. Call (636) 464-3939 and we'll add one." });
    }

    const row = await recordConsent({
      customerId: customer.id,
      phone,
      optedIn: optIn,
      source: 'dashboard',
      consentText: CONSENT_TEXT.dashboard,
    });
    if (!row) return res.status(500).json({ error: 'Could not save your preference. Please try again.' });

    if (optIn) {
      await sendSms({
        toPhone: phone,
        body: buildOptInConfirmationSms({ installState: customer.install_state }),
        customerId: customer.id,
        ignoreQuietHours: true, // immediate ack of the toggle they just flipped
      });
    }

    res.json({ ok: true, opted_in: !!(row.opted_in && !row.opted_out) });
  } catch (err) {
    console.error('[my] sms-consent error:', err && err.message);
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
    if (result.error) {
      // Undo/revert is office-only — a customer can't self-clear a pending
      // schedule, so the raw office-facing message ("undo it first...") would
      // be a dead end. Route them to the office instead.
      const message = result.code === 'pending_schedule'
        ? 'You already have a plan change scheduled for your next billing date. Please contact our office to adjust it.'
        : result.error;
      return res.status(result.status || 400).json({ error: message });
    }
    // Whitelist the customer-facing response — never leak the Stripe schedule id
    // (sub_sched_…) onto a customer surface.
    res.json({
      ok: result.ok,
      new_plan: result.new_plan,
      effective_date: result.effective_date,
      new_renewal_amount_cents: result.new_renewal_amount_cents,
    });
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
