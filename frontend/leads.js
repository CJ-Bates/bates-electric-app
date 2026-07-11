// frontend/leads.js
// Leads pipeline view for the Generator Care office dashboard (Growth Engine
// WP1). Lazy-loaded like metrics.js/accounting.js: generator-care.js calls
// BatesLeads.init() the first time the #leads tab is activated, and
// BatesLeads.prime() at page load so the "new leads" count on the section tab
// is right without opening the tab. refresh() is what the shared header
// Refresh button calls while this tab is active.

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

  // ---- Pipeline stages, in working order. badge/border classes come from
  // components.css (.badge-*) + the .lead-card.s-* page styles.
  const STAGE_ORDER = ['new', 'contacted', 'signup_sent', 'converted', 'lost'];
  const STAGES = {
    new:         { label: 'New',         badge: 'badge-info',    advance: { to: 'contacted',   label: 'Mark contacted' } },
    contacted:   { label: 'Contacted',   badge: 'badge-neutral', advance: { to: 'signup_sent', label: 'Mark signup sent' } },
    signup_sent: { label: 'Signup sent', badge: 'badge-warn',    advance: null /* next step is Convert */ },
    converted:   { label: 'Converted',   badge: 'badge-ok',      advance: null },
    lost:        { label: 'Lost',        badge: 'badge-danger',  advance: null },
  };
  const SOURCES = {
    field:    { label: 'Field',    chip: 'chip-ok' },
    referral: { label: 'Referral', chip: '' },
    campaign: { label: 'Campaign', chip: 'chip-warn' },
    manual:   { label: 'Manual',   chip: 'chip-neutral' },
  };

  // WP3: the maintenance-book import tags campaign leads with the 3-letter
  // month their maintenance is due; the tab works them as monthly cohorts.
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const MONTH_NAMES = {
    Jan: 'January', Feb: 'February', Mar: 'March', Apr: 'April',
    May: 'May', Jun: 'June', Jul: 'July', Aug: 'August',
    Sep: 'September', Oct: 'October', Nov: 'November', Dec: 'December',
  };
  const thisMonth = () => MONTHS[new Date().getMonth()];
  const nextMonth = () => MONTHS[(new Date().getMonth() + 1) % 12];

  // State
  let leads = [];          // full list from GET /leads, newest first
  let haveData = false;    // first fetch has landed
  let initialized = false; // init() ran (view markup is live)
  let inflight = null;     // de-dupes prime() vs first init() fetch
  let activeStage = 'all';
  let activeMonth = 'all'; // 'all' or a 3-letter month
  let searchQuery = '';
  let batchSize = 40;      // WP4.1 "Select next N" helper size (1..100)
  let sendingInvites = false; // a batch POST is in flight
  // WP4.1: the invite selection — lead ids checked in the cohort view. The
  // server caps a send at 100, so selection is capped there too. SEND_CAP
  // MIRRORS INVITE_MAX_BATCH in backend/routes/generator-care/leads.js
  // (separate deploys, no bundler) — edit BOTH together or the UI will offer
  // selections the server rejects.
  let selected = new Set();
  const SEND_CAP = 100;
  const warnSendCap = () =>
    showStatus(`A send is capped at ${SEND_CAP} \u2014 send these first, then select more.`, 'warning');
  // WP4.2 view toggles, cohort-scoped (reset on month change) and mutually
  // exclusive — their intersection is provably empty (follow-ups are
  // signup_sent, selected leads are new/contacted), so turning one on turns
  // the other off. Both bypass the stage tabs for the same reason: the chip
  // count is a cohort fact and must match the list it opens.
  let showFollowUpOnly = false;
  let showSelectedOnly = false;

  // Loose email shape check for the Add/Edit dialogs. MIRRORS EMAIL_RE in
  // backend/routes/generator-care/leads.js (separate deploys, no bundler) —
  // edit BOTH together.
  const LEAD_EMAIL_RE = /^\S+@\S+\.\S+$/;

  // WP4.2 "Needs follow-up": invited (signup_sent) this long ago with no
  // signup — worth a nudge, NOT auto-lost (they're existing maintenance
  // customers). Derived from invited_at; tune the window here.
  const FOLLOW_UP_DAYS = 21;
  const needsFollowUp = (l) => {
    if (l.status !== 'signup_sent' || !l.invited_at) return false;
    const t = new Date(l.invited_at).getTime();
    return Number.isFinite(t) && Date.now() - t > FOLLOW_UP_DAYS * 24 * 60 * 60 * 1000;
  };

  // ---- Helpers ----
  const $ = (id) => document.getElementById(id);
  const escapeHtml = (s) => window.BatesUI.escapeHtml(s);
  // Same US MM/DD/YYYY convention as accounting.js's formatDate, but from a
  // timestamptz — rendered in the viewer's local time (a lead created Tuesday
  // evening Central must not read as Wednesday).
  const fmtDate = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;
  };

  async function errorMessageOf(r) {
    try {
      const body = await r.json();
      if (body && body.error) return body.error;
    } catch (_) { /* non-JSON body */ }
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

  // ---- Load ----
  function loadLeads() {
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const { leads: rows } = await api('/leads');
        leads = rows || [];
        haveData = true;
        updateTabCount();
        if (initialized) render();
      } catch (err) {
        console.error('Leads load failed:', err);
        if (initialized) showStatus(`Leads load failed: ${err.message}`, 'error');
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  // Small "new leads" count on the Leads section tab (shared-nav renders the
  // tab itself; we stamp the badge) — same idea as the Needs Attention
  // filter-pill counts. Hidden at zero so the tab stays quiet.
  function updateTabCount() {
    const tab = document.querySelector('.section-tab[data-match="gc-leads"]');
    if (!tab) return;
    let badge = tab.querySelector('.tab-count');
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'tab-count';
      tab.appendChild(badge);
    }
    const n = leads.filter((l) => l.status === 'new').length;
    badge.textContent = String(n);
    badge.hidden = n === 0;
  }

  // ---- Render ----
  function matchesSearch(l) {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return ['customer_name', 'customer_email', 'customer_phone', 'install_address',
      'install_city', 'install_zip', 'generator_info', 'referred_by_label']
      .some((f) => (l[f] || '').toLowerCase().includes(q));
  }

  function leadCardHtml(l) {
    const stage = STAGES[l.status] || STAGES.new;
    const source = SOURCES[l.source] || SOURCES.manual;
    const contactBits = [];
    if (l.customer_phone) contactBits.push(`<a href="tel:${escapeHtml(l.customer_phone.replace(/[^\d+]/g, ''))}">${escapeHtml(l.customer_phone)}</a>`);
    if (l.customer_email) contactBits.push(`<a href="mailto:${escapeHtml(l.customer_email)}">${escapeHtml(l.customer_email)}</a>`);
    const place = [l.install_city, l.install_state].filter(Boolean).join(', ');
    if (place) contactBits.push(`<span>${escapeHtml(place)}</span>`);

    const actions = [];
    if (stage.advance) {
      actions.push(`<button type="button" class="btn btn-primary btn-sm" data-action="advance" data-id="${escapeHtml(l.id)}">${escapeHtml(stage.advance.label)}</button>`);
    }
    if (l.status === 'signup_sent') {
      actions.push(`<button type="button" class="btn btn-primary btn-sm" data-action="convert" data-id="${escapeHtml(l.id)}">Mark converted</button>`);
    }
    // WP2: the convertible path — email (or hand over) a pre-tagged signup
    // link; a signup through it flips this lead to Converted automatically.
    if (l.status !== 'converted' && l.status !== 'lost') {
      actions.push(`<button type="button" class="btn btn-secondary btn-sm" data-action="send-signup" data-id="${escapeHtml(l.id)}">${l.status === 'signup_sent' ? 'Resend signup link' : 'Send signup link'}</button>`);
    }
    // WP4.2: edit fixes contact info the office learns by phone — adding an
    // email is what makes a lead emailable. Delete removes test/junk rows.
    actions.push(`<button type="button" class="btn btn-secondary btn-sm" data-action="edit" data-id="${escapeHtml(l.id)}">Edit</button>`);
    actions.push(`<button type="button" class="btn btn-secondary btn-sm" data-action="note" data-id="${escapeHtml(l.id)}">${l.notes ? 'Edit note' : 'Add note'}</button>`);
    if (l.status !== 'converted' && l.status !== 'lost') {
      actions.push(`<button type="button" class="btn btn-secondary btn-sm" data-action="lost" data-id="${escapeHtml(l.id)}">Mark lost</button>`);
    }
    if (l.status === 'lost') {
      actions.push(`<button type="button" class="btn btn-secondary btn-sm" data-action="reopen" data-id="${escapeHtml(l.id)}">Reopen</button>`);
    }
    actions.push(`<button type="button" class="btn btn-secondary btn-sm" data-action="delete" data-id="${escapeHtml(l.id)}">Delete</button>`);

    // WP4.1: in the month-cohort view every emailable lead gets a checkbox
    // (the invite selection); ineligible ones show why they can't be included.
    const who = l.customer_name || l.customer_email || l.customer_phone || 'Unnamed lead';
    let selectHtml = '';
    if (activeMonth !== 'all') {
      if (isEmailable(l)) {
        selectHtml = `<input type="checkbox" class="lead-check" data-check="${escapeHtml(l.id)}"`
          + ` aria-label="Include ${escapeHtml(who)} in the invite send"${selected.has(l.id) ? ' checked' : ''}>`;
      } else if (l.status !== 'lost') {
        // Lost cards skip the chip — their badge already says it.
        const reason = ineligibleReason(l);
        if (reason) selectHtml = `<span class="lead-inel">${escapeHtml(reason)}</span>`;
      }
    }

    return `<div class="lead-card s-${escapeHtml(l.status)}${selected.has(l.id) ? ' is-selected' : ''}">
      <div class="lead-top">
        ${selectHtml}<span class="lead-name">${escapeHtml(who)}</span>
        <span class="badge ${stage.badge}">${escapeHtml(stage.label)}</span>
        <span class="chip${source.chip ? ' ' + source.chip : ''}">${escapeHtml(source.label)}</span>
        ${l.maintenance_month ? `<span class="chip">Due ${escapeHtml(l.maintenance_month)}</span>` : ''}
        ${needsFollowUp(l) ? `<span class="chip chip-warn">Needs follow-up</span>` : ''}
      </div>
      ${contactBits.length ? `<div class="lead-meta">${contactBits.join('')}</div>` : ''}
      ${l.generator_info ? `<div class="lead-gen">${escapeHtml(l.generator_info)}</div>` : ''}
      ${l.notes ? `<div class="lead-note">${escapeHtml(l.notes)}</div>` : ''}
      <div class="lead-from">${l.referred_by_label ? `From: ${escapeHtml(l.referred_by_label)} &middot; ` : ''}Added ${fmtDate(l.created_at)}</div>
      <div class="lead-actions">${actions.join('')}</div>
    </div>`;
  }

  function matchesMonth(l) {
    return activeMonth === 'all' || l.maintenance_month === activeMonth;
  }

  // WP4: why a lead can't be emailed by the invite send, or null if it can.
  // The single frontend copy of the eligibility rule — check order and
  // wording mirror the send-invites route's per-id checks, so the chips and
  // preview say exactly what the server would report.
  const ineligibleReason = (l) => {
    if (!l.customer_email) return 'no email';
    if (l.email_opt_out) return 'opted out';
    if (l.status === 'signup_sent' || l.status === 'converted') return 'already invited';
    if (l.status === 'lost') return 'marked lost';
    return null;
  };
  const isEmailable = (l) => !ineligibleReason(l);

  // The selection's send order mirrors the server-side drip convention:
  // oldest lead first, id as the tiebreaker.
  const oldestFirst = (a, b) =>
    String(a.created_at || '').localeCompare(String(b.created_at || ''))
    || String(a.id).localeCompare(String(b.id));

  // Drop selected ids that no longer point at an emailable lead in the
  // current month cohort (sent leads flip to signup_sent on refetch, the
  // month filter changed, an edit removed the email...). Run before every
  // render so a checked box always means "will be in the send".
  function pruneSelection() {
    if (!selected.size) return;
    if (activeMonth === 'all') { selected = new Set(); return; }
    const keep = new Set();
    for (const l of leads) {
      if (selected.has(l.id) && matchesMonth(l) && isEmailable(l)) keep.add(l.id);
    }
    selected = keep;
  }

  // Cohort summary bar: "August — 136 leads · 92 emailable · 12 invited",
  // plus the WP4.1 selection controls: a "Select next N" helper (checks the
  // next N emailable leads, oldest-first — the old blind batch, now visible),
  // Clear, a live "12 selected" count, and "Send to selected (12)" which
  // opens the recipient-list preview. Only meaningful when a single month is
  // selected. "invited" = already sent a signup link or converted;
  // "emailable" = who can still be checked. Rebuilt on every render, so the
  // controls use delegated listeners bound once in init() and the input's
  // value round-trips through `batchSize`.
  function renderMonthSummary(cohort) {
    const el = $('lead-month-summary');
    if (!el) return;
    if (activeMonth === 'all') {
      // WP4.2: instead of vanishing, the bar says why there are no send
      // controls — the "why can't I select anything" moment.
      el.innerHTML = `<span class="lead-send-hint">Pick a month to review and send invites.</span>`;
      el.hidden = false;
      return;
    }
    const monthName = escapeHtml(MONTH_NAMES[activeMonth] || activeMonth);
    if (!cohort.length) {
      // A 0-lead cohort gets a plain fact, not send controls (the
      // "everyone has been invited" copy would be a lie here).
      el.innerHTML = `<span class="month">${monthName}</span>`
        + `<span class="detail">No leads in this cohort.</span>`;
      el.hidden = false;
      return;
    }
    const invited = cohort.filter((l) => l.status === 'signup_sent' || l.status === 'converted').length;
    const emailable = cohort.filter(isEmailable).length;
    const followUps = cohort.filter(needsFollowUp).length;
    const leadsWord = cohort.length === 1 ? 'lead' : 'leads';
    const none = emailable === 0;
    const n = selected.size;
    const sendLabel = sendingInvites
      ? 'Sending&hellip;'
      : `Send to selected (${n})`;
    // WP4.2 quick filters: "Needs follow-up" (invited 21+ days, no signup)
    // and "Show selected" (review the exact batch in the list itself).
    // Rendered while their count is nonzero OR they're active (so an active
    // chip can always be clicked back off).
    const filterChip = (id, label, count, active) => ((count || active)
      ? `<button type="button" id="${id}" class="filter${active ? ' active' : ''}">${label} <span class="count">${count}</span></button>`
      : '');
    const filterChips = filterChip('lead-followup-chip', 'Needs follow-up', followUps, showFollowUpOnly)
      + filterChip('lead-show-sel-chip', 'Show selected', n, showSelectedOnly);
    el.innerHTML = `<span class="month">${monthName}</span>`
      + `<span class="detail">${cohort.length} ${leadsWord} &middot; ${emailable} emailable &middot; ${invited} invited</span>`
      + filterChips
      + `<span class="lead-send-group">`
      + (none
        ? `<span class="lead-send-hint">Everyone emailable in this cohort has been invited.</span>`
        : `<label for="lead-batch-size">Next</label>`
          + `<input type="number" id="lead-batch-size" min="1" max="${SEND_CAP}" inputmode="numeric" value="${batchSize}">`
          + `<button type="button" id="lead-select-next-btn" class="btn btn-secondary btn-sm"${sendingInvites ? ' disabled' : ''} title="Checks the next ${batchSize} due to be invited, oldest first">Select next ${batchSize}</button>`
          + `<button type="button" id="lead-clear-sel-btn" class="btn btn-secondary btn-sm"${!n || sendingInvites ? ' disabled' : ''}>Clear</button>`
          + `<span class="lead-sel-count">${n} selected</span>`)
      + `<button type="button" id="lead-send-invites-btn" class="btn btn-primary btn-sm"${!n || sendingInvites ? ' disabled' : ''}>${sendLabel}</button>`
      + (none ? '' : `<span class="lead-send-note">Select next = the next ${batchSize} due to be invited, oldest first.</span>`)
      + `</span>`;
    el.hidden = false;
  }

  // "Select next N": check the next `batchSize` emailable leads of the FULL
  // month cohort, oldest-first, skipping ones already checked — the WP4
  // batch convenience, but the result is visible and editable before any
  // email goes out. Capped so the selection never exceeds what one send
  // accepts.
  function selectNext() {
    if (sendingInvites || activeMonth === 'all') return;
    // Selecting starts a send workflow — drop the follow-up view so the
    // newly checked cards are actually on screen, never checked invisibly.
    showFollowUpOnly = false;
    const eligible = leads.filter(matchesMonth).filter(isEmailable).sort(oldestFirst);
    let room = Math.min(batchSize, SEND_CAP - selected.size);
    if (room <= 0) {
      warnSendCap();
      return;
    }
    let added = 0;
    for (const l of eligible) {
      if (room <= 0) break;
      if (selected.has(l.id)) continue;
      selected.add(l.id);
      room--;
      added++;
    }
    if (!added) showStatus('Everyone emailable is already selected.', 'info');
    render();
    // WP4.3: the fresh selection is grouped at the top of the list — bring
    // it (and the action bar) into view so the batch is immediately
    // reviewable instead of landing off-screen.
    if (added) {
      const bar = $('lead-month-summary');
      if (bar && typeof bar.scrollIntoView === 'function') {
        bar.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }
  }

  // WP4.1 preview dialog: the exact recipient list, one `Name — email` row
  // each, scrollable, with any now-ineligible picks greyed out in a "will be
  // skipped" group. Bespoke because the shared openConfirm escapes its
  // message (no list markup) — same gc-rd-* dialog chrome + behavior.
  function openSendPreview({ recipients, stale, monthName }) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'gc-rd-overlay';
      const n = recipients.length;
      const row = (l, why) =>
        `<div class="lead-preview-row${why ? ' skipped' : ''}">`
        + `<span class="name">${escapeHtml(l.customer_name || 'Unnamed lead')}</span>`
        + `<span class="email">${escapeHtml(l.customer_email || 'no email')}</span>`
        + (why ? `<span class="why">${escapeHtml(why)}</span>` : '')
        + `</div>`;
      const staleHtml = stale.length
        ? `<div class="lead-preview-skip-h">Will be skipped (${stale.length})</div>`
          + stale.map((l) => row(l, ineligibleReason(l) || 'no longer eligible')).join('')
        : '';
      overlay.innerHTML = `
        <div class="gc-rd-panel" role="dialog" aria-modal="true" aria-label="Send invites?">
          <h3 class="gc-rd-title">Send invites?</h3>
          <div class="gc-rd-sub">You're about to email ${n === 1 ? 'this' : `these ${n}`} ${escapeHtml(monthName)} customer${n === 1 ? '' : 's'}. They'll move to Signup sent.</div>
          <div class="lead-preview-list">${recipients.map((l) => row(l)).join('')}${staleHtml}</div>
          <div class="gc-rd-actions">
            <button type="button" class="btn btn-secondary gc-rd-cancel">Cancel</button>
            <button type="button" class="btn btn-primary gc-rd-submit">Send ${n} invite${n === 1 ? '' : 's'}</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);
      const submitEl = overlay.querySelector('.gc-rd-submit');
      function close(result) { document.removeEventListener('keydown', onKey); overlay.remove(); resolve(result); }
      // Unlike openConfirm, NO document-level Enter-confirms: this dialog
      // guards a bulk email send, and a global Enter would fire it even with
      // focus on Cancel. The focused button handles Enter natively (Send has
      // initial focus, so plain Enter still confirms).
      function onKey(e) { if (e.key === 'Escape') close(false); }
      document.addEventListener('keydown', onKey);
      overlay.querySelector('.gc-rd-cancel').addEventListener('click', () => close(false));
      overlay.addEventListener('click', (e) => { if (e.target === overlay) close(false); });
      submitEl.addEventListener('click', () => close(true));
      setTimeout(() => submitEl.focus(), 30);
    });
  }

  // WP4.1: send the enrollment invite to exactly the checked leads, after a
  // preview that lists every recipient. The server re-validates each id
  // (never re-sends, never emails opted-out leads) — this preview is a
  // courtesy; the server is the gate.
  async function sendInvites() {
    if (sendingInvites || activeMonth === 'all' || !selected.size) return;
    const monthName = MONTH_NAMES[activeMonth] || activeMonth;
    // Resolve the selection against the freshest local data, oldest-first —
    // the same order the server walks. Anything that went ineligible since
    // it was checked lands in the greyed "will be skipped" group.
    const picks = leads.filter((l) => selected.has(l.id)).sort(oldestFirst);
    const recipients = picks.filter(isEmailable);
    const stale = picks.filter((l) => !isEmailable(l));
    if (!recipients.length) {
      showStatus('The selected leads are no longer emailable \u2014 refresh and reselect.', 'warning');
      pruneSelection();
      render();
      return;
    }

    const ok = await openSendPreview({ recipients, stale, monthName });
    if (!ok) return;

    sendingInvites = true;
    render();
    try {
      const data = await api('/leads/send-invites', {
        method: 'POST',
        body: JSON.stringify({ lead_ids: recipients.map((l) => l.id) }),
      });
      const bits = [`Sent ${data.sent} invite${data.sent === 1 ? '' : 's'}`];
      const skippedCount = (data.skipped || []).length;
      if (skippedCount) bits.push(`${skippedCount} skipped`);
      if (data.failed) bits.push(`${data.failed} failed \u2014 still emailable, select again to retry`);
      showStatus(`${bits.join(' · ')}.`, data.failed ? 'error' : 'success');
      // Drop only the leads this send attempted — boxes checked while the
      // POST was in flight are the NEXT selection and must survive.
      for (const l of recipients) selected.delete(l.id);
    } catch (err) {
      showStatus(`Send failed: ${err.message}`, 'error');
    } finally {
      sendingInvites = false;
      // Refetch so the cohort counts + stages reflect what the server did:
      // sent leads move to Signup sent and drop out of "emailable". A fetch
      // already in flight (e.g. the header Refresh) predates the status
      // writes — wait it out, then fetch fresh so the render is honest.
      if (inflight) await inflight;
      await loadLeads();
      render();
    }
  }

  function render() {
    const listEl = $('lead-list');
    const emptyEl = $('leads-empty');
    const loadingEl = $('leads-loading');
    if (!listEl) return;
    loadingEl.hidden = haveData;
    if (!haveData) return;

    // Pill counts always reflect the search+month-filtered set, so with a
    // month selected they read as that cohort's stage breakdown. The cohort
    // summary bar deliberately ignores the search box: its counts must match
    // the FULL month cohort, or the selection math would lie. The selection
    // is pruned first so every count and checkbox reflects reality.
    pruneSelection();
    // A pruned-empty selection has nothing to show — drop back to the list
    // rather than an inexplicable empty view.
    if (showSelectedOnly && !selected.size) showSelectedOnly = false;
    renderMonthSummary(leads.filter(matchesMonth));
    const searched = leads.filter(matchesSearch).filter(matchesMonth);
    $('lead-count-all').textContent = String(searched.length);
    for (const s of STAGE_ORDER) {
      const el = $(`lead-count-${s}`);
      if (el) el.textContent = String(searched.filter((l) => l.status === s).length);
    }

    // WP4.2 quick filters replace the stage filter while active (their
    // populations are stage-specific, so composing with a stage tab would
    // show an empty list under a chip with a nonzero count). Search still
    // applies — the user typed it.
    let visible;
    if (showFollowUpOnly) visible = searched.filter(needsFollowUp);
    else if (showSelectedOnly) visible = searched.filter((l) => selected.has(l.id));
    else visible = activeStage === 'all' ? searched : searched.filter((l) => l.status === activeStage);
    emptyEl.hidden = visible.length > 0;
    // Two flavors of empty: a brand-new pipeline vs an empty filter result.
    if (!visible.length) {
      const virgin = leads.length === 0;
      $('leads-empty-title').textContent = virgin ? 'No leads yet' : 'No matching leads';
      let sub = virgin
        ? 'Every prospective Generator Care customer lands here &mdash; field enrollments, referrals, and campaign responses once those channels launch. Use <strong>Add lead</strong> to log one the office hears about today, then work it left to right: New &rarr; Contacted &rarr; Signup sent &rarr; Converted.'
        : 'Try a different stage, month, or search.';
      // WP4.2: the tab defaults to a month cohort, so a search can find
      // nothing here while the lead exists in another month — say so and
      // offer the jump, or "not in this month" reads as "not in the book".
      if (!virgin && searchQuery && activeMonth !== 'all') {
        const elsewhere = leads.filter(matchesSearch).length;
        if (elsewhere > 0) {
          sub = `${elsewhere} match${elsewhere === 1 ? '' : 'es'} outside ${escapeHtml(MONTH_NAMES[activeMonth] || activeMonth)}. `
            + '<button type="button" id="leads-empty-all-btn" class="btn btn-secondary btn-sm">Search all months</button>';
        }
      }
      $('leads-empty-sub').innerHTML = sub;
      listEl.innerHTML = '';
      return;
    }

    // WP4.3: checked leads float to the TOP of the list. "Select next 40"
    // picks the oldest-due (the real send order) while the list sorts
    // newest-first, so without this the fresh selection lands scattered at
    // the bottom. Stable partition: selected keep their relative order and
    // so do the rest, so nothing else jumps around. (Under "Show selected"
    // everything visible is selected — nothing to float.)
    let floated = [];
    let rest = visible;
    if (!showSelectedOnly && selected.size) {
      floated = visible.filter((l) => selected.has(l.id));
      rest = visible.filter((l) => !selected.has(l.id));
    }

    if (activeStage === 'all') {
      // Grouped by stage, working order — same group-heading treatment as the
      // Needs Attention queue. The floated selection gets its own heading so
      // it doesn't read as a stray stage group.
      listEl.innerHTML = (floated.length
        ? `<div class="gc-att-group-h">Selected <span class="count">${floated.length}</span></div>`
          + floated.map(leadCardHtml).join('')
        : '')
        + STAGE_ORDER.map((s) => {
          const group = rest.filter((l) => l.status === s);
          if (!group.length) return '';
          return `<div class="gc-att-group-h">${escapeHtml(STAGES[s].label)} <span class="count">${group.length}</span></div>`
            + group.map(leadCardHtml).join('');
        }).join('');
    } else {
      listEl.innerHTML = [...floated, ...rest].map(leadCardHtml).join('');
    }
  }

  // ---- Mutations ----
  function updateLocal(lead) {
    const i = leads.findIndex((l) => l.id === lead.id);
    if (i >= 0) leads[i] = lead; else leads.unshift(lead);
    updateTabCount();
    render();
  }

  async function patchLead(id, body, okMsg) {
    try {
      const { lead } = await api(`/leads/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
      updateLocal(lead);
      if (okMsg) showStatus(okMsg, 'success');
    } catch (err) {
      showStatus(`Failed: ${err.message}`, 'error');
    }
  }

  async function onAction(action, id) {
    const l = leads.find((x) => x.id === id);
    if (!l) return;
    const who = l.customer_name || l.customer_email || 'this lead';

    if (action === 'advance') {
      const adv = STAGES[l.status] && STAGES[l.status].advance;
      if (adv) await patchLead(id, { status: adv.to }, `${who} \u2192 ${STAGES[adv.to].label}.`);
    } else if (action === 'convert') {
      const ok = await openConfirm({
        title: 'Mark converted?',
        message: `${who} becomes a won lead. The signup itself still happens at generator.bates-electric.com \u2014 this just records the outcome.`,
        confirmText: 'Mark converted',
      });
      if (!ok) return;
      try {
        const { lead } = await api(`/leads/${id}/convert`, { method: 'POST', body: JSON.stringify({}) });
        updateLocal(lead);
        showStatus(`${who} marked converted.`, 'success');
      } catch (err) {
        showStatus(`Failed: ${err.message}`, 'error');
      }
    } else if (action === 'lost') {
      const ok = await openConfirm({
        title: 'Mark lost?',
        message: `${who} moves to Lost. You can reopen it later if they come back.`,
        confirmText: 'Mark lost',
        danger: true,
      });
      if (ok) await patchLead(id, { status: 'lost' }, `${who} marked lost.`);
    } else if (action === 'reopen') {
      await patchLead(id, { status: 'new' }, `${who} reopened.`);
    } else if (action === 'send-signup') {
      const ok = await openConfirm({
        title: l.status === 'signup_sent' ? 'Resend signup link?' : 'Send signup link?',
        message: l.customer_email
          ? `Emails ${l.customer_email} their pre-tagged signup link \u2014 a signup through it marks this lead Converted automatically. You also get the link to copy.`
          : `${who} has no email on file, so nothing is emailed \u2014 you get the pre-tagged link to copy into a text or call. The lead moves to Signup sent.`,
        confirmText: l.customer_email ? 'Send email' : 'Get link',
      });
      if (!ok) return;
      try {
        const data = await api(`/leads/${id}/send-signup`, { method: 'POST', body: JSON.stringify({}) });
        if (data.lead) updateLocal(data.lead);
        await offerCopyLink(data);
      } catch (err) {
        showStatus(`Failed: ${err.message}`, 'error');
      }
    } else if (action === 'note') {
      const vals = await openPrompt({
        title: l.notes ? 'Edit note' : 'Add note',
        message: `Working notes for ${who} \u2014 only the office sees these.`,
        fields: [{ name: 'notes', label: 'Note', type: 'textarea', value: l.notes || '' }],
        confirmText: 'Save note',
      });
      if (vals === null) return;
      await patchLead(id, { notes: vals.notes }, 'Note saved.');
    } else if (action === 'edit') {
      await editLead(l);
    } else if (action === 'delete') {
      // Deleting is allowed at every stage (it's how test/junk rows go away,
      // including a converted TEST lead), but the confirm spells out what a
      // converted/invited delete actually loses.
      const extra = l.status === 'converted'
        ? ' This lead CONVERTED \u2014 deleting it also removes that win from any future campaign metrics.'
        : l.status === 'signup_sent'
          ? ' Their invite is already out \u2014 a signup through it later won\u2019t be traced back to this campaign.'
          : '';
      const ok = await openConfirm({
        title: 'Delete this lead?',
        message: `${who} is removed from the pipeline permanently. This can\u2019t be undone.${extra}`,
        confirmText: 'Delete lead',
        danger: true,
      });
      if (!ok) return;
      try {
        await api(`/leads/${id}`, { method: 'DELETE' });
        leads = leads.filter((x) => x.id !== id);
        selected.delete(id);
        updateTabCount();
        render();
        showStatus(`${who} deleted.`, 'success');
      } catch (err) {
        showStatus(`Failed: ${err.message}`, 'error');
      }
    }
  }

  // The seven contact/address fields Add and Edit share — ONE list, so the
  // two dialogs can't drift (a field present in one but missing from the
  // other would let data be entered that the other dialog never shows).
  const leadContactFields = (l = {}) => [
    { name: 'customer_name', label: 'Name', value: l.customer_name || '', placeholder: 'Jane Doe' },
    { name: 'customer_phone', label: 'Phone', type: 'tel', inputmode: 'tel', value: l.customer_phone || '', placeholder: '(314) 555-0123' },
    { name: 'customer_email', label: 'Email', type: 'email', value: l.customer_email || '', placeholder: 'jane@example.com' },
    { name: 'install_address', label: 'Street address', value: l.install_address || '', placeholder: '123 Main St' },
    { name: 'install_city', label: 'City', value: l.install_city || '' },
    { name: 'install_state', label: 'State', value: l.install_state || '', placeholder: 'MO', hint: '2-letter code' },
    { name: 'install_zip', label: 'ZIP', inputmode: 'numeric', value: l.install_zip || '' },
  ];

  // One validator for both dialogs. `original` lets Edit skip the email
  // format check when a stored (possibly imported-junk) address is
  // untouched — a phone fix must never be blocked by an email the office
  // didn't enter. Add passes no original, so every email is checked.
  const validateLeadContact = (original = {}) => (v) => {
    if (!v.customer_name.trim() && !v.customer_email.trim() && !v.customer_phone.trim()) {
      return 'Enter at least a name, email, or phone.';
    }
    const email = v.customer_email.trim();
    if (email && email !== (original.customer_email || '') && !LEAD_EMAIL_RE.test(email)) {
      return 'That email doesn\u2019t look right.';
    }
    if (v.install_state.trim() && !/^[A-Za-z]{2}$/.test(v.install_state.trim())) {
      return 'State should be the 2-letter code (e.g. MO).';
    }
    return null;
  };

  // WP4.2: fix a lead's contact details as the office reaches people by
  // phone. Adding an email is the payoff — the lead immediately becomes
  // emailable (checkbox appears in the cohort view). Status is deliberately
  // NOT here (the stage buttons own it), and notes keep their own dialog.
  async function editLead(l) {
    const dash = '\u2014';
    const vals = await openPrompt({
      title: 'Edit lead',
      message: `Fix contact details for ${l.customer_name || 'this lead'} ${dash} adding an email makes them emailable for invites.`,
      fields: [
        ...leadContactFields(l),
        {
          name: 'maintenance_month', label: 'Maintenance month', type: 'select',
          value: l.maintenance_month || '',
          options: [{ value: '', label: dash }, ...MONTHS.map((m) => ({ value: m, label: MONTH_NAMES[m] }))],
        },
        {
          // MIRRORS CONTACT_TYPES in backend/lib/emails.js — edit BOTH together.
          name: 'contact_type', label: 'Contact type', type: 'select',
          value: l.contact_type || '',
          options: [{ value: '', label: dash }, { value: 'Person', label: 'Person' }, { value: 'Couple', label: 'Couple' }, { value: 'Business', label: 'Business' }],
          hint: 'Sets the invite greeting (first name / couple / neutral)',
        },
      ],
      validate: validateLeadContact(l),
      confirmText: 'Save changes',
    });
    if (vals === null) return;
    if (vals.install_state) vals.install_state = vals.install_state.toUpperCase();
    // Send only what actually changed. A stored-but-untouched field (esp. a
    // junk imported email the server would reject) must never ride along
    // with an unrelated fix. '' still means "clear this field".
    const changes = {};
    for (const [k, v] of Object.entries(vals)) {
      if (v.trim() !== String(l[k] || '')) changes[k] = v;
    }
    if (!Object.keys(changes).length) {
      showStatus('Nothing changed.', 'info');
      return;
    }
    await patchLead(l.id, changes, 'Lead updated.');
  }

  // Post-send dialog: confirms what happened (emailed vs copy-only) and offers
  // the pre-tagged URL with a Copy button. The URL sits in a regular input so
  // it stays selectable if the clipboard API is unavailable.
  async function offerCopyLink(data) {
    const emailedTo = data.lead && data.lead.customer_email;
    const message = data.emailed
      ? `Emailed to ${emailedTo}. You can also copy the link to send it another way.`
      : (data.email_error || 'Copy the link and text it to the customer \u2014 a signup through it marks this lead Converted automatically.');
    const vals = await openPrompt({
      title: data.emailed ? 'Signup link sent' : 'Signup link ready',
      message,
      fields: [{ name: 'url', label: 'Signup link', value: data.url }],
      confirmText: 'Copy link',
      cancelText: 'Done',
    });
    if (vals === null) return;
    try {
      await navigator.clipboard.writeText(data.url);
      showStatus('Link copied.', 'success');
    } catch (_) {
      showStatus('Copy failed \u2014 select the link text and copy it manually.', 'error');
    }
  }

  async function addLead() {
    const vals = await openPrompt({
      title: 'Add lead',
      message: 'Log a prospective Generator Care customer. Name, email, or phone is enough to start.',
      fields: [
        ...leadContactFields(),
        { name: 'generator_info', label: 'Generator info', type: 'textarea', placeholder: 'Make / model / anything the tech jotted down' },
        { name: 'referred_by_label', label: 'Who sent this?', placeholder: 'e.g. tech name, "Referral: John Smith"', hint: 'Shown on the lead so provenance never gets lost' },
        { name: 'notes', label: 'Notes', type: 'textarea' },
      ],
      validate: validateLeadContact(),
      confirmText: 'Add lead',
    });
    if (vals === null) return;
    if (vals.install_state) vals.install_state = vals.install_state.toUpperCase();
    try {
      const { lead } = await api('/leads', { method: 'POST', body: JSON.stringify({ ...vals, source: 'manual' }) });
      updateLocal(lead);
      // A manual add has no maintenance month, so under the default month
      // cohort the new card would be invisible and the save would look
      // lost \u2014 jump to a view that shows it.
      if (!matchesMonth(lead)) setMonth(lead.maintenance_month || 'all');
      showStatus('Lead added.', 'success');
    } catch (err) {
      showStatus(`Failed: ${err.message}`, 'error');
    }
  }

  // ---- Init ----
  // prime(): fetch once at page load so the section-tab count is populated
  // without the tab ever being opened. init(): called by generator-care.js on
  // first activation of #leads — binds events and renders (reusing primed data).
  function prime() {
    if (!haveData) loadLeads();
  }

  // Single entry point for month changes (dropdown or quick chip) so the
  // dropdown value and the chips' active states never disagree. A month
  // switch drops the invite selection and the cohort-scoped view toggles —
  // they belong to one cohort.
  function setMonth(m) {
    if (m !== activeMonth) {
      selected = new Set();
      showFollowUpOnly = false;
      showSelectedOnly = false;
    }
    activeMonth = m;
    const sel = $('lead-month');
    if (sel) sel.value = m;
    const chipThis = $('lead-due-this');
    const chipNext = $('lead-due-next');
    if (chipThis) chipThis.classList.toggle('active', m === thisMonth());
    if (chipNext) chipNext.classList.toggle('active', m === nextMonth());
    render();
  }

  function init() {
    initialized = true;

    $('lead-add-btn').addEventListener('click', addLead);
    $('lead-search').addEventListener('input', (e) => {
      searchQuery = e.target.value.trim();
      render();
    });
    $('lead-month').addEventListener('change', (e) => setMonth(e.target.value));
    // Quick chips toggle: click again to go back to All months.
    $('lead-due-this').addEventListener('click', () => setMonth(activeMonth === thisMonth() ? 'all' : thisMonth()));
    $('lead-due-next').addEventListener('click', () => setMonth(activeMonth === nextMonth() ? 'all' : nextMonth()));
    document.querySelectorAll('.lead-tab').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.lead-tab').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        activeStage = btn.dataset.stage;
        render();
      });
    });
    $('lead-list').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-action]');
      if (btn) onAction(btn.dataset.action, btn.dataset.id);
    });
    // WP4.2: "Search all months" escape hatch in the no-results state.
    $('leads-empty').addEventListener('click', (e) => {
      if (e.target.closest('#leads-empty-all-btn')) setMonth('all');
    });
    // WP4.1: lead checkboxes are re-rendered with their cards — delegate the
    // change from the list container (bound once here).
    $('lead-list').addEventListener('change', (e) => {
      const box = e.target.closest('input.lead-check[data-check]');
      if (!box) return;
      const id = box.dataset.check;
      if (box.checked) {
        if (selected.size >= SEND_CAP) {
          box.checked = false;
          warnSendCap();
          return;
        }
        selected.add(id);
      } else {
        selected.delete(id);
      }
      // WP4.3: a check/uncheck changes the card's LIST POSITION (checked
      // leads float to the top; unchecked drop back into place), so every
      // toggle is a full render now — rebuilding the just-clicked box is
      // fine, the click has already been processed. This also keeps the
      // "Show selected" view honest (an unchecked card leaves it).
      render();
    });
    // The selection controls live inside the cohort summary, which is rebuilt
    // every render — delegate from the container (bound once here).
    $('lead-month-summary').addEventListener('click', (e) => {
      if (e.target.closest('#lead-send-invites-btn')) sendInvites();
      else if (e.target.closest('#lead-select-next-btn')) selectNext();
      else if (e.target.closest('#lead-clear-sel-btn')) {
        selected = new Set();
        showSelectedOnly = false;
        render();
      } else if (e.target.closest('#lead-followup-chip')) {
        showFollowUpOnly = !showFollowUpOnly;
        if (showFollowUpOnly) showSelectedOnly = false; // mutually exclusive
        render();
      } else if (e.target.closest('#lead-show-sel-chip')) {
        showSelectedOnly = !showSelectedOnly;
        if (showSelectedOnly) showFollowUpOnly = false; // mutually exclusive
        render();
      }
    });
    $('lead-month-summary').addEventListener('input', (e) => {
      if (e.target.id !== 'lead-batch-size') return;
      const v = Math.floor(Number(e.target.value));
      if (Number.isFinite(v) && v >= 1) batchSize = Math.min(v, SEND_CAP);
      const btn = $('lead-select-next-btn');
      if (btn && !sendingInvites) btn.textContent = `Select next ${batchSize}`;
    });

    // WP4.2: land on the current month's cohort so the checkboxes and Send
    // controls are immediately there — the "why can't I select anything"
    // fix. setMonth renders; Amy can switch to All or any month freely.
    setMonth(thisMonth());
    if (!haveData) loadLeads();
  }

  window.BatesLeads = { init, prime, refresh: loadLeads };
})();
