import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { nrFilter, nrTables, nrProfileIndex, nrLumaStrength } from '../app/js/core/enginenr.js';

// Deterministic integer test pictures (generated the same way when the golden outputs were made with the library itself).
function testPlanes(w, h, seed) {
  let s = seed >>> 0;
  const planes = [];
  for (let c = 0; c < 3; c++) {
    const a = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        const noise = ((s >>> 16) & 63) - 32;
        const base = 60 + ((x * 3 + c * 17) % 97) + ((y * 5) % 53) + (x > Math.floor(w / 2) ? 40 : 0);
        a[y * w + x] = Math.min(Math.max(base * 4 + noise * (c + 1), 0), 1020) / 4;
      }
    }
    planes.push(a);
  }
  return planes;
}
const CASES = [[100, 100, 2, 0.2, 7], [150, 72, 0, 0.1, 11]];

test('noise reduction: whole pictures match the library, tile layout and all', () => {
  const blob = zlib.gunzipSync(fs.readFileSync(new URL('./fixtures/enginenr_golden.bin.gz', import.meta.url)));
  const f = new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
  let off = 0;
  for (const [w, h, pi, luma, seed] of CASES) {
    const planes = testPlanes(w, h, seed);
    const out = nrFilter(planes, w, h, nrTables(pi, luma));
    for (let c = 0; c < 3; c++) {
      const ref = f.subarray(off, off + w * h);
      off += w * h;
      let max = 0;
      let sum = 0;
      let change = 0;
      for (let i = 0; i < w * h; i++) {
        const e = Math.abs(out[c][i] - ref[i]);
        if (e > max) max = e;
        sum += e;
        change += Math.abs(ref[i] - planes[c][i]);
      }
      // the library's own reciprocal / reciprocal-square-root instructions differ from exact ones by a little
      if (process.env.NR_DEBUG) console.log(w, h, c, 'max', max, 'mean', sum / (w * h), 'change', change / (w * h));
      assert.ok(sum / (w * h) < 0.01 && max < 1.5, `case ${w}x${h} plane ${c}: max ${max} mean ${sum / (w * h)}`);
      assert.ok(change / (w * h) > 0.02, `the filter changes the picture (${change / (w * h)})`);
    }
  }
});

test('noise reduction: profile choice follows the nearest gain key; luma strength follows the gain table', () => {
  assert.equal(nrProfileIndex(1), 0);
  assert.equal(nrProfileIndex(2), 0);
  assert.equal(nrProfileIndex(4), 1);
  assert.equal(nrProfileIndex(8), 2);
  assert.equal(nrProfileIndex(64), 7);
  assert.ok(Math.abs(nrLumaStrength(1) - 0.1) < 1e-6 && Math.abs(nrLumaStrength(4) - 0.1333333) < 1e-6 && Math.abs(nrLumaStrength(8) - 0.2) < 1e-6);
  const t = nrTables(2, 0.2);
  assert.equal(t.nlev, 3);
  assert.equal(t.lut[0][0].length, 257);
});

test('noise reduction: pictures smaller than a tile context pass through', () => {
  const planes = testPlanes(30, 30, 3);
  const out = nrFilter(planes, 30, 30, nrTables(0, 0.1));
  assert.deepEqual(Array.from(out[0]), Array.from(planes[0]));
});
