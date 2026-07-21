// Per-visit service checklist (tech side) — offline route tests via the real
// shipped handlers. Pins: the assignedVisit ownership boundary on the PATCH,
// label validation against planVisitItems(gen_class) (no free text is ever
// stored), catalog-order canonical storage, deploy-skew tolerance (a stale
// label in a full-set save is dropped, not fatal; a stale stored label is
// dropped on read), and the completed-visit read-only snapshot (no writes,
// belt-and-suspenders in both the read guard and the UPDATE's neq filter).
require('./helpers/env');

const test = require('node:test');
const assert = require('node:assert/strict');

const { installMockSupabase } = require('./helpers/mockSupabase');
const { getRouteHandler, makeReq, makeRes } = require('./helpers/routeHandler');
const techRouter = require('../routes/generator-tech');
const { planVisitItems } = require('../lib/generator-catalog');

const TECH_ID = '00000000-0000-4000-8000-000000000042';
const VISIT_ID = 'visit-1';
const SUB_ID = 'sub-1';

const AIR = planVisitItems('air_cooled');

const detailHandler = getRouteHandler(techRouter, 'get', '/my-visits/:id');
const patchHandler = getRouteHandler(techRouter, 'patch', '/my-visits/:id/checklist');

function techReq({ params = {}, body = {} } = {}) {
  const req = makeReq({ params: { id: VISIT_ID, ...params }, body, user: { id: TECH_ID, email: 'chris@bates-electric.com' } });
  req.profile = { full_name: 'Chris Tech' };
  return req;
}

// One resolver for generator_service_visits serving both query shapes the
// checklist code uses: the ownership-scoped SELECT and the guarded UPDATE.
function visitsResolver({ visit, onUpdate } = {}) {
  return (chain) => {
    const update = chain.find((c) => c.method === 'update');
    if (update) {
      if (onUpdate) return onUpdate(update.args[0], chain);
      return { data: { id: VISIT_ID }, error: null };
    }
    return { data: visit || null, error: null };
  };
}

const openVisit = (over = {}) => ({
  id: VISIT_ID, status: 'scheduled', completed_date: null, assigned_tech_id: TECH_ID,
  appointment_at: null, subscription_id: SUB_ID,
  completed_checklist: [],
  subscription: { gen_class: 'air_cooled' },
  ...over,
});

let restore;
test.afterEach(() => { if (restore) { restore(); restore = undefined; } });

// ---- detail: the checklist rides the visit ----

test('visit detail: serves the gen class checklist + normalized ticked set (stale labels dropped, catalog order)', async () => {
  const detailVisit = {
    id: VISIT_ID, status: 'scheduled',
    subscription: { gen_class: 'air_cooled' },
    // Stored out of order + one label no longer on the catalog list.
    completed_checklist: ['Replace spark plugs', 'A removed legacy item', 'Check engine oil level'],
  };
  restore = installMockSupabase({
    generator_service_visits: () => ({ data: detailVisit, error: null }),
  });
  const res = makeRes();
  await detailHandler(techReq(), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.visit.checklist_items, AIR);
  assert.deepEqual(res.body.visit.completed_checklist, ['Check engine oil level', 'Replace spark plugs'],
    'intersected with the current list, in catalog order');
});

test('visit detail: liquid-cooled classes get the liquid checklist', async () => {
  restore = installMockSupabase({
    generator_service_visits: () => ({
      data: { id: VISIT_ID, subscription: { gen_class: 'liquid_48_150' }, completed_checklist: null },
      error: null,
    }),
  });
  const res = makeRes();
  await detailHandler(techReq(), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.visit.checklist_items, planVisitItems('liquid_22_38'));
  assert.deepEqual(res.body.visit.completed_checklist, [], 'a null column reads as nothing ticked');
});

// ---- ownership (the IDOR boundary) ----

test('checklist PATCH: 403 when the visit is not assigned to the caller — nothing written', async () => {
  let wrote = false;
  restore = installMockSupabase({
    generator_service_visits: visitsResolver({ visit: null, onUpdate: () => { wrote = true; return { data: null, error: null }; } }),
  });
  const res = makeRes();
  await patchHandler(techReq({ body: { item: AIR[0], done: true } }), res);
  assert.equal(res.statusCode, 403);
  assert.equal(wrote, false);
});

// ---- toggling ----

test('checklist PATCH { item, done:true }: adds the label; stored set is catalog-ordered', async () => {
  const seen = {};
  restore = installMockSupabase({
    generator_service_visits: visitsResolver({
      visit: openVisit({ completed_checklist: ['Replace spark plugs'] }),
      onUpdate: (patch, chain) => {
        seen.patch = patch;
        seen.neq = chain.find((c) => c.method === 'neq');
        return { data: { id: VISIT_ID }, error: null };
      },
    }),
  });
  const res = makeRes();
  await patchHandler(techReq({ body: { item: 'Check engine oil level', done: true } }), res);
  assert.equal(res.statusCode, 200);
  // Catalog order, not insertion order: oil level comes before spark plugs.
  assert.deepEqual(seen.patch.completed_checklist, ['Check engine oil level', 'Replace spark plugs']);
  assert.deepEqual(res.body.completed_checklist, ['Check engine oil level', 'Replace spark plugs']);
  assert.deepEqual(seen.neq.args, ['status', 'completed'], 'write itself refuses a completed visit');
});

test('checklist PATCH { item, done:false }: removes the label; re-untick is a no-op not an error', async () => {
  const seen = {};
  restore = installMockSupabase({
    generator_service_visits: visitsResolver({
      visit: openVisit({ completed_checklist: ['Check engine oil level', 'Replace spark plugs'] }),
      onUpdate: (patch) => { seen.patch = patch; return { data: { id: VISIT_ID }, error: null }; },
    }),
  });
  let res = makeRes();
  await patchHandler(techReq({ body: { item: 'Replace spark plugs', done: false } }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(seen.patch.completed_checklist, ['Check engine oil level']);
  restore();

  restore = installMockSupabase({
    generator_service_visits: visitsResolver({
      visit: openVisit({ completed_checklist: [] }),
      onUpdate: (patch) => { seen.patch = patch; return { data: { id: VISIT_ID }, error: null }; },
    }),
  });
  res = makeRes();
  await patchHandler(techReq({ body: { item: 'Replace spark plugs', done: false } }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(seen.patch.completed_checklist, []);
});

test('checklist PATCH: a label not on this gen class’s list is a 400, nothing written', async () => {
  let wrote = false;
  restore = installMockSupabase({
    generator_service_visits: visitsResolver({
      visit: openVisit(),
      onUpdate: () => { wrote = true; return { data: null, error: null }; },
    }),
  });
  for (const item of ['Totally made up free text', 'Inspect coolant level and hoses' /* liquid item on an air-cooled visit */]) {
    const res = makeRes();
    await patchHandler(techReq({ body: { item, done: true } }), res);
    assert.equal(res.statusCode, 400);
  }
  assert.equal(wrote, false);

  // Malformed body (neither shape) is also a 400.
  const res = makeRes();
  await patchHandler(techReq({ body: { nonsense: true } }), res);
  assert.equal(res.statusCode, 400);
});

test('checklist PATCH { completed_checklist: [...] }: whole-set save de-dupes and drops unknown labels', async () => {
  const seen = {};
  restore = installMockSupabase({
    generator_service_visits: visitsResolver({
      visit: openVisit(),
      onUpdate: (patch) => { seen.patch = patch; return { data: { id: VISIT_ID }, error: null }; },
    }),
  });
  const res = makeRes();
  await patchHandler(techReq({ body: { completed_checklist: [
    'Replace spark plugs',
    'Replace spark plugs',          // duplicate
    'A label removed from the list', // deploy skew — dropped, not fatal
    42,                              // junk type — dropped
    'Check engine oil level',
  ] } }), res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(seen.patch.completed_checklist, ['Check engine oil level', 'Replace spark plugs']);
  assert.deepEqual(res.body.completed_checklist, ['Check engine oil level', 'Replace spark plugs']);
});

// ---- completed = read-only snapshot ----

test('checklist PATCH on a completed visit: returns the stored snapshot, writes nothing', async () => {
  let wrote = false;
  restore = installMockSupabase({
    generator_service_visits: visitsResolver({
      visit: openVisit({ status: 'completed', completed_date: '2026-07-20', completed_checklist: ['Replace spark plugs'] }),
      onUpdate: () => { wrote = true; return { data: null, error: null }; },
    }),
  });
  const res = makeRes();
  await patchHandler(techReq({ body: { item: 'Check engine oil level', done: true } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.read_only, true);
  assert.deepEqual(res.body.completed_checklist, ['Replace spark plugs']);
  assert.equal(wrote, false);
});

test('checklist PATCH racing a completion: guarded UPDATE matches no row -> read-only response, stored set unchanged', async () => {
  restore = installMockSupabase({
    generator_service_visits: visitsResolver({
      visit: openVisit({ completed_checklist: ['Replace spark plugs'] }),
      // The visit completed between the read and the write: neq('status',
      // 'completed') matches nothing.
      onUpdate: () => ({ data: null, error: null }),
    }),
  });
  const res = makeRes();
  await patchHandler(techReq({ body: { item: 'Check engine oil level', done: true } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.read_only, true);
  assert.deepEqual(res.body.completed_checklist, ['Replace spark plugs'], 'the pre-race snapshot, not the attempted change');
});
