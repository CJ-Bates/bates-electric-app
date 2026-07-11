// Minimal chainable mock for the small slice of the Supabase query builder
// this codebase actually uses: .from(table).<select|update|insert|...>(...).
// <eq|neq|in|is|ilike|order|limit>(...) terminating in .single()/.maybeSingle()
// or awaited directly (the builder is a thenable, matching supabase-js).
//
// installMockSupabase swaps lib/supabase.js's shared supabaseAdmin.from with
// a fake for the duration of a test — every file that `require`s supabaseAdmin
// holds the SAME object, so patching this one property redirects them all.
// Call the returned restore() in afterEach so tests don't leak into each other.

const { supabaseAdmin } = require('../../lib/supabase');

const CHAIN_METHODS = ['select', 'update', 'insert', 'upsert', 'delete', 'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'is', 'not', 'ilike', 'or', 'order', 'limit', 'range'];

function makeQueryBuilder(resolve) {
  const chain = [];
  const builder = {};
  for (const method of CHAIN_METHODS) {
    builder[method] = (...args) => { chain.push({ method, args }); return builder; };
  }
  builder.single = () => Promise.resolve(resolve(chain, 'single'));
  builder.maybeSingle = () => Promise.resolve(resolve(chain, 'maybeSingle'));
  builder.then = (onFulfilled, onRejected) => Promise.resolve(resolve(chain, null)).then(onFulfilled, onRejected);
  return builder;
}

// tableResolvers: { [table]: (chain, terminal) => ({ data, error }) }
// chain is the recorded [{method,args}, ...] calls after .from(table) — enough
// to distinguish a lookup .select(...).eq('id', x).single() from a
// .update(patch).eq('id', x) write if a test needs to branch on it.
function installMockSupabase(tableResolvers) {
  const original = supabaseAdmin.from;
  supabaseAdmin.from = (table) => {
    const resolver = tableResolvers[table];
    if (!resolver) throw new Error(`mockSupabase: no resolver configured for table "${table}"`);
    return makeQueryBuilder((chain, terminal) => resolver(chain, terminal));
  };
  return () => { supabaseAdmin.from = original; };
}

module.exports = { installMockSupabase };
