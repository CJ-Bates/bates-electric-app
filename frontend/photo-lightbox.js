// photo-lightbox.js — shared full-screen photo viewer for visit photos.
// Used by BOTH the customer dashboard (my.html visit history) and the office
// generator-care customer modal (photo strips), so the two surfaces behave
// identically: close button, left/right arrows, swipe on touch, arrow keys on
// desktop, an "N of M" counter, and browser-back closes it (a history entry is
// pushed on open, so the phone back gesture works like it always has).
//
// Standalone on purpose: my.html doesn't load the staff app shell, so this
// file carries its own styles and exposes ONE global:
//   BatesLightbox.open(urls, startIndex)
(function () {
  'use strict';

  const SVG_X = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  const SVG_LEFT = '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>';
  const SVG_RIGHT = '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg>';

  const CSS = [
    '.bx-lb{position:fixed;inset:0;z-index:3000;background:rgba(13,21,43,.92);display:flex;align-items:center;justify-content:center;-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);touch-action:pan-y}',
    '.bx-lb img{max-width:94vw;max-height:86vh;border-radius:10px;box-shadow:0 12px 40px rgba(0,0,0,.5);user-select:none;-webkit-user-drag:none}',
    '.bx-lb-btn{position:absolute;display:flex;align-items:center;justify-content:center;width:44px;height:44px;border-radius:50%;border:1px solid rgba(255,255,255,.28);background:rgba(255,255,255,.12);color:#fff;cursor:pointer;padding:0;transition:background .15s}',
    '.bx-lb-btn:hover{background:rgba(255,255,255,.24)}',
    '.bx-lb-close{top:calc(14px + env(safe-area-inset-top,0px));right:14px}',
    '.bx-lb-prev{left:10px;top:50%;transform:translateY(-50%)}',
    '.bx-lb-next{right:10px;top:50%;transform:translateY(-50%)}',
    '.bx-lb-count{position:absolute;bottom:calc(18px + env(safe-area-inset-bottom,0px));left:50%;transform:translateX(-50%);color:#fff;font:600 13px/1 system-ui,-apple-system,sans-serif;letter-spacing:.4px;background:rgba(255,255,255,.14);border:1px solid rgba(255,255,255,.22);border-radius:999px;padding:7px 14px}',
    '@media(max-width:600px){.bx-lb-prev,.bx-lb-next{width:40px;height:40px}}',
  ].join('\n');

  let styleInjected = false;
  function injectStyle() {
    if (styleInjected) return;
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
    styleInjected = true;
  }

  // One lightbox at a time. `viaHistory` tracks whether teardown came from a
  // popstate (back button/gesture) — if not, WE call history.back() so the
  // entry pushed on open never lingers.
  let current = null;

  function open(urls, startIndex) {
    if (!urls || !urls.length) return;
    if (current) teardown(false);
    injectStyle();

    const state = {
      urls: urls.slice(),
      idx: Math.min(Math.max(startIndex || 0, 0), urls.length - 1),
    };

    const overlay = document.createElement('div');
    overlay.className = 'bx-lb';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Photo viewer');
    const multi = state.urls.length > 1;
    overlay.innerHTML =
      '<img alt="Visit photo">' +
      '<button type="button" class="bx-lb-btn bx-lb-close" aria-label="Close">' + SVG_X + '</button>' +
      (multi ? '<button type="button" class="bx-lb-btn bx-lb-prev" aria-label="Previous photo">' + SVG_LEFT + '</button>' : '') +
      (multi ? '<button type="button" class="bx-lb-btn bx-lb-next" aria-label="Next photo">' + SVG_RIGHT + '</button>' : '') +
      (multi ? '<div class="bx-lb-count" aria-live="polite"></div>' : '');

    const img = overlay.querySelector('img');
    const counter = overlay.querySelector('.bx-lb-count');
    function show(i) {
      state.idx = (i + state.urls.length) % state.urls.length;
      img.src = state.urls[state.idx];
      if (counter) counter.textContent = (state.idx + 1) + ' of ' + state.urls.length;
    }

    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      else if (multi && e.key === 'ArrowLeft') { e.preventDefault(); show(state.idx - 1); }
      else if (multi && e.key === 'ArrowRight') { e.preventDefault(); show(state.idx + 1); }
    }
    function onPop() { teardown(true); }

    // Swipe left/right moves through the set (horizontal-dominant swipes only,
    // so vertical scroll gestures pass through untouched).
    let touchX = null, touchY = null;
    overlay.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) { touchX = null; return; }
      touchX = e.touches[0].clientX; touchY = e.touches[0].clientY;
    }, { passive: true });
    overlay.addEventListener('touchend', (e) => {
      if (touchX == null || !e.changedTouches.length) return;
      const dx = e.changedTouches[0].clientX - touchX;
      const dy = e.changedTouches[0].clientY - touchY;
      touchX = null;
      if (!multi || Math.abs(dx) < 45 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      show(state.idx + (dx < 0 ? 1 : -1));
    }, { passive: true });

    overlay.querySelector('.bx-lb-close').addEventListener('click', close);
    const prev = overlay.querySelector('.bx-lb-prev');
    const next = overlay.querySelector('.bx-lb-next');
    if (prev) prev.addEventListener('click', () => show(state.idx - 1));
    if (next) next.addEventListener('click', () => show(state.idx + 1));
    // Tapping the backdrop (not the photo or a control) closes.
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

    document.addEventListener('keydown', onKey);
    window.addEventListener('popstate', onPop);
    let pushed = false;
    try { history.pushState({ batesLightbox: true }, ''); pushed = true; } catch (e) { /* viewer still works, back just navigates */ }

    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    document.body.appendChild(overlay);
    show(state.idx);

    current = { overlay, onKey, onPop, prevOverflow, pushed };
  }

  // In-UI closes (button, Escape, backdrop) tear down directly, then consume
  // the history entry pushed on open. The popstate listener is removed FIRST,
  // so that back() never re-enters. Back button/gesture arrives as a popstate
  // and tears down without touching history again.
  function close() { teardown(false); }

  function teardown(viaHistory) {
    if (!current) return;
    const c = current;
    current = null;
    document.removeEventListener('keydown', c.onKey);
    window.removeEventListener('popstate', c.onPop);
    document.body.style.overflow = c.prevOverflow;
    c.overlay.remove();
    if (!viaHistory && c.pushed) { try { history.back(); } catch (e) { /* ignore */ } }
  }

  window.BatesLightbox = { open };
})();
