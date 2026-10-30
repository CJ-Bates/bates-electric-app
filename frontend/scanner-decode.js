// frontend/scanner-decode.js
// The ZXing decode step, shared by scanner-worker.js (iPhone Safari and any
// browser without the native BarcodeDetector) and backend/test/
// inventoryScanner.test.js, which decodes real generated barcodes through
// this exact function.
//
//   const decode = BatesScanDecode.create(ZXing);
//   decode(rgba, width, height) -> { text, format } | null
//
// rgba is a frame's pixel data (Uint8ClampedArray, 4 bytes per pixel).
// Formats are reported in the BarcodeDetector spelling (upc_a, ean_13,
// code_128, qr_code, data_matrix...) so both scan paths look the same to the
// rest of the app.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BatesScanDecode = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var FORMATS = ['UPC_A', 'UPC_E', 'EAN_13', 'EAN_8', 'CODE_128', 'CODE_39', 'ITF', 'QR_CODE', 'DATA_MATRIX'];

  function create(ZXing) {
    var hints = new Map();
    hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, FORMATS.map(function (f) { return ZXing.BarcodeFormat[f]; }));
    hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
    var reader = new ZXing.MultiFormatReader();
    reader.setHints(hints);
    var gray = null;

    function attempt(source, Binarizer) {
      try {
        var result = reader.decodeWithState(new ZXing.BinaryBitmap(new Binarizer(source)));
        var name = ZXing.BarcodeFormat[result.getBarcodeFormat()];
        return { text: result.getText(), format: String(name || '').toLowerCase() };
      } catch (e) {
        return null; // NotFound / Checksum / Format: nothing readable in this frame
      } finally {
        reader.reset();
      }
    }

    return function decode(rgba, width, height) {
      var n = width * height;
      if (!gray || gray.length !== n) gray = new Uint8ClampedArray(n);
      for (var i = 0, j = 0; i < n; i++, j += 4) {
        // Integer luma (BT.601) - fast and good enough for black-on-white bars.
        gray[i] = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8;
      }
      var source = new ZXing.RGBLuminanceSource(gray, width, height);
      // Hybrid handles uneven warehouse lighting (2D codes, glare); the global
      // histogram binarizer is often better on long thin 1D barcodes.
      return attempt(source, ZXing.HybridBinarizer) || attempt(source, ZXing.GlobalHistogramBinarizer);
    };
  }

  return { create: create, FORMATS: FORMATS };
});
