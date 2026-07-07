// frontend/members.js
// Members area — office-only. Field-tech management lives here (moved out of
// the Generator Care dashboard); office staff + customer management arrive
// with the roles/permissions work. Uses the existing backend endpoints under
// /api/generator-care/techs (relocating them to /api/members is future backend
// work — behavior is identical either way).

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

  const escapeHtml = window.BatesUI.escapeHtml;

  let techList = [];

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
      }
    } catch (err) {
      console.error('Role check failed:', err);
    }
  }

  // ---- Field techs (same endpoints + behavior as the old GC modal) ----
  async function loadTechs() {
    try {
      const r = await BatesAuth.authFetch(`${API_BASE}/api/generator-care/techs`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      techList = data.techs || [];
    } catch (e) {
      console.error('loadTechs failed', e);
      showStatus(`Couldn't load techs: ${e.message}`, 'error');
    }
  }

  function renderTechsList() {
    const el = document.getElementById('techs-list');
    if (!el) return;
    if (!techList.length) { el.innerHTML = '<p class="gc-meta-label">No tech accounts yet.</p>'; return; }
    el.innerHTML = techList.map((t) => {
      const inactive = t.active === false;
      return `<div class="gc-card-row" style="display:flex;justify-content:space-between;align-items:center;gap:8px;${inactive ? 'opacity:0.6;' : ''}">
        <div>
          <div class="gc-meta-value">${escapeHtml(t.full_name || '(no name)')}${inactive ? ' <span class="gc-meta-label">\u2014 inactive</span>' : ''}</div>
          <div class="gc-meta-label">${escapeHtml(t.email)}</div>
        </div>
        <div style="display:flex;gap:6px;flex-shrink:0;">
          <button class="btn btn-secondary btn-sm" data-resend-tech="${escapeHtml(t.id)}">Resend link</button>
          <button class="btn ${inactive ? 'btn-primary' : 'btn-secondary'} btn-sm" data-toggle-tech="${escapeHtml(t.id)}" data-active="${inactive ? '1' : '0'}">${inactive ? 'Reactivate' : 'Deactivate'}</button>
        </div>
      </div>`;
    }).join('');
    el.querySelectorAll('[data-toggle-tech]').forEach((b) => {
      b.addEventListener('click', () => setTechActive(b.dataset.toggleTech, b.dataset.active === '1'));
    });
    el.querySelectorAll('[data-resend-tech]').forEach((b) => {
      b.addEventListener('click', () => resendTechInvite(b.dataset.resendTech));
    });
  }

  async function refresh() {
    document.getElementById('techs-list').innerHTML = '<p class="gc-meta-label">Loading\u2026</p>';
    await loadTechs();
    renderTechsList();
  }

  async function addTech() {
    const name = (document.getElementById('new-tech-name').value || '').trim();
    const email = (document.getElementById('new-tech-email').value || '').trim();
    if (!name || !email) { showStatus('Enter a name and email.', 'error'); return; }
    try {
      const r = await BatesAuth.authFetch(`${API_BASE}/api/generator-care/techs`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) { showStatus(data.error || `HTTP ${r.status}`, 'error'); return; }
      showStatus(data.warning || `Invited ${name}. They'll get a set-password email.`, data.warning ? 'warning' : 'success');
      document.getElementById('new-tech-name').value = '';
      document.getElementById('new-tech-email').value = '';
      await refresh();
    } catch (e) {
      console.error('add tech failed', e);
      showStatus(`Failed: ${e.message}`, 'error');
    }
  }

  async function setTechActive(id, active) {
    try {
      const r = await BatesAuth.authFetch(`${API_BASE}/api/generator-care/techs/${id}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ active }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) { showStatus(data.error || `HTTP ${r.status}`, 'error'); return; }
      showStatus(active ? 'Tech reactivated.' : 'Tech deactivated.', 'success');
      await refresh();
    } catch (e) {
      console.error('toggle tech failed', e);
      showStatus(`Failed: ${e.message}`, 'error');
    }
  }

  async function resendTechInvite(id) {
    try {
      const r = await BatesAuth.authFetch(`${API_BASE}/api/generator-care/techs/${id}/resend-invite`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) { showStatus(data.error || `HTTP ${r.status}`, 'error'); return; }
      showStatus('Set-password link re-sent.', 'success');
    } catch (e) {
      console.error('resend invite failed', e);
      showStatus(`Failed: ${e.message}`, 'error');
    }
  }

  // ---- Init ----
  checkRole();
  refresh();
  document.getElementById('refresh-btn').addEventListener('click', refresh);
  document.getElementById('add-tech-btn').addEventListener('click', addTech);
})();
