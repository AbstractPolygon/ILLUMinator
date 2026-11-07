import test from 'node:test';
import assert from 'node:assert/strict';
import { hashBytes, fingerprint, toHalfBits, fromHalfBits, encodeKept, decodeKept, keptHash } from '../app/js/core/keptpicture.js';

test('half floats: exact where a half holds the value, close elsewhere, and the edges', () => {
  for (const x of [0, 1, -1, 0.5, 2, 1024, 65504, -65504, 2 ** -14, 2 ** -24]) assert.equal(fromHalfBits(toHalfBits(x)), x);
  for (const x of [0.1, 0.333333, 1.2345, 3.14159, 100.7, 0.0123, 7.77e-3, 12345.6]) assert.ok(Math.abs(fromHalfBits(toHalfBits(x)) - x) <= Math.abs(x) / 2000, String(x));
  assert.equal(fromHalfBits(toHalfBits(1e6)), Infinity);
  assert.equal(fromHalfBits(toHalfBits(-1e6)), -Infinity);
  assert.ok(Number.isNaN(fromHalfBits(toHalfBits(NaN))));
  assert.equal(fromHalfBits(toHalfBits(1e-9)), 0);
  // the picture's values are linear light: a ramp keeps its order
  let last = -1;
  for (let i = 0; i < 4000; i++) {
    const v = fromHalfBits(toHalfBits(i / 1000));
    assert.ok(v >= last);
    last = v;
  }
});

test('a kept picture round trips, and is refused when it is not one', () => {
  const rgb = Float32Array.from({ length: 4 * 3 * 3 }, (_, i) => (i * 37 % 101) / 50);
  const key = keptHash('some key');
  const bytes = encodeKept({ key, w: 4, h: 3, rgb });
  const back = decodeKept(bytes);
  assert.equal(back.key, key);
  assert.equal(back.w, 4);
  assert.equal(back.h, 3);
  for (let i = 0; i < rgb.length; i++) assert.ok(Math.abs(back.rgb[i] - rgb[i]) <= Math.abs(rgb[i]) / 2000 + 1e-7);
  assert.equal(decodeKept(null), null);
  assert.equal(decodeKept(bytes.slice(0, bytes.byteLength - 2)), null);
  const bad = bytes.slice(0);
  new Uint8Array(bad)[0] = 0;
  assert.equal(decodeKept(bad), null);
  assert.equal(decodeKept(new ArrayBuffer(40)), null);
});

test('fingerprints follow contents, not identity', () => {
  const a = Float32Array.from([1, 2, 3, 4, 5]);
  const b = Float32Array.from([1, 2, 3, 4, 5]);
  const c = Float32Array.from([1, 2, 3, 4, 6]);
  assert.equal(fingerprint(a), fingerprint(b));
  assert.notEqual(fingerprint(a), fingerprint(c));
  assert.equal(fingerprint({ alpha: a, w: 2, range: [0, 1] }), fingerprint({ range: [0, 1], w: 2, alpha: b }));
  assert.notEqual(fingerprint({ alpha: a, w: 2 }), fingerprint({ alpha: a, w: 3 }));
  assert.notEqual(fingerprint(new Map([['x', a]])), fingerprint(new Map([['x', c]])));
  assert.equal(fingerprint(null), fingerprint(undefined));
  // a view into a larger buffer is read from its own offset, byte by byte when it is not word aligned
  const buf = new Uint8Array([9, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(hashBytes(buf.subarray(1)), hashBytes(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8])));
});
