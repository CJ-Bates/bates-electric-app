// backend/routes/generator-care/leads.js
// Growth Engine WP1: the Leads pipeline. CRUD for generator_leads — the one
// table every lead channel (field enrollment, referral, campaign, manual
// office entry) lands in and the office works from the Leads tab.
// Auth (requireAuth + office role) is applied by ./index.js.
//
// No granular requirePermission flag: leads are prospect notes the whole
// office works — nothing here moves money, creates a Stripe object, or
// exposes an existing customer's data by id (convert only records a
// subscription id on the lead). Same coarse-gate basis as the
// work-order-created/visit-schedule baseline in ../README.md.

const express = require('express');
const { supabaseAdmin } = require('../../lib/supabase');
const { sendEmail, buildSignupLinkEmail } = require('../../lib/emails');
const { reportError } = require('../../middleware/error-reporter');

const router = express.Router();

// The public signup site (bates-generator repo). Env-overridable so a staging
// deploy can point somewhere else; the default is the live Netlify site.
const SIGNUP_BASE_URL =
  (process.env.GENERATOR_SIGNUP_URL || 'https://generator.bates-electric.com').replace(/\/+$/, '');

const LEAD_SOURCES = ['field', 'referral', 'campaign', 'manual'];
const LEAD_STATUSES = ['new', 'contacted', 'signup_sent', 'converted', 'lost'];

// Every column the office UI shows — leads have no non-lead fields to leak,
// but selecting an explicit list keeps that true if the table grows.
const LEAD_COLUMNS = [
  'id', 'source', 'status',
  'customer_name', 'customer_email', 'customer_phone',
  'install_address', 'install_city', 'install_state', 'install_zip',
  'generator_info', 'referred_by_user_id', 'referred_by_label', 'notes',
  'converted_subscription_id', 'created_at', 'updated_at',
].join(', ');

// Contact/detail fields the office can set on create and edit later. Status,
// source, and converted_subscription_id are handled separately (validated
// enums / the convert endpoint).
const EDITABLE_FIELDS = [
  'customer_name', 'customer_email', 'customer_phone',
  'install_address', 'install_city', 'install_state', 'install_zip',
  'generator_info', 'referred_by_label', 'notes',
];

const trimmed = (v) => (typeof v === 'string' ? v.trim() : '');

// GET /api/generator-care/leads — newest first. Optional ?status= / ?source=
// filters and ?q= name/email search. referred_by_label carries provenance,
// so there's nothing to join.
router.get('/leads', async (req, res) => {
  try {
    const { status, source, q } = req.query || {};
    if (status && !LEAD_STATUSES.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${LEAD_STATUSES.join(', ')}` });
    }
    if (source && !LEAD_SOURCES.includes(source)) {
      return res.status(400).json({ error: `source must be one of: ${LEAD_SOURCES.join(', ')}` });
    }

    let query = supabaseAdmin
      .from('generator_leads')
      .select(LEAD_COLUMNS)
      .order('created_at', { ascending: false });
    if (status) query = query.eq('status', status);
    if (source) query = query.eq('source', source);
    if (q) {
      // PostgREST .or() parses commas/parens as syntax — strip them from the
      // needle rather than 400ing on names like "Smith, John".
      const needle = String(q).replace(/[,()]/g, ' ').trim();
      if (needle) {
        query = query.or(`customer_name.ilike.%${needle}%,customer_email.ilike.%${needle}%`);
      }
    }

    const { data, error } = await query;
    if (error) throw error;
    res.json({ leads: data || [] });
  } catch (err) {
    console.error('[generator-care] list leads error:', err && err.message);
    reportError(err, { route: req.originalUrl, method: req.method, user: req.profile && req.profile.email }).catch(() => {});
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/generator-care/leads/:id — one lead.
router.get('/leads/:id', async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('generator_leads')
      .select(LEAD_COLUMNS)
      .eq('id', req.params.id)
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'lead not found' });
    res.json({ lead: data });
  } catch (err) {
    console.error('[generator-care] get lead error:', err && err.message);
    reportError(err, { route: req.originalUrl, method: req.method, user: req.profile && req.profile.email }).catch(() => {});
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/generator-care/leads — create a lead. Used by the office "Add
// lead" button today; the field/referral/campaign work packages will create
// their leads through this same shape with their own source.
router.post('/leads', async (req, res) => {
  try {
    const body = req.body || {};
    const source = trimmed(body.source) || 'manual';
    const status = trimmed(body.status) || 'new';
    if (!LEAD_SOURCES.includes(source)) {
      return res.status(400).json({ error: `source must be one of: ${LEAD_SOURCES.join(', ')}` });
    }
    if (!LEAD_STATUSES.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${LEAD_STATUSES.join(', ')}` });
    }

    const row = { source, status };
    for (const f of EDITABLE_FIELDS) {
      const v = trimmed(body[f]);
      if (v) row[f] = v;
    }
    // The machine link to a staff profile (tech/estimator/referrer) — set by
    // the later field/referral packages; the manual form doesn't send it.
    if (trimmed(body.referred_by_user_id)) row.referred_by_user_id = trimmed(body.referred_by_user_id);

    if (!row.customer_name && !row.customer_email && !row.customer_phone) {
      return res.status(400).json({ error: 'A lead needs at least a name, email, or phone.' });
    }

    const { data, error } = await supabaseAdmin
      .from('generator_leads')
      .insert(row)
      .select(LEAD_COLUMNS)
      .single();
    if (error) throw error;
    res.json({ ok: true, lead: data });
  } catch (err) {
    console.error('[generator-care] create lead error:', err && err.message);
    reportError(err, { route: req.originalUrl, method: req.method, user: req.profile && req.profile.email }).catch(() => {});
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /api/generator-care/leads/:id — advance the stage, edit notes, or fix
// contact fields. Only sent fields change; unknown fields are ignored.
router.patch('/leads/:id', async (req, res) => {
  try {
    const body = req.body || {};
    const updates = {};

    if (body.status !== undefined) {
      const status = trimmed(body.status);
      if (!LEAD_STATUSES.includes(status)) {
        return res.status(400).json({ error: `status must be one of: ${LEAD_STATUSES.join(', ')}` });
      }
      updates.status = status;
    }
    for (const f of EDITABLE_FIELDS) {
      // Editable fields may be cleared (-> null); absent fields stay untouched.
      if (body[f] !== undefined) updates[f] = trimmed(body[f]) || null;
    }
    if (!Object.keys(updates).length) {
      return res.status(400).json({ error: 'Nothing to update.' });
    }
    updates.updated_at = new Date().toISOString();

    const { data, error } = await supabaseAdmin
      .from('generator_leads')
      .update(updates)
      .eq('id', req.params.id)
      .select(LEAD_COLUMNS)
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'lead not found' });
    res.json({ ok: true, lead: data });
  } catch (err) {
    console.error('[generator-care] update lead error:', err && err.message);
    reportError(err, { route: req.originalUrl, method: req.method, user: req.profile && req.profile.email }).catch(() => {});
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/generator-care/leads/:id/send-signup — build this lead's
// pre-tagged signup URL (?lead=<id>, which the signup site forwards into
// Stripe subscription metadata so the webhook can auto-convert the lead).
// If the lead has an email on file, also send the branded "complete your
// signup" email (FL-aware); otherwise just return the link for the office to
// copy into a text/call. Either way the lead advances to signup_sent.
// No granular requirePermission, same basis as the rest of this file: sends
// a public signup URL to a prospect — no money moved, no Stripe object
// created, no existing customer's data touched.
router.post('/leads/:id/send-signup', async (req, res) => {
  try {
    const { data: lead, error } = await supabaseAdmin
      .from('generator_leads')
      .select(LEAD_COLUMNS)
      .eq('id', req.params.id)
      .maybeSingle();
    if (error) throw error;
    if (!lead) return res.status(404).json({ error: 'lead not found' });
    if (lead.status === 'converted') {
      return res.status(400).json({ error: 'This lead already converted \u2014 no signup link needed.' });
    }

    const url = `${SIGNUP_BASE_URL}/?lead=${lead.id}`;

    // Email when we can; a failed send still returns the link so the office
    // isn't blocked on a mail hiccup — they can copy it and send it themselves.
    let emailed = false;
    let emailError = null;
    if (lead.customer_email) {
      const { subject, html, text } = buildSignupLinkEmail({
        name: lead.customer_name,
        signupUrl: url,
        companyState: lead.install_state,
      });
      const result = await sendEmail({
        to: lead.customer_email,
        subject,
        html,
        text,
        logTag: '[signup-link-email]',
        companyState: lead.install_state,
      });
      emailed = !!(result && result.sent);
      if (!emailed) {
        emailError = 'The email could not be sent \u2014 copy the link and send it yourself.';
        reportError(
          new Error(`signup-link email send failed for lead ${lead.id} to ${lead.customer_email}: ${(result && result.reason) || 'unknown'}`),
          { route: req.originalUrl, method: req.method, user: req.profile && req.profile.email }
        ).catch(() => {});
      }
    }

    const { data: updated, error: updErr } = await supabaseAdmin
      .from('generator_leads')
      .update({ status: 'signup_sent', updated_at: new Date().toISOString() })
      .eq('id', lead.id)
      .select(LEAD_COLUMNS)
      .maybeSingle();
    if (updErr) throw updErr;

    res.json({ ok: true, url, emailed, email_error: emailError, lead: updated || lead });
  } catch (err) {
    console.error('[generator-care] send-signup error:', err && err.message);
    reportError(err, { route: req.originalUrl, method: req.method, user: req.profile && req.profile.email }).catch(() => {});
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/generator-care/leads/:id/convert  { subscription_id? }
// Record that this lead became a customer: status -> converted, and remember
// which subscription came out of it when the caller knows (the
// field-enrollment WP passes it automatically; the office can convert
// without one and the link stays null).
router.post('/leads/:id/convert', async (req, res) => {
  try {
    const subscriptionId = trimmed(req.body && req.body.subscription_id) || null;
    if (subscriptionId) {
      const { data: sub, error: subErr } = await supabaseAdmin
        .from('generator_subscriptions')
        .select('id')
        .eq('id', subscriptionId)
        .maybeSingle();
      if (subErr) throw subErr;
      if (!sub) return res.status(400).json({ error: 'subscription_id does not match a subscription' });
    }

    const updates = { status: 'converted', updated_at: new Date().toISOString() };
    // Only touch the link when a subscription was named — a bare re-convert
    // must not wipe an attribution recorded earlier.
    if (subscriptionId) updates.converted_subscription_id = subscriptionId;

    const { data, error } = await supabaseAdmin
      .from('generator_leads')
      .update(updates)
      .eq('id', req.params.id)
      .select(LEAD_COLUMNS)
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'lead not found' });
    res.json({ ok: true, lead: data });
  } catch (err) {
    console.error('[generator-care] convert lead error:', err && err.message);
    reportError(err, { route: req.originalUrl, method: req.method, user: req.profile && req.profile.email }).catch(() => {});
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
