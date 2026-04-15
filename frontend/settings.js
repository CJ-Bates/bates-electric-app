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

  // --- Profile ---
  function renderProfile(profile) {
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
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire);
  } else {
    wire();
  }
})();
