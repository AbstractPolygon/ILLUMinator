// Light field rendering from the raw lenslet image.
//
// A sub-aperture view (u, v) takes, under every microlens, the pixel at offset
// (u, v) from the lens centre. Neighbouring views look at the scene from
// slightly different points on the main lens aperture, which gives parallax
// (perspective shift). Shifting views in proportion to (u, v) and averaging
// them focuses on a different depth (synthetic refocus).

import { lensCenters, toLocal } from './lenslet.js';

// Precomputes, for every output pixel, the four surrounding lenses and their
// interpolation weights. Output pixels are spaced `rowStep / detail` sensor
// pixels apart along the (de-rotated) lens grid axes.
export function buildSampler(grid, cam, detail = 1) {
  const lenses = lensCenters(grid, cam.width, cam.height);
  const { r0, r1, c0, c1, cols } = lenses;
  const spacing = grid.rowStep / detail;
  // Grid-local extent covered by complete lens neighbourhoods.
  const xMin = c0 * grid.pitch + grid.pitch;
  const xMax = c1 * grid.pitch - grid.pitch;
  const yMin = r0 * grid.rowStep;
  const yMax = (r1 - 1) * grid.rowStep;
  const outW = Math.max(1, Math.floor((xMax - xMin) / spacing));
  const outH = Math.max(1, Math.floor((yMax - yMin) / spacing));
  const idx = new Int32Array(outW * outH * 4);
  const wts = new Float32Array(outW * outH * 4);
  const half = grid.pitch / 2;
  let o = 0;
  for (let Y = 0; Y < outH; Y++) {
    const ly = yMin + Y * spacing;
    const rowF = ly / grid.rowStep;
    const ra = Math.floor(rowF);
    const t = rowF - ra;
    for (let X = 0; X < outW; X++, o += 4) {
      const lx = xMin + X * spacing;
      for (let k = 0; k < 2; k++) {
        const r = ra + k;
        const colF = (lx - (r & 1) * half) / grid.pitch;
        const ca = Math.floor(colF);
        const s = colF - ca;
        const base = (r - r0) * cols + (ca - c0);
        const wr = k === 0 ? 1 - t : t;
        idx[o + 2 * k] = base;
        idx[o + 2 * k + 1] = base + 1;
        wts[o + 2 * k] = wr * (1 - s);
        wts[o + 2 * k + 1] = wr * s;
      }
    }
  }
  return { grid, lenses, outW, outH, idx, wts, spacing, detail };
}

// Maps a sensor position to output image coordinates (used by the UI to draw
// the grid overlay and by tests).
export function sensorToOutput(sampler, x, y) {
  const { grid, lenses, spacing } = sampler;
  const [lx, ly] = toLocal(grid, x, y);
  return [(lx - (lenses.c0 + 1) * grid.pitch) / spacing, (ly - lenses.r0 * grid.rowStep) / spacing];
}

// Prepares per-channel normalisation so samplers do not need the metadata.
export function makeDevelopParams(cam) {
  const scale = [0, 1, 2].map((c) => cam.wb[c] / Math.max(1, cam.white[c] - cam.black[c]));
  return { cfa: cam.cfa, black: cam.black, scale };
}

// Bilinear interpolation on the sub-lattice of one Bayer colour, which has a
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

// Linear RGB for each lens at offset (u, v) (sensor pixels, grid axes).
function sampleLenses(raw, cam, dev, lenses, grid, u, v, out) {
  const { width, height } = cam;
  const cos = Math.cos(grid.rotation);
  const sin = Math.sin(grid.rotation);
  const du = cos * u - sin * v;
  const dv = sin * u + cos * v;
  const origins = latticeOrigins(dev.cfa);
  const [rO, gO, bO] = origins;
  const [bR, bG, bB] = dev.black;
  const [sR, sG, sB] = dev.scale;
  const n = lenses.cx.length;
  for (let i = 0; i < n; i++) {
    const x = lenses.cx[i] + du;
    const y = lenses.cy[i] + dv;
    const r = sampleLattice(raw, width, height, rO[0][0], rO[0][1], x, y);
    let g = 0;
    for (const [gx, gy] of gO) g += sampleLattice(raw, width, height, gx, gy, x, y);
    g /= gO.length;
    const b = sampleLattice(raw, width, height, bO[0][0], bO[0][1], x, y);
    out[3 * i] = Math.max(0, (r - bR) * sR);
    out[3 * i + 1] = Math.max(0, (g - bG) * sG);
    out[3 * i + 2] = Math.max(0, (b - bB) * sB);
  }
}

// Renders one sub-aperture view as linear RGB (Float32Array, outW * outH * 3).
export function renderView(raw, cam, dev, sampler, u, v, scratch) {
  const { lenses, idx, wts, outW, outH } = sampler;
  const per = scratch && scratch.length === lenses.cx.length * 3 ? scratch : new Float32Array(lenses.cx.length * 3);
  sampleLenses(raw, cam, dev, lenses, sampler.grid, u, v, per);
  const out = new Float32Array(outW * outH * 3);
  const n = outW * outH;
  for (let p = 0, o = 0; p < n; p++, o += 4) {
    let r = 0;
    let g = 0;
    let b = 0;
    for (let k = 0; k < 4; k++) {
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
export function refocus(views, outW, outH, alpha) {
  const out = new Float32Array(outW * outH * 3);
  const weight = new Float32Array(outW * outH);
  for (const view of views) {
    const sx = alpha * view.u * view.detail;
    const sy = alpha * view.v * view.detail;
    const ix = Math.floor(sx);
    const iy = Math.floor(sy);
    const ax = sx - ix;
    const ay = sy - iy;
    const w00 = (1 - ax) * (1 - ay);
    const w10 = ax * (1 - ay);
    const w01 = (1 - ax) * ay;
    const w11 = ax * ay;
    const data = view.rgb;
    const gain = view.gain;
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
        weight[dstRow + x] += 1;
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

export function colorMatrix(cam, settings) {
  const m = settings.useCcm && cam.ccm ? cam.ccm : IDENTITY;
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

// Linear camera RGB -> sRGB RGBA bytes.
export function toneMap(rgb, matrix, exposure, out) {
  const n = rgb.length / 3;
  const px = out || new Uint8ClampedArray(n * 4);
  const m = matrix.map((v) => v * exposure * 4096);
  for (let i = 0, o = 0; i < rgb.length; i += 3, o += 4) {
    const r = rgb[i];
    const g = rgb[i + 1];
    const b = rgb[i + 2];
    let R = m[0] * r + m[1] * g + m[2] * b;
    let G = m[3] * r + m[4] * g + m[5] * b;
    let B = m[6] * r + m[7] * g + m[8] * b;
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
