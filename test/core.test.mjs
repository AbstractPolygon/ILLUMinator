import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { writeContainer, encodeJson, refFor, bufferReader, readLightFieldPicture, readThumbnail, indexSections, isLfp } from '../app/js/core/lfp.js';
import { unpack10, unpack12, cameraInfo } from '../app/js/core/raw.js';
import { decodeLightField } from '../app/js/core/decode.js';
import { makeSyntheticLfr } from '../app/js/core/synthetic.js';
import { buildSampler, renderView, makeDevelopParams, apertureSamples, refocus, sharpness, sensorToOutput } from '../app/js/core/render.js';
import { renderSuperRes, estimateVignetting } from '../app/js/core/superres.js';

test('unpack10 reads four high bytes and a byte of low bits', () => {
  // Pixels 0x3ff, 0x001, 0x200, 0x155
  const bytes = Uint8Array.from([0xff, 0x00, 0x80, 0x55, 0b01_00_01_11]);
  assert.deepEqual([...unpack10(bytes, 4)], [0x3ff, 0x001, 0x200, 0x155]);
});

test('unpack12 reads two big-endian pixels from three bytes', () => {
  assert.deepEqual([...unpack12(Uint8Array.from([0xab, 0xcd, 0xef]), 2)], [0xabc, 0xdef]);
});

test('container round trip with the table of contents at the end (ILLUM layout)', async () => {
  const meta = encodeJson({ image: { width: 4, height: 2 } });
  const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  const image = new Uint8Array(37).fill(7);
  const toc = {
    frames: [{ frame: { metadataRef: await refFor(meta), imageRef: await refFor(image) } }],
    thumbnails: [{ imageRef: await refFor(jpeg), width: 1, height: 1, representation: 'jpeg' }],
  };
  const { bytes } = await writeContainer([
    { type: 'LFC', data: meta },
    { type: 'LFC', data: jpeg },
    { type: 'LFC', data: image },
    { type: 'LFM', data: encodeJson(toc) },
  ]);
  assert.ok(isLfp(bytes));
  const sections = await indexSections(bufferReader(bytes));
  assert.deepEqual(sections.map((s) => s.type), ['LFC', 'LFC', 'LFC', 'LFM']);
  const pic = await readLightFieldPicture(bufferReader(bytes));
  assert.equal(pic.metadata.image.width, 4);
  assert.deepEqual([...(await pic.container.readSection(pic.rawRef))], [...image]);
  const thumb = await readThumbnail(bufferReader(bytes));
  assert.equal(thumb.mime, 'image/jpeg');
});

test('processed files expose JPEG refocus stacks with lambdas', async () => {
  const jpegs = [0, 1, 2].map((i) => Uint8Array.from([0xff, 0xd8, 0xff, i]));
  const refs = await Promise.all(jpegs.map(refFor));
  const toc = {
    views: [{ accelerations: [{ kind: 'focusStack', perImage: refs.map((r, i) => ({ imageRef: r, focus: i - 1 })) }] }],
  };
  const { bytes } = await writeContainer([...jpegs.map((data) => ({ type: 'LFC', data })), { type: 'LFM', data: encodeJson(toc) }]);
  const pic = await readLightFieldPicture(bufferReader(bytes));
  assert.equal(pic.stacks.length, 1);
  assert.equal(pic.stacks[0].kind, 'focus');
  assert.deepEqual(pic.stacks[0].images.map((i) => i.lambda), [-1, 0, 1]);
});

test('second generation files expose perspective images and depth maps', async () => {
  const jpegs = [0, 1].map((i) => Uint8Array.from([0xff, 0xd8, 0xff, 0x10 + i]));
  const depth = Uint8Array.from([0, 64, 128, 255]);
  const frameDepth = Uint8Array.from([1, 2, 3, 4, 5, 6]);
  const refs = await Promise.all([...jpegs, depth, frameDepth].map(refFor));
  const toc = {
    frames: [{ frame: {}, accelerations: [{ kind: 'depthMap', width: 3, height: 2, minLambda: -5, maxLambda: 5, depthMap: { imageRef: refs[3], representation: 'packedEncodedByte' } }] }],
    views: [{ accelerations: [{
      kind: 'edofWarp', width: 2, height: 2, pitchRatio: { x: 0.5, y: 0.5 },
      perImage: [{ imageRef: refs[0], perspective: { u: 0, v: 0 } }, { imageRef: refs[1], perspective: { u: 0.2, v: -0.1 } }],
      depthMap: { imageRef: refs[2], representation: 'packedEncodedByte', width: 2, height: 2, minLambda: -4, maxLambda: 6 },
    }] }],
  };
  const { bytes } = await writeContainer([...[...jpegs, depth, frameDepth].map((data) => ({ type: 'LFC', data })), { type: 'LFM', data: encodeJson(toc) }]);
  const pic = await readLightFieldPicture(bufferReader(bytes));
  assert.equal(pic.stacks.length, 1);
  const warp = pic.stacks[0];
  assert.equal(warp.kind, 'warp');
  assert.deepEqual(warp.images.map((i) => i.coord), [{ x: 0, y: 0 }, { x: 0.2, y: -0.1 }]);
  assert.deepEqual([...warp.depth.bytes], [...depth]);
  assert.equal(warp.depth.minLambda, -4);
  assert.equal(pic.frameDepth.width, 3);
  assert.deepEqual([...pic.frameDepth.bytes], [...frameDepth]);
});

test('first generation files keep refocus stacks and their depth table', async () => {
  const jpegs = [0, 1].map((i) => Uint8Array.from([0xff, 0xd8, 0xff, 0x20 + i]));
  const lut = new Uint8Array(new Float32Array([1, 2, 3, 4]).buffer);
  const refs = await Promise.all([...jpegs, lut].map(refFor));
  const toc = {
    picture: { accelerationArray: [{ type: 'com.lytro.acceleration.refocusStack', vendorContent: {
      imageArray: refs.slice(0, 2).map((r, i) => ({ imageRef: r, lambda: i * 2 })),
      depthLut: { imageRef: refs[2], width: 2, height: 2 },
    } }] },
  };
  const { bytes } = await writeContainer([...[...jpegs, lut].map((data) => ({ type: 'LFC', data })), { type: 'LFM', data: encodeJson(toc) }]);
  const pic = await readLightFieldPicture(bufferReader(bytes));
  assert.equal(pic.stacks.length, 1);
  assert.equal(pic.stacks[0].kind, 'focus');
  assert.deepEqual(pic.stacks[0].images.map((i) => i.lambda), [0, 2]);
  assert.equal(pic.stacks[0].depth.representation, 'packedFloat');
});

test('cameraInfo reads ILLUM mosaic and microlens geometry', () => {
  const cam = cameraInfo({
    camera: { model: 'ILLUM' },
    image: { width: 7728, height: 5368, pixelPacking: { bitsPerPixel: 10 }, mosaic: { upperLeftPixel: 'gr' } },
    devices: { sensor: { pixelPitch: 1.4e-6 }, mla: { lensPitch: 2e-5, rotation: -0.0005, scaleFactor: { x: 1, y: 1 }, sensorOffset: { x: 0, y: 0 } } },
  });
  assert.deepEqual(cam.cfa, [[1, 0], [2, 1]]);
  assert.ok(Math.abs(cam.mla.pitch - 14.2857) < 1e-3);
  assert.equal(cam.black[0], 64);
});

// One shared synthetic capture keeps the suite fast.
const synthetic = (async () => {
  const bytes = await makeSyntheticLfr({ width: 1400, height: 1000, rotation: 0.0008, offsetX: 4.2, offsetY: -3.1 });
  return decodeLightField(bytes);
})();

test('calibration recovers the microlens grid of a synthetic capture', async () => {
  const lf = await synthetic;
  assert.equal(lf.cam.model, 'ILLUM');
  assert.ok(lf.gridQuality > lf.metadataGridQuality, 'calibration should beat raw metadata');
  assert.ok(Math.abs(lf.grid.pitch - 14.2857) < 0.02, `pitch ${lf.grid.pitch}`);
  assert.ok(Math.abs(lf.grid.rotation - 0.0008) < 0.0003, `rotation ${lf.grid.rotation}`);
});

test('refocusing finds the front and back layers at opposite alphas', async () => {
  const lf = await synthetic;
  const dev = makeDevelopParams(lf.cam);
  const sampler = buildSampler(lf.grid, lf.cam, 1);
  const views = apertureSamples(lf.grid.pitch * 0.32, 5)
    .map(({ u, v }) => ({ u, v, rgb: renderView(lf.raw, lf.cam, dev, sampler, u, v), gain: 1, detail: 1 }));
  const bestAlpha = (x, y) => {
    let best = null;
    for (let a = -0.6; a <= 0.6001; a += 0.05) {
      const s = sharpness(refocus(views, sampler.outW, sampler.outH, a), sampler.outW, sampler.outH, x, y, 3);
      if (!best || s > best.s) best = { a, s };
    }
    return best.a;
  };
  // Middle of the banded front bar, and the background checkerboard top left
  // (scene layout from synthetic.js, in sensor pixels).
  const unit = Math.min(lf.cam.width, lf.cam.height);
  const front = bestAlpha(...sensorToOutput(sampler, lf.cam.width / 2 - unit * 0.37, lf.cam.height / 2));
  const back = bestAlpha(...sensorToOutput(sampler, lf.cam.width * 0.09, lf.cam.height * 0.12));
  assert.ok(front < -0.1, `front ${front}`);
  assert.ok(back > 0.1, `back ${back}`);
});

test('high resolution render is larger and keeps the scene', async () => {
  const lf = await synthetic;
  const dev = makeDevelopParams(lf.cam);
  const sampler = buildSampler(lf.grid, lf.cam, 1);
  const base = renderView(lf.raw, lf.cam, dev, sampler, 0, 0);
  const vg = estimateVignetting(lf.raw, lf.cam, dev, lf.grid);
  const sr = renderSuperRes(lf.raw, lf.cam, dev, sampler, { alpha: -0.3, scale: 3, vignetting: vg, base, baseW: sampler.outW, baseH: sampler.outH });
  assert.equal(sr.width, sampler.outW * 3);
  // Mean brightness matches the standard render within 15%.
  const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  const ratio = mean(sr.rgb) / mean(base);
  assert.ok(ratio > 0.85 && ratio < 1.15, `brightness ratio ${ratio}`);
});

// Real camera files, if available: LYTRO_SAMPLES=/path/to/dir npm test
const samples = process.env.LYTRO_SAMPLES;
for (const name of samples ? fs.readdirSync(samples).filter((f) => /\.(lfr|lfp)$/i.test(f)) : []) {
  test(`decodes real file ${name}`, async () => {
    const lf = await decodeLightField(new Uint8Array(fs.readFileSync(path.join(samples, name))));
    assert.ok(lf.raw || lf.stacks.length, 'no image data');
    if (lf.raw) assert.ok(lf.gridQuality > 0.3, `grid quality ${lf.gridQuality}`);
  });
}

test('hot pixels are replaced by their same-color neighbors', async () => {
  const { removeHotPixels } = await import('../app/js/core/raw.js');
  const w = 10;
  const raw = new Uint16Array(w * w).fill(100);
  raw[5 * w + 5] = 1000; // hot
  raw[3 * w + 4] = 180; // ordinary detail
  assert.equal(removeHotPixels(raw, w, w), 1);
  assert.equal(raw[5 * w + 5], 100);
  assert.equal(raw[3 * w + 4], 180);
});

test('depth smoothing evens out noise but keeps edges where the picture has them', async () => {
  const { smoothDepth } = await import('../app/js/core/depth.js');
  const w = 20;
  const h = 10;
  const guide = new Float32Array(w * h * 3);
  const depth = new Float32Array(w * h);
  let s = 3;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647) - 0.5;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const near = x < 10; // a near object on the left, brighter in the picture
      guide.fill(near ? 0.8 : 0.1, 3 * (y * w + x), 3 * (y * w + x) + 3);
      depth[y * w + x] = (near ? -1 : 1) + 0.3 * rnd();
    }
  }
  const out = smoothDepth(depth, w, h, guide, { amount: 0.5 });
  const spread = (a, x0, x1) => { let lo = Infinity, hi = -Infinity; for (let y = 0; y < h; y++) for (let x = x0; x < x1; x++) { lo = Math.min(lo, a[y * w + x]); hi = Math.max(hi, a[y * w + x]); } return hi - lo; };
  assert.ok(spread(out, 0, 9) < 0.5 * spread(depth, 0, 9), 'noise reduced');
  assert.ok(out[5 * w + 9] < -0.7 && out[5 * w + 10] > 0.7, 'edge kept sharp');
});
