// frontend/texts.js
// The Texts TRAY: the Generator Care texting inbox (sql/037) as a docked side
// panel that stays open while staff work the dashboard. shared-nav.js
// injects this script (+ texts-tray.css) on every office page for members
// with the `texting` permission; techs, customers and login pages never load
// it. texts.html loads it too, as a pop-out window (html[data-texts-popout]).
//
//   - Launcher button bottom-right with the unread count (+ a dot when
//     something Needs reply). Click = open the tray; Esc / the chevron
//     minimizes it back to the launcher.
//   - Docked, not blocking: on wide screens the page gets padding-right so
//     content shrinks beside the tray (html.bts-open in texts-tray.css); the
//     customer modal is confined left of the tray so both are usable. No
//     backdrop, no focus trap. Under 900px it is a full-screen sheet.
//   - Resizable by dragging its left edge (340-640px); width remembered.
//   - Stays with you: open/closed, width, selected conversation, filter,
//     search and unsent drafts live in sessionStorage (per browser tab) and
//     are restored on every office page load.
//   - Same backend routes as before (routes/generator-care/texts.js); the one
//     addition is POST /texts/conversations/ensure so "Text" on a customer
//     who has never texted can open their conversation.
//   - Polling: 15s while open, 60s while minimized (list poll doubles as the
//     badge + "new text" toast source); nothing while the browser tab is
//     hidden.
//   - Talks to generator-care.js only through window.BatesGC (showDetail,
//     smsSegments, smsHistoryChip, refreshSmsHistory), all optional.

(() => {
  if (window.BatesTexts && window.BatesTexts.__tray) return; // loaded twice (static + injected)
  const POPOUT = document.documentElement.hasAttribute('data-texts-popout');

  // ---- Who is this for? Office + texting permission only. ----
  let profile = null;
  try { profile = JSON.parse(localStorage.getItem('bates.profile') || 'null'); } catch (e) { profile = null; }
  const isOffice = !!(profile && profile.role === 'office');
  const mayText = !!(profile && (profile.is_admin === true || !(profile.permissions && profile.permissions.texting === false)));
  if (!isOffice) {
    if (POPOUT) window.location.replace('/home');
    return;
  }

  const API_BASE = (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
    ? 'http://localhost:4000'
    : 'https://bates-electric-app.onrender.com';
  const TOKEN_KEY = 'bates.auth.token';
  const token = localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY);
  if (!token) { if (POPOUT) window.location.replace('/'); return; }

  const STORAGE_KEY = 'bates.texts.tray';
  const OPEN_POLL_MS = 15 * 1000;
  const CLOSED_POLL_MS = 60 * 1000;
  const MIN_W = 340;
  const MAX_W = 640;
  const DEFAULT_W = 400;
  const desktopMq = window.matchMedia('(min-width: 900px)');
  const CENTRAL = 'America/Chicago';

  // ---- Persisted state (per browser tab) ----
  const state = { open: false, width: DEFAULT_W, conversationId: null, filter: 'all', search: '', drafts: {} };
  try {
    const saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY) || 'null');
    if (saved && typeof saved === 'object') {
      state.open = !!saved.open;
      state.width = clampWidth(Number(saved.width) || DEFAULT_W);
      state.conversationId = typeof saved.conversationId === 'string' ? saved.conversationId : null;
      state.filter = ['all', 'needs', 'office', 'auto'].includes(saved.filter) ? saved.filter : 'all';
      state.search = typeof saved.search === 'string' ? saved.search : '';
      state.drafts = (saved.drafts && typeof saved.drafts === 'object') ? saved.drafts : {};
    }
  } catch (e) { /* private mode / blocked storage: defaults */ }
  if (POPOUT) state.open = true;
  function saveState() {
    try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
  }
  function clampWidth(w) { return Math.min(MAX_W, Math.max(MIN_W, Math.round(w))); }

  // ---- Data ----
  let conversations = [];
  let me = profile.id || null;
  let idleMinutes = 120;
  let haveData = false;
  let inflight = null;
  let thread = null;
  let threadInflight = null;
  let sending = false;
  let pollTimer = null;
  let firstPollDone = false;
  const seenInbound = {}; // conversation id -> last_inbound_at seen by this tab

  // ---- Helpers (fall back when ui-dialogs.js is not on the page) ----
  const escapeHtml = (s) => (window.BatesUI && window.BatesUI.escapeHtml)
    ? window.BatesUI.escapeHtml(s)
    : String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const confirmDialog = (opts) => (typeof window.openConfirm === 'function' ? window.openConfirm(opts) : Promise.resolve(true));
  const alertDialog = (opts) => (typeof window.openAlert === 'function' ? window.openAlert(opts) : Promise.resolve(toast({ title: opts.title, body: opts.message, kind: 'error' })));
  const gc = () => window.BatesGC || {};
  const $ = (sel, root) => (root || document).querySelector(sel);

  async function errorMessageOf(r) {
    try { const b = await r.json(); if (b && b.error) return b.error; } catch (_) { /* non-JSON */ }
    return 'HTTP ' + r.status;
  }
  async function api(path, options = {}) {
    const r = await window.BatesAuth.authFetch(`${API_BASE}/api/generator-care${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {}),
      },
    });
    if (!r.ok) throw new Error(await errorMessageOf(r));
    return r.json();
  }

  function centralDay(iso) { return new Date(iso).toLocaleDateString('en-CA', { timeZone: CENTRAL }); }
  function fmtCentral(iso, { full } = {}) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const time = d.toLocaleTimeString('en-US', { timeZone: CENTRAL, hour: 'numeric', minute: '2-digit' });
    if (!full && centralDay(iso) === centralDay(Date.now())) return time;
    const ageDays = (Date.now() - d.getTime()) / 86400000;
    if (!full && ageDays < 6) return d.toLocaleDateString('en-US', { timeZone: CENTRAL, weekday: 'short' }) + ' ' + time;
    return d.toLocaleDateString('en-US', { timeZone: CENTRAL, month: 'short', day: 'numeric' }) + ', ' + time;
  }
  function fmtCentralDate(iso) {
    return iso ? new Date(iso).toLocaleDateString('en-US', { timeZone: CENTRAL, weekday: 'short', month: 'short', day: 'numeric' }) : '';
  }
  function fmtPhone(s) {
    const digits = String(s || '').replace(/\D/g, '');
    const ten = digits.length === 11 && digits[0] === '1' ? digits.slice(1) : (digits.length === 10 ? digits : null);
    return ten ? '(' + ten.slice(0, 3) + ') ' + ten.slice(3, 6) + '-' + ten.slice(6) : String(s || '');
  }
  const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || '';
  function ownerLabel(c) {
    if (!c || !c.owner) return '';
    if (c.owned_by_me) return 'you';
    return firstName(c.owner.name) || c.owner.email || 'office';
  }
  const minutesLeft = (iso) => (iso ? Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 60000)) : null);
  function smsSegments(text) {
    if (gc().smsSegments) return gc().smsSegments(text);
    const len = String(text || '').length;
    return { chars: len, segments: len === 0 ? 0 : (len <= 160 ? 1 : Math.ceil(len / 153)), encoding: 'GSM-7' };
  }

  const svg = (d, size) => `<svg width="${size || 16}" height="${size || 16}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const ICON = {
    chat: svg('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>', 24),
    back: svg('<path d="M15 18l-6-6 6-6"/>'),
    minimize: svg('<path d="M9 18l6-6-6-6"/>'),
    close: svg('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
    popout: svg('<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14 21 3"/>'),
    person: svg('<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>', 13),
    bolt: svg('<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>', 13),
    open: svg('<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14 21 3"/>', 13),
    empty: svg('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>', 20),
  };

  // ---- DOM ----
  let launcher;
  let tray;
  let toasts;
  function mount() {
    const body = document.body;
    launcher = document.createElement('button');
    launcher.type = 'button';
    launcher.className = 'bts-launcher';
    launcher.setAttribute('aria-label', 'Open texts');
    launcher.title = 'Texts';
    launcher.innerHTML = `${ICON.chat}<span class="bts-launcher-count" id="bts-count" hidden>0</span><span class="bts-launcher-dot" id="bts-dot" hidden title="Needs reply"></span>`;
    launcher.addEventListener('click', () => open());
    if (POPOUT) launcher.hidden = true;

    tray = document.createElement('aside');
    tray.className = 'bts-tray';
    tray.id = 'bates-texts-tray';
    tray.setAttribute('aria-label', 'Texts');
    tray.innerHTML = `
      <div class="bts-resize" id="bts-resize" title="Drag to resize"></div>
      <div class="bts-head">
        <button type="button" class="bts-iconbtn" id="bts-back" hidden aria-label="Back to conversations">${ICON.back}</button>
        <div class="bts-head-title"><span id="bts-title">Texts</span><span class="tab-count" id="bts-head-count" hidden>0</span></div>
        ${POPOUT ? '' : `<button type="button" class="bts-iconbtn" id="bts-popout" aria-label="Open in its own window" title="Pop out">${ICON.popout}</button>`}
        ${POPOUT ? '' : `<button type="button" class="bts-iconbtn" id="bts-minimize" aria-label="Minimize" title="Minimize (Esc)">${ICON.minimize}</button>`}
        ${POPOUT ? '' : `<button type="button" class="bts-iconbtn" id="bts-close" aria-label="Close" title="Close" hidden>${ICON.close}</button>`}
      </div>
      <div class="bts-body">
        <div class="bts-pane" id="bts-list-pane">
          <div class="bts-list-head">
            <div class="gc-tabs" role="tablist" aria-label="Conversation filter">
              <button type="button" class="filter bts-tab" data-filter="all" role="tab">All <span class="count" id="bts-c-all">0</span></button>
              <button type="button" class="filter bts-tab" data-filter="needs" id="bts-tab-needs" role="tab">Needs reply <span class="count" id="bts-c-needs">0</span></button>
              <button type="button" class="filter bts-tab" data-filter="office" role="tab">Office <span class="count" id="bts-c-office">0</span></button>
              <button type="button" class="filter bts-tab" data-filter="auto" role="tab">Auto <span class="count" id="bts-c-auto">0</span></button>
            </div>
            <input type="search" id="bts-search" placeholder="Search by name or phone" aria-label="Search conversations" autocomplete="off" />
          </div>
          <div class="bts-list" id="bts-list" role="list"></div>
        </div>
        <div class="bts-pane" id="bts-thread-pane" hidden></div>
      </div>`;

    toasts = document.createElement('div');
    toasts.className = 'bts-toasts';
    toasts.setAttribute('aria-live', 'polite');

    body.appendChild(launcher);
    body.appendChild(tray);
    body.appendChild(toasts);
    if (POPOUT) document.documentElement.classList.add('bts-popout');

    tray.querySelectorAll('.bts-tab').forEach((btn) => {
      btn.addEventListener('click', () => { state.filter = btn.dataset.filter; saveState(); renderList(); });
    });
    const search = $('#bts-search', tray);
    search.value = state.search;
    search.addEventListener('input', (e) => { state.search = e.target.value; saveState(); renderList(); });
    $('#bts-back', tray).addEventListener('click', backToList);
    const mini = $('#bts-minimize', tray); if (mini) mini.addEventListener('click', close);
    const closeBtn = $('#bts-close', tray); if (closeBtn) closeBtn.addEventListener('click', close);
    const pop = $('#bts-popout', tray); if (pop) pop.addEventListener('click', popOut);
    tray.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !POPOUT) { e.stopPropagation(); close(); }
    });
    wireResize();
    desktopMq.addEventListener('change', applyLayout);
    applyWidth();
    applyLayout();
    renderList();
    renderThread();
  }

  function applyWidth() {
    document.documentElement.style.setProperty('--bts-w', state.width + 'px');
  }
  function applyLayout() {
    const open = state.open;
    document.documentElement.classList.toggle('bts-open', open);
    tray.classList.toggle('open', open);
    const closeBtn = $('#bts-close', tray);
    const mini = $('#bts-minimize', tray);
    if (closeBtn) closeBtn.hidden = desktopMq.matches;
    if (mini) mini.hidden = !desktopMq.matches;
  }

  // ---- Resize (drag the left edge) ----
  function wireResize() {
    const handle = $('#bts-resize', tray);
    let startX = 0;
    let startW = 0;
    const onMove = (e) => {
      const w = clampWidth(startW + (startX - e.clientX));
      state.width = w;
      applyWidth();
    };
    const onUp = () => {
      document.documentElement.classList.remove('bts-resizing');
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      saveState();
    };
    handle.addEventListener('pointerdown', (e) => {
      if (!desktopMq.matches) return;
      e.preventDefault();
      startX = e.clientX;
      startW = state.width;
      document.documentElement.classList.add('bts-resizing');
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });
  }

  // ---- Open / close ----
  function open() {
    state.open = true;
    saveState();
    applyLayout();
    schedulePolling();
    loadList({ quiet: true });
    if (state.conversationId) loadThread({ markRead: true, silent: true });
    setTimeout(() => {
      const ta = $('#bts-compose-text', tray);
      if (ta && desktopMq.matches) ta.focus(); else if (!state.conversationId) $('#bts-search', tray).focus();
    }, 50);
  }
  function close() {
    if (POPOUT) return;
    const hadFocus = tray.contains(document.activeElement);
    state.open = false;
    saveState();
    applyLayout();
    schedulePolling();
    if (hadFocus) launcher.focus();
  }
  function toggle() { return state.open ? close() : open(); }

  function popOut() {
    const w = window.open('/texts', 'bates-texts-popout', 'popup=yes,width=440,height=760,resizable=yes,scrollbars=no');
    if (!w) { toast({ title: 'Pop-out blocked', body: 'Allow pop-ups for this site, or keep using the tray.', kind: 'error' }); return; }
    close();
  }

  // ---- Badge ----
  function stampBadge() {
    const unread = conversations.filter((c) => c.unread).length;
    const needs = conversations.some((c) => c.needs_reply_since);
    const count = $('#bts-count', launcher);
    const dot = $('#bts-dot', launcher);
    const head = $('#bts-head-count', tray);
    count.textContent = unread > 99 ? '99+' : String(unread);
    count.hidden = unread === 0;
    dot.hidden = !(needs && unread === 0); // the count already says "look"; the dot is for a quiet queue
    head.textContent = String(unread);
    head.hidden = unread === 0;
    launcher.setAttribute('aria-label', unread ? `Open texts, ${unread} unread` : 'Open texts');
  }

  // ---- Load ----
  function loadList({ quiet } = {}) {
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const data = await api('/texts/conversations');
        const next = data.conversations || [];
        me = data.me || me;
        idleMinutes = data.idle_minutes || idleMinutes;
        detectNewInbound(next);
        conversations = next;
        haveData = true;
        stampBadge();
        renderList();
        if (thread && thread.conversation) {
          const fresh = conversations.find((c) => c.id === thread.conversation.id);
          if (fresh && fresh.last_inbound_at !== thread.conversation.last_inbound_at && state.open) loadThread({ silent: true });
        }
      } catch (err) {
        console.error('[texts] list load failed:', err);
        if (!quiet && state.open) toast({ title: 'Texts did not load', body: err.message, kind: 'error' });
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  // "New text from Jay King" when an inbound lands that this tab has not seen
  // yet, unless that very thread is open in front of the user.
  function detectNewInbound(next) {
    const fresh = [];
    for (const c of next) {
      const prev = seenInbound[c.id];
      if (c.last_inbound_at) {
        if (firstPollDone && c.unread && (!prev || c.last_inbound_at > prev)) fresh.push(c);
        seenInbound[c.id] = c.last_inbound_at;
      }
    }
    firstPollDone = true;
    for (const c of fresh) {
      if (state.open && state.conversationId === c.id) continue;
      toast({
        title: 'New text from ' + ((c.customer && c.customer.name) || fmtPhone(c.phone)),
        body: c.preview && c.preview.direction === 'in' ? c.preview.body : '',
        onClick: () => openConversation(c.id),
      });
    }
  }

  async function loadThread({ markRead, silent } = {}) {
    const id = state.conversationId;
    if (!id) return;
    if (threadInflight) return threadInflight;
    threadInflight = (async () => {
      try {
        const data = await api(`/texts/conversations/${encodeURIComponent(id)}`);
        if (id !== state.conversationId) return;
        const prevInbound = thread && thread.conversation && thread.conversation.last_inbound_at;
        thread = data;
        me = data.me || me;
        idleMinutes = data.idle_minutes || idleMinutes;
        const newInbound = data.conversation && data.conversation.last_inbound_at;
        renderThread();
        if (state.open && mayText && (markRead || (prevInbound && newInbound && newInbound !== prevInbound))) {
          api(`/texts/conversations/${encodeURIComponent(id)}/read`, { method: 'POST', body: '{}' })
            .then(() => {
              const c = conversations.find((x) => x.id === id);
              if (c) { c.unread = false; stampBadge(); renderList(); }
              if (thread && thread.conversation) thread.conversation.unread = false;
            })
            .catch(() => {});
        }
      } catch (err) {
        console.error('[texts] thread load failed:', err);
        if (!silent) toast({ title: 'Could not load the conversation', body: err.message, kind: 'error' });
        if (/not found/i.test(err.message)) { state.conversationId = null; saveState(); thread = null; renderThread(); }
      } finally {
        threadInflight = null;
      }
    })();
    return threadInflight;
  }

  // ---- List rendering ----
  function modeChip(c) {
    const chips = [];
    if (c.mode === 'office') {
      chips.push(`<span class="chip bts-chip-office" title="A staff member owns this conversation; automated replies are off">${ICON.person} Office &mdash; ${escapeHtml(ownerLabel(c))}</span>`);
      if (c.needs_reply_since) chips.push('<span class="chip chip-warn">Needs reply</span>');
    } else if (c.needs_reply_since) {
      chips.push('<span class="chip chip-warn" title="The customer texted and nobody has answered">Needs reply</span>');
    } else {
      chips.push(`<span class="chip chip-neutral" title="The system answers automatically">${ICON.bolt} Auto</span>`);
    }
    return chips.join(' ');
  }
  function filtered() {
    const q = state.search.trim().toLowerCase();
    const qDigits = q.replace(/\D/g, '');
    return conversations.filter((c) => {
      if (state.filter === 'needs' && !c.needs_reply_since) return false;
      if (state.filter === 'office' && c.mode !== 'office') return false;
      if (state.filter === 'auto' && (c.mode !== 'auto' || c.needs_reply_since)) return false;
      if (!q) return true;
      if (((c.customer && c.customer.name) || '').toLowerCase().includes(q)) return true;
      return qDigits.length >= 3 && String(c.phone || '').replace(/\D/g, '').includes(qDigits);
    });
  }
  function previewText(c) {
    const p = c.preview;
    if (!p) return '<span class="bts-muted">No messages yet</span>';
    const who = p.direction === 'in' ? '' : (p.by_staff ? 'Office: ' : 'Auto: ');
    if (p.status === 'note') return `<span class="bts-muted">Note: </span>${escapeHtml(p.body)}`;
    const refused = p.direction === 'out' && p.status !== 'sent';
    return `${who ? `<span class="bts-muted">${who}</span>` : ''}${escapeHtml(p.body)}${refused ? ` <span class="bts-muted">(${p.status === 'held' ? 'held' : 'not sent'})</span>` : ''}`;
  }
  function renderList() {
    const list = $('#bts-list', tray);
    if (!list) return;
    tray.querySelectorAll('.bts-tab').forEach((b) => b.classList.toggle('active', b.dataset.filter === state.filter));
    const set = (id, n) => { const el = $('#' + id, tray); if (el) el.textContent = String(n); };
    set('bts-c-all', conversations.length);
    set('bts-c-needs', conversations.filter((c) => c.needs_reply_since).length);
    set('bts-c-office', conversations.filter((c) => c.mode === 'office').length);
    set('bts-c-auto', conversations.filter((c) => c.mode === 'auto' && !c.needs_reply_since).length);
    $('#bts-tab-needs', tray).classList.toggle('alert', conversations.some((c) => c.needs_reply_since));

    if (!haveData) {
      list.innerHTML = '<div class="bts-skel"><span style="width:60%"></span><span style="width:90%"></span><span style="width:50%"></span><span style="width:85%"></span></div>';
      return;
    }
    const rows = filtered();
    if (!rows.length) {
      const sub = conversations.length === 0
        ? 'Conversations appear here once a Generator Care customer has been texted or texts us.'
        : (state.search ? 'No conversation matches that search.' : 'Nothing in this filter.');
      list.innerHTML = `<div class="bts-empty"><div class="bts-empty-ico">${ICON.empty}</div><div class="big">No conversations</div><div>${escapeHtml(sub)}</div></div>`;
      return;
    }
    list.innerHTML = rows.map((c) => {
      const name = (c.customer && c.customer.name) || fmtPhone(c.phone);
      const active = c.id === state.conversationId;
      return `<button type="button" class="bts-row${active ? ' active' : ''}${c.unread ? ' unread' : ''}" data-id="${escapeHtml(c.id)}" aria-current="${active ? 'true' : 'false'}" role="listitem">
        <span class="bts-row-dot" aria-hidden="true"></span>
        <span class="bts-row-main">
          <span class="bts-row-top"><span class="bts-row-name">${escapeHtml(name)}</span><span class="bts-row-time">${escapeHtml(fmtCentral(c.last_activity_at))}</span></span>
          <span class="bts-row-preview">${previewText(c)}</span>
          <span class="bts-row-chips">${modeChip(c)}</span>
        </span>${c.unread ? '<span class="bts-sr">Unread</span>' : ''}
      </button>`;
    }).join('');
    list.querySelectorAll('.bts-row').forEach((btn) => btn.addEventListener('click', () => openConversation(btn.dataset.id)));
  }

  // ---- Thread ----
  function openConversation(id, { keepClosed } = {}) {
    const changed = id !== state.conversationId;
    state.conversationId = id;
    saveState();
    if (changed) { thread = null; renderThread(); renderList(); }
    if (!keepClosed && !state.open) open(); else loadThread({ markRead: true, silent: true });
  }
  async function openForCustomer(customerId) {
    const known = conversations.find((c) => c.customer_id === customerId);
    if (known) return openConversation(known.id);
    try {
      const data = await api('/texts/conversations/ensure', { method: 'POST', body: JSON.stringify({ customer_id: customerId }) });
      if (data.conversation) {
        const idx = conversations.findIndex((c) => c.id === data.conversation.id);
        if (idx < 0) conversations.unshift({ ...data.conversation, preview: null, subscription_id: data.conversation.subscription_id || null });
        openConversation(data.conversation.id);
        loadList({ quiet: true });
      }
    } catch (err) {
      alertDialog({ title: 'Cannot text this customer', message: err.message, danger: true });
    }
  }
  function backToList() {
    state.conversationId = null;
    saveState();
    thread = null;
    renderThread();
    renderList();
    const s = $('#bts-search', tray);
    if (s) s.focus();
  }

  function senderLabel(m) {
    if (m.direction === 'in') return '';
    if (m.sent_by) return m.sent_by.full_name || m.sent_by.email || 'Office';
    return 'Auto';
  }
  function statusChip(m) {
    if (gc().smsHistoryChip) return gc().smsHistoryChip(m);
    if (m.direction === 'in') return '<span class="badge badge-ok">Reply</span>';
    const map = { sent: ['badge-ok', 'Sent'], failed: ['badge-danger', 'Failed'], held: ['badge-info', 'Held'], note: ['badge-neutral', 'Note'], undeliverable: ['badge-warn', 'Not deliverable'], opted_out: ['badge-warn', 'Not sent &mdash; opted out'], no_consent: ['badge-warn', 'Not sent &mdash; no consent'], quiet_hours: ['badge-neutral', 'Skipped &mdash; quiet hours'], stale: ['badge-neutral', 'Dropped'], disabled: ['badge-neutral', 'Logged &mdash; texting off'] };
    const [cls, label] = map[m.status] || ['badge-neutral', escapeHtml(m.status || '')];
    return `<span class="badge ${cls}">${label}</span>`;
  }
  function renderBubble(m) {
    if (m.status === 'note') {
      // System note (e.g. running late): shown to the office, never sent.
      return `<div class="bts-sysnote"><span>${escapeHtml(m.body || '')}</span><span class="bts-muted">${escapeHtml(fmtCentral(m.created_at))}</span></div>`;
    }
    const inbound = m.direction === 'in';
    const held = !inbound && m.status === 'held';
    const refused = !inbound && m.status !== 'sent';
    const who = inbound ? '' : `<span class="bts-sender">${escapeHtml(senderLabel(m))}</span>`;
    const fail = (m.status === 'failed' || m.status === 'invalid_phone' || m.status === 'undeliverable') && m.detail ? `<div class="bts-note fail">${escapeHtml(m.detail)}</div>` : '';
    const heldNote = held ? '<div class="bts-note held">Held &mdash; will send if still relevant after hand-back</div>' : '';
    return `<div class="bts-msg ${inbound ? 'bts-in' : 'bts-out'}${refused ? ' bts-refused' : ''}${held ? ' bts-held' : ''}">
      <div class="bts-bubble">${escapeHtml(m.body || '')}</div>
      <div class="bts-meta">${who}<span>${escapeHtml(fmtCentral(m.created_at))}</span>${statusChip(m)}</div>${heldNote}${fail}
    </div>`;
  }
  function renderMessages(messages) {
    if (!messages.length) return '<div class="bts-empty">No messages in this conversation yet.</div>';
    let lastDay = null;
    const parts = [];
    for (const m of messages) {
      const day = centralDay(m.created_at);
      if (day !== lastDay) { parts.push(`<div class="bts-day"><span>${escapeHtml(fmtCentralDate(m.created_at))}</span></div>`); lastDay = day; }
      parts.push(renderBubble(m));
    }
    return parts.join('');
  }
  function renderEvents(events) {
    if (!events || !events.length) return '';
    const line = (e) => {
      const when = fmtCentral(e.created_at, { full: true });
      if (e.to_mode === 'office') {
        const by = e.actor || e.new_owner || 'someone';
        const how = e.reason === 'sent_message' ? 'took over by sending a text' : 'took over';
        const from = e.previous_owner && e.from_mode === 'office' ? ` (from ${e.previous_owner})` : '';
        return `${when} — ${by} ${how}${from}`;
      }
      if (e.reason === 'idle_timeout') return `${when} — returned to Auto (no office message for ${idleMinutes} minutes)`;
      return `${when} — ${e.actor || 'someone'} handed back to Auto`;
    };
    return `<details class="bts-events"><summary>Mode history (${events.length})</summary><ul>${events.map((e) => `<li>${escapeHtml(line(e))}</li>`).join('')}</ul></details>`;
  }
  function renderComposer(reply, c) {
    if (!mayText) return '<div class="bts-blocked"><span class="chip chip-neutral">Read only</span><span>Sending texts needs the texting permission. Ask an administrator.</span></div>';
    if (!reply) return '';
    const blocked = (chip, why) => `<div class="bts-blocked"><span class="chip chip-warn">${chip}</span><span>${why}</span></div>`;
    if (reply.reason === 'opted_out') return blocked('Opted out', 'This customer replied STOP. Nothing can be sent to this number.');
    if (reply.reason === 'undeliverable') return blocked('Not deliverable', 'SimpleTexting marked this number as not textable. Check the phone number on the customer record.');
    if (reply.reason === 'invalid_phone') return blocked('No mobile number', 'There is no usable mobile number for this conversation.');
    if (!reply.allowed) return blocked('No consent', `No text consent on file and no text from this customer in the last ${reply.window_days} days. Record consent on the customer record, or wait for them to text first.`);
    const notes = [];
    if (reply.reason === 'recent_inbound') notes.push(`<div class="bts-compose-note"><span class="chip chip-neutral">No consent on file</span><span>They texted first, so answering is allowed for ${reply.window_days} days from their last text.</span></div>`);
    if (reply.quiet_hours_now) {
      notes.push(reply.recent_inbound
        ? '<div class="bts-compose-note"><span class="chip chip-warn">Outside 8am&ndash;9pm Central</span><span>They texted recently, so a reply sends now anyway.</span></div>'
        : '<div class="bts-compose-note"><span class="chip chip-warn">Outside 8am&ndash;9pm Central</span><span>No recent text from them, so a message now is logged but not sent until 8am.</span></div>');
    }
    if (c.mode !== 'office') notes.push(`<div class="bts-compose-note"><span>Sending takes this conversation over: automated replies stop until you hand it back or it sits idle for ${idleMinutes} minutes.</span></div>`);
    const draft = state.drafts[c.id] || '';
    return `<div class="bts-compose">${notes.join('')}
      <textarea id="bts-compose-text" rows="3" maxlength="1000" placeholder="Text ${escapeHtml(firstName(c.customer && c.customer.name) || 'the customer')}…" aria-label="Text message">${escapeHtml(draft)}</textarea>
      <div class="bts-compose-actions"><span class="bts-compose-count" id="bts-compose-count"></span><button type="button" class="btn btn-primary btn-sm" id="bts-send" disabled>Send text</button></div>
    </div>`;
  }
  function renderHeader(c, nextVisit) {
    const name = (c.customer && c.customer.name) || fmtPhone(c.phone);
    const visit = nextVisit
      ? `Next visit ${escapeHtml(fmtCentralDate(nextVisit.appointment_at))}${nextVisit.arrival_window_label ? ', ' + escapeHtml(nextVisit.arrival_window_label) + ' arrival' : ''} &middot; Tech: ${escapeHtml(nextVisit.tech || 'unassigned')}${nextVisit.sms_confirmed_at ? ' &middot; <span class="chip chip-ok">Confirmed by text</span>' : ''}`
      : '<span class="bts-muted">No upcoming visit on the books</span>';
    const idle = c.mode === 'office' && c.idle_returns_at ? `<span class="bts-muted">Auto in ${minutesLeft(c.idle_returns_at)} min without an office text</span>` : '';
    const buttons = [];
    if (mayText) {
      if (c.mode === 'office') {
        if (!c.owned_by_me) buttons.push('<button type="button" class="btn btn-secondary btn-sm" id="bts-takeover">Take over</button>');
        buttons.push('<button type="button" class="btn btn-secondary btn-sm" id="bts-handback">Hand back to auto</button>');
      } else {
        buttons.push('<button type="button" class="btn btn-secondary btn-sm" id="bts-takeover">Take over</button>');
      }
      if (c.needs_reply_since) buttons.push('<button type="button" class="btn btn-ghost btn-sm" id="bts-handled" title="Clear Needs reply without sending a text">Mark handled</button>');
    }
    if (c.subscription_id) buttons.push(`<button type="button" class="btn btn-ghost btn-sm" id="bts-open-record">${ICON.open} Open record</button>`);
    return `<div class="bts-thread-head">
      <div class="bts-thread-top"><div class="bts-thread-title">
        <div class="bts-thread-name">${escapeHtml(name)} <span class="bts-muted">${escapeHtml(fmtPhone(c.phone))}</span></div>
        <div class="bts-thread-chips">${modeChip(c)} ${idle}</div>
      </div></div>
      <div class="bts-thread-actions">${buttons.join('')}</div>
      <div class="bts-thread-facts">${visit}</div>
    </div>`;
  }
  function renderThread() {
    const pane = $('#bts-thread-pane', tray);
    const listPane = $('#bts-list-pane', tray);
    const back = $('#bts-back', tray);
    const title = $('#bts-title', tray);
    const inThread = !!state.conversationId;
    pane.hidden = !inThread;
    listPane.hidden = inThread;
    back.hidden = !inThread;
    if (!inThread) { title.textContent = 'Texts'; pane.innerHTML = ''; return; }
    if (!thread) {
      title.textContent = 'Texts';
      pane.innerHTML = '<div class="bts-skel"><span style="width:50%"></span><span style="width:80%"></span></div>';
      return;
    }
    const c = thread.conversation;
    title.textContent = (c.customer && firstName(c.customer.name)) || 'Conversation';
    pane.innerHTML = renderHeader(c, thread.next_visit) +
      `<div class="bts-messages" id="bts-messages">${renderMessages(thread.messages || [])}</div>` +
      renderEvents(thread.events) + renderComposer(thread.reply, c);
    const msgs = $('#bts-messages', tray);
    if (msgs) msgs.scrollTop = msgs.scrollHeight;
    wireThread(c);
  }
  function wireThread(c) {
    const on = (id, fn) => { const el = $('#' + id, tray); if (el) el.addEventListener('click', fn); };
    on('bts-takeover', () => modeAction('take-over', 'You now own this conversation. Automated replies are off until you hand it back.'));
    on('bts-handback', async () => {
      const ok = await confirmDialog({ title: 'Hand back to auto?', message: 'The system resumes answering this customer. Any reminder held while you had it goes out now if it is still relevant, otherwise it is dropped. Nothing is sent just because you handed back.', confirmText: 'Hand back' });
      if (ok) modeAction('hand-back', 'Handed back. Automated replies are on for this customer again.');
    });
    on('bts-handled', () => modeAction('mark-handled', 'Marked handled.'));
    on('bts-open-record', () => openRecord(c));
    const ta = $('#bts-compose-text', tray);
    const btn = $('#bts-send', tray);
    if (ta && btn) {
      const update = () => {
        const seg = smsSegments(ta.value);
        const count = $('#bts-compose-count', tray);
        if (count) count.textContent = seg.chars ? `${seg.chars} chars · ${seg.segments} segment${seg.segments === 1 ? '' : 's'}${seg.encoding === 'UCS-2' ? ' (unicode)' : ''}` : '';
        btn.disabled = sending || !ta.value.trim();
      };
      ta.addEventListener('input', () => {
        if (ta.value.trim()) state.drafts[c.id] = ta.value; else delete state.drafts[c.id];
        saveState();
        update();
      });
      ta.addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !btn.disabled) { e.preventDefault(); sendText(ta, btn); } });
      btn.addEventListener('click', () => sendText(ta, btn));
      update();
    }
  }

  // "Open record": the customer modal on this page when we are on Generator
  // Care (tray stays open - the modal is confined left of it), otherwise go
  // there; the tray reopens from sessionStorage on the next page.
  function openRecord(c) {
    if (!c.subscription_id) return;
    if (POPOUT) {
      const target = '/generator-care#sub=' + encodeURIComponent(c.subscription_id);
      try {
        if (window.opener && !window.opener.closed) { window.opener.location.href = target; window.opener.focus(); return; }
      } catch (e) { /* opener is gone or cross-origin */ }
      window.open(target, 'bates-main');
      return;
    }
    if (gc().showDetail) gc().showDetail(c.subscription_id);
    else window.location.href = '/generator-care#sub=' + encodeURIComponent(c.subscription_id);
  }

  async function modeAction(action, successMsg) {
    const id = state.conversationId;
    if (!id) return;
    try {
      const data = await api(`/texts/conversations/${encodeURIComponent(id)}/${action}`, { method: 'POST', body: '{}' });
      if (data.conversation) applyConversation(data.conversation);
      toast({ title: successMsg, kind: 'ok', ttl: 4000 });
      await loadThread({ silent: true });
      loadList({ quiet: true });
    } catch (err) {
      console.error('[texts] ' + action + ' failed:', err);
      alertDialog({ title: 'Could not ' + action.replace(/-/g, ' '), message: err.message, danger: true });
    }
  }
  function applyConversation(conv) {
    const idx = conversations.findIndex((c) => c.id === conv.id);
    const merged = idx >= 0 ? { ...conversations[idx], ...conv } : conv;
    if (idx >= 0) conversations[idx] = merged; else conversations.unshift(merged);
    if (thread && thread.conversation && thread.conversation.id === conv.id) thread.conversation = { ...thread.conversation, ...conv };
    stampBadge();
    renderList();
  }
  async function sendText(ta, btn) {
    const id = state.conversationId;
    if (!id || sending) return;
    const body = ta.value.trim();
    if (!body) return;
    const reply = thread && thread.reply;
    if (reply && reply.quiet_hours_now && reply.recent_inbound) {
      const ok = await confirmDialog({ title: 'Send outside 8am–9pm?', message: 'It is outside quiet hours, but this customer texted recently, so the reply will go out right now.', confirmText: 'Send now' });
      if (!ok) return;
    }
    sending = true;
    btn.disabled = true;
    ta.disabled = true;
    const customerId = thread && thread.conversation && thread.conversation.customer_id;
    try {
      const data = await api(`/texts/conversations/${encodeURIComponent(id)}/send`, { method: 'POST', body: JSON.stringify({ body }) });
      ta.value = '';
      delete state.drafts[id];
      saveState();
      if (data.conversation) applyConversation(data.conversation);
      toast({ title: 'Text sent', kind: 'ok', ttl: 3000 });
      if (gc().refreshSmsHistory && customerId) gc().refreshSmsHistory(customerId);
      await loadThread({ silent: true });
      loadList({ quiet: true });
    } catch (err) {
      console.error('[texts] send failed:', err);
      await alertDialog({ title: 'Text not sent', message: err.message, danger: true });
      await loadThread({ silent: true });
      const again = $('#bts-compose-text', tray);
      if (again) { again.value = body; state.drafts[id] = body; saveState(); again.dispatchEvent(new Event('input')); }
    } finally {
      sending = false;
      const t = $('#bts-compose-text', tray);
      if (t) { t.disabled = false; t.focus(); }
    }
  }

  // ---- Toasts (own implementation: clickable, sits by the launcher) ----
  function toast({ title, body, kind, onClick, ttl }) {
    if (POPOUT && !onClick && kind !== 'error' && kind !== 'ok') return;
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'bts-toast';
    const icoBg = kind === 'error' ? 'var(--danger-bg)' : (kind === 'ok' ? 'var(--ok-bg)' : 'var(--info-bg)');
    const icoFg = kind === 'error' ? 'var(--danger)' : (kind === 'ok' ? 'var(--ok)' : 'var(--info)');
    el.innerHTML = `<span class="bts-toast-ico" style="background:${icoBg};color:${icoFg}">${ICON.chat}</span><span class="bts-toast-text"><b>${escapeHtml(title)}</b>${body ? `<span>${escapeHtml(body)}</span>` : ''}</span>`;
    const remove = () => { if (el.parentNode) el.parentNode.removeChild(el); };
    el.addEventListener('click', () => { remove(); if (onClick) onClick(); });
    while (toasts.children.length >= 3) toasts.removeChild(toasts.firstChild);
    toasts.appendChild(el);
    setTimeout(remove, ttl || 10000);
  }

  // ---- Polling ----
  function schedulePolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    const every = state.open ? OPEN_POLL_MS : CLOSED_POLL_MS;
    pollTimer = setInterval(tick, every);
  }
  function tick() {
    if (document.visibilityState !== 'visible') return;
    loadList({ quiet: true });
    if (state.open && state.conversationId) loadThread({ silent: true });
  }
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') tick(); });
  window.addEventListener('storage', (e) => {
    // Another tab signed out: drop the tray rather than keep polling a dead token.
    if (e.key === TOKEN_KEY && !e.newValue) { if (pollTimer) clearInterval(pollTimer); if (tray) tray.remove(); if (launcher) launcher.remove(); }
  });

  // ---- Boot ----
  function boot() {
    mount();
    // #texts (the digest link / old tab URL): generator-care.js consumes the
    // hash before this script runs and leaves a flag; other pages leave the
    // hash itself.
    if ((location.hash === '#texts' || window.__batesTextsOpenOnLoad) && !POPOUT) {
      window.__batesTextsOpenOnLoad = false;
      state.open = true; saveState(); applyLayout();
    }
    loadList({ quiet: true }).then(() => {
      if (state.conversationId) loadThread({ markRead: state.open, silent: true });
    });
    schedulePolling();
    if (state.open && state.conversationId) loadThread({ markRead: true, silent: true });
  }
  if (document.body) boot(); else document.addEventListener('DOMContentLoaded', boot);

  window.BatesTexts = {
    __tray: true,
    open,
    close,
    toggle,
    openConversation,
    openForCustomer,
    refresh: () => { loadList({ quiet: true }); if (state.conversationId) loadThread({ silent: true }); },
    // Legacy names from the tab era; harmless.
    init: () => open(),
    prime: () => loadList({ quiet: true }),
  };
})();
