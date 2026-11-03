import test from 'node:test';
import assert from 'node:assert/strict';
import { firstGenLevel, isFirstGeneration, isoDigitalGain } from '../app/js/core/firstgen.js';

const flat = (level, w = 40, h = 40) => new Float32Array(w * h * 3).fill(level);
// A picture with a little spread: a ramp from lo to hi.
const ramp = (lo, hi, w = 40, h = 40) => Float32Array.from({ length: w * h * 3 }, (_, i) => lo + ((hi - lo) * ((i / 3) | 0)) / (w * h));

test('first generation cameras are the F01 model', () => {
  assert.equal(isFirstGeneration({ model: 'F01' }), true);
  assert.equal(isFirstGeneration({ model: 'B01' }), false);
  assert.equal(isFirstGeneration(null), false);
});

test('the digital ISO gain is ISO / 794, at least 1', () => {
  assert.equal(isoDigitalGain(200), 1);
  assert.ok(Math.abs(isoDigitalGain(3200) - 4.03) < 0.01);
});

test('a dim picture is brightened: the gain is one over the (pulled up) white', () => {
  const r = firstGenLevel(ramp(0.05, 0.5), 40, 40, 200);
  assert.ok(r.white > 0.5 && r.white < 1);
  assert.ok(r.gain > 1.4 && r.gain < 2.2, String(r.gain));
  assert.equal(r.exposure, r.gain);
});

test('a bright picture is toned down, and the ISO gain is part of the exposure', () => {
  const r = firstGenLevel(ramp(0.2, 1.8), 40, 40, 3200);
  assert.ok(r.white > 1);
  assert.ok(r.gain < 1);
  assert.ok(Math.abs(r.exposure - r.gain * 4.03) < 0.01);
});

test('the gain is at most 8, and black is at most a tenth of white', () => {
  const r = firstGenLevel(flat(0.01), 40, 40, 100);
  assert.ok(r.gain <= 8 + 1e-9);
  const q = firstGenLevel(ramp(0.4, 0.6), 40, 40, 100);
  assert.ok(q.black <= 0.1 * 0.6 + 1e-6);
});

test('too little picture gives no level', () => {
  assert.equal(firstGenLevel(new Float32Array(30), 3, 3, 200), null);
});
