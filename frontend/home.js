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

  // Featured action cards
  const TECH_FEATURED = {
    id: 'new-inspection',
    icon: '✓',
    title: 'Start Inspection',
    desc: 'Electrical safety form',
    href: 'inspection.html',
  };

  const OFFICE_FEATURED = {
    id: 'inspection-dashboard',
    icon: '☰',
    title: 'Inspection Dashboard',
    desc: 'View all reports',
    href: 'office.html',
  };

  // Quick links for all users
  const QUICK_LINKS = [
    { id: 'site-visit',    icon: '📋', title: 'Site Visit',       desc: 'Estimate form',        href: 'site-visit.html' },
    { id: 'safety-docs',   icon: '§',  title: 'Safety Docs',      desc: 'Policies & procedures', href: 'safety-docs.html' },
    { id: 'sds',           icon: '☣',  title: 'SDS Sheets',       desc: '37 chemicals',         href: 'sds.html' },
    { id: 'contacts',      icon: '☎',  title: 'Contacts',         desc: 'Team directory',       href: 'contacts.html' },
    { id: 'games',         icon: '🎮', title: 'Games',            desc: 'Safety training',      href: 'games.html' },
    { id: 'manual',        icon: '📖', title: 'Safety Manual',    desc: '2026 edition',        href: '#', onclick: 'openSafetyManual()' },
  ];

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
    const subtitle = document.getElementById('hub-subtitle');

    const displayName = profile.full_name || profile.email.split('@')[0];
    nameEl.textContent = displayName;
    roleEl.textContent = profile.role === 'office' ? 'Office' : 'Tech';
    subtitle.textContent = profile.role === 'office' ? 'Office Hub' : 'Field Hub';

    renderFeaturedActions(profile.role);
    renderQuickLinks(profile.role);
  }

  function renderFeaturedActions(role) {
    const grid = document.getElementById('featured-actions-grid');
    grid.innerHTML = '';

    if (role === 'office') {
      // Office sees Dashboard first, then New Inspection as secondary
      grid.appendChild(makeFeaturedCard(OFFICE_FEATURED));
      grid.appendChild(makeFeaturedCard({
        ...TECH_FEATURED,
        title: 'New Inspection',
        desc: 'Create report',
      }));
    } else {
      // Tech sees New Inspection as primary
      grid.appendChild(makeFeaturedCard(TECH_FEATURED));
    }
  }

  function renderQuickLinks(role) {
    const grid = document.getElementById('quick-links-grid');
    grid.innerHTML = '';

    // All users get the same quick links
    for (const link of QUICK_LINKS) {
      grid.appendChild(makeQuickCard(link));
    }
  }

  function makeFeaturedCard(card) {
    const el = document.createElement('a');
    el.className = 'featured-action-card';
    el.href = card.href;
    el.innerHTML = `
      <div class="fac-icon">${card.icon}</div>
      <h3 class="fac-title">${card.title}</h3>
      <p class="fac-sub">${card.desc}</p>
    `;
    return el;
  }

  function makeQuickCard(card) {
    const el = document.createElement('a');
    el.className = 'quick-card';
    if (card.onclick) {
      el.href = '#';
      el.onclick = (e) => {
        e.preventDefault();
        window[card.onclick]();
      };
    } else {
      el.href = card.href;
    }
    el.innerHTML = `
      <span class="qc-icon">${card.icon}</span>
      <div class="qc-title">${card.title}</div>
      <div class="qc-sub">${card.desc}</div>
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

  // Search functionality
  const searchInput = document.getElementById('dashboard-search');
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      const query = e.target.value.toLowerCase();
      // Basic search across quick links
      if (query.length > 0) {
        const cards = document.querySelectorAll('.quick-card');
        cards.forEach(card => {
          const title = card.querySelector('.qc-title')?.textContent.toLowerCase() || '';
          const desc = card.querySelector('.qc-sub')?.textContent.toLowerCase() || '';
          const matches = title.includes(query) || desc.includes(query);
          card.style.display = matches ? '' : 'none';
        });
      } else {
        document.querySelectorAll('.quick-card').forEach(card => {
          card.style.display = '';
        });
      }
    });
  }

  // Emergency banner handler
  const emergencyBanner = document.getElementById('emergency-banner');
  if (emergencyBanner) {
    emergencyBanner.addEventListener('click', () => {
      // Could open a modal with incident response steps
      // For now, just scroll to the field reference section
      document.getElementById('field-reference-section')?.scrollIntoView({ behavior: 'smooth' });
    });
  }

  // Safety Manual link
  window.openSafetyManual = function() {
    window.open('https://bateselectric-my.sharepoint.com/:b:/g/personal/cjbates_bates-electric_com/IQCHGrHJsPCFQp01ZxBJVggYAfFnVsI8LgpMWoDD-GQfMfU?e=2mFCHY', '_blank');
  };

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
