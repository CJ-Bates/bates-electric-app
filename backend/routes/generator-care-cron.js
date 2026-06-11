// backend/routes/generator-care-cron.js
// Scheduled / cron endpoints for the Generator Care program.
// Hit by an external scheduler  -  protected by a shared secret instead of user JWT.

const express = require('express');
const sgMail = require('@sendgrid/mail');
const { supabaseAdmin } = require('../lib/supabase');

const router = express.Router();

const CRON_SECRET = process.env.CRON_SECRET;
const SENDGRID_KEY = process.env.SENDGRID_API_KEY;
const FROM_EMAIL = process.env.GENERATOR_DIGEST_FROM || 'no-reply@bates-electric.com';
const TO_EMAILS = (process.env.GENERATOR_DIGEST_TO || 'amyp@bates-electric.com,cjbates@bates-electric.com')
 .split(',').map(s => s.trim()).filter(Boolean);

if (SENDGRID_KEY) sgMail.setApiKey(SENDGRID_KEY);

// Healthchecks.io dead-man's-switch ping. Fire-and-forget: never awaited, never
// throws, never affects the cron response. If HEALTHCHECKS_URL is unset it's a
// no-op. Hitting the base URL signals success; "<url>/fail" signals a crash so
// Healthchecks alerts CJ. Set HEALTHCHECKS_URL in Render after creating the check.
function pingHealthcheck(suffix = '') {
  const base = process.env.HEALTHCHECKS_URL;
  if (!base) return;
  const url = base.replace(/\/$/, '') + suffix;
  // Node 18+ global fetch. Swallow everything -- this is a pure side channel.
  Promise.resolve()
    .then(() => fetch(url, { method: 'GET' }))
    .catch((e) => console.error('[gc-cron] healthcheck ping failed:', e && e.message));
}

// Bearer-token auth for cron endpoints
function requireCronSecret(req, res, next) {
 if (!CRON_SECRET) return res.status(500).json({ error: 'CRON_SECRET not configured on server' });
 const header = req.headers.authorization || '';
 const token = header.startsWith('Bearer ') ? header.slice(7) : '';
 if (token !== CRON_SECRET) return res.status(401).json({ error: 'Invalid cron secret' });
 next();
}

// POST /api/cron/generator-care/daily-email
// Sends Amy + CJ a summary of service visits due in the next 14 days plus any overdue.
router.post('/daily-email', requireCronSecret, async (req, res) => {
 try {
 const today = new Date();
 today.setHours(0, 0, 0, 0);
 const horizon = new Date(today);
 horizon.setDate(horizon.getDate() + 14);
 const horizonStr = horizon.toISOString().slice(0, 10);

 // Pull every active subscription with next_visit_due in the next 14 days OR overdue
 const { data: subs, error } = await supabaseAdmin
 .from('generator_subscriptions')
 .select(`
 id, plan, gen_class, gen_model, gen_serial,
 fleet_monitoring, next_visit_due, last_visit_date, status,
 customer:generator_customers(name, phone, email, install_address, install_city, install_state, install_zip)
 `)
 .eq('status', 'active')
 .lte('next_visit_due', horizonStr)
 .order('next_visit_due', { ascending: true });
 if (error) throw error;

 const overdue = [];
 const upcoming = [];
 const todayStr = today.toISOString().slice(0, 10);
 for (const s of subs || []) {
 if (!s.next_visit_due) continue;
 if (s.next_visit_due < todayStr) overdue.push(s);
 else upcoming.push(s);
 }

    // Look up visit statuses for upcoming subs to split tentative vs confirmed.
    const upcomingSubIds = upcoming.map(s => s.id);
    const statusBySubId = {};
    if (upcomingSubIds.length > 0) {
      const { data: visits } = await supabaseAdmin
        .from('generator_service_visits')
        .select('subscription_id, status')
        .in('subscription_id', upcomingSubIds)
        .in('status', ['tentative', 'scheduled']);
      for (const v of (visits || [])) {
        if (!statusBySubId[v.subscription_id]) statusBySubId[v.subscription_id] = v.status;
      }
    }
    const upcomingTentative = upcoming.filter(s => statusBySubId[s.id] === 'tentative');
    const upcomingConfirmed = upcoming.filter(s => statusBySubId[s.id] !== 'tentative');

 // Also pull any failed addon charges + failed adhoc charges so we can surface them.
 // AND any past_due subscriptions (renewal charge failed; Stripe is retrying or
 // has given up). Without surfacing these here they disappear from Amy's view
 // entirely because the upcoming/overdue queries above filter status='active'.
    const [failedAddonsR, failedAdhocR, pastDueR] = await Promise.all([
      supabaseAdmin
        .from('generator_pending_addons')
        .select('id, addon_type, amount_cents, notes, subscription:generator_subscriptions(customer:generator_customers(name, phone))')
        .eq('status', 'failed')
        .order('created_at', { ascending: false }),
      supabaseAdmin
        .from('generator_adhoc_charges')
        .select('id, description, amount_cents, notes, subscription:generator_subscriptions(customer:generator_customers(name, phone))')
        .eq('status', 'failed')
        .order('created_at', { ascending: false }),
      supabaseAdmin
        .from('generator_subscriptions')
        .select('id, plan, gen_class, gen_model, annual_price_cents, customer:generator_customers(name, phone, email)')
        .eq('status', 'past_due')
        .order('next_visit_due', { ascending: true }),
    ]);
    const failedAddons = failedAddonsR.data || [];
    const failedAdhoc = failedAdhocR.data || [];
    const pastDue = pastDueR.data || [];
    const failedTotal = failedAddons.length + failedAdhoc.length;

    // The digest must go out EVERY day. Amy's runbook treats a missing email as
    // an outage signal, so on a genuinely quiet day we still send — just a short
    // "all quiet" note instead of suppressing the email entirely.
    const isQuiet = overdue.length === 0 && upcoming.length === 0 && failedTotal === 0 && pastDue.length === 0;

    const { subject, html, text } = isQuiet
      ? buildQuietEmail({ todayStr })
      : buildEmail({ overdue, upcoming, upcomingTentative, upcomingConfirmed, failedAddons, failedAdhoc, pastDue, todayStr });

 if (!SENDGRID_KEY) {
 return res.status(500).json({ error: 'SENDGRID_API_KEY not configured', preview: { subject, text } });
 }

 await sgMail.send({
 to: TO_EMAILS,
 from: { email: FROM_EMAIL, name: 'Bates Electric Generator Care' },
 subject,
 text,
 html,
 });

 // Digest sent successfully -- signal the dead-man's switch.
 pingHealthcheck();

 res.json({ ok: true, sent: true, quiet: isQuiet, recipients: TO_EMAILS, overdue: overdue.length, upcoming: upcoming.length, upcoming_tentative: upcomingTentative.length, upcoming_confirmed: upcomingConfirmed.length, failed_addons: failedAddons.length, failed_adhoc: failedAdhoc.length, past_due: pastDue.length });
 } catch (err) {
 // Signal failure to Healthchecks first so we hear about a crashed cron.
 pingHealthcheck('/fail');
 console.error('[gc-cron] daily-email error:', err && (err.response?.body || err.message));
 res.status(500).json({ error: err.message });
 }
});

// Helpers --------------------------------------------------

function buildEmail({ overdue, upcoming, upcomingTentative = [], upcomingConfirmed = [], failedAddons = [], failedAdhoc = [], pastDue = [], todayStr }) {
 const total = overdue.length + upcoming.length;
 const failedTotalForSubject = failedAddons.length + failedAdhoc.length;
      const subject = pastDue.length > 0
        ? 'Generator Care: ' + pastDue.length + ' PAST DUE' + (failedTotalForSubject ? ', ' + failedTotalForSubject + ' failed charge' + (failedTotalForSubject === 1 ? '' : 's') : '') + ', ' + overdue.length + ' overdue, ' + upcoming.length + ' due soon'
        : failedTotalForSubject > 0
        ? 'Generator Care: ' + failedTotalForSubject + ' FAILED CHARGE' + (failedTotalForSubject === 1 ? '' : 'S') + ', ' + overdue.length + ' overdue, ' + upcoming.length + ' due soon'
        : overdue.length
 ? `Generator Care: ${overdue.length} OVERDUE, ${upcoming.length} due soon`
 : `Generator Care: ${upcoming.length} visit${upcoming.length === 1 ? '' : 's'} due in the next 14 days`;

 const dashboardUrl = 'https://bates-electric-app.netlify.app/generator-care.html';

 const planLabel = (p) => p === 'semi_annual' ? 'Semi-Annual' : 'Annual';
 const genClassLabel = (c) => ({
 air_cooled: 'Air Cooled',
 liquid_22_38: 'Liquid 22-38 KW',
 liquid_48_150: 'Liquid 48-150 KW',
 })[c] || c;

 const daysUntil = (dateStr) => {
 const target = new Date(dateStr + 'T00:00:00');
 const t = new Date(todayStr + 'T00:00:00');
 return Math.floor((target - t) / 86400000);
 };
 const fmtDate = (s) => new Date(s + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

 const rowHtml = (s, kind) => {
 const c = s.customer || {};
 const d = daysUntil(s.next_visit_due);
 const dueText = kind === 'overdue'
 ? `${Math.abs(d)} day${Math.abs(d) === 1 ? '' : 's'} OVERDUE`
 : (d === 0 ? 'Today' : d === 1 ? 'Tomorrow' : `In ${d} days  | ${fmtDate(s.next_visit_due)}`);
 const dueColor = kind === 'overdue' ? '#b91c1c' : (d <= 7 ? '#b45309' : '#1F3A5F');
 const addr = [c.install_city, c.install_state].filter(Boolean).join(', ');
 return `
 <tr>
 <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;vertical-align:top;">
 <div style="font-weight:600;color:#1F3A5F;font-size:14px;">${escapeHtml(c.name || ' - ')}</div>
 <div style="color:#6b7280;font-size:12px;">${escapeHtml(addr)}  | ${escapeHtml(c.phone || '')}</div>
 </td>
 <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;vertical-align:top;color:#374151;font-size:13px;">
 ${escapeHtml(genClassLabel(s.gen_class))}<br>
 <span style="color:#6b7280;font-size:12px;">${escapeHtml(s.gen_model || 'model n/a')}  | ${escapeHtml(planLabel(s.plan))}</span>
 </td>
 <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;vertical-align:top;color:${dueColor};font-size:13px;font-weight:600;text-align:right;white-space:nowrap;">
 ${dueText}
 </td>
 </tr>
 `;
 };

 function renderPastDueSection(subs) {
        if (!subs.length) return '';
        const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        let h = '<div style="margin-top:1.5rem;">';
        h += '<h2 style="color:#7c2d12;font-size:1rem;margin-bottom:0.5rem;border-bottom:2px solid #7c2d12;padding-bottom:0.25rem;">';
        h += 'Past-due renewals (' + subs.length + ') - card update needed</h2>';
        h += '<p style="margin:0 0 0.5rem;color:#6b7280;font-size:0.85rem;">Stripe is retrying the renewal charge. Customer was auto-emailed a card-update link. Follow up by phone if it stays past-due more than a few days.</p>';
        for (const s of subs) {
          const c = s.customer || {};
          h += '<div style="padding:0.5rem 0;border-bottom:1px solid #eee;font-size:0.9rem;">';
          h += '<strong>' + esc(c.name || 'Unknown') + '</strong> - ' + esc(genClassLabel(s.gen_class)) + ' ' + esc(s.gen_model || 'model n/a') + ' - ' + esc(planLabel(s.plan));
          if (c.phone) h += '<div style="color:#6b7280;font-size:0.8rem;">' + esc(c.phone) + (c.email ? ' &middot; ' + esc(c.email) : '') + '</div>';
          else if (c.email) h += '<div style="color:#6b7280;font-size:0.8rem;">' + esc(c.email) + '</div>';
          h += '</div>';
        }
        h += '</div>';
        return h;
      }

 function renderFailedSection(addons, adhoc) {
        if (!addons.length && !adhoc.length) return '';
        const labelFor = (t) => ({
          battery_diagnostics: 'Battery Diagnostics / Load Test',
          battery_replacement: 'Battery Replacement',
          exterior_wash: 'Exterior Wash',
          outage_test: 'Simulated Outage Test',
          coolant_flush: 'Coolant System Flush',
          coolant_topoff: 'Coolant Top-Off',
          ats_inspection: 'ATS Inspection',
        })[t] || t;
        const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        const total = addons.length + adhoc.length;
        let h = '<div style="margin-top:1.5rem;">';
        h += '<h2 style="color:#DC2626;font-size:1rem;margin-bottom:0.5rem;border-bottom:2px solid #DC2626;padding-bottom:0.25rem;">';
        h += 'Failed charges (' + total + ') - needs attention</h2>';
        const rowHtml = (name, phone, description, amt, notes) => {
          let r = '<div style="padding:0.5rem 0;border-bottom:1px solid #eee;font-size:0.9rem;">';
          r += '<strong>' + esc(name || 'Unknown') + '</strong> - ' + esc(description) + ' - ' + esc(amt);
          if (notes) r += '<div style="color:#6b7280;font-size:0.8rem;">' + esc(notes) + '</div>';
          if (phone) r += '<div style="color:#6b7280;font-size:0.8rem;">' + esc(phone) + '</div>';
          r += '</div>';
          return r;
        };
        for (const a of addons) {
          const c = (a.subscription && a.subscription.customer) || {};
          const amt = a.amount_cents ? '$' + (a.amount_cents / 100).toFixed(2) : '';
          h += rowHtml(c.name, c.phone, labelFor(a.addon_type), amt, a.notes);
        }
        for (const a of adhoc) {
          const c = (a.subscription && a.subscription.customer) || {};
          const amt = a.amount_cents ? '$' + (a.amount_cents / 100).toFixed(2) : '';
          h += rowHtml(c.name, c.phone, a.description, amt, a.notes);
        }
        h += '</div>';
        return h;
      }

      const section = (title, rows, color) => {
 if (!rows.length) return '';
 return `
 <h3 style="margin:24px 0 8px;color:${color};font-size:14px;text-transform:uppercase;letter-spacing:0.06em;">${title} (${rows.length})</h3>
 <table cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:collapse;background:#fff;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
 ${rows.map(r => rowHtml(r, color === '#b91c1c' ? 'overdue' : 'upcoming')).join('')}
 </table>
 `;
 };

 const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#111827;background:#f9fafb;">
 <div style="max-width:680px;margin:0 auto;">
 <div style="background:#1F3A5F;color:#fff;padding:20px 24px;border-radius:8px 8px 0 0;">
 <div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;opacity:0.7;margin-bottom:4px;">Bates Electric, Inc.</div>
        <h1 style="margin:0;font-size:22px;letter-spacing:-0.3px;">Generator Care Digest</h1>
 <p style="margin:6px 0 0;opacity:0.85;font-size:13px;">${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</p>
 </div>
 <div style="background:#fff;padding:20px 24px;border-radius:0 0 8px 8px;border:1px solid #e5e7eb;border-top:none;">
 <p style="margin:0;color:#374151;font-size:14px;">
 ${total} customer${total === 1 ? '' : 's'} need attention in the next 14 days.
 ${overdue.length ? `<strong style="color:#b91c1c;">${overdue.length} overdue.</strong>` : ''}
 </p>
 ${renderPastDueSection(pastDue)}
 ${section('Overdue', overdue, '#b91c1c')}
 ${section('Tentative - please confirm with customer', upcomingTentative, '#D97706')}
          ${section('Confirmed visits - due in next 14 days', upcomingConfirmed, '#1F3A5F')}
          ${renderFailedSection(failedAddons, failedAdhoc)}
 <p style="margin:24px 0 0;text-align:center;">
 <a href="${dashboardUrl}" style="display:inline-block;background:#1F3A5F;color:#fff;text-decoration:none;padding:10px 20px;border-radius:6px;font-weight:600;font-size:14px;">Open Generator Care dashboard -></a>
 </p>
 <p style="margin:24px 0 0;color:#6b7280;font-size:12px;text-align:center;">
 From the dashboard you can mark visits complete (next visit auto-schedules) and view full customer details.
 </p>
 </div>

 <div style="margin-top:24px;padding:16px 24px;text-align:center;color:#9ca3af;font-size:11px;line-height:1.6;">
   <div style="font-weight:600;color:#6b7280;letter-spacing:0.5px;">BATES ELECTRIC, INC.</div>
   <div>Commercial &middot; Residential &middot; Industrial &middot; Restorative</div>
   <div style="margin-top:6px;">(636) 464-3939 &middot; bates-electric.com</div>
 </div>
 </div>
</body></html>`;

 // Plain-text fallback
 const textLines = [];
 textLines.push(`Generator Care  -  daily digest`);
 textLines.push(`${total} customer${total === 1 ? '' : 's'} need attention in next 14 days.`);
 if (pastDue.length) {
 textLines.push('');
 textLines.push(`PAST DUE (${pastDue.length}) - card update needed:`);
 for (const s of pastDue) {
 const c = s.customer || {};
 textLines.push(`- ${c.name}  -  ${genClassLabel(s.gen_class)} ${s.gen_model || ''}  -  ${planLabel(s.plan)}  -  ${c.phone || c.email || ''}`);
 }
 }
 if (overdue.length) {
 textLines.push('');
 textLines.push(`OVERDUE (${overdue.length}):`);
 for (const s of overdue) {
 const c = s.customer || {};
 const d = daysUntil(s.next_visit_due);
 textLines.push(`- ${c.name}  -  ${genClassLabel(s.gen_class)}  -  ${Math.abs(d)} days overdue  -  ${c.phone || ''}`);
 }
 }
 if (upcomingTentative.length) {
 textLines.push('');
 textLines.push(`TENTATIVE - PLEASE CONFIRM (${upcomingTentative.length}):`);
 for (const s of upcomingTentative) {
 const c = s.customer || {};
 const d = daysUntil(s.next_visit_due);
 textLines.push(`- ${c.name}  -  ${genClassLabel(s.gen_class)}  -  ${d === 0 ? 'today' : d === 1 ? 'tomorrow' : `in ${d} days`} (${fmtDate(s.next_visit_due)})  -  ${c.phone || ''}`);
 }
 }
 textLines.push('');
 textLines.push(`Dashboard: ${dashboardUrl}`);

 if (upcomingConfirmed.length) {
        textLines.push('');
        textLines.push(`CONFIRMED - DUE IN NEXT 14 DAYS (${upcomingConfirmed.length}):`);
        for (const s of upcomingConfirmed) {
          const d = Math.round((new Date(s.next_visit_due) - new Date(todayStr)) / 86400000);
          const c = s.customer || {};
          textLines.push(`- ${c.name}  -  ${genClassLabel(s.gen_class)}  -  in ${d} days  -  ${c.phone || ''}`);
        }
      }

 if (failedAddons.length || failedAdhoc.length) {
        textLines.push('');
        textLines.push('FAILED CHARGES (' + (failedAddons.length + failedAdhoc.length) + '):');
        for (const a of failedAddons) {
          const c = (a.subscription && a.subscription.customer) || {};
          const amt = a.amount_cents ? '$' + (a.amount_cents / 100).toFixed(2) : '';
          textLines.push('- ' + (c.name || 'Unknown') + ' - ' + a.addon_type + ' - ' + amt + (a.notes ? ' - ' + a.notes : ''));
        }
        for (const a of failedAdhoc) {
          const c = (a.subscription && a.subscription.customer) || {};
          const amt = a.amount_cents ? '$' + (a.amount_cents / 100).toFixed(2) : '';
          textLines.push('- ' + (c.name || 'Unknown') + ' - ' + a.description + ' - ' + amt + (a.notes ? ' - ' + a.notes : ''));
        }
      }

      return { subject, html, text: textLines.join('\n') };
}

// Quiet-day digest: same branded shell as the full digest (so Amy recognizes the
// daily email arrived) with a single "all clear" line. Sending this every quiet
// day is what keeps a missing email meaningful as an outage signal.
function buildQuietEmail({ todayStr }) {
  const dashboardUrl = 'https://bates-electric-app.netlify.app/generator-care.html';
  const dateLine = new Date(todayStr + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  const subject = 'Generator Care: all quiet - nothing due today';

  const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#111827;background:#f9fafb;">
  <div style="max-width:680px;margin:0 auto;">
    <div style="background:#1F3A5F;color:#fff;padding:20px 24px;border-radius:8px 8px 0 0;">
      <div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;opacity:0.7;margin-bottom:4px;">Bates Electric, Inc.</div>
      <h1 style="margin:0;font-size:22px;letter-spacing:-0.3px;">Generator Care Digest</h1>
      <p style="margin:6px 0 0;opacity:0.85;font-size:13px;">${dateLine}</p>
    </div>
    <div style="background:#fff;padding:28px 24px;border-radius:0 0 8px 8px;border:1px solid #e5e7eb;border-top:none;text-align:center;">
      <div style="font-size:30px;line-height:1;margin-bottom:8px;">&#9989;</div>
      <p style="margin:0;color:#1F3A5F;font-size:16px;font-weight:600;">All quiet</p>
      <p style="margin:8px 0 0;color:#374151;font-size:14px;">No new signups, no visits due, no failed charges.</p>
      <p style="margin:22px 0 0;">
        <a href="${dashboardUrl}" style="display:inline-block;background:#1F3A5F;color:#fff;text-decoration:none;padding:10px 20px;border-radius:6px;font-weight:600;font-size:14px;">Open Generator Care dashboard -></a>
      </p>
    </div>
    <div style="margin-top:24px;padding:16px 24px;text-align:center;color:#9ca3af;font-size:11px;line-height:1.6;">
      <div style="font-weight:600;color:#6b7280;letter-spacing:0.5px;">BATES ELECTRIC, INC.</div>
      <div>Commercial &middot; Residential &middot; Industrial &middot; Restorative</div>
      <div style="margin-top:6px;">(636) 464-3939 &middot; bates-electric.com</div>
    </div>
  </div>
</body></html>`;

  const text = [
    'Generator Care  -  daily digest',
    '',
    'All quiet - no new signups, no visits due, no failed charges.',
    '',
    `Dashboard: ${dashboardUrl}`,
  ].join('\n');

  return { subject, html, text };
}

function escapeHtml(s) {
 return String(s == null ? '' : s)
 .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
 .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

module.exports = router;
