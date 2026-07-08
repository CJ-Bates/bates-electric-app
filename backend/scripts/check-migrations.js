// Read-only drift check: compares backend/sql/*.sql files on disk against the
// public.schema_migrations ledger (see sql/020_schema_migrations.sql).
// Never inserts or applies anything — the human runs each migration by hand
// and records it (see backend/sql/README.md).
//
// Run from the backend folder:  node scripts/check-migrations.js
// Exits non-zero if any file on disk isn't recorded as applied.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const SQL_DIR = path.join(__dirname, '..', 'sql');

// Files intentionally written but not yet applied live (a deliberate,
// tracked decision — not drift). Remove an entry here the same time you
// apply it and record it in schema_migrations.
const KNOWN_DEFERRED = new Set([
  '019_visit_photo_path_binding.sql', // WP4/H3 belt-and-suspenders hardening — deferred
]);

(async () => {
  console.log('\n=== Bates Electric — Migration Drift Check ===\n');

  const onDisk = fs
    .readdirSync(SQL_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort();

  const admin = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
    { auth: { persistSession: false } }
  );

  const { data, error } = await admin
    .from('schema_migrations')
    .select('id')
    .order('id');

  if (error) {
    console.log('FAIL  could not read public.schema_migrations — ' + error.message);
    process.exitCode = 1;
    return;
  }

  const applied = new Set((data || []).map((row) => row.id));
  const onDiskSet = new Set(onDisk);

  const notApplied = onDisk.filter((name) => !applied.has(name));
  const deferred = notApplied.filter((name) => KNOWN_DEFERRED.has(name));
  const missing = notApplied.filter((name) => !KNOWN_DEFERRED.has(name));
  const noMatchingFile = [...applied].filter((id) => !onDiskSet.has(id)).sort();

  console.log(`Files on disk: ${onDisk.length}`);
  console.log(`Recorded as applied: ${applied.size}\n`);

  console.log('Files on disk NOT recorded as applied (danger — may be missing from the live DB):');
  if (missing.length === 0) {
    console.log('  none');
  } else {
    for (const name of missing) console.log('  ' + name);
  }

  if (deferred.length > 0) {
    console.log('\nKnown-deferred (written, intentionally not yet applied — not a failure):');
    for (const name of deferred) console.log('  ' + name);
  }

  console.log('\nRecorded ids with no matching file on disk:');
  if (noMatchingFile.length === 0) {
    console.log('  none');
  } else {
    for (const id of noMatchingFile) console.log('  ' + id);
  }

  console.log('\n=== Result: ' + (missing.length === 0 ? 'IN SYNC' : 'DRIFT DETECTED') + ' ===\n');
  process.exitCode = missing.length === 0 ? 0 : 1;
})();
