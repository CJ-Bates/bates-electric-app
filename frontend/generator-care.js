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
    window.location.replace('index.html');
    return;
  }

  // State
  let allSubs = [];
  let activeFilter = 'all';
  let searchQuery = '';
  let currentUserEmail = null;
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
      if (profile.role !== 'office') {
        showStatus('Access denied. Office role required.', 'error');
        setTimeout(() => window.location.replace('home.html'), 1500);
        return;
      }
      currentUserEmail = profile.email || null;
      // Prefill the admin test-email "Send to" with the logged-in user's email
      const adminEmailInput = document.getElementById('gc-test-email');
      if (adminEmailInput && currentUserEmail && !adminEmailInput.value) {
        adminEmailInput.value = currentUserEmail;
      }
    } catch (err) {
      console.error('Role check failed:', err);
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
      render();
      showLoading(false);
    } catch (err) {
      console.error('Load failed:', err);
      showStatus(`Load failed: ${err.message}`, 'error');
      showLoading(false);
    }
  }

  // ---- Filtering / classification ----
  function daysUntil(dateStr) {
    if (!dateStr) return null;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const target = new Date(dateStr + 'T00:00:00');
    return Math.floor((target - today) / (1000 * 60 * 60 * 24));
  }

  function bucket(sub) {
    if (sub.status !== 'active') return 'inactive';
    const d = daysUntil(sub.next_visit_due);
    if (d === null) return 'unknown';
    if (d < 0) return 'overdue';
    if (d <= 14) return 'soon';
    if (d <= 31) return 'month';
    return 'future';
  }

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
    return allSubs.filter(sub => {
      if (!matchesSearch(sub)) return false;
      const b = bucket(sub);
      if (activeFilter === 'all') return b === 'overdue' || b === 'soon' || b === 'month' || b === 'future';
      if (activeFilter === 'overdue') return b === 'overdue';
      if (activeFilter === 'soon') return b === 'overdue' || b === 'soon';
      if (activeFilter === 'month') return b === 'overdue' || b === 'soon' || b === 'month';
      return true;
    });
  }

  // ---- Render ----
  function render() {
    // Update tab counts
    let cOver = 0, cSoon = 0, cMonth = 0, cAll = 0;
    for (const s of allSubs.filter(matchesSearch)) {
      const b = bucket(s);
      if (b === 'overdue') { cOver++; cSoon++; cMonth++; cAll++; }
      else if (b === 'soon') { cSoon++; cMonth++; cAll++; }
      else if (b === 'month') { cMonth++; cAll++; }
      else if (b === 'future') { cAll++; }
    }
    document.getElementById('count-all').textContent = cAll;
    document.getElementById('count-overdue').textContent = cOver;
    document.getElementById('count-soon').textContent = cSoon;
    document.getElementById('count-month').textContent = cMonth;

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
  function fmtDateTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    return d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  }
  // Absolute instant -> a datetime-local input value in the viewer's local tz.
  function toLocalInput(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
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

  function rowHTML(sub) {
    const b = bucket(sub);
    const rowClass = b === 'overdue' ? 'overdue' : (b === 'soon' ? 'soon' : '');
    const cust = sub.customer || {};
    const fleet = sub.fleet_monitoring ? '<span class="chip" title="Fleet Monitoring enabled">FM</span>' : '';
    return `
      <tr class="gc-row ${rowClass}" data-sub-id="${sub.id}">
        <td>
          <div class="gc-customer-name">${escapeHtml(fmtNameCase(cust.name))}</div>
          <div class="gc-customer-meta">${escapeHtml(fmtNameCase(cust.install_city))}, ${escapeHtml(cust.install_state)} · ${escapeHtml(fmtPhoneDisplay(cust.phone))}</div>
        </td>
        <td class="gc-gen-info">
          ${escapeHtml(genClassLabel(sub.gen_class))}<br>
          <span class="gc-customer-meta">${escapeHtml(sub.gen_model || 'Model n/a')}</span>
        </td>
        <td>${escapeHtml(planLabel(sub.plan))} ${fleet}</td>
        <td>${dueLabel(sub)}</td>
        <td>${listStatusBadge(sub)}</td>
      </tr>
    `;
  }

  function cardHTML(sub) {
    const b = bucket(sub);
    const cardClass = b === 'overdue' ? 'overdue' : (b === 'soon' ? 'soon' : '');
    const dueClass = b === 'overdue' ? 'overdue' : (b === 'soon' ? 'soon' : '');
    const cust = sub.customer || {};
    return `
      <div class="gc-card ${cardClass}" data-sub-id="${sub.id}">
        <div class="gc-card-header">
          <div>
            <div class="gc-card-name">${escapeHtml(fmtNameCase(cust.name))}</div>
            <div class="gc-card-meta">${escapeHtml(fmtNameCase(cust.install_city))} · ${escapeHtml(genClassLabel(sub.gen_class))} · ${escapeHtml(planLabel(sub.plan))}</div>
          </div>
          ${listStatusBadge(sub)}
        </div>
        <div class="gc-card-due ${dueClass}">Due: ${dueLabel(sub)}</div>
      </div>
    `;
  }

  function badgeForBucket(b) {
    if (b === 'overdue') return '<span class="badge badge-danger">Overdue</span>';
    if (b === 'soon') return '<span class="badge badge-warn">Soon</span>';
    return '<span class="badge badge-ok">Active</span>';
  }

  // List STATUS column: surface visit scheduling state at a glance. Booked
  // appointment -> "Scheduled <date>" (ok); otherwise "Needs scheduling" —
  // danger when overdue, warn otherwise (per the v3 status semantics).
  // Inactive/canceled subs read neutral.
  function listStatusBadge(sub) {
    const pill = (intent, text) => `<span class="badge ${intent}">${escapeHtml(text)}</span>`;
    if (sub.status !== 'active') return pill('badge-neutral', (sub.status || 'inactive').replace(/^\w/, c => c.toUpperCase()));
    const ov = sub.open_visit;
    if (ov && ov.appointment_at) {
      return pill('badge-ok', `Scheduled ${fmtDate(String(ov.appointment_at).slice(0, 10))}`);
    }
    const b = bucket(sub);
    if (b === 'overdue') return pill('badge-danger', 'Needs scheduling');
    return pill('badge-warn', 'Needs scheduling');
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

  function renderContactCard(customer) {
    return `
      <div class="gc-card">
        <div id="gc-contact-region">${renderContactRead(customer)}</div>
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
      <div class="gc-card">
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
          <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
            <span class="gc-meta-label">Next due (target)</span>
            <span class="gc-meta-value">
              <input type="date" id="gc-next-visit-input" value="${subscription.next_visit_due || ''}" style="padding:4px 8px;border:1px solid var(--line);border-radius:4px;font-size:0.85rem;font-family:inherit;" />
              <button class="btn btn-secondary btn-sm" id="gc-next-visit-save" style="margin-left:6px;">Save</button>
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
  // record (customers are not invoiced). Copy with "Copy packet".
  function buildPacketText(sub, pendingAddons, actualChargeCents) {
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
    return lines.map(([k, v]) => `${k}: ${v}`).join('\n');
  }

  // Internal Jonas work-order record. Brenda keys the work order into Jonas for
  // internal records; customers are NOT invoiced (their document of record is the
  // branded receipt). Distinct from the Service-Visit card.
  function renderHandoffCard(subscription, pendingAddons) {
    const woAt = subscription.work_order_created_at;
    const woBy = subscription.work_order_created_by;
    const woNum = subscription.work_order_number;
    const packet = escapeHtml(buildPacketText(subscription, pendingAddons));

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
      <div class="gc-card">
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

  // Three clear states per visit: Needs scheduling (due, not booked) / Scheduled
  // (booked appointment date+time) / Completed. The plan-driven DUE date stays
  // separate and is shown as context.
  function renderVisitsCard(visits, subscription) {
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
        badge = `<span class="badge badge-ok">Scheduled &middot; ${escapeHtml(fmtDateTime(v.appointment_at))}</span>`;
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

      let actions = '';
      if (!completed) {
        const localVal = v.appointment_at ? toLocalInput(v.appointment_at) : '';
        actions = `
          <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:8px;">
            <label class="gc-meta-label" style="display:flex;align-items:center;gap:5px;">Assign tech:
              <select class="gc-assign-select" data-assign-visit="${v.id}" style="padding:4px 8px;border:1px solid var(--line);border-radius:4px;font-size:0.85rem;font-family:inherit;">${techOptions(v.assigned_tech_id)}</select>
            </label>
          </div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:6px;">
            <input type="datetime-local" class="gc-appt-input" data-visit="${v.id}" value="${localVal}" style="padding:4px 8px;border:1px solid var(--line);border-radius:4px;font-size:0.85rem;font-family:inherit;" />
            <button class="btn btn-secondary btn-sm" data-schedule-visit="${v.id}">${scheduled ? 'Reschedule' : 'Book appointment'}</button>
            <button class="btn btn-primary btn-sm" data-complete-visit="${v.id}">Mark complete</button>
          </div>`;
      }
      // Notes: customer-visible (on completed) + internal (office/tech only).
      const noteLines = [];
      if (completed && v.notes) noteLines.push(`<div class="gc-meta-label" style="margin-top:4px;">Customer note: ${escapeHtml(v.notes)}</div>`);
      if (v.internal_note) noteLines.push(`<div class="gc-meta-label" style="margin-top:4px;background:var(--warn-bg);border:1px solid color-mix(in srgb, var(--warn) 35%, transparent);border-radius:6px;padding:5px 8px;color:var(--warn);">Internal: ${escapeHtml(v.internal_note)}</div>`);

      const due = !completed ? dueCtx(v) : null;
      return `<div class="gc-card-row" style="display:block;">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;">
          <div>
            <div class="gc-meta-value">${escapeHtml(v.visit_type === 'regular_service' ? 'Regular service' : 'On-demand')}</div>
            ${due ? `<div class="gc-meta-label" style="margin-top:2px;">Due ${escapeHtml(due)}</div>` : ''}
            ${audit.length ? `<div class="gc-meta-label" style="margin-top:2px;opacity:0.85;">${audit.join(' &middot; ')}</div>` : ''}
          </div>
          <div style="flex-shrink:0;">${badge}</div>
        </div>
        ${noteLines.join('')}
        ${actions}
      </div>`;
    }).join('');
    const body = rows || `<div class="gc-meta-label" style="padding:6px 0;">No visits on record.</div>`;
    return `<div class="gc-card"><h3 class="gc-card-h">Service Visits<span class="gc-card-h-count">(${(visits || []).length})</span></h3>${body}</div>`;
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

  function renderAddonsCard(pending_addons, isCanceled, openVisitId, subscription) {
    const visible = (pending_addons || []).filter(a => a.status !== 'canceled');
    // Current cycle = add-ons on the open visit; history = charged add-ons from
    // prior cycles (kept, shown collapsed). Active add-ons always sit in current.
    const history = visible.filter(a => a.status === 'charged' && (!openVisitId || a.service_visit_id !== openVisitId));
    const histSet = new Set(history);
    const current = visible.filter(a => !histSet.has(a));

    const headerAction = isCanceled ? '' : `<button class="btn btn-secondary btn-sm" id="gc-add-addon-btn">+ Add Add-on</button>`;
    const header = `<h3 class="gc-card-h"><span>Add-ons<span class="gc-card-h-count">(${current.length})</span></span>${headerAction}</h3>`;

    const currentRows = current.length
      ? current.map(addonRowHtml).join('')
      : `<div class="gc-meta-label" style="padding:6px 0;">No add-ons this cycle${isCanceled ? '.' : ' &mdash; click "+ Add Add-on" to add one.'}</div>`;

    // One combined "charge performed add-ons" action for the current visit.
    const performedUnbilled = current.filter(a => a.status === 'performed' && a.amount_cents > 0);
    const performedTotal = performedUnbilled.reduce((s, a) => s + a.amount_cents, 0);
    const batchBtn = (!isCanceled && performedUnbilled.length)
      ? `<div class="gc-card-row" style="justify-content:flex-end;border-top:1px solid var(--line);padding-top:10px;margin-top:4px;">
          <button class="btn btn-primary btn-sm" id="gc-charge-addons-btn">Charge performed add-ons ($${(performedTotal/100).toFixed(2)})</button>
        </div>`
      : '';

    // Standing add-ons editor (which recurring types auto-return each visit).
    const standing = new Set((subscription && subscription.standing_addons) || []);
    const recurringAvail = availableRecurringTypes(subscription && subscription.gen_class);
    const standingHtml = (!isCanceled && recurringAvail.length)
      ? `<div style="border-top:1px solid var(--line);margin-top:10px;padding-top:8px;">
          <div class="gc-meta-label" style="margin-bottom:6px;">Standing add-ons <span style="opacity:0.75;font-weight:400;">&mdash; auto-return as Pending each visit</span></div>
          ${recurringAvail.map(t => `<label style="display:flex;align-items:center;gap:8px;padding:3px 0;font-size:0.88rem;cursor:pointer;">
            <input type="checkbox" class="gc-standing-cb" data-type="${escapeHtml(t)}"${standing.has(t) ? ' checked' : ''} />
            <span>${escapeHtml(addonLabel(t))}</span>
          </label>`).join('')}
        </div>`
      : '';

    const historyHtml = history.length
      ? `<details style="border-top:1px solid var(--line);margin-top:10px;padding-top:8px;">
          <summary style="cursor:pointer;font-size:0.85rem;color:var(--ink-2);font-weight:600;">Past visits / history (${history.length})</summary>
          <div style="margin-top:6px;">${history.map(addonRowHtml).join('')}</div>
        </details>`
      : '';

    return `<div class="gc-card">${header}${currentRows}${batchBtn}${standingHtml}${historyHtml}</div>`;
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

  async function showDetail(id) {
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
      const { subscription, visits, pending_addons, adhoc_charges = [] } = await r.json();
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
        renderContactCard(c) +
        renderPlanCard(subscription, isCanceled) +
        renderHandoffCard(subscription, pending_addons) +
        renderVisitsCard(visits, subscription) +
        renderAddonsCard(pending_addons, isCanceled, openVisitId, subscription) +
        renderChargesCard(adhoc_charges, isCanceled) +
        renderInvoicesCard() +
        renderDangerZone(isCanceled, subscription);

      // ---- Wire up event handlers (existing logic, new button IDs/classes) ----
      body.querySelectorAll('[data-complete-visit]').forEach(btn => {
        btn.addEventListener('click', () => completeVisit(btn.dataset.completeVisit, id));
      });
      body.querySelectorAll('[data-schedule-visit]').forEach(btn => {
        btn.addEventListener('click', () => scheduleAppointment(btn.dataset.scheduleVisit, id));
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

      // Kick off lazy Stripe enrichment (fills payment method, lifetime, invoices,
      // and the work-order packet's actual signup charge)
      loadStripeData(id, subscription, pending_addons, c.id);

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
      showStatus(`Charged ${money(data.total_cents)} for ${data.charged_count} add-on${data.charged_count === 1 ? '' : 's'}.`, 'success');
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
        showStatus(`Charged ${amount.toFixed(2)} successfully.`, 'success');
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
        showStatus(`Subscription canceled.${through}`, 'success');
      }
      await loadSubscriptions();
      showDetail(subscriptionId);
    } catch (err) {
      console.error('Cancel subscription failed:', err);
      showStatus(`Cancel failed: ${err.message}`, 'error');
    }
  }

  // Book (or reschedule) an appointment date+time -> the visit becomes "Scheduled".
  // Reads the inline datetime-local input next to the visit. The single backend
  // "schedule" action is where a future SMS confirmation will hang.
  async function scheduleAppointment(visitId, subscriptionId) {
    const input = document.querySelector(`.gc-appt-input[data-visit="${visitId}"]`);
    if (!input || !input.value) {
      showStatus('Pick an appointment date and time first.', 'error');
      return;
    }
    // datetime-local is local wall-clock; convert to an absolute instant to store.
    const when = new Date(input.value);
    if (isNaN(when.getTime())) {
      showStatus('That date/time isn’t valid.', 'error');
      return;
    }
    try {
      const r = await BatesAuth.authFetch(`${API_BASE}/api/generator-care/visits/${visitId}/schedule`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ appointment_at: when.toISOString() }),
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

  // ---- Manage techs ----
  async function openTechsModal() {
    document.getElementById('techsModal').hidden = false;
    document.getElementById('techs-list').innerHTML = '<p class="gc-meta-label">Loading…</p>';
    await loadTechs();
    renderTechsList();
  }
  function closeTechsModal() { document.getElementById('techsModal').hidden = true; }

  function renderTechsList() {
    const el = document.getElementById('techs-list');
    if (!el) return;
    if (!techList.length) { el.innerHTML = '<p class="gc-meta-label">No tech accounts yet.</p>'; return; }
    el.innerHTML = techList.map((t) => {
      const inactive = t.active === false;
      return `<div class="gc-card-row" style="display:flex;justify-content:space-between;align-items:center;gap:8px;${inactive ? 'opacity:0.6;' : ''}">
        <div>
          <div class="gc-meta-value">${escapeHtml(t.full_name || '(no name)')}${inactive ? ' <span class="gc-meta-label">— inactive</span>' : ''}</div>
          <div class="gc-meta-label">${escapeHtml(t.email)}</div>
        </div>
        <div style="display:flex;gap:6px;flex-shrink:0;">
          <button class="btn btn-secondary btn-sm" data-resend-tech="${escapeHtml(t.id)}">Resend link</button>
          <button class="btn ${inactive ? 'btn-primary' : 'btn-secondary'} btn-sm" data-toggle-tech="${escapeHtml(t.id)}" data-active="${inactive ? '1' : '0'}">${inactive ? 'Reactivate' : 'Deactivate'}</button>
        </div>
      </div>`;
    }).join('');
    el.querySelectorAll('[data-toggle-tech]').forEach((b) => {
      b.addEventListener('click', () => setTechActive(b.dataset.toggleTech, b.dataset.active === '1'));
    });
    el.querySelectorAll('[data-resend-tech]').forEach((b) => {
      b.addEventListener('click', () => resendTechInvite(b.dataset.resendTech));
    });
  }

  async function addTech() {
    const name = (document.getElementById('new-tech-name').value || '').trim();
    const email = (document.getElementById('new-tech-email').value || '').trim();
    if (!name || !email) { showStatus('Enter a name and email.', 'error'); return; }
    try {
      const r = await BatesAuth.authFetch(`${API_BASE}/api/generator-care/techs`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) { showStatus(data.error || `HTTP ${r.status}`, 'error'); return; }
      showStatus(data.warning || `Invited ${name}. They'll get a set-password email.`, data.warning ? 'warning' : 'success');
      document.getElementById('new-tech-name').value = '';
      document.getElementById('new-tech-email').value = '';
      await loadTechs();
      renderTechsList();
    } catch (e) {
      console.error('add tech failed', e);
      showStatus(`Failed: ${e.message}`, 'error');
    }
  }

  async function setTechActive(id, active) {
    try {
      const r = await BatesAuth.authFetch(`${API_BASE}/api/generator-care/techs/${id}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ active }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) { showStatus(data.error || `HTTP ${r.status}`, 'error'); return; }
      showStatus(active ? 'Tech reactivated.' : 'Tech deactivated.', 'success');
      await loadTechs();
      renderTechsList();
    } catch (e) {
      console.error('toggle tech failed', e);
      showStatus(`Failed: ${e.message}`, 'error');
    }
  }

  async function resendTechInvite(id) {
    try {
      const r = await BatesAuth.authFetch(`${API_BASE}/api/generator-care/techs/${id}/resend-invite`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) { showStatus(data.error || `HTTP ${r.status}`, 'error'); return; }
      showStatus('Set-password link re-sent.', 'success');
    } catch (e) {
      console.error('resend invite failed', e);
      showStatus(`Failed: ${e.message}`, 'error');
    }
  }

  function closeModal() {
    document.getElementById('detailsModal').hidden = true;
  }

  // ---- Helpers ----
  function showLoading(b) {
    document.getElementById('loading').hidden = !b;
  }
  // ---- Init ----
  checkRole();
  loadTechs();

  document.getElementById('refresh-btn').addEventListener('click', loadSubscriptions);

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

  // Manage techs modal
  document.getElementById('manage-techs-btn').addEventListener('click', openTechsModal);
  document.getElementById('techs-close-btn').addEventListener('click', closeTechsModal);
  document.getElementById('techs-close-btn2').addEventListener('click', closeTechsModal);
  document.getElementById('techs-overlay').addEventListener('click', closeTechsModal);
  document.getElementById('add-tech-btn').addEventListener('click', addTech);

  loadSubscriptions();

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
      showStatus(`Scheduled switch to ${targetLabel} at renewal (${fmtDate(data.effective_date)}). No charge today.`, 'success');
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
      showStatus('Fleet Monitoring added — prorated charge billed to the card on file.', 'success');
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
      showStatus(`Fleet Monitoring will end at renewal (${fmtDate(data.effective_date)}).`, 'success');
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
      showStatus(`Changed to ${tierLabel}.`, 'success');
      await loadSubscriptions();
      showDetail(subscription.id);
    } catch (e) {
      console.error('tier-change failed:', e);
      showStatus(`Couldn't change tier: ${e.message}`, 'error');
    }
  }

  async function loadStripeData(subscriptionId, subscription, pendingAddons, customerId) {
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
      const invEl = body.querySelector('#gc-invoices-body');
      if (invEl) {
        const invoices = data.recent_invoices || [];
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
            return `<div class="gc-card-row">
              <div>
                <div class="gc-meta-value">${escapeHtml(dateStr)} <span style="color:var(--ink-2);font-weight:500;">&middot; ${amt}</span></div>
                <div style="margin-top:4px;"><span class="badge ${chipCls}">${escapeHtml(inv.status || '')}</span>${refundChip}</div>
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
        }
      }

      // Refresh the work-order packet with the ACTUAL signup charge (promo-aware)
      // now that Stripe data is in — replaces the plan-price fallback shown at first paint.
      const pktEl = body.querySelector('#gc-packet');
      if (pktEl && subscription) {
        pktEl.value = buildPacketText(subscription, pendingAddons, data.signup_charge_cents);
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
        showStatus(`Refund failed: ${data.error || `HTTP ${r.status}`}`, 'error');
        return;
      }
      showStatus(`Refunded $${(data.amount_cents / 100).toFixed(2)}.`, 'success');
      await loadSubscriptions();
      showDetail(subscriptionId);
    } catch (err) {
      console.error('Refund failed:', err);
      showStatus(`Refund failed: ${err.message}`, 'error');
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
        showStatus(`Refund failed: ${data.error || `HTTP ${r.status}`}`, 'error');
        return;
      }
      showStatus(`Refunded $${(data.amount_cents / 100).toFixed(2)} to the customer's card.`, 'success');
      showDetail(subscriptionId);
    } catch (err) {
      console.error('Invoice refund failed:', err);
      showStatus(`Refund failed: ${err.message}`, 'error');
    }
  }

})();
