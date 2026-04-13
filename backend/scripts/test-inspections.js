// Throwaway: hits POST /inspections, GET /inspections, DELETE row.
// Uses Supabase admin API to mint a one-time access token for the test
// user, so we don't need to know a password.
//
// Run from backend/:  node scripts/test-inspections.js

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const TEST_EMAIL = 'cjbates@bates-electric.com';
const API = `http://localhost:${process.env.PORT || 4000}`;

(async () => {
  const anon = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  console.log('\n=== Inspection endpoints test ===\n');

  // 1. Mint a magic link, exchange it for a real session
  console.log('1. Minting access token for ' + TEST_EMAIL);
  const { data: link, error: linkErr } = await admin.auth.admin.generateLink({
    type: 'magiclink',
    email: TEST_EMAIL,
  });
  if (linkErr) { console.error('  generateLink failed:', linkErr); process.exit(1); }
  const token_hash = link.properties.hashed_token;

  const { data: session, error: sessErr } = await anon.auth.verifyOtp({
    token_hash,
    type: 'magiclink',
  });
  if (sessErr || !session?.session?.access_token) {
    console.error('  verifyOtp failed:', sessErr);
    process.exit(1);
  }
  const accessToken = session.session.access_token;
  console.log('  PASS  got access token');

  const authed = (path, opts = {}) =>
    fetch(API + path, {
      ...opts,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
        ...(opts.headers || {}),
      },
    });

  // 2. Create
  console.log('\n2. POST /inspections');
  const dummy = {
    data: {
      job_date: '2026-04-13',
      job_num: 'TEST-0001',
      job_inv: 'INV-TEST',
      job_tech: 'Automated Test',
      job_cust: 'Test Customer',
      job_addr: '123 Fake Street',
      job_email: 'test@example.com',
      mp_mfr: 'Square D',
      mp_volt: '240',
      mp_amps: '200',
      mp_obs: 'N',
      mp_ul: 'Y',
      mp_cond: 'Good',
    },
    status: 'submitted',
  };
  const createRes = await authed('/inspections', { method: 'POST', body: JSON.stringify(dummy) });
  const createBody = await createRes.json();
  if (!createRes.ok) { console.error('  FAIL', createRes.status, createBody); process.exit(1); }
  const id = createBody.inspection.id;
  console.log('  PASS  created id=' + id);
  console.log('         indexed job_number=' + createBody.inspection.job_number);
  console.log('         indexed customer_name=' + createBody.inspection.customer_name);

  // 3. List
  console.log('\n3. GET /inspections');
  const listRes = await authed('/inspections?limit=5');
  const listBody = await listRes.json();
  if (!listRes.ok) { console.error('  FAIL', listRes.status, listBody); process.exit(1); }
  console.log('  PASS  received ' + listBody.inspections.length + ' rows');

  // 4. Read one
  console.log('\n4. GET /inspections/:id');
  const oneRes = await authed('/inspections/' + id);
  const oneBody = await oneRes.json();
  if (!oneRes.ok) { console.error('  FAIL', oneRes.status, oneBody); process.exit(1); }
  if (oneBody.inspection.data.mp_cond !== 'Good') {
    console.error('  FAIL  data round-trip mismatch'); process.exit(1);
  }
  console.log('  PASS  data blob round-tripped correctly');

  // 5. PATCH
  console.log('\n5. PATCH /inspections/:id');
  const patchRes = await authed('/inspections/' + id, {
    method: 'PATCH',
    body: JSON.stringify({ data: { ...dummy.data, mp_cond: 'Fair' }, status: 'draft' }),
  });
  const patchBody = await patchRes.json();
  if (!patchRes.ok || patchBody.inspection.status !== 'draft') {
    console.error('  FAIL', patchRes.status, patchBody); process.exit(1);
  }
  console.log('  PASS  patched to draft');

  // 6. Clean up — service role bypasses RLS
  console.log('\n6. Cleanup');
  const { error: delErr } = await admin.from('inspections').delete().eq('id', id);
  if (delErr) { console.error('  FAIL', delErr); process.exit(1); }
  console.log('  PASS  test row deleted');

  console.log('\n=== ALL GOOD ===\n');
})();
