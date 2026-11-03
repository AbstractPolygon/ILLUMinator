import test from 'node:test';
import assert from 'node:assert/strict';
import { tiledUpscale } from '../app/js/core/aiupscale.js';
import { methodModel, modelMethod, UPSCALE_MODELS, sha256Hex } from '../app/js/core/upscalemodels.js';

// A stand in for a model: every pixel repeated scale x scale times (so the right answer is known).
function nearestModel(tile, scale) {
  return async (chw) => {
    const T = tile * scale;
    const out = new Float32Array(3 * T * T);
    for (let c = 0; c < 3; c++) for (let y = 0; y < T; y++) for (let x = 0; x < T; x++) out[c * T * T + y * T + x] = chw[c * tile * tile + Math.floor(y / scale) * tile + Math.floor(x / scale)];
    return out;
  };
}

test('tiles of a picture come together as the whole enlarged picture', async () => {
  for (const [w, h] of [[10, 7], [64, 40], [13, 90]]) {
    const rgb = new Uint16Array(w * h * 3);
    for (let i = 0; i < rgb.length; i++) rgb[i] = (i * 2654435761) % 65536;
    const tile = 32;
    const out = await tiledUpscale(rgb, w, h, 4, nearestModel(tile, 4), { tile, pad: 4 });
    assert.equal(out.length, w * 4 * h * 4 * 3);
    for (let y = 0; y < h * 4; y += 3) {
      for (let x = 0; x < w * 4; x += 2) {
        for (let c = 0; c < 3; c++) assert.equal(out[3 * (y * w * 4 + x) + c], rgb[3 * (Math.floor(y / 4) * w + Math.floor(x / 4)) + c], `${w}x${h} at ${x},${y}`);
      }
    }
  }
});

test('values the model returns outside 0..1 are clipped', async () => {
  const out = await tiledUpscale(new Uint16Array(3 * 3 * 3).fill(30000), 3, 3, 2, async () => new Float32Array(3 * 16 * 16).fill(1.5).fill(-0.5, 0, 256), { tile: 8, pad: 1, onProgress: () => {} });
  assert.equal(out[0], 0);
  assert.equal(out[1], 65535);
});

test('model methods map to their models', () => {
  for (const m of UPSCALE_MODELS) assert.equal(methodModel(modelMethod(m.id)), m);
  assert.equal(methodModel('lanczos'), null);
  assert.equal(methodModel('ai:nothing'), null);
});

test('SHA-256 of bytes', async () => {
  assert.equal(await sha256Hex(new TextEncoder().encode('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
