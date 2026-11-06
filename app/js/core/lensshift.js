// Per-lens centre corrections for the engine's ray model. The lens lattice (and the geometry table's smooth cell offsets) put every microlens at a regular place; the lenses
// themselves are a little off it, each by its own amount (a few tenths of a sensor pixel). A ray taken through a lens at its lattice place then has the wrong direction, and
// out of focus, where the lenses' views differ most, the errors add up to a pattern at the lens grid's period (the diamond lattice at 3x). The lens's real centre is the
// centre of its disc in a white image (an evenly lit white surface seen through the lens): the camera's white images from its calibration, or the one stored inside the photo.

import { lensTable, lensIndex } from './superres.js';
import { lensRange, toLocal } from './lenslet.js';
import { whiteOffsets } from './calibration.js';

// The part of each lens's offset that is not smooth over the sensor: the mean of the valid lenses within `radius` lenses is taken off (the geometry table already has the smooth
// part). Entries the white image could not measure stay 0.
export function removeSmoothOffsets(table, radius = 5) {
  const { rows, cols } = table;
  const have = new Uint8Array(rows * cols);
  for (let i = 0; i < have.length; i++) have[i] = table.dx[i] !== 0 || table.dy[i] !== 0 ? 1 : 0;
  const sum = (src) => {
    // box sums by rows then columns
    const tmp = new Float64Array(rows * cols);
    const out = new Float64Array(rows * cols);
    for (let r = 0; r < rows; r++) {
      let acc = 0;
      for (let c = -radius; c <= radius; c++) if (c >= 0 && c < cols) acc += src[r * cols + c];
      for (let c = 0; c < cols; c++) {
        tmp[r * cols + c] = acc;
        if (c + radius + 1 < cols) acc += src[r * cols + c + radius + 1];
        if (c - radius >= 0) acc -= src[r * cols + c - radius];
      }
    }
    for (let c = 0; c < cols; c++) {
      let acc = 0;
      for (let r = -radius; r <= radius; r++) if (r >= 0 && r < rows) acc += tmp[r * cols + c];
      for (let r = 0; r < rows; r++) {
        out[r * cols + c] = acc;
        if (r + radius + 1 < rows) acc += tmp[(r + radius + 1) * cols + c];
        if (r - radius >= 0) acc -= tmp[(r - radius) * cols + c];
      }
    }
    return out;
  };
  const n = sum(have);
  const sx = sum(table.dx);
  const sy = sum(table.dy);
  const dx = new Float32Array(rows * cols);
  const dy = new Float32Array(rows * cols);
  for (let i = 0; i < rows * cols; i++) {
    if (!have[i] || !(n[i] > 0)) continue;
    dx[i] = table.dx[i] - sx[i] / n[i];
    dy[i] = table.dy[i] - sy[i] / n[i];
  }
  table.dx = dx;
  table.dy = dy;
  return table;
}

// The offsets of the lenses of the engine's lattice `ge` ({ ox, oy, pitch, rowStep, rotation }, sensor pixel indices) for a photo with lens grid `appGrid`, from the white image
// `white` (core/calibration.js measureWhite / measureWhiteRaw). Returns { r0, c0, rows, cols, du, dv, count } with (du, dv) each lens's centre offset in sensor pixels along the
// lattice's own axes, indexed by (row - r0) * cols + (column - c0) of the lattice; null when too few lenses could be measured.
export function engineLensShift(white, appGrid, cam, ge, { smooth = 5, minLenses = 1000 } = {}) {
  const table = lensTable(appGrid, cam);
  if (whiteOffsets(white, appGrid, table) < minLenses) return null;
  return engineLensShiftFromTable(table, appGrid, cam, ge, smooth);
}

// The same from a table of offsets already measured on the photo's lens grid (superres.js lensTable: dx, dy in sensor pixels; the photo's own measurement). A shift the lenses
// have in common is no lens's own, and goes with the smooth part.
export function engineLensShiftFromTable(source, appGrid, cam, ge, smooth = 5) {
  const table = { r0: source.r0, c0: source.c0, rows: source.rows, cols: source.cols, dx: Float32Array.from(source.dx), dy: Float32Array.from(source.dy) };
  if (smooth > 0) removeSmoothOffsets(table, smooth);
  const range = lensRange(ge, cam.width, cam.height, ge.pitch);
  const r0 = range.r0 - 1;
  const c0 = range.c0 - 1;
  const rows = range.r1 - range.r0 + 3;
  const cols = range.c1 - range.c0 + 3;
  const du = new Float32Array(rows * cols);
  const dv = new Float32Array(rows * cols);
  const cos = Math.cos(ge.rotation);
  const sin = Math.sin(ge.rotation);
  let count = 0;
  for (let r = 0; r < rows; r++) {
    const ly = (r + r0) * ge.rowStep;
    for (let c = 0; c < cols; c++) {
      const lx = (c + c0) * ge.pitch + ((r + r0) & 1) * ge.pitch * 0.5;
      const x = ge.ox + cos * lx - sin * ly;
      const y = ge.oy + sin * lx + cos * ly;
      const [ax, ay] = toLocal(appGrid, x, y);
      const k = lensIndex(table, appGrid, ax, ay);
      if (k < 0) continue;
      const dx = table.dx[k];
      const dy = table.dy[k];
      if (dx === 0 && dy === 0) continue;
      du[r * cols + c] = cos * dx + sin * dy;
      dv[r * cols + c] = -sin * dx + cos * dy;
      count++;
    }
  }
  return count ? { r0, c0, rows, cols, du, dv, count } : null;
}

// The offset of the lens at lattice position (r, c), in sensor pixels along the lattice's axes.
export function lensShiftAt(shift, r, c, out = [0, 0]) {
  const rr = r - shift.r0;
  const cc = c - shift.c0;
  if (rr < 0 || cc < 0 || rr >= shift.rows || cc >= shift.cols) {
    out[0] = 0;
    out[1] = 0;
  } else {
    out[0] = shift.du[rr * shift.cols + cc];
    out[1] = shift.dv[rr * shift.cols + cc];
  }
  return out;
}
