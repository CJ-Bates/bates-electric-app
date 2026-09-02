// frontend/metrics.js
// Metrics view for the Generator Care program — WP5 "growth engine" redesign,
// laid out per the approved Metrics Redesign Mockup.
// All aggregation happens server-side (GET /api/generator-care/metrics); this
// file only formats numbers and draws the visuals: Chart.js for the signup
// bars + the two mix donuts, plain CSS for the funnel / progress / horizontal
// bars / weekly drip (they read tokens directly, so they theme automatically).

(() => {
  const API_BASE = (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
    ? 'http://localhost:4000'
    : 'https://bates-electric-app.onrender.com';
  const TOKEN_KEY = 'bates.auth.token';

  const getToken = () =>
    localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY);

  const token = getToken();
  if (!token) {
    window.location.replace('/');
    return;
  }

  // ---- Palette: read from the v3 design tokens at render time ----
  // getComputedStyle reflects the html.dark token swap, so charts follow
  // light/dark automatically (render() re-runs on Refresh after a toggle).
  const tok = (name) =>
    getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  // Category accents per lead source (mockup: which channel closes best).
  const SOURCE_META = {
    campaign: { label: 'Campaign',     color: '--violet' },
    field:    { label: 'Field (tech)', color: '--amber' },
    referral: { label: 'Referral',     color: '--green' },
    manual:   { label: 'Manual',       color: '--neutral' },
  };
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // "How did you hear about us?" answers from the signup form.
  const CHANNEL_LABELS = {
    existing_customer: 'Installed/serviced by Bates',
    phone_call: 'Phone call from Bates',
    postcard_mail: 'Postcard / mail',
    website: 'Website',
    referral: 'Referral',
    other: 'Other',
  };
  const channelLabel = (k) =>
    CHANNEL_LABELS[k] || String(k).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

  // ---- Helpers ----
  const $ = (id) => document.getElementById(id);
  // SEC-P1 §5: escape server-derived labels before they hit innerHTML. Values
  // are constrained today (addon_type/gen_class/source), so this is defense in
  // depth for consistency. BatesUI.escapeHtml is loaded on the host page.
  const esc = (s) => (window.BatesUI && window.BatesUI.escapeHtml)
    ? window.BatesUI.escapeHtml(s)
    : String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const fmtInt = (n) => (n || 0).toLocaleString('en-US');
  const fmtMoneyWhole = (cents) =>
    '$' + Math.round((cents || 0) / 100).toLocaleString('en-US');
  const fmtPct = (frac, digits = 0) =>
    (100 * (frac || 0)).toFixed(digits) + '%';
  // US MM/DD/YYYY, same convention as leads.js / accounting.js.
  const fmtDate = (ymd) => {
    const [y, m, d] = String(ymd).slice(0, 10).split('-').map(Number);
    if (!y || !m || !d) return ymd || '';
    return `${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}/${y}`;
  };
  const shortMd = (ymd) => {
    const [, m, d] = String(ymd).slice(0, 10).split('-').map(Number);
    return m && d ? `${m}/${d}` : '';
  };
  const monthLabel = (ym) => {
    const [y, m] = String(ym).split('-').map(Number);
    if (!y || !m) return ym;
    return new Date(y, m - 1, 1).toLocaleString('en-US', { month: 'short' }) + " '" + String(y).slice(2);
  };

  // ---- Role check (must be office) ----
  async function checkRole() {
    try {
      const r = await BatesAuth.authFetch(`${API_BASE}/me`, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) throw new Error('Failed to get profile');
      const { profile } = await r.json();
      if (profile.role !== 'office') {
        showStatus('Access denied. Office role required.', 'error');
        setTimeout(() => window.location.replace('/home'), 1500);
      }
    } catch (err) {
      console.error('Role check failed:', err);
    }
  }

  // ---- Chart lifecycle: keep refs so Refresh can destroy before redraw ----
  const charts = {};
  // Chart.js's own ResizeObserver reads 0x0 while this tab's section is
  // display:none, then corrects itself a frame after the section is shown
  // again — that two-paint correction is exactly the resize "flash" on every
  // switch back to this tab. Calling resize() synchronously right after the
  // section un-hides forces the recalculation into the same frame instead
  // (a no-op before any chart exists, e.g. on first activation).
  function resizeCharts() {
    Object.values(charts).forEach((c) => c.resize());
  }
  function draw(key, canvasId, config) {
    if (charts[key]) { charts[key].destroy(); delete charts[key]; }
    const el = $(canvasId);
    if (!el || typeof Chart === 'undefined') return;
    // Un-hide + clear any empty-state note left from a previous render
    // (Refresh-safe — see emptyPanel).
    el.style.display = '';
    const prevNote = el.parentElement && el.parentElement.querySelector('.m-empty-note');
    if (prevNote) prevNote.remove();
    charts[key] = new Chart(el.getContext('2d'), config);
  }

  // Empty state for the CSS-built containers: swap the content for a note.
  function emptyNote(containerId, msg) {
    const wrap = $(containerId);
    if (wrap) wrap.innerHTML = `<div class="m-empty-note">${msg}</div>`;
  }

  // Empty state for a Chart.js panel: hide the canvas (without destroying it)
  // and show a note instead, so a later Refresh with real data can redraw.
  function emptyPanel(wrapId, msg) {
    const wrap = $(wrapId);
    if (!wrap) return;
    const canvas = wrap.querySelector('canvas');
    for (const k of Object.keys(charts)) {
      if (charts[k] && charts[k].canvas === canvas) { charts[k].destroy(); delete charts[k]; }
    }
    if (canvas) canvas.style.display = 'none';
    let note = wrap.querySelector('.m-empty-note');
    if (!note) { note = document.createElement('div'); note.className = 'm-empty-note'; wrap.appendChild(note); }
    note.textContent = msg;
  }

  // ---- Load + render ----
  async function loadMetrics() {
    const from = $('m-from-date').value;
    const to = $('m-to-date').value;
    const hideTest = $('m-hide-test').checked ? '1' : '0';
    $('m-loading').hidden = false;
    $('m-content').hidden = true;
    try {
      const url = `${API_BASE}/api/generator-care/metrics?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&hide_test=${hideTest}`;
      const r = await BatesAuth.authFetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const data = await r.json();
      render(data);
      $('m-content').hidden = false;
    } catch (err) {
      console.error('Load failed:', err);
      showStatus('Failed to load metrics: ' + err.message, 'error');
    } finally {
      $('m-loading').hidden = true;
    }
  }

  function render(data) {
    const h = data.headline || {};
    const rev = data.revenue || {};
    const ret = data.retention || {};
    const leads = data.leads || {};
    const funnel = leads.funnel || { total: 0, contacted: 0, invited: 0, converted: 0 };

    // ----- Theme-aware chart colors, straight from the tokens -----
    const mobile = window.innerWidth <= 640;
    if (typeof Chart !== 'undefined') {
      Chart.defaults.color = tok('--ink-2');
      Chart.defaults.borderColor = tok('--line');
      Chart.defaults.font.family = tok('--font') || "'Exo 2', sans-serif";
    }

    // ----- KPI row -----
    const arrow = (name) => (window.BatesIcons ? BatesIcons.icon(name, 13) : '');
    $('kpi-active').textContent = fmtInt(h.active_subscriptions);
    const nm = h.new_this_month || 0;
    const deltaEl = $('kpi-active-delta');
    if (nm > 0) {
      deltaEl.className = 'delta up';
      deltaEl.innerHTML = `${arrow('trendUp')} +${fmtInt(nm)} this month`;
    } else {
      deltaEl.className = 'delta flat';
      deltaEl.innerHTML = `${arrow('trendFlat')} none new this month`;
    }

    $('kpi-mrr').innerHTML = `${fmtMoneyWhole(rev.mrr_cents)}<span class="unit">/mo</span>`;
    $('kpi-mrr-sub').textContent = `${fmtMoneyWhole(h.arr_cents)} / year`;

    const convRate = funnel.invited ? funnel.converted / funnel.invited : 0;
    $('kpi-conv').textContent = fmtPct(convRate);
    $('kpi-conv-sub').textContent = `${fmtInt(funnel.converted)} of ${fmtInt(funnel.invited)} invited`;

    $('kpi-invited').textContent = fmtInt(leads.invited_this_month);
    $('kpi-invited-sub').textContent = `${fmtInt(funnel.invited)} invited all-time`;

    const newMrr = rev.new_mrr_cents_this_month || 0;
    $('kpi-newrev').textContent = (newMrr > 0 ? '+' : '') + fmtMoneyWhole(newMrr);
    $('kpi-newrev-sub').textContent = `from ${fmtInt(nm)} new signup${nm === 1 ? '' : 's'}`;

    // ----- Growth engine: pipeline funnel -----
    if (funnel.total > 0) {
      $('funnel-cap').textContent = `Where the ${fmtInt(funnel.total)} active leads are in the journey`;
      const stages = [
        { label: 'Leads',     note: 'in the pipeline',                                          count: funnel.total,     color: '--accent' },
        { label: 'Contacted', note: fmtPct(funnel.contacted / funnel.total),                    count: funnel.contacted, color: '--info' },
        { label: 'Invited',   note: funnel.contacted ? fmtPct(funnel.invited / funnel.contacted) + ' of contacted' : '', count: funnel.invited, color: '--violet' },
        { label: 'Converted', note: funnel.invited ? fmtPct(funnel.converted / funnel.invited) + ' of invited' : '',     count: funnel.converted, color: '--money' },
      ];
      $('m-funnel').innerHTML = stages.map((s) => {
        const w = Math.max(9, Math.round(100 * s.count / funnel.total));
        return `<div class="m-fstage">
          <div class="m-fbar" style="width:${w}%;background:var(${s.color});">${fmtInt(s.count)}</div>
          <div class="m-fmeta"><b>${s.label}</b> <span class="m-fdrop">${s.note}</span></div>
        </div>`;
      }).join('');
    } else {
      $('funnel-cap').textContent = 'Where the leads are in the journey';
      emptyNote('m-funnel', 'No leads in the pipeline yet — add or import leads on the Leads tab.');
    }

    // ----- Growth engine: campaign progress -----
    const camp = leads.campaign || { total: 0, invited: 0, converted: 0, by_month: [] };
    const cohortsEl = $('m-cohorts');
    const cohortsCap = $('m-cohorts-cap');
    if (camp.total > 0) {
      const invitedNotConv = Math.max(0, camp.invited - camp.converted);
      const toGo = Math.max(0, camp.total - camp.invited);
      $('m-campaign').innerHTML = `
        <div class="track">
          <div class="fill" style="width:${(100 * invitedNotConv / camp.total).toFixed(1)}%;background:var(--violet);"></div>
          <div class="fill" style="width:${(100 * camp.converted / camp.total).toFixed(1)}%;background:var(--money);"></div>
        </div>
        <div class="nums">
          <span><b>${fmtInt(camp.invited)}</b> invited (${fmtPct(camp.invited / camp.total)})</span>
          <span><b>${fmtInt(camp.converted)}</b> converted</span>
          <span><b>${fmtInt(toGo)}</b> to go</span>
        </div>`;

      // Cohort mini-bars: rotate Jan..Dec so the current month leads (that's
      // the cohort being worked), unplaced (null month) last. Bar width is
      // invited relative to the busiest cohort; a cohort with nothing sent
      // yet gets a light stub (mockup: "lighter = not started").
      const byMonth = camp.by_month || [];
      const nowIdx = new Date().getMonth();
      const order = (m) => {
        if (m.month === null) return 99;
        const i = MONTHS.indexOf(m.month);
        return (i - nowIdx + 12) % 12;
      };
      const rotated = [...byMonth].sort((a, b) => order(a) - order(b));
      const maxInvited = Math.max(1, ...rotated.map((m) => m.invited));
      cohortsEl.hidden = false;
      cohortsCap.hidden = false;
      cohortsEl.innerHTML = rotated.map((m) => {
        const name = m.month === null ? 'No month set' : (m.month + (MONTHS.indexOf(m.month) === nowIdx ? ' (due now)' : ''));
        const started = m.invited > 0;
        const w = started ? Math.max(4, Math.round(100 * m.invited / maxInvited)) : 8;
        const fill = started ? 'var(--info)' : 'var(--line)';
        return `<div class="m-hbar">
          <span class="nm" title="${fmtInt(m.total)} in cohort">${name}</span>
          <div class="track"><div class="fill" style="width:${w}%;background:${fill};"></div></div>
          <span class="pct">${fmtInt(m.invited)}</span>
        </div>`;
      }).join('');
    } else {
      emptyNote('m-campaign', 'No campaign leads yet — the maintenance-book import fills this in.');
      cohortsEl.hidden = true;
      cohortsEl.innerHTML = '';
      cohortsCap.hidden = true;
    }

    // ----- Growth engine: conversion by source -----
    const bySource = (leads.conversion_by_source || []).filter((s) => s.invited > 0);
    if (bySource.length) {
      const sorted = [...bySource].sort((a, b) => b.rate - a.rate);
      const maxRate = Math.max(sorted[0].rate, 0.0001);
      $('m-sources').innerHTML = sorted.map((s) => {
        const meta = SOURCE_META[s.source] || { label: s.source, color: '--neutral' };
        const w = Math.max(3, Math.round(100 * s.rate / maxRate));
        return `<div class="m-hbar">
          <span class="nm" title="${fmtInt(s.converted)} of ${fmtInt(s.invited)} invited">${esc(meta.label)}</span>
          <div class="track"><div class="fill" style="width:${w}%;background:var(${meta.color});"></div></div>
          <span class="pct">${fmtPct(s.rate)}</span>
        </div>`;
      }).join('');
    } else {
      emptyNote('m-sources', 'Conversion rates appear once invites start going out.');
    }

    // ----- Growth engine: invite velocity + follow-up count -----
    const vel = leads.invite_velocity || [];
    const followEl = $('m-followup');
    followEl.textContent = leads.needs_follow_up > 0 ? `${fmtInt(leads.needs_follow_up)} need follow-up` : '';
    const maxVel = Math.max(...vel.map((w) => w.count), 0);
    if (vel.length && maxVel > 0) {
      $('m-velocity').innerHTML = vel.map((w) =>
        `<div class="b" style="height:${Math.max(3, Math.round(100 * w.count / maxVel))}%;" title="${fmtInt(w.count)} the week of ${fmtDate(w.week_start)}"></div>`
      ).join('');
      $('m-velocity-lab').innerHTML = vel.map((w, i) =>
        `<span>${mobile && i % 2 ? '' : shortMd(w.week_start)}</span>`
      ).join('');
    } else {
      emptyNote('m-velocity', 'No invites sent in the last 12 weeks.');
      $('m-velocity-lab').innerHTML = '';
    }

    // ----- Program & revenue: signups by month (Chart.js bar) -----
    const sm = data.signups_by_month || [];
    // On phones, thin the month labels to ~every other one so they stay
    // legible and unrotated; all bars (data) are kept.
    const signupsScales = {
      y: { beginAtZero: true, ticks: { precision: 0 } },
    };
    if (mobile) {
      signupsScales.x = {
        ticks: {
          autoSkip: false,
          maxRotation: 0,
          callback: function (value, index) { return index % 2 !== 0 ? '' : this.getLabelForValue(value); },
        },
      };
    }
    draw('signups', 'chart-signups', {
      type: 'bar',
      data: {
        labels: sm.map((p) => monthLabel(p.month)),
        datasets: [{ data: sm.map((p) => p.count), backgroundColor: tok('--info'), borderRadius: 4, maxBarThickness: 46 }],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: signupsScales,
      },
    });
    $('signups-note').textContent =
      `By month signed up · ${fmtDate(data.from)} – ${fmtDate(data.to)}`;

    // ----- Program & revenue: plan & generator mix (donuts + HTML legends) -----
    drawMixDonut('plan', 'chart-plan', 'legend-plan',
      (data.plan_mix || []).filter((p) => p.count > 0),
      { annual: tok('--accent'), semi_annual: tok('--navy-100') });
    drawMixDonut('gen', 'chart-gen', 'legend-gen',
      data.gen_class_mix || [],
      null, [tok('--violet'), tok('--info'), tok('--money')]);

    // ----- Program & revenue: add-on attach (horizontal bars) -----
    const ap = data.addon_popularity || [];
    const activeCount = h.active_subscriptions || 0;
    if (ap.length && activeCount > 0) {
      const maxShare = Math.max(...ap.map((p) => p.count / activeCount));
      $('m-addons').innerHTML = ap.map((p) => {
        const share = p.count / activeCount;
        const w = Math.max(3, Math.round(100 * share / maxShare));
        return `<div class="m-hbar">
          <span class="nm" title="${fmtInt(p.count)} sub${p.count === 1 ? '' : 's'}">${esc(p.label)}</span>
          <div class="track"><div class="fill" style="width:${w}%;background:var(--money);"></div></div>
          <span class="pct">${fmtPct(share)}</span>
        </div>`;
      }).join('');
    } else {
      emptyNote('m-addons', 'No add-ons on active subscriptions yet.');
    }

    // ----- Program & revenue: retention + revenue per sub -----
    const netNew = ret.net_new || 0;
    $('m-retention').innerHTML = `
      <div><div class="num green">${fmtPct(ret.retention_pct)}</div><div class="cap">retained</div></div>
      <div><div class="num coral">${fmtInt(ret.canceled_12mo)}</div><div class="cap">canceled</div></div>
      <div><div class="num">${netNew >= 0 ? '+' : ''}${fmtInt(netNew)}</div><div class="cap">net new</div></div>`;
    $('m-arpu').textContent = fmtMoneyWhole(rev.arpu_annual_cents);

    // ----- Program & revenue: signups by channel (horizontal bars) -----
    const ch = data.channel || {};
    const cb = ch.breakdown || [];
    if (cb.length) {
      const cCats = [
        tok('--accent'), tok('--info'), tok('--violet'), tok('--green'),
        tok('--amber'), tok('--money'), tok('--coral'), tok('--neutral'),
      ];
      draw('channel', 'chart-channel', {
        type: 'bar',
        data: {
          labels: cb.map((p) => channelLabel(p.source)),
          datasets: [{ data: cb.map((p) => p.count), backgroundColor: cb.map((_, i) => cCats[i % cCats.length]), borderRadius: 4 }],
        },
        options: {
          indexAxis: 'y',
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: { x: { beginAtZero: true, ticks: { precision: 0 } } },
        },
      });
      $('channel-note').textContent = ch.collecting_since
        ? `How customers heard about us · collecting since ${fmtDate(ch.collecting_since)}`
        : 'How customers heard about us';
    } else {
      emptyPanel('channel-wrap', ch.collecting_since
        ? `No "how did you hear about us" answers in this range yet (collecting since ${fmtDate(ch.collecting_since)}).`
        : 'Channel data starts collecting once new signups answer "How did you hear about us?" on the signup form.');
    }

    // ----- Program & revenue: cancellations trend -----
    const churn = data.churn || {};
    const cbm = churn.by_month || [];
    $('churn-note').innerHTML =
      `Overall churn <strong>${fmtPct(churn.overall_rate, 1)}</strong> · ${fmtInt(churn.canceled_total)} canceled all-time · ${fmtInt(churn.canceled_in_range)} in range`;
    if (churn.tracking_since) {
      draw('churn', 'chart-churn', {
        type: 'bar',
        data: {
          labels: cbm.map((p) => monthLabel(p.month)),
          datasets: [{ data: cbm.map((p) => p.count), backgroundColor: tok('--coral'), borderRadius: 4, maxBarThickness: 46 }],
        },
        options: {
          responsive: true, maintainAspectRatio: false,
          plugins: { legend: { display: false } },
          scales: { y: { beginAtZero: true, ticks: { precision: 0 } } },
        },
      });
    } else {
      emptyPanel('churn-wrap',
        'No cancellations recorded with a date yet. Cancellation dates are tracked going forward, so the monthly trend starts filling in from now.');
    }
  }

  // One small mix donut + its HTML legend. colorByKey maps slice key ->
  // color; when null, palette[] colors are used in order.
  function drawMixDonut(chartKey, canvasId, legendId, mix, colorByKey, palette) {
    const legendEl = $(legendId);
    const total = mix.reduce((s, p) => s + p.count, 0);
    if (!total) {
      draw(chartKey, canvasId, {
        type: 'doughnut',
        data: { labels: ['No active subs'], datasets: [{ data: [1], backgroundColor: [tok('--neutral-bg')], borderWidth: 0 }] },
        options: { responsive: true, maintainAspectRatio: false, cutout: '68%', plugins: { legend: { display: false }, tooltip: { enabled: false } } },
      });
      legendEl.innerHTML = '<div class="row">No active subs</div>';
      return;
    }
    const colors = mix.map((p, i) =>
      colorByKey ? (colorByKey[p.key] || tok('--neutral')) : palette[i % palette.length]);
    draw(chartKey, canvasId, {
      type: 'doughnut',
      data: {
        labels: mix.map((p) => p.label),
        datasets: [{ data: mix.map((p) => p.count), backgroundColor: colors, borderWidth: 0 }],
      },
      options: { responsive: true, maintainAspectRatio: false, cutout: '68%', plugins: { legend: { display: false } } },
    });
    legendEl.innerHTML = mix.map((p, i) => `
      <div class="row"><span class="dot" style="background:${colors[i]};"></span><b>${fmtPct(p.count / total)}</b> ${esc(p.label)}</div>`).join('');
  }

  // ---- Init ----
  // Called by generator-care.js the first time the Metrics tab is opened
  // (after Chart.js has loaded) rather than on DOMContentLoaded — this view
  // is lazy-loaded, not a standalone page anymore. refresh() is what the
  // shared header Refresh button calls while this tab is active.
  function init() {
    const today = new Date();
    const start = new Date(today.getFullYear() - 1, today.getMonth(), today.getDate());
    $('m-from-date').value = start.toISOString().slice(0, 10);
    $('m-to-date').value = today.toISOString().slice(0, 10);

    $('m-apply-btn').addEventListener('click', loadMetrics);
    $('m-hide-test').addEventListener('change', loadMetrics);

    checkRole();
    loadMetrics();
  }

  window.BatesMetrics = { init, refresh: loadMetrics, onShow: resizeCharts };
})();
