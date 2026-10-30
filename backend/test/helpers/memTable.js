// In-memory table resolver for installMockSupabase (helpers/mockSupabase.js).
// Interprets the recorded query chain well enough for the inbox code paths:
// select / insert / update / upsert / delete, the filters this codebase uses
// (eq, neq, is, in, not(col,'is',null), gt/gte/lt/lte, a simple `or` of
// `col.eq.value` terms), order, limit, and single/maybeSingle terminals.
// Rows are plain objects; embeds (customer:..., owner:...) are NOT joined —
// put them on the rows you seed when a test needs them.
//
//   const convs = memTable([ {...}, ... ]);
//   installMockSupabase({ generator_sms_conversations: convs.resolver });
//   convs.rows  // live array, inspect after the code ran

const crypto = require('crypto');

// Postgres ILIKE: case-insensitive, % = any run, _ = one char, backslash escapes.
const reEscape = (ch) => ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function ilikeMatch(value, pattern) {
  if (value == null) return false;
  let re = '';
  const p = String(pattern);
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '\\' && i + 1 < p.length) { re += reEscape(p[++i]); continue; }
    if (c === '%') re += '.*';
    else if (c === '_') re += '.';
    else re += reEscape(c);
  }
  return new RegExp('^' + re + '$', 'is').test(String(value));
}

function memTable(initialRows = [], { idColumn = 'id', defaults } = {}) {
  const rows = initialRows.map((r) => ({ ...r }));

  function matches(row, filters) {
    for (const f of filters) {
      const [col, a, b] = f.args;
      switch (f.method) {
        case 'eq': if (row[col] !== a) return false; break;
        case 'neq': if (row[col] === a) return false; break;
        case 'is': if (a === null ? row[col] != null : row[col] !== a) return false; break;
        case 'in': if (!(a || []).includes(row[col])) return false; break;
        case 'gt': if (!(row[col] != null && row[col] > a)) return false; break;
        case 'gte': if (!(row[col] != null && row[col] >= a)) return false; break;
        case 'lt': if (!(row[col] != null && row[col] < a)) return false; break;
        case 'lte': if (!(row[col] != null && row[col] <= a)) return false; break;
        case 'ilike': if (!ilikeMatch(row[col], a)) return false; break;
        case 'not':
          if (a === 'is' && b === null) { if (row[col] == null) return false; break; }
          if (a === 'eq') { if (row[col] === b) return false; break; }
          throw new Error('memTable: unsupported not() form ' + a);
        case 'or': {
          const terms = String(col).split(',').map((t) => t.trim()).filter(Boolean);
          const ok = terms.some((t) => {
            const m = t.match(/^([a-z_]+)\.eq\.(.+)$/i);
            if (!m) throw new Error('memTable: unsupported or() term ' + t);
            return String(row[m[1]]) === m[2];
          });
          if (!ok) return false;
          break;
        }
        default: break;
      }
    }
    return true;
  }

  function resolver(chain, terminal) {
    const op = chain.find((c) => ['select', 'insert', 'update', 'upsert', 'delete'].includes(c.method));
    const filters = chain.filter((c) => ['eq', 'neq', 'is', 'in', 'gt', 'gte', 'lt', 'lte', 'not', 'or', 'ilike'].includes(c.method));
    const order = chain.find((c) => c.method === 'order');
    const limit = chain.find((c) => c.method === 'limit');
    const finish = (list) => {
      let out = list;
      if (order) {
        const [col, opts] = order.args;
        const asc = !opts || opts.ascending !== false;
        out = out.slice().sort((x, y) => {
          const a = x[col]; const b = y[col];
          if (a == null && b == null) return 0;
          if (a == null) return 1;
          if (b == null) return -1;
          return (a < b ? -1 : a > b ? 1 : 0) * (asc ? 1 : -1);
        });
      }
      if (limit) out = out.slice(0, limit.args[0]);
      // Copies, as a real client returns fresh objects: code that snapshots a
      // row and then updates it must not see its snapshot mutate.
      out = out.map((r) => ({ ...r }));
      if (terminal === 'single' || terminal === 'maybeSingle') return { data: out[0] || null, error: null };
      return { data: out, error: null };
    };
    const stamp = (row) => {
      const r = { ...(defaults ? defaults() : {}), ...row };
      if (idColumn && r[idColumn] == null) r[idColumn] = crypto.randomUUID();
      if (r.created_at == null) r.created_at = new Date().toISOString();
      return r;
    };

    if (!op || op.method === 'select') return finish(rows.filter((r) => matches(r, filters)));
    if (op.method === 'insert') {
      const payload = Array.isArray(op.args[0]) ? op.args[0] : [op.args[0]];
      const inserted = payload.map(stamp);
      rows.push(...inserted);
      return finish(inserted);
    }
    if (op.method === 'update') {
      const hit = rows.filter((r) => matches(r, filters));
      for (const r of hit) Object.assign(r, op.args[0]);
      return finish(hit);
    }
    if (op.method === 'upsert') {
      const payload = Array.isArray(op.args[0]) ? op.args[0] : [op.args[0]];
      const conflict = ((op.args[1] && op.args[1].onConflict) || idColumn).split(',').map((s) => s.trim());
      const touched = [];
      for (const p of payload) {
        const existing = rows.find((r) => conflict.every((c) => r[c] === p[c]));
        if (existing) { Object.assign(existing, p); touched.push(existing); } else { const r = stamp(p); rows.push(r); touched.push(r); }
      }
      return finish(touched);
    }
    if (op.method === 'delete') {
      const hit = rows.filter((r) => matches(r, filters));
      for (const r of hit) rows.splice(rows.indexOf(r), 1);
      return finish(hit);
    }
    throw new Error('memTable: unsupported op ' + op.method);
  }

  return { rows, resolver };
}

module.exports = { memTable };
