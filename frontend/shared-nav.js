/**
 * Shared Navigation Component for Bates Electric PWA
 *
 * Injects a bottom navigation bar + slide-out drawer menu on any page.
 * Include this script on pages that need navigation.
 *
 * Usage: <script src="shared-nav.js"></script>
 */

(function() {
  'use strict';

  // Navigation tab definitions
  const navTabs = [
    { id: 'home', label: 'Home', icon: '🏠', href: '/home.html' },
    { id: 'inspection', label: 'Inspection', icon: '📋', href: '/inspection.html' },
    { id: 'safety', label: 'Safety', icon: '⚠️', href: '#safety' },
    { id: 'contacts', label: 'Contacts', icon: '👥', href: '#contacts' },
    { id: 'more', label: 'More', icon: '⋯', href: '#' }
  ];

  // Drawer menu structure
  const drawerMenu = [
    {
      section: 'Main',
      items: [
        { label: 'Home', icon: '🏠', href: '/home.html', id: 'drawer-home' },
        { label: 'Inspections', icon: '📋', href: '/inspection.html', id: 'drawer-inspection' },
        { label: 'Dashboard', icon: '📊', href: '/office.html', id: 'drawer-dashboard' }
      ]
    },
    {
      section: 'Resources',
      items: [
        { label: 'Safety Docs', icon: '📄', href: '#safety', id: 'drawer-safety' },
        { label: 'Contacts', icon: '👥', href: '#contacts', id: 'drawer-contacts' },
        { label: 'Training', icon: '🎓', href: '#training', id: 'drawer-training' }
      ]
    },
    {
      section: 'Account',
      items: [
        { label: 'Settings', icon: '⚙️', href: '#settings', id: 'drawer-settings' },
        { label: 'Help', icon: '❓', href: '#help', id: 'drawer-help' },
        { label: 'Sign Out', icon: '🚪', href: '/index.html', id: 'drawer-signout' }
      ]
    }
  ];

  /**
   * Inject the navigation HTML into the page
   */
  function injectNavigation() {
    // Create bottom nav HTML
    const navHTML = `
      <nav class="shared-bottom-nav" aria-label="Main navigation">
        ${navTabs.map(tab => `
          <button class="shared-nav-item" data-tab="${tab.id}" aria-label="${tab.label}" title="${tab.label}">
            <span class="shared-nav-icon">${tab.icon}</span>
            <span class="shared-nav-label">${tab.label}</span>
          </button>
        `).join('')}
      </nav>
    `;

    // Create drawer overlay + drawer
    const drawerHTML = `
      <div class="shared-drawer-overlay" id="drawerOverlay"></div>
      <aside class="shared-drawer" id="sharedDrawer" aria-label="Navigation menu">
        <div class="shared-drawer-header">
          <h2 class="shared-drawer-title">Bates Electric</h2>
          <p class="shared-drawer-subtitle">Field Service</p>
          <button class="shared-drawer-close" id="drawerClose" aria-label="Close menu">✕</button>
        </div>
        <nav class="shared-drawer-nav">
          ${drawerMenu.map(group => `
            <div class="shared-drawer-section">
              <h3 class="shared-drawer-section-label">${group.section}</h3>
              ${group.items.map(item => `
                <a href="${item.href}" class="shared-drawer-item" data-drawer-item="${item.id}" role="menuitem">
                  <span class="shared-drawer-item-icon">${item.icon}</span>
                  <span class="shared-drawer-item-label">${item.label}</span>
                </a>
              `).join('')}
            </div>
          `).join('')}
        </nav>
      </aside>
    `;

    // Inject into DOM
    document.body.insertAdjacentHTML('beforeend', navHTML);
    document.body.insertAdjacentHTML('beforeend', drawerHTML);
  }

  /**
   * Determine the current page based on URL
   */
  function getCurrentPage() {
    const pathname = window.location.pathname;
    if (pathname.includes('office')) return 'office';
    if (pathname.includes('home')) return 'home';
    if (pathname.includes('inspection')) return 'inspection';
    if (pathname.includes('safety')) return 'safety';
    if (pathname.includes('contacts')) return 'contacts';
    return 'home'; // default
  }

  /**
   * Update active state of nav items based on current page
   */
  function updateActiveState() {
    const currentPage = getCurrentPage();

    // Update bottom nav
    document.querySelectorAll('.shared-nav-item').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === currentPage);
    });

    // Update drawer items
    document.querySelectorAll('.shared-drawer-item').forEach(item => {
      const isActive =
        (currentPage === 'home' && item.dataset.drawerItem === 'drawer-home') ||
        (currentPage === 'inspection' && item.dataset.drawerItem === 'drawer-inspection') ||
        (currentPage === 'office' && item.dataset.drawerItem === 'drawer-dashboard') ||
        (currentPage === 'safety' && item.dataset.drawerItem === 'drawer-safety') ||
        (currentPage === 'contacts' && item.dataset.drawerItem === 'drawer-contacts');
      item.classList.toggle('active', isActive);
    });
  }

  /**
   * Handle bottom nav tab clicks
   */
  function setupBottomNavListeners() {
    document.querySelectorAll('.shared-nav-item').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const tab = btn.dataset.tab;

        // Handle "More" tab — open drawer instead of navigation
        if (tab === 'more') {
          e.preventDefault();
          openDrawer();
          return;
        }

        // Navigate to tab's href
        const tabData = navTabs.find(t => t.id === tab);
        if (tabData && tabData.href !== '#') {
          window.location.href = tabData.href;
        }
      });
    });
  }

  /**
   * Handle drawer interactions
   */
  function setupDrawerListeners() {
    const overlay = document.getElementById('drawerOverlay');
    const drawer = document.getElementById('sharedDrawer');
    const closeBtn = document.getElementById('drawerClose');

    // Close drawer
    function closeDrawer() {
      overlay.classList.remove('open');
      drawer.classList.remove('open');
      document.body.style.overflow = '';
    }

    // Open drawer
    window.openDrawer = function() {
      overlay.classList.add('open');
      drawer.classList.add('open');
      document.body.style.overflow = 'hidden';
    };

    // Close on overlay click
    overlay.addEventListener('click', closeDrawer);

    // Close on close button click
    closeBtn.addEventListener('click', closeDrawer);

    // Close on drawer item click (navigation)
    document.querySelectorAll('.shared-drawer-item').forEach(item => {
      // Don't close for hash links (for now)
      if (!item.href.startsWith('#')) {
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
    // Wait for DOM to be fully loaded
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initialize);
    } else {
      initialize();
    }
  }

  function initialize() {
    injectNavigation();
    updateActiveState();
    setupBottomNavListeners();
    setupDrawerListeners();
  }

  // Start initialization
  init();
})();
