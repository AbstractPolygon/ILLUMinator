import test from 'node:test';
import assert from 'node:assert/strict';
import { upscale, scaledSize } from '../app/js/core/upscale.js';

function image(w, h, f) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = f(x, y);
      data.set([v, v, v, 255], (y * w + x) * 4);
    }
  }
  return { width: w, height: h, data };
}

test('upscaling keeps a flat picture flat, at the new size', () => {
  for (const method of ['lanczos', 'smooth']) {
    const out = upscale(image(7, 5, () => 120), 21, 15, { method, sharpen: 0.5 });
    assert.equal(out.width, 21);
    assert.equal(out.height, 15);
    assert.equal(out.data.length, 21 * 15 * 4);
    for (let i = 0; i < out.data.length; i += 4) {
      assert.equal(out.data[i], 120);
      assert.equal(out.data[i + 3], 255);
    }
  }
});

test('Lanczos keeps an edge sharper than smooth, within 0..255', () => {
  const edge = image(8, 2, (x) => (x < 4 ? 0 : 255));
  const row = (img) => Array.from({ length: img.width }, (_, x) => img.data[x * 4]);
  const lanczos = row(upscale(edge, 32, 8, { method: 'lanczos' }));
  const smooth = row(upscale(edge, 32, 8, { method: 'smooth' }));
  // Steepest step between neighboring output pixels.
  const steep = (r) => Math.max(...r.slice(1).map((v, i) => Math.abs(v - r[i])));
  assert.ok(steep(lanczos) > steep(smooth));
  assert.ok(lanczos.every((v) => v >= 0 && v <= 255));
  assert.equal(lanczos[0], 0);
  assert.equal(lanczos[31], 255);
});

test('sizes for upscaling', () => {
  assert.deepEqual(scaledSize(2460, 1708, 2), [4920, 3416]);
  assert.deepEqual(scaledSize(1557, 1081, 1, { even: true }), [1558, 1082]);
});

test('reducing does not alias: fine stripes average to gray', () => {
  // One-pixel black and white stripes, reduced 4x: every output pixel is
  // about mid gray (a narrow filter would pick stripes and give 0 or 255).
  const stripes = image(64, 4, (x) => (x % 2 ? 255 : 0));
  for (const method of ['lanczos', 'smooth']) {
    const out = upscale(stripes, 16, 1, { method });
    for (let x = 2; x < 14; x++) assert.ok(Math.abs(out.data[x * 4] - 127.5) < 12, `${method} ${x}: ${out.data[x * 4]}`);
  }
});
