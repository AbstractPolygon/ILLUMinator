// The engine's saturation recovery (SaturationState + SaturationRecoveryDiffusion, core/lytroedof.js diffuseSaturation).
import test from 'node:test';
import assert from 'node:assert/strict';
import { diffuseSaturation } from '../app/js/core/lytroedof.js';

const W = 16;
const H = 16;
const cam = { width: W, height: H, white: [1023, 1023, 1023] };
const dev = { cfa: [[0, 1], [1, 2]] }; // RGGB: green where x + y is odd

function setup(level, at) {
  const raw = new Uint16Array(W * H).fill(500);
  const a = new Float32Array(W * H).fill(1);
  raw[at] = level;
  a[at] = 0.2;
  return { raw, a };
}

test('the mask is raw / white > 0.98: 1002 is not saturated, 1003 is', () => {
  const at = 8 * W + 8; // x 8, y 8: red site
  const lo = setup(1002, at);
  diffuseSaturation(lo.a, lo.raw, cam, dev);
  assert.equal(lo.a[at], Math.fround(0.2));
  const hi = setup(1003, at);
  diffuseSaturation(hi.a, hi.raw, cam, dev);
  assert.equal(hi.a[at], 1);
});

test('a masked red or blue site takes the pixels two away, a green site the diagonals', () => {
  const red = 8 * W + 8;
  const t = setup(1023, red);
  t.a[red - 2] = 3; t.a[red + 2] = 3; t.a[red - 2 * W] = 3; t.a[red + 2 * W] = 3; // the four same colour neighbours
  t.a[red - 1] = 100; t.a[red - W] = 100; t.a[red - W - 1] = 100; // other colours must not count
  diffuseSaturation(t.a, t.raw, cam, dev);
  assert.equal(t.a[red], 3);
  const green = 8 * W + 9; // x 9, y 8
  const g = setup(1023, green);
  g.a[green - W - 1] = 2; g.a[green - W + 1] = 2; g.a[green + W - 1] = 2; g.a[green + W + 1] = 2;
  g.a[green - 2] = 100; g.a[green + 2] = 100;
  diffuseSaturation(g.a, g.raw, cam, dev);
  assert.equal(g.a[green], 2);
});

test('a masked pixel is never lowered, and unmasked pixels are untouched', () => {
  const at = 8 * W + 8;
  const t = setup(1023, at);
  t.a[at] = 5;
  const before = Float32Array.from(t.a);
  diffuseSaturation(t.a, t.raw, cam, dev);
  assert.deepEqual(t.a, before);
});

test('in-place raster sweeps carry a value across a masked run in one pass of 20', () => {
  const raw = new Uint16Array(W * H).fill(500);
  const a = new Float32Array(W * H).fill(0.1);
  // a masked row of red sites (even x) at y 8, x 2..12; the unmasked red site at x 0 is bright
  for (let x = 2; x <= 12; x += 2) raw[8 * W + x] = 1023;
  a[8 * W + 0] = 4;
  for (let x = 1; x < W; x++) if (x % 2 === 0 && x > 12) a[8 * W + x] = 0.1;
  diffuseSaturation(a, raw, cam, dev);
  // the bright site at x 0 feeds x 2 first (at least (4 + 0.3) / 4 after the first sweep), then x 4, x 6 ... in turn: monotone decay along the run
  const run = [2, 4, 6, 8, 10, 12].map((x) => a[8 * W + x]);
  assert.ok(run[0] > 1.075, String(run[0]));
  for (let k = 1; k < run.length; k++) assert.ok(run[k] < run[k - 1] && run[k] > 0.1, `${k}: ${run}`);
});
