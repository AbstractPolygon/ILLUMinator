import test from 'node:test';
import assert from 'node:assert/strict';
import { findPeriodicPeaks, removePeriodicPattern } from '../app/js/core/notch.js';

const W = 640;
const H = 512;

// A smooth scene with fine random texture, and (optionally) a faint pattern.
function picture(pattern) {
  let seed = 7;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const rgb = new Float32Array(W * H * 3);
  const base = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const v = 0.3 + 0.2 * Math.sin(x / 90) * Math.cos(y / 70) + 0.03 * (rand() - 0.5);
      base[y * W + x] = v;
      const p = pattern ? 0.012 * Math.sin(2 * Math.PI * (0.0039 * x + 0.3125 * y)) : 0;
      const q = (v + p) ** 2;
      rgb.set([q, q, q], 3 * (y * W + x));
    }
  }
  return { rgb, base };
}

test('a faint periodic pattern is found and removed, the picture stays', () => {
  const { rgb, base } = picture(true);
  const lum = Float32Array.from({ length: W * H }, (_, i) => Math.sqrt(rgb[3 * i]));
  const found = findPeriodicPeaks(lum, W, H);
  assert.ok(found.length >= 1, 'finds the pattern');
  assert.ok(Math.abs(Math.abs(found[0].fy) - 0.3125) < 0.004, `frequency ${found[0].fy}`);
  removePeriodicPattern(rgb, W, H);
  let before = 0;
  let err = 0;
  for (let i = 0; i < W * H; i++) {
    const v = Math.sqrt(rgb[3 * i]);
    err += (v - base[i]) ** 2;
    before += 0.012 ** 2 / 2;
  }
  // The leftover difference to the scene is far below the pattern's own energy.
  assert.ok(err < before * 0.35, `left ${err / before}`);
});

test('a picture without a pattern is not touched', () => {
  const { rgb } = picture(false);
  const copy = Float32Array.from(rgb);
  const peaks = removePeriodicPattern(rgb, W, H);
  assert.equal(peaks.length, 0);
  assert.deepEqual(rgb, copy);
});

test('a small picture is skipped', () => {
  const rgb = new Float32Array(100 * 100 * 3).fill(0.5);
  assert.deepEqual(removePeriodicPattern(rgb, 100, 100), []);
});
