// The engine's demodulation bitmap (DemodulationAlgorithmBitmapDatabase::Fit and the rescale that follows it), built from the camera's white image the way the
// running engine builds it (hook dumps of the plane at every stage; see docs/lytro-re-notes.md, "Colour tilt"). The plane the engine divides each photo by is NOT the
// white image over its mean: after the per-colour mean normalisation it runs a nonlinear response correction that lifts the dim rim of every lens disk, most for blue.
//
//   P  = expand16(m) - expand16(black)           (the 10 bit value as the engine's 16 bit sample, m << 6 | m >> 4; the white image's own black, 64)
//   P  = hot pixels of the photo's list replaced by the mean of their non-listed neighbours within a radius 2 diamond, other colours scaled by the phase means
//   A  = max(0.02, max(1e-6, P) / mean of its Bayer phase)    (the two greens share one mean)
//   S1 = A / max(A)
//   S2 = S1 * curve[c][ clamp(floor(4096 * S1 / (tile(c) * q(c))), 0, 4095) ]    tile: the 100 x 100 grid of phase means divided by the centre cell; q: the 0.998 quantile
//   E  = S2 * D(A) / D(S2)       D: the mean over the central third of the lens centres of the phase value at the lens centre (colour buckets), so the disk centres keep their level
//
// Checked against the engine (batch4-2, eba001cb): S1 rms 1e-6, S2 rms 6e-5, the final rescale to 0.05 %.
import { MOD_CURVE_B64 } from './enginemod-tables.js';
import { debugFlags } from './debugflags.js';

let CURVE = null;
export function curve() {
  if (CURVE) return CURVE;
  const bin = typeof atob === 'function' ? atob(MOD_CURVE_B64) : Buffer.from(MOD_CURVE_B64, 'base64').toString('binary');
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  CURVE = new Float32Array(bytes.buffer);
  return CURVE;
}

// phase index of (x, y): (y & 1) * 2 + (x & 1); the curve channel of each phase (R 0, Gr 1, B 2, Gb 3: green is Gr on the row that holds red)
export function phaseChannels(cfa) {
  const out = [0, 0, 0, 0];
  for (let py = 0; py < 2; py++) {
    const rowHasRed = cfa[py][0] === 0 || cfa[py][1] === 0;
    for (let px = 0; px < 2; px++) {
      const c = cfa[py][px];
      out[py * 2 + px] = c === 0 ? 0 : c === 2 ? 2 : rowHasRed ? 1 : 3;
    }
  }
  return out;
}

// Value of the phase lattice (py, px) at the sensor position (x, y) by bilinear interpolation among the four nearest pixels of that phase; NaN outside.
function phaseSample(P, W, H, py, px, x, y) {
  const gx = (x - px) / 2;
  const gy = (y - py) / 2;
  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const fx = gx - x0;
  const fy = gy - y0;
  const xa = x0 * 2 + px;
  const ya = y0 * 2 + py;
  if (x0 < 0 || y0 < 0 || xa + 2 >= W || ya + 2 >= H) return NaN;
  const i = ya * W + xa;
  return P[i] * (1 - fx) * (1 - fy) + P[i + 2] * fx * (1 - fy) + P[i + 2 * W] * (1 - fx) * fy + P[i + 2 * W + 2] * fx * fy;
}

// The mean over the central third of the lens centres of the colour at the lens centre. Returns the value of each colour (R, G, B; G over both green phases).
function diskCentre(P, W, H, grid, cfa) {
  const cs = Math.cos(grid.rotation);
  const sn = Math.sin(grid.rotation);
  const rows = Math.floor((H - grid.oy) / grid.rowStep) + 1;
  const cols = W / grid.pitch;
  const r0 = Math.floor(rows / 3);
  const r1 = Math.floor((2 * rows) / 3);
  const c0 = Math.floor(cols / 3);
  const c1 = Math.floor((2 * cols) / 3);
  const sum = [0, 0, 0];
  const cnt = [0, 0, 0];
  for (let r = r0; r < r1; r++) {
    const off = (r & 1) * grid.pitch * 0.5;
    for (let c = c0; c < c1; c++) {
      const u = c * grid.pitch + off;
      const v = r * grid.rowStep;
      const x = grid.ox + cs * u - sn * v;
      const y = grid.oy + sn * u + cs * v;
      for (let py = 0; py < 2; py++) {
        for (let px = 0; px < 2; px++) {
          const s = phaseSample(P, W, H, py, px, x, y);
          if (Number.isFinite(s)) {
            const col = cfa[py][px];
            sum[col] += s;
            cnt[col]++;
          }
        }
      }
    }
  }
  return sum.map((s, k) => (cnt[k] ? s / cnt[k] : 0));
}

// mod: the white image's 10 bit values (Uint16Array, W x H), mod.black its black (default 64). hot: the photo's listed hot pixel indices (or null).
// Returns { E: Float32Array (W x H, the engine's plane), stages } and optionally the intermediate planes.
export function engineModulationPlane(mod, cam, dev, grid, hot, opts = {}) {
  const { width: W, height: H } = cam;
  const N = W * H;
  const cfa = dev.cfa;
  const black = Number.isFinite(mod.black) ? mod.black : 64;
  const black16 = ((black << 6) | (black >> 4)) >>> 0;
  const lutch = phaseChannels(cfa);
  const P = new Float32Array(N);
  const sums = [0, 0, 0, 0];
  for (let y = 0; y < H; y++) {
    const rowBase = y * W;
    const py2 = (y & 1) * 2;
    for (let x = 0; x < W; x++) {
      const m = mod[rowBase + x];
      const v = Math.fround(((m << 6) | (m >> 4)) - black16);
      P[rowBase + x] = v;
      sums[py2 + (x & 1)] += v;
    }
  }
  // the means of the four phases; the two greens are averaged (cfg 0x2408 off)
  const cntPhase = (W / 2) * (H / 2);
  const mean = sums.map((s) => s / cntPhase);
  const greens = [0, 1, 2, 3].filter((p) => cfa[p >> 1][p & 1] === 1);
  if (greens.length === 2) {
    const g = (mean[greens[0]] + mean[greens[1]]) / 2;
    mean[greens[0]] = g;
    mean[greens[1]] = g;
  }
  // hot pixels: replaced by the mean of the not listed (and not negative) neighbours within the radius 2 diamond, each scaled by mean(target phase) / mean(its phase)
  if (hot && hot.length) {
    const mask = new Uint8Array(N);
    for (let k = 0; k < hot.length; k++) mask[hot[k]] = 1;
    const offs = [];
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if ((dx || dy) && Math.abs(dx) + Math.abs(dy) <= 2) offs.push([dx, dy]);
    const rep = new Float32Array(hot.length);
    for (let k = 0; k < hot.length; k++) {
      const i = hot[k];
      const y = (i / W) | 0;
      const x = i - y * W;
      if (x < 3 || y < 3 || x >= W - 3 || y >= H - 3) {
        rep[k] = P[i];
        continue;
      }
      const pt = (y & 1) * 2 + (x & 1);
      let acc = 0;
      let n = 0;
      for (const [dx, dy] of offs) {
        const j = i + dy * W + dx;
        if (mask[j]) continue;
        const v = P[j];
        if (!(v >= 0)) continue;
        const pn = (((y + dy) & 1) << 1) | ((x + dx) & 1);
        acc += v * (mean[pt] / mean[pn]);
        n++;
      }
      rep[k] = n ? Math.fround(acc / n) : P[i];
    }
    for (let k = 0; k < hot.length; k++) P[hot[k]] = rep[k];
  }
  // A and its maximum
  let amax = 0;
  for (let y = 0; y < H; y++) {
    const rowBase = y * W;
    const py2 = (y & 1) * 2;
    for (let x = 0; x < W; x++) {
      const i = rowBase + x;
      const v = Math.fround(Math.max(1e-6, P[i]) / mean[py2 + (x & 1)]);
      const a = v < 0.02 ? 0.02 : v;
      P[i] = a;
      if (a > amax) amax = a;
    }
  }
  const inv = 1 / amax;
  for (let i = 0; i < N; i++) P[i] = Math.fround(P[i] * inv);
  // S1 statistics: tile means (100 x 100 cells per phase), quantile of every phase
  const tsum = new Float64Array(4 * 10000);
  const tcnt = new Float64Array(4 * 10000);
  const BINS = 1 << 16;
  const hist = new Uint32Array(4 * BINS);
  const cxOf = new Int32Array(W);
  for (let x = 0; x < W; x++) cxOf[x] = Math.min(99, Math.floor((x * 100) / W));
  for (let y = 0; y < H; y++) {
    const cy = Math.min(99, Math.floor((y * 100) / H));
    const rowBase = y * W;
    const py2 = (y & 1) * 2;
    for (let x = 0; x < W; x++) {
      const p = py2 + (x & 1);
      const v = P[rowBase + x];
      const cell = p * 10000 + cy * 100 + cxOf[x];
      tsum[cell] += v;
      tcnt[cell]++;
      hist[p * BINS + Math.min(BINS - 1, (v * BINS) | 0)]++;
    }
  }
  const tile = new Float64Array(4 * 10000);
  const qv = [0, 0, 0, 0];
  for (let p = 0; p < 4; p++) {
    const centre = tsum[p * 10000 + 50 * 100 + 50] / tcnt[p * 10000 + 50 * 100 + 50];
    for (let k = 0; k < 10000; k++) tile[p * 10000 + k] = tcnt[p * 10000 + k] ? tsum[p * 10000 + k] / tcnt[p * 10000 + k] / centre : 0;
    // the 0.998 quantile (linear between order statistics, as numpy does)
    const total = cntPhase;
    const target = 0.998 * (total - 1);
    let acc = 0;
    let b = 0;
    while (b < BINS - 1 && acc + hist[p * BINS + b] <= target) acc += hist[p * BINS + b++];
    qv[p] = (b + 0.5) / BINS;
  }
  // the lens centre level of S1 before the response curve
  const dBefore = diskCentre(P, W, H, grid, cfa);
  const LUT = curve();
  for (let y = 0; y < H; y++) {
    const cy = Math.min(99, Math.floor((y * 100) / H));
    const rowBase = y * W;
    const py2 = (y & 1) * 2;
    for (let x = 0; x < W; x++) {
      const p = py2 + (x & 1);
      const i = rowBase + x;
      const v = P[i];
      let idx = Math.floor((4096 * v) / (tile[p * 10000 + cy * 100 + cxOf[x]] * qv[p]));
      if (!(idx >= 0)) idx = 0;
      else if (idx > 4095) idx = 4095;
      P[i] = Math.fround(v * LUT[idx * 4 + lutch[p]]);
    }
  }
  const dAfter = diskCentre(P, W, H, grid, cfa);
  // E = S2 * D(A) / D(S2), A = S1 * max(A)
  const ratio = [0, 1, 2].map((c) => (dAfter[c] ? (dBefore[c] * amax) / dAfter[c] : 1));
  if (debugFlags().printColor) console.error('DISKC', JSON.stringify({ dA: dBefore.map((d) => d * amax), inv: dBefore.map((d) => 1 / (d * amax)), dAfter }));
  for (let y = 0; y < H; y++) {
    const rowBase = y * W;
    const crow = cfa[y & 1];
    for (let x = 0; x < W; x++) P[rowBase + x] = Math.fround(P[rowBase + x] * ratio[crow[x & 1]]);
  }
  return { E: P, max: amax, ratio, quantiles: qv };
}

// The plane in the form the rest of the code reads (a Uint16 modulation image, black subtracted per colour by the caller, one unit = 1 / UNIT of the engine's plane):
// value = round(E * UNIT) + the photo's black of that colour. `.eUnit` tells engineColorScale that its "whole sensor mean" is the unit itself.
export const MOD_UNIT = 30000;
export function engineModulation(mod, cam, dev, grid, hot) {
  const { E } = engineModulationPlane(mod, cam, dev, grid, hot);
  const { width: W, height: H } = cam;
  const out = new Uint16Array(W * H);
  for (let y = 0; y < H; y++) {
    const crow = dev.cfa[y & 1];
    for (let x = 0; x < W; x++) {
      const b = dev.black[crow[x & 1]];
      const v = Math.round(E[y * W + x] * MOD_UNIT + b);
      out[y * W + x] = v > 65535 ? 65535 : v;
    }
  }
  out.eUnit = MOD_UNIT;
  return out;
}
