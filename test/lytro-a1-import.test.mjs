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
