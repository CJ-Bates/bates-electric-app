// icons.js — shared inline-SVG icon set, Design System v3 §11b house style:
// 24px grid, stroke-based, stroke-width 1.75, round caps/joins,
// stroke="currentColor" so icons inherit text color in both themes.
// Sizes: 20px default · 16px inline-with-text · 24px nav.
//
// Usage:  BatesIcons.icon('check')          -> 20px check SVG string
//         BatesIcons.icon('phone', 16)      -> 16px phone SVG string
// No icon font, no CDN — the app ships zero emoji and zero font glyphs.
(function () {
  'use strict';

  // Path data on the shared 24px grid (attributes added by icon()).
  const PATHS = {
    check: '<path d="M4 12.5 9.5 18 20 6.5"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    warn: '<path d="M12 3 2.5 20h19L12 3z"/><path d="M12 9.5V14"/><circle cx="12" cy="17" r="0.5" fill="currentColor"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><circle cx="12" cy="8" r="0.5" fill="currentColor"/>',
    error: '<path d="M12 5v9"/><circle cx="12" cy="18" r="0.5" fill="currentColor"/>',
    phone: '<path d="M15.5 20.5c-2.6-.6-5.2-2.1-7.4-4.3S4.4 11.4 3.8 8.8c-.3-1.2 0-2.4.9-3.2l1.3-1.2c.6-.6 1.6-.5 2.1.2l1.7 2.4c.4.6.4 1.4-.1 1.9l-1 1.1c.5 1.1 1.2 2.2 2.2 3.2s2.1 1.7 3.2 2.2l1.1-1c.5-.5 1.3-.5 1.9-.1l2.4 1.7c.7.5.8 1.5.2 2.1l-1.2 1.3c-.8.9-2 1.2-3.2.9z"/>',
    external: '<path d="M14 4h6v6M20 4 10.5 13.5M9 5H5v14h14v-4"/>',
    arrowUpRight: '<path d="M7 17 17 7"/><path d="M8 7h9v9"/>',
    trendUp: '<path d="M3.5 17 10 10.5l4 4L20.5 8"/><path d="M14.5 8h6v6"/>',
    trendDown: '<path d="M3.5 7 10 13.5l4-4L20.5 16"/><path d="M14.5 16h6v-6"/>',
    trendFlat: '<path d="M4 12h16"/><path d="m16.5 8.5 3.5 3.5-3.5 3.5"/>',
    sun: '<circle cx="12" cy="12" r="4.5"/><path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M18.7 5.3l-1.8 1.8M7.1 16.9l-1.8 1.8"/>',
    moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z"/>',
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
    home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/>',
    bolt: '<path d="M13 2 4.5 13.5H11L10 22l8.5-11.5H13L13 2z"/>',
  };

  function icon(name, size) {
    const paths = PATHS[name];
    if (!paths) return '';
    const s = size || 20;
    return '<svg width="' + s + '" height="' + s + '" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" ' +
      'aria-hidden="true">' + paths + '</svg>';
  }

  window.BatesIcons = { icon: icon, names: Object.keys(PATHS) };
})();
