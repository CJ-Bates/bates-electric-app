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

  // ---- Role check (must be office) ----
  async function checkRole() {
    try {
      const r = await fetch(`${API_BASE}/me`, {
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
      const r = await fetch(`${API_BASE}/api/generator-care/subscriptions`, {
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
  function genClassLabel(c) {
    return ({
      air_cooled: 'Air Cooled',
      liquid_22_38: 'Liquid 22-38 KW',
      liquid_48_150: 'Liquid 48-150 KW',
    })[c] || c;
  }
  function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = s == null ? '' : String(s);
    return d.innerHTML;
  }
  function fmtDate(dateStr) {
    if (!dateStr) return '—';
    return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
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
    const fleet = sub.fleet_monitoring ? '<span class="gc-badge gc-badge-fleet" title="Fleet Monitoring enabled">FM</span>' : '';
    return `
      <tr class="gc-row ${rowClass}" data-sub-id="${sub.id}">
        <td>
          <div class="gc-customer-name">${escapeHtml(cust.name)}</div>
          <div class="gc-customer-meta">${escapeHtml(cust.install_city)}, ${escapeHtml(cust.install_state)} · ${escapeHtml(cust.phone)}</div>
        </td>
        <td class="gc-gen-info">
          ${escapeHtml(genClassLabel(sub.gen_class))}<br>
          <span class="gc-customer-meta">${escapeHtml(sub.gen_model || 'Model n/a')}</span>
        </td>
        <td>${escapeHtml(planLabel(sub.plan))} ${fleet}</td>
        <td>${dueLabel(sub)}</td>
        <td>${badgeForBucket(b)}</td>
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
            <div class="gc-card-name">${escapeHtml(cust.name)}</div>
            <div class="gc-card-meta">${escapeHtml(cust.install_city)} · ${escapeHtml(genClassLabel(sub.gen_class))} · ${escapeHtml(planLabel(sub.plan))}</div>
          </div>
          ${badgeForBucket(b)}
        </div>
        <div class="gc-card-due ${dueClass}">Next visit: ${dueLabel(sub)}</div>
      </div>
    `;
  }

  function badgeForBucket(b) {
    if (b === 'overdue') return '<span class="gc-badge gc-badge-overdue">Overdue</span>';
    if (b === 'soon') return '<span class="gc-badge gc-badge-soon">Soon</span>';
    return '<span class="gc-badge gc-badge-active">Active</span>';
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
    const cls = `gc-status-pill-${status || 'active'}`;
    return `<span class="gc-status-pill ${cls}">${escapeHtml(status || 'active')}</span>`;
  }

  function renderHeaderBar(customer, subscription) {
    const phone = customer.phone || '';
    const email = customer.email || '';
    const stripeId = subscription.stripe_customer_id;
    const stripeLink = stripeId
      ? `<a href="https://dashboard.stripe.com/customers/${encodeURIComponent(stripeId)}" target="_blank" rel="noopener noreferrer">Open in Stripe &#8599;</a>`
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

  function renderContactCard(customer) {
    const addrLine = [customer.install_address, customer.install_city, customer.install_state, customer.install_zip].filter(Boolean).join(', ');
    return `
      <div class="gc-card">
        <h3 class="gc-card-h">Contact &amp; Address</h3>
        <div class="gc-card-row"><span class="gc-meta-label">Phone</span><span class="gc-meta-value">${escapeHtml(customer.phone) || '&mdash;'}</span></div>
        <div class="gc-card-row"><span class="gc-meta-label">Email</span><span class="gc-meta-value">${escapeHtml(customer.email) || '&mdash;'}</span></div>
        <div class="gc-card-row"><span class="gc-meta-label">Install address</span><span class="gc-meta-value">${escapeHtml(addrLine) || '&mdash;'}</span></div>
        <div class="gc-note-editor">
          <span class="gc-meta-label" style="display:block;margin-bottom:6px;">Internal note (office only)</span>
          <textarea id="gc-customer-note" data-customer-id="${customer.id}" placeholder="Anything Amy or Brenda should know about this customer.">${escapeHtml(customer.notes || '')}</textarea>
          <div class="gc-note-editor-actions">
            <button class="gc-btn gc-btn-secondary gc-btn-sm" id="gc-save-note-btn">Save note</button>
          </div>
        </div>
      </div>`;
  }

  function renderPlanCard(subscription, isCanceled) {
    const annual = subscription.annual_price_cents ? `$${(subscription.annual_price_cents/100).toFixed(2)}/yr` : '&mdash;';
    const lastVisitText = subscription.last_visit_date ? fmtDate(subscription.last_visit_date) : '&mdash; (none yet)';
    const accountActions = isCanceled ? '' : `
      <div class="gc-card-actions">
        <button class="gc-btn gc-btn-secondary gc-btn-sm" id="gc-resend-welcome-btn">Resend Welcome</button>
        <button class="gc-btn gc-btn-secondary gc-btn-sm" id="gc-portal-btn">Send Card-Update Link</button>
      </div>`;
    return `
      <div class="gc-card">
        <h3 class="gc-card-h">Plan &amp; Billing</h3>
        <div class="gc-card-row"><span class="gc-meta-label">Plan</span><span class="gc-meta-value">${escapeHtml(planLabel(subscription.plan))}</span></div>
        <div class="gc-card-row"><span class="gc-meta-label">Generator</span><span class="gc-meta-value">${escapeHtml(genClassLabel(subscription.gen_class))} &mdash; ${escapeHtml(subscription.gen_model || 'model n/a')}</span></div>
        ${subscription.gen_serial ? `<div class="gc-card-row"><span class="gc-meta-label">Serial</span><span class="gc-meta-value">${escapeHtml(subscription.gen_serial)}</span></div>` : ''}
        <div class="gc-card-row"><span class="gc-meta-label">Fleet Monitoring</span><span class="gc-meta-value">${subscription.fleet_monitoring ? 'Yes' : 'No'}</span></div>
        <div class="gc-card-row"><span class="gc-meta-label">Annual price</span><span class="gc-meta-value">${annual}</span></div>
        <div class="gc-card-row"><span class="gc-meta-label">Signed up</span><span class="gc-meta-value">${fmtDate(subscription.signup_date)}</span></div>
        <div class="gc-card-row"><span class="gc-meta-label">Last visit</span><span class="gc-meta-value">${lastVisitText}</span></div>
        <div class="gc-card-row">
          <span class="gc-meta-label">Next visit due</span>
          <span class="gc-meta-value">
            <input type="date" id="gc-next-visit-input" value="${subscription.next_visit_due || ''}" style="padding:4px 8px;border:1px solid #d1d5db;border-radius:4px;font-size:0.85rem;font-family:inherit;" />
            <button class="gc-btn gc-btn-secondary gc-btn-sm" id="gc-next-visit-save" style="margin-left:6px;">Save</button>
          </span>
        </div>
        <div class="gc-card-row" id="gc-payment-method-row"><span class="gc-meta-label">Payment method</span><span class="gc-meta-value" id="gc-payment-method-value"><span class="gc-skeleton gc-skeleton-line gc-skeleton-text-md"></span></span></div>
        <div class="gc-card-row" id="gc-lifetime-row"><span class="gc-meta-label">Lifetime billed</span><span class="gc-meta-value" id="gc-lifetime-value"><span class="gc-skeleton gc-skeleton-line gc-skeleton-text-sm"></span></span></div>
        ${accountActions}
      </div>`;
  }

  function renderVisitsCard(visits) {
    const rows = (visits || []).map(v => {
      const date = v.completed_date
        ? `Completed ${fmtDate(v.completed_date)}`
        : v.status === 'tentative'
          ? `Tentative &mdash; ${fmtDate(v.scheduled_date)} (needs confirmation)`
          : `Scheduled ${fmtDate(v.scheduled_date)}`;
      let action;
      if (v.status === 'tentative') {
        action = `<div style="display:flex;gap:6px;flex-wrap:wrap;">
          <button class="gc-btn gc-btn-secondary gc-btn-sm" data-confirm-visit="${v.id}">Confirm</button>
          <button class="gc-btn gc-btn-primary gc-btn-sm" data-complete-visit="${v.id}">Mark complete</button>
        </div>`;
      } else if (v.status === 'scheduled') {
        action = `<button class="gc-btn gc-btn-primary gc-btn-sm" data-complete-visit="${v.id}">Mark complete</button>`;
      } else if (v.status === 'completed') {
        action = `<span class="gc-chip gc-chip-completed">Completed</span>`;
      } else {
        action = `<span class="gc-chip">${escapeHtml(v.status)}</span>`;
      }
      return `<div class="gc-card-row">
        <div>
          <div class="gc-meta-value">${escapeHtml(v.visit_type === 'regular_service' ? 'Regular service' : 'On-demand')}</div>
          <div class="gc-meta-label" style="margin-top:2px;">${date}</div>
        </div>
        <div>${action}</div>
      </div>`;
    }).join('');
    const body = rows || `<div class="gc-meta-label" style="padding:6px 0;">No visits on record.</div>`;
    return `<div class="gc-card"><h3 class="gc-card-h">Service Visits<span class="gc-card-h-count">(${(visits || []).length})</span></h3>${body}</div>`;
  }

  function renderAddonsCard(pending_addons, isCanceled) {
    const visible = (pending_addons || []).filter(a => a.status !== 'canceled');
    const headerAction = isCanceled ? '' : `<button class="gc-btn gc-btn-secondary gc-btn-sm" id="gc-add-addon-btn">+ Add Add-on</button>`;
    const header = `<h3 class="gc-card-h"><span>Add-ons<span class="gc-card-h-count">(${visible.length})</span></span>${headerAction}</h3>`;
    if (visible.length === 0) {
      const empty = `<div class="gc-meta-label" style="padding:6px 0;">No add-ons yet${isCanceled ? '.' : ' &mdash; click "+ Add Add-on" to add one.'}</div>`;
      return `<div class="gc-card">${header}${empty}</div>`;
    }
    const rows = visible.map(a => {
      const amtStr = a.amount_cents ? `$${(a.amount_cents/100).toFixed(2)}` : '';
      const label = escapeHtml(addonLabel(a.addon_type));
      let chip = '', action = '';
      if (a.status === 'pending') {
        chip = `<span class="gc-chip gc-chip-pending">Pending</span>`;
        action = `<div style="display:flex;gap:6px;flex-wrap:wrap;">
          <button class="gc-btn gc-btn-primary gc-btn-sm" data-mark-performed="${a.id}" data-amount="${amtStr}" data-label="${label}">Mark Performed</button>
          <button class="gc-btn gc-btn-icon gc-btn-sm" data-remove-addon="${a.id}" data-label="${label}" title="Remove">&times;</button>
        </div>`;
      } else if (a.status === 'performed') {
        chip = `<span class="gc-chip gc-chip-performed">Performed &middot; bills at renewal</span>`;
        action = `<button class="gc-btn gc-btn-ghost gc-btn-sm" data-unmark="${a.id}">Undo</button>`;
      } else if (a.status === 'charged') {
        const refunded = parseTotalRefundedCents(a.notes);
        if (refunded >= a.amount_cents) {
          chip = `<span class="gc-chip gc-chip-refunded">Refunded</span>`;
        } else if (refunded > 0) {
          chip = `<span class="gc-chip gc-chip-partial">Partial refund: $${(refunded/100).toFixed(2)}</span>`;
          action = `<button class="gc-btn gc-btn-ghost gc-btn-sm" data-refund-addon="${a.id}" data-amount="${a.amount_cents}" data-refunded="${refunded}" data-label="${label}">Refund more</button>`;
        } else {
          chip = `<span class="gc-chip gc-chip-charged">Charged</span>`;
          action = `<button class="gc-btn gc-btn-ghost gc-btn-sm" data-refund-addon="${a.id}" data-amount="${a.amount_cents}" data-refunded="0" data-label="${label}">Refund</button>`;
        }
      } else if (a.status === 'failed') {
        chip = `<span class="gc-chip gc-chip-failed">Failed</span>`;
        action = `<button class="gc-btn gc-btn-destructive gc-btn-sm" data-mark-performed="${a.id}" data-amount="${amtStr}" data-label="${label}">Retry</button>`;
      } else {
        chip = `<span class="gc-chip">${escapeHtml(a.status)}</span>`;
      }
      const visibleNotes = stripRefundLines(a.notes);
      const noteHtml = visibleNotes ? `<div style="color:#DC2626;font-size:0.78rem;margin-top:4px;">${escapeHtml(visibleNotes)}</div>` : '';
      return `<div class="gc-card-row">
        <div>
          <div class="gc-meta-value">${label} ${amtStr ? `<span style="color:#6b7280;font-weight:500;">&middot; ${amtStr}</span>` : ''}</div>
          <div style="margin-top:4px;">${chip}</div>
          ${noteHtml}
        </div>
        <div>${action}</div>
      </div>`;
    }).join('');
    return `<div class="gc-card">${header}${rows}</div>`;
  }

  function renderChargesCard(adhoc_charges, isCanceled) {
    const visible = (adhoc_charges || []).filter(c => c.status !== 'canceled');
    const headerAction = isCanceled ? '' : `<button class="gc-btn gc-btn-secondary gc-btn-sm" id="gc-add-charge-btn">+ Add Charge</button>`;
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
        chip = `<span class="gc-chip gc-chip-pending">${label}</span>`;
        action = `<button class="gc-btn gc-btn-icon gc-btn-sm" data-cancel-charge="${c.id}" data-desc="${desc}" title="Cancel">&times;</button>`;
      } else if (c.status === 'charged') {
        const refunded = parseTotalRefundedCents(c.notes);
        if (refunded >= c.amount_cents) {
          chip = `<span class="gc-chip gc-chip-refunded">Refunded</span>`;
        } else if (refunded > 0) {
          chip = `<span class="gc-chip gc-chip-partial">Charged &middot; partial refund $${(refunded/100).toFixed(2)}</span>`;
          action = `<button class="gc-btn gc-btn-ghost gc-btn-sm" data-refund-charge="${c.id}" data-amount="${c.amount_cents}" data-refunded="${refunded}" data-desc="${desc}">Refund more</button>`;
        } else {
          chip = `<span class="gc-chip gc-chip-charged">${c.date_charged ? 'Charged ' + escapeHtml(c.date_charged) : 'Charged'}</span>`;
          action = `<button class="gc-btn gc-btn-ghost gc-btn-sm" data-refund-charge="${c.id}" data-amount="${c.amount_cents}" data-refunded="0" data-desc="${desc}">Refund</button>`;
        }
      } else if (c.status === 'failed') {
        chip = `<span class="gc-chip gc-chip-failed">Failed</span>`;
      } else {
        chip = `<span class="gc-chip">${escapeHtml(c.status)}</span>`;
      }
      const visibleNotes = stripRefundLines(c.notes);
      const noteHtml = visibleNotes ? `<div style="color:#DC2626;font-size:0.78rem;margin-top:4px;">${escapeHtml(visibleNotes)}</div>` : '';
      return `<div class="gc-card-row">
        <div>
          <div class="gc-meta-value">${desc} ${amtStr ? `<span style="color:#6b7280;font-weight:500;">&middot; ${amtStr}</span>` : ''}</div>
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
      <button class="gc-btn gc-btn-destructive gc-btn-sm" id="gc-cancel-sub-btn">Cancel Subscription</button>
    </div>`;
  }

  async function showDetail(id) {
    const modal = document.getElementById('detailsModal');
    const title = document.getElementById('modal-title');
    const body = document.getElementById('modal-body');
    modal.hidden = false;
    title.textContent = 'Loading…';
    body.innerHTML = renderInitialSkeleton();

    try {
      const r = await fetch(`${API_BASE}/api/generator-care/subscriptions/${id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const { subscription, visits, pending_addons, adhoc_charges = [] } = await r.json();
      const c = subscription.customer || {};
      title.textContent = c.name || 'Customer';
      const isCanceled = subscription.status === 'canceled';

      body.innerHTML =
        renderHeaderBar(c, subscription) +
        renderContactCard(c) +
        renderPlanCard(subscription, isCanceled) +
        renderVisitsCard(visits) +
        renderAddonsCard(pending_addons, isCanceled) +
        renderChargesCard(adhoc_charges, isCanceled) +
        renderInvoicesCard() +
        renderDangerZone(isCanceled, subscription);

      // ---- Wire up event handlers (existing logic, new button IDs/classes) ----
      body.querySelectorAll('[data-complete-visit]').forEach(btn => {
        btn.addEventListener('click', () => completeVisit(btn.dataset.completeVisit, id));
      });
      body.querySelectorAll('[data-confirm-visit]').forEach(btn => {
        btn.addEventListener('click', () => confirmVisit(btn.dataset.confirmVisit, id));
      });
      body.querySelectorAll('[data-mark-performed]').forEach(btn => {
        btn.addEventListener('click', () => markPerformed(btn.dataset.markPerformed, btn.dataset.amount, btn.dataset.label, id));
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

      const saveNoteBtn = body.querySelector('#gc-save-note-btn');
      if (saveNoteBtn) saveNoteBtn.addEventListener('click', () => saveCustomerNote(c.id, saveNoteBtn));

      const saveNvBtn = body.querySelector('#gc-next-visit-save');
      if (saveNvBtn) {
        saveNvBtn.addEventListener('click', async () => {
          const newDate = body.querySelector('#gc-next-visit-input').value;
          if (!newDate) { showStatus('Please pick a date.', 'error'); return; }
          saveNvBtn.disabled = true;
          saveNvBtn.textContent = 'Saving…';
          try {
            const r = await fetch(`${API_BASE}/api/generator-care/subscriptions/${id}`, {
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

      // Kick off lazy Stripe enrichment (fills payment method, lifetime, invoices)
      loadStripeData(id);

    } catch (err) {
      console.error('Detail load failed:', err);
      body.innerHTML = `<div class="gc-card"><p style="color:#DC2626;">Failed to load: ${escapeHtml(err.message)}</p></div>`;
    }
  }

  function addonLabel(t) {
    return ({
      battery_diagnostics: 'Battery Diagnostics / Load Test',
      battery_replacement: 'Battery Replacement',
      exterior_wash: 'Exterior Wash & Interior Blow-Out',
      outage_test: 'Simulated Power Outage Test',
      coolant_flush: 'Coolant System Flush',
      coolant_topoff: 'Coolant Top-Off',
      ats_inspection: 'ATS Inspection',
    })[t] || t;
  }

  async function removeAddon(addonId, label, subscriptionId) {
    if (!confirm(`Remove "${label}" from this subscription?\n\nThe add-on will be marked canceled. You can always add it back via "+ Add Add-on".`)) return;
    try {
      const r = await fetch(`${API_BASE}/api/generator-care/addons/${addonId}/remove`, {
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

  async function markPerformed(addonId, amount, label, subscriptionId) {
    const today = new Date().toISOString().slice(0, 10);
    const dateStr = prompt(
      `Mark "${label}" (${amount}) as performed?\n\nThis adds the charge to the customer's next renewal invoice. They will NOT be charged immediately.\n\nDate performed (YYYY-MM-DD):`,
      today
    );
    if (dateStr === null) return;
    const performedDate = (dateStr || '').trim() || today;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(performedDate)) {
      alert('Date must be in YYYY-MM-DD format (e.g. 2026-06-03).');
      return;
    }
    try {
      const r = await fetch(`${API_BASE}/api/generator-care/addons/${addonId}/mark-performed`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ date_performed: performedDate }),
      });
      const data = await r.json();
      if (!r.ok) {
        const reason = data.reason || data.error || `HTTP ${r.status}`;
        showStatus(`Could not mark performed: ${reason}`, 'error');
      } else {
        showStatus(`${label} marked performed. Will charge at renewal.`, 'success');
      }
      await loadSubscriptions();
      showDetail(subscriptionId);
    } catch (err) {
      console.error('Mark performed failed:', err);
      showStatus(`Failed: ${err.message}`, 'error');
    }
  }

  async function unmarkPerformed(addonId, subscriptionId) {
    if (!confirm('Undo "performed" status? This removes it from the upcoming invoice. Only works before the invoice is finalized.')) return;
    try {
      const r = await fetch(`${API_BASE}/api/generator-care/addons/${addonId}/unmark-performed`, {
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
    const description = prompt('Describe the work or item (shown on customer receipt):', '');
    if (description === null) return;
    if (!description.trim()) {
      showStatus('Description required.', 'error');
      return;
    }
    const amountStr = prompt(`Amount in dollars (e.g. 125.50):`, '');
    if (amountStr === null) return;
    const amount = parseFloat(amountStr);
    if (isNaN(amount) || amount <= 0) {
      showStatus('Amount must be a positive number.', 'error');
      return;
    }
    const amount_cents = Math.round(amount * 100);
    const methodStr = prompt(`How to bill?\n\n1. Charge now (immediate, hits the saved card today)\n2. Add to next renewal invoice (bundles with subscription)\n\nEnter 1 or 2:`, '1');
    if (methodStr === null) return;
    const billing_method = methodStr.trim() === '2' ? 'renewal' : 'immediate';
    
    let service_visit_id = null;
    if (visits && visits.length > 0) {
      const scheduledOrCompleted = visits.filter(v => ['scheduled','tentative','completed'].includes(v.status));
      if (scheduledOrCompleted.length > 0) {
        const lines = scheduledOrCompleted.map((v, i) => {
          const d = v.completed_date || v.scheduled_date || '';
          return `${i+1}. ${v.visit_type === 'regular_service' ? 'Regular Service' : 'On-Demand'} - ${d} (${v.status})`;
        });
        const visitStr = prompt(`Link to a specific visit? (optional)\n\n0. Not tied to a specific visit\n${lines.join('\n')}\n\nEnter number:`, '0');
        if (visitStr === null) return;
        const visitIdx = parseInt(visitStr, 10) - 1;
        if (!isNaN(visitIdx) && visitIdx >= 0 && visitIdx < scheduledOrCompleted.length) {
          service_visit_id = scheduledOrCompleted[visitIdx].id;
        }
      }
    }
    
    const methodLabel = billing_method === 'immediate' ? 'charge now' : 'add to next renewal';
    if (!confirm(`Confirm:\n\n"${description.trim()}" - ${amount.toFixed(2)}\nMethod: ${methodLabel}\n\nProceed?`)) return;
    
    try {
      const r = await fetch(`${API_BASE}/api/generator-care/subscriptions/${subscriptionId}/adhoc-charge`, {
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
    if (!confirm(`Cancel charge "${desc}"?\n\nIf pending, this removes it. If it was already charged, it cannot be canceled here (refund must be handled separately).`)) return;
    try {
      const r = await fetch(`${API_BASE}/api/generator-care/adhoc-charges/${chargeId}/cancel`, {
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
      const listR = await fetch(`${API_BASE}/api/generator-care/subscriptions/${subscriptionId}/available-addons`, {
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
      // Build numbered prompt
      const lines = addons.map((a, i) => `${i+1}. ${a.label} (${(a.amount_cents/100).toFixed(2)})`);
      const sel = prompt(`Which add-on to add?\n\n${lines.join('\n')}\n\nEnter the number (1-${addons.length}):`, '1');
      if (sel === null) return;
      const idx = parseInt(sel, 10) - 1;
      if (isNaN(idx) || idx < 0 || idx >= addons.length) {
        showStatus('Invalid selection.', 'error');
        return;
      }
      const choice = addons[idx];
      if (!confirm(`Add "${choice.label}" (${(choice.amount_cents/100).toFixed(2)}) to this subscription as a pending add-on?\n\nIt will be charged at the next renewal once marked performed.`)) return;
      const addR = await fetch(`${API_BASE}/api/generator-care/subscriptions/${subscriptionId}/add-addon`, {
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
    if (!confirm('Cancel this subscription?\n\nCustomer keeps service through their paid-through date. Stripe will NOT auto-renew at the end of the period.\n\nYou can add an optional reason in the next prompt.')) return;
    const reason = prompt('Optional: reason for cancellation (or leave blank):', '');
    if (reason === null) return; // user hit Cancel on the reason prompt
    try {
      const r = await fetch(`${API_BASE}/api/generator-care/subscriptions/${subscriptionId}/cancel`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: reason.trim() || null }),
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

  async function confirmVisit(visitId, subscriptionId) {
    const dateStr = prompt(
      'Confirm the actual scheduled date for this visit.\n\nFormat: YYYY-MM-DD\n(Press OK to keep the current date.)',
      ''
    );
    if (dateStr === null) return; // user cancelled
    const trimmed = (dateStr || '').trim();
    let body = {};
    if (trimmed) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
        alert('Date must be in YYYY-MM-DD format (e.g. 2026-06-15). Leave blank to keep current.');
        return;
      }
      body.scheduled_date = trimmed;
    }
    try {
      const r = await fetch(`${API_BASE}/api/generator-care/visits/${visitId}/confirm`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        const reason = data.reason || data.error || `HTTP ${r.status}`;
        showStatus(`Could not confirm visit: ${reason}`, 'error');
      } else {
        showStatus('Visit confirmed.', 'success');
      }
      await loadSubscriptions();
      showDetail(subscriptionId);
    } catch (err) {
      console.error('Confirm visit failed:', err);
      showStatus(`Failed: ${err.message}`, 'error');
    }
  }

  async function completeVisit(visitId, subscriptionId) {
    const today = new Date().toISOString().slice(0, 10);
    const dateStr = prompt(
      'What date was this visit actually performed?\n\nFormat: YYYY-MM-DD\n(The next visit will be scheduled relative to this date.)',
      today
    );
    if (dateStr === null) return; // user cancelled
    const completed_date = (dateStr || '').trim() || today;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(completed_date)) {
      alert('Date must be in YYYY-MM-DD format (e.g. 2026-06-02).');
      return;
    }
    // Optional notes — included in the customer's "visit complete" email if provided.
    const notesInput = prompt(
      'Notes for the customer (optional).\n\nWhat we did, anything they should know about, etc. Will appear in the visit-complete email under "Notes from the visit." Leave blank to skip.',
      ''
    );
    if (notesInput === null) return; // user cancelled
    const notes = (notesInput || '').trim() || null;
    try {
      const r = await fetch(`${API_BASE}/api/generator-care/visits/${visitId}/complete`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ completed_date, notes }),
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

  function closeModal() {
    document.getElementById('detailsModal').hidden = true;
  }

  // ---- Helpers ----
  function showLoading(b) {
    document.getElementById('loading').hidden = !b;
  }
  function showStatus(msg, kind = 'info') {
    const el = document.getElementById('status');
    el.hidden = false;
    el.className = `status ${kind}`;
    el.textContent = msg;
    setTimeout(() => { el.hidden = true; }, 3000);
  }

  // ---- Init ----
  checkRole();

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

  loadSubscriptions();

  // ---- Resend Welcome Email ----
  async function resendWelcomeEmail(subscriptionId, btn) {
    const originalText = btn ? btn.textContent : null;
    if (btn) { btn.disabled = true; btn.textContent = 'Sending...'; }
    try {
      const r = await fetch(`${API_BASE}/api/generator-care/subscriptions/${subscriptionId}/resend-welcome`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      });
      const data = await r.json();
      if (!r.ok || !data.sent) {
        const reason = data.error || data.email_status || `HTTP ${r.status}`;
        alert(`Couldn't resend welcome email: ${reason}`);
        return;
      }
      const who = data.customer_name ? ` to ${data.customer_name}` : '';
      const emailAddr = data.customer_email ? ` (${data.customer_email})` : '';
      alert(`Welcome email re-sent${who}${emailAddr}.`);
    } catch (err) {
      console.error('Resend welcome failed:', err);
      alert(`Failed: ${err.message}`);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = originalText; }
    }
  }

  // ---- Send Customer Portal link ----
  async function sendPortalLink(subscriptionId) {
    try {
      const r = await fetch(`${API_BASE}/api/generator-care/subscriptions/${subscriptionId}/portal-session`, {
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
        alert(`Card-update link emailed${who}${emailAddr}.\n\nThe customer can use it to update their card, see invoices, or change contact info. Link expires in about an hour.`);
      } else {
        // Fallback if SendGrid is down or the customer has no email on file
        try { await navigator.clipboard.writeText(data.url); } catch (_) {}
        const reason = data.email_status ? ' (' + data.email_status + ')' : '';
        const target = data.customer_email || 'the customer';
        alert(`Couldn't auto-send the email${reason}.\n\nLink copied to clipboard \u2014 text or email it to ${target}:\n\n${data.url}\n\nLink expires in about an hour.`);
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
        resultEl.style.color = '#991b1b';
        return;
      }
      btn.disabled = true;
      const originalText = btn.textContent;
      btn.textContent = 'Sending...';
      resultEl.textContent = '';
      try {
        const r = await fetch(`${API_BASE}/api/generator-care/admin/send-test-email`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ template, to }),
        });
        const data = await r.json();
        if (!r.ok || !data.sent) {
          const reason = data.error || `HTTP ${r.status}`;
          resultEl.textContent = `Failed: ${reason}`;
          resultEl.style.color = '#991b1b';
          return;
        }
        resultEl.textContent = `Sent to ${to} (check your inbox).`;
        resultEl.style.color = '#065f46';
      } catch (err) {
        console.error('Test email send failed:', err);
        resultEl.textContent = `Failed: ${err.message}`;
        resultEl.style.color = '#991b1b';
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
  async function loadStripeData(subscriptionId) {
    const body = document.getElementById('modal-body');
    if (!body) return;
    try {
      const r = await fetch(`${API_BASE}/api/generator-care/subscriptions/${subscriptionId}/stripe-data`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();

      // Payment method row
      const pmEl = body.querySelector('#gc-payment-method-value');
      if (pmEl) {
        const pm = data.payment_method;
        pmEl.innerHTML = pm
          ? `${escapeHtml(pm.brand || 'card')} &middot; &bull;&bull;&bull;&bull; ${escapeHtml(pm.last4 || '')} <span style="color:#6b7280;font-weight:500;">exp ${String(pm.exp_month || '').padStart(2,'0')}/${String(pm.exp_year || '').slice(-2)}</span>`
          : `<span style="color:#9ca3af;font-weight:500;">No card on file</span>`;
      }

      // Lifetime billed row
      const ltEl = body.querySelector('#gc-lifetime-value');
      if (ltEl) {
        const amt = data.lifetime_billed_cents || 0;
        ltEl.textContent = `$${(amt / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
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
            const chipCls = inv.status === 'paid' ? 'gc-chip-paid' : (inv.status === 'open' ? 'gc-chip-open' : 'gc-chip');
            return `<div class="gc-card-row">
              <div>
                <div class="gc-meta-value">${escapeHtml(dateStr)} <span style="color:#6b7280;font-weight:500;">&middot; ${amt}</span></div>
                <div style="margin-top:4px;"><span class="gc-chip ${chipCls}">${escapeHtml(inv.status || '')}</span></div>
              </div>
              <div>
                <a href="${inv.stripe_dashboard_url}" target="_blank" rel="noopener noreferrer" class="gc-btn gc-btn-ghost gc-btn-sm" style="text-decoration:none;">View in Stripe &#8599;</a>
              </div>
            </div>`;
          }).join('');
          const resendBtn = `<div class="gc-card-actions"><button class="gc-btn gc-btn-secondary gc-btn-sm" id="gc-resend-invoice-btn" data-sub-id="${subscriptionId}">Resend last invoice</button></div>`;
          invEl.innerHTML = rows + resendBtn;
          const resend = body.querySelector('#gc-resend-invoice-btn');
          if (resend) resend.addEventListener('click', () => resendLastInvoice(subscriptionId, resend));
        }
      }
    } catch (err) {
      console.error('[stripe-data] load failed:', err);
      const fail = `<span style="color:#9ca3af;font-weight:500;font-size:0.82rem;">Couldn't load &mdash; refresh to retry</span>`;
      const pmEl = body.querySelector('#gc-payment-method-value');
      if (pmEl) pmEl.innerHTML = fail;
      const ltEl = body.querySelector('#gc-lifetime-value');
      if (ltEl) ltEl.innerHTML = fail;
      const invEl = body.querySelector('#gc-invoices-body');
      if (invEl) invEl.innerHTML = `<div class="gc-meta-label" style="padding:6px 0;">Couldn't load invoices &mdash; refresh to retry.</div>`;
    }
  }

  async function saveCustomerNote(customerId, btn) {
    const textarea = document.getElementById('gc-customer-note');
    if (!textarea || !customerId) return;
    const original = btn ? btn.textContent : null;
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    try {
      const r = await fetch(`${API_BASE}/api/generator-care/customers/${customerId}`, {
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

  async function resendLastInvoice(subscriptionId, btn) {
    if (!confirm('Resend the most recent invoice to the customer via Stripe? (Stripe sends its own email — separate from our Bates-branded templates.)')) return;
    const original = btn ? btn.textContent : null;
    if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
    try {
      const r = await fetch(`${API_BASE}/api/generator-care/subscriptions/${subscriptionId}/resend-invoice`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      });
      const data = await r.json();
      if (!r.ok) {
        showStatus(`Resend failed: ${data.error || `HTTP ${r.status}`}`, 'error');
        return;
      }
      if (data.note) {
        // Paid invoice case — no email re-sent. Show the hosted URL so Amy
        // can copy/paste it to the customer.
        const url = data.hosted_invoice_url || '';
        alert(`${data.note}\n\n${url ? 'Hosted invoice URL: ' + url : ''}`);
        if (url) {
          try { await navigator.clipboard.writeText(url); showStatus('Invoice URL copied to clipboard.', 'success'); } catch (_) {}
        }
      } else {
        showStatus('Invoice resent via Stripe.', 'success');
      }
    } catch (err) {
      console.error('Resend invoice failed:', err);
      showStatus(`Resend failed: ${err.message}`, 'error');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = original; }
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

  async function refundCharge(rowType, rowId, originalAmountCents, alreadyRefundedCents, label, subscriptionId) {
    const remaining = originalAmountCents - alreadyRefundedCents;
    if (remaining <= 0) {
      alert('Already fully refunded.');
      return;
    }
    const remainingDollars = (remaining / 100).toFixed(2);
    const origDollars = (originalAmountCents / 100).toFixed(2);

    const promptMsg = alreadyRefundedCents > 0
      ? `Refund "${label}".\n\nOriginal: $${origDollars}\nAlready refunded: $${(alreadyRefundedCents/100).toFixed(2)}\nMax additional refund: $${remainingDollars}\n\nAmount (blank = full $${remainingDollars}):`
      : `Refund "${label}".\n\nOriginal charge: $${origDollars}\n\nAmount (blank = full $${origDollars}):`;

    const amtStr = prompt(promptMsg, '');
    if (amtStr === null) return;

    let amount_cents = null;
    const trimmed = (amtStr || '').trim();
    if (trimmed) {
      const num = parseFloat(trimmed);
      if (!Number.isFinite(num) || num <= 0 || Math.round(num * 100) > remaining) {
        alert(`Invalid amount. Must be between 0.01 and ${remainingDollars}.`);
        return;
      }
      amount_cents = Math.round(num * 100);
    }

    const reasonStr = prompt('Optional reason for refund (or leave blank):', '');
    if (reasonStr === null) return;

    const confirmAmt = amount_cents ? (amount_cents / 100).toFixed(2) : remainingDollars;
    if (!confirm(`Refund $${confirmAmt} via Stripe?\n\nThis posts to the customer's card within a few business days. Cannot be undone (you would have to recharge them).`)) return;

    const endpoint = rowType === 'addon'
      ? `${API_BASE}/api/generator-care/addons/${rowId}/refund`
      : `${API_BASE}/api/generator-care/adhoc-charges/${rowId}/refund`;

    try {
      const r = await fetch(endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount_cents, reason: (reasonStr || '').trim() || null }),
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

})();
