// PATCH /leads/:id (WP4.2 edit surface) + DELETE /leads/:id — offline route
// tests via the real shipped handlers. The office edits leads as it works the
// phone book: adding an email is what makes a lead emailable, month/contact
// type fix bad import guesses. Edits are enum/format-validated server-side;
// status and converted_subscription_id are NOT editable through the edit
// surface's fields (status has its own validated path, the convert endpoint
// owns the subscription link). Delete is a hard delete of a prospect row.
require('./helpers/env');

const test = require('node:test');
const assert = require('node:assert/strict');

const { installMockSupabase } = require('./helpers/mockSupabase');
const { getRouteHandler, makeReq, makeRes } = require('./helpers/routeHandler');
const leadsRouter = require('../routes/generator-care/leads');

const patchHandler = getRouteHandler(leadsRouter, 'patch', '/leads/:id');
const deleteHandler = getRouteHandler(leadsRouter, 'delete', '/leads/:id');

const LEAD_ID = '123e4567-e89b-12d3-a456-426614174000';

function makeLead(overrides = {}) {
  return {
    id: LEAD_ID,
    source: 'campaign',
    status: 'new',
    customer_name: 'Pat NoMail',
    customer_email: null,
    customer_phone: '(314) 555-0100',
    maintenance_month: 'Aug',
    contact_type: 'Person',
    email_opt_out: false,
    ...overrides,
  };
}

// Resolver: records update/delete writes; updates merge onto the lead, a
// delete returns the row once (then "missing" if the row was deleted).
function leadResolvers(lead, seen) {
  let deleted = false;
  return {
    generator_leads: (chain) => {
      const update = chain.find((c) => c.method === 'update');
      const del = chain.find((c) => c.method === 'delete');
      const eq = chain.find((c) => c.method === 'eq' && c.args[0] === 'id');
      const hit = !deleted && lead && eq && eq.args[1] === lead.id;
      if (update) {
        seen.update = update.args[0];
        if (!hit) return { data: null, error: null };
        Object.assign(lead, update.args[0]);
        return { data: { ...lead }, error: null };
      }
      if (del) {
        seen.deleteEq = eq && eq.args;
        if (!hit) return { data: null, error: null };
        deleted = true;
        return { data: { id: lead.id }, error: null };
      }
      return { data: hit ? { ...lead } : null, error: null };
    },
  };
}

let restoreSupabase;
test.afterEach(() => {
  if (restoreSupabase) { restoreSupabase(); restoreSupabase = undefined; }
});

// ---- PATCH: the WP4.2 edit surface ----

test('adding an email to a no-email lead saves it (trimmed) and returns the lead', async () => {
  const seen = {};
  const lead = makeLead();
  restoreSupabase = installMockSupabase(leadResolvers(lead, seen));

  const res = makeRes();
  await patchHandler(makeReq({ params: { id: LEAD_ID }, body: { customer_email: '  pat@example.com  ' } }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(seen.update.customer_email, 'pat@example.com');
  assert.equal(res.body.lead.customer_email, 'pat@example.com');
});

test('malformed email -> 400, nothing written', async () => {
  const seen = {};
  restoreSupabase = installMockSupabase(leadResolvers(makeLead(), seen));

  for (const bad of ['8015551234', 'pat@nodot', 'pat example.com', '@example.com']) {
    const res = makeRes();
    await patchHandler(makeReq({ params: { id: LEAD_ID }, body: { customer_email: bad } }), res);
    assert.equal(res.statusCode, 400, `expected 400 for email "${bad}"`);
  }
  assert.equal(seen.update, undefined);
});

test('clearing an email (empty/whitespace) stores null, never "None"', async () => {
  const seen = {};
  restoreSupabase = installMockSupabase(leadResolvers(makeLead({ customer_email: 'old@example.com' }), seen));

  const res = makeRes();
  await patchHandler(makeReq({ params: { id: LEAD_ID }, body: { customer_email: '   ' } }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(seen.update.customer_email, null);
});

test('maintenance_month: valid saves, empty clears to null, junk -> 400', async () => {
  const seen = {};
  const lead = makeLead();
  restoreSupabase = installMockSupabase(leadResolvers(lead, seen));

  let res = makeRes();
  await patchHandler(makeReq({ params: { id: LEAD_ID }, body: { maintenance_month: 'Sep' } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(seen.update.maintenance_month, 'Sep');

  res = makeRes();
  await patchHandler(makeReq({ params: { id: LEAD_ID }, body: { maintenance_month: '' } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(seen.update.maintenance_month, null);

  res = makeRes();
  await patchHandler(makeReq({ params: { id: LEAD_ID }, body: { maintenance_month: 'September' } }), res);
  assert.equal(res.statusCode, 400);
});

test('contact_type: valid saves, junk -> 400', async () => {
  const seen = {};
  restoreSupabase = installMockSupabase(leadResolvers(makeLead(), seen));

  let res = makeRes();
  await patchHandler(makeReq({ params: { id: LEAD_ID }, body: { contact_type: 'Business' } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(seen.update.contact_type, 'Business');

  res = makeRes();
  await patchHandler(makeReq({ params: { id: LEAD_ID }, body: { contact_type: 'Robot' } }), res);
  assert.equal(res.statusCode, 400);
});

test('converted_subscription_id is not an editable field — alone it is "Nothing to update"', async () => {
  const seen = {};
  restoreSupabase = installMockSupabase(leadResolvers(makeLead(), seen));

  const res = makeRes();
  await patchHandler(makeReq({ params: { id: LEAD_ID }, body: { converted_subscription_id: 'sub-123' } }), res);

  assert.equal(res.statusCode, 400);
  assert.equal(seen.update, undefined);
});

test('a mixed edit writes only known fields and stamps updated_at', async () => {
  const seen = {};
  restoreSupabase = installMockSupabase(leadResolvers(makeLead(), seen));

  const res = makeRes();
  await patchHandler(makeReq({
    params: { id: LEAD_ID },
    body: {
      customer_name: 'Pat Reached',
      customer_email: 'pat@example.com',
      maintenance_month: 'Oct',
      contact_type: 'Couple',
      converted_subscription_id: 'sub-123', // ignored
      import_batch: 'evil', // ignored
    },
  }), res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(Object.keys(seen.update).sort(),
    ['contact_type', 'customer_email', 'customer_name', 'maintenance_month', 'updated_at']);
});

// ---- DELETE: hard delete of a prospect row ----

test('DELETE removes the lead and returns ok', async () => {
  const seen = {};
  restoreSupabase = installMockSupabase(leadResolvers(makeLead(), seen));

  const res = makeRes();
  await deleteHandler(makeReq({ params: { id: LEAD_ID } }), res);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true });
  assert.deepEqual(seen.deleteEq, ['id', LEAD_ID]);

  // The row is gone: a second delete (or any lookup) is a 404.
  const again = makeRes();
  await deleteHandler(makeReq({ params: { id: LEAD_ID } }), again);
  assert.equal(again.statusCode, 404);
});

test('DELETE of an unknown lead -> 404', async () => {
  const seen = {};
  restoreSupabase = installMockSupabase(leadResolvers(makeLead(), seen));

  const res = makeRes();
  await deleteHandler(makeReq({ params: { id: '00000000-0000-4000-8000-00000000dead' } }), res);
  assert.equal(res.statusCode, 404);
});
