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
    window.location.replace('/');
  };

  // Featured action cards
  const TECH_FEATURED = {
    id: 'new-inspection',
    icon: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="m9 14 2 2 4-4"/></svg>',
    title: 'Start Inspection',
    desc: 'Electrical safety form',
    href: '/inspection',
  };

  const OFFICE_FEATURED = {
    id: 'inspection-dashboard',
    icon: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/></svg>',
    title: 'Inspections',
    desc: 'Reports dashboard + new form',
    href: '/office',
  };


  const GENERATOR_FEATURED = {
    id: 'generator-care',
    icon: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
    title: 'Generator Care',
    desc: 'Customers + scheduled service visits',
    href: '/generator-care',
  };

  // Office-only: the Members area (techs today; office staff + customers later).
  const MEMBERS_FEATURED = {
    id: 'members',
    icon: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
    title: 'Members',
    desc: 'Techs, office staff & customers',
    href: '/members',
  };

  // Tech-only: the field-tech's assigned generator service visits.
  const MY_VISITS_FEATURED = {
    id: 'my-visits',
    icon: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
    title: 'My Visits',
    desc: 'Your assigned generator service visits',
    href: '/tech',
  };
  // Quick links for all users
  const QUICK_LINKS = [
    { id: 'site-visit',    icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M12 11h4"/><path d="M12 16h4"/><path d="M8 11h.01"/><path d="M8 16h.01"/></svg>', title: 'Site Visit',       desc: 'Estimate form',        href: '/site-visit' },
    { id: 'documents',     icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/><path d="M12 13V7"/><path d="m9 10 3-3 3 3"/></svg>', title: 'Documents',        desc: 'Safety manual & SDS',  href: '/documents' },
    { id: 'contacts',      icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>', title: 'Contacts',         desc: 'Team directory',       href: '/contacts' },
  ];

  function formatHeroDate(d) {
    return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  }

  async function loadProfile() {
    const token = getToken();
    if (!token) return redirectToLogin();

    try {
      const res = await BatesAuth.authFetch(`${API_BASE}/me`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.status === 401) {
        clearToken();
        return redirectToLogin();
      }
      if (!res.ok) throw new Error('Failed to load profile');
      const { profile } = await res.json();
      // Cache BEFORE any redirect so role-guard.js can route the next page
      // hit pre-paint (techs previously never got their role cached — render()
      // was the only writer and techs never reach it).
      try { localStorage.setItem('bates.profile', JSON.stringify(profile)); } catch (e) {}
      // Techs land on "My Day", not the shared hub — redirect before any
      // render() call so there's no flash of hub content first.
      if (profile.role === 'tech') {
        window.location.replace('/tech');
        return;
      }
      // role-guard.js hid the shell when no role was cached; reveal it now
      // that the authoritative check says this user stays (the redirect path
      // above deliberately keeps it hidden while navigation happens).
      document.documentElement.classList.remove('role-pending');
      render(profile);
    } catch (err) {
      document.documentElement.classList.remove('role-pending');
      showError(err.message || 'Could not load your profile.');
    }
  }

  function render(profile) {
    const displayName = profile.full_name || profile.email.split('@')[0];
    const firstName = displayName.split(' ')[0];

    // Store profile for shared-nav and other components
    try { localStorage.setItem('bates.profile', JSON.stringify(profile)); } catch(e) {}

    // Hero section
    const now = new Date();
    const greetEl = document.getElementById('hero-greet');
    const nameEl = document.getElementById('hero-name');
    const subEl = document.getElementById('hero-sub');
    const dateEl = document.getElementById('hero-date');

    if (greetEl) greetEl.textContent = BatesWeather.greetingForHour(now.getHours());
    if (nameEl) nameEl.textContent = firstName;
    if (subEl) subEl.textContent = profile.role === 'office' ? 'Office Hub' : 'Field Hub';
    if (dateEl) dateEl.textContent = formatHeroDate(now);

    renderFeaturedActions(profile.role);
    renderQuickLinks(profile.role);
    BatesWeather.mount({
      wrapEl: document.getElementById('hero-weather'),
      iconEl: document.getElementById('hero-weather-icon'),
      tempEl: document.getElementById('hero-weather-temp'),
      locEl: document.getElementById('hero-weather-loc'),
    });
  }

  function renderFeaturedActions(role) {
    const grid = document.getElementById('featured-actions-grid');
    if (!grid) return;
    grid.innerHTML = '';

    if (role === 'office') {
      grid.appendChild(makeFeaturedCard(GENERATOR_FEATURED));
      grid.appendChild(makeFeaturedCard(OFFICE_FEATURED));
      grid.appendChild(makeFeaturedCard(MEMBERS_FEATURED));
    } else {
      // Techs land on the hub; their generator visits are the primary card.
      grid.appendChild(makeFeaturedCard(MY_VISITS_FEATURED));
      grid.appendChild(makeFeaturedCard(TECH_FEATURED));
    }
  }

  function renderQuickLinks() {
    const grid = document.getElementById('quick-links-grid');
    if (!grid) return;
    grid.innerHTML = '';
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
      <div>
        <h3 class="fac-title">${card.title}</h3>
        <p class="fac-sub">${card.desc}</p>
      </div>
    `;
    return el;
  }

  function makeQuickCard(card) {
    const el = document.createElement('a');
    el.className = 'quick-card';
    el.href = card.href;
    el.innerHTML = `
      <span class="qc-icon">${card.icon}</span>
      <div class="qc-title">${card.title}</div>
      <div class="qc-sub">${card.desc}</div>
    `;
    return el;
  }

  function showError(msg) {
    const main = document.querySelector('.hub-main');
    if (!main) return;
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
      const cards = document.querySelectorAll('.quick-card');
      cards.forEach(card => {
        if (query.length > 0) {
          const title = card.querySelector('.qc-title')?.textContent.toLowerCase() || '';
          const desc = card.querySelector('.qc-sub')?.textContent.toLowerCase() || '';
          card.style.display = (title.includes(query) || desc.includes(query)) ? '' : 'none';
        } else {
          card.style.display = '';
        }
      });
    });
  }

  // Service worker
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
