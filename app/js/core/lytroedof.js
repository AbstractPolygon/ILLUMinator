// Lytro Desktop's all in focus reconstruction (see docs/lytro-re-notes.md,
// "ILLUM all-in-focus (EDOF) image"): the rays are splatted with a per-ray
// depth, holes are filled, and a depth aware filter bank (the photo's
// reconstructionFilterRef) reconstructs the picture from the splat.

import { lensWarp } from './lens.js';
import { FILTER_DESCRIPTORS } from './lytrofilters.js';

// ---- the photo's reconstruction filter bank --------------------------------

async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// A non interlaced 8 bit RGB PNG as { width, height, data } (RGB bytes).
export async function decodePngRgb(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let p = 8;
  let width = 0;
  let height = 0;
  const idat = [];
  while (p < bytes.length) {
    const n = dv.getUint32(p);
    const type = String.fromCharCode(bytes[p + 4], bytes[p + 5], bytes[p + 6], bytes[p + 7]);
    if (type === 'IHDR') {
      width = dv.getUint32(p + 8);
      height = dv.getUint32(p + 12);
      if (bytes[p + 16] !== 8 || bytes[p + 17] !== 2 || bytes[p + 20] !== 0) throw new Error('unsupported PNG');
    } else if (type === 'IDAT') idat.push(bytes.subarray(p + 8, p + 8 + n));
    else if (type === 'IEND') break;
    p += 12 + n;
  }
  const total = idat.reduce((a, b) => a + b.length, 0);
  const joined = new Uint8Array(total);
  let o = 0;
  for (const c of idat) {
    joined.set(c, o);
    o += c.length;
  }
  const raw = await inflate(joined);
  const stride = width * 3;
  const out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    for (let i = 0; i < stride; i++) {
      const a = i >= 3 ? out[y * stride + i - 3] : 0;
      const up = y > 0 ? out[(y - 1) * stride + i] : 0;
      const c = y > 0 && i >= 3 ? out[(y - 1) * stride + i - 3] : 0;
      let v = raw[src + i];
      if (f === 1) v += a;
      else if (f === 2) v += up;
      else if (f === 3) v += (a + up) >> 1;
      else if (f === 4) {
        const pa = Math.abs(up - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + up - 2 * c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? up : c;
      }
      out[y * stride + i] = v & 255;
    }
  }
  return { width, height, data: out };
}

// Kernel scale as a function of lambda (preset 0x4400, ILLUM): linear
// between these points, 1 outside.
const SCALE_POINTS = [[-100, 1], [-6, 1], [-5, 0.75], [-4, 0.5], [-3, 0.75], [-2, 1], [2, 1], [3, 0.75], [4, 0.5], [5, 0.75], [6, 1], [100, 1]];
export function kernelScale(lambda) {
  const P = SCALE_POINTS;
  if (lambda <= P[0][0]) return P[0][1];
  for (let i = 1; i < P.length; i++) {
    if (lambda <= P[i][0]) {
      const t = (lambda - P[i - 1][0]) / (P[i][0] - P[i - 1][0]);
      return P[i - 1][1] * (1 - t) + P[i][1] * t;
    }
  }
  return P[P.length - 1][1];
}

export const BANK = { sparsify: 0.01, rank: 1, mono: true, overlap: 0.1 };

// The green plane of every 65 x 65 kernel of the PNG, as signed floats
// summing to 1: entries[lambdaIndex * tiles + tile].
export function bankKernels(png, meta) {
  const tiles = meta.numKernelsX * meta.numKernelsY;
  const size = png.width;
  const n = meta.lambdas.length * tiles;
  const entries = [];
  for (let e = 0; e < n; e++) {
    const k = new Float64Array(size * size);
    let sum = 0;
    for (let i = 0; i < size * size; i++) {
      k[i] = png.data[(e * size * size + i) * 3 + 1] / 255 - 0.5;
      sum += k[i];
    }
    for (let i = 0; i < k.length; i++) k[i] /= sum;
    entries.push(k);
  }
  return { entries, size, tiles, meta };
}

// The kernel resampled by (sx, sy): its new size is rounded up to an odd
// number; larger kernels are sampled bilinearly, smaller ones are splatted
// and divided by their coverage (FUN_180bf4500).
function resampleKernel(k, size, sx, sy) {
  let w = Math.ceil(size * sx);
  let h = Math.ceil(size * sy);
  if (w % 2 === 0) w++;
  if (h % 2 === 0) h++;
  const out = new Float64Array(w * h);
  if (size < w || size < h ? size < w : false) {
    // upscaling
  }
  if (w > size) {
    const ix = 1 / sx;
    const iy = 1 / sy;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const px = (x - (w >> 1)) * ix + (size >> 1) + 0.5 - 0.5;
        const py = (y - (h >> 1)) * iy + (size >> 1) + 0.5 - 0.5;
        const x0 = Math.floor(px);
        const y0 = Math.floor(py);
        const ax = px - x0;
        const ay = py - y0;
        const at = (xx, yy) => (xx < 0 || yy < 0 || xx >= size || yy >= size ? 0 : k[yy * size + xx]);
        out[y * w + x] = (at(x0, y0) * (1 - ax) + at(x0 + 1, y0) * ax) * (1 - ay) + (at(x0, y0 + 1) * (1 - ax) + at(x0 + 1, y0 + 1) * ax) * ay;
      }
    }
    return { k: out, w, h };
  }
  // splat: every source tap spreads over the new grid with bilinear weights
  const cov = new Float64Array(w * h);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = (x - (size >> 1)) * sx + (w >> 1);
      const py = (y - (size >> 1)) * sy + (h >> 1);
      const x0 = Math.floor(px);
      const y0 = Math.floor(py);
      const ax = px - x0;
      const ay = py - y0;
      const v = k[y * size + x];
      for (let j = 0; j < 2; j++) {
        for (let i = 0; i < 2; i++) {
          const xx = x0 + i;
          const yy = y0 + j;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const wt = (i ? ax : 1 - ax) * (j ? ay : 1 - ay);
          out[yy * w + xx] += v * wt;
          cov[yy * w + xx] += wt;
        }
      }
    }
  }
  for (let i = 0; i < out.length; i++) out[i] = cov[i] > 0 ? out[i] / cov[i] : 0;
  return { k: out, w, h };
}

// Dominant separable term of a w x h matrix (power iteration): the column and
// row vectors (each summing to 1) and the gain that restores the kernel's sum.
function rank1(k, w, h) {
  let v = new Float64Array(w).fill(1);
  let u = new Float64Array(h);
  let s = 0;
  for (let it = 0; it < 60; it++) {
    for (let y = 0; y < h; y++) {
      let a = 0;
      for (let x = 0; x < w; x++) a += k[y * w + x] * v[x];
      u[y] = a;
    }
    let nu = 0;
    for (let y = 0; y < h; y++) nu += u[y] * u[y];
    nu = Math.sqrt(nu) || 1;
    for (let y = 0; y < h; y++) u[y] /= nu;
    for (let x = 0; x < w; x++) {
      let a = 0;
      for (let y = 0; y < h; y++) a += k[y * w + x] * u[y];
      v[x] = a;
    }
    let nv = 0;
    for (let x = 0; x < w; x++) nv += v[x] * v[x];
    s = Math.sqrt(nv) || 1;
    for (let x = 0; x < w; x++) v[x] /= s;
  }
  let su = 0;
  let sv = 0;
  for (let y = 0; y < h; y++) su += u[y];
  for (let x = 0; x < w; x++) sv += v[x];
  const col = Float32Array.from(u, (a) => a / su);
  const row = Float32Array.from(v, (a) => a / sv);
  return { col, row, gain: su * s * sv };
}

// The bank for pictures of W x H: per entry a rank 1 filter.
export function buildBank(src, W, H, opts = BANK) {
  const { entries, size, tiles, meta } = src;
  const out = [];
  for (let e = 0; e < entries.length; e++) {
    const lam = meta.lambdas[Math.floor(e / tiles)];
    const s = kernelScale(lam);
    const sx = (s * W) / meta.targetWidth;
    const sy = (s * H) / meta.targetHeight;
    let { k, w, h } = sx === 1 && sy === 1 ? { k: entries[e], w: size, h: size } : resampleKernel(entries[e], size, sx, sy);
    if (opts.sparsify > 0) {
      let max = -Infinity;
      for (let i = 0; i < k.length; i++) if (k[i] > max) max = k[i];
      const t = opts.sparsify * max;
      k = Float64Array.from(k, (a) => (Math.abs(a) <= t ? 0 : a));
    }
    // the smallest centred window holding every non zero tap
    let rx = 0;
    let ry = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (k[y * w + x] !== 0) {
          rx = Math.max(rx, Math.abs(x - (w >> 1)));
          ry = Math.max(ry, Math.abs(y - (h >> 1)));
        }
      }
    }
    const nw = 2 * rx + 1;
    const nh = 2 * ry + 1;
    const c = new Float64Array(nw * nh);
    for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) c[y * nw + x] = k[(y + (h >> 1) - ry) * w + x + (w >> 1) - rx];
    out.push(rank1(c, nw, nh));
  }
  return { filters: out, tiles, tilesX: meta.numKernelsX, tilesY: meta.numKernelsY, lambdas: meta.lambdas };
}


// ---- the engine's own reconstruction filters (RefocusEdof::computeReconstructionFilterBank) ----
//
// For every lambda step (0.25) and axis the engine builds a 1D filter: the two descriptors around lambda (InitializeFilterDescriptorsBlitzenVersion1_1)
// each give a magnitude response sampled at frequencies hf / size (cycles per pixel, up to Nyquist), designed by SpecifiedBandsFilter::DesignFilter
// (linear phase, the inverse DFT of the sampled response, N = 2^ceil(log2(cell)) + 1 taps with cell = (|lambda| + disk pitch) / (image size / output
// size)) and blended linearly by the distance of lambda to their thresholds.

const PI32 = 3.1415927410125732;

function designTaps(freqs, mags, size, taps) {
  const N = Math.max(3, taps);
  const M = 2 ** Math.ceil(Math.log2(N)) + 1;
  // the sparse response: points (f / size, mag) while f <= size / 2, linear between them, 0 outside
  const px = [];
  const py = [];
  for (let i = 0; i < freqs.length; i++) {
    const fs = globalThis.__bankFS || 1;
    if (size * 0.5 < freqs[i] * fs) break;
    px.push(Math.fround((freqs[i] * fs) / size));
    py.push(mags[i]);
  }
  const resp = (f) => {
    if (!px.length || f < px[0] || f > px[px.length - 1]) return 0;
    let j = 0;
    while (j + 1 < px.length - 1 && px[j + 1] <= f) j++;
    if (px.length === 1) return py[0];
    const t = (f - px[j]) / (px[j + 1] - px[j]);
    return py[j] * (1 - t) + py[j + 1] * t;
  };
  const n = 2 * M - 2;
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const phase = Math.trunc((1 - N) / 2) * PI32;
  for (let i = 0; i < M; i++) {
    const f = (i / (M - 1)) * 0.5;
    const mag = resp(f);
    const th = 2 * f * phase;
    re[i] = Math.cos(th) * mag;
    im[i] = Math.sin(th) * mag;
    if (i > 0 && i < M - 1) {
      re[n - i] = re[i];
      im[n - i] = -im[i];
    }
  }
  // inverse DFT (angle +2 pi j k / n, scaled by 1 / n), the real part of the first N samples
  const out = new Float64Array(N);
  for (let k = 0; k < N; k++) {
    let sum = 0;
    for (let j = 0; j < n; j++) {
      const a = (2 * PI32 * j * k) / n;
      sum += Math.cos(a) * re[j] - Math.sin(a) * im[j];
    }
    out[k] = sum / n;
  }
  return out;
}

// the descriptors around lambda: [lower, upper, weight of lower]
function bracket(lam) {
  const D = FILTER_DESCRIPTORS;
  let up = 0;
  while (up < D.length - 1 && !(lam <= D[up].lambda)) up++;
  let lo = D.length - 1;
  while (lo > 0 && !(D[lo].lambda <= lam)) lo--;
  if (up === lo) return [D[lo], D[up], 1];
  const du = Math.abs(lam - D[up].lambda);
  const dl = Math.abs(lam - D[lo].lambda);
  return [D[lo], D[up], du / (dl + du)];
}

// Filter taps along one axis: size is the output picture size on that axis, cell the projected disk pitch in output pixels.
function engineAxisFilter(lam, axis, size, cell) {
  const taps = 2 ** Math.ceil(Math.log2(cell)) + 1;
  const [lo, up, w] = bracket(lam);
  const f = axis === 0 ? ['hf', 'hm'] : ['vf', 'vm'];
  const a = designTaps(lo[f[0]], lo[f[1]], size, taps);
  if (lo === up) return a;
  const b = designTaps(up[f[0]], up[f[1]], size, taps);
  return Float64Array.from(a, (v, i) => v * w + b[i] * (1 - w));
}

// A bank for applyBank: one filter per lambda step, no tiles. imgW, imgH: size of the standardized lightfield, diskPitch its disk pitch (14).
export function buildEngineBank(W, H, imgW, imgH, lamMin, lamMax, { diskPitch = 14, step = 0.25 } = {}) {
  const lo = Math.floor(lamMin / step) * step;
  const hi = Math.ceil(lamMax / step) * step;
  const lambdas = [];
  const filters = [];
  for (let l = lo; l <= hi + 1e-9; l += step) {
    lambdas.push(l);
    const cell = Math.max(((Math.abs(l) + diskPitch) * W) / imgW, ((Math.abs(l) + diskPitch) * H) / imgH);
    filters.push({ row: engineAxisFilter(l, 0, W, cell), col: engineAxisFilter(l, 1, H, cell) });
  }
  return { filters, tiles: 1, tilesX: 1, tilesY: 1, lambdas };
}


// ---- the engine's lens lattice (HexMicrolensArrayModel::DiskPitch / DiskCenter) ----------------------------
//
// The disks are not the lenses: the engine scales the lens pitch by (exit pupil + sensor offset z / 1000) / exit pupil (all in millimetres / micrometres as
// the metadata reader converts them), anchors the lattice so that disk (0, 0) is the one containing the sensor centre plus the mla's sensor offset, rotates it
// by the mla rotation and applies the mla's x and y scale factors. Returns a grid object like the app's own (pitch, rowStep, rotation, ox, oy).
export function engineGrid(metadata, width, height, near = null) {
  const f = Math.fround;
  const dev = metadata.devices;
  const mla = dev.mla;
  const lens = dev.lens;
  const pp = f(dev.sensor.pixelPitch * 1e6);
  const E = f(lens.exitPupilOffset.z * 1000);
  const P = f(mla.lensPitch * 1e6);
  const ox = f(mla.sensorOffset.x * 1e6);
  const oy = f(mla.sensorOffset.y * 1e6);
  const oz = f(mla.sensorOffset.z * 1e6);
  const sx = f(mla.scaleFactor.x);
  const sy = f(mla.scaleFactor.y);
  const th = f(mla.rotation);
  const S3 = 0.8660254;
  const dp = f(f(f(f(oz / 1000) + E) * P) / E);
  const cx0 = f(f(f(width * pp) * 0.5) + ox);
  const cy0 = f(f(f(height * pp) * 0.5) + oy);
  const c = f(Math.cos(-th));
  const s = f(Math.sin(-th));
  const rowUm = f(f(dp * S3) * sy);
  const rowIdx = Math.floor(cy0 / rowUm);
  const off = rowIdx & 1 ? f(0.5 * dp * sx) : 0;
  const x9 = f(f(cx0 * c - s * cy0) + off);
  const dpx = f(sx * dp);
  const col = Math.floor(x9 / dpx);
  const x = f(f(x9 - f(col * dpx)) / pp);
  const y = f(f(f(c * cy0 + cx0 * s) - f(f(f(rowIdx * S3) * dp) * sy)) / pp);
  const ct = Math.cos(th);
  const st = Math.sin(th);
  const grid = {
    pitch: f(dpx / pp),
    rowStep: f(f(dp / pp) * S3 * sy),
    rotation: th,
    ox: ct * x - st * y,
    oy: ct * y + st * x,
  };
  // the same lattice, anchored at the disk nearest `near` (the app's lens rows and columns count from its own origin)
  if (near) {
    const dx = near.ox - grid.ox;
    const dy = near.oy - grid.oy;
    const lx = ct * dx + st * dy;
    const ly = -st * dx + ct * dy;
    const r = Math.round(ly / grid.rowStep);
    const c = Math.round((lx - (r & 1) * grid.pitch * 0.5) / grid.pitch);
    const px = c * grid.pitch + (r & 1) * grid.pitch * 0.5;
    const py = r * grid.rowStep;
    grid.ox += ct * px - st * py;
    grid.oy += st * px + ct * py;
  }
  return grid;
}

// ---- the splat ---------------------------------------------------------------

import { geometryAt } from './geometrytable.js';
import { forEachLensPixel, tileWeights, isDefect, sampleDepth, depthFilter } from './superres.js';
import { LAMBDA_TO_ALPHA } from './recipe.js';
import { createLfDemosaic } from './lfdemosaic.js';

// aperture: the engine's HexAperture value, LightfieldLogic::NominalApertureFraction = min(micro f-number / main f-number, 2 - that - 2 / pitch)
// clamped to 0..1, which is 1 - 2/14 on the 14 px standardized lightfield; 'hex' is HexAperture's shape (apothem 0.5 * value lens pitches),
// 'circle' the earlier disc of radius 0.5 * value.
// LightfieldLogic::NominalApertureFraction on the 14 px standardized lightfield (K: 2 for the ILLUM, 4 for the first generation).
export function nominalAperture(cam) {
  const fm = cam.mla && cam.mla.fNumberMicrolens;
  const fn = cam.capture && cam.capture.fNumber;
  if (!(fm > 0) && !(fn > 0)) return SPLAT.aperture;
  const ratio = fm / fn;
  const k = cam.bits === 12 ? 4 : 2;
  const clamp01 = (v) => Math.min(1, Math.max(0, v));
  return Math.min(clamp01(ratio), clamp01(2 - ratio - k / 14));
}

// aperture: the hexagon the engine's pictures match best (swept against tnt on b4-1 with the engine's depth: 0.3..0.5 -> 3.92, 0.6 -> 4.09, 0.857 -> 4.74). The engine's
// aperture table is sampled over -1..1 (index = 127.5 * coordinate + 128, ProjectEdof::robustProjection), so HexAperture's flat sides at 0.5 * value are in units
// of the lens disk's radius: the value 0.9025 the metadata gives is 0.451 in this parameter (apothem = aperture * pitch / 2), in the middle of that optimum.
export function engineAperture(cam) {
  const nominal = nominalAperture(cam);
  return nominal === SPLAT.aperture ? nominal : nominal / 2;
}

export const SPLAT = { aperture: 0.4, modPow: 2, shape: 'hex', tolerance: 2, tolA: 1, tolB: 2, reach: 'engine', step: 1, demosaic: 'engine', nearest: true, sharpen: { amount: 0.25, c: 0.7, clampPre: 1 } };

// The raw picture corrected for the lens (black level, white balance,
// vignetting) at every pixel under a lens: NaN where it cannot be used.
export function correctedPlane(raw, cam, dev, g, vg, radius, modulation = null) {
  const { width, height } = cam;
  const plane = new Float32Array(width * height).fill(NaN);
  plane.mod = new Float32Array(width * height);
  // The camera's white image, as the engine uses it: every pixel is divided by its modulation relative to the same colour at the lens centre.
  let centres = null;
  if (modulation) {
    centres = new Map();
    forEachLensPixel(g, cam, 2.3, (i, x, y, u, v, lensX, lensY) => {
      if (u * u + v * v > 5.3) return;
      const ch = dev.cfa[y & 1][x & 1];
      const key = lensX + lensY * 1e6;
      let c = centres.get(key);
      if (!c) centres.set(key, (c = new Float64Array(6)));
      c[ch] += Math.max(0, modulation[i] - dev.black[ch]);
      c[3 + ch]++;
    });
  }
  const binScale = vg.bins / (2 * vg.rMax);
  const binsSq = vg.bins * vg.bins;
  let lastLens = NaN;
  let tw = null;
  forEachLensPixel(g, cam, radius, (i, x, y, u, v, lensX, lensY) => {
    if (lensX + lensY * 1e6 !== lastLens) {
      lastLens = lensX + lensY * 1e6;
      tw = tileWeights(vg, x, y);
    }
    const ch = dev.cfa[y & 1][x & 1];
    const bin = Math.floor((v + vg.rMax) * binScale) * vg.bins + Math.floor((u + vg.rMax) * binScale);
    let gain = 0;
    if (centres) {
      const c = centres.get(lastLens);
      const m = Math.max(0, modulation[i] - dev.black[ch]);
      const ref = c && c[3 + ch] ? c[ch] / c[3 + ch] : 0;
      gain = m > ref * 0.15 ? ref / m : 0;
    } else {
      for (const [t, w] of tw) gain += vg.gain[(t * binsSq + bin) * 3 + ch] * w;
    }
    if (!(gain > 0)) return;
    let value = raw[i];
    if (isDefect(raw, width, i)) {
      // HotPixelCorrectionImage::SimpleCorrection: the mean of the two same-colour neighbours along the smoother axis, if the pixel is
      // 1.2 times brighter than it (cfg 0xa30) or above 0.99 of the white level.
      const b = dev.black[ch];
      const vert = Math.abs(raw[i - 2 * width] - raw[i + 2 * width]) + Math.abs(raw[i - width] - raw[i + width]);
      const horiz = Math.abs(raw[i - 2] - raw[i + 2]) + Math.abs(raw[i - 1] - raw[i + 1]);
      const est = (vert <= horiz ? raw[i - 2 * width] + raw[i + 2 * width] : raw[i - 2] + raw[i + 2]) * 0.5 - b;
      if (value - b > 1.2 * est || value > 0.99 * dev.saturated[ch]) value = est + b;
      else return;
    }
    if (globalThis.__radialFix) gain *= globalThis.__radialFix(Math.hypot(u, v) / g.pitch);
    plane.mod[i] = 1 / gain;
    plane[i] = Math.max(0, value - dev.black[ch]) * dev.scale[ch] * gain;
  });
  return plane;
}

// Bilinear demosaic of one pixel of the corrected plane: the pixel's own
// channel plus the mean of the nearest pixels of the other two.
function rgbAt(plane, width, cfa, x, y, out) {
  const ch = cfa[y & 1][x & 1];
  const at = (xx, yy) => plane[yy * width + xx];
  const mean = (list) => {
    let s = 0;
    let n = 0;
    for (const v of list) {
      if (v === v) {
        s += v;
        n++;
      }
    }
    return n ? s / n : NaN;
  };
  const own = at(x, y);
  const horiz = [at(x - 1, y), at(x + 1, y)];
  const vert = [at(x, y - 1), at(x, y + 1)];
  const diag = [at(x - 1, y - 1), at(x + 1, y - 1), at(x - 1, y + 1), at(x + 1, y + 1)];
  if (ch === 1) {
    // green: red and blue are the horizontal and vertical neighbours
    const hch = cfa[y & 1][(x + 1) & 1];
    out[1] = own;
    out[hch] = mean(horiz);
    out[hch === 0 ? 2 : 0] = mean(vert);
  } else {
    out[ch] = own;
    out[1] = mean(horiz.concat(vert));
    out[ch === 0 ? 2 : 0] = mean(diag);
  }
  return out[0] === out[0] && out[1] === out[1] && out[2] === out[2];
}

function nearestDepth(D, w, h, x, y) {
  const xi = Math.min(w - 1, Math.max(0, Math.round(x)));
  const yi = Math.min(h - 1, Math.max(0, Math.round(y)));
  return D[yi * w + xi];
}

// Lytro's per ray depth (FUN_1809b8280): walk the ray's depth from the
// lowest to the highest depth near its lens and stop where the depth map at
// the ray's landing place agrees. Returns lambda, or NaN for none.
// BackProjectDepthMap::ComputeMinMaxDepthMap: the range of depths a ray is traced through comes from the minimum and maximum of the depth map in a
// window as wide as the largest ray displacement can be: ceil(L * 0.5 + 0.5) lenses across and ceil(L / sqrt(3) + 0.5) rows down, L the largest
// |lambda| (the depth map's pixel is one lens in the engine, here one row step). The engine builds the window by passes of 3 with strides 1, 2, 4, ...,
// so its radius is the first of 1, 3, 7, 15, ... that reaches that.
function minMaxRadius(depth, w, h, g, unit) {
  let big = 0;
  for (let i = 0; i < depth.length; i++) big = Math.max(big, Math.abs(depth[i]));
  const L = big / LAMBDA_TO_ALPHA;
  const target = Math.max(Math.ceil(L * 0.5 + 0.5) * g.pitch / unit, Math.ceil(L / Math.sqrt(3) + 0.5));
  let r = 1;
  while (r < target && r < Math.max(w, h)) r = r * 2 + 1;
  return r;
}

function marchRay(lx, ly, rdu, rdv, lam0, lam1, D, lw, lh, opts, up = null) {
  let far = Infinity;
  const near = opts.nearest;
  for (let lam = lam0; lam <= lam1; lam += opts.step) {
    const a = lam * LAMBDA_TO_ALPHA;
    // RayTraceRegion reads the depth map at the texel the ray falls in (no interpolation)
    // with the upscaled map (DmResampler) the ray reads the finer texel it falls in: centre of texel i is at (i + 0.5) / factor - 0.5 lens map pixels
    const d = (up ? nearestDepth(up.data, up.width, up.height, (lx - a * rdu) * up.factor + (up.factor - 1) / 2, (ly - a * rdv) * up.factor + (up.factor - 1) / 2) : near ? nearestDepth(D, lw, lh, lx - a * rdu, ly - a * rdv) : sampleDepth(D, lw, lh, lx - a * rdu, ly - a * rdv)) / LAMBDA_TO_ALPHA;
    if (Math.abs(d - lam) < opts.tolA) return d;
    if (d < lam && far !== Infinity && far > lam && far - d < opts.tolB) {
      const t = far - (lam - opts.step);
      return ((d - far) * t) / ((lam - d) + t) + far;
    }
    if (lam < d) far = d;
  }
  return far !== Infinity && !opts.noFar ? far : NaN;
}


// The engine demosaics the whole sensor, so every pixel needs a value: those
// not under a usable lens get the plain black level and white balance, and
// unusable ones (saturated, defect) the mean of their valid same colour
// neighbours. (The engine's SaturationRecoveryType defaults to 2, which does not
// diffuse; its highlight recovery is the clip rule of sharpenHighlights.)
function completePlane(plane, raw, cam, dev) {
  const { width, height } = cam;
  const out = Float32Array.from(plane);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (plane[i] === plane[i]) continue;
      const ch = dev.cfa[y & 1][x & 1];
      let s = 0;
      let n = 0;
      for (const [dx, dy] of [[-2, 0], [2, 0], [0, -2], [0, 2]]) {
        const xx = x + dx;
        const yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue;
        const v = plane[yy * width + xx];
        if (v === v) {
          s += v;
          n++;
        }
      }
      out[i] = n ? s / n : Math.max(0, raw[i] - dev.black[ch]) * dev.scale[ch];
    }
  }
  return out;
}

// SharpenRecoverHighlightsYCbCr as read from the engine: the luma is smoothed
// by a first order IIR filter (coefficient c, forward and backward, along rows
// and then columns) and becomes low + (Y - low) * (1 + amount) with a weight
// that fades out the boost in highlights, B3(2Y) (the cubic B spline scaled to
// 1 at 0, so 0 from Y = 1); where the weight is gone only positive differences
// (the clip level is 0) pass. Chroma is untouched, so the change of Y is added
// to all three channels.
function sharpenHighlights(dm, W, H, { amount = 0.25, c = 0.7, clampPre = 0, clampPost = 0 } = {}) {
  const a = 1 - c;
  const low = new Float32Array(W * H);
  const rgb = [0, 0, 0];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!dm.at(x, y, rgb)) { low[y * W + x] = 0; continue; }
      if (clampPre) for (let k = 0; k < 3; k++) rgb[k] = Math.min(rgb[k], clampPre);
      low[y * W + x] = 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2];
    }
  }
  for (let y = 0; y < H; y++) {
    const o = y * W;
    for (let x = 1; x < W; x++) low[o + x] = a * low[o + x] + c * low[o + x - 1];
    for (let x = W - 2; x >= 0; x--) low[o + x] = a * low[o + x] + c * low[o + x + 1];
  }
  for (let y = 1; y < H; y++) for (let x = 0; x < W; x++) low[y * W + x] = a * low[y * W + x] + c * low[(y - 1) * W + x];
  for (let y = H - 2; y >= 0; y--) for (let x = 0; x < W; x++) low[y * W + x] = a * low[y * W + x] + c * low[(y + 1) * W + x];
  const b3 = (t) => {
    t = Math.abs(t);
    if (t <= 1) return 1 - 1.5 * t * t + 0.75 * t * t * t;
    if (t <= 2) return 0.25 * (2 - t) ** 3;
    return 0;
  };
  return {
    at(x, y, out) {
      if (!dm.at(x, y, out)) return false;
      if (clampPre) for (let k = 0; k < 3; k++) out[k] = Math.min(out[k], clampPre);
      const Y = 0.299 * out[0] + 0.587 * out[1] + 0.114 * out[2];
      const l = low[y * W + x];
      const d = (Y - l) * (1 + amount);
      const w = b3(2 * Y);
      const nY = w * (l + d) + (1 - w) * (l + (d > 0 ? d : 0));
      const k = nY - Y;
      out[0] += k;
      out[1] += k;
      out[2] += k;
      if (clampPost) for (let q = 0; q < 3; q++) out[q] = Math.min(out[q], clampPost);
      return true;
    },
  };
}

// Splats the rays: premultiplied RGBA of W x H (alpha = summed weight).
export function lytroSplat({ raw, cam, dev, grid: g, sampler, vignetting: vg, depth, scale, lens, W, H, onProgress, rayWarp = null, modulation = null, geoTable = null, depth5 = null }, opts = SPLAT) {
  const { width } = cam;
  const unit = g.rowStep;
  const { xMin, yMin, outW: lw, outH: lh } = sampler;
  const hex = opts.shape !== 'circle';
  const apothem = g.pitch * opts.aperture * 0.5;
  // the pixels to read reach the hexagon's corners
  const radius = hex ? (apothem * 2) / Math.sqrt(3) : apothem;
  const hexRise = apothem / Math.sqrt(3);
  // With the camera's ray table every ray carries the distortion correction itself (as in the engine), so there is no picture warp afterwards.
  const warp = rayWarp ? null : lensWarp(lens, W, H);
  const cosR = Math.cos(g.rotation);
  const sinR = Math.sin(g.rotation);
  const warpOut = [0, 0, 0, 0];
  const geoOut = [0, 0];
  let cell = null;
  let lastCell = NaN;
  // z of every output pixel, in lambda
  const zMap = new Float32Array(W * H);
  for (let j = 0; j < H; j++) {
    for (let k = 0; k < W; k++) {
      const [sx, sy] = warp ? warp.source(k + 0.5, j + 0.5) : [k + 0.5, j + 0.5];
      // opts.zFrom5: the output depth from the upscaled map as well (tried: halo 16.4 -> 19.6, so off)
      zMap[j * W + k] = (depth5 && opts.zFrom5 ? nearestDepth(depth5.data, depth5.width, depth5.height, (sx / scale - 0.5) * depth5.factor + (depth5.factor - 1) / 2, (sy / scale - 0.5) * depth5.factor + (depth5.factor - 1) / 2) : sampleDepth(depth, lw, lh, sx / scale - 0.5, sy / scale - 0.5)) / LAMBDA_TO_ALPHA;
    }
  }
  const reach = opts.reach === 'engine' ? minMaxRadius(depth, lw, lh, g, unit) : opts.reach;
  const lo = depthFilter(depth, lw, lh, reach, Math.min);
  const hi = depthFilter(depth, lw, lh, reach, Math.max);
  // The sensor side on the GPU (gpu/lytroengine.js), when the caller gives it and the picture is one it handles.
  const gpuInput = { depth5, raw, modulation, cam, dev, grid: g, sampler, unit, rayWarp, depth, lw, lh, lo, hi, zMap, scale, W, H, apothem, rise: hexRise, planeRadius: radius + 2, opts };
  if (globalThis.__dumpSplat) globalThis.__dumpSplat(gpuInput);
  if (opts.gpu && rayWarp && modulation && !warp && opts.demosaic === 'engine' && opts.shape === 'hex' && !opts.inner && !opts.geoSign && !opts.vScale && opts.nearest && !opts.alphaPow && !opts.noFar && (opts.duScale ?? 1) === 1) {
    const gpuAcc = opts.gpu(gpuInput);
    if (gpuAcc) return { acc: gpuAcc, W, H, zMap, stats: { rays: 0, accepted: 0 } };
  }
  const plane = correctedPlane(raw, cam, dev, g, vg, radius + 2, modulation);
  let dm = opts.demosaic === 'engine' ? createLfDemosaic(completePlane(plane, raw, cam, dev), width, cam.height, dev.cfa) : null;
  if (dm && opts.sharpen) dm = sharpenHighlights(dm, width, cam.height, opts.sharpen);
  const acc = new Float32Array(W * H * 4);
  const rgb = [0, 0, 0];
  const r2 = radius * radius;
  let count = 0;
  let accepted = 0;
  forEachLensPixel(g, cam, radius, (i, x, y, u, v, lensX, lensY) => {
    if (hex) {
      // HexAperture::operator()(u, v): flat sides at |u| = apothem, corners on the v axis (u, v are in the lens array's own frame)
      const au = Math.abs(u);
      const av = Math.abs(v);
      if (au > apothem || av > 2 * hexRise || (av > hexRise && av + au / Math.sqrt(3) > 2 * hexRise)) return;
    } else if (u * u + v * v > r2) return;
    if (opts.inner && Math.hypot(u, v) / g.pitch < opts.inner) return;
    if (dm ? !(plane[i] === plane[i] && dm.at(x, y, rgb)) : !rgbAt(plane, width, dev.cfa, x, y, rgb)) return;
    if (globalThis.__diagBins) {
      const dg = globalThis.__diagBins;
      const cxm = x - (cosR * u - sinR * v);
      const cym = y - (sinR * u + cosR * v);
      if (cxm > cam.width * 0.4 && cxm < cam.width * 0.6 && cym > cam.height * 0.4 && cym < cam.height * 0.6) {
        const rr = Math.min(dg.n - 1, Math.floor((Math.hypot(u, v) / g.pitch) * dg.n * 2));
        dg.sum[rr] += rgb[1];
        dg.cnt[rr]++;
      }
    }
    let lx = (lensX - xMin) / unit;
    let ly = (lensY - yMin) / unit;
    let ru = u;
    let rv = v;
    if (rayWarp) {
      // The engine corrects every ray with the camera's table: where it comes
      // from (dx, dy: fractions of the picture) and its direction (du, dv: lens
      // pitches), then projects the corrected ray (HexLightfieldGeometry::Project).
      const key = lensX + lensY * 1e6;
      if (key !== lastCell) {
        lastCell = key;
        const cx = x - (cosR * u - sinR * v);
        const cy = y - (sinR * u + cosR * v);
        cell = rayWarp.lens(cx / cam.width - 0.5, cy / cam.height - 0.5);
      }
      rayWarp.fromLens(cell, u / g.pitch, v / g.pitch, warpOut);
      const sx = warpOut[0] * cam.width;
      const sy = warpOut[1] * cam.height;
      lx += (cosR * sx + sinR * sy) / unit;
      ly += (-sinR * sx + cosR * sy) / unit;
      const dus = opts.duScale ?? 1;
      ru += (cosR * warpOut[2] + sinR * warpOut[3]) * g.pitch * dus;
      rv += (-sinR * warpOut[2] + cosR * warpOut[3]) * g.pitch * dus;
    }
    if (geoTable && opts.geoSign) {
      // GeometryErrorTable::CorrectLightfieldPoint: the cell's (u, v) is taken off the ray's direction (lens pitches, lens array axes).
      const gx = x - (cosR * u - sinR * v);
      const gy = y - (sinR * u + cosR * v);
      geometryAt(geoTable, gx / cam.width - 0.5, gy / cam.height - 0.5, geoOut);
      ru -= opts.geoSign * geoOut[0] * g.pitch;
      rv -= opts.geoSign * geoOut[1] * g.pitch;
    }
    if (opts.vScale) rv *= opts.vScale;
    const lam0 = sampleDepth(lo, lw, lh, lx, ly) / LAMBDA_TO_ALPHA;
    const lam1 = sampleDepth(hi, lw, lh, lx, ly) / LAMBDA_TO_ALPHA + 1;
    const lamR = marchRay(lx, ly, ru, rv, lam0, lam1, depth, lw, lh, opts, depth5);
    count++;
    if (!(lamR === lamR)) return;
    const rayWeight = opts.modPow ? Math.pow(plane.mod[i], opts.modPow) : 1;
    const a = lamR * LAMBDA_TO_ALPHA;
    let qx = (lx - a * ru) * scale;
    let qy = (ly - a * rv) * scale;
    if (warp) [qx, qy] = warp.forward(qx + 0.5, qy + 0.5).map((q) => q - 0.5);
    const x0 = Math.floor(qx);
    const y0 = Math.floor(qy);
    const fx = qx - x0;
    const fy = qy - y0;
    for (let j = 0; j < 2; j++) {
      for (let k = 0; k < 2; k++) {
        const xx = x0 + k;
        const yy = y0 + j;
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
        const p = yy * W + xx;
        if (globalThis.__rayDiag && j === 0 && k === 0) {
          const dd = lamR - zMap[p];
          const rb = Math.min(7, Math.floor((Math.hypot(u, v) / g.pitch) * 16));
          const dgn = globalThis.__rayDiag;
          dgn.n[rb]++;
          if (dd < -5) dgn.near[rb]++;
          if (dd > 5) dgn.far[rb]++;
        }
        if (lamR - zMap[p] >= opts.tolerance) continue;
        const w = (k ? fx : 1 - fx) * (j ? fy : 1 - fy);
        // the standardized pixel's colour is demodulated and its alpha is modulation ^ 2 (ApplyReweighting, cfg 0x2470): colour sums unweighted, alpha sums the weights
        const cw = opts.alphaPow ? w : w * rayWeight;
        const aw = opts.alphaPow ? w * Math.pow(plane.mod[i], opts.alphaPow) : w * rayWeight;
        acc[4 * p] += rgb[0] * cw;
        acc[4 * p + 1] += rgb[1] * cw;
        acc[4 * p + 2] += rgb[2] * cw;
        acc[4 * p + 3] += aw;
        if (j === 0 && k === 0) accepted++;
      }
    }
  }, onProgress);
  if (globalThis.__dumpSplatAcc) globalThis.__dumpSplatAcc(acc);
  return { acc, W, H, zMap, stats: { rays: count, accepted } };
}

// ---- hole filling (FUN_180c5fa60 and the pyramid FUN_180c60140) -------------

// One red black relaxation sweep of the filled picture B towards the data A
// (FUN_180c60990): every pixel becomes the sum of A's pixel and its four
// neighbours in B, divided by their summed weights (alpha), so alpha is 1.
function relax(A, B, w, h) {
  const upd = (x, y) => {
    const i = y * w + x;
    let r = A[4 * i];
    let g = A[4 * i + 1];
    let b = A[4 * i + 2];
    let a = A[4 * i + 3];
    const add = (j) => {
      r += B[4 * j];
      g += B[4 * j + 1];
      b += B[4 * j + 2];
      a += B[4 * j + 3];
    };
    if (y > 0) add(i - w);
    if (x > 0) add(i - 1);
    if (x < w - 1) add(i + 1);
    if (y < h - 1) add(i + w);
    if (a <= 0) {
      B[4 * i] = B[4 * i + 1] = B[4 * i + 2] = B[4 * i + 3] = 0;
    } else {
      B[4 * i] = r / a;
      B[4 * i + 1] = g / a;
      B[4 * i + 2] = b / a;
      B[4 * i + 3] = 1;
    }
  };
  for (let y = 0; y <= h; y++) {
    for (let x = ~y & 1; x < w; x += 2) {
      if (y < h) upd(x, y);
      if (y - 1 >= 0) upd(x, y - 1);
    }
  }
}

// 3 x 3 binomial reduction by two (FUN_180c5fee0); samples outside are skipped.
function reduce(src, w, h) {
  const nw = Math.ceil(w / 2);
  const nh = Math.ceil(h / 2);
  const out = new Float32Array(nw * nh * 4);
  const k = [0.25, 0.5, 0.25];
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let j = 0; j < 3; j++) {
        const yy = 2 * y - 1 + j;
        if (yy < 0 || yy >= h) continue;
        for (let i = 0; i < 3; i++) {
          const xx = 2 * x - 1 + i;
          if (xx < 0 || xx >= w) continue;
          const wt = k[i] * k[j];
          const q = 4 * (yy * w + xx);
          r += wt * src[q];
          g += wt * src[q + 1];
          b += wt * src[q + 2];
          a += wt * src[q + 3];
        }
      }
      const o = 4 * (y * nw + x);
      out[o] = r;
      out[o + 1] = g;
      out[o + 2] = b;
      out[o + 3] = a;
    }
  }
  return { data: out, w: nw, h: nh };
}

export const FILL = { full: 0.99, scale: 1000, small: 1, minSize: 20, levels: 10, sweeps: 3 };

// The premultiplied splat as a picture (alpha 1 wherever anything reached it).
export function fillHoles(acc, W, H, o = FILL) {
  // pixels with enough weight become colour, the rest stay premultiplied
  const A0 = new Float32Array(acc.length);
  for (let p = 0; p < W * H; p++) {
    const a = acc[4 * p + 3];
    const f = a >= o.full ? o.scale / a : o.small;
    for (let c = 0; c < 4; c++) A0[4 * p + c] = acc[4 * p + c] * f;
  }
  const As = [{ data: A0, w: W, h: H }];
  const Bs = [{ data: new Float32Array(W * H * 4), w: W, h: H }];
  for (let l = 0; l < o.levels; l++) {
    const last = As[As.length - 1];
    if (last.w < o.minSize && last.h < o.minSize) break;
    const nw = Math.floor((last.w + 1) / 2);
    const nh = Math.floor((last.h + 1) / 2);
    As.push({ data: null, w: nw, h: nh });
    Bs.push({ data: new Float32Array(nw * nh * 4), w: nw, h: nh });
  }
  for (let l = 0; l + 1 < As.length; l++) As[l + 1] = reduce(As[l].data, As[l].w, As[l].h);
  for (let l = As.length - 1; l >= 1; l--) {
    for (let s = 0; s < o.sweeps; s++) relax(As[l].data, Bs[l].data, As[l].w, As[l].h);
    // the coarse result seeds the even pixels of the next finer level
    const c = Bs[l];
    const f = Bs[l - 1];
    for (let y = 0; y < c.h; y++) {
      for (let x = 0; x < c.w; x++) {
        const yy = 2 * y;
        const xx = 2 * x;
        if (yy >= f.h || xx >= f.w) continue;
        const q = 4 * (yy * f.w + xx);
        const s0 = 4 * (y * c.w + x);
        f.data[q] = c.data[s0];
        f.data[q + 1] = c.data[s0 + 1];
        f.data[q + 2] = c.data[s0 + 2];
        f.data[q + 3] = c.data[s0 + 3];
      }
    }
  }
  for (let s = 0; s < o.sweeps; s++) relax(As[0].data, Bs[0].data, W, H);
  return Bs[0].data;
}

// ---- the depth aware filter bank (FUN_180c651c0 and below) -------------------

// Weight of a neighbour whose lambda differs from the pixel's by d: the
// trapezoid through (-4, 0), (-2, 1), (2, 1), (4, 0), looked up at
// int(d + 4.5) (clamped to 0..8) as the table of whole numbers -4..4.
const RANGE_LUT = [0, 0.5, 1, 1, 1, 1, 1, 0.5, 0];

function entryIndex(bank, tx, ty, lam) {
  const L = bank.lambdas;
  let i;
  if (!(L[0] <= lam && lam !== L[0])) i = 0;
  else if (!(lam < L[L.length - 1])) i = L.length - 1;
  else {
    i = 0;
    while (L[i] <= lam) i++;
    if ((lam - L[i - 1]) * 2 <= L[i] - L[i - 1]) i--;
  }
  return (i * bank.tilesY + ty) * bank.tilesX + tx;
}

function ramp(n, total, i, m) {
  // window of tile i of `n` along an axis of `total` pixels with overlap m
  const a = Math.trunc((total * i) / n);
  const b = Math.trunc((total * (i + 1)) / n);
  const start = i > 0 ? a - m : a;
  const end = i < n - 1 ? b + m : b;
  const upEnd = i > 0 ? a + m : a;
  const downStart = i < n - 1 ? b - m : b;
  const w = new Float32Array(end - start);
  for (let x = start; x < end; x++) {
    let v = 1;
    if (x < upEnd) v = (x - start + 1) / (upEnd - start + 1);
    else if (x >= downStart) v = (end - x) / (end - downStart + 1);
    w[x - start] = v;
  }
  return { start, end, w };
}

// img: RGB (Float32 W*H*3), depth: lambda per pixel (Float32 W*H).
export function applyBank(img, depth, W, H, bank) {
  const out = new Float32Array(W * H * 3);
  const wsum = new Float32Array(W * H);
  const m = Math.trunc((H * BANK.overlap + 1) * 0.5);
  const tmp = new Float32Array(W * H * 3);
  for (let ty = 0; ty < bank.tilesY; ty++) {
    const ry = ramp(bank.tilesY, H, ty, m);
    for (let tx = 0; tx < bank.tilesX; tx++) {
      const rx = ramp(bank.tilesX, W, tx, m);
      const tw = rx.end - rx.start;
      const th = ry.end - ry.start;
      // horizontal pass over the tile (taps stay inside the tile)
      for (let y = 0; y < th; y++) {
        for (let x = 0; x < tw; x++) {
          const gi = (ry.start + y) * W + rx.start + x;
          const lc = depth[gi];
          const f = bank.filters[entryIndex(bank, tx, ty, lc)];
          const hw = f.row.length >> 1;
          const x0 = Math.max(0, x - hw);
          const x1 = Math.min(tw - 1, x + hw);
          let r = 0;
          let g = 0;
          let b = 0;
          let s = 0;
          for (let xx = x0; xx <= x1; xx++) {
            const q = (ry.start + y) * W + rx.start + xx;
            const idx = Math.min(8, Math.max(0, Math.trunc(depth[q] - lc + 4.5)));
            const wt = f.row[xx - x + hw] * RANGE_LUT[idx];
            r += wt * img[3 * q];
            g += wt * img[3 * q + 1];
            b += wt * img[3 * q + 2];
            s += wt;
          }
          tmp[3 * gi] = s > 0 ? r / s : 0;
          tmp[3 * gi + 1] = s > 0 ? g / s : 0;
          tmp[3 * gi + 2] = s > 0 ? b / s : 0;
        }
      }
      // vertical pass
      for (let y = 0; y < th; y++) {
        for (let x = 0; x < tw; x++) {
          const gi = (ry.start + y) * W + rx.start + x;
          const lc = depth[gi];
          const f = bank.filters[entryIndex(bank, tx, ty, lc)];
          const hh = f.col.length >> 1;
          const y0 = Math.max(0, y - hh);
          const y1 = Math.min(th - 1, y + hh);
          let r = 0;
          let g = 0;
          let b = 0;
          let s = 0;
          for (let yy = y0; yy <= y1; yy++) {
            const q = (ry.start + yy) * W + rx.start + x;
            const idx = Math.min(8, Math.max(0, Math.trunc(depth[q] - lc + 4.5)));
            const wt = f.col[yy - y + hh] * RANGE_LUT[idx];
            r += wt * tmp[3 * q];
            g += wt * tmp[3 * q + 1];
            b += wt * tmp[3 * q + 2];
            s += wt;
          }
          const win = rx.w[x] * ry.w[y];
          const k = win; // Lytro normalises by the weighted kernel sum (GridFilterImage1DDepthMasked), so the kernel gain cancels
          if (s > 0) {
            out[3 * gi] += (r / s) * k;
            out[3 * gi + 1] += (g / s) * k;
            out[3 * gi + 2] += (b / s) * k;
          }
          wsum[gi] += win;
        }
      }
    }
  }
  return { rgb: out, wsum };
}
