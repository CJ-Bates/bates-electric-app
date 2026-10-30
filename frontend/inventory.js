// frontend/inventory.js
// Warehouse inventory (sql/039 + routes/inventory.js). One page, hash routes:
//   #/                home: Scan, Bulk count, search + Filter + More
//   #/item/<id>       an item: big In / Out / Count, surplus, details, photos, history
//   #/count           Bulk count (the rapid scan-in; "count session" in code)
//   #/surplus         surplus list + CSV / PDF
//   #/reports         simple numbers
//
// Data: inventory-store.js holds the catalog (cached, works offline) and the
// write queue; every scan write goes through it, so the same code path works
// with and without signal. Permissions come from /me (inventory_view /
// _scan_out / _manage); the server enforces them again on every call.

(() => {
  const API_BASE = (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
    ? 'http://localhost:4000'
    : 'https://bates-electric-app.onrender.com';
  const TOKEN_KEY = 'bates.auth.token';
  const getToken = () => localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY);
  if (!getToken()) { window.location.replace('/'); return; }

  const esc = window.BatesUI.escapeHtml;
  const $ = (sel, root) => (root || document).querySelector(sel);
  const viewEl = document.getElementById('inv-view');
  const syncEl = document.getElementById('inv-sync');

  const svg = (d, s = 20) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const ICON = {
    scan: svg('<path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><path d="M7 8v8M10 8v8M13 8v8M17 8v8"/>', 24),
    count: svg('<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 7h8M8 11h8M8 15h5"/>', 24),
    box: svg('<path d="M21 8 12 3 3 8v8l9 5 9-5z"/><path d="m3 8 9 5 9-5"/><path d="M12 13v8"/>', 22),
    camera: svg('<path d="M14.5 4h-5L8 6H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-3z"/><circle cx="12" cy="13" r="3.5"/>', 22),
    sync: svg('<path d="M21 12a9 9 0 0 1-15.5 6.2L3 16"/><path d="M3 12a9 9 0 0 1 15.5-6.2L21 8"/><path d="M21 3v5h-5M3 21v-5h5"/>', 15),
    cloudOff: svg('<path d="m2 2 20 20"/><path d="M5.8 5.8A7 7 0 0 0 7 19h9.5"/><path d="M20.6 16.6A4.5 4.5 0 0 0 17.5 9H17a7 7 0 0 0-8.6-4.6"/>', 15),
    alert: svg('<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>', 15),
    tag: svg('<path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"/><circle cx="7.5" cy="7.5" r="1.5"/>', 18),
    chart: svg('<path d="M3 3v18h18"/><path d="M7 15v-4M12 15V7M17 15v-6"/>', 18),
    download: svg('<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>', 18),
    filter: svg('<path d="M3 5h18l-7 8v6l-4-2v-4z"/>', 18),
    check: svg('<path d="m5 12 5 5 9-10"/>', 20),
  };

  // ---- formatting ----
  const fmtQty = (n) => { const v = Number(n) || 0; return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/0+$/, '').replace(/\.$/, ''); };
  const money = (cents) => (cents == null ? '' : '$' + (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
  const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', year: 'numeric' }) : '');
  const fmtDateTime = (iso) => (iso ? new Date(iso).toLocaleString('en-US', { timeZone: 'America/Chicago', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
  const COND = { new: 'New', open_box: 'New - open box', used: 'Used' };
  const TXN_LABEL = { initial_count: 'Initial count', received: 'Received', scanned_out: 'Scanned out', adjustment: 'Count adjusted', sold: 'Sold', disposed: 'Disposed' };
  // Undo (sql/040): + In, - Out / scan-out and Count, for 15 minutes.
  const UNDOABLE = new Set(['received', 'scanned_out', 'adjustment']);
  const UNDO_WINDOW_MS = 15 * 60 * 1000;
  const UNDO_TOAST_MS = 10000;
  let categories = [];
  const catLabel = (k) => ((categories.find((c) => c[0] === k) || [k, k])[1]) || '';
  const online = () => navigator.onLine !== false;
  const uuid = () => crypto.randomUUID();

  // ---- API ----
  // Every request has a time limit. Without one, an iPhone request that
  // stalls (resume from background, a server swap mid-deploy) never settles
  // and the sync queue waits on it forever (2026-10-30 "1 scan waiting").
  const API_TIMEOUT_MS = 20000;
  const UPLOAD_TIMEOUT_MS = 45000;
  function timeoutError(ms) { const e = new Error(`No answer from the server after ${Math.round(ms / 1000)} s`); e.name = 'TimeoutError'; return e; }
  async function withTimeout(ms, run) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    try { return await run(ctrl.signal); } catch (e) { if (ctrl.signal.aborted) throw timeoutError(ms); throw e; } finally { clearTimeout(t); }
  }
  async function rawApi(path, opts = {}) {
    const headers = { Authorization: `Bearer ${getToken()}` };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    return withTimeout(opts.timeout || API_TIMEOUT_MS, (signal) => BatesAuth.authFetch(`${API_BASE}${path}`, { method: opts.method || 'GET', headers, signal, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) }));
  }
  async function api(path, opts) {
    const r = await rawApi(path, opts);
    const data = await withTimeout(API_TIMEOUT_MS, () => r.json()).catch(() => ({}));
    if (!r.ok) { const e = new Error(data.error || `HTTP ${r.status}`); e.status = r.status; e.data = data; throw e; }
    return data;
  }

  // ---- state ----
  let me = null;
  let perms = { view: false, scan_out: false, manage: false };
  let store = null;
  let currentRoute = '';
  let rerender = null;   // current page's soft refresh (after a catalog refresh)
  // Bumped on every navigation. A page's async work (a slow fetch) checks it
  // before drawing, so a page you already left can never paint over the
  // current one.
  let routeSeq = 0;
  const routeToken = () => { const mine = routeSeq; return () => mine === routeSeq; };

  // ============================================================================
  // Boot
  // ============================================================================
  async function loadMe() {
    try {
      const { profile } = await api('/me');
      try { localStorage.setItem('bates.profile', JSON.stringify(profile)); } catch (e) { /* private mode */ }
      return profile;
    } catch (e) {
      // Offline: the cached profile is good enough to run the warehouse.
      try { return JSON.parse(localStorage.getItem('bates.profile') || 'null'); } catch (e2) { return null; }
    }
  }

  async function boot() {
    me = await loadMe();
    const p = (me && me.permissions) || {};
    perms = { view: !!p.inventory_view, scan_out: !!p.inventory_scan_out, manage: !!p.inventory_manage };
    if (!me || !perms.view) {
      viewEl.innerHTML = `<section class="card"><h3 class="gc-card-h">Inventory</h3><p class="inv-muted">You don't have access to inventory. Ask an administrator to turn it on for you in Members.</p></section>`;
      return;
    }
    store = BatesInvStore.create({
      adapter: BatesInvStore.indexedDbAdapter('bates-inventory'),
      send: (ops) => api('/api/inventory/sync', { method: 'POST', body: { ops } }),
      uploadPhoto,
      isOnline: online,
      onFlushed: (st) => { if (!st.pending && !store.pendingOps().length) refreshCatalog(); },
      onRemap: (fromId, toId) => { if (currentRoute === 'item' && location.hash.indexOf(fromId) !== -1) location.hash = '#/item/' + toId; },
    });
    await store.load();
    categories = store.view().categories || [];
    store.onChange(renderSync);
    renderSync(store.state());
    window.addEventListener('online', () => { store.flush(); refreshCatalog(); });
    // Keep nudging while anything waits: a wedged pass gets released by the
    // store's watchdog on the next nudge, and a resumed iPhone syncs at once.
    setInterval(() => { if (store.state().pending && online()) store.flush(); }, 15000);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && store.state().pending) store.flush(); });
    window.addEventListener('offline', () => renderSync(store.state()));
    window.addEventListener('hashchange', route);
    BatesScanner.listenWedge((code, format, source) => {
      if (currentRoute === 'count') countScan(code, format, source).then((m) => { if (m) showStatus(stripTags(m.html), m.kind === 'warn' ? 'warning' : 'success'); });
      else openCode(code, format);
    });
    route();
    refreshCatalog();
    store.flush();
  }

  // Status-line HTML (built from escaped values only) -> plain text for a toast.
  const stripTags = (h) => { const d = document.createElement('div'); d.innerHTML = String(h); return d.textContent; };

  let refreshing = null;
  function refreshCatalog() {
    if (!online() || refreshing) return refreshing || Promise.resolve();
    // With writes still queued the server copy would double-show them under
    // the replay; refresh once the queue drains (onFlushed calls us again).
    if (store.pendingOps().length) return Promise.resolve();
    refreshing = api('/api/inventory/catalog').then(async (cat) => {
      categories = cat.categories || categories;
      if (cat.permissions) perms = { view: !!cat.permissions.view, scan_out: !!cat.permissions.scan_out, manage: !!cat.permissions.manage };
      await store.setCatalog(cat);
      if (rerender) rerender();
    }).catch((e) => { console.warn('[inventory] catalog refresh failed:', e.message); }).finally(() => { refreshing = null; });
    return refreshing;
  }

  // ---- sync chip ----
  // The chip shows ONLY when something is waiting or wasn't saved. Tapping it
  // opens the details: what's waiting, tries, the last error, Retry.
  let syncSheet = null;
  function renderSync(st) {
    if (!st) return;
    if (syncSheet) syncSheet.refresh(st);
    syncEl.className = 'inv-sync';
    const waiting = st.pending;
    if (st.failed.length) {
      syncEl.classList.add('failed');
      syncEl.innerHTML = `${ICON.alert} ${st.failed.length} not saved${waiting ? ` &middot; ${waiting} waiting` : ''}`;
    } else if (waiting && !st.online) {
      syncEl.classList.add('offline');
      syncEl.innerHTML = `${ICON.cloudOff} Offline &middot; ${waiting} waiting to sync`;
    } else if (waiting) {
      syncEl.classList.add(st.lastError ? 'failed' : 'syncing');
      syncEl.innerHTML = `${st.lastError ? ICON.alert : ICON.sync} ${waiting} waiting to sync${st.lastError ? ' &middot; tap for details' : ''}`;
    } else {
      syncEl.hidden = true;
      return;
    }
    syncEl.hidden = false;
  }
  syncEl.addEventListener('click', () => { if (store) showSyncDetails(); });

  function showSyncDetails() {
    const s2 = openSheet('<div data-sync-body></div>', { onClose: () => { syncSheet = null; } });
    const body = s2.el.querySelector('[data-sync-body]');
    const draw = (st) => {
      const waitingRows = st.waiting.map((w) => `<li><strong>${esc(describeOp(w))}</strong>${w.scans > 1 ? ` <span class="inv-small">(${w.scans} scans)</span>` : ''}
        ${w.attempts ? `<br><span class="inv-small">${w.attempts} ${w.attempts === 1 ? 'try' : 'tries'}${w.lastError ? ' &middot; ' + esc(w.lastError) : ''}</span>` : ''}</li>`).join('');
      const failedRows = st.failed.map((f) => `<li><strong>${esc(describeOp(f))}</strong><br><span class="inv-small" style="color:var(--danger);">${esc(f.error)}</span><br>
        <span class="inv-row-gap" style="margin-top:4px;"><button type="button" class="btn btn-secondary btn-sm" data-retry-failed="${esc(f.op_id)}">Retry</button><button type="button" class="btn btn-ghost btn-sm" data-dismiss="${esc(f.op_id)}">Dismiss</button></span></li>`).join('');
      body.innerHTML = `
        <h3>Sync</h3>
        <dl class="inv-dl" style="margin-top:10px;">
          <dt>Waiting</dt><dd>${st.pending}${st.photos ? ` (incl. ${st.photos} photo${st.photos === 1 ? '' : 's'})` : ''}${st.syncing ? ' &middot; sending now' : ''}</dd>
          <dt>Connection</dt><dd>${st.online ? 'Online' : 'Offline - it sends when you\'re back online'}</dd>
          <dt>Last error</dt><dd>${st.lastError ? `<span style="color:var(--danger);">${esc(st.lastError)}</span> <span class="inv-small">${esc(fmtDateTime(st.lastErrorAt))}</span>` : 'None'}</dd>
          <dt>Last synced</dt><dd>${st.lastSyncAt ? esc(fmtDateTime(st.lastSyncAt)) : '-'}</dd>
        </dl>
        ${waitingRows ? `<h4 style="margin:14px 0 4px;">Waiting to sync</h4><ul class="inv-sync-list">${waitingRows}</ul>` : ''}
        ${failedRows ? `<h4 style="margin:14px 0 4px;">Not saved</h4><p class="inv-small" style="margin:0 0 6px;">These were refused or kept failing. They're kept on this phone - Retry sends them again, Dismiss throws them away.</p><ul class="inv-sync-list">${failedRows}</ul>` : ''}
        <div class="inv-sheet-actions">
          <button type="button" class="btn btn-secondary" data-close>Close</button>
          ${st.pending ? `<button type="button" class="btn btn-primary" data-retry-now${st.online ? '' : ' disabled'}>Retry now</button>` : ''}
        </div>`;
      body.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => s2.close()));
      const rn = body.querySelector('[data-retry-now]');
      if (rn) rn.addEventListener('click', () => { store.retryNow(); showStatus('Trying again...', 'info'); });
      body.querySelectorAll('[data-retry-failed]').forEach((b) => b.addEventListener('click', () => store.retryFailed(b.dataset.retryFailed)));
      body.querySelectorAll('[data-dismiss]').forEach((b) => b.addEventListener('click', async () => {
        const ok = await openConfirm({ title: 'Throw this change away?', message: 'It will never reach inventory. Redo it by hand if it\'s still needed.', confirmText: 'Dismiss', danger: true });
        if (ok) store.dismissFailed(b.dataset.dismiss);
      }));
    };
    syncSheet = { refresh: draw };
    draw(store.state());
  }
  function describeOp(f) {
    const p = f.payload || {};
    const item = p.item_id ? store.item(p.item_id) : (p.id ? store.item(p.id) : null);
    const name = (item && item.description) || p.description || 'an item';
    if (f.kind === 'txn') return `${TXN_LABEL[p.type] || p.type}${p.qty ? ' ' + fmtQty(p.qty) : ''} - ${name}`;
    if (f.kind === 'item_create') return `New item - ${name}`;
    if (f.kind === 'unit_create') return `Serial ${p.serial_number} - ${name}`;
    if (f.kind === 'photo') return `Photo - ${name}`;
    if (f.kind === 'undo') return `Undo - ${name}`;
    if (f.kind === 'session_lines') return `Bulk count (${(p.lines || []).length} items)`;
    if (f.kind === 'session_upsert') return 'Start bulk count';
    if (f.kind === 'session_post') return 'Save bulk count';
    if (f.kind === 'session_discard') return 'Discard bulk count';
    return f.kind.replace(/_/g, ' ');
  }

  // ============================================================================
  // Router
  // ============================================================================
  function route() {
    const h = location.hash.replace(/^#\/?/, '');
    const [pathPart, queryPart] = h.split('?');
    const parts = pathPart.split('/').filter(Boolean);
    const params = new URLSearchParams(queryPart || '');
    rerender = null;
    routeSeq += 1;
    window.scrollTo(0, 0);
    if (parts[0] === 'item' && parts[1]) { currentRoute = 'item'; renderItem(parts[1], params); }
    else if (parts[0] === 'count') { currentRoute = 'count'; renderCount(); }
    else if (parts[0] === 'surplus') { currentRoute = 'surplus'; renderSurplus(); }
    else if (parts[0] === 'reports') { currentRoute = 'reports'; renderReports(); }
    else { currentRoute = 'home'; renderHome(); }
  }

  // ============================================================================
  // Bottom sheet + small helpers
  // ============================================================================
  function openSheet(html, { onClose } = {}) {
    const back = document.createElement('div');
    back.className = 'inv-sheet-back';
    back.innerHTML = `<div class="inv-sheet" role="dialog" aria-modal="true">${html}</div>`;
    document.body.appendChild(back);
    const el = back.firstElementChild;
    let closed = false;
    const close = (v) => {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKey, true);
      back.remove();
      if (onClose) onClose(v);
    };
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(null); } };
    document.addEventListener('keydown', onKey, true);
    back.addEventListener('click', (e) => { if (e.target === back) close(null); });
    el.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => close(null)));
    return { el, close };
  }

  // A choice of 2-4 big buttons -> value | null.
  function choose({ title, message, options }) {
    return new Promise((resolve) => {
      const s = openSheet(`<h3>${esc(title)}</h3>${message ? `<p class="inv-muted">${esc(message)}</p>` : ''}
        <div class="inv-choice">${options.map((o, i) => `<button type="button" class="btn ${o.primary ? 'btn-primary' : 'btn-secondary'}" data-i="${i}">${esc(o.label)}</button>`).join('')}
        <button type="button" class="btn btn-ghost" data-close>Cancel</button></div>`, { onClose: (v) => resolve(v) });
      s.el.querySelectorAll('[data-i]').forEach((b) => b.addEventListener('click', () => s.close(options[Number(b.dataset.i)].value)));
    });
  }

  // Open the camera once; resolves with the code (typed codes count too).
  function scanOnce(title) {
    return new Promise((resolve) => {
      let got = null;
      const s = BatesScanner.open({ title, onScan: (code) => { got = code; return 'close'; } });
      s.onClose(() => resolve(got));
    });
  }

  // Shrink a camera photo to a ~1600px JPEG before it is queued/uploaded.
  async function shrinkPhoto(file) {
    const MAX = 1600;
    let src;
    try { src = await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch (e) {
      src = await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = URL.createObjectURL(file);
      });
    }
    const w = src.width; const h = src.height;
    const scale = Math.min(1, MAX / Math.max(w, h));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(w * scale); canvas.height = Math.round(h * scale);
    canvas.getContext('2d').drawImage(src, 0, 0, canvas.width, canvas.height);
    return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.82));
  }
  function pickPhoto() {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.setAttribute('capture', 'environment');
      input.addEventListener('change', async () => {
        const f = input.files && input.files[0];
        if (!f) return resolve(null);
        // Always re-encoded to a <=1600px JPEG here (iPhone photos are HEIC;
        // the bucket takes JPEG / PNG / WebP only).
        let jpeg = null;
        try { jpeg = await shrinkPhoto(f); } catch (e) { jpeg = null; }
        if (!jpeg || jpeg.type !== 'image/jpeg') {
          openAlert({ title: 'Couldn\'t use that photo', message: 'This phone couldn\'t turn it into a JPEG.', next: 'Take the photo again with the camera.' });
          return resolve(null);
        }
        resolve(jpeg);
      });
      input.click();
    });
  }

  // Photo upload, called by the store's queue. The JPEG goes to OUR backend
  // (POST .../photos/upload), which stores it with the service role - no
  // signed-URL PUT from the phone (CJ's iPhone test: a photo retried forever
  // and none ever landed). Resolves 'ok', or { drop, error } when the server
  // refused it for good (4xx - shown as "not saved"); throws to retry (5xx,
  // timeout, offline) - the store gives up and shows it after 5 tries.
  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
      r.onerror = () => reject(r.error || new Error('Could not read the photo on this phone'));
      r.readAsDataURL(blob);
    });
  }
  async function uploadPhoto(rec) {
    const data = await blobToBase64(rec.blob);
    const r = await rawApi(`/api/inventory/items/${rec.item_id}/photos/upload`, { method: 'POST', body: { photo_id: rec.photo_id, unit_id: rec.unit_id || null, data }, timeout: UPLOAD_TIMEOUT_MS });
    const body = await r.json().catch(() => ({}));
    if (r.status >= 400 && r.status < 500) return { drop: true, error: body.error || `The server refused this photo (${r.status}).` };
    if (!r.ok) throw new Error(body.error || `Photo upload failed (${r.status})`);
    if (currentRoute === 'item' && location.hash.indexOf(rec.item_id) !== -1 && rerender) rerender(true);
    return 'ok';
  }

  async function download(path, filename) {
    try {
      const r = await rawApi(path);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch (e) {
      openAlert({ title: 'Download failed', message: e.message, next: 'Check your connection and try again.', danger: true });
    }
  }

  // ============================================================================
  // Undo toast: ~10 s after + In / - Out / Count / scan-out
  // ============================================================================
  let undoToast = null;
  function showUndo(message, opId) {
    if (undoToast) undoToast.remove();
    const el = document.createElement('div');
    el.className = 'inv-undo';
    el.setAttribute('role', 'status');
    el.innerHTML = `<span class="inv-undo-msg">${esc(message)}${online() ? '' : ' <span class="inv-small">(saved on this phone)</span>'}</span>
      <button type="button" class="inv-undo-btn">Undo</button><i class="inv-undo-bar" style="animation-duration:${UNDO_TOAST_MS}ms"></i>`;
    document.body.appendChild(el);
    undoToast = el;
    const timer = setTimeout(() => { if (undoToast === el) { el.remove(); undoToast = null; } }, UNDO_TOAST_MS);
    el.querySelector('.inv-undo-btn').addEventListener('click', async () => {
      clearTimeout(timer);
      el.remove();
      if (undoToast === el) undoToast = null;
      const r = await store.undo(opId);
      if (r.error) return openAlert({ title: 'Nothing to undo', message: r.error });
      showStatus(r.dropped ? 'Undone - it never left this phone.' : (online() ? 'Undone.' : 'Undone (saved on this phone, will sync).'), 'success');
      if (rerender) rerender();
    });
  }

  // ============================================================================
  // Scanning outside a count session: open the item, or quick-add it.
  // ============================================================================
  async function findCode(code, format) {
    const local = store.lookup(code, format);
    if (local) return local;
    if (!online()) return null;
    try {
      const r = await api(`/api/inventory/lookup?code=${encodeURIComponent(code)}${format ? '&format=' + encodeURIComponent(format) : ''}`);
      if (!r.found) return null;
      await refreshCatalog();
      let item = store.item(r.item_id);
      if (!item) {
        // Catalog refresh waits for the queue to drain; load just this item.
        try { item = (await api('/api/inventory/items/' + encodeURIComponent(r.item_id))).item; } catch (e2) { item = { id: r.item_id, description: 'Item' }; }
      }
      const unit = r.unit_id ? (store.unitsOf(r.item_id).find((u) => u.id === r.unit_id) || { id: r.unit_id }) : null;
      return { item, unit };
    } catch (e) { return null; }
  }

  async function openCode(code, format) {
    const hit = await findCode(code, format);
    if (hit && hit.item) {
      location.hash = '#/item/' + hit.item.id + (hit.unit ? '?unit=' + hit.unit.id : '');
      return;
    }
    if (perms.manage) {
      const created = await quickAdd({ code, format });
      if (created) location.hash = '#/item/' + created.id;
      return;
    }
    openAlert({ title: 'Not in inventory', message: `Nothing matches ${code}.`, next: 'Search by part number or description instead - it may be on an item without that barcode.' });
  }

  function scanFromHome() {
    BatesScanner.open({
      title: 'Scan a barcode',
      onScan: (code, format) => { setTimeout(() => openCode(code, format), 0); return 'close'; },
    });
  }

  // ============================================================================
  // Quick add (unknown barcode, or "New item")
  // ============================================================================
  function quickAdd({ code, format, sessionId } = {}) {
    return new Promise((resolve) => {
      let remembered = {};
      try { remembered = JSON.parse(sessionStorage.getItem('bates.inv.lastAdd') || '{}'); } catch (e) { /* none */ }
      let photo = null;
      const catOpts = categories.map((c) => `<option value="${esc(c[0])}"${(remembered.category || 'misc') === c[0] ? ' selected' : ''}>${esc(c[1])}</option>`).join('');
      const s = openSheet(`
        <h3>New item</h3>
        ${code ? `<p class="inv-muted">Barcode <strong>${esc(code)}</strong>${format ? ` (${esc(format.replace(/_/g, '-').toUpperCase())})` : ''}</p>` : '<p class="inv-muted">No barcode - you can add one later from the item page.</p>'}
        <form data-qa autocomplete="off">
          <label class="inv-field">Description *<input name="description" required maxlength="200" placeholder="e.g. Generac 16kW air filter" /></label>
          <div class="inv-2col">
            <label class="inv-field" data-qty-wrap>Quantity *<input name="qty" type="number" inputmode="decimal" min="0" step="any" value="1" /></label>
            <label class="inv-field">Location<input name="location" maxlength="120" value="${esc(remembered.location || '')}" placeholder="Shelf / bin" /></label>
          </div>
          <label class="inv-field" data-serial-wrap hidden>Serial number of this unit<input name="serial_number" maxlength="120" placeholder="Scan or type later on the item page" /></label>
          <div class="inv-photo-pick"><button type="button" class="btn btn-secondary" data-photo>${ICON.camera} Take photo</button><span data-photo-preview class="inv-muted"></span></div>
          <button type="button" class="inv-details-toggle" data-more>More details</button>
          <div data-more-wrap hidden>
            <div class="inv-2col">
              <label class="inv-field">Part / model #<input name="part_number" maxlength="120" /></label>
              <label class="inv-field">Manufacturer<input name="manufacturer" maxlength="120" value="${esc(remembered.manufacturer || '')}" /></label>
              <label class="inv-field">Category<select name="category">${catOpts}</select></label>
              <label class="inv-field">Condition<select name="condition"><option value="new">New</option><option value="open_box">New - open box</option><option value="used">Used</option></select></label>
              <label class="inv-field">Unit<input name="unit_of_measure" maxlength="20" value="each" /></label>
              <label class="inv-field">Unit cost ($)<input name="unit_cost" type="number" inputmode="decimal" min="0" step="0.01" /></label>
            </div>
            <label class="inv-field" style="flex-direction:row;align-items:center;gap:8px;"><input type="checkbox" name="serialized" /> Track by serial number (ATSs, big-ticket gear)</label>
            <label class="inv-field">Notes<textarea name="notes" rows="2" maxlength="2000"></textarea></label>
          </div>
          <div class="inv-err" data-err hidden></div>
          <div class="inv-sheet-actions">
            <button type="button" class="btn btn-secondary" data-close>Cancel</button>
            <button type="submit" class="btn btn-primary">Save item</button>
          </div>
        </form>`, { onClose: (v) => resolve(v || null) });
      const form = s.el.querySelector('[data-qa]');
      setTimeout(() => form.description.focus(), 50);
      s.el.querySelector('[data-more]').addEventListener('click', (e) => { e.target.hidden = true; s.el.querySelector('[data-more-wrap]').hidden = false; });
      form.serialized.addEventListener('change', () => {
        s.el.querySelector('[data-qty-wrap]').hidden = form.serialized.checked;
        s.el.querySelector('[data-serial-wrap]').hidden = !form.serialized.checked;
      });
      s.el.querySelector('[data-photo]').addEventListener('click', async () => {
        const blob = await pickPhoto();
        if (!blob) return;
        photo = blob;
        s.el.querySelector('[data-photo-preview]').innerHTML = `<img src="${URL.createObjectURL(blob)}" alt="Photo preview" />`;
      });
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const err = s.el.querySelector('[data-err]');
        const description = form.description.value.trim();
        const serialized = form.serialized.checked;
        const qty = Number(form.qty.value);
        if (!description) { err.hidden = false; err.textContent = 'A description is required.'; return; }
        if (!serialized && (!Number.isFinite(qty) || qty < 0)) { err.hidden = false; err.textContent = 'Enter the quantity (0 or more).'; return; }
        const cost = form.unit_cost.value === '' ? null : Math.round(Number(form.unit_cost.value) * 100);
        if (cost != null && (!Number.isFinite(cost) || cost < 0)) { err.hidden = false; err.textContent = 'Unit cost must be a positive amount.'; return; }
        const id = uuid();
        const payload = {
          id, description,
          part_number: form.part_number.value.trim() || null,
          manufacturer: form.manufacturer.value.trim() || null,
          category: form.category.value || 'misc',
          condition: form.condition.value || 'new',
          location: form.location.value.trim() || null,
          unit_of_measure: form.unit_of_measure.value.trim() || 'each',
          unit_cost_cents: cost,
          notes: form.notes.value.trim() || null,
          serialized,
          barcode: code ? { code, format: format || null } : null,
          qty: serialized ? null : qty,
          initial_type: sessionId ? 'initial_count' : 'received',
          session_id: sessionId || null,
          client_op_id: uuid(),
          source: 'quick_add',
          occurred_at: new Date().toISOString(),
        };
        await store.enqueue('item_create', payload);
        const serial = serialized ? form.serial_number.value.trim() : '';
        if (serial) {
          await store.enqueue('unit_create', { id: uuid(), item_id: id, serial_number: serial, type: sessionId ? 'initial_count' : 'received', client_op_id: uuid(), session_id: sessionId || null, condition: payload.condition, source: 'quick_add' });
        }
        if (photo) await store.queuePhoto({ photo_id: uuid(), item_id: id, unit_id: null, blob: photo });
        try { sessionStorage.setItem('bates.inv.lastAdd', JSON.stringify({ location: payload.location, category: payload.category, manufacturer: payload.manufacturer })); } catch (e2) { /* fine */ }
        s.close({ id, qty: serialized ? (serial ? 1 : 0) : qty, serialized, serial });
      });
    });
  }

  // ============================================================================
  // "For what?" (scan-out) - optional job note / Generator Care customer
  // ============================================================================
  function forWhat(item, qtyText) {
    return new Promise((resolve) => {
      let customer = null;
      const s = openSheet(`
        <h3>Scan out ${esc(qtyText)}</h3>
        <p class="inv-muted">${esc(item.description)} &middot; For what? (optional)</p>
        <label class="inv-field">Job<input data-job maxlength="200" placeholder="Job name or number" /></label>
        <label class="inv-field">or a Generator Care customer
          <input data-cust type="search" placeholder="${online() ? 'Search customers by name' : 'Customer search needs a connection'}" ${online() ? '' : 'disabled'} />
        </label>
        <div class="inv-cust-list" data-cust-list></div>
        <label class="inv-field">Note<input data-note maxlength="500" /></label>
        <div class="inv-sheet-actions">
          <button type="button" class="btn btn-secondary" data-close>Cancel</button>
          <button type="button" class="btn btn-primary" data-ok>Scan out</button>
        </div>`, { onClose: (v) => resolve(v || null) });
      const list = s.el.querySelector('[data-cust-list]');
      let t = null;
      s.el.querySelector('[data-cust]').addEventListener('input', (e) => {
        clearTimeout(t);
        const q = e.target.value.trim();
        if (q.length < 2) { list.innerHTML = ''; return; }
        t = setTimeout(async () => {
          try {
            const { customers } = await api('/api/inventory/customers?q=' + encodeURIComponent(q));
            list.innerHTML = customers.map((c) => `<button type="button" data-id="${esc(c.id)}"${customer && customer.id === c.id ? ' class="on"' : ''}>${esc(c.name)}${c.install_city ? ` <span class="inv-small">${esc(c.install_city)}</span>` : ''}</button>`).join('') || '<span class="inv-small">No match</span>';
            list.querySelectorAll('[data-id]').forEach((b) => b.addEventListener('click', () => {
              customer = customers.find((c) => c.id === b.dataset.id);
              list.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
            }));
          } catch (err) { list.innerHTML = '<span class="inv-small">Search failed</span>'; }
        }, 250);
      });
      s.el.querySelector('[data-ok]').addEventListener('click', () => s.close({
        job_note: s.el.querySelector('[data-job]').value.trim() || null,
        customer_id: customer ? customer.id : null,
        note: s.el.querySelector('[data-note]').value.trim() || null,
      }));
      setTimeout(() => s.el.querySelector('[data-job]').focus(), 50);
    });
  }

  // ============================================================================
  // Home
  // ============================================================================
  const homeState = (() => {
    try { return JSON.parse(sessionStorage.getItem('bates.inv.home') || 'null') || {}; } catch (e) { return {}; }
  })();
  homeState.q = homeState.q || ''; homeState.cat = homeState.cat || ''; homeState.chips = homeState.chips || {}; homeState.sort = homeState.sort || 'name';
  const saveHome = () => { try { sessionStorage.setItem('bates.inv.home', JSON.stringify(homeState)); } catch (e) { /* fine */ } };

  const FILTER_CHIPS = [['instock', 'In stock'], ['surplus', 'Surplus'], ['serialized', 'Serialized'], ['recount', 'Needs recount']];
  const SORTS = [['name', 'Name'], ['qty', 'Most on hand'], ['recent', 'Recently changed'], ['location', 'Location']];
  const activeFilters = () => (homeState.cat ? 1 : 0) + FILTER_CHIPS.filter((c) => homeState.chips[c[0]]).length;

  function renderHome() {
    viewEl.innerHTML = `
      <button type="button" class="inv-bigbtn primary full inv-scan-main" data-scan>${ICON.scan} Scan</button>
      ${perms.manage ? `<a class="inv-bulk" href="#/count"><span class="inv-bulk-icon">${ICON.count}</span><span class="inv-bulk-text"><strong>Bulk count</strong><span>Scan many items, then save all at once</span></span></a>` : ''}
      <div class="inv-toolbar">
        <form class="inv-search" data-search autocomplete="off">
          <input type="search" enterkeyhint="search" placeholder="Search barcode, part #, name" value="${esc(homeState.q)}" aria-label="Search inventory" />
        </form>
        <button type="button" class="btn btn-secondary inv-tool" data-filter aria-haspopup="dialog">${ICON.filter} Filter</button>
        <button type="button" class="btn btn-secondary inv-tool" data-more aria-haspopup="dialog">More</button>
      </div>
      <div class="inv-filter-on" data-filter-on hidden></div>
      <div data-count class="inv-small"></div>
      <div class="inv-list" data-list></div>`;
    const input = $('[data-search] input', viewEl);
    input.addEventListener('input', () => { homeState.q = input.value; saveHome(); drawList(); });
    $('[data-search]', viewEl).addEventListener('submit', (e) => {
      e.preventDefault();
      const q = input.value.trim();
      if (!q) return;
      const hit = store.lookup(q);
      if (hit) { location.hash = '#/item/' + hit.item.id + (hit.unit ? '?unit=' + hit.unit.id : ''); return; }
      input.blur();
      drawList();
    });
    $('[data-scan]', viewEl).addEventListener('click', scanFromHome);
    $('[data-filter]', viewEl).addEventListener('click', () => openFilterSheet(drawList));
    $('[data-more]', viewEl).addEventListener('click', openMoreMenu);
    let limit = 150;
    function drawFilterChip() {
      const n = activeFilters();
      const el = $('[data-filter-on]', viewEl);
      if (!el) return;
      el.hidden = !n;
      el.innerHTML = n ? `<span class="inv-chip on">${n} ${n === 1 ? 'filter' : 'filters'} on</span><button type="button" class="btn btn-ghost btn-sm" data-clear-filters>Clear</button>` : '';
      const c = el.querySelector('[data-clear-filters]');
      if (c) c.addEventListener('click', () => { homeState.cat = ''; homeState.chips = {}; saveHome(); drawList(); });
      $('[data-filter]', viewEl).classList.toggle('on', !!n);
    }
    function drawList() {
      drawFilterChip();
      let items = store.search(homeState.q);
      if (homeState.cat) items = items.filter((i) => i.category === homeState.cat);
      if (homeState.chips.instock) items = items.filter((i) => i.qty_on_hand > 0);
      if (homeState.chips.surplus) items = items.filter((i) => i.surplus_qty > 0);
      if (homeState.chips.serialized) items = items.filter((i) => i.serialized);
      if (homeState.chips.recount) items = items.filter((i) => i.qty_on_hand < 0);
      const by = {
        name: (a, b) => a.description.localeCompare(b.description),
        qty: (a, b) => b.qty_on_hand - a.qty_on_hand,
        recent: (a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')),
        location: (a, b) => String(a.location || '~').localeCompare(String(b.location || '~')),
      }[homeState.sort];
      items = items.slice().sort(by);
      const total = store.view().items.length;
      $('[data-count]', viewEl).textContent = total ? `${items.length} of ${total} items` : '';
      const listEl = $('[data-list]', viewEl);
      if (!total) {
        listEl.innerHTML = `<div class="inv-empty">${store.view().generated_at ? 'Nothing in inventory yet.' : (online() ? 'Loading&hellip;' : 'Offline - inventory loads the first time you\'re online.')}${perms.manage && store.view().generated_at ? '<br>Start with a <a href="#/count">bulk count</a>.' : ''}</div>`;
        return;
      }
      if (!items.length) { listEl.innerHTML = '<div class="inv-empty">No items match.</div>'; return; }
      listEl.innerHTML = items.slice(0, limit).map(itemRow).join('') +
        (items.length > limit ? `<button type="button" class="btn btn-ghost" data-more style="margin:8px;">Show ${Math.min(150, items.length - limit)} more</button>` : '');
      const more = $('[data-more]', listEl);
      if (more) more.addEventListener('click', () => { limit += 150; drawList(); });
    }
    drawList();
    rerender = drawList;
  }

  // Filter: category, in stock / surplus / serialized / needs recount, sort.
  // Applies as you tap; Done closes.
  function openFilterSheet(onChange) {
    const s2 = openSheet(`
      <h3>Filter</h3>
      <label class="inv-field">Category<select data-f-cat><option value="">All categories</option>${categories.map((c) => `<option value="${esc(c[0])}"${homeState.cat === c[0] ? ' selected' : ''}>${esc(c[1])}</option>`).join('')}</select></label>
      <div class="inv-field">Show only
        <div class="inv-filter-chips">${FILTER_CHIPS.map((c) => `<button type="button" class="inv-chip${homeState.chips[c[0]] ? ' on' : ''}" data-f-chip="${c[0]}" aria-pressed="${!!homeState.chips[c[0]]}">${c[1]}</button>`).join('')}</div>
      </div>
      <label class="inv-field">Sort by<select data-f-sort>${SORTS.map((o) => `<option value="${o[0]}"${homeState.sort === o[0] ? ' selected' : ''}>${o[1]}</option>`).join('')}</select></label>
      <div class="inv-sheet-actions" style="justify-content:space-between;">
        <button type="button" class="btn btn-ghost" data-f-clear>Clear filters</button>
        <button type="button" class="btn btn-primary" data-close>Done</button>
      </div>`);
    const changed = () => { saveHome(); onChange(); };
    s2.el.querySelector('[data-f-cat]').addEventListener('change', (e) => { homeState.cat = e.target.value; changed(); });
    s2.el.querySelector('[data-f-sort]').addEventListener('change', (e) => { homeState.sort = e.target.value; changed(); });
    s2.el.querySelectorAll('[data-f-chip]').forEach((b) => b.addEventListener('click', () => {
      const k = b.dataset.fChip;
      homeState.chips[k] = !homeState.chips[k];
      b.classList.toggle('on', !!homeState.chips[k]);
      b.setAttribute('aria-pressed', String(!!homeState.chips[k]));
      changed();
    }));
    s2.el.querySelector('[data-f-clear]').addEventListener('click', () => {
      homeState.cat = ''; homeState.chips = {};
      s2.el.querySelector('[data-f-cat]').value = '';
      s2.el.querySelectorAll('[data-f-chip]').forEach((b) => { b.classList.remove('on'); b.setAttribute('aria-pressed', 'false'); });
      changed();
    });
  }

  function openMoreMenu() {
    const s2 = openSheet(`
      <h3>More</h3>
      <div class="inv-menu">
        <a class="inv-menu-item" href="#/surplus">${ICON.tag}<span><strong>Surplus list</strong><span class="inv-small">What we're selling - CSV and PDF for dealers</span></span></a>
        <a class="inv-menu-item" href="#/reports">${ICON.chart}<span><strong>Reports</strong><span class="inv-small">Totals, value, recently out, not touched in 12 months</span></span></a>
        ${perms.manage ? `<button type="button" class="inv-menu-item" data-m-new>${ICON.box}<span><strong>New item (no barcode)</strong><span class="inv-small">Add something that has no barcode</span></span></button>` : ''}
      </div>
      <div class="inv-sheet-actions"><button type="button" class="btn btn-secondary" data-close>Close</button></div>`);
    s2.el.querySelectorAll('a.inv-menu-item').forEach((a) => a.addEventListener('click', () => s2.close()));
    const n = s2.el.querySelector('[data-m-new]');
    if (n) n.addEventListener('click', async () => { s2.close(); const c = await quickAdd({}); if (c) location.hash = '#/item/' + c.id; });
  }

  function itemRow(i) {
    const q = i.qty_on_hand;
    const sub = [i.part_number && '#' + i.part_number, i.manufacturer, i.location].filter(Boolean).map(esc).join(' &middot; ');
    return `<a class="inv-item" href="#/item/${esc(i.id)}">
      <span class="inv-thumb">${i.thumb_url ? `<img src="${esc(i.thumb_url)}" alt="" loading="lazy" />` : ICON.box}</span>
      <span><span class="inv-item-title">${esc(i.description)}</span>
        ${i._pending ? ' <span class="inv-badge pending">Not synced</span>' : ''}${i.surplus_qty > 0 ? ` <span class="inv-badge surplus">Surplus ${fmtQty(i.surplus_qty)}</span>` : ''}${i.serialized ? ' <span class="inv-badge">Serial</span>' : ''}
        <span class="inv-item-sub" style="display:block;">${sub || '&nbsp;'}</span></span>
      <span class="inv-qty${q === 0 ? ' zero' : ''}${q < 0 ? ' neg' : ''}">${fmtQty(q)}<small>${esc(i.unit_of_measure || 'each')}</small></span>
    </a>`;
  }

  // ============================================================================
  // Item page
  // ============================================================================
  async function renderItem(id, params) {
    let detail = null;
    let loading = false;
    let stepQty = 1;
    const focusUnit = params.get('unit');
    const alive = routeToken();
    let lastResult = null; // what the last + In / - Out / Count did (shows Scan next / Back)

    function nextStep() {
      if (!lastResult) return '';
      return `<section class="card inv-next" aria-live="polite">
        <div class="inv-next-msg">${ICON.check}<span>${esc(lastResult)}</span></div>
        <div class="inv-next-btns">
          <button type="button" class="inv-bigbtn primary" data-next-scan>${ICON.scan} Scan next</button>
          <a class="inv-bigbtn" href="#/">Back to inventory</a>
        </div>
      </section>`;
    }

    async function load(force) {
      if (!online() || loading) return;
      loading = true;
      try { detail = await api('/api/inventory/items/' + encodeURIComponent(id)); }
      catch (e) { if (e.status === 404 && !store.item(id) && alive()) { viewEl.innerHTML = '<section class="card"><p>Item not found.</p><a class="btn btn-secondary btn-sm" href="#/">Back</a></section>'; loading = false; return; } }
      loading = false;
      if (force !== false) draw();
    }

    function current() {
      const local = store.item(id);
      const server = detail && detail.item;
      if (!local && !server) return null;
      // Queued writes are reflected in the store view; prefer its qty while any are pending.
      const pend = store.pendingOps().some((o) => (o.payload && (o.payload.item_id === id || o.payload.id === id)));
      const base = { ...(server || {}), ...(local ? { qty_on_hand: local.qty_on_hand, surplus_qty: local.surplus_qty } : {}) };
      if (!server && local) Object.assign(base, local);
      if (server && !pend) { base.qty_on_hand = server.qty_on_hand; base.surplus_qty = server.surplus_qty; }
      base._pending = pend;
      return base;
    }

    function draw() {
      if (!alive()) return;
      const it = current();
      if (!it) {
        viewEl.innerHTML = online() ? '<div class="inv-skel"><span style="width:60%"></span><span style="width:80%"></span></div>' : '<section class="card"><p>This item isn\'t on this phone yet. Connect to load it.</p><a class="btn btn-secondary btn-sm" href="#/">Back</a></section>';
        return;
      }
      const photos = (detail && detail.photos) || [];
      const primary = photos.find((p) => p.is_primary && !p.unit_id) || photos.find((p) => !p.unit_id);
      const heroImg = (primary && primary.url) || it.thumb_url;
      const units = detail ? detail.units : store.unitsOf(id);
      const inStockUnits = units.filter((u) => u.status === 'in_stock');
      const q = it.qty_on_hand;
      const keep = Math.max(0, q - (it.surplus_qty || 0));
      const value = it.unit_cost_cents != null && q > 0 ? it.unit_cost_cents * q : null;
      const canIn = perms.manage; const canOut = perms.scan_out; const canCount = perms.manage;

      const actions = (canIn || canOut) ? (it.serialized ? `
        <section class="card">
          <div class="inv-act-grid" style="grid-template-columns:1fr 1fr;margin-top:0;">
            ${canIn ? '<button type="button" class="inv-act in" data-act="unit-in">+ Receive unit</button>' : ''}
            ${canOut ? `<button type="button" class="inv-act out" data-act="unit-out"${inStockUnits.length ? '' : ' disabled'}>&minus; Scan out unit</button>` : ''}
          </div>
        </section>` : `
        <section class="card">
          <div class="inv-row-gap" style="justify-content:center;">
            <div class="inv-stepper"><button type="button" data-step="-1" aria-label="Less">&minus;</button><input type="number" inputmode="decimal" min="0" step="any" value="${stepQty}" data-stepq aria-label="Quantity" /><button type="button" data-step="1" aria-label="More">+</button></div>
          </div>
          <div class="inv-act-grid" style="grid-template-columns:repeat(${[canIn, canOut, canCount].filter(Boolean).length}, 1fr);">
            ${canIn ? '<button type="button" class="inv-act in" data-act="in">+ In</button>' : ''}
            ${canOut ? '<button type="button" class="inv-act out" data-act="out">&minus; Out</button>' : ''}
            ${canCount ? '<button type="button" class="inv-act" data-act="count">Count</button>' : ''}
          </div>
        </section>`) : '<p class="inv-muted">Look-up only. Ask an administrator if you need to scan items out.</p>';

      const surplus = perms.manage ? `
        <section class="card">
          <h3 class="inv-section-h">Keep vs. surplus <span class="inv-small">surplus = for sale</span></h3>
          <div class="inv-2col">
            <label class="inv-field">Surplus qty<input type="number" inputmode="decimal" min="0" max="${Math.max(q, 0)}" step="any" value="${fmtQty(it.surplus_qty || 0)}" data-sq /><small>Keep: <span data-keep>${fmtQty(keep)}</span> of ${fmtQty(q)}</small></label>
            <label class="inv-field">Asking price (each)<input type="number" inputmode="decimal" min="0" step="0.01" value="${it.surplus_price_cents == null ? '' : (it.surplus_price_cents / 100).toFixed(2)}" data-sp placeholder="$" /></label>
          </div>
          <label class="inv-field">Surplus notes<input maxlength="1000" value="${esc(it.surplus_notes || '')}" data-sn /></label>
          <div class="inv-sheet-actions" style="justify-content:space-between;">
            <button type="button" class="btn btn-secondary" data-act="sell">Sell / dispose&hellip;</button>
            <button type="button" class="btn btn-primary" data-act="save-surplus">Save surplus</button>
          </div>
        </section>` : (it.surplus_qty > 0 ? `<section class="card"><h3 class="inv-section-h">Surplus</h3><p style="margin:0;">${fmtQty(it.surplus_qty)} for sale${it.surplus_price_cents != null ? ` at ${money(it.surplus_price_cents)} each` : ''} &middot; keep ${fmtQty(keep)}</p>${it.surplus_notes ? `<p class="inv-muted">${esc(it.surplus_notes)}</p>` : ''}</section>` : '');

      const codes = detail ? detail.barcodes : store.view().barcodes.filter((b) => b.item_id === id);
      const details = `
        <section class="card">
          <h3 class="inv-section-h">Details ${perms.manage && detail ? '<button type="button" class="btn btn-ghost btn-sm" data-act="edit">Edit</button>' : ''}</h3>
          <dl class="inv-dl">
            <dt>Location</dt><dd>${esc(it.location || '-')}</dd>
            <dt>Category</dt><dd>${esc(catLabel(it.category))}</dd>
            <dt>Condition</dt><dd>${esc(COND[it.condition] || it.condition || '')}</dd>
            <dt>Unit</dt><dd>${esc(it.unit_of_measure || 'each')}</dd>
            <dt>Unit cost</dt><dd>${it.unit_cost_cents != null ? money(it.unit_cost_cents) : '-'}</dd>
            <dt>Value on hand</dt><dd>${value != null ? money(value) : '-'}</dd>
            ${it.notes ? `<dt>Notes</dt><dd>${esc(it.notes)}</dd>` : ''}
            <dt>Barcodes</dt><dd>${codes.length ? codes.map((b) => `<div>${esc(b.code)}${b.format ? ` <span class="inv-small">${esc(String(b.format).replace(/_/g, '-').toUpperCase())}</span>` : ''}${perms.manage && b.id && detail ? ` <button type="button" class="btn btn-ghost btn-sm" data-rm-code="${esc(b.id)}" aria-label="Remove barcode">Remove</button>` : ''}</div>`).join('') : '-'}
              ${perms.manage && detail ? '<button type="button" class="btn btn-ghost btn-sm" data-act="add-code">+ Add barcode</button>' : ''}</dd>
            ${it.last_count ? `<dt>Last counted</dt><dd>${esc(fmtDate(it.last_count.at))}${it.last_count.by ? ' by ' + esc(it.last_count.by) : ''}</dd>` : ''}
          </dl>
        </section>`;

      const unitsCard = it.serialized ? `
        <section class="card">
          <h3 class="inv-section-h">Serial numbers <span class="inv-small">${inStockUnits.length} in stock</span></h3>
          <div class="inv-units">${units.length ? units.map((u) => `<div class="inv-unit"${u.id === focusUnit ? ' style="border-color:var(--accent);"' : ''}><span><strong>${esc(u.serial_number)}</strong>${u.condition && u.condition !== it.condition ? ` <span class="inv-small">${esc(COND[u.condition] || u.condition)}</span>` : ''}</span>
            <span class="inv-badge ${u.status === 'in_stock' ? 'ok' : ''}">${esc({ in_stock: 'In stock', out: 'Scanned out', sold: 'Sold', disposed: 'Disposed', pending: 'Pending' }[u.status] || u.status)}</span></div>`).join('') : '<span class="inv-muted">No units yet.</span>'}</div>
        </section>` : '';

      const photosCard = `
        <section class="card">
          <h3 class="inv-section-h">Photos ${perms.manage ? '<button type="button" class="btn btn-ghost btn-sm" data-act="photo">+ Add photo</button>' : ''}</h3>
          ${detail ? (photos.length ? `<div class="inv-photos">${photos.map((p) => `<div class="inv-photo">${p.url ? `<img src="${esc(p.url)}" alt="Item photo" loading="lazy" />` : ''}${p.is_primary ? '<span class="inv-badge ok">Main</span>' : ''}
            ${perms.manage ? `<span class="inv-photo-tools">${p.is_primary ? '' : `<button type="button" data-primary="${esc(p.id)}">Main</button>`}<button type="button" data-rm-photo="${esc(p.id)}">Delete</button></span>` : ''}</div>`).join('')}</div>` : '<span class="inv-muted">No photos yet.</span>') : '<span class="inv-muted">Photos load when you\'re online.</span>'}
        </section>`;

      const undoable = detail ? undoCandidate(detail.history) : null;
      const undoneIds = new Set(detail ? detail.history.filter((h) => h.reverses_txn_id).map((h) => h.reverses_txn_id) : []);
      const history = detail ? `
        <section class="card">
          <h3 class="inv-section-h">History</h3>
          <ul class="inv-hist">${detail.history.length ? detail.history.map((h) => `<li>
            <span class="inv-hist-what"><strong>${h.reverses_txn_id ? 'Undo' : esc(TXN_LABEL[h.txn_type] || h.txn_type)}</strong>${h.serial_number ? ` &middot; SN ${esc(h.serial_number)}` : ''}${undoneIds.has(h.id) ? ' <span class="inv-badge">Undone</span>' : ''}<br>
              <span class="inv-small">${esc(fmtDateTime(h.occurred_at || h.created_at))}${h.actor ? ' &middot; ' + esc(h.actor) : ''}${h.job_note ? ' &middot; ' + esc(h.job_note) : ''}${h.customer ? ' &middot; ' + esc(h.customer) : ''}${h.note ? ' &middot; ' + esc(h.note) : ''}</span>
              ${undoable && undoable.id === h.id ? `<br><button type="button" class="btn btn-ghost btn-sm inv-hist-undo" data-undo-txn="${esc(h.id)}">Undo this</button>` : ''}</span>
            <span class="chg ${h.qty_change < 0 ? 'minus' : (h.qty_change > 0 ? 'plus' : '')}">${h.qty_change > 0 ? '+' : ''}${fmtQty(h.qty_change)}<br><span class="inv-small">= ${fmtQty(h.resulting_qty)}</span></span></li>`).join('') : '<li><span class="inv-muted">Nothing yet.</span></li>'}</ul>
        </section>` : '';

      viewEl.innerHTML = `
        <a href="#/" class="btn btn-secondary inv-back">&larr; Back to inventory</a>
        <section class="card inv-hero">
          <div class="inv-hero-top">
            <button type="button" class="inv-hero-photo" data-act="${perms.manage ? 'photo' : ''}" aria-label="${heroImg ? 'Photo' : 'Add a photo'}">${heroImg ? `<img src="${esc(heroImg)}" alt="" />` : ICON.camera}</button>
            <div class="inv-hero-text">
              <h2>${esc(it.description)}</h2>
              <div class="inv-small">${[it.part_number && 'Part # ' + it.part_number, it.manufacturer].filter(Boolean).map(esc).join(' &middot; ')}</div>
            </div>
          </div>
          <div class="inv-hero-qty">
            <span class="inv-hero-num${q < 0 ? ' neg' : ''}">${fmtQty(q)}</span>
            <span class="inv-muted">${esc(it.unit_of_measure || 'each')} on hand</span>
            ${it._pending ? '<span class="inv-badge pending">Syncing</span>' : ''}
            ${it.surplus_qty > 0 ? `<span class="inv-badge">Keep ${fmtQty(keep)}</span><span class="inv-badge surplus">Surplus ${fmtQty(it.surplus_qty)}</span>` : ''}
            ${q < 0 ? '<span class="inv-badge warn">Needs recount</span>' : ''}
          </div>
        </section>
        ${actions}${nextStep()}${surplus}${unitsCard}${details}${photosCard}${history}
        ${!detail && !online() ? '<p class="inv-muted">Offline: showing what this phone has. History and photos load when you\'re back online.</p>' : ''}`;
      wire(it, units, inStockUnits);
    }

    function wire(it, units, inStockUnits) {
      const stepInput = $('[data-stepq]', viewEl);
      viewEl.querySelectorAll('[data-step]').forEach((b) => b.addEventListener('click', () => {
        stepQty = Math.max(1, (Number(stepInput.value) || 0) + Number(b.dataset.step));
        stepInput.value = stepQty;
      }));
      if (stepInput) stepInput.addEventListener('change', () => { stepQty = Math.max(0, Number(stepInput.value) || 0); });
      const sq = $('[data-sq]', viewEl);
      if (sq) sq.addEventListener('input', () => { const k = $('[data-keep]', viewEl); if (k) k.textContent = fmtQty(Math.max(0, it.qty_on_hand - (Number(sq.value) || 0))); });
      viewEl.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => act(b.dataset.act, it, inStockUnits)));
      viewEl.querySelectorAll('[data-rm-code]').forEach((b) => b.addEventListener('click', () => removeCode(b.dataset.rmCode)));
      viewEl.querySelectorAll('[data-primary]').forEach((b) => b.addEventListener('click', () => photoAction(b.dataset.primary, 'primary')));
      viewEl.querySelectorAll('[data-rm-photo]').forEach((b) => b.addEventListener('click', () => photoAction(b.dataset.rmPhoto, 'delete')));
      viewEl.querySelectorAll('[data-undo-txn]').forEach((b) => b.addEventListener('click', () => undoFromHistory(b.dataset.undoTxn)));
      const sn = $('[data-next-scan]', viewEl);
      if (sn) sn.addEventListener('click', scanFromHome);
    }

    // My most recent change on this item that still stands, if it can still
    // be undone (type, 15 minutes, permission). The server re-checks all of it.
    function undoCandidate(history) {
      if (!me) return null;
      const undone = new Set(history.filter((h) => h.reverses_txn_id).map((h) => h.reverses_txn_id));
      const mine = history.find((h) => h.actor_id === me.id && !h.reverses_txn_id && !undone.has(h.id));
      if (!mine || mine.session_id || !UNDOABLE.has(mine.txn_type)) return null;
      if (Date.now() - new Date(mine.created_at).getTime() > UNDO_WINDOW_MS) return null;
      if (mine.txn_type === 'scanned_out' ? !perms.scan_out : !perms.manage) return null;
      return mine;
    }

    async function undoFromHistory(txnId) {
      const h = detail && detail.history.find((x) => x.id === txnId);
      if (!h) return;
      const what = `${TXN_LABEL[h.txn_type] || h.txn_type} ${h.qty_change > 0 ? '+' : ''}${fmtQty(h.qty_change)}${h.serial_number ? ' (SN ' + h.serial_number + ')' : ''}`;
      const ok = await openConfirm({ title: 'Undo this change?', message: `${what}, ${fmtDateTime(h.created_at)}. Both lines stay in the history.`, confirmText: 'Undo' });
      if (!ok) return;
      await store.undoTxn({ id: h.id, item_id: id, qty_change: h.qty_change, unit_id: h.unit_id });
      draw();
      showStatus(online() ? 'Undone.' : 'Undone (saved on this phone, will sync).', 'success');
      setTimeout(() => load(), 900);
    }

    const qtyNow = () => { const s = $('[data-stepq]', viewEl); return s ? Number(s.value) || 0 : stepQty; };

    async function txn(type, payload, doneMsg) {
      const op = await store.enqueue('txn', { client_op_id: uuid(), item_id: id, type, occurred_at: new Date().toISOString(), source: 'item_page', ...payload });
      const now = store.item(id);
      lastResult = doneMsg + (now ? ` - ${fmtQty(now.qty_on_hand)} ${now.unit_of_measure || 'each'} on hand` : '');
      draw();
      if (UNDOABLE.has(type)) showUndo(doneMsg, op.op_id);
      else showStatus(doneMsg + (online() ? '' : ' (saved on this phone, will sync)'), 'success');
      setTimeout(() => load(), 900);
    }

    async function act(kind, it, inStockUnits) {
      if (!kind) return;
      const q = qtyNow();
      if (kind === 'in') {
        if (!(q > 0)) return showStatus('Enter how many came in.', 'error');
        return txn('received', { qty: q }, `Received ${fmtQty(q)}`);
      }
      if (kind === 'out') {
        if (!(q > 0)) return showStatus('Enter how many are going out.', 'error');
        if (q > it.qty_on_hand) {
          if (online()) {
            return openAlert({ title: `Only ${fmtQty(it.qty_on_hand)} on hand`, message: `You're scanning out ${fmtQty(q)}, but inventory shows ${fmtQty(it.qty_on_hand)}.`, next: perms.manage ? 'If the shelf has more, use Count to fix the number first.' : 'Ask the warehouse to recount this item.' });
          }
          const ok = await openConfirm({ title: 'More than this phone shows', message: `This phone shows ${fmtQty(it.qty_on_hand)} on hand. Scan out ${fmtQty(q)} anyway? It will be flagged for a recount.`, confirmText: 'Scan out anyway' });
          if (!ok) return;
        }
        const why = await forWhat(it, `${fmtQty(q)} ${it.unit_of_measure || 'each'}`);
        if (!why) return;
        return txn('scanned_out', { qty: q, ...why }, `Scanned out ${fmtQty(q)}`);
      }
      if (kind === 'count') {
        const v = await openPrompt({
          title: 'Count', message: `How many ${it.description} are on the shelf right now?`,
          fields: [{ name: 'qty', label: 'Counted', type: 'number', inputmode: 'decimal', min: 0, step: 'any', value: fmtQty(it.qty_on_hand) }, { name: 'note', label: 'Note (optional)' }],
          confirmText: 'Save count',
          validate: (vals) => (vals.qty === '' || !(Number(vals.qty) >= 0) ? 'Enter the number on the shelf (0 or more).' : null),
        });
        if (!v) return;
        return txn('adjustment', { set_qty: Number(v.qty), note: v.note || null }, `Count saved: ${fmtQty(v.qty)}`);
      }
      if (kind === 'unit-in') {
        const serial = await scanOnce('Scan or type the serial number');
        if (!serial) return;
        const existing = store.unitsOf(id).find((u) => String(u.serial_number).toUpperCase() === serial.trim().toUpperCase());
        if (existing && existing.status === 'in_stock') return openAlert({ title: 'Already in stock', message: `Serial ${serial} is already in stock on this item.` });
        const op = await store.enqueue('unit_create', { id: existing ? existing.id : uuid(), item_id: id, serial_number: serial.trim(), type: 'received', client_op_id: uuid(), occurred_at: new Date().toISOString(), source: 'item_page' });
        const nowU = store.item(id);
        lastResult = `Received serial ${serial}` + (nowU ? ` - ${fmtQty(nowU.qty_on_hand)} on hand` : '');
        draw();
        showUndo(`Received serial ${serial}`, op.op_id);
        setTimeout(() => load(), 900);
        return;
      }
      if (kind === 'unit-out' || (kind === 'sell' && it.serialized)) {
        const unit = await pickUnit(inStockUnits, kind === 'sell' ? 'Which unit?' : 'Which unit is going out?');
        if (!unit) return;
        if (kind === 'sell') return sellDispose(it, unit);
        const why = await forWhat(it, 'serial ' + unit.serial_number);
        if (!why) return;
        return txn('scanned_out', { unit_id: unit.id, ...why }, `Scanned out serial ${unit.serial_number}`);
      }
      if (kind === 'sell') return sellDispose(it, null);
      if (kind === 'save-surplus') return saveSurplus(it);
      if (kind === 'edit') return editItem(it);
      if (kind === 'add-code') return addCode();
      if (kind === 'photo') {
        if (!perms.manage) return;
        const blob = await pickPhoto();
        if (!blob) return;
        await store.queuePhoto({ photo_id: uuid(), item_id: id, unit_id: null, blob });
        showStatus(online() ? 'Uploading photo...' : 'Photo saved on this phone - it uploads when you\'re online.', 'info');
      }
    }

    async function pickUnit(list, title) {
      if (!list.length) { openAlert({ title: 'Nothing in stock', message: 'No units of this item are in stock.' }); return null; }
      const opts = list.slice(0, 8).map((u) => ({ label: 'SN ' + u.serial_number, value: u.id }));
      opts.push({ label: 'Scan the serial instead', value: '__scan' });
      const v = await choose({ title, options: opts });
      if (!v) return null;
      if (v !== '__scan') return list.find((u) => u.id === v);
      const code = await scanOnce('Scan or type the serial number');
      if (!code) return null;
      const u = list.find((x) => String(x.serial_number).toUpperCase() === code.trim().toUpperCase());
      if (!u) { openAlert({ title: 'Not in stock', message: `Serial ${code} isn't in stock on this item.` }); return null; }
      return u;
    }

    async function sellDispose(it, unit) {
      const fields = [{ name: 'type', label: 'What happened?', type: 'select', value: 'sold', options: [{ value: 'sold', label: 'Sold' }, { value: 'disposed', label: 'Disposed / scrapped' }] }];
      if (!unit) fields.push({ name: 'qty', label: 'Quantity', type: 'number', inputmode: 'decimal', min: 0, step: 'any', value: fmtQty(it.surplus_qty > 0 ? it.surplus_qty : 1) });
      fields.push({ name: 'note', label: 'Note (buyer, price, reason)' });
      const v = await openPrompt({
        title: unit ? `Serial ${unit.serial_number}` : 'Sell / dispose',
        message: unit ? '' : `Comes out of the surplus first (${fmtQty(it.surplus_qty || 0)} marked surplus).`,
        fields, confirmText: 'Save',
        validate: (vals) => (!unit && !(Number(vals.qty) > 0) ? 'Enter a quantity.' : (!unit && Number(vals.qty) > it.qty_on_hand ? `Only ${fmtQty(it.qty_on_hand)} on hand.` : null)),
      });
      if (!v) return;
      return txn(v.type, unit ? { unit_id: unit.id, note: v.note || null } : { qty: Number(v.qty), note: v.note || null }, `${v.type === 'sold' ? 'Sold' : 'Disposed'}${unit ? ' serial ' + unit.serial_number : ' ' + fmtQty(v.qty)}`);
    }

    async function saveSurplus(it) {
      if (!online()) return openAlert({ title: 'Needs a connection', message: 'Surplus changes save when you\'re online.' });
      const sqv = Number($('[data-sq]', viewEl).value || 0);
      const spRaw = $('[data-sp]', viewEl).value;
      if (!(sqv >= 0) || sqv > Math.max(it.qty_on_hand, 0)) return showStatus(`Surplus must be between 0 and ${fmtQty(Math.max(it.qty_on_hand, 0))}.`, 'error');
      try {
        await api('/api/inventory/items/' + id, { method: 'PATCH', body: { surplus_qty: sqv, surplus_price_cents: spRaw === '' ? null : Math.round(Number(spRaw) * 100), surplus_notes: $('[data-sn]', viewEl).value } });
        showStatus('Surplus saved.', 'success');
        await refreshCatalog();
        load();
      } catch (e) { openAlert({ title: 'Surplus NOT saved', message: e.message, danger: true }); }
    }

    async function editItem(it) {
      const units = (detail && detail.units) || [];
      const s = openSheet(`
        <h3>Edit item</h3>
        <form data-edit autocomplete="off">
          <label class="inv-field">Description *<input name="description" required maxlength="200" value="${esc(it.description)}" /></label>
          <div class="inv-2col">
            <label class="inv-field">Part / model #<input name="part_number" maxlength="120" value="${esc(it.part_number || '')}" /></label>
            <label class="inv-field">Manufacturer<input name="manufacturer" maxlength="120" value="${esc(it.manufacturer || '')}" /></label>
            <label class="inv-field">Category<select name="category">${categories.map((c) => `<option value="${esc(c[0])}"${it.category === c[0] ? ' selected' : ''}>${esc(c[1])}</option>`).join('')}</select></label>
            <label class="inv-field">Condition<select name="condition">${Object.keys(COND).map((k) => `<option value="${k}"${it.condition === k ? ' selected' : ''}>${COND[k]}</option>`).join('')}</select></label>
            <label class="inv-field">Location<input name="location" maxlength="120" value="${esc(it.location || '')}" /></label>
            <label class="inv-field">Unit<input name="unit_of_measure" maxlength="20" value="${esc(it.unit_of_measure || 'each')}" /></label>
            <label class="inv-field">Unit cost ($)<input name="unit_cost" type="number" inputmode="decimal" min="0" step="0.01" value="${it.unit_cost_cents == null ? '' : (it.unit_cost_cents / 100).toFixed(2)}" /></label>
          </div>
          ${it.qty_on_hand === 0 && !units.length ? `<label class="inv-field" style="flex-direction:row;align-items:center;gap:8px;"><input type="checkbox" name="serialized"${it.serialized ? ' checked' : ''} /> Track by serial number</label>` : ''}
          <label class="inv-field">Notes<textarea name="notes" rows="3" maxlength="2000">${esc(it.notes || '')}</textarea></label>
          <div class="inv-err" data-err hidden></div>
          <div class="inv-sheet-actions" style="justify-content:space-between;">
            <button type="button" class="btn btn-danger-soft" data-archive>Archive item</button>
            <span class="inv-row-gap"><button type="button" class="btn btn-secondary" data-close>Cancel</button><button type="submit" class="btn btn-primary">Save</button></span>
          </div>
        </form>`);
      const form = s.el.querySelector('[data-edit]');
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const body = {
          description: form.description.value, part_number: form.part_number.value, manufacturer: form.manufacturer.value,
          category: form.category.value, condition: form.condition.value, location: form.location.value,
          unit_of_measure: form.unit_of_measure.value, notes: form.notes.value,
          unit_cost_cents: form.unit_cost.value === '' ? null : Math.round(Number(form.unit_cost.value) * 100),
        };
        if (form.serialized) body.serialized = form.serialized.checked;
        try {
          await api('/api/inventory/items/' + id, { method: 'PATCH', body });
          s.close();
          showStatus('Saved.', 'success');
          await refreshCatalog();
          load();
        } catch (err) { const el = s.el.querySelector('[data-err]'); el.hidden = false; el.textContent = err.message; }
      });
      s.el.querySelector('[data-archive]').addEventListener('click', async () => {
        const ok = await openConfirm({ title: 'Archive this item?', message: 'It disappears from inventory lists. Its history is kept.', confirmText: 'Archive', danger: true });
        if (!ok) return;
        try {
          await api('/api/inventory/items/' + id, { method: 'PATCH', body: { archived: true } });
          s.close();
          await refreshCatalog();
          location.hash = '#/';
        } catch (err) { openAlert({ title: 'Not archived', message: err.message, danger: true }); }
      });
    }

    async function addCode() {
      const code = await scanOnce('Scan the extra barcode');
      if (!code) return;
      try {
        await api(`/api/inventory/items/${id}/barcodes`, { method: 'POST', body: { code } });
        showStatus('Barcode added.', 'success');
        await refreshCatalog();
        load();
      } catch (e) {
        if (e.data && e.data.existing_item_id) {
          const other = store.item(e.data.existing_item_id);
          return openAlert({ title: 'Barcode already used', message: `${code} belongs to ${other ? '"' + other.description + '"' : 'another item'}.`, next: 'Open that item from search if it is the same product.' });
        }
        openAlert({ title: 'Barcode NOT added', message: e.message, danger: true });
      }
    }
    async function removeCode(barcodeId) {
      const ok = await openConfirm({ title: 'Remove this barcode?', message: 'Scanning it will no longer find this item.', confirmText: 'Remove', danger: true });
      if (!ok) return;
      try { await api(`/api/inventory/items/${id}/barcodes/${barcodeId}`, { method: 'DELETE' }); await refreshCatalog(); load(); } catch (e) { showStatus(e.message, 'error'); }
    }
    async function photoAction(photoId, kind) {
      if (kind === 'delete') {
        const ok = await openConfirm({ title: 'Delete this photo?', confirmText: 'Delete', danger: true });
        if (!ok) return;
      }
      try {
        await api(`/api/inventory/items/${id}/photos/${photoId}${kind === 'primary' ? '/primary' : ''}`, { method: kind === 'primary' ? 'POST' : 'DELETE', body: kind === 'primary' ? {} : undefined });
        await refreshCatalog();
        load();
      } catch (e) { showStatus(e.message, 'error'); }
    }

    draw();
    rerender = (fromPhoto) => { if (fromPhoto) load(); else draw(); };
    load();
  }

  // ============================================================================
  // Count session
  // ============================================================================
  const countState = { session: null, awaitSerialFor: null, scanner: null };
  // "Tap to scan" (default) or "Continuous", remembered on this device.
  const COUNT_MODE_KEY = 'bates.inv.countScanMode';
  const getCountMode = () => { try { return localStorage.getItem(COUNT_MODE_KEY) === 'continuous' ? 'continuous' : 'tap'; } catch (e) { return 'tap'; } };
  const setCountMode = (m) => { try { localStorage.setItem(COUNT_MODE_KEY, m); } catch (e) { /* per-visit only */ } };

  async function currentSession() {
    const open = await store.openSessions();
    open.sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)));
    countState.session = open[0] || null;
    return countState.session;
  }

  function sessionTotals(s) {
    const ids = Object.keys(s.lines || {});
    const serial = s.serialCounts || {};
    return {
      items: new Set(ids.concat(Object.keys(serial))).size,
      pieces: ids.reduce((sum, id) => sum + (s.lines[id].qty || 0), 0) + Object.values(serial).reduce((a, b) => a + b, 0),
      created: s.created || 0,
    };
  }

  async function renderCount() {
    if (!perms.manage) {
      viewEl.innerHTML = '<section class="card"><p>Bulk count is for warehouse staff. Ask an administrator if you need this.</p><a class="btn btn-secondary btn-sm" href="#/">Back</a></section>';
      return;
    }
    const alive = routeToken();
    const s = await currentSession();
    if (!alive()) return;
    if (!s) {
      viewEl.innerHTML = `
        <a href="#/" class="btn btn-secondary inv-back">&larr; Back to inventory</a>
        <section class="card">
          <h3 class="gc-card-h">Bulk count</h3>
          <p class="inv-muted" style="margin-top:0;">For the big scan-in: scan, scan, scan. Each scan of a known item adds 1 (you can adjust). An unknown barcode opens a quick-add form, then you keep scanning. Everything is saved on this phone as you go, even with no signal, and posts to inventory when you tap Finish.</p>
          <button type="button" class="inv-bigbtn primary full" data-start style="width:100%;">${ICON.count} Start bulk count</button>
        </section>`;
      $('[data-start]', viewEl).addEventListener('click', async () => { await store.startSession(); renderCount(); });
      return;
    }
    drawCount();
    rerender = drawCount;
  }

  function drawCount() {
    const s = countState.session;
    if (!s || currentRoute !== 'count') return;
    const t = sessionTotals(s);
    const order = (s.order || []).filter((id) => s.lines[id] || (s.serialCounts || {})[id]);
    viewEl.innerHTML = `
      <a href="#/" class="btn btn-secondary inv-back">&larr; Back to inventory</a>
      <div class="inv-small">Bulk count started ${esc(fmtDateTime(s.started_at))}</div>
      <div class="inv-count-stats">
        <div class="inv-stat"><b>${t.items}</b><span>items</span></div>
        <div class="inv-stat"><b>${fmtQty(t.pieces)}</b><span>pieces</span></div>
        <div class="inv-stat"><b>${t.created}</b><span>new items</span></div>
      </div>
      <div class="inv-seg" role="radiogroup" aria-label="How the camera reads">
        <button type="button" role="radio" data-cmode="tap" aria-checked="${getCountMode() === 'tap'}">Tap to scan</button>
        <button type="button" role="radio" data-cmode="continuous" aria-checked="${getCountMode() === 'continuous'}">Continuous</button>
      </div>
      <button type="button" class="inv-bigbtn primary full" data-cscan>${ICON.scan} Scan</button>
      <div class="inv-small" style="margin-top:-6px;">${getCountMode() === 'tap' ? 'Aim at one barcode, tap Scan for each one.' : 'Reads every barcode you hold in the box - for counting one item fast.'}</div>
      <form class="inv-search" data-cadd autocomplete="off"><input type="search" placeholder="No barcode? Search to add +1" aria-label="Search to add" /></form>
      <div class="inv-list" data-cresults hidden></div>
      <div class="inv-list">${order.length ? order.map((id) => countRow(s, id)).join('') : '<div class="inv-empty">Nothing counted yet. Tap Scan.</div>'}</div>
      <div class="inv-sheet-actions" style="justify-content:space-between;">
        <button type="button" class="btn btn-danger-soft" data-cdiscard>Discard session</button>
        <button type="button" class="btn btn-primary" data-cfinish${t.items ? '' : ' disabled'}>Save all</button>
      </div>`;
    $('[data-cscan]', viewEl).addEventListener('click', openCountScanner);
    viewEl.querySelectorAll('[data-cmode]').forEach((b) => b.addEventListener('click', () => { setCountMode(b.dataset.cmode); drawCount(); }));
    $('[data-cfinish]', viewEl).addEventListener('click', finishCount);
    $('[data-cdiscard]', viewEl).addEventListener('click', discardCount);
    const addInput = $('[data-cadd] input', viewEl);
    const results = $('[data-cresults]', viewEl);
    addInput.addEventListener('input', () => {
      const q = addInput.value.trim();
      if (q.length < 2) { results.hidden = true; return; }
      const hits = store.search(q).filter((i) => !i.serialized).slice(0, 8);
      results.hidden = false;
      results.innerHTML = hits.length ? hits.map((i) => `<button type="button" class="inv-count-row" style="width:100%;text-align:left;border:0;background:none;color:inherit;font:inherit;cursor:pointer;" data-add="${esc(i.id)}"><span>${esc(i.description)}<br><span class="inv-small">${esc(i.part_number || '')}</span></span><span class="inv-badge ok">+1</span></button>`).join('') : '<div class="inv-empty">No match.</div>';
      results.querySelectorAll('[data-add]').forEach((b) => b.addEventListener('click', async () => {
        const m = await countItem(store.item(b.dataset.add));
        if (m) showStatus(stripTags(m.html), m.kind === 'warn' ? 'warning' : 'success');
        addInput.value = ''; results.hidden = true;
        drawCount();
      }));
    });
    $('[data-cadd]', viewEl).addEventListener('submit', (e) => e.preventDefault());
    viewEl.querySelectorAll('[data-cstep]').forEach((b) => b.addEventListener('click', async () => {
      const id = b.dataset.item;
      const cur = s.lines[id] ? s.lines[id].qty : 0;
      await store.countLine(s, id, { set: Math.max(0, cur + Number(b.dataset.cstep)), silent: true });
      drawCount();
    }));
    viewEl.querySelectorAll('[data-cset]').forEach((inp) => inp.addEventListener('change', async () => {
      await store.countLine(s, inp.dataset.cset, { set: Math.max(0, Number(inp.value) || 0), silent: true });
      drawCount();
    }));
  }

  function countRow(s, id) {
    const it = store.item(id) || { description: '(new item, syncing)' };
    const serialN = (s.serialCounts || {})[id];
    if (serialN) {
      return `<div class="inv-count-row"><span><strong>${esc(it.description)}</strong><br><span class="inv-small">serial-tracked</span></span><span class="inv-badge ok">${serialN} ${serialN === 1 ? 'unit' : 'units'}</span></div>`;
    }
    const l = s.lines[id];
    return `<div class="inv-count-row">
      <span><strong>${esc(it.description)}</strong>${l.mode === 'replace' ? ' <span class="inv-badge warn">Replaces earlier count</span>' : ''}<br><span class="inv-small">${esc(it.part_number || '')}${it.location ? ' &middot; ' + esc(it.location) : ''}</span></span>
      <span class="inv-stepper"><button type="button" data-cstep="-1" data-item="${esc(id)}" aria-label="One less">&minus;</button><input type="number" inputmode="decimal" min="0" step="any" value="${fmtQty(l.qty)}" data-cset="${esc(id)}" aria-label="Counted" /><button type="button" data-cstep="1" data-item="${esc(id)}" aria-label="One more">+</button></span>
    </div>`;
  }

  function openCountScanner() {
    const mode = getCountMode();
    const sc = BatesScanner.open({
      title: mode === 'continuous' ? 'Bulk count - continuous' : 'Bulk count',
      mode,
      stayOpen: true,
      footer: mode === 'continuous' ? 'Each barcode in the box adds 1. Move off it and back to count it again.' : 'Each Scan adds 1.',
      onScan: async (code, format, source) => {
        const m = await countScan(code, format, source, sc);
        if (m) sc.setStatus(m.html, m.kind);
        return 'keep';
      },
    });
    countState.scanner = sc;
    sc.onClose(() => { countState.scanner = null; countState.awaitSerialFor = null; if (currentRoute === 'count') drawCount(); });
  }

  // One scan in a count session -> { html, kind } for the scanner status line.
  async function countScan(code, format, source, sc) {
    const s = countState.session || await currentSession();
    if (!s) return { html: 'Start a bulk count first.', kind: 'warn' };

    // Waiting for a serial number for a serial-tracked item.
    if (countState.awaitSerialFor) {
      const item = countState.awaitSerialFor;
      countState.awaitSerialFor = null;
      return countUnit(s, item, code.trim());
    }

    let hit = store.lookup(code, format);
    if (!hit && online()) hit = await findCode(code, format);
    if (hit && hit.item && hit.item.id) {
      const item = store.item(hit.item.id) || hit.item;
      if (item.serialized) {
        if (hit.unit) return countUnit(s, item, hit.unit.serial_number, hit.unit);
        countState.awaitSerialFor = item;
        return { html: `${esc(item.description)}: now scan its <strong>serial number</strong> (or type it below)`, kind: 'warn' };
      }
      return countItem(item);
    }

    // Unknown barcode: quick-add, then back to scanning.
    if (sc) sc.pause();
    const created = await quickAdd({ code, format, sessionId: s.id });
    if (sc) sc.resume();
    if (!created) return { html: 'Skipped. Keep scanning.', kind: '' };
    s.created = (s.created || 0) + 1;
    if (created.serialized) {
      if (created.serial) { s.serialCounts = s.serialCounts || {}; s.serialCounts[created.id] = (s.serialCounts[created.id] || 0) + 1; if (s.order.indexOf(created.id) === -1) s.order.unshift(created.id); }
      await store.saveSession(s);
      return { html: 'New serial-tracked item added. Scan each unit\'s serial after its barcode.', kind: 'ok' };
    }
    await store.countLine(s, created.id, { set: created.qty });
    if (currentRoute === 'count' && !sc) drawCount();
    return { html: `New item added: ${fmtQty(created.qty)} counted`, kind: 'ok' };
  }

  // +1 on a known, non-serialized item; asks add/replace the first time when
  // another session already counted it.
  async function countItem(item) {
    const s = countState.session;
    if (!s || !item) return null;
    let mode;
    if (!s.lines[item.id] && item.last_count && item.last_count.session_id !== s.id) {
      if (countState.scanner) countState.scanner.pause();
      mode = await choose({
        title: 'Already counted',
        message: `${item.description} was counted ${fmtDate(item.last_count.at)}${item.last_count.by ? ' by ' + item.last_count.by : ''}: ${fmtQty(item.last_count.qty)} on hand after that count. Add this count to it, or replace it?`,
        options: [
          { label: `Add to it (more of these somewhere else)`, value: 'add', primary: true },
          { label: 'Replace it (this count is the real number)', value: 'replace' },
        ],
      });
      if (countState.scanner) countState.scanner.resume();
      if (!mode) return { html: 'Skipped.', kind: '' };
    }
    await store.countLine(s, item.id, mode ? { mode } : {});
    if (currentRoute === 'count' && !countState.scanner) drawCount();
    return { html: `<strong>+1</strong> ${esc(item.description)} &middot; ${fmtQty(s.lines[item.id].qty)} counted${s.lines[item.id].mode === 'replace' ? ' (replacing)' : ''}`, kind: 'ok' };
  }

  async function countUnit(s, item, serial, knownUnit) {
    if (!serial) return { html: 'No serial read. Scan the barcode again.', kind: 'warn' };
    const existing = knownUnit || store.unitsOf(item.id).find((u) => String(u.serial_number).toUpperCase() === serial.toUpperCase());
    if (existing && existing.status === 'in_stock') return { html: `Serial ${esc(serial)} is already in stock.`, kind: 'warn' };
    await store.enqueue('unit_create', { id: existing ? existing.id : uuid(), item_id: item.id, serial_number: serial, type: 'initial_count', client_op_id: uuid(), session_id: s.id, source: 'count_session', occurred_at: new Date().toISOString() });
    s.serialCounts = s.serialCounts || {};
    s.serialCounts[item.id] = (s.serialCounts[item.id] || 0) + 1;
    if (s.order.indexOf(item.id) === -1) s.order.unshift(item.id);
    await store.saveSession(s);
    return { html: `<strong>+1</strong> ${esc(item.description)} &middot; SN ${esc(serial)}`, kind: 'ok' };
  }

  async function finishCount() {
    const s = countState.session;
    if (!s) return;
    const t = sessionTotals(s);
    const ok = await openConfirm({
      title: 'Save this bulk count?',
      message: `${t.items} items, ${fmtQty(t.pieces)} pieces, ${t.created} new items. This adds them to inventory (or replaces the earlier count where you chose that).`,
      confirmText: 'Save all',
    });
    if (!ok) return;
    await store.finishSession(s);
    countState.session = null;
    await openSuccessFlash({
      title: online() ? 'Bulk count saved' : 'Bulk count saved on this phone',
      message: online() ? `${t.items} items, ${fmtQty(t.pieces)} pieces added to inventory.` : 'Saved on this phone. It posts to inventory as soon as you\'re back online.',
    });
    location.hash = '#/';
  }

  async function discardCount() {
    const s = countState.session;
    if (!s) return;
    const ok = await openConfirm({ title: 'Discard this bulk count?', message: 'Nothing from it is added to inventory. New items you created stay (with no quantity).', confirmText: 'Discard', danger: true });
    if (!ok) return;
    await store.discardSession(s);
    countState.session = null;
    renderCount();
  }

  // ============================================================================
  // Surplus
  // ============================================================================
  async function renderSurplus() {
    const head = `<a href="#/" class="btn btn-secondary inv-back">&larr; Back to inventory</a>
      <section class="card">
        <h3 class="gc-card-h">Surplus list</h3>
        <p class="inv-muted" style="margin-top:0;">Stock marked for sale (set "Surplus qty" on an item). Send the PDF or CSV to other dealers or a liquidator.</p>
        <div class="inv-row-gap"><button type="button" class="btn btn-secondary btn-sm" data-csv>${ICON.download} CSV</button><button type="button" class="btn btn-secondary btn-sm" data-pdf>${ICON.download} PDF with photos</button></div>
        <div class="inv-small" data-totals style="margin-top:8px;"></div>
      </section>`;
    viewEl.innerHTML = head + '<div data-grid class="inv-surplus-grid"><div class="inv-skel"><span style="width:70%"></span></div></div>';
    const today = new Date().toISOString().slice(0, 10);
    $('[data-csv]', viewEl).addEventListener('click', () => download('/api/inventory/surplus.csv', `bates-surplus-${today}.csv`));
    $('[data-pdf]', viewEl).addEventListener('click', () => download('/api/inventory/surplus.pdf', `bates-surplus-${today}.pdf`));
    const alive = routeToken();
    let items; let totals;
    try {
      const r = await api('/api/inventory/surplus');
      items = r.items; totals = r.totals;
    } catch (e) {
      items = store.view().items.filter((i) => i.surplus_qty > 0).map((i) => ({ ...i, photo_url: i.thumb_url }));
      totals = null;
    }
    if (!alive()) return;
    $('[data-totals]', viewEl).textContent = totals
      ? `${totals.items} items, ${fmtQty(totals.pieces)} pieces${totals.asking_cents ? ', ' + money(totals.asking_cents) + ' at asking price' : ''}`
      : (online() ? '' : 'Offline: showing this phone\'s copy.');
    $('[data-grid]', viewEl).innerHTML = items.length ? items.map((i) => `
      <a class="inv-surplus-card" href="#/item/${esc(i.id)}">
        <span class="inv-thumb">${i.photo_url ? `<img src="${esc(i.photo_url)}" alt="" loading="lazy" />` : ICON.box}</span>
        <span><span class="inv-item-title">${esc(i.description)}</span>
          <span class="inv-item-sub" style="display:block;">${[i.part_number && '#' + i.part_number, i.manufacturer, COND[i.condition]].filter(Boolean).map(esc).join(' &middot; ')}</span>
          <span style="display:block;margin-top:6px;font-weight:700;">${fmtQty(i.surplus_qty)} ${esc(i.unit_of_measure || 'each')} for sale <span class="inv-small">of ${fmtQty(i.qty_on_hand)}</span></span>
          <span class="inv-small">${i.surplus_price_cents != null ? money(i.surplus_price_cents) + ' each' : 'Make an offer'}</span></span>
      </a>`).join('') : '<div class="inv-empty">Nothing is marked surplus yet.</div>';
  }

  // ============================================================================
  // Reports
  // ============================================================================
  async function renderReports() {
    viewEl.innerHTML = '<a href="#/" class="btn btn-secondary inv-back">&larr; Back to inventory</a><div class="inv-skel"><span style="width:60%"></span><span style="width:80%"></span></div>';
    const alive = routeToken();
    let r;
    try { r = await api('/api/inventory/reports'); } catch (e) {
      if (!alive()) return;
      viewEl.innerHTML = '<a href="#/" class="btn btn-secondary inv-back">&larr; Back to inventory</a><section class="card"><p>Reports need a connection.</p></section>';
      return;
    }
    if (!alive()) return;
    const list = (rows, empty, fn) => (rows.length ? `<ul class="inv-hist">${rows.map(fn).join('')}</ul>` : `<p class="inv-muted">${empty}</p>`);
    viewEl.innerHTML = `
      <a href="#/" class="btn btn-secondary inv-back">&larr; Back to inventory</a>
      <div class="inv-tiles">
        <div class="inv-tile"><b>${r.totals.items}</b><span>items</span></div>
        <div class="inv-tile"><b>${fmtQty(r.totals.pieces)}</b><span>pieces on hand</span></div>
        <div class="inv-tile"><b>${money(r.totals.value_cents) || '$0.00'}</b><span>value on hand${r.totals.items_with_cost < r.totals.items ? ` (${r.totals.items_with_cost} of ${r.totals.items} have a cost)` : ''}</span></div>
        <div class="inv-tile"><b>${fmtQty(r.totals.surplus_pieces)}</b><span>surplus pieces</span></div>
      </div>
      ${r.needs_recount.length ? `<section class="card"><h3 class="inv-section-h">Needs recount <span class="inv-small">below zero after offline scan-outs</span></h3>${list(r.needs_recount, '', (i) => `<li><a href="#/item/${esc(i.id)}">${esc(i.description)}</a><span class="chg minus">${fmtQty(i.qty_on_hand)}</span></li>`)}</section>` : ''}
      <section class="card"><h3 class="inv-section-h">Recently scanned out</h3>
        ${list(r.recent_out, 'Nothing scanned out yet.', (o) => `<li><span><a href="#/item/${esc(o.item_id)}">${esc(o.description)}</a><br><span class="inv-small">${esc(fmtDateTime(o.at))}${o.by ? ' &middot; ' + esc(o.by) : ''}${o.for ? ' &middot; ' + esc(o.for) : ''}</span></span><span class="chg minus">&minus;${fmtQty(o.qty)}</span></li>`)}
      </section>
      <section class="card"><h3 class="inv-section-h">Not touched in 12+ months <span class="inv-small">surplus candidates</span></h3>
        ${list(r.stale, 'Nothing yet - everything has moved or been counted in the last year.', (i) => `<li><span><a href="#/item/${esc(i.id)}">${esc(i.description)}</a><br><span class="inv-small">last activity ${esc(fmtDate(i.last_activity_at))}${i.location ? ' &middot; ' + esc(i.location) : ''}</span></span><span class="chg">${fmtQty(i.qty_on_hand)}</span></li>`)}
      </section>`;
  }

  boot();
})();
