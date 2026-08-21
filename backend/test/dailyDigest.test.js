// Daily digest OVERDUE split — fully offline. Covers the spec's verify matrix:
//   1. a sub whose completion advanced next_visit_due is upcoming, not passed-due
//   2. passed due + passed scheduled visit -> AWAITING COMPLETION, appt shown
//   3. passed due + no visit / only a NULL-dated tentative placeholder ->
//      NEEDS SCHEDULING (the placeholder never "covers" a due date)
//   4. passed due + FUTURE booked visit -> awaiting bucket, "Booked <date>"
//   5. Ted Garrett's Aug 21 state (due yesterday, visit yesterday, status
//      scheduled + NULL placeholder) lands in AWAITING COMPLETION
//   6. quiet day still quiet; a day with ONLY awaiting items still sends a
//      full (non-quiet) digest; subject reflects the split
require('./helpers/env');

const test = require('node:test');
const assert = require('node:assert/strict');

const { installMockSupabase } = require('./helpers/mockSupabase');
const { getRouteHandler, makeReq, makeRes } = require('./helpers/routeHandler');

// Patch the shared mailer BEFORE the router is required — the router
// destructures sendViaBrevo at require time. Stays patched for this whole
// file (every route-level test here wants the capture).
const mailer = require('../lib/mailer');
const sentEmails = [];
mailer.sendViaBrevo = async (args) => { sentEmails.push(args); return { sent: true }; };

const router = require('../routes/generator-care-cron');
const { splitOverdue, buildSubject, buildEmail } = router._test;
const dailyEmail = getRouteHandler(router, 'post', '/daily-email');

let restoreSupabase;
test.afterEach(() => {
  if (restoreSupabase) { restoreSupabase(); restoreSupabase = undefined; }
  sentEmails.length = 0;
});

// ---------------------------------------------------------------------------
// splitOverdue — the classification itself (pinned clock)
// ---------------------------------------------------------------------------
const NOW = new Date('2026-08-21T11:00:00Z'); // 6am CDT Thu Aug 21 — digest hour

function sub(id, due) {
  return {
    id, plan: 'annual', gen_class: 'air_cooled', gen_model: 'G100', gen_serial: 'sn',
    fleet_monitoring: false, next_visit_due: due, last_visit_date: null, status: 'active',
    customer: { name: 'Cust ' + id, phone: '6365550100', email: 'c@example.com', install_address: '1 Main', install_city: 'Arnold', install_state: 'MO', install_zip: '63010' },
  };
}

test('splitOverdue: no visit rows at all -> NEEDS SCHEDULING', () => {
  const s = sub('s1', '2026-08-18');
  const r = splitOverdue({ overdue: [s], visitsBySubId: {}, now: NOW });
  assert.deepEqual(r.needsScheduling, [s]);
  assert.deepEqual(r.awaiting, []);
});

test('splitOverdue: only a NULL-dated tentative placeholder -> NEEDS SCHEDULING', () => {
  const s = sub('s1', '2026-08-18');
  const r = splitOverdue({
    overdue: [s],
    visitsBySubId: { s1: [{ subscription_id: 's1', status: 'tentative', appointment_at: null, arrival_window: null }] },
    now: NOW,
  });
  assert.deepEqual(r.needsScheduling, [s]);
  assert.deepEqual(r.awaiting, []);
});

test('splitOverdue: scheduled visit whose appointment passed -> AWAITING, not futureBooked', () => {
  const s = sub('s1', '2026-08-20');
  const visit = { subscription_id: 's1', status: 'scheduled', appointment_at: '2026-08-20T15:00:00Z', arrival_window: '10-12' };
  const r = splitOverdue({ overdue: [s], visitsBySubId: { s1: [visit] }, now: NOW });
  assert.deepEqual(r.needsScheduling, []);
  assert.equal(r.awaiting.length, 1);
  assert.equal(r.awaiting[0].sub, s);
  assert.equal(r.awaiting[0].visit, visit);
  assert.equal(r.awaiting[0].futureBooked, false);
});

test('splitOverdue: FUTURE booked visit -> awaiting bucket with futureBooked (never "needs scheduling")', () => {
  const s = sub('s1', '2026-08-18');
  const visit = { subscription_id: 's1', status: 'scheduled', appointment_at: '2026-08-31T13:00:00Z', arrival_window: '8-10' };
  const r = splitOverdue({ overdue: [s], visitsBySubId: { s1: [visit] }, now: NOW });
  assert.deepEqual(r.needsScheduling, []);
  assert.equal(r.awaiting[0].futureBooked, true);
});

test('splitOverdue: stale past visit + future rebook -> shows the future one', () => {
  const s = sub('s1', '2026-08-18');
  const past = { subscription_id: 's1', status: 'scheduled', appointment_at: '2026-08-19T15:00:00Z', arrival_window: '10-12' };
  const future = { subscription_id: 's1', status: 'scheduled', appointment_at: '2026-08-31T13:00:00Z', arrival_window: '8-10' };
  const r = splitOverdue({ overdue: [s], visitsBySubId: { s1: [past, future] }, now: NOW });
  assert.equal(r.awaiting[0].visit, future);
  assert.equal(r.awaiting[0].futureBooked, true);
});

// ---------------------------------------------------------------------------
// buildSubject — honest at a glance
// ---------------------------------------------------------------------------
test('buildSubject: real gaps SHOUT, paperwork lag stays lowercase', () => {
  assert.equal(
    buildSubject({ needsSchedulingCount: 2, awaitingCount: 1, upcomingCount: 3 }),
    'Generator Care: 2 NEED SCHEDULING, 1 awaiting completion, 3 due soon');
  assert.equal(
    buildSubject({ needsSchedulingCount: 1, upcomingCount: 0 }),
    'Generator Care: 1 NEEDS SCHEDULING, 0 due soon');
  assert.equal(
    buildSubject({ awaitingCount: 1, upcomingCount: 3 }),
    'Generator Care: 1 awaiting completion, 3 due soon');
});

test('buildSubject: past-due and failed charges keep top billing; nothing urgent keeps the friendly form', () => {
  assert.equal(
    buildSubject({ pastDueCount: 1, failedCount: 2, needsSchedulingCount: 1, awaitingCount: 1, upcomingCount: 4 }),
    'Generator Care: 1 PAST DUE, 2 FAILED CHARGES, 1 NEEDS SCHEDULING, 1 awaiting completion, 4 due soon');
  assert.equal(buildSubject({ upcomingCount: 3 }), 'Generator Care: 3 visits due in the next 14 days');
  assert.equal(buildSubject({ upcomingCount: 1 }), 'Generator Care: 1 visit due in the next 14 days');
});

// ---------------------------------------------------------------------------
// buildEmail — the awaiting row shows the appointment, needs-scheduling stays red
// ---------------------------------------------------------------------------
test('buildEmail: awaiting row shows the passed appointment + "not marked complete"; needs-scheduling row stays OVERDUE', () => {
  const sched = sub('s1', '2026-08-15');
  const wait = sub('s2', '2026-08-20');
  const { html, text } = buildEmail({
    needsScheduling: [sched],
    awaiting: [{ sub: wait, visit: { status: 'scheduled', appointment_at: '2026-08-20T15:00:00Z', arrival_window: '10-12' }, futureBooked: false }],
    upcoming: [], todayStr: '2026-08-21',
  });
  assert.ok(html.includes('Overdue - needs scheduling'), 'red section present');
  assert.ok(html.includes('Awaiting completion'), 'amber section present');
  assert.ok(html.includes('6 days OVERDUE'), 'needs-scheduling row keeps the red day count');
  assert.ok(html.includes('Visit was Thu, Aug 20'), 'awaiting row shows the appointment date');
  assert.ok(html.includes('not marked complete'), html.match(/Visit was[^<]*/));
  assert.ok(text.includes('OVERDUE - NEEDS SCHEDULING (1):'), text);
  assert.ok(text.includes('AWAITING COMPLETION (1):'), text);
  assert.ok(text.includes('visit was Thu, Aug 20'), text);
});

test('buildEmail: future-booked awaiting row reads "Booked", tentative reads "Tentatively booked"', () => {
  const { html } = buildEmail({
    needsScheduling: [],
    awaiting: [
      { sub: sub('s1', '2026-08-18'), visit: { status: 'scheduled', appointment_at: '2026-08-31T13:00:00Z', arrival_window: '8-10' }, futureBooked: true },
      { sub: sub('s2', '2026-08-19'), visit: { status: 'tentative', appointment_at: '2026-08-30T13:00:00Z', arrival_window: '8-10' }, futureBooked: true },
    ],
    upcoming: [], todayStr: '2026-08-21',
  });
  assert.ok(html.includes('Booked Mon, Aug 31'), 'rescheduled row shows the new date');
  assert.ok(html.includes('Tentatively booked Sun, Aug 30'), 'tentative future date is not overstated');
  assert.ok(!html.includes('not marked complete'), 'no paperwork language on future bookings');
});

// ---------------------------------------------------------------------------
// Route-level: the real handler, mocked supabase + mailer. Dates are built
// relative to the machine clock because the handler uses new Date() directly.
// ---------------------------------------------------------------------------
const localMidnight = new Date();
localMidnight.setHours(0, 0, 0, 0);
function dayStr(offsetDays) {
  const d = new Date(localMidnight);
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}
function isoHoursAgo(h) {
  return new Date(Date.now() - h * 3600000).toISOString();
}

function installWorld({ subs = [], visits = [] } = {}) {
  restoreSupabase = installMockSupabase({
    generator_magic_shortlinks: () => ({ data: null, error: null }),
    generator_subscriptions: (chain) => {
      const statusEq = chain.find((c) => c.method === 'eq' && c.args[0] === 'status');
      if (statusEq && statusEq.args[1] === 'past_due') return { data: [], error: null };
      const lte = chain.find((c) => c.method === 'lte');
      let rows = subs.slice();
      if (lte) rows = rows.filter((s) => s.next_visit_due != null && s.next_visit_due <= lte.args[1]);
      return { data: rows, error: null };
    },
    generator_service_visits: (chain) => {
      let rows = visits.slice();
      for (const c of chain) {
        if (c.method === 'in') rows = rows.filter((r) => c.args[1].includes(r[c.args[0]]));
      }
      return { data: rows, error: null };
    },
    generator_pending_addons: () => ({ data: [], error: null }),
    generator_adhoc_charges: () => ({ data: [], error: null }),
  });
}

test('route: Ted Garrett repro — due yesterday, visit yesterday still "scheduled" + NULL placeholder -> AWAITING COMPLETION, digest sends non-quiet', async () => {
  installWorld({
    subs: [sub('ted', dayStr(-1))],
    visits: [
      { subscription_id: 'ted', status: 'scheduled', appointment_at: isoHoursAgo(20), arrival_window: '10-12' },
      { subscription_id: 'ted', status: 'tentative', appointment_at: null, arrival_window: null }, // auto-created placeholder
    ],
  });
  const res = makeRes();
  await dailyEmail(makeReq(), res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.quiet, false, 'awaiting-only day still sends the full digest');
  assert.equal(res.body.needs_scheduling, 0);
  assert.equal(res.body.awaiting_completion, 1);
  assert.equal(res.body.overdue, 1);
  assert.equal(sentEmails.length, 1);
  assert.equal(sentEmails[0].subject, 'Generator Care: 1 awaiting completion, 0 due soon');
  assert.ok(sentEmails[0].html.includes('not marked complete'), 'row carries the paperwork hint');
});

test('route: due date passed with only the NULL placeholder -> NEEDS SCHEDULING, subject shouts', async () => {
  installWorld({
    subs: [sub('gap', dayStr(-3))],
    visits: [{ subscription_id: 'gap', status: 'tentative', appointment_at: null, arrival_window: null }],
  });
  const res = makeRes();
  await dailyEmail(makeReq(), res);
  assert.equal(res.body.needs_scheduling, 1);
  assert.equal(res.body.awaiting_completion, 0);
  assert.equal(sentEmails[0].subject, 'Generator Care: 1 NEEDS SCHEDULING, 0 due soon');
  assert.ok(sentEmails[0].html.includes('OVERDUE'), 'red treatment kept');
});

test('route: completed visit advanced the due date -> sub is upcoming, in neither bucket', async () => {
  installWorld({
    subs: [sub('done', dayStr(5))],
    visits: [
      // the completed visit is filtered out by the tentative/scheduled query;
      // the sub itself is future-due so it can never reach the split.
      { subscription_id: 'done', status: 'completed', appointment_at: isoHoursAgo(30), arrival_window: '10-12' },
      { subscription_id: 'done', status: 'tentative', appointment_at: null, arrival_window: null },
    ],
  });
  const res = makeRes();
  await dailyEmail(makeReq(), res);
  assert.equal(res.body.needs_scheduling, 0);
  assert.equal(res.body.awaiting_completion, 0);
  assert.equal(res.body.overdue, 0);
  assert.equal(res.body.upcoming, 1);
});

test('route: genuinely quiet day still sends the quiet email', async () => {
  installWorld({ subs: [], visits: [] });
  const res = makeRes();
  await dailyEmail(makeReq(), res);
  assert.equal(res.body.quiet, true);
  assert.equal(sentEmails.length, 1);
  assert.equal(sentEmails[0].subject, 'Generator Care: all quiet - nothing due today');
});
