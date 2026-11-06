// Blown-out highlights have no cost to solve a depth from: they take their surroundings' depth (core/enginedepth.js fillBlownDepth).
import test from 'node:test';
import assert from 'node:assert/strict';
import { fillBlownDepth } from '../app/js/core/enginedepth.js';

test('a blown-out highlight takes the depth around it, not the label of nowhere', () => {
  const w = 60, h = 40;
  const rgb = new Float32Array(w * h * 3).fill(0.4);
  const lam = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) lam[y * w + x] = 10 + 0.1 * x;   // a tilted surface
  // a highlight: blown out, and the solver left garbage in it
  for (let y = 15; y < 25; y++) for (let x = 20; x < 32; x++) { rgb.fill(1, (y * w + x) * 3, (y * w + x) * 3 + 3); lam[y * w + x] = -35; }
  const out = fillBlownDepth(lam, rgb, w, h);
  for (let y = 15; y < 25; y++) for (let x = 20; x < 32; x++) {
    const want = 10 + 0.1 * x;
    assert.ok(Math.abs(out[y * w + x] - want) < 1.0, `(${x}, ${y}): ${out[y * w + x]} for ${want}`);
  }
  // elsewhere untouched
  assert.equal(out[5 * w + 5], lam[5 * w + 5]);
  assert.equal(out[35 * w + 50], lam[35 * w + 50]);
});

test('nothing blown out: the same array back; a picture that is all highlight stays finite', () => {
  const w = 20, h = 10;
  const lam = new Float32Array(w * h).fill(3);
  assert.equal(fillBlownDepth(lam, new Float32Array(w * h * 3).fill(0.2), w, h), lam);
  const all = fillBlownDepth(lam, new Float32Array(w * h * 3).fill(1), w, h);
  for (const v of all) assert.ok(Number.isFinite(v));
});
