// The debug and test switches (app/js/core/debugflags.js): always an object, hooks read and written through the harness globals.
import test from 'node:test';
import assert from 'node:assert/strict';
import { debugFlags, hook, setHook } from '../app/js/core/debugflags.js';

test('debugFlags is an empty object when nothing is set, and the harness object when it is', () => {
  const saved = globalThis.__lytro;
  try {
    delete globalThis.__lytro;
    assert.equal(typeof debugFlags(), 'object');
    assert.equal(debugFlags().legacy, undefined);
    assert.equal(debugFlags(), debugFlags());
    assert.throws(() => { 'use strict'; debugFlags().legacy = true; }, TypeError);
    globalThis.__lytro = { legacy: true, viewRing: 0.3 };
    assert.equal(debugFlags().legacy, true);
    assert.equal(debugFlags().viewRing, 0.3);
  } finally {
    if (saved === undefined) delete globalThis.__lytro;
    else globalThis.__lytro = saved;
  }
});

test('hooks are the __name globals a harness sets', () => {
  try {
    assert.equal(hook('depthOverrideTest'), undefined);
    globalThis.__depthOverrideTest = 5;
    assert.equal(hook('depthOverrideTest'), 5);
    assert.equal(setHook('focusMetricsTest', { a: 1 }).a, 1);
    assert.deepEqual(globalThis.__focusMetricsTest, { a: 1 });
  } finally {
    delete globalThis.__depthOverrideTest;
    delete globalThis.__focusMetricsTest;
  }
});
