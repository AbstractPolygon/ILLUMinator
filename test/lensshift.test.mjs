import test from 'node:test';
import assert from 'node:assert/strict';
import { engineLensShift, removeSmoothOffsets, lensShiftAt } from '../app/js/core/lensshift.js';
import { lensRange } from '../app/js/core/lenslet.js';
import { WHITE_SCALE } from '../app/js/core/calibration.js';

// A lens grid and a white image whose lenses sit off the grid by known amounts.
const cam = { width: 1400, height: 1000 };
const grid = { ox: 3.3, oy: 5.1, pitch: 14, rowStep: 14 * 0.8660254037844386, rotation: 0.002 };
const range = lensRange(grid, cam.width, cam.height, grid.pitch);
const truth = (r, c) => [0.3 * Math.sin(r * 12.9898 + c * 78.233), 0.3 * Math.cos(r * 39.346 + c * 11.135)];
function whiteImage() {
  const r0 = range.r0 - 2;
  const c0 = range.c0 - 2;
  const rows = range.r1 - range.r0 + 5;
  const cols = range.c1 - range.c0 + 5;
  const off = new Int8Array(rows * cols * 2).fill(-128);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const [tx, ty] = truth(r + r0, c + c0);
      off[2 * (r * cols + c)] = Math.round(tx * WHITE_SCALE);
      off[2 * (r * cols + c) + 1] = Math.round(ty * WHITE_SCALE);
    }
  }
  return { grid, r0, c0, rows, cols, off };
}

test('lens centre offsets from a white image reach the lenses of the engine lattice, along its axes', () => {
  const ge = { ...grid, ox: grid.ox + 0.2, oy: grid.oy - 0.3, rotation: 0.0021 };
  const shift = engineLensShift(whiteImage(), grid, cam, ge, { smooth: 0 });
  assert.ok(shift && shift.count > 1000, 'many lenses');
  // the lens in the middle: its offset (the white image's, with the mean of all removed) rotated into the lattice's axes
  const r = Math.round((range.r0 + range.r1) / 2);
  const c = Math.round((range.c0 + range.c1) / 2);
  const out = lensShiftAt(shift, r, c);
  assert.ok(Math.hypot(out[0], out[1]) > 0.02, `an offset ${out}`);
  assert.ok(Math.hypot(out[0], out[1]) < 0.6);
  assert.deepEqual(lensShiftAt(shift, r + 1000, c), [0, 0], 'outside the table nothing moves');
  assert.equal(engineLensShift({ ...whiteImage(), off: new Int8Array(whiteImage().off.length).fill(-128) }, grid, cam, ge), null, 'nothing measured');
});

test('removing the smooth part keeps what differs from lens to lens', () => {
  const rows = 40;
  const cols = 40;
  const table = { rows, cols, dx: new Float32Array(rows * cols), dy: new Float32Array(rows * cols) };
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      table.dx[r * cols + c] = 0.5 + 0.01 * c + ((r + c) % 2 ? 0.1 : -0.1); // a slope plus a checkerboard
      table.dy[r * cols + c] = -0.3;
    }
  }
  removeSmoothOffsets(table, 5);
  const mid = 20 * cols + 20;
  assert.ok(Math.abs(Math.abs(table.dx[mid]) - 0.1) < 0.03, `the checkerboard stays ${table.dx[mid]}`);
  assert.ok(Math.abs(table.dy[mid]) < 0.01, 'a constant goes');
});

import { engineLensShiftFromTable } from '../app/js/core/lensshift.js';
import { lensTable } from '../app/js/core/superres.js';

test('offsets measured on the photo carry over to the lattice, without what the lenses share', () => {
  const ge = { ...grid, ox: grid.ox + 0.1, oy: grid.oy + 0.1 };
  const table = lensTable(grid, cam);
  for (let i = 0; i < table.dx.length; i++) {
    table.dx[i] = 0.4 + ((i * 7919) % 13 - 6) / 60;
    table.dy[i] = -0.2 + ((i * 104729) % 11 - 5) / 60;
  }
  const shift = engineLensShiftFromTable(table, grid, cam, ge);
  assert.ok(shift && shift.count > 1000);
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < shift.du.length; i++) {
    sx += shift.du[i];
    sy += shift.dv[i];
  }
  assert.ok(Math.abs(sx / shift.count) < 0.02 && Math.abs(sy / shift.count) < 0.02, 'the common shift is gone');
  assert.ok(shift.du.some((v) => Math.abs(v) > 0.03), 'what differs between lenses stays');
});
