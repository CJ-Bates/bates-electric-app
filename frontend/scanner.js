// frontend/scanner.js
// Camera + keyboard-wedge barcode scanning for the inventory pages.
//
//   const s = BatesScanner.open({ title, mode, stayOpen, onScan, footer })
//     mode: 'tap' (default) - the camera opens AIMING and reads nothing until
//             the big Scan button is pressed; then it reads for up to 3 s,
//             only codes inside the aiming box, nearest the centre; two or
//             more codes in the box -> a pick list instead of a guess.
//           'continuous' - reads all the time (fast counting of one item at
//             a time), still only inside the box; two codes in the box are
//             skipped with a hint rather than guessed.
//     stayOpen: keep the scanner open after a read (count sessions).
//     onScan(code, format, source) -> may return a Promise; reading pauses
//       until it settles. Return 'close' to close; 'keep' keeps a one-shot
//       scanner open. source: 'camera' | 'scanner' (USB/Bluetooth) | 'manual'
//   s.setStatus(html, kind)  s.pause()  s.resume()  s.close()  s.onClose(fn)
//
//   const stop = BatesScanner.listenWedge(handler)  // page-level USB scanner
//
// Why aim-then-scan (CJ's first real-phone test, 2026-10-30): reading the
// moment the camera opened grabbed whichever of several barcodes it saw
// first. Decoding: the native BarcodeDetector where it supports our formats
// (Android Chrome), filtered to codes fully inside the box; otherwise
// scanner-worker.js (vendored ZXing) on the box crop (iPhone Safari), which
// finds up to 3 codes per frame. Same behaviour on both. Feedback: a beep
// (WebAudio) + vibration where supported (Android). Torch where the camera
// exposes it (Android Chrome); hidden otherwise.

(() => {
  const WANTED = ['upc_a', 'upc_e', 'ean_13', 'ean_8', 'code_128', 'code_39', 'itf', 'qr_code', 'data_matrix'];
  const NO_CHECKSUM = new Set(['code_39', 'itf']); // 1D codes with no check digit: confirm with a second read
  const READ_WINDOW_MS = 3000;
  const LEAVE_MS = 700;
  const WORKER_INTERVAL_MS = 120;
  const NATIVE_INTERVAL_MS = 100;
  const FORMAT_LABEL = { upc_a: 'UPC-A', upc_e: 'UPC-E', ean_13: 'EAN-13', ean_8: 'EAN-8', code_128: 'Code 128', code_39: 'Code 39', itf: 'ITF', qr_code: 'QR', data_matrix: 'Data Matrix' };
  const fmtLabel = (f) => FORMAT_LABEL[f] || (f ? String(f).replace(/_/g, ' ').toUpperCase() : 'Barcode');
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const svg = (d, s = 22) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const ICON = {
    close: svg('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
    torch: svg('<path d="M8 2h8l-1 6H9z"/><path d="M9 8v12a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2V8"/><path d="M12 12v3"/>'),
    keyboard: svg('<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10"/>', 18),
    scan: svg('<path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><path d="M7 8v8M10 8v8M13 8v8M17 8v8"/>', 26),
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
      if (w) { workerWaiters.delete(e.data.id); w(e.data.results || []); }
    };
    worker.onerror = () => { workerWaiters.forEach((w) => w([])); workerWaiters.clear(); };
    return worker;
  }
  function workerDecode(imageData) {
    return new Promise((resolve) => {
      const id = ++workerSeq;
      workerWaiters.set(id, resolve);
      const buf = imageData.data.buffer;
      getWorker().postMessage({ id, buffer: buf, width: imageData.width, height: imageData.height }, [buf]);
      setTimeout(() => { if (workerWaiters.has(id)) { workerWaiters.delete(id); resolve([]); } }, 1500);
    });
  }

  // ---- keyboard-wedge scanners ----------------------------------------------
  // A USB/Bluetooth scanner "types" the code fast and presses Enter. Humans
  // don't type 4+ characters at < 50 ms per key, so the timing tells them apart.
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
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (document.querySelector('.bsc-overlay')) return; // the scanner overlay has its own listener
      onKey(e);
    };
    document.addEventListener('keydown', wrapped, true);
    return () => document.removeEventListener('keydown', wrapped, true);
  }

  // ---- the overlay ----------------------------------------------------------
  function open({ title = 'Scan a barcode', mode = 'tap', stayOpen = false, onScan, footer = '' } = {}) {
    const continuous = mode === 'continuous';
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
        <div class="bsc-box${continuous ? ' live' : ''}" aria-hidden="true"><i class="bsc-cross-h"></i><i class="bsc-cross-v"></i></div>
        <div class="bsc-camera-msg" hidden></div>
        <div class="bsc-pick" hidden role="group" aria-label="Choose a barcode"></div>
      </div>
      <div class="bsc-bottom">
        <div class="bsc-status" aria-live="polite">${continuous ? 'Hold one barcode in the box' : 'Aim the box at one barcode, then tap Scan'}</div>
        <div class="bsc-controls">
          <button type="button" class="bsc-iconbtn" data-bsc-torch aria-label="Flashlight" aria-pressed="false" hidden>${ICON.torch}</button>
          <button type="button" class="bsc-scanbtn" data-bsc-scan aria-label="Scan"${continuous ? ' hidden' : ''}>${ICON.scan}<span>Scan</span></button>
          <span class="bsc-spacer" aria-hidden="true"></span>
        </div>
        <form class="bsc-manual" data-bsc-manual autocomplete="off">
          <span class="bsc-manual-icon">${ICON.keyboard}</span>
          <input type="text" inputmode="text" enterkeyhint="go" placeholder="Type a barcode or part #" aria-label="Type a barcode or part number" />
          <button type="submit" class="btn btn-secondary btn-sm">Go</button>
        </form>
        ${footer ? `<div class="bsc-footer">${footer}</div>` : ''}
      </div>`;
    document.body.appendChild(root);
    document.documentElement.classList.add('bsc-open');

    const video = root.querySelector('video');
    const statusEl = root.querySelector('.bsc-status');
    const box = root.querySelector('.bsc-box');
    const camMsg = root.querySelector('.bsc-camera-msg');
    const pickEl = root.querySelector('.bsc-pick');
    const torchBtn = root.querySelector('[data-bsc-torch]');
    const scanBtn = root.querySelector('[data-bsc-scan]');
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    let stream = null;
    let track = null;
    let closed = false;
    let paused = false;
    // aiming (tap mode, idle) | reading (tap mode, Scan pressed) | live
    // (continuous) | picking | busy (onScan running)
    let state = continuous ? 'live' : 'aiming';
    let readUntil = 0;
    let timer = null;
    let detector = null;
    let lastAccepted = null;  // continuous: code most recently accepted
    let lastSeenAt = 0;       // continuous: when that code was last in the box
    let pending1D = null;     // a no-checksum code awaiting its confirming read
    let lastMultiHint = 0;
    let onClose = null;

    const setStatus = (html, kind) => {
      statusEl.innerHTML = html;
      statusEl.className = 'bsc-status' + (kind ? ' ' + kind : '');
    };
    function setState(s) {
      state = s;
      box.classList.toggle('reading', s === 'reading');
      if (scanBtn) scanBtn.disabled = s !== 'aiming';
    }

    async function accept(code, format, source) {
      if (closed || state === 'busy') return;
      setState('busy');
      pickEl.hidden = true;
      beep();
      box.classList.add('hit');
      setTimeout(() => box.classList.remove('hit'), 300);
      setStatus(`Read <strong>${esc(code)}</strong>${format ? ` <span class="bsc-fmt">${esc(fmtLabel(format))}</span>` : ''}`, 'ok');
      let outcome;
      try { outcome = await (onScan ? onScan(code, format, source) : null); } catch (e) { setStatus(esc(e.message || 'Something went wrong'), 'warn'); }
      if (closed) return;
      if (outcome === 'close' || (!stayOpen && outcome !== 'keep')) { close(); return; }
      // Back to aiming. A code still in the box must leave it before it
      // counts again (continuous), and tap mode waits for the next tap.
      lastSeenAt = performance.now();
      pending1D = null;
      setState(continuous ? 'live' : 'aiming');
    }

    function showPick(results) {
      setState('picking');
      setStatus(`${results.length} barcodes in the box. Which one?`, 'warn');
      pickEl.innerHTML = `<div class="bsc-pick-title">Which barcode?</div>` +
        results.map((r, i) => `<button type="button" class="bsc-pick-btn" data-pick="${i}"><span class="bsc-fmt">${esc(fmtLabel(r.format))}</span> <strong>${esc(r.text)}</strong></button>`).join('') +
        '<button type="button" class="bsc-pick-cancel" data-pick-cancel>Neither - aim again</button>';
      pickEl.hidden = false;
      pickEl.querySelectorAll('[data-pick]').forEach((b) => b.addEventListener('click', () => {
        const r = results[Number(b.dataset.pick)];
        accept(r.text, r.format, 'camera');
      }));
      pickEl.querySelector('[data-pick-cancel]').addEventListener('click', () => {
        pickEl.hidden = true;
        setStatus('Aim the box at one barcode, then tap Scan');
        setState(continuous ? 'live' : 'aiming');
      });
    }

    // Codes fully inside the aiming box on this frame, nearest the centre first.
    async function detectFrame() {
      const vw = video.videoWidth; const vh = video.videoHeight;
      const area = BatesScanDecode.screenBoxToVideo(box.getBoundingClientRect(), video.getBoundingClientRect(), vw, vh);
      if (!(area.w > 10 && area.h > 10)) return [];
      if (detector) return BatesScanDecode.inBox(await detector.detect(video), area);
      // ZXing on exactly the box crop (capped width - full frames are slow on older iPhones).
      const scale = Math.min(1, 900 / area.w);
      canvas.width = Math.max(1, Math.round(area.w * scale)); canvas.height = Math.max(1, Math.round(area.h * scale));
      ctx.drawImage(video, area.x, area.y, area.w, area.h, 0, 0, canvas.width, canvas.height);
      return workerDecode(ctx.getImageData(0, 0, canvas.width, canvas.height));
    }

    // A single read wants confirming only for 1D codes without a check digit.
    function confirmed(r) {
      if (!NO_CHECKSUM.has(r.format)) return true;
      if (pending1D && pending1D.text === r.text) { pending1D = null; return true; }
      pending1D = r;
      return false;
    }

    async function tick() {
      if (closed) return;
      const active = !paused && (state === 'reading' || state === 'live') && video.readyState >= 2 && video.videoWidth;
      if (active) {
        let results = [];
        try { results = await detectFrame(); } catch (e) { results = []; }
        if (!closed && (state === 'reading' || state === 'live')) {
          const now = performance.now();
          if (state === 'reading') {
            if (results.length >= 2) showPick(results);
            else if (results.length === 1) { if (confirmed(results[0])) accept(results[0].text, results[0].format, 'camera'); }
            else if (now > readUntil) {
              pending1D = null;
              setStatus('No barcode found - move closer or try the flashlight', 'warn');
              setState('aiming');
            }
          } else if (results.length >= 2) {
            if (now - lastMultiHint > 1500) { lastMultiHint = now; setStatus('Two barcodes in the box - aim at just one', 'warn'); }
          } else if (results.length === 1) {
            const r = results[0];
            if (r.text === lastAccepted && now - lastSeenAt < LEAVE_MS) lastSeenAt = now; // still the same box: don't recount
            else if (confirmed(r)) { lastAccepted = r.text; lastSeenAt = now; accept(r.text, r.format, 'camera'); }
          }
        }
      }
      if (!closed) timer = setTimeout(tick, detector ? NATIVE_INTERVAL_MS : WORKER_INTERVAL_MS);
    }

    async function startCamera() {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        camMsg.hidden = false;
        camMsg.textContent = 'This browser can\'t use the camera here. Type the barcode below, or use a USB scanner.';
        if (scanBtn) scanBtn.disabled = true;
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
        if (!detector) getWorker(); // warm ZXing up before the first tap
        tick();
      } catch (e) {
        camMsg.hidden = false;
        if (scanBtn) scanBtn.disabled = true;
        camMsg.textContent = e && e.name === 'NotAllowedError'
          ? 'Camera permission is off. Allow the camera for this site in your browser settings, or type the barcode below.'
          : 'Couldn\'t start the camera. Type the barcode below, or use a USB scanner.';
      }
    }

    if (scanBtn) {
      scanBtn.disabled = true; // enabled once the camera is running
      video.addEventListener('playing', () => { if (state === 'aiming') scanBtn.disabled = false; }, { once: true });
      scanBtn.addEventListener('click', () => {
        if (state !== 'aiming') return;
        pending1D = null;
        readUntil = performance.now() + READ_WINDOW_MS;
        setStatus('Reading&hellip;');
        setState('reading');
      });
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
      if (state === 'picking' || state === 'reading') setState(continuous ? 'live' : 'aiming');
      accept(v, null, 'manual');
    });

    const wedge = makeWedge((code) => {
      if (state === 'picking' || state === 'reading') setState(continuous ? 'live' : 'aiming');
      accept(code, null, 'scanner');
    });
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

    startCamera();
    return {
      setStatus,
      pause: () => { paused = true; },
      resume: () => { paused = false; lastSeenAt = performance.now(); },
      close,
      onClose: (fn) => { onClose = fn; },
      get closed() { return closed; },
      get state() { return state; },
    };
  }

  window.BatesScanner = { open, listenWedge, beep, _makeWedge: makeWedge };
})();
