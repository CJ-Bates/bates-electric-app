// backend/routes/generator-care-cron.js
// Scheduled / cron endpoints for the Generator Care program.
// Hit by an external scheduler — protected by a shared secret instead of user JWT.

const express = require('express');
const sgMail = require('@sendgrid/mail');
const { supabaseAdmin } = require('../lib/supabase');

const router = express.Router();

const CRON_SECRET = process.env.CRON_SECRET;
const SENDGRID_KEY = process.env.SENDGRID_API_KEY;
const FROM_EMAIL  = process.env.OFFICE_EMAIL || 'noreply@bates-electric.com';
const TO_EMAILS   = (process.env.GENERATOR_DIGEST_TO || 'amyp@bates-electric.com,cjbates@bates-electric.com')
  .split(',').map(s => s.trim()).filter(Boolean);

if (SENDGRID_KEY) sgMail.setApiKey(SENDGRID_KEY);

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

    if (overdue.length === 0 && upcoming.length === 0) {
      // Quiet morning — no email
      return res.json({ ok: true, sent: false, reason: 'No visits in the next 14 days', overdue: 0, upcoming: 0 });
    }

    const { subject, html, text } = buildEmail({ overdue, upcoming, todayStr });

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

    res.json({ ok: true, sent: true, recipients: TO_EMAILS, overdue: overdue.length, upcoming: upcoming.length });
  } catch (err) {
    console.error('[gc-cron] daily-email error:', err && (err.response?.body || err.message));
    res.status(500).json({ error: err.message });
  }
});

// Helpers --------------------------------------------------

function buildEmail({ overdue, upcoming, todayStr }) {
  const total = overdue.length + upcoming.length;
  const subject = overdue.length
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
      : (d === 0 ? 'Today' : d === 1 ? 'Tomorrow' : `In ${d} days · ${fmtDate(s.next_visit_due)}`);
    const dueColor = kind === 'overdue' ? '#b91c1c' : (d <= 7 ? '#b45309' : '#1F3A5F');
    const addr = [c.install_city, c.install_state].filter(Boolean).join(', ');
    return `
      <tr>
        <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;vertical-align:top;">
          <div style="font-weight:600;color:#1F3A5F;font-size:14px;">${escapeHtml(c.name || '—')}</div>
          <div style="color:#6b7280;font-size:12px;">${escapeHtml(addr)} · ${escapeHtml(c.phone || '')}</div>
        </td>
        <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;vertical-align:top;color:#374151;font-size:13px;">
          ${escapeHtml(genClassLabel(s.gen_class))}<br>
          <span style="color:#6b7280;font-size:12px;">${escapeHtml(s.gen_model || 'model n/a')} · ${escapeHtml(planLabel(s.plan))}</span>
        </td>
        <td style="padding:10px 12px;border-bottom:1px solid #e5e7eb;vertical-align:top;color:${dueColor};font-size:13px;font-weight:600;text-align:right;white-space:nowrap;">
          ${dueText}
        </td>
      </tr>
    `;
  };

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
      <h1 style="margin:0;font-size:20px;">Generator Care — Good Morning</h1>
      <p style="margin:6px 0 0;opacity:0.85;font-size:13px;">${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</p>
    </div>
    <div style="background:#fff;padding:20px 24px;border-radius:0 0 8px 8px;border:1px solid #e5e7eb;border-top:none;">
      <p style="margin:0;color:#374151;font-size:14px;">
        ${total} customer${total === 1 ? '' : 's'} need attention in the next 14 days.
        ${overdue.length ? `<strong style="color:#b91c1c;">${overdue.length} overdue.</strong>` : ''}
      </p>
      ${section('Overdue', overdue, '#b91c1c')}
      ${section('Due in next 14 days', upcoming, '#1F3A5F')}
      <p style="margin:24px 0 0;text-align:center;">
        <a href="${dashboardUrl}" style="display:inline-block;background:#1F3A5F;color:#fff;text-decoration:none;padding:10px 20px;border-radius:6px;font-weight:600;font-size:14px;">Open Generator Care dashboard →</a>
      </p>
      <p style="margin:24px 0 0;color:#6b7280;font-size:12px;text-align:center;">
        From the dashboard you can mark visits complete (next visit auto-schedules) and view full customer details.
      </p>
    </div>
  </div>
</body></html>`;

  // Plain-text fallback
  const textLines = [];
  textLines.push(`Generator Care — daily digest`);
  textLines.push(`${total} customer${total === 1 ? '' : 's'} need attention in next 14 days.`);
  if (overdue.length) {
    textLines.push('');
    textLines.push(`OVERDUE (${overdue.length}):`);
    for (const s of overdue) {
      const c = s.customer || {};
      const d = daysUntil(s.next_visit_due);
      textLines.push(`- ${c.name} — ${genClassLabel(s.gen_class)} — ${Math.abs(d)} days overdue — ${c.phone || ''}`);
    }
  }
  if (upcoming.length) {
    textLines.push('');
    textLines.push(`DUE IN NEXT 14 DAYS (${upcoming.length}):`);
    for (const s of upcoming) {
      const c = s.customer || {};
      const d = daysUntil(s.next_visit_due);
      textLines.push(`- ${c.name} — ${genClassLabel(s.gen_class)} — ${d === 0 ? 'today' : d === 1 ? 'tomorrow' : `in ${d} days`} (${fmtDate(s.next_visit_due)}) — ${c.phone || ''}`);
    }
  }
  textLines.push('');
  textLines.push(`Dashboard: ${dashboardUrl}`);

  return { subject, html, text: textLines.join('\n') };
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

module.exports = router;
