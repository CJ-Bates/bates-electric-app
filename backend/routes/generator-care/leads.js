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

const crypto = require('crypto');
const express = require('express');
const { supabaseAdmin } = require('../../lib/supabase');
const { sendEmail, buildSignupLinkEmail, buildEnrollmentInviteEmail, BRAND, CONTACT_TYPES } = require('../../lib/emails');
const { reportError } = require('../../middleware/error-reporter');

const router = express.Router();

// The public signup site (bates-generator repo). Env-overridable so a staging
// deploy can point somewhere else; the default is the live Netlify site.
const SIGNUP_BASE_URL =
  (process.env.GENERATOR_SIGNUP_URL || 'https://generator.bates-electric.com').replace(/\/+$/, '');

// This backend's own public origin — the unsubscribe link in the invite email
// points here (the route is served by this app, not the Netlify frontend).
const API_PUBLIC_BASE_URL =
  (process.env.GENERATOR_API_PUBLIC_URL || 'https://bates-electric-app.onrender.com').replace(/\/+$/, '');

// WP4 bulk-send tuning. Hard cap 100 leads per call so no single click can
// blast a whole cohort. MIRRORED as SEND_CAP in frontend/leads.js (separate
// deploys, no bundler) — edit BOTH together or the UI will offer selections
// the server rejects. The throttle spaces sends so we don't hammer Brevo;
// tests zero it.
const INVITE_MAX_BATCH = 100;

// generator_leads.id is a uuid column — an id that can't cast to uuid would
// make the .in() lookup throw (22P02) and 500 the whole request, so ids are
// shape-checked here first and bad ones become per-id "not found" skips.
// Lowercased before matching: Postgres compares uuids case-insensitively,
// but the Map keyed on DB output (lowercase) would miss an uppercase form.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INVITE_THROTTLE_MS = process.env.GENERATOR_INVITE_THROTTLE_MS != null
  ? Number(process.env.GENERATOR_INVITE_THROTTLE_MS)
  : 200;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const LEAD_SOURCES = ['field', 'referral', 'campaign', 'manual'];
// WP5 (pipeline metrics) note: when funnel counts are built, "active
// pipeline" must EXCLUDE status='lost' (and deleted leads are hard-deleted
// by DELETE /leads/:id, so they're already out). If WP5 counts "needs
// follow-up", the window lives as FOLLOW_UP_DAYS in frontend/leads.js —
// share one number, don't restate 21.
const LEAD_STATUSES = ['new', 'contacted', 'signup_sent', 'converted', 'lost'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// CONTACT_TYPES comes from lib/emails.js — the one Node-side list, next to
// inviteGreeting which interprets the values.
// Deliberately loose (same shape check the Add/Edit dialogs use): enough to
// catch "8015551234" typed into the email box, not to police RFC 5322.
// MIRRORED as LEAD_EMAIL_RE in frontend/leads.js (separate deploys, no
// bundler) — edit BOTH together.
const EMAIL_RE = /^\S+@\S+\.\S+$/;

// Every column the office UI shows — leads have no non-lead fields to leak,
// but selecting an explicit list keeps that true if the table grows.
// (import_batch stays server-side: it's an undo tag, nothing the UI shows.)
// (unsubscribe_token stays server-side too: it's the secret in the
// unsubscribe URL, nothing the UI needs. email_opt_out IS listed — the Leads
// tab counts a cohort's emailable leads from it.)
const LEAD_COLUMNS = [
  'id', 'source', 'status',
  'customer_name', 'customer_email', 'customer_phone',
  'install_address', 'install_city', 'install_state', 'install_zip',
  'generator_info', 'maintenance_month', 'contact_type',
  'referred_by_user_id', 'referred_by_label', 'notes', 'email_opt_out',
  'converted_subscription_id', 'invited_at', 'created_at', 'updated_at',
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

// GET /api/generator-care/leads — newest first. Optional ?status= / ?source= /
// ?maintenance_month= filters and ?q= name/email search. referred_by_label
// carries provenance, so there's nothing to join.
router.get('/leads', async (req, res) => {
  try {
    const { status, source, maintenance_month: month, q } = req.query || {};
    if (status && !LEAD_STATUSES.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${LEAD_STATUSES.join(', ')}` });
    }
    if (source && !LEAD_SOURCES.includes(source)) {
      return res.status(400).json({ error: `source must be one of: ${LEAD_SOURCES.join(', ')}` });
    }
    if (month && !MONTHS.includes(month)) {
      return res.status(400).json({ error: `maintenance_month must be one of: ${MONTHS.join(', ')}` });
    }

    // The maintenance-book import (WP3) put the pipeline past PostgREST's
    // 1000-row response cap, so page through rather than silently truncating
    // — the Leads tab counts cohorts over the full set.
    const PAGE = 1000;
    const leads = [];
    for (let from = 0; ; from += PAGE) {
      let query = supabaseAdmin
        .from('generator_leads')
        .select(LEAD_COLUMNS)
        .order('created_at', { ascending: false })
        .order('id', { ascending: true }) // created_at ties (bulk import) need a total order or pages could overlap
        .range(from, from + PAGE - 1);
      if (status) query = query.eq('status', status);
      if (source) query = query.eq('source', source);
      if (month) query = query.eq('maintenance_month', month);
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
      leads.push(...(data || []));
      if (!data || data.length < PAGE) break;
    }
    res.json({ leads });
  } catch (err) {
    console.error('[generator-care] list leads error:', err && err.message);
    reportError(err, { route: req.path, method: req.method, user: req.profile && req.profile.email }).catch(() => {});
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
    reportError(err, { route: req.path, method: req.method, user: req.profile && req.profile.email }).catch(() => {});
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
    if (row.customer_email && !EMAIL_RE.test(row.customer_email)) {
      return res.status(400).json({ error: 'That email address doesn\u2019t look right.' });
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
    reportError(err, { route: req.path, method: req.method, user: req.profile && req.profile.email }).catch(() => {});
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /api/generator-care/leads/:id — advance the stage, edit notes, or fix
// contact/detail fields (WP4.2: the office edits leads as it reaches people
// by phone — adding an email is what makes a lead emailable and joins it to
// the campaign). Only sent fields change; unknown fields are ignored.
// status has its own validated path here; converted_subscription_id is only
// ever written by the convert endpoint.
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
    if (updates.customer_email && !EMAIL_RE.test(updates.customer_email)) {
      return res.status(400).json({ error: 'That email address doesn\u2019t look right.' });
    }
    // WP4.2: month + contact type are enum-validated, clearable edits too —
    // the book import guessed some of these and the office fixes them by ear.
    // Non-strings are rejected, not coerced: trimmed(9) === '' would silently
    // CLEAR the field on a 200 instead of erroring.
    if (body.maintenance_month !== undefined) {
      const month = typeof body.maintenance_month === 'string' ? body.maintenance_month.trim() : null;
      if (month === null || (month && !MONTHS.includes(month))) {
        return res.status(400).json({ error: `maintenance_month must be one of: ${MONTHS.join(', ')}` });
      }
      updates.maintenance_month = month || null;
    }
    if (body.contact_type !== undefined) {
      const contactType = typeof body.contact_type === 'string' ? body.contact_type.trim() : null;
      if (contactType === null || (contactType && !CONTACT_TYPES.includes(contactType))) {
        return res.status(400).json({ error: `contact_type must be one of: ${CONTACT_TYPES.join(', ')}` });
      }
      updates.contact_type = contactType || null;
    }
    if (!Object.keys(updates).length) {
      return res.status(400).json({ error: 'Nothing to update.' });
    }
    updates.updated_at = new Date().toISOString();
    // EVERY writer that moves a lead to signup_sent stamps invited_at — the
    // "Needs follow-up" clock. This path is the office's manual "Mark signup
    // sent" (a link handed over by text/phone), which is an invite too; the
    // two send routes stamp it themselves.
    if (updates.status === 'signup_sent') updates.invited_at = updates.updated_at;

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
    reportError(err, { route: req.path, method: req.method, user: req.profile && req.profile.email }).catch(() => {});
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/generator-care/leads/:id — hard delete (WP4.2). Leads are
// prospect rows with no money or customer data hanging off them, so a real
// delete is fine — and it's what keeps test/junk leads out of any future
// pipeline metrics (see the WP5 note above LEAD_STATUSES). Office-gated
// (inherited); same coarse-gate basis as the rest of this file.
router.delete('/leads/:id', async (req, res) => {
  try {
    const { data, error } = await supabaseAdmin
      .from('generator_leads')
      .delete()
      .eq('id', req.params.id)
      .select('id')
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'lead not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('[generator-care] delete lead error:', err && err.message);
    reportError(err, { route: req.path, method: req.method, user: req.profile && req.profile.email }).catch(() => {});
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
          { route: req.path, method: req.method, user: req.profile && req.profile.email }
        ).catch(() => {});
      }
    }

    // invited_at drives the "Needs follow-up" flag; a re-send re-stamps it,
    // deliberately resetting the follow-up clock (WP4.2).
    const now = new Date().toISOString();
    const { data: updated, error: updErr } = await supabaseAdmin
      .from('generator_leads')
      .update({ status: 'signup_sent', invited_at: now, updated_at: now })
      .eq('id', lead.id)
      .select(LEAD_COLUMNS)
      .maybeSingle();
    if (updErr) throw updErr;

    res.json({ ok: true, url, emailed, email_error: emailError, lead: updated || lead });
  } catch (err) {
    console.error('[generator-care] send-signup error:', err && err.message);
    reportError(err, { route: req.path, method: req.method, user: req.profile && req.profile.email }).catch(() => {});
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/generator-care/leads/send-invites  { lead_ids: [uuid, ...] }
// Growth Engine WP4 (reshaped by WP4.1): the enrollment-invite send. The
// office picks the recipients in the Leads tab, reviews the exact list in a
// confirm dialog, and posts those ids — the send is never blind. Each sent
// lead gets the campaign invite email (buildEnrollmentInviteEmail) and
// advances to signup_sent.
//
// The client list is a courtesy; the server is the gate. Every id is
// re-validated here before anything is sent: it must exist, have an email on
// file, not be opted out, and still be status new/contacted (signup_sent/
// converted/lost are done). An id that fails a check is SKIPPED with a
// reason — not an error — so a stale selection can never re-invite someone
// or email an opted-out lead. Each send gets the lead's ?lead= signup link
// and its own unsubscribe token (generated + persisted on first send). A
// per-lead send failure is logged and that lead is left un-advanced so a
// re-send can retry it — one bad address never aborts the batch.
//
// No granular requirePermission, same basis as the rest of this file: emails
// prospects a public signup URL — no money moved, no Stripe object created,
// no existing customer's data touched. The 100-id cap bounds the blast radius.
router.post('/leads/send-invites', async (req, res) => {
  try {
    const body = req.body || {};
    const ids = body.lead_ids;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'lead_ids must be a non-empty array of lead ids.' });
    }
    if (ids.some((id) => typeof id !== 'string' || !id.trim())) {
      return res.status(400).json({ error: 'Every lead id must be a non-empty string.' });
    }
    // De-dupe (lowercased — see UUID_RE) while keeping the caller's order —
    // a doubled id must never mean a doubled email. The cap applies to the
    // de-duped count: it bounds emails sent, not list length.
    const uniqueIds = [...new Set(ids.map((id) => id.trim().toLowerCase()))];
    if (uniqueIds.length > INVITE_MAX_BATCH) {
      return res.status(400).json({ error: `Send at most ${INVITE_MAX_BATCH} invites per batch.` });
    }

    // Only well-formed uuids go in the query; the rest fall out of the byId
    // lookup below as "not found" skips.
    const lookupIds = uniqueIds.filter((id) => UUID_RE.test(id));
    let rows = [];
    if (lookupIds.length) {
      const { data, error } = await supabaseAdmin
        .from('generator_leads')
        .select('id, status, email_opt_out, customer_name, customer_email, install_state, contact_type, unsubscribe_token')
        .in('id', lookupIds);
      if (error) throw error;
      rows = data || [];
    }
    const byId = new Map(rows.map((r) => [String(r.id).toLowerCase(), r]));

    // Server-side eligibility per id — never trust the client list.
    const skipped = [];
    const batch = [];
    for (const id of uniqueIds) {
      const lead = byId.get(id);
      if (!lead) skipped.push({ id, reason: 'not found' });
      else if (!trimmed(lead.customer_email)) skipped.push({ id, reason: 'no email' });
      else if (lead.email_opt_out) skipped.push({ id, reason: 'opted out' });
      else if (lead.status !== 'new' && lead.status !== 'contacted') {
        skipped.push({ id, reason: lead.status === 'lost' ? 'marked lost' : 'already invited' });
      } else batch.push(lead);
    }

    let sent = 0;
    let failed = 0;
    for (const lead of batch) {
      // Throttle between sends (not before the first) so Brevo sees a drip.
      if (sent + failed > 0 && INVITE_THROTTLE_MS > 0) await sleep(INVITE_THROTTLE_MS);

      try {
        // Unsubscribe token: persist BEFORE sending so the link in the email
        // always matches the DB (a send with an unsaved token would be dead).
        let token = trimmed(lead.unsubscribe_token);
        if (!token) {
          token = crypto.randomBytes(24).toString('base64url');
          const { error: tokErr } = await supabaseAdmin
            .from('generator_leads')
            .update({ unsubscribe_token: token })
            .eq('id', lead.id);
          if (tokErr) throw tokErr;
        }

        const { subject, html, text } = buildEnrollmentInviteEmail({
          name: lead.customer_name,
          contactType: lead.contact_type,
          signupUrl: `${SIGNUP_BASE_URL}/?lead=${lead.id}`,
          unsubscribeUrl: `${API_PUBLIC_BASE_URL}/generator-care/unsubscribe?token=${encodeURIComponent(token)}`,
          companyState: lead.install_state,
        });
        const result = await sendEmail({
          to: lead.customer_email,
          subject,
          html,
          text,
          logTag: '[enrollment-invite]',
          companyState: lead.install_state,
          // "Just reply — Amy will take care of you": replies land in the
          // monitored generators@ mailbox, not the no-reply sender.
          replyTo: BRAND.email,
        });
        if (!result || !result.sent) {
          throw new Error(`invite send failed for lead ${lead.id} to ${lead.customer_email}: ${(result && result.reason) || 'unknown'}`);
        }

        // Advance AFTER a confirmed send. If this write fails the invite went
        // out but the lead stays new/contacted — a re-click would re-send to
        // this one address, which the error report lets the office head off.
        // invited_at drives the "Needs follow-up" flag (WP4.2).
        const advancedAt = new Date().toISOString();
        const { error: updErr } = await supabaseAdmin
          .from('generator_leads')
          .update({ status: 'signup_sent', invited_at: advancedAt, updated_at: advancedAt })
          .eq('id', lead.id);
        if (updErr) throw updErr;
        sent++;
      } catch (err) {
        failed++;
        console.error('[generator-care] send-invites lead error:', err && err.message);
        reportError(err, { route: req.path, method: req.method, user: req.profile && req.profile.email }).catch(() => {});
      }
    }

    // Failed leads were not advanced, so re-selecting them retries the send.
    res.json({ sent, skipped, failed });
  } catch (err) {
    console.error('[generator-care] send-invites error:', err && err.message);
    reportError(err, { route: req.path, method: req.method, user: req.profile && req.profile.email }).catch(() => {});
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
    reportError(err, { route: req.path, method: req.method, user: req.profile && req.profile.email }).catch(() => {});
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
