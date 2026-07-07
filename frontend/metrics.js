// frontend/metrics.js
// Metrics / Insights view for the Generator Care program.
// Mirrors the auth + fetch pattern used by accounting.js; charts via Chart.js.
// All aggregation happens server-side (GET /api/generator-care/metrics); this
// file only formats numbers and draws charts.

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

  const CHANNEL_LABELS = {
    existing_customer: 'Installed/serviced by Bates',
    phone_call: 'Phone call from Bates',
    postcard_mail: 'Postcard / mail',
    website: 'Website',
    referral: 'Referral',
    other: 'Other',
  };

  // ---- Helpers ----
  const $ = (id) => document.getElementById(id);
  const fmtMoneyWhole = (cents) =>
    '$' + Math.round((cents || 0) / 100).toLocaleString('en-US');
  const fmtPct = (frac, digits = 0) =>
    (100 * (frac || 0)).toFixed(digits) + '%';
  const channelLabel = (k) =>
    CHANNEL_LABELS[k] || String(k).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  const monthLabel = (ym) => {
    const [y, m] = String(ym).split('-').map(Number);
    if (!y || !m) return ym;
    return new Date(y, m - 1, 1).toLocaleString('en-US', { month: 'short' }) + " '" + String(y).slice(2);
  };
  const niceDate = (ymd) => {
    if (!ymd) return '';
    const [y, m, d] = String(ymd).slice(0, 10).split('-').map(Number);
    if (!y) return ymd;
    return new Date(y, (m || 1) - 1, d || 1).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  };

  function showStatus(msg, kind) {
    const el = $('status');
    el.textContent = msg;
    el.className = 'status ' + (kind || '');
    el.hidden = false;
    if (kind !== 'error') setTimeout(() => { el.hidden = true; }, 3500);
  }

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
  function draw(key, canvasId, config) {
    if (charts[key]) { charts[key].destroy(); delete charts[key]; }
    const el = $(canvasId);
    if (!el || typeof Chart === 'undefined') return;
    // Un-hide + clear any empty-state note left from a previous render (Refresh-safe).
    el.style.display = '';
    const prevNote = el.parentElement && el.parentElement.querySelector('.m-empty-note');
    if (prevNote) prevNote.remove();
    charts[key] = new Chart(el.getContext('2d'), config);
  }
  // Shared options
  const baseBar = {
    responsive: true, maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: { y: { beginAtZero: true, ticks: { precision: 0 } } },
  };
  const baseHBar = {
    indexAxis: 'y',
    responsive: true, maintainAspectRatio: false,
    plugins: { legend: { display: false } },
    scales: { x: { beginAtZero: true, ticks: { precision: 0 } } },
  };

  // ---- Load + render ----
  async function loadMetrics() {
    const from = $('from-date').value;
    const to = $('to-date').value;
    $('loading').hidden = false;
    $('content').hidden = true;
    try {
      const url = `${API_BASE}/api/generator-care/metrics?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
      const r = await BatesAuth.authFetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const data = await r.json();
      render(data);
      $('content').hidden = false;
    } catch (err) {
      console.error('Load failed:', err);
      showStatus('Failed to load metrics: ' + err.message, 'error');
    } finally {
      $('loading').hidden = true;
    }
  }

  function render(data) {
    const h = data.headline || {};

    // ----- Theme-aware chart colors, straight from the tokens -----
    // Chart.js global text/grid colors + all series fills read the v3 tokens,
    // so both themes come from the same source of truth as the rest of the UI.
    // Recomputed each render so a theme toggle + Refresh repaints correctly.
    const mobile = window.innerWidth <= 640;
    if (typeof Chart !== 'undefined') {
      Chart.defaults.color = tok('--ink-2');
      Chart.defaults.borderColor = tok('--line');
      Chart.defaults.font.family = tok('--font') || "'Exo 2', sans-serif";
    }
    const cBar   = tok('--accent');   // primary bars (signups, gen class)
    const cBar2  = tok('--info');     // secondary bars (add-ons)
    const cAmber = tok('--warn');     // cancellations
    const cDonut = [tok('--accent'), tok('--navy-600'), tok('--navy-100')];
    const cCats  = [
      tok('--accent'), tok('--info'), tok('--navy-600'), tok('--ok'),
      tok('--warn'), tok('--neutral'), tok('--danger'), tok('--navy-700'),
    ];

    // ----- Headline stat cards -----
    $('stat-active').textContent = (h.active_subscriptions || 0).toLocaleString('en-US');
    $('stat-active-sub').innerHTML = '&nbsp;';

    $('stat-new').textContent = (h.new_this_month || 0).toLocaleString('en-US');
    const nm = h.new_this_month || 0, lm = h.new_last_month || 0;
    let deltaHtml;
    if (lm === 0) {
      deltaHtml = `vs ${lm} last month`;
    } else {
      const pct = Math.round(((nm - lm) / lm) * 100);
      const cls = pct > 0 ? 'up' : (pct < 0 ? 'down' : 'flat');
      // Trend arrows are house-style inline SVG (icons.js) — no glyph icons.
      const iconName = pct > 0 ? 'trendUp' : (pct < 0 ? 'trendDown' : 'trendFlat');
      const arrow = window.BatesIcons ? BatesIcons.icon(iconName, 13) : '';
      deltaHtml = `<span class="${cls}">${arrow} ${Math.abs(pct)}%</span> vs last month (${lm})`;
    }
    $('stat-new-sub').innerHTML = deltaHtml;

    $('stat-arr').textContent = fmtMoneyWhole(h.arr_cents);
    $('stat-attach').textContent = fmtPct(h.attach_rate);

    // ----- Signups over time (bar) -----
    const sm = data.signups_by_month || [];
    // On phones, thin the month labels to ~every other one so they stay legible
    // and unrotated; all 12 bars (data) are kept. Desktop shows every label.
    const signupsScales = Object.assign({}, baseBar.scales);
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
        datasets: [{ data: sm.map((p) => p.count), backgroundColor: cBar, borderRadius: 4, maxBarThickness: 46 }],
      },
      options: Object.assign({}, baseBar, { scales: signupsScales }),
    });
    $('signups-note').textContent =
      `By month signed up · ${niceDate(data.from)} – ${niceDate(data.to)}`;

    // ----- Plan mix (doughnut) -----
    const pm = (data.plan_mix || []).filter((p) => p.count > 0);
    if (pm.length) {
      draw('plan', 'chart-plan', {
        type: 'doughnut',
        data: {
          labels: pm.map((p) => p.label),
          datasets: [{ data: pm.map((p) => p.count), backgroundColor: cDonut }],
        },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } } },
      });
    } else {
      draw('plan', 'chart-plan', emptyDoughnut());
    }

    // ----- Generator class (horizontal bar) -----
    const gc = data.gen_class_mix || [];
    draw('genclass', 'chart-genclass', {
      type: 'bar',
      data: {
        labels: gc.map((p) => p.label),
        datasets: [{ data: gc.map((p) => p.count), backgroundColor: cBar, borderRadius: 4 }],
      },
      options: baseHBar,
    });

    // ----- Add-on popularity (horizontal bar) -----
    const ap = data.addon_popularity || [];
    if (ap.length) {
      draw('addons', 'chart-addons', {
        type: 'bar',
        data: {
          labels: ap.map((p) => p.label),
          datasets: [{ data: ap.map((p) => p.count), backgroundColor: cBar2, borderRadius: 4 }],
        },
        options: baseHBar,
      });
    } else {
      emptyPanel('addon-wrap', 'No add-ons on active subscriptions yet.');
    }

    // ----- Cancellations -----
    const churn = data.churn || {};
    const cbm = churn.by_month || [];
    const churnPct = fmtPct(churn.overall_rate, 1);
    $('churn-note').innerHTML =
      `Overall churn <strong>${churnPct}</strong> · ${churn.canceled_total || 0} canceled all-time · ${churn.canceled_in_range || 0} in range`;
    if (churn.tracking_since) {
      draw('churn', 'chart-churn', {
        type: 'bar',
        data: {
          labels: cbm.map((p) => monthLabel(p.month)),
          datasets: [{ data: cbm.map((p) => p.count), backgroundColor: cAmber, borderRadius: 4, maxBarThickness: 46 }],
        },
        options: baseBar,
      });
    } else {
      emptyPanel('churn-wrap',
        'No cancellations recorded with a date yet. Cancellation dates are tracked going forward, so the monthly trend starts filling in from now.');
    }

    // ----- Signups by channel (horizontal bar) -----
    const ch = data.channel || {};
    const cb = ch.breakdown || [];
    if (cb.length) {
      draw('channel', 'chart-channel', {
        type: 'bar',
        data: {
          labels: cb.map((p) => channelLabel(p.source)),
          datasets: [{ data: cb.map((p) => p.count), backgroundColor: cb.map((_, i) => cCats[i % cCats.length]) }],
        },
        options: baseHBar,
      });
      $('channel-note').textContent = ch.collecting_since
        ? `How customers heard about us · collecting since ${niceDate(ch.collecting_since)}`
        : 'How customers heard about us';
    } else {
      emptyPanel('channel-wrap', ch.collecting_since
        ? `No "how did you hear about us" answers in this range yet (collecting since ${niceDate(ch.collecting_since)}).`
        : 'Channel data starts collecting once new signups answer "How did you hear about us?" on the signup form.');
    }
  }

  // Show a plain note in a panel (empty state) without destroying the canvas,
  // so a later Refresh with real data can redraw it.
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
    note.style.display = '';
  }

  function emptyDoughnut() {
    return {
      type: 'doughnut',
      data: { labels: ['No active subs'], datasets: [{ data: [1], backgroundColor: [tok('--neutral-bg')] }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { enabled: false } } },
    };
  }

  // ---- Init ----
  window.addEventListener('DOMContentLoaded', () => {
    const today = new Date();
    const start = new Date(today.getFullYear() - 1, today.getMonth(), today.getDate());
    $('from-date').value = start.toISOString().slice(0, 10);
    $('to-date').value = today.toISOString().slice(0, 10);

    $('apply-btn').addEventListener('click', loadMetrics);
    $('refresh-btn').addEventListener('click', loadMetrics);

    checkRole();
    loadMetrics();
  });
})();
