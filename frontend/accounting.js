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
  let currentView = 'date';        // 'date' | 'payout'
  let currentData = null;          // last by-date payload
  let currentPayoutData = null;    // last by-payout payload

  // ---- Helpers ----
  const $ = (id) => document.getElementById(id);
  const fmtMoney = (cents) => {
    const c = cents || 0;
    const n = Math.abs(c) / 100;
    return (c < 0 ? '-$' : '$') + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  };
  const niceDate = (ymd) => {
    if (!ymd) return '';
    const [y, m, d] = ymd.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
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

  // ---- Shared transaction-row rendering (used by both views) ----
  const rowTr = (t) => `<tr>
      <td>${t.date}</td>
      <td>${escapeHtml(t.customer_name)}</td>
      <td style="color:#6b7280;font-size:0.82rem;">${escapeHtml(t.address)}</td>
      <td>${escapeHtml(t.description)}</td>
      <td class="num">${fmtMoney(t.gross_cents)}</td>
      <td class="num" style="color:#b45309;">${fmtMoney(t.fee_cents)}</td>
      <td class="num" style="color:#047857;font-weight:600;">${fmtMoney(t.net_cents)}</td>
      <td><span class="acc-auth-code">${escapeHtml(t.auth_code || '—')}</span></td>
    </tr>`;

  const rowCard = (t) => `
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
      </div>`;

  // A constituent-transaction table + mobile cards block (CSS swaps them at 768px).
  const txnTableHtml = (rows) => `<div class="acc-table-wrap"><table class="acc-table">
      <thead><tr><th>Date</th><th>Customer</th><th>Address</th><th>Description</th><th class="num">Gross</th><th class="num">Fee</th><th class="num">Net</th><th>Auth Code</th></tr></thead>
      <tbody>${rows.map(rowTr).join('')}</tbody>
    </table></div>`;
  const txnCardsHtml = (rows) => `<div class="acc-mobile-cards">${rows.map(rowCard).join('')}</div>`;

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
    $('acc-tbody').innerHTML = txns.map(rowTr).join('');

    // Footer totals
    $('acc-tfoot').innerHTML = `<tr>
      <td colspan="4" style="text-align:right;">Totals (${data.totals.count} ${data.totals.count === 1 ? 'charge' : 'charges'}):</td>
      <td class="num">${fmtMoney(data.totals.gross_cents)}</td>
      <td class="num" style="color:#b45309;">${fmtMoney(data.totals.fee_cents)}</td>
      <td class="num" style="color:#047857;">${fmtMoney(data.totals.net_cents)}</td>
      <td></td>
    </tr>`;

    // Mobile cards
    $('acc-cards').innerHTML = txns.map(rowCard).join('');
  }

  // ---- Payout (bank reconciliation) view ----
  async function loadPayouts() {
    const from = $('from-date').value;
    const to = $('to-date').value;
    $('loading').hidden = false;
    $('payout-summary').hidden = true;
    $('pending-group').innerHTML = '';
    $('payout-list').innerHTML = '';
    $('payout-empty').hidden = true;

    try {
      const url = `${API_BASE}/api/generator-care/accounting/payouts?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
      const r = await BatesAuth.authFetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const data = await r.json();
      currentPayoutData = data;
      renderPayouts(data);
    } catch (err) {
      console.error('Load payouts failed:', err);
      showStatus('Failed to load payouts: ' + err.message, 'error');
    } finally {
      $('loading').hidden = true;
    }
  }

  function pendingCardHtml(p) {
    return `<div class="pending-card">
      <div class="pending-head">
        <div class="pending-title">Pending &mdash; not yet paid out</div>
        <div class="pending-amt">${fmtMoney(p.net_cents)}</div>
      </div>
      <div class="pending-note">In your Stripe balance; will settle in a future payout. Not on a bank statement yet &mdash; this is why the by-date net can run ahead of the bank.</div>
      ${txnTableHtml(p.transactions)}
      ${txnCardsHtml(p.transactions)}
    </div>`;
  }

  function payoutCardHtml(g) {
    const dirClass = g.direction === 'debit' ? 'debit' : 'deposit';
    const dirLabel = g.direction === 'debit' ? 'Debit from bank' : 'Deposit to bank';
    const statusClass = String(g.status || '').replace(/[^a-z_]/gi, '');
    const niceStatus = String(g.status || '').replace(/_/g, ' ');
    const tied = !!g.ties;
    return `<div class="payout-card">
      <div class="payout-head">
        <div>
          <div class="payout-date">${niceDate(g.arrival_date)}<span class="payout-status ${statusClass}">${escapeHtml(niceStatus)}</span></div>
          <div class="payout-id">${escapeHtml(g.id)}</div>
        </div>
        <div class="payout-bank ${dirClass}">
          <span class="lbl">${dirLabel}</span>
          <span class="amt">${fmtMoney(Math.abs(g.bank_amount_cents))}</span>
        </div>
      </div>
      ${txnTableHtml(g.transactions)}
      ${txnCardsHtml(g.transactions)}
      <div class="payout-recon ${tied ? 'tied' : 'untied'}">
        <span class="chk">${tied ? '✓' : '⚠'}</span>
        <span>Transactions net: ${fmtMoney(g.transactions_net_cents)} &nbsp;=&nbsp; ${dirLabel}: ${fmtMoney(g.bank_amount_cents)}${tied ? ' — ties to the penny' : ' — does NOT tie; review this payout'}</span>
      </div>
    </div>`;
  }

  function renderPayouts(data) {
    const payouts = data.payouts || [];
    const pending = data.pending || { count: 0, net_cents: 0, transactions: [] };

    if (payouts.length || pending.count) {
      $('payout-summary').hidden = false;
      $('po-settled').textContent = fmtMoney(data.totals.settled_net_cents);
      $('po-count').textContent = data.totals.payout_count;
      $('po-pending').textContent = fmtMoney(pending.net_cents);
    } else {
      $('payout-summary').hidden = true;
    }

    // Pending always at the top.
    $('pending-group').innerHTML = pending.count ? pendingCardHtml(pending) : '';
    $('payout-list').innerHTML = payouts.map(payoutCardHtml).join('');
    $('payout-empty').hidden = !(payouts.length === 0 && pending.count === 0);
  }

  // ---- View switching ----
  function loadCurrent() {
    if (currentView === 'payout') loadPayouts();
    else loadTransactions();
  }

  function setView(view) {
    if (view !== 'date' && view !== 'payout') return;
    currentView = view;
    const isPayout = view === 'payout';
    $('view-date').classList.toggle('active', !isPayout);
    $('view-payout').classList.toggle('active', isPayout);
    $('view-date').setAttribute('aria-selected', String(!isPayout));
    $('view-payout').setAttribute('aria-selected', String(isPayout));
    $('date-view').hidden = isPayout;
    $('payout-view').hidden = !isPayout;
    $('scope-hint').innerHTML = isPayout
      ? 'Filtering by <strong>payout date</strong> &mdash; when money actually settled to/from the bank. Each group ties to one bank line.'
      : 'Filtering by <strong>transaction date</strong> &mdash; when each charge, refund, or fee occurred.';
    loadCurrent();
  }

  // ---- CSV download ----
  function csvEscape(v) {
    const s = String(v == null ? '' : v);
    if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function downloadCsv() {
    if (currentView === 'payout') return downloadPayoutCsv();
    if (!currentData || !currentData.transactions || currentData.transactions.length === 0) {
      showStatus('Nothing to export.', 'info'); // transient — auto-dismisses so it doesn't linger over a card
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

  // Payout-grouped CSV: pending section first, then one block per payout
  // (payout header + its transaction rows + a reconciliation/net line).
  function downloadPayoutCsv() {
    const data = currentPayoutData;
    const hasPayouts = data && (data.payouts || []).length > 0;
    const hasPending = data && data.pending && data.pending.count > 0;
    if (!hasPayouts && !hasPending) {
      showStatus('Nothing to export.', 'info');
      return;
    }
    const money = (c) => ((c || 0) / 100).toFixed(2);
    const line = (arr) => arr.map(csvEscape).join(',');
    const rowsHdr = ['', 'Date', 'Customer', 'Address', 'Description', 'Gross', 'Stripe Fee', 'Net', 'Auth Code'];
    const lines = [];

    if (hasPending) {
      lines.push(line(['PENDING - not yet paid out', '', '', '', '', '', '', money(data.pending.net_cents), '']));
      lines.push(line(rowsHdr));
      data.pending.transactions.forEach((t) => lines.push(line(['', t.date, t.customer_name, t.address, t.description, money(t.gross_cents), money(t.fee_cents), money(t.net_cents), t.auth_code || ''])));
      lines.push('');
    }

    (data.payouts || []).forEach((g) => {
      lines.push(line(['Payout', 'Arrival Date', 'Status', 'Direction', 'Bank Amount']));
      lines.push(line([g.id, g.arrival_date, g.status, g.direction, money(g.bank_amount_cents)]));
      lines.push(line(rowsHdr));
      g.transactions.forEach((t) => lines.push(line(['', t.date, t.customer_name, t.address, t.description, money(t.gross_cents), money(t.fee_cents), money(t.net_cents), t.auth_code || ''])));
      lines.push(line(['', '', '', '', '', '', 'Transactions Net', money(g.transactions_net_cents), g.ties ? 'TIES' : 'DOES NOT TIE']));
      lines.push('');
    });

    const csv = lines.join('\r\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `bates-payouts-${data.from}-to-${data.to}.csv`;
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

    $('apply-btn').addEventListener('click', loadCurrent);
    $('refresh-btn').addEventListener('click', loadCurrent);
    $('export-csv-btn').addEventListener('click', downloadCsv);
    $('view-date').addEventListener('click', () => setView('date'));
    $('view-payout').addEventListener('click', () => setView('payout'));

    checkRole();
    loadTransactions();
  });
})();
