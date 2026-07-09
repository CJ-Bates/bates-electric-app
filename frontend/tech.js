// frontend/tech.js
// Field-Tech view for Generator Care: a tech sees ONLY the visits assigned to
// them, opens a visit for the details they need on site (customer, address with
// map link, phone to call, generator, plan, prior notes — NO billing), and marks
// it complete with a customer-visible note + an internal note. All data comes
// from the tech-gated API (/api/generator-care/tech/*); the server enforces the
// assignment (IDOR) boundary. Uses the shared dialog/toast (no native popups).

(() => {
  const API_BASE = (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
    ? 'http://localhost:4000'
    : 'https://bates-electric-app.onrender.com';
  const TOKEN_KEY = 'bates.auth.token';
  const getToken = () => localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY);
  const token = getToken();
  if (!token) { window.location.replace('/'); return; }

  const TECH_BASE = `${API_BASE}/api/generator-care/tech`;
  let currentVisit = null;

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  function fmtDate(d) {
    if (!d) return '';
    const dt = new Date(String(d).length <= 10 ? d + 'T00:00:00' : d);
    if (isNaN(dt)) return esc(d);
    return dt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  }
  function fmtDateTime(d) {
    if (!d) return '';
    const dt = new Date(d);
    if (isNaN(dt)) return esc(d);
    return dt.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }
  // Booked appointment -> "Tue, Jul 21 · 8:00–10:00 AM arrival" when the visit
  // has an arrival window; legacy exact-time bookings fall back to fmtDateTime.
  function fmtAppt(iso, windowCode) {
    const w = iso && window.BatesArrivalWindows.byCode[windowCode];
    if (!w) return fmtDateTime(iso);
    const dt = new Date(iso);
    if (isNaN(dt)) return esc(iso);
    return dt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) + ' · ' + w.label + ' arrival';
  }
  function todayStr() { return new Date().toISOString().slice(0, 10); }
  function localDateOf(v) {
    // The visit's effective date for grouping: booked appointment, else due date.
    const src = v.appointment_at || v.scheduled_date;
    if (!src) return null;
    const dt = new Date(String(src).length <= 10 ? src + 'T00:00:00' : src);
    return isNaN(dt) ? null : dt.toISOString().slice(0, 10);
  }
  // Arrival-window label only, no date (the "My Day" cards imply the date via
  // their section/day-chip, so repeating it in every row would be noise).
  function windowLabelOnly(v) {
    const w = window.BatesArrivalWindows.byCode[v.arrival_window];
    if (w) return w.label + ' arrival';
    return fmtDateTime(v.appointment_at); // legacy exact-time booking, no window
  }
  // Up-next time chip: bare window label for a stop happening today, dated
  // window label otherwise (overdue or a future soonest-upcoming pick).
  function apptChipText(v) {
    const w = window.BatesArrivalWindows.byCode[v.arrival_window];
    const d = localDateOf(v);
    if (!w) return fmtDateTime(v.appointment_at);
    return d === todayStr() ? w.label : `${fmtDate(v.appointment_at)} · ${w.label}`;
  }
  // "first one at 8 AM" — just the window's start clock time.
  function startTimeLabel(v) {
    const w = window.BatesArrivalWindows.byCode[v.arrival_window];
    if (w && w.start) {
      const [h, m] = w.start.split(':').map(Number);
      const dt = new Date();
      dt.setHours(h, m, 0, 0);
      return dt.toLocaleTimeString('en-US', m ? { hour: 'numeric', minute: '2-digit' } : { hour: 'numeric' });
    }
    return fmtDateTime(v.appointment_at);
  }
  function dayChipParts(dateStr) {
    const dt = new Date(dateStr + 'T00:00:00');
    if (isNaN(dt)) return { dow: '', day: '' };
    return { dow: dt.toLocaleDateString('en-US', { weekday: 'short' }), day: String(dt.getDate()) };
  }
  function customerName(v) {
    return (v.subscription && v.subscription.customer && v.subscription.customer.name) || 'Customer';
  }
  function cityState(v) {
    const c = (v.subscription && v.subscription.customer) || {};
    return [c.install_city, c.install_state].filter(Boolean).join(', ');
  }
  function firstNameOf(profile) {
    const displayName = (profile && (profile.full_name || (profile.email && profile.email.split('@')[0]))) || 'there';
    return displayName.split(' ')[0];
  }
  // Delegated tap-to-open: the whole card/row opens the visit EXCEPT taps that
  // land on a real link/button inside it (Navigate, Call, Book time, Open visit),
  // which keep their own behavior.
  function makeTappable(el, id) {
    el.addEventListener('click', (e) => {
      if (e.target.closest('a, button')) return;
      openVisit(id);
    });
  }
  const planLabel = (p) => p === 'semi_annual' ? 'Semi-Annual' : (p === 'annual' ? 'Annual' : (p || '—'));
  const genClassLabel = (g) => ({
    air_cooled: 'Air cooled', liquid_22_38: 'Liquid cooled', liquid_48_150: 'Liquid cooled',
  }[g] || (g || ''));
  // Absolute instant -> a datetime-local input value in the viewer's local tz.
  function toLocalInput(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  // ---- Photo upload plumbing (same proven pattern as inspection.js) ----
  // Uploads go DIRECTLY from the phone to Supabase Storage with the tech's JWT;
  // RLS on the bucket/table enforces the assignment boundary (a 403 = not their
  // visit). The backend only serves reads (signed URLs) and deletes.
  function withTimeout(promise, ms, label) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label || 'Operation'} timed out after ${ms}ms`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  let cachedConfig = null;
  async function getConfig() {
    if (cachedConfig) return cachedConfig;
    const res = await withTimeout(fetch(`${API_BASE}/config`), 10000, 'Config fetch');
    if (!res.ok) throw new Error('Failed to load config');
    cachedConfig = await res.json();
    return cachedConfig;
  }

  function safeFileName(name) {
    return (name || 'photo.jpg').replace(/[^A-Za-z0-9._-]/g, '_');
  }

  // Shrink before upload: max dimension ~1600px, JPEG q0.8. Cuts a 4–8 MB phone
  // photo to a few hundred KB so uploads survive job-site signal. If decode or
  // canvas fails (e.g. HEIC on some browsers), ship the original file — the
  // bucket still enforces type/size server-side.
  const MAX_PHOTO_DIM = 1600;
  async function compressImage(file) {
    if (!file.type || !file.type.startsWith('image/')) return file;
    try {
      const bmp = await createImageBitmap(file);
      const scale = Math.min(1, MAX_PHOTO_DIM / Math.max(bmp.width, bmp.height));
      const w = Math.max(1, Math.round(bmp.width * scale));
      const h = Math.max(1, Math.round(bmp.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d').drawImage(bmp, 0, 0, w, h);
      if (bmp.close) bmp.close();
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.8));
      return blob || file;
    } catch (e) {
      console.warn('compress failed, uploading original', e);
      return file;
    }
  }

  // One photo: storage object first (path is `<visitId>/...` so RLS can check
  // the parent visit), then the DB row (uploaded_by defaults to auth.uid()).
  async function uploadOneVisitPhoto(cfg, visitId, file, blob, idx) {
    const path = `${visitId}/${Date.now()}-${idx}-${safeFileName(file.name)}`;
    const storageRes = await fetch(`${cfg.supabaseUrl}/storage/v1/object/generator-visit-photos/${path}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'apikey': cfg.supabaseAnonKey,
        'Content-Type': blob.type || file.type || 'application/octet-stream',
        'x-upsert': 'false',
      },
      body: blob,
    });
    if (!storageRes.ok) {
      if (storageRes.status === 403) throw new Error('This visit is not assigned to you, so photos can\'t be added.');
      const bodyText = await storageRes.text().catch(() => '');
      throw new Error(`Upload failed (${storageRes.status}): ${bodyText}`);
    }
    const rowRes = await fetch(`${cfg.supabaseUrl}/rest/v1/generator_visit_photos`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'apikey': cfg.supabaseAnonKey,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify({ visit_id: visitId, storage_path: path }),
    });
    if (!rowRes.ok) {
      const bodyText = await rowRes.text().catch(() => '');
      throw new Error(`Photo record failed (${rowRes.status}): ${bodyText}`);
    }
  }

  // ---- Role guard: this view is for techs ----
  // Returns the profile on success, `undefined` on a failed profile fetch
  // (fail OPEN — still render the day; the API itself is tech-gated), or
  // `null` when we've redirected a non-tech away (caller must stop).
  async function checkRole() {
    try {
      const r = await BatesAuth.authFetch(`${API_BASE}/me`, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) throw new Error('profile');
      const { profile } = await r.json();
      if (profile.role !== 'tech') {
        // Office (or anyone else) belongs on the office hub, not the field view.
        window.location.replace('/home');
        return null;
      }
      return profile;
    } catch (e) {
      console.error('role check failed', e);
      return undefined;
    }
  }

  // ---- Hero: greeting + date + weather ----
  function renderHero(profile) {
    const now = new Date();
    const dateEl = document.getElementById('hero-date');
    const greetEl = document.getElementById('hero-greet');
    const nameEl = document.getElementById('hero-name');
    if (dateEl) dateEl.textContent = now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
    if (greetEl) greetEl.textContent = window.BatesWeather.greetingForHour(now.getHours());
    if (nameEl) nameEl.textContent = firstNameOf(profile);
    window.BatesWeather.mount({
      wrapEl: document.getElementById('hero-weather'),
      iconEl: document.getElementById('hero-weather-icon'),
      tempEl: document.getElementById('hero-weather-temp'),
      locEl: document.getElementById('hero-weather-loc'),
    });
  }

  // ---- List ----
  async function loadVisits() {
    try {
      const r = await BatesAuth.authFetch(`${TECH_BASE}/my-visits`, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const { visits } = await r.json();
      renderDay(visits || []);
    } catch (e) {
      console.error('load visits failed', e);
      const sub = document.getElementById('hero-sub');
      if (sub) sub.textContent = "Couldn't load your visits. Pull to refresh or try again.";
    }
  }

  function visitStatus(v) {
    if (v.completed_date || v.status === 'completed') return 'done';
    if (v.appointment_at) return 'scheduled';
    return 'need';
  }

  // Buckets every visit into the "My Day" sections, then renders each.
  function renderDay(visits) {
    const today = todayStr();
    const open = visits.filter((v) => visitStatus(v) !== 'done');
    const done = visits.filter((v) => visitStatus(v) === 'done');

    const scheduledOpen = open
      .filter((v) => visitStatus(v) === 'scheduled')
      .sort((a, b) => new Date(a.appointment_at) - new Date(b.appointment_at));
    const overdueScheduled = scheduledOpen.filter((v) => localDateOf(v) && localDateOf(v) < today);
    const todayOpen = scheduledOpen.filter((v) => localDateOf(v) === today);
    const futureScheduled = scheduledOpen.filter((v) => localDateOf(v) && localDateOf(v) > today);

    // Not-yet-booked visits: a future due date is just an upcoming reminder;
    // no due date (or a due date already here/passed) needs action now.
    const needStatus = open.filter((v) => visitStatus(v) === 'need');
    const needFuture = needStatus.filter((v) => localDateOf(v) && localDateOf(v) > today);
    const needNow = needStatus.filter((v) => !localDateOf(v) || localDateOf(v) <= today);

    const needsAttention = [...overdueScheduled, ...needNow];
    const upcoming = [...futureScheduled, ...needFuture].sort((a, b) => {
      const da = localDateOf(a) || '9999-99-99';
      const db = localDateOf(b) || '9999-99-99';
      return da < db ? -1 : (da > db ? 1 : 0);
    });

    const todayOrOverdue = [...overdueScheduled, ...todayOpen]
      .sort((a, b) => new Date(a.appointment_at) - new Date(b.appointment_at));
    const upNext = todayOrOverdue[0] || futureScheduled[0] || null;
    const laterToday = todayOpen.filter((v) => !upNext || v.id !== upNext.id);

    const weekAgoStr = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const doneThisWeek = done
      .filter((v) => v.completed_date && v.completed_date >= weekAgoStr)
      .sort((a, b) => String(b.completed_date || '').localeCompare(String(a.completed_date || '')));

    renderStats(todayOpen.length, needsAttention.length, doneThisWeek.length);
    renderHeroSub(todayOpen, needsAttention, upNext);
    renderUpNext(upNext, todayOpen.length, open.length > 0);
    renderLaterToday(laterToday);
    renderAttention(needsAttention);
    renderUpcoming(upcoming);
    renderDoneSummary(doneThisWeek);
  }

  function renderStats(todayCount, overdueCount, doneCount) {
    const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = String(val); };
    set('td-stat-today', todayCount);
    set('td-stat-overdue', overdueCount);
    set('td-stat-done', doneCount);
  }

  function renderHeroSub(todayOpen, needsAttention, upNext) {
    const el = document.getElementById('hero-sub');
    if (!el) return;
    if (todayOpen.length > 0) {
      el.innerHTML = `You've got <b>${todayOpen.length}</b> stop${todayOpen.length === 1 ? '' : 's'} today — first one at ${esc(startTimeLabel(todayOpen[0]))}.`;
    } else if (needsAttention.length > 0) {
      el.innerHTML = `No stops today — but <b>${needsAttention.length}</b> visit${needsAttention.length === 1 ? '' : 's'} need${needsAttention.length === 1 ? 's' : ''} attention.`;
    } else if (upNext) {
      el.textContent = `No stops today — next up ${fmtDate(upNext.appointment_at)}.`;
    } else {
      el.textContent = "You're all caught up for now.";
    }
  }

  function renderUpNext(v, todayCount, hasAnyOpen) {
    const wrap = document.getElementById('td-upnext-wrap');
    if (!wrap) return;
    if (!v) {
      wrap.innerHTML = hasAnyOpen ? '' : `<div class="section-label">Up next</div>
        <div class="td-empty"><div class="td-empty-icon">${BatesIcons.icon('check', 24)}</div>You're all caught up — the office will dispatch new visits here.</div>`;
      return;
    }
    const cust = customerName(v);
    const c = (v.subscription && v.subscription.customer) || {};
    const sub = v.subscription || {};
    const addrFull = [c.install_address, c.install_city, c.install_state, c.install_zip].filter(Boolean).join(', ');
    const mapUrl = addrFull ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(addrFull)}` : null;
    const telDigits = c.phone ? String(c.phone).replace(/[^\d+]/g, '') : null;
    const genParts = [genClassLabel(sub.gen_class), sub.gen_type_label, planLabel(sub.plan)].filter(Boolean);

    const overdue = localDateOf(v) && localDateOf(v) < todayStr();
    const tag = overdue ? 'Overdue' : (localDateOf(v) === todayStr() ? `Stop 1 of ${todayCount}` : 'Next visit');

    const actions = [];
    if (mapUrl) actions.push(`<a class="td-upnext-btn td-upnext-btn-nav" href="${esc(mapUrl)}" target="_blank" rel="noopener">${BatesIcons.icon('navigate', 16)}Navigate</a>`);
    if (telDigits) actions.push(`<a class="td-upnext-btn td-upnext-btn-soft" href="tel:${esc(telDigits)}">${BatesIcons.icon('phone', 15)}Call</a>`);
    actions.push(`<button type="button" class="td-upnext-btn td-upnext-btn-soft" data-open-visit="${esc(v.id)}">${BatesIcons.icon('chevronRight', 15)}Open visit</button>`);

    wrap.innerHTML = `
      <div class="section-label">Up next</div>
      <div class="td-upnext" data-visit="${esc(v.id)}">
        <div class="td-upnext-head">
          <span class="td-upnext-time">${BatesIcons.icon('clock', 14)}${esc(apptChipText(v))}</span>
          <span class="td-upnext-tag">${esc(tag)}</span>
        </div>
        <h3>${esc(cust)}</h3>
        ${addrFull ? `<div class="td-upnext-addr">${esc(addrFull)}</div>` : ''}
        ${genParts.length ? `<div class="td-upnext-gen">${genParts.map((p) => `<span>${esc(p)}</span>`).join('<span class="dot"></span>')}</div>` : ''}
        <div class="td-upnext-actions">${actions.join('')}</div>
      </div>`;
    makeTappable(wrap.querySelector('.td-upnext'), v.id);
    const openBtn = wrap.querySelector('[data-open-visit]');
    if (openBtn) openBtn.addEventListener('click', () => openVisit(v.id));
  }

  // Shared card markup for "Later today" (mode='today') and "Needs attention"
  // (mode='attention') — same shape, warn-accented + a Book-time affordance.
  function cardHtml(v, mode) {
    const warn = mode === 'attention';
    const cust = customerName(v);
    const addr = cityState(v);
    let metaText, rightHtml;
    if (warn) {
      const st = visitStatus(v);
      metaText = st === 'scheduled'
        ? `Overdue — was ${windowLabelOnly(v)} on ${fmtDate(v.appointment_at)}`
        : (v.scheduled_date ? `Due ${fmtDate(v.scheduled_date)} — not booked` : 'Not booked');
      rightHtml = `<button type="button" class="badge badge-warn" data-book="${esc(v.id)}">Book time</button>`;
    } else {
      metaText = windowLabelOnly(v);
      rightHtml = `<span class="badge badge-ok">Scheduled</span>`;
    }
    const meta = [addr, metaText].filter(Boolean).join(' · ');
    return `<div class="td-card${warn ? ' td-warncard' : ''}" data-visit="${esc(v.id)}">
      <div class="td-card-pin">${BatesIcons.icon(warn ? 'warn' : 'mapPin', 20)}</div>
      <div class="td-card-mid">
        <div class="td-card-cust">${esc(cust)}</div>
        ${meta ? `<div class="td-card-meta">${esc(meta)}</div>` : ''}
      </div>
      <div class="td-card-right">${rightHtml}</div>
      <span class="td-card-chev">${BatesIcons.icon('chevronRight', 18)}</span>
    </div>`;
  }

  function renderLaterToday(list) {
    const wrap = document.getElementById('td-later-wrap');
    if (!wrap) return;
    if (!list.length) { wrap.innerHTML = ''; return; }
    wrap.innerHTML = `<div class="section-label">Later today</div>${list.map((v) => cardHtml(v, 'today')).join('')}`;
    wrap.querySelectorAll('[data-visit]').forEach((el) => makeTappable(el, el.getAttribute('data-visit')));
  }

  function renderAttention(list) {
    const wrap = document.getElementById('td-attention-wrap');
    if (!wrap) return;
    if (!list.length) { wrap.innerHTML = ''; return; }
    wrap.innerHTML = `<div class="section-label td-label-warn">Needs attention</div>${list.map((v) => cardHtml(v, 'attention')).join('')}`;
    wrap.querySelectorAll('[data-visit]').forEach((el) => makeTappable(el, el.getAttribute('data-visit')));
    wrap.querySelectorAll('[data-book]').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const v = list.find((x) => String(x.id) === btn.getAttribute('data-book'));
        if (v) rescheduleVisit(v);
      });
    });
  }

  function renderUpcoming(list) {
    const wrap = document.getElementById('td-upcoming-wrap');
    if (!wrap) return;
    if (!list.length) { wrap.innerHTML = ''; return; }
    const rows = list.map((v) => {
      const cust = customerName(v);
      const addr = cityState(v);
      const metaText = visitStatus(v) === 'scheduled' ? windowLabelOnly(v) : 'needs scheduling';
      const { dow, day } = dayChipParts(localDateOf(v));
      const meta = [addr, metaText].filter(Boolean).join(' · ');
      return `<div class="td-urow" data-visit="${esc(v.id)}">
        <div class="td-urow-d"><div class="td-urow-dow">${esc(dow)}</div><div class="td-urow-day">${esc(day)}</div></div>
        <div class="td-urow-mid"><div class="td-urow-cust">${esc(cust)}</div>${meta ? `<div class="td-urow-meta">${esc(meta)}</div>` : ''}</div>
        <span class="td-card-chev">${BatesIcons.icon('chevronRight', 18)}</span>
      </div>`;
    }).join('');
    wrap.innerHTML = `<hr class="td-divider" /><div class="section-label">Upcoming</div>${rows}`;
    wrap.querySelectorAll('[data-visit]').forEach((el) => makeTappable(el, el.getAttribute('data-visit')));
  }

  function renderDoneSummary(doneThisWeek) {
    const wrap = document.getElementById('td-done-wrap');
    if (!wrap) return;
    if (!doneThisWeek.length) { wrap.innerHTML = ''; return; }
    const rows = doneThisWeek.map((v) => {
      const cust = customerName(v);
      const addr = cityState(v);
      const meta = [addr, v.completed_date ? `Completed ${fmtDate(v.completed_date)}` : ''].filter(Boolean).join(' · ');
      return `<div class="td-urow" data-visit="${esc(v.id)}">
        <div class="td-urow-mid"><div class="td-urow-cust">${esc(cust)}</div>${meta ? `<div class="td-urow-meta">${esc(meta)}</div>` : ''}</div>
        <span class="badge badge-neutral">Done</span>
      </div>`;
    }).join('');
    wrap.innerHTML = `<hr class="td-divider" />
      <div class="td-done-note" id="td-done-toggle" role="button" tabindex="0">&#10003; <b>${doneThisWeek.length}</b> visit${doneThisWeek.length === 1 ? '' : 's'} completed this week — tap to view</div>
      <div id="td-done-list" hidden>${rows}</div>`;
    const toggle = document.getElementById('td-done-toggle');
    const list = document.getElementById('td-done-list');
    const flip = () => { list.hidden = !list.hidden; };
    toggle.addEventListener('click', flip);
    toggle.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); flip(); } });
    list.querySelectorAll('[data-visit]').forEach((el) => makeTappable(el, el.getAttribute('data-visit')));
  }

  // ---- Detail ----
  async function openVisit(id) {
    const overlay = document.getElementById('tvd');
    const body = document.getElementById('tvd-body');
    body.innerHTML = `<p>Loading…</p>`;
    overlay.classList.add('open');
    overlay.setAttribute('aria-hidden', 'false');
    try {
      const r = await BatesAuth.authFetch(`${TECH_BASE}/my-visits/${id}`, { headers: { Authorization: `Bearer ${token}` } });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) { body.innerHTML = `<div class="tvd-sec">Couldn't open this visit: ${esc(data.error || ('HTTP ' + r.status))}</div>`; return; }
      currentVisit = data.visit;
      renderDetail(data.visit);
    } catch (e) {
      console.error('open visit failed', e);
      body.innerHTML = `<div class="tvd-sec">Couldn't open this visit.</div>`;
    }
  }

  function closeDetail() {
    const overlay = document.getElementById('tvd');
    overlay.classList.remove('open');
    overlay.setAttribute('aria-hidden', 'true');
    currentVisit = null;
  }

  function renderDetail(v) {
    const body = document.getElementById('tvd-body');
    const sub = v.subscription || {};
    const c = sub.customer || {};
    const done = !!(v.completed_date || v.status === 'completed');

    const addrFull = [c.install_address, c.install_city, c.install_state, c.install_zip].filter(Boolean).join(', ');
    const mapUrl = addrFull ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(addrFull)}` : null;
    const telDigits = c.phone ? String(c.phone).replace(/[^\d+]/g, '') : null;
    const gen = [genClassLabel(sub.gen_class), sub.gen_type_label, sub.gen_model].filter(Boolean).join(' • ');

    let when;
    if (done) when = `Completed ${fmtDate(v.completed_date)}${v.completed_by ? ' by ' + esc(v.completed_by) : ''}`;
    else if (v.appointment_at) when = `Scheduled ${fmtAppt(v.appointment_at, v.arrival_window)}`;
    else when = v.scheduled_date ? `Needs scheduling · due ${fmtDate(v.scheduled_date)}` : 'Needs scheduling';

    body.innerHTML = `
      <div class="tvd-sec">
        <h3>Customer</h3>
        <div class="tvd-row"><span class="k">Name</span><span class="v">${esc(c.name || '—')}</span></div>
        ${addrFull ? `<div class="tvd-row"><span class="k">Address</span><span class="v"><a class="tvd-action" href="${esc(mapUrl)}" target="_blank" rel="noopener">${esc(addrFull)} ${BatesIcons.icon('external', 14)}</a></span></div>` : ''}
        ${telDigits ? `<div class="tvd-row"><span class="k">Phone</span><span class="v"><a class="tvd-action" href="tel:${esc(telDigits)}">${esc(c.phone)} ${BatesIcons.icon('phone', 14)}</a></span></div>` : ''}
      </div>

      <div class="tvd-sec">
        <h3>Generator &amp; plan</h3>
        ${gen ? `<div class="tvd-row"><span class="k">Generator</span><span class="v">${esc(gen)}</span></div>` : ''}
        ${sub.gen_serial ? `<div class="tvd-row"><span class="k">Serial</span><span class="v">${esc(sub.gen_serial)}</span></div>` : ''}
        <div class="tvd-row"><span class="k">Plan</span><span class="v">${esc(planLabel(sub.plan))}</span></div>
        <div class="tvd-row"><span class="k">Status</span><span class="v">${esc(when)}</span></div>
        ${!done ? `<div class="tvd-row" style="justify-content:flex-end;"><button type="button" class="btn btn-ghost btn-sm" id="tvd-resched-btn">${v.appointment_at ? 'Reschedule' : 'Book time'}</button></div>` : ''}
      </div>

      ${(v.notes || v.internal_note) ? `<div class="tvd-sec">
        <h3>Notes</h3>
        ${v.notes ? `<div style="margin-bottom:${v.internal_note ? '10px' : '0'}"><div class="k" style="font-size:0.78rem;color:var(--ink-2);margin-bottom:3px;">Customer-visible</div><div class="tvd-note">${esc(v.notes)}</div></div>` : ''}
        ${v.internal_note ? `<div><div class="k" style="font-size:0.78rem;color:var(--warn);margin-bottom:3px;">Internal (not shown to customer)</div><div class="tvd-note tvd-note-internal">${esc(v.internal_note)}</div></div>` : ''}
      </div>` : ''}

      <div class="tvd-sec">
        <h3>Photos</h3>
        <div class="tvd-photo-grid" id="tvd-photo-grid"><span class="tvd-photo-muted">Loading photos&hellip;</span></div>
        <div class="tvd-photo-status" id="tvd-photo-status" hidden></div>
        <label class="btn btn-secondary">
          Add photos
          <input type="file" id="tvd-photo-input" accept="image/*" capture="environment" multiple hidden>
        </label>
      </div>

      <div class="tvd-sec" id="tvd-addons-sec" hidden></div>

      <div class="tvd-cta">
        ${done
          ? `<div class="tvd-done-banner">Completed ${esc(fmtDate(v.completed_date))}${v.completed_by ? ' by ' + esc(v.completed_by) : ''}</div>`
          : `<button class="btn btn-primary tvd-complete" id="tvd-complete-btn">Mark visit complete</button>`}
      </div>
    `;

    const btn = document.getElementById('tvd-complete-btn');
    if (btn) btn.addEventListener('click', () => completeVisit(v.id));
    const reschedBtn = document.getElementById('tvd-resched-btn');
    if (reschedBtn) reschedBtn.addEventListener('click', () => rescheduleVisit(v));
    wirePhotoUpload(v.id);
    loadPhotos(v.id);
    loadAddons(v);
  }

  // ---- Photos (phase 2) ----
  // Thumbnails from the tech-gated API (signed URLs). Tap = full size in a new
  // tab; the X (only on the tech's own photos while the visit is open — the
  // server sets `deletable`) removes one. Uploads stay allowed after completion;
  // deletes are what lock.
  async function loadPhotos(visitId) {
    const grid = document.getElementById('tvd-photo-grid');
    if (!grid) return;
    // Identity guard: if the panel re-rendered for another visit while this
    // request was in flight, the live grid is a NEW element — drop the result.
    const stale = () => document.getElementById('tvd-photo-grid') !== grid;
    try {
      const r = await BatesAuth.authFetch(`${TECH_BASE}/my-visits/${visitId}/photos`, { headers: { Authorization: `Bearer ${token}` } });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      if (stale()) return;
      renderPhotoGrid(visitId, data.photos || []);
    } catch (e) {
      console.error('load photos failed', e);
      if (!stale()) grid.innerHTML = `<span class="tvd-photo-muted">Couldn't load photos.</span>`;
    }
  }

  function renderPhotoGrid(visitId, photos) {
    const grid = document.getElementById('tvd-photo-grid');
    if (!grid) return;
    if (!photos.length) {
      grid.innerHTML = `<span class="tvd-photo-muted">No photos yet.</span>`;
      return;
    }
    grid.innerHTML = photos.map((p) => `<div class="tvd-photo-thumb">
        <a href="${esc(p.url)}" target="_blank" rel="noopener"><img src="${esc(p.url)}" alt="Visit photo" loading="lazy"></a>
        ${p.deletable ? `<button type="button" class="tvd-photo-del" data-del-photo="${esc(p.id)}" aria-label="Delete photo">${BatesIcons.icon('x', 12)}</button>` : ''}
      </div>`).join('');
    grid.querySelectorAll('[data-del-photo]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const ok = await openConfirm({ title: 'Delete this photo?', confirmText: 'Delete', danger: true });
        if (!ok) return;
        try {
          const r = await BatesAuth.authFetch(`${TECH_BASE}/my-visits/${visitId}/photos/${btn.getAttribute('data-del-photo')}`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${token}` },
          });
          const data = await r.json().catch(() => ({}));
          if (!r.ok) { showStatus(`Could not delete: ${data.error || ('HTTP ' + r.status)}`, 'error'); return; }
          showStatus('Photo deleted.', 'success');
        } catch (e) {
          console.error('delete photo failed', e);
          showStatus(`Failed: ${e.message}`, 'error');
        } finally {
          loadPhotos(visitId);
        }
      });
    });
  }

  // Compress + upload sequentially with a per-file progress line (one toast at
  // the end, not one per file), then reload the strip.
  function wirePhotoUpload(visitId) {
    const input = document.getElementById('tvd-photo-input');
    const statusEl = document.getElementById('tvd-photo-status');
    if (!input) return;
    let busy = false;
    input.addEventListener('change', async () => {
      if (busy) return;
      const files = Array.from(input.files || []);
      input.value = '';
      if (!files.length) return;
      busy = true;
      const setLine = (msg) => {
        if (!statusEl) return;
        statusEl.hidden = !msg;
        statusEl.textContent = msg || '';
      };
      let uploaded = 0;
      let firstErr = null;
      try {
        const cfg = await getConfig();
        for (let i = 0; i < files.length; i++) {
          setLine(`Uploading ${i + 1} of ${files.length}…`);
          try {
            const blob = await compressImage(files[i]);
            await withTimeout(uploadOneVisitPhoto(cfg, visitId, files[i], blob, i), 45000, 'Photo upload');
            uploaded++;
          } catch (e) {
            console.error('photo upload failed', e);
            if (!firstErr) firstErr = e;
          }
        }
      } catch (e) {
        console.error('photo config failed', e);
        firstErr = new Error('Couldn\'t reach the photo service — check your connection.');
      }
      setLine('');
      busy = false;
      const failed = files.length - uploaded;
      if (!failed) {
        showStatus(`${uploaded} photo${uploaded === 1 ? '' : 's'} added.`, 'success');
      } else if (uploaded) {
        showStatus(`${uploaded} of ${files.length} photos added — ${failed} failed. ${firstErr ? firstErr.message : ''}`, 'warning');
      } else {
        showStatus(`Photos didn't upload: ${firstErr ? firstErr.message : 'unknown error'}`, 'error');
      }
      if (uploaded) loadPhotos(visitId);
    });
  }

  // ---- Reschedule (phase 2, open visits only) ----
  // Books a date + 2-hour ARRIVAL WINDOW (same shape as the office books in);
  // appointment_at is stored as the window's start on that date.
  async function rescheduleVisit(v) {
    const hasAppt = !!v.appointment_at;
    const AW = window.BatesArrivalWindows;
    const res = await openPrompt({
      title: hasAppt ? 'Reschedule visit' : 'Book time',
      message: 'Pick the date and the arrival window you\'ll be on site in.',
      fields: [
        { name: 'date', label: 'New date', type: 'date', value: hasAppt ? toLocalInput(v.appointment_at).slice(0, 10) : '', required: true },
        {
          name: 'window', label: 'Arrival window', type: 'select',
          value: AW.byCode[v.arrival_window] ? v.arrival_window : AW.WINDOWS[0].code,
          options: AW.WINDOWS.map((w) => ({ value: w.code, label: w.label })),
        },
      ],
      validate: (vals) => {
        if (isNaN(new Date(vals.date + 'T12:00:00').getTime())) return 'Enter a valid date.';
        if (!AW.byCode[vals.window]) return 'Pick an arrival window.';
        return '';
      },
      confirmText: hasAppt ? 'Reschedule' : 'Book',
    });
    if (res === null) return;
    const win = AW.byCode[res.window];
    const when = new Date(`${res.date}T${win.start}`);
    if (isNaN(when.getTime())) { showStatus('That date didn\'t parse — try again.', 'error'); return; }
    try {
      const r = await BatesAuth.authFetch(`${TECH_BASE}/my-visits/${v.id}/schedule`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ appointment_at: when.toISOString(), arrival_window: win.code }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) { showStatus(`Could not reschedule: ${data.error || ('HTTP ' + r.status)}`, 'error'); return; }
      showStatus(`Visit scheduled for ${data.visit && data.visit.appointment_at ? fmtAppt(data.visit.appointment_at, data.visit.arrival_window) : fmtAppt(when.toISOString(), win.code)}.`, 'success');
      loadVisits();
      openVisit(v.id); // re-fetch so the detail shows the new window
    } catch (e) {
      console.error('reschedule failed', e);
      showStatus(`Failed: ${e.message}`, 'error');
    }
  }

  // ---- Add-ons checklist (phase 2) ----
  // Labels only — NEVER amounts; billing is office-only. Section stays hidden
  // unless the API returns items (and on any load error, since it's additive).
  async function loadAddons(v) {
    const sec = document.getElementById('tvd-addons-sec');
    if (!sec) return;
    try {
      const r = await BatesAuth.authFetch(`${TECH_BASE}/my-visits/${v.id}/addons`, { headers: { Authorization: `Bearer ${token}` } });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      // Identity guard: don't render into a panel that re-rendered meanwhile.
      if (document.getElementById('tvd-addons-sec') !== sec) return;
      renderAddons(v, data.addons || []);
    } catch (e) {
      console.error('load addons failed', e); // additive — section just stays hidden
    }
  }

  function renderAddons(v, addons) {
    const sec = document.getElementById('tvd-addons-sec');
    if (!sec) return;
    if (!addons.length) { sec.hidden = true; sec.innerHTML = ''; return; }
    const done = !!(v.completed_date || v.status === 'completed');
    const rows = addons.map((a) => {
      const badge = a.status === 'performed'
        ? `<span class="badge badge-ok">Performed${a.date_performed ? ' ' + esc(fmtDate(a.date_performed)) : ''}</span>`
        : `<span class="badge badge-warn">Pending</span>`;
      let action = '';
      if (!done) {
        action = a.status === 'pending'
          ? `<button type="button" class="btn btn-primary btn-sm" data-addon-perform="${esc(a.id)}">Mark performed</button>`
          : `<button type="button" class="btn btn-ghost btn-sm" data-addon-undo="${esc(a.id)}">Undo</button>`;
      }
      return `<div class="tvd-addon-row">
        <div class="tvd-addon-label">${esc(a.label)}</div>
        <div class="tvd-addon-side">${badge}${action}</div>
      </div>`;
    }).join('');
    sec.innerHTML = `<h3>Add-ons</h3><p class="tvd-addon-hint">Flag work you performed — the office bills it later.</p>${rows}`;
    sec.hidden = false;
    sec.querySelectorAll('[data-addon-perform]').forEach((btn) => {
      btn.addEventListener('click', () => performAddon(v, btn.getAttribute('data-addon-perform'), false));
    });
    sec.querySelectorAll('[data-addon-undo]').forEach((btn) => {
      btn.addEventListener('click', () => performAddon(v, btn.getAttribute('data-addon-undo'), true));
    });
  }

  async function performAddon(v, addonId, undo) {
    try {
      const r = await BatesAuth.authFetch(`${TECH_BASE}/my-visits/${v.id}/addons/${addonId}/perform`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(undo ? { undo: true } : {}),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) { showStatus(data.error || `HTTP ${r.status}`, 'error'); }
      else showStatus(undo ? 'Moved back to pending.' : 'Marked performed.', 'success');
    } catch (e) {
      console.error('addon perform failed', e);
      showStatus(`Failed: ${e.message}`, 'error');
    }
    loadAddons(v); // refresh either way — a 409 means it changed underneath us
  }

  // ---- Complete ----
  async function completeVisit(id) {
    const res = await openPrompt({
      title: 'Mark visit complete',
      message: 'Records the date performed and notes. The next visit is auto-scheduled on the plan cadence (the office will assign it).',
      fields: [
        { name: 'date', label: 'Date performed', type: 'date', value: todayStr(), required: true },
        { name: 'notes', label: 'Note for the customer (optional)', type: 'textarea', placeholder: 'What we did, anything they should know…', hint: 'The customer sees this in their visit-complete email.' },
        { name: 'internal', label: 'Internal note (office + techs only)', type: 'textarea', placeholder: 'Parts used, follow-ups, access notes…', hint: 'Never shown to the customer.' },
        { name: 'parts', label: 'Parts used / needs quote (office only)', type: 'textarea', placeholder: 'Breaker 20A x2, needs quote for surge protector…', hint: 'Sent to the office with a [Field] stamp — never shown to the customer.' },
      ],
      confirmText: 'Mark complete',
    });
    if (res === null) return;
    const body = {
      completed_date: (res.date || '').trim() || todayStr(),
      notes: (res.notes || '').trim() || null,
      internal_note: (res.internal || '').trim() || null,
      parts_note: (res.parts || '').trim() || null,
    };
    try {
      const r = await BatesAuth.authFetch(`${TECH_BASE}/my-visits/${id}/complete`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) { showStatus(`Could not mark complete: ${data.error || ('HTTP ' + r.status)}`, 'error'); return; }
      showStatus('Visit marked complete. Nice work!', 'success');
      closeDetail();
      loadVisits();
    } catch (e) {
      console.error('complete failed', e);
      showStatus(`Failed: ${e.message}`, 'error');
    }
  }

  // ---- Init ----
  document.getElementById('tvd-back').addEventListener('click', closeDetail);
  document.getElementById('tvd').addEventListener('click', (e) => {
    if (e.target === document.getElementById('tvd')) closeDetail();
  });

  (async () => {
    const profile = await checkRole();
    if (profile === null) return; // redirected to /home
    renderHero(profile || {});
    loadVisits();
  })();
})();
