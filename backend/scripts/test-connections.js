// Throwaway script: verify the backend can talk to Supabase + Resend.
// Run from the backend folder:  node scripts/test-connections.js
// It does NOT send a real email and does NOT write any data.

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');

const required = [
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'RESEND_API_KEY',
  'OFFICE_EMAIL',
  'EMAIL_FROM',
];

let ok = true;
const pass = (msg) => console.log('  PASS  ' + msg);
const fail = (msg) => { console.log('  FAIL  ' + msg); ok = false; };

(async () => {
  console.log('\n=== Bates Electric — Connection Test ===\n');

  console.log('1. Environment variables');
  for (const key of required) {
    if (!process.env[key] || process.env[key].trim() === '') {
      fail(`${key} is missing or empty`);
    } else {
      pass(`${key} is set`);
    }
  }
  if (!ok) {
    console.log('\nFix the missing variables in backend/.env and rerun.\n');
    process.exit(1);
  }

  console.log('\n2. Supabase — service role key can read schema');
  try {
    const admin = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      { auth: { persistSession: false } }
    );

    // Count rows in each table — should succeed even when empty.
    for (const table of ['profiles', 'inspections', 'inspection_photos']) {
      const { error, count } = await admin
        .from(table)
        .select('*', { count: 'exact', head: true });
      if (error) {
        fail(`Table "${table}" — ${error.message}`);
      } else {
        pass(`Table "${table}" reachable (${count ?? 0} rows)`);
      }
    }

    // Confirm the storage bucket exists
    const { data: buckets, error: bErr } = await admin.storage.listBuckets();
    if (bErr) {
      fail(`Storage listBuckets — ${bErr.message}`);
    } else {
      const found = buckets.find((b) => b.id === 'inspection-photos');
      if (found) pass('Storage bucket "inspection-photos" exists');
      else fail('Storage bucket "inspection-photos" not found');
    }
  } catch (e) {
    fail('Supabase client threw: ' + e.message);
  }

  console.log('\n3. Resend — API key accepted');
  try {
    const resend = new Resend(process.env.RESEND_API_KEY);
    // Listing API keys is a cheap, read-only call that fails fast on a bad key.
    const { data, error } = await resend.apiKeys.list();
    if (error) {
      fail(`Resend — ${error.message || JSON.stringify(error)}`);
    } else {
      pass(`Resend authenticated (${data?.data?.length ?? 0} keys in account)`);
    }
  } catch (e) {
    fail('Resend client threw: ' + e.message);
  }

  console.log('\n=== Result: ' + (ok ? 'ALL GOOD' : 'SOMETHING FAILED') + ' ===\n');
  process.exit(ok ? 0 : 1);
})();
