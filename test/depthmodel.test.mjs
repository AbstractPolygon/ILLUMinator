// Monocular depth models (core/depthmodels.js, core/depthmodel.js): the model list, the model's input, and the fit of its relative depth to the measured depth.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEPTH_MODELS, depthModelMethod, methodDepthModel } from '../app/js/core/depthmodels.js';
import { modelInput, resampleMap, fitModelDepth, fuseModelDepth } from '../app/js/core/depthmodel.js';

test('the models are listed with their pinned files and a method value', () => {
  assert.deepEqual(DEPTH_MODELS.map((m) => m.id), ['da2-small', 'midas-small']);
  for (const m of DEPTH_MODELS) {
    assert.match(m.sha256, /^[0-9a-f]{64}$/);
    assert.match(m.url, /^https:\/\/huggingface\.co\/.*\/resolve\/[0-9a-f]{40}\//);
    assert.ok(m.size > 1e7);
    assert.equal(methodDepthModel(depthModelMethod(m.id)), m);
  }
  assert.equal(methodDepthModel('classic'), null);
  assert.equal(methodDepthModel('model:nothing'), null);
});

test('the model input is planar, normalised, of the model size', () => {
  const m = DEPTH_MODELS[1];
  const w = 40, h = 30;
  const rgb = new Float32Array(w * h * 3);
  for (let i = 0; i < w * h; i++) rgb.fill((i % w) / w, i * 3, i * 3 + 3);
  const inp = modelInput(m, rgb, w, h);
  assert.equal(inp.length, 3 * m.input * m.input);
  // a left to right ramp: increasing along x, the same on every row, in the normalised range
  const S = m.input;
  assert.ok(inp[S - 1] > inp[0]);
  assert.ok(Math.abs(inp[5 * S + 10] - inp[200 * S + 10]) < 1e-5);
  let lo = Infinity, hi = -Infinity;
  for (const v of inp) { if (v < lo) lo = v; if (v > hi) hi = v; }
  assert.ok(lo >= -2.2 && hi <= 2.7);
});

test('resampling a map keeps its values', () => {
  const S = 8;
  const map = Float32Array.from({ length: S * S }, (_, i) => i % S);
  const big = resampleMap(map, S, 32, 32);
  assert.ok(Math.abs(big[0]) < 0.5 && Math.abs(big[31] - 7) < 0.5);
  assert.ok(Math.abs(big[16 * 32 + 16] - 3.5) < 0.6);
});

test('the fit finds the measurement in the model, robust to where they disagree', () => {
  const w = 120, h = 80;
  const truth = new Float32Array(w * h);
  const rel = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const d = -2 + 4 * (x / w) + (x > 60 && y > 30 ? 1.5 : 0);
    truth[y * w + x] = d;
    rel[y * w + x] = -(d - 0.3) * 0.5 + 10;          // a relative depth: reversed, another scale and offset
  }
  // the measurement is wrong in a patch (a highlight): the fit must not follow it
  const measured = Float32Array.from(truth);
  for (let y = 5; y < 20; y++) for (let x = 5; x < 25; x++) measured[y * w + x] = 9;
  const fit = fitModelDepth(rel, measured, null, w, h);
  assert.ok(fit && fit.a < 0);
  const fused = fuseModelDepth(measured, rel, fit, 1);
  let worst = 0;
  for (let y = 30; y < 75; y++) for (let x = 30; x < 115; x++) worst = Math.max(worst, Math.abs(fused[y * w + x] - truth[y * w + x]));
  assert.ok(worst < 0.2, `worst ${worst}`);
  // the patch takes the model's depth instead of the bad measurement (blend 1), and nothing changes at blend 0
  assert.ok(Math.abs(fused[10 * w + 10] - truth[10 * w + 10]) < 0.5, `${fused[10 * w + 10]} for ${truth[10 * w + 10]}`);
  assert.equal(fuseModelDepth(measured, rel, fit, 0), measured);
  // half way is half way
  const half = fuseModelDepth(measured, rel, fit, 0.5);
  assert.ok(Math.abs(half[10 * w + 10] - (measured[10 * w + 10] + fused[10 * w + 10]) / 2) < 1e-4);
  // a flat model has nothing to fit
  assert.equal(fitModelDepth(new Float32Array(w * h), measured, null, w, h), null);
});
