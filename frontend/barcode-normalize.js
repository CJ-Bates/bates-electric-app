// frontend/barcode-normalize.js
// One barcode normalizer for the browser (offline catalog lookups) AND the
// backend (backend/lib/barcodes.js re-exports this file), so a code scanned
// offline and the same code saved on the server can never disagree.
//
// Why normalize: the same product reaches us in different spellings.
//   - A camera reads a UPC-A as 12 digits; many USB scanners send it as the
//     13-digit EAN ("0" + UPC). Both become the EAN-13 form.
//   - UPC-E (8 digits, small packages) is a compressed UPC-A; it is expanded
//     to UPC-A and then EAN-13. An 8-digit code with no format (typed, or a
//     keyboard-wedge scanner) is ambiguous with EAN-8, so lookups try both.
//   - USB scanners can prefix an AIM symbology id ("]C1", "]E0") and append
//     CR/LF/TAB; those are stripped.
//   - Non-numeric codes (Code 39/128 part numbers, QR) are upper-cased:
//     Code 39 has no lower case and part numbers are case-insensitive in
//     practice, so "abc-12" typed by hand finds "ABC-12".
//
//   normalize(raw, format)  -> canonical code_norm stored on the server ('' if empty)
//   candidates(raw, format) -> every code_norm this scan could match (lookups)
//   expandUpcE(code8)       -> 12-digit UPC-A, or null
//   checkDigitOk(digits)    -> GS1 mod-10 check (informational only)

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BatesBarcode = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function clean(raw) {
    var s = String(raw == null ? '' : raw);
    s = s.replace(/^\][A-Za-z][0-9A-Za-z]/, '');      // AIM symbology identifier
    s = s.replace(/[\x00-\x1c\x1e-\x1f\x7f]/g, '');   // control chars (keep GS 0x1d for GS1 data)
    return s.trim();
  }

  // UPC-E (number system + 6 digits + check) -> UPC-A. Only number systems
  // 0 and 1 exist for UPC-E.
  function expandUpcE(code) {
    if (!/^[01]\d{7}$/.test(code)) return null;
    var ns = code[0];
    var d = code.slice(1, 7);
    var check = code[7];
    var last = d[5];
    var body;
    if (last === '0' || last === '1' || last === '2') body = d.slice(0, 2) + last + '0000' + d.slice(2, 5);
    else if (last === '3') body = d.slice(0, 3) + '00000' + d.slice(3, 5);
    else if (last === '4') body = d.slice(0, 4) + '00000' + d[4];
    else body = d.slice(0, 5) + '0000' + last;
    return ns + body + check;
  }

  function checkDigitOk(digits) {
    if (!/^\d{8,14}$/.test(digits)) return false;
    var sum = 0;
    for (var i = digits.length - 2, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) sum += Number(digits[i]) * w;
    return (10 - (sum % 10)) % 10 === Number(digits[digits.length - 1]);
  }

  var fmt = function (f) { return String(f || '').toLowerCase(); };

  function numericNorm(s, format) {
    var f = fmt(format);
    if (s.length === 12) return '0' + s;                       // UPC-A -> EAN-13
    if (s.length === 8 && f === 'upc_e') {
      var a = expandUpcE(s);
      return a ? '0' + a : s;
    }
    return s;                                                  // EAN-8, EAN-13, GTIN-14, others as-is
  }

  function normalize(raw, format) {
    var s = clean(raw);
    if (!s) return '';
    if (/^\d+$/.test(s)) return numericNorm(s, format);
    return s.toUpperCase();
  }

  function candidates(raw, format) {
    var s = clean(raw);
    if (!s) return [];
    var out = [normalize(s, format)];
    if (/^\d{8}$/.test(s) && !fmt(format)) {
      var a = expandUpcE(s);
      if (a) out.push('0' + a);                                // could be a UPC-E typed / wedged
    }
    if (/^\d{13}$/.test(s) && s[0] === '0') out.push(s);       // already EAN-13 form (no-op dup guard)
    return out.filter(function (v, i) { return v && out.indexOf(v) === i; });
  }

  return { normalize: normalize, candidates: candidates, expandUpcE: expandUpcE, checkDigitOk: checkDigitOk, clean: clean };
});
