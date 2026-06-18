// frontend/accounting.js
// Accounting view for the Generator Care program.
// Mirrors the auth pattern used by generator-care.js.

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
  let currentData = null;

  // ---- Helpers ----
  const $ = (id) => document.getElementById(id);
  const fmtMoney = (cents) => {
    const n = (cents || 0) / 100;
    return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };
  const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));

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
      const r = await BatesAuth.authFetch(`${API_BASE}/me`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) throw new Error('Failed to get profile');
      const { profile } = await r.json();
      if (profile.role !== 'office') {
        showStatus('Access denied. Office role required.', 'error');
        setTimeout(() => window.location.replace('home.html'), 1500);
      }
    } catch (err) {
      console.error('Role check failed:', err);
    }
  }

  // ---- Load transactions ----
  async function loadTransactions() {
    const from = $('from-date').value;
    const to = $('to-date').value;
    $('loading').hidden = false;
    $('empty').hidden = true;
    $('table-wrap').hidden = true;
    $('summary-row').hidden = true;
    $('acc-cards').innerHTML = '';

    try {
      const url = `${API_BASE}/api/generator-care/accounting/transactions?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
      const r = await BatesAuth.authFetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const data = await r.json();
      currentData = data;
      render(data);
    } catch (err) {
      console.error('Load failed:', err);
      showStatus('Failed to load: ' + err.message, 'error');
    } finally {
      $('loading').hidden = true;
    }
  }

  function render(data) {
    const txns = data.transactions || [];
    if (txns.length === 0) {
      $('empty').hidden = false;
      return;
    }

    // Summary
    $('summary-row').hidden = false;
    $('total-gross').textContent = fmtMoney(data.totals.gross_cents);
    $('total-fee').textContent = fmtMoney(data.totals.fee_cents);
    $('total-net').textContent = fmtMoney(data.totals.net_cents);
    $('total-count').textContent = data.totals.count;

    // Desktop table
    $('table-wrap').hidden = false;
    const tbody = $('acc-tbody');
    tbody.innerHTML = txns.map(t => {
      return `<tr>
        <td>${t.date}</td>
        <td>${escapeHtml(t.customer_name)}</td>
        <td style="color:#6b7280;font-size:0.82rem;">${escapeHtml(t.address)}</td>
        <td>${escapeHtml(t.description)}</td>
        <td class="num">${fmtMoney(t.gross_cents)}</td>
        <td class="num" style="color:#b45309;">${fmtMoney(t.fee_cents)}</td>
        <td class="num" style="color:#047857;font-weight:600;">${fmtMoney(t.net_cents)}</td>
        <td><span class="acc-auth-code">${escapeHtml(t.auth_code || '—')}</span></td>
      </tr>`;
    }).join('');

    // Footer totals
    const tfoot = $('acc-tfoot');
    tfoot.innerHTML = `<tr>
      <td colspan="4" style="text-align:right;">Totals (${data.totals.count} ${data.totals.count === 1 ? 'charge' : 'charges'}):</td>
      <td class="num">${fmtMoney(data.totals.gross_cents)}</td>
      <td class="num" style="color:#b45309;">${fmtMoney(data.totals.fee_cents)}</td>
      <td class="num" style="color:#047857;">${fmtMoney(data.totals.net_cents)}</td>
      <td></td>
    </tr>`;

    // Mobile cards
    $('acc-cards').innerHTML = txns.map(t => `
      <div class="acc-card">
        <div class="acc-card-head">
          <span class="acc-card-name">${escapeHtml(t.customer_name)}</span>
          <span class="acc-card-amount">${fmtMoney(t.gross_cents)}</span>
        </div>
        <div class="acc-card-meta">${t.date} &middot; ${escapeHtml(t.description)}</div>
        <div class="acc-card-meta" style="margin-bottom:0;">${escapeHtml(t.address)}</div>
        <div class="acc-card-meta" style="margin-bottom:0;">Auth code: <span class="acc-auth-code">${escapeHtml(t.auth_code || '—')}</span></div>
        <div class="acc-card-footer">
          <span class="fee">Fee: ${fmtMoney(t.fee_cents)}</span>
          <span class="net">Net: ${fmtMoney(t.net_cents)}</span>
        </div>
      </div>
    `).join('');
  }

  // ---- CSV download ----
  function csvEscape(v) {
    const s = String(v == null ? '' : v);
    if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function downloadCsv() {
    if (!currentData || !currentData.transactions || currentData.transactions.length === 0) {
      showStatus('Nothing to export.', 'error');
      return;
    }
    const header = ['Date', 'Customer', 'Address', 'Description', 'Gross', 'Stripe Fee', 'Net', 'Auth Code'];
    const rows = currentData.transactions.map(t => [
      t.date,
      t.customer_name,
      t.address,
      t.description,
      (t.gross_cents / 100).toFixed(2),
      (t.fee_cents / 100).toFixed(2),
      (t.net_cents / 100).toFixed(2),
      t.auth_code || '',
    ]);
    // Add a totals row
    rows.push([
      '', '', '', 'TOTALS',
      (currentData.totals.gross_cents / 100).toFixed(2),
      (currentData.totals.fee_cents / 100).toFixed(2),
      (currentData.totals.net_cents / 100).toFixed(2),
      '',
    ]);
    const csv = [header, ...rows].map(r => r.map(csvEscape).join(',')).join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `bates-accounting-${currentData.from}-to-${currentData.to}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // ---- Init ----
  window.addEventListener('DOMContentLoaded', () => {
    const today = new Date();
    const start = new Date(today.getFullYear(), today.getMonth(), 1);
    $('from-date').value = start.toISOString().slice(0, 10);
    $('to-date').value = today.toISOString().slice(0, 10);

    $('apply-btn').addEventListener('click', loadTransactions);
    $('refresh-btn').addEventListener('click', loadTransactions);
    $('export-csv-btn').addEventListener('click', downloadCsv);

    checkRole();
    loadTransactions();
  });
})();
