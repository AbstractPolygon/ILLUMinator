// The engine's tables (read from Lytro's engine) are data files: these checks catch a table that was damaged or cut short, not the engine's numbers themselves.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FILTER_DESCRIPTORS } from '../app/js/core/lytrofilters.js';
import { curve } from '../app/js/core/enginemod.js';
import { ENGINE_NR_PROFILES } from '../app/js/core/enginenr-profiles.js';
import { AWB_LUT1, AWB_LUT2, AWB_CFG, AWB_CCT_TABLE, AWB_GAIN_TABLE, AWB_DEFAULT_RESPONSE, AWB_TARGET_GAINS } from '../app/js/core/enginewb-tables.js';

const finite = (a) => Array.from(a).every(Number.isFinite);

test('reconstruction filters: one set per depth, in order, each four tables of 17 values', () => {
  assert.equal(FILTER_DESCRIPTORS.length, 27);
  for (let i = 1; i < FILTER_DESCRIPTORS.length; i++) assert.ok(FILTER_DESCRIPTORS[i].lambda > FILTER_DESCRIPTORS[i - 1].lambda);
  assert.equal(FILTER_DESCRIPTORS[0].lambda, -34);
  assert.equal(FILTER_DESCRIPTORS[26].lambda, 30);
  for (const d of FILTER_DESCRIPTORS) {
    for (const k of ['hf', 'hm', 'vf', 'vm']) {
      assert.equal(d[k].length, 17, `${d.lambda} ${k}`);
      assert.ok(finite(d[k]));
    }
  }
});

test('the modulation curve is 16384 finite values near 1', () => {
  const c = curve();
  assert.equal(c.length, 16384);
  assert.ok(finite(c));
  assert.ok(c.every((v) => v > 0.5 && v < 2));
});

test('noise reduction profiles: eight ISO keys in order, one profile for each', () => {
  const { keys, profiles } = ENGINE_NR_PROFILES;
  assert.equal(keys.length, 8);
  assert.equal(profiles.length, 8);
  for (let i = 1; i < keys.length; i++) assert.ok(keys[i] > keys[i - 1]);
  for (const p of profiles) {
    for (const k of ['ctype', 'scalars', 'ctrl', 'A', 'B']) assert.ok(k in p, `profile has ${k}`);
  }
});

test('auto white balance tables: two 64 x 64 hex weight tables, ordered temperature tables, three-channel gains', () => {
  for (const lut of [AWB_LUT1, AWB_LUT2]) {
    assert.equal(lut.length, 4096);
    assert.match(lut, /^[0-9a-f]+$/);
  }
  for (const table of [AWB_CCT_TABLE, AWB_GAIN_TABLE]) {
    const cct = (row) => row[row.length - 1];
    const ratio = (row) => row[0];
    for (let i = 1; i < table.length; i++) {
      assert.ok(cct(table[i]) > cct(table[i - 1]), 'temperatures rise');
      if (table === AWB_CCT_TABLE) assert.ok(ratio(table[i]) > ratio(table[i - 1]), 'the red/blue ratio rises with them');
    }
  }
  for (const row of AWB_GAIN_TABLE) assert.equal(row.length, 4);
  assert.equal(AWB_DEFAULT_RESPONSE.length, 3);
  assert.equal(AWB_TARGET_GAINS.length, 3);
  assert.ok(AWB_TARGET_GAINS.every((g) => g > 0));
  assert.ok(AWB_CFG.roiFraction > 0 && AWB_CFG.roiFraction <= 1);
  assert.equal(AWB_CFG.shiftKnots.length, 6);
});
