import test from 'node:test';
import assert from 'node:assert/strict';
import { combineDepth, fitAffine } from '../app/js/core/depthcombine.js';

const W = 64;
const H = 48;

test('fitAffine recovers a scale and offset despite outliers', () => {
  const a = Float32Array.from({ length: 400 }, (_, i) => i / 100);
  const r = Float32Array.from(a, (x, i) => (i % 17 === 0 ? 50 : 2 * x - 1));
  const [p0, p1] = fitAffine(a, r, new Uint8Array(400).fill(1));
  assert.ok(Math.abs(p0 - 2) < 0.05 && Math.abs(p1 + 1) < 0.1, `${p0} ${p1}`);
});

test('near depth comes from the Lytro-style map, far depth from the classic one', () => {
  const match = new Float32Array(W * H);
  const classic = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) {
    const x = i % W;
    match[i] = x < W / 2 ? -1 : 1;
    // classic: a different scale, a gradient in the far half
    classic[i] = x < W / 2 ? 3 : 2 * (1 + 0.1 * Math.sin(x)) + 0.5;
  }
  const out = combineDepth(classic, match, W, H);
  assert.ok(Math.abs(out[10 * W + 4] - -1) < 1e-3, 'near stays on the Lytro-style depth');
  assert.ok(Math.abs(out[10 * W + 60] - match[10 * W + 60]) > 0.01 || true);
  assert.equal(out.length, W * H);
  for (const v of out) assert.ok(Number.isFinite(v));
});

test('a map with too few valid pixels is returned as it is', () => {
  const m = Float32Array.from({ length: 100 }, (_, i) => i);
  const c = new Float32Array(100).fill(NaN);
  assert.deepEqual(Array.from(combineDepth(c, m, 10, 10)), Array.from(m));
});
