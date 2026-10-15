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

test('spread blur softens the sharp range too', () => {
  const w = 21, h = 21;
  const rgb = new Float32Array(w * h * 3).fill(0.1);
  rgb.set([1, 1, 1], (10 * w + 10) * 3);
  const depth = new Float32Array(w * h).fill(0); // all in focus
  const sharp = applyDepthOfField(rgb, w, h, depth, w, h, 0, 1, 14, { spread: 0.5 });
  const soft = applyDepthOfField(rgb, w, h, depth, w, h, 0, 1, 14, { spread: 0.5, blur: 3 });
  assert.equal(sharp[(10 * w + 10) * 3], 1);
  assert.ok(soft[(10 * w + 10) * 3] < 0.9);
});
