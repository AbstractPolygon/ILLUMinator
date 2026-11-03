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

import { toneMap } from '../app/js/core/render.js';
import { firstToneColor, firstTone } from '../app/js/core/base.js';

test('the first generation contrast spline passes through its knots and keeps black and white', () => {
  assert.equal(firstTone(0), 0);
  assert.ok(Math.abs(firstTone(1) - 1) < 1e-9);
  assert.ok(Math.abs(firstTone(0.42601) - 0.55869) < 1e-6);
  const out = [0, 0, 0];
  firstToneColor(0, 0, 0, out);
  assert.ok(out.every((v) => Math.abs(v) < 1e-6));
  firstToneColor(1, 1, 1, out);
  assert.ok(out.every((v) => Math.abs(v - 1) < 1e-3));
  // Mid grey gets lighter (the curve lifts the mids), and stays grey.
  firstToneColor(0.18, 0.18, 0.18, out);
  assert.ok(out[0] > 0.18 && Math.abs(out[0] - out[1]) < 1e-3 && Math.abs(out[1] - out[2]) < 1e-3);
});

test('first generation colour is clamped before the matrix, not after', () => {
  // A very red pixel: with the strong first generation matrix, an unclamped red would push green and blue negative / out of range.
  const ccm = [3.1115827560424805, -1.9393929243087769, -0.172189861536026, -0.3629055917263031, 1.6408803462982178, -0.27797481417655945, 0.07896701246500015, -1.1558042764663696, 2.0768373012542725];
  const rgb = Float32Array.from([2.0, 0.3, 0.1]);
  const lytro = (pre) => ({ saturation: 1, exact: false, first: true, pre });
  const clamped = toneMap(rgb, ccm, 1, undefined, null, null, null, lytro({ gain: [1, 1, 1], offset: 0 }));
  const unclamped = toneMap(rgb, ccm, 1, undefined, null, null, null, lytro(null));
  // Clamped: red is 1 before the matrix, so the matrix sees (1, 0.3, 0.1): green is lower than with red at 2.
  assert.notDeepEqual(Array.from(clamped.slice(0, 3)), Array.from(unclamped.slice(0, 3)));
  const sane = (px) => px.slice(0, 3).every((v) => v >= 0 && v <= 255);
  assert.ok(sane(clamped) && sane(unclamped));
  // The gain and the black offset act before the clamp: a gain of 0.25 on the same pixel is not clamped at all.
  const small = toneMap(rgb, ccm, 1, undefined, null, null, null, lytro({ gain: [0.25, 0.25, 0.25], offset: 0 }));
  const direct = toneMap(Float32Array.from([0.5, 0.075, 0.025]), ccm, 1, undefined, null, null, null, lytro({ gain: [1, 1, 1], offset: 0 }));
  assert.deepEqual(Array.from(small.slice(0, 3)), Array.from(direct.slice(0, 3)));
});
