// backend/lib/inventory.js
// Warehouse inventory (sql/039) helpers shared by routes/inventory.js.
//
// The one rule: quantities move ONLY through the inventory_post_txn() /
// inventory_post_count_session() database functions, which lock the item and
// write the ledger row + the new qty in one transaction (a trigger refuses any
// other change to qty_on_hand). postTxn() below is the single JS door to them;
// it maps the functions' errors to HTTP statuses (22023 = a rule said no ->
// 400 with the function's own message; P0002 = not found -> 404).

const { supabaseAdmin } = require('./supabase');

const PHOTOS_BUCKET = 'inventory-photos';
const PHOTO_URL_TTL_SECONDS = 60 * 60 * 8; // a warehouse shift

// Categories are validated here, not in SQL, so adding one needs no migration.
const CATEGORIES = [
  ['ats', 'Transfer switch (ATS)'],
  ['generator_part', 'Generator part'],
  ['filter', 'Filter'],
  ['battery', 'Battery'],
  ['breaker', 'Breaker'],
  ['panel', 'Panel / load center'],
  ['wire', 'Wire / cable'],
  ['fitting', 'Conduit / fittings'],
  ['tool', 'Tool'],
  ['misc', 'Misc'],
];
const CATEGORY_KEYS = new Set(CATEGORIES.map((c) => c[0]));
const CONDITIONS = new Set(['new', 'open_box', 'used']);
const TXN_TYPES = new Set(['initial_count', 'received', 'scanned_out', 'adjustment', 'sold', 'disposed']);
// What Undo covers (+ In, - Out / scan-out, Count) and for how long.
const UNDOABLE_TYPES = new Set(['received', 'scanned_out', 'adjustment']);
const UNDO_WINDOW_MS = 15 * 60 * 1000;

class InventoryError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra || null;
  }
}

function mapRpcError(error) {
  const msg = (error && error.message) || 'Inventory update failed';
  if (error && error.code === '22023') return new InventoryError(400, msg);
  if (error && error.code === 'P0002') return new InventoryError(404, msg);
  // PostgREST can't find the function (schema cache stale after a migration,
  // or the migration missing): say so plainly instead of a bare 500.
  if (error && error.code === 'PGRST202') return new InventoryError(500, 'The inventory database function is missing or out of date (' + msg + ')');
  return new InventoryError(500, msg);
}

// Post one ledger row. Returns the inventory_transactions row (the original
// one when client_op_id was already used - an offline resend).
async function postTxn({ itemId, type, actorId, qtyChange, setQty, unitId, clientOpId, sessionId, jobNote, customerId, note, occurredAt, source, allowNegative, reversesTxnId }) {
  if (!TXN_TYPES.has(type)) throw new InventoryError(400, 'Unknown transaction type.');
  const args = {
    p_item_id: itemId,
    p_type: type,
    p_actor_id: actorId || null,
    p_qty_change: qtyChange == null ? null : Number(qtyChange),
    p_set_qty: setQty == null ? null : Number(setQty),
    p_unit_id: unitId || null,
    p_client_op_id: clientOpId || null,
    p_session_id: sessionId || null,
    p_job_note: jobNote || null,
    p_customer_id: customerId || null,
    p_note: note || null,
    p_occurred_at: occurredAt || null,
    p_source: source || null,
    p_allow_negative: !!allowNegative,
  };
  // An undo (sql/040) reverses one earlier row; the key is sent only then.
  if (reversesTxnId) args.p_reverses_txn_id = reversesTxnId;
  const { data, error } = await supabaseAdmin.rpc('inventory_post_txn', args);
  if (error) throw mapRpcError(error);
  return Array.isArray(data) ? data[0] : data;
}

async function postCountSession({ sessionId, actorId }) {
  const { data, error } = await supabaseAdmin.rpc('inventory_post_count_session', { p_session_id: sessionId, p_actor_id: actorId || null });
  if (error) throw mapRpcError(error);
  return Number(data) || 0;
}

// Signed URLs for a list of storage paths -> Map(path -> url). Never throws:
// a missing photo is a blank thumbnail, not a broken page.
async function signPhotoUrls(paths, ttl = PHOTO_URL_TTL_SECONDS) {
  const out = new Map();
  const list = [...new Set((paths || []).filter(Boolean))];
  if (!list.length) return out;
  try {
    const { data, error } = await supabaseAdmin.storage.from(PHOTOS_BUCKET).createSignedUrls(list, ttl);
    if (error) throw error;
    for (const row of data || []) if (row && row.path && row.signedUrl) out.set(row.path, row.signedUrl);
  } catch (e) {
    console.error('[inventory] photo signing failed:', e && e.message);
  }
  return out;
}

// Photo bytes -> 'image/jpeg' | 'image/png' | 'image/webp', 'heic', or null.
// Checked on the bytes, not the claimed type: the bucket only takes JPEG /
// PNG / WebP, and iPhone photos are HEIC unless the phone re-encodes them.
function sniffImage(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buf.toString('ascii', 4, 8) === 'ftyp' && /^(heic|heix|hevc|mif1|msf1)/.test(buf.toString('ascii', 8, 12))) return 'heic';
  return null;
}
const PHOTO_MAX_BYTES = 5 * 1024 * 1024; // the bucket's own limit (sql/039)

// Store photo bytes in the private bucket with the service role. Wrapped so
// tests can stand in for Storage. Resolves { error } like supabase-js.
async function storagePut(path, buf, contentType) {
  return supabaseAdmin.storage.from(PHOTOS_BUCKET).upload(path, buf, { contentType, upsert: true });
}

// Numbers from the API body: finite, rounded to cents (qty is numeric(12,2)).
function num(v) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return NaN;
  return Math.round(n * 100) / 100;
}
const n2 = (v) => (v == null ? 0 : Number(v));

// CSV cell: quoted, and spreadsheet-formula injection defused (a cell that
// starts with = + - @ is prefixed with ' so Excel shows it as text).
function csvCell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}
function toCsv(rows) {
  return rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

const money = (cents) => (cents == null ? '' : (cents / 100).toFixed(2));
const conditionLabel = (c) => ({ new: 'New', open_box: 'New - open box', used: 'Used' }[c] || c || '');
const categoryLabel = (k) => (CATEGORIES.find((c) => c[0] === k) || [k, k || ''])[1];

// The surplus export rows (CSV + PDF share them).
function surplusRows(items) {
  return items.map((i) => ({
    description: i.description,
    manufacturer: i.manufacturer || '',
    part_number: i.part_number || '',
    category: categoryLabel(i.category),
    condition: conditionLabel(i.condition),
    surplus_qty: n2(i.surplus_qty),
    unit: i.unit_of_measure || 'each',
    price: money(i.surplus_price_cents),
    location: i.location || '',
    notes: i.surplus_notes || '',
  }));
}

function surplusCsv(items) {
  const header = ['Description', 'Manufacturer', 'Part #', 'Category', 'Condition', 'Surplus qty', 'Unit', 'Asking price (each)', 'Location', 'Notes'];
  return toCsv([header].concat(surplusRows(items).map((r) => [
    r.description, r.manufacturer, r.part_number, r.category, r.condition, r.surplus_qty, r.unit, r.price, r.location, r.notes,
  ])));
}

module.exports = {
  PHOTOS_BUCKET, PHOTO_URL_TTL_SECONDS, CATEGORIES, CATEGORY_KEYS, CONDITIONS, TXN_TYPES, UNDOABLE_TYPES, UNDO_WINDOW_MS,
  InventoryError, postTxn, postCountSession, signPhotoUrls, num, n2, csvCell, toCsv, money,
  sniffImage, storagePut, PHOTO_MAX_BYTES,
  conditionLabel, categoryLabel, surplusRows, surplusCsv,
};
