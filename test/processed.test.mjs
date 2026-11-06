import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeDepth, ProcessedPicture, FOCUS_RANGE } from '../app/js/core/processed.js';

function flat(w, h, rgb, extra = {}) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([...rgb, 255], i * 4);
  return { width: w, height: h, data, ...extra };
}

test('decodeDepth: 8-bit bytes map linearly onto the lambda range', () => {
  const bytes = Uint8Array.from([0, 255, 128, 64]);
  const d = decodeDepth({ width: 2, height: 2, bytes, minLambda: -4, maxLambda: 4, representation: 'uint8' });
  assert.equal(d.lambda.length, 4);
  assert.equal(d.lambda[0], -4);
  assert.equal(d.lambda[1], 4);
  assert.ok(Math.abs(d.lambda[2] - (128 / 255 * 8 - 4)) < 1e-6);
});

test('decodeDepth: packed floats are read little endian, and a too short map is refused', () => {
  const floats = new Float32Array([-2, -1, 0, 1, 2, 3]);
  const d = decodeDepth({ width: 3, height: 2, bytes: new Uint8Array(floats.buffer), minLambda: -3, maxLambda: 4, representation: 'packedFloat' });
  assert.deepEqual(Array.from(d.lambda), [-2, -1, 0, 1, 2, 3]);
  assert.throws(() => decodeDepth({ width: 3, height: 2, bytes: new Uint8Array(8), representation: 'packedFloat' }), /too short/);
  assert.throws(() => decodeDepth({ width: 8, height: 8, bytes: new Uint8Array(4), representation: 'png' }), /Unsupported/);
});

test('decodeDepth: big endian floats are told from little endian by the values being out of range', () => {
  const bytes = new Uint8Array(4 * 400);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < 400; i++) view.setFloat32(4 * i, (i % 7) - 3, false);
  const d = decodeDepth({ width: 20, height: 20, bytes, minLambda: -5, maxLambda: 5, representation: 'packedFloat' });
  assert.equal(d.lambda[10], (10 % 7) - 3);
});

test('a refocus stack is sorted by focus, its lambda range comes from the images, and the camera focus maps onto it', () => {
  const pic = new ProcessedPicture({
    kind: 'focus',
    source: 'test',
    images: [flat(4, 4, [200, 200, 200], { lambda: 2 }), flat(4, 4, [0, 0, 0], { lambda: -2 })],
  });
  assert.deepEqual(pic.images.map((i) => i.lambda), [-2, 2]);
  assert.deepEqual(pic.lambdaRange, [-2, 2]);
  assert.equal(pic.canDrag, false);
  assert.equal(pic.hasDepth, false);
  assert.equal(pic.toLambda(0), 0);
  assert.ok(Math.abs(pic.toLambda(FOCUS_RANGE) - 2) < 1e-9);
  assert.ok(Math.abs(pic.toAlpha(pic.toLambda(0.7)) - 0.7) < 1e-9);
  assert.equal(pic.toAlpha(100), FOCUS_RANGE, 'clamped');
});

test('the base picture of a refocus stack blends the two images around the asked focus', () => {
  const pic = new ProcessedPicture({
    kind: 'focus',
    source: 'test',
    images: [flat(2, 2, [0, 0, 0], { lambda: -2 }), flat(2, 2, [255, 255, 255], { lambda: 2 })],
  });
  const lo = pic.base(0, 0, -2);
  const mid = pic.base(0, 0, 0);
  const hi = pic.base(0, 0, 2);
  assert.ok(lo[0] < 1e-6 && Math.abs(hi[0] - 1) < 1e-6);
  assert.ok(Math.abs(mid[0] - 0.5) < 1e-6, `halfway is half: ${mid[0]}`);
});

test('a picture with a depth map can be dragged and reads the depth bilinearly', () => {
  const depth = { width: 2, height: 1, lambda: Float32Array.from([0, 4]) };
  const pic = new ProcessedPicture({ kind: 'single', source: 'test', images: [flat(8, 4, [90, 90, 90])], depth });
  assert.equal(pic.hasDepth, true);
  assert.equal(pic.canDrag, true);
  assert.ok(Math.abs(pic.lambdaAt(0, 2) - 0) < 1e-6);
  assert.ok(Math.abs(pic.lambdaAt(7, 2) - 4) < 1e-6);
  const mid = pic.lambdaAt(3.5, 2);
  assert.ok(mid > 1.5 && mid < 2.5, `between the two: ${mid}`);
  assert.equal(new ProcessedPicture({ kind: 'single', source: 'x', images: [flat(2, 2, [1, 1, 1])] }).lambdaAt(0, 0), null);
});

test('smoothing a picture without depth does nothing, and 0 puts the original depth back', () => {
  const none = new ProcessedPicture({ kind: 'single', source: 'x', images: [flat(4, 4, [1, 1, 1])] });
  none.setSmoothing(0.5);
  assert.equal(none.depth, null);
  const lambda = Float32Array.from({ length: 64 }, (_, i) => (i % 8 < 4 ? 0 : 5));
  const pic = new ProcessedPicture({ kind: 'single', source: 'x', images: [flat(8, 8, [100, 100, 100])], depth: { width: 8, height: 8, lambda } });
  const original = pic.depth;
  pic.setSmoothing(0.8);
  assert.notEqual(pic.depth, original);
  pic.setSmoothing(0);
  assert.equal(pic.depth, original);
});
