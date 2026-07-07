// photo-lightbox.js — shared full-screen photo viewer for visit photos.
// Used by BOTH the customer dashboard (my.html visit history) and the office
// generator-care customer modal (photo strips), so the two surfaces behave
// identically: close button, left/right arrows, swipe on touch, arrow keys on
// desktop, an "N of M" counter, browser-back closes it (a history entry is
// pushed on open, so the phone back gesture works like it always has), AND
// zoom: pinch + double-tap on touch, click-to-zoom + scroll-wheel on desktop,
// with one-finger panning while zoomed. Swiping between photos stays active
// at 1x; while zoomed, the same finger pans instead (arrows/keys still page,
// and paging resets the zoom).
//
// Standalone on purpose: my.html doesn't load the staff app shell, so this
// file carries its own styles and exposes ONE global:
//   BatesLightbox.open(urls, startIndex)
(function () {
  'use strict';

  var SVG_X = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  var SVG_LEFT = '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>';
  var SVG_RIGHT = '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg>';

  var MAX_SCALE = 4;
  var DBLTAP_SCALE = 2.2;

  // touch-action:none — the lightbox owns every gesture on the overlay (the
  // page behind is scroll-locked while open anyway). This is what lets pinch
  // reach us instead of being eaten by the browser; swipe stays implemented
  // in JS below, exactly as before.
  var CSS = [
    '.bx-lb{position:fixed;inset:0;z-index:3000;background:rgba(13,21,43,.92);display:flex;align-items:center;justify-content:center;-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);touch-action:none;overflow:hidden}',
    '.bx-lb img{max-width:94vw;max-height:86vh;border-radius:10px;box-shadow:0 12px 40px rgba(0,0,0,.5);user-select:none;-webkit-user-drag:none;will-change:transform;cursor:zoom-in}',
    '.bx-lb.bx-zoomed img{cursor:grab}',
    '.bx-lb.bx-panning img{cursor:grabbing}',
    '.bx-lb-btn{position:absolute;display:flex;align-items:center;justify-content:center;width:44px;height:44px;border-radius:50%;border:1px solid rgba(255,255,255,.28);background:rgba(255,255,255,.12);color:#fff;cursor:pointer;padding:0;transition:background .15s;touch-action:manipulation}',
    '.bx-lb-btn:hover{background:rgba(255,255,255,.24)}',
    '.bx-lb-close{top:calc(14px + env(safe-area-inset-top,0px));right:14px}',
    '.bx-lb-prev{left:10px;top:50%;transform:translateY(-50%)}',
    '.bx-lb-next{right:10px;top:50%;transform:translateY(-50%)}',
    '.bx-lb-count{position:absolute;bottom:calc(18px + env(safe-area-inset-bottom,0px));left:50%;transform:translateX(-50%);color:#fff;font:600 13px/1 system-ui,-apple-system,sans-serif;letter-spacing:.4px;background:rgba(255,255,255,.14);border:1px solid rgba(255,255,255,.22);border-radius:999px;padding:7px 14px}',
    '@media(max-width:600px){.bx-lb-prev,.bx-lb-next{width:40px;height:40px}}',
  ].join('\n');

  var styleInjected = false;
  function injectStyle() {
    if (styleInjected) return;
    var style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
    styleInjected = true;
  }

  // One lightbox at a time. `viaHistory` tracks whether teardown came from a
  // popstate (back button/gesture) — if not, WE call history.back() so the
  // entry pushed on open never lingers.
  var current = null;

  function open(urls, startIndex) {
    if (!urls || !urls.length) return;
    if (current) teardown(false);
    injectStyle();

    var state = {
      urls: urls.slice(),
      idx: Math.min(Math.max(startIndex || 0, 0), urls.length - 1),
    };

    var overlay = document.createElement('div');
    overlay.className = 'bx-lb';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Photo viewer');
    var multi = state.urls.length > 1;
    overlay.innerHTML =
      '<img alt="Visit photo" draggable="false">' +
      '<button type="button" class="bx-lb-btn bx-lb-close" aria-label="Close">' + SVG_X + '</button>' +
      (multi ? '<button type="button" class="bx-lb-btn bx-lb-prev" aria-label="Previous photo">' + SVG_LEFT + '</button>' : '') +
      (multi ? '<button type="button" class="bx-lb-btn bx-lb-next" aria-label="Next photo">' + SVG_RIGHT + '</button>' : '') +
      (multi ? '<div class="bx-lb-count" aria-live="polite"></div>' : '');

    var img = overlay.querySelector('img');
    var counter = overlay.querySelector('.bx-lb-count');

    // ---- Zoom/pan state ----------------------------------------------------
    // transform: translate(tx,ty) scale(s), origin center. The img is flex-
    // centered, so its layout center is the anchor all the math hangs off.
    var zoom = { s: 1, tx: 0, ty: 0 };

    function applyZoom(animated) {
      img.style.transition = animated ? 'transform .18s ease' : 'none';
      img.style.transform = 'translate(' + zoom.tx + 'px,' + zoom.ty + 'px) scale(' + zoom.s + ')';
      overlay.classList.toggle('bx-zoomed', zoom.s > 1);
    }
    // Keep the photo covering the viewport-ish: never pan it fully offscreen.
    function clampPan() {
      var maxX = Math.max(0, (img.offsetWidth * zoom.s - window.innerWidth) / 2 + 24);
      var maxY = Math.max(0, (img.offsetHeight * zoom.s - window.innerHeight) / 2 + 24);
      zoom.tx = Math.min(maxX, Math.max(-maxX, zoom.tx));
      zoom.ty = Math.min(maxY, Math.max(-maxY, zoom.ty));
    }
    function resetZoom(animated) {
      zoom.s = 1; zoom.tx = 0; zoom.ty = 0;
      applyZoom(animated);
    }
    // Zoom so the image point under screen point (px,py) stays put.
    function zoomAt(px, py, newScale, animated) {
      newScale = Math.min(MAX_SCALE, Math.max(1, newScale));
      var rect = img.getBoundingClientRect();
      var cx = rect.left + rect.width / 2;   // current visual center
      var cy = rect.top + rect.height / 2;
      var ratio = newScale / zoom.s;
      zoom.tx = px - (px - cx) * ratio - (cx - zoom.tx);
      zoom.ty = py - (py - cy) * ratio - (cy - zoom.ty);
      zoom.s = newScale;
      if (zoom.s === 1) { zoom.tx = 0; zoom.ty = 0; }
      clampPan();
      applyZoom(animated);
    }

    function show(i) {
      state.idx = (i + state.urls.length) % state.urls.length;
      img.src = state.urls[state.idx];
      resetZoom(false);
      if (counter) counter.textContent = (state.idx + 1) + ' of ' + state.urls.length;
    }

    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      else if (multi && e.key === 'ArrowLeft') { e.preventDefault(); show(state.idx - 1); }
      else if (multi && e.key === 'ArrowRight') { e.preventDefault(); show(state.idx + 1); }
    }
    function onPop() { teardown(true); }

    // ---- Gestures (pointer events) -----------------------------------------
    // 2 pointers = pinch-zoom (+ two-finger pan). 1 pointer while zoomed =
    // pan. 1 pointer at 1x = the horizontal-dominant swipe that pages the set
    // (vertical drags do nothing, same as before). Gestures starting on a
    // control button are left alone so taps on close/arrows stay taps.
    var pointers = new Map();
    var gesture = null;   // {kind:'swipe'|'pan'|'pinch', ...}
    var movedFar = false; // suppresses click-to-zoom / backdrop-close after drags
    var lastTap = { t: 0, x: 0, y: 0 };

    function pinchAnchor() {
      var pts = Array.from(pointers.values());
      return {
        x: (pts[0].x + pts[1].x) / 2,
        y: (pts[0].y + pts[1].y) / 2,
        d: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1,
      };
    }

    overlay.addEventListener('pointerdown', function (e) {
      if (e.target.closest && e.target.closest('.bx-lb-btn')) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pointers.size === 1) {
        movedFar = false;
        gesture = {
          kind: zoom.s > 1 ? 'pan' : 'swipe',
          startX: e.clientX, startY: e.clientY,
          startTx: zoom.tx, startTy: zoom.ty,
          type: e.pointerType,
        };
        if (gesture.kind === 'pan') overlay.classList.add('bx-panning');
      } else if (pointers.size === 2) {
        var a = pinchAnchor();
        gesture = { kind: 'pinch', start: a, startScale: zoom.s, startTx: zoom.tx, startTy: zoom.ty };
        overlay.classList.remove('bx-panning');
      }
    });

    overlay.addEventListener('pointermove', function (e) {
      if (!pointers.has(e.pointerId) || !gesture) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (Math.hypot(e.clientX - (gesture.startX || e.clientX), e.clientY - (gesture.startY || e.clientY)) > 6) movedFar = true;

      if (gesture.kind === 'pinch' && pointers.size === 2) {
        var now = pinchAnchor();
        var newScale = Math.min(MAX_SCALE, Math.max(1, gesture.startScale * (now.d / gesture.start.d)));
        // Keep the image point that was under the starting midpoint under the
        // current midpoint: combined pinch-zoom + two-finger pan.
        var rect = img.getBoundingClientRect();
        var cx = rect.left + rect.width / 2 - zoom.tx;  // untranslated center
        var cy = rect.top + rect.height / 2 - zoom.ty;
        var ratio = newScale / gesture.startScale;
        zoom.tx = now.x - cx - (gesture.start.x - cx - gesture.startTx) * ratio;
        zoom.ty = now.y - cy - (gesture.start.y - cy - gesture.startTy) * ratio;
        zoom.s = newScale;
        clampPan();
        applyZoom(false);
        movedFar = true;
      } else if (gesture.kind === 'pan' && pointers.size === 1) {
        zoom.tx = gesture.startTx + (e.clientX - gesture.startX);
        zoom.ty = gesture.startTy + (e.clientY - gesture.startY);
        clampPan();
        applyZoom(false);
      }
    });

    function endPointer(e) {
      if (!pointers.has(e.pointerId)) return;
      var wasKind = gesture && gesture.kind;
      var start = gesture;
      pointers.delete(e.pointerId);

      if (wasKind === 'pinch') {
        if (pointers.size === 1) {
          // One finger lifted: keep going as a pan with the remaining finger.
          var left = Array.from(pointers.values())[0];
          gesture = { kind: zoom.s > 1 ? 'pan' : 'swipe', startX: left.x, startY: left.y, startTx: zoom.tx, startTy: zoom.ty, type: e.pointerType };
        } else {
          gesture = null;
          if (zoom.s <= 1.02) resetZoom(true); // snap tidy at ~1x
        }
        return;
      }

      overlay.classList.remove('bx-panning');
      gesture = null;
      if (!start) return;

      if (wasKind === 'swipe' && e.type === 'pointerup') {
        var dx = e.clientX - start.startX;
        var dy = e.clientY - start.startY;
        if (multi && Math.abs(dx) >= 45 && Math.abs(dx) >= Math.abs(dy) * 1.5) {
          show(state.idx + (dx < 0 ? 1 : -1));
          return;
        }
        // Double-tap toggles zoom on touch (mouse gets click-to-zoom below).
        if (start.type !== 'mouse' && !movedFar && e.target === img) {
          var t = Date.now();
          if (t - lastTap.t < 320 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 40) {
            lastTap.t = 0;
            zoomAt(e.clientX, e.clientY, DBLTAP_SCALE, true);
          } else {
            lastTap = { t: t, x: e.clientX, y: e.clientY };
          }
        }
      } else if (wasKind === 'pan' && start.type !== 'mouse' && !movedFar && e.type === 'pointerup' && e.target === img) {
        // Double-tap while zoomed: back to 1x.
        var t2 = Date.now();
        if (t2 - lastTap.t < 320 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 40) {
          lastTap.t = 0;
          resetZoom(true);
        } else {
          lastTap = { t: t2, x: e.clientX, y: e.clientY };
        }
      }
    }
    overlay.addEventListener('pointerup', endPointer);
    overlay.addEventListener('pointercancel', endPointer);
    // A mouse released outside the window never fires pointerup on us; purge
    // so a stale entry can't fake a two-finger pinch later. (Touch gestures
    // always end in pointerup/pointercancel.)
    overlay.addEventListener('pointerleave', function (e) {
      if (e.pointerType !== 'mouse') return;
      pointers.delete(e.pointerId);
      gesture = null;
      overlay.classList.remove('bx-panning');
    });

    // Desktop: click the photo to zoom in/out, scroll wheel to zoom smoothly.
    img.addEventListener('click', function (e) {
      if (movedFar) return;
      // Touch taps are handled by the double-tap logic above.
      var fine = window.matchMedia && window.matchMedia('(pointer: fine)').matches;
      if (!fine) return;
      if (zoom.s > 1) resetZoom(true);
      else zoomAt(e.clientX, e.clientY, DBLTAP_SCALE, true);
    });
    overlay.addEventListener('wheel', function (e) {
      e.preventDefault();
      var factor = e.deltaY < 0 ? 1.2 : 1 / 1.2;
      zoomAt(e.clientX, e.clientY, zoom.s * factor, false);
    }, { passive: false });

    // Belt-and-braces for older iOS: stop Safari's native page pinch/scroll
    // while the viewer is up (touch-action:none covers modern browsers).
    overlay.addEventListener('touchmove', function (e) { e.preventDefault(); }, { passive: false });

    overlay.querySelector('.bx-lb-close').addEventListener('click', close);
    var prev = overlay.querySelector('.bx-lb-prev');
    var next = overlay.querySelector('.bx-lb-next');
    if (prev) prev.addEventListener('click', function () { show(state.idx - 1); });
    if (next) next.addEventListener('click', function () { show(state.idx + 1); });
    // Tapping the backdrop (not the photo or a control) closes — unless the
    // touch was really a drag that happened to end on the backdrop.
    overlay.addEventListener('click', function (e) { if (e.target === overlay && !movedFar) close(); });

    document.addEventListener('keydown', onKey);
    window.addEventListener('popstate', onPop);
    var pushed = false;
    try { history.pushState({ batesLightbox: true }, ''); pushed = true; } catch (e) { /* viewer still works, back just navigates */ }

    var prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    document.body.appendChild(overlay);
    show(state.idx);

    current = { overlay: overlay, onKey: onKey, onPop: onPop, prevOverflow: prevOverflow, pushed: pushed };
  }

  // In-UI closes (button, Escape, backdrop) tear down directly, then consume
  // the history entry pushed on open. The popstate listener is removed FIRST,
  // so that back() never re-enters. Back button/gesture arrives as a popstate
  // and tears down without touching history again.
  function close() { teardown(false); }

  function teardown(viaHistory) {
    if (!current) return;
    var c = current;
    current = null;
    document.removeEventListener('keydown', c.onKey);
    window.removeEventListener('popstate', c.onPop);
    document.body.style.overflow = c.prevOverflow;
    c.overlay.remove();
    if (!viaHistory && c.pushed) { try { history.back(); } catch (e) { /* ignore */ } }
  }

  window.BatesLightbox = { open: open };
})();
