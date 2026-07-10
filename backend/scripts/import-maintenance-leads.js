// One-time loader for Growth Engine WP3: imports the generator-maintenance
// book (scripts/data/maintenance-leads.csv, ~1,653 customers) into
// generator_leads as source='campaign' leads, each tagged with its
// maintenance_month so the Leads tab can work them as monthly cohorts and
// WP4 can drip signup invites cohort by cohort.
//
// Run from the backend folder:
//   node scripts/import-maintenance-leads.js            # DRY RUN — prints what would happen, writes nothing
//   node scripts/import-maintenance-leads.js --commit   # actually inserts
//
// Safe to re-run: before inserting, every CSV row is checked against the
// existing source='campaign' leads by normalized customer_name + install_zip,
// so a second run inserts 0 — and a lead that's already been advanced or
// converted is never touched or duplicated.
//
// UNDO the whole import (only rows still untouched at status='new'):
//   delete from generator_leads where import_batch = 'gen-maint-2026-07' and status = 'new';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { supabaseAdmin } = require('../lib/supabase');

const CSV_PATH = path.join(__dirname, 'data', 'maintenance-leads.csv');
const IMPORT_BATCH = 'gen-maint-2026-07';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const CONTACT_TYPES = ['Person', 'Couple', 'Business'];
const INSERT_CHUNK = 200;

// ---- CSV parsing ----
// The book has quoted fields with embedded commas ("Smith, John & Jane"), so
// this is a real RFC-4180 walk — quotes, "" escapes, CR/LF — not a split(',').
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      rows.push(row); row = [];
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// Blank, whitespace, or a literal "None"/"none" placeholder -> null. The
// leads table (and every UI on top of it) treats null as "not on file";
// the string "None" would render — and email — as a real value.
function cleanValue(v) {
  const t = (v || '').trim();
  if (!t || /^none$/i.test(t)) return null;
  return t;
}

// Dedupe key among source='campaign' rows: normalized name + zip. Case,
// whitespace runs, and punctuation don't make two entries different people.
function dedupeKey(name, zip) {
  const n = (name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const z = (zip || '').trim();
  return `${n}|${z}`;
}

function mapRow(cols, header) {
  const get = (name) => cleanValue(cols[header.indexOf(name)]);
  const flags = get('flags');
  const rawEntry = get('raw_entry');
  // flags + raw_entry land in notes so nothing from the book is lost.
  const noteBits = [];
  if (flags) noteBits.push(`Flags: ${flags}`);
  if (rawEntry) noteBits.push(`Book entry: ${rawEntry}`);
  return {
    source: 'campaign',
    status: 'new',
    customer_name: get('customer_name'),
    customer_email: get('customer_email'),
    customer_phone: get('customer_phone'),
    install_address: get('install_address'),
    install_city: get('install_city'),
    install_state: get('install_state'),
    install_zip: get('install_zip'),
    maintenance_month: get('maintenance_month'),
    contact_type: get('contact_type'),
    referred_by_label: 'Generator Maintenance calendar',
    import_batch: IMPORT_BATCH,
    notes: noteBits.length ? noteBits.join('\n') : null,
  };
}

(async () => {
  const commit = process.argv.includes('--commit');

  console.log('\n=== Bates Electric — Maintenance-book lead import ===');
  console.log(commit ? 'Mode: COMMIT — rows will be written.' : 'Mode: DRY RUN — nothing will be written.');
  console.log(`CSV: ${CSV_PATH}`);
  console.log(`Batch tag: ${IMPORT_BATCH}\n`);

  const text = fs.readFileSync(CSV_PATH, 'utf8').replace(/^\uFEFF/, '');
  const rows = parseCsv(text).filter((r) => r.some((c) => c.trim() !== ''));
  const header = rows.shift().map((h) => h.trim());
  for (const required of ['customer_name', 'install_zip', 'maintenance_month', 'contact_type', 'flags', 'raw_entry']) {
    if (!header.includes(required)) {
      console.error(`FAIL  CSV header is missing "${required}" — got: ${header.join(', ')}`);
      process.exitCode = 1;
      return;
    }
  }

  const problems = [];
  const mapped = rows.map((cols, i) => {
    const lead = mapRow(cols, header);
    const line = i + 2; // 1-based + header row
    if (!lead.customer_name && !lead.customer_email && !lead.customer_phone) {
      problems.push(`line ${line}: no name, email, or phone — skipped`);
      return null;
    }
    if (lead.maintenance_month && !MONTHS.includes(lead.maintenance_month)) {
      problems.push(`line ${line}: maintenance_month "${lead.maintenance_month}" is not Jan..Dec — imported with month = null`);
      lead.maintenance_month = null;
    }
    if (lead.contact_type && !CONTACT_TYPES.includes(lead.contact_type)) {
      problems.push(`line ${line}: contact_type "${lead.contact_type}" is not Person/Couple/Business — imported with contact_type = null`);
      lead.contact_type = null;
    }
    return lead;
  }).filter(Boolean);

  // Idempotency: anything already in the campaign pipeline (by name+zip)
  // is skipped, whatever its status — a re-run never doubles the book and
  // never touches a lead Amy has already advanced or converted.
  const existing = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabaseAdmin
      .from('generator_leads')
      .select('customer_name, install_zip')
      .eq('source', 'campaign')
      .range(from, from + PAGE - 1);
    if (error) {
      console.error('FAIL  could not read existing campaign leads — ' + error.message);
      process.exitCode = 1;
      return;
    }
    existing.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  const existingKeys = new Set(existing.map((l) => dedupeKey(l.customer_name, l.install_zip)));

  const toInsert = [];
  const seenThisRun = new Set(); // CSV-internal duplicates count as skips too
  let skippedExisting = 0;
  let skippedDupInFile = 0;
  for (const lead of mapped) {
    const key = dedupeKey(lead.customer_name, lead.install_zip);
    if (existingKeys.has(key)) { skippedExisting++; continue; }
    if (seenThisRun.has(key)) { skippedDupInFile++; continue; }
    seenThisRun.add(key);
    toInsert.push(lead);
  }

  // ---- Summary ----
  const count = (f) => toInsert.filter((l) => l[f]).length;
  const byMonth = {};
  for (const l of toInsert) {
    const m = l.maintenance_month || '(none)';
    byMonth[m] = (byMonth[m] || 0) + 1;
  }

  console.log(`CSV data rows:            ${rows.length}`);
  console.log(`Mapped (importable):      ${mapped.length}`);
  console.log(`Already in pipeline:      ${skippedExisting} (skipped — dedupe on name+zip among campaign leads)`);
  console.log(`Duplicate within CSV:     ${skippedDupInFile} (skipped)`);
  console.log(`Would insert:             ${toInsert.length}\n`);
  console.log(`  with email:             ${count('customer_email')}`);
  console.log(`  with phone:             ${count('customer_phone')}`);
  console.log(`  with maintenance month: ${count('maintenance_month')}`);
  console.log(`  with contact type:      ${count('contact_type')}\n`);

  console.log('By maintenance month:');
  for (const m of [...MONTHS, '(none)']) {
    if (byMonth[m]) console.log(`  ${m.padEnd(7)} ${byMonth[m]}`);
  }

  if (problems.length) {
    console.log(`\nRow warnings (${problems.length}):`);
    for (const p of problems) console.log('  ' + p);
  }

  console.log('\nSample of 10 mapped rows:');
  for (const l of toInsert.slice(0, 10)) {
    console.log(`  ${l.maintenance_month || '---'}  ${l.customer_name || '(no name)'} — ${[l.customer_email || 'no email', l.customer_phone || 'no phone', [l.install_city, l.install_state, l.install_zip].filter(Boolean).join(' ') || 'no address'].join(' · ')} [${l.contact_type || 'no type'}]`);
  }

  if (!commit) {
    console.log('\nDRY RUN — nothing was written. Re-run with --commit to write.\n');
    return;
  }

  // ---- Insert ----
  let inserted = 0;
  for (let i = 0; i < toInsert.length; i += INSERT_CHUNK) {
    const chunk = toInsert.slice(i, i + INSERT_CHUNK);
    const { error } = await supabaseAdmin.from('generator_leads').insert(chunk);
    if (error) {
      console.error(`\nFAIL  insert error after ${inserted} rows — ${error.message}`);
      console.error(`Rows from this batch already written stay tagged import_batch='${IMPORT_BATCH}'.`);
      console.error('Fix the cause and re-run: the dedupe check makes a re-run pick up where this left off.');
      process.exitCode = 1;
      return;
    }
    inserted += chunk.length;
    console.log(`  inserted ${inserted}/${toInsert.length}...`);
  }

  console.log(`\nDone: ${inserted} leads inserted, ${skippedExisting + skippedDupInFile} skipped.`);
  console.log('\nVerify in the Supabase SQL Editor:');
  console.log("  select coalesce(maintenance_month, '(none)') as month, count(*)");
  console.log("  from generator_leads where source = 'campaign'");
  console.log('  group by 1 order by min(array_position(');
  console.log("    array['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'], maintenance_month)) nulls last;");
  console.log("  select count(*) as campaign_total from generator_leads where source = 'campaign';\n");
})();
