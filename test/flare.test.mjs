import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateVeil, veilAt, subtractVeil } from '../app/js/core/flare.js';

const W = 64;
const H = 48;

function image(fn) {
  const rgb = new Float32Array(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const c = fn(x, y);
      rgb.set(c, (y * W + x) * 3);
    }
  }
  return rgb;
}

test('a picture whose darkest value is a lifted black has that value as its veil', () => {
  // texture from 0.1 up to 0.9, so the darkest part of every tile is 0.1
  const rgb = image((x, y) => {
    const v = 0.1 + 0.8 * ((x * 7 + y * 13) % 10) / 9;
    return [v, v, v];
  });
  const veil = estimateVeil(rgb, W, H);
  assert.equal(veil.data.length, veil.tilesX * veil.tilesY * 3);
  const mid = veilAt(veil, 0.5, 0.5);
  for (const c of mid) assert.ok(Math.abs(c - 0.1) < 0.02, `veil ${c}`);
});

test('a true black has no veil, and a flat bright wall is not taken for one in its middle', () => {
  const black = image((x, y) => [((x + y) % 3) * 0.3, ((x * y) % 4) * 0.2, 0.5 * ((x + 2 * y) % 2)]);
  const veil = estimateVeil(black, W, H);
  for (const c of veilAt(veil, 0.5, 0.5)) assert.ok(c < 0.01);
});

test('subtractVeil takes the veil off, never goes below zero, and does nothing for amount 0', () => {
  const rgb = image((x, y) => {
    const v = 0.1 + 0.8 * ((x * 7 + y * 13) % 10) / 9;
    return [v, v, v];
  });
  const veil = estimateVeil(rgb, W, H);
  assert.equal(subtractVeil(rgb, W, H, veil, 0), rgb);
  assert.equal(subtractVeil(rgb, W, H, null, 1), rgb);
  const out = subtractVeil(rgb, W, H, veil, 1);
  assert.notEqual(out, rgb);
  let min = Infinity;
  for (const v of out) min = Math.min(min, v);
  assert.ok(min >= 0);
  assert.ok(min < 0.03, 'the lifted black is back near zero');
  // half the amount takes off half of it
  const half = subtractVeil(rgb, W, H, veil, 0.5);
  const i = (24 * W + 32) * 3;
  assert.ok(Math.abs((rgb[i] - half[i]) - (rgb[i] - out[i]) / 2) < 1e-6);
});

test('veilAt is bilinear: constant tiles give a constant veil everywhere', () => {
  const veil = { tilesX: 16, tilesY: 12, data: new Float32Array(16 * 12 * 3).fill(0.2) };
  for (const [x, y] of [[0, 0], [1, 1], [0.5, 0.5], [0.03, 0.97]]) {
    for (const c of veilAt(veil, x, y)) assert.ok(Math.abs(c - 0.2) < 1e-6);
  }
});
