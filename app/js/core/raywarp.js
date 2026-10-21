// The camera's own correction of its rays. Every raw ILLUM file carries a
// calibration table (the "aberration correction" section) that says, for a ray
// at a place on the sensor and a direction through its lens, how far the real
// ray is from the ideal one: a shift of where it comes from (dx, dy) and of
// its direction (du, dv). Without it, rays that left the lens at different
// angles do not meet where the depth says they should, and the picture comes
// out soft away from the middle (a close-up taken with the zoom out: about
// three depth units of focus off in the middle, one and a half at the sides).
//
// File layout (little endian): 26 header words, then four arrays:
//   words 0..6   magic 0xaf0990fa, version 3, count, 0, byte size, grid width,
//                grid height
//   words 7..10  smallest value of the four axes (x, y, u, v), 11..14 the
//                extents, 15..18 the steps, 19 the border nodes per side,
//                20 weight precision (0: one byte)
//   words 21..25 table parameters: largest radius (image) 0.58, largest
//                radius (direction) 0.58, steps 0.008 (image radius), 0.03
//                (direction radius), 0.05 (angle)
//   then, for na x nb x nc nodes: A (2 floats), B (2 floats), A valid (1 byte),
//   B valid (1 byte). Node (ia, ib, ic) is at ia + na * (ic + nc * ib).
// The optics are round, so the table is indexed by the radius of the image
// position, the radius of the direction and the angle between the two; A holds
// the shifts along the radius (xy and uv) as a function of the cosine of that
// angle, B the sideways shifts as a function of its sine.
//
// Positions are in units of the image width / height from the center (-0.5 to
// 0.5), directions in lens pitches from the lens center.

const MAGIC = 0xaf0990fa;

// The field curvature of the rays as a change of the depth map (see focusAt).
export const FOCUS_FIELD = { on: false, gain: 1, across: 24, down: 16 };

export function parseRayWarp(bytes, width, height, { tilt = true } = {}) {
  if (!bytes || bytes.length < 104) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== MAGIC || view.getInt32(4, true) !== 3) return null;
  if (view.getInt32(16, true) !== bytes.length || view.getInt32(80, true) !== 0) return null;
  const f = (i) => view.getFloat32(4 * i, true);
  const mins = [f(7), f(8), f(9), f(10)];
  const ext = [f(11), f(12), f(13), f(14)];
  const step = [f(15), f(16), f(17), f(18)];
  const border = view.getInt32(76, true);
  const [aMax, bMax, stepA, stepB, stepC] = [f(21), f(22), f(23), f(24), f(25)];
  const r = Math.fround;
  const na = Math.ceil(r(r(r(1) / stepA) * aMax)) + 2;
  const nb = Math.ceil(r(r(r(1) / stepB) * bMax)) + 2;
  const nc = Math.ceil(r(r(r(1) / stepC) * 2)) + 2;
  const nodes = na * nb * nc;
  if (104 + 18 * nodes !== bytes.length) return null;
  const A = new Float32Array(nodes * 2);
  const B = new Float32Array(nodes * 2);
  for (let i = 0; i < nodes * 2; i++) {
    A[i] = view.getFloat32(104 + 4 * i, true);
    B[i] = view.getFloat32(104 + 8 * nodes + 4 * i, true);
  }
  const maskA = bytes.subarray(104 + 16 * nodes, 104 + 17 * nodes);
  const maskB = bytes.subarray(104 + 17 * nodes, 104 + 18 * nodes);
  const table = { na, nb, nc, A, B, maskA, maskB, stepA, stepB, stepC };
  const n = [0, 1, 2, 3].map((k) => Math.trunc(1 + (1 / step[k]) * ext[k] + 2 * border));
  const dense = buildDense(table, { mins, step, n, border }, width, height);
  return makeEvaluator(dense, n, mins, step, border, tilt);
}

// Trilinear lookup in one of the radial tables, normalized by the nodes that are valid.
function lookup(tab, mask, table, ia, ib, ic, fa, fb, fc, out) {
  const { na, nb, nc } = table;
  let x = 0;
  let y = 0;
  let w = 0;
  for (let da = 0; da < 2; da++) {
    const wa = da ? fa : 1 - fa;
    for (let db = 0; db < 2; db++) {
      const wb = db ? fb : 1 - fb;
      for (let dc = 0; dc < 2; dc++) {
        const wc = dc ? fc : 1 - fc;
        const q = Math.min(na - 1, ia + da) + na * (Math.min(nc - 1, ic + dc) + nc * Math.min(nb - 1, ib + db));
        if (!mask[q]) continue;
        const k = wa * wb * wc;
        x += k * tab[2 * q];
        y += k * tab[2 * q + 1];
        w += k;
      }
    }
  }
  out[0] = w > 0 ? x / w : 0;
  out[1] = w > 0 ? y / w : 0;
  return w;
}

// The correction on a regular grid over (x, y, u, v), the way the evaluator
// reads it: values (dx, dy, du, dv) and whether the node is covered.
function buildDense(table, grid, width, height) {
  const { mins, step, n, border } = grid;
  const diag = Math.hypot(width, height);
  const size = n[0] * n[1] * n[2] * n[3];
  const values = new Float32Array(size * 4);
  const covered = new Uint8Array(size);
  const a = [0, 0];
  const b = [0, 0];
  let o = 0;
  for (let ix = 0; ix < n[0]; ix++) {
    const x = mins[0] + step[0] * (ix - border);
    for (let iy = 0; iy < n[1]; iy++) {
      const y = mins[1] + step[1] * (iy - border);
      const px = (width / diag) * x;
      const py = (height / diag) * y;
      const ra = Math.hypot(px, py);
      const nx = ra > 0 ? px / ra : 0;
      const ny = ra > 0 ? py / ra : py;
      for (let iu = 0; iu < n[2]; iu++) {
        const u = mins[2] + step[2] * (iu - border);
        for (let iv = 0; iv < n[3]; iv++, o++) {
          const v = mins[3] + step[3] * (iv - border);
          const rb = Math.hypot(u, v);
          const prod = ra * rb;
          const cos = prod > 0 ? (v * py + u * px) / prod : 1;
          const sin = prod > 0 ? (-py * u + v * px) / prod : 0;
          const ta = ra / table.stepA;
          const tb = rb / table.stepB;
          const tc = (cos + 1) / table.stepC;
          const td = (sin + 1) / table.stepC;
          const ia = Math.floor(ta);
          const ib = Math.floor(tb);
          const ic = Math.floor(tc);
          const id = Math.floor(td);
          if (ia < 0 || ib < 0 || ic < 0 || id < 0 || ia + 1 >= table.na || ib + 1 >= table.nb || ic + 1 >= table.nc || id + 1 >= table.nc) continue;
          const wA = lookup(table.A, table.maskA, table, ia, ib, ic, ta - ia, tb - ib, tc - ic, a);
          const wB = lookup(table.B, table.maskB, table, ia, ib, id, ta - ia, tb - ib, td - id, b);
          if (!(wA + wB > 0)) continue;
          covered[o] = 1;
          values[4 * o] = (b[0] * -ny + a[0] * nx) * (diag / width);
          values[4 * o + 1] = (b[0] * nx + a[0] * ny) * (diag / height);
          values[4 * o + 2] = b[1] * -ny + a[1] * nx;
          values[4 * o + 3] = b[1] * nx + a[1] * ny;
        }
      }
    }
  }
  return { values, covered };
}

// Reads the grid at a ray: the sum of the 16 surrounding nodes' values and the
// sum of their weights where covered (the shift is the first over the second).
function makeEvaluator(dense, n, mins, step, border, removeTilt) {
  const { values, covered } = dense;
  const strideV = 1;
  const strideU = n[3];
  const strideY = n[2] * n[3];
  const strideX = n[1] * n[2] * n[3];
  const t = [0, 0, 0, 0];
  const i = [0, 0, 0, 0];
  const fr = [0, 0, 0, 0];
  const locate = (q) => {
    for (let k = 0; k < 4; k++) {
      t[k] = border + (q[k] - mins[k]) / step[k];
      i[k] = Math.min(n[k] - 2, Math.max(0, Math.floor(t[k])));
      fr[k] = t[k] - i[k];
    }
  };
  const sample = (q, out) => {
    locate(q);
    let w = 0;
    out[0] = out[1] = out[2] = out[3] = 0;
    for (let c = 0; c < 16; c++) {
      const dx = c & 1;
      const dy = (c >> 1) & 1;
      const du = (c >> 2) & 1;
      const dv = (c >> 3) & 1;
      const k = (dx ? fr[0] : 1 - fr[0]) * (dy ? fr[1] : 1 - fr[1]) * (du ? fr[2] : 1 - fr[2]) * (dv ? fr[3] : 1 - fr[3]);
      const node = (i[0] + dx) * strideX + (i[1] + dy) * strideY + (i[2] + du) * strideU + (i[3] + dv) * strideV;
      if (!covered[node]) continue;
      out[0] += k * values[4 * node];
      out[1] += k * values[4 * node + 1];
      out[2] += k * values[4 * node + 2];
      out[3] += k * values[4 * node + 3];
      w += k;
    }
    if (w > 0) for (let k = 0; k < 4; k++) out[k] /= w;
    return w;
  };
  const tmp = [0, 0, 0, 0];
  // The grid shows the size the center view's image comes out at after the
  // correction; the correction is scaled so that picture fills the frame again.
  const wx = sample([0.5, 0, 0, 0], tmp) && tmp[0] + 0.5;
  const wxm = sample([-0.5, 0, 0, 0], tmp) && tmp[0] - 0.5;
  const hy = sample([0, 0.5, 0, 0], tmp) && tmp[1] + 0.5;
  const hym = sample([0, -0.5, 0, 0], tmp) && tmp[1] - 0.5;
  const scale = 1 / Math.min(wx - wxm, hy - hym);
  if (Number.isFinite(scale) && scale > 0) {
    for (let ix = 0; ix < n[0]; ix++) {
      const x = mins[0] + step[0] * (ix - border);
      for (let iy = 0; iy < n[1]; iy++) {
        const y = mins[1] + step[1] * (iy - border);
        const base = (ix * strideX + iy * strideY) * 4;
        for (let r = 0; r < strideY; r++) {
          const q = base + 4 * r;
          values[q] = scale * (values[q] + x) - x;
          values[q + 1] = scale * (values[q + 1] + y) - y;
        }
      }
    }
  }

  // The table also holds a term that grows with the direction through the lens
  // (a ray that leaves at an angle is moved in proportion to that angle: a
  // defocus, as the camera was calibrated at a focus other than infinity). It is
  // read at the image center from how the shift changes with the direction, and
  // taken out of every node, so that the rays focus at depth zero again.
  let tiltX = 0;
  let tiltY = 0;
  if (removeTilt) {
    const h = 1e-4;
    const lo = [0, 0, 0, 0];
    sample([0, 0, h, 0], tmp);
    sample([0, 0, -h, 0], lo);
    tiltX = ((tmp[0] - lo[0]) / (2 * h));
    sample([0, 0, 0, h], tmp);
    sample([0, 0, 0, -h], lo);
    tiltY = ((tmp[1] - lo[1]) / (2 * h));
    for (let ix = 0; ix < n[0]; ix++) {
      for (let iy = 0; iy < n[1]; iy++) {
        for (let iu = 0; iu < n[2]; iu++) {
          const u = mins[2] + step[2] * (iu - border);
          for (let iv = 0; iv < n[3]; iv++) {
            const node = ix * strideX + iy * strideY + iu * strideU + iv;
            if (!covered[node]) continue;
            const v = mins[3] + step[3] * (iv - border);
            values[4 * node] -= u * tiltX;
            values[4 * node + 1] -= v * tiltY;
          }
        }
      }
    }
  }

  return {
    scale,
    tilt: [tiltX, tiltY],
    // The grid as images for the GPU: texel (ix * nu + iu, iy * nv + iv) holds
    // (dx, dy, du, dv), and a second image 1 where the node is covered.
    gridImages() {
      const w = n[0] * n[2];
      const h = n[1] * n[3];
      const grid = new Float32Array(w * h * 4);
      const cover = new Float32Array(w * h);
      for (let ix = 0; ix < n[0]; ix++) {
        for (let iy = 0; iy < n[1]; iy++) {
          for (let iu = 0; iu < n[2]; iu++) {
            for (let iv = 0; iv < n[3]; iv++) {
              const node = ix * strideX + iy * strideY + iu * strideU + iv;
              const texel = (iy * n[3] + iv) * w + ix * n[2] + iu;
              cover[texel] = covered[node];
              for (let k = 0; k < 4; k++) grid[4 * texel + k] = values[4 * node + k];
            }
          }
        }
      }
      return { width: w, height: h, grid, cover, nodes: n.slice(), mins: mins.slice(), step: step.slice(), border };
    },
    // The depth (in lambda) at which the corrected rays of an image position
    // (x, y: -0.5..0.5) come together, relative to the middle of the picture:
    // the rays of a lens are shifted in proportion to their direction by an
    // amount that changes across the picture (field curvature), so a flat
    // scene is in focus at a different depth in the corners than in the middle.
    // Read from how the shift changes with the direction (`kx`, `ky`: lens
    // pitch over image width and height).
    focusAt(x, y, kx, ky) {
      const us = [-0.3, -0.15, 0, 0.15, 0.3];
      const q = [0, 0, 0, 0];
      const slope = (axis, k) => {
        let su = 0;
        let sm = 0;
        let suu = 0;
        let sum = 0;
        for (const u of us) {
          q[0] = x;
          q[1] = y;
          q[2] = axis === 0 ? u : 0;
          q[3] = axis === 1 ? u : 0;
          sample(q, tmp);
          const m = tmp[axis];
          su += u;
          sm += m;
          suu += u * u;
          sum += u * m;
        }
        return -((us.length * sum - su * sm) / (us.length * suu - su * su)) / k;
      };
      return 0.5 * (slope(0, kx) + slope(1, ky));
    },
    // How far the depth map has to move (in focus units, the app's alpha) so
    // that rays with the tilt taken out still meet where the depth says: the
    // tilt is a defocus, and the depth maps are measured with it in.
    alphaShift(grid, width, height) {
      const perPitch = 0.5 * (tiltX * width + tiltY * height); // sensor pixels of shift per lens pitch of direction
      return -perPitch / (grid.rowStep * grid.pitch);
    },
    // (dx, dy, du, dv) at a ray: image position (x, y) and direction (u, v) in lens pitches.
    at(x, y, u, v, out) {
      const w = sample([x, y, u, v], out);
      if (!(w > 0)) out[0] = out[1] = out[2] = out[3] = 0;
      return out;
    },
    // A cheaper reader for all the rays of one lens: the 16 x 16 directions of
    // the grid at this image position, then `fromLens` for each ray.
    lens(x, y) {
      locate([x, y, 0, 0]);
      const fx = fr[0];
      const fy = fr[1];
      const ix = i[0];
      const iy = i[1];
      const cells = n[2] * n[3];
      const sums = new Float32Array(cells * 4);
      const weights = new Float32Array(cells);
      for (let c = 0; c < 4; c++) {
        const dx = c & 1;
        const dy = (c >> 1) & 1;
        const k = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy);
        const base = (ix + dx) * strideX + (iy + dy) * strideY;
        for (let r = 0; r < cells; r++) {
          if (!covered[base + r]) continue;
          const q = 4 * (base + r);
          sums[4 * r] += k * values[q];
          sums[4 * r + 1] += k * values[q + 1];
          sums[4 * r + 2] += k * values[q + 2];
          sums[4 * r + 3] += k * values[q + 3];
          weights[r] += k;
        }
      }
      return { sums, weights };
    },
    fromLens(cell, u, v, out) {
      const tu = border + (u - mins[2]) / step[2];
      const tv = border + (v - mins[3]) / step[3];
      const iu = Math.min(n[2] - 2, Math.max(0, Math.floor(tu)));
      const iv = Math.min(n[3] - 2, Math.max(0, Math.floor(tv)));
      const fu = tu - iu;
      const fv = tv - iv;
      let w = 0;
      out[0] = out[1] = out[2] = out[3] = 0;
      for (let c = 0; c < 4; c++) {
        const du = c & 1;
        const dv = (c >> 1) & 1;
        const k = (du ? fu : 1 - fu) * (dv ? fv : 1 - fv);
        const r = (iu + du) * strideU + (iv + dv);
        out[0] += k * cell.sums[4 * r];
        out[1] += k * cell.sums[4 * r + 1];
        out[2] += k * cell.sums[4 * r + 2];
        out[3] += k * cell.sums[4 * r + 3];
        w += k * cell.weights[r];
      }
      if (w > 0) for (let k = 0; k < 4; k++) out[k] /= w;
      else out[0] = out[1] = out[2] = out[3] = 0;
      return out;
    },
  };
}
