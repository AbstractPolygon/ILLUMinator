import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDetail, applyDetail } from '../app/js/core/detail.js';

function noisy(w, h, seed = 1) {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647) - 0.5;
  const rgb = new Float32Array(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    const base = 0.25 + 0.05 * rnd();
    rgb[3 * i] = base + 0.05 * rnd();
    rgb[3 * i + 1] = base;
    rgb[3 * i + 2] = base + 0.05 * rnd();
  }
  return rgb;
}

const lumaVar = (rgb) => {
  const y = [];
  for (let i = 0; i < rgb.length; i += 3) y.push(0.2126 * rgb[i] + 0.7152 * rgb[i + 1] + 0.0722 * rgb[i + 2]);
  const m = y.reduce((a, b) => a + b, 0) / y.length;
  return y.reduce((a, b) => a + (b - m) ** 2, 0) / y.length;
};
const chromaVar = (rgb) => {
  let s = 0;
  for (let i = 0; i < rgb.length; i += 3) s += (rgb[i] - rgb[i + 2]) ** 2;
  return s / (rgb.length / 3);
};

test('details are off by default', () => {
  assert.equal(makeDetail({ details: { detail: 25, radius: 1 } }), null);
});

test('luminance noise reduction smooths brightness', () => {
  const rgb = noisy(32, 32);
  const out = applyDetail(rgb, 32, 32, makeDetail({ details: { luminance: 80 } }));
  assert.ok(lumaVar(out) < 0.6 * lumaVar(rgb));
});

test('color noise reduction smooths color, not brightness', () => {
  const rgb = noisy(32, 32);
  const out = applyDetail(rgb, 32, 32, makeDetail({ details: { color: 80 } }));
  assert.ok(chromaVar(out) < 0.3 * chromaVar(rgb));
  assert.ok(Math.abs(lumaVar(out) - lumaVar(rgb)) < 0.05 * lumaVar(rgb));
});

test('sharpening increases edge contrast', () => {
  const w = 16;
  const rgb = new Float32Array(w * w * 3);
  for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) rgb.fill(x < 8 ? 0.1 : 0.4, 3 * (y * w + x), 3 * (y * w + x) + 3);
  const out = applyDetail(rgb, w, w, makeDetail({ details: { amount: 100, radius: 1, detail: 100 } }));
  const at = (x) => out[3 * (8 * w + x) + 1];
  assert.ok(at(7) < 0.1 && at(8) > 0.4, `edge ${at(7)} ${at(8)}`);
  assert.ok(Math.abs(at(1) - 0.1) < 1e-4, 'flat areas unchanged');
});

const flat = (w, h, v = 0.3) => new Float32Array(w * h * 3).fill(v);

test('speckles: a hot pixel is clamped, a flat image is untouched', () => {
  const w = 16;
  const rgb = flat(w, w);
  const i = 3 * (8 * w + 8);
  rgb[i] = rgb[i + 1] = rgb[i + 2] = 1;
  const out = applyDetail(rgb, w, w, makeDetail({ details: { speckle: 50 } }));
  assert.ok(Math.abs(out[i] - 0.3) < 1e-6);
  assert.ok(Math.abs(out[3 * 2] - 0.3) < 1e-6);
});

test('dust: a faint dark spot is lifted, a strong dark mark is kept', () => {
  const w = 48;
  const rgb = flat(w, w, 0.5);
  const set = (cx, cy, v) => {
    for (let y = cy - 2; y <= cy + 2; y++) for (let x = cx - 2; x <= cx + 2; x++) rgb.fill(v, 3 * (y * w + x), 3 * (y * w + x) + 3);
  };
  set(12, 12, 0.4); // faint dust
  set(36, 36, 0.05); // dark detail
  const out = applyDetail(rgb, w, w, makeDetail({ details: { dust: 50 } }));
  assert.ok(out[3 * (12 * w + 12)] > 0.47, `dust ${out[3 * (12 * w + 12)]}`);
  assert.ok(out[3 * (36 * w + 36)] < 0.1, `detail ${out[3 * (36 * w + 36)]}`);
  assert.ok(Math.abs(out[3 * (1 * w + 1)] - 0.5) < 1e-6);
});

import { detailForSize } from '../app/js/core/detail.js';

test('sharpening radius grows with pixels per lens so big renders look the same', () => {
  const p = { amount: 0.7, radius: 1 };
  assert.equal(detailForSize(p, 615, 615).radius, 1);
  assert.equal(detailForSize(p, 1230, 615).radius, 1);
  assert.equal(detailForSize(p, 1845, 615).radius, 1.5);
  assert.equal(detailForSize(p, 2460, 615).radius, 2);
  assert.equal(detailForSize(null, 2460, 615), null);
});

test('engine unsharp mask: per-lambda tables, gain table and the parameter map', async () => {
  const { engineUsmMap, engineUnsharp, totalGain, ENGINE_USM } = await import('../app/js/core/detail.js');
  // the tables are the engine's, piecewise linear: radius 0.36 in focus, 0.4 far out; amount 0.5 at lambda -3, 0.45 at -8; gain 3.0 at 1, 1.7 at 32
  const flat = (l, gain) => engineUsmMap(new Float32Array(4).fill(l), 2, 2, gain).data;
  const near = flat(-3, 1);
  assert.ok(Math.abs(near[0] - 0.36) < 1e-6 && Math.abs(near[1] - 0.5 * 3.0) < 1e-6, `${near[0]} ${near[1]}`);
  assert.ok(Math.abs(flat(-20, 1)[0] - 0.4) < 1e-6);
  assert.ok(Math.abs(flat(-6, 8)[1] - 0.47 * (2 + (1.7 - 2) * (8 - 3) / 29)) < 1e-5);
  // total gain: analog gain, digital gain only above ISO 640
  assert.equal(totalGain({ capture: { analogGain: 8, iso: 80 } }), 8);
  assert.equal(totalGain({ capture: { analogGain: 1, iso: 1280 } }), 2);
  assert.equal(totalGain({}), 1);
  // a step edge gains overshoot on both sides, a flat picture is untouched, and a weaker gain-8 amount overshoots less
  const w = 2022; // the engine's width: the blur is about 1.4 px
  const h = 4;
  const edge = () => {
    const px = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) px.set([i % w < w / 2 ? 90 : 160, i % w < w / 2 ? 90 : 160, i % w < w / 2 ? 90 : 160, 255], 4 * i);
    return px;
  };
  const a = engineUnsharp(edge(), w, h, 1, engineUsmMap(null, 1, 1, 1));
  const b = engineUnsharp(edge(), w, h, 1, engineUsmMap(null, 1, 1, 8));
  const row = (px) => [px[4 * (w / 2 - 1)], px[4 * (w / 2)]];
  assert.ok(row(a)[0] < 90 && row(a)[1] > 160, `${row(a)}`);
  assert.ok(row(b)[0] > row(a)[0] && row(b)[1] < row(a)[1]);
  const flatPx = new Uint8ClampedArray(w * h * 4).fill(120);
  assert.deepEqual([...engineUnsharp(flatPx.slice(), w, h, 1, null)], [...flatPx]);
  assert.equal(ENGINE_USM.threshold, 0.4);
});
