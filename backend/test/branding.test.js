// Florida DBA rule: "S.E. Bates Electric" in Florida, "Bates Electric"
// everywhere else — keyed off the install-address state only.
require('./helpers/env');
const test = require('node:test');
const assert = require('node:assert/strict');

const { isFlorida, companyName } = require('../lib/branding');

test('isFlorida: liberal matching on FL / Florida only', () => {
  const yes = ['FL', 'fl', 'Fl', ' FL ', 'Florida', 'florida', ' FLORIDA '];
  const no = ['MO', 'mo', 'F', 'FLA', 'Miami', 'Flo', '', null, undefined, 0, false];
  for (const v of yes) assert.equal(isFlorida(v), true, JSON.stringify(v));
  for (const v of no) assert.equal(isFlorida(v), false, JSON.stringify(v));
});

test('companyName: S.E. prefix in Florida only', () => {
  assert.equal(companyName('FL'), 'S.E. Bates Electric');
  assert.equal(companyName('Florida'), 'S.E. Bates Electric');
  assert.equal(companyName('MO'), 'Bates Electric');
  assert.equal(companyName('GA'), 'Bates Electric');
  assert.equal(companyName(null), 'Bates Electric');
  assert.equal(companyName(undefined), 'Bates Electric');
});
