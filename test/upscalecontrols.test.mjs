import test from 'node:test';
import assert from 'node:assert/strict';
import { denoiseRgb16, addGrain16 } from '../app/js/core/aiupscale.js';
import { upscale } from '../app/js/core/upscale.js';

const noisy = (w, h, level) => {
  const rgb = new Uint16Array(w * h * 3);
  let s = 12345;
  for (let i = 0; i < rgb.length; i++) {
    s = (s * 1103515245 + 12345) >>> 0;
    rgb[i] = 30000 + ((s >>> 16) / 65535 - 0.5) * level;
  }
  return rgb;
};
const spread = (rgb) => {
  let m = 0;
  for (const v of rgb) m += v;
  m /= rgb.length;
  let d = 0;
  for (const v of rgb) d += (v - m) ** 2;
  return Math.sqrt(d / rgb.length);
};

test('denoising before the model smooths noise and leaves a strong edge', () => {
  const w = 40;
  const h = 20;
  const rgb = noisy(w, h, 3000);
  for (let y = 0; y < h; y++) for (let x = 20; x < w; x++) for (let c = 0; c < 3; c++) rgb[3 * (y * w + x) + c] += 25000;
  const out = denoiseRgb16(rgb, w, h, 1);
  const flat = (a) => a.filter((_, i) => ((i / 3) | 0) % w < 15).slice(0, 3 * 15 * 8);
  assert.ok(spread(Uint16Array.from(flat(out))) < 0.7 * spread(Uint16Array.from(flat(rgb))), 'noise on the flat part is reduced');
  const left = out[3 * (10 * w + 18)];
  const right = out[3 * (10 * w + 22)];
  assert.ok(right - left > 20000, 'the edge stays');
  assert.equal(denoiseRgb16(rgb, w, h, 0), rgb);
});

test('grain is added in the mid-tones, the same every time, and not to black or white', () => {
  const w = 30;
  const h = 30;
  const mid = new Uint16Array(w * h * 3).fill(32768);
  const a = addGrain16(mid, w, h, 1);
  const b = addGrain16(mid, w, h, 1);
  assert.deepEqual(a, b);
  assert.ok(spread(a) > 200, `grain level ${spread(a)}`);
  const black = addGrain16(new Uint16Array(w * h * 3), w, h, 1);
  assert.equal(Math.max(...black), 0);
  assert.equal(addGrain16(mid, w, h, 0), mid);
});

test('Lanczos with fewer lobes rings less at an edge than with more', () => {
  const w = 16;
  const h = 4;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 4; c++) data[4 * (y * w + x) + c] = c === 3 ? 255 : x < 8 ? 60 : 190;
  const over = (lobes) => {
    const out = upscale({ width: w, height: h, data }, 64, 16, { method: 'lanczos', lobes });
    let max = 0;
    for (let x = 0; x < 64; x++) max = Math.max(max, out.data[4 * (8 * 64 + x)]);
    return max - 190;
  };
  assert.ok(over(2) < over(4), `${over(2)} against ${over(4)}`);
});
