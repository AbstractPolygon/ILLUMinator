import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGeometryTable, geometryAt } from '../app/js/core/geometrytable.js';

// A table as the photo stores it: magic, version 2, 15, 0, byte size, width, height, then (u, v) float pairs.
function table(w, h, fn) {
  const bytes = new Uint8Array(28 + 8 * w * h);
  const v = new DataView(bytes.buffer);
  v.setUint32(0, 0xaf0880fa, true);
  v.setInt32(4, 2, true);
  v.setInt32(8, 15, true);
  v.setInt32(16, bytes.length, true);
  v.setInt32(20, w, true);
  v.setInt32(24, h, true);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [a, b] = fn(x, y);
      v.setFloat32(28 + 8 * (y * w + x), a, true);
      v.setFloat32(28 + 8 * (y * w + x) + 4, b, true);
    }
  }
  return bytes;
}

test('a valid table is read back value for value', () => {
  const geo = parseGeometryTable(table(4, 3, (x, y) => [x + 10 * y, -x - 10 * y]));
  assert.equal(geo.w, 4);
  assert.equal(geo.h, 3);
  assert.equal(geo.data.length, 24);
  assert.deepEqual([geo.data[2 * (2 * 4 + 3)], geo.data[2 * (2 * 4 + 3) + 1]], [23, -23]);
});

test('bad input gives null, not a throw', () => {
  assert.equal(parseGeometryTable(null), null);
  assert.equal(parseGeometryTable(new Uint8Array(10)), null);
  const wrongMagic = table(2, 2, () => [0, 0]);
  wrongMagic[0] ^= 0xff;
  assert.equal(parseGeometryTable(wrongMagic), null);
  const wrongVersion = table(2, 2, () => [0, 0]);
  wrongVersion[4] = 3;
  assert.equal(parseGeometryTable(wrongVersion), null);
  const truncated = table(4, 4, () => [0, 0]).subarray(0, 60);
  assert.equal(parseGeometryTable(truncated), null);
});

test('geometryAt takes the cell floor(size * (x + 0.5) + 0.5), clamped to the table', () => {
  const geo = parseGeometryTable(table(5, 5, (x, y) => [x, y]));
  const out = [0, 0];
  assert.deepEqual(geometryAt(geo, 0, 0, out), [3, 3]); // the middle: floor(5 * 0.5 + 0.5) = 3
  assert.deepEqual(geometryAt(geo, -0.5, -0.5, out), [0, 0]); // floor(0.5) = 0
  assert.deepEqual(geometryAt(geo, 0.5, 0.5, out), [4, 4]); // floor(5.5) = 5, clamped to 4
  assert.deepEqual(geometryAt(geo, -3, 7, out), [0, 4]); // far outside: clamped, never out of range
});
