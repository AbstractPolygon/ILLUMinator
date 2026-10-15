import { test } from 'node:test';
import assert from 'node:assert/strict';
import { removeSpeckles } from '../app/js/core/detail.js';

const W = 12, H = 12;
const img = (pixels) => {
  const rgb = new Float32Array(W * H * 3).fill(0.04);
  for (const [x, y] of pixels) rgb.set([1, 1, 1], (y * W + x) * 3);
  return rgb;
};
const at = (rgb, x, y) => rgb[(y * W + x) * 3];

test('removes single pixels and 2 x 2 clumps', () => {
  const out = removeSpeckles(img([[3, 3], [7, 7], [8, 7], [7, 8], [8, 8]]), W, H, { speckle: 1, speckleSize: 2 });
  for (const [x, y] of [[3, 3], [7, 7], [8, 8]]) assert.ok(at(out, x, y) < 0.1, `${x},${y}`);
});

test('keeps one-pixel lines', () => {
  const line = [...Array(W)].map((_, x) => [x, 5]);
  const out = removeSpeckles(img(line), W, H, { speckle: 1, speckleSize: 5 });
  for (let x = 1; x < W - 1; x++) assert.equal(at(out, x, 5), 1);
});

test('size 1 leaves 2 x 2 clumps', () => {
  const out = removeSpeckles(img([[7, 7], [8, 7], [7, 8], [8, 8]]), W, H, { speckle: 1, speckleSize: 1 });
  assert.equal(at(out, 7, 7), 1);
});
