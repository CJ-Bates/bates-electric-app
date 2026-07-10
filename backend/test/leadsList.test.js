// GET /leads (Growth Engine WP3) — offline route tests via the real shipped
// handler. WP3 rewrote the list to page past PostgREST's 1000-row cap (the
// maintenance-book import makes the pipeline ~1,650 rows) and added the
// ?maintenance_month= cohort filter, so cover: full multi-page assembly,
// month filter validation + pass-through, and the existing status/source
// validation still rejecting junk.
require('./helpers/env');

const test = require('node:test');
const assert = require('node:assert/strict');

const { installMockSupabase } = require('./helpers/mockSupabase');
const { getRouteHandler, makeReq, makeRes } = require('./helpers/routeHandler');
const leadsRouter = require('../routes/generator-care/leads');

const handler = getRouteHandler(leadsRouter, 'get', '/leads');

const makeLeads = (n, offset = 0) =>
  Array.from({ length: n }, (_, i) => ({ id: `lead-${offset + i}`, status: 'new', source: 'campaign' }));

let restoreSupabase;
test.afterEach(() => { if (restoreSupabase) { restoreSupabase(); restoreSupabase = null; } });

test('pages past the 1000-row cap: two full-page fetches assemble one list', async () => {
  const ranges = [];
  restoreSupabase = installMockSupabase({
    generator_leads: (chain) => {
      const range = chain.find((c) => c.method === 'range');
      ranges.push(range.args);
      const [from] = range.args;
      // Page 1 comes back full (1000 rows), page 2 short (653) — short page ends the loop.
      return { data: from === 0 ? makeLeads(1000) : makeLeads(653, 1000), error: null };
    },
  });

  const res = makeRes();
  await handler(makeReq({ query: {} }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.leads.length, 1653);
  assert.deepEqual(ranges, [[0, 999], [1000, 1999]]);
});

test('?maintenance_month=Aug filters server-side via eq', async () => {
  let sawEq;
  restoreSupabase = installMockSupabase({
    generator_leads: (chain) => {
      sawEq = chain.find((c) => c.method === 'eq');
      return { data: makeLeads(3), error: null };
    },
  });

  const res = makeRes();
  await handler(makeReq({ query: { maintenance_month: 'Aug' } }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.leads.length, 3);
  assert.deepEqual(sawEq.args, ['maintenance_month', 'Aug']);
});

test('junk filters are rejected before any query runs', async () => {
  let queried = false;
  restoreSupabase = installMockSupabase({
    generator_leads: () => { queried = true; return { data: [], error: null }; },
  });

  for (const query of [
    { maintenance_month: 'August' }, // must be the 3-letter form
    { maintenance_month: 'aug' },    // case matters — it's a stored value, not a search
    { status: 'bogus' },
    { source: 'bogus' },
  ]) {
    const res = makeRes();
    await handler(makeReq({ query }), res);
    assert.equal(res.statusCode, 400, JSON.stringify(query));
  }
  assert.equal(queried, false);
});
