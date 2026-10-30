// frontend/scanner.js
// Camera + keyboard-wedge barcode scanning for the inventory pages.
//
//   const s = BatesScanner.open({ title, continuous, onScan, footer })
//     onScan(code, format, source) -> may return a Promise; scanning pauses
//       until it settles. Return 'close' to close the scanner (single mode
//       closes after the first accepted read on its own).
//     source: 'camera' | 'scanner' (USB/Bluetooth wedge) | 'manual'
//   s.setStatus(html, kind)  s.pause()  s.resume()  s.close()
//
//   const stop = BatesScanner.listenWedge(handler)  // page-level USB scanner
//
// Decoding: the native BarcodeDetector where it exists and supports our
// formats (Android Chrome); otherwise scanner-worker.js (vendored ZXing) in a
// Web Worker, fed a cropped, downscaled frame ~8x a second (iPhone Safari).
// Debounce: a code is accepted once, then ignored until it has LEFT the
// frame for 700 ms - so holding the phone on one box never counts it twice,
// and count mode re-counts only when the user moves off and back. 1D codes
// on the worker path need two identical reads in a row (fewer misreads).
// Feedback: a short beep (WebAudio, no file) + vibration where supported
// (Android; iPhone browsers have no vibration API). Torch where the camera
// exposes it (Android Chrome); the button is hidden otherwise.

(() => {
  const WANTED = ['upc_a', 'upc_e', 'ean_13', 'ean_8', 'code_128', 'code_39', 'itf', 'qr_code', 'data_matrix'];
  const TWO_D = new Set(['qr_code', 'data_matrix']);
  const LEAVE_MS = 700;
  const WORKER_INTERVAL_MS = 120;
  const NATIVE_INTERVAL_MS = 100;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const svg = (d, s = 22) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const ICON = {
    close: svg('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
    torch: svg('<path d="M8 2h8l-1 6H9z"/><path d="M9 8v12a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2V8"/><path d="M12 12v3"/>'),
    keyboard: svg('<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>', 18),
  };

  // ---- feedback -------------------------------------------------------------
  let audio = null;
  function beep() {
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      if (audio.state === 'suspended') audio.resume();
      const o = audio.createOscillator();
      const g = audio.createGain();
      o.type = 'square'; o.frequency.value = 1760;
      g.gain.setValueAtTime(0.06, audio.currentTime);
      g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.11);
      o.connect(g); g.connect(audio.destination);
      o.start(); o.stop(audio.currentTime + 0.12);
    } catch (e) { /* no audio: the on-screen flash still confirms */ }
    try { if (navigator.vibrate) navigator.vibrate(60); } catch (e) { /* unsupported */ }
  }

  // ---- decoders -------------------------------------------------------------
  let nativeDetector; // undefined = not probed yet; null = unavailable
  async function getNativeDetector() {
    if (nativeDetector !== undefined) return nativeDetector;
    nativeDetector = null;
    try {
      if ('BarcodeDetector' in window) {
        const supported = await window.BarcodeDetector.getSupportedFormats();
        const formats = WANTED.filter((f) => supported.includes(f));
        // Need at least the retail + Code 128 set, else ZXing does better.
        if (['ean_13', 'upc_a', 'code_128'].every((f) => formats.includes(f))) {
          nativeDetector = new window.BarcodeDetector({ formats });
        }
      }
    } catch (e) { nativeDetector = null; }
    return nativeDetector;
  }

  let worker = null;
  let workerSeq = 0;
  const workerWaiters = new Map();
  function getWorker() {
    if (worker) return worker;
    worker = new Worker('scanner-worker.js');
    worker.onmessage = (e) => {
      const w = workerWaiters.get(e.data.id);
      if (w) { workerWaiters.delete(e.data.id); w(e.data.result); }
    };
    worker.onerror = () => { workerWaiters.forEach((w) => w(null)); workerWaiters.clear(); };
    return worker;
  }
  function workerDecode(imageData) {
    return new Promise((resolve) => {
      const id = ++workerSeq;
      workerWaiters.set(id, resolve);
      const buf = imageData.data.buffer;
      getWorker().postMessage({ id, buffer: buf, width: imageData.width, height: imageData.height }, [buf]);
      setTimeout(() => { if (workerWaiters.has(id)) { workerWaiters.delete(id); resolve(null); } }, 1500);
    });
  }

  // ---- keyboard-wedge scanners ----------------------------------------------
  // A USB/Bluetooth scanner "types" the code fast and presses Enter. Humans
  // don't type 6+ characters at < 50 ms per key, so the timing tells them apart.
  function makeWedge(onCode) {
    let buf = '';
    let last = 0;
    let gaps = [];
    return (e) => {
      const now = performance.now();
      if (e.key === 'Enter') {
        const fast = buf.length >= 4 && gaps.length && (gaps.reduce((a, b) => a + b, 0) / gaps.length) < 50;
        const code = buf;
        buf = ''; gaps = [];
        if (fast) { e.preventDefault(); onCode(code); }
        return;
      }
      if (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) return;
      if (now - last > 120) { buf = ''; gaps = []; }
      else if (buf) gaps.push(now - last);
      buf += e.key;
      last = now;
    };
  }
  function listenWedge(handler) {
    const onKey = makeWedge((code) => handler(code, null, 'scanner'));
    const wrapped = (e) => {
      // A focused text field gets the keystrokes itself (its own Enter handler).
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (document.querySelector('.bsc-overlay')) return; // the scanner overlay has its own listener
      onKey(e);
    };
    document.addEventListener('keydown', wrapped, true);
    return () => document.removeEventListener('keydown', wrapped, true);
  }

  // ---- the overlay ----------------------------------------------------------
  function open({ title = 'Scan a barcode', continuous = false, onScan, footer = '' } = {}) {
    const root = document.createElement('div');
    root.className = 'bsc-overlay';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', title);
    root.innerHTML = `
      <div class="bsc-top">
        <div class="bsc-title">${esc(title)}</div>
        <button type="button" class="bsc-iconbtn" data-bsc-close aria-label="Close scanner">${ICON.close}</button>
      </div>
      <div class="bsc-stage">
        <video class="bsc-video" playsinline muted autoplay></video>
        <div class="bsc-box" aria-hidden="true"><span></span></div>
        <div class="bsc-camera-msg" hidden></div>
      </div>
      <div class="bsc-bottom">
        <div class="bsc-status" aria-live="polite">Point the camera at the barcode</div>
        <div class="bsc-tools">
          <button type="button" class="bsc-iconbtn" data-bsc-torch aria-label="Flashlight" aria-pressed="false" hidden>${ICON.torch}</button>
          <form class="bsc-manual" data-bsc-manual autocomplete="off">
            <span class="bsc-manual-icon">${ICON.keyboard}</span>
            <input type="text" inputmode="text" enterkeyhint="go" placeholder="Type a barcode or part #" aria-label="Type a barcode or part number" />
            <button type="submit" class="btn btn-secondary btn-sm">Go</button>
          </form>
        </div>
        ${footer ? `<div class="bsc-footer">${footer}</div>` : ''}
      </div>`;
    document.body.appendChild(root);
    document.documentElement.classList.add('bsc-open');

    const video = root.querySelector('video');
    const statusEl = root.querySelector('.bsc-status');
    const box = root.querySelector('.bsc-box');
    const camMsg = root.querySelector('.bsc-camera-msg');
    const torchBtn = root.querySelector('[data-bsc-torch]');
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    let stream = null;
    let track = null;
    let closed = false;
    let paused = false;
    let busy = false;
    let timer = null;
    let detector = null;
    let lastAccepted = null;       // code most recently accepted
    let lastSeenAt = 0;            // when that code was last in frame
    let pending1D = null;          // worker path: first read awaiting confirmation

    const setStatus = (html, kind) => {
      statusEl.innerHTML = html;
      statusEl.className = 'bsc-status' + (kind ? ' ' + kind : '');
    };

    async function accept(code, format, source) {
      if (closed || busy) return;
      busy = true;
      beep();
      box.classList.add('hit');
      setTimeout(() => box.classList.remove('hit'), 260);
      let outcome;
      try { outcome = await (onScan ? onScan(code, format, source) : null); } catch (e) { setStatus(esc(e.message || 'Something went wrong'), 'warn'); }
      // Treat the code as "just seen": if it is still in frame after a slow
      // handler (e.g. the quick-add form), it must leave before it counts again.
      lastSeenAt = performance.now();
      busy = false;
      if (outcome === 'close' || (!continuous && outcome !== 'keep')) close();
    }

    // One camera read. Debounce by "has it left the frame?".
    function seen(code, format) {
      const now = performance.now();
      if (code === lastAccepted) {
        if (now - lastSeenAt < LEAVE_MS) { lastSeenAt = now; return; }
      }
      lastSeenAt = now;
      lastAccepted = code;
      accept(code, format, 'camera');
    }
    function nothingSeen() { /* the absence itself is the debounce clock */ }

    async function tick() {
      if (closed) return;
      if (!paused && !busy && video.readyState >= 2 && video.videoWidth) {
        try {
          if (detector) {
            const found = await detector.detect(video);
            const hit = found && found.find((b) => b.rawValue);
            if (hit) seen(hit.rawValue, hit.format); else nothingSeen();
          } else {
            // Crop to the scan box (center 86% x 50%) and cap the width - the
            // whole 1080p frame is slow on older iPhones and adds nothing.
            const vw = video.videoWidth; const vh = video.videoHeight;
            const cw = Math.round(vw * 0.86); const ch = Math.round(vh * 0.5);
            const sx = Math.round((vw - cw) / 2); const sy = Math.round((vh - ch) / 2);
            const scale = Math.min(1, 900 / cw);
            canvas.width = Math.round(cw * scale); canvas.height = Math.round(ch * scale);
            ctx.drawImage(video, sx, sy, cw, ch, 0, 0, canvas.width, canvas.height);
            const result = await workerDecode(ctx.getImageData(0, 0, canvas.width, canvas.height));
            if (result && result.text) {
              if (TWO_D.has(result.format) || (pending1D && pending1D.text === result.text)) {
                pending1D = null;
                seen(result.text, result.format);
              } else {
                pending1D = result;
              }
            } else {
              pending1D = null;
              nothingSeen();
            }
          }
        } catch (e) { /* a dropped frame */ }
      }
      if (!closed) timer = setTimeout(tick, detector ? NATIVE_INTERVAL_MS : WORKER_INTERVAL_MS);
    }

    async function startCamera() {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        camMsg.hidden = false;
        camMsg.textContent = 'This browser can\'t use the camera here. Type the barcode below, or use a USB scanner.';
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        });
        if (closed) { stream.getTracks().forEach((t) => t.stop()); return; }
        video.srcObject = stream;
        await video.play().catch(() => {});
        track = stream.getVideoTracks()[0];
        const caps = track && track.getCapabilities ? track.getCapabilities() : {};
        if (caps.torch) torchBtn.hidden = false;
        if (caps.focusMode && caps.focusMode.includes('continuous')) {
          track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
        }
        detector = await getNativeDetector();
        tick();
      } catch (e) {
        camMsg.hidden = false;
        camMsg.textContent = e && e.name === 'NotAllowedError'
          ? 'Camera permission is off. Allow the camera for this site in your browser settings, or type the barcode below.'
          : 'Couldn\'t start the camera. Type the barcode below, or use a USB scanner.';
      }
    }

    torchBtn.addEventListener('click', async () => {
      if (!track) return;
      const on = torchBtn.getAttribute('aria-pressed') !== 'true';
      try {
        await track.applyConstraints({ advanced: [{ torch: on }] });
        torchBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
      } catch (e) { torchBtn.hidden = true; }
    });

    const manual = root.querySelector('[data-bsc-manual]');
    manual.addEventListener('submit', (e) => {
      e.preventDefault();
      const input = manual.querySelector('input');
      const v = input.value.trim();
      if (!v) return;
      input.value = '';
      input.blur();
      accept(v, null, 'manual');
    });

    const wedge = makeWedge((code) => accept(code, null, 'scanner'));
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); close(); return; }
      if (e.target && e.target.closest && e.target.closest('[data-bsc-manual]')) return;
      wedge(e);
    };
    document.addEventListener('keydown', onKey, true);
    root.querySelector('[data-bsc-close]').addEventListener('click', () => close());

    function close() {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      document.removeEventListener('keydown', onKey, true);
      if (stream) stream.getTracks().forEach((t) => t.stop());
      root.remove();
      document.documentElement.classList.remove('bsc-open');
      if (typeof onClose === 'function') onClose();
    }
    let onClose = null;

    startCamera();
    return {
      setStatus,
      pause: () => { paused = true; },
      resume: () => { paused = false; lastSeenAt = performance.now(); },
      close,
      onClose: (fn) => { onClose = fn; },
      get closed() { return closed; },
    };
  }

  window.BatesScanner = { open, listenWedge, beep, _makeWedge: makeWedge };
})();
