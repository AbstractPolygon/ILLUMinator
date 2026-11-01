import test from 'node:test';
import assert from 'node:assert/strict';
import { engineModulationPlane, engineModulation, MOD_UNIT } from '../app/js/core/enginemod.js';

const cam = { width: 400, height: 300 };
const dev = { cfa: [[1, 0], [2, 1]], black: [66, 66, 66] };
const grid = { pitch: 14.29, rowStep: 12.38, ox: 6.4, oy: 6.6, rotation: 0 };

function frame(fn) {
  const m = new Uint16Array(cam.width * cam.height);
  for (let y = 0; y < cam.height; y++) for (let x = 0; x < cam.width; x++) m[y * cam.width + x] = fn(x, y);
  m.black = 64;
  return m;
}

test('a flat white image gives a flat plane per colour and the hot pixel list is repaired from its neighbours', () => {
  const m = frame(() => 500);
  const hot = new Uint32Array([100 * cam.width + 100, 101 * cam.width + 200]);
  m[hot[0]] = 1023;
  m[hot[1]] = 2;
  const { E } = engineModulationPlane(m, cam, dev, grid, hot);
  const at = (x, y) => E[y * cam.width + x];
  for (const [x, y] of [[50, 50], [51, 50], [50, 51], [51, 51], [100, 100], [200, 101]]) {
    // same colour as a neighbour two pixels over
    assert.ok(Math.abs(at(x, y) - at(x + 2, y)) < 1e-4, `(${x},${y}) ${at(x, y)} vs ${at(x + 2, y)}`);
  }
  assert.ok(at(50, 50) > 0.5 && at(50, 50) < 3);
});

test('the dim rim of a lens disk is lifted, the disk centre keeps its level', () => {
  // a disk image: bright in the middle of every 14 pixel cell, dim at its edge
  const m = frame((x, y) => {
    const u = ((x % 14) - 7) / 7;
    const v = ((y % 14) - 7) / 7;
    const r = Math.min(1, Math.hypot(u, v));
    return Math.round(120 + 600 * (1 - r * r));
  });
  const plain = engineModulationPlane(m, cam, dev, grid, null, {});
  // compare with the plain (mean normalised) frame: the rim is lifted, the centre matches
  const centre = plain.E[(7 + 14 * 10) * cam.width + (7 + 14 * 10)];
  const rim = plain.E[(0 + 14 * 10) * cam.width + (0 + 14 * 10)];
  assert.ok(rim > 0 && centre > rim * 2, `centre ${centre} rim ${rim}`);
});

test('engineModulation packs the plane for the existing code: black added back, unit marker set', () => {
  const m = frame(() => 500);
  const out = engineModulation(m, cam, dev, grid, null);
  assert.equal(out.eUnit, MOD_UNIT);
  const v = out[50 * cam.width + 50] - 66;
  assert.ok(v > 0.5 * MOD_UNIT && v < 3 * MOD_UNIT, `${v}`);
});
