// frontend/generator-care.js
// Office dashboard for the Generator Care subscription program.
// Mirrors the auth pattern used by office.js.

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

  // State
  let allSubs = [];
  let activeFilter = 'all';
  let searchQuery = '';
  let currentUserEmail = null;
  // Effective permission flags from /me (null until loaded). UI hiding only —
  // every gated endpoint re-checks server-side (requirePermission).
  let userPerms = null;
  // Card on file for the open customer, set by loadStripeData. Used as the card
  // label in the refund dialog for ad-hoc/addon charges (which don't carry a
  // per-charge card client-side); invoices pass their exact card explicitly.
  let cardOnFile = null;
  // Next-renewal + pending-plan-change info for the open customer, set by
  // loadStripeData. Used by the Change-plan confirm dialog (for the renewal date).
  let planBilling = null;
  // Active + inactive tech accounts, loaded once for the per-visit assign picker
  // and the manage-techs screen. id -> name lookups use this.
  let techList = [];
  // Batched Stripe billing snapshot for the Needs Attention queue: renewal date
  // + card-on-file expiry per stripe_subscription_id, from GET /billing-snapshot.
  // null until the first load; {} with snapshotUnavailable=true when Stripe is
  // unreachable (the queue then simply shows its DB-derived items).
  let billingSnapshot = null;
  let snapshotUnavailable = false;
  // Guards renderAttention() so the skeleton stays up until real data lands.
  let subsLoaded = false;
  // Metrics/Accounting are lazy: data (and, for Metrics, Chart.js itself)
  // only loads the first time that tab is activated; these guard against
  // re-fetching on every later tab switch (only the header Refresh button does).
  let metricsLoaded = false;
  let accountingLoaded = false;
  let leadsLoaded = false;
  let chartJsPromise = null;

  const techName = (id) => {
    const t = techList.find((x) => x.id === id);
    return t ? (t.full_name || t.email) : 'Unknown tech';
  };
  // <select> options for the assign picker: "Unassigned" + each ACTIVE tech, with
  // the currently-assigned one selected (kept even if since deactivated).
  function techOptions(selectedId) {
    const opts = ['<option value="">— Unassigned —</option>'];
    for (const t of techList) {
      if (t.active === false && t.id !== selectedId) continue; // hide deactivated unless already on this visit
      const sel = t.id === selectedId ? ' selected' : '';
      const label = escapeHtml((t.full_name || t.email) + (t.active === false ? ' (inactive)' : ''));
      opts.push(`<option value="${escapeHtml(t.id)}"${sel}>${label}</option>`);
    }
    return opts.join('');
  }

  async function loadTechs() {
    try {
      const r = await BatesAuth.authFetch(`${API_BASE}/api/generator-care/techs`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) return;
      const data = await r.json();
      techList = data.techs || [];
    } catch (e) {
      console.error('loadTechs failed', e);
    }
  }

  // US states + DC for the Contact & Address state dropdown. 2-letter codes only
  // (matches the signup form) so install_state stays clean — FL branding keys off it.
  const US_STATES = ['AL','AK','AZ','AR','CA','CO','CT','DE','DC','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY'];

  // Canonical add-on display names — one source for the Add-ons list, the
  // work-order packet, and anywhere else an add-on is shown. The sellable types
  // mirror the backend ADDON_CATALOG labels (what the "+ Add Add-on" picker shows),
  // so signup/picker → dashboard → packet all agree; the rest are legacy types
  // kept so old records never render a raw id.
  const ADDON_LABELS = {
    fleet_monitoring: 'Fleet Monitoring',
    battery_replacement: 'Battery Replacement',
    battery_diagnostics: 'Battery Diagnostics / Load Test',
    exterior_wash: 'Exterior Wash & Interior Blow-Out',
    coolant_flush: 'Coolant System Flush',
    coolant_topoff: 'Coolant Top-Off Service',
    outage_test: 'Simulated Power Outage Test',
    ats_inspection: 'ATS Inspection',
    ats_outage_combined: 'Transfer Switch Inspection & Simulated Outage Test',
  };

  // Generator class / kW pricing tiers — values are the catalog gen_class keys
  // (the backend resolves the Stripe price from gen_class + cadence). Used by the
  // "Change tier" picker.
  const TIER_OPTIONS = [
    { value: 'air_cooled',    label: 'Air Cooled (7–28 kW)' },
    { value: 'liquid_22_38',  label: 'Liquid Cooled (22–45 kW)' },
    { value: 'liquid_48_150', label: 'Liquid Cooled (48–150 kW)' },
  ];

  // ---- Role check (must be office) ----
  async function checkRole() {
    try {
      const r = await BatesAuth.authFetch(`${API_BASE}/me`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) throw new Error('Failed to get profile');
      const { profile } = await r.json();
      // Cache for role-guard.js so the NEXT wrong-page hit redirects pre-paint
      // (also corrects a stale cached role from a previous account).
      try { localStorage.setItem('bates.profile', JSON.stringify(profile)); } catch (e) {}
      if (profile.role !== 'office') {
        // Immediately — no reason to hold a non-office user on office chrome
        // (role-guard.js keeps the shell hidden while this check ran).
        window.location.replace('/home');
        return;
      }
      document.documentElement.classList.remove('role-pending');
      currentUserEmail = profile.email || null;
      userPerms = profile.permissions || null;
      // Prefill the admin test-email "Send to" with the logged-in user's email
      const adminEmailInput = document.getElementById('gc-test-email');
      if (adminEmailInput && currentUserEmail && !adminEmailInput.value) {
        adminEmailInput.value = currentUserEmail;
      }
    } catch (err) {
      console.error('Role check failed:', err);
      document.documentElement.classList.remove('role-pending');
    }
  }

  // ---- Load all subscriptions ----
  async function loadSubscriptions() {
    showLoading(true);
    try {
      const r = await BatesAuth.authFetch(`${API_BASE}/api/generator-care/subscriptions`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const { subscriptions } = await r.json();
      allSubs = subscriptions || [];
      subsLoaded = true;
      render();
      renderAttention();
      showLoading(false);
    } catch (err) {
      console.error('Load failed:', err);
      showStatus(`Load failed: ${err.message}`, 'error');
      showLoading(false);
    }
  }

  // ---- Lazy Stripe enrichment for the attention queue ----
  // Renewal-window + card-expiry cards ride this; everything else in the queue
  // is DB-derived and renders without it. Failure degrades to "no extras".
  async function loadBillingSnapshot() {
    try {
      const r = await BatesAuth.authFetch(`${API_BASE}/api/generator-care/billing-snapshot`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      billingSnapshot = data.billing || {};
      snapshotUnavailable = !!data.unavailable;
    } catch (e) {
      console.error('billing snapshot failed:', e);
      billingSnapshot = {};
      snapshotUnavailable = true;
    }
    renderAttention();
  }

  // ---- Filtering / classification ----
  function daysUntil(dateStr) {
    if (!dateStr) return null;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const target = new Date(dateStr + 'T00:00:00');
    return Math.floor((target - today) / (1000 * 60 * 60 * 24));
  }

  // ---- Lifecycle classification ("Where they're at") ----
  // ONE state per customer, highest-priority-first, sharing thresholds and
  // signals with the Needs Attention queue so the two views tell one story.
  const DUE_SOON_DAYS = 21;      // CJ's ~3-week soft scheduling window
  const RENEWAL_SOON_DAYS = 30;  // renewal reach-out prompt
  const CARD_EXPIRING_DAYS = 60; // card-expiry heads-up

  function att(sub) { return sub.attention || {}; }
  function performedTotalCents(sub) {
    return (att(sub).performed_addons || []).reduce((s, a) => s + (a.amount_cents || 0), 0);
  }
  function hasFailedPayment(sub) {
    return sub.status === 'past_due'
      || (att(sub).failed_addons || []).length > 0
      || (att(sub).failed_charges || []).length > 0;
  }
  // Appointment date was before today (a today-appointment isn't "passed" —
  // the tech may still be on site) and the visit hasn't been completed.
  function apptPassed(ov) {
    if (!ov || !ov.appointment_at) return false;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const appt = new Date(ov.appointment_at);
    return !isNaN(appt.getTime()) && appt < today;
  }

  // Returns { key, tab, badge:[intent, label] }. `tab` = which filter pill the
  // customer belongs to ('none' = shows under All only, e.g. canceled).
  function lifecycleState(sub) {
    const a = att(sub);
    const d = daysUntil(sub.next_visit_due);
    const ov = sub.open_visit;
    const booked = !!(ov && ov.appointment_at);
    if (hasFailedPayment(sub)) return { key: 'payment_failed', tab: 'action', badge: ['badge-danger', 'Payment failed'] };
    if (sub.status === 'incomplete') return { key: 'incomplete', tab: 'action', badge: ['badge-danger', 'Signup incomplete'] };
    if (sub.status === 'canceled') {
      const st = sub.service_through;
      if (st && daysUntil(st) >= 0) return { key: 'cancel_pending', tab: 'none', badge: ['badge-neutral', `Canceled \u2014 ends ${fmtDate(st)}`] };
      return { key: 'canceled', tab: 'none', badge: ['badge-neutral', 'Canceled'] };
    }
    if (d !== null && d < 0 && !booked) return { key: 'overdue', tab: 'action', badge: ['badge-danger', 'Overdue'] };
    if (performedTotalCents(sub) > 0) return { key: 'charge_pending', tab: 'action', badge: ['badge-money', 'Charge pending'] };
    if (a.pending_prefs) return { key: 'awaiting_confirm', tab: 'action', badge: ['badge-info', 'Awaiting your confirm'] };
    if (apptPassed(ov)) return { key: 'appt_passed', tab: 'action', badge: ['badge-info', 'Confirm completion'] };
    if (!sub.work_order_created_at) return { key: 'needs_wo', tab: 'action', badge: ['badge-warn', 'New \u2014 needs WO'] };
    // Badge shows the arrival window when the visit has one; legacy bookings
    // without a window keep the date-only form (never a bare clock time).
    if (booked) {
      const label = window.BatesArrivalWindows.byCode[ov.arrival_window]
        ? fmtAppt(ov.appointment_at, ov.arrival_window)
        : fmtDate(String(ov.appointment_at).slice(0, 10));
      return { key: 'scheduled', tab: 'scheduled', badge: ['badge-ok', `Scheduled ${label}`] };
    }
    if (d === null) return { key: 'no_due', tab: 'action', badge: ['badge-warn', 'No due date'] };
    if (d <= DUE_SOON_DAYS) return { key: 'due_soon', tab: 'due-soon', badge: ['badge-warn', 'Due soon \u2014 schedule'] };
    return { key: 'all_good', tab: 'all-good', badge: ['badge-neutral', 'All good \u2014 nothing due'] };
  }

  // List sort: action states float to the top, resting customers sink — the
  // same "who needs me" ordering as the queue; due date breaks ties.
  const STATE_ORDER = {
    payment_failed: 0, incomplete: 1, overdue: 2, charge_pending: 3,
    awaiting_confirm: 4, appt_passed: 5, needs_wo: 6, no_due: 7,
    due_soon: 8, scheduled: 9, all_good: 10, cancel_pending: 11, canceled: 12,
  };

  function matchesSearch(sub) {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    const fields = [
      sub.customer?.name,
      sub.customer?.email,
      sub.customer?.phone,
      sub.customer?.install_address,
      sub.customer?.install_city,
      sub.customer?.install_zip,
      sub.gen_model,
      sub.gen_serial,
      sub.gen_type_label,
    ];
    return fields.some(f => f && String(f).toLowerCase().includes(q));
  }

  function filteredSubs() {
    return allSubs
      .filter(matchesSearch)
      .filter((sub) => {
        if (activeFilter === 'all') return true;
        return lifecycleState(sub).tab === activeFilter;
      })
      .sort((a, b) => {
        const ra = STATE_ORDER[lifecycleState(a).key] ?? 99;
        const rb = STATE_ORDER[lifecycleState(b).key] ?? 99;
        if (ra !== rb) return ra - rb;
        return String(a.next_visit_due || '9999').localeCompare(String(b.next_visit_due || '9999'));
      });
  }

  // ---- Render ----
  function render() {
    // Update tab counts (every customer is in All; canceled live ONLY there).
    let cAll = 0, cAction = 0, cDueSoon = 0, cScheduled = 0, cAllGood = 0;
    for (const s of allSubs.filter(matchesSearch)) {
      cAll++;
      const t = lifecycleState(s).tab;
      if (t === 'action') cAction++;
      else if (t === 'due-soon') cDueSoon++;
      else if (t === 'scheduled') cScheduled++;
      else if (t === 'all-good') cAllGood++;
    }
    document.getElementById('count-all').textContent = cAll;
    document.getElementById('count-action').textContent = cAction;
    document.getElementById('count-due-soon').textContent = cDueSoon;
    document.getElementById('count-scheduled').textContent = cScheduled;
    document.getElementById('count-all-good').textContent = cAllGood;
    // "Action needed" reads as an alert whenever anything is in it.
    document.getElementById('gc-tab-action').classList.toggle('alert', cAction > 0);

    const subs = filteredSubs();
    const empty = document.getElementById('empty');
    const tableWrap = document.getElementById('gc-table-wrap');
    const cards = document.getElementById('gc-cards');
    const countEl = document.getElementById('result-count');
    if (countEl) countEl.textContent = `${subs.length} customer${subs.length === 1 ? '' : 's'}`;

    if (subs.length === 0) {
      empty.hidden = false;
      tableWrap.hidden = true;
      cards.innerHTML = '';
      return;
    }
    empty.hidden = true;
    tableWrap.hidden = false;

    // Desktop table
    const tbody = document.getElementById('gc-tbody');
    tbody.innerHTML = subs.map(sub => rowHTML(sub)).join('');
    // Mobile cards
    cards.innerHTML = subs.map(sub => cardHTML(sub)).join('');

    // Wire up click handlers
    document.querySelectorAll('[data-sub-id]').forEach(el => {
      el.addEventListener('click', () => showDetail(el.dataset.subId));
    });
  }

  function planLabel(plan) {
    return plan === 'semi_annual' ? 'Semi-Annual' : (plan === 'annual' ? 'Annual' : plan);
  }
  // Florida DBA naming — mirrors backend lib/branding.js. In Florida the company
  // operates as "S.E. Bates Electric" (trademark settlement); elsewhere it's
  // "Bates Electric." Conditional on the customer's install-address state only.
  function isFlorida(state) {
    if (!state) return false;
    const s = String(state).trim().toLowerCase();
    return s === 'fl' || s === 'florida';
  }
  function companyName(state) {
    return isFlorida(state) ? 'S.E. Bates Electric' : 'Bates Electric';
  }
  function genClassLabel(c) {
    return ({
      air_cooled: 'Air Cooled',
      liquid_22_38: 'Liquid 22-45 KW',
      liquid_48_150: 'Liquid 48-150 KW',
    })[c] || c;
  }
  // Shared quote-safe escaper from ui-dialogs.js (loaded just before this
  // script) — one implementation for every page instead of per-file copies.
  const escapeHtml = window.BatesUI.escapeHtml;

  // ---- Display formatting (render-time only) --------------------------------
  // Stored values are NEVER rewritten — these shape names/cities/phones for the
  // customer list, the detail modal, and the Jonas work-order packet only. The
  // Contact & Address edit form keeps showing the raw stored values.

  // Title-case a name or city, but ONLY when the stored value is ALL-CAPS or
  // all-lowercase (clearly untyped case). Mixed-case values pass through as
  // typed, so deliberately-cased names ("McDonald", "DiSalvo") are never
  // mangled; a simple Mc- fix covers the common case when we do transform.
  function fmtNameCase(s) {
    const v = String(s == null ? '' : s).trim();
    const letters = v.replace(/[^A-Za-z]/g, '');
    if (!letters) return v;
    const allCaps = letters === letters.toUpperCase();
    const allLower = letters === letters.toLowerCase();
    if (!allCaps && !allLower) return v;
    return v.toLowerCase()
      .replace(/(^|[\s\-'.])([a-z])/g, (m, sep, ch) => sep + ch.toUpperCase())
      .replace(/\bMc([a-z])/g, (m, ch) => 'Mc' + ch.toUpperCase());
  }

  // Phone: +1XXXXXXXXXX or a bare 10-digit number renders as (XXX) XXX-XXXX.
  // Anything else (extensions, letters, international) renders as stored.
  function fmtPhoneDisplay(s) {
    const v = String(s == null ? '' : s).trim();
    if (!v || !/^[+()\-.\s\d]+$/.test(v)) return v;
    const digits = v.replace(/\D/g, '');
    const ten = digits.length === 10 ? digits
      : (digits.length === 11 && digits[0] === '1' ? digits.slice(1) : null);
    if (!ten) return v;
    return '(' + ten.slice(0, 3) + ') ' + ten.slice(3, 6) + '-' + ten.slice(6);
  }

  function fmtDate(dateStr) {
    if (!dateStr) return '—';
    return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }
  // Appointment date+time (absolute instant stored as timestamptz) -> local display.
  // Legacy fallback only — booked visits display via fmtAppt (date + arrival window).
  function fmtDateTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  }
  // Booked appointment -> "Jul 21, 2026 · 8:00–10:00 AM arrival" when the
  // visit carries an arrival window (the whole app speaks windows, never a
  // bare clock time); legacy visits without one fall back to the stored time.
  function fmtAppt(iso, windowCode) {
    const w = iso && window.BatesArrivalWindows.byCode[windowCode];
    if (!w) return fmtDateTime(iso);
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) + ' · ' + w.label + ' arrival';
  }
  // Absolute instant -> a date input value (YYYY-MM-DD) in the viewer's local tz.
  function toLocalDateInput(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }
  function dueLabel(sub) {
    const d = daysUntil(sub.next_visit_due);
    if (d === null) return '—';
    if (d < 0) return `${Math.abs(d)} day${Math.abs(d) === 1 ? '' : 's'} OVERDUE`;
    if (d === 0) return 'Today';
    if (d === 1) return 'Tomorrow';
    if (d <= 14) return `In ${d} days`;
    return fmtDate(sub.next_visit_due);
  }

  // Inline flags under the customer name — every pending action stays visible
  // in the full list even when a higher-priority state owns the badge column
  // (and everything actionable is one click from here via the row -> modal).
  const flagIcon = (paths) => `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
  const FLAG_ICONS = {
    warn: flagIcon('<path d="M12 3 2.5 20h19L12 3z"/><path d="M12 9.5V14"/>'),
    money: flagIcon('<path d="M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>'),
    calendar: flagIcon('<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 2v4M16 2v4"/>'),
    file: flagIcon('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>'),
    check: flagIcon('<rect x="4" y="4" width="16" height="16" rx="2"/><path d="m8.5 12 2.5 2.5 5-5.5"/>'),
  };
  function rowFlags(sub) {
    const a = att(sub);
    const money = (c) => '$' + ((c || 0) / 100).toFixed(2);
    const out = [];
    const flag = (cls, ico, label) => out.push(`<span class="gc-flag ${cls}">${FLAG_ICONS[ico]}${escapeHtml(label)}</span>`);
    if (hasFailedPayment(sub)) flag('f-danger', 'warn', 'Payment failed');
    const pt = performedTotalCents(sub);
    if (pt > 0) flag('f-money', 'money', `${money(pt)} to charge`);
    if (a.pending_prefs && sub.status !== 'canceled') {
      const booked = !!(sub.open_visit && sub.open_visit.appointment_at);
      flag('f-info', 'calendar', booked ? 'Reschedule requested' : 'Times proposed');
    }
    if (apptPassed(sub.open_visit) && sub.status !== 'canceled') flag('f-info', 'check', 'Appt passed');
    if (!sub.work_order_created_at && (sub.status === 'active' || sub.status === 'past_due')) flag('f-warn', 'file', 'Work order not created');
    return out.length ? `<div>${out.join('')}</div>` : '';
  }

  function stateBadge(st) {
    return `<span class="badge ${st.badge[0]}">${escapeHtml(st.badge[1])}</span>`;
  }

  function rowHTML(sub) {
    const st = lifecycleState(sub);
    const danger = st.key === 'payment_failed' || st.key === 'overdue' || st.key === 'incomplete';
    const cust = sub.customer || {};
    const fleet = sub.fleet_monitoring ? '<span class="chip" title="Fleet Monitoring enabled">FM</span>' : '';
    return `
      <tr class="gc-row ${danger ? 'overdue' : ''}" data-sub-id="${sub.id}">
        <td>
          <div class="gc-customer-name">${escapeHtml(fmtNameCase(cust.name))}</div>
          <div class="gc-customer-meta">${escapeHtml(fmtNameCase(cust.install_city))}, ${escapeHtml(cust.install_state)} · ${escapeHtml(fmtPhoneDisplay(cust.phone))}</div>
          ${rowFlags(sub)}
        </td>
        <td class="gc-gen-info">
          ${escapeHtml(genClassLabel(sub.gen_class))}<br>
          <span class="gc-customer-meta">${escapeHtml(sub.gen_model || 'Model n/a')}</span>
        </td>
        <td>${escapeHtml(planLabel(sub.plan))} ${fleet}</td>
        <td>${dueLabel(sub)}</td>
        <td>${stateBadge(st)}</td>
      </tr>
    `;
  }

  function cardHTML(sub) {
    const st = lifecycleState(sub);
    const danger = st.key === 'payment_failed' || st.key === 'overdue' || st.key === 'incomplete';
    const cust = sub.customer || {};
    return `
      <div class="gc-card ${danger ? 'overdue' : ''}" data-sub-id="${sub.id}">
        <div class="gc-card-header">
          <div>
            <div class="gc-card-name">${escapeHtml(fmtNameCase(cust.name))}</div>
            <div class="gc-card-meta">${escapeHtml(fmtNameCase(cust.install_city))} · ${escapeHtml(genClassLabel(sub.gen_class))} · ${escapeHtml(planLabel(sub.plan))}</div>
            ${rowFlags(sub)}
          </div>
          ${stateBadge(st)}
        </div>
        <div class="gc-card-due ${danger ? 'overdue' : ''}">Due: ${dueLabel(sub)}</div>
      </div>
    `;
  }

  // ----------------------------------------------------------------
  // NEEDS ATTENTION queue — the default landing view. One card per thing
  // Amy must do, severity-tiered, each with the ONE button that does it.
  // Buttons route through the EXISTING flows/endpoints (chargePerformedAddons,
  // sendPortalLink, the detail modal) — no parallel action paths, so every
  // money action keeps its existing confirm step. Computed in one pass over
  // the same list payload the Customers view uses; the Stripe billing
  // snapshot only ADDS renewal/card cards when it loads.
  // ----------------------------------------------------------------

  const attIcon = (paths) => `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
  const ATT_ICONS = {
    alert: attIcon('<path d="M12 3 2.5 20h19L12 3z"/><path d="M12 9.5V14"/><circle cx="12" cy="17" r="0.5" fill="currentColor"/>'),
    dollar: attIcon('<path d="M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>'),
    calendar: attIcon('<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 2v4M16 2v4"/>'),
    clock: attIcon('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
    file: attIcon('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M9 13h6M9 17h6"/>'),
    card: attIcon('<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/>'),
    refresh: attIcon('<path d="M21 12a9 9 0 1 1-2.6-6.4L21 8"/><path d="M21 3v5h-5"/>'),
    checksquare: attIcon('<rect x="4" y="4" width="16" height="16" rx="2"/><path d="m8.5 12 2.5 2.5 5-5.5"/>'),
    userminus: attIcon('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M17 11h6"/>'),
    wrench: attIcon('<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>'),
  };
  const TIER_ORDER = ['critical', 'money', 'action', 'upcoming'];
  const TIER_META = {
    critical: { label: 'Urgent' },
    money: { label: 'Money to collect' },
    action: { label: 'Waiting on you' },
    upcoming: { label: 'Coming up' },
  };

  // Cards are valid through the last day of their expiry month.
  function daysUntilCardExpiry(card) {
    if (!card || !card.exp_month || !card.exp_year) return null;
    const lastDay = new Date(card.exp_year, card.exp_month, 0);
    lastDay.setHours(0, 0, 0, 0);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return Math.floor((lastDay - today) / 86400000);
  }
  function cardBrandLabel(card) {
    const b = (card && card.brand) || '';
    return b ? b.charAt(0).toUpperCase() + b.slice(1) : 'Card';
  }
  function customerLink(sub) {
    return `<span class="gc-acust" data-att-open="${sub.id}">${escapeHtml(fmtNameCase((sub.customer || {}).name) || 'Customer')}</span>`;
  }

  // One pass over allSubs -> the prioritized card list. Titles and action
  // labels are static strings (entities OK, inserted raw); every dynamic
  // value inside desc goes through escapeHtml.
  function computeAttentionItems() {
    const items = [];
    const money = (c) => '$' + ((c || 0) / 100).toFixed(2);
    for (const sub of allSubs) {
      const a = att(sub);
      const d = daysUntil(sub.next_visit_due);
      const ov = sub.open_visit;
      const booked = !!(ov && ov.appointment_at);
      const bs = (billingSnapshot && sub.stripe_subscription_id) ? billingSnapshot[sub.stripe_subscription_id] : null;
      const card = bs && bs.card;
      const cardExpDays = daysUntilCardExpiry(card);

      // CRITICAL — a payment already failed (renewal past-due / declined items)
      if (hasFailedPayment(sub)) {
        const failedBits = []
          .concat((a.failed_addons || []).map((x) => `${addonLabel(x.addon_type)} (${money(x.amount_cents)})`))
          .concat((a.failed_charges || []).map((x) => `${x.description || 'charge'} (${money(x.amount_cents)})`));
        const what = [];
        if (sub.status === 'past_due') what.push('their renewal charge was declined');
        if (failedBits.length) what.push(`declined: ${failedBits.join(', ')}`);
        const cardBit = (card && cardExpDays !== null && cardExpDays < 0)
          ? ` Card on file expired ${card.exp_month}/${card.exp_year}.`
          : ' The card may need updating.';
        items.push({
          tier: 'critical', cls: 'c-danger', icon: 'alert', sub, sort: -1000,
          title: 'Payment failed',
          desc: `${customerLink(sub)} &mdash; ${escapeHtml(what.join('; ') || 'a charge was declined')}.${cardBit}`,
          action: { kind: 'cardlink', label: 'Send card-update link' },
        });
      } else if (sub.status === 'active' && card && cardExpDays !== null && cardExpDays < 0) {
        // CRITICAL — card already expired; the next charge WILL fail
        items.push({
          tier: 'critical', cls: 'c-danger', icon: 'card', sub, sort: -999,
          title: 'Card on file expired',
          desc: `${customerLink(sub)} &mdash; ${escapeHtml(cardBrandLabel(card))} &bull;&bull;${escapeHtml(card.last4 || '')} expired ${card.exp_month}/${card.exp_year}. The next charge will fail.`,
          action: { kind: 'cardlink', label: 'Send card-update link' },
        });
      }

      // CRITICAL — visit overdue and nothing booked (most overdue first)
      if (sub.status === 'active' && d !== null && d < 0 && !booked) {
        items.push({
          tier: 'critical', cls: 'c-danger', icon: 'clock', sub, sort: d,
          title: 'Visit overdue',
          desc: `${customerLink(sub)} &mdash; visit was due ${escapeHtml(fmtDate(sub.next_visit_due))} (${Math.abs(d)} day${Math.abs(d) === 1 ? '' : 's'} ago). Nothing is booked.`,
          action: { kind: 'visits', label: 'Schedule visit' },
        });
      }

      // MONEY — performed add-ons not yet charged (largest total first)
      const pt = performedTotalCents(sub);
      if (pt > 0) {
        const list = (a.performed_addons || [])
          .map((x) => `${addonLabel(x.addon_type)} (${money(x.amount_cents)})`).join(', ');
        const canCharge = !userPerms || userPerms.billing_actions !== false;
        items.push({
          tier: 'money', cls: 'c-money', icon: 'dollar', sub, sort: -pt,
          title: 'Add-ons performed &mdash; not yet charged',
          desc: `${customerLink(sub)} &mdash; ${escapeHtml(list)}. <b>${money(pt)}</b> ready to charge.`,
          action: canCharge
            ? { kind: 'charge', label: `Charge ${money(pt)}` }
            : { kind: 'addons', label: 'View add-ons' },
        });
      }

      // ACTION — customer proposed visit times (oldest request first)
      if (a.pending_prefs && sub.status !== 'canceled') {
        const p = a.pending_prefs;
        const slots = (Array.isArray(p.slots) ? p.slots : [])
          .map((s) => `${fmtDate(s.date)} ${escapeHtml(window.BatesArrivalWindows.label(s.window))}`.trim()).join(' &middot; ');
        items.push({
          tier: 'action', cls: 'c-info', icon: 'calendar', sub, sort: Date.parse(p.created_at || '') || 0,
          title: booked ? 'Reschedule requested' : 'Visit times proposed',
          desc: slots
            ? `${customerLink(sub)} proposed <i>${slots}</i>${p.note ? ` &mdash; &ldquo;${escapeHtml(p.note)}&rdquo;` : ''}. Confirm one.`
            : `${customerLink(sub)} asked for a different time${p.note ? ` &mdash; &ldquo;${escapeHtml(p.note)}&rdquo;` : ''}. Rebook with them.`,
          action: { kind: 'visits', label: 'Review &amp; book' },
        });
      }

      // Appointment date passed but the visit was never marked complete. Two
      // very different situations hide in that state, so the card branches:
      // a tech WAS dispatched -> the visit probably happened, just confirm it
      // (action tier). No tech was EVER assigned -> the job almost certainly
      // didn't happen — a missed appointment the customer was expecting.
      // That's critical: ranked with the overdue items (above them in the
      // group, below payment failures) and routed straight to the assign
      // picker so Amy dispatches + rebooks from one place.
      if (sub.status !== 'canceled' && apptPassed(ov)) {
        if (ov.assigned_tech_id) {
          items.push({
            tier: 'action', cls: 'c-info', icon: 'checksquare', sub, sort: Date.parse(ov.appointment_at) || 0,
            title: 'Appointment passed &mdash; confirm completion',
            desc: `${customerLink(sub)} &mdash; appointment was ${escapeHtml(fmtAppt(ov.appointment_at, ov.arrival_window))}. If the visit happened, mark it complete so the next cycle starts.`,
            action: { kind: 'visits', label: 'Mark complete' },
          });
        } else {
          items.push({
            tier: 'critical', cls: 'c-danger', icon: 'wrench', sub,
            sort: -900 + (daysUntil(toLocalDateInput(ov.appointment_at)) || 0),
            title: 'Passed &mdash; no tech was assigned',
            desc: `${customerLink(sub)} &mdash; appointment was ${escapeHtml(fmtAppt(ov.appointment_at, ov.arrival_window))} and no tech was ever dispatched. The job likely didn&rsquo;t happen &mdash; assign a tech and rebook.`,
            action: { kind: 'visits', label: 'Assign a tech' },
          });
        }
      }

      // ACTION — visit needs a tech dispatched: booked (upcoming) or due soon,
      // with nobody assigned. Far-future tentative visits (a new signup whose
      // first visit is months out) stay quiet — no date pressure, no card.
      // A booked-but-PASSED appointment is owned by the passed-appointment
      // branch above (critical "Passed — no tech was assigned" when nobody was
      // dispatched), never this card — one card per visit. Within ~2 days of
      // the appointment this one jumps to the top of its tier (and goes red).
      if ((sub.status === 'active' || sub.status === 'past_due')
          && ov && ov.status !== 'canceled' && !ov.assigned_tech_id) {
        if (booked && !apptPassed(ov)) {
          const apptDays = daysUntil(toLocalDateInput(ov.appointment_at));
          const imminent = apptDays !== null && apptDays <= 2;
          items.push({
            tier: 'action', cls: imminent ? 'c-danger' : 'c-warn', icon: 'wrench', sub,
            sort: imminent ? -900 + apptDays : (Date.parse(ov.appointment_at) || 0),
            title: 'No tech assigned',
            desc: `${customerLink(sub)} &mdash; booked for ${escapeHtml(fmtAppt(ov.appointment_at, ov.arrival_window))} with no tech assigned.`,
            action: { kind: 'visits', label: 'Assign a tech' },
          });
        } else if (!booked && d !== null && d >= 0 && d <= DUE_SOON_DAYS) {
          items.push({
            tier: 'action', cls: 'c-warn', icon: 'wrench', sub,
            sort: Date.parse((ov.scheduled_date || sub.next_visit_due) + 'T00:00:00') || 0,
            title: 'No tech assigned',
            desc: `${customerLink(sub)} &mdash; visit due ${escapeHtml(fmtDate(sub.next_visit_due))} with no tech assigned.`,
            action: { kind: 'visits', label: 'Assign a tech' },
          });
        }
      }

      // ACTION — new signup, Jonas work order not created yet
      if ((sub.status === 'active' || sub.status === 'past_due') && !sub.work_order_created_at) {
        items.push({
          tier: 'action', cls: 'c-warn', icon: 'file', sub, sort: Date.parse(sub.created_at || '') || 0,
          title: 'New signup &mdash; create Jonas work order',
          desc: `${customerLink(sub)} signed up ${escapeHtml(fmtDate(sub.signup_date))}. WO not created yet.`,
          action: { kind: 'handoff', label: 'Open work order' },
        });
      }

      // ACTION — signup payment never completed
      if (sub.status === 'incomplete') {
        items.push({
          tier: 'action', cls: 'c-danger', icon: 'alert', sub, sort: -1,
          title: 'Signup incomplete',
          desc: `${customerLink(sub)} &mdash; signup payment didn&rsquo;t finish. Check Stripe or reach out to the customer.`,
          action: { kind: 'open', label: 'Open customer' },
        });
      }

      // ACTION — cancellation scheduled; a call might save them
      if (sub.status === 'canceled' && sub.service_through && daysUntil(sub.service_through) >= 0) {
        items.push({
          tier: 'action', cls: 'c-info', icon: 'userminus', sub, sort: daysUntil(sub.service_through),
          title: 'Cancellation scheduled',
          desc: `${customerLink(sub)} &mdash; service runs through ${escapeHtml(fmtDate(sub.service_through))}, then ends. A quick call might save them.`,
          action: { kind: 'open', label: 'Open customer' },
        });
      }

      // ACTION — data gap: active but no due-date target
      if (sub.status === 'active' && d === null) {
        items.push({
          tier: 'action', cls: 'c-warn', icon: 'alert', sub, sort: 1e12,
          title: 'No next-due date set',
          desc: `${customerLink(sub)} has no &ldquo;next due&rdquo; target, so due-soon tracking can&rsquo;t work. Set one in Plan &amp; Billing.`,
          action: { kind: 'plan', label: 'Set due date' },
        });
      }

      // UPCOMING — visit due inside the soft window, nothing booked
      if (sub.status === 'active' && d !== null && d >= 0 && d <= DUE_SOON_DAYS && !booked) {
        items.push({
          tier: 'upcoming', cls: 'c-warn', icon: 'calendar', sub, sort: d,
          title: `Visit due ${d === 0 ? 'today' : `in ${d} day${d === 1 ? '' : 's'}`}`,
          desc: `${customerLink(sub)} &mdash; due ${escapeHtml(fmtDate(sub.next_visit_due))}. Nothing booked yet.`,
          action: { kind: 'visits', label: 'Schedule visit' },
        });
      }

      // UPCOMING — renewal inside 30 days (reach-out prompt; needs the snapshot)
      if (sub.status === 'active' && bs && bs.period_end && !bs.cancel_at_period_end) {
        const rd = daysUntil(bs.period_end);
        if (rd !== null && rd >= 0 && rd <= RENEWAL_SOON_DAYS) {
          const amtCents = sub.annual_price_cents
            ? (sub.plan === 'semi_annual' ? Math.round(sub.annual_price_cents / 2) : sub.annual_price_cents)
            : null;
          items.push({
            tier: 'upcoming', cls: 'c-warn', icon: 'refresh', sub, sort: 100 + rd,
            title: `Renews ${fmtDate(bs.period_end)}`,
            desc: `${customerLink(sub)}${amtCents ? ` &mdash; ${money(amtCents)} auto-charges` : ' &mdash; renews'} ${rd === 0 ? 'today' : `in ${rd} day${rd === 1 ? '' : 's'}`}. Good moment for a check-in.`,
            action: { kind: 'open', label: 'Open customer' },
          });
        }
      }

      // UPCOMING — card expiring soon (not yet expired, nothing failed yet)
      if (sub.status === 'active' && !hasFailedPayment(sub)
          && card && cardExpDays !== null && cardExpDays >= 0 && cardExpDays <= CARD_EXPIRING_DAYS) {
        items.push({
          tier: 'upcoming', cls: 'c-warn', icon: 'card', sub, sort: 200 + cardExpDays,
          title: 'Card expiring soon',
          desc: `${customerLink(sub)} &mdash; ${escapeHtml(cardBrandLabel(card))} &bull;&bull;${escapeHtml(card.last4 || '')} expires ${card.exp_month}/${card.exp_year}.`,
          action: { kind: 'cardlink', label: 'Send card-update link' },
        });
      }
    }
    items.sort((x, y) => (TIER_ORDER.indexOf(x.tier) - TIER_ORDER.indexOf(y.tier)) || (x.sort - y.sort));
    items.forEach((it, i) => { it.idx = i; });
    return items;
  }

  let attentionItems = [];

  function attCardHTML(item) {
    return `<div class="gc-action ${item.cls}">
      <div class="gc-ai">${ATT_ICONS[item.icon] || ATT_ICONS.alert}</div>
      <div class="gc-abody">
        <div class="gc-at">${item.title}</div>
        <div class="gc-ad">${item.desc}</div>
      </div>
      <button type="button" class="btn btn-sm gc-btn-solid" data-att-idx="${item.idx}">${item.action.label}</button>
    </div>`;
  }

  function runAttentionAction(item) {
    if (!item) return;
    const sub = item.sub;
    const kind = item.action.kind;
    if (kind === 'charge') return chargePerformedAddons(sub.id, (sub.customer || {}).id, att(sub).performed_addons || []);
    if (kind === 'cardlink') return sendPortalLink(sub.id);
    if (kind === 'visits') return showDetail(sub.id, 'visits');
    if (kind === 'handoff') return showDetail(sub.id, 'handoff');
    if (kind === 'addons') return showDetail(sub.id, 'addons');
    if (kind === 'plan') return showDetail(sub.id, 'plan');
    return showDetail(sub.id);
  }

  function renderAttention() {
    const listEl = document.getElementById('gc-att-list');
    const emptyEl = document.getElementById('gc-att-empty');
    const summaryEl = document.getElementById('gc-att-summary');
    const noteEl = document.getElementById('gc-att-note');
    if (!listEl || !subsLoaded) return; // keep the skeleton until real data lands

    attentionItems = computeAttentionItems();
    const activeCount = allSubs.filter((s) => s.status === 'active' || s.status === 'past_due').length;
    const nowCount = attentionItems.filter((i) => i.tier !== 'upcoming').length;
    const upCount = attentionItems.length - nowCount;

    const parts = [];
    parts.push(nowCount
      ? `<b>${nowCount} item${nowCount === 1 ? '' : 's'} need${nowCount === 1 ? 's' : ''} you</b>`
      : 'Nothing needs you right now');
    if (upCount) parts.push(`${upCount} coming up`);
    parts.push(`${activeCount} active customer${activeCount === 1 ? '' : 's'}`);
    if (summaryEl) summaryEl.innerHTML = parts.join(' &middot; ');

    // Renewal + card checks ride the Stripe snapshot; say so when it's down
    // instead of silently showing less.
    if (noteEl) {
      noteEl.hidden = !snapshotUnavailable;
      if (snapshotUnavailable) noteEl.textContent = 'Renewal and card checks are unavailable right now (Stripe unreachable) \u2014 showing everything else.';
    }

    if (!attentionItems.length) {
      listEl.innerHTML = '';
      if (emptyEl) {
        emptyEl.hidden = false;
        const sb = document.getElementById('gc-att-empty-sub');
        if (sb) sb.textContent = `${activeCount} active customer${activeCount === 1 ? '' : 's'} \u2014 all resting quietly.`;
      }
      return;
    }
    if (emptyEl) emptyEl.hidden = true;

    let html = '';
    for (const tier of TIER_ORDER) {
      const group = attentionItems.filter((i) => i.tier === tier);
      if (!group.length) continue;
      html += `<div class="gc-att-group-h ${tier === 'critical' ? 'g-critical' : ''}">${TIER_META[tier].label} <span class="count">${group.length}</span></div>`;
      html += group.map(attCardHTML).join('');
    }
    listEl.innerHTML = html;

    // Customer names open the modal; each card's button runs its one action.
    listEl.querySelectorAll('[data-att-open]').forEach((el) => {
      el.addEventListener('click', () => showDetail(el.dataset.attOpen));
    });
    listEl.querySelectorAll('[data-att-idx]').forEach((btn) => {
      btn.addEventListener('click', () => runAttentionAction(attentionItems[parseInt(btn.dataset.attIdx, 10)]));
    });
  }

  // ---- Detail modal ----
  // ----------------------------------------------------------------
  // Customer detail modal (v2: card-based layout, lazy-loaded Stripe data)
  // ----------------------------------------------------------------

  function renderInitialSkeleton() {
    return [
      `<div class="gc-card"><span class="gc-skeleton gc-skeleton-line gc-skeleton-text-lg"></span><span class="gc-skeleton gc-skeleton-line gc-skeleton-text-md"></span><span class="gc-skeleton gc-skeleton-line gc-skeleton-text-sm"></span></div>`,
      `<div class="gc-card"><span class="gc-skeleton gc-skeleton-line gc-skeleton-text-lg"></span><span class="gc-skeleton gc-skeleton-line gc-skeleton-text-md"></span></div>`,
    ].join('');
  }

  function statusPill(status) {
    const s = status || 'active';
    // Stripe subscription statuses -> v3 badge intents (raw status stays visible).
    const m = ({
      active: 'badge-ok',
      trialing: 'badge-ok',
      past_due: 'badge-warn',
      incomplete: 'badge-warn',
      unpaid: 'badge-danger',
      canceled: 'badge-neutral',
      incomplete_expired: 'badge-neutral',
      paused: 'badge-neutral',
    })[s] || 'badge-neutral';
    return `<span class="badge ${m}">${escapeHtml(s)}</span>`;
  }

  function renderHeaderBar(customer, subscription) {
    const phone = fmtPhoneDisplay(customer.phone) || '';
    const email = customer.email || '';
    const stripeId = subscription.stripe_customer_id;
    const stripeLink = stripeId
      ? `<a href="https://dashboard.stripe.com/customers/${encodeURIComponent(stripeId)}" target="_blank" rel="noopener noreferrer">Open in Stripe <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="vertical-align:-3px;"><line x1="7" y1="17" x2="17" y2="7"/><polyline points="8 7 17 7 17 16"/></svg></a>`
      : '';
    const contactBits = [
      phone ? `<span>${escapeHtml(phone)}</span>` : '',
      email ? `<span>&middot;</span><span>${escapeHtml(email)}</span>` : '',
    ].filter(Boolean).join('');
    return `
      <div style="margin-bottom: 16px;">
        <div class="gc-modal-header">${statusPill(subscription.status)}</div>
        <div class="gc-modal-subhead">
          ${contactBits}
          ${stripeLink ? `<span style="margin-left:auto;">${stripeLink}</span>` : ''}
        </div>
      </div>`;
  }

  // Read view of the Contact & Address info (swapped in/out of #gc-contact-region
  // when Amy toggles Edit). The internal-note editor lives outside this region so
  // an in-progress note isn't lost when entering edit mode.
  function renderContactRead(customer) {
    const addrLine = [customer.install_address, fmtNameCase(customer.install_city), customer.install_state, customer.install_zip].filter(Boolean).join(', ');
    const fl = isFlorida(customer.install_state);
    // Florida customers operate under the S.E. Bates Electric DBA — surface it so
    // Amy/Ally use the correct legal name on Jonas work orders + AR invoices.
    const flBadge = '<span class="chip chip-warn">FL &middot; S.E. Bates Electric</span>';
    const operatingRow = fl
      ? `<div class="gc-card-row"><span class="gc-meta-label">Operating as</span><span class="gc-meta-value">${flBadge}</span></div>`
      : '';
    return `
      <h3 class="gc-card-h"><span>Contact &amp; Address</span><button type="button" class="btn btn-ghost btn-sm" id="gc-contact-edit-btn">Edit</button></h3>
      <div class="gc-card-row"><span class="gc-meta-label">Name</span><span class="gc-meta-value">${escapeHtml(fmtNameCase(customer.name)) || '&mdash;'}</span></div>
      <div class="gc-card-row"><span class="gc-meta-label">Phone</span><span class="gc-meta-value">${escapeHtml(fmtPhoneDisplay(customer.phone)) || '&mdash;'}</span></div>
      <div class="gc-card-row"><span class="gc-meta-label">Email</span><span class="gc-meta-value">${escapeHtml(customer.email) || '&mdash;'}</span></div>
      <div class="gc-card-row"><span class="gc-meta-label">Install address</span><span class="gc-meta-value">${escapeHtml(addrLine) || '&mdash;'}</span></div>
      ${operatingRow}`;
  }

  // US-state dropdown for the edit form; preserves a legacy non-code value if one
  // is stored, so editing another field can't silently wipe it.
  function stateSelectHtml(selected) {
    const sel = (selected || '').trim().toUpperCase();
    const known = US_STATES.includes(sel);
    const placeholder = !sel ? `<option value="" selected>&mdash; Select &mdash;</option>` : '';
    const legacy = (!known && sel) ? `<option value="${escapeHtml(sel)}" selected>${escapeHtml(sel)} (current)</option>` : '';
    const opts = US_STATES.map(code => `<option value="${code}"${code === sel ? ' selected' : ''}>${code}</option>`).join('');
    return `<select id="gc-edit-state" class="gc-edit-input">${placeholder}${legacy}${opts}</select>`;
  }

  // Edit form for Contact & Address. Name/phone/email + install address parts;
  // State is the clean 2-letter dropdown. Card stays out of here on purpose —
  // the customer updates their card via the secure "Send Card-Update Link".
  function renderContactEdit(customer) {
    return `
      <h3 class="gc-card-h"><span>Edit Contact &amp; Address</span></h3>
      <div class="gc-edit-grid">
        <label class="gc-edit-field gc-edit-full"><span>Full name</span><input type="text" id="gc-edit-name" class="gc-edit-input" value="${escapeHtml(customer.name || '')}"></label>
        <label class="gc-edit-field"><span>Phone</span><input type="tel" id="gc-edit-phone" class="gc-edit-input" value="${escapeHtml(customer.phone || '')}"></label>
        <label class="gc-edit-field"><span>Email</span><input type="email" id="gc-edit-email" class="gc-edit-input" value="${escapeHtml(customer.email || '')}"></label>
        <label class="gc-edit-field gc-edit-full"><span>Street address</span><input type="text" id="gc-edit-addr" class="gc-edit-input" value="${escapeHtml(customer.install_address || '')}"></label>
        <label class="gc-edit-field"><span>City</span><input type="text" id="gc-edit-city" class="gc-edit-input" value="${escapeHtml(customer.install_city || '')}"></label>
        <label class="gc-edit-field"><span>State</span>${stateSelectHtml(customer.install_state)}</label>
        <label class="gc-edit-field"><span>Zip</span><input type="text" id="gc-edit-zip" class="gc-edit-input" value="${escapeHtml(customer.install_zip || '')}"></label>
      </div>
      <div class="gc-edit-error" id="gc-contact-error" hidden></div>
      <div class="gc-note-editor-actions">
        <button type="button" class="btn btn-secondary btn-sm" id="gc-contact-cancel-btn">Cancel</button>
        <button type="button" class="btn btn-primary btn-sm" id="gc-contact-save-btn">Save changes</button>
      </div>`;
  }

  // SMS consent block (Phase 1) — lives OUTSIDE gc-contact-region so the
  // contact edit/cancel re-render can't wipe it. Shows the consent state and
  // the office "record consent" control (verbal opt-in path); the backend
  // writes the legal consent row (source 'office').
  function renderSmsConsentBlock(customer, smsConsent) {
    const hasPhone = !!(customer.phone && String(customer.phone).trim());
    let stateHtml;
    let action = '';
    if (smsConsent && smsConsent.opted_in && !smsConsent.opted_out) {
      stateHtml = `<span class="chip chip-ok">Opted in</span> <span class="gc-meta-label">via ${escapeHtml(smsConsent.source || '?')}${smsConsent.opted_in_at ? ' &middot; ' + fmtDate(String(smsConsent.opted_in_at).slice(0, 10)) : ''}</span>`;
      action = `<button type="button" class="btn btn-ghost btn-sm" id="gc-sms-consent-btn" data-optin="false">Record opt-out</button>`;
    } else if (smsConsent && smsConsent.opted_out) {
      stateHtml = `<span class="chip chip-warn">Opted out</span>${smsConsent.opted_out_at ? ` <span class="gc-meta-label">${fmtDate(String(smsConsent.opted_out_at).slice(0, 10))}</span>` : ''}`;
      action = hasPhone ? `<button type="button" class="btn btn-ghost btn-sm" id="gc-sms-consent-btn" data-optin="true">Record opt-in</button>` : '';
    } else {
      stateHtml = `<span class="gc-meta-label">Not opted in</span>`;
      action = hasPhone
        ? `<button type="button" class="btn btn-ghost btn-sm" id="gc-sms-consent-btn" data-optin="true">Record consent</button>`
        : `<span class="gc-meta-label">(no phone on file)</span>`;
    }
    return `<div class="gc-card-row"><span class="gc-meta-label">Appointment texts</span><span class="gc-meta-value" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">${stateHtml}${action}</span></div>`;
  }

  function renderContactCard(customer, smsConsent) {
    return `
      <div class="gc-card">
        <div id="gc-contact-region">${renderContactRead(customer)}</div>
        ${renderSmsConsentBlock(customer, smsConsent)}
        <div class="gc-note-editor">
          <span class="gc-meta-label" style="display:block;margin-bottom:6px;">Internal note (office only)</span>
          <textarea id="gc-customer-note" data-customer-id="${customer.id}" placeholder="Anything Amy or Brenda should know about this customer.">${escapeHtml(customer.notes || '')}</textarea>
          <div class="gc-note-editor-actions">
            <button class="btn btn-secondary btn-sm" id="gc-save-note-btn">Save note</button>
          </div>
        </div>
      </div>`;
  }

  function renderPlanCard(subscription, isCanceled) {
    const annual = subscription.annual_price_cents ? `$${(subscription.annual_price_cents/100).toFixed(2)}/yr` : '&mdash;';
    const lastVisitText = subscription.last_visit_date ? fmtDate(subscription.last_visit_date) : '&mdash; (none yet)';
    const accountActions = isCanceled ? '' : `
      <div class="gc-card-actions">
        <button class="btn btn-secondary btn-sm" id="gc-change-plan-btn" data-plan="${escapeHtml(subscription.plan)}" data-genclass="${escapeHtml(subscription.gen_class)}">Change plan</button>
        <button class="btn btn-secondary btn-sm" id="gc-change-tier-btn">Change tier</button>
        <span id="gc-fleet-action"></span>
        <button class="btn btn-secondary btn-sm" id="gc-resend-welcome-btn">Resend Welcome</button>
        <button class="btn btn-secondary btn-sm" id="gc-portal-btn">Send Card-Update Link</button>
      </div>`;
    return `
      <div class="gc-card" id="gc-card-plan">
        <h3 class="gc-card-h">Plan &amp; Billing</h3>
        <div class="gc-card-row"><span class="gc-meta-label">Plan</span><span class="gc-meta-value">${escapeHtml(planLabel(subscription.plan))}</span></div>
        <div id="gc-plan-pending" style="display:none;"></div>
        <div id="gc-generator-region">${renderGeneratorRead(subscription)}</div>
        <div class="gc-card-row"><span class="gc-meta-label">Fleet Monitoring</span><span class="gc-meta-value" id="gc-fleet-value">${subscription.fleet_monitoring ? 'Yes' : 'No'}</span></div>
        <div class="gc-card-row"><span class="gc-meta-label">Annual price</span><span class="gc-meta-value">${annual}</span></div>
        <div class="gc-card-row" id="gc-renews-row" style="display:none;"><span class="gc-meta-label">Renews at</span><span class="gc-meta-value" id="gc-renews-value"></span></div>
        <div class="gc-card-row"><span class="gc-meta-label">Signed up</span><span class="gc-meta-value">${fmtDate(subscription.signup_date)}</span></div>
        <div class="gc-card-row"><span class="gc-meta-label">Last visit</span><span class="gc-meta-value">${lastVisitText}</span></div>
        <div class="gc-card-row" style="display:block;">
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;">
            <span class="gc-meta-label">Next due (target)</span>
            <span class="gc-meta-value" style="display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap;">
              <input type="date" id="gc-next-visit-input" value="${subscription.next_visit_due || ''}" style="padding:4px 8px;border:1px solid var(--line);border-radius:4px;font-size:0.85rem;font-family:inherit;" />
              <button class="btn btn-secondary btn-sm" id="gc-next-visit-save">Save</button>
            </span>
          </div>
          <div class="gc-meta-label" style="margin-top:4px;opacity:0.8;font-size:0.78rem;">Auto-set from the plan cadence. Book the actual appointment in Service Visits below.</div>
        </div>
        <div class="gc-card-row" id="gc-payment-method-row"><span class="gc-meta-label">Payment method</span><span class="gc-meta-value" id="gc-payment-method-value"><span class="gc-skeleton gc-skeleton-line gc-skeleton-text-md"></span></span></div>
        <div class="gc-card-row" id="gc-lifetime-row"><span class="gc-meta-label">Lifetime billed</span><span class="gc-meta-value" id="gc-lifetime-value"><span class="gc-skeleton gc-skeleton-line gc-skeleton-text-sm"></span></span></div>
        ${accountActions}
      </div>`;
  }

  function fmtStamp(ts) {
    if (!ts) return '';
    return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  // Plain-text work-order packet — the fields Brenda keys into Jonas as an internal
  // record (customers are not invoiced). Copy with "Copy packet". openVisit adds
  // the booked appointment (date + arrival window) when there is one.
  function buildPacketText(sub, pendingAddons, actualChargeCents, openVisit) {
    const c = sub.customer || {};
    const addr = [c.install_address, fmtNameCase(c.install_city), c.install_state, c.install_zip].filter(Boolean).join(', ');
    const cadence = sub.plan === 'semi_annual' ? 'every 6 months' : (sub.plan === 'annual' ? 'annually' : '');
    const annual = sub.annual_price_cents || 0;
    const renewal = sub.plan === 'semi_annual' ? Math.round(annual / 2) : annual;
    // Actual first charge (promo-aware) when known; else fall back to plan price.
    const signupCharge = (typeof actualChargeCents === 'number') ? actualChargeCents : renewal;
    const money = (cents) => '$' + ((cents || 0) / 100).toFixed(2);
    const addons = (sub.fleet_monitoring ? [ADDON_LABELS.fleet_monitoring] : [])
      .concat((pendingAddons || []).filter(a => a.status !== 'canceled').map(a => addonLabel(a.addon_type)));
    const gen = [genClassLabel(sub.gen_class), sub.gen_model, sub.gen_serial && ('s/n ' + sub.gen_serial)].filter(Boolean).join(' • ');
    const lines = [
      ['Work order #', sub.work_order_number || '—'],
      ['Bill under', companyName(c.install_state) + (isFlorida(c.install_state) ? ' (Florida DBA)' : '')],
      ['Customer', fmtNameCase(c.name) || ''],
      ['Phone', fmtPhoneDisplay(c.phone) || ''],
      ['Email', c.email || ''],
      ['Install address', addr],
      ['Plan', planLabel(sub.plan) + (cadence ? ` (billed ${cadence})` : '')],
      ['Generator', gen],
      ['Add-ons', addons.length ? addons.join(', ') : 'None'],
      ['Signed up', sub.signup_date ? fmtDate(sub.signup_date) : ''],
      ['Amount charged at signup', money(signupCharge)],
      ['Renews at', money(renewal) + (cadence ? ` ${cadence}` : '')],
    ];
    // Booked appointment rides along for Brenda's record (window, not a time).
    if (openVisit && openVisit.appointment_at) {
      lines.push(['Appointment', fmtAppt(openVisit.appointment_at, openVisit.arrival_window)]);
    }
    return lines.map(([k, v]) => `${k}: ${v}`).join('\n');
  }

  // Internal Jonas work-order record. Brenda keys the work order into Jonas for
  // internal records; customers are NOT invoiced (their document of record is the
  // branded receipt). Distinct from the Service-Visit card.
  function renderHandoffCard(subscription, pendingAddons, openVisit) {
    const woAt = subscription.work_order_created_at;
    const woBy = subscription.work_order_created_by;
    const woNum = subscription.work_order_number;
    const packet = escapeHtml(buildPacketText(subscription, pendingAddons, undefined, openVisit));

    const check = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>';
    const dot = (done, n) =>
      `<span style="display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:50%;font-size:0.72rem;font-weight:700;flex-shrink:0;background:${done ? 'var(--ok)' : 'var(--neutral-bg)'};color:${done ? 'var(--ink-inverse)' : 'var(--ink-3)'};">${done ? check : n}</span>`;
    const stepRow = (n, label, done, value) => `
      <div class="gc-card-row" style="align-items:center;">
        <span class="gc-meta-label" style="display:flex;align-items:center;gap:8px;">${dot(done, n)}${label}</span>
        <span class="gc-meta-value" style="text-align:right;">${value}</span>
      </div>`;

    const woValue = woAt
      ? `<span style="font-weight:400;color:var(--ink-2);">${woNum ? '<strong style="color:var(--ink);">WO# ' + escapeHtml(woNum) + '</strong> &middot; ' : ''}${fmtStamp(woAt)}${woBy ? ' &middot; ' + escapeHtml(woBy) : ''}</span> <button class="btn btn-ghost btn-sm" id="gc-wo-undo-btn">Undo</button>`
      : `<span style="display:inline-flex;align-items:center;gap:6px;justify-content:flex-end;flex-wrap:wrap;">
          <input type="text" id="gc-wo-number" class="gc-wo-input" style="width:120px;flex:0 0 auto;font-size:0.8rem;padding:5px 8px;" placeholder="Jonas WO #" autocomplete="off" />
          <button class="btn btn-primary btn-sm" id="gc-wo-created-btn">Mark work order created</button>
        </span>
        <div id="gc-wo-validation" style="display:none;color:var(--danger);font-size:0.75rem;margin-top:4px;text-align:right;">Enter the Jonas work-order number first.</div>`;

    return `
      <div class="gc-card" id="gc-card-handoff">
        <h3 class="gc-card-h">Jonas Work Order <span class="gc-card-h-count">internal record</span></h3>
        ${stepRow('1', 'Signed up', true, `<span style="font-weight:400;color:var(--ink-2);">${fmtDate(subscription.signup_date)}</span>`)}
        ${stepRow('2', 'Work order created', !!woAt, woValue)}
        <div class="gc-note-editor">
          <span class="gc-meta-label" style="display:block;margin-bottom:6px;">Work-order packet &mdash; for keying into Jonas</span>
          <textarea id="gc-packet" class="gc-packet" readonly rows="9">${packet}</textarea>
          <div class="gc-note-editor-actions">
            <button class="btn btn-secondary btn-sm" id="gc-copy-packet-btn">Copy packet</button>
          </div>
        </div>
      </div>`;
  }

  // Customer-proposed appointment slots (dashboard v2): date + arrival window
  // from the SAME shared list the booking control uses, so "Use this slot"
  // maps 1:1 to what Amy books. Slots submitted before the arrival-window
  // change carry legacy AM/PM — shown with their old labels and mapped to the
  // closest window on use. Booking marks the pending preferences used
  // (server-side).
  const LEGACY_PREF_WINDOW_MAP = { AM: '8-10', PM: '12-2' };

  function renderVisitPrefsBox(pref) {
    // Two shapes: structured slots (customer picked dates) or note-only (a
    // "request a different time" reschedule — free text, no slots).
    const slots = (pref && Array.isArray(pref.slots)) ? pref.slots : [];
    if (!pref || (!slots.length && !pref.note)) return '';
    const slotRows = slots.map((s, i) => {
      const label = `${fmtDate(s.date)} · ${window.BatesArrivalWindows.label(s.window)}`;
      return `<div style="display:flex;align-items:center;gap:8px;margin-top:4px;">
        <span style="font-size:0.85rem;">${i + 1}) ${escapeHtml(label)}</span>
        <button class="btn btn-secondary btn-sm" data-use-slot data-date="${escapeHtml(s.date)}" data-window="${escapeHtml(LEGACY_PREF_WINDOW_MAP[s.window] || s.window || '')}" style="padding:2px 10px;font-size:0.75rem;">Use this slot</button>
      </div>`;
    }).join('');
    return `<div style="margin-top:8px;background:var(--info-bg);border:1px solid color-mix(in srgb, var(--info) 35%, transparent);border-radius:6px;padding:8px 10px;">
      <div class="gc-meta-label" style="color:var(--info);">${slots.length ? 'Customer prefers' : 'Customer asked for a different time'}${pref.created_at ? ` (sent ${fmtDate(String(pref.created_at).slice(0, 10))})` : ''}:</div>
      ${slotRows}
      ${pref.note ? `<div class="gc-meta-label" style="margin-top:6px;white-space:pre-line;">${slots.length ? 'Note: ' : ''}${escapeHtml(pref.note)}</div>` : ''}
      <div class="gc-meta-label" style="margin-top:6px;opacity:0.8;">${slots.length ? '&quot;Use this slot&quot; fills the booking controls below &mdash; booking' : 'Booking a new window below'} sends the customer their confirmation email and clears this.</div>
    </div>`;
  }

  // Three clear states per visit: Needs scheduling (due, not booked) / Scheduled
  // (booked date + arrival window) / Completed. The plan-driven DUE date stays
  // separate and is shown as context.
  // Human line for the latest outbound text on a visit (from visit_sms in the
  // detail payload). Status names come from lib/sms.js's message log.
  function smsStatusLine(m) {
    if (!m) return null;
    const when = m.created_at ? ' ' + fmtDate(String(m.created_at).slice(0, 10)) : '';
    switch (m.status) {
      case 'sent': return 'Confirmation text sent' + when;
      case 'disabled': return 'Text logged, not sent (texting is off)' + when;
      case 'no_consent': return 'Text not sent &mdash; customer has not opted in';
      case 'opted_out': return 'Text not sent &mdash; customer opted out';
      case 'quiet_hours': return 'Text skipped (outside 8am&ndash;9pm)' + when;
      case 'stale': return 'Text dropped &mdash; appointment passed before it could send' + when;
      case 'failed': return 'Text failed to send' + when;
      default: return null;
    }
  }

  function renderVisitsCard(visits, subscription, visitPreferences, visitSms) {
    visitSms = visitSms || {};
    const prefByVisit = {};
    (visitPreferences || []).forEach((p) => {
      // Rows arrive newest-first; keep the newest pending row per visit.
      if (!prefByVisit[p.visit_id]) prefByVisit[p.visit_id] = p;
    });
    // The prefs box only renders on OPEN visit rows — a pending pref whose
    // visit already completed (it rolled before booking) would never show.
    // Surface the newest such pref on the current open visit instead; booking
    // that visit marks every pending pref on the sub used, so it clears.
    const isOpenVisit = (v) => !(v.completed_date || v.status === 'completed');
    const openIdSet = new Set((visits || []).filter(isOpenVisit).map((v) => v.id));
    const firstOpen = (visits || []).filter(isOpenVisit)
      .sort((a, b) => String(a.appointment_at || a.scheduled_date || '').localeCompare(String(b.appointment_at || b.scheduled_date || '')))[0];
    if (firstOpen && !prefByVisit[firstOpen.id]) {
      const orphan = (visitPreferences || []).find((p) => !openIdSet.has(p.visit_id));
      if (orphan) prefByVisit[firstOpen.id] = orphan;
    }
    const dueCtx = (v) => {
      const d = (subscription && subscription.next_visit_due) || v.scheduled_date || null;
      return d ? fmtDate(d) : null;
    };
    const rows = (visits || []).map(v => {
      const completed = !!(v.completed_date || v.status === 'completed');
      const scheduled = !completed && !!v.appointment_at;

      let badge;
      if (completed) {
        badge = `<span class="badge badge-neutral">Completed${v.completed_date ? ' ' + fmtDate(v.completed_date) : ''}</span>`;
      } else if (scheduled) {
        badge = `<span class="badge badge-ok">Scheduled &middot; ${escapeHtml(fmtAppt(v.appointment_at, v.arrival_window))}</span>`;
        // Customer replied Y to the confirmation text (SMS Phase 1).
        if (v.sms_confirmed_at) badge += ` <span class="badge badge-ok">Confirmed by text</span>`;
      } else {
        badge = `<span class="badge badge-warn">Needs scheduling</span>`;
      }

      // Audit trail (who/when), like the Jonas hand-off stamps.
      const audit = [];
      if (v.scheduled_by && (scheduled || completed)) {
        audit.push(`Booked by ${escapeHtml(v.scheduled_by)}${v.scheduled_at ? ' on ' + fmtDate(String(v.scheduled_at).slice(0, 10)) : ''}`);
      }
      if (completed && v.completed_by) audit.push(`Completed by ${escapeHtml(v.completed_by)}`);

      // Dispatch: who's assigned (shown for open visits; completed shows completed_by).
      if (!completed && v.assigned_tech_id) audit.push(`Assigned: ${escapeHtml(techName(v.assigned_tech_id))}`);

      // Latest outbound text for this visit (sent / logged-not-sent / blocked).
      const smsLine = !completed && smsStatusLine(visitSms[v.id]);
      if (smsLine) audit.push(smsLine);

      let actions = '';
      if (!completed) {
        // Booking = date + arrival window (how Amy schedules), from the shared
        // window list. A legacy visit booked with an exact time pre-fills its
        // date but makes her pick a window to rebook.
        const dateVal = v.appointment_at ? toLocalDateInput(v.appointment_at) : '';
        const winOptions = `<option value="" disabled${v.arrival_window ? '' : ' selected'}>Arrival window&hellip;</option>`
          + window.BatesArrivalWindows.WINDOWS.map((w) =>
              `<option value="${escapeHtml(w.code)}"${w.code === v.arrival_window ? ' selected' : ''}>${escapeHtml(w.label)}</option>`).join('');
        actions = `
          <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:8px;">
            <label class="gc-meta-label" style="display:flex;align-items:center;gap:5px;">Assign tech:
              <select class="gc-assign-select" data-assign-visit="${v.id}" style="padding:4px 8px;border:1px solid var(--line);border-radius:4px;font-size:0.85rem;font-family:inherit;">${techOptions(v.assigned_tech_id)}</select>
            </label>
          </div>
          ${renderVisitPrefsBox(prefByVisit[v.id])}
          <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:6px;">
            <input type="date" class="gc-appt-date" data-visit="${v.id}" value="${dateVal}" aria-label="Appointment date" style="padding:4px 8px;border:1px solid var(--line);border-radius:4px;font-size:0.85rem;font-family:inherit;" />
            <select class="gc-appt-window" data-visit="${v.id}" aria-label="Arrival window" style="padding:4px 8px;border:1px solid var(--line);border-radius:4px;font-size:0.85rem;font-family:inherit;">${winOptions}</select>
            <button class="btn btn-secondary btn-sm" data-schedule-visit="${v.id}">${scheduled ? 'Reschedule' : 'Book appointment'}</button>
            <button class="btn btn-primary btn-sm" data-complete-visit="${v.id}">Mark complete</button>
          </div>`;
      }
      // What the tech CHECKED OFF on a completed visit (service checklist).
      // Only checked items are listed — an unchecked item is simply absent
      // (same rule as the customer dashboard). Legacy visits have none.
      const services = (completed && v.completed_services && v.completed_services.length)
        ? `<div class="gc-meta-label" style="margin-top:4px;">Services completed (${v.completed_services.length}): ${v.completed_services.map(escapeHtml).join(' &middot; ')}</div>`
        : '';

      // Notes: customer-visible (on completed) + internal (office/tech only).
      const noteLines = [];
      if (completed && v.notes) noteLines.push(`<div class="gc-meta-label" style="margin-top:4px;">Customer note: ${escapeHtml(v.notes)}</div>`);
      if (v.internal_note) noteLines.push(`<div class="gc-meta-label" style="margin-top:4px;background:var(--warn-bg);border:1px solid color-mix(in srgb, var(--warn) 35%, transparent);border-radius:6px;padding:5px 8px;color:var(--warn);">Internal: ${escapeHtml(v.internal_note)}</div>`);

      const due = !completed ? dueCtx(v) : null;
      return `<div class="gc-card-row" style="display:block;">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;flex-wrap:wrap;">
          <div>
            <div class="gc-meta-value">${escapeHtml(v.visit_type === 'regular_service' ? 'Regular service' : 'On-demand')}</div>
            ${due ? `<div class="gc-meta-label" style="margin-top:2px;">Due ${escapeHtml(due)}</div>` : ''}
            ${audit.length ? `<div class="gc-meta-label" style="margin-top:2px;opacity:0.85;">${audit.join(' &middot; ')}</div>` : ''}
          </div>
          <div style="flex-shrink:0;">${badge}</div>
        </div>
        ${services}${noteLines.join('')}
        <!-- TECH-DASHBOARD PHASE 2 (additive): tech photo strip mounts here; filled by the loader in showDetail -->
        <div class="gc-visit-photos" data-visit-photos="${v.id}" style="margin-top:6px;"></div>
        ${actions}
      </div>`;
    }).join('');
    const body = rows || `<div class="gc-meta-label" style="padding:6px 0;">No visits on record.</div>`;
    return `<div class="gc-card" id="gc-card-visits"><h3 class="gc-card-h">Service Visits<span class="gc-card-h-count">(${(visits || []).length})</span></h3>${body}</div>`;
  }

  // Recurring add-on types available for a gen class (mirrors the catalog flags;
  // coolant top-off is liquid-cooled only).
  const RECURRING_ADDONS = [
    { type: 'exterior_wash', liquidOnly: false },
    { type: 'ats_outage_combined', liquidOnly: false },
    { type: 'coolant_topoff', liquidOnly: true },
  ];
  function availableRecurringTypes(genClass) {
    const liquid = genClass === 'liquid_22_38' || genClass === 'liquid_48_150';
    return RECURRING_ADDONS.filter(r => !r.liquidOnly || liquid).map(r => r.type);
  }

  // Empty placeholder tying a charged add-on/adhoc row to its invoice.
  // loadStripeData fills it ("&middot; on the Jul 20 invoice ($86.00)") once
  // recent_invoices land, matching by the shared PaymentIntent id — so a
  // bundled cart charge (add-on + custom billed as ONE payment) visibly points
  // at the one invoice instead of reading as separate money. Rows with no
  // match (older data, invoice outside the recent 5) keep an empty span.
  // Also carries the row's amount + notes-derived refund so loadStripeData can
  // reconcile the row's refund state against the invoice charge's ACTUAL
  // amount_refunded (an invoice-level refund never annotates row notes).
  function invoiceTagSpan(paymentIntentId, amountCents, refundedCents) {
    return paymentIntentId ? `<span class="gc-meta-label" data-invoice-tag-pi="${escapeHtml(paymentIntentId)}" data-row-amount="${amountCents || 0}" data-row-refunded="${refundedCents || 0}"></span>` : '';
  }

  // Shown in place of the Refund control on a charged row with no stored
  // PaymentIntent: the refund endpoint can't target the payment, so a button
  // could only error. Rare after the PI backfill script — a row stays
  // unlinkable only when its invoice item is gone in Stripe or the data was
  // entered by hand.
  const UNLINKED_REFUND_NOTE = `<span class="gc-meta-label">Not linked to a payment &mdash; refund in Stripe</span>`;

  // Render one add-on row (used for the current cycle + history).
  function addonRowHtml(a) {
    const amtStr = a.amount_cents ? `$${(a.amount_cents/100).toFixed(2)}` : '';
    const label = escapeHtml(addonLabel(a.addon_type));
    let chip = '', action = '';
    if (a.status === 'pending') {
      chip = `<span class="badge badge-warn">Pending</span>`;
      action = `<div style="display:flex;gap:6px;flex-wrap:wrap;">
        <button class="btn btn-primary btn-sm" data-mark-performed="${a.id}" data-amount="${amtStr}" data-label="${label}">Mark Performed</button>
        <button class="btn btn-secondary btn-sm gc-btn-icon" data-remove-addon="${a.id}" data-label="${label}" title="Remove" aria-label="Remove"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
      </div>`;
    } else if (a.status === 'performed') {
      chip = `<span class="badge badge-warn">Performed &middot; unbilled</span>`;
      action = `<button class="btn btn-ghost btn-sm" data-unmark="${a.id}">Undo</button>`;
    } else if (a.status === 'charged') {
      const refunded = parseTotalRefundedCents(a.notes);
      const chargedOn = a.date_charged ? ' &middot; ' + escapeHtml(fmtDate(a.date_charged)) : '';
      if (refunded >= a.amount_cents) {
        chip = `<span class="badge badge-neutral">Refunded</span>`;
      } else if (refunded > 0) {
        chip = `<span class="badge badge-warn">Partial refund: $${(refunded/100).toFixed(2)}</span>`;
        action = `<button class="btn btn-ghost btn-sm" data-refund-addon="${a.id}" data-amount="${a.amount_cents}" data-refunded="${refunded}" data-label="${label}">Refund more</button>`;
      } else {
        chip = `<span class="badge badge-ok">Charged ${amtStr}${chargedOn}</span>`;
        action = `<button class="btn btn-ghost btn-sm" data-refund-addon="${a.id}" data-amount="${a.amount_cents}" data-refunded="0" data-label="${label}">Refund</button>`;
      }
      if (!a.stripe_payment_intent_id && action) action = UNLINKED_REFUND_NOTE;
      chip += invoiceTagSpan(a.stripe_payment_intent_id, a.amount_cents, refunded);
    } else if (a.status === 'failed') {
      chip = `<span class="badge badge-danger">Failed</span>`;
      action = `<button class="btn btn-danger-soft btn-sm" data-mark-performed="${a.id}" data-amount="${amtStr}" data-label="${label}">Retry</button>`;
    } else {
      chip = `<span class="badge badge-neutral">${escapeHtml(a.status)}</span>`;
    }
    const visibleNotes = stripRefundLines(a.notes);
    const noteHtml = visibleNotes ? `<div style="color:var(--danger);font-size:0.78rem;margin-top:4px;">${escapeHtml(visibleNotes)}</div>` : '';
    return `<div class="gc-card-row">
      <div>
        <div class="gc-meta-value">${label} ${amtStr ? `<span style="color:var(--ink-2);font-weight:500;">&middot; ${amtStr}</span>` : ''}</div>
        <div style="margin-top:4px;">${chip}</div>
        ${noteHtml}
      </div>
      <div>${action}</div>
    </div>`;
  }

  // Status chip for a menu row (add-ons menu Phase 1 statuses).
  function menuStatusChip(m) {
    if (m.status === 'charged') return `<span class="badge" style="background:var(--ok);color:#fff;">Charged</span>`;
    if (m.status === 'performed') return `<span class="badge badge-ok">Performed &middot; unbilled</span>`;
    if (m.status === 'this_visit') return `<span class="badge badge-warn">This visit</span>`;
    if (m.status === 'every_visit') return `<span class="badge badge-info">Every visit</span>`;
    return `<span class="badge badge-neutral">Not in plan</span>`;
  }

  // One row of the complete add-on menu: label + price always visible, a
  // status chip, and the office actions for that status (the same endpoints
  // as before — add, standing toggle, mark performed, undo, remove, refund —
  // just presented on the menu).
  function menuRowHtml(m, subscription, rowByld, isCanceled) {
    const label = escapeHtml(m.label);
    const amtStr = `$${(m.amount_cents / 100).toFixed(2)}`;
    const isStanding = ((subscription && subscription.standing_addons) || []).includes(m.addon_type);
    const row = m.addon_id ? rowByld.get(m.addon_id) : null;

    const actions = [];
    if (isCanceled && m.status !== 'charged') {
      // Canceled subscription: nothing new can be added/performed; only
      // refunds on already-charged rows stay actionable.
    } else if (m.status === 'not_in_plan') {
      actions.push(`<button class="btn btn-secondary btn-sm" data-menu-add="${escapeHtml(m.addon_type)}" data-label="${label}" data-amount="${m.amount_cents}">Add this visit</button>`);
      if (m.recurring) actions.push(`<button class="btn btn-ghost btn-sm" data-standing-set="${escapeHtml(m.addon_type)}" data-on="1" data-label="${label}" data-amount="${m.amount_cents}">Every visit</button>`);
    } else if (m.status === 'every_visit') {
      if (m.addon_id) actions.push(`<button class="btn btn-primary btn-sm" data-mark-performed="${m.addon_id}" data-amount="${amtStr}" data-label="${label}">Mark Performed</button>`);
      // Standing but not materialized on this cycle yet (enrolled mid-cycle):
      // let the office pull it onto the current visit so it can be performed.
      else actions.push(`<button class="btn btn-secondary btn-sm" data-menu-add="${escapeHtml(m.addon_type)}" data-label="${label}" data-amount="${m.amount_cents}">Add this visit</button>`);
      actions.push(`<button class="btn btn-ghost btn-sm" data-standing-set="${escapeHtml(m.addon_type)}" data-on="0" data-label="${label}">Stop every visit</button>`);
    } else if (m.status === 'this_visit') {
      actions.push(`<button class="btn btn-primary btn-sm" data-mark-performed="${m.addon_id}" data-amount="${amtStr}" data-label="${label}">Mark Performed</button>`);
      actions.push(`<button class="btn btn-secondary btn-sm gc-btn-icon" data-remove-addon="${m.addon_id}" data-label="${label}" title="Remove" aria-label="Remove"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>`);
    } else if (m.status === 'performed') {
      actions.push(`<button class="btn btn-ghost btn-sm" data-unmark="${m.addon_id}">Undo</button>`);
    } else if (m.status === 'charged' && row) {
      const refunded = parseTotalRefundedCents(row.notes);
      if (refunded >= row.amount_cents) {
        // fully refunded — chip below says so, no action
      } else if (!row.stripe_payment_intent_id) {
        actions.push(UNLINKED_REFUND_NOTE);
      } else {
        actions.push(`<button class="btn btn-ghost btn-sm" data-refund-addon="${row.id}" data-amount="${row.amount_cents}" data-refunded="${refunded}" data-label="${label}">${refunded > 0 ? 'Refund more' : 'Refund'}</button>`);
      }
    }

    // Chip: charged rows show refund state; standing types performed/charged
    // this cycle keep a small "Every visit" tag so the office still sees (and
    // can stop) the enrollment.
    let chip = menuStatusChip(m);
    if (m.status === 'charged' && row) {
      const refunded = parseTotalRefundedCents(row.notes);
      const chargedOn = row.date_charged ? ' &middot; ' + escapeHtml(fmtDate(row.date_charged)) : '';
      if (refunded >= row.amount_cents) chip = `<span class="badge badge-neutral">Refunded</span>`;
      else if (refunded > 0) chip = `<span class="badge badge-warn">Partial refund: $${(refunded/100).toFixed(2)}</span>`;
      else chip = `<span class="badge" style="background:var(--ok);color:#fff;">Charged${chargedOn}</span>`;
      chip += invoiceTagSpan(row.stripe_payment_intent_id, row.amount_cents, refunded);
    }
    const standingTag = (isStanding && (m.status === 'performed' || m.status === 'charged'))
      ? ` <span class="badge badge-info">Every visit</span>`
      : '';
    const performedMeta = (m.status === 'performed' && (m.date_performed || m.performed_by))
      ? `<div class="gc-meta-label" style="margin-top:3px;">${m.date_performed ? 'Performed ' + escapeHtml(fmtDate(m.date_performed)) : ''}${m.performed_by ? ' by ' + escapeHtml(m.performed_by) : ''}</div>`
      : '';
    const visibleNotes = row ? stripRefundLines(row.notes) : '';
    const noteHtml = visibleNotes ? `<div style="color:var(--danger);font-size:0.78rem;margin-top:4px;">${escapeHtml(visibleNotes)}</div>` : '';

    return `<div class="gc-card-row">
      <div>
        <div class="gc-meta-value">${label} <span style="color:var(--ink-2);font-weight:500;">&middot; ${amtStr}</span></div>
        <div style="margin-top:4px;">${chip}${standingTag}</div>
        ${performedMeta}
        ${noteHtml}
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end;">${actions.join('')}</div>
    </div>`;
  }

  function renderAddonsCard(pending_addons, isCanceled, openVisitId, subscription, addonMenu) {
    const visible = (pending_addons || []).filter(a => a.status !== 'canceled');
    // Current cycle = add-ons on the open visit; history = charged add-ons from
    // prior cycles (kept, shown collapsed). Active add-ons always sit in current.
    const history = visible.filter(a => a.status === 'charged' && (!openVisitId || a.service_visit_id !== openVisitId));
    const histSet = new Set(history);
    const current = visible.filter(a => !histSet.has(a));

    // ---- The complete menu (add-ons menu Phase 1) ----
    // Every catalog add-on that fits this generator class, price + status,
    // served by the backend (addon_menu). Falls back to the legacy sparse
    // card only if the API predates the menu (deploy skew).
    let bodyRows, headerAction, headerCount;
    if (Array.isArray(addonMenu)) {
      const rowByld = new Map(visible.map(a => [a.id, a]));
      const active = addonMenu.filter(m => m.status !== 'not_in_plan');
      headerCount = active.length;
      headerAction = '';
      const failed = current.filter(a => a.status === 'failed');
      bodyRows = addonMenu.map(m => menuRowHtml(m, subscription, rowByld, isCanceled)).join('')
        + (failed.length
          ? `<div class="gc-meta-label" style="margin-top:8px;color:var(--danger);">Failed charges</div>` + failed.map(addonRowHtml).join('')
          : '');
    } else {
      headerCount = current.length;
      headerAction = isCanceled ? '' : `<button class="btn btn-secondary btn-sm" id="gc-add-addon-btn">+ Add Add-on</button>`;
      bodyRows = current.length
        ? current.map(addonRowHtml).join('')
        : `<div class="gc-meta-label" style="padding:6px 0;">No add-ons this cycle${isCanceled ? '.' : ' &mdash; click "+ Add Add-on" to add one.'}</div>`;
    }
    const header = `<h3 class="gc-card-h"><span>Add-ons<span class="gc-card-h-count">(${headerCount})</span></span>${headerAction}</h3>`;

    // One combined "charge performed add-ons" action for the current visit.
    const performedUnbilled = current.filter(a => a.status === 'performed' && a.amount_cents > 0);
    const performedTotal = performedUnbilled.reduce((s, a) => s + a.amount_cents, 0);
    const batchBtn = (!isCanceled && performedUnbilled.length)
      ? `<div class="gc-card-row" style="justify-content:flex-end;border-top:1px solid var(--line);padding-top:10px;margin-top:4px;">
          <button class="btn btn-primary btn-sm" id="gc-charge-addons-btn">Charge performed add-ons ($${(performedTotal/100).toFixed(2)})</button>
        </div>`
      : '';

    // Standing add-ons checkbox editor — only for the legacy (menu-less)
    // render; the menu's per-row "Every visit"/"Stop every visit" replaces it.
    let standingHtml = '';
    if (!Array.isArray(addonMenu)) {
      const standing = new Set((subscription && subscription.standing_addons) || []);
      const recurringAvail = availableRecurringTypes(subscription && subscription.gen_class);
      standingHtml = (!isCanceled && recurringAvail.length)
        ? `<div style="border-top:1px solid var(--line);margin-top:10px;padding-top:8px;">
            <div class="gc-meta-label" style="margin-bottom:6px;">Standing add-ons <span style="opacity:0.75;font-weight:400;">&mdash; auto-return as Pending each visit</span></div>
            ${recurringAvail.map(t => `<label style="display:flex;align-items:center;gap:8px;padding:3px 0;font-size:0.88rem;cursor:pointer;">
              <input type="checkbox" class="gc-standing-cb" data-type="${escapeHtml(t)}"${standing.has(t) ? ' checked' : ''} />
              <span>${escapeHtml(addonLabel(t))}</span>
            </label>`).join('')}
          </div>`
        : '';
    }

    const historyHtml = history.length
      ? `<details style="border-top:1px solid var(--line);margin-top:10px;padding-top:8px;">
          <summary style="cursor:pointer;font-size:0.85rem;color:var(--ink-2);font-weight:600;">Past visits / history (${history.length})</summary>
          <div style="margin-top:6px;">${history.map(addonRowHtml).join('')}</div>
        </details>`
      : '';

    return `<div class="gc-card" id="gc-card-addons">${header}${bodyRows}${batchBtn}${standingHtml}${historyHtml}</div>`;
  }

  function renderChargesCard(adhoc_charges, isCanceled) {
    const visible = (adhoc_charges || []).filter(c => c.status !== 'canceled');
    const headerAction = isCanceled ? '' : `<button class="btn btn-secondary btn-sm" id="gc-add-charge-btn">+ Add Charge</button>`;
    const header = `<h3 class="gc-card-h"><span>Other Charges<span class="gc-card-h-count">(${visible.length})</span></span>${headerAction}</h3>`;
    if (visible.length === 0) {
      const empty = `<div class="gc-meta-label" style="padding:6px 0;">No ad-hoc charges. Use this for non-program work (parts, repairs, etc).</div>`;
      return `<div class="gc-card">${header}${empty}</div>`;
    }
    const rows = visible.map(c => {
      const amtStr = c.amount_cents ? `$${(c.amount_cents/100).toFixed(2)}` : '';
      const desc = escapeHtml(c.description);
      let chip = '', action = '';
      if (c.status === 'pending') {
        const label = c.billing_method === 'renewal' ? 'Pending &middot; bills at renewal' : 'Pending';
        chip = `<span class="badge badge-warn">${label}</span>`;
        action = `<button class="btn btn-secondary btn-sm gc-btn-icon" data-cancel-charge="${c.id}" data-desc="${desc}" title="Cancel" aria-label="Cancel"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>`;
      } else if (c.status === 'charged') {
        const refunded = parseTotalRefundedCents(c.notes);
        if (refunded >= c.amount_cents) {
          chip = `<span class="badge badge-neutral">Refunded</span>`;
        } else if (refunded > 0) {
          chip = `<span class="badge badge-warn">Charged &middot; partial refund $${(refunded/100).toFixed(2)}</span>`;
          action = `<button class="btn btn-ghost btn-sm" data-refund-charge="${c.id}" data-amount="${c.amount_cents}" data-refunded="${refunded}" data-desc="${desc}">Refund more</button>`;
        } else {
          chip = `<span class="badge badge-ok">${c.date_charged ? 'Charged ' + escapeHtml(c.date_charged) : 'Charged'}</span>`;
          action = `<button class="btn btn-ghost btn-sm" data-refund-charge="${c.id}" data-amount="${c.amount_cents}" data-refunded="0" data-desc="${desc}">Refund</button>`;
        }
        if (!c.stripe_payment_intent_id && action) action = UNLINKED_REFUND_NOTE;
        chip += invoiceTagSpan(c.stripe_payment_intent_id, c.amount_cents, refunded);
      } else if (c.status === 'failed') {
        chip = `<span class="badge badge-danger">Failed</span>`;
      } else {
        chip = `<span class="badge badge-neutral">${escapeHtml(c.status)}</span>`;
      }
      const visibleNotes = stripRefundLines(c.notes);
      const noteHtml = visibleNotes ? `<div style="color:var(--danger);font-size:0.78rem;margin-top:4px;">${escapeHtml(visibleNotes)}</div>` : '';
      return `<div class="gc-card-row">
        <div>
          <div class="gc-meta-value">${desc} ${amtStr ? `<span style="color:var(--ink-2);font-weight:500;">&middot; ${amtStr}</span>` : ''}</div>
          <div style="margin-top:4px;">${chip}</div>
          ${noteHtml}
        </div>
        <div>${action}</div>
      </div>`;
    }).join('');
    return `<div class="gc-card">${header}${rows}</div>`;
  }

  // Skeleton card; loadStripeData() replaces innerHTML once Stripe data lands.
  function renderInvoicesCard() {
    return `<div class="gc-card" id="gc-invoices-card">
      <h3 class="gc-card-h">Recent Invoices</h3>
      <div id="gc-invoices-body">
        <div class="gc-skeleton-card-row"><span class="gc-skeleton gc-skeleton-line gc-skeleton-text-md"></span><span class="gc-skeleton gc-skeleton-line gc-skeleton-text-sm"></span></div>
        <div class="gc-skeleton-card-row"><span class="gc-skeleton gc-skeleton-line gc-skeleton-text-md"></span><span class="gc-skeleton gc-skeleton-line gc-skeleton-text-sm"></span></div>
      </div>
    </div>`;
  }

  // Text message history (SMS Phase 1 follow-up, two-way since the SMS
  // thread work). SimpleTexting's UI only shows a conversation once the
  // customer REPLIES — outbound-only threads (opt-in confirmation, booking
  // confirmation, reminders, nudges) are invisible there. generator_sms_messages
  // has the complete record, so this card is the definitive "did they get
  // their confirmation?" answer — and, now, where the office answers a
  // customer's text (reply box at the bottom of the thread; consent rules
  // live in lib/sms.js and are only mirrored here for the operator's benefit).
  //
  // Both history cards (SMS + Email) are collapsed <details> by default — the
  // record was getting long. The whole point of these cards is spotting a
  // failure, so collapsing must never bury one: the loader stamps the count
  // AND, when the newest outbound message is in a failed/blocked state, its
  // status chip into the collapsed header (see historyHeaderStamp).
  // Skeleton body; loadSmsHistory() replaces innerHTML once the log lands.
  function renderHistoryDetails({ cardId, title, countId, flagId, bodyId }) {
    return `<details class="gc-card gc-history-details" id="${cardId}">
      <summary class="gc-history-summary">
        <h3 class="gc-card-h"><span><span class="gc-disclose" aria-hidden="true">&#9656;</span>${title}<span class="gc-card-h-count" id="${countId}"></span></span><span id="${flagId}"></span></h3>
      </summary>
      <div id="${bodyId}">
        <div class="gc-skeleton-card-row"><span class="gc-skeleton gc-skeleton-line gc-skeleton-text-md"></span><span class="gc-skeleton gc-skeleton-line gc-skeleton-text-sm"></span></div>
        <div class="gc-skeleton-card-row"><span class="gc-skeleton gc-skeleton-line gc-skeleton-text-md"></span><span class="gc-skeleton gc-skeleton-line gc-skeleton-text-sm"></span></div>
      </div>
    </details>`;
  }

  function renderSmsHistoryCard() {
    return renderHistoryDetails({
      cardId: 'gc-card-sms',
      title: 'Text Message History',
      countId: 'gc-sms-history-count',
      flagId: 'gc-sms-history-flag',
      bodyId: 'gc-sms-history-body',
    });
  }

  // Email send history (sql/033) — the email twin of the SMS card. Every send
  // attempt is logged by the backend mailer, and Brevo's delivery webhook
  // upgrades "Sent" to Delivered/Bounced/etc. This is how the office answers
  // "did the customer actually GET their appointment email?" — which matters
  // most exactly when SMS is blocked (no consent) and email is the only channel.
  function renderEmailHistoryCard() {
    return renderHistoryDetails({
      cardId: 'gc-card-email',
      title: 'Email History',
      countId: 'gc-email-history-count',
      flagId: 'gc-email-history-flag',
      bodyId: 'gc-email-history-body',
    });
  }

  // Stamp count + (when the newest message is a failure) its status chip into
  // a collapsed history header, so a "Not sent — no consent" or a bounce is
  // visible without expanding the card.
  function historyHeaderStamp({ countId, flagId, count, flagHtml }) {
    const countEl = document.getElementById(countId);
    if (countEl) countEl.textContent = `(${count})`;
    const flagEl = document.getElementById(flagId);
    if (flagEl) flagEl.innerHTML = flagHtml || '';
  }

  // Status chip per logged message. Statuses come from lib/sms.js's message
  // log (out: sent|failed|disabled|no_consent|opted_out|quiet_hours|
  // invalid_phone; in: received) — refused sends are logged too, so blocked
  // texts are visible here rather than silently missing.
  function smsHistoryChip(m) {
    if (m.direction === 'in') return '<span class="badge badge-ok">Reply</span>';
    switch (m.status) {
      case 'sent': return '<span class="badge badge-ok">Sent</span>';
      case 'failed': return '<span class="badge badge-danger">Failed</span>';
      case 'invalid_phone': return '<span class="badge badge-danger">Invalid phone</span>';
      case 'no_consent': return '<span class="badge badge-warn">Not sent &mdash; no consent</span>';
      case 'opted_out': return '<span class="badge badge-warn">Not sent &mdash; opted out</span>';
      case 'quiet_hours': return '<span class="badge badge-neutral">Skipped &mdash; quiet hours</span>';
      case 'stale': return '<span class="badge badge-neutral">Dropped &mdash; too late to send</span>';
      case 'disabled': return '<span class="badge badge-neutral">Logged &mdash; texting off</span>';
      default: return `<span class="badge badge-neutral">${escapeHtml(m.status || '')}</span>`;
    }
  }

  // Who sent an operator reply — the office member's name, else their email.
  function smsSenderLabel(m) {
    const p = m.sent_by;
    if (!p) return '';
    return fmtNameCase(p.full_name) || p.email || 'office';
  }

  // One bubble in the conversation. Inbound sits left, outbound right; every
  // outbound keeps its status chip so a refused send ("Not sent — no consent")
  // reads as a blocked bubble, never a delivered one. Bodies are
  // attacker-controllable free text from the inbound webhook — always escaped.
  function renderSmsBubble(m) {
    const inbound = m.direction === 'in';
    const visitTag = m.related_visit_id ? ` <span class="gc-sms-tag">visit</span>` : '';
    const sender = !inbound && m.sent_by
      ? ` <span>&middot; sent by ${escapeHtml(smsSenderLabel(m))}</span>`
      : '';
    // Failure reason (never the API token — lib/sms.js keeps it out of the log).
    const failDetail = (m.status === 'failed' || m.status === 'invalid_phone') && m.detail
      ? `<div class="gc-meta-label" style="margin-top:2px;color:var(--danger);">${escapeHtml(m.detail)}</div>`
      : '';
    const refused = !inbound && m.status !== 'sent';
    return `<div class="gc-sms-msg ${inbound ? 'gc-sms-in' : 'gc-sms-out'}${refused ? ' gc-sms-refused' : ''}">
      <div class="gc-sms-bubble">${escapeHtml(m.body || '')}</div>
      <div class="gc-sms-meta">
        <span>${escapeHtml(fmtDateTime(m.created_at))}</span>
        ${smsHistoryChip(m)}${visitTag}${sender}
      </div>
      ${failDetail}
    </div>`;
  }

  // Live character / segment count for the reply box. GSM-7 covers plain
  // ASCII plus a few accented letters (160 chars per single text, 153 per
  // part when split; ^{}\[~]|€ count double). Anything outside it — curly
  // quotes, emoji, an em dash — flips the whole message to UCS-2 (70 / 67).
  // Advisory only; the provider does the real segmentation.
  const GSM7_BASIC_RE = /^[\u0040\u00A3\u0024\u00A5\u00E8\u00E9\u00F9\u00EC\u00F2\u00C7\n\u00D8\u00F8\r\u00C5\u00E5\u0394_\u03A6\u0393\u039B\u03A9\u03A0\u03A8\u03A3\u0398\u039E\u00C6\u00E6\u00DF\u00C9 !"#\u00A4%&'()*+,\-./0-9:;<=>?\u00A1A-Z\u00C4\u00D6\u00D1\u00DC\u00A7\u00BFa-z\u00E4\u00F6\u00F1\u00FC\u00E0]$/;
  const GSM7_EXT_RE = /^[\^{}\\\[~\]|\u20AC]$/;
  function smsSegments(text) {
    const s = String(text || '');
    let units = 0;
    let gsm = true;
    for (const ch of s) {
      if (GSM7_BASIC_RE.test(ch)) units += 1;
      else if (GSM7_EXT_RE.test(ch)) units += 2;
      else { gsm = false; break; }
    }
    if (!gsm) {
      const len = s.length; // UTF-16 units, which is what UCS-2 counts
      return { chars: len, segments: len === 0 ? 0 : (len <= 70 ? 1 : Math.ceil(len / 67)), encoding: 'UCS-2' };
    }
    return { chars: s.length, segments: units === 0 ? 0 : (units <= 160 ? 1 : Math.ceil(units / 153)), encoding: 'GSM-7' };
  }

  // Reply box state comes from the thread endpoint's `reply` block (lib/sms.js
  // operatorReplyEligibility). A blocked box names WHICH rule blocked it —
  // "opted out" and "no consent + nothing recent from them" are different
  // problems with different fixes. This is for the operator's benefit only;
  // the backend enforces the same rules on every send regardless.
  function renderSmsReplyBox(reply) {
    if (!reply) return '';
    const days = reply.window_days || 30;
    const blocked = (chipText, why) => `<div class="gc-sms-reply gc-sms-reply-blocked" id="gc-sms-reply-box">
        <span class="chip chip-warn">${chipText}</span> <span class="gc-meta-label">${why}</span>
      </div>`;
    if (!reply.allowed) {
      switch (reply.reason) {
        case 'opted_out':
          return blocked('Opted out', 'This customer sent STOP. Texts can\'t be sent to this number &mdash; replies are off.');
        case 'invalid_phone':
          return blocked('No mobile number', 'No usable mobile number on file for this customer.');
        default:
          return blocked('No consent', `No text consent on file and no text from them in the last ${days} days. Record consent (above) to text them, or wait for them to text first.`);
      }
    }
    // Allowed, but a cold send (no recent text from them) outside 8am-9pm
    // Central would only be refused by quiet hours — don't offer it.
    if (reply.quiet_hours_now && !reply.recent_inbound) {
      return blocked('Quiet hours', `It's outside 8am&ndash;9pm Central and this customer hasn't texted in the last ${days} days, so a text now would be blocked. Try again after 8am.`);
    }
    const notes = [];
    if (reply.reason === 'recent_inbound') {
      notes.push(`<div class="gc-sms-note"><span class="chip chip-neutral">No consent on file</span> <span class="gc-meta-label">They texted first, so answering is allowed for ${days} days from their last text (${escapeHtml(fmtDateTime(reply.last_inbound_at))}).</span></div>`);
    }
    if (reply.quiet_hours_now) {
      notes.push(`<div class="gc-sms-note"><span class="chip chip-warn">Outside 8am&ndash;9pm Central</span> <span class="gc-meta-label">They texted recently, so a reply will send now anyway &mdash; you'll be asked to confirm.</span></div>`);
    }
    return `<div class="gc-sms-reply" id="gc-sms-reply-box">
      ${notes.join('')}
      <textarea id="gc-sms-reply-text" rows="3" maxlength="1000" placeholder="Type a reply\u2026" aria-label="Reply by text"></textarea>
      <div class="gc-sms-reply-actions">
        <span class="gc-meta-label" id="gc-sms-reply-count"></span>
        <button type="button" class="btn btn-primary btn-sm" id="gc-sms-reply-send" disabled>Send text</button>
      </div>
    </div>`;
  }

  function wireSmsReplyBox(scope, subId, customerId, reply) {
    const ta = scope.querySelector('#gc-sms-reply-text');
    const btn = scope.querySelector('#gc-sms-reply-send');
    const count = scope.querySelector('#gc-sms-reply-count');
    if (!ta || !btn) return;
    const update = () => {
      const s = smsSegments(ta.value);
      if (count) {
        count.textContent = `${s.chars} chars \u00B7 ${s.segments} segment${s.segments === 1 ? '' : 's'}${s.encoding === 'UCS-2' ? ' (unicode)' : ''}`;
      }
      btn.disabled = !ta.value.trim();
    };
    ta.addEventListener('input', update);
    update();
    btn.addEventListener('click', () => sendSmsReply(ta, btn, subId, customerId, reply));
  }

  // POST the reply, then reload the thread — the new row (sent, or refused
  // with its reason) shows up there like every other logged attempt.
  async function sendSmsReply(ta, btn, subId, customerId, reply) {
    const text = ta.value.trim();
    if (!text) return;
    if (reply && reply.quiet_hours_now) {
      const ok = await openConfirm({
        title: 'Send outside 8am\u20139pm Central?',
        message: 'This customer texted recently, so the reply will go out right now, outside normal texting hours. Send it?',
        confirmText: 'Send now',
      });
      if (!ok) return;
    }
    const label = btn.textContent;
    btn.disabled = true;
    ta.disabled = true;
    btn.textContent = 'Sending\u2026';
    try {
      const r = await BatesAuth.authFetch(`${API_BASE}/api/generator-care/customers/${customerId}/sms-reply`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: text }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      showStatus('Text sent.', 'success');
      ta.value = '';
      loadSmsHistory(subId, customerId); // the sent row joins the thread
    } catch (err) {
      // Keep what they typed: a blocked/failed attempt is logged and shows
      // on the next Refresh, but the draft must not vanish under them.
      console.error('[sms-reply] failed:', err);
      showStatus(err.message, 'error');
      btn.textContent = label;
      ta.disabled = false;
      btn.disabled = !ta.value.trim();
    }
  }

  // A newest-message state that warrants a warning chip in the COLLAPSED SMS
  // header. quiet_hours/disabled are expected states, not failures.
  function smsNeedsFlag(m) {
    return m && m.direction === 'out'
      && ['failed', 'invalid_phone', 'no_consent', 'opted_out'].includes(m.status);
  }

  // Email status chip: the send attempt ('Failed' means Brevo never took it),
  // upgraded by the delivery outcome from Brevo's webhook when we have one.
  // Plain 'Sent' = accepted by Brevo, no delivery event (yet or ever — the
  // webhook only covers sends after it was configured).
  function emailHistoryChip(m) {
    if (m.status === 'failed') return '<span class="badge badge-danger">Failed</span>';
    switch (m.delivery_status) {
      case 'delivered': return '<span class="badge badge-ok">Delivered</span>';
      case 'hard_bounce': return '<span class="badge badge-danger">Bounced</span>';
      case 'soft_bounce': return '<span class="badge badge-warn">Soft bounce</span>';
      case 'blocked': return '<span class="badge badge-danger">Blocked</span>';
      case 'spam': return '<span class="badge badge-danger">Marked spam</span>';
      case 'invalid_email': return '<span class="badge badge-danger">Invalid address</span>';
      case 'deferred': return '<span class="badge badge-neutral">Deferred</span>';
      case 'error': return '<span class="badge badge-warn">Delivery error</span>';
      default: return '<span class="badge badge-ok">Sent</span>';
    }
  }

  function emailNeedsFlag(m) {
    return !!m && (m.status === 'failed'
      || ['hard_bounce', 'blocked', 'spam', 'invalid_email'].includes(m.delivery_status));
  }

  function renderEmailHistoryRow(m) {
    const visitTag = m.related_visit_id
      ? ` <span class="gc-meta-label" style="border:1px solid var(--line);border-radius:4px;padding:0 5px;">visit</span>`
      : '';
    const kindTag = m.kind
      ? `<span class="gc-meta-label">${escapeHtml(m.kind)}</span>`
      : '';
    // Failure reason (send failure) or delivery detail (bounce reason). The
    // backend scrubs anything secret-shaped before it's stored.
    const detailText = (m.status === 'failed' && m.detail)
      || (emailNeedsFlag(m) && m.delivery_detail) || '';
    const failDetail = detailText
      ? `<div class="gc-meta-label" style="margin-top:2px;color:var(--danger);">${escapeHtml(detailText)}</div>`
      : '';
    return `<div class="gc-card-row" style="display:block;">
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
        <span class="gc-meta-value">${escapeHtml(fmtDateTime(m.created_at))}</span>
        ${kindTag}
        ${emailHistoryChip(m)}${visitTag}
      </div>
      <div style="margin-top:4px;font-size:0.83rem;color:var(--ink-2);overflow-wrap:anywhere;">${escapeHtml(m.subject || '(no subject)')} <span class="gc-meta-label">&mdash; to ${escapeHtml(m.to_email || 'unknown')}</span></div>
      ${failDetail}
    </div>`;
  }

  function renderDangerZone(isCanceled, subscription) {
    if (isCanceled) {
      // Stripe keeps the sub active until the period end even though we mark it
      // 'canceled'. Show the paid-through date so Amy doesn't tell a customer
      // their coverage already ended.
      const through = subscription && subscription.raw_metadata && subscription.raw_metadata.service_through;
      const throughLine = through
        ? `Customer keeps service through <strong>${fmtDate(through)}</strong>; auto-renewal is off.`
        : `Customer keeps service through their paid-through date; auto-renewal is off.`;
      return `<div class="gc-canceled-banner">
        <strong>This subscription is canceled.</strong> ${throughLine}
      </div>`;
    }
    return `<div class="gc-danger-zone">
      <span class="gc-danger-zone-text">Cancel ends the subscription at the period end. Customer keeps service through the paid-through date.</span>
      <button class="btn btn-danger btn-sm" id="gc-cancel-sub-btn">Cancel Subscription</button>
    </div>`;
  }

  // Remove the action buttons this member's flags don't cover (see /me
  // permissions). Convenience only — the backend 403s regardless. Called on
  // the detail body after each render pass (the invoices card arrives later,
  // from loadStripeData, so it gets its own pass).
  function stripDeniedActions(scope) {
    if (!userPerms || !scope) return;
    const drop = (sel) => scope.querySelectorAll(sel).forEach((el) => el.remove());
    if (!userPerms.refunds) {
      const cancelBtn = scope.querySelector('#gc-cancel-sub-btn');
      if (cancelBtn) (cancelBtn.closest('.gc-danger-zone') || cancelBtn).remove();
      drop('[data-refund-addon], [data-refund-charge], [data-refund-invoice]');
    }
    if (!userPerms.billing_actions) {
      drop('#gc-change-plan-btn, #gc-change-tier-btn, #gc-add-addon-btn, #gc-charge-addons-btn, #gc-add-charge-btn, [data-mark-performed], [data-remove-addon], [data-unmark], [data-cancel-charge], [data-menu-add], [data-standing-set]');
      scope.querySelectorAll('.gc-standing-cb').forEach((cb) => { cb.disabled = true; });
    }
    if (!userPerms.customer_edit) {
      drop('#gc-contact-edit-btn, #gc-generator-edit-btn, #gc-save-note-btn, #gc-next-visit-save, #gc-sms-consent-btn');
      const replyBox = scope.querySelector('#gc-sms-reply-box');
      if (replyBox) {
        replyBox.outerHTML = `<div class="gc-sms-reply gc-sms-reply-blocked"><span class="chip chip-neutral">Read only</span> <span class="gc-meta-label">Replying by text needs the customer-edit permission. Ask an administrator.</span></div>`;
      }
    }
    if (!userPerms.tech_manage) {
      scope.querySelectorAll('[data-assign-visit]').forEach((sel) => { sel.disabled = true; });
    }
  }

  // `focus` (optional): 'visits' | 'addons' | 'handoff' | 'plan' — scrolls the
  // matching card into view with a brief pulse. Used by Needs Attention cards
  // so each queue action lands exactly where the work happens.
  async function showDetail(id, focus) {
    const modal = document.getElementById('detailsModal');
    const title = document.getElementById('modal-title');
    const body = document.getElementById('modal-body');
    modal.hidden = false;
    title.textContent = 'Loading…';
    body.innerHTML = renderInitialSkeleton();
    // Clear last customer's card so a failed stripe-data load can't mislabel
    // this customer's refund dialog; loadStripeData repopulates it below.
    cardOnFile = null;

    try {
      const r = await BatesAuth.authFetch(`${API_BASE}/api/generator-care/subscriptions/${id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const { subscription, visits, pending_addons, adhoc_charges = [], addon_menu = null, visit_preferences = [], sms_consent = null, visit_sms = {} } = await r.json();
      const c = subscription.customer || {};
      title.textContent = fmtNameCase(c.name) || 'Customer';
      const isCanceled = subscription.status === 'canceled';

      // Current visit cycle = the earliest open (not-completed, not-canceled)
      // regular-service visit; its add-ons are the actionable current-cycle set,
      // others are history.
      const openVisit = (visits || [])
        .filter(v => v.visit_type === 'regular_service' && !v.completed_date && v.status !== 'canceled')
        .sort((a, b) => String(a.scheduled_date || '').localeCompare(String(b.scheduled_date || '')))[0];
      const openVisitId = openVisit ? openVisit.id : null;

      body.innerHTML =
        renderHeaderBar(c, subscription) +
        renderContactCard(c, sms_consent) +
        renderSmsHistoryCard() +
        renderEmailHistoryCard() +
        renderPlanCard(subscription, isCanceled) +
        renderHandoffCard(subscription, pending_addons, openVisit) +
        renderVisitsCard(visits, subscription, visit_preferences, visit_sms) +
        renderAddonsCard(pending_addons, isCanceled, openVisitId, subscription, addon_menu) +
        renderChargesCard(adhoc_charges, isCanceled) +
        renderInvoicesCard() +
        renderDangerZone(isCanceled, subscription);

      stripDeniedActions(body);

      // ---- Wire up event handlers (existing logic, new button IDs/classes) ----
      body.querySelectorAll('[data-complete-visit]').forEach(btn => {
        btn.addEventListener('click', () => completeVisit(btn.dataset.completeVisit, id));
      });
      body.querySelectorAll('[data-schedule-visit]').forEach(btn => {
        btn.addEventListener('click', () => scheduleAppointment(btn.dataset.scheduleVisit, id));
      });
      // One-tap "use this slot": fill the visit's booking controls (date +
      // arrival window) from a customer-proposed slot, then Amy books with
      // the existing button. Legacy AM/PM slots arrive pre-mapped to the
      // closest window by renderVisitPrefsBox.
      body.querySelectorAll('[data-use-slot]').forEach(btn => {
        btn.addEventListener('click', () => {
          const row = btn.closest('.gc-card-row');
          const dateInput = row && row.querySelector('.gc-appt-date');
          const winSelect = row && row.querySelector('.gc-appt-window');
          if (!dateInput || !winSelect) return;
          dateInput.value = btn.dataset.date;
          if (window.BatesArrivalWindows.byCode[btn.dataset.window]) winSelect.value = btn.dataset.window;
          dateInput.focus();
        });
      });
      body.querySelectorAll('[data-assign-visit]').forEach(sel => {
        sel.addEventListener('change', () => assignVisit(sel.dataset.assignVisit, sel.value || null, id));
      });
      body.querySelectorAll('[data-mark-performed]').forEach(btn => {
        btn.addEventListener('click', () => markPerformed(btn.dataset.markPerformed, btn.dataset.amount, btn.dataset.label, id));
      });
      const chargeAddonsBtn = body.querySelector('#gc-charge-addons-btn');
      if (chargeAddonsBtn) chargeAddonsBtn.addEventListener('click', () => chargePerformedAddons(id, c.id, (pending_addons || []).filter(a => a.status === 'performed' && a.amount_cents > 0)));
      body.querySelectorAll('.gc-standing-cb').forEach(cb => {
        cb.addEventListener('change', () => saveStandingAddons(id, c.id));
      });
      body.querySelectorAll('[data-remove-addon]').forEach(btn => {
        btn.addEventListener('click', () => removeAddon(btn.dataset.removeAddon, btn.dataset.label, id));
      });
      body.querySelectorAll('[data-unmark]').forEach(btn => {
        btn.addEventListener('click', () => unmarkPerformed(btn.dataset.unmark, id));
      });
      body.querySelectorAll('[data-refund-addon]').forEach(btn => {
        btn.addEventListener('click', () => refundCharge('addon', btn.dataset.refundAddon, parseInt(btn.dataset.amount, 10), parseInt(btn.dataset.refunded, 10), btn.dataset.label, id));
      });
      body.querySelectorAll('[data-refund-charge]').forEach(btn => {
        btn.addEventListener('click', () => refundCharge('adhoc', btn.dataset.refundCharge, parseInt(btn.dataset.amount, 10), parseInt(btn.dataset.refunded, 10), btn.dataset.desc, id));
      });
      body.querySelectorAll('[data-cancel-charge]').forEach(btn => {
        btn.addEventListener('click', () => cancelAdhocCharge(btn.dataset.cancelCharge, btn.dataset.desc, id));
      });

      const addAddonBtn = body.querySelector('#gc-add-addon-btn');
      if (addAddonBtn) addAddonBtn.addEventListener('click', () => addAddon(id));

      // Menu-row actions (add-ons menu Phase 1): direct "Add this visit" and
      // the per-row every-visit toggles. Same endpoints as before.
      body.querySelectorAll('[data-menu-add]').forEach(btn => {
        btn.addEventListener('click', () => addAddonFromMenu(id, btn.dataset.menuAdd, btn.dataset.label, parseInt(btn.dataset.amount, 10)));
      });
      body.querySelectorAll('[data-standing-set]').forEach(btn => {
        btn.addEventListener('click', () => setStandingFromMenu(id, c.id, (subscription.standing_addons || []), btn.dataset.standingSet, btn.dataset.on === '1', btn.dataset.label, parseInt(btn.dataset.amount || '0', 10)));
      });

      const addChargeBtn = body.querySelector('#gc-add-charge-btn');
      if (addChargeBtn) addChargeBtn.addEventListener('click', () => addAdhocCharge(id, visits || []));

      const cancelSubBtn = body.querySelector('#gc-cancel-sub-btn');
      if (cancelSubBtn) cancelSubBtn.addEventListener('click', () => cancelSubscription(id));

      const portalBtn = body.querySelector('#gc-portal-btn');
      if (portalBtn) portalBtn.addEventListener('click', () => sendPortalLink(id));

      const resendWelcomeBtn = body.querySelector('#gc-resend-welcome-btn');
      if (resendWelcomeBtn) resendWelcomeBtn.addEventListener('click', () => resendWelcomeEmail(id, resendWelcomeBtn));

      const changePlanBtn = body.querySelector('#gc-change-plan-btn');
      if (changePlanBtn) changePlanBtn.addEventListener('click', () => changePlan(id, changePlanBtn.dataset.plan, changePlanBtn.dataset.genclass));

      // Fleet add/remove button — initial label from the DB flag; loadStripeData
      // re-renders it from the live Stripe items (source of truth) once loaded.
      if (!isCanceled) renderFleetAction(id, c.id, !!subscription.fleet_monitoring, null);

      const saveNoteBtn = body.querySelector('#gc-save-note-btn');
      if (saveNoteBtn) saveNoteBtn.addEventListener('click', () => saveCustomerNote(c.id, saveNoteBtn));

      const contactEditBtn = body.querySelector('#gc-contact-edit-btn');
      if (contactEditBtn) contactEditBtn.addEventListener('click', () => enterContactEdit(c, id));

      const smsConsentBtn = body.querySelector('#gc-sms-consent-btn');
      if (smsConsentBtn) smsConsentBtn.addEventListener('click', () => recordSmsConsent(c, smsConsentBtn.dataset.optin === 'true', id));

      const genEditBtn = body.querySelector('#gc-generator-edit-btn');
      if (genEditBtn) genEditBtn.addEventListener('click', () => enterGeneratorEdit(subscription));

      const changeTierBtn = body.querySelector('#gc-change-tier-btn');
      if (changeTierBtn) changeTierBtn.addEventListener('click', () => changeTier(subscription));

      // ---- Jonas hand-off buttons ----
      const woBtn = body.querySelector('#gc-wo-created-btn');
      if (woBtn) woBtn.addEventListener('click', () => markWorkOrderCreated(id, woBtn));
      const woUndoBtn = body.querySelector('#gc-wo-undo-btn');
      if (woUndoBtn) woUndoBtn.addEventListener('click', () => undoHandoff(id, 'work-order-created', 'Undo the work-order-created mark?'));
      const copyPacketBtn = body.querySelector('#gc-copy-packet-btn');
      if (copyPacketBtn) copyPacketBtn.addEventListener('click', () => copyPacket(copyPacketBtn));

      const saveNvBtn = body.querySelector('#gc-next-visit-save');
      if (saveNvBtn) {
        saveNvBtn.addEventListener('click', async () => {
          const newDate = body.querySelector('#gc-next-visit-input').value;
          if (!newDate) { showStatus('Please pick a date.', 'error'); return; }
          saveNvBtn.disabled = true;
          saveNvBtn.textContent = 'Saving…';
          try {
            const r = await BatesAuth.authFetch(`${API_BASE}/api/generator-care/subscriptions/${id}`, {
              method: 'PATCH',
              headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ next_visit_due: newDate }),
            });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            showStatus('Next visit date saved.', 'success');
            await loadSubscriptions();
            showDetail(id);
          } catch (err) {
            console.error('Save next visit failed:', err);
            showStatus(`Failed: ${err.message}`, 'error');
            saveNvBtn.disabled = false;
            saveNvBtn.textContent = 'Save';
          }
        });
      }

      // ---- TECH-DASHBOARD PHASE 2 (additive): tech visit photos ----
      // Fills each visit row's .gc-visit-photos mount (renderVisitsCard) with a
      // strip of thumbnails from GET /api/generator-care/visits/:id/photos
      // (short-lived signed URLs). Clicking a thumb opens a minimal lightbox.
      // Photos are additive: any fetch error/404 leaves the mount empty and
      // must never break the modal.
      body.querySelectorAll('[data-visit-photos]').forEach(async (holder) => {
        try {
          const vid = holder.getAttribute('data-visit-photos');
          const pr = await BatesAuth.authFetch(`${API_BASE}/api/generator-care/visits/${vid}/photos`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (!pr.ok) return;
          const { photos } = await pr.json();
          if (!photos || !photos.length) return;
          holder.innerHTML =
            `<div class="gc-meta-label" style="margin-bottom:4px;">Photos (${photos.length})</div>` +
            `<div style="display:flex;flex-wrap:wrap;gap:6px;">` +
            photos.map((p, i) => `<img src="${escapeHtml(p.url)}" alt="Visit photo" data-photo-idx="${i}" loading="lazy" style="width:44px;height:44px;object-fit:cover;border-radius:6px;border:1px solid var(--line);cursor:pointer;" />`).join('') +
            `</div>`;
          // Shared viewer (photo-lightbox.js) — same close/arrows/swipe/counter
          // behavior the customer dashboard has, with arrows across THIS
          // visit's photos.
          const photoUrls = photos.map((p) => p.url);
          holder.querySelectorAll('[data-photo-idx]').forEach((img) => {
            img.addEventListener('click', () => {
              window.BatesLightbox.open(photoUrls, parseInt(img.getAttribute('data-photo-idx'), 10) || 0);
            });
          });
        } catch (e) {
          // Leave the strip empty — photos must never break the modal.
        }
      });
      // ---- end TECH-DASHBOARD PHASE 2 (additive) ----

      // Deep-link from a Needs Attention card: scroll its section into view.
      if (focus) {
        const target = body.querySelector(`#gc-card-${focus}`);
        if (target) {
          setTimeout(() => {
            target.scrollIntoView({ block: 'start', behavior: 'smooth' });
            target.classList.add('gc-focus-pulse');
            setTimeout(() => target.classList.remove('gc-focus-pulse'), 1800);
          }, 60);
        }
      }

      // Kick off lazy Stripe enrichment (fills payment method, lifetime, invoices,
      // and the work-order packet's actual signup charge) + the text-message log.
      loadStripeData(id, subscription, pending_addons, c.id, openVisit);
      loadSmsHistory(id, c.id);
      loadEmailHistory(id);

    } catch (err) {
      console.error('Detail load failed:', err);
      body.innerHTML = `<div class="gc-card"><p style="color:var(--danger);">Failed to load: ${escapeHtml(err.message)}</p></div>`;
    }
  }

  function addonLabel(t) {
    return ADDON_LABELS[t] || t;
  }

  async function removeAddon(addonId, label, subscriptionId) {
    if (!await openConfirm({ title: 'Remove add-on?', message: `"${label}" will be marked canceled. You can always add it back via "+ Add Add-on".`, confirmText: 'Remove', danger: true })) return;
    try {
      const r = await BatesAuth.authFetch(`${API_BASE}/api/generator-care/addons/${addonId}/remove`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await r.json();
      if (!r.ok) {
        const reason = data.hint || data.error || `HTTP ${r.status}`;
        showStatus(`Could not remove: ${reason}`, 'error');
      } else {
        showStatus(`Removed ${label}.`, 'success');
      }
      await loadSubscriptions();
      showDetail(subscriptionId);
    } catch (err) {
      console.error('Remove addon failed:', err);
      showStatus(`Failed: ${err.message}`, 'error');
    }
  }

  // Mark a pending add-on PERFORMED (unbilled) — does NOT charge. Performed add-ons
  // are billed together for the visit via "Charge performed add-ons".
  async function markPerformed(addonId, amount, label, subscriptionId) {
    const today = new Date().toISOString().slice(0, 10);
    const res = await openPrompt({
      title: `Mark "${label}" performed`,
      message: 'Marks it performed — does NOT charge. Bill it together with the other performed add-ons using "Charge performed add-ons."',
      fields: [{ name: 'date', label: 'Date performed', type: 'date', value: today, required: true }],
      confirmText: 'Mark performed',
    });
    if (res === null) return;
    const performedDate = (res.date || '').trim() || today;
    try {
      const r = await BatesAuth.authFetch(`${API_BASE}/api/generator-care/addons/${addonId}/mark-performed`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ date_performed: performedDate }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) { showStatus(`Could not mark performed: ${data.error || ('HTTP ' + r.status)}`, 'error'); return; }
      showStatus(`${label} marked performed (unbilled).`, 'success');
      await loadSubscriptions();
      showDetail(subscriptionId);
    } catch (err) {
      console.error('Mark performed failed:', err);
      showStatus(`Failed: ${err.message}`, 'error');
    }
  }

  // Charge ALL performed-but-unbilled add-ons for the visit in ONE combined,
  // itemized transaction (one charge, one receipt).
  async function chargePerformedAddons(subscriptionId, customerId, performedAddons) {
    const money = (c) => '$' + ((c || 0) / 100).toFixed(2);
    const list = (performedAddons || []).filter(a => a.amount_cents > 0);
    if (!list.length) { showStatus('No performed add-ons to charge.', 'info'); return; }
    const total = list.reduce((s, a) => s + a.amount_cents, 0);
    const items = list.map(a => `${addonLabel(a.addon_type)} (${money(a.amount_cents)})`).join(', ');
    if (!await openConfirm({
      title: 'Charge performed add-ons?',
      message: `Charge ${money(total)} to the card on file for: ${items}? This is one charge with one itemized receipt.`,
      confirmText: `Charge ${money(total)}`,
    })) return;
    try {
      const r = await BatesAuth.authFetch(`${API_BASE}/api/generator-care/subscriptions/${subscriptionId}/charge-performed-addons`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ customer_id: customerId }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) { showStatus(`Could not charge: ${data.reason || data.error || ('HTTP ' + r.status)}`, 'error'); return; }
      openSuccessFlash({ title: 'Charge successful', message: `Charged ${money(data.total_cents)} for ${data.charged_count} add-on${data.charged_count === 1 ? '' : 's'}.` });
      await loadSubscriptions();
      showDetail(subscriptionId);
    } catch (err) {
      console.error('Charge performed add-ons failed:', err);
      showStatus(`Failed: ${err.message}`, 'error');
    }
  }

  // Save which recurring add-ons are "standing" (auto-return each visit) for this
  // customer. Reads the current checkbox state and PATCHes the set.
  async function saveStandingAddons(subscriptionId, customerId) {
    const checked = Array.from(document.querySelectorAll('.gc-standing-cb'))
      .filter(cb => cb.checked).map(cb => cb.dataset.type);
    try {
      const r = await BatesAuth.authFetch(`${API_BASE}/api/generator-care/subscriptions/${subscriptionId}/standing-addons`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ standing_addons: checked, customer_id: customerId }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) { showStatus(`Couldn't save standing add-ons: ${data.error || ('HTTP ' + r.status)}`, 'error'); return; }
      showStatus('Standing add-ons updated.', 'success');
    } catch (err) {
      console.error('Save standing add-ons failed:', err);
      showStatus(`Failed: ${err.message}`, 'error');
    }
  }

  async function unmarkPerformed(addonId, subscriptionId) {
    if (!await openConfirm({ title: 'Undo performed?', message: 'Reverts this add-on to Pending (it has not been charged).', confirmText: 'Undo' })) return;
    try {
      const r = await BatesAuth.authFetch(`${API_BASE}/api/generator-care/addons/${addonId}/unmark-performed`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await r.json();
      if (!r.ok) {
        const reason = data.reason || data.error || `HTTP ${r.status}`;
        showStatus(`Could not undo: ${reason}`, 'error');
      } else {
        showStatus('Reverted to pending.', 'success');
      }
      await loadSubscriptions();
      showDetail(subscriptionId);
    } catch (err) {
      console.error('Unmark failed:', err);
      showStatus(`Failed: ${err.message}`, 'error');
    }
  }

  async function addAdhocCharge(subscriptionId, visits) {
    // Optional "link to a visit" select, built from this customer's visits.
    const visitOptions = [{ value: '', label: 'Not tied to a specific visit' }];
    (visits || [])
      .filter(v => ['scheduled', 'tentative', 'completed'].includes(v.status))
      .forEach(v => {
        const d = v.completed_date || v.appointment_at || v.scheduled_date || '';
        const dLabel = d ? ' — ' + String(d).slice(0, 10) : '';
        visitOptions.push({ value: v.id, label: `${v.visit_type === 'regular_service' ? 'Regular Service' : 'On-Demand'}${dLabel} (${v.status})` });
      });

    const res = await openPrompt({
      title: 'Add other charge',
      message: 'Charge the saved card now, or bundle it onto the next renewal invoice.',
      fields: [
        { name: 'description', label: 'Description (shown on customer receipt)', type: 'text', required: true },
        { name: 'amount', label: 'Amount ($)', type: 'number', step: '0.01', min: '0.01', inputmode: 'decimal', required: true, placeholder: 'e.g. 125.50' },
        { name: 'method', label: 'How to bill', type: 'select', value: 'immediate', options: [
          { value: 'immediate', label: 'Charge now (hits the saved card today)' },
          { value: 'renewal', label: 'Add to next renewal invoice' },
        ] },
        ...(visitOptions.length > 1 ? [{ name: 'visit', label: 'Link to a visit (optional)', type: 'select', value: '', options: visitOptions }] : []),
      ],
      confirmText: 'Add charge',
      validate: (v) => {
        const num = parseFloat(v.amount);
        if (!Number.isFinite(num) || num <= 0) return 'Amount must be a positive number.';
        return null;
      },
    });
    if (res === null) return;
    const amount = parseFloat(res.amount);
    const amount_cents = Math.round(amount * 100);
    const billing_method = res.method === 'renewal' ? 'renewal' : 'immediate';
    const service_visit_id = res.visit || null;
    const description = (res.description || '').trim();

    try {
      const r = await BatesAuth.authFetch(`${API_BASE}/api/generator-care/subscriptions/${subscriptionId}/adhoc-charge`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          description: description.trim(),
          amount_cents,
          billing_method,
          service_visit_id,
        }),
      });
      const data = await r.json();
      if (!r.ok) {
        const reason = data.reason || data.error || `HTTP ${r.status}`;
        showStatus(`Could not add charge: ${reason}`, 'error');
      } else if (billing_method === 'immediate') {
        openSuccessFlash({ title: 'Charge successful', message: `Charged $${amount.toFixed(2)} to the card on file.` });
      } else {
        showStatus(`Added ${amount.toFixed(2)} to next renewal.`, 'success');
      }
      await loadSubscriptions();
      showDetail(subscriptionId);
    } catch (err) {
      console.error('Add adhoc charge failed:', err);
      showStatus(`Failed: ${err.message}`, 'error');
    }
  }

  async function cancelAdhocCharge(chargeId, desc, subscriptionId) {
    if (!await openConfirm({ title: 'Cancel charge?', message: `"${desc}"\n\nIf pending, this removes it. If it was already charged, it cannot be canceled here (refund must be handled separately).`, confirmText: 'Cancel charge', danger: true })) return;
    try {
      const r = await BatesAuth.authFetch(`${API_BASE}/api/generator-care/adhoc-charges/${chargeId}/cancel`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await r.json();
      if (!r.ok) {
        const reason = data.reason || data.error || `HTTP ${r.status}`;
        showStatus(`Could not cancel: ${reason}`, 'error');
      } else {
        showStatus('Charge canceled.', 'success');
      }
      await loadSubscriptions();
      showDetail(subscriptionId);
    } catch (err) {
      console.error('Cancel adhoc charge failed:', err);
      showStatus(`Failed: ${err.message}`, 'error');
    }
  }

  // Menu-row "Add this visit": one confirm, then the existing add-addon
  // endpoint. Adding only schedules it — the charge happens after it's
  // marked performed (the billing safety rule).
  async function addAddonFromMenu(subscriptionId, addonType, label, amountCents) {
    const money = '$' + ((amountCents || 0) / 100).toFixed(2);
    if (!await openConfirm({
      title: `Add ${label} this visit?`,
      message: `${label} (${money}) is added to the current visit. Nothing is charged until it's marked performed and billed.`,
      confirmText: 'Add this visit',
    })) return;
    try {
      const r = await BatesAuth.authFetch(`${API_BASE}/api/generator-care/subscriptions/${subscriptionId}/add-addon`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ addon_type: addonType }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) { showStatus(`Could not add: ${data.error || ('HTTP ' + r.status)}`, 'error'); return; }
      showStatus(`Added ${label} for this visit.`, 'success');
      await loadSubscriptions();
      showDetail(subscriptionId);
    } catch (err) {
      console.error('Menu add addon failed:', err);
      showStatus(`Failed: ${err.message}`, 'error');
    }
  }

  // Menu-row every-visit toggle: PATCHes the standing set (current set ± this
  // type) through the existing standing-addons endpoint.
  async function setStandingFromMenu(subscriptionId, customerId, currentStanding, addonType, on, label, amountCents) {
    const money = '$' + ((amountCents || 0) / 100).toFixed(2);
    const ok = await openConfirm(on
      ? {
          title: `${label} every visit?`,
          message: `${label} auto-returns on every visit (${money} each time). It's only charged when the work is performed.`,
          confirmText: 'Every visit',
        }
      : {
          title: `Stop ${label} every visit?`,
          message: `${label} stops auto-returning on future visits. Anything already performed or charged is untouched.`,
          confirmText: 'Stop',
        });
    if (!ok) return;
    const next = new Set(currentStanding);
    if (on) next.add(addonType); else next.delete(addonType);
    try {
      const r = await BatesAuth.authFetch(`${API_BASE}/api/generator-care/subscriptions/${subscriptionId}/standing-addons`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ standing_addons: Array.from(next), customer_id: customerId }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) { showStatus(`Couldn't update: ${data.error || ('HTTP ' + r.status)}`, 'error'); return; }
      showStatus(on ? `${label} set to every visit.` : `${label} no longer every visit.`, 'success');
      await loadSubscriptions();
      showDetail(subscriptionId);
    } catch (err) {
      console.error('Standing toggle failed:', err);
      showStatus(`Failed: ${err.message}`, 'error');
    }
  }

  async function addAddon(subscriptionId) {
    try {
      // Fetch available addons for this subscription's gen class
      const listR = await BatesAuth.authFetch(`${API_BASE}/api/generator-care/subscriptions/${subscriptionId}/available-addons`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const listData = await listR.json();
      if (!listR.ok) {
        showStatus(`Could not load addons: ${listData.error || listR.status}`, 'error');
        return;
      }
      const addons = listData.addons || [];
      if (!addons.length) {
        showStatus('No add-ons available for this generator class.', 'error');
        return;
      }
      // Inline select dialog instead of a numbered prompt.
      const choiceOptions = addons.map((a) => ({ value: a.addon_type, label: `${a.label} ($${(a.amount_cents / 100).toFixed(2)})` }));
      const res = await openPrompt({
        title: 'Add add-on',
        message: 'Adds a pending add-on. It will be charged at the next renewal once marked performed.',
        fields: [{ name: 'addon', label: 'Add-on', type: 'select', value: choiceOptions[0].value, options: choiceOptions }],
        confirmText: 'Add add-on',
      });
      if (res === null) return;
      const choice = addons.find((a) => a.addon_type === res.addon);
      if (!choice) { showStatus('Invalid selection.', 'error'); return; }
      const addR = await BatesAuth.authFetch(`${API_BASE}/api/generator-care/subscriptions/${subscriptionId}/add-addon`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ addon_type: choice.addon_type }),
      });
      const addData = await addR.json();
      if (!addR.ok) {
        showStatus(`Could not add: ${addData.error || addR.status}`, 'error');
      } else {
        showStatus(`Added ${choice.label}.`, 'success');
      }
      await loadSubscriptions();
      showDetail(subscriptionId);
    } catch (err) {
      console.error('Add addon failed:', err);
      showStatus(`Failed: ${err.message}`, 'error');
    }
  }

  async function cancelSubscription(subscriptionId) {
    const res = await openPrompt({
      title: 'Cancel subscription?',
      message: 'Customer keeps service through their paid-through date. Stripe will NOT auto-renew at the end of the period.',
      fields: [{ name: 'reason', label: 'Reason (optional)', type: 'textarea', placeholder: 'e.g. moved, sold the generator' }],
      confirmText: 'Cancel subscription',
      cancelText: 'Keep subscription',
      danger: true,
    });
    if (res === null) return;
    const reason = (res.reason || '').trim() || null;
    try {
      const r = await BatesAuth.authFetch(`${API_BASE}/api/generator-care/subscriptions/${subscriptionId}/cancel`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason }),
      });
      const data = await r.json();
      if (!r.ok) {
        const reason = data.reason || data.error || `HTTP ${r.status}`;
        showStatus(`Cancel failed: ${reason}`, 'error');
      } else {
        const through = data.service_through ? ` Service through ${data.service_through}.` : '';
        openSuccessFlash({ title: 'Subscription canceled', message: `Stripe will not auto-renew.${through}` });
      }
      await loadSubscriptions();
      showDetail(subscriptionId);
    } catch (err) {
      console.error('Cancel subscription failed:', err);
      showStatus(`Cancel failed: ${err.message}`, 'error');
    }
  }

  // Book (or reschedule) an appointment date + arrival window -> the visit
  // becomes "Scheduled". Reads the inline date input + window select next to
  // the visit; appointment_at is stored as the window's START on that date
  // (local wall-clock -> absolute instant) so sorting/state logic is
  // unchanged, and arrival_window is the human-facing label everywhere. The
  // single backend "schedule" action is where a future SMS confirmation will hang.
  async function scheduleAppointment(visitId, subscriptionId) {
    const dateInput = document.querySelector(`.gc-appt-date[data-visit="${visitId}"]`);
    const winSelect = document.querySelector(`.gc-appt-window[data-visit="${visitId}"]`);
    const win = winSelect && window.BatesArrivalWindows.byCode[winSelect.value];
    if (!dateInput || !dateInput.value || !win) {
      showStatus('Pick a date and an arrival window first.', 'error');
      return;
    }
    const when = new Date(`${dateInput.value}T${win.start}`);
    if (isNaN(when.getTime())) {
      showStatus('That date isn’t valid.', 'error');
      return;
    }
    try {
      const r = await BatesAuth.authFetch(`${API_BASE}/api/generator-care/visits/${visitId}/schedule`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ appointment_at: when.toISOString(), arrival_window: win.code }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        showStatus(`Could not schedule: ${data.error || `HTTP ${r.status}`}`, 'error');
        return;
      }
      showStatus('Appointment booked.', 'success');
      await loadSubscriptions();
      showDetail(subscriptionId);
    } catch (err) {
      console.error('Schedule appointment failed:', err);
      showStatus(`Failed: ${err.message}`, 'error');
    }
  }

  async function completeVisit(visitId, subscriptionId) {
    const today = new Date().toISOString().slice(0, 10);
    const res = await openPrompt({
      title: 'Mark visit complete',
      message: "The next visit will be scheduled on the plan's regular cadence (every 6 or 12 months from signup) — not relative to today.",
      fields: [
        { name: 'date', label: 'Date performed', type: 'date', value: today, required: true },
        { name: 'notes', label: 'Notes for the customer (optional)', type: 'textarea', placeholder: 'What we did, anything they should know…', hint: 'Appears in the visit-complete email under “Notes from the visit.”' },
        { name: 'internal', label: 'Internal note (office + techs only)', type: 'textarea', placeholder: 'Parts used, follow-ups, access notes…', hint: 'Never shown to the customer.' },
      ],
      confirmText: 'Mark complete',
    });
    if (res === null) return;
    const completed_date = (res.date || '').trim() || today;
    const notes = (res.notes || '').trim() || null;
    const internal_note = (res.internal || '').trim() || null;
    try {
      const r = await BatesAuth.authFetch(`${API_BASE}/api/generator-care/visits/${visitId}/complete`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ completed_date, notes, internal_note }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        const reason = data.reason || data.error || `HTTP ${r.status}`;
        showStatus(`Could not mark complete: ${reason}`, 'error');
      } else {
        showStatus('Visit marked complete. Next visit scheduled.', 'success');
      }
      await loadSubscriptions();
      showDetail(subscriptionId);
    } catch (err) {
      console.error('Complete visit failed:', err);
      showStatus(`Failed: ${err.message}`, 'error');
    }
  }

  // Dispatch a tech to (or clear) a visit. Office-gated server-side.
  async function assignVisit(visitId, techId, subscriptionId) {
    try {
      const r = await BatesAuth.authFetch(`${API_BASE}/api/generator-care/visits/${visitId}/assign`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ assigned_tech_id: techId }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) { showStatus(`Couldn't assign: ${data.error || ('HTTP ' + r.status)}`, 'error'); return; }
      showStatus(techId ? `Assigned to ${techName(techId)}.` : 'Assignment cleared.', 'success');
      await loadSubscriptions();
      showDetail(subscriptionId);
    } catch (err) {
      console.error('assign visit failed:', err);
      showStatus(`Failed: ${err.message}`, 'error');
    }
  }

  // (Field-tech MANAGEMENT moved to members.html/members.js; loadTechs +
  // techName/techOptions above stay — the per-visit assign picker uses them.)

  function closeModal() {
    document.getElementById('detailsModal').hidden = true;
  }

  // ---- Helpers ----
  function showLoading(b) {
    document.getElementById('loading').hidden = !b;
  }
  // ---- View switching (hash-routed) ----
  // No hash / #attention = the action queue (default landing view);
  // #customers = the full list; #metrics / #accounting are the other two
  // Generator Care tabs, folded in as in-page views too (they used to be
  // separate documents — see metrics.js/accounting.js, now lazy-loaded
  // BatesMetrics/BatesAccounting modules). The shared section switcher
  // renders all four as top-level tabs (shared-nav.js); hash changes swap
  // views without a reload.
  const HASH_VIEWS = ['attention', 'customers', 'leads', 'metrics', 'accounting'];
  function currentHashView() {
    const h = location.hash.slice(1);
    return HASH_VIEWS.includes(h) ? h : 'attention';
  }
  const SECTION_TAB_MATCH = { attention: 'gc-attention', customers: 'gc-customers', leads: 'gc-leads', metrics: 'metrics', accounting: 'accounting' };

  // Chart.js is only needed by Metrics and costs ~200KB, so it's fetched from
  // the CDN on first activation of that tab rather than unconditionally in
  // <head> — everyone else (the common case: Needs Attention/Customers) never
  // pays for it. Cached in a module-level promise so repeat activations/
  // concurrent calls don't inject the script twice.
  function ensureChartJs() {
    if (window.Chart) return Promise.resolve();
    if (chartJsPromise) return chartJsPromise;
    chartJsPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js';
      s.onload = resolve;
      s.onerror = () => reject(new Error('Chart.js failed to load'));
      document.head.appendChild(s);
    });
    return chartJsPromise;
  }

  function showView(view) {
    document.getElementById('attention-view').hidden = view !== 'attention';
    document.getElementById('customers-view').hidden = view !== 'customers';
    document.getElementById('leads-view').hidden = view !== 'leads';
    document.getElementById('metrics-view').hidden = view !== 'metrics';
    document.getElementById('accounting-view').hidden = view !== 'accounting';
    // Chart.js's canvases keep whatever size they last measured while
    // display:none, so every re-activation (not just the first) needs an
    // explicit resize — see the comment on resizeCharts() in metrics.js.
    // No-op if no charts exist yet (first activation, before data loads).
    if (view === 'metrics') window.BatesMetrics.onShow();

    // Header controls that only make sense for specific tabs.
    const listView = view === 'attention' || view === 'customers';
    document.getElementById('gc-admin-tools').hidden = !listView;
    const countEl = document.getElementById('result-count');
    if (countEl) countEl.hidden = !listView;
    document.getElementById('export-csv-btn').hidden = view !== 'accounting';
    // print-all-btn also depends on accounting's own by-date/by-payout state
    // (accounting.js's setView() toggles it) — only force it hidden when
    // leaving the tab; leave accounting's own state alone while on it.
    if (view !== 'accounting') document.getElementById('print-all-btn').hidden = true;

    const want = SECTION_TAB_MATCH[view];
    document.querySelectorAll('.section-tab[data-match]').forEach((a) => {
      const on = a.dataset.match === want;
      a.classList.toggle('active', on);
      if (on) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });

    if (view === 'metrics' && !metricsLoaded) {
      metricsLoaded = true;
      ensureChartJs()
        .then(() => window.BatesMetrics.init())
        .catch((err) => {
          console.error('Chart.js failed to load:', err);
          showStatus('Could not load charts — check your connection and try again.', 'error');
        });
    }
    if (view === 'accounting' && !accountingLoaded) {
      accountingLoaded = true;
      window.BatesAccounting.init();
    }
    if (view === 'leads' && !leadsLoaded) {
      leadsLoaded = true;
      window.BatesLeads.init();
    }
  }
  window.addEventListener('hashchange', () => showView(currentHashView()));

  // ---- Init ----
  // Permission flags shape the queue's buttons (e.g. Charge vs View add-ons),
  // so re-render it once /me lands.
  checkRole().then(() => renderAttention());
  loadTechs();
  // One early leads fetch so the "new leads" count shows on the section tab
  // without the tab being opened; BatesLeads.init() reuses the same data.
  if (window.BatesLeads) window.BatesLeads.prime();
  showView(currentHashView());

  document.getElementById('refresh-btn').addEventListener('click', () => {
    const view = currentHashView();
    if (view === 'metrics') { if (window.BatesMetrics) window.BatesMetrics.refresh(); return; }
    if (view === 'accounting') { if (window.BatesAccounting) window.BatesAccounting.refresh(); return; }
    if (view === 'leads') { if (window.BatesLeads) window.BatesLeads.refresh(); return; }
    loadSubscriptions();
    loadBillingSnapshot();
  });

  document.querySelectorAll('.gc-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.gc-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeFilter = btn.dataset.filter;
      render();
    });
  });

  document.getElementById('filter-name').addEventListener('input', (e) => {
    searchQuery = e.target.value;
    render();
  });

  document.getElementById('modal-close-btn').addEventListener('click', closeModal);
  document.getElementById('modal-close-btn2').addEventListener('click', closeModal);
  document.querySelector('#detailsModal .modal-overlay').addEventListener('click', closeModal);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

  loadSubscriptions();
  loadBillingSnapshot();

  // ---- Resend Welcome Email ----
  async function resendWelcomeEmail(subscriptionId, btn) {
    const originalText = btn ? btn.textContent : null;
    if (btn) { btn.disabled = true; btn.textContent = 'Sending...'; }
    try {
      const r = await BatesAuth.authFetch(`${API_BASE}/api/generator-care/subscriptions/${subscriptionId}/resend-welcome`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      });
      const data = await r.json();
      if (!r.ok || !data.sent) {
        const reason = data.error || data.email_status || `HTTP ${r.status}`;
        showStatus(`Couldn't resend welcome email: ${reason}`, 'error');
        return;
      }
      const who = data.customer_name ? ` to ${data.customer_name}` : '';
      const emailAddr = data.customer_email ? ` (${data.customer_email})` : '';
      showStatus(`Welcome email re-sent${who}${emailAddr}.`, 'success');
    } catch (err) {
      console.error('Resend welcome failed:', err);
      showStatus(`Failed: ${err.message}`, 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = originalText; }
    }
  }

  // ---- Send Customer Portal link ----
  async function markWorkOrderCreated(subscriptionId, btn) {
    const input = document.getElementById('gc-wo-number');
    const validation = document.getElementById('gc-wo-validation');
    const woNumber = input ? input.value.trim() : '';
    if (!woNumber) {
      if (validation) validation.style.display = 'block';
      if (input) input.focus();
      return;
    }
    if (validation) validation.style.display = 'none';
    if (!await openConfirm({ title: 'Mark work order created?', message: `WO# ${woNumber}\n\nStamps the Jonas work order as created — an internal record for Brenda. Customers are not invoiced.`, confirmText: 'Mark created' })) return;
    if (btn) { btn.disabled = true; btn.textContent = 'Working…'; }
    try {
      const r = await BatesAuth.authFetch(`${API_BASE}/api/generator-care/subscriptions/${subscriptionId}/work-order-created`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ work_order_number: woNumber }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        showStatus(`Could not mark work order created: ${data.error || `HTTP ${r.status}`}`, 'error');
      } else if (data.already_marked) {
        showStatus('Already marked as created.', 'info');
      } else {
        showStatus('Work order created.', 'success');
      }
      await loadSubscriptions();
      showDetail(subscriptionId);
    } catch (err) {
      console.error('markWorkOrderCreated failed:', err);
      showStatus('Failed to mark work order created.', 'error');
    }
  }

  async function undoHandoff(subscriptionId, which, confirmMsg) {
    if (!await openConfirm({ title: 'Undo?', message: confirmMsg, confirmText: 'Undo', danger: true })) return;
    try {
      const r = await BatesAuth.authFetch(`${API_BASE}/api/generator-care/subscriptions/${subscriptionId}/${which}/undo`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) showStatus(`Could not undo: ${data.error || `HTTP ${r.status}`}`, 'error');
      else showStatus('Undone.', 'success');
      await loadSubscriptions();
      showDetail(subscriptionId);
    } catch (err) {
      console.error('undoHandoff failed:', err);
      showStatus('Failed to undo.', 'error');
    }
  }

  function copyPacket(btn) {
    const ta = document.getElementById('gc-packet');
    if (!ta) return;
    const flash = () => { const t = btn.textContent; btn.textContent = 'Copied!'; setTimeout(() => { btn.textContent = t; }, 1500); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(ta.value).then(flash).catch(() => { ta.select(); document.execCommand('copy'); flash(); });
    } else {
      ta.select(); document.execCommand('copy'); flash();
    }
  }

  async function sendPortalLink(subscriptionId) {
    try {
      const r = await BatesAuth.authFetch(`${API_BASE}/api/generator-care/subscriptions/${subscriptionId}/portal-session`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      });
      const data = await r.json();
      if (!r.ok) {
        showStatus(`Portal link failed: ${data.error || 'HTTP ' + r.status}`, 'error');
        return;
      }
      const who = data.customer_name ? ` to ${data.customer_name}` : '';
      const emailAddr = data.customer_email ? ` (${data.customer_email})` : '';
      if (data.email_sent) {
        showStatus(`Card-update link emailed${who}${emailAddr}. Link expires in about an hour.`, 'success');
      } else {
        // Fallback if the mail provider is down or the customer has no email on file: copy
        // the link to the clipboard so Amy can paste it to the customer.
        let copied = false;
        try { await navigator.clipboard.writeText(data.url); copied = true; } catch (_) {}
        const reason = data.email_status ? ' (' + data.email_status + ')' : '';
        const target = data.customer_email || 'the customer';
        showStatus(`Couldn't auto-send the email${reason}.${copied ? ' Link copied to clipboard' : ' Copy the link from the console'} \u2014 send it to ${target}. Expires in ~1 hour.`, 'info');
        if (!copied) console.log('[portal-link] card-update URL:', data.url);
      }
    } catch (err) {
      console.error('Portal link failed:', err);
      showStatus(`Failed: ${err.message}`, 'error');
    }
  }

  // ---- Admin: Send test email ----
  function wireAdminTools() {
    const btn = document.getElementById('gc-test-send-btn');
    const templateSel = document.getElementById('gc-test-template');
    const emailInput = document.getElementById('gc-test-email');
    const resultEl = document.getElementById('gc-test-result');
    if (!btn || !templateSel || !emailInput || !resultEl) return;

    btn.addEventListener('click', async () => {
      const template = templateSel.value;
      const to = (emailInput.value || '').trim();
      if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
        resultEl.textContent = 'Please enter a valid email address.';
        resultEl.style.color = 'var(--danger)';
        return;
      }
      btn.disabled = true;
      const originalText = btn.textContent;
      btn.textContent = 'Sending...';
      resultEl.textContent = '';
      try {
        const r = await BatesAuth.authFetch(`${API_BASE}/api/generator-care/admin/send-test-email`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ template, to }),
        });
        const data = await r.json();
        if (!r.ok || !data.sent) {
          const reason = data.error || `HTTP ${r.status}`;
          resultEl.textContent = `Failed: ${reason}`;
          resultEl.style.color = 'var(--danger)';
          return;
        }
        resultEl.textContent = `Sent to ${to} (check your inbox).`;
        resultEl.style.color = 'var(--ok)';
      } catch (err) {
        console.error('Test email send failed:', err);
        resultEl.textContent = `Failed: ${err.message}`;
        resultEl.style.color = 'var(--danger)';
      } finally {
        btn.disabled = false;
        btn.textContent = originalText;
      }
    });
  }
  wireAdminTools();

  // ---- Modal: lazy Stripe enrichment + new action handlers ----

  // Fetches payment method + lifetime billed + last 5 invoices, replaces
  // the matching skeletons in the open modal. Fails quietly with a small
  // "couldn't load" message in each section.
  // Switch the customer between Semi-Annual and Annual, effective at their next
  // renewal. No charge today (server schedules it via a Stripe subscription
  // schedule with proration disabled).
  async function changePlan(subscriptionId, currentPlan, genClass) {
    const target = currentPlan === 'semi_annual' ? 'annual' : 'semi_annual';
    const targetLabel = planLabel(target);
    const renewsOn = planBilling && planBilling.current_period_end ? planBilling.current_period_end : null;
    const whenText = renewsOn ? `their next renewal on ${fmtDate(renewsOn)}` : 'their next renewal';
    if (!await openConfirm({ title: `Switch to ${targetLabel}?`, message: `Starting at ${whenText}. No charge today — the new ${targetLabel} price and billing cadence take effect at renewal; they stay on their current plan until then.`, confirmText: `Switch to ${targetLabel}` })) return;
    try {
      const r = await BatesAuth.authFetch(`${API_BASE}/api/generator-care/subscriptions/${subscriptionId}/change-plan`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ new_plan: target }),
      });
      const data = await r.json();
      if (!r.ok) { showStatus(`Couldn't change plan: ${data.error || ('HTTP ' + r.status)}`, 'error'); return; }
      openSuccessFlash({ title: 'Plan change scheduled', message: `Switching to ${targetLabel} at renewal (${fmtDate(data.effective_date)}). No charge today.` });
      showDetail(subscriptionId);
    } catch (e) {
      console.error('change-plan failed:', e);
      showStatus(`Couldn't change plan: ${e.message}`, 'error');
    }
  }

  // Cancel a not-yet-effective plan change (releases the Stripe schedule).
  async function revertPlanChange(subscriptionId) {
    if (!await openConfirm({ title: 'Undo the pending change?', message: 'Cancel the change scheduled for renewal and keep things exactly as they are now. No charge either way.', confirmText: 'Undo it' })) return;
    try {
      const r = await BatesAuth.authFetch(`${API_BASE}/api/generator-care/subscriptions/${subscriptionId}/revert-plan-change`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      });
      const data = await r.json();
      if (!r.ok) { showStatus(`Couldn't undo: ${data.error || ('HTTP ' + r.status)}`, 'error'); return; }
      showStatus('Pending change cancelled. Nothing changes at renewal.', 'success');
      showDetail(subscriptionId);
    } catch (e) {
      console.error('revert-plan-change failed:', e);
      showStatus(`Couldn't undo: ${e.message}`, 'error');
    }
  }

  // ---- Fleet Monitoring add/remove (folded into the one subscription) --------
  // Renders the Add/Remove button into #gc-fleet-action based on the live fleet
  // state. When a change is already pending at renewal, the banner carries the
  // undo, so the button is hidden to avoid a conflicting action.
  function renderFleetAction(subscriptionId, customerId, hasFleet, pendingChange) {
    const wrap = document.getElementById('gc-fleet-action');
    if (!wrap) return;
    if (userPerms && !userPerms.billing_actions) { wrap.innerHTML = ''; return; }
    if (pendingChange && (pendingChange.fleet_change || pendingChange.plan_changed)) { wrap.innerHTML = ''; return; }
    if (hasFleet) {
      wrap.innerHTML = `<button class="btn btn-secondary btn-sm" id="gc-remove-fleet-btn">Remove Fleet Monitoring</button>`;
      const b = document.getElementById('gc-remove-fleet-btn');
      if (b) b.addEventListener('click', () => removeFleet(subscriptionId, customerId));
    } else {
      wrap.innerHTML = `<button class="btn btn-secondary btn-sm" id="gc-add-fleet-btn">Add Fleet Monitoring</button>`;
      const b = document.getElementById('gc-add-fleet-btn');
      if (b) b.addEventListener('click', () => addFleet(subscriptionId, customerId));
    }
  }

  // Add Fleet: preview the prorated charge first, confirm inline, then charge.
  async function addFleet(subscriptionId, customerId) {
    const money = (c) => '$' + ((c || 0) / 100).toFixed(2);
    let preview;
    try {
      const q = customerId ? `?customer_id=${encodeURIComponent(customerId)}` : '';
      const r = await BatesAuth.authFetch(`${API_BASE}/api/generator-care/subscriptions/${subscriptionId}/fleet-preview${q}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      preview = await r.json();
      if (!r.ok) { showStatus(`Couldn't preview: ${preview.error || ('HTTP ' + r.status)}`, 'error'); return; }
    } catch (e) {
      console.error('fleet-preview failed:', e);
      showStatus(`Couldn't preview: ${e.message}`, 'error');
      return;
    }
    if (preview.already_has_fleet) { showStatus('Fleet Monitoring is already active.', 'info'); showDetail(subscriptionId); return; }

    const through = preview.period_end ? fmtDate(preview.period_end) : 'the next renewal';
    const cad = preview.plan === 'semi_annual' ? 'per 6 months' : 'per year';
    const charge = preview.proration_cents;
    // If a coupon/credit reduced the charge below the time-based proration, say so.
    let reducedNote = '';
    if ((preview.reduced_by_credit || preview.reduced_by_discount)
        && typeof preview.expected_gross_cents === 'number' && preview.expected_gross_cents > charge) {
      const why = preview.reduced_by_credit && preview.reduced_by_discount ? 'an account credit and a discount'
        : preview.reduced_by_credit ? 'an account credit' : 'a discount';
      reducedNote = ` (Reduced from ${money(preview.expected_gross_cents)} by ${why} on the account.)`;
    }
    const ok = await openConfirm({
      title: 'Add Fleet Monitoring?',
      message: `A prorated charge of ${money(charge)} will be billed to the card on file now, covering Fleet Monitoring through ${through}.${reducedNote} After that it renews together with the plan — the next renewal will be ${money(preview.combined_renewal_cents)} on ${through} (includes Fleet Monitoring ${money(preview.fleet_renewal_cents)} ${cad}).`,
      confirmText: `Charge ${money(charge)} & add`,
    });
    if (!ok) return;

    try {
      const r = await BatesAuth.authFetch(`${API_BASE}/api/generator-care/subscriptions/${subscriptionId}/add-fleet`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ customer_id: customerId, proration_date: preview.proration_date }),
      });
      const data = await r.json();
      if (!r.ok) { showStatus(`Couldn't add Fleet Monitoring: ${data.error || ('HTTP ' + r.status)}`, 'error'); return; }
      openSuccessFlash({ title: 'Fleet Monitoring added', message: 'Prorated charge billed to the card on file.' });
      await loadSubscriptions();
      showDetail(subscriptionId);
    } catch (e) {
      console.error('add-fleet failed:', e);
      showStatus(`Couldn't add Fleet Monitoring: ${e.message}`, 'error');
    }
  }

  // Remove Fleet: schedule it to drop at renewal (no proration, no refund).
  async function removeFleet(subscriptionId, customerId) {
    const renewsOn = (planBilling && planBilling.current_period_end) ? fmtDate(planBilling.current_period_end) : 'the next renewal';
    const ok = await openConfirm({
      title: 'Remove Fleet Monitoring?',
      message: `Fleet Monitoring stays active through the period already paid for and drops off at renewal (${renewsOn}). No refund or charge now. You can undo this until then.`,
      confirmText: 'Remove at renewal',
      danger: true,
    });
    if (!ok) return;
    try {
      const r = await BatesAuth.authFetch(`${API_BASE}/api/generator-care/subscriptions/${subscriptionId}/remove-fleet`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ customer_id: customerId }),
      });
      const data = await r.json();
      if (!r.ok) { showStatus(`Couldn't remove Fleet Monitoring: ${data.error || ('HTTP ' + r.status)}`, 'error'); return; }
      openSuccessFlash({ title: 'Fleet Monitoring removal scheduled', message: `It stays active until renewal (${fmtDate(data.effective_date)}), then drops off. No refund or charge now.` });
      showDetail(subscriptionId);
    } catch (e) {
      console.error('remove-fleet failed:', e);
      showStatus(`Couldn't remove Fleet Monitoring: ${e.message}`, 'error');
    }
  }

  // ---- Change generator class / pricing tier (prorate the difference now) ----
  // Pick class + cadence -> preview the exact prorated charge/credit -> confirm ->
  // apply with the SAME pinned proration_date so the charge equals the preview.
  async function changeTier(subscription) {
    const money = (c) => '$' + ((c || 0) / 100).toFixed(2);
    const customerId = (subscription.customer && subscription.customer.id) || undefined;

    // 1. Pick the target class / kW tier (cadence is unchanged — use Change plan
    //    for cadence). Prefilled to the current class.
    const picked = await openPrompt({
      title: 'Change generator class / tier',
      message: 'Corrects the generator class / kW tier (and its price) at the current cadence. The full price difference is settled now. Confirm the corrected tier with the customer first.',
      fields: [
        { name: 'gen_class', label: 'Generator class / kW tier', type: 'select', value: subscription.gen_class, options: TIER_OPTIONS },
      ],
      confirmText: 'Preview change',
    });
    if (picked === null) return;
    if (picked.gen_class === subscription.gen_class) {
      showStatus('That is already the current class / tier.', 'info');
      return;
    }

    // 2. Preview the exact flat catalog difference (deterministic).
    let preview;
    try {
      const r = await BatesAuth.authFetch(`${API_BASE}/api/generator-care/subscriptions/${subscription.id}/tier-change-preview`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ new_gen_class: picked.gen_class, customer_id: customerId }),
      });
      preview = await r.json().catch(() => ({}));
      if (!r.ok) { showStatus(`Couldn't preview: ${preview.error || ('HTTP ' + r.status)}`, 'error'); return; }
    } catch (e) {
      console.error('tier-change-preview failed:', e);
      showStatus(`Couldn't preview: ${e.message}`, 'error');
      return;
    }

    const tierLabel = (TIER_OPTIONS.find((t) => t.value === picked.gen_class) || {}).label || picked.gen_class;
    const cadLabel = subscription.plan === 'semi_annual' ? 'Semi-Annual' : 'Annual';
    const onDate = preview.period_end ? ` on ${fmtDate(preview.period_end)}` : '';
    const moneyLine = preview.direction === 'credit'
      ? `A credit of ${money(preview.credit_cents)} (full tier difference) will be applied to the next invoice — no charge now.`
      : `A charge of ${money(preview.charge_now_cents)} (full tier difference) will be billed to the card on file now.`;
    const confirmText = preview.direction === 'credit'
      ? 'Apply change (credit)'
      : `Charge ${money(preview.charge_now_cents)} & change`;

    const ok = await openConfirm({
      title: `Change to ${tierLabel}?`,
      message: `${moneyLine} Renewal will be ${money(preview.new_renewal_cents)}${onDate} (cadence unchanged — ${cadLabel}).`,
      confirmText,
      danger: preview.direction === 'charge',
    });
    if (!ok) return;

    // 3. Apply — backend charges/credits the same flat catalog difference.
    try {
      const r = await BatesAuth.authFetch(`${API_BASE}/api/generator-care/subscriptions/${subscription.id}/tier-change`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ new_gen_class: picked.gen_class, customer_id: customerId }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) { showStatus(`Couldn't change tier: ${data.error || ('HTTP ' + r.status)}`, 'error'); return; }
      openSuccessFlash({ title: 'Tier changed', message: `Changed to ${tierLabel}.` });
      await loadSubscriptions();
      showDetail(subscription.id);
    } catch (e) {
      console.error('tier-change failed:', e);
      showStatus(`Couldn't change tier: ${e.message}`, 'error');
    }
  }

  async function loadStripeData(subscriptionId, subscription, pendingAddons, customerId, openVisit) {
    const body = document.getElementById('modal-body');
    if (!body) return;
    try {
      const r = await BatesAuth.authFetch(`${API_BASE}/api/generator-care/subscriptions/${subscriptionId}/stripe-data`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();

      // Remember the card on file for the refund dialog's card label.
      cardOnFile = data.payment_method || null;

      // Payment method row
      const pmEl = body.querySelector('#gc-payment-method-value');
      if (pmEl) {
        const pm = data.payment_method;
        pmEl.innerHTML = pm
          ? `${escapeHtml(pm.brand || 'card')} &middot; &bull;&bull;&bull;&bull; ${escapeHtml(pm.last4 || '')} <span style="color:var(--ink-2);font-weight:500;">exp ${String(pm.exp_month || '').padStart(2,'0')}/${String(pm.exp_year || '').slice(-2)}</span>`
          : `<span style="color:var(--ink-3);font-weight:500;">No card on file</span>`;
      }

      // Lifetime billed row
      const ltEl = body.querySelector('#gc-lifetime-value');
      if (ltEl) {
        const amt = data.lifetime_billed_cents || 0;
        ltEl.textContent = `$${(amt / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      }

      // Plan billing: "Renews at" amount + any pending (scheduled) plan change.
      planBilling = data.plan_billing || null;
      const pb = planBilling;
      const cadenceText = (plan) => plan === 'semi_annual' ? 'every 6 months' : 'annually';
      const money = (c) => '$' + ((c || 0) / 100).toFixed(2);
      const renewsRow = body.querySelector('#gc-renews-row');
      const renewsEl = body.querySelector('#gc-renews-value');
      if (renewsRow && renewsEl && pb) {
        if (pb.pending_change) {
          renewsEl.innerHTML = `${money(pb.pending_change.new_renewal_amount_cents)} ${cadenceText(pb.pending_change.new_plan)} <span style="color:var(--ink-2);font-weight:500;">(from ${fmtDate(pb.pending_change.effective_date)})</span>`;
          renewsRow.style.display = '';
        } else if (pb.current_renewal_amount_cents != null) {
          renewsEl.innerHTML = `${money(pb.current_renewal_amount_cents)} ${cadenceText(subscription.plan)}${pb.current_period_end ? ` <span style="color:var(--ink-2);font-weight:500;">(next: ${fmtDate(pb.current_period_end)})</span>` : ''}`;
          renewsRow.style.display = '';
        }
      }
      // Fleet Monitoring Yes/No reflects the live Stripe items, and the add/remove
      // button is re-rendered from that truth (the DB flag may briefly lag).
      if (pb) {
        const fleetValEl = body.querySelector('#gc-fleet-value');
        if (fleetValEl) fleetValEl.textContent = pb.current_has_fleet ? 'Yes' : 'No';
        renderFleetAction(subscriptionId, customerId, !!pb.current_has_fleet, pb.pending_change);
      }

      // Pending-change banner + undo control. Handles a plan switch, a Fleet
      // add/remove at renewal, or both. Undo = release the schedule (revert).
      const pendingEl = body.querySelector('#gc-plan-pending');
      if (pendingEl) {
        if (pb && pb.pending_change) {
          const pc = pb.pending_change;
          let msg, undoLabel;
          if (pc.fleet_change === 'removing' && !pc.plan_changed) {
            msg = `<strong>Fleet Monitoring</strong> ends at renewal (${fmtDate(pc.effective_date)}). It stays active until then — no refund or charge now.`;
            undoLabel = 'Keep Fleet Monitoring';
          } else if (pc.fleet_change === 'adding' && !pc.plan_changed) {
            msg = `<strong>Fleet Monitoring</strong> starts at renewal (${fmtDate(pc.effective_date)}).`;
            undoLabel = 'Cancel';
          } else {
            msg = `Switching to <strong>${escapeHtml(planLabel(pc.new_plan))}</strong>${pc.fleet_change === 'removing' ? ' (Fleet Monitoring ends)' : pc.fleet_change === 'adding' ? ' (Fleet Monitoring added)' : ''} at renewal (${fmtDate(pc.effective_date)}). No charge until then.`;
            undoLabel = 'Keep current plan';
          }
          pendingEl.innerHTML = `<div style="margin:6px 0 2px;padding:9px 11px;background:var(--warn-bg);border:1px solid color-mix(in srgb, var(--warn) 35%, transparent);border-radius:6px;font-size:0.83rem;color:var(--warn);line-height:1.45;">`
            + msg
            + ` <button class="btn btn-ghost btn-sm" id="gc-revert-plan-btn" style="margin-left:4px;">${undoLabel}</button></div>`;
          pendingEl.style.display = '';
          const revertBtn = body.querySelector('#gc-revert-plan-btn');
          if (revertBtn) revertBtn.addEventListener('click', () => revertPlanChange(subscriptionId));
        } else {
          pendingEl.style.display = 'none';
          pendingEl.innerHTML = '';
        }
      }

      // Invoices card body
      const invoices = data.recent_invoices || [];
      const invEl = body.querySelector('#gc-invoices-body');
      if (invEl) {
        if (invoices.length === 0) {
          invEl.innerHTML = `<div class="gc-meta-label" style="padding:6px 0;">No invoices yet.</div>`;
        } else {
          const rows = invoices.map(inv => {
            const dateStr = inv.created ? new Date(inv.created * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
            const amt = `$${((inv.amount_paid || 0) / 100).toFixed(2)}`;
            const chipCls = inv.status === 'paid' ? 'badge-ok' : (inv.status === 'open' ? 'badge-warn' : 'badge-neutral');
            const chargeAmt = inv.charge_amount_cents || inv.amount_paid || 0;
            const refunded = inv.amount_refunded_cents || 0;
            // Refund-status chip next to the paid chip.
            let refundChip = '';
            if (refunded > 0 && refunded >= chargeAmt) {
              refundChip = ` <span class="badge badge-neutral">Refunded</span>`;
            } else if (refunded > 0) {
              refundChip = ` <span class="badge badge-warn">Partial refund $${(refunded / 100).toFixed(2)}</span>`;
            }
            // Refund button only when the backend says it's refundable (paid, has a
            // charge, not already fully refunded). Hidden on open/refunded invoices.
            const refundBtn = inv.refundable
              ? `<button class="btn btn-ghost btn-sm" data-refund-invoice="${inv.id}" data-charge-amount="${chargeAmt}" data-refunded="${refunded}" data-amount="${amt}" data-card-brand="${escapeHtml(inv.card_brand || '')}" data-card-last4="${escapeHtml(inv.card_last4 || '')}">${refunded > 0 ? 'Refund more' : 'Refund'}</button>`
              : '';
            // Itemized breakdown, so a bundled charge (add-on + custom billed
            // as ONE payment) reads as one invoice with its pieces — not as
            // possibly-separate money. Single-line invoices (plan renewals,
            // lone ad-hoc charges) render exactly as before, no breakdown.
            const lineItems = inv.line_items || [];
            const breakdown = lineItems.length >= 2
              ? `<div style="margin-top:4px;">${lineItems.map(li =>
                  `<div class="gc-meta-label">${escapeHtml(li.description || 'Item')} &mdash; $${((li.amount_cents || 0) / 100).toFixed(2)}</div>`).join('')}</div>`
              : '';
            return `<div class="gc-card-row">
              <div>
                <div class="gc-meta-value">${escapeHtml(dateStr)} <span style="color:var(--ink-2);font-weight:500;">&middot; ${amt}</span></div>
                <div style="margin-top:4px;"><span class="badge ${chipCls}">${escapeHtml(inv.status || '')}</span>${refundChip}</div>
                ${breakdown}
              </div>
              <div style="display:flex;gap:6px;align-items:center;">
                ${refundBtn}
                <a href="${inv.stripe_dashboard_url}" target="_blank" rel="noopener noreferrer" class="btn btn-ghost btn-sm">View in Stripe <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="7" y1="17" x2="17" y2="7"/><polyline points="8 7 17 7 17 16"/></svg></a>
              </div>
            </div>`;
          }).join('');
          // "Resend receipt" re-sends OUR branded receipt for the most recent
          // (paid) invoice — recent_invoices is newest-first and paid-only.
          const last = invoices[0];
          const custEmail = (subscription && subscription.customer && subscription.customer.email) || '';
          const resendBtn = `<div class="gc-card-actions"><button class="btn btn-secondary btn-sm" id="gc-resend-receipt-btn" data-invoice="${last.id}" data-date="${last.created || ''}" data-amount="${last.amount_paid || 0}" data-email="${escapeHtml(custEmail)}">Resend receipt</button></div>`;
          invEl.innerHTML = rows + resendBtn;
          const resend = body.querySelector('#gc-resend-receipt-btn');
          if (resend) resend.addEventListener('click', () => resendReceipt(subscriptionId, resend));
          body.querySelectorAll('[data-refund-invoice]').forEach(btn => {
            btn.addEventListener('click', () => refundInvoice(
              btn.dataset.refundInvoice,
              parseInt(btn.dataset.chargeAmount, 10) || 0,
              parseInt(btn.dataset.refunded, 10) || 0,
              subscriptionId,
              btn.dataset.cardBrand || null,
              btn.dataset.cardLast4 || null
            ));
          });
          stripDeniedActions(invEl);
        }
      }

      // Fill the invoice tags on charged add-on/adhoc rows (placeholders from
      // invoiceTagSpan): each row whose stored PI matches a recent invoice gets
      // "on the <date> invoice ($X.XX)" — the $85 add-on and the $1 custom
      // charge both visibly point at the same $86 invoice. No match = no tag.
      const invByPi = new Map();
      invoices.forEach(inv => { if (inv.payment_intent_id) invByPi.set(inv.payment_intent_id, inv); });
      body.querySelectorAll('[data-invoice-tag-pi]').forEach(el => {
        const inv = invByPi.get(el.dataset.invoiceTagPi);
        if (!inv || !inv.created) return;
        const d = new Date(inv.created * 1000);
        const dateStr = d.toLocaleDateString('en-US', d.getFullYear() === new Date().getFullYear()
          ? { month: 'short', day: 'numeric' }
          : { month: 'short', day: 'numeric', year: 'numeric' });
        el.innerHTML = ` &middot; on the ${escapeHtml(dateStr)} invoice ($${((inv.amount_paid || 0) / 100).toFixed(2)})`;
      });

      // Reconcile each charged row's refund state against the invoice charge's
      // ACTUAL amount_refunded from Stripe. Per-row refunds annotate the row's
      // notes, but an INVOICE-level refund (or one issued straight from the
      // Stripe dashboard) doesn't — leaving the row reading "Charged" with a
      // live Refund link after the money already went back (double-refund
      // bait). Matching is by the shared PaymentIntent; display-only.
      invoices.forEach(inv => {
        if (!inv.payment_intent_id || !(inv.amount_refunded_cents > 0)) return;
        const spans = Array.from(body.querySelectorAll(`[data-invoice-tag-pi="${CSS.escape(inv.payment_intent_id)}"]`));
        if (!spans.length) return;
        const chargeAmount = inv.charge_amount_cents || 0;
        if (chargeAmount > 0 && inv.amount_refunded_cents >= chargeAmount) {
          // Whole payment returned -> every row it settled is refunded.
          spans.forEach(el => {
            const rowEl = el.closest('.gc-card-row');
            if (!rowEl) return;
            const statusBadge = el.parentElement && el.parentElement.querySelector('.badge');
            if (statusBadge) statusBadge.outerHTML = `<span class="badge badge-neutral">Refunded</span>`;
            rowEl.querySelectorAll('[data-refund-addon], [data-refund-charge]').forEach(b => b.remove());
          });
          return;
        }
        // Partially refunded. Refund money the rows already show from their own
        // notes is accounted for; only an unattributed remainder (i.e. an
        // invoice-level partial refund) needs surfacing. Which line the money
        // belongs to is ambiguous, so say so explicitly — never guess a
        // per-line amount, and keep the Refund control (over-refund attempts
        // are still blocked server-side).
        const notesRefunded = spans.reduce((s, el) => s + (parseInt(el.dataset.rowRefunded, 10) || 0), 0);
        if (inv.amount_refunded_cents <= notesRefunded) return;
        spans.forEach(el => {
          const rowEl = el.closest('.gc-card-row');
          if (!rowEl || rowEl.querySelector('.gc-inv-partial')) return;
          const rowAmount = parseInt(el.dataset.rowAmount, 10) || 0;
          const rowRefunded = parseInt(el.dataset.rowRefunded, 10) || 0;
          if (rowAmount > 0 && rowRefunded >= rowAmount) return; // row already reads Refunded
          if (el.parentElement) el.parentElement.insertAdjacentHTML('beforeend',
            ` <span class="badge badge-warn gc-inv-partial">Invoice partially refunded ($${(inv.amount_refunded_cents / 100).toFixed(2)} of $${(chargeAmount / 100).toFixed(2)})</span>`);
        });
      });

      // Refresh the work-order packet with the ACTUAL signup charge (promo-aware)
      // now that Stripe data is in — replaces the plan-price fallback shown at first paint.
      const pktEl = body.querySelector('#gc-packet');
      if (pktEl && subscription) {
        pktEl.value = buildPacketText(subscription, pendingAddons, data.signup_charge_cents, openVisit);
      }
    } catch (err) {
      console.error('[stripe-data] load failed:', err);
      const fail = `<span style="color:var(--ink-3);font-weight:500;font-size:0.82rem;">Couldn't load &mdash; refresh to retry</span>`;
      const pmEl = body.querySelector('#gc-payment-method-value');
      if (pmEl) pmEl.innerHTML = fail;
      const ltEl = body.querySelector('#gc-lifetime-value');
      if (ltEl) ltEl.innerHTML = fail;
      const invEl = body.querySelector('#gc-invoices-body');
      if (invEl) invEl.innerHTML = `<div class="gc-meta-label" style="padding:6px 0;">Couldn't load invoices &mdash; refresh to retry.</div>`;
    }
  }

  // Text message thread (lazy) — fills #gc-sms-history-body with the
  // customer's complete conversation, oldest first, plus the reply box. Same
  // open-fast pattern as loadStripeData: the modal paints instantly, this
  // fills in after. Loaded when the record opens and on the manual Refresh
  // button ONLY — no polling, no push: the existing office alert email is
  // what says "a reply arrived". A failed load shows a retry note and must
  // never break the modal.
  async function loadSmsHistory(subscriptionId, customerId) {
    const body = document.getElementById('modal-body');
    if (!body) return;
    const el = body.querySelector('#gc-sms-history-body');
    if (!el) return;
    try {
      const r = await BatesAuth.authFetch(`${API_BASE}/api/generator-care/subscriptions/${subscriptionId}/sms-messages`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const { messages = [], reply = null } = await r.json();
      // Newest-first from the API; a failed/blocked latest message surfaces in
      // the collapsed header so it isn't hidden behind the click.
      historyHeaderStamp({
        countId: 'gc-sms-history-count',
        flagId: 'gc-sms-history-flag',
        count: messages.length,
        flagHtml: messages.length && smsNeedsFlag(messages[0]) ? smsHistoryChip(messages[0]) : '',
      });
      const thread = messages.length
        ? `<div class="gc-sms-thread">${messages.slice().reverse().map(renderSmsBubble).join('')}</div>`
        : `<div class="gc-meta-label" style="padding:6px 0;">No texts yet.</div>`;
      el.innerHTML = `<div class="gc-sms-toolbar">
          <span class="gc-meta-label">Not live &mdash; refresh to check for new replies.</span>
          <button type="button" class="btn btn-ghost btn-sm" id="gc-sms-refresh">Refresh</button>
        </div>${thread}${renderSmsReplyBox(reply)}`;
      stripDeniedActions(el);
      const refreshBtn = el.querySelector('#gc-sms-refresh');
      if (refreshBtn) refreshBtn.addEventListener('click', () => { refreshBtn.disabled = true; loadSmsHistory(subscriptionId, customerId); });
      wireSmsReplyBox(el, subscriptionId, customerId, reply);
      // Newest message in view — now, and again when the collapsed card opens
      // (a hidden element can't scroll).
      const scrollToNewest = () => { const t = el.querySelector('.gc-sms-thread'); if (t) t.scrollTop = t.scrollHeight; };
      const card = document.getElementById('gc-card-sms');
      if (card && !card.dataset.smsScrollWired) {
        card.dataset.smsScrollWired = '1';
        card.addEventListener('toggle', () => { if (card.open) scrollToNewest(); });
      }
      scrollToNewest();
    } catch (err) {
      console.error('[sms-history] load failed:', err);
      el.innerHTML = `<div class="gc-meta-label" style="padding:6px 0;">Couldn't load texts &mdash; refresh to retry.</div>`;
    }
  }

  // Email history (lazy) — same open-fast pattern as loadSmsHistory. Empty is
  // the norm until the 033 migration + mailer logging have been live a while.
  async function loadEmailHistory(subscriptionId) {
    const body = document.getElementById('modal-body');
    if (!body) return;
    const el = body.querySelector('#gc-email-history-body');
    if (!el) return;
    try {
      const r = await BatesAuth.authFetch(`${API_BASE}/api/generator-care/subscriptions/${subscriptionId}/email-messages`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const { messages } = await r.json();
      if (!messages || !messages.length) {
        historyHeaderStamp({ countId: 'gc-email-history-count', flagId: 'gc-email-history-flag', count: 0 });
        el.innerHTML = `<div class="gc-meta-label" style="padding:6px 0;">No emails logged yet. (Logging starts with sends made after the email-history update.)</div>`;
        return;
      }
      historyHeaderStamp({
        countId: 'gc-email-history-count',
        flagId: 'gc-email-history-flag',
        count: messages.length,
        flagHtml: emailNeedsFlag(messages[0]) ? emailHistoryChip(messages[0]) : '',
      });
      el.innerHTML = messages.map(renderEmailHistoryRow).join('');
    } catch (err) {
      console.error('[email-history] load failed:', err);
      el.innerHTML = `<div class="gc-meta-label" style="padding:6px 0;">Couldn't load emails &mdash; refresh to retry.</div>`;
    }
  }

  // Record SMS consent for a customer (office path, SMS Phase 1). The confirm
  // spells out what "record consent" legally means — the office should only
  // click it after the customer actually agreed (phone call / at the door).
  async function recordSmsConsent(customer, optIn, subId) {
    const phoneStr = fmtPhoneDisplay(customer.phone) || customer.phone || '';
    const ok = await openConfirm(optIn
      ? {
          title: 'Record text opt-in?',
          message: `Only record this after ${fmtNameCase(customer.name) || 'the customer'} clearly agreed (on the phone or in person) to receive appointment reminder and confirmation texts at ${phoneStr}. This is the legal consent record. They'll get a confirmation text when texting is enabled.`,
          confirmText: 'Customer agreed - record it',
        }
      : {
          title: 'Record text opt-out?',
          message: `Stops all Generator Care texts to ${phoneStr}. Recorded with today's date.`,
          confirmText: 'Record opt-out',
          danger: true,
        });
    if (!ok) return;
    try {
      const r = await BatesAuth.authFetch(`${API_BASE}/api/generator-care/customers/${customer.id}/sms-consent`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ opt_in: optIn }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      showStatus(optIn ? 'Text opt-in recorded.' : 'Text opt-out recorded.', 'success');
      showDetail(subId);
    } catch (err) {
      console.error('[sms-consent] failed:', err);
      showStatus(`Failed: ${err.message}`, 'error');
    }
  }

  // Swap the contact region into edit mode and wire Save/Cancel.
  function enterContactEdit(customer, subId) {
    const region = document.getElementById('gc-contact-region');
    if (!region) return;
    region.innerHTML = renderContactEdit(customer);

    const cancelBtn = document.getElementById('gc-contact-cancel-btn');
    if (cancelBtn) cancelBtn.addEventListener('click', () => {
      region.innerHTML = renderContactRead(customer);
      const editBtn = document.getElementById('gc-contact-edit-btn');
      if (editBtn) editBtn.addEventListener('click', () => enterContactEdit(customer, subId));
    });

    const saveBtn = document.getElementById('gc-contact-save-btn');
    if (saveBtn) saveBtn.addEventListener('click', () => saveContactEdit(customer, subId, saveBtn));

    const firstInput = document.getElementById('gc-edit-name');
    if (firstInput) firstInput.focus();
  }

  async function saveContactEdit(customer, subId, btn) {
    const val = (id) => { const el = document.getElementById(id); return el ? el.value.trim() : ''; };
    const errEl = document.getElementById('gc-contact-error');
    const showErr = (msg) => { if (errEl) { errEl.textContent = msg; errEl.hidden = false; } };

    const payload = {
      name: val('gc-edit-name'),
      phone: val('gc-edit-phone'),
      email: val('gc-edit-email'),
      install_address: val('gc-edit-addr'),
      install_city: val('gc-edit-city'),
      install_state: val('gc-edit-state'),
      install_zip: val('gc-edit-zip'),
    };

    // Required-not-empty on the core fields + email-format check.
    if (!payload.name) return showErr('Full name is required.');
    if (!payload.phone) return showErr('Phone is required.');
    if (!payload.email) return showErr('Email is required.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email)) return showErr('Please enter a valid email address.');
    if (!payload.install_address) return showErr('Street address is required.');
    if (!payload.install_city) return showErr('City is required.');
    if (!payload.install_state) return showErr('State is required.');
    if (!payload.install_zip) return showErr('Zip is required.');

    const original = btn ? btn.textContent : null;
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    try {
      const r = await BatesAuth.authFetch(`${API_BASE}/api/generator-care/customers/${customer.id}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await r.json();
      if (!r.ok) {
        showErr(data.error || `HTTP ${r.status}`);
        if (btn) { btn.disabled = false; btn.textContent = original; }
        return;
      }
      showStatus('Contact & address updated.', 'success');
      // Re-render list + modal so the name in the title/header and the FL branding
      // badge reflect the change immediately (no full page reload).
      await loadSubscriptions();
      showDetail(subId);
    } catch (err) {
      console.error('Save contact failed:', err);
      showErr(err.message);
      if (btn) { btn.disabled = false; btn.textContent = original; }
    }
  }

  // ---- Generator make/model + serial (descriptive only — class/tier untouched) ----
  // Read view: shows class (read-only, sets pricing) + editable make/model + serial.
  function renderGeneratorRead(subscription) {
    return `
      <div class="gc-card-row"><span class="gc-meta-label">Generator</span>
        <span class="gc-meta-value">${escapeHtml(genClassLabel(subscription.gen_class))} &mdash; ${escapeHtml(subscription.gen_model || 'model n/a')}
          <button type="button" class="btn btn-ghost btn-sm" id="gc-generator-edit-btn" style="margin-left:6px;">Edit</button></span>
      </div>
      <div class="gc-card-row"><span class="gc-meta-label">Serial</span><span class="gc-meta-value">${subscription.gen_serial ? escapeHtml(subscription.gen_serial) : '&mdash; (not on file)'}</span></div>`;
  }

  function renderGeneratorEdit(subscription) {
    return `
      <div class="gc-card-row" style="display:block;">
        <div class="gc-meta-label" style="margin-bottom:6px;">Generator make/model + serial &mdash; <span style="opacity:0.8;">class/tier (${escapeHtml(genClassLabel(subscription.gen_class))}) sets pricing and isn&rsquo;t edited here.</span></div>
        <div class="gc-edit-grid">
          <label class="gc-edit-field gc-edit-full"><span>Make / model</span><input type="text" id="gc-gen-model" class="gc-edit-input" value="${escapeHtml(subscription.gen_model || '')}" placeholder="e.g. Generac Guardian 22 kW"></label>
          <label class="gc-edit-field gc-edit-full"><span>Serial number</span><input type="text" id="gc-gen-serial" class="gc-edit-input" value="${escapeHtml(subscription.gen_serial || '')}" placeholder="Serial #"></label>
        </div>
        <div class="gc-edit-error" id="gc-generator-error" hidden></div>
        <div class="gc-note-editor-actions">
          <button type="button" class="btn btn-secondary btn-sm" id="gc-generator-cancel-btn">Cancel</button>
          <button type="button" class="btn btn-primary btn-sm" id="gc-generator-save-btn">Save changes</button>
        </div>
      </div>`;
  }

  function wireGeneratorEditBtn(subscription) {
    const editBtn = document.getElementById('gc-generator-edit-btn');
    if (editBtn) editBtn.addEventListener('click', () => enterGeneratorEdit(subscription));
  }

  function enterGeneratorEdit(subscription) {
    const region = document.getElementById('gc-generator-region');
    if (!region) return;
    region.innerHTML = renderGeneratorEdit(subscription);
    const cancelBtn = document.getElementById('gc-generator-cancel-btn');
    if (cancelBtn) cancelBtn.addEventListener('click', () => {
      region.innerHTML = renderGeneratorRead(subscription);
      wireGeneratorEditBtn(subscription);
    });
    const saveBtn = document.getElementById('gc-generator-save-btn');
    if (saveBtn) saveBtn.addEventListener('click', () => saveGeneratorEdit(subscription, saveBtn));
    const first = document.getElementById('gc-gen-model');
    if (first) first.focus();
  }

  async function saveGeneratorEdit(subscription, btn) {
    const val = (id) => { const el = document.getElementById(id); return el ? el.value.trim() : ''; };
    const errEl = document.getElementById('gc-generator-error');
    const showErr = (msg) => { if (errEl) { errEl.textContent = msg; errEl.hidden = false; } };
    const payload = {
      gen_model: val('gc-gen-model'),
      gen_serial: val('gc-gen-serial'),
      // IDOR guard: require the sub to belong to this customer.
      customer_id: (subscription.customer && subscription.customer.id) || undefined,
    };
    const original = btn ? btn.textContent : null;
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    try {
      const r = await BatesAuth.authFetch(`${API_BASE}/api/generator-care/subscriptions/${subscription.id}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) { showErr(data.error || `HTTP ${r.status}`); if (btn) { btn.disabled = false; btn.textContent = original; } return; }
      showStatus('Generator details updated.', 'success');
      await loadSubscriptions();
      showDetail(subscription.id);
    } catch (err) {
      console.error('Save generator failed:', err);
      showErr(err.message);
      if (btn) { btn.disabled = false; btn.textContent = original; }
    }
  }

  async function saveCustomerNote(customerId, btn) {
    const textarea = document.getElementById('gc-customer-note');
    if (!textarea || !customerId) return;
    const original = btn ? btn.textContent : null;
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    try {
      const r = await BatesAuth.authFetch(`${API_BASE}/api/generator-care/customers/${customerId}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ notes: textarea.value }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      showStatus('Note saved.', 'success');
    } catch (err) {
      console.error('Save note failed:', err);
      showStatus(`Note save failed: ${err.message}`, 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = original; }
    }
  }

  // Re-send OUR branded receipt for the most recent paid invoice (same template +
  // data the customer got automatically when the charge settled).
  async function resendReceipt(subscriptionId, btn) {
    const invoiceId = btn.dataset.invoice;
    const dateStr = btn.dataset.date
      ? new Date(parseInt(btn.dataset.date, 10) * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      : '';
    const amt = '$' + ((parseInt(btn.dataset.amount, 10) || 0) / 100).toFixed(2);
    const email = btn.dataset.email || '';
    if (!await openConfirm({ title: 'Resend receipt?', message: `For ${dateStr} · ${amt}\n\nSends to ${email || 'the customer'}.`, confirmText: 'Resend receipt' })) return;
    const original = btn.textContent;
    btn.disabled = true; btn.textContent = 'Sending…';
    try {
      const r = await BatesAuth.authFetch(`${API_BASE}/api/generator-care/subscriptions/${subscriptionId}/resend-receipt`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoice_id: invoiceId }),
      });
      const data = await r.json();
      if (!r.ok || !data.sent) {
        showStatus(`Resend failed: ${data.error || `HTTP ${r.status}`}`, 'error');
        return;
      }
      showStatus(`Receipt resent${email ? ' to ' + email : ''}.`, 'success');
    } catch (err) {
      console.error('Resend receipt failed:', err);
      showStatus(`Resend failed: ${err.message}`, 'error');
    } finally {
      btn.disabled = false; btn.textContent = original;
    }
  }

  // ---- Refund helpers ----
  // Parses the structured "REFUNDED $X.XX [of $Y.YY] on YYYY-MM-DD ..." markers
  // that the backend appends to notes on every refund. Returns total cents refunded.
  function parseTotalRefundedCents(notes) {
    if (!notes) return 0;
    const matches = String(notes).matchAll(/REFUNDED \$(\d+(?:\.\d+)?)/g);
    let total = 0;
    for (const m of matches) total += Math.round(parseFloat(m[1]) * 100);
    return total;
  }

  // Removes REFUNDED... lines from notes for display purposes (refunds are
  // rendered as badges, not as red failure-style notes).
  function stripRefundLines(notes) {
    if (!notes) return '';
    return String(notes).split('\n').filter(line => !line.trim().startsWith('REFUNDED ')).join('\n').trim();
  }

  // Human card label, e.g. "Mastercard ••3981" — falls back when card unknown.
  function cardLabel(brand, last4) {
    if (!last4) return 'the card on file';
    const b = brand ? brand.charAt(0).toUpperCase() + brand.slice(1) : 'Card';
    return `${b} ••${last4}`;
  }

  // Inline refund mini-dialog. Resolves with { amountCents, reason } after the
  // office user confirms, or null if they cancel. The amount pre-fills to the
  // full refundable balance and is editable down for a partial; amounts <= $0
  // or over the balance are blocked before the confirm step.
  function openRefundDialog({ label, originalCents, alreadyRefundedCents, cardBrand, cardLast4 }) {
    return new Promise((resolve) => {
      const already = alreadyRefundedCents || 0;
      const remaining = (originalCents || 0) - already;
      const remainingDollars = (remaining / 100).toFixed(2);
      const cardText = cardLabel(cardBrand, cardLast4);
      const shortCard = cardLast4 ? `••${cardLast4}` : 'the card on file';

      const overlay = document.createElement('div');
      overlay.className = 'gc-rd-overlay';
      const alreadyRow = already > 0
        ? `<div class="gc-rd-line"><span>Already refunded</span><span>$${(already / 100).toFixed(2)}</span></div>`
        : '';
      overlay.innerHTML = `
        <div class="gc-rd-panel" role="dialog" aria-modal="true" aria-label="Issue refund">
          <h3 class="gc-rd-title">Refund</h3>
          <div class="gc-rd-sub">${escapeHtml(label || '')}</div>
          <div class="gc-rd-summary">
            <div class="gc-rd-line"><span>Original charge</span><span>$${((originalCents || 0) / 100).toFixed(2)}</span></div>
            ${alreadyRow}
            <div class="gc-rd-line gc-rd-line-strong"><span>Refundable balance</span><span>$${remainingDollars}</span></div>
          </div>
          <label class="gc-rd-field"><span>Amount to refund ($)</span>
            <input type="number" class="gc-rd-amount" step="0.01" min="0.01" max="${remainingDollars}" value="${remainingDollars}" inputmode="decimal">
          </label>
          <div class="gc-rd-error" hidden></div>
          <label class="gc-rd-field"><span>Reason (optional)</span>
            <input type="text" class="gc-rd-reason" placeholder="e.g. duplicate charge, courtesy">
          </label>
          <div class="gc-rd-card">Refunds to <strong>${escapeHtml(cardText)}</strong></div>
          <p class="gc-rd-note">Refunding does <strong>not</strong> cancel the plan &mdash; use &ldquo;Cancel Subscription&rdquo; for that. Stripe keeps its original processing fee on refunds (it isn&rsquo;t returned).</p>
          <div class="gc-rd-actions">
            <button type="button" class="btn btn-secondary btn-sm gc-rd-cancel">Cancel</button>
            <button type="button" class="btn btn-primary btn-sm gc-rd-submit">Refund $${remainingDollars}</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);

      const amountEl = overlay.querySelector('.gc-rd-amount');
      const reasonEl = overlay.querySelector('.gc-rd-reason');
      const errEl = overlay.querySelector('.gc-rd-error');
      const submitEl = overlay.querySelector('.gc-rd-submit');
      const cancelEl = overlay.querySelector('.gc-rd-cancel');

      function close(result) {
        document.removeEventListener('keydown', onKey);
        overlay.remove();
        resolve(result);
      }
      function onKey(e) { if (e.key === 'Escape') close(null); }
      document.addEventListener('keydown', onKey);

      function currentCents() {
        const num = parseFloat((amountEl.value || '').trim());
        if (!Number.isFinite(num)) return NaN;
        return Math.round(num * 100);
      }
      function validate() {
        const cents = currentCents();
        let msg = '';
        if (!Number.isFinite(cents) || cents <= 0) msg = 'Enter an amount greater than $0.00.';
        else if (cents > remaining) msg = `Amount can’t exceed the $${remainingDollars} refundable balance.`;
        if (msg) {
          errEl.textContent = msg; errEl.hidden = false;
          submitEl.disabled = true; submitEl.textContent = 'Refund';
        } else {
          errEl.hidden = true;
          submitEl.disabled = false; submitEl.textContent = `Refund $${(cents / 100).toFixed(2)}`;
        }
      }
      amountEl.addEventListener('input', validate);
      validate();

      cancelEl.addEventListener('click', () => close(null));
      overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); });
      submitEl.addEventListener('click', () => {
        const cents = currentCents();
        if (!Number.isFinite(cents) || cents <= 0 || cents > remaining) { validate(); return; }
        // The dialog (amount + "Refund $X" button + can't-undo note) IS the
        // confirmation — no extra native popup.
        close({ amountCents: cents, reason: (reasonEl.value || '').trim() || null });
      });

      setTimeout(() => { amountEl.focus(); amountEl.select(); }, 30);
    });
  }

  async function refundCharge(rowType, rowId, originalAmountCents, alreadyRefundedCents, label, subscriptionId) {
    const remaining = originalAmountCents - (alreadyRefundedCents || 0);
    if (remaining <= 0) {
      showStatus('Already fully refunded.', 'error');
      return;
    }
    // Ad-hoc/addon charges don't carry a per-charge card client-side; the refund
    // posts to the original card server-side regardless — show the card on file.
    const result = await openRefundDialog({
      label,
      originalCents: originalAmountCents,
      alreadyRefundedCents,
      cardBrand: cardOnFile && cardOnFile.brand,
      cardLast4: cardOnFile && cardOnFile.last4,
    });
    if (!result) return;

    const endpoint = rowType === 'addon'
      ? `${API_BASE}/api/generator-care/addons/${rowId}/refund`
      : `${API_BASE}/api/generator-care/adhoc-charges/${rowId}/refund`;

    try {
      const r = await BatesAuth.authFetch(endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount_cents: result.amountCents, reason: result.reason }),
      });
      const data = await r.json();
      if (!r.ok) {
        // A refund that did NOT happen must never hide in the corner toast —
        // block with a must-acknowledge dialog (Stripe shows no refund).
        await openAlert({ title: 'Refund NOT issued', message: `${label}: ${data.error || `HTTP ${r.status}`}`, danger: true });
        return;
      }
      openSuccessFlash({ title: 'Refund issued', message: `Refunded $${(data.amount_cents / 100).toFixed(2)} for ${label}.` });
      await loadSubscriptions();
      showDetail(subscriptionId);
    } catch (err) {
      console.error('Refund failed:', err);
      await openAlert({ title: 'Refund NOT issued', message: `${label}: ${err.message}`, danger: true });
    }
  }

  // Refund a paid subscription/plan invoice. Independent of cancellation — the
  // confirm copy makes that explicit so Amy doesn't conflate the two.
  async function refundInvoice(invoiceId, chargeAmountCents, alreadyRefundedCents, subscriptionId, cardBrand, cardLast4) {
    const remaining = (chargeAmountCents || 0) - (alreadyRefundedCents || 0);
    if (remaining <= 0) {
      showStatus('This invoice is already fully refunded.', 'error');
      return;
    }
    const result = await openRefundDialog({
      label: 'Plan charge (subscription invoice)',
      originalCents: chargeAmountCents,
      alreadyRefundedCents,
      // Exact card from the invoice's charge; fall back to the card on file.
      cardBrand: cardBrand || (cardOnFile && cardOnFile.brand),
      cardLast4: cardLast4 || (cardOnFile && cardOnFile.last4),
    });
    if (!result) return;

    try {
      const r = await BatesAuth.authFetch(`${API_BASE}/api/generator-care/invoices/${invoiceId}/refund`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount_cents: result.amountCents, reason: result.reason }),
      });
      const data = await r.json();
      if (!r.ok) {
        await openAlert({ title: 'Refund NOT issued', message: data.error || `HTTP ${r.status}`, danger: true });
        return;
      }
      openSuccessFlash({ title: 'Refund issued', message: `Refunded $${(data.amount_cents / 100).toFixed(2)} to the customer's card.` });
      showDetail(subscriptionId);
    } catch (err) {
      console.error('Invoice refund failed:', err);
      await openAlert({ title: 'Refund NOT issued', message: err.message, danger: true });
    }
  }

})();
