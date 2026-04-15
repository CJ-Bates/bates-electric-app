(() => {
  const API_BASE = (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
    ? 'http://localhost:4000'
    : 'https://bates-electric-app.onrender.com';

  const TOKEN_KEY = 'bates.auth.token';
  const PROFILE_KEY = 'bates.profile';
  const THEME_KEY = 'bates.theme';

  const getToken = () =>
    localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY);

  const clearToken = () => {
    localStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(TOKEN_KEY);
  };

  const redirectToLogin = () => {
    window.location.replace('index.html');
  };

  // --- Toast ---
  let toastTimer = null;
  function toast(message) {
    const el = document.getElementById('settings-toast');
    if (!el) return;
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
  }

  // Current in-memory profile for modal defaults
  let currentProfile = null;

  // --- Profile ---
  function renderProfile(profile) {
    currentProfile = profile;
    const nameEl = document.getElementById('profile-name');
    const emailEl = document.getElementById('profile-email');
    const roleEl = document.getElementById('profile-role');

    const displayName = profile.full_name || (profile.email ? profile.email.split('@')[0] : 'User');
    if (nameEl) nameEl.textContent = displayName;
    if (emailEl) emailEl.textContent = profile.email || '';
    if (roleEl && profile.role) {
      roleEl.textContent = profile.role === 'office' ? 'Office' : 'Technician';
      roleEl.hidden = false;
    }
  }

  async function loadProfile() {
    // Hydrate from cache first for instant render
    try {
      const cached = JSON.parse(localStorage.getItem(PROFILE_KEY) || 'null');
      if (cached && cached.email) renderProfile(cached);
    } catch (e) {}

    const token = getToken();
    if (!token) return redirectToLogin();

    try {
      const res = await fetch(`${API_BASE}/me`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status === 401) {
        clearToken();
        return redirectToLogin();
      }
      if (!res.ok) return; // keep cached view
      const { profile } = await res.json();
      try { localStorage.setItem(PROFILE_KEY, JSON.stringify(profile)); } catch (e) {}
      renderProfile(profile);
    } catch (err) {
      // Offline — cached render is fine
    }
  }

  // --- Theme ---
  function applyTheme(theme) {
    if (theme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }

  function initTheme() {
    const saved = localStorage.getItem(THEME_KEY) || 'light';
    applyTheme(saved);
    const toggle = document.getElementById('theme-toggle');
    if (!toggle) return;
    toggle.checked = saved === 'dark';
    toggle.addEventListener('change', () => {
      const next = toggle.checked ? 'dark' : 'light';
      try { localStorage.setItem(THEME_KEY, next); } catch (e) {}
      applyTheme(next);
    });
  }

  // --- App version ---
  async function loadVersion() {
    const el = document.getElementById('app-version');
    if (!el) return;
    try {
      const res = await fetch('service-worker.js', { cache: 'no-store' });
      if (!res.ok) throw new Error();
      const text = await res.text();
      const match = text.match(/CACHE\s*=\s*['"]([^'"]+)['"]/);
      el.textContent = match ? match[1] : 'unknown';
    } catch {
      el.textContent = 'unknown';
    }
  }

  // --- Updates / cache ---
  async function checkForUpdates() {
    toast('Checking for updates…');
    try {
      if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map((r) => r.update()));
      }
    } catch (e) {}
    setTimeout(() => window.location.reload(), 400);
  }

  async function clearCache() {
    const ok = window.confirm('Clear offline cache and reload? Any unsaved drafts stay in place.');
    if (!ok) return;
    toast('Clearing cache…');
    try {
      if ('caches' in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      }
      if ('serviceWorker' in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map((r) => r.unregister()));
      }
    } catch (e) {}
    setTimeout(() => window.location.reload(), 400);
  }

  // --- Modal helpers ---
  function openModal(id) {
    const el = document.getElementById(id);
    if (el) el.classList.add('open');
  }
  function closeModal(id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.remove('open');
    // Reset forms and errors on close
    const form = el.querySelector('form');
    if (form) form.reset();
    const err = el.querySelector('.settings-modal-error');
    if (err) { err.hidden = true; err.textContent = ''; }
  }
  function showModalError(errorId, message) {
    const el = document.getElementById(errorId);
    if (!el) return;
    el.textContent = message;
    el.hidden = false;
  }

  // --- Edit profile ---
  function openEditProfile() {
    if (!currentProfile) return;
    const nameInput = document.getElementById('edit-profile-name');
    const emailInput = document.getElementById('edit-profile-email-input');
    if (nameInput) nameInput.value = currentProfile.full_name || '';
    if (emailInput) emailInput.value = currentProfile.email || '';
    const err = document.getElementById('edit-profile-error');
    if (err) { err.hidden = true; err.textContent = ''; }
    openModal('edit-profile-modal');
    setTimeout(() => nameInput && nameInput.focus(), 50);
  }

  async function saveProfile(e) {
    e.preventDefault();
    const nameInput = document.getElementById('edit-profile-name');
    const saveBtn = document.getElementById('edit-profile-save');
    const full_name = (nameInput.value || '').trim();
    if (full_name.length < 1) {
      showModalError('edit-profile-error', 'Name cannot be empty.');
      return;
    }

    const token = getToken();
    if (!token) return redirectToLogin();

    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    try {
      const res = await fetch(`${API_BASE}/me`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ full_name }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        showModalError('edit-profile-error', body.error || 'Could not save your changes.');
        return;
      }
      if (body.profile) {
        try { localStorage.setItem(PROFILE_KEY, JSON.stringify(body.profile)); } catch (e) {}
        renderProfile(body.profile);
      }
      closeModal('edit-profile-modal');
      toast('Profile updated');
    } catch (err) {
      showModalError('edit-profile-error', 'Network error. Please try again.');
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save';
    }
  }

  // --- Change password ---
  function openChangePassword() {
    const err = document.getElementById('change-password-error');
    if (err) { err.hidden = true; err.textContent = ''; }
    openModal('change-password-modal');
    setTimeout(() => {
      const cur = document.getElementById('cp-current');
      if (cur) cur.focus();
    }, 50);
  }

  async function submitPasswordChange(e) {
    e.preventDefault();
    const currentInput = document.getElementById('cp-current');
    const newInput = document.getElementById('cp-new');
    const confirmInput = document.getElementById('cp-confirm');
    const saveBtn = document.getElementById('change-password-save');

    const current_password = currentInput.value;
    const new_password = newInput.value;
    const confirm_password = confirmInput.value;

    if (!current_password || !new_password || !confirm_password) {
      showModalError('change-password-error', 'Fill in all three fields.');
      return;
    }
    if (new_password.length < 8) {
      showModalError('change-password-error', 'New password must be at least 8 characters.');
      return;
    }
    if (new_password !== confirm_password) {
      showModalError('change-password-error', 'New passwords do not match.');
      return;
    }
    if (new_password === current_password) {
      showModalError('change-password-error', 'New password must differ from the current one.');
      return;
    }

    const token = getToken();
    if (!token) return redirectToLogin();

    saveBtn.disabled = true;
    saveBtn.textContent = 'Updating…';
    try {
      const res = await fetch(`${API_BASE}/auth/change-password`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ current_password, new_password }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        showModalError('change-password-error', body.error || 'Could not update password.');
        return;
      }
      closeModal('change-password-modal');
      toast('Password updated');
    } catch (err) {
      showModalError('change-password-error', 'Network error. Please try again.');
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Update';
    }
  }

  // --- Sign out ---
  function signOut() {
    clearToken();
    try { localStorage.removeItem(PROFILE_KEY); } catch (e) {}
    redirectToLogin();
  }

  // --- Wire up ---
  function wire() {
    initTheme();
    loadProfile();
    loadVersion();

    const updateBtn = document.getElementById('check-updates-btn');
    if (updateBtn) updateBtn.addEventListener('click', checkForUpdates);

    const clearBtn = document.getElementById('clear-cache-btn');
    if (clearBtn) clearBtn.addEventListener('click', clearCache);

    const signoutBtn = document.getElementById('signout-btn');
    if (signoutBtn) signoutBtn.addEventListener('click', signOut);

    const editBtn = document.getElementById('edit-profile-btn');
    if (editBtn) editBtn.addEventListener('click', openEditProfile);

    const editForm = document.getElementById('edit-profile-form');
    if (editForm) editForm.addEventListener('submit', saveProfile);

    const changePwBtn = document.getElementById('change-password-btn');
    if (changePwBtn) changePwBtn.addEventListener('click', openChangePassword);

    const changePwForm = document.getElementById('change-password-form');
    if (changePwForm) changePwForm.addEventListener('submit', submitPasswordChange);

    // Close modals on backdrop click + any [data-modal-close] element
    document.querySelectorAll('.settings-modal-backdrop').forEach((bd) => {
      bd.addEventListener('click', (e) => {
        if (e.target === bd) closeModal(bd.id);
      });
    });
    document.querySelectorAll('[data-modal-close]').forEach((el) => {
      el.addEventListener('click', () => closeModal(el.dataset.modalClose));
    });
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      document.querySelectorAll('.settings-modal-backdrop.open').forEach((m) => closeModal(m.id));
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire);
  } else {
    wire();
  }
})();
