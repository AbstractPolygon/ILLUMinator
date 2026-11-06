import test from 'node:test';
import assert from 'node:assert/strict';
import { guideDepthEdges } from '../app/js/core/depthguide.js';

test("Lytro's regions get our depth: edges from the guide, values from ours", () => {
  const W = 40, H = 20;
  const guide = new Float32Array(W * H);
  const ours = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    guide[y * W + x] = x < 20 ? -1 : 0.5;               // two flat regions, a sharp edge at x = 20
    ours[y * W + x] = x < 20 ? -0.2 : 0.5 + 0.001 * (x - 30); // ours: the left part is nearer than Lytro puts it; the edge is soft
  }
  for (let y = 0; y < H; y++) { ours[y * W + 19] = -0.1; ours[y * W + 20] = 0.1; } // a soft edge
  const out = guideDepthEdges(ours, guide, W, H);
  for (let y = 0; y < H; y++) {
    assert.ok(Math.abs(out[y * W + 5] - -0.2) < 1e-6, 'left region takes our value, not -1');
    assert.equal(out[y * W + 19], out[y * W + 5], 'the edge is where the guide has it');
    assert.equal(out[y * W + 20], out[y * W + 30], 'right region is flat');
  }
});

test('regions smaller than the minimum keep our depth', () => {
  const W = 20, H = 10;
  const guide = new Float32Array(W * H).fill(1);
  guide[5 * W + 5] = 9;                                 // a one pixel region
  const ours = Float32Array.from({ length: W * H }, (_, i) => 0.3 + (i % 3) * 0.01);
  const out = guideDepthEdges(ours, guide, W, H, { minSize: 4 });
  assert.equal(out[5 * W + 5], ours[5 * W + 5]);
});

import { shapeDepthContrast } from '../app/js/core/depth.js';

test('depth map contrast reshapes the depth: none leaves it, more pulls the ends in and steepens the middle', () => {
  const n = 1001;
  const depth = Float32Array.from({ length: n }, (_, i) => -1 + (2 * i) / (n - 1));
  assert.equal(shapeDepthContrast(depth, 0), depth);
  const half = shapeDepthContrast(depth, 0.5);
  const full = shapeDepthContrast(depth, 1);
  // monotone, same order
  for (let i = 1; i < n; i++) assert.ok(half[i] >= half[i - 1] && full[i] >= full[i - 1]);
  // the ends are flattened (the extreme depths take the same value), the middle is steeper than the original
  assert.equal(full[0], full[100]);
  assert.ok(full[n - 1] === full[n - 101]);
  const slope = (d, i) => (d[i + 10] - d[i]) / 10;
  assert.ok(slope(full, 500) > slope(depth, 500) * 1.4, `${slope(full, 500)} vs ${slope(depth, 500)}`);
  // the middle stays in the middle
  assert.ok(Math.abs(full[500]) < 1e-3);
  // more contrast, more of the range flattened at the ends
  assert.ok(full[100] > half[100] || full[100] === half[100]);
});

import { despeckleDepth } from '../app/js/core/depth.js';

test('despeckle replaces small isolated depth patches and keeps real structure', () => {
  const w = 80, h = 60;
  const depth = new Float32Array(w * h).fill(0);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) depth[y * w + x] = 0.1 * (x / w);
  // a speck: a few pixels far from their surroundings
  for (let y = 20; y < 23; y++) for (let x = 30; x < 33; x++) depth[y * w + x] = 1;
  // a real object: a big near block
  for (let y = 35; y < 55; y++) for (let x = 50; x < 75; x++) depth[y * w + x] = 1;
  const out = despeckleDepth(depth, w, h);
  assert.ok(Math.abs(out[21 * w + 31] - 0.04) < 0.05, `speck left: ${out[21 * w + 31]}`);
  assert.equal(out[45 * w + 60], 1);
  // untouched elsewhere
  assert.equal(out[5 * w + 5], depth[5 * w + 5]);
  // a flat picture comes back as it is
  const flat = new Float32Array(w * h).fill(2);
  assert.equal(despeckleDepth(flat, w, h), flat);
});

import { highlightMask, finishDepth } from '../app/js/core/depth.js';

test('highlightMask marks glints and a margin around them, not smooth areas', () => {
  const w = 40;
  const h = 40;
  const guide = new Float32Array(w * h).fill(0.3);
  guide[20 * w + 20] = 1;
  const mask = highlightMask(guide, w, h, { radius: 6, lift: 0.07, grow: 2 });
  assert.equal(mask[20 * w + 20], 1);
  assert.equal(mask[22 * w + 22], 1, 'margin');
  assert.equal(mask[5 * w + 5], 0);
  assert.equal(highlightMask(new Float32Array(w * h).fill(0.3), w, h)[20 * w + 20], 0);
});

test('depth under a glint is taken from its surroundings, however convincing its match looks', () => {
  const w = 60;
  const h = 60;
  const n = w * h;
  const guide = new Float32Array(n).fill(0.4);
  const alpha = new Float32Array(n).fill(0.1);
  const cost = new Float32Array(n).fill(0.1);
  const meanCost = new Float32Array(n).fill(1);
  for (let y = 24; y < 36; y++) {
    for (let x = 24; x < 36; x++) {
      guide[y * w + x] = 1;
      alpha[y * w + x] = 1.4; // a wrong depth with a pronounced minimum
      cost[y * w + x] = 0;
    }
  }
  const out = finishDepth({ alpha, cost, meanCost }, w, h, guide, { refine: false });
  assert.ok(Math.abs(out.alpha[30 * w + 30] - 0.1) < 0.15, `depth at the glint ${out.alpha[30 * w + 30]}`);
});
