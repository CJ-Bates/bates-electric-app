// PostgREST embed hints (`alias:table!hint(cols)`) must never exceed
// Postgres's 63-char identifier limit. An auto-generated FK constraint name
// longer than that is silently TRUNCATED at create time, so a hint written
// from the untruncated name 404s at the PostgREST layer ("Could not find a
// relationship ... using the hint ...") and the route 500s. Seen live
// 2026-10-26: generator_sms_conversation_events_previous_owner_profile_id_fkey
// (64 chars) broke the Texts thread. New code uses the column-name form
// (table!column), which never hits the limit; this test scans every backend
// source file so the mistake can't come back.
require('./helpers/env');

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const PG_IDENT_MAX = 63;
const ROOTS = ['lib', 'routes', 'middleware', 'scripts'].map((d) => path.join(__dirname, '..', d));

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, out);
    else if (entry.name.endsWith('.js')) out.push(p);
  }
  return out;
}

// `:profiles!some_hint(` — an embed hint. `!fn(` in plain JS (negation of a
// call) is excluded by requiring the `alias:table!` shape in front.
const HINT_RE = /:\s*[a-z_]+!([A-Za-z_][A-Za-z0-9_]*)\(/g;

test('no PostgREST embed hint is longer than 63 chars (Postgres truncates the FK name it would have to match)', () => {
  const offenders = [];
  let hints = 0;
  for (const file of ROOTS.flatMap((r) => walk(r))) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(HINT_RE)) {
      hints += 1;
      if (m[1].length > PG_IDENT_MAX) offenders.push(path.relative(path.join(__dirname, '..'), file) + ': ' + m[1] + ' (' + m[1].length + ')');
    }
  }
  assert.ok(hints >= 5, 'scan found the known embed hints (' + hints + ')');
  assert.deepEqual(offenders, []);
});

test('sql/037 embeds use the column-name hint form, not generated constraint names', () => {
  const texts = fs.readFileSync(path.join(__dirname, '..', 'routes', 'generator-care', 'texts.js'), 'utf8');
  const lib = fs.readFileSync(path.join(__dirname, '..', 'lib', 'smsConversations.js'), 'utf8');
  for (const src of [texts, lib]) {
    assert.doesNotMatch(src, /!generator_sms_conversation(s|_events)_[a-z_]+_fkey\(/, 'no 037 constraint-name hints');
  }
  assert.match(texts, /profiles!previous_owner_profile_id\(/);
  assert.match(texts, /profiles!owner_profile_id\(/);
});
