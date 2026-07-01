// Throwaway script: verify the backend can talk to Supabase + Brevo.
// Run from the backend folder:  node scripts/test-connections.js
// It does NOT send a real email and does NOT write any data.

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

// The env vars production actually reads (see server.js, lib/, routes/).
// Stripe/cron/reporting vars are listed as recommended rather than required so
// this script stays useful in a minimal local setup.
const required = [
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'BREVO_API_KEY',
  'OFFICE_EMAIL',
];
const recommended = [
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'CRON_SECRET',
  'GENERATOR_DIGEST_FROM',
  'GENERATOR_DIGEST_TO',
  'ALERT_EMAIL',
];

let ok = true;
const pass = (msg) => console.log('  PASS  ' + msg);
const warn = (msg) => console.log('  WARN  ' + msg);
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
  for (const key of recommended) {
    if (!process.env[key] || process.env[key].trim() === '') {
      warn(`${key} is not set (needed in production — Stripe/cron/alerts)`);
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

  console.log('\n3. Brevo API key check (no email sent)');
  try {
    // Authenticated read of the account endpoint proves the key is valid
    // without sending anything.
    const resp = await fetch('https://api.brevo.com/v3/account', {
      headers: { 'api-key': process.env.BREVO_API_KEY, accept: 'application/json' },
    });
    if (resp.ok) {
      const acct = await resp.json().catch(() => ({}));
      pass(`Brevo key valid${acct.email ? ` (account: ${acct.email})` : ''}`);
    } else if (resp.status === 401 || resp.status === 403) {
      fail(`Brevo rejected the API key (HTTP ${resp.status})`);
    } else {
      fail(`Brevo account check failed (HTTP ${resp.status})`);
    }
  } catch (e) {
    fail('Brevo check threw: ' + e.message);
  }

  console.log('\n=== Result: ' + (ok ? 'ALL GOOD' : 'SOMETHING FAILED') + ' ===\n');
  process.exit(ok ? 0 : 1);
})();
