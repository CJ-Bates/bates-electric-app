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
  function todayStr() { return new Date().toISOString().slice(0, 10); }
  function localDateOf(v) {
    // The visit's effective date for grouping: booked appointment, else due date.
    const src = v.appointment_at || v.scheduled_date;
    if (!src) return null;
    const dt = new Date(String(src).length <= 10 ? src + 'T00:00:00' : src);
    return isNaN(dt) ? null : dt.toISOString().slice(0, 10);
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
  async function checkRole() {
    try {
      const r = await BatesAuth.authFetch(`${API_BASE}/me`, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) throw new Error('profile');
      const { profile } = await r.json();
      if (profile.role !== 'tech') {
        // Office (or anyone else) belongs on the office hub, not the field view.
        window.location.replace('/home');
        return false;
      }
      const sub = document.getElementById('tv-sub');
      if (sub && profile.full_name) sub.textContent = `Assigned visits for ${profile.full_name}.`;
      return true;
    } catch (e) {
      console.error('role check failed', e);
      return true; // fail open to the list; the API is still tech-gated.
    }
  }

  // ---- List ----
  async function loadVisits() {
    const list = document.getElementById('tv-list');
    try {
      const r = await BatesAuth.authFetch(`${TECH_BASE}/my-visits`, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const { visits } = await r.json();
      renderList(visits || []);
    } catch (e) {
      console.error('load visits failed', e);
      list.innerHTML = `<p class="tv-empty">Couldn't load your visits. Pull to refresh or try again.</p>`;
    }
  }

  function visitStatus(v) {
    if (v.completed_date || v.status === 'completed') return 'done';
    if (v.appointment_at) return 'scheduled';
    return 'need';
  }

  function renderList(visits) {
    const list = document.getElementById('tv-list');
    if (!visits.length) {
      list.innerHTML = `<div class="tv-empty"><div class="tv-empty-icon">${BatesIcons.icon('check', 24)}</div>No visits assigned to you right now.<br>The office will dispatch visits here.</div>`;
      return;
    }
    const today = todayStr();
    const open = visits.filter((v) => visitStatus(v) !== 'done');
    const done = visits.filter((v) => visitStatus(v) === 'done')
      .sort((a, b) => String(b.completed_date || '').localeCompare(String(a.completed_date || '')))
      .slice(0, 10);
    const todayList = open.filter((v) => localDateOf(v) && localDateOf(v) <= today);
    const upcoming = open.filter((v) => !localDateOf(v) || localDateOf(v) > today);

    let html = '';
    html += groupHtml('Today / overdue', todayList);
    html += groupHtml('Upcoming', upcoming);
    html += groupHtml('Recently completed', done);
    list.innerHTML = html || `<div class="tv-empty">No visits assigned to you right now.</div>`;

    list.querySelectorAll('[data-visit]').forEach((el) => {
      el.addEventListener('click', () => openVisit(el.getAttribute('data-visit')));
    });
  }

  function groupHtml(title, items) {
    if (!items.length) return '';
    const rows = items.map((v) => {
      const cust = (v.subscription && v.subscription.customer && v.subscription.customer.name) || 'Customer';
      const st = visitStatus(v);
      let chip, when;
      if (st === 'done') {
        chip = `<span class="badge badge-neutral">Completed${v.completed_date ? ' ' + fmtDate(v.completed_date) : ''}</span>`;
        when = '';
      } else if (st === 'scheduled') {
        chip = `<span class="badge badge-ok">Scheduled</span>`;
        when = `<div class="tv-meta">${esc(fmtDateTime(v.appointment_at))}</div>`;
      } else {
        chip = `<span class="badge badge-warn">Needs scheduling</span>`;
        when = v.scheduled_date ? `<div class="tv-meta">Due ${esc(fmtDate(v.scheduled_date))}</div>` : '';
      }
      const addr = (v.subscription && v.subscription.customer)
        ? [v.subscription.customer.install_city, v.subscription.customer.install_state].filter(Boolean).join(', ')
        : '';
      return `<div class="tv-card" data-visit="${esc(v.id)}">
        <div class="tv-card-top">
          <div>
            <div class="tv-cust">${esc(cust)}</div>
            ${addr ? `<div class="tv-meta">${esc(addr)}</div>` : ''}
            ${when}
          </div>
          <div>${chip}</div>
        </div>
      </div>`;
    }).join('');
    return `<div class="tv-group"><div class="tv-group-h">${esc(title)}</div>${rows}</div>`;
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
    else if (v.appointment_at) when = `Scheduled ${fmtDateTime(v.appointment_at)}`;
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
  async function rescheduleVisit(v) {
    const hasAppt = !!v.appointment_at;
    const res = await openPrompt({
      title: hasAppt ? 'Reschedule visit' : 'Book time',
      message: 'Pick the date and time you\'ll be on site.',
      fields: [{ name: 'when', label: 'New date & time', type: 'datetime-local', value: hasAppt ? toLocalInput(v.appointment_at) : '', required: true }],
      validate: (vals) => isNaN(new Date(vals.when).getTime()) ? 'Enter a valid date and time.' : '',
      confirmText: hasAppt ? 'Reschedule' : 'Book',
    });
    if (res === null) return;
    const when = new Date(res.when);
    if (isNaN(when.getTime())) { showStatus('That date and time didn\'t parse — try again.', 'error'); return; }
    try {
      const r = await BatesAuth.authFetch(`${TECH_BASE}/my-visits/${v.id}/schedule`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ appointment_at: when.toISOString() }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) { showStatus(`Could not reschedule: ${data.error || ('HTTP ' + r.status)}`, 'error'); return; }
      showStatus(`Visit scheduled for ${fmtDateTime(data.visit && data.visit.appointment_at ? data.visit.appointment_at : when.toISOString())}.`, 'success');
      loadVisits();
      openVisit(v.id); // re-fetch so the detail shows the new time
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
    const ok = await checkRole();
    if (ok) loadVisits();
  })();
})();
