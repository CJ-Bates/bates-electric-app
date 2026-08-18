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
//   node scripts/backfill-simpletexting-names.js          # DRY RUN (default): read-only, nothing written
//   node scripts/backfill-simpletexting-names.js --live   # real upserts, LIVE account
//
// Guardrails:
//   - Dry run is the default; writing requires an explicit --live.
//   - NEVER overwrites an existing name: each contact is GET-checked first
//     and skipped if it already has any first/last name, so a name the
//     office corrected by hand in the SimpleTexting UI survives re-runs.
//     (A compare-against-our-DB check would NOT protect those — a hand
//     correction differs from the DB by definition.) If the GET itself
//     fails, the contact is NOT written — fail safe, counted as failed.
//     Dry run does the same read-only GETs when SIMPLETEXTING_API_TOKEN is
//     set, so its output is exactly what --live would do; without a token
//     it lists candidates and says the named-check happens at run time.
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
const { normalizePhone, upsertSimpleTextingContact, SIMPLETEXTING_BASE } = require('../lib/sms');
const { supabaseAdmin } = require('../lib/supabase');

// Dry run unless --live is given; a stray --dry-run (the old opt-in flag)
// always wins so the pre-2026-08 invocation can never go live by accident.
const DRY_RUN = !process.argv.includes('--live') || process.argv.includes('--dry-run');
const DELAY_MS = 400; // between SimpleTexting calls; a few hundred contacts max
const PAGE_SIZE = 1000; // Supabase caps un-ranged selects at 1000 — page to be safe

const maskPhone = (e164) => '***-***-' + String(e164).slice(-4);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Read-only: what does SimpleTexting hold for this contact right now?
// 'named' means it has ANY first/last name — those are never written, so a
// hand-corrected name in the UI can't be clobbered. Never throws; an
// unreadable contact comes back as 'error' and the caller fails safe.
async function getCurrentName(e164) {
  try {
    const resp = await fetch(SIMPLETEXTING_BASE + '/api/contacts/' + e164.replace(/^\+1/, ''), {
      headers: {
        // Token lives ONLY in this header — never in a log or error detail.
        Authorization: 'Bearer ' + process.env.SIMPLETEXTING_API_TOKEN,
        accept: 'application/json',
      },
    });
    if (resp.status === 404) return { state: 'missing' };
    if (!resp.ok) return { state: 'error', detail: 'SimpleTexting ' + resp.status };
    const c = await resp.json().catch(() => null);
    const existing = c ? [c.firstName, c.lastName].filter(Boolean).join(' ').trim() : '';
    return existing ? { state: 'named', name: existing } : { state: 'unnamed' };
  } catch (e) {
    return { state: 'error', detail: (e && e.message) || String(e) };
  }
}

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

  const haveToken = !!process.env.SIMPLETEXTING_API_TOKEN;

  if (!haveToken) {
    if (!DRY_RUN) {
      console.error('SIMPLETEXTING_API_TOKEN is not set — aborting before any API call.');
      process.exit(1);
    }
    // Token-less dry run: can't GET current names, so this is the candidate
    // list only — the already-named check happens per contact at run time.
    console.log('\n' + byPhone.size + ' candidate contact(s) — no SIMPLETEXTING_API_TOKEN, so current');
    console.log('names were NOT checked; any contact that already has a name is skipped at run time:');
    for (const [e164, name] of byPhone) console.log('  ' + maskPhone(e164) + '  ' + name);
    console.log('\nDry run — no API calls made.');
    console.log('Summary: ' + JSON.stringify(summary) + ' (candidates: ' + byPhone.size + ')\n');
    return;
  }

  console.log(
    DRY_RUN
      ? 'Checking ' + byPhone.size + ' contact(s) (read-only GETs, nothing written):\n'
      : 'About to check-and-name ' + byPhone.size + ' contact(s) on the LIVE shared SimpleTexting account.\n'
  );

  for (const [e164, name] of byPhone) {
    const current = await getCurrentName(e164);
    if (current.state === 'named') {
      // Never overwrite: this preserves names the office fixed by hand.
      summary.skipped++;
      console.log('  SKIP  ' + maskPhone(e164) + '  already named "' + current.name + '"' +
        (current.name === name ? '' : ' (ours would have been "' + name + '")'));
    } else if (current.state === 'error') {
      // Can't see the current name -> don't risk clobbering it.
      summary.failed++;
      console.log('  FAIL  ' + maskPhone(e164) + '  name check failed (' + current.detail + ') — not written');
    } else if (DRY_RUN) {
      summary.updated++;
      console.log('  WOULD NAME  ' + maskPhone(e164) + '  ' + name +
        (current.state === 'missing' ? ' (no contact yet — would be created)' : ''));
    } else {
      // Never throws; a failure logs its own reason (token never included).
      const result = await upsertSimpleTextingContact({ phone: e164, name });
      if (result.ok) {
        summary.updated++;
        console.log('  OK    ' + maskPhone(e164) + '  ' + name);
      } else {
        summary.failed++;
        console.log('  FAIL  ' + maskPhone(e164) + '  ' + name + ' — ' + result.reason);
      }
    }
    await sleep(DELAY_MS);
  }

  if (DRY_RUN) console.log('\nDry run — read-only, nothing written. (updated = would-name count)');
  console.log('\nSummary: ' + JSON.stringify(summary) + '\n');
  process.exit(summary.failed > 0 ? 1 : 0);
})().catch((e) => {
  console.error('Backfill aborted: ' + ((e && e.message) || e));
  process.exit(1);
});
