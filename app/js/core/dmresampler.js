// Port of the Lytro Desktop engine's depth map upscaler (LFE::DmResampler, integer scaling path).
//
// The engine upscales its lens-grid depth map by an odd integer factor (5) without smearing depth steps:
//   1. Similarity masks: for every lens, which of its 8 neighbours lies within `similarity` (0.8 lambda); a second
//      "exactly equal" mask marks completely flat areas. Crossing diagonals of a full 2x2 block are removed.
//   2. Every lens cell is a "modified Voronoi" polygon (20 candidate points, corners cut or bulged toward similar
//      diagonal neighbours). The polygon edges that face a dissimilar neighbour form boundary chains, which are
//      walked across cells (hopping into similar neighbours), turned into a clamped quadratic B-spline and sampled.
//   3. Each sub pixel (at i/(factor+1) of the cell, NOT at (i-0.5)/factor) belongs to the lens whose centre it sees
//      without crossing a spline: the cell's own lens, else the horizontal neighbour, else the vertical one, else it
//      is ambiguous and is filled afterwards from the nearest valid values along a diagonal.
//   4. The value is either the owner lens depth or (blend) an inverse-distance blend of the lenses of the sub
//      pixel's quadrant that the owner is similar to, quantised to 1e-4.
//
// Arithmetic follows the engine: float32 for the masks, the line tests, the weights and the blend (Math.fround after
// every operation), float64 for the B-spline. See test/dmresampler.test.mjs, which compares this file bit for bit
// with test/dmresampler_ref.py.
//
// Behaviour that the engine leaves undefined and that is decided here (documented in the test too):
//  * a sub pixel owned by a lens outside the image (border cells only) reads the nearest lens inside the image;
//  * populateAmbiguousPixels' fallback does not read outside the image (the engine reads without bounds checks).

const f32 = Math.fround;

const DX = new Int8Array([-1, 0, 1, -1, 1, -1, 0, 1, 0]);
const DY = new Int8Array([-1, -1, -1, 0, 0, 1, 1, 1, 0]);

// kDmUpscaleSubpixCvPos: the 20 candidate polygon points in cell coordinates (all exact in float32).
const CVX = new Float64Array([0.5, 0.75, 0.75, 1, 1.25, 1, 1.25, 0.75, 1, 0.75, 0.5, 0.25, 0.25, 0, -0.25, 0, -0.25, 0.25, 0, 0.25]);
const CVY = new Float64Array([0, -0.25, 0.25, 0, 0.25, 0.5, 0.75, 0.75, 1, 1.25, 1, 1.25, 0.75, 1, 0.75, 0.5, 0.25, 0.25, 0, -0.25]);

// kDmUpscaleSubpixNeighborConnectivity[neighbour][point]: index of the same geometric point in the neighbour's ring.
const CONN = (() => {
  const t = new Int8Array(8 * 20).fill(-1);
  const rows = [
    { 16: 9, 18: 8, 19: 6 },
    { 0: 10, 1: 7, 2: 9, 3: 8, 17: 11, 18: 13, 19: 12 },
    { 1: 14, 3: 13, 4: 11 },
    { 12: 6, 13: 8, 14: 7, 15: 5, 16: 2, 17: 4, 18: 3 },
    { 2: 16, 3: 18, 4: 17, 5: 15, 6: 12, 7: 14, 8: 13 },
    { 11: 4, 13: 3, 14: 1 },
    { 7: 1, 8: 3, 9: 2, 10: 0, 11: 17, 12: 19, 13: 18 },
    { 6: 19, 8: 18, 9: 16 },
  ];
  rows.forEach((r, nb) => { for (const p in r) t[nb * 20 + +p] = r[p]; });
  return t;
})();
// Walk tables, [direction (0 backward, 1 forward)][point].
const STEP = [
  new Int8Array([1, 1, -1, 1, 2, 4, 4, -1, 4, 7, 6, 6, -1, 6, 5, 3, 3, -1, 3, 0]),
  new Int8Array([1, 2, -1, 4, 4, 4, 7, -1, 6, 6, 6, 5, -1, 3, 3, 3, 0, -1, 1, 1]),
];
const DIAG = [
  new Int8Array([0, 0, 0, 0, 2, 2, 2, 2, 2, 7, 7, 7, 7, 7, 5, 5, 5, 5, 5, 0]),
  new Int8Array([2, 2, 2, 7, 7, 7, 7, 7, 5, 5, 5, 5, 5, 0, 0, 0, 0, 0, 2, 2]),
];
const SIDE = [
  new Int8Array([3, 3, 3, 1, 1, 1, 1, 1, 4, 4, 4, 4, 4, 6, 6, 6, 6, 6, 3, 3]),
  new Int8Array([4, 4, 4, 4, 6, 6, 6, 6, 6, 3, 3, 3, 3, 3, 1, 1, 1, 1, 1, 4]),
];
// NEIGHBOR_INDEX_TO_OWNERS_NEIGHBOR_IDX[owner*9 + m]
const N2ON = new Int8Array([
  8, 4, -1, 6, -1, -1, -1, -1, 7, 3, 8, 4, 5, 7, -1, -1, -1, 6, -1, 3, 8, -1, 6, -1, -1, -1, 5,
  1, 2, -1, 8, -1, 6, 7, -1, 4, -1, 0, 1, -1, 8, -1, 5, 6, 3, -1, -1, -1, 1, -1, 8, 4, -1, 2,
  -1, -1, -1, 0, 2, 3, 8, 4, 1, -1, -1, -1, -1, 5, -1, 3, 8, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8,
]);
const QUAD = new Int8Array([0, 1, 3, 8, 1, 2, 4, 8, 4, 7, 6, 8, 6, 5, 3, 8]);
const SIDEBITS = [2, 16, 64, 8];
const CORNER_ORDER = [1, 4, 128, 32];
const NBR_DELTA = [-1, 1, 1, -1];
const COMPL = [4, 1, 32, 128];
const CORNERS = [18, 3, 8, 13];
const MIDPOINTS = [0, 5, 10, 15];
const COLLAPSED = [17, 2, 7, 12];
const EXT0 = [16, 1, 6, 11];
const EXT1 = [19, 4, 9, 14];
const SAMPLE_X = [0, f32(-1 / 3), f32(1 / 3), 0, 0];
const SAMPLE_Y = [0, 0, 0, f32(-1 / 3), f32(1 / 3)];

const SPLINE_DEGREE = 2; // DmResampler+0x0c
const SPLINE_SPS = 3; // DmResampler+0x10, spline samples per unit of parameter
const WALK_MAX = SPLINE_DEGREE + 1;
const OCCLUDED = -100; // marker of ambiguous sub pixels (0xc2c80000)
const CAP = 1024; // chain buffer capacity (entries), the chain grows from the middle

// ---- similarity masks (calcSimilarityMap) --------------------------------------------------------------------
function similarityMap(D, w, h, thr) {
  const M = new Uint8Array(w * h);
  const t = f32(thr);
  const useThr = t !== 0 || Number.isNaN(t);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const d = D[i];
      let m = 0;
      for (let k = 0; k < 8; k++) {
        const xn = x + DX[k];
        const yn = y + DY[k];
        if (xn < 0 || xn >= w || yn < 0 || yn >= h) continue;
        const dn = D[yn * w + xn];
        if (useThr) {
          // the bit is cleared when thr <= |d - dn| (float32 difference; NaN keeps the bit)
          if (!(t <= Math.abs(f32(d - dn)))) m |= 1 << k;
        } else if (d === dn) m |= 1 << k;
      }
      M[i] = m;
    }
  }
  return M;
}

// removeDiagonalsOnFull2x2
function removeDiagonals(M, D, w, h) {
  for (let y = 0; y < h - 1; y++) {
    for (let x = 0; x < w - 1; x++) {
      const a = y * w + x;
      const b = a + 1;
      const c = a + w;
      const d = c + 1;
      if ((M[a] & 0x80) && (M[b] & 0x20)) {
        if ((M[a] & 0x10) === 0) {
          if (D[b] <= D[a]) { M[a] &= 0x7f; M[d] &= 0xfe; } // keep B-C (nearer top lens)
          else { M[b] &= 0xdf; M[c] &= 0xfb; }
        } else {
          M[b] &= 0xdf; M[c] &= 0xfb; M[a] &= 0x7f; M[d] &= 0xfe;
        }
      }
    }
  }
}

// calcPixelVoronoiType + voronoiLabel2PointFlags for every cell
function voronoiFlags(M, w, h) {
  const F = new Int32Array(w * h);
  const lab = [0, 0, 0, 0];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const m = M[y * w + x];
      for (let k = 0; k < 4; k++) {
        if (CORNER_ORDER[k] & m) lab[k] = 1;
        else {
          const xn = x + NBR_DELTA[k];
          lab[k] = xn >= 0 && xn < w ? ((COMPL[k] & M[y * w + xn]) ? 2 : 0) : 0;
        }
      }
      let f = 0x8421;
      for (let k = 0; k < 4; k++) {
        const prevMid = MIDPOINTS[(k + 3) & 3];
        if (lab[k] === 2) {
          f |= 1 << COLLAPSED[k]; f &= ~(1 << prevMid); f &= ~(1 << MIDPOINTS[k]);
        } else if (lab[k] === 1) {
          f |= (1 << EXT0[k]) | (1 << EXT1[k]); f &= ~(1 << prevMid); f &= ~(1 << MIDPOINTS[k]);
        } else f |= 1 << CORNERS[k];
      }
      if (lab[0] === 0 && lab[1] === 0) f &= ~1;
      if (lab[1] === 0 && lab[2] === 0) f &= ~(1 << 5);
      if (lab[2] === 0 && lab[3] === 0) f &= ~(1 << 10);
      if (lab[3] === 0 && lab[0] === 0) f &= ~(1 << 15);
      F[y * w + x] = f;
    }
  }
  return F;
}

// linesIntersectAntonioModified, float32, after its inclusive bounding box rejection (the caller has done that:
// the engine rejects when the extent of one segment lies entirely beside the other's in x or in y). Segment
// (x1,y1)-(x2,y2) against (x3,y3)-(x4,y4); touching counts, parallel does not.
function isectArith(x1, y1, x2, y2, x3, y3, x4, y4) {
  const ax = f32(x2 - x1);
  const bx = f32(x3 - x4);
  const ay = f32(y2 - y1);
  const by = f32(y3 - y4);
  const cx = f32(x1 - x3);
  const cy = f32(y1 - y3);
  const alpha = f32(f32(by * cx) - f32(bx * cy));
  const den = f32(f32(bx * ay) - f32(by * ax));
  const beta = f32(f32(ax * cy) - f32(ay * cx));
  if (den > 0) {
    if (alpha < 0 || alpha > den || beta < 0 || beta > den) return false;
  } else if (alpha > 0 || alpha < den || beta > 0 || beta < den) return false;
  return den !== 0;
}

/**
 * Upscale a lens-grid depth map by an odd integer factor with the engine's DmResampler.
 * @param {Float32Array|number[]} depth row-major lens depth (lambda or any unit; `similarity` is in the same unit)
 * @param {number} width lens columns
 * @param {number} height lens rows
 * @param {number} factor odd integer (5)
 * @param {{similarity?: number, blend?: boolean}} [opts]
 * @returns {{data: Float32Array, width: number, height: number}} width*factor by height*factor
 */
export function dmResample(depth, width, height, factor = 5, { similarity = 0.8, blend = true } = {}) {
  const w = width | 0;
  const h = height | 0;
  const X = factor | 0;
  const Y = X;
  if (!(X >= 1) || X % 2 === 0 || X !== factor) throw new Error('dmResample: the factor must be an odd integer');
  if (!(w > 0 && h > 0) || depth.length < w * h) throw new Error('dmResample: bad depth map size');
  const D = depth instanceof Float32Array ? depth : Float32Array.from(depth);
  const thr = f32(similarity);
  const thrPos = thr > 0;
  const useBlend = thrPos && !!blend;
  const OW = w * X;
  const out = new Float32Array(OW * h * Y);

  const M = similarityMap(D, w, h, similarity);
  const Meq = useBlend ? similarityMap(D, w, h, 0) : null;
  removeDiagonals(M, D, w, h);
  const F = voronoiFlags(M, w, h);

  // ---- sub pixel tables (cell independent) -------------------------------------------------------------------
  const XY = X * Y;
  const xposT = new Float64Array(X); // float32 values i/(X+1)
  const yposT = new Float64Array(Y);
  const sx = f32(1 / (X + 1));
  const sy = f32(1 / (Y + 1));
  for (let i = 1; i <= X; i++) xposT[i - 1] = f32(i * sx);
  for (let i = 1; i <= Y; i++) yposT[i - 1] = f32(i * sy);
  const hstepX = f32(0.5 * sx);
  const hstepY = f32(0.5 * sy);
  const hdirT = new Int8Array(X);
  const vdirT = new Int8Array(Y);
  for (let i = 0; i < X; i++) hdirT[i] = 0.5 > xposT[i] ? -1 : 1;
  for (let i = 0; i < Y; i++) vdirT[i] = 0.5 > yposT[i] ? -1 : 1;
  // the 5 line of sight targets per sub pixel
  const sqx = new Float64Array(XY * 5);
  const sqy = new Float64Array(XY * 5);
  for (let e = 0; e < XY; e++) {
    const xp = xposT[e % X];
    const yp = yposT[(e / X) | 0];
    for (let k = 0; k < 5; k++) {
      sqx[e * 5 + k] = f32(f32(SAMPLE_X[k] * hstepX) + xp);
      sqy[e * 5 + k] = f32(f32(SAMPLE_Y[k] * hstepY) + yp);
    }
  }
  // blend: weights (float32) and the quadrant of every sub pixel
  const WT = new Float64Array(XY * 9);
  const quadOf = new Int8Array(XY);
  if (useBlend) {
    for (let iy = 1; iy <= Y; iy++) {
      for (let ix = 1; ix <= X; ix++) {
        const e = (iy - 1) * X + (ix - 1);
        for (let m = 0; m < 9; m++) {
          const fx = f32(f32(DX[m] + 0.5) - f32(ix / (X + 1)));
          const fy = f32(f32(DY[m] + 0.5) - f32(iy / (Y + 1)));
          const d2 = f32(f32(fy * fy) + f32(fx * fx));
          WT[e * 9 + m] = f32(1 / Math.sqrt(f32(0.01) <= d2 ? d2 : 0.01));
        }
      }
    }
    const invX = f32(1 / X);
    for (let e = 0; e < XY; e++) {
      const row = Math.trunc(f32(e * invX));
      const col = e - row * X;
      const right = (X + 0.5) * 0.5 <= col;
      const bottom = (Y + 0.5) * 0.5 <= row;
      quadOf[e] = right ? (bottom ? 2 : 1) : (bottom ? 3 : 0);
    }
  }

  // calcBlendedSampleResult for sub pixel e of cell (lx, ly) owned by lens `owner` (0..8)
  function blended(lx, ly, e, owner) {
    let ox = lx + DX[owner];
    let oy = ly + DY[owner];
    if (ox < 0) ox = 0; else if (ox >= w) ox = w - 1; // owner outside the image (undefined in the engine)
    if (oy < 0) oy = 0; else if (oy >= h) oy = h - 1;
    const own = M[oy * w + ox];
    const q = quadOf[e] * 4;
    let num = 0;
    let den = 0;
    for (let j = 0; j < 4; j++) {
      const m = QUAD[q + j];
      if (m !== owner) {
        const b = N2ON[owner * 9 + m];
        if (b < 0 || ((own >> b) & 1) === 0) continue;
      }
      const wgt = WT[e * 9 + m];
      if (wgt > 0) {
        let mx = lx + DX[m];
        let my = ly + DY[m];
        if (mx < 0) mx = 0; else if (mx >= w) mx = w - 1;
        if (my < 0) my = 0; else if (my >= h) my = h - 1;
        den = f32(den + wgt);
        num = f32(num + f32(wgt * D[my * w + mx]));
      }
    }
    if (!(den > 0)) { num = D[ly * w + lx]; den = 1; }
    let r = f32(f32(f32(num / den) * 10000) + 0.5);
    r = Math.floor(r);
    return f32(r / 10000);
  }

  // ---- boundary chains --------------------------------------------------------------------------------------
  const cIdx = new Int8Array(CAP);
  const cRx = new Int8Array(CAP);
  const cRy = new Int8Array(CAP);
  const cInter = new Uint8Array(CAP);
  let lo = 0; // first entry
  let hi = 0; // one past the last entry

  function atIntersection(x, y, p) {
    let ox;
    let oy;
    if (p === 3) { ox = 0; oy = -1; } else if (p === 8) { ox = 0; oy = 0; } else if (p === 13) { ox = -1; oy = 0; } else if (p === 18) { ox = -1; oy = -1; } else return false;
    const x0 = x + ox;
    const y0 = y + oy;
    if (x0 < 0 || x0 + 1 >= w || y0 < 0 || y0 + 1 >= h) return true;
    const a = M[y0 * w + x0];
    if (a & 0x80) return false;
    const b = M[y0 * w + x0 + 1];
    if (b & 0x20) return false;
    const c = M[(y0 + 1) * w + x0];
    let n = (((c >> 4) & 1) ^ 1) + (((b >> 6) & 1) ^ 1) + (((a >> 4) & 1) ^ 1) + (((a >> 6) & 1) ^ 1);
    if (thrPos) n += ((a & 0x50) !== 0 ? 1 : 0) + ((c & 0x50) !== 0 ? 1 : 0);
    return n > 2;
  }

  // walkBoundary: extend the chain at its end (forward) or its front (backward)
  function walk(ox, oy, fwd) {
    const pos = fwd ? hi - 1 : lo;
    let relx = cRx[pos];
    let rely = cRy[pos];
    let cx = ox + relx;
    let cy = oy + rely;
    if (cx < 0 || cx >= w || cy < 0 || cy >= h) return;
    const seed = cIdx[pos];
    let p = seed;
    let sameStart = (relx | rely) === 0;
    let close = SPLINE_DEGREE;
    let flag = 0;
    let canJump = true;
    let cont = true;
    let budget = 1;
    let maxcount = WALK_MAX;
    const d = fwd ? 1 : 0;
    const stepT = STEP[d];
    const diagT = DIAG[d];
    const sideT = SIDE[d];
    for (let guard = 0; cont && guard < 4096; guard++) {
      const ci = cy * w + cx;
      const fl = F[ci];
      if (((fl >> p) & 1) === 0) break;
      const t = stepT[p];
      const m = M[ci];
      if (t >= 0 && ((m >> t) & 1) && canJump) {
        let nb = diagT[p];
        let conn = CONN[nb * 20 + p];
        if (!(conn >= 0 && ((m >> nb) & 1))) {
          nb = sideT[p];
          conn = CONN[nb * 20 + p];
          if (!(conn >= 0 && ((m >> nb) & 1))) nb = -1;
        }
        if (nb !== -1) {
          const e = fwd ? hi++ : --lo;
          if (lo < 0 || hi >= CAP) throw new Error('dmResample: boundary chain too long');
          relx += DX[nb]; rely += DY[nb]; cx += DX[nb]; cy += DY[nb];
          cIdx[e] = conn; cRx[e] = relx; cRy[e] = rely; cInter[e] = atIntersection(cx, cy, conn) ? 1 : 0;
          p = conn;
          canJump = false;
          budget = budget > 0 ? budget - 1 : 0;
          sameStart = false;
          continue;
        }
      }
      // ring step to the next active point
      let r = p + (fwd ? 21 : 19);
      let q = r % 20;
      for (let n = 0; n < 19; n++) {
        q = r % 20;
        if ((fl >> q) & 1) break;
        r += fwd ? 1 : -1;
      }
      const e = fwd ? hi++ : --lo;
      if (lo < 0 || hi >= CAP) throw new Error('dmResample: boundary chain too long');
      cIdx[e] = q; cRx[e] = relx; cRy[e] = rely; cInter[e] = atIntersection(cx, cy, q) ? 1 : 0;
      const newFlag = q === seed ? 1 : flag;
      close -= flag & 1;
      if (budget === 0) maxcount--;
      cont = sameStart ? (close > 0 && !(newFlag & 1)) : maxcount > 0;
      flag = newFlag;
      p = q;
      canJump = true;
    }
  }

  // per cell spline sample storage and segments
  let sxArr = new Float64Array(8192);
  let syArr = new Float64Array(8192);
  let ns = 0;
  const counts = new Int32Array(4);
  const ptx = new Float64Array(2 * CAP);
  const pty = new Float64Array(2 * CAP);
  const knots = new Float64Array(2 * CAP + 4);

  // appendLineSegments: chain -> sampled clamped quadratic B-spline
  function appendLineSegments(ci, ox, oy) {
    let n = 0;
    let prx = 0;
    let pry = 0;
    for (let i = lo; i < hi; i++) {
      const rx = cRx[i];
      const ry = cRy[i];
      if (i > lo && (rx !== prx || ry !== pry)) { prx = rx; pry = ry; continue; } // jump duplicate
      prx = rx; pry = ry;
      const px = f32(f32(rx + ox) + CVX[cIdx[i]]);
      const py = f32(f32(ry + oy) + CVY[cIdx[i]]);
      ptx[n] = px; pty[n++] = py;
      if (cInter[i]) { ptx[n] = px; pty[n++] = py; }
    }
    counts[ci] = 0;
    if (n < SPLINE_DEGREE + 2) return;
    const m = n + SPLINE_DEGREE + 1;
    knots[0] = 0; knots[1] = 0; knots[2] = 0;
    for (let l = 3; l < m; l++) knots[l] = knots[l - 1] + (l <= n ? 1 : 0);
    const t0 = knots[3];
    const span = knots[n - 1] - t0;
    const cnt = Math.trunc(SPLINE_SPS * span);
    if (cnt <= 0) return;
    if (ns + cnt > sxArr.length) {
      const nx = new Float64Array((ns + cnt) * 2);
      const ny = new Float64Array((ns + cnt) * 2);
      nx.set(sxArr); ny.set(syArr); sxArr = nx; syArr = ny;
    }
    const step = span / cnt;
    for (let i = 0; i < cnt; i++) {
      const t = i * step + t0;
      // knot span search (knots[k] <= t < knots[k+1]), then de Boor with the same operation order as the reference
      let k = Math.floor(t) + 2;
      if (k > n - 1) k = n - 1;
      let d0x = ptx[k - 2], d0y = pty[k - 2];
      let d1x = ptx[k - 1], d1y = pty[k - 1];
      let d2x = ptx[k], d2y = pty[k];
      let den = knots[k + 2] - knots[k];
      let a = den !== 0 ? (t - knots[k]) / den : 0;
      d2x = (1 - a) * d1x + a * d2x; d2y = (1 - a) * d1y + a * d2y;
      den = knots[k + 1] - knots[k - 1];
      a = den !== 0 ? (t - knots[k - 1]) / den : 0;
      d1x = (1 - a) * d0x + a * d1x; d1y = (1 - a) * d0y + a * d1y;
      den = knots[k + 1] - knots[k];
      a = den !== 0 ? (t - knots[k]) / den : 0;
      d2x = (1 - a) * d1x + a * d2x; d2y = (1 - a) * d1y + a * d2y;
      sxArr[ns + i] = d2x; syArr[ns + i] = d2y;
    }
    ns += cnt;
    counts[ci] = cnt;
  }

  // ---- ownership of the sub pixels (LineIsectSubpixEvaluator::evalMembershipMask) -------------------------------
  let sgAx = new Float64Array(2048);
  let sgAy = new Float64Array(2048);
  let sgBx = new Float64Array(2048);
  let sgBy = new Float64Array(2048);
  let sgMinX = new Float64Array(2048);
  let sgMaxX = new Float64Array(2048);
  let sgMinY = new Float64Array(2048);
  let sgMaxY = new Float64Array(2048);
  let sgList = new Int32Array(2048); // segments near the sight lines of one sub pixel
  let nseg = 0;
  const member = new Int8Array(XY);

  function pushSeg(ax, ay, bx, by) {
    if (nseg === sgAx.length) {
      const g = (a) => { const n = new Float64Array(a.length * 2); n.set(a); return n; };
      sgAx = g(sgAx); sgAy = g(sgAy); sgBx = g(sgBx); sgBy = g(sgBy);
      sgMinX = g(sgMinX); sgMaxX = g(sgMaxX); sgMinY = g(sgMinY); sgMaxY = g(sgMaxY);
      sgList = new Int32Array(sgAx.length);
    }
    sgAx[nseg] = ax; sgAy[nseg] = ay; sgBx[nseg] = bx; sgBy[nseg] = by;
    if (ax <= bx) { sgMinX[nseg] = ax; sgMaxX[nseg] = bx; } else { sgMinX[nseg] = bx; sgMaxX[nseg] = ax; }
    if (ay <= by) { sgMinY[nseg] = ay; sgMaxY[nseg] = by; } else { sgMinY[nseg] = by; sgMaxY[nseg] = ay; }
    nseg++;
  }

  // any segment crossing P=(x3,y3) -> Q=(x4,y4)?
  function blocked(x3, y3, x4, y4) {
    const lx = x3 <= x4 ? x3 : x4;
    const hx = x3 <= x4 ? x4 : x3;
    const ly = y3 <= y4 ? y3 : y4;
    const hy = y3 <= y4 ? y4 : y3;
    for (let s = 0; s < nseg; s++) {
      if (sgMaxX[s] < lx || hx < sgMinX[s] || sgMaxY[s] < ly || hy < sgMinY[s]) continue;
      if (isectArith(sgAx[s], sgAy[s], sgBx[s], sgBy[s], x3, y3, x4, y4)) return true;
    }
    return false;
  }

  // blocked() restricted to the first `nl` segments of sgList, for the line (0.5,0.5) -> sample point b
  function sightBlocked(nl, b) {
    const x4 = sqx[b];
    const y4 = sqy[b];
    const lx = x4 < 0.5 ? x4 : 0.5;
    const hx = x4 < 0.5 ? 0.5 : x4;
    const ly = y4 < 0.5 ? y4 : 0.5;
    const hy = y4 < 0.5 ? 0.5 : y4;
    for (let j = 0; j < nl; j++) {
      const s = sgList[j];
      if (sgMaxX[s] < lx || hx < sgMinX[s] || sgMaxY[s] < ly || hy < sgMinY[s]) continue;
      if (isectArith(sgAx[s], sgAy[s], sgBx[s], sgBy[s], 0.5, 0.5, x4, y4)) return true;
    }
    return false;
  }

  function evalMembership(nchains, lx, ly) {
    nseg = 0;
    let idx = 0;
    for (let ci = 0; ci < nchains; ci++) {
      const c = counts[ci];
      if (idx >= ns) break;
      let px = f32(sxArr[idx] - lx);
      let py = f32(syArr[idx] - ly);
      if (c < 2) { idx += 1; continue; }
      idx += 2;
      let i = 2;
      for (;;) {
        if (idx - 1 >= ns) break;
        const cx = f32(sxArr[idx - 1] - lx);
        const cy = f32(syArr[idx - 1] - ly);
        if ((px <= cx ? px : cx) <= 1.5 && (py <= cy ? py : cy) <= 1.5 && (px >= cx ? px : cx) >= -0.5 && (py >= cy ? py : cy) >= -0.5) pushSeg(px, py, cx, cy);
        px = cx; py = cy;
        if (c <= i) break;
        i++; idx++;
      }
    }
    for (let e = 0; e < XY; e++) {
      const ix = e % X;
      const iy = (e / X) | 0;
      const xpos = xposT[ix];
      const ypos = yposT[iy];
      let m = -1;
      let first = false; // line of sight to the exact sub pixel centre blocked
      let h1 = false, h2 = false, h3 = false, h4 = false;
      if (nseg > 0) {
        const b = e * 5;
        // the five sight lines all start at the lens centre and end within a sixth of a texel of the sub pixel:
        // test only the segments overlapping their common bounding box
        let bx0 = 0.5, bx1 = 0.5, by0 = 0.5, by1 = 0.5;
        for (let k = 0; k < 5; k++) {
          const qx = sqx[b + k];
          const qy = sqy[b + k];
          if (qx < bx0) bx0 = qx; else if (qx > bx1) bx1 = qx;
          if (qy < by0) by0 = qy; else if (qy > by1) by1 = qy;
        }
        let nl = 0;
        for (let s = 0; s < nseg; s++) {
          if (sgMaxX[s] < bx0 || bx1 < sgMinX[s] || sgMaxY[s] < by0 || by1 < sgMinY[s]) continue;
          sgList[nl++] = s;
        }
        if (nl > 0) {
          first = sightBlocked(nl, b);
          if (!first) {
            h1 = sightBlocked(nl, b + 1);
            h2 = sightBlocked(nl, b + 2);
            h3 = sightBlocked(nl, b + 3);
            h4 = sightBlocked(nl, b + 4);
          }
        }
      }
      if (!first && h1 === h2 && h3 === h4) m = 8;
      else {
        const hdir = hdirT[ix];
        const vdir = vdirT[iy];
        if (!blocked(hdir + 0.5, 0.5, xpos, ypos)) m = hdir < 0 ? 3 : 4;
        else if (!blocked(0.5, vdir + 0.5, xpos, ypos)) m = vdir < 0 ? 1 : 6;
      }
      member[e] = m;
    }
  }

  // ---- main loop over the lens cells ------------------------------------------------------------------------
  const amb = []; // out pixel indices (y*OW + x) of ambiguous sub pixels, in cell raster order
  for (let ly = 0; ly < h; ly++) {
    for (let lx = 0; lx < w; lx++) {
      const ci = ly * w + lx;
      const mk = M[ci];
      const o0 = ly * Y * OW + lx * X;
      if ((mk & 0x5a) === 0x5a) {
        // populateNonBoundaryRegion
        if (useBlend && Meq[ci] !== 0xff) {
          for (let e = 0; e < XY; e++) out[o0 + ((e / X) | 0) * OW + (e % X)] = blended(lx, ly, e, 8);
        } else {
          const v = D[ci];
          for (let e = 0; e < XY; e++) out[o0 + ((e / X) | 0) * OW + (e % X)] = v;
        }
        continue;
      }
      // boundary cell: up to 4 chains, one per dissimilar side
      ns = 0;
      let nch = 0;
      for (let k = 0; k < 4; k++) {
        if ((SIDEBITS[k] & mk) !== 0) continue;
        const fl = F[ci];
        let r = 21 + 5 * k;
        let q = r % 20;
        for (let n = 0; n < 19; n++) {
          q = r % 20;
          if ((fl >> q) & 1) break;
          r++;
        }
        if (((fl >> q) & 1) === 0) throw new Error('dmResample: Non-active seed point');
        lo = CAP >> 1; hi = lo + 1;
        cIdx[lo] = q; cRx[lo] = 0; cRy[lo] = 0; cInter[lo] = atIntersection(lx, ly, q) ? 1 : 0;
        walk(lx, ly, true);
        walk(lx, ly, false);
        appendLineSegments(nch, lx, ly);
        nch++;
      }
      evalMembership(nch, lx, ly);
      for (let e = 0; e < XY; e++) {
        const m = member[e];
        const oi = o0 + ((e / X) | 0) * OW + (e % X);
        if (m < 0) {
          out[oi] = OCCLUDED;
          amb.push(oi);
        } else if (!useBlend) {
          let mx = lx + DX[m];
          let my = ly + DY[m];
          if (mx < 0) mx = 0; else if (mx >= w) mx = w - 1;
          if (my < 0) my = 0; else if (my >= h) my = h - 1;
          out[oi] = D[my * w + mx];
        } else out[oi] = blended(lx, ly, e, m);
      }
    }
  }

  // ---- populateAmbiguousPixels ------------------------------------------------------------------------------
  const OH = h * Y;
  for (let ai = 0; ai < amb.length; ai++) {
    const oi = amb[ai];
    const x = oi % OW;
    const y = (oi / OW) | 0;
    let done = false;
    for (let k = 0; k < 2; k++) {
      const ys = k === 0 ? 1 : -1;
      let a = OCCLUDED;
      let xx = x, yy = y;
      for (;;) {
        xx += 1; yy += ys;
        if (xx < 0 || xx >= OW || yy < 0) break;
        if (yy < OH) a = out[yy * OW + xx];
        if (a !== OCCLUDED || yy >= OH) break;
      }
      let b = OCCLUDED;
      xx = x; yy = y;
      for (;;) {
        xx -= 1; yy -= ys;
        if (xx < 0 || xx >= OW || yy < 0) break;
        if (yy < OH) b = out[yy * OW + xx];
        if (b !== OCCLUDED || yy >= OH) break;
      }
      if (Math.abs(f32(a - b)) < thr) {
        const mid = f32(f32(a + b) * 0.5);
        if (mid !== OCCLUDED) { out[oi] = mid; done = true; }
        break; // an averaged sentinel goes straight to the fallback
      }
    }
    if (done) continue;
    let best = 0;
    let have = false;
    for (let j = 0; j < 4; j++) {
      const xx = x + (j === 2 ? -1 : j === 3 ? 1 : 0);
      const yy = y + (j === 0 ? -1 : j === 1 ? 1 : 0);
      if (xx < 0 || xx >= OW || yy < 0 || yy >= OH) continue;
      const v = out[yy * OW + xx];
      if (v === OCCLUDED) continue;
      if (!have || v < best) best = v;
      have = true;
    }
    if (!have) throw new Error('dmResample: hadValid');
    out[oi] = best;
  }

  return { data: out, width: OW, height: OH };
}
