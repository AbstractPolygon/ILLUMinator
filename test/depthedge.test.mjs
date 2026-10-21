// The depth edge mask the back-projection passes stay out of (core/superres.js).
import test from 'node:test';
import assert from 'node:assert/strict';
import { depthEdgeMask } from '../app/js/core/superres.js';

test('the mask covers a box around a depth step and nothing on a flat surface', () => {
  const w = 40;
  const h = 20;
  const depth = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) depth[y * w + x] = x < 20 ? 0 : 1;
  const mask = depthEdgeMask(depth, w, h, { step: 0.3, radius: 4 });
  assert.equal(mask[10 * w + 19], 1);
  assert.equal(mask[10 * w + 22], 1);
  assert.equal(mask[10 * w + 17], 1);
  assert.ok(mask[10 * w + 14] > 0 && mask[10 * w + 14] < 1);
  assert.equal(mask[10 * w + 3], 0);
  assert.equal(mask[10 * w + 36], 0);
});

test('a gradual slope is not an edge', () => {
  const w = 40;
  const h = 10;
  const depth = Float32Array.from({ length: w * h }, (_, i) => (i % w) * 0.001);
  assert.ok(depthEdgeMask(depth, w, h).every((v) => v === 0));
});
