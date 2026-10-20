import test from 'node:test';
import assert from 'node:assert/strict';
import { makeLook, applyLook, toneCurve, whiteBalanceGains } from '../app/js/core/color.js';

test('all-zero color settings need no per-pixel work', () => {
  assert.equal(makeLook({ tone: { contrast: 0 }, color: { red: 0 } }), null);
});

test('white balance keeps luminance and warms with temperature', () => {
  const [r, g, b] = whiteBalanceGains(8000, 5500, 0);
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

test('eyedropper finds the white balance that makes a color neutral', async () => {
  const { solveWhiteBalance, whiteBalanceGains } = await import('../app/js/core/color.js');
  const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  // A grey card shot under light that needs 3500 K and tint +20 to neutralize.
  const g = whiteBalanceGains(3500, 5500, 20);
  const card = [0.5 / g[0], 0.5 / g[1], 0.5 / g[2]];
  const res = solveWhiteBalance(card, identity, 5500);
  assert.ok(Math.abs(res.kelvin - 3500) <= 100, `kelvin ${res.kelvin}`);
  assert.ok(Math.abs(res.tint - 20) <= 3, `tint ${res.tint}`);
});

test('temperature and tint move the gains the way Lytro Desktop does', () => {
  // [temperature, tint, red gain, blue gain] (green = 1): what Lytro Desktop
  // stored in stack.preadjust.lfp for photos with that temperature and tint.
  const ld = [
    [3195, 84, 1.1171, 1.8517],
    [3123, 15, 1.0429, 1.7702],
    [5051, -14, 1.3004, 1.3505],
    [6098, -69, 1.3732, 1.1662],
    [6131, -19, 1.4359, 1.2118],
  ];
  for (const [k0, t0, r0, b0] of ld) {
    for (const [k1, t1, r1, b1] of ld) {
      // From the first photo's balance to the second's.
      const g = whiteBalanceGains(k1, k0, t1 - t0);
      assert.ok(Math.abs(g[0] / g[1] / (r1 / r0) - 1) < 0.02, `red ${k0}->${k1}`);
      assert.ok(Math.abs(g[2] / g[1] / (b1 / b0) - 1) < 0.02, `blue ${k0}->${k1}`);
    }
  }
  // As shot changes nothing.
  const same = whiteBalanceGains(4200, 4200, 0);
  assert.ok(same.every((v) => Math.abs(v - 1) < 1e-9));
});
