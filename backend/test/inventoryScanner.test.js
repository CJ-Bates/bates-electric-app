// Scanner + barcode plumbing (frontend files, exercised in Node):
//   - frontend/scanner-decode.js decodes REAL rendered barcodes through the
//     vendored ZXing build (the iPhone path): UPC-A, EAN-13, Code 128,
//     Code 39, QR, Data Matrix - including a frame with noise, a tilt-free
//     but off-centre code, and a blank frame (null, no throw)
//   - frontend/barcode-normalize.js (shared with the backend): UPC-A vs
//     EAN-13 vs USB-scanner spellings land on one code_norm; UPC-E expands;
//     AIM prefixes and CR/LF are stripped; lookups try both 8-digit readings
//   - the vendored file is exactly the pinned upstream build (hash)
require('./helpers/env');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const VENDOR = path.join(__dirname, '..', '..', 'frontend', 'vendor', 'zxing', 'zxing-library.min.js');
const ZXing = require(VENDOR);
const { create, screenBoxToVideo, inBox } = require('../../frontend/scanner-decode.js');
const B = require('../lib/barcodes');
const decodeAll = create(ZXing);
const decode = (px, w, h) => decodeAll(px, w, h)[0] || null;

// ---- tiny renderers: module widths -> RGBA frame ---------------------------
// widths alternate bar/space starting with a bar; `scale` px per module.
function renderWidths(widths, { scale = 3, height = 90, quiet = 12, noise = 0, offsetX = 0, canvasW } = {}) {
  const total = widths.reduce((a, b) => a + b, 0);
  const w = canvasW || (total + quiet * 2) * scale + offsetX;
  const h = height + 40;
  const px = new Uint8ClampedArray(w * h * 4).fill(255);
  let x = quiet * scale + offsetX;
  widths.forEach((m, i) => {
    if (i % 2 === 0) {
      for (let xx = x; xx < x + m * scale; xx++) for (let y = 20; y < 20 + height; y++) {
        const o = (y * w + xx) * 4; px[o] = px[o + 1] = px[o + 2] = 0;
      }
    }
    x += m * scale;
  });
  if (noise) {
    let seed = 7;
    for (let i = 0; i < px.length; i += 4) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const d = (seed % (noise * 2)) - noise;
      px[i] = px[i + 1] = px[i + 2] = Math.max(0, Math.min(255, px[i] + d));
    }
  }
  return { px, w, h };
}
function renderMatrix(m, scale = 6, quiet = 4) {
  const w = (m.getWidth() + quiet * 2) * scale;
  const h = (m.getHeight() + quiet * 2) * scale;
  const px = new Uint8ClampedArray(w * h * 4).fill(255);
  for (let y = 0; y < m.getHeight(); y++) for (let x = 0; x < m.getWidth(); x++) {
    if (!m.get(x, y)) continue;
    for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
      const o = (((y + quiet) * scale + dy) * w + (x + quiet) * scale + dx) * 4; px[o] = px[o + 1] = px[o + 2] = 0;
    }
  }
  return { px, w, h };
}

// EAN-13 / UPC-A from ZXing's own L patterns (G = mirrored L; R = L widths).
const UPCEAN = Object.getPrototypeOf(ZXing.EAN13Reader);
const L = Array.from(UPCEAN.L_PATTERNS, (p) => Array.from(p));
function ean13Widths(digits13) {
  const parity = ZXing.EAN13Reader.FIRST_DIGIT_ENCODINGS[Number(digits13[0])];
  const out = [1, 1, 1];
  for (let i = 1; i <= 6; i++) {
    const p = L[Number(digits13[i])];
    const useG = (parity >> (6 - i)) & 1;
    // left half starts with a SPACE: prefix 0-width bar keeps bar/space alternation
    out.push(...(useG ? p.slice().reverse() : p));
  }
  out.push(1, 1, 1, 1, 1);
  for (let i = 7; i <= 12; i++) out.push(...L[Number(digits13[i])]);
  out.push(1, 1, 1);
  return out;
}
// Code 128 set B with checksum, from ZXing's CODE_PATTERNS.
function code128Widths(text) {
  const P = ZXing.Code128Reader.CODE_PATTERNS;
  const vals = [104, ...Array.from(text, (c) => c.charCodeAt(0) - 32)];
  const check = vals.reduce((s, v, i) => s + v * (i === 0 ? 1 : i), 0) % 103;
  return [...vals, check, 106].flatMap((v) => Array.from(P[v])).concat(v106Tail(P));
}
function v106Tail(P) { return P[106].length === 6 ? [2] : []; } // stop = 6 widths + final 2-module bar
// Code 39 from ZXing's 9-bit encodings (1 = wide). '*' start/stop.
function code39Widths(text) {
  const alpha = ZXing.Code39Reader.ALPHABET_STRING;
  const enc = ZXing.Code39Reader.CHARACTER_ENCODINGS;
  const star = 0x094;
  const chars = [star, ...Array.from(text, (c) => enc[alpha.indexOf(c)]), star];
  const out = [];
  chars.forEach((e, ci) => {
    for (let b = 8; b >= 0; b--) out.push(((e >> b) & 1) ? 3 : 1);
    if (ci < chars.length - 1) out.push(1); // inter-character gap (a space)
  });
  return out;
}
// The renderer alternates bar/space from a BAR; EAN left halves begin with a
// space, so merge: start guard [1,1,1] ends on a bar, next element is a space. OK.

test('vendored ZXing is the pinned upstream build', () => {
  const sha = crypto.createHash('sha256').update(fs.readFileSync(VENDOR)).digest('hex');
  assert.equal(sha, 'd7cc8f69dd70bdcf3ac00c9ae572bf2acb9f4132ba379c72df842e4db918652d');
  assert.doesNotMatch(fs.readFileSync(VENDOR, 'utf8'), /\beval\(|new Function\(/, 'nothing the CSP would block');
});

test('decodes UPC-A and EAN-13 (with sensor noise and off-centre)', () => {
  const upc = '036000291452'; // UPC-A as printed
  let f = renderWidths(ean13Widths('0' + upc), { noise: 30 });
  let r = decode(f.px, f.w, f.h);
  assert.ok(r, 'UPC-A read');
  assert.equal(r.format, 'upc_a');
  assert.equal(r.text, upc);
  assert.equal(B.normalize(r.text, r.format), '0' + upc);

  f = renderWidths(ean13Widths('4006381333931'), { offsetX: 140, canvasW: 640 });
  r = decode(f.px, f.w, f.h);
  assert.equal(r.format, 'ean_13');
  assert.equal(r.text, '4006381333931');
});

test('decodes Code 128 and Code 39 part-number labels', () => {
  let f = renderWidths(code128Widths('GEN-ATS400-SE'), { scale: 2 });
  let r = decode(f.px, f.w, f.h);
  assert.ok(r, 'Code 128 read');
  assert.equal(r.format, 'code_128');
  assert.equal(r.text, 'GEN-ATS400-SE');

  f = renderWidths(code39Widths('RXSW200A3'), { scale: 2 });
  r = decode(f.px, f.w, f.h);
  assert.ok(r, 'Code 39 read');
  assert.equal(r.format, 'code_39');
  assert.equal(r.text, 'RXSW200A3');
});

test('decodes QR and Data Matrix', () => {
  const qr = new ZXing.QRCodeWriter().encode('SN:A12345-ATS', ZXing.BarcodeFormat.QR_CODE, 0, 0, new Map());
  let f = renderMatrix(qr);
  let r = decode(f.px, f.w, f.h);
  assert.equal(r.format, 'qr_code');
  assert.equal(r.text, 'SN:A12345-ATS');

  const dm = new ZXing.DataMatrixWriter().encode('PN0042-77', ZXing.BarcodeFormat.DATA_MATRIX, 0, 0, new Map());
  f = renderMatrix(dm);
  r = decode(f.px, f.w, f.h);
  assert.equal(r.format, 'data_matrix');
  assert.equal(r.text, 'PN0042-77');
});

test('a blank frame decodes to null (no throw), repeatedly', () => {
  const w = 320; const h = 240;
  const px = new Uint8ClampedArray(w * h * 4).fill(200);
  for (let i = 0; i < 5; i++) assert.equal(decode(px, w, h), null);
});

test('normalizer: one product, many spellings', () => {
  const variants = [['036000291452', 'upc_a'], ['0036000291452', 'ean_13'], [']E00036000291452\r\n', undefined], [' 036000291452 ', undefined]];
  for (const [code, fmt] of variants) assert.equal(B.normalize(code, fmt), '0036000291452', JSON.stringify(code));
  assert.equal(B.expandUpcE('01234565'), '012345000065');
  assert.equal(B.expandUpcE('04252614'), '042100005264');
  assert.equal(B.normalize('01234565', 'upc_e'), '0012345000065');
  assert.deepEqual(B.candidates('01234565'), ['01234565', '0012345000065'], 'untyped 8 digits: EAN-8 or UPC-E');
  assert.equal(B.normalize('  rxsw-200a ', 'code_39'), 'RXSW-200A');
  assert.equal(B.normalize(''), '');
  assert.equal(B.checkDigitOk('036000291452'), true);
  assert.equal(B.checkDigitOk('036000291453'), false);
});

// ---- aim-then-scan (2026-10-30): several codes in the box -------------------
// Paint several 1D codes onto one frame at given positions.
function compose(w, h, parts) {
  const px = new Uint8ClampedArray(w * h * 4).fill(255);
  for (const { widths, x, y, scale = 2, height = 70 } of parts) {
    let cx = x;
    widths.forEach((m, i) => {
      if (i % 2 === 0) {
        for (let xx = cx; xx < cx + m * scale; xx++) for (let yy = y; yy < y + height; yy++) {
          const o = (yy * w + xx) * 4; px[o] = px[o + 1] = px[o + 2] = 0;
        }
      }
      cx += m * scale;
    });
  }
  return px;
}

test('two codes side by side in the box: both found, nearest the centre first', () => {
  const W = 900; const H = 260;
  const a = ean13Widths('0036000291452'); // UPC-A 036000291452
  const b = ean13Widths('4006381333931');
  const total = (ws) => ws.reduce((s, v) => s + v, 0) * 2;
  // a sits left of centre, b is centred
  const bx = Math.round(W / 2 - total(b) / 2);
  const px = compose(W, H, [{ widths: a, x: 20, y: 95 }, { widths: b, x: bx, y: 95 }]);
  const found = decodeAll(px, W, H);
  assert.equal(found.length, 2, JSON.stringify(found));
  assert.equal(found[0].text, '4006381333931', 'the centred one first');
  assert.equal(found[1].text, '036000291452');
  assert.ok(found[0].dist < found[1].dist);
});

test('two codes stacked one above the other are both found', () => {
  const W = 400; const H = 300;
  const px = compose(W, H, [{ widths: code128Widths('SHELF-A1'), x: 40, y: 30, height: 60 }, { widths: code128Widths('PN-7781'), x: 40, y: 200, height: 60 }]);
  const texts = decodeAll(px, W, H).map((f) => f.text).sort();
  assert.deepEqual(texts, ['PN-7781', 'SHELF-A1']);
});

test('one code: one result (masking never re-reports the same code)', () => {
  const f = renderWidths(ean13Widths('4006381333931'));
  const found = decodeAll(f.px, f.w, f.h);
  assert.equal(found.length, 1);
});

test('aim box -> camera pixels through object-fit: cover', () => {
  // 1920x1080 camera shown in a 400x800 portrait element: scale 800/1080,
  // the visible picture is the centre 540 px of the width.
  const video = { left: 0, top: 0, width: 400, height: 800 };
  const box = { left: 40, top: 300, width: 320, height: 200 };
  const r = screenBoxToVideo(box, video, 1920, 1080);
  const scale = 800 / 1080;
  const offX = (400 - 1920 * scale) / 2;
  assert.ok(Math.abs(r.x - (40 - offX) / scale) < 0.01);
  assert.ok(Math.abs(r.y - 300 / scale) < 0.01);
  assert.ok(Math.abs(r.w - 320 / scale) < 0.01);
  assert.ok(Math.abs(r.h - 200 / scale) < 0.01);
});

test('native detector results: only codes FULLY inside the box count, nearest centre first', () => {
  const box = { x: 100, y: 100, w: 400, h: 200 };
  const corners = (x, y, w, h) => [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }];
  const codes = [
    { rawValue: 'OUTSIDE', format: 'ean_13', cornerPoints: corners(600, 120, 80, 40) },
    { rawValue: 'HALF-IN', format: 'code_128', cornerPoints: corners(450, 150, 120, 40) },
    { rawValue: 'EDGE', format: 'upc_a', cornerPoints: corners(110, 110, 80, 40) },
    { rawValue: 'CENTRE', format: 'upc_a', cornerPoints: corners(260, 180, 80, 40) },
  ];
  assert.deepEqual(inBox(codes, box).map((c) => c.text), ['CENTRE', 'EDGE']);
  assert.deepEqual(inBox([codes[0], codes[1]], box), [], 'nothing fully inside');
});

test('two short Code 128 labels close together (24 px gap) are both found - the first one is fully blanked', () => {
  // Regression from the headless camera test: ZXing reports start/stop pattern
  // CENTRES, so a padded mask left stop-pattern bars in the second code's quiet zone.
  const W = 356; const H = 192;
  const a = code128Widths('A1'); const b = code128Widths('B2');
  const aw = a.reduce((s, v) => s + v, 0) * 2;
  const px = compose(W, H, [{ widths: a, x: 52, y: 56, height: 80 }, { widths: b, x: 52 + aw + 24, y: 56, height: 80 }]);
  assert.deepEqual(decodeAll(px, W, H).map((f) => f.text).sort(), ['A1', 'B2']);
});

test('the iPhone decoder reads Code 128 "BATES-TEST-03" (hyphens, digits) exactly', () => {
  const f = renderWidths(code128Widths('BATES-TEST-03'), { scale: 2, noise: 20 });
  const r = decode(f.px, f.w, f.h);
  assert.ok(r, 'read');
  assert.equal(r.format, 'code_128');
  assert.equal(r.text, 'BATES-TEST-03');
});
