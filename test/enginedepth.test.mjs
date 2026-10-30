import test from 'node:test';
import assert from 'node:assert/strict';
import { engineCostVolume, engineAggregate, engineTrws, engineDepthMap, engineLabels } from '../app/js/core/enginedepth.js';

const W = 24;
const H = 20;
const flat = (r, g = r, b = r) => { const v = new Float32Array(W * H * 3); for (let i = 0; i < W * H; i++) { v[3 * i] = r; v[3 * i + 1] = g; v[3 * i + 2] = b; } return v; };
// the engine's own responses, measured by driving its cost function with synthetic views (docs/lytro-re-notes.md)
test('depth cost: the four largest truncated differences, times 1.25, capped by 0.2 per view', () => {
  const labels = [-3, -2, -1, 0, 1, 2, 3, 4];
  const check = (views, expect) => { const c = engineCostVolume(views, W, H, labels, { truncate: 0.2, scale: 1.25, top: 4, blownOut: 0.95, noisy: -1, noisyQuantile: 0.5 }); const i = (10 * W + 12) * labels.length; assert.ok(Math.abs(c[i] - expect) < 1e-6, `${c[i]} vs ${expect}`); };
  check([...Array(8).fill(0).map(() => flat(0.3)), flat(0.32, 0.3, 0.3)], 1.25 * 4 * 0.02); // the centre differs: all eight views see it, four count
  const one = [...Array(8).fill(0).map(() => flat(0.3)), flat(0.3)]; one[2] = flat(0.32, 0.3, 0.3);
  check(one, 1.25 * 0.02); // one view differs
  check([...Array(8).fill(0).map(() => flat(0.3)), flat(0.8)], 1.0); // each view's term stops at 0.2
});

test('depth: the whole chain keeps a flat scene at one label', () => {
  const labels = engineLabels(1);
  assert.equal(labels.length % 4, 0);
  const views = Array.from({ length: 9 }, (_, k) => { const v = flat(0.4); for (let i = 0; i < W * H; i++) v[3 * i] += 0.01 * Math.sin(i * 0.7); return v; });
  const d = engineDepthMap(views, W, H, labels);
  assert.equal(d.length, W * H);
  for (const x of d) assert.ok(x >= -35.5 && x <= labels[labels.length - 1] + 0.5);
});

test('aggregation of a constant volume is the constant; message passing prefers the cheap label', () => {
  const L = 4;
  const vol = new Float32Array(W * H * L);
  for (let i = 0; i < W * H; i++) for (let l = 0; l < L; l++) vol[i * L + l] = l === 2 ? 0.1 : 0.7;
  const agg = engineAggregate(vol, flat(0.5), W, H, L);
  assert.ok(Math.abs(agg[5 * L + 2] - 0.1) < 1e-6);
  const best = engineTrws(agg, new Float32Array(W * H).fill(1), new Float32Array(W * H).fill(1), W, H, L);
  assert.ok(best.every((b) => b === 2));
});
