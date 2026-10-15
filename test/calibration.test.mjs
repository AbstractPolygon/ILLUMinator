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
  assert.deepEqual(info.left.map((l) => l.name), ['MOD_0000.RAW']);
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
