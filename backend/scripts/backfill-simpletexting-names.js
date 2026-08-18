// Backfill: name the existing "no name" SimpleTexting contacts.
//
// Two populations, same repair:
//   1. Customers who opted into SMS before the contact-name upsert shipped
//      (lib/sms.js upsertSimpleTextingContact, merged 2026-07-17) — a contact
//      is only ever created by texting them, and naming now happens at
//      consent time.
//   2. Customers hit by the create race (fixed 2026-08-18): the signup-time
//      name upsert lost to the send's auto-create, SimpleTexting answered 409
//      instead of updating, and the contact stayed unnamed (live example:
//      Edwin S., 2026-08-12). These customers all have opted-in consent rows
//      — every code path that fires the name upsert writes consent first, and
//      auto-create only happens on a send, which is consent-gated — so the
//      opted-in scope below already covers them; no widening needed.
//
// Idempotent and safe to re-run whenever unnamed contacts show up.
//
// Run from the backend folder (needs SUPABASE_* + SIMPLETEXTING_API_TOKEN):
//   node scripts/backfill-simpletexting-names.js          # DRY RUN (default): list only, NO API calls
//   node scripts/backfill-simpletexting-names.js --live   # real upserts, LIVE account
//
// Guardrails:
//   - Dry run is the default; writing requires an explicit --live.
//   - Only opted-in && !opted-out consent rows are considered — the upsert
//     would CREATE a missing contact, so scoping to consenters guarantees we
//     never mint a contact for someone who didn't opt in (this is also why
//     opted-OUT customers' contacts stay unnamed on purpose: naming them
//     could re-create a deleted contact for someone who said stop).
//   - Reuses upsertSimpleTextingContact verbatim: upsert=true,
//     listsReplacement=false (never touches list membership on the shared
//     account), token in the auth header only, non-throwing.
//   - Idempotent: re-running just re-sets the same names.
//   - DB access is SELECT-only; the only writes are names in SimpleTexting.
//   - Sequential with a delay between calls — no rate-limit trips.
//   - Phones are masked (last 4) in all output; the token is never printed.

require('dotenv').config();
const { normalizePhone, upsertSimpleTextingContact } = require('../lib/sms');
const { supabaseAdmin } = require('../lib/supabase');

// Dry run unless --live is given; a stray --dry-run (the old opt-in flag)
// always wins so the pre-2026-08 invocation can never go live by accident.
const DRY_RUN = !process.argv.includes('--live') || process.argv.includes('--dry-run');
const DELAY_MS = 400; // between SimpleTexting calls; a few hundred contacts max
const PAGE_SIZE = 1000; // Supabase caps un-ranged selects at 1000 — page to be safe

const maskPhone = (e164) => '***-***-' + String(e164).slice(-4);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchOptedInRows() {
  const rows = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabaseAdmin
      .from('generator_sms_consent')
      .select('phone, customer:generator_customers(name)')
      .eq('opted_in', true)
      .eq('opted_out', false)
      .order('created_at', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error('consent query failed: ' + error.message);
    rows.push(...(data || []));
    if (!data || data.length < PAGE_SIZE) return rows;
  }
}

(async () => {
  console.log('\n=== SimpleTexting contact-name backfill' + (DRY_RUN ? ' (DRY RUN)' : '') + ' ===\n');

  const rows = await fetchOptedInRows();
  const summary = { considered: rows.length, updated: 0, skipped: 0, failed: 0 };

  // Filter to usable rows and de-dupe by phone (a customer can have multiple
  // consent rows; a phone maps to ONE SimpleTexting contact). First row wins.
  const byPhone = new Map();
  for (const row of rows) {
    const e164 = normalizePhone(row.phone);
    const name = String((row.customer && row.customer.name) || '').trim();
    if (!e164 || !name) {
      summary.skipped++;
      console.log('  SKIP  ' + (e164 ? maskPhone(e164) : 'unusable phone') + (name ? '' : ' — no customer name'));
      continue;
    }
    if (byPhone.has(e164)) {
      summary.skipped++;
      if (byPhone.get(e164) !== name) {
        console.log('  SKIP  ' + maskPhone(e164) + ' — duplicate phone with a different name ("' + name + '" vs kept "' + byPhone.get(e164) + '")');
      }
      continue;
    }
    byPhone.set(e164, name);
  }

  if (DRY_RUN) {
    console.log('\nWould update ' + byPhone.size + ' contact(s):');
    for (const [e164, name] of byPhone) console.log('  ' + maskPhone(e164) + '  ' + name);
    console.log('\nDry run — no API calls made.');
    console.log('Summary: ' + JSON.stringify(summary) + ' (updated = would-update count on a real run: ' + byPhone.size + ')\n');
    return;
  }

  if (!process.env.SIMPLETEXTING_API_TOKEN) {
    console.error('SIMPLETEXTING_API_TOKEN is not set — aborting before any API call.');
    process.exit(1);
  }

  console.log('About to update ' + byPhone.size + ' contact(s) on the LIVE shared SimpleTexting account.\n');

  for (const [e164, name] of byPhone) {
    // Never throws; a failure logs its own reason (token never included).
    const result = await upsertSimpleTextingContact({ phone: e164, name });
    if (result.ok) {
      summary.updated++;
      console.log('  OK    ' + maskPhone(e164) + '  ' + name);
    } else {
      summary.failed++;
      console.log('  FAIL  ' + maskPhone(e164) + '  ' + name + ' — ' + result.reason);
    }
    await sleep(DELAY_MS);
  }

  console.log('\nSummary: ' + JSON.stringify(summary) + '\n');
  process.exit(summary.failed > 0 ? 1 : 0);
})().catch((e) => {
  console.error('Backfill aborted: ' + ((e && e.message) || e));
  process.exit(1);
});
