import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultMask, parseMasks, activeMasks, maskWeight, applyLocal } from '../app/js/core/local.js';

test('masks parse with defaults filled in and junk dropped', () => {
  const m = parseMasks(JSON.stringify([{ kind: 'radial', x: 0.2 }, { kind: 'nope' }, null]));
  assert.equal(m.length, 1);
  assert.equal(m[0].x, 0.2);
  assert.equal(m[0].fx.exposure, 0);
  assert.deepEqual(parseMasks('not json'), []);
  assert.equal(activeMasks(m).length, 0);
});

test('radial, linear and depth masks weigh where they should', () => {
  const r = defaultMask('radial');
  assert.equal(maskWeight(r, 0.5, 0.5, 1.5, null), 1);
  assert.equal(maskWeight(r, 0.95, 0.5, 1.5, null), 0);
  assert.equal(maskWeight({ ...r, invert: true }, 0.95, 0.5, 1.5, null), 1);
  const l = defaultMask('linear'); // angle 90: full effect above, none below
  assert.ok(maskWeight(l, 0.5, 0.1, 1.5, null) > 0.99);
  assert.ok(maskWeight(l, 0.5, 0.9, 1.5, null) < 0.01);
  const d = defaultMask('depth');
  assert.equal(maskWeight(d, 0, 0, 1, 0), 1);
  assert.equal(maskWeight(d, 0, 0, 1, 1.2), 0);
  assert.equal(maskWeight(d, 0, 0, 1, null), 0);
});

test('effects apply by the mask weight', () => {
  const m = { ...defaultMask('radial'), fx: { exposure: 1, contrast: 0, saturation: 0, temperature: 0, tint: 0 } };
  const inside = [0.2, 0.2, 0.2];
  applyLocal(inside, [m], 0.5, 0.5, 1.5, null);
  assert.ok(Math.abs(inside[0] - 0.4) < 1e-9);
  const outside = [0.2, 0.2, 0.2];
  applyLocal(outside, [m], 0.99, 0.99, 1.5, null);
  assert.equal(outside[0], 0.2);
});
