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
    window.location.replace('/');
    return;
  }

  // First real (paying) customer signed up 2026-06-25 — live-mode charges dated
  // before that are CJ's early testing. The "Hide early test activity" toggle
  // (default ON) filters them from the by-date view so the numbers Brenda sees
  // start at real revenue. The by-payout view is NOT filtered: each payout group
  // must tie to its bank line to the penny, and hiding constituents would break
  // the reconciliation.
  const FIRST_REAL_CUSTOMER_DATE = '2026-06-25';

  // State
  let currentView = 'date';        // 'date' | 'payout'
  let currentData = null;          // last by-date payload
  let currentPayoutData = null;    // last by-payout payload
  let hideTestActivity = true;     // mirrors the #hide-test-toggle checkbox

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
  // Transaction/reconciliation rows show US MM/DD/YYYY (Brenda's Jonas/Excel
  // convention), unlike niceDate's long-form summary headings above — one
  // shared spot so a future user-selectable format is a one-place change.
  // Built straight from the parsed ISO parts (no Date object) so there's no
  // UTC-midnight-shifts-a-day-back risk from the caller's local timezone.
  const formatDate = (ymd) => {
    if (!ymd) return '';
    const [y, m, d] = String(ymd).slice(0, 10).split('-').map(Number);
    if (!y || !m || !d) return ymd;
    return `${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}/${y}`;
  };
  const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));

  // Prefer the server's error message ("Invalid date range") over a bare
  // "HTTP 400" in the failure toast.
  async function errorMessageOf(r) {
    try {
      const body = await r.json();
      if (body && body.error) return body.error;
    } catch (_) { /* non-JSON body */ }
    return 'HTTP ' + r.status;
  }

  function showStatus(msg, kind) {
    const el = $('status');
    el.textContent = msg;
    el.className = 'status ' + (kind || '');
    el.hidden = false;
    if (kind !== 'error') setTimeout(() => { el.hidden = true; }, 3500);
  }

  // ---- Shared transaction-row rendering (used by both views) ----
  const rowTr = (t) => `<tr>
      <td>${formatDate(t.date)}</td>
      <td>${escapeHtml(t.customer_name)}</td>
      <td style="color:var(--ink-2);font-size:0.82rem;">${escapeHtml(t.address)}</td>
      <td>${escapeHtml(t.description)}</td>
      <td class="num">${fmtMoney(t.gross_cents)}</td>
      <td class="num" style="color:var(--warn);">${fmtMoney(t.fee_cents)}</td>
      <td class="num" style="color:var(--ok);font-weight:600;">${fmtMoney(t.net_cents)}</td>
      <td><span class="acc-auth-code">${escapeHtml(t.auth_code || '—')}</span></td>
    </tr>`;

  const rowCard = (t) => `
      <div class="acc-card">
        <div class="acc-card-head">
          <span class="acc-card-name">${escapeHtml(t.customer_name)}</span>
          <span class="acc-card-amount">${fmtMoney(t.gross_cents)}</span>
        </div>
        <div class="acc-card-meta">${formatDate(t.date)} &middot; ${escapeHtml(t.description)}</div>
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
        setTimeout(() => window.location.replace('/home'), 1500);
        return;
      }
      // Per-member flag (see /me permissions). The API 403s without it too —
      // this just lands the member somewhere friendlier than a broken page.
      if (profile.permissions && profile.permissions.accounting === false) {
        showStatus('Access denied. You don\u2019t have Accounting access \u2014 ask an administrator.', 'error');
        setTimeout(() => window.location.replace('/generator-care'), 1500);
      }
    } catch (err) {
      console.error('Role check failed:', err);
    }
  }

  // ---- Load transactions ----
  async function loadTransactions() {
    const from = $('acc-from-date').value;
    const to = $('acc-to-date').value;
    $('acc-loading').hidden = false;
    $('acc-empty').hidden = true;
    $('table-wrap').hidden = true;
    $('summary-row').hidden = true;
    $('acc-cards').innerHTML = '';

    try {
      const url = `${API_BASE}/api/generator-care/accounting/transactions?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
      const r = await BatesAuth.authFetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) throw new Error(await errorMessageOf(r));
      const data = await r.json();
      currentData = data;
      render();
    } catch (err) {
      console.error('Load failed:', err);
      showStatus('Failed to load: ' + err.message, 'error');
    } finally {
      $('acc-loading').hidden = true;
    }
  }

  // The by-date rows currently visible: the server payload with the early-test
  // filter applied when the toggle is on. Dates are YYYY-MM-DD so plain string
  // comparison against the cutoff is correct.
  function visibleTransactions() {
    const txns = (currentData && currentData.transactions) || [];
    if (!hideTestActivity) return txns;
    return txns.filter((t) => !t.date || t.date >= FIRST_REAL_CUSTOMER_DATE);
  }

  // Totals for the VISIBLE rows — recomputed client-side because the server
  // totals cover the whole date range, filtered or not.
  function visibleTotals(txns) {
    return txns.reduce((acc, t) => ({
      gross_cents: acc.gross_cents + (t.gross_cents || 0),
      fee_cents: acc.fee_cents + (t.fee_cents || 0),
      net_cents: acc.net_cents + (t.net_cents || 0),
      count: acc.count + 1,
    }), { gross_cents: 0, fee_cents: 0, net_cents: 0, count: 0 });
  }

  function render() {
    const txns = visibleTransactions();
    $('acc-empty').hidden = true;
    $('table-wrap').hidden = true;
    $('summary-row').hidden = true;
    $('acc-cards').innerHTML = '';
    if (txns.length === 0) {
      $('acc-empty').hidden = false;
      return;
    }
    const totals = visibleTotals(txns);

    // Summary
    $('summary-row').hidden = false;
    $('total-gross').textContent = fmtMoney(totals.gross_cents);
    $('total-fee').textContent = fmtMoney(totals.fee_cents);
    $('total-net').textContent = fmtMoney(totals.net_cents);
    $('total-count').textContent = totals.count;

    // Desktop table
    $('table-wrap').hidden = false;
    $('acc-tbody').innerHTML = txns.map(rowTr).join('');

    // Footer totals
    $('acc-tfoot').innerHTML = `<tr>
      <td colspan="4" style="text-align:right;">Totals (${totals.count} ${totals.count === 1 ? 'charge' : 'charges'}):</td>
      <td class="num">${fmtMoney(totals.gross_cents)}</td>
      <td class="num" style="color:var(--warn);">${fmtMoney(totals.fee_cents)}</td>
      <td class="num" style="color:var(--ok);">${fmtMoney(totals.net_cents)}</td>
      <td></td>
    </tr>`;

    // Mobile cards
    $('acc-cards').innerHTML = txns.map(rowCard).join('');
  }

  // ---- Payout (bank reconciliation) view ----
  async function loadPayouts() {
    const from = $('acc-from-date').value;
    const to = $('acc-to-date').value;
    $('acc-loading').hidden = false;
    $('payout-summary').hidden = true;
    $('pending-group').innerHTML = '';
    $('payout-list').innerHTML = '';
    $('payout-empty').hidden = true;

    try {
      const url = `${API_BASE}/api/generator-care/accounting/payouts?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
      const r = await BatesAuth.authFetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) throw new Error(await errorMessageOf(r));
      const data = await r.json();
      currentPayoutData = data;
      renderPayouts(data);
    } catch (err) {
      console.error('Load payouts failed:', err);
      showStatus('Failed to load payouts: ' + err.message, 'error');
    } finally {
      $('acc-loading').hidden = true;
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

  // Stripe payout status -> shared badge intent (Design System v3):
  // paid = ok · pending / in_transit = warn · failed = danger ·
  // canceled = neutral. Anything unexpected falls back to neutral.
  const STATUS_BADGE = {
    paid: 'badge-ok',
    in_transit: 'badge-warn',
    pending: 'badge-warn',
    failed: 'badge-danger',
    canceled: 'badge-neutral',
  };

  function payoutCardHtml(g) {
    const dirClass = g.direction === 'debit' ? 'debit' : 'deposit';
    const dirLabel = g.direction === 'debit' ? 'Debit from bank' : 'Deposit to bank';
    const badgeClass = STATUS_BADGE[String(g.status || '').toLowerCase()] || 'badge-neutral';
    const niceStatus = String(g.status || '').replace(/_/g, ' ');
    const tied = !!g.ties;
    const head = `<div class="payout-head">
        <div>
          <div class="payout-date">${niceDate(g.arrival_date)}<span class="badge ${badgeClass} payout-status">${escapeHtml(niceStatus)}</span></div>
          <div class="payout-id">${escapeHtml(g.id)}</div>
          <button type="button" class="btn btn-secondary btn-sm print-payout-btn" data-payout-id="${escapeHtml(g.id)}">Print breakdown</button>
        </div>
        <div class="payout-bank ${dirClass}">
          <span class="lbl">${dirLabel}</span>
          <span class="amt">${fmtMoney(Math.abs(g.bank_amount_cents))}</span>
        </div>
      </div>`;
    // Some payouts (notably auto-debits) don't itemize constituents in range —
    // show an explanatory note instead of a misleading "does not tie" warning.
    if (g.unconstituted) {
      return `<div class="payout-card">
        ${head}
        <div class="payout-note">${escapeHtml(g.note || 'No itemized transactions reference this payout in the selected range.')}</div>
      </div>`;
    }
    // A note can coexist with rows (e.g. an incomplete itemization) — show
    // both; never hide rows we do have.
    return `<div class="payout-card">
      ${head}
      ${g.note ? `<div class="payout-note">${escapeHtml(g.note)}</div>` : ''}
      ${txnTableHtml(g.transactions)}
      ${txnCardsHtml(g.transactions)}
      <div class="payout-recon ${tied ? 'tied' : 'untied'}">
        <span class="chk">${tied ? BatesIcons.icon('check', 16) : BatesIcons.icon('warn', 16)}</span>
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
    $('print-all-btn').hidden = !isPayout;
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
    // Export exactly what's on screen — the early-test filter applies here too.
    const txns = currentData ? visibleTransactions() : [];
    if (txns.length === 0) {
      showStatus('Nothing to export.', 'info'); // transient — auto-dismisses so it doesn't linger over a card
      return;
    }
    const totals = visibleTotals(txns);
    const header = ['Date', 'Customer', 'Address', 'Description', 'Gross', 'Stripe Fee', 'Net', 'Auth Code'];
    const rows = txns.map(t => [
      formatDate(t.date),
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
      (totals.gross_cents / 100).toFixed(2),
      (totals.fee_cents / 100).toFixed(2),
      (totals.net_cents / 100).toFixed(2),
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
      data.pending.transactions.forEach((t) => lines.push(line(['', formatDate(t.date), t.customer_name, t.address, t.description, money(t.gross_cents), money(t.fee_cents), money(t.net_cents), t.auth_code || ''])));
      lines.push('');
    }

    (data.payouts || []).forEach((g) => {
      lines.push(line(['Payout', 'Arrival Date', 'Status', 'Direction', 'Bank Amount']));
      lines.push(line([g.id, formatDate(g.arrival_date), g.status, g.direction, money(g.bank_amount_cents)]));
      lines.push(line(rowsHdr));
      g.transactions.forEach((t) => lines.push(line(['', formatDate(t.date), t.customer_name, t.address, t.description, money(t.gross_cents), money(t.fee_cents), money(t.net_cents), t.auth_code || ''])));
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

  // ---- Print breakdown (Brenda's paper/PDF copy) ----
  // Builds letterhead-lite blocks into #print-root, marks the body as printing
  // (print CSS then shows ONLY the print root), and opens the browser's print
  // dialog — Brenda can print or save as PDF from there. One payout per page;
  // "Print all groups" emits every payout with a page break between. Cleanup
  // happens on afterprint so a plain Ctrl+P later prints the normal page.
  const printRow = (t) => `<tr>
      <td>${formatDate(t.date)}</td>
      <td>${escapeHtml(t.customer_name)}</td>
      <td>${escapeHtml(t.description)}</td>
      <td class="num">${fmtMoney(t.gross_cents)}</td>
      <td class="num">${fmtMoney(t.fee_cents)}</td>
      <td class="num">${fmtMoney(t.net_cents)}</td>
      <td class="mono">${escapeHtml(t.auth_code || '—')}</td>
    </tr>`;

  function printBlockHtml(g) {
    const dirLabel = g.direction === 'debit' ? 'Debit from bank' : 'Deposit to bank';
    const rows = g.transactions || [];
    const generated = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
    const tieLine = !rows.length ? '' : (g.ties
      ? `Itemized net ${fmtMoney(g.transactions_net_cents)} = ${dirLabel.toLowerCase()} ${fmtMoney(Math.abs(g.bank_amount_cents))} — ties to the penny.`
      : `Itemized net ${fmtMoney(g.transactions_net_cents)} vs ${dirLabel.toLowerCase()} ${fmtMoney(Math.abs(g.bank_amount_cents))} — difference of ${fmtMoney(g.bank_amount_cents - g.transactions_net_cents)}; see note above.`);
    return `<section class="print-payout">
      <div class="print-head">
        <div>
          <div class="print-co">Bates Electric, Inc.</div>
          <div class="print-sub">Generator Care &middot; Payout reconciliation</div>
        </div>
        <div class="print-gen">Generated ${generated}</div>
      </div>
      <div class="print-facts">
        <div><span class="lbl">Payout date</span><span class="val">${niceDate(g.arrival_date)}</span></div>
        <div><span class="lbl">${dirLabel}</span><span class="val">${fmtMoney(Math.abs(g.bank_amount_cents))}</span></div>
        <div><span class="lbl">Stripe payout ID</span><span class="val mono">${escapeHtml(g.id)}</span></div>
        <div><span class="lbl">Status</span><span class="val">${escapeHtml(String(g.status || '').replace(/_/g, ' '))}</span></div>
      </div>
      ${g.note ? `<div class="print-note">${escapeHtml(g.note)}</div>` : ''}
      ${rows.length ? `<table class="print-table">
        <thead><tr><th>Date</th><th>Customer</th><th>Description</th><th class="num">Gross</th><th class="num">Fee</th><th class="num">Net</th><th>Auth code</th></tr></thead>
        <tbody>${rows.map(printRow).join('')}</tbody>
        <tfoot><tr>
          <td colspan="3">Totals (${rows.length} transaction${rows.length === 1 ? '' : 's'})</td>
          <td class="num">${fmtMoney(g.gross_cents)}</td>
          <td class="num">${fmtMoney(g.fee_cents)}</td>
          <td class="num">${fmtMoney(g.transactions_net_cents)}</td>
          <td></td>
        </tr></tfoot>
      </table>
      <div class="print-tie">${tieLine}</div>` : ''}
    </section>`;
  }

  function printPayoutGroups(groups) {
    if (!groups.length) {
      showStatus('Nothing to print.', 'info');
      return;
    }
    $('print-root').innerHTML = groups.map(printBlockHtml).join('');
    document.body.classList.add('printing');
    window.print();
  }

  // ---- Init ----
  // Called by generator-care.js the first time the Accounting tab is opened,
  // rather than on DOMContentLoaded — this view is lazy-loaded, not a
  // standalone page anymore. refresh() is what the shared header Refresh
  // button calls while this tab is active.
  function init() {
    // Default range: first of the current month through today. Formatted in
    // LOCAL time — toISOString() shifts to UTC, which can land a day off.
    const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const today = new Date();
    $('acc-from-date').value = ymd(new Date(today.getFullYear(), today.getMonth(), 1));
    $('acc-to-date').value = ymd(today);

    $('acc-apply-btn').addEventListener('click', loadCurrent);
    $('export-csv-btn').addEventListener('click', downloadCsv);
    $('view-date').addEventListener('click', () => setView('date'));
    $('view-payout').addEventListener('click', () => setView('payout'));

    // Print: per-payout buttons are rendered per card (delegated), the
    // header button prints every group in the range.
    $('payout-list').addEventListener('click', (e) => {
      const btn = e.target.closest('.print-payout-btn');
      if (!btn || !currentPayoutData) return;
      const g = (currentPayoutData.payouts || []).find((x) => x.id === btn.dataset.payoutId);
      if (g) printPayoutGroups([g]);
    });
    $('print-all-btn').addEventListener('click', () => {
      printPayoutGroups((currentPayoutData && currentPayoutData.payouts) || []);
    });
    window.addEventListener('afterprint', () => {
      document.body.classList.remove('printing');
      $('print-root').innerHTML = '';
    });
    $('hide-test-toggle').addEventListener('change', (e) => {
      hideTestActivity = e.target.checked;
      if (currentData) render(); // client-side filter — no refetch needed
    });

    checkRole();
    loadTransactions();
  }

  window.BatesAccounting = { init, refresh: loadCurrent };
})();
