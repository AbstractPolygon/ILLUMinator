// Light field rendering from the raw lenslet image.
//
// A sub-aperture view (u, v) takes, under every microlens, the pixel at offset
// (u, v) from the lens center. Neighbouring views look at the scene from
// slightly different points on the main lens aperture, which gives parallax
// (perspective shift). Shifting views in proportion to (u, v) and averaging
// them focuses on a different depth (synthetic refocus).

import { lensCenters, toLocal } from './lenslet.js';
import { applyLook } from './color.js';

const TAPS = 8;

// Precomputes, for every output pixel, the nearby lenses and their weights.
// The lens rows are offset by half a lens, so any interpolation that takes
// each output row from one lens row puts a sharp edge at slightly different
// places in alternate rows (a comb pattern). A round kernel over all lenses
// within `kernel` lens pitches treats every direction alike instead.
// Output pixels are spaced `rowStep / detail` sensor pixels apart along the
// (de-rotated) lens grid axes.
// Grid-local extent covered by complete lens neighbourhoods, and the output
// size at `detail`.
function samplerExtent(lenses, grid, detail) {
  const { r0, r1, c0, c1 } = lenses;
  const spacing = grid.rowStep / detail;
  const xMin = c0 * grid.pitch + 2 * grid.pitch;
  const xMax = c1 * grid.pitch - 2 * grid.pitch;
  const yMin = (r0 + 1) * grid.rowStep;
  const yMax = (r1 - 2) * grid.rowStep;
  const outW = Math.max(1, Math.floor((xMax - xMin) / spacing));
  const outH = Math.max(1, Math.floor((yMax - yMin) / spacing));
  return { spacing, xMin, xMax, yMin, yMax, outW, outH };
}

// View size (pixels) at each `detail`, without building a sampler.
export function viewSizes(grid, cam, details) {
  const lenses = lensCenters(grid, cam.width, cam.height);
  return Object.fromEntries(details.map((d) => {
    const { outW, outH } = samplerExtent(lenses, grid, d);
    return [d, [outW, outH]];
  }));
}

export function buildSampler(grid, cam, detail = 1, kernel = 1.0) {
  const lenses = lensCenters(grid, cam.width, cam.height);
  const { cols, r0, c0 } = lenses;
  const { spacing, xMin, xMax, yMin, yMax, outW, outH } = samplerExtent(lenses, grid, detail);
  const idx = new Int32Array(outW * outH * TAPS);
  const wts = new Float32Array(outW * outH * TAPS);
  const radius = kernel * grid.pitch;
  const r2 = radius * radius;
  const half = grid.pitch / 2;
  const candI = new Int32Array(16);
  const candW = new Float32Array(16);
  let o = 0;
  for (let Y = 0; Y < outH; Y++) {
    const ly = yMin + Y * spacing;
    const ra = Math.floor(ly / grid.rowStep);
    for (let X = 0; X < outW; X++, o += TAPS) {
      const lx = xMin + X * spacing;
      let n = 0;
      for (let r = ra - 1; r <= ra + 2; r++) {
        const dy = ly - r * grid.rowStep;
        if (dy * dy >= r2) continue;
        const off = (r & 1) * half;
        const cc = Math.round((lx - off) / grid.pitch);
        for (let c = cc - 1; c <= cc + 1; c++) {
          const dx = lx - (c * grid.pitch + off);
          const d2 = dx * dx + dy * dy;
          if (d2 >= r2) continue;
          const q = 1 - d2 / r2;
          candI[n] = (r - r0) * cols + (c - c0);
          candW[n] = q * q;
          n++;
        }
      }
      // Keep the strongest taps and normalize.
      let sum = 0;
      for (let k = 0; k < TAPS; k++) {
        let best = -1;
        for (let m = 0; m < n; m++) if (candW[m] > 0 && (best < 0 || candW[m] > candW[best])) best = m;
        if (best < 0) {
          idx[o + k] = idx[o];
          wts[o + k] = 0;
          continue;
        }
        idx[o + k] = candI[best];
        wts[o + k] = candW[best];
        sum += candW[best];
        candW[best] = 0;
      }
      for (let k = 0; k < TAPS; k++) wts[o + k] /= sum || 1;
    }
  }
  return { grid, lenses, outW, outH, idx, wts, taps: TAPS, spacing, detail, xMin, yMin, kernel };
}

// Maps a sensor position to output image coordinates (used by the UI to draw
// the grid overlay and by tests).
export function sensorToOutput(sampler, x, y) {
  const { grid, spacing } = sampler;
  const [lx, ly] = toLocal(grid, x, y);
  return [(lx - sampler.xMin) / spacing, (ly - sampler.yMin) / spacing];
}

// Prepares per-channel normalization so samplers do not need the metadata.
// Raw values this close to the white level count as saturated.
const SATURATION = 0.97;

export function makeDevelopParams(cam) {
  const scale = [0, 1, 2].map((c) => cam.wb[c] / Math.max(1, cam.white[c] - cam.black[c]));
  // Raw level at which each channel saturates, and the developed level at
  // which the first channel does. Above it the true color is unknown: when
  // every channel clips, white balance scales red and blue more than green
  // and white highlights turn pink or red. Clamping all channels to the
  // first channel's clip level renders them white instead.
  const saturated = [0, 1, 2].map((c) => cam.black[c] + SATURATION * (cam.white[c] - cam.black[c]));
  const clip = Math.min(...[0, 1, 2].map((c) => (saturated[c] - cam.black[c]) * scale[c]));
  return { cfa: cam.cfa, black: cam.black, scale, saturated, clip };
}

// Bilinear interpolation on the sub-lattice of one Bayer color, which has a
// spacing of two pixels and starts at (px, py).
function sampleLattice(raw, width, height, px, py, x, y) {
  const fx = (x - px) / 2;
  const fy = (y - py) / 2;
  const i = Math.floor(fx);
  const j = Math.floor(fy);
  const ax = fx - i;
  const ay = fy - j;
  const sx = px + 2 * i;
  const sy = py + 2 * j;
  if (sx < 0 || sy < 0 || sx + 2 >= width || sy + 2 >= height) return 0;
  const p = sy * width + sx;
  const q = p + 2 * width;
  return (raw[p] * (1 - ax) + raw[p + 2] * ax) * (1 - ay) + (raw[q] * (1 - ax) + raw[q + 2] * ax) * ay;
}

function latticeOrigins(cfa) {
  const out = [[], [], []];
  for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) out[cfa[y][x]].push([x, y]);
  return out;
}

// Box sum over a (2r+1)^2 window of lenses on the lens grid.
function lensBoxSum(src, rows, cols, r) {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  for (let y = 0; y < rows; y++) {
    let acc = 0;
    const row = y * cols;
    for (let x = -r; x <= r; x++) if (x >= 0 && x < cols) acc += src[row + x];
    for (let x = 0; x < cols; x++) {
      tmp[row + x] = acc;
      if (x + r + 1 < cols) acc += src[row + x + r + 1];
      if (x - r >= 0) acc -= src[row + x - r];
    }
  }
  for (let x = 0; x < cols; x++) {
    let acc = 0;
    for (let y = -r; y <= r; y++) if (y >= 0 && y < rows) acc += tmp[y * cols + x];
    for (let y = 0; y < rows; y++) {
      out[y * cols + x] = acc;
      if (y + r + 1 < rows) acc += tmp[(y + r + 1) * cols + x];
      if (y - r >= 0) acc -= tmp[(y - r) * cols + x];
    }
  }
  return out;
}

const CHROMA_RADIUS = 3; // lenses
const LUMA_SIGMA = 0.9; // sensor pixels

// Linear RGB for each lens at offset (u, v) (sensor pixels, grid axes).
//
// Lenses are 14.29 pixels apart but the color filter pattern repeats every 2,
// so each lens samples the pattern at a slightly different place. Very sharp
// detail inside a lens image (a bright point such as the sun in lens flare
// can be a single pixel) lands on a red, green or blue pixel depending on
// the lens, and plain demosaicing turns that into red and blue stripes. So:
//  - color is averaged over neighboring lenses, which see the same detail
//    through every filter color;
//  - brightness comes from every raw pixel near the sample point, each
//    converted to brightness using that color, so it does not depend on
//    which filter a detail landed on.
function sampleLenses(raw, cam, dev, lenses, grid, u, v, out) {
  const { width, height } = cam;
  const cos = Math.cos(grid.rotation);
  const sin = Math.sin(grid.rotation);
  const du = cos * u - sin * v;
  const dv = sin * u + cos * v;
  const [rO, gO, bO] = latticeOrigins(dev.cfa);
  const { black, scale } = dev;
  const clip = dev.clip ?? Infinity;
  const n = lenses.cx.length;
  const R = new Float32Array(n);
  const G = new Float32Array(n);
  const B = new Float32Array(n);
  const Y = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = lenses.cx[i] + du;
    const y = lenses.cy[i] + dv;
    const r = sampleLattice(raw, width, height, rO[0][0], rO[0][1], x, y);
    let g = 0;
    for (const [gx, gy] of gO) g += sampleLattice(raw, width, height, gx, gy, x, y);
    g /= gO.length;
    const b = sampleLattice(raw, width, height, bO[0][0], bO[0][1], x, y);
    R[i] = Math.min(clip, Math.max(0, (r - black[0]) * scale[0]));
    G[i] = Math.min(clip, Math.max(0, (g - black[1]) * scale[1]));
    B[i] = Math.min(clip, Math.max(0, (b - black[2]) * scale[2]));
    Y[i] = 0.2126 * R[i] + 0.7152 * G[i] + 0.0722 * B[i];
  }
  // Neighborhood color as fractions of brightness.
  const { rows, cols } = lenses;
  const sR = lensBoxSum(R, rows, cols, CHROMA_RADIUS);
  const sG = lensBoxSum(G, rows, cols, CHROMA_RADIUS);
  const sB = lensBoxSum(B, rows, cols, CHROMA_RADIUS);
  const sY = lensBoxSum(Y, rows, cols, CHROMA_RADIUS);
  const reach = Math.ceil(2 * LUMA_SIGMA);
  const inv2s2 = 1 / (2 * LUMA_SIGMA * LUMA_SIGMA);
  for (let i = 0; i < n; i++) {
    const yN = sY[i];
    if (!(yN > 1e-9)) {
      out[3 * i] = out[3 * i + 1] = out[3 * i + 2] = 0;
      continue;
    }
    const frac = [sR[i] / yN, sG[i] / yN, sB[i] / yN];
    // Brightness per unit of each channel's value, from the local color.
    const toY = frac.map((f) => (f > 1e-4 ? 1 / f : 0));
    const x = lenses.cx[i] + du;
    const y = lenses.cy[i] + dv;
    const x0 = Math.round(x);
    const y0 = Math.round(y);
    let acc = 0;
    let wsum = 0;
    for (let yy = y0 - reach; yy <= y0 + reach; yy++) {
      if (yy < 0 || yy >= height) continue;
      const ey = yy - y;
      const crow = dev.cfa[yy & 1];
      for (let xx = x0 - reach; xx <= x0 + reach; xx++) {
        if (xx < 0 || xx >= width) continue;
        const ex = xx - x;
        const w = Math.exp(-(ex * ex + ey * ey) * inv2s2);
        const ch = crow[xx & 1];
        const val = Math.min(clip, Math.max(0, (raw[yy * width + xx] - black[ch]) * scale[ch]));
        acc += w * val * toY[ch];
        wsum += w;
      }
    }
    const lum = wsum > 0 ? Math.min(clip, acc / wsum) : Y[i];
    out[3 * i] = lum * frac[0];
    out[3 * i + 1] = lum * frac[1];
    out[3 * i + 2] = lum * frac[2];
  }
}

// Renders one sub-aperture view as linear RGB (Float32Array, outW * outH * 3).
export function renderView(raw, cam, dev, sampler, u, v, scratch) {
  const { lenses, idx, wts, outW, outH, taps } = sampler;
  const per = scratch && scratch.length === lenses.cx.length * 3 ? scratch : new Float32Array(lenses.cx.length * 3);
  sampleLenses(raw, cam, dev, lenses, sampler.grid, u, v, per);
  const out = new Float32Array(outW * outH * 3);
  const n = outW * outH;
  for (let p = 0, o = 0; p < n; p++, o += taps) {
    let r = 0;
    let g = 0;
    let b = 0;
    for (let k = 0; k < taps; k++) {
      const w = wts[o + k];
      const l = idx[o + k] * 3;
      r += per[l] * w;
      g += per[l + 1] * w;
      b += per[l + 2] * w;
    }
    out[3 * p] = r;
    out[3 * p + 1] = g;
    out[3 * p + 2] = b;
  }
  return out;
}

export function meanLuminance(rgb) {
  let s = 0;
  const n = rgb.length / 3;
  for (let i = 0; i < rgb.length; i += 3) s += 0.2126 * rgb[i] + 0.7152 * rgb[i + 1] + 0.0722 * rgb[i + 2];
  return n ? s / n : 0;
}

// Sub-aperture positions on a square grid, clipped to a disc of radius
// `radius` (sensor pixels).
export function apertureSamples(radius, steps) {
  const out = [];
  const half = (steps - 1) / 2;
  for (let j = 0; j < steps; j++) {
    for (let i = 0; i < steps; i++) {
      const u = half ? ((i - half) / half) * radius : 0;
      const v = half ? ((j - half) / half) * radius : 0;
      if (u * u + v * v <= radius * radius * 1.0001) out.push({ u, v });
    }
  }
  return out;
}

// Shift-and-add refocus over a set of pre-rendered views.
// `alpha` is the shift in output pixels (at detail 1) per sensor pixel of
// aperture offset; each view carries { u, v, rgb, gain, detail }.
// A synthetic aperture centerd on (u0, v0) with Gaussian radius `sigma`
// (sensor pixels) combines refocusing with a change of viewpoint; a smaller
// sigma gives more depth of field.
export function refocus(views, outW, outH, alpha, { u0 = 0, v0 = 0, sigma = Infinity } = {}) {
  const out = new Float32Array(outW * outH * 3);
  const weight = new Float32Array(outW * outH);
  for (const view of views) {
    const du = view.u - u0;
    const dv = view.v - v0;
    const wv = Number.isFinite(sigma) ? Math.exp(-(du * du + dv * dv) / (2 * sigma * sigma)) : 1;
    if (wv < 1e-3) continue;
    const sx = alpha * du * view.detail;
    const sy = alpha * dv * view.detail;
    const ix = Math.floor(sx);
    const iy = Math.floor(sy);
    const ax = sx - ix;
    const ay = sy - iy;
    const w00 = (1 - ax) * (1 - ay);
    const w10 = ax * (1 - ay);
    const w01 = (1 - ax) * ay;
    const w11 = ax * ay;
    const data = view.rgb;
    const gain = view.gain * wv;
    const x0 = Math.max(0, -ix);
    const x1 = Math.min(outW, outW - ix - 1);
    const y0 = Math.max(0, -iy);
    const y1 = Math.min(outH, outH - iy - 1);
    for (let y = y0; y < y1; y++) {
      const srcRow = (y + iy) * outW + ix;
      const dstRow = y * outW;
      for (let x = x0; x < x1; x++) {
        const s = (srcRow + x) * 3;
        const t = s + 3;
        const u = s + outW * 3;
        const w = u + 3;
        const d = (dstRow + x) * 3;
        out[d] += (data[s] * w00 + data[t] * w10 + data[u] * w01 + data[w] * w11) * gain;
        out[d + 1] += (data[s + 1] * w00 + data[t + 1] * w10 + data[u + 1] * w01 + data[w + 1] * w11) * gain;
        out[d + 2] += (data[s + 2] * w00 + data[t + 2] * w10 + data[u + 2] * w01 + data[w + 2] * w11) * gain;
        weight[dstRow + x] += wv;
      }
    }
  }
  for (let p = 0; p < weight.length; p++) {
    const w = weight[p] || 1;
    out[3 * p] /= w;
    out[3 * p + 1] /= w;
    out[3 * p + 2] /= w;
  }
  return out;
}

// --- tone mapping ------------------------------------------------------------

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];

function srgbTable() {
  const n = 4096;
  const t = new Uint8ClampedArray(n + 1);
  for (let i = 0; i <= n; i++) {
    const v = i / n;
    t[i] = Math.round(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055));
  }
  return t;
}
const SRGB = srgbTable();

// settings.ccm (9 values, rows of output RGB from camera RGB) replaces the
// camera's own matrix; useCcm false uses none.
export function colorMatrix(cam, settings) {
  const m = Array.isArray(settings.ccm) && settings.ccm.length === 9 ? settings.ccm : settings.useCcm && cam.ccm ? cam.ccm : IDENTITY;
  const sat = settings.saturation;
  // Saturation around Rec.709 luminance, applied after the camera matrix.
  const lr = 0.2126 * (1 - sat);
  const lg = 0.7152 * (1 - sat);
  const lb = 0.0722 * (1 - sat);
  const s = [lr + sat, lg, lb, lr, lg + sat, lb, lr, lg, lb + sat];
  const out = new Array(9);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      out[i * 3 + j] = s[i * 3] * m[j] + s[i * 3 + 1] * m[3 + j] + s[i * 3 + 2] * m[6 + j];
    }
  }
  return out;
}

// Exposure that maps the 99.5th luminance percentile to just below white.
export function autoExposure(rgb, matrix) {
  const bins = 2048;
  const hist = new Uint32Array(bins);
  const max = 4;
  let n = 0;
  for (let i = 0; i < rgb.length; i += 3) {
    const r = matrix[0] * rgb[i] + matrix[1] * rgb[i + 1] + matrix[2] * rgb[i + 2];
    const g = matrix[3] * rgb[i] + matrix[4] * rgb[i + 1] + matrix[5] * rgb[i + 2];
    const b = matrix[6] * rgb[i] + matrix[7] * rgb[i + 1] + matrix[8] * rgb[i + 2];
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    hist[Math.max(0, Math.min(bins - 1, Math.floor((y / max) * bins)))]++;
    n++;
  }
  let acc = 0;
  const target = n * 0.995;
  for (let i = 0; i < bins; i++) {
    acc += hist[i];
    if (acc >= target) return 0.92 / Math.max(1e-3, ((i + 1) / bins) * max);
  }
  return 1;
}

// Linear camera RGB -> sRGB RGBA bytes. `look`: the per-pixel color
// adjustments from makeLook (core/color.js), applied after exposure.
export function toneMap(rgb, matrix, exposure, out, look = null) {
  const n = rgb.length / 3;
  const px = out || new Uint8ClampedArray(n * 4);
  const scale = look ? 1 : 4096;
  const m = matrix.map((v) => v * exposure * scale);
  const p = [0, 0, 0];
  for (let i = 0, o = 0; i < rgb.length; i += 3, o += 4) {
    const r = rgb[i];
    const g = rgb[i + 1];
    const b = rgb[i + 2];
    let R = m[0] * r + m[1] * g + m[2] * b;
    let G = m[3] * r + m[4] * g + m[5] * b;
    let B = m[6] * r + m[7] * g + m[8] * b;
    if (look) {
      p[0] = R;
      p[1] = G;
      p[2] = B;
      applyLook(p, look);
      R = p[0] * 4096;
      G = p[1] * 4096;
      B = p[2] * 4096;
    }
    R = R < 0 ? 0 : R > 4096 ? 4096 : R;
    G = G < 0 ? 0 : G > 4096 ? 4096 : G;
    B = B < 0 ? 0 : B > 4096 ? 4096 : B;
    px[o] = SRGB[R | 0];
    px[o + 1] = SRGB[G | 0];
    px[o + 2] = SRGB[B | 0];
    px[o + 3] = 255;
  }
  return px;
}

// Local contrast (gradient energy) in a window, used for click-to-focus.
export function sharpness(rgb, width, height, cx, cy, radius) {
  let s = 0;
  const lum = (x, y) => {
    const i = (y * width + x) * 3;
    return rgb[i] + 2 * rgb[i + 1] + rgb[i + 2];
  };
  const x0 = Math.max(1, Math.round(cx - radius));
  const x1 = Math.min(width - 2, Math.round(cx + radius));
  const y0 = Math.max(1, Math.round(cy - radius));
  const y1 = Math.min(height - 2, Math.round(cy + radius));
  let mean = 0;
  let count = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const gx = lum(x + 1, y) - lum(x - 1, y);
      const gy = lum(x, y + 1) - lum(x, y - 1);
      s += gx * gx + gy * gy;
      mean += lum(x, y);
      count++;
    }
  }
  mean = count ? mean / count : 0;
  return mean > 0 ? s / count / (mean * mean) : 0;
}
