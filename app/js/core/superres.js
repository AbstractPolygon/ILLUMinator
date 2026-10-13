// High resolution refocus by splatting every raw pixel.
//
// The standard renderer takes one sample per microlens, so its output has one
// pixel per lens. But each raw pixel under a lens sees the scene from a
// slightly different aperture position. When refocusing to depth `alpha`, a
// pixel at offset d from its lens center L belongs at output position
// L - alpha * d. Away from the optical focus plane (alpha != 0) these
// positions from neighbouring lenses interleave at sub-lens spacing, so
// splatting each pixel there recovers detail finer than the lens grid.
//
// Pixels are splatted into their own color channel only, which demosaics
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
// from the lens center along the grid axes and (lensX, lensY) the grid-local
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
// ~200k lenses, but per-tile normalization would also flatten the scene.
// From a white image use several tiles so main lens vignetting is corrected.
export function estimateVignetting(source, cam, dev, g, { tilesX = 1, tilesY = 1, lensStride } = {}) {
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
  }, null, lensStride ?? (tiles > 1 ? 1 : 2));
  const mean = new Float32Array(size);
  for (let k = 0; k < size; k++) mean[k] = cnt[k] ? sum[k] / cnt[k] : 0;
  // Reference per channel: the lens center bin of the middle tile.
  const midTile = Math.floor(tilesY / 2) * tilesX + Math.floor(tilesX / 2);
  const midBin = (BINS >> 1) * BINS + (BINS >> 1);
  const ref = [0, 1, 2].map((ch) => mean[(midTile * BINS * BINS + midBin) * 3 + ch]);
  const gain = new Float32Array(size);
  for (let t = 0; t < tiles; t++) {
    for (let b = 0; b < BINS * BINS; b++) {
      for (let ch = 0; ch < 3; ch++) {
        const k = (t * BINS * BINS + b) * 3 + ch;
        const center = mean[(t * BINS * BINS + midBin) * 3 + ch];
        // Bins darker than 30% of their lens center are lens borders: unusable.
        gain[k] = mean[k] > center * 0.3 ? ref[ch] / mean[k] : 0;
      }
    }
  }
  return { tilesX, tilesY, width, height, bins: BINS, rMax, gain };
}

// Bright single-pixel defects (hot pixels) and dead pixels: compare with the
// four nearest pixels of the same color.
function isDefect(raw, width, i) {
  const v = raw[i];
  const m = (raw[i - 2] + raw[i + 2] + raw[i - 2 * width] + raw[i + 2 * width]) * 0.25;
  return v > m * 3 + 40 || (v < m * 0.2 && m > 100);
}

function sampleBilinear(img, w, h, x, y) {
  const fx = Math.min(w - 1.001, Math.max(0, x));
  const fy = Math.min(h - 1.001, Math.max(0, y));
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const ax = fx - x0;
  const ay = fy - y0;
  const q = y0 * w + x0;
  return (img[q] * (1 - ax) + img[q + 1] * ax) * (1 - ay) + (img[q + w] * (1 - ax) + img[q + w + 1] * ax) * ay;
}

// options: { alpha, allInFocus, u0, v0, apertureSigma, scale, vignetting,
//            base, baseW, baseH, depth, sigma, aperture, onProgress }
// (u0, v0) moves the viewpoint like the camera view does; `apertureSigma`
// (sensor pixels) narrows the synthetic aperture around it for more depth of
// field when refocusing.
// `base` is the standard refocus result (linear RGB, baseW x baseH at the
// sampler's detail) used to fill output pixels that receive too few samples.
//
// Splatting is only right for scene points at the focus depth: out of focus,
// each lens's tiny image of the scene lands at the wrong scale and the result
// looks like a mosaic of hexagonal tiles. `depth` (the focus value that makes
// each base pixel sharp, from estimateDepth) fixes this in two ways:
//  - refocusing at `alpha`: splatted detail is kept where the scene is in
//    focus and the smooth refocus blur of `base` is used elsewhere;
//  - `allInFocus`: every lens's pixels are placed using the depth under that
//    lens, so every depth is sharp (base should then be a single view).
export function renderSuperRes(raw, cam, dev, sampler, options) {
  const {
    alpha = 0, allInFocus = false, u0 = 0, v0 = 0, apertureSigma = Infinity, scale = 3, vignetting: vg, base, depth,
    depthTolerance = 0.12, onProgress,
  } = options;
  const inv2a2 = Number.isFinite(apertureSigma) ? 1 / (2 * apertureSigma * apertureSigma) : 0;
  // At higher output scales there are fewer samples per output pixel; use a
  // little more of each lens and wider splats so they still cover evenly.
  const sigma = options.sigma ?? 0.6 * Math.max(1, scale / 3);
  const aperture = options.aperture ?? (scale >= 4 ? 0.42 : 0.38);
  const { grid: g, outW, outH, detail } = sampler;
  const { width } = cam;
  const unit = g.rowStep;
  const { xMin, yMin } = sampler;
  const bw = options.baseW;
  const bh = options.baseH;
  const W = Math.floor((outW / detail) * scale);
  const H = Math.floor((outH / detail) * scale);
  // Color comes from the smooth standard render (upsampled), and only
  // brightness detail from the splatted raw pixels. Splatting each pixel into
  // its own color channel would leave red and blue (a quarter of the pixels
  // each) sparse and slightly displaced from green, which shows as color
  // fringes that change with focus. Instead every raw pixel, whatever its
  // color, gives a brightness estimate using the local color of the standard
  // render: three times denser than green alone, and fringe free.
  const up = new Float32Array(W * H * 3);
  const upY = new Float32Array(W * H);
  const focus = new Float32Array(W * H);
  for (let j = 0; j < H; j++) {
    const by = Math.min(bh - 1.001, Math.max(0, ((j + 0.5) / scale) * detail - 0.5));
    const y0 = Math.floor(by);
    const ay = by - y0;
    for (let k = 0; k < W; k++) {
      const bx = Math.min(bw - 1.001, Math.max(0, ((k + 0.5) / scale) * detail - 0.5));
      const x0 = Math.floor(bx);
      const ax = bx - x0;
      const p = j * W + k;
      for (let ch = 0; ch < 3; ch++) {
        let b = 0;
        if (base) {
          const q = (y0 * bw + x0) * 3 + ch;
          b = (base[q] * (1 - ax) + base[q + 3] * ax) * (1 - ay) + (base[q + bw * 3] * (1 - ax) + base[q + bw * 3 + 3] * ax) * ay;
        }
        up[3 * p + ch] = b;
      }
      upY[p] = 0.2126 * up[3 * p] + 0.7152 * up[3 * p + 1] + 0.0722 * up[3 * p + 2];
      let inFocus = 1;
      if (depth && !allInFocus) {
        const q = y0 * bw + x0;
        const d = (depth[q] * (1 - ax) + depth[q + 1] * ax) * (1 - ay) + (depth[q + bw] * (1 - ax) + depth[q + bw + 1] * ax) * ay;
        const e = (d - alpha) / depthTolerance;
        inFocus = Math.exp(-e * e);
      }
      focus[p] = inFocus;
    }
  }

  const rUse = g.pitch * aperture;
  const reach = Math.ceil(1.5 * sigma);
  let accY;
  let wsum;
  if (options.gpuSplat) {
    // The same accumulation on the GPU: one point per raw pixel.
    ({ accY, wsum } = options.gpuSplat({
      W, H, scale, sigma, reach, rUse, alpha, allInFocus, u0, v0, apertureSigma, vignetting: vg,
      xMin, yMin, unit, detail, base, baseW: bw, baseH: bh, depth,
    }));
  } else {
    ({ accY, wsum } = splatOnCpu());
  }

  function splatOnCpu() {
    const accY = new Float32Array(W * H);
    const wsum = new Float32Array(W * H);
    const inv2s2 = 1 / (2 * sigma * sigma);
    const taps = 2 * reach + 1;
    const wx = new Float32Array(taps);
    const wy = new Float32Array(taps);
    const binScale = vg.bins / (2 * vg.rMax);
    const binsSq = vg.bins * vg.bins;
    let lastLens = NaN;
    let tw = null;
    let lensAlpha = alpha;

    forEachLensPixel(g, cam, rUse, (i, x, y, u, v, lensX, lensY) => {
      if (lensX + lensY * 1e6 !== lastLens) {
        lastLens = lensX + lensY * 1e6;
        tw = tileWeights(vg, x, y);
        if (allInFocus && depth) {
          lensAlpha = sampleBilinear(depth, bw, bh, ((lensX - xMin) / unit) * detail, ((lensY - yMin) / unit) * detail);
        }
      }
      const ch = dev.cfa[y & 1][x & 1];
      const bin = Math.floor((v + vg.rMax) * binScale) * vg.bins + Math.floor((u + vg.rMax) * binScale);
      let gain = 0;
      for (const [t, w] of tw) gain += vg.gain[(t * binsSq + bin) * 3 + ch] * w;
      // Saturated pixels carry no reliable brightness; the standard render
      // (with clipped highlights rendered white) fills in there.
      if (!(gain > 0) || raw[i] >= dev.saturated[ch] || isDefect(raw, width, i)) return;
      const du = u - u0;
      const dv = v - v0;
      const conf = (1 - (u * u + v * v) / (rUse * rUse)) * (inv2a2 ? Math.exp(-(du * du + dv * dv) * inv2a2) : 1);
      if (conf < 1e-3) return;
      const ox = ((lensX - xMin) / unit - lensAlpha * du) * scale;
      const oy = ((lensY - yMin) / unit - lensAlpha * dv) * scale;
      const px = Math.round(ox);
      const py = Math.round(oy);
      if (px < reach || py < reach || px >= W - reach || py >= H - reach) return;
      // Brightness estimate from this one color sample and the local color.
      const lp = py * W + px;
      const c = up[3 * lp + ch];
      if (!(c > 1e-5)) return;
      const value = Math.max(0, raw[i] - dev.black[ch]) * dev.scale[ch] * gain;
      const yEst = value * Math.min(8, upY[lp] / c);
      for (let k = 0; k < taps; k++) {
        const ex = px - reach + k - ox;
        const ey = py - reach + k - oy;
        wx[k] = Math.exp(-ex * ex * inv2s2);
        wy[k] = Math.exp(-ey * ey * inv2s2) * conf;
      }
      for (let j = 0; j < taps; j++) {
        let o = (py - reach + j) * W + px - reach;
        for (let k = 0; k < taps; k++, o++) {
          const w = wx[k] * wy[j];
          accY[o] += yEst * w;
          wsum[o] += w;
        }
      }
    }, onProgress);
    return { accY, wsum };
  }

  // Normalize, falling back smoothly to the standard render where samples
  // are sparse; match overall brightness to it; keep detail where in focus.
  const lambda = 0.15;
  const sharpY = new Float32Array(W * H);
  let sumUp = 0;
  let sumSharp = 0;
  for (let p = 0; p < W * H; p++) {
    sharpY[p] = (accY[p] + upY[p] * lambda) / (wsum[p] + lambda);
    sumUp += upY[p];
    sumSharp += sharpY[p];
  }
  const pattern = removeLatticePattern(sharpY, upY, focus, wsum, W, H, { g, xMin, yMin, unit, scale });
  const match = sumSharp > 0 ? sumUp / sumSharp : 1;
  const out = new Float32Array(W * H * 3);
  for (let p = 0; p < W * H; p++) {
    const ratio = upY[p] > 1e-6 ? Math.min(4, (sharpY[p] * match) / upY[p]) : 1;
    const k = focus[p] * ratio + (1 - focus[p]);
    out[3 * p] = up[3 * p] * k;
    out[3 * p + 1] = up[3 * p + 1] * k;
    out[3 * p + 2] = up[3 * p + 2] * k;
  }
  return { width: W, height: H, rgb: out, pattern };
}

const PHASE_BINS = 16;

// The splatted samples' density and brightness vary slightly with position
// inside each lens cell, so the result carries a faint pattern that repeats
// with the lens grid (hexagons or squares, most visible on smooth surfaces).
// Measure it: average the ratio of splatted to standard brightness at each
// position within the cell (its lattice phase) over the whole picture, where
// the scene evens out, and divide it out. Returns the pattern's strength
// (relative standard deviation) before correction.
function removeLatticePattern(sharpY, upY, focus, wsum, W, H, { g, xMin, yMin, unit, scale }) {
  const n = PHASE_BINS;
  const sum = new Float64Array(n * n);
  const cnt = new Float64Array(n * n);
  const phase = (k, j) => {
    const ly = yMin + (j / scale) * unit;
    const lx = xMin + (k / scale) * unit;
    const fj = ly / g.rowStep;
    const fi = (lx - fj * g.pitch * 0.5) / g.pitch;
    return [fi - Math.floor(fi), fj - Math.floor(fj)];
  };
  for (let j = 0; j < H; j++) {
    for (let k = 0; k < W; k++) {
      const p = j * W + k;
      if (focus[p] < 0.5 || !(wsum[p] > 0) || !(upY[p] > 1e-4)) continue;
      const [a, b] = phase(k, j);
      const bin = Math.min(n - 1, Math.floor(b * n)) * n + Math.min(n - 1, Math.floor(a * n));
      sum[bin] += sharpY[p] / upY[p];
      cnt[bin] += 1;
    }
  }
  let total = 0;
  let count = 0;
  for (let i = 0; i < n * n; i++) {
    total += sum[i];
    count += cnt[i];
  }
  if (count < n * n * 20) return 0;
  const mean = total / count;
  const gain = new Float32Array(n * n);
  let var2 = 0;
  for (let i = 0; i < n * n; i++) {
    gain[i] = cnt[i] > 0 ? sum[i] / cnt[i] / mean : 1;
    var2 += (gain[i] - 1) ** 2;
  }
  // Bilinear in phase (wrapping around the cell) to avoid bin edges.
  for (let j = 0; j < H; j++) {
    for (let k = 0; k < W; k++) {
      const [a, b] = phase(k, j);
      const fa = a * n - 0.5;
      const fb = b * n - 0.5;
      const a0 = Math.floor(fa);
      const b0 = Math.floor(fb);
      const ta = fa - a0;
      const tb = fb - b0;
      const at = (bb, aa) => gain[(((bb % n) + n) % n) * n + (((aa % n) + n) % n)];
      const gv = (at(b0, a0) * (1 - ta) + at(b0, a0 + 1) * ta) * (1 - tb) + (at(b0 + 1, a0) * (1 - ta) + at(b0 + 1, a0 + 1) * ta) * tb;
      if (gv > 0) sharpY[j * W + k] /= gv;
    }
  }
  return Math.sqrt(var2 / (n * n));
}

// Vignetting correction for a whole view at aperture offset (u, v):
// [r, g, b] gains, bilinear between the table's bins (first tile).
export function vignettingGainAt(vg, u, v) {
  const n = vg.bins;
  const fx = ((u / vg.rMax + 1) / 2) * n - 0.5;
  const fy = ((v / vg.rMax + 1) / 2) * n - 0.5;
  const x0 = Math.max(0, Math.min(n - 2, Math.floor(fx)));
  const y0 = Math.max(0, Math.min(n - 2, Math.floor(fy)));
  const ax = Math.max(0, Math.min(1, fx - x0));
  const ay = Math.max(0, Math.min(1, fy - y0));
  return [0, 1, 2].map((ch) => {
    const at = (x, y) => vg.gain[(y * n + x) * 3 + ch] || 0;
    return (at(x0, y0) * (1 - ax) + at(x0 + 1, y0) * ax) * (1 - ay) + (at(x0, y0 + 1) * (1 - ax) + at(x0 + 1, y0 + 1) * ax) * ay;
  });
}
