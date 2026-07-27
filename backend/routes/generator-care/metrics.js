// backend/routes/generator-care/metrics.js
// Pre-computed aggregates for the Metrics / Insights dashboard.
// Auth (requireAuth + office role) is applied by ./index.js.

const express = require('express');
const { supabaseAdmin } = require('../../lib/supabase');
const { requirePermission } = require('../../middleware/permissions');
const { reportError } = require('../../middleware/error-reporter');

const router = express.Router();

// ---- Metrics helpers (date math + month bucketing for /metrics) ----
function todayYmd() { return new Date().toISOString().slice(0, 10); }
function isYmd(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s); }
// Subtract n whole months from a YYYY-MM-DD string (UTC).
function ymdMonthsAgo(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, (m - 1) - n, d)).toISOString().slice(0, 10);
}
// Dense month series [{month:'YYYY-MM', count}] spanning fromStr..toStr, counting
// how many of `dates` (YYYY-MM-DD strings) fall in each month. Empty months = 0.
function bucketByMonth(dates, fromStr, toStr) {
  const counts = {};
  for (const d of dates) { if (!d) continue; const k = d.slice(0, 7); counts[k] = (counts[k] || 0) + 1; }
  const series = [];
  let [y, m] = fromStr.slice(0, 7).split('-').map(Number);
  const [ty, tm] = toStr.slice(0, 7).split('-').map(Number);
  for (let i = 0; i < 120; i++) { // cap guards against a malformed range
    series.push({ month: `${y}-${String(m).padStart(2, '0')}`, count: counts[`${y}-${String(m).padStart(2, '0')}`] || 0 });
    if (y === ty && m === tm) break;
    m++; if (m > 12) { m = 1; y++; }
    if (y > ty || (y === ty && m > tm)) break;
  }
  return series;
}
// Monday (UTC) of the week containing a YYYY-MM-DD string.
function weekStartYmd(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - ((dt.getUTCDay() + 6) % 7));
  return dt.toISOString().slice(0, 10);
}
// Dense weekly series [{week_start:'YYYY-MM-DD', count}] for the `weeks` weeks
// ending in the week containing toStr, counting how many of `timestamps`
// (ISO strings) fall in each week. Older timestamps just fall outside.
function bucketByWeek(timestamps, weeks, toStr) {
  const counts = {};
  for (const ts of timestamps) {
    if (!ts) continue;
    const ws = weekStartYmd(String(ts).slice(0, 10));
    counts[ws] = (counts[ws] || 0) + 1;
  }
  const series = [];
  const [y, m, d] = weekStartYmd(toStr).split('-').map(Number);
  for (let i = weeks - 1; i >= 0; i--) {
    const dt = new Date(Date.UTC(y, m - 1, d - 7 * i));
    const ws = dt.toISOString().slice(0, 10);
    series.push({ week_start: ws, count: counts[ws] || 0 });
  }
  return series;
}

// GET /api/generator-care/metrics?from=YYYY-MM-DD&to=YYYY-MM-DD&hide_test=1
// Pre-computed aggregates for the Metrics / Insights dashboard. All math is done
// here (server-side), never in the browser. Three groups of metrics:
//   * SNAPSHOT (active count, ARR/MRR/ARPU, plan mix, gen-class mix, add-on
//     attach + popularity) reflect the CURRENT active book and ignore from/to.
//   * FLOW (signups-by-month, channel breakdown, canceled trend) respect the
//     range. "New this month" is always the current calendar month, and the
//     retention view is always the trailing 12 months.
//   * LEADS (WP5 growth engine: funnel, campaign progress, conversion by
//     source, invite velocity, needs-follow-up) are a snapshot of the pipeline
//     and ignore from/to. Pipeline metrics EXCLUDE status='lost' leads, and
//     deleted leads are hard-deleted by DELETE /leads/:id so they're already
//     out (the WP4.2 forward note above LEAD_STATUSES in ./leads.js).
//
// hide_test=1 excludes early test subscriptions (signup_date before the first
// real customer) from every subscription-based number, mirroring the
// Accounting tab's "Hide early test activity" toggle. Leads need no such
// filter — test leads are deleted, not flagged.
const GEN_CLASS_LABELS = {
  air_cooled:    'Air-cooled (7–28 kW)',
  liquid_22_38:  'Liquid (22–45 kW)',
  liquid_48_150: 'Liquid (48–150 kW)',
};
const ADDON_LABELS = {
  fleet_monitoring:    'Fleet monitoring',
  battery_replacement: 'Battery replacement',
  battery_diagnostics: 'Battery diagnostics',
  exterior_wash:       'Exterior wash',
  coolant_flush:       'Coolant flush',
  coolant_topoff:      'Coolant top-off',
  ats_inspection:      'ATS inspection',
  ats_outage_combined: 'ATS + outage test',
  outage_test:         'Outage test',
};

// Subs signed up before this date are the pre-launch test activity ("Cj").
// MIRRORED as FIRST_REAL_CUSTOMER_DATE in frontend/accounting.js (separate
// deploys, no bundler) — edit BOTH together.
const FIRST_REAL_CUSTOMER_DATE = '2026-06-25';
// WP4.2 "Needs follow-up" window: invited this long ago with no signup yet.
// MIRRORED as FOLLOW_UP_DAYS in frontend/leads.js — edit BOTH together.
const FOLLOW_UP_DAYS = 21;
// How far back the invite-velocity weekly series reaches.
const INVITE_VELOCITY_WEEKS = 12;
// Conversion-by-source is reported for every source in this (display) order.
const LEAD_SOURCES = ['campaign', 'field', 'referral', 'manual'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// "Invited" = an invite went out: signup_sent, or converted (a conversion
// implies the lead got a link). Matches the funnel's stage definitions.
const INVITED_STATUSES = ['signup_sent', 'converted'];
const CONTACTED_STATUSES = ['contacted', 'signup_sent', 'converted'];

// Revenue/ARR/plan-mix/conversion data — same sensitivity as the accounting
// endpoints, so it requires the same flag (was office-role only).
router.get('/metrics', requirePermission('accounting'), async (req, res) => {
  try {
    const toStr = isYmd(req.query.to) ? req.query.to : todayYmd();
    const fromStr = isYmd(req.query.from) ? req.query.from : ymdMonthsAgo(toStr, 12);
    const hideTest = req.query.hide_test === '1' || req.query.hide_test === 'true';
    // Same rule as accounting.js's visibleTransactions(): a row with no date
    // is never hidden — only rows we can PROVE are pre-launch drop out.
    const isTestSub = (r) => {
      const d = r.signup_date || (r.created_at || '').slice(0, 10);
      return !!d && d < FIRST_REAL_CUSTOMER_DATE;
    };

    // ===== Snapshot: the current active book =====
    const { data: activeSubs, error: activeErr } = await supabaseAdmin
      .from('generator_subscriptions')
      .select('id, plan, gen_class, fleet_monitoring, annual_price_cents, signup_date, created_at')
      .eq('status', 'active');
    if (activeErr) throw activeErr;
    const active = (activeSubs || []).filter((r) => !hideTest || !isTestSub(r));
    const activeCount = active.length;
    const arrCents = active.reduce((s, r) => s + (r.annual_price_cents || 0), 0);

    const planMix = { semi_annual: 0, annual: 0 };
    const genClassMix = {};
    for (const r of active) {
      if (r.plan in planMix) planMix[r.plan]++;
      genClassMix[r.gen_class] = (genClassMix[r.gen_class] || 0) + 1;
    }

    // Add-ons: fleet_monitoring is a boolean on the sub; the rest are
    // generator_pending_addons rows (excluding canceled/failed = not opted in).
    const activeIds = active.map(r => r.id);
    const fleetCount = active.filter(r => r.fleet_monitoring).length;
    let pendingAddons = [];
    if (activeIds.length) {
      const { data: pa, error: paErr } = await supabaseAdmin
        .from('generator_pending_addons')
        .select('subscription_id, addon_type')
        .in('subscription_id', activeIds)
        .not('status', 'in', '(canceled,failed)');
      if (paErr) throw paErr;
      pendingAddons = pa || [];
    }
    const addonSubSets = {};            // addon_type -> Set(subId), so dupes per sub count once
    const subsWithAnyAddon = new Set();
    for (const a of pendingAddons) {
      (addonSubSets[a.addon_type] = addonSubSets[a.addon_type] || new Set()).add(a.subscription_id);
      subsWithAnyAddon.add(a.subscription_id);
    }
    for (const r of active) if (r.fleet_monitoring) subsWithAnyAddon.add(r.id);

    const addonPopularity = [];
    if (fleetCount > 0) addonPopularity.push({ key: 'fleet_monitoring', label: ADDON_LABELS.fleet_monitoring, count: fleetCount });
    for (const [type, set] of Object.entries(addonSubSets)) {
      addonPopularity.push({ key: type, label: ADDON_LABELS[type] || type, count: set.size });
    }
    addonPopularity.sort((a, b) => b.count - a.count);
    const attachRate = activeCount ? subsWithAnyAddon.size / activeCount : 0;

    // Revenue view of the same active book (WP5). "Monthly equivalent" is the
    // annual price / 12 regardless of billing cadence — semi-annual subs still
    // carry their full-year price in annual_price_cents.
    const monthStart = todayYmd().slice(0, 7) + '-01';
    const mrrCents = Math.round(arrCents / 12);
    const newMrrCentsThisMonth = Math.round(
      active
        .filter((r) => {
          const d = r.signup_date || (r.created_at || '').slice(0, 10);
          return d && d >= monthStart;
        })
        .reduce((s, r) => s + (r.annual_price_cents || 0), 0) / 12
    );
    const arpuAnnualCents = activeCount ? Math.round(arrCents / activeCount) : 0;

    // ===== Flow: signups in range, by month + by channel =====
    const { data: rangeSubsRaw, error: rangeErr } = await supabaseAdmin
      .from('generator_subscriptions')
      .select('signup_date, created_at, signup_source')
      .gte('signup_date', fromStr)
      .lte('signup_date', toStr);
    if (rangeErr) throw rangeErr;
    const rangeSubs = (rangeSubsRaw || []).filter((r) => !hideTest || !isTestSub(r));
    const signupsByMonth = bucketByMonth(
      rangeSubs.map(r => r.signup_date || (r.created_at || '').slice(0, 10)),
      fromStr, toStr,
    );
    const channelCounts = {};
    let channelKnown = 0;
    for (const r of rangeSubs) {
      if (r.signup_source) { channelCounts[r.signup_source] = (channelCounts[r.signup_source] || 0) + 1; channelKnown++; }
    }
    const channelBreakdown = Object.entries(channelCounts)
      .map(([source, count]) => ({ source, count }))
      .sort((a, b) => b.count - a.count);
    const { data: firstSrc } = await supabaseAdmin
      .from('generator_subscriptions')
      .select('signup_date')
      .not('signup_source', 'is', null)
      .order('signup_date', { ascending: true })
      .limit(1)
      .maybeSingle();
    const collectingSince = firstSrc ? firstSrc.signup_date : null;

    // New this month vs last month (current calendar month, range-independent).
    // With hide_test, the count floor never reaches back before the cutoff.
    const lastMonthStart = ymdMonthsAgo(monthStart, 1);
    const yearAgo = ymdMonthsAgo(todayYmd(), 12);
    const floorYmd = (ymd) => (hideTest && ymd < FIRST_REAL_CUSTOMER_DATE ? FIRST_REAL_CUSTOMER_DATE : ymd);
    const [{ count: newThisMonth }, { count: newLastMonth }, { count: new12mo }] = await Promise.all([
      supabaseAdmin.from('generator_subscriptions').select('id', { count: 'exact', head: true })
        .gte('signup_date', floorYmd(monthStart)).lte('signup_date', todayYmd()),
      supabaseAdmin.from('generator_subscriptions').select('id', { count: 'exact', head: true })
        .gte('signup_date', floorYmd(lastMonthStart)).lt('signup_date', monthStart),
      supabaseAdmin.from('generator_subscriptions').select('id', { count: 'exact', head: true })
        .gte('signup_date', floorYmd(yearAgo)).lte('signup_date', todayYmd()),
    ]);

    // ===== Churn + retention =====
    // One fetch of every canceled sub covers the all-time count, the in-range
    // trend, AND the trailing-12-month retention view (canceled subs are few).
    const { data: canceledRowsRaw, error: canErr } = await supabaseAdmin
      .from('generator_subscriptions')
      .select('signup_date, created_at, canceled_at')
      .eq('status', 'canceled');
    if (canErr) throw canErr;
    const canceledAll = (canceledRowsRaw || []).filter((r) => !hideTest || !isTestSub(r));
    const canceledTotal = canceledAll.length;
    const denom = activeCount + canceledTotal;
    const overallChurn = denom > 0 ? canceledTotal / denom : 0;

    // Trend needs a canceled_at date (null pre-005 — those count in the total
    // but can't be placed on the timeline).
    const toEnd = toStr + 'T23:59:59.999Z';
    const canceledInRange = canceledAll.filter((r) => r.canceled_at && r.canceled_at >= fromStr && r.canceled_at <= toEnd);
    const canceledByMonth = bucketByMonth(canceledInRange.map(r => (r.canceled_at || '').slice(0, 10)), fromStr, toStr);
    const datedCancels = canceledAll.map(r => r.canceled_at).filter(Boolean).sort();
    const cancelTrackingSince = datedCancels.length ? datedCancels[0].slice(0, 10) : null;

    const canceled12mo = canceledAll.filter((r) => r.canceled_at && r.canceled_at.slice(0, 10) >= yearAgo).length;
    const retentionDenom = activeCount + canceled12mo;
    const retentionPct = retentionDenom > 0 ? activeCount / retentionDenom : 0;
    const netNew = (new12mo || 0) - canceled12mo;

    // ===== Leads: the growth-engine pipeline (WP5) =====
    // Active pipeline only — status='lost' is excluded at the query and
    // deleted leads no longer exist, so every count below is "workable book".
    // Page past PostgREST's 1000-row cap like GET /leads does — the
    // maintenance-book import makes this ~1,650 rows.
    const PAGE = 1000;
    const leads = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabaseAdmin
        .from('generator_leads')
        .select('id, status, source, maintenance_month, invited_at')
        .neq('status', 'lost')
        .order('created_at', { ascending: false })
        .order('id', { ascending: true }) // created_at ties (bulk import) need a total order or pages could overlap
        .range(from, from + PAGE - 1);
      if (error) throw error;
      leads.push(...(data || []));
      if (!data || data.length < PAGE) break;
    }

    const isInvited = (l) => INVITED_STATUSES.includes(l.status);
    const funnel = {
      total: leads.length,
      contacted: leads.filter((l) => CONTACTED_STATUSES.includes(l.status)).length,
      invited: leads.filter(isInvited).length,
      converted: leads.filter((l) => l.status === 'converted').length,
    };

    // Campaign progress: the imported maintenance book, worked as month
    // cohorts. by_month is ordered Jan..Dec (months with no campaign leads are
    // omitted); leads the import couldn't place get month:null, listed last.
    const campaignLeads = leads.filter((l) => l.source === 'campaign');
    const campaignByMonth = [];
    for (const month of [...MONTHS, null]) {
      const cohort = campaignLeads.filter((l) => (l.maintenance_month || null) === month);
      if (!cohort.length) continue;
      campaignByMonth.push({
        month,
        total: cohort.length,
        invited: cohort.filter(isInvited).length,
        converted: cohort.filter((l) => l.status === 'converted').length,
      });
    }
    const campaign = {
      total: campaignLeads.length,
      invited: campaignLeads.filter(isInvited).length,
      converted: campaignLeads.filter((l) => l.status === 'converted').length,
      by_month: campaignByMonth,
    };

    // Which channel actually closes: converted / invited per source.
    const conversionBySource = LEAD_SOURCES.map((source) => {
      const pool = leads.filter((l) => l.source === source);
      const invited = pool.filter(isInvited).length;
      const converted = pool.filter((l) => l.status === 'converted').length;
      return { source, invited, converted, rate: invited > 0 ? converted / invited : 0 };
    });

    // The drip: invites per week (invited_at is stamped by every path that
    // sends or records an invite — see leads.js).
    const inviteVelocity = bucketByWeek(
      leads.map((l) => l.invited_at).filter(Boolean),
      INVITE_VELOCITY_WEEKS,
      todayYmd(),
    );
    const invitedThisMonth = leads.filter((l) => l.invited_at && String(l.invited_at).slice(0, 10) >= monthStart).length;

    // Same clock as the Leads tab's "Needs follow-up" flag (WP4.2).
    const followUpCutoff = Date.now() - FOLLOW_UP_DAYS * 24 * 60 * 60 * 1000;
    const needsFollowUp = leads.filter((l) => {
      if (l.status !== 'signup_sent' || !l.invited_at) return false;
      const t = new Date(l.invited_at).getTime();
      return Number.isFinite(t) && t < followUpCutoff;
    }).length;

    res.json({
      from: fromStr,
      to: toStr,
      generated_at: new Date().toISOString(),
      hide_test: hideTest,
      headline: {
        active_subscriptions: activeCount,
        new_this_month: newThisMonth || 0,
        new_last_month: newLastMonth || 0,
        arr_cents: arrCents,
        attach_rate: attachRate,           // 0..1
      },
      revenue: {
        mrr_cents: mrrCents,
        new_mrr_cents_this_month: newMrrCentsThisMonth,
        arpu_annual_cents: arpuAnnualCents,
      },
      retention: {                          // trailing 12 months, range-independent
        retention_pct: retentionPct,       // 0..1
        canceled_12mo: canceled12mo,
        net_new: netNew,
      },
      plan_mix: [
        { key: 'semi_annual', label: 'Semi-Annual', count: planMix.semi_annual },
        { key: 'annual',      label: 'Annual',      count: planMix.annual },
      ],
      gen_class_mix: Object.entries(genClassMix).map(([key, count]) => ({ key, label: GEN_CLASS_LABELS[key] || key, count })),
      addon_popularity: addonPopularity,
      signups_by_month: signupsByMonth,
      churn: {
        overall_rate: overallChurn,        // 0..1, point-in-time (NOT first-renewal)
        canceled_total: canceledTotal,
        canceled_in_range: canceledInRange.length,
        by_month: canceledByMonth,
        tracking_since: cancelTrackingSince,
      },
      channel: {
        breakdown: channelBreakdown,
        known_count: channelKnown,
        collecting_since: collectingSince,
      },
      leads: {
        funnel,                            // {total, contacted, invited, converted}
        campaign,                          // {total, invited, converted, by_month:[{month,total,invited,converted}]}
        conversion_by_source: conversionBySource,
        invite_velocity: inviteVelocity,   // [{week_start, count}] oldest..newest
        invited_this_month: invitedThisMonth,
        needs_follow_up: needsFollowUp,
        follow_up_days: FOLLOW_UP_DAYS,
      },
    });
  } catch (err) {
    console.error('[generator-care] metrics error:', err);
    reportError(err, { route: req.originalUrl, method: req.method, user: req.profile && req.profile.email }).catch(() => {});
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
