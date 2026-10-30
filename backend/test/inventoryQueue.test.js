// The phone-side offline queue (frontend/inventory-store.js), run in Node
// with the in-memory adapter against a fake /sync server that is idempotent
// the way the real one is (client_op_id / item id / session id):
//   - offline scans queue, the view shows them, nothing is sent
//   - back online they sync once; a response LOST after the server applied
//     the batch is resent and counts nothing twice
//   - a 5xx keeps everything queued (retry); a 4xx moves just that op to
//     "failed" and the rest still sync
//   - a count session: hundreds of scans stay ONE queued snapshot op, the
//     indicator counts scans, and a newer snapshot queued mid-flight is not
//     lost when the older one's success comes back
//   - an offline quick-add whose barcode another phone already added is
//     re-pointed to the existing item (no twin, no lost scans)
//   - offline scan-outs are flagged queued_offline (the server then allows
//     a below-zero count)
require('./helpers/env');

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const S = require('../../frontend/inventory-store.js');

// Fake server: items qty by id, applied op ids, session lines (absolute).
function fakeServer() {
  const srv = { items: new Map(), applied: new Set(), barcodes: new Map(), sessionLines: new Map(), calls: 0, mode: 'ok', posted: new Set() };
  srv.send = async (ops) => {
    srv.calls++;
    if (srv.mode === 'offline') throw new Error('Failed to fetch');
    if (srv.mode === '500') return { results: ops.map((o) => ({ op_id: o.op_id, ok: false, status: 500, error: 'boom' })) };
    const results = ops.map((o) => {
      const p = o.payload;
      if (o.kind === 'item_create') {
        const norm = p.barcode && p.barcode.code;
        if (norm && srv.barcodes.has(norm) && srv.barcodes.get(norm) !== p.id) return { op_id: o.op_id, ok: false, status: 409, error: 'dup', conflict: 'barcode', existing_item_id: srv.barcodes.get(norm) };
        if (!srv.items.has(p.id)) srv.items.set(p.id, 0);
        if (norm) srv.barcodes.set(norm, p.id);
        if (p.qty && !p.session_id && !srv.applied.has(p.client_op_id)) { srv.applied.add(p.client_op_id); srv.items.set(p.id, srv.items.get(p.id) + p.qty); }
        return { op_id: o.op_id, ok: true, status: 200, result: {} };
      }
      if (o.kind === 'txn') {
        if (!srv.items.has(p.item_id)) return { op_id: o.op_id, ok: false, status: 404, error: 'Item not found' };
        if (p.type === 'scanned_out' && srv.items.get(p.item_id) - p.qty < 0 && !p.queued_offline) return { op_id: o.op_id, ok: false, status: 400, error: 'only ' + srv.items.get(p.item_id) + ' on hand' };
        if (!srv.applied.has(p.client_op_id)) {
          srv.applied.add(p.client_op_id);
          srv.items.set(p.item_id, srv.items.get(p.item_id) + (p.type === 'scanned_out' ? -p.qty : p.qty));
        }
        return { op_id: o.op_id, ok: true, status: 200, result: {} };
      }
      if (o.kind === 'session_lines') { srv.sessionLines.set(p.session_id, p.lines); return { op_id: o.op_id, ok: true, status: 200 }; }
      if (o.kind === 'session_post') {
        if (!srv.posted.has(p.session_id)) {
          srv.posted.add(p.session_id);
          for (const l of srv.sessionLines.get(p.session_id) || []) srv.items.set(l.item_id, (srv.items.get(l.item_id) || 0) + l.counted_qty);
        }
        return { op_id: o.op_id, ok: true, status: 200 };
      }
      return { op_id: o.op_id, ok: true, status: 200 };
    });
    if (srv.mode === 'drop-response') { srv.mode = 'ok'; throw new Error('connection reset'); } // applied, but the phone never hears
    return { results };
  };
  return srv;
}

async function makeStore(srv, { online = true } = {}) {
  const net = { online };
  const adapter = S.memoryAdapter();
  const store = S.create({ adapter, send: (ops) => srv.send(ops), uploadPhoto: async () => 'ok', isOnline: () => net.online, uuid: () => crypto.randomUUID() });
  await store.load();
  return { store, net, adapter };
}
const ITEM = 'a1111111-1111-4111-8111-111111111111';
const catalog = (qty = 10) => ({ generated_at: 'x', items: [{ id: ITEM, description: '30A breaker', qty_on_hand: qty, surplus_qty: 0, serialized: false }], barcodes: [{ item_id: ITEM, code: '012345678905', code_norm: '0012345678905' }], units: [], categories: [], permissions: {} });
const settle = () => new Promise((r) => setTimeout(r, 20));

test('offline: scans queue + show in the view, nothing sent; online: one sync, no double count when the response is lost', async () => {
  const srv = fakeServer(); srv.items.set(ITEM, 10);
  const { store, net } = await makeStore(srv, { online: false });
  await store.setCatalog(catalog(10));

  await store.enqueue('txn', { client_op_id: crypto.randomUUID(), item_id: ITEM, type: 'scanned_out', qty: 2 });
  await store.enqueue('txn', { client_op_id: crypto.randomUUID(), item_id: ITEM, type: 'received', qty: 5 });
  await settle();
  assert.equal(srv.calls, 0, 'nothing sent while offline');
  assert.equal(store.state().pending, 2, '"2 scans waiting to sync"');
  assert.equal(store.item(ITEM).qty_on_hand, 13, 'view = catalog + pending');
  assert.equal(store.lookup('036000291452') , null);
  assert.equal(store.lookup('0012345678905').item.id, ITEM, 'offline lookup by barcode (EAN form)');
  assert.equal(store.lookup('012345678905').item.id, ITEM, 'offline lookup by barcode (UPC form)');
  assert.equal(store.pendingOps()[0].payload.queued_offline, true, 'offline scan-out flagged');

  net.online = true;
  srv.mode = 'drop-response';
  await store.flush();                 // server applied, phone never heard
  assert.equal(srv.items.get(ITEM), 13);
  assert.equal(store.state().pending, 2, 'still queued after the lost response');
  await store.flush();                 // resend
  assert.equal(srv.items.get(ITEM), 13, 'resend counted nothing twice');
  assert.equal(store.state().pending, 0);
});

test('5xx keeps everything queued; 4xx fails just that op and the rest sync', async () => {
  const srv = fakeServer(); srv.items.set(ITEM, 1);
  const { store } = await makeStore(srv);
  await store.setCatalog(catalog(1));
  srv.mode = '500';
  await store.enqueue('txn', { client_op_id: crypto.randomUUID(), item_id: ITEM, type: 'received', qty: 1 });
  await settle(); await store.flush();
  assert.equal(store.state().pending, 1, 'kept for retry');
  assert.equal(store.state().failed.length, 0);
  srv.mode = 'ok';
  await store.enqueue('txn', { client_op_id: crypto.randomUUID(), item_id: ITEM, type: 'scanned_out', qty: 9 }); // live: refused
  await store.enqueue('txn', { client_op_id: crypto.randomUUID(), item_id: ITEM, type: 'received', qty: 3 });
  await settle(); await store.flush(); await settle();
  assert.equal(store.state().pending, 0);
  assert.equal(store.state().failed.length, 1);
  assert.match(store.state().failed[0].error, /on hand/);
  assert.equal(srv.items.get(ITEM), 5, '1 + 1 + 3, the refused scan-out applied nothing');
});

test('count session: 300 scans = one snapshot op; indicator counts scans; a mid-flight snapshot is not lost; post is applied once', async () => {
  const srv = fakeServer(); srv.items.set(ITEM, 0);
  const { store, net } = await makeStore(srv, { online: false });
  await store.setCatalog(catalog(0));
  const s = await store.startSession();
  for (let i = 0; i < 300; i++) await store.countLine(s, ITEM);
  const ops = store.pendingOps();
  assert.equal(ops.filter((o) => o.kind === 'session_lines').length, 1, 'coalesced');
  assert.equal(ops.find((o) => o.kind === 'session_lines').payload.lines[0].counted_qty, 300);
  assert.equal(store.state().pending, 301, '300 scans + the session start');

  // Online: the snapshot is in flight when one more scan lands.
  net.online = true;
  const realSend = srv.send;
  let release;
  let held = false;
  srv.send = (b) => {
    if (held) return realSend(b); // only the first request is held on the wire
    held = true;
    return new Promise((resolve) => { release = () => resolve(realSend(b)); });
  };
  const f = store.flush();
  await settle();
  await store.countLine(s, ITEM);       // newer snapshot (301) queued while 300 is on the wire
  release();
  await f;
  srv.send = realSend;
  await store.flush(); await settle();
  assert.equal(srv.sessionLines.get(s.id)[0].counted_qty, 301, 'the newer snapshot still went');

  await store.finishSession(s);
  await settle(); await store.flush(); await settle();
  await store.enqueue('session_post', { session_id: s.id }); // a duplicate post (double tap / resend)
  await settle(); await store.flush(); await settle();
  assert.equal(srv.items.get(ITEM), 301, 'posted once');
  assert.equal(store.state().pending, 0);
});

test('offline quick-add whose barcode another phone already added: re-pointed to the existing item, scans kept', async () => {
  const srv = fakeServer();
  const EXISTING = 'b2222222-2222-4222-8222-222222222222';
  srv.items.set(EXISTING, 4); srv.barcodes.set('0099887766554', EXISTING);
  const { store, net } = await makeStore(srv, { online: false });
  await store.setCatalog({ ...catalog(0), items: [], barcodes: [] });
  const LOCAL = crypto.randomUUID();
  await store.enqueue('item_create', { id: LOCAL, description: 'Oil filter', barcode: { code: '0099887766554' }, qty: 2, client_op_id: crypto.randomUUID() });
  await store.enqueue('txn', { client_op_id: crypto.randomUUID(), item_id: LOCAL, type: 'received', qty: 3 });
  assert.equal(store.lookup('0099887766554').item.id, LOCAL, 'offline: the new item is findable at once');
  net.online = true;
  await store.flush(); await settle(); await store.flush(); await settle();
  assert.equal(srv.items.has(LOCAL), false, 'no twin item');
  assert.equal(srv.items.get(EXISTING), 9, 'the quick-add qty (2) and the later scan (3) landed on the existing item');
  assert.equal(store.state().failed.length, 0);
});
