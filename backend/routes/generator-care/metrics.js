// backend/routes/generator-care/metrics.js
// Pre-computed aggregates for the Metrics / Insights dashboard.
// Auth (requireAuth + office role) is applied by ./index.js.

const express = require('express');
const { supabaseAdmin } = require('../../lib/supabase');

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

// GET /api/generator-care/metrics?from=YYYY-MM-DD&to=YYYY-MM-DD
// Pre-computed aggregates for the Metrics / Insights dashboard. All math is done
// here (server-side), never in the browser. Two groups of metrics:
//   * SNAPSHOT (active count, ARR, plan mix, gen-class mix, add-on attach +
//     popularity) reflect the CURRENT active book and ignore from/to.
//   * FLOW (signups-by-month, channel breakdown, canceled trend) respect the
//     range. "New this month" is always the current calendar month.
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

router.get('/metrics', async (req, res) => {
  try {
    const toStr = isYmd(req.query.to) ? req.query.to : todayYmd();
    const fromStr = isYmd(req.query.from) ? req.query.from : ymdMonthsAgo(toStr, 12);

    // ===== Snapshot: the current active book =====
    const { data: activeSubs, error: activeErr } = await supabaseAdmin
      .from('generator_subscriptions')
      .select('id, plan, gen_class, fleet_monitoring, annual_price_cents')
      .eq('status', 'active');
    if (activeErr) throw activeErr;
    const active = activeSubs || [];
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

    // ===== Flow: signups in range, by month + by channel =====
    const { data: rangeSubs, error: rangeErr } = await supabaseAdmin
      .from('generator_subscriptions')
      .select('signup_date, created_at, signup_source')
      .gte('signup_date', fromStr)
      .lte('signup_date', toStr);
    if (rangeErr) throw rangeErr;
    const signupsByMonth = bucketByMonth(
      (rangeSubs || []).map(r => r.signup_date || (r.created_at || '').slice(0, 10)),
      fromStr, toStr,
    );
    const channelCounts = {};
    let channelKnown = 0;
    for (const r of (rangeSubs || [])) {
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
    const monthStart = todayYmd().slice(0, 7) + '-01';
    const lastMonthStart = ymdMonthsAgo(monthStart, 1);
    const [{ count: newThisMonth }, { count: newLastMonth }] = await Promise.all([
      supabaseAdmin.from('generator_subscriptions').select('id', { count: 'exact', head: true })
        .gte('signup_date', monthStart).lte('signup_date', todayYmd()),
      supabaseAdmin.from('generator_subscriptions').select('id', { count: 'exact', head: true })
        .gte('signup_date', lastMonthStart).lt('signup_date', monthStart),
    ]);

    // ===== Churn =====
    const { count: canceledTotal } = await supabaseAdmin
      .from('generator_subscriptions')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'canceled');
    const denom = activeCount + (canceledTotal || 0);
    const overallChurn = denom > 0 ? (canceledTotal || 0) / denom : 0;

    // Canceled in range + monthly trend (needs canceled_at; null pre-005).
    const { data: canceledRows, error: canErr } = await supabaseAdmin
      .from('generator_subscriptions')
      .select('canceled_at')
      .not('canceled_at', 'is', null)
      .gte('canceled_at', fromStr)
      .lte('canceled_at', toStr + 'T23:59:59.999Z');
    if (canErr) throw canErr;
    const canceledByMonth = bucketByMonth((canceledRows || []).map(r => (r.canceled_at || '').slice(0, 10)), fromStr, toStr);
    const { data: firstCancel } = await supabaseAdmin
      .from('generator_subscriptions')
      .select('canceled_at')
      .not('canceled_at', 'is', null)
      .order('canceled_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    const cancelTrackingSince = firstCancel ? (firstCancel.canceled_at || '').slice(0, 10) : null;

    res.json({
      from: fromStr,
      to: toStr,
      generated_at: new Date().toISOString(),
      headline: {
        active_subscriptions: activeCount,
        new_this_month: newThisMonth || 0,
        new_last_month: newLastMonth || 0,
        arr_cents: arrCents,
        attach_rate: attachRate,           // 0..1
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
        canceled_total: canceledTotal || 0,
        canceled_in_range: (canceledRows || []).length,
        by_month: canceledByMonth,
        tracking_since: cancelTrackingSince,
      },
      channel: {
        breakdown: channelBreakdown,
        known_count: channelKnown,
        collecting_since: collectingSince,
      },
    });
  } catch (err) {
    console.error('[generator-care] metrics error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
