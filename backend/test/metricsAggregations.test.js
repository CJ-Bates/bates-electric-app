// GET /metrics (Growth Engine WP5) — offline route tests via the real shipped
// handler. WP5 added the leads block (funnel / campaign progress / conversion
// by source / invite velocity / needs-follow-up), the revenue + retention
// views, and the hide_test filter, so cover: funnel stage definitions, source
// conversion incl. divide-by-zero, weekly velocity bucketing, the 21-day
// follow-up threshold, the new-MRR calendar-month boundary, campaign cohort
// ordering, and hide_test exclusion.
require('./helpers/env');

const test = require('node:test');
const assert = require('node:assert/strict');

const { installMockSupabase } = require('./helpers/mockSupabase');
const { getRouteHandler, makeReq, makeRes } = require('./helpers/routeHandler');
const metricsRouter = require('../routes/generator-care/metrics');

const handler = getRouteHandler(metricsRouter, 'get', '/metrics');

// ---- date helpers (UTC, mirroring the route's own math) ----
const todayYmd = () => new Date().toISOString().slice(0, 10);
const monthStart = () => todayYmd().slice(0, 7) + '-01';
const ymdPlusDays = (ymd, n) => {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
const daysAgoIso = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();
const mondayOf = (ymd) => {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - ((dt.getUTCDay() + 6) % 7));
  return dt.toISOString().slice(0, 10);
};

// One resolver set for the whole endpoint. The subscriptions resolver routes
// each of the route's queries by its select() signature; leads come back on
// the first page (tests stay far under the 1000-row page size).
function installMetricsMocks({ active = [], range = [], canceled = [], counts = () => 0, addons = [], leads = [] } = {}) {
  return installMockSupabase({
    generator_subscriptions: (chain) => {
      const sel = chain.find((c) => c.method === 'select');
      const arg = String(sel.args[0]);
      const opts = sel.args[1];
      if (opts && opts.head) return { count: counts(chain), error: null };
      if (arg.includes('plan')) return { data: active, error: null };
      if (arg.includes('signup_source')) return { data: range, error: null };
      if (arg.includes('canceled_at')) return { data: canceled, error: null };
      return { data: null, error: null }; // firstSrc maybeSingle
    },
    generator_pending_addons: () => ({ data: addons, error: null }),
    generator_leads: (chain) => {
      const r = chain.find((c) => c.method === 'range');
      return { data: r.args[0] === 0 ? leads : [], error: null };
    },
  });
}

let restoreSupabase;
test.afterEach(() => { if (restoreSupabase) { restoreSupabase(); restoreSupabase = null; } });

async function run(query = {}) {
  const res = makeRes();
  await handler(makeReq({ query }), res);
  assert.equal(res.statusCode, 200);
  return res.body;
}

test('funnel counts follow the stage definitions and lost is excluded at the query', async () => {
  let sawNeq;
  restoreSupabase = installMockSupabase({
    generator_subscriptions: (chain) => {
      const sel = chain.find((c) => c.method === 'select');
      if (sel.args[1] && sel.args[1].head) return { count: 0, error: null };
      return { data: [], error: null };
    },
    generator_leads: (chain) => {
      sawNeq = chain.find((c) => c.method === 'neq');
      const r = chain.find((c) => c.method === 'range');
      if (r.args[0] !== 0) return { data: [], error: null };
      return {
        data: [
          { id: 'l1', status: 'new', source: 'campaign' },
          { id: 'l2', status: 'new', source: 'campaign' },
          { id: 'l3', status: 'contacted', source: 'field' },
          { id: 'l4', status: 'signup_sent', source: 'campaign', invited_at: daysAgoIso(1) },
          { id: 'l5', status: 'converted', source: 'referral', invited_at: daysAgoIso(3) },
        ],
        error: null,
      };
    },
  });

  const body = await run();
  assert.deepEqual(sawNeq.args, ['status', 'lost']);
  assert.deepEqual(body.leads.funnel, { total: 5, contacted: 3, invited: 2, converted: 1 });
});

test('conversion by source: rate = converted/invited, 0 when nothing invited, fixed order', async () => {
  restoreSupabase = installMetricsMocks({
    leads: [
      // campaign: 4 invited (2 converted) -> 0.5
      { id: 'c1', status: 'converted', source: 'campaign' },
      { id: 'c2', status: 'converted', source: 'campaign' },
      { id: 'c3', status: 'signup_sent', source: 'campaign' },
      { id: 'c4', status: 'signup_sent', source: 'campaign' },
      // field: 1 invited, 0 converted -> 0
      { id: 'f1', status: 'signup_sent', source: 'field' },
      // manual: leads exist but none invited -> divide-by-zero guard -> 0
      { id: 'm1', status: 'new', source: 'manual' },
      { id: 'm2', status: 'contacted', source: 'manual' },
      // referral: no leads at all -> 0s, still present in the list
    ],
  });

  const body = await run();
  assert.deepEqual(body.leads.conversion_by_source, [
    { source: 'campaign', invited: 4, converted: 2, rate: 0.5 },
    { source: 'field', invited: 1, converted: 0, rate: 0 },
    { source: 'referral', invited: 0, converted: 0, rate: 0 },
    { source: 'manual', invited: 0, converted: 0, rate: 0 },
  ]);
});

test('invite velocity: 12 dense Monday-aligned weekly buckets; old invites fall outside', async () => {
  restoreSupabase = installMetricsMocks({
    leads: [
      { id: 'a', status: 'signup_sent', source: 'campaign', invited_at: daysAgoIso(0) },
      { id: 'b', status: 'signup_sent', source: 'campaign', invited_at: daysAgoIso(7) },
      { id: 'c', status: 'signup_sent', source: 'campaign', invited_at: daysAgoIso(200) }, // outside the window
    ],
  });

  const body = await run();
  const vel = body.leads.invite_velocity;
  assert.equal(vel.length, 12);
  for (const b of vel) {
    assert.equal(new Date(b.week_start + 'T00:00:00Z').getUTCDay(), 1, `${b.week_start} is not a Monday`);
  }
  // Buckets are oldest..newest: today lands in the last, 7 days ago in the one before.
  assert.equal(vel[11].week_start, mondayOf(todayYmd()));
  assert.equal(vel[11].count, 1);
  assert.equal(vel[10].count, 1);
  assert.equal(vel.reduce((s, b) => s + b.count, 0), 2);
});

test('needs follow-up: signup_sent older than 21 days counts; fresher or converted does not', async () => {
  restoreSupabase = installMetricsMocks({
    leads: [
      { id: 'a', status: 'signup_sent', source: 'campaign', invited_at: daysAgoIso(22) }, // counts
      { id: 'b', status: 'signup_sent', source: 'campaign', invited_at: daysAgoIso(20) }, // inside the window
      { id: 'c', status: 'converted', source: 'campaign', invited_at: daysAgoIso(40) },   // already closed
      { id: 'd', status: 'signup_sent', source: 'campaign', invited_at: null },           // never stamped
    ],
  });

  const body = await run();
  assert.equal(body.leads.needs_follow_up, 1);
  assert.equal(body.leads.follow_up_days, 21);
});

test('new MRR: only subs signed up inside the current calendar month, at annual/12', async () => {
  const inMonth = monthStart();
  const beforeMonth = ymdPlusDays(monthStart(), -1); // last day of the previous month
  restoreSupabase = installMetricsMocks({
    active: [
      { id: 's1', plan: 'annual', gen_class: 'air_cooled', annual_price_cents: 12000, signup_date: inMonth },
      { id: 's2', plan: 'annual', gen_class: 'air_cooled', annual_price_cents: 24000, signup_date: beforeMonth },
    ],
  });

  const body = await run();
  assert.equal(body.revenue.new_mrr_cents_this_month, 1000); // 12000/12; the boundary sub is out
  assert.equal(body.revenue.mrr_cents, 3000);                // (12000+24000)/12
  assert.equal(body.revenue.arpu_annual_cents, 18000);       // 36000/2
});

test('revenue + retention guards: an empty book divides to zeros, not NaN', async () => {
  restoreSupabase = installMetricsMocks({});
  const body = await run();
  assert.equal(body.revenue.mrr_cents, 0);
  assert.equal(body.revenue.arpu_annual_cents, 0);
  assert.equal(body.retention.retention_pct, 0);
  assert.equal(body.retention.net_new, 0);
});

test('campaign progress: cohorts ordered Jan..Dec, unplaced (null month) last, empty months omitted', async () => {
  restoreSupabase = installMetricsMocks({
    leads: [
      { id: 'a', status: 'new', source: 'campaign', maintenance_month: 'Aug' },
      { id: 'b', status: 'signup_sent', source: 'campaign', maintenance_month: 'Aug', invited_at: daysAgoIso(2) },
      { id: 'c', status: 'converted', source: 'campaign', maintenance_month: 'Jan' },
      { id: 'd', status: 'new', source: 'campaign', maintenance_month: null },
      { id: 'e', status: 'new', source: 'field', maintenance_month: 'Feb' }, // not campaign — ignored
    ],
  });

  const body = await run();
  assert.deepEqual(body.leads.campaign, {
    total: 4,
    invited: 2,
    converted: 1,
    by_month: [
      { month: 'Jan', total: 1, invited: 1, converted: 1 },
      { month: 'Aug', total: 2, invited: 1, converted: 0 },
      { month: null, total: 1, invited: 0, converted: 0 },
    ],
  });
});

test('hide_test=1 drops pre-launch subs from the book, ARR, and churn; off keeps them', async () => {
  const data = {
    active: [
      { id: 't1', plan: 'annual', gen_class: 'air_cooled', annual_price_cents: 99900, signup_date: '2026-06-01' }, // test-era
      { id: 'r1', plan: 'annual', gen_class: 'air_cooled', annual_price_cents: 12000, signup_date: '2026-07-01' },
    ],
    canceled: [
      { signup_date: '2026-06-02', canceled_at: '2026-06-20T00:00:00Z' }, // test-era cancel
    ],
  };

  restoreSupabase = installMetricsMocks(data);
  let body = await run({ hide_test: '1' });
  assert.equal(body.hide_test, true);
  assert.equal(body.headline.active_subscriptions, 1);
  assert.equal(body.headline.arr_cents, 12000);
  assert.equal(body.churn.canceled_total, 0);
  restoreSupabase();

  restoreSupabase = installMetricsMocks(data);
  body = await run({});
  assert.equal(body.hide_test, false);
  assert.equal(body.headline.active_subscriptions, 2);
  assert.equal(body.headline.arr_cents, 111900);
  assert.equal(body.churn.canceled_total, 1);
});
