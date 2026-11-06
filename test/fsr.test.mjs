import test from 'node:test';
import assert from 'node:assert/strict';
import { rcasStrength, easu, rcas } from '../app/js/core/fsr.js';

function rgba(w, h, fn) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = fn(x, y);
      data.set([r, g, b, 255], (y * w + x) * 4);
    }
  }
  return { width: w, height: h, data };
}

test('rcasStrength: 0 is none, 1 is the strongest, and it only rises in between', () => {
  assert.equal(rcasStrength(0), 0);
  assert.equal(rcasStrength(1), 1);
  let last = 0;
  for (let s = 0.1; s <= 1.0001; s += 0.1) {
    const v = rcasStrength(s);
    assert.ok(v > last, `strength at ${s}`);
    last = v;
  }
});

test('easu enlarges to the asked size, keeps a flat color flat and sets alpha to 1', () => {
  const out = easu(rgba(8, 6, () => [51, 102, 204]), 16, 12);
  assert.equal(out.length, 16 * 12 * 4);
  for (let i = 0; i < out.length; i += 4) {
    assert.ok(Math.abs(out[i] - 0.2) < 1e-3 && Math.abs(out[i + 1] - 0.4) < 1e-3 && Math.abs(out[i + 2] - 0.8) < 1e-3);
    assert.equal(out[i + 3], 1);
  }
});

test('easu keeps a vertical edge in place and does not overshoot past its two sides', () => {
  const img = rgba(10, 6, (x) => (x < 5 ? [40, 40, 40] : [200, 200, 200]));
  const out = easu(img, 20, 12);
  const row = (y) => Array.from({ length: 20 }, (_, x) => out[(y * 20 + x) * 4]);
  const r = row(6);
  assert.ok(r[0] < 0.2 && r[19] > 0.75, 'dark left, bright right');
  assert.ok(r.every((v) => v >= 40 / 255 - 1e-3 && v <= 200 / 255 + 1e-3), 'no overshoot');
  // monotone across the edge: the enlarged edge is not reversed anywhere
  for (let x = 1; x < 20; x++) assert.ok(r[x] >= r[x - 1] - 1e-3);
});

test('rcas with no sharpness only converts to bytes; with sharpness a flat field stays flat and an edge gets crisper', () => {
  const W = 12;
  const H = 6;
  const src = new Float32Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) src.set([x < 6 ? 0.3 : 0.6, x < 6 ? 0.3 : 0.6, x < 6 ? 0.3 : 0.6, 1], (y * W + x) * 4);
  }
  const plain = rcas(src, W, H, 0);
  assert.equal(plain[(3 * W + 2) * 4], Math.round(0.3 * 255));
  assert.equal(plain[(3 * W + 2) * 4 + 3], 255);
  const sharp = rcas(src, W, H, 1);
  // flat parts away from the edge unchanged
  assert.equal(sharp[(3 * W + 1) * 4], plain[(3 * W + 1) * 4]);
  // beside the edge the dark side gets darker and the bright side brighter
  assert.ok(sharp[(3 * W + 5) * 4] <= plain[(3 * W + 5) * 4]);
  assert.ok(sharp[(3 * W + 6) * 4] >= plain[(3 * W + 6) * 4]);
  assert.ok(sharp[(3 * W + 5) * 4] < plain[(3 * W + 5) * 4] || sharp[(3 * W + 6) * 4] > plain[(3 * W + 6) * 4]);
});
