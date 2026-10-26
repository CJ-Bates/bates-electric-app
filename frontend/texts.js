// frontend/texts.js
// Texts inbox for the Generator Care office dashboard (Phase 1, sql/037).
// Lazy-loaded like leads.js: generator-care.js calls BatesTexts.init() the
// first time the #texts tab is activated, BatesTexts.prime() at page load so
// the unread count shows on the section tab from anywhere in Generator Care,
// and BatesTexts.refresh() from the shared header Refresh button while this
// tab is active. The customer record opens through window.BatesGC.showDetail
// (generator-care.js); the segment counter and status chips come from the
// same module so the inbox and the customer-record thread never disagree.
//
// Polling: the unread badge every 60s always; the list + open thread every
// 15s while the tab is visible. Nothing here talks to SimpleTexting - every
// send goes through the backend's one operator path (lib/officeTexting.js),
// which also takes the conversation over.

(() => {
  const API_BASE = (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
    ? 'http://localhost:4000'
    : 'https://bates-electric-app.onrender.com';
  const TOKEN_KEY = 'bates.auth.token';
  const getToken = () => localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY);
  const token = getToken();
  if (!token) { window.location.replace('/'); return; }

  const BADGE_POLL_MS = 60 * 1000;
  const VIEW_POLL_MS = 15 * 1000;

  const $ = (id) => document.getElementById(id);
  const escapeHtml = (s) => window.BatesUI.escapeHtml(s);
  const gc = () => window.BatesGC || {};

  // ---- State ----
  let conversations = [];
  let me = null;
  let idleMinutes = 120;
  let haveData = false;
  let initialized = false;
  let inflight = null;
  let activeId = null;
  let thread = null;          // { conversation, messages, events, next_visit, reply }
  let threadInflight = null;
  let activeFilter = 'all';   // all | needs | office | auto
  let searchQuery = '';
  let badgeTimer = null;
  let viewTimer = null;
  let sending = false;

  function canText() {
    try {
      const profile = JSON.parse(localStorage.getItem('bates.profile') || '{}');
      if (profile.is_admin === true) return true;
      return !(profile.permissions && profile.permissions.texting === false);
    } catch (e) { return true; }
  }

  // ---- Helpers ----
  async function errorMessageOf(r) {
    try { const b = await r.json(); if (b && b.error) return b.error; } catch (_) { /* non-JSON */ }
    return 'HTTP ' + r.status;
  }
  async function api(path, options = {}) {
    const r = await BatesAuth.authFetch(`${API_BASE}/api/generator-care${path}`, {
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

  const CENTRAL = 'America/Chicago';
  function centralDay(iso) {
    return new Date(iso).toLocaleDateString('en-CA', { timeZone: CENTRAL });
  }
  // "2:14 PM" today, "Mon 2:14 PM" this week, "Oct 3, 2:14 PM" otherwise - Central.
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
    if (!iso) return '';
    return new Date(iso).toLocaleDateString('en-US', { timeZone: CENTRAL, weekday: 'short', month: 'short', day: 'numeric' });
  }
  function fmtPhone(s) {
    const digits = String(s || '').replace(/\D/g, '');
    const ten = digits.length === 11 && digits[0] === '1' ? digits.slice(1) : (digits.length === 10 ? digits : null);
    return ten ? '(' + ten.slice(0, 3) + ') ' + ten.slice(3, 6) + '-' + ten.slice(6) : String(s || '');
  }
  function firstName(name) {
    const f = String(name || '').trim().split(/\s+/)[0];
    return f || '';
  }
  function ownerLabel(c) {
    if (!c || !c.owner) return '';
    if (c.owned_by_me) return 'you';
    return firstName(c.owner.name) || c.owner.email || 'office';
  }
  function minutesLeft(iso) {
    if (!iso) return null;
    return Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 60000));
  }

  const ICON = {
    back: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>',
    person: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
    bolt: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/></svg>',
    open: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><path d="M15 3h6v6"/><path d="M10 14 21 3"/></svg>',
    empty: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
  };

  // Mode chip for a conversation. Needs reply wins over Auto; an office
  // conversation that also needs a reply shows both.
  function modeChip(c) {
    const chips = [];
    if (c.mode === 'office') {
      chips.push(`<span class="chip texts-chip-office" title="A staff member owns this conversation; automated replies are off">${ICON.person} Office &mdash; ${escapeHtml(ownerLabel(c))}</span>`);
      if (c.needs_reply_since) chips.push('<span class="chip chip-warn">Needs reply</span>');
    } else if (c.needs_reply_since) {
      chips.push('<span class="chip chip-warn" title="The customer texted and nobody has answered">Needs reply</span>');
    } else {
      chips.push(`<span class="chip chip-neutral" title="The system answers automatically">${ICON.bolt} Auto</span>`);
    }
    return chips.join(' ');
  }

  // ---- Load ----
  function loadList({ quiet } = {}) {
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const data = await api('/texts/conversations');
        conversations = data.conversations || [];
        me = data.me || me;
        idleMinutes = data.idle_minutes || idleMinutes;
        haveData = true;
        updateTabCount();
        if (initialized) renderList();
      } catch (err) {
        console.error('Texts load failed:', err);
        if (initialized && !quiet) showStatus(`Texts load failed: ${err.message}`, 'error');
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  async function loadBadge() {
    try {
      const data = await api('/texts/unread-count');
      stampTabCount(data.unread || 0, data.needs_reply || 0);
    } catch (err) {
      console.warn('Texts badge poll failed:', err && err.message);
    }
  }

  function updateTabCount() {
    const unread = conversations.filter((c) => c.unread).length;
    const needs = conversations.filter((c) => c.needs_reply_since).length;
    stampTabCount(unread, needs);
  }
  // Unread count on the Texts section tab (shared-nav renders the tab; we
  // stamp the badge, same as leads.js). Hidden at zero.
  function stampTabCount(unread, needs) {
    const tab = document.querySelector('.section-tab[data-match="gc-texts"]');
    if (!tab) return;
    let badge = tab.querySelector('.tab-count');
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'tab-count';
      tab.appendChild(badge);
    }
    badge.textContent = String(unread);
    badge.title = `${unread} unread text conversation${unread === 1 ? '' : 's'}` + (needs ? ` · ${needs} need${needs === 1 ? 's' : ''} a reply` : '');
    badge.hidden = unread === 0;
  }

  // ---- List ----
  function filtered() {
    const q = searchQuery.trim().toLowerCase();
    const qDigits = q.replace(/\D/g, '');
    return conversations.filter((c) => {
      if (activeFilter === 'needs' && !c.needs_reply_since) return false;
      if (activeFilter === 'office' && c.mode !== 'office') return false;
      if (activeFilter === 'auto' && (c.mode !== 'auto' || c.needs_reply_since)) return false;
      if (!q) return true;
      const name = ((c.customer && c.customer.name) || '').toLowerCase();
      if (name.includes(q)) return true;
      if (qDigits.length >= 3 && String(c.phone || '').replace(/\D/g, '').includes(qDigits)) return true;
      return false;
    });
  }

  function previewText(c) {
    const p = c.preview;
    if (!p) return '<span class="texts-muted">No messages yet</span>';
    const who = p.direction === 'in' ? '' : (p.by_staff ? 'Office: ' : 'Auto: ');
    const refused = p.direction === 'out' && p.status !== 'sent';
    return `${who ? `<span class="texts-muted">${who}</span>` : ''}${escapeHtml(p.body)}${refused ? ` <span class="texts-muted">(${escapeHtml(p.status === 'held' ? 'held' : 'not sent')})</span>` : ''}`;
  }

  function renderCounts() {
    const set = (id, n) => { const el = $(id); if (el) el.textContent = String(n); };
    set('texts-count-all', conversations.length);
    set('texts-count-needs', conversations.filter((c) => c.needs_reply_since).length);
    set('texts-count-office', conversations.filter((c) => c.mode === 'office').length);
    set('texts-count-auto', conversations.filter((c) => c.mode === 'auto' && !c.needs_reply_since).length);
    const needsTab = $('texts-tab-needs');
    if (needsTab) needsTab.classList.toggle('alert', conversations.some((c) => c.needs_reply_since));
  }

  function renderList() {
    const list = $('texts-list');
    const loading = $('texts-loading');
    const empty = $('texts-empty');
    if (!list) return;
    if (loading) loading.hidden = haveData;
    renderCounts();
    const rows = filtered();
    if (empty) {
      empty.hidden = !haveData || rows.length > 0;
      const sub = $('texts-empty-sub');
      if (sub) {
        sub.textContent = conversations.length === 0
          ? 'Conversations appear here once a Generator Care customer has been texted or texts us.'
          : (searchQuery ? 'No conversation matches that search.' : 'Nothing in this filter.');
      }
    }
    list.innerHTML = rows.map((c) => {
      const name = (c.customer && c.customer.name) || fmtPhone(c.phone);
      const when = fmtCentral(c.last_activity_at);
      return `<button type="button" class="texts-row${c.id === activeId ? ' active' : ''}${c.unread ? ' unread' : ''}" data-id="${escapeHtml(c.id)}" aria-current="${c.id === activeId ? 'true' : 'false'}">
        <span class="texts-row-dot" aria-hidden="true"></span>
        <span class="texts-row-main">
          <span class="texts-row-top"><span class="texts-row-name">${escapeHtml(name)}</span><span class="texts-row-time">${escapeHtml(when)}</span></span>
          <span class="texts-row-preview">${previewText(c)}</span>
          <span class="texts-row-chips">${modeChip(c)}</span>
        </span>
        ${c.unread ? '<span class="texts-sr">Unread</span>' : ''}
      </button>`;
    }).join('');
    list.querySelectorAll('.texts-row').forEach((btn) => {
      btn.addEventListener('click', () => openThread(btn.dataset.id));
    });
  }

  // ---- Thread ----
  async function openThread(id, { silent } = {}) {
    const changed = id !== activeId;
    activeId = id;
    if (changed) {
      thread = null;
      renderThread();
      renderList();
      const layout = $('texts-layout');
      if (layout) layout.classList.add('is-thread');
    }
    await loadThread({ markRead: true, silent });
  }

  function closeThread() {
    activeId = null;
    thread = null;
    const layout = $('texts-layout');
    if (layout) layout.classList.remove('is-thread');
    renderThread();
    renderList();
  }

  async function loadThread({ markRead, silent } = {}) {
    if (!activeId) return;
    if (threadInflight) return threadInflight;
    const id = activeId;
    threadInflight = (async () => {
      try {
        const data = await api(`/texts/conversations/${encodeURIComponent(id)}`);
        if (id !== activeId) return;
        const prevInbound = thread && thread.conversation && thread.conversation.last_inbound_at;
        thread = data;
        me = data.me || me;
        idleMinutes = data.idle_minutes || idleMinutes;
        const newInbound = data.conversation && data.conversation.last_inbound_at;
        renderThread();
        // Mark read on open and whenever a fresh inbound lands while open.
        if ((markRead || (prevInbound && newInbound && newInbound !== prevInbound)) && canText()) {
          api(`/texts/conversations/${encodeURIComponent(id)}/read`, { method: 'POST', body: '{}' })
            .then(() => {
              const c = conversations.find((x) => x.id === id);
              if (c) { c.unread = false; updateTabCount(); renderList(); }
              if (thread && thread.conversation) thread.conversation.unread = false;
            })
            .catch(() => {});
        }
      } catch (err) {
        console.error('Thread load failed:', err);
        if (!silent) showStatus(`Could not load the conversation: ${err.message}`, 'error');
      } finally {
        threadInflight = null;
      }
    })();
    return threadInflight;
  }

  function senderLabel(m) {
    if (m.direction === 'in') return '';
    if (m.sent_by) return m.sent_by.full_name || m.sent_by.email || 'Office';
    return 'Auto';
  }

  function statusChip(m) {
    if (gc().smsHistoryChip) return gc().smsHistoryChip(m);
    return `<span class="badge badge-neutral">${escapeHtml(m.direction === 'in' ? 'Reply' : (m.status || ''))}</span>`;
  }

  function renderBubble(m) {
    const inbound = m.direction === 'in';
    const held = !inbound && m.status === 'held';
    const refused = !inbound && m.status !== 'sent';
    const who = inbound ? '' : `<span class="texts-sender">${escapeHtml(senderLabel(m))}</span>`;
    const failDetail = (m.status === 'failed' || m.status === 'invalid_phone' || m.status === 'undeliverable') && m.detail
      ? `<div class="gc-meta-label texts-fail">${escapeHtml(m.detail)}</div>` : '';
    const heldNote = held ? '<div class="gc-meta-label texts-held-note">Held &mdash; will send if still relevant after hand-back</div>' : '';
    return `<div class="gc-sms-msg ${inbound ? 'gc-sms-in' : 'gc-sms-out'}${refused ? ' gc-sms-refused' : ''}${held ? ' texts-held' : ''}" data-day="${escapeHtml(centralDay(m.created_at))}">
      <div class="gc-sms-bubble">${escapeHtml(m.body || '')}</div>
      <div class="gc-sms-meta">${who}<span>${escapeHtml(fmtCentral(m.created_at))}</span>${statusChip(m)}</div>
      ${heldNote}${failDetail}
    </div>`;
  }

  function renderMessages(messages) {
    if (!messages.length) return '<div class="texts-muted texts-center">No messages in this conversation yet.</div>';
    let lastDay = null;
    const parts = [];
    for (const m of messages) {
      const day = centralDay(m.created_at);
      if (day !== lastDay) {
        parts.push(`<div class="texts-day"><span>${escapeHtml(fmtCentralDate(m.created_at))}</span></div>`);
        lastDay = day;
      }
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
    return `<details class="texts-events"><summary>Mode history (${events.length})</summary><ul>${events.map((e) => `<li>${escapeHtml(line(e))}</li>`).join('')}</ul></details>`;
  }

  function renderComposer(reply, c) {
    if (!canText()) {
      return '<div class="gc-sms-reply gc-sms-reply-blocked"><span class="chip chip-neutral">Read only</span> <span class="gc-meta-label">Sending texts needs the texting permission. Ask an administrator.</span></div>';
    }
    if (!reply) return '';
    const blocked = (chipText, why) => `<div class="gc-sms-reply gc-sms-reply-blocked" id="texts-compose-box"><span class="chip chip-warn">${chipText}</span> <span class="gc-meta-label">${why}</span></div>`;
    if (reply.reason === 'opted_out') return blocked('Opted out', 'This customer replied STOP. Nothing can be sent to this number.');
    if (reply.reason === 'undeliverable') return blocked('Not deliverable', 'SimpleTexting marked this number as not textable. Check the phone number on the customer record.');
    if (reply.reason === 'invalid_phone') return blocked('No mobile number', 'There is no usable mobile number for this conversation.');
    if (!reply.allowed) return blocked('No consent', `No text consent on file and no text from this customer in the last ${reply.window_days} days. Record consent on the customer record, or wait for them to text first.`);
    const notes = [];
    if (reply.reason === 'recent_inbound') {
      notes.push(`<div class="gc-sms-note"><span class="chip chip-neutral">No consent on file</span> <span class="gc-meta-label">They texted first, so answering is allowed for ${reply.window_days} days from their last text (${escapeHtml(fmtCentral(reply.last_inbound_at, { full: true }))}).</span></div>`);
    }
    if (reply.quiet_hours_now) {
      notes.push(reply.recent_inbound
        ? '<div class="gc-sms-note"><span class="chip chip-warn">Outside 8am&ndash;9pm Central</span> <span class="gc-meta-label">They texted recently, so a reply will send now anyway.</span></div>'
        : '<div class="gc-sms-note"><span class="chip chip-warn">Outside 8am&ndash;9pm Central</span> <span class="gc-meta-label">This customer has not texted recently, so a message now will be logged but not sent until 8am.</span></div>');
    }
    const takeoverNote = c.mode === 'office'
      ? '' : '<div class="gc-sms-note"><span class="gc-meta-label">Sending takes this conversation over: automated replies stop until you hand it back or it sits idle for ' + idleMinutes + ' minutes.</span></div>';
    return `<div class="gc-sms-reply" id="texts-compose-box">
      ${notes.join('')}${takeoverNote}
      <textarea id="texts-compose-text" rows="3" maxlength="1000" placeholder="Type a text to ${escapeHtml(firstName(c.customer && c.customer.name) || 'the customer')}…" aria-label="Text message"></textarea>
      <div class="gc-sms-reply-actions">
        <span class="gc-meta-label" id="texts-compose-count"></span>
        <button type="button" class="btn btn-primary btn-sm" id="texts-compose-send" disabled>Send text</button>
      </div>
    </div>`;
  }

  function renderHeader(c, nextVisit) {
    const name = (c.customer && c.customer.name) || fmtPhone(c.phone);
    const visit = nextVisit
      ? `Next visit ${escapeHtml(fmtCentralDate(nextVisit.appointment_at))}${nextVisit.arrival_window_label ? ', ' + escapeHtml(nextVisit.arrival_window_label) + ' arrival' : ''} &middot; Tech: ${escapeHtml(nextVisit.tech || 'unassigned')}${nextVisit.sms_confirmed_at ? ' &middot; <span class="chip chip-ok">Confirmed by text</span>' : ''}`
      : '<span class="texts-muted">No upcoming visit on the books</span>';
    const idle = c.mode === 'office' && c.idle_returns_at
      ? `<span class="texts-muted">Returns to Auto in ${minutesLeft(c.idle_returns_at)} min without an office text</span>` : '';
    const allowed = canText();
    const buttons = [];
    if (allowed) {
      if (c.mode === 'office') {
        if (!c.owned_by_me) buttons.push('<button type="button" class="btn btn-secondary btn-sm" id="texts-takeover-btn">Take over</button>');
        buttons.push('<button type="button" class="btn btn-secondary btn-sm" id="texts-handback-btn">Hand back to auto</button>');
      } else {
        buttons.push('<button type="button" class="btn btn-secondary btn-sm" id="texts-takeover-btn">Take over</button>');
      }
      if (c.needs_reply_since) buttons.push('<button type="button" class="btn btn-ghost btn-sm" id="texts-handled-btn" title="Clear Needs reply without sending a text (for example, you called them)">Mark handled</button>');
    }
    if (c.subscription_id) buttons.push(`<button type="button" class="btn btn-ghost btn-sm" id="texts-open-record-btn">${ICON.open} Open record</button>`);
    return `<div class="texts-thread-head">
      <button type="button" class="btn btn-ghost btn-sm texts-back" id="texts-back-btn" aria-label="Back to conversations">${ICON.back} All texts</button>
      <div class="texts-thread-title">
        <div class="texts-thread-name">${escapeHtml(name)} <span class="texts-muted">${escapeHtml(fmtPhone(c.phone))}</span></div>
        <div class="texts-thread-chips">${modeChip(c)} ${idle}</div>
      </div>
      <div class="texts-thread-actions">${buttons.join('')}</div>
      <div class="texts-thread-facts">${visit}</div>
    </div>`;
  }

  function renderThread() {
    const pane = $('texts-thread');
    if (!pane) return;
    if (!activeId) {
      pane.innerHTML = `<div class="texts-placeholder"><div class="gc-att-empty-ico">${ICON.empty}</div><div class="big">Pick a conversation</div><div class="texts-muted">Texts with Generator Care customers show up on the left.</div></div>`;
      return;
    }
    if (!thread) {
      pane.innerHTML = `<div class="texts-thread-head"><button type="button" class="btn btn-ghost btn-sm texts-back" id="texts-back-btn">${ICON.back} All texts</button><span class="gc-skeleton gc-skeleton-line gc-skeleton-text-md"></span></div><div class="texts-messages"><span class="gc-skeleton gc-skeleton-line gc-skeleton-text-lg"></span></div>`;
      const back = $('texts-back-btn');
      if (back) back.addEventListener('click', closeThread);
      return;
    }
    const c = thread.conversation;
    pane.innerHTML = renderHeader(c, thread.next_visit) +
      `<div class="texts-messages" id="texts-messages">${renderMessages(thread.messages || [])}</div>` +
      renderEvents(thread.events) +
      renderComposer(thread.reply, c);
    const msgs = $('texts-messages');
    if (msgs) msgs.scrollTop = msgs.scrollHeight;
    wireThread(c);
  }

  function wireThread(c) {
    const on = (id, fn) => { const el = $(id); if (el) el.addEventListener('click', fn); };
    on('texts-back-btn', closeThread);
    on('texts-takeover-btn', () => modeAction('take-over', 'You now own this conversation. Automated replies are off until you hand it back.'));
    on('texts-handback-btn', async () => {
      const ok = await openConfirm({
        title: 'Hand back to auto?',
        message: 'The system resumes answering this customer. Any reminder held while you had it goes out now if it is still relevant, otherwise it is dropped. Nothing is sent just because you handed back.',
        confirmText: 'Hand back',
      });
      if (ok) modeAction('hand-back', 'Handed back. Automated replies are on for this customer again.');
    });
    on('texts-handled-btn', () => modeAction('mark-handled', 'Marked handled.'));
    on('texts-open-record-btn', () => {
      if (gc().showDetail && c.subscription_id) gc().showDetail(c.subscription_id);
      else showStatus('Could not open the customer record from here. Find them on the Customers tab.', 'warning');
    });
    const ta = $('texts-compose-text');
    const btn = $('texts-compose-send');
    const count = $('texts-compose-count');
    if (ta && btn) {
      const update = () => {
        const seg = gc().smsSegments ? gc().smsSegments(ta.value) : { chars: ta.value.length, segments: Math.ceil(ta.value.length / 160) || 0, encoding: 'GSM-7' };
        if (count) count.textContent = seg.chars ? `${seg.chars} chars · ${seg.segments} segment${seg.segments === 1 ? '' : 's'}${seg.encoding === 'UCS-2' ? ' (unicode)' : ''}` : '';
        btn.disabled = sending || !ta.value.trim();
      };
      ta.addEventListener('input', update);
      ta.addEventListener('keydown', (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && !btn.disabled) { e.preventDefault(); sendText(ta, btn); }
      });
      btn.addEventListener('click', () => sendText(ta, btn));
      update();
    }
  }

  async function modeAction(action, successMsg) {
    if (!activeId) return;
    const id = activeId;
    try {
      const data = await api(`/texts/conversations/${encodeURIComponent(id)}/${action}`, { method: 'POST', body: '{}' });
      if (data.conversation) applyConversation(data.conversation);
      showStatus(successMsg, 'success');
      await loadThread({ silent: true });
      loadList({ quiet: true });
    } catch (err) {
      console.error('[texts] ' + action + ' failed:', err);
      showStatus(`Could not ${action.replace(/-/g, ' ')}: ${err.message}`, 'error');
    }
  }

  function applyConversation(conv) {
    const idx = conversations.findIndex((c) => c.id === conv.id);
    const merged = idx >= 0 ? { ...conversations[idx], ...conv } : conv;
    if (idx >= 0) conversations[idx] = merged; else conversations.unshift(merged);
    if (thread && thread.conversation && thread.conversation.id === conv.id) thread.conversation = { ...thread.conversation, ...conv };
    updateTabCount();
    renderList();
  }

  async function sendText(ta, btn) {
    if (!activeId || sending) return;
    const id = activeId;
    const body = ta.value.trim();
    if (!body) return;
    const reply = thread && thread.reply;
    if (reply && reply.quiet_hours_now && reply.recent_inbound) {
      const ok = await openConfirm({ title: 'Send outside 8am–9pm?', message: 'It is outside quiet hours, but this customer texted recently, so the reply will go out right now.', confirmText: 'Send now' });
      if (!ok) return;
    }
    sending = true;
    btn.disabled = true;
    ta.disabled = true;
    try {
      const data = await api(`/texts/conversations/${encodeURIComponent(id)}/send`, { method: 'POST', body: JSON.stringify({ body }) });
      ta.value = '';
      if (data.conversation) applyConversation(data.conversation);
      showStatus('Text sent.', 'success');
      await loadThread({ silent: true });
      loadList({ quiet: true });
    } catch (err) {
      console.error('[texts] send failed:', err);
      await openAlert({ title: 'Text not sent', message: err.message, danger: true });
      await loadThread({ silent: true });
    } finally {
      sending = false;
      ta.disabled = false;
      ta.focus();
    }
  }

  // ---- Polling ----
  function viewVisible() {
    return initialized && location.hash.slice(1) === 'texts' && document.visibilityState === 'visible';
  }
  function tickView() {
    if (!viewVisible()) return;
    loadList({ quiet: true });
    if (activeId) loadThread({ silent: true });
  }
  function startPolling() {
    if (!badgeTimer) badgeTimer = setInterval(() => { if (document.visibilityState === 'visible') loadBadge(); }, BADGE_POLL_MS);
    if (!viewTimer) viewTimer = setInterval(tickView, VIEW_POLL_MS);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { loadBadge(); tickView(); } });
  }

  // ---- Init ----
  function prime() {
    loadBadge();
    startPolling();
  }

  function init() {
    if (initialized) return;
    initialized = true;
    document.querySelectorAll('#texts-tabs .texts-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#texts-tabs .texts-tab').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        activeFilter = btn.dataset.filter;
        renderList();
      });
    });
    const search = $('texts-search');
    if (search) search.addEventListener('input', (e) => { searchQuery = e.target.value; renderList(); });
    renderThread();
    renderList();
    loadList();
    startPolling();
  }

  function refresh() {
    loadList();
    if (activeId) loadThread();
  }

  window.BatesTexts = { init, prime, refresh };
})();
