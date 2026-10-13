import test from 'node:test';
import assert from 'node:assert/strict';
import { makeLook, applyLook, toneCurve, whiteBalanceGains } from '../app/js/core/color.js';

test('all-zero color settings need no per-pixel work', () => {
  assert.equal(makeLook({ tone: { contrast: 0 }, color: { red: 0 } }), null);
});

test('white balance keeps luminance and warms with temperature', () => {
  const [r, g, b] = whiteBalanceGains(0.5, 0);
  assert.ok(r > 1 && b < 1);
  assert.ok(Math.abs(0.2126 * r + 0.7152 * g + 0.0722 * b - 1) < 1e-9);
});

test('tone sliders move the curve the expected way', () => {
  const base = makeLook({ tone: { contrast: 1e-9 } });
  const at = (tone, x) => toneCurve(x, { ...base, ...tone });
  assert.ok(at({ shadows: 1 }, 0.25) > at({}, 0.25));
  assert.ok(at({ highlights: -1 }, 0.75) < at({}, 0.75));
  assert.ok(at({ blacks: -1 }, 0.05) < at({}, 0.05));
  assert.ok(at({ whites: 1 }, 0.9) > at({}, 0.9));
  assert.ok(at({ contrast: 1 }, 0.2) < 0.2 && at({ contrast: 1 }, 0.8) > 0.8);
});

test('hue sliders only touch their own colors', () => {
  const look = makeLook({ color: { red: -1 } });
  const red = [0.5, 0.1, 0.1];
  const blue = [0.1, 0.1, 0.5];
  applyLook(red, look);
  applyLook(blue, look);
  assert.ok(Math.abs(red[0] - red[1]) < 1e-6, 'red desaturated');
  assert.ok(blue[2] - blue[0] > 0.39, 'blue untouched');
});
