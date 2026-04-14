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

  // SVG icon definitions
  const svgIcons = {
    hamburger: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" x2="20" y1="12" y2="12"/><line x1="4" x2="20" y1="6" y2="6"/><line x1="4" x2="20" y1="18" y2="18"/></svg>`,
    close: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`,
    house: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>`,
    clipboardCheck: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="m9 14 2 2 4-4"/></svg>`,
    layoutDashboard: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/></svg>`,
    shield: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>`,
    flaskConical: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 2v7.527a2 2 0 0 1-.211.896L4.72 20.55a1 1 0 0 0 .9 1.45h12.76a1 1 0 0 0 .9-1.45l-5.069-10.127A2 2 0 0 1 14 9.527V2"/><path d="M8.5 2h7"/><path d="M7 16.5h10"/></svg>`,
    users: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`,
    gamepad2: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="6" x2="10" y1="11" y2="11"/><line x1="8" x2="8" y1="9" y2="13"/><line x1="15" x2="15.01" y1="12" y2="12"/><line x1="18" x2="18.01" y1="10" y2="10"/><path d="M17.32 5H6.68a4 4 0 0 0-3.978 3.59c-.006.052-.01.101-.017.152C2.604 9.416 2 14.456 2 16a3 3 0 0 0 3 3c1.11 0 2.08-.402 2.592-1.382L9 15h6l1.408 2.618C16.92 18.598 17.89 19 19 19a3 3 0 0 0 3-3c0-1.544-.604-6.584-.685-7.258-.007-.05-.011-.1-.017-.151A4 4 0 0 0 17.32 5z"/></svg>`,
    settings: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>`,
    helpCircle: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/></svg>`,
    logOut: `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" x2="9" y1="12" y2="12"/></svg>`
  };

  // Drawer menu structure with SVG icons
  const drawerMenu = [
    {
      section: 'Main',
      items: [
        { label: 'Home', icon: 'house', href: 'home.html', id: 'drawer-home' },
        { label: 'Inspections', icon: 'clipboardCheck', href: 'inspection.html', id: 'drawer-inspection' },
        { label: 'Dashboard', icon: 'layoutDashboard', href: 'office.html', id: 'drawer-dashboard', officeOnly: true }
      ]
    },
    {
      section: 'Resources',
      items: [
        { label: 'Safety Docs', icon: 'shield', href: 'safety-docs.html', id: 'drawer-safety' },
        { label: 'SDS Sheets', icon: 'flaskConical', href: 'sds.html', id: 'drawer-sds' },
        { label: 'Contacts', icon: 'users', href: 'contacts.html', id: 'drawer-contacts' },
        { label: 'Games', icon: 'gamepad2', href: 'games.html', id: 'drawer-games' }
      ]
    },
    {
      section: 'Account',
      items: [
        { label: 'Settings', icon: 'settings', href: 'settings.html', id: 'drawer-settings' },
        { label: 'Help', icon: 'helpCircle', href: 'help.html', id: 'drawer-help' },
        { label: 'Sign Out', icon: 'logOut', href: '#', id: 'drawer-signout', isSignOut: true }
      ]
    }
  ];

  // Page title mapping
  const pageTitles = {
    'home': 'Home',
    'inspection': 'Inspection',
    'site-visit': 'Site Visit',
    'office': 'Dashboard',
    'safety-docs': 'Safety Docs',
    'sds': 'SDS Sheets',
    'contacts': 'Contacts',
    'games': 'Games'
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
    const pageTitle = getPageTitle();
    const isOffice = isOfficeRole();

    // Create top bar HTML
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
          // Skip Dashboard if not office role
          if (item.officeOnly && !isOffice) {
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
    if (pathname.includes('office')) return 'office';
    if (pathname.includes('site-visit')) return 'site-visit';
    if (pathname.includes('inspection')) return 'inspection';
    if (pathname.includes('safety-docs')) return 'safety-docs';
    if (pathname.includes('sds')) return 'sds';
    if (pathname.includes('contacts')) return 'contacts';
    if (pathname.includes('games')) return 'games';
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
      if (currentPage === 'site-visit' && itemId === 'drawer-inspection') isActive = true;
      if (currentPage === 'office' && itemId === 'drawer-dashboard') isActive = true;
      if (currentPage === 'safety-docs' && itemId === 'drawer-safety') isActive = true;
      if (currentPage === 'sds' && itemId === 'drawer-sds') isActive = true;
      if (currentPage === 'contacts' && itemId === 'drawer-contacts') isActive = true;
      if (currentPage === 'games' && itemId === 'drawer-games') isActive = true;

      item.classList.toggle('active', isActive);
    });
  }

  /**
   * Handle sign out (clear tokens and redirect)
   */
  function handleSignOut() {
    localStorage.removeItem('bates.auth.token');
    sessionStorage.removeItem('bates.auth.token');
    window.location.href = 'index.html';
  }

  /**
   * Handle hamburger button click
   */
  function setupHamburgerListener() {
    const hamburgerBtn = document.getElementById('hamburgerBtn');
    if (hamburgerBtn) {
      hamburgerBtn.addEventListener('click', openDrawer);
    }
  }

  /**
   * Handle drawer interactions
   */
  function setupDrawerListeners() {
    const overlay = document.getElementById('drawerOverlay');
    const drawer = document.getElementById('sharedDrawer');
    const closeBtn = document.getElementById('drawerClose');
    const topbarSignOut = document.getElementById('topbarSignOut');
    const drawerSignOut = document.getElementById('drawerSignOut');

    // Close drawer
    function closeDrawer() {
      overlay.classList.remove('open');
      drawer.classList.remove('open');
      document.body.style.overflow = '';
    }

    // Open drawer (globally available)
    window.openDrawer = function() {
      overlay.classList.add('open');
      drawer.classList.add('open');
      document.body.style.overflow = 'hidden';
    };

    // Close on overlay click
    overlay.addEventListener('click', closeDrawer);

    // Close on close button click
    closeBtn.addEventListener('click', closeDrawer);

    // Handle topbar sign out
    if (topbarSignOut) {
      topbarSignOut.addEventListener('click', (e) => {
        e.preventDefault();
        handleSignOut();
      });
    }

    // Handle drawer sign out
    if (drawerSignOut) {
      drawerSignOut.addEventListener('click', (e) => {
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
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && drawer.classList.contains('open')) {
        closeDrawer();
      }
    });
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
    updateActiveState();
    setupHamburgerListener();
    setupDrawerListeners();
  }

  // Start initialization
  init();
})();
