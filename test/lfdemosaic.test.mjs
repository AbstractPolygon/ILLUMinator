import test from 'node:test';
import assert from 'node:assert/strict';
import { createLfDemosaic, EXPFLUT, H1, V1, S1, H2, V2 } from '../app/js/core/lfdemosaic.js';

const RGGB = [[0, 1], [1, 2]];

// A raw plane whose every site holds its color's value: a flat field of that color, as the sensor would see it.
function plane(w, h, rgb, cfa = RGGB) {
  const p = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) p[y * w + x] = rgb[cfa[y & 1][x & 1]];
  return p;
}

test('the tables have the sizes the engine uses', () => {
  assert.equal(EXPFLUT.length, 65);
  assert.ok(EXPFLUT[0] < 1 && EXPFLUT[0] > EXPFLUT[64] && EXPFLUT[64] > 0, 'weights fall with the gradient');
  assert.equal(H1.length, 12);
  assert.equal(V1.length, 12);
  assert.equal(S1.length, 12);
  assert.equal(H2.length, 4);
  assert.equal(V2.length, 4);
});

test('a flat colored field comes out as that color everywhere, borders included', () => {
  const w = 40;
  const h = 36;
  const rgb = [0.8, 0.5, 0.2];
  const demosaic = createLfDemosaic(plane(w, h, rgb), w, h, RGGB);
  const out = [0, 0, 0];
  for (const [x, y] of [[0, 0], [1, 0], [3, 3], [4, 4], [17, 18], [20, 21], [35, 30], [39, 35], [39, 0]]) {
    assert.equal(demosaic.at(x, y, out), true, `finite at ${x},${y}`);
    for (let c = 0; c < 3; c++) assert.ok(Math.abs(out[c] - rgb[c]) < 1e-5, `${x},${y} channel ${c}: ${out[c]}`);
  }
});

test('the other Bayer orders work the same', () => {
  const w = 24;
  const h = 24;
  const rgb = [0.1, 0.6, 0.9];
  for (const cfa of [[[1, 0], [2, 1]], [[1, 2], [0, 1]], [[2, 1], [1, 0]]]) {
    const demosaic = createLfDemosaic(plane(w, h, rgb, cfa), w, h, cfa);
    const out = [0, 0, 0];
    demosaic.at(12, 12, out);
    for (let c = 0; c < 3; c++) assert.ok(Math.abs(out[c] - rgb[c]) < 1e-5);
  }
});

test('the result does not depend on how the picture is cut into bands', () => {
  const w = 32;
  const h = 40;
  const p = new Float32Array(w * h);
  for (let i = 0; i < p.length; i++) p[i] = 0.3 + 0.2 * Math.sin(i * 0.37) + 0.1 * Math.cos(i * 0.011);
  const a = createLfDemosaic(p, w, h, RGGB, 8);
  const b = createLfDemosaic(p, w, h, RGGB, 64);
  const oa = [0, 0, 0];
  const ob = [0, 0, 0];
  for (let y = 0; y < h; y += 3) {
    for (let x = 0; x < w; x += 5) {
      a.at(x, y, oa);
      b.at(x, y, ob);
      for (let c = 0; c < 3; c++) assert.ok(Math.abs(oa[c] - ob[c]) < 1e-6, `${x},${y}`);
    }
  }
});

test('a sharp vertical edge in green does not leak across: green stays on its own side', () => {
  const w = 32;
  const h = 32;
  const p = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) p[y * w + x] = x < 16 ? 0.1 : 0.9;
  const demosaic = createLfDemosaic(p, w, h, RGGB);
  const left = [0, 0, 0];
  const right = [0, 0, 0];
  demosaic.at(10, 16, left);
  demosaic.at(22, 16, right);
  for (let c = 0; c < 3; c++) {
    assert.ok(Math.abs(left[c] - 0.1) < 1e-4 && Math.abs(right[c] - 0.9) < 1e-4);
  }
});
