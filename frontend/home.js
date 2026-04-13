(() => {
  const API_BASE = (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
    ? 'http://localhost:4000'
    : '';

  const TOKEN_KEY = 'bates.auth.token';

  const getToken = () =>
    localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY);

  const clearToken = () => {
    localStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(TOKEN_KEY);
  };

  const redirectToLogin = () => {
    window.location.replace('index.html');
  };

  // Tiles shared by everyone — placeholders wired up as we port Safety Hub sections.
  const SHARED_TILES = [
    { id: 'safety-docs',   icon: '§', title: 'Safety Documentation', desc: 'OSHA guides, policies, and procedures.', disabled: true },
    { id: 'sds',           icon: '☣', title: 'SDS Chemical Sheets',  desc: 'Safety Data Sheets for on-site chemicals.', disabled: true },
    { id: 'hazard-quiz',   icon: '?', title: 'Hazard Quiz',          desc: 'Test your electrical safety knowledge.', disabled: true },
    { id: 'wire-wizard',   icon: '⚡', title: 'Wire Wizard',           desc: 'Practice circuits and wiring scenarios.', disabled: true },
    { id: 'emergency',     icon: '!', title: 'Emergency Contacts',   desc: 'On-call numbers, hospitals, and site leads.', disabled: true },
  ];

  const TECH_TILE = {
    id: 'new-inspection',
    icon: '✓',
    title: 'New Inspection',
    desc: 'Start an electrical safety inspection report.',
    href: 'inspection.html',
    featured: true,
    hint: 'Primary tool',
  };

  const OFFICE_TILE = {
    id: 'inspection-dashboard',
    icon: '☰',
    title: 'Inspection Dashboard',
    desc: 'View and sort every submitted inspection report.',
    href: 'office.html',
    featured: true,
    hint: 'Office staff',
  };

  async function loadProfile() {
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
      if (!res.ok) throw new Error('Failed to load profile');
      const { profile } = await res.json();
      render(profile);
    } catch (err) {
      showError(err.message || 'Could not load your profile.');
    }
  }

  function render(profile) {
    const nameEl = document.getElementById('user-name');
    const roleEl = document.getElementById('user-role');
    const welcomeTitle = document.getElementById('welcome-title');
    const welcomeCopy = document.getElementById('welcome-copy');
    const subtitle = document.getElementById('hub-subtitle');

    const displayName = profile.full_name || profile.email.split('@')[0];
    nameEl.textContent = displayName;
    roleEl.textContent = profile.role === 'office' ? 'Office' : 'Tech';
    subtitle.textContent = profile.role === 'office' ? 'Office Hub' : 'Field Hub';

    welcomeTitle.textContent = `Welcome, ${displayName}`;
    welcomeCopy.textContent = profile.role === 'office'
      ? 'Review submitted inspections and manage field reports.'
      : 'Start a new inspection or review your recent reports.';

    // Office sees the dashboard as their primary tile plus a New Inspection
    // tile for when they need to create one themselves. Techs see New
    // Inspection as primary and no dashboard.
    const tiles = profile.role === 'office'
      ? [OFFICE_TILE, { ...TECH_TILE, featured: false, hint: 'Create a report' }, ...SHARED_TILES]
      : [TECH_TILE, ...SHARED_TILES];

    const grid = document.getElementById('tile-grid');
    grid.innerHTML = '';
    for (const t of tiles) {
      grid.appendChild(makeTile(t));
    }
  }

  function makeTile(t) {
    const el = document.createElement(t.disabled ? 'div' : 'a');
    el.className = 'tile' + (t.featured ? ' featured' : '') + (t.disabled ? ' disabled' : '');
    if (!t.disabled) {
      el.href = t.href;
      el.setAttribute('role', 'link');
    } else {
      el.setAttribute('aria-disabled', 'true');
    }
    el.innerHTML = `
      <div class="tile-icon" aria-hidden="true">${t.icon}</div>
      <h3 class="tile-title">${t.title}</h3>
      <p class="tile-desc">${t.desc}</p>
      <div class="tile-hint">${t.disabled ? 'Coming soon' : (t.hint || 'Open')}</div>
    `;
    return el;
  }

  function showError(msg) {
    const main = document.querySelector('.hub-main');
    const box = document.createElement('div');
    box.className = 'hub-error';
    box.textContent = msg;
    main.prepend(box);
  }

  document.getElementById('signout-btn').addEventListener('click', async () => {
    const token = getToken();
    if (token) {
      try {
        await fetch(`${API_BASE}/auth/logout`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
        });
      } catch (_) { /* ignore */ }
    }
    clearToken();
    redirectToLogin();
  });

  const isLocal = ['localhost', '127.0.0.1'].includes(location.hostname);
  if ('serviceWorker' in navigator && !isLocal) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('service-worker.js').catch(() => {});
    });
  } else if ('serviceWorker' in navigator && isLocal) {
    navigator.serviceWorker.getRegistrations().then((regs) => {
      regs.forEach((r) => r.unregister());
    });
  }

  loadProfile();
})();
