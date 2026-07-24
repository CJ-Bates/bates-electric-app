// Unit tests for the stuck-I/O safety primitives (lib/asyncGuards.js): the
// timeout guard that makes a wedged Stripe/Supabase call REJECT instead of
// hang, and the bounded-concurrency mapper that caps simultaneous sockets.
require('./helpers/env');

const test = require('node:test');
const assert = require('node:assert/strict');

const { withTimeout, TimeoutError, mapPool } = require('../lib/asyncGuards');

const delay = (ms, value) => new Promise((r) => setTimeout(() => r(value), ms));

test('withTimeout resolves with the value when the promise settles first', async () => {
  const out = await withTimeout(delay(5, 42), 1000, 'fast');
  assert.equal(out, 42);
});

test('withTimeout accepts a non-promise value', async () => {
  const out = await withTimeout(7, 1000, 'plain');
  assert.equal(out, 7);
});

test('withTimeout rejects with a TimeoutError when the promise hangs', async () => {
  const started = Date.now();
  await assert.rejects(
    () => withTimeout(new Promise(() => {}), 30, 'stuck call'),
    (e) => {
      assert.ok(e instanceof TimeoutError);
      assert.match(e.message, /stuck call timed out after 30ms/);
      assert.equal(e.code, 'ETIMEDOUT_GUARD');
      return true;
    },
  );
  // Bounded: it rejected near the deadline, not after hanging indefinitely.
  assert.ok(Date.now() - started < 2000, 'should reject promptly at the timeout');
});

test('withTimeout surfaces the promise’s own rejection if it loses the race', async () => {
  const boom = new Error('upstream failed');
  await assert.rejects(() => withTimeout(Promise.reject(boom), 1000, 'x'), /upstream failed/);
});

test('mapPool returns results in input order', async () => {
  // Later items resolve sooner, so out-of-order completion would be visible.
  const out = await mapPool([1, 2, 3, 4], 2, (n) => delay((5 - n) * 5, n * 10));
  assert.deepEqual(out, [10, 20, 30, 40]);
});

test('mapPool never runs more than `concurrency` tasks at once', async () => {
  let active = 0;
  let peak = 0;
  const items = Array.from({ length: 12 }, (_, i) => i);
  const out = await mapPool(items, 3, async (n) => {
    active++;
    peak = Math.max(peak, active);
    await delay(10);
    active--;
    return n;
  });
  assert.deepEqual(out, items);
  assert.ok(peak <= 3, `peak concurrency ${peak} must not exceed 3`);
  assert.ok(peak >= 2, `peak concurrency ${peak} should have reached the cap`);
});

test('mapPool on an empty list resolves to an empty array without calling fn', async () => {
  let called = false;
  const out = await mapPool([], 4, async () => { called = true; });
  assert.deepEqual(out, []);
  assert.equal(called, false);
});

test('mapPool rejects on the first task rejection (Promise.all semantics)', async () => {
  await assert.rejects(
    () => mapPool([1, 2, 3], 2, async (n) => { if (n === 2) throw new Error('item 2'); return n; }),
    /item 2/,
  );
});
