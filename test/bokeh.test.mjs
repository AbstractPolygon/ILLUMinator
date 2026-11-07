import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bokehKernel, kernelDistance, applyDepthOfField } from '../app/js/core/dof.js';

test('blades: corner up at radius 1, flat sides closer', () => {
  const k = bokehKernel({ shape: 'blades', blades: 6 });
  assert.ok(Math.abs(kernelDistance(k, 0, 1) - 1) < 1e-9);
  assert.ok(Math.abs(kernelDistance(k, Math.cos(Math.PI / 6), 0) - 1) < 1e-9);
  // Five blades rotated by half a segment put a flat side on top.
  const k5 = bokehKernel({ shape: 'blades', blades: 5, rotation: 36 });
  assert.ok(kernelDistance(k5, 0, Math.cos(Math.PI / 5)) < 1 + 1e-9);
  assert.equal(bokehKernel({ shape: 'hexagon' }).blades, 6);
});

test('blades: from 3 to 32, and a 32-sided shape is nearly round', () => {
  assert.equal(bokehKernel({ shape: 'blades', blades: 2 }).blades, 3);
  assert.equal(bokehKernel({ shape: 'blades', blades: 32 }).blades, 32);
  assert.equal(bokehKernel({ shape: 'blades', blades: 99 }).blades, 32);
  const k = bokehKernel({ shape: 'blades', blades: 32 });
  // Flat sides sit at cos(180/32) = 0.9952 of the corner radius.
  assert.ok(Math.abs(kernelDistance(k, 0, 1) - 1) < 1e-9);
  assert.ok(kernelDistance(k, 1, 0) > 0.995 && kernelDistance(k, 1, 0) < 1.005);
});

test('oval narrows the circle and turns with rotation', () => {
  const k = bokehKernel({ shape: 'circle', oval: 1 });
  assert.ok(kernelDistance(k, 0.5, 0) > 1);
  assert.ok(kernelDistance(k, 0, 0.9) < 1);
  const t = bokehKernel({ shape: 'circle', oval: 1, rotation: 90 });
  assert.ok(kernelDistance(t, 0.9, 0) < 1 + 1e-9);
  assert.ok(kernelDistance(t, 0, 0.5) > 1);
});

test('onion rings keep a point light bright and finite', () => {
  const w = 41, h = 41;
  const rgb = new Float32Array(w * h * 3);
  rgb.fill(0.1);
  rgb.set([1, 1, 1], (20 * w + 20) * 3);
  const depth = new Float32Array(w * h).fill(1);
  for (const opts of [{ shape: 'circle', onion: 1 }, { shape: 'blades', blades: 7, rotation: 20, onion: 0.5 }, { shape: 'circle', oval: 0.5 }]) {
    const out = applyDepthOfField(rgb, w, h, depth, w, h, 0, 0.5, 14, opts);
    assert.ok(out.every(Number.isFinite));
    assert.ok(out[(20 * w + 20) * 3] < 1);
  }
});

test('refocus prefers views that did not clip', async () => {
  const { refocus, clipTrust } = await import('../app/js/core/render.js');
  const w = 4, h = 4;
  const mk = (val) => new Float32Array(w * h * 3).fill(val);
  const clipped = mk(1);
  const edge = mk(1.6); // a vignetted view, scaled back up: past the clip
  const views = [
    { u: 0, v: 0, rgb: clipped, gain: 1, detail: 1, trust: clipTrust(clipped, 1) },
    { u: 0, v: 0, rgb: edge, gain: 1, detail: 1, trust: clipTrust(mk(0.8), 1) },
  ];
  const out = refocus(views, w, h, 0);
  assert.ok(out[0] > 1.5, `got ${out[0]}`);
});

test('spread blur feathers the blur radius map and leaves the sharp range sharp', () => {
  const w = 41, h = 9;
  const rgb = new Float32Array(w * h * 3);
  for (let i = 0; i < w * h; i++) rgb.fill(0.1 + 0.8 * ((i % w) % 2), i * 3, i * 3 + 3);   // fine stripes: blur shows as lost contrast
  // the left half of the picture is in focus (depth 0), the right half far behind it
  const depth = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 20; x < w; x++) depth[y * w + x] = 1.2;
  const contrast = (img, x) => { let m = 0; for (let y = 0; y < h; y++) m += Math.abs(img[(y * w + x) * 3] - img[(y * w + x + 1) * 3]); return m / h; };
  const hard = applyDepthOfField(rgb, w, h, depth, w, h, 0, 1, 4, { spread: 0.5 });
  const feathered = applyDepthOfField(rgb, w, h, depth, w, h, 0, 1, 4, { spread: 0.5, feather: 8 });
  // far from the edge nothing changes: the sharp side stays sharp, the blurred side is as blurred
  assert.ok(Math.abs(contrast(hard, 2) - contrast(feathered, 2)) < 1e-6);
  assert.ok(Math.abs(contrast(hard, 38) - contrast(feathered, 38)) < 0.02);
  // at the edge the sharp-to-blur change is gradual: a step with the hard map, a ramp when feathered
  const step = (img) => Math.abs(contrast(img, 17) - contrast(img, 23));
  const ramp = (img, x) => contrast(img, x);
  assert.ok(ramp(feathered, 17) < ramp(hard, 17) - 0.05, 'blur starts inside the sharp range');
  assert.ok(ramp(feathered, 23) > ramp(hard, 23) + 0.0 || step(feathered) <= step(hard));
});
