// GET /inspections/:id/photos.zip — offline tests through the real shipped
// handler, added alongside the archiver 7 -> 8 upgrade (the zip endpoint is
// archiver's only consumer). The produced stream is validated as a REAL zip:
// central directory parsed and every entry inflated and byte-compared, so a
// corrupt-but-nonzero archive fails loudly.
require('./helpers/env');

const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { PassThrough } = require('node:stream');

// inspections.js destructures supabaseForUser/supabaseAdmin from lib/supabase
// at require time, so the swap must happen BEFORE the router is required.
const supabaseLib = require('../lib/supabase');
const { getRouteHandler } = require('./helpers/routeHandler');

let userInspectionRow;
supabaseLib.supabaseForUser = () => ({
  from: () => {
    const b = {};
    b.select = () => b;
    b.eq = () => b;
    b.single = () => Promise.resolve(
      userInspectionRow
        ? { data: userInspectionRow, error: null }
        : { data: null, error: { message: 'not found' } }
    );
    return b;
  },
});

let storageWorld;
Object.defineProperty(supabaseLib.supabaseAdmin, 'storage', {
  configurable: true,
  value: {
    from: () => ({
      list: (prefix) => Promise.resolve(storageWorld.list(prefix)),
      download: (path) => Promise.resolve(storageWorld.download(path)),
    }),
  },
});

const inspectionsRouter = require('../routes/inspections');
const handler = getRouteHandler(inspectionsRouter, 'get', '/:id/photos.zip');

const INSPECTION_ID = 'a0000000-0000-4000-8000-000000000001';

function makeZipRes() {
  const res = new PassThrough();
  res.headers = {};
  res.statusCode = 200;
  res.jsonBody = undefined;
  res.headersSent = false;
  res.setHeader = (k, v) => { res.headers[k.toLowerCase()] = v; res.headersSent = true; };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.jsonBody = payload; res.end(); return res; };
  const chunks = [];
  res.on('data', (c) => chunks.push(c));
  res.collected = new Promise((resolve) => {
    res.on('end', () => resolve(Buffer.concat(chunks)));
    res.on('finish', () => resolve(Buffer.concat(chunks)));
  });
  return res;
}

// Minimal zip reader: walk the central directory, inflate each entry via its
// local header, return { [name]: Buffer }. Throws on a malformed archive.
function readZip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  assert.notEqual(eocd, -1, 'zip end-of-central-directory record not found');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = {};
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(off), 0x02014b50, 'bad central directory signature');
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    assert.equal(buf.readUInt32LE(localOff), 0x04034b50, 'bad local header signature');
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);
    entries[name] = method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw);
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

const PHOTO_A = Buffer.from('jpeg-bytes-a-'.repeat(40));
const PHOTO_B = Buffer.from('jpeg-bytes-b-'.repeat(90));

function world({ downloads } = {}) {
  userInspectionRow = { id: INSPECTION_ID, customer_name: 'Sarah', job_number: 'JOB-123' };
  storageWorld = {
    list: (prefix) => {
      if (prefix === INSPECTION_ID) {
        return { data: [
          { name: 'report.pdf', id: 'f0' },
          { name: 'a.jpg', id: 'f1' },
          { name: 'sub', id: null },
        ], error: null };
      }
      return { data: [{ name: 'b.jpg', id: 'f2' }], error: null };
    },
    download: (path) => {
      const bufs = downloads || {
        [`${INSPECTION_ID}/a.jpg`]: PHOTO_A,
        [`${INSPECTION_ID}/sub/b.jpg`]: PHOTO_B,
      };
      const buf = bufs[path];
      if (!buf) return { data: null, error: { message: 'download failed' } };
      return { data: { arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) }, error: null };
    },
  };
}

test('streams a valid, openable zip containing every photo with correct names and headers', async () => {
  world();
  const res = makeZipRes();
  await handler({ params: { id: INSPECTION_ID }, token: 'tok' }, res);
  const body = await res.collected;

  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'application/zip');
  assert.equal(res.headers['content-disposition'], 'attachment; filename="JOB-123-photos.zip"');

  const entries = readZip(body);
  assert.deepEqual(Object.keys(entries).sort(), ['a.jpg', 'sub/b.jpg']);
  assert.ok(entries['a.jpg'].equals(PHOTO_A), 'a.jpg content mismatch');
  assert.ok(entries['sub/b.jpg'].equals(PHOTO_B), 'sub/b.jpg content mismatch');
});

test('a failed photo download is skipped — remaining photos still arrive in a valid zip, no 500 mid-stream', async () => {
  world({ downloads: { [`${INSPECTION_ID}/sub/b.jpg`]: PHOTO_B } }); // a.jpg download fails
  const res = makeZipRes();
  await handler({ params: { id: INSPECTION_ID }, token: 'tok' }, res);
  const body = await res.collected;

  assert.equal(res.statusCode, 200, 'stream must not be failed by one bad photo');
  const entries = readZip(body);
  assert.deepEqual(Object.keys(entries), ['sub/b.jpg']);
  assert.ok(entries['sub/b.jpg'].equals(PHOTO_B));
});

test('404 when the inspection has no photos (report.pdf alone does not count)', async () => {
  world();
  storageWorld.list = (prefix) => (
    prefix === INSPECTION_ID
      ? { data: [{ name: 'report.pdf', id: 'f0' }], error: null }
      : { data: [], error: null }
  );
  const res = makeZipRes();
  await handler({ params: { id: INSPECTION_ID }, token: 'tok' }, res);
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.jsonBody, { error: 'No photos for this inspection' });
});

test('404 for an inspection the user cannot read', async () => {
  world();
  userInspectionRow = null;
  const res = makeZipRes();
  await handler({ params: { id: INSPECTION_ID }, token: 'tok' }, res);
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.jsonBody, { error: 'Not found' });
});
