// GET /generator-care/unsubscribe (Growth Engine WP4) — offline tests of the
// PUBLIC no-auth opt-out route. Must flip email_opt_out exactly once
// (idempotent re-clicks preserve the original opt_out_at), and must show the
// same neutral confirmation for unknown/missing tokens as for real ones so
// the URL can't be used to probe which tokens exist.
require('./helpers/env');

const test = require('node:test');
const assert = require('node:assert/strict');

const { installMockSupabase } = require('./helpers/mockSupabase');
const { getRouteHandler, makeReq } = require('./helpers/routeHandler');
const publicRouter = require('../routes/generator-care-public');

const handler = getRouteHandler(publicRouter, 'get', '/unsubscribe');

// This route responds with an HTML page (res.type().send()), which the shared
// makeRes doesn't model — extend it locally.
function makeHtmlRes() {
  const res = { statusCode: 200, body: undefined, contentType: undefined };
  res.status = (code) => { res.statusCode = code; return res; };
  res.type = (t) => { res.contentType = t; return res; };
  res.send = (payload) => { res.body = payload; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  return res;
}

// Stateful store keyed by unsubscribe_token; records update writes.
function makeStore(rows) {
  const store = rows.map((r) => ({ ...r }));
  const updates = [];
  const resolver = (chain) => {
    const update = chain.find((c) => c.method === 'update');
    if (update) {
      const eq = chain.find((c) => c.method === 'eq');
      updates.push(update.args[0]);
      const row = store.find((l) => l[eq.args[0]] === eq.args[1]);
      if (row) Object.assign(row, update.args[0]);
      return { data: row ? { ...row } : null, error: null };
    }
    const eq = chain.find((c) => c.method === 'eq');
    const row = store.find((l) => l[eq.args[0]] === eq.args[1]);
    return { data: row ? { ...row } : null, error: null };
  };
  return { store, updates, resolver };
}

let restoreSupabase;
test.afterEach(() => { if (restoreSupabase) { restoreSupabase(); restoreSupabase = undefined; } });

test('valid token: flips email_opt_out + stamps opt_out_at, shows the confirmation page', async () => {
  const { store, updates, resolver } = makeStore([
    { id: 'L1', unsubscribe_token: 'tok-1', email_opt_out: false, opt_out_at: null },
  ]);
  restoreSupabase = installMockSupabase({ generator_leads: resolver });

  const res = makeHtmlRes();
  await handler(makeReq({ query: { token: 'tok-1' } }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.contentType, 'html');
  assert.match(res.body, /You(&rsquo;|')ve been unsubscribed/);
  assert.equal(store[0].email_opt_out, true);
  assert.ok(store[0].opt_out_at, 'opt_out_at stamped');
  assert.equal(updates.length, 1);
  assert.equal(updates[0].email_opt_out, true);
});

test('idempotent: a second click changes nothing and keeps the original opt_out_at', async () => {
  const { store, updates, resolver } = makeStore([
    { id: 'L1', unsubscribe_token: 'tok-1', email_opt_out: false, opt_out_at: null },
  ]);
  restoreSupabase = installMockSupabase({ generator_leads: resolver });

  await handler(makeReq({ query: { token: 'tok-1' } }), makeHtmlRes());
  const firstOptOutAt = store[0].opt_out_at;

  const res = makeHtmlRes();
  await handler(makeReq({ query: { token: 'tok-1' } }), res);

  assert.equal(res.statusCode, 200);
  assert.match(res.body, /unsubscribed/i);
  assert.equal(updates.length, 1, 'no second write — already opted out');
  assert.equal(store[0].opt_out_at, firstOptOutAt);
});

test('unknown token: same neutral confirmation, nothing written (no existence probe)', async () => {
  const { updates, resolver } = makeStore([
    { id: 'L1', unsubscribe_token: 'tok-1', email_opt_out: false, opt_out_at: null },
  ]);
  restoreSupabase = installMockSupabase({ generator_leads: resolver });

  const res = makeHtmlRes();
  await handler(makeReq({ query: { token: 'tok-nope' } }), res);

  assert.equal(res.statusCode, 200);
  assert.match(res.body, /unsubscribed/i);
  assert.equal(updates.length, 0);
});

test('missing token: neutral confirmation, database never queried', async () => {
  let queried = false;
  restoreSupabase = installMockSupabase({
    generator_leads: () => { queried = true; return { data: null, error: null }; },
  });

  const res = makeHtmlRes();
  await handler(makeReq({ query: {} }), res);

  assert.equal(res.statusCode, 200);
  assert.match(res.body, /unsubscribed/i);
  assert.equal(queried, false);
});
