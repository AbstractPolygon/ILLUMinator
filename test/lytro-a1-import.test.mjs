import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { bufferReader, readLightFieldPicture, readThumbnail } from '../app/js/core/lfp.js';

const require = createRequire(import.meta.url);
const { assembleLfp, thumbnailPicture } = require('../electron/camera.cjs');

// A first generation camera's .TXT file, as it comes off the camera (trimmed).
const txt = (inner = true) => Buffer.from(JSON.stringify({
  master: {
    picture: { frameArray: [{ frame: { metadata: { type: 'lightField', image: { width: 4, height: 4, representation: 'rawPacked', rawDetails: { pixelPacking: { endianness: 'big', bitsPerPixel: 12 } } } }, privateMetadata: { camera: { serialNumber: 'A1' } } } }] },
    thumbnailArray: [],
    version: { major: 1, minor: 0 },
  },
  compressedFrame: { metadata: { representation: 'jpeg' } },
  debug: {},
}), 'utf8');

const ab = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.length);

test('a picture from a first generation camera is assembled with the frame metadata from inside its TXT file', async () => {
  const raw = Buffer.alloc(24, 7);
  const file = await assembleLfp({ raw, txt: txt() });
  const lf = await readLightFieldPicture(bufferReader(ab(file)));
  assert.equal(lf.metadata.image.width, 4);
  assert.equal(lf.metadata.image.representation, 'rawPacked');
  assert.equal(lf.privateMetadata.camera.serialNumber, 'A1');
  assert.ok(lf.rawRef);
});

test('the camera thumbnail goes into the file, raw RGB as a PNG', async () => {
  const rgb = Buffer.alloc(8 * 8 * 3, 200);
  const t = thumbnailPicture(rgb);
  assert.equal(t.mime, 'image/png');
  assert.deepEqual([...t.bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(thumbnailPicture(Buffer.from([0xff, 0xd8, ...new Array(30).fill(1)])).mime, 'image/jpeg');
  assert.equal(thumbnailPicture(Buffer.alloc(100)), null);
  const file = await assembleLfp({ raw: Buffer.alloc(24), txt: txt(), thumb: rgb });
  const thumb = await readThumbnail(bufferReader(ab(file)));
  assert.equal(thumb.mime, 'image/png');
});

test('files imported by earlier versions (the whole TXT file stored as the metadata) still open', async () => {
  const { encodeJson, refFor, writeContainer } = await import('../app/js/core/lfp.js');
  const meta = encodeJson(JSON.parse(txt().toString()));
  const priv = encodeJson({});
  const raw = new Uint8Array(24);
  const toc = { picture: { frameArray: [{ frame: { metadataRef: await refFor(meta), privateMetadataRef: await refFor(priv), imageRef: await refFor(raw) } }] } };
  const { bytes } = await writeContainer([{ type: 'LFC', data: meta }, { type: 'LFC', data: priv }, { type: 'LFC', data: raw }, { type: 'LFM', data: encodeJson(toc) }]);
  const lf = await readLightFieldPicture(bufferReader(ab(Buffer.from(bytes))));
  assert.equal(lf.metadata.image.width, 4);
  assert.equal(lf.privateMetadata.camera.serialNumber, 'A1');
});

test('other thumbnail layouts: header + JPEG, RGBA, YUYV and grey squares are understood', () => {
  const jpegAfterHeader = Buffer.concat([Buffer.alloc(20, 3), Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 1)]);
  assert.equal(thumbnailPicture(jpegAfterHeader).mime, 'image/jpeg');
  assert.equal(thumbnailPicture(jpegAfterHeader).bytes[0], 0xff);
  const rgba = Buffer.alloc(128 * 128 * 4, 9);
  assert.equal(thumbnailPicture(rgba).mime, 'image/png');
  const withHeader = Buffer.concat([Buffer.alloc(64), Buffer.alloc(128 * 128 * 3, 5)]);
  assert.equal(thumbnailPicture(withHeader).width, 128);
  const yuyv = Buffer.alloc(128 * 128 * 2, 128);
  assert.equal(thumbnailPicture(yuyv).mime, 'image/png');
  const grey = Buffer.alloc(128 * 128, 200);
  assert.equal(thumbnailPicture(grey).mime, 'image/png');
});

test('thumbnails of a first generation camera are asked for one at a time and failures are not kept', async () => {
  const { lytroThumbnail } = require('../electron/camera.cjs');
  const { LytroCamera } = require('../electron/lytro-protocol.cjs');
  const pic = { id: 'p1', name: 'IMG_0001', folder: '100PHOTO' };
  let active = 0;
  let maxActive = 0;
  let fail = true;
  const entry = {
    id: 'lytro:t', product: 0x00a1, pictures: [pic, { ...pic, id: 'p2' }],
    camera: {
      async download(type, name) {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        if (fail) throw new Error('busy');
        return Buffer.alloc(128 * 128 * 3, 1);
      },
    },
  };
  assert.ok(LytroCamera.pathOf(pic, '128').endsWith('.128'));
  assert.equal(await lytroThumbnail(entry, 'p1'), null);
  fail = false;
  const [a, b] = await Promise.all([lytroThumbnail(entry, 'p1'), lytroThumbnail(entry, 'p2')]);
  assert.equal(a.mime, 'image/png');
  assert.equal(b.mime, 'image/png');
  assert.equal(maxActive, 1);
});

// A smooth picture, as a thumbnail is: soft colour blobs.
function scene() {
  const rgb = Buffer.alloc(128 * 128 * 3);
  for (let y = 0; y < 128; y++) {
    for (let x = 0; x < 128; x++) {
      const i = (y * 128 + x) * 3;
      rgb[i] = 128 + 100 * Math.sin(x / 19);
      rgb[i + 1] = 128 + 100 * Math.cos(y / 23 + x / 41);
      rgb[i + 2] = 128 + 100 * Math.sin((x + y) / 31);
    }
  }
  return rgb;
}
const lumaOf = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
const toYuv = (r, g, b) => [lumaOf(r, g, b), 128 - 0.169 * r - 0.331 * g + 0.5 * b, 128 + 0.5 * r - 0.419 * g - 0.081 * b];

test('a raw thumbnail in an unknown pixel format is read as the layout that looks like a picture', () => {
  const { decodeRawThumbnail } = require('../electron/camera.cjs');
  const rgb = scene();
  const px = (i) => [rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]];
  const n = 128 * 128;
  const encode = {
    rgb: () => rgb,
    rgba: () => { const o = Buffer.alloc(n * 4, 255); for (let i = 0; i < n; i++) px(i).forEach((v, c) => { o[i * 4 + c] = v; }); return o; },
    'planar-rgb': () => { const o = Buffer.alloc(n * 3); for (let i = 0; i < n; i++) px(i).forEach((v, c) => { o[c * n + i] = v; }); return o; },
    rgb565: () => { const o = Buffer.alloc(n * 2); for (let i = 0; i < n; i++) { const [r, g, b] = px(i); o.writeUInt16LE(((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3), i * 2); } return o; },
    yuyv: () => { const o = Buffer.alloc(n * 2); for (let i = 0; i < n; i += 2) { const a = toYuv(...px(i)); const b = toYuv(...px(i + 1)); o.set([a[0], (a[1] + b[1]) / 2, b[0], (a[2] + b[2]) / 2], i * 2); } return o; },
    uyvy: () => { const o = Buffer.alloc(n * 2); for (let i = 0; i < n; i += 2) { const a = toYuv(...px(i)); const b = toYuv(...px(i + 1)); o.set([(a[1] + b[1]) / 2, a[0], (a[2] + b[2]) / 2, b[0]], i * 2); } return o; },
    i420: () => { const o = Buffer.alloc(n * 1.5); for (let i = 0; i < n; i++) o[i] = toYuv(...px(i))[0]; for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) { const c = toYuv(...px(y * 2 * 128 + x * 2)); o[n + y * 64 + x] = c[1]; o[n + 4096 + y * 64 + x] = c[2]; } return o; },
  };
  for (const [name, make] of Object.entries(encode)) {
    const got = decodeRawThumbnail(make());
    assert.equal(got.name, name, `${name}: read as ${got.name} ${JSON.stringify(got.scores)}`);
    // The colours come out right (not only the layout name).
    let err = 0;
    for (let i = 0; i < rgb.length; i += 37) err += Math.abs(got.rgb[i] - rgb[i]);
    assert.ok(err / (rgb.length / 37) < 12, `${name}: colour error ${err / (rgb.length / 37)}`);
  }
  assert.equal(decodeRawThumbnail(Buffer.alloc(1000)), null);
});
