// frontend/inventory-store.js
// The phone side of inventory: the catalog cache, the offline write queue and
// local count sessions, persisted in IndexedDB so a dead zone in the
// warehouse (or a closed tab) never loses a scan.
//
//   const store = BatesInvStore.create({ adapter, send, uploadPhoto, isOnline })
//
// THE QUEUE. Every scan write (new item, in, out, count, serial unit, count
// lines, posting a session) becomes an op with a client-made id and goes to
// POST /api/inventory/sync - online or not; online it just flushes at once.
// The server is idempotent on those ids (client_op_id / item id / unit id /
// session id), so a resend after a dropped connection returns the original
// result instead of counting twice. Results:
//   ok        -> op removed
//   409 + existing_item_id on item_create -> someone already has this
//               barcode: later ops for the local item are re-pointed to the
//               existing one (no twin items)
//   other 4xx -> moved to `failed` (shown to the user), queue continues
//   5xx / network -> stop, keep everything, retry with backoff
//
// COUNT SESSIONS live here first (hundreds of scans must stay instant): each
// scan bumps an ABSOLUTE count in the local session; one coalesced
// 'session_lines' op carries the whole snapshot, so resends are harmless and
// the queue stays small however many scans there are.
//
// THE VIEW the UI reads = last server catalog + every still-pending op
// replayed on top (applyOp), so an offline phone shows its own scans.
//
// Pure helpers (applyOp, buildIndex, lookup) are exported for tests; the
// IndexedDB adapter is the only browser-only part.

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./barcode-normalize.js'));
  else root.BatesInvStore = factory(root.BatesBarcode);
})(typeof self !== 'undefined' ? self : this, function (BatesBarcode) {
  'use strict';

  var SYNC_BATCH = 50;
  var round2 = function (n) { return Math.round(Number(n) * 100) / 100; };
  var clone = function (o) { return JSON.parse(JSON.stringify(o)); };

  // ---- pure: catalog view ---------------------------------------------------
  function emptyCatalog() { return { items: [], barcodes: [], units: [], categories: [], permissions: {}, generated_at: null }; }

  // Replay one pending op onto a catalog copy (mutates `cat`).
  function applyOp(cat, op) {
    var p = op.payload || {};
    var item = function (id) { return cat.items.find(function (i) { return i.id === id; }); };
    if (op.kind === 'item_create') {
      if (!item(p.id)) {
        cat.items.push({
          id: p.id, description: p.description, part_number: p.part_number || null, manufacturer: p.manufacturer || null,
          category: p.category || 'misc', condition: p.condition || 'new', location: p.location || null,
          unit_of_measure: p.unit_of_measure || 'each', unit_cost_cents: p.unit_cost_cents == null ? null : p.unit_cost_cents,
          serialized: !!p.serialized, qty_on_hand: (!p.serialized && !p.session_id && Number(p.qty) > 0) ? round2(p.qty) : 0,
          surplus_qty: 0, thumb_url: null, last_count: null, _pending: true,
        });
      }
      if (p.barcode && p.barcode.code) {
        var norm = BatesBarcode.normalize(p.barcode.code, p.barcode.format);
        if (norm && !cat.barcodes.some(function (b) { return b.code_norm === norm; })) cat.barcodes.push({ item_id: p.id, code: p.barcode.code, code_norm: norm, format: p.barcode.format || null });
      }
    } else if (op.kind === 'txn') {
      var it = item(p.item_id);
      if (!it) return cat;
      if (p.unit_id) {
        var u = cat.units.find(function (x) { return x.id === p.unit_id; });
        var outType = p.type === 'scanned_out' || p.type === 'sold' || p.type === 'disposed';
        if (u) u.status = outType ? ({ scanned_out: 'out', sold: 'sold', disposed: 'disposed' })[p.type] : 'in_stock';
        it.qty_on_hand = round2(it.qty_on_hand + (outType ? -1 : 1));
      } else if (p.type === 'adjustment' && p.set_qty != null) {
        it.qty_on_hand = round2(p.set_qty);
      } else {
        var q = Math.abs(Number(p.qty) || 0);
        var out = p.type === 'scanned_out' || p.type === 'sold' || p.type === 'disposed';
        it.qty_on_hand = round2(it.qty_on_hand + (p.type === 'adjustment' ? Number(p.qty) || 0 : (out ? -q : q)));
        if (p.type === 'sold' || p.type === 'disposed') it.surplus_qty = Math.max(0, round2((it.surplus_qty || 0) - q));
      }
      it.surplus_qty = Math.min(it.surplus_qty || 0, Math.max(it.qty_on_hand, 0));
    } else if (op.kind === 'undo') {
      // Optimistic reversal (the server posts the real reversing row).
      var target = item(p.item_id);
      var rev = p.reverse || {};
      if (!target) return cat;
      target.qty_on_hand = round2(target.qty_on_hand + (Number(rev.delta) || 0));
      if (rev.unit_id) {
        var uu = cat.units.find(function (x) { return x.id === rev.unit_id; });
        if (uu && rev.unit_status) uu.status = rev.unit_status;
      }
      target.surplus_qty = Math.min(target.surplus_qty || 0, Math.max(target.qty_on_hand, 0));
    } else if (op.kind === 'unit_create') {
      var parent = item(p.item_id);
      if (!parent) return cat;
      if (!cat.units.some(function (x) { return x.id === p.id; })) {
        cat.units.push({ id: p.id, item_id: p.item_id, serial_number: p.serial_number, status: 'in_stock', condition: p.condition || parent.condition });
        parent.qty_on_hand = round2(parent.qty_on_hand + 1);
      }
    }
    return cat;
  }

  function buildIndex(cat) {
    var byNorm = new Map();
    var bySerial = new Map();
    var byId = new Map();
    cat.items.forEach(function (i) { byId.set(i.id, i); });
    cat.barcodes.forEach(function (b) { byNorm.set(b.code_norm, b.item_id); });
    cat.units.forEach(function (u) { bySerial.set(String(u.serial_number).toUpperCase(), u); });
    return { byNorm: byNorm, bySerial: bySerial, byId: byId };
  }

  // A scanned/typed code -> { item, unit } | null, against the local view.
  function lookup(cat, index, code, format) {
    var cands = BatesBarcode.candidates(code, format);
    for (var i = 0; i < cands.length; i++) {
      var id = index.byNorm.get(cands[i]);
      if (id && index.byId.get(id)) return { item: index.byId.get(id), unit: null };
    }
    var u = index.bySerial.get(BatesBarcode.clean(code).toUpperCase());
    if (u && index.byId.get(u.item_id)) return { item: index.byId.get(u.item_id), unit: u };
    return null;
  }

  // Free-text search over the view: barcode, part #, description, manufacturer, location.
  function search(cat, q) {
    var s = String(q || '').trim().toUpperCase();
    if (!s) return cat.items.slice();
    var norm = BatesBarcode.normalize(s);
    var codeHits = new Set(cat.barcodes.filter(function (b) { return b.code_norm.indexOf(norm) !== -1; }).map(function (b) { return b.item_id; }));
    var terms = s.split(/\s+/);
    return cat.items.filter(function (i) {
      if (codeHits.has(i.id)) return true;
      var hay = [i.description, i.part_number, i.manufacturer, i.location].join(' ').toUpperCase();
      return terms.every(function (t) { return hay.indexOf(t) !== -1; });
    });
  }

  // ---- adapters ---------------------------------------------------------------
  function memoryAdapter() {
    var stores = {};
    var st = function (n) { return (stores[n] = stores[n] || new Map()); };
    return {
      get: function (s, k) { return Promise.resolve(st(s).has(k) ? clone(st(s).get(k)) : undefined); },
      put: function (s, k, v) { st(s).set(k, clone(v)); return Promise.resolve(); },
      del: function (s, k) { st(s).delete(k); return Promise.resolve(); },
      all: function (s) { return Promise.resolve(Array.from(st(s).values()).map(clone)); },
      _stores: stores,
    };
  }

  function indexedDbAdapter(dbName) {
    var STORES = ['ops', 'failed', 'kv', 'sessions', 'photos'];
    var dbp = new Promise(function (resolve, reject) {
      var req = indexedDB.open(dbName || 'bates-inventory', 1);
      req.onupgradeneeded = function () { STORES.forEach(function (s) { if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s); }); };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
    function run(store, mode, fn) {
      return dbp.then(function (db) {
        return new Promise(function (resolve, reject) {
          var tx = db.transaction(store, mode);
          var r = fn(tx.objectStore(store));
          tx.oncomplete = function () { resolve(r && 'result' in r ? r.result : undefined); };
          tx.onerror = function () { reject(tx.error); };
          tx.onabort = function () { reject(tx.error); };
        });
      });
    }
    return {
      get: function (s, k) { return run(s, 'readonly', function (os) { return os.get(k); }); },
      put: function (s, k, v) { return run(s, 'readwrite', function (os) { os.put(v, k); }); },
      del: function (s, k) { return run(s, 'readwrite', function (os) { os.delete(k); }); },
      all: function (s) { return run(s, 'readonly', function (os) { return os.getAll(); }); },
    };
  }

  // ---- the store --------------------------------------------------------------
  function create(opts) {
    var adapter = opts.adapter;
    var send = opts.send;                 // (ops) -> Promise<{ results }>
    var uploadPhoto = opts.uploadPhoto;   // (photoRecord) -> Promise
    var isOnline = opts.isOnline || function () { return true; };
    var uuid = opts.uuid || function () { return crypto.randomUUID(); };
    var listeners = [];
    var seqCounter = 0;
    var flushing = null;
    var retryTimer = null;
    var backoff = 2000;
    var base = emptyCatalog();
    var view = emptyCatalog();
    var index = buildIndex(view);
    var pending = [];
    var failed = [];
    var photosPending = 0;
    var lastError = null;
    var remapped = new Map();            // local item id -> existing server id (this session)
    var inFlight = new Set();            // op ids in the request on the wire right now
    var recent = [];                     // acknowledged undoable ops: { op_id, payload, effect, txn }
    var recentDirty = false;
    var baseDirty = false;

    function notify() { listeners.forEach(function (fn) { try { fn(state()); } catch (e) { /* listener bug */ } }); }
    function state() {
      var unsyncedScans = 0;
      pending.forEach(function (op) { unsyncedScans += op.kind === 'session_lines' ? (op.scans || 1) : 1; });
      return { pending: unsyncedScans + photosPending, failed: failed.slice(), syncing: !!flushing, online: isOnline(), lastError: lastError, catalogAt: base.generated_at };
    }
    function nextSeq() { seqCounter += 1; return Date.now() * 1000 + (seqCounter % 1000); }

    function rebuild() {
      view = clone(base);
      pending.slice().sort(function (a, b) { return a.seq - b.seq; }).forEach(function (op) { applyOp(view, op); });
      index = buildIndex(view);
    }

    function load() {
      return Promise.all([adapter.get('kv', 'catalog'), adapter.all('ops'), adapter.all('failed'), adapter.all('photos'), adapter.get('kv', 'recent')]).then(function (r) {
        recent = r[4] || [];
        base = r[0] || emptyCatalog();
        pending = r[1] || [];
        failed = r[2] || [];
        photosPending = (r[3] || []).length;
        rebuild();
        notify();
      });
    }

    function setCatalog(cat) {
      base = cat;
      return adapter.put('kv', 'catalog', cat).then(function () { rebuild(); notify(); });
    }

    // Queue an op. `offline` is recorded so the server lets an offline
    // scan-out take stock below zero (the part already left the building).
    // What an op does to the screen right now (for Undo): item, qty delta,
    // unit and its status before. Measured against the current view.
    function effectOf(kind, p) {
      var it = index.byId.get(p.item_id);
      if (!it) return null;
      if (kind === 'unit_create') {
        var prev = view.units.find(function (u) { return u.id === p.id; });
        return { item_id: p.item_id, delta: 1, unit_id: p.id, unit_status_before: prev ? prev.status : 'pending' };
      }
      if (kind !== 'txn') return null;
      var out = p.type === 'scanned_out' || p.type === 'sold' || p.type === 'disposed';
      if (p.unit_id) {
        var u = view.units.find(function (x) { return x.id === p.unit_id; });
        return { item_id: p.item_id, delta: out ? -1 : 1, unit_id: p.unit_id, unit_status_before: u ? u.status : 'in_stock' };
      }
      var delta = p.type === 'adjustment' && p.set_qty != null ? round2(p.set_qty - it.qty_on_hand)
        : (p.type === 'adjustment' ? Number(p.qty) || 0 : (out ? -1 : 1) * Math.abs(Number(p.qty) || 0));
      return { item_id: p.item_id, delta: delta, unit_id: null };
    }

    function enqueue(kind, payload, extra) {
      var op = { op_id: (extra && extra.op_id) || uuid(), seq: nextSeq(), kind: kind, payload: payload, v: 1, created_at: new Date().toISOString() };
      if (kind === 'txn' && payload.type === 'scanned_out' && !isOnline()) payload.queued_offline = true;
      if (kind === 'txn' || kind === 'unit_create') op.effect = effectOf(kind, payload);
      if (extra && extra.scans) op.scans = extra.scans;
      var existing = pending.findIndex(function (o) { return o.op_id === op.op_id; });
      if (existing !== -1) { op.v = (pending[existing].v || 1) + 1; pending.splice(existing, 1); }
      pending.push(op);
      return adapter.put('ops', op.op_id, op).then(function () { rebuild(); notify(); scheduleFlush(extra && extra.delay); return op; });
    }

    // Timers never keep a Node test process alive (unref is a no-op shape in browsers).
    function later(fn, ms) { var t = setTimeout(fn, ms); if (t && t.unref) t.unref(); return t; }
    function scheduleFlush(delay) {
      clearTimeout(retryTimer);
      retryTimer = later(function () { flush(); }, delay == null ? 0 : delay);
    }

    // Remap a local item id to the server's existing item in every pending op.
    function remapItem(fromId, toId) {
      var touched = [];
      pending.forEach(function (op) {
        var p = op.payload || {};
        var hit = false;
        if (p.item_id === fromId) { p.item_id = toId; hit = true; }
        if (op.kind === 'session_lines' && Array.isArray(p.lines)) {
          var merged = {};
          p.lines.forEach(function (l) {
            var id = l.item_id === fromId ? toId : l.item_id;
            if (l.item_id === fromId) hit = true;
            merged[id] = merged[id] ? { item_id: id, counted_qty: round2(merged[id].counted_qty + l.counted_qty), mode: merged[id].mode } : { item_id: id, counted_qty: l.counted_qty, mode: l.mode };
          });
          p.lines = Object.keys(merged).map(function (k) { return merged[k]; });
        }
        if (hit) touched.push(adapter.put('ops', op.op_id, op));
      });
      return Promise.all(touched).then(function () { return remapSessions(fromId, toId); });
    }
    function remapSessions(fromId, toId) {
      return adapter.all('sessions').then(function (list) {
        return Promise.all(list.map(function (s) {
          if (!s.lines || !s.lines[fromId]) return null;
          var l = s.lines[fromId];
          delete s.lines[fromId];
          if (s.lines[toId]) s.lines[toId].qty = round2(s.lines[toId].qty + l.qty); else s.lines[toId] = l;
          return adapter.put('sessions', s.id, s);
        }));
      });
    }

    // Does this op reference an item we just re-pointed? Then its failure in
    // the SAME batch (sent before the remap) is not real: it stays queued and
    // goes again with the existing item's id.
    function refsRemapped(op) {
      var p = op.payload || {};
      if (p.item_id && remapped.has(p.item_id)) return true;
      return Array.isArray(p.lines) && p.lines.some(function (l) { return remapped.has(l.item_id); });
    }

    function handleResult(op, res) {
      var stored = pending.find(function (o) { return o.op_id === op.op_id; });
      if (!res.ok && stored && refsRemapped(op)) return Promise.resolve();
      var sameVersion = stored && stored.v === op.v;
      if (res.ok) {
        if (sameVersion) {
          // The server has it now: fold it into the stored catalog copy too,
          // so the screen doesn't jump back (a new item vanishing, a qty
          // reverting) until the next catalog refresh replaces the copy.
          applyOp(base, stored);
          baseDirty = true;
          if (stored.effect) {
            recent.unshift({ op_id: stored.op_id, kind: stored.kind, payload: stored.payload, effect: stored.effect, txn: res.result && res.result.txn ? { id: res.result.txn.id, qty_change: res.result.txn.qty_change } : null });
            recent = recent.slice(0, 100);
            recentDirty = true;
          }
          pending = pending.filter(function (o) { return o !== stored; });
          return adapter.del('ops', op.op_id);
        }
        return Promise.resolve(); // a newer snapshot was queued meanwhile; it still has to go
      }
      if (op.kind === 'item_create' && res.status === 409 && res.existing_item_id) {
        pending = pending.filter(function (o) { return o.op_id !== op.op_id; });
        remapped.set(op.payload.id, res.existing_item_id);
        return adapter.del('ops', op.op_id).then(function () { return remapItem(op.payload.id, res.existing_item_id); })
          .then(function () {
            // The quick-add's photos belong to the existing item now.
            return adapter.all('photos').then(function (ph) {
              return Promise.all(ph.filter(function (x) { return x.item_id === op.payload.id; }).map(function (x) { x.item_id = res.existing_item_id; return adapter.put('photos', x.photo_id, x); }));
            });
          })
          .then(function () {
            // The quick-add's own quantity still happened: carry it over to the
            // existing item (same client_op_id, so a resend can't double it).
            // A count-session quick-add's qty lives in the session lines, which
            // remapItem already moved.
            var p = op.payload;
            if (!p.serialized && !p.session_id && Number(p.qty) > 0) {
              return enqueue('txn', { client_op_id: p.client_op_id, item_id: res.existing_item_id, type: p.initial_type === 'initial_count' ? 'initial_count' : 'received', qty: Number(p.qty), source: p.source, occurred_at: p.occurred_at });
            }
          })
          .then(function () { if (opts.onRemap) opts.onRemap(op.payload.id, res.existing_item_id); });
      }
      var f = { op_id: op.op_id, kind: op.kind, payload: op.payload, error: res.error || 'Not saved', status: res.status, at: new Date().toISOString() };
      failed.push(f);
      pending = pending.filter(function (o) { return o.op_id !== op.op_id; });
      return Promise.all([adapter.put('failed', f.op_id, f), adapter.del('ops', op.op_id)]);
    }

    function flush() {
      if (flushing) return flushing;
      if (!pending.length && !photosPending) return Promise.resolve(state());
      if (!isOnline()) { notify(); return Promise.resolve(state()); }
      flushing = (function loop() {
        var batch = pending.slice().sort(function (a, b) { return a.seq - b.seq; }).slice(0, SYNC_BATCH).map(clone);
        if (!batch.length) return flushPhotos();
        var before = pending.map(function (o) { return o.op_id + ':' + o.v + ':' + JSON.stringify(o.payload); }).join('|');
        notify();
        inFlight = new Set(batch.map(function (o) { return o.op_id; }));
        return send(batch.map(function (o) { return { op_id: o.op_id, kind: o.kind, payload: o.payload }; })).then(function (resp) {
          inFlight = new Set();
          var results = (resp && resp.results) || [];
          var stop = false;
          var chain = Promise.resolve();
          batch.forEach(function (op, i) {
            var r = results[i];
            if (!r || stop) return;
            if (r.status >= 500) { stop = true; return; }
            chain = chain.then(function () { return handleResult(op, r); });
          });
          return chain.then(function () {
            rebuild();
            if (stop || results.length < batch.length) throw new Error('Server busy - will retry');
            backoff = 2000;
            lastError = null;
            // Go again only if this round changed something (an op finished,
            // or a re-point rewrote one); otherwise back off instead of spinning.
            var after = pending.map(function (o) { return o.op_id + ':' + o.v + ':' + JSON.stringify(o.payload); }).join('|');
            if (pending.length && after === before) throw new Error('Waiting to retry');
            return pending.length ? loop() : flushPhotos();
          });
        });
      })().catch(function (e) {
        inFlight = new Set();
        lastError = (e && e.message) || 'Sync failed';
        retryTimer = later(function () { flush(); }, backoff);
        backoff = Math.min(backoff * 2, 60000);
      }).then(function () {
        flushing = null;
        if (baseDirty) { baseDirty = false; adapter.put('kv', 'catalog', base).catch(function () { /* next refresh rewrites it */ }); }
        if (recentDirty) { recentDirty = false; adapter.put('kv', 'recent', recent).catch(function () { /* undo falls back to history */ }); }
        rebuild();
        notify();
        // Something queued during the last request: go again shortly.
        if (pending.length && !lastError && isOnline()) scheduleFlush(300);
        if (opts.onFlushed) opts.onFlushed(state());
        return state();
      });
      notify();
      return flushing;
    }

    function flushPhotos() {
      return adapter.all('photos').then(function (list) {
        photosPending = list.length;
        var chain = Promise.resolve();
        list.forEach(function (ph) {
          // Wait until the item itself exists on the server.
          if (pending.some(function (o) { return o.kind === 'item_create' && o.payload.id === ph.item_id; })) return;
          // uploadPhoto resolves 'ok' or 'drop' (refused for good); a
          // rejection means "try again later" and stops this pass.
          chain = chain.then(function () {
            return uploadPhoto(ph).then(function (outcome) {
              photosPending -= 1;
              var done = adapter.del('photos', ph.photo_id);
              if (outcome !== 'drop') return done;
              var f = { op_id: 'photo:' + ph.photo_id, kind: 'photo', payload: { item_id: ph.item_id }, error: 'A photo could not be saved.', status: 400, at: new Date().toISOString() };
              failed.push(f);
              return Promise.all([done, adapter.put('failed', f.op_id, f)]);
            });
          });
        });
        return chain;
      });
    }

    function queuePhoto(rec) {
      return adapter.put('photos', rec.photo_id, rec).then(function () { photosPending += 1; notify(); scheduleFlush(); });
    }

    // ---- undo ----
    // Undo one of this phone's actions by its op id:
    //   still queued (not sent)  -> just drop it; nothing ever reaches the server
    //   on the wire or synced    -> queue an 'undo' op naming the original's
    //                               client_op_id; the server posts the reversing
    //                               row (after the original, by queue order)
    // Resolves { dropped } | { queued } | { error }.
    function undo(opId) {
      var p = pending.find(function (o) { return o.op_id === opId; });
      if (p && !inFlight.has(opId)) {
        pending = pending.filter(function (o) { return o !== p; });
        return adapter.del('ops', opId).then(function () { rebuild(); notify(); return { dropped: true }; });
      }
      var src = p || recent.find(function (r) { return r.op_id === opId; });
      if (!src || !src.effect) return Promise.resolve({ error: 'Nothing to undo.' });
      var eff = src.effect;
      var delta = src.txn && src.txn.qty_change != null ? Number(src.txn.qty_change) : eff.delta;
      return enqueue('undo', {
        client_op_id: uuid(),
        original_client_op_id: src.payload.client_op_id,
        item_id: eff.item_id,
        reverse: { delta: -delta, unit_id: eff.unit_id || null, unit_status: delta < 0 ? 'in_stock' : (eff.unit_status_before || 'pending') },
      }).then(function () { return { queued: true }; });
    }
    // Undo a ledger row seen in the item's history (server id).
    function undoTxn(row) {
      return enqueue('undo', {
        client_op_id: uuid(),
        txn_id: row.id,
        item_id: row.item_id,
        reverse: { delta: -Number(row.qty_change || 0), unit_id: row.unit_id || null, unit_status: Number(row.qty_change) < 0 ? 'in_stock' : 'out' },
      }).then(function () { return { queued: true }; });
    }

    function dismissFailed(opId) {
      failed = failed.filter(function (f) { return f.op_id !== opId; });
      return adapter.del('failed', opId).then(notify);
    }

    // ---- count sessions ----
    function getSession(id) { return adapter.get('sessions', id); }
    function openSessions() { return adapter.all('sessions').then(function (l) { return l.filter(function (s) { return s.status === 'open'; }); }); }
    function startSession(note) {
      var s = { id: uuid(), started_at: new Date().toISOString(), note: note || null, status: 'open', lines: {}, order: [], scans: 0, units: 0, created: 0, unsynced: 0 };
      return adapter.put('sessions', s.id, s).then(function () { return enqueue('session_upsert', { id: s.id, note: s.note }); }).then(function () { return s; });
    }
    function saveSession(s) { return adapter.put('sessions', s.id, s); }
    // Bump (or set) a line, persist, and queue ONE coalesced snapshot op.
    function countLine(session, itemId, opts2) {
      var o = opts2 || {};
      var line = session.lines[itemId] || { qty: 0, mode: o.mode || 'add' };
      if (o.mode) line.mode = o.mode;
      line.qty = round2(o.set != null ? o.set : line.qty + (o.delta == null ? 1 : o.delta));
      if (line.qty < 0) line.qty = 0;
      session.lines[itemId] = line;
      if (session.order.indexOf(itemId) === -1) session.order.unshift(itemId);
      if (!o.silent) { session.scans += 1; session.unsynced += 1; }
      return saveSession(session).then(function () { return syncSessionLines(session); });
    }
    function syncSessionLines(session) {
      var lines = Object.keys(session.lines).map(function (id) { return { item_id: id, counted_qty: session.lines[id].qty, mode: session.lines[id].mode }; });
      return enqueue('session_lines', { session_id: session.id, lines: lines }, { op_id: 'lines:' + session.id, scans: session.unsynced || 1, delay: 1500 });
    }
    function finishSession(session) {
      session.status = 'finishing';
      return saveSession(session)
        .then(function () { return syncSessionLines(session); })
        .then(function () { return enqueue('session_post', { session_id: session.id }); })
        .then(function () { session.status = 'posted'; session.finished_at = new Date().toISOString(); return saveSession(session); })
        .then(function () { return session; });
    }
    function discardSession(session) {
      session.status = 'discarded';
      return saveSession(session).then(function () { return enqueue('session_discard', { session_id: session.id }); });
    }

    return {
      load: load, setCatalog: setCatalog, enqueue: enqueue, flush: flush, queuePhoto: queuePhoto, dismissFailed: dismissFailed,
      undo: undo, undoTxn: undoTxn,
      state: state, onChange: function (fn) { listeners.push(fn); },
      stop: function () { clearTimeout(retryTimer); },
      view: function () { return view; }, lookup: function (code, format) { return lookup(view, index, code, format); },
      item: function (id) { return index.byId.get(id) || null; },
      unitsOf: function (itemId) { return view.units.filter(function (u) { return u.item_id === itemId; }); },
      search: function (q) { return search(view, q); },
      pendingOps: function () { return pending.slice(); },
      startSession: startSession, getSession: getSession, openSessions: openSessions, countLine: countLine, saveSession: saveSession,
      finishSession: finishSession, discardSession: discardSession, uuid: uuid,
    };
  }

  return { create: create, applyOp: applyOp, buildIndex: buildIndex, lookup: lookup, search: search, memoryAdapter: memoryAdapter, indexedDbAdapter: indexedDbAdapter };
});
