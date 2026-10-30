// backend/routes/inventory.js
// Warehouse inventory API (sql/039), mounted at /api/inventory.
//
// Who: office and tech accounts only (customers get 403 at the door), then
// the three nested member flags (middleware/permissions.js):
//   inventory_view     - catalog, lookup, item pages, surplus list + exports, reports
//   inventory_scan_out - + scan items out (with "for what?"), customer search
//   inventory_manage   - + add items, receive, count, adjust, edit, photos,
//                         surplus qty, sell / dispose, count sessions
// Unit cost and value on hand are shown to everyone with view (office and
// techs alike - CJ, 2026-10-30); customers can't reach this router at all.
//
// Writes from the phone go through POST /sync - one batch endpoint for the
// offline queue AND for live actions, so there is exactly one idempotent
// write path: every op carries a client-generated id (item id, unit id,
// client_op_id, session id) and a resend returns the original result instead
// of counting twice. Edits that only make sense online (item details,
// barcodes, photos) have their own routes.
//
// Quantities only move through lib/inventory.js postTxn()/postCountSession()
// (the database functions); this file never writes qty_on_hand.

const express = require('express');
const crypto = require('crypto');
const PDFDocument = require('pdfkit');
const { supabaseAdmin } = require('../lib/supabase');
const { requireAuth, requireRole } = require('../middleware/auth');
const { requirePermission, getPermissionRow, effectivePermissions } = require('../middleware/permissions');
const { makeGeneralLimiter, makeSensitiveLimiter } = require('../middleware/limiters');
const barcodes = require('../lib/barcodes');
const inv = require('../lib/inventory');

const router = express.Router();
router.use(requireAuth, requireRole('office', 'tech'));
router.use(makeGeneralLimiter());
const sensitiveLimiter = makeSensitiveLimiter();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_SYNC_OPS = 100;
const PAGE = 1000; // PostgREST's row cap per request

const ITEM_COLS = 'id, description, manufacturer, part_number, category, unit_of_measure, unit_cost_cents, location, condition, notes, serialized, qty_on_hand, surplus_qty, surplus_price_cents, surplus_notes, archived_at, last_activity_at, created_at, updated_at';

const str = (v, max) => {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max || 500) : null;
};
const isUuid = (v) => typeof v === 'string' && UUID_RE.test(v);
const nameOf = (p) => (p && (p.full_name || p.email)) || null;

// Fetch every row of a query, PAGE at a time (Supabase caps a response at
// 1000 rows; the catalog will outgrow that).
async function fetchAll(build) {
  const out = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build().range(from, from + PAGE - 1);
    if (error) throw error;
    out.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

async function permsFor(req) {
  if (req._memberPermRow === undefined) req._memberPermRow = await getPermissionRow(req.profile.id);
  return effectivePermissions(req.profile, req._memberPermRow);
}

function send(res, err) {
  if (err instanceof inv.InventoryError) {
    return res.status(err.status).json({ error: err.message, ...(err.extra || {}) });
  }
  if (err && err.code === '23514') return res.status(400).json({ error: 'That value breaks a rule (e.g. surplus can\'t exceed what\'s on hand).' });
  console.error('[inventory] error:', err && err.message);
  return res.status(500).json({ error: 'Server error' });
}

async function profileNames(ids) {
  const list = [...new Set((ids || []).filter(Boolean))];
  const map = new Map();
  if (!list.length) return map;
  const { data } = await supabaseAdmin.from('profiles').select('id, full_name, email').in('id', list);
  for (const p of data || []) map.set(p.id, nameOf(p));
  return map;
}

async function loadItem(id) {
  if (!isUuid(id)) return null;
  const { data, error } = await supabaseAdmin.from('inventory_items').select(ITEM_COLS).eq('id', id).maybeSingle();
  if (error) throw error;
  return data || null;
}

// The latest posted count-session row per item: drives "already counted in
// another session - add to it or replace it?" on the phone.
async function lastCounts(itemIds) {
  const rows = await fetchAll(() => {
    let q = supabaseAdmin.from('inventory_transactions')
      .select('item_id, session_id, created_at, qty_change, resulting_qty, actor_id, txn_type')
      .not('session_id', 'is', null)
      .order('created_at', { ascending: false });
    if (itemIds) q = q.in('item_id', itemIds);
    return q;
  });
  const names = await profileNames(rows.map((r) => r.actor_id));
  const map = new Map();
  for (const r of rows) {
    if (map.has(r.item_id)) continue;
    map.set(r.item_id, { session_id: r.session_id, at: r.created_at, qty: inv.n2(r.resulting_qty), by: names.get(r.actor_id) || null });
  }
  return map;
}

// ============================================================================
// Reads
// ============================================================================

// GET /catalog - everything the phone caches for search + offline lookups.
router.get('/catalog', requirePermission('inventory_view'), async (req, res) => {
  try {
    const [items, codes, units, photos] = await Promise.all([
      fetchAll(() => supabaseAdmin.from('inventory_items').select(ITEM_COLS).is('archived_at', null).order('description', { ascending: true })),
      fetchAll(() => supabaseAdmin.from('inventory_barcodes').select('id, item_id, code, code_norm, format')),
      fetchAll(() => supabaseAdmin.from('inventory_units').select('id, item_id, serial_number, status, condition')),
      fetchAll(() => supabaseAdmin.from('inventory_photos').select('item_id, storage_path, is_primary, created_at').is('unit_id', null)),
    ]);
    const primary = new Map();
    for (const p of photos.slice().sort((a, b) => (b.is_primary - a.is_primary) || String(a.created_at).localeCompare(String(b.created_at)))) {
      if (!primary.has(p.item_id)) primary.set(p.item_id, p.storage_path);
    }
    const [urls, counts] = await Promise.all([inv.signPhotoUrls([...primary.values()]), lastCounts(null)]);
    const perms = await permsFor(req);
    res.json({
      generated_at: new Date().toISOString(),
      categories: inv.CATEGORIES,
      permissions: { view: perms.inventory_view, scan_out: perms.inventory_scan_out, manage: perms.inventory_manage },
      items: items.map((i) => ({
        ...i,
        qty_on_hand: inv.n2(i.qty_on_hand),
        surplus_qty: inv.n2(i.surplus_qty),
        thumb_url: urls.get(primary.get(i.id)) || null,
        last_count: counts.get(i.id) || null,
      })),
      barcodes: codes,
      units,
    });
  } catch (err) { send(res, err); }
});

// GET /lookup?code=&format= - a scanned / typed code -> item (+ unit when the
// code is a serial number). { found:false, code_norm } for an unknown code.
router.get('/lookup', requirePermission('inventory_view'), async (req, res) => {
  try {
    const code = str(req.query.code, 200);
    if (!code) return res.status(400).json({ error: 'code is required' });
    const cands = barcodes.candidates(code, req.query.format);
    const { data: hits, error } = await supabaseAdmin.from('inventory_barcodes').select('item_id, code_norm').in('code_norm', cands).limit(1);
    if (error) throw error;
    if (hits && hits[0]) return res.json({ found: true, item_id: hits[0].item_id, unit_id: null, code_norm: hits[0].code_norm });
    const clean = barcodes.clean(code).replace(/[\\%_]/g, (c) => '\\' + c);
    const { data: unit, error: uErr } = await supabaseAdmin.from('inventory_units').select('id, item_id').ilike('serial_number', clean).limit(1);
    if (uErr) throw uErr;
    if (unit && unit[0]) return res.json({ found: true, item_id: unit[0].item_id, unit_id: unit[0].id, code_norm: barcodes.normalize(code, req.query.format) });
    res.json({ found: false, code_norm: barcodes.normalize(code, req.query.format) });
  } catch (err) { send(res, err); }
});

// GET /items/:id - the item page.
router.get('/items/:id', requirePermission('inventory_view'), async (req, res) => {
  try {
    const item = await loadItem(req.params.id);
    if (!item) return res.status(404).json({ error: 'Item not found' });
    const [codes, units, photos, history, counts] = await Promise.all([
      supabaseAdmin.from('inventory_barcodes').select('id, code, code_norm, format, created_at').eq('item_id', item.id).order('created_at', { ascending: true }),
      supabaseAdmin.from('inventory_units').select('id, serial_number, condition, notes, status, created_at').eq('item_id', item.id).order('serial_number', { ascending: true }),
      supabaseAdmin.from('inventory_photos').select('id, unit_id, storage_path, is_primary, created_at').eq('item_id', item.id).order('created_at', { ascending: true }),
      supabaseAdmin.from('inventory_transactions')
        .select('id, unit_id, txn_type, qty_change, resulting_qty, actor_id, created_at, occurred_at, job_note, customer_id, note, session_id, source, reverses_txn_id')
        .eq('item_id', item.id).order('created_at', { ascending: false }).limit(200),
      lastCounts([item.id]),
    ]);
    for (const r of [codes, units, photos, history]) if (r.error) throw r.error;
    const urls = await inv.signPhotoUrls((photos.data || []).map((p) => p.storage_path));
    const names = await profileNames((history.data || []).map((h) => h.actor_id));
    const custIds = [...new Set((history.data || []).map((h) => h.customer_id).filter(Boolean))];
    const custNames = new Map();
    if (custIds.length) {
      const { data: cs } = await supabaseAdmin.from('generator_customers').select('id, name').in('id', custIds);
      for (const c of cs || []) custNames.set(c.id, c.name);
    }
    const serialById = new Map((units.data || []).map((u) => [u.id, u.serial_number]));
    res.json({
      item: { ...item, qty_on_hand: inv.n2(item.qty_on_hand), surplus_qty: inv.n2(item.surplus_qty), last_count: counts.get(item.id) || null },
      barcodes: codes.data || [],
      units: units.data || [],
      photos: (photos.data || []).map((p) => ({ id: p.id, unit_id: p.unit_id, is_primary: p.is_primary, url: urls.get(p.storage_path) || null, created_at: p.created_at })),
      history: (history.data || []).map((h) => ({
        ...h,
        qty_change: inv.n2(h.qty_change),
        resulting_qty: inv.n2(h.resulting_qty),
        actor: names.get(h.actor_id) || null,
        customer: h.customer_id ? (custNames.get(h.customer_id) || null) : null,
        serial_number: h.unit_id ? (serialById.get(h.unit_id) || null) : null,
      })),
      categories: inv.CATEGORIES,
    });
  } catch (err) { send(res, err); }
});

// GET /customers?q= - Generator Care customer picker for "for what?".
router.get('/customers', requirePermission('inventory_scan_out'), async (req, res) => {
  try {
    const q = str(req.query.q, 80);
    if (!q || q.length < 2) return res.json({ customers: [] });
    const pattern = '%' + q.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
    const { data, error } = await supabaseAdmin.from('generator_customers').select('id, name, install_city').ilike('name', pattern).order('name', { ascending: true }).limit(10);
    if (error) throw error;
    res.json({ customers: data || [] });
  } catch (err) { send(res, err); }
});

// ============================================================================
// Writes: the op handlers (shared by /sync and the direct routes)
// ============================================================================

function need(perms, flag) {
  if (!perms[flag]) throw new inv.InventoryError(403, 'You don\'t have permission for this. Ask an administrator.');
}

// Validate + shape the editable item fields from a body. partial=true for PATCH.
function itemFields(body, { partial }) {
  const out = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
  if (!partial || has('description')) {
    const d = str(body.description, 200);
    if (!d) throw new inv.InventoryError(400, 'A description is required.');
    out.description = d;
  }
  for (const [k, max] of [['manufacturer', 120], ['part_number', 120], ['location', 120], ['notes', 2000], ['surplus_notes', 1000]]) {
    if (has(k)) out[k] = str(body[k], max);
  }
  if (has('unit_of_measure')) out.unit_of_measure = str(body.unit_of_measure, 20) || 'each';
  if (!partial || has('category')) {
    const c = body.category == null || body.category === '' ? 'misc' : String(body.category);
    if (!inv.CATEGORY_KEYS.has(c)) throw new inv.InventoryError(400, 'Unknown category.');
    out.category = c;
  }
  if (!partial || has('condition')) {
    const c = body.condition == null || body.condition === '' ? 'new' : String(body.condition);
    if (!inv.CONDITIONS.has(c)) throw new inv.InventoryError(400, 'Unknown condition.');
    out.condition = c;
  }
  for (const k of ['unit_cost_cents', 'surplus_price_cents']) {
    if (!has(k)) continue;
    if (body[k] === null || body[k] === '') { out[k] = null; continue; }
    const n = Number(body[k]);
    if (!Number.isInteger(n) || n < 0) throw new inv.InventoryError(400, k === 'unit_cost_cents' ? 'Unit cost must be a positive amount.' : 'Asking price must be a positive amount.');
    out[k] = n;
  }
  if (has('surplus_qty')) {
    const n = inv.num(body.surplus_qty);
    if (n == null || Number.isNaN(n) || n < 0) throw new inv.InventoryError(400, 'Surplus quantity must be 0 or more.');
    out.surplus_qty = n;
  }
  return out;
}

// Attach a barcode to an item. Same code on the SAME item = no-op (resend);
// on another item = 409 with that item's id (the phone re-points to it).
async function attachBarcode({ itemId, code, format, actorId }) {
  const raw = str(code, 200);
  const norm = barcodes.normalize(raw, format);
  if (!norm) return null;
  const { data: existing, error } = await supabaseAdmin.from('inventory_barcodes').select('id, item_id').in('code_norm', barcodes.candidates(raw, format)).limit(1);
  if (error) throw error;
  if (existing && existing[0]) {
    if (existing[0].item_id === itemId) return existing[0];
    throw new inv.InventoryError(409, 'That barcode already belongs to another item.', { conflict: 'barcode', existing_item_id: existing[0].item_id });
  }
  const { data, error: insErr } = await supabaseAdmin.from('inventory_barcodes')
    .insert({ item_id: itemId, code: barcodes.clean(raw), code_norm: norm, format: str(format, 30), created_by: actorId })
    .select('id, item_id, code, code_norm, format').single();
  if (insErr) {
    if (insErr.code === '23505') throw new inv.InventoryError(409, 'That barcode already belongs to another item.', { conflict: 'barcode' });
    throw insErr;
  }
  return data;
}

async function ensureSession({ sessionId, actorId, note }) {
  if (!isUuid(sessionId)) throw new inv.InventoryError(400, 'Bad count session id.');
  const { data, error } = await supabaseAdmin.from('inventory_count_sessions').select('id, status').eq('id', sessionId).maybeSingle();
  if (error) throw error;
  if (data) return data;
  const { data: created, error: insErr } = await supabaseAdmin.from('inventory_count_sessions')
    .insert({ id: sessionId, started_by: actorId, note: str(note, 500) }).select('id, status').single();
  if (insErr && insErr.code !== '23505') throw insErr;
  return created || { id: sessionId, status: 'open' };
}

async function upsertLines({ sessionId, lines }) {
  const session = await ensureSession({ sessionId, actorId: null });
  if (session.status !== 'open') throw new inv.InventoryError(409, 'This count session was already ' + session.status + '.');
  const rows = [];
  for (const l of lines || []) {
    const qty = inv.num(l.counted_qty);
    if (!isUuid(l.item_id) || qty == null || Number.isNaN(qty) || qty < 0) throw new inv.InventoryError(400, 'Bad count line.');
    rows.push({ session_id: sessionId, item_id: l.item_id, counted_qty: qty, mode: l.mode === 'replace' ? 'replace' : 'add', updated_at: new Date().toISOString() });
  }
  if (!rows.length) return 0;
  const { error } = await supabaseAdmin.from('inventory_count_lines').upsert(rows, { onConflict: 'session_id,item_id' });
  if (error) throw error;
  return rows.length;
}

const OPS = {
  // { id, description, ..., serialized, barcode:{code,format}, qty, initial_type, client_op_id, session_id }
  async item_create(p, actor, perms) {
    need(perms, 'inventory_manage');
    const fields = itemFields(p, { partial: false });
    const id = p.id == null ? crypto.randomUUID() : p.id;
    if (!isUuid(id)) throw new inv.InventoryError(400, 'Bad item id.');
    const serialized = p.serialized === true;
    const existingItem = await loadItem(id); // a resend of the same create
    // Barcode first: a code that belongs to another item means someone
    // already added this product (maybe on another phone) - don't make a twin.
    if (!existingItem && p.barcode && p.barcode.code) {
      const cands = barcodes.candidates(p.barcode.code, p.barcode.format);
      const { data: hit } = await supabaseAdmin.from('inventory_barcodes').select('item_id').in('code_norm', cands).limit(1);
      if (hit && hit[0]) throw new inv.InventoryError(409, 'That barcode already belongs to another item.', { conflict: 'barcode', existing_item_id: hit[0].item_id });
    }
    if (!existingItem) {
      const { error } = await supabaseAdmin.from('inventory_items')
        .insert({ id, ...fields, unit_of_measure: fields.unit_of_measure || 'each', serialized, created_by: actor, updated_by: actor });
      if (error && error.code !== '23505') throw error;
    }
    if (p.barcode && p.barcode.code) await attachBarcode({ itemId: id, code: p.barcode.code, format: p.barcode.format, actorId: actor });
    const qty = inv.num(p.qty);
    if (!serialized && qty != null && !Number.isNaN(qty) && qty > 0) {
      if (p.session_id) await upsertLines({ sessionId: p.session_id, lines: [{ item_id: id, counted_qty: qty, mode: 'add' }] });
      else {
        await inv.postTxn({
          itemId: id, type: p.initial_type === 'initial_count' ? 'initial_count' : 'received', actorId: actor, qtyChange: qty,
          clientOpId: isUuid(p.client_op_id) ? p.client_op_id : null, occurredAt: p.occurred_at, source: str(p.source, 20),
        });
      }
    }
    return { item: await loadItem(id) };
  },

  // { client_op_id, item_id, type, qty | set_qty, unit_id, job_note, customer_id, note, occurred_at, source, queued_offline }
  async txn(p, actor, perms) {
    need(perms, p.type === 'scanned_out' ? 'inventory_scan_out' : 'inventory_manage');
    if (!isUuid(p.item_id)) throw new inv.InventoryError(400, 'Bad item id.');
    if (p.customer_id != null && p.customer_id !== '' && !isUuid(p.customer_id)) throw new inv.InventoryError(400, 'Bad customer.');
    const OUT = new Set(['scanned_out', 'sold', 'disposed']);
    let qtyChange = null;
    let setQty = null;
    if (p.type === 'adjustment' && p.set_qty != null) {
      setQty = inv.num(p.set_qty);
      if (setQty == null || Number.isNaN(setQty) || setQty < 0) throw new inv.InventoryError(400, 'Count must be 0 or more.');
    } else if (!p.unit_id) {
      const q = inv.num(p.qty);
      if (q == null || Number.isNaN(q) || q === 0 && p.type !== 'adjustment') throw new inv.InventoryError(400, 'Enter a quantity.');
      qtyChange = p.type === 'adjustment' ? q : (OUT.has(p.type) ? -Math.abs(q) : Math.abs(q));
    }
    const row = await inv.postTxn({
      itemId: p.item_id, type: p.type, actorId: actor, qtyChange, setQty, unitId: p.unit_id || null,
      clientOpId: isUuid(p.client_op_id) ? p.client_op_id : null,
      jobNote: str(p.job_note, 200), customerId: p.customer_id || null, note: str(p.note, 1000),
      occurredAt: p.occurred_at || null, source: str(p.source, 20),
      // Only a scan-out that happened OFFLINE may take stock below zero (the
      // part left; the item then shows under Needs recount).
      allowNegative: p.type === 'scanned_out' && p.queued_offline === true,
    });
    return { txn: { ...row, qty_change: inv.n2(row.qty_change), resulting_qty: inv.n2(row.resulting_qty) } };
  },

  // { id, item_id, serial_number, condition, notes, type: received|initial_count, client_op_id, session_id }
  async unit_create(p, actor, perms) {
    need(perms, 'inventory_manage');
    if (!isUuid(p.id) || !isUuid(p.item_id)) throw new inv.InventoryError(400, 'Bad unit.');
    const serial = str(p.serial_number, 120);
    if (!serial) throw new inv.InventoryError(400, 'A serial number is required.');
    const item = await loadItem(p.item_id);
    if (!item) throw new inv.InventoryError(404, 'Item not found');
    if (!item.serialized) throw new inv.InventoryError(400, 'This item is not serial-tracked.');
    const { data: existing, error } = await supabaseAdmin.from('inventory_units').select('id, status').eq('item_id', p.item_id).ilike('serial_number', serial.replace(/[\\%_]/g, (c) => '\\' + c)).limit(1);
    if (error) throw error;
    let unitId = p.id;
    if (existing && existing[0] && existing[0].id !== p.id) {
      // A serial we already know: receiving it back is fine; a second
      // "new unit" with the same serial is not.
      if (existing[0].status === 'in_stock') throw new inv.InventoryError(409, 'Serial ' + serial + ' is already in stock.', { conflict: 'serial', unit_id: existing[0].id });
      unitId = existing[0].id;
    } else if (!existing || !existing[0]) {
      const condition = inv.CONDITIONS.has(p.condition) ? p.condition : item.condition;
      const { error: insErr } = await supabaseAdmin.from('inventory_units')
        .insert({ id: p.id, item_id: p.item_id, serial_number: serial, condition, notes: str(p.notes, 1000), created_by: actor });
      if (insErr && insErr.code !== '23505') throw insErr;
    }
    const row = await inv.postTxn({
      itemId: p.item_id, type: p.type === 'initial_count' ? 'initial_count' : 'received', actorId: actor, unitId,
      clientOpId: isUuid(p.client_op_id) ? p.client_op_id : null, sessionId: p.session_id || null,
      occurredAt: p.occurred_at || null, source: str(p.source, 20),
    });
    return { unit_id: unitId, txn: { ...row, qty_change: inv.n2(row.qty_change), resulting_qty: inv.n2(row.resulting_qty) } };
  },

  async session_upsert(p, actor, perms) {
    need(perms, 'inventory_manage');
    return { session: await ensureSession({ sessionId: p.id, actorId: actor, note: p.note }) };
  },

  // { session_id, lines:[{ item_id, counted_qty, mode }] } - ABSOLUTE counts
  async session_lines(p, actor, perms) {
    need(perms, 'inventory_manage');
    return { lines: await upsertLines({ sessionId: p.session_id, lines: p.lines }) };
  },

  async session_post(p, actor, perms) {
    need(perms, 'inventory_manage');
    await ensureSession({ sessionId: p.session_id, actorId: actor });
    const posted = await inv.postCountSession({ sessionId: p.session_id, actorId: actor });
    return { posted };
  },

  // { client_op_id, txn_id | original_client_op_id } - Undo (sql/040).
  // Posts a reversing 'adjustment' linked to the original. Rules: your own
  // change, your most recent one still standing on that item, within 15
  // minutes, never a count-session row or another undo. A second undo of
  // the same change returns the first (double tap / offline resend).
  async undo(p, actor, perms) {
    let q = supabaseAdmin.from('inventory_transactions').select('id, item_id, unit_id, txn_type, qty_change, actor_id, created_at, session_id, reverses_txn_id');
    if (isUuid(p.txn_id)) q = q.eq('id', p.txn_id);
    else if (isUuid(p.original_client_op_id)) q = q.eq('client_op_id', p.original_client_op_id);
    else throw new inv.InventoryError(400, 'Nothing to undo.');
    const { data: orig, error } = await q.maybeSingle();
    if (error) throw error;
    if (!orig) throw new inv.InventoryError(404, 'Nothing to undo - that change never reached the server.');
    if (!inv.UNDOABLE_TYPES.has(orig.txn_type) || orig.reverses_txn_id || orig.session_id) {
      throw new inv.InventoryError(400, 'This change cannot be undone. Use Count to fix the number.');
    }
    need(perms, orig.txn_type === 'scanned_out' ? 'inventory_scan_out' : 'inventory_manage');
    const { data: prior, error: pErr } = await supabaseAdmin.from('inventory_transactions').select('*').eq('reverses_txn_id', orig.id).maybeSingle();
    if (pErr) throw pErr;
    if (prior) return { txn: { ...prior, qty_change: inv.n2(prior.qty_change), resulting_qty: inv.n2(prior.resulting_qty) }, already: true };
    if (orig.actor_id !== actor) throw new inv.InventoryError(403, 'You can only undo your own changes.');
    if (Date.now() - new Date(orig.created_at).getTime() > inv.UNDO_WINDOW_MS) {
      throw new inv.InventoryError(409, 'Too late to undo (15 minutes). Use Count to fix the number.');
    }
    // Your most recent change still standing: anything later of yours on this
    // item must already be undone.
    const { data: later, error: lErr } = await supabaseAdmin.from('inventory_transactions').select('id')
      .eq('item_id', orig.item_id).eq('actor_id', actor).is('reverses_txn_id', null).gt('created_at', orig.created_at);
    if (lErr) throw lErr;
    if (later && later.length) {
      const { data: undone, error: uErr } = await supabaseAdmin.from('inventory_transactions').select('reverses_txn_id').in('reverses_txn_id', later.map((r) => r.id));
      if (uErr) throw uErr;
      const undoneIds = new Set((undone || []).map((r) => r.reverses_txn_id));
      if (later.some((r) => !undoneIds.has(r.id))) {
        throw new inv.InventoryError(409, 'Only your most recent change on this item can be undone.');
      }
    }
    const label = { received: 'received', scanned_out: 'scanned out', adjustment: 'count' }[orig.txn_type] || orig.txn_type;
    const row = await inv.postTxn({
      itemId: orig.item_id, type: 'adjustment', actorId: actor, reversesTxnId: orig.id,
      clientOpId: isUuid(p.client_op_id) ? p.client_op_id : null,
      note: 'undo of ' + label, source: 'undo',
    });
    return { txn: { ...row, qty_change: inv.n2(row.qty_change), resulting_qty: inv.n2(row.resulting_qty) } };
  },

  async session_discard(p, actor, perms) {
    need(perms, 'inventory_manage');
    const { error } = await supabaseAdmin.from('inventory_count_sessions').update({ status: 'discarded', finished_at: new Date().toISOString() }).eq('id', p.session_id).eq('status', 'open');
    if (error) throw error;
    return { discarded: true };
  },
};

// POST /sync { ops: [{ op_id, kind, payload }] } - applied IN ORDER. Each
// result: { op_id, ok, status, result | error, ...conflict }. A 5xx stops the
// batch (the phone keeps the rest queued and retries); a 4xx is final for
// that op (the phone shows it) and the batch continues.
router.post('/sync', requirePermission('inventory_view'), async (req, res) => {
  const ops = Array.isArray(req.body && req.body.ops) ? req.body.ops : null;
  if (!ops) return res.status(400).json({ error: 'ops[] is required' });
  if (ops.length > MAX_SYNC_OPS) return res.status(400).json({ error: 'At most ' + MAX_SYNC_OPS + ' ops per sync.' });
  let perms;
  try { perms = await permsFor(req); } catch (err) { return send(res, err); }
  const results = [];
  for (const op of ops) {
    const handler = op && OPS[op.kind];
    if (!handler) { results.push({ op_id: op && op.op_id, ok: false, status: 400, error: 'Unknown op.' }); continue; }
    try {
      const result = await handler(op.payload || {}, req.profile.id, perms);
      results.push({ op_id: op.op_id, ok: true, status: 200, result });
    } catch (err) {
      if (err instanceof inv.InventoryError && err.status < 500) {
        // 4xx = final for this op; the phone shows it under "not saved".
        results.push({ op_id: op.op_id, ok: false, status: err.status, error: err.message, ...(err.extra || {}) });
        continue;
      }
      if (err && err.code === '23514') { results.push({ op_id: op.op_id, ok: false, status: 400, error: 'That value breaks a rule.' }); continue; }
      // A reference to an item that doesn't exist (e.g. its create was just
      // refused in this batch): the phone re-points and resends.
      if (err && err.code === '23503') { results.push({ op_id: op.op_id, ok: false, status: 409, error: 'That item is not on the server.' }); continue; }
      // Staff-only API: the real message goes back so the phone's sync chip
      // can show WHY something is waiting (2026-10-30 stuck-sync report).
      const msg = (err && err.message) || 'unknown';
      const p = op.payload || {};
      console.error('[inventory] sync op failed:', op.kind, 'item', p.item_id || p.id || '-', 'op', p.client_op_id || op.op_id, '-', msg);
      results.push({ op_id: op.op_id, ok: false, status: 500, error: 'Server error: ' + msg });
      break;
    }
  }
  res.json({ results });
});

// ============================================================================
// Writes: online-only edits
// ============================================================================

// PATCH /items/:id - details, location, surplus qty / price / notes, archive.
router.patch('/items/:id', requirePermission('inventory_manage'), async (req, res) => {
  try {
    const item = await loadItem(req.params.id);
    if (!item) return res.status(404).json({ error: 'Item not found' });
    const body = req.body || {};
    const patch = itemFields(body, { partial: true });
    if (typeof body.serialized === 'boolean' && body.serialized !== item.serialized) {
      // Switching tracking mode with stock on hand would orphan the count.
      const { count } = await supabaseAdmin.from('inventory_units').select('id', { count: 'exact', head: true }).eq('item_id', item.id);
      if (inv.n2(item.qty_on_hand) !== 0 || count) return res.status(400).json({ error: 'Serial tracking can only change while the item has nothing on hand.' });
      patch.serialized = body.serialized;
    }
    if (patch.surplus_qty != null && patch.surplus_qty > Math.max(inv.n2(item.qty_on_hand), 0)) {
      return res.status(400).json({ error: 'Surplus can\'t be more than the ' + inv.n2(item.qty_on_hand) + ' on hand.' });
    }
    if (typeof body.archived === 'boolean') patch.archived_at = body.archived ? new Date().toISOString() : null;
    if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to change.' });
    patch.updated_by = req.profile.id;
    patch.updated_at = new Date().toISOString();
    const { data, error } = await supabaseAdmin.from('inventory_items').update(patch).eq('id', item.id).select(ITEM_COLS).single();
    if (error) throw error;
    res.json({ item: { ...data, qty_on_hand: inv.n2(data.qty_on_hand), surplus_qty: inv.n2(data.surplus_qty) } });
  } catch (err) { send(res, err); }
});

router.post('/items/:id/barcodes', requirePermission('inventory_manage'), async (req, res) => {
  try {
    const item = await loadItem(req.params.id);
    if (!item) return res.status(404).json({ error: 'Item not found' });
    const code = str((req.body || {}).code, 200);
    if (!code) return res.status(400).json({ error: 'Scan or type a barcode.' });
    const row = await attachBarcode({ itemId: item.id, code, format: req.body.format || 'manual', actorId: req.profile.id });
    res.json({ barcode: row });
  } catch (err) { send(res, err); }
});

router.delete('/items/:id/barcodes/:barcodeId', requirePermission('inventory_manage'), async (req, res) => {
  try {
    if (!isUuid(req.params.id) || !isUuid(req.params.barcodeId)) return res.status(404).json({ error: 'Not found' });
    const { error } = await supabaseAdmin.from('inventory_barcodes').delete().eq('id', req.params.barcodeId).eq('item_id', req.params.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) { send(res, err); }
});

// Photos: the phone asks for a one-time signed upload URL for
// '<item_id>/<photo_id>.jpg', PUTs the (already shrunk) JPEG straight to
// Storage, then confirms here. The bucket has no client policies at all.
router.post('/items/:id/photos/upload-url', requirePermission('inventory_manage'), async (req, res) => {
  try {
    const item = await loadItem(req.params.id);
    if (!item) return res.status(404).json({ error: 'Item not found' });
    const photoId = (req.body || {}).photo_id;
    if (!isUuid(photoId)) return res.status(400).json({ error: 'Bad photo id.' });
    const path = item.id + '/' + photoId + '.jpg';
    const { data, error } = await supabaseAdmin.storage.from(inv.PHOTOS_BUCKET).createSignedUploadUrl(path, { upsert: true });
    if (error) throw error;
    res.json({ path, signed_url: data.signedUrl });
  } catch (err) { send(res, err); }
});

router.post('/items/:id/photos', requirePermission('inventory_manage'), async (req, res) => {
  try {
    const item = await loadItem(req.params.id);
    if (!item) return res.status(404).json({ error: 'Item not found' });
    const { photo_id: photoId, unit_id: unitId } = req.body || {};
    if (!isUuid(photoId)) return res.status(400).json({ error: 'Bad photo id.' });
    if (unitId != null && !isUuid(unitId)) return res.status(400).json({ error: 'Bad unit.' });
    const path = item.id + '/' + photoId + '.jpg';
    // The object must really be there (an upload that never landed).
    const { error: headErr } = await supabaseAdmin.storage.from(inv.PHOTOS_BUCKET).createSignedUrl(path, 60);
    if (headErr) return res.status(400).json({ error: 'The photo upload did not arrive - try again.' });
    // A resend of the same confirm returns the row as it is (never resets primary).
    let { data } = await supabaseAdmin.from('inventory_photos').select('id, unit_id, storage_path, is_primary, created_at').eq('storage_path', path).maybeSingle();
    if (!data) {
      const { data: existing } = await supabaseAdmin.from('inventory_photos').select('id').eq('item_id', item.id).is('unit_id', null).limit(1);
      const ins = await supabaseAdmin.from('inventory_photos')
        .insert({ id: photoId, item_id: item.id, unit_id: unitId || null, storage_path: path, is_primary: !unitId && !(existing && existing.length), uploaded_by: req.profile.id })
        .select('id, unit_id, storage_path, is_primary, created_at').single();
      if (ins.error) throw ins.error;
      data = ins.data;
    }
    const urls = await inv.signPhotoUrls([path]);
    res.json({ photo: { id: data.id, unit_id: data.unit_id, is_primary: data.is_primary, url: urls.get(path) || null, created_at: data.created_at } });
  } catch (err) { send(res, err); }
});

// POST /items/:id/photos/upload { photo_id, unit_id?, data (base64) }
// The phone's photo path since 2026-10-30: the JPEG comes to us and we store
// it with the service role - no signed-URL PUT from the phone (CJ's iPhone
// test left a photo retrying forever and 0 photos ever landed). Bytes are
// checked (JPEG / PNG / WebP only; HEIC refused with a clear message) and a
// storage refusal comes back as a 4xx the phone shows instead of retrying.
// Idempotent on photo_id (a resend returns the same photo).
router.post('/items/:id/photos/upload', requirePermission('inventory_manage'), async (req, res) => {
  try {
    const item = await loadItem(req.params.id);
    if (!item) return res.status(404).json({ error: 'Item not found' });
    const { photo_id: photoId, unit_id: unitId, data } = req.body || {};
    if (!isUuid(photoId)) return res.status(400).json({ error: 'Bad photo id.' });
    if (unitId != null && !isUuid(unitId)) return res.status(400).json({ error: 'Bad unit.' });
    if (typeof data !== 'string' || !data) return res.status(400).json({ error: 'No photo data.' });
    const buf = Buffer.from(data.replace(/^data:[^,]*,/, ''), 'base64');
    if (buf.length > inv.PHOTO_MAX_BYTES) return res.status(413).json({ error: 'Photo is too big (over 5 MB).' });
    const type = inv.sniffImage(buf);
    if (type === 'heic') return res.status(415).json({ error: 'Photo is HEIC - the app should have converted it to JPEG. Take it again.' });
    if (!type) return res.status(415).json({ error: 'That file is not a JPEG, PNG or WebP photo.' });
    const ext = type === 'image/png' ? 'png' : type === 'image/webp' ? 'webp' : 'jpg';
    const path = item.id + '/' + photoId + '.' + ext;
    let { data: row } = await supabaseAdmin.from('inventory_photos').select('id, unit_id, storage_path, is_primary, created_at').eq('storage_path', path).maybeSingle();
    if (!row) {
      const { error: upErr } = await inv.storagePut(path, buf, type);
      if (upErr) {
        const status = Number(upErr.statusCode || upErr.status) || 0;
        console.error('[inventory] photo storage upload failed:', path, status, upErr.message);
        // Storage said no for good (size/type/policy) -> 422, the phone shows it.
        // Anything else (5xx, network) -> 502, the phone retries a few times.
        if (status >= 400 && status < 500) return res.status(422).json({ error: 'Photo storage refused it: ' + upErr.message });
        return res.status(502).json({ error: 'Photo storage error: ' + upErr.message });
      }
      const { data: existing } = await supabaseAdmin.from('inventory_photos').select('id').eq('item_id', item.id).is('unit_id', null).limit(1);
      const ins = await supabaseAdmin.from('inventory_photos')
        .insert({ id: photoId, item_id: item.id, unit_id: unitId || null, storage_path: path, is_primary: !unitId && !(existing && existing.length), uploaded_by: req.profile.id })
        .select('id, unit_id, storage_path, is_primary, created_at').single();
      if (ins.error && ins.error.code !== '23505') throw ins.error;
      row = ins.data || (await supabaseAdmin.from('inventory_photos').select('id, unit_id, storage_path, is_primary, created_at').eq('storage_path', path).maybeSingle()).data;
    }
    const urls = await inv.signPhotoUrls([path]);
    res.json({ photo: { id: row.id, unit_id: row.unit_id, is_primary: row.is_primary, url: urls.get(path) || null, created_at: row.created_at } });
  } catch (err) { send(res, err); }
});

router.post('/items/:id/photos/:photoId/primary', requirePermission('inventory_manage'), async (req, res) => {
  try {
    if (!isUuid(req.params.id) || !isUuid(req.params.photoId)) return res.status(404).json({ error: 'Not found' });
    const { error: e1 } = await supabaseAdmin.from('inventory_photos').update({ is_primary: false }).eq('item_id', req.params.id);
    if (e1) throw e1;
    const { error: e2 } = await supabaseAdmin.from('inventory_photos').update({ is_primary: true }).eq('id', req.params.photoId).eq('item_id', req.params.id);
    if (e2) throw e2;
    res.json({ ok: true });
  } catch (err) { send(res, err); }
});

router.delete('/items/:id/photos/:photoId', requirePermission('inventory_manage'), async (req, res) => {
  try {
    if (!isUuid(req.params.id) || !isUuid(req.params.photoId)) return res.status(404).json({ error: 'Not found' });
    const { data: photo, error } = await supabaseAdmin.from('inventory_photos').select('id, storage_path').eq('id', req.params.photoId).eq('item_id', req.params.id).maybeSingle();
    if (error) throw error;
    if (!photo) return res.status(404).json({ error: 'Photo not found' });
    await supabaseAdmin.storage.from(inv.PHOTOS_BUCKET).remove([photo.storage_path]).catch(() => {});
    const { error: delErr } = await supabaseAdmin.from('inventory_photos').delete().eq('id', photo.id);
    if (delErr) throw delErr;
    res.json({ ok: true });
  } catch (err) { send(res, err); }
});

// ============================================================================
// Surplus + reports
// ============================================================================

async function surplusItems() {
  return fetchAll(() => supabaseAdmin.from('inventory_items').select(ITEM_COLS)
    .is('archived_at', null).gt('surplus_qty', 0).order('category', { ascending: true }).order('description', { ascending: true }));
}
async function primaryPhotoPaths(itemIds) {
  if (!itemIds.length) return new Map();
  const rows = await fetchAll(() => supabaseAdmin.from('inventory_photos').select('item_id, storage_path, is_primary, created_at').in('item_id', itemIds).is('unit_id', null));
  const map = new Map();
  for (const p of rows.sort((a, b) => (b.is_primary - a.is_primary) || String(a.created_at).localeCompare(String(b.created_at)))) {
    if (!map.has(p.item_id)) map.set(p.item_id, p.storage_path);
  }
  return map;
}

router.get('/surplus', requirePermission('inventory_view'), async (req, res) => {
  try {
    const items = await surplusItems();
    const paths = await primaryPhotoPaths(items.map((i) => i.id));
    const urls = await inv.signPhotoUrls([...paths.values()]);
    const list = items.map((i) => ({ ...i, qty_on_hand: inv.n2(i.qty_on_hand), surplus_qty: inv.n2(i.surplus_qty), photo_url: urls.get(paths.get(i.id)) || null }));
    res.json({
      items: list,
      totals: {
        items: list.length,
        pieces: list.reduce((s, i) => s + i.surplus_qty, 0),
        asking_cents: list.reduce((s, i) => s + (i.surplus_price_cents == null ? 0 : i.surplus_price_cents * i.surplus_qty), 0),
      },
    });
  } catch (err) { send(res, err); }
});

router.get('/surplus.csv', requirePermission('inventory_view'), async (req, res) => {
  try {
    const csv = inv.surplusCsv(await surplusItems());
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="bates-surplus-' + new Date().toISOString().slice(0, 10) + '.csv"');
    res.send('﻿' + csv); // BOM so Excel reads UTF-8
  } catch (err) { send(res, err); }
});

// The printable surplus sheet for dealers / a liquidator, with photos.
router.get('/surplus.pdf', sensitiveLimiter, requirePermission('inventory_view'), async (req, res) => {
  try {
    const items = await surplusItems();
    const paths = await primaryPhotoPaths(items.map((i) => i.id));
    const images = new Map();
    for (const [itemId, path] of [...paths.entries()].slice(0, 300)) {
      try {
        const { data, error } = await supabaseAdmin.storage.from(inv.PHOTOS_BUCKET).download(path);
        if (!error && data) images.set(itemId, Buffer.from(await data.arrayBuffer()));
      } catch (e) { /* no photo on the sheet for this one */ }
    }
    const pdf = await buildSurplusPdf(items, images);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="bates-surplus-' + new Date().toISOString().slice(0, 10) + '.pdf"');
    res.send(pdf);
  } catch (err) { send(res, err); }
});

function buildSurplusPdf(items, images) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 40 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    const rows = inv.surplusRows(items);
    const date = new Date().toLocaleDateString('en-US', { timeZone: 'America/Chicago', month: 'long', day: 'numeric', year: 'numeric' });
    doc.font('Helvetica-Bold').fontSize(18).fillColor('#0B2545').text('Bates Electric - Surplus Inventory');
    doc.font('Helvetica').fontSize(10).fillColor('#4A5568').text(date + '  |  ' + rows.length + ' items  |  ' + rows.reduce((s, r) => s + r.surplus_qty, 0) + ' pieces');
    doc.moveDown(0.8);
    const PHOTO = 84;
    rows.forEach((r, idx) => {
      if (doc.y + PHOTO + 16 > doc.page.height - doc.page.margins.bottom) doc.addPage();
      const top = doc.y;
      const left = doc.page.margins.left;
      const img = images.get(items[idx].id);
      if (img) {
        try { doc.image(img, left, top, { fit: [PHOTO, PHOTO], align: 'center', valign: 'center' }); } catch (e) { /* unreadable image */ }
      } else {
        doc.rect(left, top, PHOTO, PHOTO).strokeColor('#D0D5DD').stroke();
        doc.fontSize(8).fillColor('#718096').text('No photo', left, top + PHOTO / 2 - 4, { width: PHOTO, align: 'center' });
      }
      const x = left + PHOTO + 14;
      const w = doc.page.width - doc.page.margins.right - x;
      doc.font('Helvetica-Bold').fontSize(12).fillColor('#1A1A1A').text(r.description, x, top, { width: w });
      const facts = [r.manufacturer, r.part_number && ('Part # ' + r.part_number), r.category, r.condition].filter(Boolean).join('  |  ');
      doc.font('Helvetica').fontSize(9.5).fillColor('#4A5568').text(facts, x, doc.y + 2, { width: w });
      doc.font('Helvetica-Bold').fontSize(10.5).fillColor('#1A1A1A')
        .text('Qty ' + r.surplus_qty + ' ' + r.unit + (r.price ? '   |   $' + r.price + ' each' : '   |   Make an offer'), x, doc.y + 4, { width: w });
      if (r.notes) doc.font('Helvetica').fontSize(9).fillColor('#4A5568').text(r.notes, x, doc.y + 2, { width: w });
      doc.y = Math.max(doc.y, top + PHOTO) + 10;
      doc.moveTo(left, doc.y - 5).lineTo(doc.page.width - doc.page.margins.right, doc.y - 5).strokeColor('#E2E8F0').stroke();
    });
    if (!rows.length) doc.fontSize(11).fillColor('#4A5568').text('Nothing is marked surplus right now.');
    doc.end();
  });
}

// GET /reports - the simple numbers.
router.get('/reports', requirePermission('inventory_view'), async (req, res) => {
  try {
    const items = await fetchAll(() => supabaseAdmin.from('inventory_items').select(ITEM_COLS).is('archived_at', null));
    const yearAgo = Date.now() - 365 * 86400000;
    let pieces = 0; let value = 0; let costed = 0; let surplusPieces = 0;
    for (const i of items) {
      const q = inv.n2(i.qty_on_hand);
      if (q > 0) pieces += q;
      if (i.unit_cost_cents != null && q > 0) { value += i.unit_cost_cents * q; costed++; }
      surplusPieces += inv.n2(i.surplus_qty);
    }
    const touched = (i) => new Date(i.last_activity_at || i.created_at).getTime();
    const stale = items.filter((i) => touched(i) < yearAgo && inv.n2(i.qty_on_hand) > 0).sort((a, b) => touched(a) - touched(b)).slice(0, 100);
    const recount = items.filter((i) => inv.n2(i.qty_on_hand) < 0);
    const { data: outs, error } = await supabaseAdmin.from('inventory_transactions')
      .select('id, item_id, qty_change, actor_id, created_at, job_note, customer_id').eq('txn_type', 'scanned_out').order('created_at', { ascending: false }).limit(25);
    if (error) throw error;
    const names = await profileNames((outs || []).map((o) => o.actor_id));
    const descById = new Map(items.map((i) => [i.id, i.description]));
    const custIds = [...new Set((outs || []).map((o) => o.customer_id).filter(Boolean))];
    const custNames = new Map();
    if (custIds.length) {
      const { data: cs } = await supabaseAdmin.from('generator_customers').select('id, name').in('id', custIds);
      for (const c of cs || []) custNames.set(c.id, c.name);
    }
    const slim = (i) => ({ id: i.id, description: i.description, part_number: i.part_number, qty_on_hand: inv.n2(i.qty_on_hand), location: i.location, last_activity_at: i.last_activity_at || i.created_at });
    res.json({
      totals: { items: items.length, pieces, value_cents: value, items_with_cost: costed, surplus_pieces: surplusPieces },
      recent_out: (outs || []).map((o) => ({
        id: o.id, item_id: o.item_id, description: descById.get(o.item_id) || '(archived item)', qty: Math.abs(inv.n2(o.qty_change)),
        by: names.get(o.actor_id) || null, at: o.created_at, for: o.job_note || custNames.get(o.customer_id) || null,
      })),
      stale: stale.map(slim),
      needs_recount: recount.map(slim),
    });
  } catch (err) { send(res, err); }
});

module.exports = router;
module.exports._test = { OPS, itemFields, fetchAll };
