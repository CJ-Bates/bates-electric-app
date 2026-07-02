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
  if (!token) { window.location.replace('index.html'); return; }

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

  // ---- Role guard: this view is for techs ----
  async function checkRole() {
    try {
      const r = await BatesAuth.authFetch(`${API_BASE}/me`, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) throw new Error('profile');
      const { profile } = await r.json();
      if (profile.role !== 'tech') {
        // Office (or anyone else) belongs on the office hub, not the field view.
        window.location.replace('home.html');
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
      </div>

      ${(v.notes || v.internal_note) ? `<div class="tvd-sec">
        <h3>Notes</h3>
        ${v.notes ? `<div style="margin-bottom:${v.internal_note ? '10px' : '0'}"><div class="k" style="font-size:0.78rem;color:var(--ink-2);margin-bottom:3px;">Customer-visible</div><div class="tvd-note">${esc(v.notes)}</div></div>` : ''}
        ${v.internal_note ? `<div><div class="k" style="font-size:0.78rem;color:var(--warn);margin-bottom:3px;">Internal (not shown to customer)</div><div class="tvd-note tvd-note-internal">${esc(v.internal_note)}</div></div>` : ''}
      </div>` : ''}

      <div class="tvd-cta">
        ${done
          ? `<div class="tvd-done-banner">Completed ${esc(fmtDate(v.completed_date))}${v.completed_by ? ' by ' + esc(v.completed_by) : ''}</div>`
          : `<button class="btn btn-primary tvd-complete" id="tvd-complete-btn">Mark visit complete</button>`}
      </div>
    `;

    const btn = document.getElementById('tvd-complete-btn');
    if (btn) btn.addEventListener('click', () => completeVisit(v.id));
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
      ],
      confirmText: 'Mark complete',
    });
    if (res === null) return;
    const body = {
      completed_date: (res.date || '').trim() || todayStr(),
      notes: (res.notes || '').trim() || null,
      internal_note: (res.internal || '').trim() || null,
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
