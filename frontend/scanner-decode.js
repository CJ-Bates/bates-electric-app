// frontend/scanner-decode.js
// Pure scanning logic shared by scanner.js, scanner-worker.js and the Node
// tests (backend/test/inventoryScanner.test.js decodes real generated
// barcodes through these exact functions).
//
//   const decodeAll = BatesScanDecode.create(ZXing);   // iPhone / no BarcodeDetector
//   decodeAll(rgba, w, h) -> [{ text, format, cx, cy, dist }]  nearest-centre first
//     Finds up to 3 codes in the frame (the aim box crop): decode one, blank
//     it out, decode again. ZXing reads one code per pass, and CJ's ask is
//     "if two codes are in the box, ask - don't guess".
//
//   screenBoxToVideo(boxRect, videoRect, vw, vh) -> { x, y, w, h } in camera pixels
//     The aim box is drawn over a <video> shown with object-fit: cover, so the
//     visible picture is scaled and cropped; this undoes that.
//
//   inBox(codes, box) -> [{ text, format, dist }] nearest-centre first
//     For the native BarcodeDetector (Android): it reports every code in the
//     whole frame with corner points; keep only codes FULLY inside the box.
//
// Formats use the BarcodeDetector spelling (upc_a, ean_13, code_128,
// qr_code, data_matrix...) on both paths.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BatesScanDecode = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var FORMATS = ['UPC_A', 'UPC_E', 'EAN_13', 'EAN_8', 'CODE_128', 'CODE_39', 'ITF', 'QR_CODE', 'DATA_MATRIX'];
  var TWO_D = { qr_code: true, data_matrix: true, aztec: true, pdf_417: true };
  var MAX_CODES = 3;

  function create(ZXing) {
    var hints = new Map();
    hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, FORMATS.map(function (f) { return ZXing.BarcodeFormat[f]; }));
    hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
    var reader = new ZXing.MultiFormatReader();
    reader.setHints(hints);
    var gray = null;

    function attempt(w, h, Binarizer) {
      try {
        var source = new ZXing.RGBLuminanceSource(gray, w, h);
        return reader.decodeWithState(new ZXing.BinaryBitmap(new Binarizer(source)));
      } catch (e) {
        return null; // nothing readable
      } finally {
        reader.reset();
      }
    }

    // Blank out a decoded code so the next pass can find another one.
    // 2D codes: ZXing reports the finder patterns (a few modules inside the
    // edge) - pad them into a rectangle. 1D codes: ZXing reports the CENTRES
    // of the start and stop patterns on one scan line, not the real ends, so
    // a padded guess leaves bars behind that spoil a neighbour's quiet zone
    // (two codes side by side then read as one). Measure the real extent from
    // the pixels instead: along the scan line out to the quiet zone, and up/
    // down the bars to where they stop.
    function mask(points, format, w, h) {
      var xs = points.map(function (p) { return p.getX(); });
      var ys = points.map(function (p) { return p.getY(); });
      var x0 = Math.min.apply(null, xs); var x1 = Math.max.apply(null, xs);
      var y0 = Math.min.apply(null, ys); var y1 = Math.max.apply(null, ys);
      var ax; var bx; var ay; var by;
      if (TWO_D[format]) {
        var pad = Math.max(x1 - x0, y1 - y0, 8) * 0.3;
        ax = x0 - pad; bx = x1 + pad; ay = y0 - pad; by = y1 + pad;
      } else {
        var ext = extent1D(Math.round((y0 + y1) / 2), Math.round(x0), Math.round(x1), w, h);
        ax = ext.left - 2; bx = ext.right + 2; ay = ext.top - 2; by = ext.bottom + 2;
      }
      ax = Math.max(0, Math.floor(ax)); bx = Math.min(w, Math.ceil(bx));
      ay = Math.max(0, Math.floor(ay)); by = Math.min(h, Math.ceil(by));
      for (var y = ay; y < by; y++) gray.fill(255, y * w + ax, y * w + bx);
    }

    function extent1D(row, x0, x1, w, h) {
      row = Math.min(h - 1, Math.max(0, row));
      x0 = Math.max(0, x0); x1 = Math.min(w - 1, x1);
      var base = row * w;
      var lo = 255; var hi = 0;
      for (var x = x0; x <= x1; x++) { var v = gray[base + x]; if (v < lo) lo = v; if (v > hi) hi = v; }
      var thr = (lo + hi) / 2;
      var dark = function (xx, yy) { return gray[yy * w + xx] < thr; };
      // Narrowest bar = one module; a quiet zone is 7+ modules of white.
      var minRun = Infinity; var run = 0;
      for (x = x0; x <= x1 + 1; x++) {
        if (x <= x1 && dark(x, row)) run++;
        else { if (run > 0 && run < minRun) minRun = run; run = 0; }
      }
      if (!isFinite(minRun)) minRun = 2;
      var quiet = Math.max(4, minRun * 7);
      var walk = function (from, step) {
        var last = from; var white = 0;
        for (var xx = from; xx >= 0 && xx < w; xx += step) {
          if (dark(xx, row)) { last = xx; white = 0; } else if (++white >= quiet) break;
        }
        return last;
      };
      var left = walk(x0, -1); var right = walk(x1, 1);
      // Bar height: follow a few dark columns up and down until they end.
      var top = row; var bottom = row;
      var cols = [];
      for (x = left; x <= right && cols.length < 5; x += Math.max(1, Math.floor((right - left) / 5))) {
        for (var c = x; c <= Math.min(right, x + minRun * 3); c++) { if (dark(c, row)) { cols.push(c); break; } }
      }
      cols.forEach(function (c) {
        var y = row; while (y > 0 && dark(c, y - 1)) y--; if (y < top) top = y;
        y = row; while (y < h - 1 && dark(c, y + 1)) y++; if (y > bottom) bottom = y;
      });
      return { left: left, right: right, top: top, bottom: bottom };
    }

    return function decodeAll(rgba, width, height) {
      var n = width * height;
      if (!gray || gray.length !== n) gray = new Uint8ClampedArray(n);
      for (var i = 0, j = 0; i < n; i++, j += 4) {
        gray[i] = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8; // BT.601 luma
      }
      var found = [];
      for (var round = 0; round < MAX_CODES; round++) {
        // Hybrid copes with uneven warehouse light; the global histogram
        // binarizer is often better on long thin 1D codes.
        var r = attempt(width, height, ZXing.HybridBinarizer) || attempt(width, height, ZXing.GlobalHistogramBinarizer);
        if (!r) break;
        var format = String(ZXing.BarcodeFormat[r.getBarcodeFormat()] || '').toLowerCase();
        var text = r.getText();
        if (found.some(function (f) { return f.text === text; })) break; // mask missed it; stop, don't loop
        var pts = r.getResultPoints() || [];
        var cx = width / 2; var cy = height / 2;
        if (pts.length) {
          cx = pts.reduce(function (s, p) { return s + p.getX(); }, 0) / pts.length;
          cy = pts.reduce(function (s, p) { return s + p.getY(); }, 0) / pts.length;
        }
        found.push({ text: text, format: format, cx: cx, cy: cy, dist: Math.hypot(cx - width / 2, cy - height / 2) });
        if (!pts.length) break;
        mask(pts, format, width, height);
      }
      return found.sort(function (a, b) { return a.dist - b.dist; });
    };
  }

  function screenBoxToVideo(box, videoRect, vw, vh) {
    var scale = Math.max(videoRect.width / vw, videoRect.height / vh);
    var offX = (videoRect.width - vw * scale) / 2;
    var offY = (videoRect.height - vh * scale) / 2;
    var x = (box.left - videoRect.left - offX) / scale;
    var y = (box.top - videoRect.top - offY) / scale;
    var w = box.width / scale;
    var h = box.height / scale;
    var cx0 = Math.max(0, x); var cy0 = Math.max(0, y);
    return { x: cx0, y: cy0, w: Math.min(vw, x + w) - cx0, h: Math.min(vh, y + h) - cy0 };
  }

  function inBox(codes, box) {
    var tol = Math.max(box.w, box.h) * 0.02;
    var bx = box.x + box.w / 2; var by = box.y + box.h / 2;
    var out = [];
    (codes || []).forEach(function (c) {
      var pts = c.cornerPoints && c.cornerPoints.length ? c.cornerPoints
        : (c.boundingBox ? [{ x: c.boundingBox.x, y: c.boundingBox.y }, { x: c.boundingBox.x + c.boundingBox.width, y: c.boundingBox.y + c.boundingBox.height }] : []);
      if (!pts.length || !c.rawValue) return;
      var inside = pts.every(function (p) { return p.x >= box.x - tol && p.x <= box.x + box.w + tol && p.y >= box.y - tol && p.y <= box.y + box.h + tol; });
      if (!inside) return;
      if (out.some(function (o) { return o.text === c.rawValue; })) return;
      var cx = pts.reduce(function (s, p) { return s + p.x; }, 0) / pts.length;
      var cy = pts.reduce(function (s, p) { return s + p.y; }, 0) / pts.length;
      out.push({ text: c.rawValue, format: c.format, dist: Math.hypot(cx - bx, cy - by) });
    });
    return out.sort(function (a, b) { return a.dist - b.dist; });
  }

  return { create: create, screenBoxToVideo: screenBoxToVideo, inBox: inBox, FORMATS: FORMATS, TWO_D: TWO_D };
});
