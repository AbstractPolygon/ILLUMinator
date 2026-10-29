import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHotPixels, makeHotPixelFile } from '../app/js/core/calibration.js';
import { fixHotPixels } from '../app/js/core/raw.js';

test('a hot pixel file lists two rows for each column entry', () => {
  const file = makeHotPixelFile([[3, 5, 9], [3, 20, 21], [7, 0, 11]]);
  const px = parseHotPixels(file, 10, 30);
  assert.deepEqual(Array.from(px), [0 * 10 + 7, 5 * 10 + 3, 9 * 10 + 3, 11 * 10 + 7, 20 * 10 + 3, 21 * 10 + 3]);
});

test('a hot pixel file that does not fit the sensor is refused', () => {
  assert.equal(parseHotPixels(makeHotPixelFile([[40, 1, 2]]), 10, 30), null);
  assert.equal(parseHotPixels(makeHotPixelFile([[3, 1, 99]]), 10, 30), null);
  assert.equal(parseHotPixels(new Uint8Array(3), 10, 30), null);
});

test('listed pixels are always repaired, even when mild', () => {
  const w = 12;
  const raw = new Uint16Array(w * w).fill(100);
  raw[5 * w + 6] = 130; // too mild for the search to flag
  const plain = fixHotPixels(raw, w, w);
  assert.equal(plain.raw[5 * w + 6], 130);
  const listed = fixHotPixels(raw, w, w, Uint32Array.of(5 * w + 6));
  assert.equal(listed.raw[5 * w + 6], 100);
  assert.equal(listed.count, 1);
});

test('a listed pixel follows the engine rule: left alone up to 1.2 times the estimate, else the smoother direction\'s mean', () => {
  const w = 12;
  const raw = new Uint16Array(w * w).fill(100);
  const i = 5 * w + 6;
  // horizontal neighbours differ (a vertical edge): the vertical pair is smoother
  raw[i - 2] = 100;
  raw[i + 2] = 300;
  raw[i - 2 * w] = 100;
  raw[i + 2 * w] = 120;
  raw[i] = 119; // under 1.2 x 110
  assert.equal(fixHotPixels(raw, w, w, Uint32Array.of(i)).raw[i], 119);
  raw[i] = 140;
  const out = fixHotPixels(raw, w, w, Uint32Array.of(i));
  assert.equal(out.raw[i], 110);
  assert.equal(out.count, 1);
  // nothing outside the list is touched
  raw[3 * w + 3] = 900;
  assert.equal(fixHotPixels(raw, w, w, Uint32Array.of(i)).raw[3 * w + 3], 900);
});

import { makeTar } from '../app/js/core/tar.js';
import { memoryStorage } from '../app/js/library/storage.js';
import { importCalibration, listCalibrations, loadCalibration, removeCalibration, KEEP_BYTES } from '../app/js/core/calibration.js';

const blobOf = (bytes) => ({ size: bytes.length, slice: (a, b) => ({ arrayBuffer: async () => bytes.slice(a, b).buffer }) });

test('a calibration backup is kept per camera: small files stored, big white images left', async () => {
  const enc = new TextEncoder();
  const tar = makeTar({
    'B5100/unitdata/unit_info.json': enc.encode('{"camera":{"serialNumber":"B5100"}}'),
    'B5100/unitdata/HOTPIXEL.BIN': makeHotPixelFile([[3, 5, 9]]),
    'B5100/unitdata/MOD_0000.RAW': new Uint8Array(KEEP_BYTES + 1),
  });
  const store = memoryStorage();
  const info = await importCalibration(blobOf(tar), store);
  assert.equal(info.serial, 'B5100');
  assert.equal(info.saved, 2);
  assert.deepEqual(info.left.map((l) => l.name), ['MOD_0000.RAW']); // no .TXT/.GCT with it: not usable
  assert.equal(info.hotPixels, true);
  assert.equal((await listCalibrations(store)).length, 1);
  const cal = await loadCalibration(store, 'B5100');
  assert.equal(parseHotPixels(cal.hotPixelFile, 10, 30).length, 2);
  await removeCalibration(store, 'B5100');
  assert.equal((await listCalibrations(store)).length, 0);
});

test('data without a camera serial number is refused', async () => {
  const tar = makeTar({ 'x/other.json': new TextEncoder().encode('{}') });
  await assert.rejects(importCalibration(blobOf(tar), memoryStorage()), /calibration/);
});

import { whiteOffsets, WHITE_SCALE } from '../app/js/core/calibration.js';
import { lensTable } from '../app/js/core/superres.js';
import { lensCenters } from '../app/js/core/lenslet.js';

test('white image offsets fill a photo\'s lens table and drop the shift all lenses share', () => {
  const cam = { width: 400, height: 300 };
  const grid = { pitch: 14, rowStep: 14 * Math.sqrt(3) / 2, rotation: 0, ox: 200, oy: 150 };
  const lc = lensCenters(grid, cam.width, cam.height);
  const off = new Int8Array(lc.rows * lc.cols * 2);
  // every lens 0.25 px right of its grid place, one of them a further 0.5 px
  for (let i = 0; i < lc.rows * lc.cols; i++) off[2 * i] = Math.round(0.25 * WHITE_SCALE);
  const k = 40;
  off[2 * k] += Math.round(0.5 * WHITE_SCALE);
  const white = { grid, r0: lc.r0, c0: lc.c0, rows: lc.rows, cols: lc.cols, off };
  const table = lensTable(grid, cam);
  const n = whiteOffsets(white, grid, table);
  assert.ok(n > 100);
  const ti = (k / lc.cols | 0) * table.cols + (k % lc.cols) + (lc.c0 - table.c0) + (lc.r0 - table.r0) * table.cols;
  assert.ok(Math.abs(table.dx[ti] - 0.5) < 0.02, `outlier lens off by ${table.dx[ti]}`);
  assert.ok(Math.abs(table.dx[ti + 1]) < 0.02);
  assert.ok(Math.abs(table.dy[ti]) < 0.02);
});
