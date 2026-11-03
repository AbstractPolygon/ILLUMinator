import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeProcessed, decodeProcessed, PROCESSED_FILE } from '../app/js/core/processed-cache.js';

const buf = (u8) => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.length);

test('the processed version of a photo survives writing and reading', () => {
  const alpha = Float32Array.from({ length: 12 }, (_, i) => i * 0.25 - 1);
  const back = decodeProcessed(buf(encodeProcessed({ key: '{"app":"0.5.38"}', w: 4, h: 3, alpha, focusOffset: 0.375 })));
  assert.equal(back.key, '{"app":"0.5.38"}');
  assert.deepEqual([back.w, back.h], [4, 3]);
  assert.deepEqual([...back.alpha], [...alpha]);
  assert.equal(back.focusOffset, 0.375);
  assert.equal(PROCESSED_FILE, 'processed.illuminator.bin');
});

test('a missing focus offset stays missing', () => {
  const back = decodeProcessed(buf(encodeProcessed({ key: 'k', w: 2, h: 2, alpha: new Float32Array(4) })));
  assert.equal(back.focusOffset, undefined);
});

test('damaged or foreign files are not used', () => {
  assert.equal(decodeProcessed(null), null);
  assert.equal(decodeProcessed(new ArrayBuffer(4)), null);
  assert.equal(decodeProcessed(buf(new Uint8Array(40))), null);
  const good = encodeProcessed({ key: 'k', w: 4, h: 4, alpha: new Float32Array(16) });
  assert.equal(decodeProcessed(buf(good.subarray(0, good.length - 8))), null, 'cut short');
});
