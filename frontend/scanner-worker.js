// frontend/scanner-worker.js
// Off-main-thread barcode decoding for browsers without the native
// BarcodeDetector (iPhone Safari). scanner.js posts a cropped, downscaled
// frame; we answer { id, result: { text, format } | null }. Keeping ZXing
// here keeps the camera preview smooth while it works.
/* global importScripts, ZXing, BatesScanDecode */
importScripts('vendor/zxing/zxing-library.min.js', 'scanner-decode.js');

var decode = BatesScanDecode.create(ZXing);

self.onmessage = function (e) {
  var m = e.data || {};
  var result = null;
  try {
    result = decode(new Uint8ClampedArray(m.buffer), m.width, m.height);
  } catch (err) {
    result = null;
  }
  self.postMessage({ id: m.id, result: result });
};
