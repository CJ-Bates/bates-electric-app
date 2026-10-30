// backend/lib/barcodes.js
// The barcode normalizer lives in frontend/barcode-normalize.js so the
// browser's offline catalog lookups and the server agree byte for byte; this
// re-export is the backend's handle on it (server.js already serves ../frontend,
// so the directory is always deployed alongside the backend).
module.exports = require('../../frontend/barcode-normalize.js');
