// sql/039 for real: spins up a THROWAWAY local Postgres cluster (temp dir,
// random port), stubs the few Supabase objects the migration references
// (profiles, generator_customers, member_permissions, storage.buckets, the
// anon/authenticated/service_role roles), applies the migration twice
// (re-runnable), then drives the ledger functions:
//   - qty is ONLY moved by inventory_post_txn (direct edits refused) and the
//     ledger is append-only; qty always equals the ledger sum
//   - client_op_id makes a resend return the original row
//   - live overdraw refused, offline scan-out allowed below zero
//   - serialized units move one at a time, no double out
//   - count sessions: add vs replace, posting twice posts once
//   - surplus: sold comes out of surplus first, scan-out trims it
//   - the header's verification query returns the expected values
// Skips when no Postgres binaries are found (set PG_BIN to point at them).
// Never touches Supabase.
require('./helpers/env');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const exe = process.platform === 'win32' ? '.exe' : '';
const PG_BIN = [process.env.PG_BIN, 'C:/Program Files/PostgreSQL/17/bin', 'C:/Program Files/PostgreSQL/16/bin', '/usr/lib/postgresql/16/bin', '/usr/local/bin', '/usr/bin']
  .filter(Boolean).find((d) => fs.existsSync(path.join(d, 'initdb' + exe)) && fs.existsSync(path.join(d, 'psql' + exe)));
const MIGRATION = path.join(__dirname, '..', 'sql', '039_warehouse_inventory.sql');
const UNDO_MIGRATION = path.join(__dirname, '..', 'sql', '040_inventory_undo.sql');

const STUB = `
create role anon; create role authenticated; create role service_role;
create table public.profiles (id uuid primary key, full_name text);
create table public.generator_customers (id uuid primary key, name text);
create table public.member_permissions (profile_id uuid primary key, texting boolean not null default true);
create schema storage;
create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
insert into public.profiles values ('00000000-0000-0000-0000-0000000000a1', 'CJ');
`;
const A = "'00000000-0000-0000-0000-0000000000a1'";
const BRK = "'11111111-1111-1111-1111-111111111111'";
const ATS = "'22222222-2222-2222-2222-222222222222'";

test('sql/039 against a real Postgres', { skip: PG_BIN ? false : 'no local Postgres (set PG_BIN)' }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bates-inv-pg-'));
  const data = path.join(dir, 'data');
  const port = String(55000 + Math.floor(Math.random() * 4000));
  const bin = (name) => path.join(PG_BIN, name + exe);
  execFileSync(bin('initdb'), ['-D', data, '-U', 'postgres', '-A', 'trust', '-E', 'UTF8'], { stdio: 'ignore' });
  execFileSync(bin('pg_ctl'), ['-D', data, '-o', `-p ${port}`, '-l', path.join(dir, 'log.txt'), '-w', 'start'], { stdio: 'ignore' });
  t.after(() => {
    try { execFileSync(bin('pg_ctl'), ['-D', data, '-m', 'immediate', 'stop'], { stdio: 'ignore' }); } catch (e) { /* already down */ }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { /* temp */ }
  });
  const psql = (sql) => execFileSync(bin('psql'), ['-p', port, '-U', 'postgres', '-At', '-q', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const psqlFile = (file) => execFileSync(bin('psql'), ['-p', port, '-U', 'postgres', '-q', '-v', 'ON_ERROR_STOP=1', '-f', file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const fails = (sql, re) => {
    let msg = null;
    try { psql(sql); } catch (e) { msg = String(e.stderr || e.message); }
    assert.ok(msg, 'expected an error from: ' + sql);
    if (re) assert.match(msg, re);
  };
  const stub = path.join(dir, 'stub.sql');
  fs.writeFileSync(stub, STUB);
  psqlFile(stub);
  psqlFile(MIGRATION);
  psqlFile(MIGRATION); // re-runnable
  psqlFile(UNDO_MIGRATION);
  psqlFile(UNDO_MIGRATION); // re-runnable
  const post = (args) => psql(`select resulting_qty from inventory_post_txn(${args})`);
  const qty = (id) => psql(`select qty_on_hand || '|' || surplus_qty from inventory_items where id = ${id}`);

  psql(`insert into inventory_items (id, description) values (${BRK}, '30A breaker'); insert into inventory_items (id, description, serialized) values (${ATS}, '400A ATS', true)`);

  // In / out / resend / count.
  assert.equal(post(`${BRK}, 'received', ${A}, p_qty_change => 5, p_client_op_id => 'aaaaaaaa-0000-0000-0000-000000000001'`), '5.00');
  assert.equal(post(`${BRK}, 'received', ${A}, p_qty_change => 5, p_client_op_id => 'aaaaaaaa-0000-0000-0000-000000000001'`), '5.00', 'resend returns the original row');
  assert.equal(post(`${BRK}, 'scanned_out', ${A}, p_qty_change => -2`), '3.00');
  assert.equal(psql(`select qty_change from inventory_post_txn(${BRK}, 'adjustment', ${A}, p_set_qty => 7)`), '4.00', 'count posts the difference');
  fails(`select inventory_post_txn(${BRK}, 'scanned_out', ${A}, p_qty_change => -9)`, /only 7\.00 on hand/);
  fails(`select inventory_post_txn(${BRK}, 'received', ${A}, p_qty_change => -1)`, /positive quantity/);

  // Guards.
  fails(`update inventory_items set qty_on_hand = 100 where id = ${BRK}`, /maintained by the ledger/);
  fails('update inventory_transactions set qty_change = 0', /append-only/);
  fails('delete from inventory_transactions', /append-only/);
  psql(`update inventory_items set location = 'Shelf B2' where id = ${BRK}`); // other edits are fine

  // Surplus.
  psql(`update inventory_items set surplus_qty = 6 where id = ${BRK}`);
  fails(`update inventory_items set surplus_qty = 8 where id = ${BRK}`, /inventory_items_surplus_qty_chk/);
  post(`${BRK}, 'sold', ${A}, p_qty_change => -2`);
  assert.equal(qty(BRK), '5.00|4.00', 'sold 2 of 7 (6 surplus) -> 5 on hand, 4 surplus');
  post(`${BRK}, 'scanned_out', ${A}, p_qty_change => -3`);
  assert.equal(qty(BRK), '2.00|2.00', 'scan-out trims surplus to what is left');

  // Offline overdraw.
  assert.equal(post(`${BRK}, 'scanned_out', ${A}, p_qty_change => -5, p_allow_negative => true`), '-3.00');
  fails(`select inventory_post_txn(${BRK}, 'sold', ${A}, p_qty_change => -1, p_allow_negative => true)`, /only -3\.00 on hand/);

  // Serialized.
  psql(`insert into inventory_units (id, item_id, serial_number) values ('33333333-0000-0000-0000-000000000001', ${ATS}, 'SN-A'), ('33333333-0000-0000-0000-000000000002', ${ATS}, 'SN-B')`);
  post(`${ATS}, 'initial_count', ${A}, p_unit_id => '33333333-0000-0000-0000-000000000001'`);
  assert.equal(post(`${ATS}, 'initial_count', ${A}, p_unit_id => '33333333-0000-0000-0000-000000000002'`), '2.00');
  assert.equal(post(`${ATS}, 'scanned_out', ${A}, p_unit_id => '33333333-0000-0000-0000-000000000001'`), '1.00');
  fails(`select inventory_post_txn(${ATS}, 'scanned_out', ${A}, p_unit_id => '33333333-0000-0000-0000-000000000001')`, /not in stock/);
  fails(`select inventory_post_txn(${ATS}, 'adjustment', ${A}, p_set_qty => 5)`, /pick the unit/);
  assert.equal(psql(`select count(*) from inventory_units where item_id = ${ATS} and status = 'in_stock'`), '1');

  // Count sessions: add, then replace; double post is a no-op.
  psql(`insert into inventory_count_sessions (id, started_by) values ('44444444-0000-0000-0000-000000000001', ${A}), ('44444444-0000-0000-0000-000000000002', ${A})`);
  psql(`insert into inventory_count_lines (session_id, item_id, counted_qty) values ('44444444-0000-0000-0000-000000000001', ${BRK}, 12)`);
  assert.equal(psql(`select inventory_post_count_session('44444444-0000-0000-0000-000000000001', ${A})`), '1');
  assert.equal(psql(`select inventory_post_count_session('44444444-0000-0000-0000-000000000001', ${A})`), '0');
  assert.equal(qty(BRK).split('|')[0], '9.00', '-3 + 12');
  psql(`insert into inventory_count_lines (session_id, item_id, counted_qty, mode) values ('44444444-0000-0000-0000-000000000002', ${BRK}, 4, 'replace')`);
  psql(`select inventory_post_count_session('44444444-0000-0000-0000-000000000002', ${A})`);
  assert.equal(qty(BRK).split('|')[0], '4.00', 'replace sets the count');

  // Undo (sql/040): a reversing adjustment linked to the original.
  const lastId = (item) => psql(`select id from inventory_transactions where item_id = ${item} order by created_at desc, id desc limit 1`);
  const before = qty(BRK).split('|')[0];
  post(`${BRK}, 'received', ${A}, p_qty_change => 3`);
  const recv = lastId(BRK);
  assert.equal(psql(`select qty_change || '|' || resulting_qty || '|' || reverses_txn_id from inventory_post_txn(${BRK}, 'adjustment', ${A}, p_reverses_txn_id => '${recv}', p_note => 'undo of received')`), `-3.00|${before}|${recv}`);
  assert.equal(psql(`select id from inventory_post_txn(${BRK}, 'adjustment', ${A}, p_reverses_txn_id => '${recv}')`), lastId(BRK), 'a second undo returns the first');
  assert.equal(psql(`select count(*) from inventory_transactions where reverses_txn_id = '${recv}'`), '1');
  fails(`select inventory_post_txn(${BRK}, 'adjustment', ${A}, p_reverses_txn_id => '${lastId(BRK)}')`, /an undo can't be undone/);
  fails(`select inventory_post_txn(${BRK}, 'received', ${A}, p_reverses_txn_id => '${recv}')`, /posted as an adjustment/);
  fails(`select inventory_post_txn(${ATS}, 'adjustment', ${A}, p_reverses_txn_id => '${recv}')`, /another item/);
  // Undoing a receive whose parts already left is refused (no negative stock).
  post(`${BRK}, 'received', ${A}, p_qty_change => 2`);
  const recv2 = lastId(BRK);
  post(`${BRK}, 'scanned_out', ${A}, p_qty_change => -${Number(before) + 2}`);
  fails(`select inventory_post_txn(${BRK}, 'adjustment', ${A}, p_reverses_txn_id => '${recv2}')`, /can't undo/);
  // Serialized: undo a unit scan-out -> back in stock; undo its first receive -> pending.
  psql(`insert into inventory_units (id, item_id, serial_number) values ('33333333-0000-0000-0000-000000000003', ${ATS}, 'SN-C')`);
  post(`${ATS}, 'received', ${A}, p_unit_id => '33333333-0000-0000-0000-000000000003'`);
  const unitIn = lastId(ATS);
  post(`${ATS}, 'scanned_out', ${A}, p_unit_id => '33333333-0000-0000-0000-000000000003'`);
  const unitOut = lastId(ATS);
  const atsBefore = qty(ATS).split('|')[0];
  psql(`select inventory_post_txn(${ATS}, 'adjustment', ${A}, p_reverses_txn_id => '${unitOut}', p_note => 'undo of scanned_out')`);
  assert.equal(psql(`select status from inventory_units where id = '33333333-0000-0000-0000-000000000003'`), 'in_stock');
  assert.equal(qty(ATS).split('|')[0], (Number(atsBefore) + 1).toFixed(2));
  assert.equal(psql(`select unit_id from inventory_transactions where reverses_txn_id = '${unitOut}'`), '33333333-0000-0000-0000-000000000003');
  psql(`select inventory_post_txn(${ATS}, 'adjustment', ${A}, p_reverses_txn_id => '${unitIn}')`);
  assert.equal(psql(`select status from inventory_units where id = '33333333-0000-0000-0000-000000000003'`), 'pending', 'never in stock before that receive');
  assert.equal(psql(`select count(*) from inventory_units where item_id = ${ATS} and status = 'in_stock'`), qty(ATS).split('|')[0].replace('.00', ''));
  fails('update inventory_transactions set reverses_txn_id = null', /append-only/);

  // Ledger integrity + the verification query from the migration header.
  assert.equal(psql(`select count(*) from inventory_items i where i.qty_on_hand <> coalesce((select sum(t.qty_change) from inventory_transactions t where t.item_id = i.id), 0)`), '0');
  const header = fs.readFileSync(MIGRATION, 'utf8');
  const verify = header.slice(header.indexOf('--   select'), header.indexOf('as ledger_mismatches;') + 'as ledger_mismatches;'.length)
    .split('\n').map((l) => l.replace(/^--\s{0,3}/, '')).join('\n');
  assert.equal(psql(verify), '7|7|0|3|3|0|1|1|1|0');
  const header40 = fs.readFileSync(UNDO_MIGRATION, 'utf8');
  const verify40 = header40.slice(header40.indexOf('--   select'), header40.indexOf('as ledger_mismatches;') + 'as ledger_mismatches;'.length)
    .split('\n').map((l) => l.replace(/^--\s{0,3}/, '')).join('\n');
  assert.equal(psql(verify40), '1|1|1|1|0|0');
});
