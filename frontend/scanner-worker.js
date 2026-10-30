// frontend/scanner-worker.js
// Off-main-thread barcode decoding for browsers without the native
// BarcodeDetector (iPhone Safari). scanner.js posts the aim-box crop of a
// frame; we answer { id, results: [{ text, format, cx, cy, dist }] }
// nearest-centre first (empty when nothing reads). Keeping ZXing here keeps
// the camera preview smooth while it works.
/* global importScripts, ZXing, BatesScanDecode */
importScripts('vendor/zxing/zxing-library.min.js', 'scanner-decode.js');

var decodeAll = BatesScanDecode.create(ZXing);

self.onmessage = function (e) {
  var m = e.data || {};
  var results = [];
  try {
    results = decodeAll(new Uint8ClampedArray(m.buffer), m.width, m.height);
  } catch (err) {
    results = [];
  }
  self.postMessage({ id: m.id, results: results });
};
