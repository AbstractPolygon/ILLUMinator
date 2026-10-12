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
    views: [{ accelerations: [{ kind: 'focusStack', perImage: refs.map((r, i) => ({ imageRef: r, lambda: i - 1 })) }] }],
  };
  const { bytes } = await writeContainer([...jpegs.map((data) => ({ type: 'LFC', data })), { type: 'LFM', data: encodeJson(toc) }]);
  const pic = await readLightFieldPicture(bufferReader(bytes));
  assert.equal(pic.stacks.length, 1);
  assert.equal(pic.stacks[0].kind, 'focusStack');
  assert.deepEqual(pic.stacks[0].images.map((i) => i.lambda), [-1, 0, 1]);
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
