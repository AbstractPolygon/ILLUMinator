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

test('what opening worked out is kept, with or without the depth', () => {
  const open = { key: 'o', scale: [0.5, 0.6, 0.7], wb: { gains: [1.2, 1, 1.3], rel: [1, 1, 1], cct: 5000 } };
  const only = decodeProcessed(buf(encodeProcessed({ key: 'k', w: 0, h: 0, alpha: new Float32Array(0), open })));
  assert.deepEqual(only.open, open);
  assert.equal(only.alpha.length, 0);
  const both = decodeProcessed(buf(encodeProcessed({ key: 'k', w: 2, h: 2, alpha: Float32Array.of(1, 2, 3, 4), focusOffset: 0.5, open })));
  assert.deepEqual(both.open, open);
  assert.deepEqual([...both.alpha], [1, 2, 3, 4]);
  assert.equal(decodeProcessed(buf(encodeProcessed({ key: 'k', w: 0, h: 0, alpha: new Float32Array(0) }))), null, 'nothing kept');
});

test('the depths of other depth methods are kept beside the main one', () => {
  const extra = [
    { key: '{"style":"classic"}', w: 2, h: 2, alpha: Float32Array.of(1, 2, 3, 4), confidence: Float32Array.of(0.1, 0.2, 0.3, 0.4), range: [0.5, 2.5], flat: false },
    { key: '{"style":"other"}', w: 3, h: 1, alpha: Float32Array.of(5, 6, 7), confidence: Float32Array.of(1, 1, 0), flat: true },
  ];
  const back = decodeProcessed(buf(encodeProcessed({ key: 'k', w: 2, h: 1, alpha: Float32Array.of(9, 8), open: { key: 'o' }, extra })));
  assert.deepEqual([...back.alpha], [9, 8]);
  assert.equal(back.extra.length, 2);
  assert.equal(back.extra[0].key, extra[0].key);
  assert.deepEqual([...back.extra[0].alpha], [1, 2, 3, 4]);
  assert.deepEqual([...back.extra[0].confidence].map((v) => +v.toFixed(2)), [0.1, 0.2, 0.3, 0.4]);
  assert.deepEqual(back.extra[0].range, [0.5, 2.5]);
  assert.equal(back.extra[1].flat, true);
  assert.deepEqual([...back.extra[1].alpha], [5, 6, 7]);
  const none = decodeProcessed(buf(encodeProcessed({ key: 'k', w: 1, h: 1, alpha: Float32Array.of(1) })));
  assert.deepEqual(none.extra, []);
  const bad = encodeProcessed({ key: 'k', w: 2, h: 1, alpha: Float32Array.of(9, 8), extra });
  const cut = decodeProcessed(buf(bad.subarray(0, bad.length - 4)));
  assert.deepEqual([...cut.alpha], [9, 8], 'the main depth survives a cut file');
  assert.equal(cut.extra.length, 1, 'only the complete extra depths are used');
});
