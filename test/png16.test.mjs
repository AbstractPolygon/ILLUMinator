import test from 'node:test';
import assert from 'node:assert/strict';
import { encodePng16 } from '../app/js/core/png16.js';
import { decodePngGray } from '../app/js/core/userdepth.js';

test('a 16 bit PNG keeps every value', async () => {
  const w = 37;
  const h = 11;
  const rgb = new Uint16Array(w * h * 3);
  let seed = 5;
  for (let i = 0; i < rgb.length; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    rgb[i] = i % 3 === 0 ? (i / 3 / (w * h)) * 65535 : seed >>> 16;
  }
  rgb[0] = 0;
  rgb[3] = 65535;
  const png = await encodePng16(rgb, w, h);
  const dv = new DataView(png.buffer);
  assert.equal(dv.getUint32(16), w);
  assert.equal(dv.getUint32(20), h);
  assert.equal(png[24], 16, 'bit depth');
  assert.equal(png[25], 2, 'truecolor');
  // the first channel read back through the PNG reader (16 bit, scaled 0..1)
  const back = await decodePngGray(png);
  assert.ok(back);
  for (let i = 0; i < w * h; i++) assert.equal(Math.round(back.data[i] * 65535), rgb[3 * i], `pixel ${i}`);
});

test('the chunks carry valid checksums', async () => {
  const png = await encodePng16(new Uint16Array(4 * 4 * 3).fill(1234), 4, 4);
  const dv = new DataView(png.buffer);
  let p = 8;
  let names = '';
  const table = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  while (p < png.length) {
    const len = dv.getUint32(p);
    names += String.fromCharCode(...png.subarray(p + 4, p + 8)) + ' ';
    let c = 0xffffffff;
    for (let i = p + 4; i < p + 8 + len; i++) c = table[(c ^ png[i]) & 255] ^ (c >>> 8);
    assert.equal(dv.getUint32(p + 8 + len), (c ^ 0xffffffff) >>> 0);
    p += 12 + len;
  }
  assert.equal(names.trim(), 'IHDR sRGB IDAT IEND');
});
