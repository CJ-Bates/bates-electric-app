# ZXing (vendored)

`zxing-library.min.js` is `@zxing/library` **0.21.3**, file `umd/index.min.js`,
unmodified (Apache-2.0, see `LICENSE`). Vendored because the app's CSP allows
no third-party scripts at runtime and the scanner must work offline.

- sha256: `d7cc8f69dd70bdcf3ac00c9ae572bf2acb9f4132ba379c72df842e4db918652d`
- Loaded only by `frontend/scanner-worker.js` (via `importScripts`) on devices
  without the native `BarcodeDetector` (iPhone Safari). Contains no `eval` /
  `new Function`, so it runs under the existing CSP.
- To upgrade: `npm pack @zxing/library@<ver>`, copy `umd/index.min.js` here,
  update the version + hash above, rerun `backend/test/inventoryScanner.test.js`.
