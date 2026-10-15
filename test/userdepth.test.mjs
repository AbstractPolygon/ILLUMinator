import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { decodePngGray, parseDepthRange } from '../app/js/core/userdepth.js';
import { groupPhotos } from '../app/js/library/scan.js';

function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(name, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(name, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
// A 16-bit gray PNG, each row with a different filter.
function png16(w, h, value) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 16;
  const rows = [];
  let prev = Buffer.alloc(w * 2);
  for (let y = 0; y < h; y++) {
    const line = Buffer.alloc(w * 2);
    for (let x = 0; x < w; x++) line.writeUInt16BE(value(x, y), x * 2);
    const f = y % 5;
    const enc = Buffer.alloc(w * 2);
    for (let i = 0; i < enc.length; i++) {
      const a = i >= 2 ? line[i - 2] : 0, up = prev[i], c = i >= 2 ? prev[i - 2] : 0;
      const p = a + up - c, pa = Math.abs(p - a), pb = Math.abs(p - up), pc = Math.abs(p - c);
      const pred = [0, a, up, (a + up) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? up : c][f];
      enc[i] = (line[i] - pred) & 255;
    }
    rows.push(Buffer.from([f]), enc);
    prev = line;
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

test('decodes a 16-bit gray PNG exactly, every filter', async () => {
  const value = (x, y) => (x * 997 + y * 4099 + 40000) % 65536;
  const img = await decodePngGray(png16(9, 10, value));
  assert.equal(img.width, 9);
  assert.equal(img.height, 10);
  for (let y = 0; y < 10; y++) for (let x = 0; x < 9; x++) assert.equal(Math.round(img.data[y * 9 + x] * 65535), value(x, y));
});

test('reads the lambda range and rejects bad ones', () => {
  assert.deepEqual(parseDepthRange('{"LambdaMin":-35,"LambdaMax":8}'), { min: -35, max: 8 });
  assert.equal(parseDepthRange('{"LambdaMin":3,"LambdaMax":3}'), null);
  assert.equal(parseDepthRange('nope'), null);
});

test('a Lytro picture folder brings its edited depth map', () => {
  const f = (name) => ({ name, size: 1 });
  const [p] = groupPhotos(['raw.lfp', 'stack.view.lfp', 'stack.userdepthmap.png', 'stack.userdepthmap.txt'].map((n) => ({ path: `Beach/${n}`, file: f(n) })));
  assert.equal(p.depthMap.name, 'stack.userdepthmap.png');
  assert.equal(p.depthRange.name, 'stack.userdepthmap.txt');
  const [q] = groupPhotos(['raw.lfp', 'stack.userdepthmap.png'].map((n) => ({ path: `Sea/${n}`, file: f(n) })));
  assert.equal(q.depthMap, null);
});
