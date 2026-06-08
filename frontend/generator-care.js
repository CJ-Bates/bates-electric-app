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
  async function showDetail(id) {
    const modal = document.getElementById('detailsModal');
    const title = document.getElementById('modal-title');
    const body = document.getElementById('modal-body');
    modal.hidden = false;
    title.textContent = 'Loading…';
    body.innerHTML = '<p>Loading customer detail…</p>';

    try {
      const r = await fetch(`${API_BASE}/api/generator-care/subscriptions/${id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const { subscription, visits, pending_addons, adhoc_charges = [] } = await r.json();
      const c = subscription.customer || {};
      title.textContent = c.name || 'Customer';

      const addrLine = [c.install_address, c.install_city, c.install_state, c.install_zip].filter(Boolean).join(', ');
      const annual = subscription.annual_price_cents ? `$${(subscription.annual_price_cents/100).toFixed(2)}` : '—';

      let html = '';
      // Customer info
      html += `<div class="gc-detail-section">
        <div class="gc-detail-h">Customer</div>
        <dl class="gc-detail-grid">
          <dt>Phone</dt><dd>${escapeHtml(c.phone) || '—'}</dd>
          <dt>Email</dt><dd>${escapeHtml(c.email) || '—'}</dd>
          <dt>Install address</dt><dd>${escapeHtml(addrLine) || '—'}</dd>
        </dl>
      </div>`;

      // Subscription info
      html += `<div class="gc-detail-section">
        <div class="gc-detail-h">Subscription</div>
        <dl class="gc-detail-grid">
          <dt>Plan</dt><dd>${escapeHtml(planLabel(subscription.plan))}</dd>
          <dt>Generator</dt><dd>${escapeHtml(genClassLabel(subscription.gen_class))} — ${escapeHtml(subscription.gen_model || 'model n/a')}</dd>
          <dt>Serial</dt><dd>${escapeHtml(subscription.gen_serial) || '—'}</dd>
          <dt>Fleet Monitoring</dt><dd>${subscription.fleet_monitoring ? 'Yes' : 'No'}</dd>
          <dt>Annual price</dt><dd>${annual}</dd>
          <dt>Signed up</dt><dd>${fmtDate(subscription.signup_date)}</dd>
          <dt>Next visit due</dt><dd><input type="date" id="gc-next-visit-input" value="${subscription.next_visit_due || ''}" style="padding: 0.25rem 0.4rem; border: 1px solid #d1d5db; border-radius: 4px; font-size: 0.85rem;" /> <button id="gc-next-visit-save" class="gc-mark-done" style="font-size: 0.75rem; padding: 0.25rem 0.55rem; margin-left: 0.3rem;">Save</button></dd>
          <dt>Status</dt><dd>${escapeHtml(subscription.status)}</dd>
        </dl>
        ${subscription.status === 'canceled'
          ? `<div style="margin-top: 0.5rem; padding: 0.5rem 0.75rem; background: #FEF2F2; border-left: 3px solid #DC2626; color: #991B1B; font-size: 0.85rem;">
              This subscription is canceled. Customer keeps service through their paid-through date; auto-renewal is off.
            </div>`
          : `<div style="margin-top: 0.75rem; text-align: right;">
              <button class="gc-mark-done" id="gc-resend-welcome-btn" style="background: #1F3A5F; font-size: 0.75rem; padding: 0.3rem 0.7rem; margin-right: 6px;">Resend Welcome Email</button><button class="gc-mark-done" id="gc-portal-btn" style="background: #1F3A5F; font-size: 0.75rem; padding: 0.3rem 0.7rem; margin-right: 6px;">Send Card-Update Link</button><button class="gc-mark-done" id="gc-cancel-sub-btn" style="background: #DC2626; font-size: 0.75rem; padding: 0.3rem 0.7rem;">Cancel Subscription</button>
            </div>`}
      </div>`;

      // Service visits
      html += `<div class="gc-detail-section"><div class="gc-detail-h">Service Visits</div>`;
      if (visits.length === 0) html += `<p style="color: #6b7280;">No visits on record.</p>`;
      else {
        for (const v of visits) {
          const date = v.completed_date
            ? `Completed ${fmtDate(v.completed_date)}`
            : v.status === 'tentative'
              ? `Tentative — ${fmtDate(v.scheduled_date)} (needs confirmation)`
              : `Scheduled ${fmtDate(v.scheduled_date)}`;
          let action;
          if (v.status === 'tentative') {
            action = `
              <button class="gc-mark-done" data-confirm-visit="${v.id}" style="background:#F59E0B; margin-right:0.3rem;">Confirm</button>
              <button class="gc-mark-done" data-complete-visit="${v.id}">Mark complete</button>`;
          } else if (v.status === 'scheduled') {
            action = `<button class="gc-mark-done" data-complete-visit="${v.id}">Mark complete</button>`;
          } else {
            action = `<span class="gc-badge gc-badge-active" style="font-size: 0.7rem;">${escapeHtml(v.status)}</span>`;
          }
          html += `<div class="gc-visit-row">
            <div>
              <div>${escapeHtml(v.visit_type === 'regular_service' ? 'Regular Service' : 'On-Demand')}</div>
              <div style="color: #6b7280; font-size: 0.82rem;">${date}</div>
            </div>
            ${action}
          </div>`;
        }
      }
      html += `</div>`;

      // Pending add-ons (always show this section, even if empty)
      {
        html += `<div class="gc-detail-section">
          <div class="gc-detail-h" style="display:flex;justify-content:space-between;align-items:center;">
            <span>Pre-authorized Add-ons</span>
            ${subscription.status === 'canceled' ? '' : `<button class="gc-mark-done" id="gc-add-addon-btn" style="background:#0F766E;font-size:0.7rem;padding:0.25rem 0.6rem;">+ Add Add-on</button>`}
          </div>`;
        if (pending_addons.length === 0) {
          html += `<div style="color: #6b7280; font-size: 0.85rem; padding: 0.5rem 0;">No add-ons yet. Click "+ Add Add-on" to add one.</div>`;
        }
        const visibleAddons = pending_addons.filter(a => a.status !== 'canceled');
        for (const a of visibleAddons) {
          const amt = a.amount_cents ? `${(a.amount_cents/100).toFixed(2)}` : '';
          let action = '';
          let badgeColor = '#6b7280';
          if (a.status === 'pending') {
            action = `
              <div style="display:flex;gap:0.3rem;align-items:center;">
                <button class="gc-mark-done" data-mark-performed="${a.id}" data-amount="${amt}" data-label="${escapeHtml(addonLabel(a.addon_type))}" style="background:#0F766E;">Mark Performed</button>
                <button class="gc-mark-done" data-remove-addon="${a.id}" data-label="${escapeHtml(addonLabel(a.addon_type))}" title="Remove this add-on" style="background:#9CA3AF;font-size:0.7rem;padding:0.2rem 0.5rem;">&times;</button>
              </div>`;
          } else if (a.status === 'performed') {
            badgeColor = '#D97706';
            action = `
              <div style="display:flex;flex-direction:column;gap:0.25rem;align-items:flex-end;">
                <span class="gc-badge" style="background:#FEF3C7;color:#92400E;font-size:0.7rem;padding:0.25rem 0.55rem;border-radius:999px;">Performed - will charge at renewal</span>
                <button class="gc-mark-done" data-unmark="${a.id}" style="background:#9CA3AF;font-size:0.7rem;padding:0.2rem 0.5rem;">Undo</button>
              </div>`;
          } else if (a.status === 'charged') {
            badgeColor = '#059669';
            action = `<span class="gc-badge" style="background:#D1FAE5;color:#065F46;font-size:0.7rem;padding:0.25rem 0.55rem;border-radius:999px;">Charged</span>`;
          } else if (a.status === 'failed') {
            badgeColor = '#DC2626';
            action = `<button class="gc-mark-done" data-mark-performed="${a.id}" data-amount="${amt}" data-label="${escapeHtml(addonLabel(a.addon_type))}" style="background:#DC2626;">Retry</button>`;
          } else {
            action = `<span class="gc-badge gc-badge-active" style="font-size:0.7rem;">${escapeHtml(a.status)}</span>`;
          }
          const noteHtml = a.notes ? `<div style="color:#DC2626;font-size:0.75rem;margin-top:0.2rem;">${escapeHtml(a.notes)}</div>` : '';
          html += `<div class="gc-visit-row">
            <div>
              <div>${escapeHtml(addonLabel(a.addon_type))}</div>
              <div style="color: ${badgeColor}; font-size: 0.82rem;">${amt} · ${escapeHtml(a.status)}</div>
              ${noteHtml}
            </div>
            ${action}
          </div>`;
        }
        html += `</div>`;
      }

      // Ad-hoc / other charges section
      {
        const visibleCharges = (adhoc_charges || []).filter(c => c.status !== 'canceled');
        html += `<div class="gc-detail-section">
          <div class="gc-detail-h" style="display:flex;justify-content:space-between;align-items:center;">
            <span>Other Charges (non-program)</span>
            ${subscription.status === 'canceled' ? '' : `<button class="gc-mark-done" id="gc-add-charge-btn" style="background:#0F766E;font-size:0.7rem;padding:0.25rem 0.6rem;">+ Add Charge</button>`}
          </div>`;
        if (visibleCharges.length === 0) {
          html += `<div style="color: #6b7280; font-size: 0.85rem; padding: 0.5rem 0;">No ad-hoc charges. Use this for non-program work (parts, repairs, etc).</div>`;
        }
        for (const c of visibleCharges) {
          const amt = c.amount_cents ? `${(c.amount_cents/100).toFixed(2)}` : '';
          let badge, badgeColor, action = '';
          if (c.status === 'pending') {
            badgeColor = '#D97706';
            badge = c.billing_method === 'renewal' ? 'Pending - will bill at renewal' : 'Pending';
            action = `<button class="gc-mark-done" data-cancel-charge="${c.id}" data-desc="${escapeHtml(c.description)}" style="background:#9CA3AF;font-size:0.7rem;padding:0.2rem 0.5rem;">&times;</button>`;
          } else if (c.status === 'charged') {
            badgeColor = '#059669';
            badge = c.date_charged ? `Charged ${c.date_charged}` : 'Charged';
          } else if (c.status === 'failed') {
            badgeColor = '#DC2626';
            badge = 'Failed';
          } else {
            badgeColor = '#6b7280';
            badge = c.status;
          }
          const noteHtml = c.notes ? `<div style="color:#DC2626;font-size:0.75rem;margin-top:0.2rem;">${escapeHtml(c.notes)}</div>` : '';
          html += `<div class="gc-visit-row">
            <div>
              <div>${escapeHtml(c.description)}</div>
              <div style="color: ${badgeColor}; font-size: 0.82rem;">${amt} - ${escapeHtml(badge)}</div>
              ${noteHtml}
            </div>
            ${action}
          </div>`;
        }
        html += `</div>`;
      }

      body.innerHTML = html;

      // Wire up "Mark complete" buttons
      body.querySelectorAll('[data-complete-visit]').forEach(btn => {
        btn.addEventListener('click', () => completeVisit(btn.dataset.completeVisit, id));
      });

      // Wire up Confirm buttons for tentative visits
      body.querySelectorAll('[data-confirm-visit]').forEach(btn => {
        btn.addEventListener('click', () => confirmVisit(btn.dataset.confirmVisit, id));
      });

      // Wire up Charge buttons on pending/failed add-ons
      const addChargeBtn = body.querySelector('#gc-add-charge-btn');
      if (addChargeBtn) {
        addChargeBtn.addEventListener('click', () => addAdhocCharge(id, visits || []));
      }
      body.querySelectorAll('[data-cancel-charge]').forEach(btn => {
        btn.addEventListener('click', () => cancelAdhocCharge(btn.dataset.cancelCharge, btn.dataset.desc, id));
      });

      const addBtn = body.querySelector('#gc-add-addon-btn');
      if (addBtn) {
        addBtn.addEventListener('click', () => addAddon(id));
      }

      body.querySelectorAll('[data-mark-performed]').forEach(btn => {
        btn.addEventListener('click', () => markPerformed(btn.dataset.markPerformed, btn.dataset.amount, btn.dataset.label, id));
      });
      body.querySelectorAll('[data-remove-addon]').forEach(btn => {
        btn.addEventListener('click', () => removeAddon(btn.dataset.removeAddon, btn.dataset.label, id));
      });
      body.querySelectorAll('[data-unmark]').forEach(btn => {
        btn.addEventListener('click', () => unmarkPerformed(btn.dataset.unmark, id));
      });

      // Wire up "Save next visit due" button
      const saveNvBtn = body.querySelector('#gc-next-visit-save');
      const cancelBtn = body.querySelector('#gc-cancel-sub-btn');
      if (cancelBtn) {
        cancelBtn.addEventListener('click', () => cancelSubscription(id));
      }
      const portalBtn = body.querySelector('#gc-portal-btn');
      if (portalBtn) {
        portalBtn.addEventListener('click', () => sendPortalLink(id));
      }
      const resendWelcomeBtn = body.querySelector('#gc-resend-welcome-btn');
      if (resendWelcomeBtn) {
        resendWelcomeBtn.addEventListener('click', () => resendWelcomeEmail(id, resendWelcomeBtn));
      }

      if (saveNvBtn) {
        saveNvBtn.addEventListener('click', async () => {
          const newDate = body.querySelector('#gc-next-visit-input').value;
          if (!newDate) { showStatus('Please pick a date.', 'error'); return; }
          saveNvBtn.disabled = true;
          saveNvBtn.textContent = 'Saving...';
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
    } catch (err) {
      console.error('Detail load failed:', err);
      body.innerHTML = `<p style="color: #ef4444;">Failed to load: ${escapeHtml(err.message)}</p>`;
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
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      showStatus('Visit confirmed.', 'success');
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
    try {
      const r = await fetch(`${API_BASE}/api/generator-care/visits/${visitId}/complete`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ completed_date }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      showStatus('Visit marked complete. Next visit scheduled.', 'success');
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

})();
