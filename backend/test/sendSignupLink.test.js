// POST /leads/:id/send-signup (Growth Engine WP2) — offline route tests via
// the real shipped handler (test/helpers/routeHandler bypasses the
// requireAuth/requireRole('office') middleware mounted in
// routes/generator-care/index.js). Covers the email path, the copy-only path
// (no email on file), a failed send (link still returned, office not
// blocked), FL branding, and the converted/missing guards.
require('./helpers/env');

const test = require('node:test');
const assert = require('node:assert/strict');

// Patch the mail transport BEFORE the leads router (and therefore lib/emails)
// is first required: emails.js destructures sendViaBrevo at load, so the
// delegator below must already be in place when that happens. node --test
// runs each file in its own process, so this can't leak elsewhere.
const mailer = require('../lib/mailer');
let brevoImpl = async () => ({ sent: true, messageId: 'test-msg' });
let brevoCalls = [];
mailer.sendViaBrevo = async (args) => { brevoCalls.push(args); return brevoImpl(args); };

const { installMockSupabase } = require('./helpers/mockSupabase');
const { getRouteHandler, makeReq, makeRes } = require('./helpers/routeHandler');
const leadsRouter = require('../routes/generator-care/leads');

const LEAD_ID = '123e4567-e89b-12d3-a456-426614174000';
const EXPECTED_URL = `https://generator.bates-electric.com/?lead=${LEAD_ID}`;

const handler = getRouteHandler(leadsRouter, 'post', '/leads/:id/send-signup');

function makeLead(overrides = {}) {
  return {
    id: LEAD_ID,
    source: 'manual',
    status: 'contacted',
    customer_name: 'Jane Doe',
    customer_email: 'jane@example.com',
    customer_phone: '',
    install_state: 'MO',
    ...overrides,
  };
}

// Resolver: first select returns `lead`, the status update returns the
// updated row and records the patch it was asked to write.
function leadResolvers(lead, seen) {
  return {
    generator_leads: (chain) => {
      const update = chain.find((c) => c.method === 'update');
      if (update) {
        seen.update = update.args[0];
        seen.updateEq = chain.find((c) => c.method === 'eq').args;
        return { data: { ...lead, ...update.args[0] }, error: null };
      }
      return { data: lead, error: null };
    },
  };
}

let restoreSupabase;
test.beforeEach(() => { brevoCalls = []; brevoImpl = async () => ({ sent: true, messageId: 'test-msg' }); });
test.afterEach(() => {
  if (restoreSupabase) { restoreSupabase(); restoreSupabase = undefined; }
});

test('email path: sends the branded email, returns the pre-tagged URL, advances to signup_sent', async () => {
  const seen = {};
  restoreSupabase = installMockSupabase(leadResolvers(makeLead(), seen));

  const res = makeRes();
  await handler(makeReq({ params: { id: LEAD_ID } }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.url, EXPECTED_URL);
  assert.equal(res.body.emailed, true);
  assert.equal(res.body.email_error, null);
  assert.equal(res.body.lead.status, 'signup_sent');

  // One real send, to the lead, carrying the pre-tagged link in both bodies.
  assert.equal(brevoCalls.length, 1);
  assert.deepEqual(brevoCalls[0].to, 'jane@example.com');
  assert.match(brevoCalls[0].subject, /Complete your Bates Electric Generator Care signup/);
  assert.ok(brevoCalls[0].html.includes(EXPECTED_URL), 'html body must contain the ?lead= URL');
  assert.ok(brevoCalls[0].text.includes(EXPECTED_URL), 'text body must contain the ?lead= URL');

  // Status write: signup_sent on THIS lead, nothing else touched.
  assert.equal(seen.update.status, 'signup_sent');
  assert.ok(seen.update.updated_at);
  assert.deepEqual(Object.keys(seen.update).sort(), ['status', 'updated_at']);
  assert.deepEqual(seen.updateEq, ['id', LEAD_ID]);
});

test('FL lead: email is S.E. Bates branded (sender name + body company name)', async () => {
  const seen = {};
  restoreSupabase = installMockSupabase(leadResolvers(makeLead({ install_state: 'FL' }), seen));

  const res = makeRes();
  await handler(makeReq({ params: { id: LEAD_ID } }), res);

  assert.equal(res.body.emailed, true);
  assert.equal(brevoCalls[0].senderName, 'S.E. Bates Electric Generator Care');
  assert.match(brevoCalls[0].subject, /S\.E\. Bates Electric/);
});

test('copy-only path: no email on file -> nothing sent, link returned, still advances', async () => {
  const seen = {};
  restoreSupabase = installMockSupabase(leadResolvers(makeLead({ customer_email: null }), seen));

  const res = makeRes();
  await handler(makeReq({ params: { id: LEAD_ID } }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.emailed, false);
  assert.equal(res.body.email_error, null);
  assert.equal(res.body.url, EXPECTED_URL);
  assert.equal(brevoCalls.length, 0, 'must not attempt a send with no recipient');
  assert.equal(seen.update.status, 'signup_sent');
});

test('failed send: office still gets the link + a copy-it-yourself note, lead still advances', async () => {
  brevoImpl = async () => ({ sent: false, reason: 'Brevo 503' });
  const seen = {};
  restoreSupabase = installMockSupabase(leadResolvers(makeLead(), seen));

  const res = makeRes();
  await handler(makeReq({ params: { id: LEAD_ID } }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.emailed, false);
  assert.match(res.body.email_error, /copy the link/);
  assert.equal(res.body.url, EXPECTED_URL);
  assert.equal(seen.update.status, 'signup_sent');
});

test('converted lead -> 400, nothing sent, nothing written', async () => {
  const seen = {};
  restoreSupabase = installMockSupabase(leadResolvers(makeLead({ status: 'converted' }), seen));

  const res = makeRes();
  await handler(makeReq({ params: { id: LEAD_ID } }), res);

  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /already converted/);
  assert.equal(brevoCalls.length, 0);
  assert.equal(seen.update, undefined, 'no status write on a converted lead');
});

test('unknown lead -> 404', async () => {
  restoreSupabase = installMockSupabase({
    generator_leads: () => ({ data: null, error: null }),
  });

  const res = makeRes();
  await handler(makeReq({ params: { id: LEAD_ID } }), res);

  assert.equal(res.statusCode, 404);
  assert.equal(brevoCalls.length, 0);
});
