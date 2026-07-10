// POST /leads/send-invites (Growth Engine WP4, id-list shape from WP4.1) —
// offline route tests via the real shipped handler. The send is driven by an
// explicit lead_ids selection, and the server must re-validate every id
// (email on file, not opted out, still new/contacted) and SKIP failures with
// a reason rather than trusting the client list — a stale selection can never
// re-invite or email an opted-out lead. Also: cap at 100 ids, de-dupe doubled
// ids, persist an unsubscribe token before sending, brand FL leads as
// S.E. Bates, and survive a per-lead send failure without aborting the batch.
// Plus the pure buildEnrollmentInviteEmail greeting/compliance rules.
require('./helpers/env');
// Zero the inter-send throttle so a batch of fixtures doesn't slow the suite.
process.env.GENERATOR_INVITE_THROTTLE_MS = '0';

const test = require('node:test');
const assert = require('node:assert/strict');

// Patch the mail transport BEFORE the leads router (and therefore lib/emails)
// is first required — emails.js destructures sendViaBrevo at load.
const mailer = require('../lib/mailer');
let brevoImpl = async () => ({ sent: true, messageId: 'test-msg' });
let brevoCalls = [];
mailer.sendViaBrevo = async (args) => { brevoCalls.push(args); return brevoImpl(args); };

const { installMockSupabase } = require('./helpers/mockSupabase');
const { getRouteHandler, makeReq, makeRes } = require('./helpers/routeHandler');
const leadsRouter = require('../routes/generator-care/leads');
const { buildEnrollmentInviteEmail, inviteGreeting } = require('../lib/emails');

const handler = getRouteHandler(leadsRouter, 'post', '/leads/send-invites');

// Fixture ids must be real uuid forms: the route shape-checks every id
// against its uuid regex (generator_leads.id is a uuid column) before
// querying, and anything else is skipped as "not found" without ever
// reaching the store.
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const L1 = uid(1); const L2 = uid(2); const L3 = uid(3); const L4 = uid(4);
const L5 = uid(5); const L6 = uid(6); const L7 = uid(7); const L8 = uid(8);
const L9 = uid(9);

// A stateful mini-store whose resolver APPLIES the route's filters (eq/in/not)
// and merges update writes, so eligibility + the never-re-send guarantee are
// tested against real query semantics, not a canned response.
function makeStore(rows) {
  const store = rows.map((r) => ({ email_opt_out: false, unsubscribe_token: null, ...r }));
  const updates = []; // every update write: { patch, id }
  const resolver = (chain) => {
    const update = chain.find((c) => c.method === 'update');
    if (update) {
      const eq = chain.find((c) => c.method === 'eq' && c.args[0] === 'id');
      updates.push({ patch: update.args[0], id: eq && eq.args[1] });
      const row = store.find((l) => l.id === (eq && eq.args[1]));
      if (!row) return { data: null, error: null };
      Object.assign(row, update.args[0]);
      return { data: { ...row }, error: null };
    }
    let out = store;
    for (const c of chain) {
      if (c.method === 'eq') out = out.filter((l) => l[c.args[0]] === c.args[1]);
      else if (c.method === 'in') out = out.filter((l) => c.args[1].includes(l[c.args[0]]));
      else if (c.method === 'not' && c.args[1] === 'is' && c.args[2] === null) {
        out = out.filter((l) => l[c.args[0]] !== null && l[c.args[0]] !== undefined);
      }
    }
    out = [...out].sort((a, b) =>
      String(a.created_at || '').localeCompare(String(b.created_at || ''))
      || String(a.id).localeCompare(String(b.id)));
    return { data: out.map((r) => ({ ...r })), error: null };
  };
  return { store, updates, resolver };
}

// An August cohort with every exclusion reason represented.
function augustFixtures() {
  return [
    { id: L1, status: 'new', maintenance_month: 'Aug', customer_name: 'Mark Osbourne', contact_type: 'Person', customer_email: 'a@example.com', install_state: 'MO', created_at: '2026-01-01T00:00:00Z' },
    { id: L2, status: 'contacted', maintenance_month: 'Aug', customer_name: 'Jim and Lisa Liotta', contact_type: 'Couple', customer_email: 'b@example.com', install_state: 'MO', created_at: '2026-01-02T00:00:00Z' },
    { id: L3, status: 'new', maintenance_month: 'Aug', customer_name: 'No Email', contact_type: 'Person', customer_email: null, install_state: 'MO', created_at: '2026-01-02T01:00:00Z' },
    { id: L4, status: 'new', maintenance_month: 'Aug', customer_name: 'Opted Out', contact_type: 'Person', customer_email: 'c@example.com', email_opt_out: true, install_state: 'MO', created_at: '2026-01-02T02:00:00Z' },
    { id: L5, status: 'signup_sent', maintenance_month: 'Aug', customer_name: 'Already Invited', contact_type: 'Person', customer_email: 'd@example.com', install_state: 'MO', created_at: '2026-01-02T03:00:00Z' },
    { id: L6, status: 'converted', maintenance_month: 'Aug', customer_name: 'Won Already', contact_type: 'Person', customer_email: 'e@example.com', install_state: 'MO', created_at: '2026-01-02T04:00:00Z' },
    { id: L7, status: 'new', maintenance_month: 'Sep', customer_name: 'Wrong Month', contact_type: 'Person', customer_email: 'sep@example.com', install_state: 'MO', created_at: '2026-01-02T05:00:00Z' },
    { id: L8, status: 'new', maintenance_month: 'Aug', customer_name: 'Microfinish', contact_type: 'Business', customer_email: 'f@example.com', install_state: 'MO', created_at: '2026-01-03T00:00:00Z' },
  ];
}

let restoreSupabase;
test.beforeEach(() => { brevoCalls = []; brevoImpl = async () => ({ sent: true, messageId: 'test-msg' }); });
test.afterEach(() => {
  if (restoreSupabase) { restoreSupabase(); restoreSupabase = undefined; }
});

test('sends the listed eligible leads; every ineligible id is skipped with a reason, not sent', async () => {
  const { store, resolver } = makeStore(augustFixtures());
  restoreSupabase = installMockSupabase({ generator_leads: resolver });

  const res = makeRes();
  // A stale/hostile selection: two eligible leads plus every ineligible
  // flavor (no email, opted out, already invited, converted, lost via L9,
  // unknown id). The server must sort them itself.
  store.push({ id: L9, status: 'lost', maintenance_month: 'Aug', customer_name: 'Gone', contact_type: 'Person', customer_email: 'g@example.com', email_opt_out: false, unsubscribe_token: null, created_at: '2026-01-04T00:00:00Z' });
  await handler(makeReq({ body: { lead_ids: [L1, L2, L3, L4, L5, L6, L9, 'NOPE'] } }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.sent, 2);
  assert.equal(res.body.failed, 0);
  assert.deepEqual(res.body.skipped, [
    { id: L3, reason: 'no email' },
    { id: L4, reason: 'opted out' },
    { id: L5, reason: 'already invited' },
    { id: L6, reason: 'already invited' },
    { id: L9, reason: 'marked lost' },
    // skipped echoes the normalized (trimmed, lowercased) id, not the
    // caller's original casing — ids are compared case-insensitively.
    { id: 'nope', reason: 'not found' },
  ]);
  // Only the eligible two got mail, in the order the caller listed them.
  assert.deepEqual(brevoCalls.map((c) => c.to), ['a@example.com', 'b@example.com']);

  // Sent leads advanced + invited_at stamped (WP4.2: it drives the derived
  // "Needs follow-up" flag); skipped ones untouched.
  assert.equal(store.find((l) => l.id === L1).status, 'signup_sent');
  assert.ok(store.find((l) => l.id === L1).invited_at, 'batch send must stamp invited_at');
  assert.equal(store.find((l) => l.id === L2).status, 'signup_sent');
  assert.ok(store.find((l) => l.id === L2).invited_at);
  assert.equal(store.find((l) => l.id === L4).status, 'new');
  assert.equal(store.find((l) => l.id === L4).invited_at, undefined, 'skipped leads never get an invited_at');
  assert.equal(store.find((l) => l.id === L9).status, 'lost');

  // Each send: reply-to Amy's monitored mailbox, the lead's own ?lead= link,
  // and a live unsubscribe link carrying the token that was persisted.
  const l1 = store.find((l) => l.id === L1);
  assert.ok(l1.unsubscribe_token, 'token generated + persisted on first send');
  assert.equal(brevoCalls[0].replyTo, 'generators@bates-electric.com');
  assert.ok(brevoCalls[0].html.includes(`https://generator.bates-electric.com/?lead=${L1}`));
  assert.ok(brevoCalls[0].html.includes(`/generator-care/unsubscribe?token=${l1.unsubscribe_token}`));
  assert.ok(brevoCalls[0].text.includes(`/generator-care/unsubscribe?token=${l1.unsubscribe_token}`));
  // Greetings follow contact_type: Person -> first name, Couple -> the "and" name.
  assert.ok(brevoCalls[0].html.includes('Hi Mark,'));
  assert.ok(brevoCalls[1].html.includes('Hi Jim and Lisa,'));
});

test('re-sending the same selection never re-sends — sent leads come back skipped', async () => {
  const { resolver } = makeStore(augustFixtures());
  restoreSupabase = installMockSupabase({ generator_leads: resolver });

  const first = makeRes();
  await handler(makeReq({ body: { lead_ids: [L1, L2] } }), first);
  const second = makeRes();
  await handler(makeReq({ body: { lead_ids: [L1, L2, L8] } }), second);

  assert.deepEqual(first.body, { sent: 2, skipped: [], failed: 0 });
  // The stale re-send only reaches the one still-eligible lead.
  assert.deepEqual(second.body, {
    sent: 1,
    skipped: [
      { id: L1, reason: 'already invited' },
      { id: L2, reason: 'already invited' },
    ],
    failed: 0,
  });
  // Across both clicks each address got exactly one email.
  assert.deepEqual(brevoCalls.map((c) => c.to), ['a@example.com', 'b@example.com', 'f@example.com']);
  // Business greeting is the neutral "Hello,".
  assert.ok(brevoCalls[2].html.includes('Hello,'));
});

test('a doubled id in the list is de-duped — one email, not two', async () => {
  const { resolver } = makeStore(augustFixtures());
  restoreSupabase = installMockSupabase({ generator_leads: resolver });

  const res = makeRes();
  await handler(makeReq({ body: { lead_ids: [L1, L1, L1] } }), res);

  assert.deepEqual(res.body, { sent: 1, skipped: [], failed: 0 });
  assert.deepEqual(brevoCalls.map((c) => c.to), ['a@example.com']);
});

test('existing unsubscribe token is reused, not regenerated', async () => {
  const rows = augustFixtures();
  rows[0].unsubscribe_token = 'tok-existing';
  const { store, updates, resolver } = makeStore(rows);
  restoreSupabase = installMockSupabase({ generator_leads: resolver });

  const res = makeRes();
  await handler(makeReq({ body: { lead_ids: [L1] } }), res);

  assert.equal(res.body.sent, 1);
  assert.equal(store.find((l) => l.id === L1).unsubscribe_token, 'tok-existing');
  assert.ok(brevoCalls[0].html.includes('unsubscribe?token=tok-existing'));
  // The only write for L1 is the status advance (+ the WP4.2 invited_at
  // stamp) — no token rewrite.
  assert.deepEqual(updates.filter((u) => u.id === L1).map((u) => Object.keys(u.patch).sort()),
    [['invited_at', 'status', 'updated_at']]);
});

test('FL lead -> S.E. Bates branding in sender name and body', async () => {
  const rows = augustFixtures();
  rows[0].install_state = 'FL';
  const { resolver } = makeStore(rows);
  restoreSupabase = installMockSupabase({ generator_leads: resolver });

  const res = makeRes();
  await handler(makeReq({ body: { lead_ids: [L1] } }), res);

  assert.equal(res.body.sent, 1);
  assert.equal(brevoCalls[0].senderName, 'S.E. Bates Electric Generator Care');
  assert.ok(brevoCalls[0].html.includes('S.E. Bates Electric'));
  assert.ok(brevoCalls[0].html.includes('local S.E. Bates techs'), 'FL must not say bare "Bates"');
});

test('a per-send failure is logged, left un-advanced, and never aborts the batch', async () => {
  brevoImpl = async ({ to }) =>
    (to === 'b@example.com' ? { sent: false, reason: 'Brevo 503' } : { sent: true, messageId: 'ok' });
  const { store, resolver } = makeStore(augustFixtures());
  restoreSupabase = installMockSupabase({ generator_leads: resolver });

  const res = makeRes();
  await handler(makeReq({ body: { lead_ids: [L1, L2, L8] } }), res);

  assert.equal(res.statusCode, 200);
  // L1 + L8 sent; L2 failed and stays contacted so a re-send retries it.
  assert.deepEqual(res.body, { sent: 2, skipped: [], failed: 1 });
  assert.equal(store.find((l) => l.id === L2).status, 'contacted');
  assert.equal(store.find((l) => l.id === L1).status, 'signup_sent');
  assert.equal(store.find((l) => l.id === L8).status, 'signup_sent');
});

test('guards: missing/empty/oversized/malformed lead_ids -> 400, nothing sent', async () => {
  const { updates, resolver } = makeStore(augustFixtures());
  restoreSupabase = installMockSupabase({ generator_leads: resolver });

  for (const body of [
    {},
    { lead_ids: [] },
    { lead_ids: L1 },
    { lead_ids: { 0: L1 } },
    { lead_ids: Array.from({ length: 101 }, (_, i) => `L${i}`) },
    { lead_ids: [L1, 42] },
    { lead_ids: [L1, ''] },
    { lead_ids: [L1, null] },
  ]) {
    const res = makeRes();
    await handler(makeReq({ body }), res);
    assert.equal(res.statusCode, 400, `expected 400 for ${JSON.stringify(body)}`);
  }
  assert.equal(brevoCalls.length, 0);
  assert.equal(updates.length, 0);
});

test('exactly 100 ids is allowed — the cap is a limit, not off-by-one', async () => {
  const { resolver } = makeStore(augustFixtures());
  restoreSupabase = installMockSupabase({ generator_leads: resolver });

  // 100 ids: one real eligible lead padded with unknowns. It must process,
  // not 400.
  const ids = [L1, ...Array.from({ length: 99 }, (_, i) => `X${i}`)];
  const res = makeRes();
  await handler(makeReq({ body: { lead_ids: ids } }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.sent, 1);
  assert.equal(res.body.skipped.length, 99);
  assert.ok(res.body.skipped.every((s) => s.reason === 'not found'));
});

// ---- Pure builder: greeting + bulk-email compliance ----

test('inviteGreeting styles: Person first name, Couple "and" name, Business neutral', () => {
  assert.equal(inviteGreeting({ name: 'Mark Osbourne', contactType: 'Person' }), 'Mark');
  assert.equal(inviteGreeting({ name: 'Jim and Lisa Liotta', contactType: 'Couple' }), 'Jim and Lisa');
  assert.equal(inviteGreeting({ name: 'Jo & Don Hall', contactType: 'Couple' }), 'Jo & Don');
  assert.equal(inviteGreeting({ name: 'Mary Ann and Bob Smith', contactType: 'Couple' }), 'Mary Ann and Bob');
  assert.equal(inviteGreeting({ name: 'Microfinish', contactType: 'Business' }), null);
  assert.equal(inviteGreeting({ name: '', contactType: 'Person' }), null);
  assert.equal(inviteGreeting({ name: 'Karen Grieb', contactType: null }), 'Karen');
});

test('invite email carries the required bulk-mail footer: address + unsubscribe', () => {
  const { subject, html, text } = buildEnrollmentInviteEmail({
    name: 'Mark Osbourne',
    contactType: 'Person',
    signupUrl: 'https://generator.bates-electric.com/?lead=L1',
    unsubscribeUrl: 'https://bates-electric-app.onrender.com/generator-care/unsubscribe?token=tok',
    companyState: 'MO',
  });
  assert.equal(subject, 'Your generator, maintained and tracked — without the hassle');
  for (const body of [html, text]) {
    assert.ok(body.includes('PO Box 100, Imperial, MO 63052'), 'physical address is legally required');
    assert.ok(body.includes('unsubscribe?token=tok'), 'unsubscribe link is legally required');
  }
  // The four benefit lead-ins from the approved copy.
  for (const benefit of ['We keep track of everything', 'always in the loop', 'You stay in control', 'Same trusted team']) {
    assert.ok(html.includes(benefit), `missing benefit: ${benefit}`);
  }
  assert.ok(html.includes('$395/year'));
  assert.ok(html.includes('Enroll in Generator Care'));
});
