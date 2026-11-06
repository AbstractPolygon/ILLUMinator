import test from 'node:test';
import assert from 'node:assert/strict';
import { newerVersion, updateCheckOn } from '../app/js/ui/updates.js';

test('newerVersion compares dotted numbers part by part', () => {
  assert.equal(newerVersion('0.5.81', '0.5.80'), true);
  assert.equal(newerVersion('0.5.80', '0.5.81'), false);
  assert.equal(newerVersion('0.5.80', '0.5.80'), false);
  assert.equal(newerVersion('0.10.0', '0.9.9'), true, 'numbers, not text: 10 is more than 9');
  assert.equal(newerVersion('1.0', '0.9.9'), true);
  assert.equal(newerVersion('0.5', '0.5.0'), false, 'a missing part is 0');
});

test('the automatic update check is on unless it was turned off, and without storage', () => {
  const store = {};
  globalThis.localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = v; } };
  assert.equal(updateCheckOn(), true);
  store['illuminator.checkUpdates'] = '0';
  assert.equal(updateCheckOn(), false);
  store['illuminator.checkUpdates'] = '1';
  assert.equal(updateCheckOn(), true);
  globalThis.localStorage = { getItem: () => { throw new Error('blocked'); } };
  assert.equal(updateCheckOn(), true);
  delete globalThis.localStorage;
});
