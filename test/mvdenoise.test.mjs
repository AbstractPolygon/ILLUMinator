import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeViews, mergeSigma } from '../app/js/core/mvdenoise.js';

function rng(seed) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647) - 0.5;
}

// A flat gray scene seen by 9 views, each with its own noise.
function scene(w, h, n, noise, seed = 7) {
  const rnd = rng(seed);
  return Array.from({ length: n }, (_, k) => {
    const rgb = new Float32Array(w * h * 3);
    for (let i = 0; i < rgb.length; i++) rgb[i] = 0.3 + noise * rnd();
    return { u: (k % 3) - 1, v: Math.floor(k / 3) - 1, rgb, gain: 1 };
  });
}

const variance = (a) => {
  const m = a.reduce((x, y) => x + y, 0) / a.length;
  return a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length;
};

test('merging views averages noise away', () => {
  const w = 24;
  const views = scene(w, w, 9, 0.04);
  const depth = new Float32Array(w * w);
  const ref = views[4].rgb;
  const out = mergeViews(views, w, w, depth, ref, { sigma: mergeSigma(0.3), blend: 1 });
  assert.ok(variance(Array.from(out)) < 0.25 * variance(Array.from(ref)));
});

test('blend 0 keeps the original view', () => {
  const w = 8;
  const views = scene(w, w, 9, 0.04);
  const out = mergeViews(views, w, w, new Float32Array(w * w), views[4].rgb, { sigma: 0.05, blend: 0 });
  assert.deepEqual(Array.from(out), Array.from(views[4].rgb));
});

test('views that disagree (occlusion) are weighted down', () => {
  const w = 8;
  const views = scene(w, w, 9, 0);
  // One view sees something bright in front.
  views[0].rgb.fill(3);
  const out = mergeViews(views, w, w, new Float32Array(w * w), views[4].rgb, { sigma: mergeSigma(0.3), blend: 1 });
  assert.ok(Math.abs(out[0] - 0.3) < 0.01, `got ${out[0]}`);
});

test('views are aligned by depth', () => {
  // A vertical bright line; at depth a, view k sees it shifted by a * u_k.
  const w = 16;
  const a = 2;
  const views = [-1, 0, 1].map((u) => {
    const rgb = new Float32Array(w * w * 3).fill(0.1);
    for (let y = 0; y < w; y++) rgb.fill(1, 3 * (y * w + 8 + a * u), 3 * (y * w + 8 + a * u) + 3);
    return { u, v: 0, rgb, gain: 1 };
  });
  const depth = new Float32Array(w * w).fill(a);
  const out = mergeViews(views, w, w, depth, views[1].rgb, { sigma: mergeSigma(0.3), blend: 1 });
  assert.ok(out[3 * (4 * w + 8)] > 0.99 && out[3 * (4 * w + 6)] < 0.11, 'line stays sharp');
});
