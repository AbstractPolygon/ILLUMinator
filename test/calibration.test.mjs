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
