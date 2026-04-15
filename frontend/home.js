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
    { id: 'documents',     icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"/><path d="M12 13V7"/><path d="m9 10 3-3 3 3"/></svg>', title: 'Documents',        desc: 'Safety manual & SDS',  href: 'documents.html' },
    { id: 'contacts',      icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>', title: 'Contacts',         desc: 'Team directory',       href: 'contacts.html' },
    { id: 'games',         icon: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="6" x2="10" y1="11" y2="11"/><line x1="8" x2="8" y1="9" y2="13"/><line x1="15" x2="15.01" y1="12" y2="12"/><line x1="18" x2="18.01" y1="10" y2="10"/><path d="M17.32 5H6.68a4 4 0 0 0-3.978 3.59c-.006.052-.01.101-.017.152C2.604 9.416 2 14.456 2 16a3 3 0 0 0 3 3c1.11 0 2.08-.402 2.592-1.382L9 15h6l1.408 2.618C16.92 18.598 17.89 19 19 19a3 3 0 0 0 3-3c0-1.544-.604-6.584-.685-7.258-.007-.05-.011-.1-.017-.151A4 4 0 0 0 17.32 5z"/></svg>', title: 'Games',            desc: 'Safety training',      href: 'games.html' },
  ];

  // WMO weather code → { label, svg }
  const WEATHER_ICONS = {
    sun: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2"/><path d="M12 20v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="m17.66 17.66 1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="m6.34 17.66-1.41 1.41"/><path d="m19.07 4.93-1.41 1.41"/></svg>',
    cloudSun: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v2"/><path d="m4.93 4.93 1.41 1.41"/><path d="M20 12h2"/><path d="m19.07 4.93-1.41 1.41"/><path d="M15.947 12.65a4 4 0 0 0-5.925-4.128"/><path d="M13 22H7a5 5 0 1 1 4.9-6H13a3 3 0 0 1 0 6Z"/></svg>',
    cloud: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/></svg>',
    fog: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10h18"/><path d="M5 14h14"/><path d="M3 18h18"/><path d="M5 6h14"/></svg>',
    rain: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"/><path d="M16 14v6"/><path d="M8 14v6"/><path d="M12 16v6"/></svg>',
    snow: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"/><path d="M8 15h.01"/><path d="M8 19h.01"/><path d="M12 17h.01"/><path d="M12 21h.01"/><path d="M16 15h.01"/><path d="M16 19h.01"/></svg>',
    storm: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 16.9A5 5 0 0 0 18 7h-1.26a8 8 0 1 0-11.62 9"/><path d="m13 12-3 5h4l-3 5"/></svg>',
  };

  function weatherFromCode(code) {
    if (code === 0) return { icon: 'sun', label: 'Clear' };
    if (code <= 2) return { icon: 'cloudSun', label: 'Partly cloudy' };
    if (code === 3) return { icon: 'cloud', label: 'Cloudy' };
    if (code === 45 || code === 48) return { icon: 'fog', label: 'Foggy' };
    if (code >= 51 && code <= 67) return { icon: 'rain', label: 'Rain' };
    if (code >= 71 && code <= 77) return { icon: 'snow', label: 'Snow' };
    if (code >= 80 && code <= 82) return { icon: 'rain', label: 'Showers' };
    if (code >= 85 && code <= 86) return { icon: 'snow', label: 'Snow' };
    if (code >= 95) return { icon: 'storm', label: 'Storms' };
    return { icon: 'cloud', label: '' };
  }

  const LOC_CACHE_KEY = 'bates.weather.loc';
  const LOC_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

  function readCachedLocation() {
    try {
      const raw = localStorage.getItem(LOC_CACHE_KEY);
      if (!raw) return null;
      const j = JSON.parse(raw);
      if (!j || !Number.isFinite(j.lat) || !Number.isFinite(j.lon)) return null;
      if (Date.now() - (j.ts || 0) > LOC_CACHE_TTL_MS) return null;
      return j;
    } catch (e) { return null; }
  }

  function writeCachedLocation(loc) {
    try {
      localStorage.setItem(LOC_CACHE_KEY, JSON.stringify({ ...loc, ts: Date.now() }));
    } catch (e) { /* ignore */ }
  }

  function getBrowserPosition() {
    return new Promise((resolve) => {
      if (!navigator.geolocation) return resolve({ ok: false, reason: 'unsupported' });
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve({ ok: true, lat: pos.coords.latitude, lon: pos.coords.longitude }),
        (err) => resolve({ ok: false, reason: err && err.code === 1 ? 'denied' : 'error' }),
        { enableHighAccuracy: true, timeout: 12000, maximumAge: 5 * 60 * 1000 }
      );
    });
  }

  async function reverseGeocode(lat, lon) {
    try {
      const url = `https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`;
      const res = await fetch(url);
      if (!res.ok) return null;
      const j = await res.json();
      return j.city || j.locality || j.principalSubdivision || null;
    } catch (e) { return null; }
  }

  async function fetchWeatherFor(loc) {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}&current=temperature_2m,weather_code&temperature_unit=fahrenheit&timezone=auto`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const json = await res.json();
    const t = Math.round(json?.current?.temperature_2m);
    const code = json?.current?.weather_code;
    if (!Number.isFinite(t) || !Number.isFinite(code)) return null;
    return { t, code };
  }

  function renderWeather(els, loc, weather) {
    const w = weatherFromCode(weather.code);
    els.iconEl.innerHTML = WEATHER_ICONS[w.icon] || WEATHER_ICONS.cloud;
    els.tempEl.textContent = `${weather.t}°`;
    els.locEl.textContent = loc.city || '';
    els.wrap.title = w.label;
    els.wrap.hidden = false;
  }

  function renderEnablePrompt(els, message) {
    els.iconEl.innerHTML = '';
    els.tempEl.textContent = '';
    els.locEl.textContent = message;
    els.wrap.title = 'Tap to enable location';
    els.wrap.hidden = false;
  }

  async function tryRenderWith(els, loc) {
    const weather = await fetchWeatherFor(loc);
    if (!weather) return false;
    if (!loc.city) loc.city = await reverseGeocode(loc.lat, loc.lon);
    renderWeather(els, loc, weather);
    writeCachedLocation(loc);
    return true;
  }

  async function loadWeather() {
    const wrap = document.getElementById('hero-weather');
    const iconEl = document.getElementById('hero-weather-icon');
    const tempEl = document.getElementById('hero-weather-temp');
    const locEl = document.getElementById('hero-weather-loc');
    if (!wrap || !iconEl || !tempEl || !locEl) return;
    const els = { wrap, iconEl, tempEl, locEl };

    const cached = readCachedLocation();
    if (cached) {
      const ok = await tryRenderWith(els, { lat: cached.lat, lon: cached.lon, city: cached.city });
      if (ok) {
        requestFreshLocation(els, { silent: true });
        return;
      }
    }

    let permState = null;
    try {
      if (navigator.permissions && navigator.permissions.query) {
        const p = await navigator.permissions.query({ name: 'geolocation' });
        permState = p.state;
      }
    } catch (e) { /* not all browsers support this */ }

    if (permState === 'granted' || permState === 'prompt' || permState === null) {
      const ok = await requestFreshLocation(els, { silent: false });
      if (ok) return;
    }

    renderEnablePrompt(els, 'Tap to enable location');
  }

  async function requestFreshLocation(els, { silent }) {
    const pos = await getBrowserPosition();
    if (!pos.ok) {
      if (!silent) {
        renderEnablePrompt(els, pos.reason === 'denied' ? 'Location off' : 'Tap to enable location');
      }
      return false;
    }
    const loc = { lat: pos.lat, lon: pos.lon, city: null };
    return tryRenderWith(els, loc);
  }

  function wireWeatherTileRetry() {
    const wrap = document.getElementById('hero-weather');
    if (!wrap) return;
    const handler = async (ev) => {
      ev.preventDefault();
      const els = {
        wrap,
        iconEl: document.getElementById('hero-weather-icon'),
        tempEl: document.getElementById('hero-weather-temp'),
        locEl: document.getElementById('hero-weather-loc'),
      };
      els.locEl.textContent = 'Locating…';
      await requestFreshLocation(els, { silent: false });
    };
    wrap.addEventListener('click', handler);
    wrap.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') handler(ev);
    });
  }

  function greetingForHour(h) {
    if (h < 5) return 'Working late';
    if (h < 12) return 'Good morning';
    if (h < 17) return 'Good afternoon';
    if (h < 21) return 'Good evening';
    return 'Good evening';
  }

  function formatHeroDate(d) {
    return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  }

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

    if (greetEl) greetEl.textContent = greetingForHour(now.getHours());
    if (nameEl) nameEl.textContent = firstName;
    if (subEl) subEl.textContent = profile.role === 'office' ? 'Office Hub' : 'Field Hub';
    if (dateEl) dateEl.textContent = formatHeroDate(now);

    renderFeaturedActions(profile.role);
    renderQuickLinks(profile.role);
    wireWeatherTileRetry();
    loadWeather();
  }

  function renderFeaturedActions(role) {
    const grid = document.getElementById('featured-actions-grid');
    if (!grid) return;
    grid.innerHTML = '';

    if (role === 'office') {
      grid.appendChild(makeFeaturedCard(OFFICE_FEATURED));
      grid.appendChild(makeFeaturedCard({
        ...TECH_FEATURED,
        title: 'New Inspection',
        desc: 'Create report',
      }));
    } else {
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

  // Emergency banner handler
  const emergencyBanner = document.getElementById('emergency-banner');
  if (emergencyBanner) {
    emergencyBanner.addEventListener('click', () => {
      // Could open a modal with incident response steps
      alert('Emergency Steps:\\n1. Ensure scene is safe\\n2. Call 911 if needed\\n3. Call office (636) 464-3939\\n4. Administer first aid\\n5. Secure the area\\n6. Document the incident');
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