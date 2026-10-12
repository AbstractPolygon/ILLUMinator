// High resolution refocus by splatting every raw pixel.
//
// The standard renderer takes one sample per microlens, so its output has one
// pixel per lens. But each raw pixel under a lens sees the scene from a
// slightly different aperture position. When refocusing to depth `alpha`, a
// pixel at offset d from its lens centre L belongs at output position
// L - alpha * d. Away from the optical focus plane (alpha != 0) these
// positions from neighbouring lenses interleave at sub-lens spacing, so
// splatting each pixel there recovers detail finer than the lens grid.
//
// Pixels are splatted into their own colour channel only, which demosaics
// for free. Microlens vignetting is removed first using a gain table indexed
// by the offset under the lens: estimated from the picture itself, or (more
// accurately, including main lens vignetting) from a white image.

import { lensRange, lensCenter } from './lenslet.js';

const BINS = 17;

function tileWeights(table, x, y) {
  const fx = Math.min(table.tilesX - 1, Math.max(0, (x / table.width) * table.tilesX - 0.5));
  const fy = Math.min(table.tilesY - 1, Math.max(0, (y / table.height) * table.tilesY - 0.5));
  const x0 = Math.min(table.tilesX - 2, Math.floor(fx));
  const y0 = Math.min(table.tilesY - 2, Math.floor(fy));
  if (table.tilesX === 1 || table.tilesY === 1) return [[0, 1]];
  const ax = fx - x0;
  const ay = fy - y0;
  const t = (i, j) => j * table.tilesX + i;
  return [
    [t(x0, y0), (1 - ax) * (1 - ay)], [t(x0 + 1, y0), ax * (1 - ay)],
    [t(x0, y0 + 1), (1 - ax) * ay], [t(x0 + 1, y0 + 1), ax * ay],
  ];
}

// Visits every usable pixel under every lens:
// fn(index, x, y, u, v, lensX, lensY, lensR, lensC), with (u, v) the offset
// from the lens centre along the grid axes and (lensX, lensY) the grid-local
// lens position.
function forEachLensPixel(g, cam, radius, fn, onProgress, lensStride = 1) {
  const { width, height } = cam;
  const { r0, r1, c0, c1 } = lensRange(g, width, height, g.pitch);
  const cos = Math.cos(g.rotation);
  const sin = Math.sin(g.rotation);
  const r2 = radius * radius;
  for (let r = r0; r <= r1; r += lensStride) {
    if (onProgress && ((r - r0) & 31) === 0) onProgress((r - r0) / (r1 - r0 + 1));
    const lensY = r * g.rowStep;
    for (let c = c0; c <= c1; c++) {
      const lensX = c * g.pitch + (r & 1) * g.pitch * 0.5;
      const [cx, cy] = lensCenter(g, r, c);
      const ya = Math.max(2, Math.ceil(cy - radius));
      const yb = Math.min(height - 3, Math.floor(cy + radius));
      const xa = Math.max(2, Math.ceil(cx - radius));
      const xb = Math.min(width - 3, Math.floor(cx + radius));
      for (let y = ya; y <= yb; y++) {
        const dy = y - cy;
        for (let x = xa; x <= xb; x++) {
          const dx = x - cx;
          if (dx * dx + dy * dy > r2) continue;
          fn(y * width + x, x, y, cos * dx + sin * dy, -sin * dx + cos * dy, lensX, lensY);
        }
      }
    }
  }
}

// Gain table { tilesX, tilesY, bins, rMax, gain } built from per-bin means.
// From the picture itself use a single tile: the scene averages out over
// ~200k lenses, but per-tile normalisation would also flatten the scene.
// From a white image use several tiles so main lens vignetting is corrected.
export function estimateVignetting(source, cam, dev, g, { tilesX = 1, tilesY = 1 } = {}) {
  const rMax = g.pitch * 0.5;
  const tiles = tilesX * tilesY;
  const size = tiles * BINS * BINS * 3;
  const sum = new Float64Array(size);
  const cnt = new Float64Array(size);
  const { width, height } = cam;
  forEachLensPixel(g, cam, rMax, (i, x, y, u, v) => {
    const bu = Math.floor(((u / rMax + 1) / 2) * BINS);
    const bv = Math.floor(((v / rMax + 1) / 2) * BINS);
    if (bu < 0 || bv < 0 || bu >= BINS || bv >= BINS) return;
    const tx = Math.min(tilesX - 1, Math.floor((x / width) * tilesX));
    const ty = Math.min(tilesY - 1, Math.floor((y / height) * tilesY));
    const ch = dev.cfa[y & 1][x & 1];
    const k = (((ty * tilesX + tx) * BINS + bv) * BINS + bu) * 3 + ch;
    sum[k] += Math.max(0, source[i] - dev.black[ch]) * dev.scale[ch];
    cnt[k]++;
  }, null, tiles > 1 ? 1 : 2);
  const mean = new Float32Array(size);
  for (let k = 0; k < size; k++) mean[k] = cnt[k] ? sum[k] / cnt[k] : 0;
  // Reference per channel: the lens centre bin of the middle tile.
  const midTile = Math.floor(tilesY / 2) * tilesX + Math.floor(tilesX / 2);
  const midBin = (BINS >> 1) * BINS + (BINS >> 1);
  const ref = [0, 1, 2].map((ch) => mean[(midTile * BINS * BINS + midBin) * 3 + ch]);
  const gain = new Float32Array(size);
  for (let t = 0; t < tiles; t++) {
    for (let b = 0; b < BINS * BINS; b++) {
      for (let ch = 0; ch < 3; ch++) {
        const k = (t * BINS * BINS + b) * 3 + ch;
        const centre = mean[(t * BINS * BINS + midBin) * 3 + ch];
        // Bins darker than 30% of their lens centre are lens borders: unusable.
        gain[k] = mean[k] > centre * 0.3 ? ref[ch] / mean[k] : 0;
      }
    }
  }
  return { tilesX, tilesY, width, height, bins: BINS, rMax, gain };
}

// Bright single-pixel defects (hot pixels) and dead pixels: compare with the
// four nearest pixels of the same colour.
function isDefect(raw, width, i) {
  const v = raw[i];
  const m = (raw[i - 2] + raw[i + 2] + raw[i - 2 * width] + raw[i + 2 * width]) * 0.25;
  return v > m * 3 + 40 || (v < m * 0.2 && m > 100);
}

// options: { alpha, scale, vignetting, base, baseW, baseH, sigma, onProgress }
// `base` is the standard refocus result (linear RGB, baseW x baseH at the
// sampler's detail) used to fill output pixels that receive too few samples.
export function renderSuperRes(raw, cam, dev, sampler, options) {
  const { alpha = 0, scale = 3, vignetting: vg, base, sigma = 0.6, onProgress } = options;
  const { grid: g, lenses, outW, outH, detail } = sampler;
  const { width } = cam;
  const unit = g.rowStep;
  const xMin = (lenses.c0 + 1) * g.pitch;
  const yMin = lenses.r0 * g.rowStep;
  const W = Math.floor((outW / detail) * scale);
  const H = Math.floor((outH / detail) * scale);
  const acc = new Float32Array(W * H * 3);
  const wsum = new Float32Array(W * H * 3);
  const rUse = g.pitch * 0.45;
  const inv2s2 = 1 / (2 * sigma * sigma);
  const wx = new Float32Array(3);
  const wy = new Float32Array(3);
  const binScale = vg.bins / (2 * vg.rMax);
  const binsSq = vg.bins * vg.bins;
  let lastLens = NaN;
  let tw = null;

  forEachLensPixel(g, cam, rUse, (i, x, y, u, v, lensX, lensY) => {
    if (lensX + lensY * 1e6 !== lastLens) {
      lastLens = lensX + lensY * 1e6;
      tw = tileWeights(vg, x, y);
    }
    const ch = dev.cfa[y & 1][x & 1];
    const bin = Math.floor((v + vg.rMax) * binScale) * vg.bins + Math.floor((u + vg.rMax) * binScale);
    let gain = 0;
    for (const [t, w] of tw) gain += vg.gain[(t * binsSq + bin) * 3 + ch] * w;
    if (!(gain > 0) || isDefect(raw, width, i)) return;
    const value = Math.max(0, raw[i] - dev.black[ch]) * dev.scale[ch] * gain;
    const conf = 1 - (u * u + v * v) / (rUse * rUse);
    const ox = ((lensX - xMin) / unit - alpha * u) * scale;
    const oy = ((lensY - yMin) / unit - alpha * v) * scale;
    const px = Math.round(ox);
    const py = Math.round(oy);
    if (px < 1 || py < 1 || px >= W - 1 || py >= H - 1) return;
    for (let k = 0; k < 3; k++) {
      const ex = px - 1 + k - ox;
      const ey = py - 1 + k - oy;
      wx[k] = Math.exp(-ex * ex * inv2s2);
      wy[k] = Math.exp(-ey * ey * inv2s2) * conf;
    }
    for (let j = 0; j < 3; j++) {
      let o = ((py - 1 + j) * W + px - 1) * 3 + ch;
      for (let k = 0; k < 3; k++, o += 3) {
        const w = wx[k] * wy[j];
        acc[o] += value * w;
        wsum[o] += w;
      }
    }
  }, onProgress);

  // Normalise, falling back smoothly to the upsampled standard render where
  // samples are sparse (e.g. around the optical focus plane).
  const out = new Float32Array(W * H * 3);
  const lambda = 0.15;
  const bw = options.baseW;
  const bh = options.baseH;
  for (let j = 0; j < H; j++) {
    const by = Math.min(bh - 1.001, Math.max(0, ((j + 0.5) / scale) * detail - 0.5));
    const y0 = Math.floor(by);
    const ay = by - y0;
    for (let k = 0; k < W; k++) {
      const bx = Math.min(bw - 1.001, Math.max(0, ((k + 0.5) / scale) * detail - 0.5));
      const x0 = Math.floor(bx);
      const ax = bx - x0;
      const p = (j * W + k) * 3;
      for (let ch = 0; ch < 3; ch++) {
        let b = 0;
        if (base) {
          const q = (y0 * bw + x0) * 3 + ch;
          b = (base[q] * (1 - ax) + base[q + 3] * ax) * (1 - ay) + (base[q + bw * 3] * (1 - ax) + base[q + bw * 3 + 3] * ax) * ay;
        }
        out[p + ch] = (acc[p + ch] + b * lambda) / (wsum[p + ch] + lambda);
      }
    }
  }
  return { width: W, height: H, rgb: out };
}
