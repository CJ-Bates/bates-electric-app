// Warehouse inventory API (routes/inventory.js + middleware/permissions.js)
// through the real shipped handlers against the in-memory Supabase stand-in.
// The two ledger functions are faked here with the SAME rules as sql/039
// (inventorySql.test.js runs the real SQL against Postgres when available):
//   - permissions: role defaults (office view; tech view + scan out), the
//     nesting (manage > scan_out > view), admin, customers locked out
//   - /sync per-op permissions: a tech can scan out but not receive, count,
//     adjust, add items or run sessions; office (default) is look-up only
//   - scan-in / scan-out / count math, serialized units, sell reduces surplus
//   - idempotency: a resent op (same client_op_id / item id) counts once
//   - an offline scan-out may go below zero; a live one may not
//   - quick-add with a barcode another item owns -> 409 + existing_item_id
//   - surplus can't exceed on hand; CSV export (escaping, formula injection);
//     unit cost is visible to techs (CJ 2026-10-30) - catalog keeps it
require('./helpers/env');

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const { supabaseAdmin } = require('../lib/supabase');
const { installMockSupabase } = require('./helpers/mockSupabase');
const { memTable } = require('./helpers/memTable');
const { getRouteHandler, makeRes } = require('./helpers/routeHandler');
const { effectivePermissions } = require('../middleware/permissions');
const inv = require('../lib/inventory');
const router = require('../routes/inventory');

const TECH = { id: 'd0000000-0000-4000-8000-00000000000c', role: 'tech', is_admin: false };
const OFFICE = { id: 'a0000000-0000-4000-8000-0000000000a1', role: 'office', is_admin: false };
const WAREHOUSE = { id: 'e0000000-0000-4000-8000-0000000000e1', role: 'office', is_admin: false };
const CJ = { id: 'c0000000-0000-4000-8000-0000000000c1', role: 'office', is_admin: true };
const ROWS = { [WAREHOUSE.id]: { profile_id: WAREHOUSE.id, inventory_manage: true } };

const ITEM = '11111111-1111-4111-8111-111111111111';
const ATS = '22222222-2222-4222-8222-222222222222';

let world;
let restore;
let realRpc;
const pgError = (code, message) => ({ data: null, error: { code, message } });

// Fake of inventory_post_txn / inventory_post_count_session (sql/039 rules).
function fakeRpc(name, a) {
  const items = world.items.rows;
  const ledger = world.txns.rows;
  if (name === 'inventory_post_txn') {
    if (a.p_client_op_id) {
      const dup = ledger.find((t) => t.client_op_id === a.p_client_op_id);
      if (dup) return { data: dup, error: null };
    }
    const it = items.find((i) => i.id === a.p_item_id);
    if (!it) return pgError('P0002', 'inventory item not found');
    let change;
    let unitId = a.p_unit_id;
    if (a.p_reverses_txn_id) {
      // sql/040 undo rules
      const orig = ledger.find((t) => t.id === a.p_reverses_txn_id);
      if (!orig) return pgError('P0002', 'nothing to undo');
      if (orig.reverses_txn_id) return pgError('22023', "an undo can't be undone");
      const prior = ledger.find((t) => t.reverses_txn_id === orig.id);
      if (prior) return { data: prior, error: null };
      if (orig.unit_id) {
        unitId = orig.unit_id;
        const u = world.units.rows.find((x) => x.id === orig.unit_id);
        if (orig.qty_change > 0) { if (u.status !== 'in_stock') return pgError('22023', 'no longer in stock'); u.status = 'pending'; change = -1; }
        else { if (u.status === 'in_stock') return pgError('22023', 'already back in stock'); u.status = 'in_stock'; change = 1; }
      } else {
        change = -orig.qty_change;
        if (it.qty_on_hand + change < 0) return pgError('22023', "only " + it.qty_on_hand + " on hand - can't undo");
      }
    } else if (it.serialized) {
      if (!a.p_unit_id) return pgError('22023', 'serialized item: pick the unit (serial number)');
      const u = world.units.rows.find((x) => x.id === a.p_unit_id && x.item_id === it.id);
      if (!u) return pgError('P0002', 'unit not found on this item');
      if (['initial_count', 'received'].includes(a.p_type)) {
        if (u.status === 'in_stock') return pgError('22023', 'unit ' + u.serial_number + ' is already in stock');
        u.status = 'in_stock'; change = 1;
      } else if (['scanned_out', 'sold', 'disposed'].includes(a.p_type)) {
        if (u.status !== 'in_stock') return pgError('22023', 'unit ' + u.serial_number + ' is not in stock');
        u.status = { scanned_out: 'out', sold: 'sold', disposed: 'disposed' }[a.p_type]; change = -1;
      } else return pgError('22023', 'serialized items move by unit');
    } else {
      change = a.p_set_qty != null ? a.p_set_qty - it.qty_on_hand : a.p_qty_change;
      if (change == null) return pgError('22023', 'quantity required');
      if (['initial_count', 'received'].includes(a.p_type) && change <= 0) return pgError('22023', a.p_type + ' needs a positive quantity');
      if (['scanned_out', 'sold', 'disposed'].includes(a.p_type) && change >= 0) return pgError('22023', a.p_type + ' needs a negative quantity');
      if (it.qty_on_hand + change < 0 && !(a.p_allow_negative && a.p_type === 'scanned_out')) return pgError('22023', 'only ' + it.qty_on_hand + ' on hand');
    }
    const result = Math.round((it.qty_on_hand + change) * 100) / 100;
    let surplus = it.surplus_qty || 0;
    if (['sold', 'disposed'].includes(a.p_type)) surplus = Math.max(surplus + change, 0);
    surplus = Math.min(surplus, Math.max(result, 0));
    const row = {
      id: crypto.randomUUID(), item_id: it.id, unit_id: unitId, txn_type: a.p_type, reverses_txn_id: a.p_reverses_txn_id || null, qty_change: change, resulting_qty: result,
      actor_id: a.p_actor_id, client_op_id: a.p_client_op_id, session_id: a.p_session_id, job_note: a.p_job_note, customer_id: a.p_customer_id,
      note: a.p_note, source: a.p_source, created_at: new Date().toISOString(), allow_negative: a.p_allow_negative,
    };
    ledger.push(row);
    it.qty_on_hand = result; it.surplus_qty = surplus; it.last_activity_at = row.created_at;
    return { data: row, error: null };
  }
  if (name === 'inventory_post_count_session') {
    const s = world.sessions.rows.find((x) => x.id === a.p_session_id);
    if (!s) return pgError('P0002', 'count session not found');
    if (s.status === 'posted') return { data: 0, error: null };
    let n = 0;
    for (const l of world.lines.rows.filter((x) => x.session_id === s.id)) {
      const it = items.find((i) => i.id === l.item_id);
      if (!it || it.serialized || (l.counted_qty <= 0 && l.mode !== 'replace')) continue;
      const opId = crypto.createHash('md5').update(s.id + ':' + l.item_id).digest('hex');
      const r = l.mode === 'replace'
        ? fakeRpc('inventory_post_txn', { p_item_id: l.item_id, p_type: 'adjustment', p_actor_id: a.p_actor_id, p_set_qty: l.counted_qty, p_client_op_id: opId, p_session_id: s.id })
        : fakeRpc('inventory_post_txn', { p_item_id: l.item_id, p_type: 'initial_count', p_actor_id: a.p_actor_id, p_qty_change: l.counted_qty, p_client_op_id: opId, p_session_id: s.id });
      if (r.error) return r;
      n++;
    }
    s.status = 'posted';
    return { data: n, error: null };
  }
  throw new Error('unexpected rpc ' + name);
}

function setup() {
  world = {
    items: memTable([
      { id: ITEM, description: '30A breaker', category: 'breaker', condition: 'new', unit_of_measure: 'each', unit_cost_cents: 1250, serialized: false, qty_on_hand: 10, surplus_qty: 0, archived_at: null, created_at: '2026-10-01T00:00:00Z' },
      { id: ATS, description: '400A ATS', category: 'ats', condition: 'new', unit_of_measure: 'each', unit_cost_cents: 380000, serialized: true, qty_on_hand: 1, surplus_qty: 0, archived_at: null, created_at: '2026-10-01T00:00:00Z' },
    ], { defaults: () => ({ qty_on_hand: 0, surplus_qty: 0, archived_at: null, serialized: false }) }), // the SQL column defaults
    barcodes: memTable([{ id: 'b1', item_id: ITEM, code: '012345678905', code_norm: '0012345678905', format: 'upc_a' }]),
    units: memTable([{ id: 'u1000000-0000-4000-8000-000000000001', item_id: ATS, serial_number: 'SN-A1', status: 'in_stock', condition: 'new' }], { defaults: () => ({ status: 'pending' }) }),
    photos: memTable([]),
    txns: memTable([]),
    sessions: memTable([], { defaults: () => ({ status: 'open' }) }),
    lines: memTable([], { defaults: () => ({ mode: 'add' }) }),
    perms: memTable(Object.values(ROWS)),
  };
  restore = installMockSupabase({
    inventory_items: world.items.resolver,
    inventory_barcodes: world.barcodes.resolver,
    inventory_units: world.units.resolver,
    inventory_photos: world.photos.resolver,
    inventory_transactions: world.txns.resolver,
    inventory_count_sessions: world.sessions.resolver,
    inventory_count_lines: world.lines.resolver,
    member_permissions: world.perms.resolver,
    profiles: () => ({ data: [], error: null }),
    generator_customers: () => ({ data: [], error: null }),
  });
  realRpc = supabaseAdmin.rpc;
  supabaseAdmin.rpc = async (name, args) => fakeRpc(name, args);
}
test.beforeEach(setup);
test.afterEach(() => { restore(); supabaseAdmin.rpc = realRpc; });

const syncHandler = getRouteHandler(router, 'post', '/sync');
async function sync(profile, ops) {
  const res = makeRes();
  await syncHandler({ profile, body: { ops: ops.map((o, i) => ({ op_id: 'op' + i, ...o })) }, _memberPermRow: ROWS[profile.id] || null }, res);
  return res.body.results;
}
const item = (id) => world.items.rows.find((i) => i.id === id);
const sumLedger = (id) => world.txns.rows.filter((t) => t.item_id === id).reduce((s, t) => s + t.qty_change, 0);

// ---------------------------------------------------------------------------
test('permissions: role defaults, nesting, admin, customers locked out', () => {
  const p = (profile, row) => {
    const e = effectivePermissions(profile, row || null);
    return [e.inventory_view, e.inventory_scan_out, e.inventory_manage];
  };
  assert.deepEqual(p(OFFICE), [true, false, false], 'office: look up only');
  assert.deepEqual(p(TECH), [true, true, false], 'tech: look up + scan out');
  assert.deepEqual(p(WAREHOUSE, ROWS[WAREHOUSE.id]), [true, true, true], 'manage implies the rest');
  assert.deepEqual(p(CJ), [true, true, true]);
  assert.deepEqual(p(TECH, { inventory_view: false, inventory_scan_out: false }), [false, false, false], 'switched off');
  assert.deepEqual(p(OFFICE, { inventory_scan_out: true, inventory_view: null }), [true, true, false], 'scan out implies view');
  assert.deepEqual(p({ id: 'x', role: 'customer' }, { inventory_manage: true }), [false, false, false], 'customers never');
  // Existing flags unchanged by the inventory additions.
  const e = effectivePermissions(OFFICE, null);
  assert.equal(e.texting, true); assert.equal(e.tech_reschedule, false);
});

test('router admits office + tech only (customers get 403 at the door)', () => {
  const roleLayer = router.stack[1]; // router.use(requireAuth, requireRole(...)) -> [requireAuth, requireRole]
  const run = (role) => { const res = makeRes(); let passed = false; roleLayer.handle({ profile: { role } }, res, () => { passed = true; }); return passed || res.statusCode; };
  assert.equal(run('office'), true);
  assert.equal(run('tech'), true);
  assert.equal(run('customer'), 403);
});

test('tech: can scan out (with "for what?"), cannot receive / count / add / run sessions; office default is look-up only', async () => {
  const cust = 'f0000000-0000-4000-8000-0000000000f1';
  let r = await sync(TECH, [{ kind: 'txn', payload: { client_op_id: crypto.randomUUID(), item_id: ITEM, type: 'scanned_out', qty: 2, job_note: 'Smith job', customer_id: cust } }]);
  assert.equal(r[0].ok, true);
  assert.equal(item(ITEM).qty_on_hand, 8);
  const t = world.txns.rows[0];
  assert.equal(t.qty_change, -2); assert.equal(t.job_note, 'Smith job'); assert.equal(t.customer_id, cust); assert.equal(t.actor_id, TECH.id);

  r = await sync(TECH, [
    { kind: 'txn', payload: { client_op_id: crypto.randomUUID(), item_id: ITEM, type: 'received', qty: 5 } },
    { kind: 'txn', payload: { client_op_id: crypto.randomUUID(), item_id: ITEM, type: 'adjustment', set_qty: 50 } },
    { kind: 'item_create', payload: { description: 'Sneaky', qty: 3 } },
    { kind: 'session_upsert', payload: { id: crypto.randomUUID() } },
    { kind: 'txn', payload: { client_op_id: crypto.randomUUID(), item_id: ITEM, type: 'sold', qty: 1 } },
  ]);
  assert.deepEqual(r.map((x) => x.status), [403, 403, 403, 403, 403]);
  assert.equal(item(ITEM).qty_on_hand, 8, 'nothing moved');

  r = await sync(OFFICE, [{ kind: 'txn', payload: { client_op_id: crypto.randomUUID(), item_id: ITEM, type: 'scanned_out', qty: 1 } }]);
  assert.equal(r[0].status, 403, 'office default cannot scan out');

  // PATCH (edit) is manage-gated at the route; check the middleware order.
  const patch = router.stack.find((l) => l.route && l.route.path === '/items/:id' && l.route.methods.patch);
  assert.equal(patch.route.stack.length, 2, 'requirePermission + handler');
});

test('scan-in / out / count math; the ledger always sums to the on-hand qty', async () => {
  const ops = [
    { kind: 'txn', payload: { client_op_id: crypto.randomUUID(), item_id: ITEM, type: 'received', qty: 6 } },      // 16
    { kind: 'txn', payload: { client_op_id: crypto.randomUUID(), item_id: ITEM, type: 'scanned_out', qty: 4 } },   // 12
    { kind: 'txn', payload: { client_op_id: crypto.randomUUID(), item_id: ITEM, type: 'adjustment', set_qty: 9 } }, // 9 (-3)
    { kind: 'txn', payload: { client_op_id: crypto.randomUUID(), item_id: ITEM, type: 'scanned_out', qty: 20 } },  // refused live
  ];
  const r = await sync(WAREHOUSE, ops);
  assert.deepEqual(r.map((x) => x.ok), [true, true, true, false]);
  assert.match(r[3].error, /only 9 on hand/);
  assert.equal(item(ITEM).qty_on_hand, 9);
  assert.deepEqual(world.txns.rows.map((t) => t.qty_change), [6, -4, -3]);
  assert.equal(10 + sumLedger(ITEM), item(ITEM).qty_on_hand, 'seed 10 + ledger = on hand');
  assert.equal(r[2].result.txn.resulting_qty, 9);
});

test('idempotency: the same op resent (lost response) counts once; same item create resent makes one item', async () => {
  const op = { kind: 'txn', payload: { client_op_id: crypto.randomUUID(), item_id: ITEM, type: 'received', qty: 3 } };
  await sync(WAREHOUSE, [op]);
  await sync(WAREHOUSE, [op]);
  await sync(WAREHOUSE, [op]);
  assert.equal(item(ITEM).qty_on_hand, 13);
  assert.equal(world.txns.rows.length, 1);

  const id = crypto.randomUUID();
  const create = { kind: 'item_create', payload: { id, description: 'Oil filter', category: 'filter', barcode: { code: '0099887766554', format: 'ean_13' }, qty: 12, client_op_id: crypto.randomUUID() } };
  let r = await sync(WAREHOUSE, [create]);
  assert.equal(r[0].ok, true);
  r = await sync(WAREHOUSE, [create]);
  assert.equal(r[0].ok, true, 'resend is fine');
  assert.equal(world.items.rows.filter((i) => i.id === id).length, 1);
  assert.equal(world.barcodes.rows.filter((b) => b.item_id === id).length, 1);
  assert.equal(item(id).qty_on_hand, 12, 'qty posted once');
});

test('offline scan-out may go below zero (needs recount); the same request live may not', async () => {
  let r = await sync(TECH, [{ kind: 'txn', payload: { client_op_id: crypto.randomUUID(), item_id: ITEM, type: 'scanned_out', qty: 12 } }]);
  assert.equal(r[0].status, 400);
  r = await sync(TECH, [{ kind: 'txn', payload: { client_op_id: crypto.randomUUID(), item_id: ITEM, type: 'scanned_out', qty: 12, queued_offline: true } }]);
  assert.equal(r[0].ok, true);
  assert.equal(item(ITEM).qty_on_hand, -2);
  // queued_offline never loosens anything but a scan-out.
  r = await sync(WAREHOUSE, [{ kind: 'txn', payload: { client_op_id: crypto.randomUUID(), item_id: ITEM, type: 'sold', qty: 5, queued_offline: true } }]);
  assert.equal(r[0].status, 400);
});

test('serialized units: receive by serial, scan out one unit, no double out, qty = units in stock', async () => {
  const newUnit = crypto.randomUUID();
  let r = await sync(WAREHOUSE, [{ kind: 'unit_create', payload: { id: newUnit, item_id: ATS, serial_number: 'SN-B2', type: 'received', client_op_id: crypto.randomUUID() } }]);
  assert.equal(r[0].ok, true);
  assert.equal(item(ATS).qty_on_hand, 2);
  r = await sync(WAREHOUSE, [{ kind: 'unit_create', payload: { id: crypto.randomUUID(), item_id: ATS, serial_number: 'sn-b2', type: 'received', client_op_id: crypto.randomUUID() } }]);
  assert.equal(r[0].status, 409, 'same serial (any case) already in stock');
  r = await sync(TECH, [{ kind: 'txn', payload: { client_op_id: crypto.randomUUID(), item_id: ATS, type: 'scanned_out', unit_id: newUnit, job_note: 'Jones standby' } }]);
  assert.equal(r[0].ok, true);
  r = await sync(TECH, [{ kind: 'txn', payload: { client_op_id: crypto.randomUUID(), item_id: ATS, type: 'scanned_out', unit_id: newUnit } }]);
  assert.equal(r[0].status, 400);
  assert.match(r[0].error, /not in stock/);
  r = await sync(WAREHOUSE, [{ kind: 'txn', payload: { client_op_id: crypto.randomUUID(), item_id: ATS, type: 'scanned_out', qty: 1 } }]);
  assert.equal(r[0].status, 400, 'a serialized item needs the unit');
  assert.equal(item(ATS).qty_on_hand, world.units.rows.filter((u) => u.item_id === ATS && u.status === 'in_stock').length);
  // Coming back from a job: the known serial is received again (no new unit).
  r = await sync(WAREHOUSE, [{ kind: 'unit_create', payload: { id: crypto.randomUUID(), item_id: ATS, serial_number: 'SN-B2', type: 'received', client_op_id: crypto.randomUUID() } }]);
  assert.equal(r[0].ok, true);
  assert.equal(r[0].result.unit_id, newUnit);
  assert.equal(world.units.rows.filter((u) => u.serial_number.toUpperCase() === 'SN-B2').length, 1);
});

test('count session: lines are absolute + resend-safe; add vs replace; posting twice posts once', async () => {
  const S1 = crypto.randomUUID();
  const lines = (qty, mode) => ({ kind: 'session_lines', payload: { session_id: S1, lines: [{ item_id: ITEM, counted_qty: qty, mode }] } });
  let r = await sync(WAREHOUSE, [{ kind: 'session_upsert', payload: { id: S1 } }, lines(5), lines(7), lines(7)]);
  assert.ok(r.every((x) => x.ok));
  assert.equal(world.lines.rows.length, 1);
  assert.equal(world.lines.rows[0].counted_qty, 7, 'last snapshot wins');
  r = await sync(WAREHOUSE, [{ kind: 'session_post', payload: { session_id: S1 } }, { kind: 'session_post', payload: { session_id: S1 } }]);
  assert.equal(r[0].result.posted, 1);
  assert.equal(r[1].result.posted, 0);
  assert.equal(item(ITEM).qty_on_hand, 17, 'added: 10 + 7');
  r = await sync(WAREHOUSE, [lines(1)]);
  assert.equal(r[0].status, 409, 'a posted session takes no more lines');

  const S2 = crypto.randomUUID();
  await sync(WAREHOUSE, [{ kind: 'session_upsert', payload: { id: S2 } }, { kind: 'session_lines', payload: { session_id: S2, lines: [{ item_id: ITEM, counted_qty: 4, mode: 'replace' }] } }, { kind: 'session_post', payload: { session_id: S2 } }]);
  assert.equal(item(ITEM).qty_on_hand, 4, 'replaced the earlier count');
  assert.equal(world.txns.rows.at(-1).txn_type, 'adjustment');
});

test('quick-add with a barcode another item owns -> 409 + existing_item_id, nothing created', async () => {
  const r = await sync(WAREHOUSE, [{ kind: 'item_create', payload: { id: crypto.randomUUID(), description: 'Breaker (dup)', barcode: { code: '0012345678905' }, qty: 2, client_op_id: crypto.randomUUID() } }]);
  assert.equal(r[0].status, 409);
  assert.equal(r[0].existing_item_id, ITEM);
  assert.equal(world.items.rows.length, 2);
  // The UPC-A spelling of the same code collides too.
  const r2 = await sync(WAREHOUSE, [{ kind: 'item_create', payload: { id: crypto.randomUUID(), description: 'Breaker (dup)', barcode: { code: '012345678905', format: 'upc_a' } } }]);
  assert.equal(r2[0].existing_item_id, ITEM);
});

test('surplus: sell reduces it, scan-out trims it to on hand; PATCH refuses surplus above on hand', async () => {
  item(ITEM).qty_on_hand = 24; item(ITEM).surplus_qty = 18;
  await sync(WAREHOUSE, [{ kind: 'txn', payload: { client_op_id: crypto.randomUUID(), item_id: ITEM, type: 'sold', qty: 5 } }]);
  assert.deepEqual([item(ITEM).qty_on_hand, item(ITEM).surplus_qty], [19, 13]);
  await sync(TECH, [{ kind: 'txn', payload: { client_op_id: crypto.randomUUID(), item_id: ITEM, type: 'scanned_out', qty: 10 } }]);
  assert.deepEqual([item(ITEM).qty_on_hand, item(ITEM).surplus_qty], [9, 9]);

  const patch = getRouteHandler(router, 'patch', '/items/:id');
  const res = makeRes();
  await patch({ params: { id: ITEM }, body: { surplus_qty: 12 }, profile: WAREHOUSE }, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /more than the 9 on hand/);
  const ok = makeRes();
  await patch({ params: { id: ITEM }, body: { surplus_qty: 6, surplus_price_cents: 4500 }, profile: WAREHOUSE }, ok);
  assert.equal(ok.statusCode, 200);
  assert.equal(item(ITEM).surplus_qty, 6);
  assert.equal(item(ITEM).qty_on_hand, 9, 'PATCH never touches qty');
});

test('surplus CSV: surplus qty + price, quoted, formula injection defused; route sends a download', async () => {
  const csv = inv.surplusCsv([
    { description: 'Kit, "deluxe"', manufacturer: 'Generac', part_number: '=HYPERLINK("x")', category: 'generator_part', condition: 'open_box', surplus_qty: 18, unit_of_measure: 'each', surplus_price_cents: 4500, location: 'B2', surplus_notes: '' },
  ]);
  const lines = csv.trim().split('\r\n');
  assert.equal(lines[0], '"Description","Manufacturer","Part #","Category","Condition","Surplus qty","Unit","Asking price (each)","Location","Notes"');
  assert.equal(lines[1], '"Kit, ""deluxe""","Generac","\'=HYPERLINK(""x"")","Generator part","New - open box","18","each","45.00","B2",""');

  item(ITEM).surplus_qty = 4;
  const handler = getRouteHandler(router, 'get', '/surplus.csv');
  const headers = {};
  const res = { ...makeRes(), setHeader: (k, v) => { headers[k] = v; }, send: (b) => { res.sent = b; } };
  await handler({ profile: OFFICE, query: {} }, res);
  assert.match(headers['Content-Type'], /text\/csv/);
  assert.match(headers['Content-Disposition'], /attachment; filename="bates-surplus-\d{4}-\d{2}-\d{2}\.csv"/);
  assert.match(res.sent, /30A breaker/);
  assert.doesNotMatch(res.sent, /400A ATS/, 'only items with surplus');
});

test('catalog: techs see unit cost (no hiding), permissions echoed, last count attached', async () => {
  const realSign = inv.signPhotoUrls;
  inv.signPhotoUrls = async () => new Map();
  test.after(() => { inv.signPhotoUrls = realSign; });
  const S = crypto.randomUUID();
  world.txns.rows.push({ id: 't1', item_id: ITEM, session_id: S, created_at: '2026-10-29T15:00:00Z', qty_change: 10, resulting_qty: 10, actor_id: null, txn_type: 'initial_count' });
  const handler = getRouteHandler(router, 'get', '/catalog');
  const res = makeRes();
  await handler({ profile: TECH, query: {}, _memberPermRow: null }, res);
  const breaker = res.body.items.find((i) => i.id === ITEM);
  assert.equal(breaker.unit_cost_cents, 1250);
  assert.deepEqual(res.body.permissions, { view: true, scan_out: true, manage: false });
  assert.equal(breaker.last_count.session_id, S);
  assert.equal(res.body.barcodes.length, 1);
});

// ---------------------------------------------------------------------------
// Undo (sql/040)
const undoOp = (payload) => ({ kind: 'undo', payload: { client_op_id: crypto.randomUUID(), ...payload } });
const rowFor = (opId) => world.txns.rows.find((t) => t.client_op_id === opId);

test('undo: reverses my + In (by the original client_op_id), linked + noted; a second undo returns the first', async () => {
  const op = crypto.randomUUID();
  await sync(WAREHOUSE, [{ kind: 'txn', payload: { client_op_id: op, item_id: ITEM, type: 'received', qty: 3 } }]);
  assert.equal(item(ITEM).qty_on_hand, 13);
  let r = await sync(WAREHOUSE, [undoOp({ original_client_op_id: op })]);
  assert.equal(r[0].ok, true, JSON.stringify(r[0]));
  assert.equal(item(ITEM).qty_on_hand, 10);
  const u = world.txns.rows.at(-1);
  assert.equal(u.txn_type, 'adjustment');
  assert.equal(u.qty_change, -3);
  assert.equal(u.reverses_txn_id, rowFor(op).id);
  assert.equal(u.note, 'undo of received');
  assert.equal(world.txns.rows.length, 2, 'both rows stay in the ledger');
  r = await sync(WAREHOUSE, [undoOp({ txn_id: rowFor(op).id })]);
  assert.equal(r[0].ok, true);
  assert.equal(r[0].result.already, true);
  assert.equal(item(ITEM).qty_on_hand, 10, 'not undone twice');
  r = await sync(WAREHOUSE, [undoOp({ txn_id: u.id })]);
  assert.equal(r[0].status, 400, 'an undo cannot be undone');
});

test('undo rules: own changes only, 15 minutes, most recent still standing; count-session rows excluded; never-synced = 404', async () => {
  const mine = crypto.randomUUID();
  const theirs = crypto.randomUUID();
  await sync(TECH, [{ kind: 'txn', payload: { client_op_id: theirs, item_id: ITEM, type: 'scanned_out', qty: 1 } }]);
  await sync(WAREHOUSE, [{ kind: 'txn', payload: { client_op_id: mine, item_id: ITEM, type: 'received', qty: 2 } }]);
  let r = await sync(WAREHOUSE, [undoOp({ original_client_op_id: theirs })]);
  assert.equal(r[0].status, 403, 'someone else\'s change');
  assert.match(r[0].error, /your own/);

  rowFor(mine).created_at = new Date(Date.now() - 16 * 60000).toISOString();
  r = await sync(WAREHOUSE, [undoOp({ original_client_op_id: mine })]);
  assert.equal(r[0].status, 409);
  assert.match(r[0].error, /15 minutes/);
  rowFor(mine).created_at = new Date(Date.now() - 60000).toISOString();

  const second = crypto.randomUUID();
  await sync(WAREHOUSE, [{ kind: 'txn', payload: { client_op_id: second, item_id: ITEM, type: 'adjustment', set_qty: 20 } }]);
  r = await sync(WAREHOUSE, [undoOp({ original_client_op_id: mine })]);
  assert.equal(r[0].status, 409, 'not my most recent');
  r = await sync(WAREHOUSE, [undoOp({ original_client_op_id: second }), undoOp({ original_client_op_id: mine })]);
  assert.deepEqual(r.map((x) => x.ok), [true, true], 'undo the Count, then the + In before it');
  assert.equal(item(ITEM).qty_on_hand, 9, '10 - 1 (tech) + 2 - 2, Count undone');

  r = await sync(WAREHOUSE, [undoOp({ original_client_op_id: crypto.randomUUID() })]);
  assert.equal(r[0].status, 404);
  world.txns.rows.push({ id: crypto.randomUUID(), item_id: ITEM, txn_type: 'initial_count', qty_change: 5, actor_id: WAREHOUSE.id, session_id: crypto.randomUUID(), created_at: new Date().toISOString(), reverses_txn_id: null });
  r = await sync(WAREHOUSE, [undoOp({ txn_id: world.txns.rows.at(-1).id })]);
  assert.equal(r[0].status, 400, 'count-session rows are not undone here');
});

test('undo: a tech undoes their own scan-out (also a serialized unit -> back in stock) but cannot undo a receive', async () => {
  const out = crypto.randomUUID();
  await sync(TECH, [{ kind: 'txn', payload: { client_op_id: out, item_id: ATS, type: 'scanned_out', unit_id: 'u1000000-0000-4000-8000-000000000001' } }]);
  assert.equal(world.units.rows[0].status, 'out');
  assert.equal(item(ATS).qty_on_hand, 0);
  let r = await sync(TECH, [undoOp({ original_client_op_id: out })]);
  assert.equal(r[0].ok, true, JSON.stringify(r[0]));
  assert.equal(world.units.rows[0].status, 'in_stock', 'the unit is back in stock');
  assert.equal(item(ATS).qty_on_hand, 1);
  assert.equal(world.txns.rows.at(-1).unit_id, 'u1000000-0000-4000-8000-000000000001');

  // A receive made by the tech's account (e.g. promoted later) still needs manage to undo.
  const recv = crypto.randomUUID();
  await sync(WAREHOUSE, [{ kind: 'txn', payload: { client_op_id: recv, item_id: ITEM, type: 'received', qty: 1 } }]);
  rowFor(recv).actor_id = TECH.id;
  r = await sync(TECH, [undoOp({ original_client_op_id: recv })]);
  assert.equal(r[0].status, 403);
});
