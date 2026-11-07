import test from 'node:test';
import assert from 'node:assert/strict';
import { preColorKey, COLOR_PASS_SETTINGS } from '../app/js/core/precolorkey.js';
import { COLOR_SETTINGS } from '../app/js/settingsmap.js';

const base = {
  ev: 0, saturation: 1, wb: { kelvin: 5000, tint: 0 }, tone: { contrast: 0 }, lens: { auto: true, distortion: 0, vignetting: 0 }, defringe: { on: false },
  curve: { points: [] }, ccm: null, local: { masks: [] }, details: { amount: 25 }, mvDenoise: { on: true, blend: 0.5 }, depthSmoothing: 0.3, latticeOn: true, detail: 2,
};

test('a change to a color setting keeps the picture before the color pass', () => {
  const key = preColorKey(base, [1, 2], ['edof', 3], ['details']);
  for (const changed of [
    { ...base, ev: 1 }, { ...base, saturation: 1.4 }, { ...base, wb: { kelvin: 6500, tint: 5 } }, { ...base, tone: { contrast: 0.3 } }, { ...base, lens: { auto: false, distortion: 20, vignetting: 10 } },
    { ...base, defringe: { on: true } }, { ...base, curve: { points: [[0, 0], [1, 1]] } }, { ...base, local: { masks: [{ kind: 'depth' }] } }, { ...base, details: { amount: 80 } },
  ]) assert.equal(preColorKey(changed, [1, 2], ['edof', 3], ['details']), key);
});

test('a change to anything that shapes the picture makes a new key', () => {
  const key = preColorKey(base, [1, 2], ['edof', 3], ['details']);
  for (const changed of [
    { ...base, mvDenoise: { on: false, blend: 0.5 } }, { ...base, depthSmoothing: 0.6 }, { ...base, latticeOn: false }, { ...base, detail: 1 }, { ...base, lensCentres: 'off' },
    { ...base, someNewSetting: 1 },
  ]) assert.notEqual(preColorKey(changed, [1, 2], ['edof', 3], ['details']), key);
  assert.notEqual(preColorKey(base, [1, 3], ['edof', 3], ['details']), key);
  assert.notEqual(preColorKey(base, [1, 2], ['edof', 4], ['details']), key);
  // where the sharpening and noise reduction run before the color pass (the graphics card's picture), they count
  assert.notEqual(preColorKey({ ...base, details: { amount: 80 } }, [1, 2], ['sr']), preColorKey(base, [1, 2], ['sr']));
});

test('every row of the color table is a color pass setting', () => {
  for (const [path] of COLOR_SETTINGS) assert.ok(COLOR_PASS_SETTINGS.has(path.split('.')[0]), path);
});
