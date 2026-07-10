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

  // State
  let leads = [];          // full list from GET /leads, newest first
  let haveData = false;    // first fetch has landed
  let initialized = false; // init() ran (view markup is live)
  let inflight = null;     // de-dupes prime() vs first init() fetch
  let activeStage = 'all';
  let searchQuery = '';

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
    actions.push(`<button type="button" class="btn btn-secondary btn-sm" data-action="note" data-id="${escapeHtml(l.id)}">${l.notes ? 'Edit note' : 'Add note'}</button>`);
    if (l.status !== 'converted' && l.status !== 'lost') {
      actions.push(`<button type="button" class="btn btn-secondary btn-sm" data-action="lost" data-id="${escapeHtml(l.id)}">Mark lost</button>`);
    }
    if (l.status === 'lost') {
      actions.push(`<button type="button" class="btn btn-secondary btn-sm" data-action="reopen" data-id="${escapeHtml(l.id)}">Reopen</button>`);
    }

    return `<div class="lead-card s-${escapeHtml(l.status)}">
      <div class="lead-top">
        <span class="lead-name">${escapeHtml(l.customer_name || l.customer_email || l.customer_phone || 'Unnamed lead')}</span>
        <span class="badge ${stage.badge}">${escapeHtml(stage.label)}</span>
        <span class="chip${source.chip ? ' ' + source.chip : ''}">${escapeHtml(source.label)}</span>
      </div>
      ${contactBits.length ? `<div class="lead-meta">${contactBits.join('')}</div>` : ''}
      ${l.generator_info ? `<div class="lead-gen">${escapeHtml(l.generator_info)}</div>` : ''}
      ${l.notes ? `<div class="lead-note">${escapeHtml(l.notes)}</div>` : ''}
      <div class="lead-from">${l.referred_by_label ? `From: ${escapeHtml(l.referred_by_label)} &middot; ` : ''}Added ${fmtDate(l.created_at)}</div>
      <div class="lead-actions">${actions.join('')}</div>
    </div>`;
  }

  function render() {
    const listEl = $('lead-list');
    const emptyEl = $('leads-empty');
    const loadingEl = $('leads-loading');
    if (!listEl) return;
    loadingEl.hidden = haveData;
    if (!haveData) return;

    // Pill counts always reflect the search-filtered set.
    const searched = leads.filter(matchesSearch);
    $('lead-count-all').textContent = String(searched.length);
    for (const s of STAGE_ORDER) {
      const el = $(`lead-count-${s}`);
      if (el) el.textContent = String(searched.filter((l) => l.status === s).length);
    }

    const visible = activeStage === 'all' ? searched : searched.filter((l) => l.status === activeStage);
    emptyEl.hidden = visible.length > 0;
    // Two flavors of empty: a brand-new pipeline vs an empty filter result.
    if (!visible.length) {
      const virgin = leads.length === 0;
      $('leads-empty-title').textContent = virgin ? 'No leads yet' : 'No matching leads';
      $('leads-empty-sub').innerHTML = virgin
        ? 'Every prospective Generator Care customer lands here &mdash; field enrollments, referrals, and campaign responses once those channels launch. Use <strong>Add lead</strong> to log one the office hears about today, then work it left to right: New &rarr; Contacted &rarr; Signup sent &rarr; Converted.'
        : 'Try a different stage or search.';
      listEl.innerHTML = '';
      return;
    }

    if (activeStage === 'all') {
      // Grouped by stage, working order — same group-heading treatment as the
      // Needs Attention queue.
      listEl.innerHTML = STAGE_ORDER.map((s) => {
        const group = visible.filter((l) => l.status === s);
        if (!group.length) return '';
        return `<div class="gc-att-group-h">${escapeHtml(STAGES[s].label)} <span class="count">${group.length}</span></div>`
          + group.map(leadCardHtml).join('');
      }).join('');
    } else {
      listEl.innerHTML = visible.map(leadCardHtml).join('');
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
    }
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
        { name: 'customer_name', label: 'Name', placeholder: 'Jane Doe' },
        { name: 'customer_phone', label: 'Phone', type: 'tel', inputmode: 'tel', placeholder: '(314) 555-0123' },
        { name: 'customer_email', label: 'Email', type: 'email', placeholder: 'jane@example.com' },
        { name: 'install_address', label: 'Street address', placeholder: '123 Main St' },
        { name: 'install_city', label: 'City' },
        { name: 'install_state', label: 'State', placeholder: 'MO', hint: '2-letter code' },
        { name: 'install_zip', label: 'ZIP', inputmode: 'numeric' },
        { name: 'generator_info', label: 'Generator info', type: 'textarea', placeholder: 'Make / model / anything the tech jotted down' },
        { name: 'referred_by_label', label: 'Who sent this?', placeholder: 'e.g. tech name, "Referral: John Smith"', hint: 'Shown on the lead so provenance never gets lost' },
        { name: 'notes', label: 'Notes', type: 'textarea' },
      ],
      validate: (v) => {
        if (!v.customer_name.trim() && !v.customer_email.trim() && !v.customer_phone.trim()) {
          return 'Enter at least a name, email, or phone.';
        }
        if (v.customer_email.trim() && !/^\S+@\S+\.\S+$/.test(v.customer_email.trim())) {
          return 'That email doesn\u2019t look right.';
        }
        if (v.install_state.trim() && !/^[A-Za-z]{2}$/.test(v.install_state.trim())) {
          return 'State should be the 2-letter code (e.g. MO).';
        }
        return null;
      },
      confirmText: 'Add lead',
    });
    if (vals === null) return;
    if (vals.install_state) vals.install_state = vals.install_state.toUpperCase();
    try {
      const { lead } = await api('/leads', { method: 'POST', body: JSON.stringify({ ...vals, source: 'manual' }) });
      updateLocal(lead);
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

  function init() {
    initialized = true;

    $('lead-add-btn').addEventListener('click', addLead);
    $('lead-search').addEventListener('input', (e) => {
      searchQuery = e.target.value.trim();
      render();
    });
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

    if (haveData) render();
    else loadLeads();
  }

  window.BatesLeads = { init, prime, refresh: loadLeads };
})();
