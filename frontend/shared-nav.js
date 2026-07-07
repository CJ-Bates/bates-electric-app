/**
 * Shared Navigation Component for Bates Electric PWA
 *
 * Injects a top navigation bar with hamburger menu + slide-out drawer menu on any page.
 * Include this script on pages that need navigation.
 *
 * Usage: <script src="shared-nav.js"></script>
 */

(function() {
  'use strict';

  // Apply persisted theme before first paint on every page that loads shared-nav
  try {
    if (localStorage.getItem('bates.theme') === 'dark') {
      document.documentElement.classList.add('dark');
    }
  } catch (e) {}

  // ---- Shared authenticated fetch + session-expiry handling ----------------
  // Centralizes the "token expired" UX for every dashboard page: any
  // authenticated API call that comes back 401 clears the stored token and
  // bounces the user to login with a short message, instead of leaving them on
  // a broken page firing "Failed to load" / "Role check failed" toasts.
  // Exposed as window.BatesAuth so the per-page scripts (loaded after this one)
  // can route their fetches through it.
  (function setupAuthHelper() {
    const TOKEN_KEY = 'bates.auth.token';
    const REFRESH_KEY = 'bates.auth.refresh';
    const DEFAULT_EXPIRED_MSG = 'Your session expired — please sign in again.';
    const API_BASE = (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
      ? 'http://localhost:4000'
      : 'https://bates-electric-app.onrender.com';

    const getToken = () =>
      localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY);
    const getRefreshToken = () =>
      localStorage.getItem(REFRESH_KEY) || sessionStorage.getItem(REFRESH_KEY);

    // The session lives in localStorage (remember-me) or sessionStorage. Refreshed
    // tokens go back into whichever store currently holds the session.
    const sessionStore = () =>
      (localStorage.getItem(TOKEN_KEY) != null || localStorage.getItem(REFRESH_KEY) != null)
        ? localStorage : sessionStorage;

    const onLoginPage = () => {
      const p = window.location.pathname;
      return p === '/' || /(^|\/)index\.html$/i.test(p);
    };

    // Clear stored session and redirect to login (once). Returns true if it
    // navigated, false if suppressed because we're already on the login page
    // (guards against a redirect loop).
    function redirectToLogin(message) {
      try {
        localStorage.removeItem(TOKEN_KEY); sessionStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(REFRESH_KEY); sessionStorage.removeItem(REFRESH_KEY);
      } catch (e) {}
      if (onLoginPage()) return false;
      try { sessionStorage.setItem('bates.auth.message', message || DEFAULT_EXPIRED_MSG); } catch (e) {}
      window.location.replace('/');
      return true;
    }

    // Exchange the refresh token for a fresh access token (Supabase access tokens
    // are short-lived). Deduped: concurrent 401s share one in-flight refresh so a
    // rotating refresh token isn't spent twice. Resolves true on success.
    let refreshInFlight = null;
    function refreshSession() {
      if (refreshInFlight) return refreshInFlight;
      const rt = getRefreshToken();
      if (!rt) return Promise.resolve(false);
      refreshInFlight = fetch(API_BASE + '/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: rt }),
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (!data || !data.token) return false;
          const store = sessionStore();
          store.setItem(TOKEN_KEY, data.token);
          if (data.refresh_token) store.setItem(REFRESH_KEY, data.refresh_token);
          return true;
        })
        .catch(() => false)
        .finally(() => { refreshInFlight = null; });
      return refreshInFlight;
    }

    // Drop-in fetch wrapper. Always attaches the freshest bearer token. On 401 it
    // silently refreshes the session once and retries; only if the refresh fails
    // does it clear the session and bounce to login (returning a never-resolving
    // promise so the caller halts cleanly). Non-401 responses pass through.
    async function authFetch(url, options, _retried) {
      const opts = options || {};
      const headers = Object.assign({}, opts.headers || {});
      const token = getToken();
      if (token) headers['Authorization'] = 'Bearer ' + token; // freshest wins (esp. after a refresh)
      const res = await fetch(url, Object.assign({}, opts, { headers }));
      if (res.status === 401) {
        if (!_retried && await refreshSession()) {
          return authFetch(url, options, true); // retry once with the refreshed token
        }
        if (redirectToLogin()) return new Promise(() => {}); // navigating away; stop the caller
        throw new Error('Unauthorized'); // already on login — let caller handle rather than hang
      }
      return res;
    }

    window.BatesAuth = { authFetch, redirectToLogin, refreshSession, getToken, getRefreshToken, onLoginPage };
  })();

  // ---- Load-time auth gate -------------------------------------------------
  // Every page that loads shared-nav.js (all except index.html, pdf-viewer.html
  // and reset-password.html — pdf-viewer carries its own inline guard) bounces
  // straight to login when no session token exists in either store. This is a
  // deterrent, not real protection — the HTML is still fetchable — the sensitive
  // data itself lives behind authenticated API endpoints. onLoginPage() is the
  // loop guard: never redirect the login page to itself.
  if (!window.BatesAuth.getToken() && !window.BatesAuth.onLoginPage()) {
    window.location.replace('/');
    return;
  }

  // SVG icon definitions
  const svgIcons = {
    hamburger: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><line x1="4" x2="20" y1="12" y2="12"/><line x1="4" x2="20" y1="6" y2="6"/><line x1="4" x2="20" y1="18" y2="18"/></svg>`,
    close: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`,
    house: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>`,
    clipboardCheck: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="m9 14 2 2 4-4"/></svg>`,
    layoutDashboard: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/></svg>`,
    shield: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>`,
    flaskConical: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2v7.527a2 2 0 0 1-.211.896L4.72 20.55a1 1 0 0 0 .9 1.45h12.76a1 1 0 0 0 .9-1.45l-5.069-10.127A2 2 0 0 1 14 9.527V2"/><path d="M8.5 2h7"/><path d="M7 16.5h10"/></svg>`,
    users: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`,
    settings: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>`,
    helpCircle: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/></svg>`,
    logOut: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" x2="9" y1="12" y2="12"/></svg>`,
    fileText: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/><line x1="16" x2="8" y1="13" y2="13"/><line x1="16" x2="8" y1="17" y2="17"/><line x1="10" x2="8" y1="9" y2="9"/></svg>`,
    zap: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`,
    mapPin: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>`,
    };

  // Drawer menu structure with SVG icons
  const drawerMenu = [
    {
      section: 'Main',
      items: [
        { label: 'Home', icon: 'house', href: '/home', id: 'drawer-home' },
        { label: 'My Visits', icon: 'zap', href: '/tech', id: 'drawer-tech', techOnly: true },
        { label: 'Inspections', icon: 'clipboardCheck', href: '/inspection', id: 'drawer-inspection' },
        { label: 'Site Visit', icon: 'mapPin', href: '/site-visit', id: 'drawer-site-visit' },
        { label: 'Generator Care', icon: 'zap', href: '/generator-care', id: 'drawer-generator', officeOnly: true },
        { label: 'Members', icon: 'users', href: '/members', id: 'drawer-members', officeOnly: true }
      ]
    },
    {
      section: 'Resources',
      items: [
        { label: 'Documents', icon: 'fileText', href: '/documents', id: 'drawer-documents' },
        { label: 'Contacts', icon: 'users', href: '/contacts', id: 'drawer-contacts' }
      ]
    },
    {
      section: 'Account',
      items: [
        { label: 'Settings', icon: 'settings', href: '/settings', id: 'drawer-settings' },
        { label: 'Sign Out', icon: 'logOut', href: '#', id: 'drawer-signout', isSignOut: true }
      ]
    }
  ];

  // Page title mapping
  const pageTitles = {
    'home': 'Home',
    'inspection': 'Inspections',
    'site-visit': 'Site Visit',
    'office': 'Inspections',
    'members': 'Members',
    'documents': 'Documents',
    'safety-manual': 'Safety Manual',
    'sds-sheets': 'SDS Sheets',
    'contacts': 'Contacts'
    // Generator Care and its Metrics / Accounting sub-tabs are intentionally NOT
    // listed, so getPageTitle() falls back to the default "Bates Electric" on all
    // three: the top ribbon stays the app-shell brand, while the centered page
    // heading below carries the tab-specific title.
  };

  /**
   * Get page title from current URL
   */
  function getPageTitle() {
    const pathname = window.location.pathname;
    for (const [key, title] of Object.entries(pageTitles)) {
      if (pathname.includes(key)) {
        return title;
      }
    }
    return 'Bates Electric';
  }

  /**
   * Check if user is office role (checks localStorage for role)
   */
  function isOfficeRole() {
    try {
      const profile = JSON.parse(localStorage.getItem('bates.profile') || '{}');
      return profile.role === 'office';
    } catch {
      return false;
    }
  }

  /**
   * Inject the navigation HTML into the page
   */
  function injectNavigation() {
    // Skip if a topbar is already in the DOM (e.g. hardcoded fallback in the page)
    if (document.querySelector('.app-topbar')) {
      console.log('[shared-nav] topbar already present, skipping injection');
      return;
    }
    console.log('[shared-nav] injecting topbar');
    const pageTitle = getPageTitle();
    const isOffice = isOfficeRole();

    // Create top bar HTML
    // Styling lives entirely in app.css (.app-topbar is v3 glass chrome in both
    // themes) — no inline styles, so the token swap themes it automatically.
    const topbarHTML = `
      <header class="app-topbar">
        <div class="topbar-left">
          <button class="topbar-hamburger" id="hamburgerBtn" aria-label="Open menu">
            ${svgIcons.hamburger}
          </button>
        </div>
        <div class="topbar-center">
          <h1 class="topbar-title">${pageTitle}</h1>
        </div>
        <div class="topbar-right">
          <button class="topbar-signout" id="topbarSignOut" aria-label="Sign out">
            ${svgIcons.logOut}
          </button>
        </div>
      </header>
    `;

    // Create drawer overlay + drawer with role-aware menu
    const drawerItemsHTML = drawerMenu.map(group => `
      <div class="shared-drawer-section">
        <h3 class="shared-drawer-section-label">${group.section}</h3>
        ${group.items.map(item => {
          // Skip office-only items for techs, and tech-only items for office.
          if (item.officeOnly && !isOffice) {
            return '';
          }
          if (item.techOnly && isOffice) {
            return '';
          }

          if (item.isSignOut) {
            return `
              <button class="shared-drawer-item" data-drawer-item="${item.id}" role="menuitem" id="drawerSignOut">
                <span class="shared-drawer-item-icon">${svgIcons[item.icon]}</span>
                <span class="shared-drawer-item-label">${item.label}</span>
              </button>
            `;
          }

          return `
            <a href="${item.href}" class="shared-drawer-item" data-drawer-item="${item.id}" role="menuitem">
              <span class="shared-drawer-item-icon">${svgIcons[item.icon]}</span>
              <span class="shared-drawer-item-label">${item.label}</span>
            </a>
          `;
        }).join('')}
      </div>
    `).join('');

    const drawerHTML = `
      <div class="shared-drawer-overlay" id="drawerOverlay"></div>
      <aside class="shared-drawer" id="sharedDrawer" aria-label="Navigation menu">
        <div class="shared-drawer-header">
          <img src="logo-icon.png?v=7" alt="Bates Electric" width="36" height="36" style="margin-bottom:4px;" />
          <h2 class="shared-drawer-title">Bates Electric</h2>
          <p class="shared-drawer-subtitle">Field Service</p>
          <button class="shared-drawer-close" id="drawerClose" aria-label="Close menu">
            ${svgIcons.close}
          </button>
        </div>
        <nav class="shared-drawer-nav">
          ${drawerItemsHTML}
        </nav>
      </aside>
    `;

    // Inject into DOM
    document.body.insertAdjacentHTML('afterbegin', topbarHTML);
    document.body.insertAdjacentHTML('beforeend', drawerHTML);
  }

  /**
   * Determine the current page based on URL
   */
  function getCurrentPage() {
    const pathname = window.location.pathname;
    if (pathname.includes('members')) return 'members';
    if (pathname.includes('office')) return 'office';
    if (pathname.includes('site-visit')) return 'site-visit';
    if (pathname.includes('inspection')) return 'inspection';
    if (pathname.includes('safety-manual')) return 'safety-manual';
    if (pathname.includes('sds-sheets')) return 'sds-sheets';
    if (pathname.includes('documents')) return 'documents';
    if (pathname.includes('contacts')) return 'contacts';
    if (pathname.includes('generator-care')) return 'generator-care';
    if (pathname.includes('home')) return 'home';
    return 'home';
  }

  /**
   * Update active state of drawer items based on current page
   */
  function updateActiveState() {
    const currentPage = getCurrentPage();

    document.querySelectorAll('.shared-drawer-item').forEach(item => {
      const itemId = item.dataset.drawerItem;
      let isActive = false;

      if (currentPage === 'home' && itemId === 'drawer-home') isActive = true;
      if (currentPage === 'inspection' && itemId === 'drawer-inspection') isActive = true;
      if (currentPage === 'site-visit' && itemId === 'drawer-site-visit') isActive = true;
      if (currentPage === 'office' && itemId === 'drawer-inspection') isActive = true;
      if (currentPage === 'members' && itemId === 'drawer-members') isActive = true;
      if (currentPage === 'documents' && itemId === 'drawer-documents') isActive = true;
      if (currentPage === 'safety-manual' && itemId === 'drawer-documents') isActive = true;
      if (currentPage === 'sds-sheets' && itemId === 'drawer-documents') isActive = true;
      if (currentPage === 'contacts' && itemId === 'drawer-contacts') isActive = true;
      if (currentPage === 'generator-care' && itemId === 'drawer-generator') isActive = true;

      item.classList.toggle('active', isActive);
    });
  }

  /**
   * Handle sign out (clear tokens and redirect)
   */
  function handleSignOut() {
    localStorage.removeItem('bates.auth.token');
    sessionStorage.removeItem('bates.auth.token');
    localStorage.removeItem('bates.auth.refresh');
    sessionStorage.removeItem('bates.auth.refresh');
    window.location.href = '/';
  }

  /**
   * Open/close drawer functions (defined early so hamburger can reference them)
   */
  function openDrawer() {
    const overlay = document.getElementById('drawerOverlay');
    const drawer = document.getElementById('sharedDrawer');
    if (overlay && drawer) {
      overlay.classList.add('open');
      drawer.classList.add('open');
      document.body.style.overflow = 'hidden';
    }
  }

  function closeDrawer() {
    const overlay = document.getElementById('drawerOverlay');
    const drawer = document.getElementById('sharedDrawer');
    if (overlay && drawer) {
      overlay.classList.remove('open');
      drawer.classList.remove('open');
      document.body.style.overflow = '';
    }
  }

  /**
   * Make SVG children of buttons non-interactive so the button gets the tap
   */
  function fixSvgPointerEvents() {
    document.querySelectorAll('.topbar-hamburger svg, .topbar-signout svg, .shared-drawer-close svg').forEach(svg => {
      svg.style.pointerEvents = 'none';
    });
  }

  /**
   * Handle hamburger button click
   */
  function setupHamburgerListener() {
    const hamburgerBtn = document.getElementById('hamburgerBtn');
    if (hamburgerBtn) {
      // Use both click and touchend for maximum mobile compatibility
      hamburgerBtn.addEventListener('click', function(e) {
        e.preventDefault();
        e.stopPropagation();
        openDrawer();
      });
      hamburgerBtn.addEventListener('touchend', function(e) {
        e.preventDefault();
        e.stopPropagation();
        openDrawer();
      }, { passive: false });
    }
  }

  /**
   * Handle drawer interactions
   */
  function setupDrawerListeners() {
    const overlay = document.getElementById('drawerOverlay');
    const closeBtn = document.getElementById('drawerClose');
    const topbarSignOut = document.getElementById('topbarSignOut');
    const drawerSignOut = document.getElementById('drawerSignOut');

    // Close on overlay click/touch
    if (overlay) {
      overlay.addEventListener('click', closeDrawer);
      overlay.addEventListener('touchend', function(e) {
        e.preventDefault();
        closeDrawer();
      }, { passive: false });
    }

    // Close on close button click/touch
    if (closeBtn) {
      closeBtn.addEventListener('click', function(e) {
        e.preventDefault();
        closeDrawer();
      });
      closeBtn.addEventListener('touchend', function(e) {
        e.preventDefault();
        closeDrawer();
      }, { passive: false });
    }

    // Handle topbar sign out
    if (topbarSignOut) {
      topbarSignOut.addEventListener('click', function(e) {
        e.preventDefault();
        e.stopPropagation();
        handleSignOut();
      });
      topbarSignOut.addEventListener('touchend', function(e) {
        e.preventDefault();
        e.stopPropagation();
        handleSignOut();
      }, { passive: false });
    }

    // Handle drawer sign out
    if (drawerSignOut) {
      drawerSignOut.addEventListener('click', function(e) {
        e.preventDefault();
        handleSignOut();
      });
    }

    // Close on drawer item click (navigation)
    document.querySelectorAll('.shared-drawer-item').forEach(item => {
      if (!item.isSignOut && !item.id.includes('SignOut')) {
        item.addEventListener('click', closeDrawer);
      }
    });

    // Keyboard: ESC to close
    document.addEventListener('keydown', function(e) {
      const drawer = document.getElementById('sharedDrawer');
      if (e.key === 'Escape' && drawer && drawer.classList.contains('open')) {
        closeDrawer();
      }
    });
  }

  /**
   * Inject the Generator Care section tab switcher into [data-section-tabs].
   * Only the three GC pages (Customers / Metrics / Accounting) include that
   * mount, so this is a no-op everywhere else. Keeping the markup here — one
   * place — means the three pages can't drift apart.
   */
  function injectSectionTabs() {
    const mount = document.querySelector('[data-section-tabs]');
    if (!mount) return;
    // Icons are currently hidden at all widths (the switcher stays a top
    // segmented control everywhere; the bottom slot belongs to .app-tabbar).
    const ICONS = {
      'generator-care': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
      'metrics': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" x2="18" y1="20" y2="10"/><line x1="12" x2="12" y1="20" y2="4"/><line x1="6" x2="6" y1="20" y2="14"/></svg>',
      'accounting': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" x2="12" y1="2" y2="22"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>',
    };
    // The Accounting tab is hidden for members whose accounting flag is off
    // (cached profile from /me — see home.js). UI convenience only: the
    // accounting API enforces the flag server-side.
    let canSeeAccounting = true;
    try {
      const profile = JSON.parse(localStorage.getItem('bates.profile') || '{}');
      if (profile.permissions && profile.permissions.accounting === false) canSeeAccounting = false;
    } catch (e) { /* default to visible; the page + API still enforce */ }
    const tabs = [
      { label: 'Customers',  href: '/generator-care', match: 'generator-care' },
      { label: 'Metrics',    href: '/metrics',        match: 'metrics' },
      { label: 'Accounting', href: '/accounting',     match: 'accounting' },
    ].filter((t) => t.match !== 'accounting' || canSeeAccounting);
    const path = window.location.pathname;
    mount.innerHTML = tabs.map((t) => {
      const active = path.indexOf(t.match) !== -1;
      return `<a href="${t.href}" class="section-tab${active ? ' active' : ''}"${active ? ' aria-current="page"' : ''}>` +
        `<span class="section-tab-icon" aria-hidden="true">${ICONS[t.match] || ''}</span>` +
        `<span class="section-tab-label">${t.label}</span></a>`;
    }).join('');
  }

  /**
   * Inject the global mobile tab bar (v3: floating glass-strong bottom nav,
   * Home · Gen Care/My Visits · Inspections · More). CSS shows it only at
   * <=640px (.app-tabbar in app.css). Skipped on pages whose bottom slot
   * belongs to a sticky form action bar (inspection / site-visit, v3 demo #2).
   * Tab targets respect the same role gating as the drawer: Gen Care is
   * office-only, My Visits (tech.html) is the techs' slot.
   */
  function injectTabBar() {
    if (document.querySelector('.app-tabbar')) return;
    if (document.querySelector('.insp-actions, .sv-footer-actions')) return;
    const path = window.location.pathname;
    const tabs = [
      { label: 'Home', icon: 'house', href: '/home', match: ['home'] },
      isOfficeRole()
        ? { label: 'Gen Care', icon: 'zap', href: '/generator-care', match: ['generator-care', 'metrics', 'accounting'] }
        : { label: 'My Visits', icon: 'zap', href: '/tech', match: ['tech'] },
      { label: 'Inspections', icon: 'clipboardCheck', href: '/inspection', match: ['inspection', 'office'] },
    ];
    const isActive = (t) => t.match.some((m) => path.includes(m));
    // Pages reachable only through the drawer (Contacts, Documents, Settings…)
    // light up "More" so the bar always shows where you are.
    const moreActive = !tabs.some(isActive);
    const tabbarHTML = `
      <nav class="app-tabbar" aria-label="Primary">
        ${tabs.map((t) => {
          const active = isActive(t);
          return `<a href="${t.href}" class="app-tab${active ? ' active' : ''}"${active ? ' aria-current="page"' : ''}>` +
            `<span class="app-tab-ico" aria-hidden="true">${svgIcons[t.icon]}</span>` +
            `<span class="app-tab-label">${t.label}</span></a>`;
        }).join('')}
        <button type="button" class="app-tab${moreActive ? ' active' : ''}" id="tabbarMore" aria-label="More — open menu">
          <span class="app-tab-ico" aria-hidden="true">${svgIcons.hamburger}</span>
          <span class="app-tab-label">More</span>
        </button>
      </nav>
    `;
    document.body.insertAdjacentHTML('beforeend', tabbarHTML);
    // Content reserves room for the floating bar (see .has-tabbar in app.css).
    document.body.classList.add('has-tabbar');
    const moreBtn = document.getElementById('tabbarMore');
    moreBtn.querySelectorAll('svg').forEach((svg) => { svg.style.pointerEvents = 'none'; });
    moreBtn.addEventListener('click', function (e) {
      e.preventDefault();
      openDrawer();
    });
    moreBtn.addEventListener('touchend', function (e) {
      e.preventDefault();
      openDrawer();
    }, { passive: false });
  }

  /**
   * Prefetch main-nav targets on hover (desktop) / touchstart (mobile) so the
   * next page is warm before the tap lands. Nav links only — drawer, tab bar,
   * GC section tabs — never arbitrary anchors (PDFs etc.). One <link
   * rel="prefetch"> per URL per page load; requests flow through the service
   * worker, which caches fresh copies as a side effect.
   */
  function setupPrefetch() {
    const done = new Set();
    function handler(e) {
      const t = e.target;
      const a = t && t.closest ? t.closest('a.shared-drawer-item, a.app-tab, a.section-tab') : null;
      if (!a || !a.href || a.origin !== location.origin) return;
      const href = a.href.split('#')[0];
      if (done.has(href) || a.pathname === location.pathname) return;
      done.add(href);
      const link = document.createElement('link');
      link.rel = 'prefetch';
      link.href = href;
      document.head.appendChild(link);
    }
    document.addEventListener('mouseover', handler, { passive: true });
    document.addEventListener('touchstart', handler, { passive: true });
  }

  /**
   * Initialize the navigation when DOM is ready
   */
  function init() {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initialize);
    } else {
      initialize();
    }
  }

  function initialize() {
    injectNavigation();
    injectSectionTabs();
    injectTabBar();
    fixSvgPointerEvents();
    updateActiveState();
    setupHamburgerListener();
    setupDrawerListeners();
    setupPrefetch();
  }

  // Start initialization
  init();
})();
