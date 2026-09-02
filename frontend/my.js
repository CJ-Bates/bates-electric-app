// my.js — Generator Care customer portal (my.html).
//
// Customer-facing, magic-link (Supabase OTP) auth. Deliberately does NOT load
// shared-nav.js / app.js (staff-only) and does NOT register the service
// worker. Session tokens live under the customer-only sessionStorage keys
// bates.my.token / bates.my.refresh — never the staff portal's storage keys.
// Theme persists under its own key too (bates.my.theme).
(function () {
  'use strict';

  const API_BASE = (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
    ? 'http://localhost:4000'
    : 'https://bates-electric-app.onrender.com';

  const TOKEN_KEY = 'bates.my.token';
  const REFRESH_KEY = 'bates.my.refresh';
  const THEME_KEY = 'bates.my.theme';

  const esc = (s) => window.BatesUI.escapeHtml(s);
  const $ = (id) => document.getElementById(id);

  // Latest overview payload — the single source every render reads from.
  let overview = null;
  // Live-Stripe billing (renewal, pending change, receipts) loads SEPARATELY
  // from the fast overview so it never blocks first paint.
  let billingState = 'loading'; // 'loading' | 'done' | 'failed'
  // The add-on MENU (Phase 2) loads alongside the overview from
  // /api/my/addon-menu. 'failed' (including a backend without the endpoint
  // yet) falls back to the pre-menu pending/standing view in renderAddons.
  let addonMenu = null;
  let menuState = 'loading'; // 'loading' | 'done' | 'failed'
  // Whether the hero's appointment-preferences form is expanded.
  let prefsFormOpen = false;

  // ---------------------------------------------------------------------------
  // Magic-link landing: Supabase redirects back with tokens in the hash
  // (#access_token=...&refresh_token=...&type=magiclink). Accept any hash that
  // carries an access_token, stash the tokens, and strip the hash from the URL.
  // ---------------------------------------------------------------------------
  (function handleHashLanding() {
    const hash = (location.hash || '').replace(/^#/, '');
    if (!hash) return;
    const params = new URLSearchParams(hash);
    const accessToken = params.get('access_token');
    if (!accessToken) return;
    try {
      sessionStorage.setItem(TOKEN_KEY, accessToken);
      const refreshToken = params.get('refresh_token');
      if (refreshToken) sessionStorage.setItem(REFRESH_KEY, refreshToken);
    } catch (e) { /* storage unavailable — the load below will land on sign-in */ }
    history.replaceState(null, '', location.pathname + location.search);
  })();

  // ---------------------------------------------------------------------------
  // Formatting helpers
  // ---------------------------------------------------------------------------
  function money(cents) {
    if (cents == null || isNaN(cents)) return '—';
    return '$' + (cents / 100).toFixed(2);
  }

  // 'YYYY-MM-DD' (parsed as LOCAL date, not UTC) or an ISO timestamp -> 'Aug 3, 2026'
  function fmtDate(value) {
    if (!value) return '';
    let d;
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
      const parts = String(value).split('-').map(Number);
      d = new Date(parts[0], parts[1] - 1, parts[2]);
    } else {
      d = new Date(value);
    }
    if (isNaN(d.getTime())) return String(value);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  // ISO timestamp -> 'Monday, Aug 3 · 7:00 AM'. Legacy fallback only — booked
  // visits display via fmtArrival (date + arrival window, never a clock time).
  function fmtAppointment(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    const day = d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
    const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    return day + ' · ' + time;
  }

  // Booked visit -> 'Monday, Aug 3 · 8:00–10:00 AM arrival' when it has an
  // arrival window (the 2-hour window we actually schedule in); visits booked
  // before the window change fall back to the stored time.
  function fmtArrival(iso, windowCode) {
    const w = window.BatesArrivalWindows.byCode[windowCode];
    if (!w) return fmtAppointment(iso);
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    return d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })
      + ' · ' + w.label + ' arrival';
  }

  const GEN_CLASS_LABELS = {
    air_cooled: 'Air Cooled (7–28 kW)',
    liquid_22_38: 'Liquid Cooled (22–45 kW)',
    liquid_48_150: 'Liquid Cooled (48–150 kW)',
  };
  const GEN_CLASS_SHORT = {
    air_cooled: 'Air Cooled',
    liquid_22_38: 'Liquid Cooled',
    liquid_48_150: 'Liquid Cooled',
  };

  function planLabelFull(plan) {
    return plan === 'semi_annual' ? 'Semi-Annual (2 visits/yr)' : 'Annual (1 visit/yr)';
  }
  function planLabelShort(plan) {
    return plan === 'semi_annual' ? 'Semi-Annual plan' : 'Annual plan';
  }

  // ---------------------------------------------------------------------------
  // Views
  // ---------------------------------------------------------------------------
  // Shown during every normal load (also the static first-paint copy in
  // my.html); showLoadFailure swaps it for the error text.
  var LOADING_COPY = 'Loading your dashboard…';

  function showView(name) {
    $('view-signin').hidden = name !== 'signin';
    $('view-loading').hidden = name !== 'loading';
    $('view-dash').hidden = name !== 'dash';
    $('signout-btn').hidden = name === 'signin';
    if (name === 'loading') {
      // Skeleton + reassuring copy while loading; only retry waits for an
      // actual failure. Reset the message — a retry re-enters here with the
      // failure text still in place.
      $('loading-skel').hidden = false;
      $('loading-msg').hidden = false;
      $('loading-msg').textContent = LOADING_COPY;
      $('retry-btn').hidden = true;
    }
  }

  // Flip the loading view from skeletons to a failure message + retry.
  function showLoadFailure(message) {
    showView('loading');
    $('loading-skel').hidden = true;
    $('loading-msg').hidden = false;
    $('loading-msg').textContent = message;
    $('retry-btn').hidden = false;
  }

  function clearMyKeys() {
    try {
      sessionStorage.removeItem(TOKEN_KEY);
      sessionStorage.removeItem(REFRESH_KEY);
    } catch (e) { /* ignore */ }
  }

  // Confirm first (shared inline dialog) — a stray tap on the topbar button
  // used to sign the customer out instantly. sessionExpired() stays instant.
  function signOut() {
    const confirmed = (typeof window.openConfirm === 'function')
      ? window.openConfirm({ title: 'Sign out of Bates Electric?', confirmText: 'Sign out', cancelText: 'Cancel' })
      : Promise.resolve(true);
    confirmed.then(function (ok) {
      if (!ok) return;
      clearMyKeys();
      overview = null;
      showView('signin');
    });
  }

  function sessionExpired() {
    clearMyKeys();
    overview = null;
    showView('signin');
    showStatus('Your session expired — request a new link.', 'info');
  }

  // ---------------------------------------------------------------------------
  // Config (/config → supabaseUrl + anon key), cached.
  // ---------------------------------------------------------------------------
  let configPromise = null;
  function getConfig() {
    if (!configPromise) {
      configPromise = fetch(API_BASE + '/config')
        .then((r) => { if (!r.ok) throw new Error('config'); return r.json(); })
        .catch((err) => { configPromise = null; throw err; });
    }
    return configPromise;
  }

  // ---------------------------------------------------------------------------
  // Auth plumbing
  // ---------------------------------------------------------------------------
  let refreshPromise = null;
  function tryRefresh() {
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
      const refreshToken = sessionStorage.getItem(REFRESH_KEY);
      if (!refreshToken) return false;
      try {
        const res = await fetch(API_BASE + '/auth/refresh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh_token: refreshToken }),
        });
        if (!res.ok) return false;
        const data = await res.json().catch(() => ({}));
        if (!data.token) return false;
        sessionStorage.setItem(TOKEN_KEY, data.token);
        if (data.refresh_token) sessionStorage.setItem(REFRESH_KEY, data.refresh_token);
        return true;
      } catch (e) {
        return false;
      }
    })();
    return refreshPromise.then((ok) => { refreshPromise = null; return ok; });
  }

  // Attach Bearer; on 401 refresh ONCE and retry; still 401 → back to sign-in.
  async function authFetch(url, opts) {
    opts = opts || {};
    const run = () => {
      const headers = Object.assign({}, opts.headers || {});
      const token = sessionStorage.getItem(TOKEN_KEY);
      if (token) headers.Authorization = 'Bearer ' + token;
      return fetch(url, Object.assign({}, opts, { headers }));
    };
    let res = await run();
    if (res.status === 401) {
      const refreshed = await tryRefresh();
      if (refreshed) res = await run();
      if (!refreshed || res.status === 401) {
        sessionExpired();
        const err = new Error('session-expired');
        err.expired = true;
        throw err;
      }
    }
    return res;
  }

  // JSON convenience wrapper over authFetch — throws Error(message) on { error }.
  async function api(path, opts) {
    const res = await authFetch(API_BASE + path, opts);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error(body.error || 'Something went wrong — please try again.');
      err.status = res.status;
      err.api = true;
      throw err;
    }
    return body;
  }

  // Surface an action error as a toast (silently swallow the expired-session
  // path — sessionExpired already showed its own message).
  function surface(err) {
    if (err && err.expired) return;
    showStatus((err && err.message) || 'Something went wrong — please try again.', 'error');
  }

  // Must-see version, for outcomes the customer cannot afford to miss: a
  // request or receipt that did NOT go out, a cancel that did NOT happen.
  // Dismissed by the customer, with what to do next.
  function surfaceMustSee(err, title, next) {
    if (err && err.expired) return;
    return openAlert({ title, message: (err && err.message) || 'Something went wrong.', next, danger: true });
  }

  // ---------------------------------------------------------------------------
  // Sign-in: request a magic link via Supabase OTP. Response is IGNORED on
  // purpose — success, 4xx, or network error all show the same neutral message
  // so the form can't be used to test which emails have accounts.
  // ---------------------------------------------------------------------------
  async function requestLink(email) {
    const btn = $('signin-btn');
    btn.disabled = true;
    setTimeout(() => { btn.disabled = false; }, 30000);
    try {
      const cfg = await getConfig();
      const redirect = encodeURIComponent(location.origin + location.pathname);
      await fetch(cfg.supabaseUrl + '/auth/v1/otp?redirect_to=' + redirect, {
        method: 'POST',
        headers: { apikey: cfg.supabaseAnonKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email, create_user: true }),
      });
    } catch (e) { /* same neutral message regardless */ }
    $('signin-sent').classList.add('show');
  }

  // ---------------------------------------------------------------------------
  // Overview load + render
  // ---------------------------------------------------------------------------
  async function loadOverview(quiet) {
    if (!quiet) showView('loading');
    billingState = 'loading';
    menuState = 'loading';
    prefsFormOpen = false;
    // All three requests go out together: /overview (our DB — fast) paints the
    // page; /billing (live Stripe) fills the renewal line + receipts when it
    // lands; /addon-menu fills the services card. A hiccup in either side
    // request degrades its section, never the page.
    const billingPromise = api('/api/my/billing').then(
      (r) => ({ ok: true, r }),
      (err) => ({ ok: false, err })
    );
    const menuPromise = api('/api/my/addon-menu').then(
      (r) => ({ ok: true, r }),
      (err) => ({ ok: false, err })
    );
    try {
      overview = await api('/api/my/overview');
      render(overview);
      showView('dash');
    } catch (err) {
      if (err && err.expired) return;
      if (err && err.status === 403) {
        // Signed in, but the email isn't linked to a Generator Care plan.
        clearMyKeys();
        showView('signin');
        showStatus(err.message, 'error');
        return;
      }
      if (quiet && overview) { surface(err); return; }
      showLoadFailure('We couldn’t load your dashboard.');
      surface(err);
      return;
    }
    const b = await billingPromise;
    if (b.ok) {
      billingState = 'done';
      overview.plan.billing = (b.r && b.r.billing) || null;
      overview.invoices = (b.r && b.r.invoices) || [];
    } else {
      if (b.err && b.err.expired) return;
      billingState = 'failed';
      overview.invoices = [];
    }
    renderPlan(overview.plan);
    renderReceipts(overview.invoices || []);
    renderCancelCard(overview.plan);

    const m = await menuPromise;
    if (m.ok && m.r && m.r.menu) {
      menuState = 'done';
      addonMenu = m.r;
    } else {
      if (m.err && m.err.expired) return;
      menuState = 'failed';
      addonMenu = null;
    }
    renderAddons(overview.addons || {});
  }

  function applyBranding(branding) {
    const fl = !!(branding && branding.is_florida);
    $('brand-name').textContent = fl ? 'S.E. BATES ELECTRIC' : 'BATES ELECTRIC';
    const logo = fl ? 'se-bates-electric-logo.jpg' : 'logo-icon.png?v=7';
    $('brand-logo').src = logo;
    $('signin-logo').src = logo;
    const alt = fl ? 'S.E. Bates Electric' : 'Bates Electric';
    $('brand-logo').alt = alt;
    $('signin-logo').alt = alt;
    $('foot-company').textContent = ((branding && branding.company_name) || 'Bates Electric') + ', Inc.';
  }

  function render(o) {
    applyBranding(o.branding);
    renderHello(o);
    renderHero(o.next_visit);
    renderGenerator(o);
    renderVisits(o.visits || []);
    renderPlan(o.plan);
    renderSmsCard(o.sms, o.customer);
    renderAddons(o.addons || {});
    renderReceipts(o.invoices || []);
    renderCancelCard(o.plan);
  }

  function renderHello(o) {
    const hour = new Date().getHours();
    const part = hour < 12 ? 'morning' : (hour < 17 ? 'afternoon' : 'evening');
    const first = ((o.customer && o.customer.name) || '').trim().split(/\s+/)[0] || 'there';
    $('hello').textContent = 'Good ' + part + ', ' + first;

    const genLabel = (o.generator && (o.generator.type_label || GEN_CLASS_SHORT[o.generator.gen_class])) || 'Your';
    const bits = [];
    if (o.customer && o.customer.install_address) {
      bits.push(o.customer.install_address + (o.customer.install_city ? ', ' + o.customer.install_city : ''));
    }
    $('sub').textContent = (bits.length ? bits[0] + ' — ' : '')
      + genLabel + ' generator · ' + planLabelShort(o.plan && o.plan.plan);
  }

  // ---------------------------------------------------------------------------
  // Appointment texts (SMS Phase 1). The card only appears when a usable
  // mobile number is on file (the API decides — sms.available); the checkbox
  // mirrors the stored consent state and each flip writes a consent row
  // server-side. The label text MIRRORS the backend CONSENT_TEXT — the exact
  // language is the legal record, edit both together.
  // ---------------------------------------------------------------------------
  function renderSmsCard(sms, customer) {
    const card = $('sms-card');
    if (!card) return;
    if (!sms || !sms.available) { card.hidden = true; return; }
    card.hidden = false;
    $('sms-phone-line').textContent = 'We’ll text ' + ((customer && customer.phone) || 'your number on file') + ' about upcoming visits.';
    $('sms-toggle').checked = !!sms.opted_in;
  }

  async function onSmsToggle(e) {
    const box = e.target;
    const optIn = !!box.checked;
    box.disabled = true;
    try {
      const r = await api('/api/my/sms-consent', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ opt_in: optIn }),
      });
      if (overview) overview.sms = { available: true, opted_in: !!r.opted_in };
      showStatus(optIn
        ? 'You’re signed up for appointment texts.'
        : 'Appointment texts are turned off.', 'success');
    } catch (err) {
      box.checked = !optIn; // revert — the server didn't take it
      surface(err);
    } finally {
      box.disabled = false;
    }
  }

  function renderHero(nextVisit) {
    const card = $('hero-card');
    const prefs = $('hero-prefs');
    if (!nextVisit || (!nextVisit.appointment_at && !nextVisit.due_date)) {
      card.hidden = true;
      return;
    }
    card.hidden = false;
    if (nextVisit.appointment_at) {
      // Booked: the confirmed arrival window owns the hero; preferences are done.
      const win = window.BatesArrivalWindows.byCode[nextVisit.arrival_window];
      $('hero-k').textContent = 'Next service visit';
      $('hero-when').textContent = fmtArrival(nextVisit.appointment_at, nextVisit.arrival_window);
      $('hero-who').textContent = win
        ? 'Our technician will arrive between ' + win.label.replace('–', ' and ') + '. We’ll confirm the day before.'
        : 'Regular maintenance service — we’ll confirm the day before.';
      $('btn-calendar').hidden = false;
      $('btn-reschedule').hidden = false;
      prefs.hidden = true;
      prefs.innerHTML = '';
    } else {
      // Not booked yet: the customer proposes times; the office confirms
      // (typically about two weeks before the due date).
      $('hero-k').textContent = 'Next service visit — to be scheduled';
      $('hero-when').textContent = 'Due ' + fmtDate(nextVisit.due_date);
      $('hero-who').textContent = 'Pick times that work for you below, or we’ll call to schedule.';
      $('btn-calendar').hidden = true;
      $('btn-reschedule').hidden = true;
      prefs.hidden = false;
      renderHeroPrefs(nextVisit);
    }
  }

  // ---------------------------------------------------------------------------
  // Appointment preferences (hero, unscheduled visits only). The customer
  // proposes date + arrival-window slots from the SAME shared window list the
  // office books from (frontend/arrival-windows.js), so a proposed slot maps
  // 1:1 to a bookable appointment.
  // ---------------------------------------------------------------------------
  const PREFS_RECEIVED_COPY = 'Preferences received — we’ll confirm your appointment, typically about two weeks before it’s due.';

  // Shared labels; also covers legacy AM/PM slots submitted before the change.
  function windowLabel(w) { return window.BatesArrivalWindows.label(w); }

  function tomorrowStr() {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function renderHeroPrefs(nv) {
    if (!nv) return;
    const el = $('hero-prefs');
    const p = nv.preferences;
    if (prefsFormOpen) {
      const existing = (p && p.slots) || [];
      // Pre-select each row's saved window; legacy AM/PM slots (submitted
      // before the arrival-window change) map to the closest window.
      const LEGACY_MAP = { AM: '8-10', PM: '12-2' };
      const rows = [0, 1, 2].map((i) => {
        const s = existing[i] || {};
        const sel = window.BatesArrivalWindows.byCode[s.window]
          ? s.window
          : (LEGACY_MAP[s.window] || window.BatesArrivalWindows.WINDOWS[0].code);
        const opts = window.BatesArrivalWindows.WINDOWS.map((w) =>
          '<option value="' + esc(w.code) + '"' + (sel === w.code ? ' selected' : '') + '>' + esc(w.label) + '</option>').join('');
        return '<div class="pref-row">'
          + '<input type="date" data-pref-date min="' + tomorrowStr() + '" value="' + esc(s.date || '') + '" aria-label="Preferred date ' + (i + 1) + '">'
          + '<select data-pref-window aria-label="Arrival window ' + (i + 1) + '">'
          + opts
          + '</select></div>';
      }).join('');
      el.innerHTML = '<div class="pref-form">'
        + '<label>Preferred dates &amp; arrival windows — up to three</label>'
        + rows
        + '<textarea data-pref-note rows="2" placeholder="Anything else? Gate code, best number to reach you… (optional)">' + esc((p && p.note) || '') + '</textarea>'
        + '<div class="row"><button class="btn btn-onhero" data-action="prefs-submit">Send preferences</button>'
        + '<button class="btn btn-onhero" data-action="prefs-cancel">Cancel</button></div>'
        + '</div>';
      return;
    }
    if (p && p.slots && p.slots.length) {
      el.innerHTML = '<div class="pref-list"><b>Your preferred arrival windows</b><br>'
        + p.slots.map((s, i) => (i + 1) + ') ' + esc(fmtDate(s.date)) + ' · ' + esc(windowLabel(s.window))).join('<br>')
        + '</div>'
        + '<div class="pref-copy">' + esc(PREFS_RECEIVED_COPY) + ' You can change them until we confirm.</div>'
        + '<div class="row" style="margin-top:10px"><button class="btn btn-onhero" data-action="prefs-open">Change preferences</button></div>';
    } else {
      el.innerHTML = '<div class="pref-copy">Tell us up to three dates and arrival windows that work for you — we’ll confirm your appointment, typically about two weeks before it’s due.</div>'
        + '<div class="row" style="margin-top:10px"><button class="btn btn-onhero" data-action="prefs-open">Pick your preferred times</button></div>';
    }
  }

  async function onPrefsSubmit(btn) {
    const form = $('hero-prefs');
    const dates = Array.prototype.slice.call(form.querySelectorAll('[data-pref-date]'));
    const windows = Array.prototype.slice.call(form.querySelectorAll('[data-pref-window]'));
    const slots = [];
    for (let i = 0; i < dates.length; i++) {
      const date = (dates[i].value || '').trim();
      if (!date) continue;
      slots.push({ date, window: windows[i] ? windows[i].value : window.BatesArrivalWindows.WINDOWS[0].code });
    }
    if (!slots.length) {
      showStatus('Pick at least one preferred date.', 'warning');
      return;
    }
    const noteEl = form.querySelector('[data-pref-note]');
    btn.disabled = true;
    try {
      const r = await api('/api/my/visit-preferences', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slots, note: (noteEl && noteEl.value) || '' }),
      });
      if (overview && overview.next_visit) overview.next_visit.preferences = r.preferences;
      prefsFormOpen = false;
      renderHero(overview && overview.next_visit);
      showStatus(PREFS_RECEIVED_COPY, 'success');
    } catch (err) {
      btn.disabled = false;
      surface(err);
    }
  }

  function renderGenerator(o) {
    const g = o.generator || {};
    const c = o.customer || {};
    const address = [c.install_address, c.install_city, c.install_state].filter(Boolean).join(', ');
    const rows = [
      ['Type', g.type_label || GEN_CLASS_LABELS[g.gen_class] || g.gen_class || '—'],
      ['Model', g.model || '—'],
      ['Serial', g.serial || '—'],
      ['Service address', address || '—'],
    ];
    $('gen-kv').innerHTML = rows.map(([k, v]) =>
      '<div class="kv"><span class="k">' + esc(k) + '</span><span class="v">' + esc(v) + '</span></div>').join('');
  }

  const CHECK_SVG = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12.5 9.5 18 20 6.5"/></svg>';

  function visitRowHtml(v) {
    if (v.status === 'completed') {
      // Itemize the visit: the services the tech checked off (or, for legacy
      // visits with no checklist, the static plan list), add-on services
      // performed that day, then the tech's notes and photos. Only CHECKED
      // services are ever listed — an unchecked item is simply absent, never
      // shown as "not done". On-demand visits skip the static fallback — it's
      // the PLAN visits that include the full service list.
      const checked = (v.completed_services && v.completed_services.length) ? v.completed_services : null;
      const items = checked || (v.is_plan_visit ? ((overview && overview.plan && overview.plan.visit_items) || []) : []);
      const planBlock = items.length
        ? '<div class="plan-items"><b>' + (checked ? 'Services completed this visit' : 'Included in your plan') + '</b><ul>'
          + items.map((it) => '<li>' + CHECK_SVG + '<span>' + esc(it) + '</span></li>').join('')
          + '</ul></div>'
        : '';
      const addonsBlock = (v.performed_addons && v.performed_addons.length)
        ? '<div class="plan-items"><b>Add-on services this visit</b><ul>'
          + v.performed_addons.map((a) =>
              '<li class="addon">' + CHECK_SVG + '<span>' + esc(a.label) + ' — performed</span></li>').join('')
          + '</ul></div>'
        : '';
      const note = v.notes
        ? '<div class="note"><b>Technician notes</b>' + esc(v.notes) + '</div>'
        : '';
      const photos = (v.photos && v.photos.length)
        ? '<div class="photos">' + v.photos.map((url, i) =>
            '<button type="button" class="ph-btn" data-action="open-photo" data-visit="' + esc(v.id) + '" data-idx="' + i + '" aria-label="View photo ' + (i + 1) + '"><img src="' + esc(url) + '" alt="Visit photo" loading="lazy"></button>').join('') + '</div>'
        : '';
      return '<div class="visit">'
        + '<div class="head"><span class="date">' + esc(fmtDate(v.completed_date)) + '</span><span class="badge badge-neutral">Completed</span></div>'
        + planBlock + addonsBlock + note + photos
        + '</div>';
    }
    // scheduled / upcoming
    const scheduled = v.status === 'scheduled' && v.appointment_at;
    const win = scheduled && window.BatesArrivalWindows.byCode[v.arrival_window];
    const dateLabel = scheduled
      ? fmtDate(v.appointment_at) + (win ? ' · ' + win.label + ' arrival' : ' · upcoming')
      : (v.due_date ? 'Due ' + fmtDate(v.due_date) : 'Upcoming visit');
    const badge = scheduled
      ? '<span class="badge badge-info">Scheduled</span>'
      : '<span class="badge badge-warn">To be scheduled</span>';
    return '<div class="visit">'
      + '<div class="head"><span class="date">' + esc(dateLabel) + '</span>' + badge + '</div>'
      + '<div class="desc">Regular maintenance — oil &amp; filter, battery check, transfer test.</div>'
      + '</div>';
  }

  function renderVisits(visits) {
    const el = $('visits');
    if (!visits.length) {
      el.innerHTML = '<p class="hint" style="margin:0">No visits yet — your first service will appear here.</p>';
      return;
    }
    // Open visits first (soonest first), then completed newest-first.
    const open = visits.filter((v) => v.status !== 'completed');
    open.sort((a, b) => String(a.appointment_at || a.due_date || '9999')
      .localeCompare(String(b.appointment_at || b.due_date || '9999')));
    const done = visits.filter((v) => v.status === 'completed');
    done.sort((a, b) => String(b.completed_date || '').localeCompare(String(a.completed_date || '')));

    const recentDone = done.slice(0, 6);
    const olderDone = done.slice(6);
    let html = open.map(visitRowHtml).join('') + recentDone.map(visitRowHtml).join('');
    if (olderDone.length) {
      html += '<div id="older-visits" hidden>' + olderDone.map(visitRowHtml).join('') + '</div>'
        + '<div class="row" style="margin-top:12px"><button class="btn btn-ghost" data-action="show-older">Show older visits</button></div>';
    }
    el.innerHTML = html;
  }

  function planStatusBadge(status) {
    if (status === 'active') return '<span class="badge badge-ok">Active</span>';
    if (status === 'past_due') return '<span class="badge badge-warn">Past due</span>';
    if (status === 'canceled') return '<span class="badge badge-neutral">Canceled</span>';
    return '<span class="badge badge-neutral">' + esc(status || '—') + '</span>';
  }

  function planIsEnding(plan) {
    return !!(plan && (plan.status === 'canceled' || (plan.billing && plan.billing.cancel_at_period_end)));
  }

  function serviceThroughDate(plan) {
    return (plan && plan.service_through)
      || (plan && plan.billing && plan.billing.current_period_end)
      || null;
  }

  function renderPlan(plan) {
    plan = plan || {};
    const billing = plan.billing;
    const ending = planIsEnding(plan);

    const rows = [];
    rows.push(['Plan', esc(plan.label || '—')]);
    if (ending) {
      const through = serviceThroughDate(plan);
      rows.push(['Service through', esc(through ? fmtDate(through) : '—')]);
    } else if (billing && billing.current_period_end) {
      rows.push(['Renews', esc(fmtDate(billing.current_period_end)
        + (billing.current_renewal_amount_cents != null ? ' · ' + money(billing.current_renewal_amount_cents) : ''))]);
    } else if (billingState === 'loading') {
      // Billing is still on its way from Stripe — hold the row with a skeleton.
      rows.push(['Renews', '<span class="skel" style="margin:0;height:12px;display:inline-block;width:140px"></span>']);
    }
    rows.push(['Status', planStatusBadge(plan.status)]);
    $('plan-kv').innerHTML = rows.map(([k, v]) =>
      '<div class="kv"><span class="k">' + esc(k) + '</span><span class="v">' + v + '</span></div>').join('');

    // Pending plan change → info line, and no switch button.
    const pending = billing && billing.pending_change;
    const pendingEl = $('plan-pending');
    if (pending && pending.new_plan) {
      pendingEl.hidden = false;
      pendingEl.innerHTML = '<span class="badge badge-info">Switching to ' + esc(planLabelFull(pending.new_plan))
        + (pending.effective_date ? ' on ' + esc(fmtDate(pending.effective_date)) : '') + '</span>';
    } else {
      pendingEl.hidden = true;
      pendingEl.innerHTML = '';
    }

    const switchBtn = $('btn-switch');
    if (ending || pending) {
      switchBtn.hidden = true;
    } else {
      switchBtn.hidden = false;
      switchBtn.textContent = 'Switch to ' + planLabelFull(plan.other_plan);
    }

    $('plan-hint').textContent = (ending || pending)
      ? 'Card & billing opens our secure Stripe portal.'
      : 'Plan changes take effect at your renewal — no charge today. Card & billing opens our secure Stripe portal.';
  }

  // One menu row: label + friendly status chip + price line + the action that
  // fits its state. Internal statuses stay internal — the customer-facing
  // wording maps not_in_plan/every_visit/this_visit/performed/charged to
  // Not added / On every visit / Added this visit / Done / Charged.
  function addonMenuRow(m, canceled) {
    const price = money(m.amount_cents);
    let badge, meta = '', actions = '';
    if (m.status === 'charged') {
      badge = '<span class="badge badge-neutral">Charged</span>';
      meta = price + ' · charged for this visit';
    } else if (m.status === 'performed') {
      badge = '<span class="badge badge-neutral">Done</span>';
      meta = price + ' · performed — will be billed';
    } else if (m.status === 'every_visit') {
      badge = '<span class="badge badge-info">On every visit</span>';
      meta = price + ' each visit it’s performed'
        + ' &nbsp;·&nbsp; <a href="#" class="link-danger" data-action="standing-off" data-type="' + esc(m.addon_type) + '" data-label="' + esc(m.label) + '">Remove</a>';
    } else if (m.status === 'this_visit') {
      badge = '<span class="badge badge-info">Added this visit</span>';
      meta = price + ' · billed only when performed';
      if (m.addon_id) {
        meta += ' &nbsp;·&nbsp; <a href="#" class="link-danger" data-action="remove-addon" data-id="' + esc(m.addon_id) + '" data-label="' + esc(m.label) + '">Remove</a>';
      }
    } else { // not_in_plan
      badge = '<span class="badge badge-neutral">Not added</span>';
      meta = price + ' · billed only after it’s performed';
      if (!canceled) {
        const btn = 'class="btn btn-secondary" style="padding:5px 12px;font-size:13px"';
        actions = '<div class="row" style="margin-top:8px">'
          + (m.recurring
            ? '<button ' + btn + ' data-action="standing-on" data-type="' + esc(m.addon_type) + '">Add to every visit</button>'
            : '<button ' + btn + ' data-action="menu-add" data-type="' + esc(m.addon_type) + '">Add to my next visit</button>')
          + '</div>';
      }
    }
    return '<div class="visit">'
      + '<div class="head"><span class="date">' + esc(m.label) + '</span>' + badge + '</div>'
      + '<div class="meta">' + meta + '</div>'
      + actions
      + '</div>';
  }

  function renderAddons(addons) {
    // Phase 2: the full add-on menu (same builder as office + tech). While
    // it's still loading show skeletons; if the fetch failed — including a
    // backend that doesn't serve /addon-menu yet — fall back to the pre-menu
    // pending/standing view below, which keeps the old "+ Add a service" flow.
    if (menuState !== 'failed') {
      const el = $('addons');
      $('btn-add-addon').hidden = true; // menu rows carry their own Add controls
      if (menuState === 'loading' || !addonMenu) {
        el.innerHTML = '<span class="skel skel-lg"></span><span class="skel skel-md"></span>';
        return;
      }
      const canceled = !!addonMenu.subscription_canceled;
      el.innerHTML = (addonMenu.menu || []).map((m) => addonMenuRow(m, canceled)).join('')
        || '<p class="hint" style="margin:0">No add-on services are available for your generator — call the office.</p>';
      return;
    }

    const el = $('addons');
    const standing = addons.standing || [];
    const pending = addons.pending || [];
    let html = '';

    html += standing.map((a) => '<div class="visit">'
      + '<div class="head"><span class="date">' + esc(a.label) + '</span><span class="badge badge-info">Every visit</span></div>'
      + '<div class="meta">' + esc(money(a.amount_cents)) + ' · returns automatically each service visit</div>'
      + '</div>').join('');

    html += pending.map((a) => {
      const badge = a.status === 'performed'
        ? '<span class="badge badge-neutral">Performed — will be billed</span>'
        : '<span class="badge badge-info">This visit</span>';
      const remove = a.removable
        ? ' &nbsp;·&nbsp; <a href="#" class="link-danger" data-action="remove-addon" data-id="' + esc(a.id) + '" data-label="' + esc(a.label) + '">Remove</a>'
        : '';
      return '<div class="visit">'
        + '<div class="head"><span class="date">' + esc(a.label) + '</span>' + badge + '</div>'
        + '<div class="meta">' + esc(money(a.amount_cents)) + ' · billed when performed' + remove + '</div>'
        + '</div>';
    }).join('');

    if (!html) {
      html = '<p class="hint" style="margin:0">Nothing added yet — pick a service below if you’d like one done at your next visit.</p>';
    }
    el.innerHTML = html;

    $('btn-add-addon').hidden = !(addons.available && addons.available.length);
  }

  function renderReceipts(invoices) {
    const el = $('receipts');
    if (billingState === 'loading') {
      el.innerHTML = '<span class="skel skel-lg"></span><span class="skel skel-md"></span>';
      return;
    }
    if (billingState === 'failed') {
      el.innerHTML = '<p class="hint" style="margin:0">We couldn’t load your receipts right now — refresh to try again.</p>';
      return;
    }
    if (!invoices.length) {
      el.innerHTML = '<p class="hint" style="margin:0">No receipts yet — payment receipts will appear here.</p>';
      return;
    }
    el.innerHTML = invoices.map((inv) => {
      const view = inv.hosted_invoice_url
        ? '<a class="link" href="' + esc(inv.hosted_invoice_url) + '" target="_blank" rel="noopener">View</a>'
        : '';
      return '<div class="receipt">'
        + '<span>' + esc(fmtDate(inv.date)) + ' — ' + esc(inv.description) + '</span>'
        + '<span class="row" style="gap:14px;flex-wrap:nowrap"><b>' + esc(money(inv.amount_cents)) + '</b>'
        + view
        + '<a class="link" href="#" data-action="resend-receipt" data-id="' + esc(inv.id) + '">Resend email</a>'
        + '</span></div>';
    }).join('');
  }

  function renderCancelCard(plan) {
    const body = $('cancel-body');
    if (planIsEnding(plan)) {
      const through = serviceThroughDate(plan);
      body.innerHTML = '<div style="font-size:13px;color:var(--ink-2);max-width:420px">'
        + '<b style="color:var(--ink)">Your plan is canceled</b><br>'
        + (through ? 'Service continues through ' + esc(fmtDate(through)) + ' — no further charges after that.' : 'No further charges.')
        + '</div>';
      return;
    }
    const periodEnd = plan && plan.billing && plan.billing.current_period_end;
    body.innerHTML = '<div style="font-size:13px;color:var(--ink-2);max-width:420px">'
      + '<b style="color:var(--ink)">Need to cancel?</b><br>'
      + 'You’ll keep full service through your paid period' + (periodEnd ? ' (' + esc(fmtDate(periodEnd)) + ')' : '') + ' — no further charges after that.'
      + '</div>'
      + '<button class="btn btn-secondary" style="color:var(--danger)" data-action="cancel-plan">Cancel plan</button>';
  }

  // ---------------------------------------------------------------------------
  // Actions
  // ---------------------------------------------------------------------------
  async function onReschedule() {
    const values = await openPrompt({
      title: 'Request a different time',
      message: 'Tell us what works better and our office will confirm the new time with you. Nothing changes until we confirm.',
      fields: [
        { name: 'preferred', label: 'Preferred day / time', required: true, placeholder: 'e.g. the week of Aug 10, mornings' },
        { name: 'note', label: 'Anything else? (optional)', type: 'textarea', placeholder: 'Gate codes, best number to reach you…' },
      ],
      confirmText: 'Send request',
    });
    if (!values) return;
    try {
      await api('/api/my/reschedule-request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preferred: values.preferred, note: values.note || '' }),
      });
      openSuccessFlash({ title: 'Request sent', message: 'We’ll confirm the new time with you.' });
    } catch (err) { surfaceMustSee(err, 'Request NOT sent', 'Please try again, or call us at (636) 464-3939.'); }
  }

  function icsEscape(s) {
    return String(s || '')
      .replace(/\\/g, '\\\\')
      .replace(/;/g, '\\;')
      .replace(/,/g, '\\,')
      .replace(/\r?\n/g, '\\n');
  }

  function onAddToCalendar() {
    const nv = overview && overview.next_visit;
    if (!nv || !nv.appointment_at) return;
    const start = new Date(nv.appointment_at);
    if (isNaN(start.getTime())) return;
    // The calendar event spans the whole 2-hour arrival window (appointment_at
    // is the window's start); legacy exact-time bookings keep the 1-hour block.
    const win = window.BatesArrivalWindows.byCode[nv.arrival_window];
    const end = new Date(start.getTime() + (win ? 2 * 60 : 60) * 60 * 1000);
    const utc = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    const c = overview.customer || {};
    const where = [c.install_address, c.install_city, c.install_state, c.install_zip].filter(Boolean).join(', ');
    const company = (overview.branding && overview.branding.company_name) || 'Bates Electric';
    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Bates Electric//Generator Care//EN',
      'CALSCALE:GREGORIAN',
      'BEGIN:VEVENT',
      'UID:' + (nv.id || Date.now()) + '@bates-electric.com',
      'DTSTAMP:' + utc(new Date()),
      'DTSTART:' + utc(start),
      'DTEND:' + utc(end),
      'SUMMARY:' + icsEscape('Generator service visit — ' + company),
      'LOCATION:' + icsEscape(where),
      'DESCRIPTION:' + icsEscape((win ? 'Arrival window: ' + win.label + '. ' : '') + 'Regular generator maintenance service. Questions? (636) 464-3939'),
      'END:VEVENT',
      'END:VCALENDAR',
    ];
    const blob = new Blob([lines.join('\r\n')], { type: 'text/calendar;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'generator-service-visit.ics';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  async function onSwitchPlan() {
    if (!overview || !overview.plan) return;
    const other = overview.plan.other_plan;
    const label = planLabelFull(other);
    const renews = overview.plan.billing && overview.plan.billing.current_period_end;
    const ok = await openConfirm({
      title: 'Switch to ' + label + '?',
      message: 'Takes effect at your renewal' + (renews ? ' on ' + fmtDate(renews) : '') + ' — no charge today. You’ll see the new price before anything is billed.',
      confirmText: 'Switch plan',
      cancelText: 'Keep current plan',
    });
    if (!ok) return;
    try {
      const r = await api('/api/my/change-plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ new_plan: other }),
      });
      let msg = 'Done — switching to ' + planLabelFull(r.new_plan || other);
      if (r.effective_date) msg += ' on ' + fmtDate(r.effective_date);
      if (r.new_renewal_amount_cents != null) msg += '. New renewal: ' + money(r.new_renewal_amount_cents);
      showStatus(msg + '.', 'success');
      loadOverview(true);
    } catch (err) { surface(err); }
  }

  async function onBillingPortal() {
    const btn = $('btn-billing');
    btn.disabled = true;
    try {
      const r = await api('/api/my/billing-portal');
      if (r.url) { location.href = r.url; return; }
      showStatus('Could not open the billing portal — please try again.', 'error');
    } catch (err) { surface(err); }
    btn.disabled = false;
  }

  async function onAddAddon() {
    const available = (overview && overview.addons && overview.addons.available) || [];
    if (!available.length) {
      showStatus('No add-on services are available for your generator — call the office.', 'info');
      return;
    }
    const values = await openPrompt({
      title: 'Add a service',
      message: 'Performed during your next visit and billed only when done — never before.',
      fields: [{
        name: 'addon_type',
        label: 'Service',
        type: 'select',
        options: available.map((a) => ({ value: a.addon_type, label: a.label + ' — ' + money(a.amount_cents) })),
      }],
      confirmText: 'Add service',
    });
    if (!values || !values.addon_type) return;
    try {
      await api('/api/my/addons', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ addon_type: values.addon_type }),
      });
      showStatus('Added — we’ll take care of it at your next visit.', 'success');
      loadOverview(true);
    } catch (err) { surface(err); }
  }

  function menuItemByType(type) {
    return ((addonMenu && addonMenu.menu) || []).find((m) => m.addon_type === type) || null;
  }

  // One-time self-enroll from a menu row. The confirmation states the price
  // and WHEN it's charged — adding only schedules it; billing happens after
  // the work is performed at the visit, never here.
  async function onMenuAdd(type) {
    const item = menuItemByType(type);
    if (!item) return;
    const ok = await openConfirm({
      title: 'Add ' + item.label + '?',
      message: 'We’ll add this to your next visit. You’ll be charged ' + money(item.amount_cents)
        + ' only after it’s performed — never before.',
      confirmText: 'Add to my next visit',
      cancelText: 'Not now',
    });
    if (!ok) return;
    try {
      await api('/api/my/addons', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ addon_type: type }),
      });
      showStatus('Added — we’ll take care of it at your next visit.', 'success');
      loadOverview(true);
    } catch (err) { surface(err); }
  }

  // Every-visit (standing) self-enroll: returns automatically each cycle,
  // billed each visit it's performed.
  async function onStandingOn(type) {
    const item = menuItemByType(type);
    if (!item) return;
    const ok = await openConfirm({
      title: 'Add ' + item.label + ' to every visit?',
      message: 'We’ll include this on every visit. You’ll be charged ' + money(item.amount_cents)
        + ' each visit it’s performed — never before the work is done.',
      confirmText: 'Add to every visit',
      cancelText: 'Not now',
    });
    if (!ok) return;
    try {
      await api('/api/my/standing/' + encodeURIComponent(type), { method: 'POST' });
      showStatus('Done — ' + item.label + ' is now part of every visit.', 'success');
      loadOverview(true);
    } catch (err) { surface(err); }
  }

  async function onStandingOff(type, label) {
    const ok = await openConfirm({
      title: 'Remove ' + (label || 'this service') + ' from every visit?',
      message: 'It won’t be added to future visits, and it comes off your upcoming visit too if it hasn’t been done yet. No charge involved.',
      confirmText: 'Remove',
      cancelText: 'Keep it',
      danger: true,
    });
    if (!ok) return;
    try {
      await api('/api/my/standing/' + encodeURIComponent(type), { method: 'DELETE' });
      showStatus('Removed — it won’t be on future visits.', 'success');
      loadOverview(true);
    } catch (err) { surface(err); }
  }

  async function onRemoveAddon(id, label) {
    const ok = await openConfirm({
      title: 'Remove ' + (label || 'this service') + '?',
      message: 'No charge involved — it just comes off your next visit.',
      confirmText: 'Remove',
      cancelText: 'Keep it',
      danger: true,
    });
    if (!ok) return;
    try {
      await api('/api/my/addons/' + encodeURIComponent(id), { method: 'DELETE' });
      showStatus('Removed — nothing will be billed.', 'success');
      loadOverview(true);
    } catch (err) { surface(err); }
  }

  async function onResendReceipt(invoiceId) {
    try {
      await api('/api/my/resend-receipt/' + encodeURIComponent(invoiceId), { method: 'POST' });
      openSuccessFlash({ title: 'Receipt sent', message: 'Check your inbox — it can take a minute.' });
    } catch (err) { surfaceMustSee(err, 'Receipt NOT sent', 'Please try again, or call us at (636) 464-3939.'); }
  }

  async function onCancelPlan() {
    // Save-step first: a different plan, or a phone call, might fit better.
    const proceed = await openConfirm({
      title: 'Before you go…',
      message: 'Would a different plan fit better? You can switch plans free at renewal. Or talk to us: (636) 464-3939.',
      confirmText: 'Continue to cancel',
      cancelText: 'Keep my plan',
    });
    if (!proceed) return;
    const values = await openPrompt({
      title: 'Cancel your plan?',
      message: 'You’ll keep full service through your paid period — no further charges after that.',
      fields: [{ name: 'reason', label: 'Anything we could have done better? (optional)', type: 'textarea' }],
      confirmText: 'Cancel my plan',
      cancelText: 'Never mind',
      danger: true,
    });
    if (!values) return;
    try {
      const r = await api('/api/my/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: values.reason || '' }),
      });
      openSuccessFlash({
        title: 'Your plan is canceled',
        message: r.service_through ? 'Service continues through ' + fmtDate(r.service_through) + '.' : 'No further charges.',
      });
      loadOverview(true);
    } catch (err) { surfaceMustSee(err, 'Plan NOT canceled', 'Your plan is unchanged. Please try again, or call us at (636) 464-3939.'); }
  }

  // ---------------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------------
  function init() {
    $('theme-toggle').addEventListener('click', () => {
      const dark = document.documentElement.classList.toggle('dark');
      try {
        if (dark) localStorage.setItem(THEME_KEY, 'dark');
        else localStorage.removeItem(THEME_KEY);
      } catch (e) { /* ignore */ }
    });

    $('signout-btn').addEventListener('click', signOut);

    $('signin-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const email = $('signin-email').value.trim();
      if (!email || email.indexOf('@') === -1) {
        showStatus('Enter the email on your Generator Care plan.', 'warning');
        return;
      }
      requestLink(email);
    });

    $('btn-reschedule').addEventListener('click', onReschedule);
    $('btn-calendar').addEventListener('click', onAddToCalendar);
    $('sms-toggle').addEventListener('change', onSmsToggle);
    $('btn-switch').addEventListener('click', onSwitchPlan);
    $('btn-billing').addEventListener('click', onBillingPortal);
    $('btn-add-addon').addEventListener('click', onAddAddon);

    // Delegated clicks for rows rendered per-overview.
    document.addEventListener('click', (e) => {
      const el = e.target.closest ? e.target.closest('[data-action]') : null;
      if (!el) return;
      const action = el.dataset.action;
      if (el.tagName === 'A') e.preventDefault();
      if (action === 'remove-addon') onRemoveAddon(el.dataset.id, el.dataset.label);
      else if (action === 'menu-add') onMenuAdd(el.dataset.type);
      else if (action === 'standing-on') onStandingOn(el.dataset.type);
      else if (action === 'standing-off') onStandingOff(el.dataset.type, el.dataset.label);
      else if (action === 'resend-receipt') onResendReceipt(el.dataset.id);
      else if (action === 'cancel-plan') onCancelPlan();
      else if (action === 'retry') loadOverview();
      else if (action === 'open-photo') {
        const visit = ((overview && overview.visits) || []).find((v) => v.id === el.dataset.visit);
        if (visit && visit.photos && visit.photos.length) {
          window.BatesLightbox.open(visit.photos, parseInt(el.dataset.idx, 10) || 0);
        }
      }
      else if (action === 'prefs-open') { prefsFormOpen = true; renderHeroPrefs(overview && overview.next_visit); }
      else if (action === 'prefs-cancel') { prefsFormOpen = false; renderHeroPrefs(overview && overview.next_visit); }
      else if (action === 'prefs-submit') onPrefsSubmit(el);
      else if (action === 'show-older') {
        const older = $('older-visits');
        if (older) older.hidden = false;
        el.parentElement.remove();
      }
    });

    // A dead SMS short link (/s/<token> already used or expired) redirects
    // here with ?link=expired. Strip the param, and if there's no session to
    // fall back on, pair the sign-in card with a gentle note. Deliberately
    // neutral wording — the redeemer never reveals which check failed.
    var expiredLink = false;
    try {
      var qs = new URLSearchParams(location.search);
      if (qs.get('link') === 'expired') {
        expiredLink = true;
        qs.delete('link');
        history.replaceState(null, '', location.pathname + (qs.toString() ? '?' + qs.toString() : ''));
      }
    } catch (e) { /* ignore */ }

    // Stored token (fresh from the magic link, or an existing session) → straight
    // to the dashboard; otherwise the sign-in card.
    if (sessionStorage.getItem(TOKEN_KEY)) loadOverview();
    else {
      showView('signin');
      if (expiredLink) showStatus('That sign-in link has expired — enter your email below and we’ll send you a fresh one.', 'info');
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
