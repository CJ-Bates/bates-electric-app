(() => {
  const API_BASE = (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
    ? 'http://localhost:4000'
    : 'https://bates-electric-app.onrender.com';

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
    icon: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="m9 14 2 2 4-4"/></svg>',
    title: 'Start Inspection',
    desc: 'Electrical safety form',
    href: 'inspection.html',
  };

  const OFFICE_FEATURED = {
    id: 'inspection-dashboard',
    icon: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/></svg>',
    title: 'Inspection Dashboard',
    desc: 'View all reports',
    href: 'office.html',
  };

  // Quick links for all users
  const QUICK_LINKS = [
    { id: 'site-visit',    icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M12 11h4"/><path d="M12 16h4"/><path d="M8 11h.01"/><path d="M8 16h.01"/></svg>', title: 'Site Visit',       desc: 'Estimate form',        href: 'site-visit.html' },
    { id: 'safety-docs',   icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',  title: 'Safety Docs',      desc: 'Policies & procedures', href: 'safety-docs.html' },
    { id: 'sds',           icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2v7.527a2 2 0 0 1-.211.896L4.72 20.55a1 1 0 0 0 .9 1.45h12.76a1 1 0 0 0 .9-1.45l-5.069-10.127A2 2 0 0 1 14 9.527V2"/><path d="M8.5 2h7"/><path d="M7 16.5h10"/></svg>',  title: 'SDS Sheets',       desc: '37 chemicals',         href: 'sds.html' },
    { id: 'contacts',      icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>', title: 'Contacts',         desc: 'Team directory',       href: 'contacts.html' },
    { id: 'games',         icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="6" x2="10" y1="11" y2="11"/><line x1="8" x2="8" y1="9" y2="13"/><line x1="15" x2="15.01" y1="12" y2="12"/><line x1="18" x2="18.01" y1="10" y2="10"/><path d="M17.32 5H6.68a4 4 0 0 0-3.978 3.59c-.006.052-.01.101-.017.152C2.604 9.416 2 14.456 2 16a3 3 0 0 0 3 3c1.11 0 2.08-.402 2.592-1.382L9 15h6l1.408 2.618C16.92 18.598 17.89 19 19 19a3 3 0 0 0 3-3c0-1.544-.604-6.584-.685-7.258-.007-.05-.011-.1-.017-.151A4 4 0 0 0 17.32 5z"/></svg>', title: 'Games',            desc: 'Safety training',      href: 'games.html' },
    { id: 'manual',        icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>', title: 'Safety Manual',    desc: '2026 edition',        href: '#', onclick: 'openSafetyManual()' },
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
    if (nameEl) nameEl.textContent = displayName;
    if (roleEl) roleEl.textContent = profile.role === 'office' ? 'Office' : 'Tech';
    if (subtitle) subtitle.textContent = profile.role === 'office' ? 'Office Hub' : 'Field Hub';

    // Store profile for shared-nav and other components
    try { localStorage.setItem('bates.profile', JSON.stringify(profile)); } catch(e) {}

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
