// frontend/members.js
// Members area. Admins see everything: office staff (invite-only accounts +
// per-member permission toggles + admin/deactivate controls), field techs
// (with the per-tech self-scheduling flag), and customer portal accounts
// (revoke access / resend sign-in info). A non-admin office member with the
// tech_manage flag sees only the Field Techs section; anyone else gets a
// friendly no-access card. All gating is re-enforced server-side.

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

  const OFFICE_FLAGS = [
    { key: 'accounting',      label: 'Accounting',      hint: 'Accounting tab + payout data' },
    { key: 'refunds',         label: 'Refunds',         hint: 'Refund + cancel controls' },
    { key: 'billing_actions', label: 'Billing actions', hint: 'Add-on charges, adhoc charges, plan/tier changes, fleet' },
    { key: 'customer_edit',   label: 'Customer edit',   hint: 'Contact, generator, and notes editing' },
    { key: 'tech_manage',     label: 'Tech manage',     hint: 'Create/deactivate techs, assign visits' },
  ];

  let me = null;          // profile from /me (with permissions + is_admin)
  let isAdmin = false;
  let staffList = [];     // office members (admin view, from /api/members)
  let techList = [];      // techs - admin view: from /api/members; else /api/generator-care/techs
  let customerList = [];
  let openPanelId = null; // which staff member's manage panel is expanded

  const authHeaders = (json) => {
    const h = { Authorization: `Bearer ${token}` };
    if (json) h['Content-Type'] = 'application/json';
    return h;
  };

  const fmtStamp = (iso) => {
    if (!iso) return 'never';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return 'never';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  };

  async function api(path, opts) {
    const r = await BatesAuth.authFetch(`${API_BASE}${path}`, opts);
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    return data;
  }

  // ---- Who am I / which sections show ----
  async function loadMe() {
    const { profile } = await api('/me', { headers: authHeaders() });
    if (profile.role !== 'office') {
      showStatus('Access denied. Office role required.', 'error');
      setTimeout(() => window.location.replace('/home'), 1500);
      return null;
    }
    return profile;
  }

  function show(id, on) {
    const el = document.getElementById(id);
    if (el) el.hidden = !on;
  }

  // ---- Office staff (admin) ----
  function staffChips(m) {
    if (m.is_admin) return '<span class="chip">Admin \u2014 full access</span>';
    const p = m.permissions || {};
    const granted = OFFICE_FLAGS.filter((f) => p[f.key] === true);
    if (granted.length === OFFICE_FLAGS.length) return '<span class="chip chip-neutral">Full access</span>';
    if (!granted.length) return '<span class="chip chip-neutral">No permissions</span>';
    return granted.map((f) => `<span class="chip chip-neutral">${escapeHtml(f.label)}</span>`).join(' ');
  }

  function staffPanelHtml(m) {
    const p = m.permissions || {};
    const isSelf = me && m.id === me.id;
    const toggles = OFFICE_FLAGS.map((f) => `
      <label style="display:flex;align-items:flex-start;gap:8px;padding:6px 0;cursor:pointer;">
        <input type="checkbox" data-perm="${f.key}" data-member="${escapeHtml(m.id)}"${p[f.key] ? ' checked' : ''}${m.is_admin ? ' disabled' : ''} style="margin-top:2px;" />
        <span><span class="gc-meta-value" style="display:block;">${escapeHtml(f.label)}</span>
        <span class="gc-meta-label">${escapeHtml(f.hint)}</span></span>
      </label>`).join('');
    return `<div class="gc-card-row" data-panel-for="${escapeHtml(m.id)}" style="display:block;background:var(--surface-2, rgba(27,45,91,0.03));border-radius:8px;padding:10px 12px;">
      ${m.is_admin ? '<p class="gc-meta-label" style="margin:0 0 4px;">Admins have every permission; demote to use individual toggles.</p>' : ''}
      ${toggles}
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:10px;">
        <button class="btn btn-secondary btn-sm" data-resend-staff="${escapeHtml(m.id)}">Resend set-password link</button>
        <button class="btn btn-secondary btn-sm" data-toggle-admin="${escapeHtml(m.id)}" data-make="${m.is_admin ? '0' : '1'}">${m.is_admin ? 'Remove admin' : 'Make admin'}</button>
        ${isSelf ? '' : `<button class="btn ${m.active === false ? 'btn-primary' : 'btn-danger-soft'} btn-sm" data-toggle-staff="${escapeHtml(m.id)}" data-active="${m.active === false ? '1' : '0'}">${m.active === false ? 'Reactivate' : 'Deactivate'}</button>`}
      </div>
    </div>`;
  }

  function renderStaffList() {
    const el = document.getElementById('staff-list');
    if (!el) return;
    if (!staffList.length) { el.innerHTML = '<p class="gc-meta-label">No office accounts yet.</p>'; return; }
    el.innerHTML = staffList.map((m) => {
      const inactive = m.active === false;
      const open = openPanelId === m.id;
      return `<div class="gc-card-row" style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;${inactive ? 'opacity:0.6;' : ''}">
        <div style="min-width:200px;">
          <div class="gc-meta-value">${escapeHtml(m.full_name || '(no name)')}${inactive ? ' <span class="gc-meta-label">\u2014 deactivated</span>' : ''}</div>
          <div class="gc-meta-label">${escapeHtml(m.email)} &middot; last sign-in ${escapeHtml(fmtStamp(m.last_sign_in_at))}</div>
          <div style="margin-top:4px;display:flex;gap:4px;flex-wrap:wrap;">${staffChips(m)}</div>
        </div>
        <div style="flex-shrink:0;">
          <button class="btn ${open ? 'btn-primary' : 'btn-secondary'} btn-sm" data-manage-staff="${escapeHtml(m.id)}">${open ? 'Close' : 'Manage'}</button>
        </div>
      </div>${open ? staffPanelHtml(m) : ''}`;
    }).join('');

    el.querySelectorAll('[data-manage-staff]').forEach((b) => {
      b.addEventListener('click', () => {
        openPanelId = openPanelId === b.dataset.manageStaff ? null : b.dataset.manageStaff;
        renderStaffList();
      });
    });
    el.querySelectorAll('[data-perm]').forEach((cb) => {
      cb.addEventListener('change', () => setPermission(cb.dataset.member, cb.dataset.perm, cb.checked, cb));
    });
    el.querySelectorAll('[data-resend-staff]').forEach((b) => {
      b.addEventListener('click', () => resendStaffInvite(b.dataset.resendStaff));
    });
    el.querySelectorAll('[data-toggle-admin]').forEach((b) => {
      b.addEventListener('click', () => toggleAdmin(b.dataset.toggleAdmin, b.dataset.make === '1'));
    });
    el.querySelectorAll('[data-toggle-staff]').forEach((b) => {
      b.addEventListener('click', () => setStaffActive(b.dataset.toggleStaff, b.dataset.active === '1'));
    });
  }

  async function inviteStaff() {
    const name = (document.getElementById('new-staff-name').value || '').trim();
    const email = (document.getElementById('new-staff-email').value || '').trim();
    if (!name || !email) { showStatus('Enter a name and email.', 'error'); return; }
    try {
      const data = await api('/api/members/invite', {
        method: 'POST', headers: authHeaders(true), body: JSON.stringify({ name, email }),
      });
      if (data.warning) showStatus(data.warning, 'warning');
      else openSuccessFlash({ title: 'Member invited', message: `Invited ${name}. They'll get a set-password email.` });
      document.getElementById('new-staff-name').value = '';
      document.getElementById('new-staff-email').value = '';
      await refresh();
    } catch (e) {
      showStatus(`Invite failed: ${e.message}`, 'error');
    }
  }

  async function setPermission(memberId, flag, value, cb) {
    try {
      const body = {}; body[flag] = value;
      const data = await api(`/api/members/${memberId}/permissions`, {
        method: 'PATCH', headers: authHeaders(true), body: JSON.stringify(body),
      });
      const member = staffList.concat(techList).find((m) => m.id === memberId);
      if (member) member.permissions = data.permissions;
      renderStaffList();
      renderTechsList();
      showStatus('Permissions updated.', 'success');
    } catch (e) {
      if (cb) cb.checked = !value; // roll back the optimistic tick
      showStatus(`Couldn't update permissions: ${e.message}`, 'error');
    }
  }

  async function resendStaffInvite(id) {
    try {
      await api(`/api/members/${id}/resend-invite`, { method: 'POST', headers: authHeaders(true) });
      showStatus('Set-password link sent.', 'success');
    } catch (e) {
      showStatus(`Failed: ${e.message}`, 'error');
    }
  }

  async function toggleAdmin(id, makeAdmin) {
    const m = staffList.find((s) => s.id === id);
    const who = (m && (m.full_name || m.email)) || 'this member';
    const ok = await openConfirm({
      title: makeAdmin ? 'Make admin?' : 'Remove admin?',
      message: makeAdmin
        ? `${who} will get full access to everything, including member management.`
        : `${who} will lose member management and fall back to their permission toggles.`,
      confirmText: makeAdmin ? 'Make admin' : 'Remove admin',
      danger: !makeAdmin,
    });
    if (!ok) return;
    try {
      await api(`/api/members/${id}/admin`, {
        method: 'POST', headers: authHeaders(true), body: JSON.stringify({ is_admin: makeAdmin }),
      });
      showStatus(makeAdmin ? 'Member is now an admin.' : 'Admin removed.', 'success');
      await refresh();
    } catch (e) {
      showStatus(`Failed: ${e.message}`, 'error');
    }
  }

  async function setStaffActive(id, active) {
    if (!active) {
      const m = staffList.find((s) => s.id === id);
      const who = (m && (m.full_name || m.email)) || 'this member';
      const ok = await openConfirm({
        title: 'Deactivate member?',
        message: `${who} won't be able to sign in until reactivated. Their account and history are kept.`,
        confirmText: 'Deactivate', danger: true,
      });
      if (!ok) return;
    }
    try {
      await api(`/api/members/${id}`, {
        method: 'PATCH', headers: authHeaders(true), body: JSON.stringify({ active }),
      });
      openSuccessFlash(active
        ? { title: 'Member reactivated', message: 'They can sign in again.' }
        : { title: 'Member deactivated', message: "They can't sign in until reactivated." });
      await refresh();
    } catch (e) {
      showStatus(`Failed: ${e.message}`, 'error');
    }
  }

  // ---- Field techs (same endpoints + behavior as before; admin extras) ----
  async function loadTechsBasic() {
    const data = await api('/api/generator-care/techs', { headers: authHeaders() });
    techList = data.techs || [];
  }

  function renderTechsList() {
    const el = document.getElementById('techs-list');
    if (!el) return;
    if (!techList.length) { el.innerHTML = '<p class="gc-meta-label">No tech accounts yet.</p>'; return; }
    el.innerHTML = techList.map((t) => {
      const inactive = t.active === false;
      // Self-scheduling toggle: admin view only (t.permissions present there).
      const selfSched = t.permissions
        ? `<label class="gc-meta-label" style="display:inline-flex;align-items:center;gap:6px;margin-top:4px;cursor:pointer;">
             <input type="checkbox" data-perm="tech_reschedule" data-member="${escapeHtml(t.id)}"${t.permissions.tech_reschedule ? ' checked' : ''} />
             Can book/move their own appointments</label>`
        : '';
      const lastSeen = t.permissions ? ` &middot; last sign-in ${escapeHtml(fmtStamp(t.last_sign_in_at))}` : '';
      return `<div class="gc-card-row" style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;${inactive ? 'opacity:0.6;' : ''}">
        <div style="min-width:200px;">
          <div class="gc-meta-value">${escapeHtml(t.full_name || '(no name)')}${inactive ? ' <span class="gc-meta-label">\u2014 inactive</span>' : ''}</div>
          <div class="gc-meta-label">${escapeHtml(t.email)}${lastSeen}</div>
          ${selfSched}
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
    el.querySelectorAll('[data-perm]').forEach((cb) => {
      cb.addEventListener('change', () => setPermission(cb.dataset.member, cb.dataset.perm, cb.checked, cb));
    });
  }

  async function addTech() {
    const name = (document.getElementById('new-tech-name').value || '').trim();
    const email = (document.getElementById('new-tech-email').value || '').trim();
    if (!name || !email) { showStatus('Enter a name and email.', 'error'); return; }
    try {
      const data = await api('/api/generator-care/techs', {
        method: 'POST', headers: authHeaders(true), body: JSON.stringify({ name, email }),
      });
      if (data.warning) showStatus(data.warning, 'warning');
      else openSuccessFlash({ title: 'Tech invited', message: `Invited ${name}. They'll get a set-password email.` });
      document.getElementById('new-tech-name').value = '';
      document.getElementById('new-tech-email').value = '';
      await refresh();
    } catch (e) {
      showStatus(`Failed: ${e.message}`, 'error');
    }
  }

  async function setTechActive(id, active) {
    try {
      await api(`/api/generator-care/techs/${id}`, {
        method: 'PATCH', headers: authHeaders(true), body: JSON.stringify({ active }),
      });
      openSuccessFlash(active
        ? { title: 'Tech reactivated', message: 'They can sign in again.' }
        : { title: 'Tech deactivated', message: "They can't sign in until reactivated." });
      await refresh();
    } catch (e) {
      showStatus(`Failed: ${e.message}`, 'error');
    }
  }

  async function resendTechInvite(id) {
    try {
      await api(`/api/generator-care/techs/${id}/resend-invite`, { method: 'POST', headers: authHeaders(true) });
      showStatus('Set-password link re-sent.', 'success');
    } catch (e) {
      showStatus(`Failed: ${e.message}`, 'error');
    }
  }

  // ---- Customer portal accounts (admin) ----
  function renderCustomersList() {
    const el = document.getElementById('customers-list');
    if (!el) return;
    if (!customerList.length) { el.innerHTML = '<p class="gc-meta-label">No customer portal accounts yet.</p>'; return; }
    el.innerHTML = customerList.map((c) => {
      const revoked = c.active === false;
      return `<div class="gc-card-row" style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;${revoked ? 'opacity:0.6;' : ''}">
        <div style="min-width:200px;">
          <div class="gc-meta-value">${escapeHtml(c.full_name || c.email)}${revoked ? ' <span class="chip chip-neutral" style="margin-left:6px;">Access revoked</span>' : ''}</div>
          <div class="gc-meta-label">${escapeHtml(c.email)} &middot; portal account since ${escapeHtml(fmtStamp(c.created_at))} &middot; last sign-in ${escapeHtml(fmtStamp(c.last_sign_in_at))}</div>
        </div>
        <div style="display:flex;gap:6px;flex-shrink:0;">
          ${revoked ? '' : `<button class="btn btn-secondary btn-sm" data-resend-signin="${escapeHtml(c.id)}">Resend sign-in info</button>`}
          <button class="btn ${revoked ? 'btn-primary' : 'btn-danger-soft'} btn-sm" data-toggle-customer="${escapeHtml(c.id)}" data-active="${revoked ? '1' : '0'}">${revoked ? 'Restore access' : 'Revoke access'}</button>
        </div>
      </div>`;
    }).join('');
    el.querySelectorAll('[data-toggle-customer]').forEach((b) => {
      b.addEventListener('click', () => setCustomerActive(b.dataset.toggleCustomer, b.dataset.active === '1'));
    });
    el.querySelectorAll('[data-resend-signin]').forEach((b) => {
      b.addEventListener('click', () => resendSignin(b.dataset.resendSignin, b));
    });
  }

  async function setCustomerActive(id, active) {
    if (!active) {
      const c = customerList.find((x) => x.id === id);
      const who = (c && (c.full_name || c.email)) || 'this customer';
      const ok = await openConfirm({
        title: 'Revoke portal access?',
        message: `${who} won't be able to sign in to my.bates-electric.com until access is restored. Their subscription and service are NOT affected.`,
        confirmText: 'Revoke access', danger: true,
      });
      if (!ok) return;
    }
    try {
      await api(`/api/members/customers/${id}`, {
        method: 'PATCH', headers: authHeaders(true), body: JSON.stringify({ active }),
      });
      showStatus(active ? 'Portal access restored.' : 'Portal access revoked.', 'success');
      await refresh();
    } catch (e) {
      showStatus(`Failed: ${e.message}`, 'error');
    }
  }

  async function resendSignin(id, btn) {
    if (btn) btn.disabled = true;
    try {
      await api(`/api/members/customers/${id}/resend-signin`, { method: 'POST', headers: authHeaders(true) });
      showStatus('Sign-in instructions sent.', 'success');
    } catch (e) {
      showStatus(`Failed: ${e.message}`, 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  // ---- Load + render everything the caller may see ----
  async function refresh() {
    try {
      if (isAdmin) {
        const [membersData, customersData] = await Promise.all([
          api('/api/members', { headers: authHeaders() }),
          api('/api/members/customers', { headers: authHeaders() }),
        ]);
        const members = membersData.members || [];
        staffList = members.filter((m) => m.role === 'office');
        techList = members.filter((m) => m.role === 'tech');
        customerList = customersData.customers || [];
        renderStaffList();
        renderTechsList();
        renderCustomersList();
      } else {
        await loadTechsBasic();
        renderTechsList();
      }
    } catch (e) {
      console.error('members refresh failed', e);
      showStatus(`Couldn't load members: ${e.message}`, 'error');
    }
  }

  // ---- Init ----
  async function init() {
    try {
      me = await loadMe();
    } catch (e) {
      console.error('profile load failed', e);
      showStatus('Could not load your profile.', 'error');
      return;
    }
    if (!me) return;
    isAdmin = me.is_admin === true;
    const canManageTechs = isAdmin || !!(me.permissions && me.permissions.tech_manage);
    show('staff-section', isAdmin);
    show('customers-section', isAdmin);
    show('techs-section', canManageTechs);
    show('no-access-section', !isAdmin && !canManageTechs);
    if (isAdmin || canManageTechs) await refresh();
  }

  init();
  document.getElementById('refresh-btn').addEventListener('click', refresh);
  document.getElementById('add-tech-btn').addEventListener('click', addTech);
  document.getElementById('invite-staff-btn').addEventListener('click', inviteStaff);
})();
