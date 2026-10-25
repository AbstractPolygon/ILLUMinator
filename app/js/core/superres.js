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

import { lensWarp } from './lens.js';
import { lensRange, lensCenter } from './lenslet.js';
import { LAMBDA_TO_ALPHA } from './recipe.js';

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
function forEachLensPixel(g, cam, radius, fn, onProgress, lensStride = 1, win = null) {
  const { width, height } = cam;
  const range = lensRange(g, width, height, g.pitch);
  // `win`: only the lenses of this range (rows r0..r1, columns c0..c1).
  const r0 = win ? Math.max(range.r0, win.r0) : range.r0;
  const r1 = win ? Math.min(range.r1, win.r1) : range.r1;
  const c0 = win ? Math.max(range.c0, win.c0) : range.c0;
  const c1 = win ? Math.min(range.c1, win.c1) : range.c1;
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

export const VIGNETTING = { floor: 0.3 };

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
        // Bins darker than this share of their lens center are lens borders: unusable.
        gain[k] = mean[k] > center * VIGNETTING.floor ? ref[ch] / mean[k] : 0;
      }
    }
  }
  return { tilesX, tilesY, width, height, bins: BINS, rMax, gain };
}

// Bright single-pixel defects (hot pixels) and dead pixels: compare with the
// four nearest pixels of the same color.
export function isDefect(raw, width, i) {
  const v = raw[i];
  const m = (raw[i - 2] + raw[i + 2] + raw[i - 2 * width] + raw[i + 2 * width]) * 0.25;
  return v > m * 3 + 40 || (v < m * 0.2 && m > 100);
}

// Depth sampled between texels, but without inventing depths that are not
// there: where the four neighbors differ by more than `tol` (an edge between
// two surfaces) the nearest texel is taken, so a ray meets one surface or the
// other instead of a made-up depth in between. Lytro Desktop's depth maps are
// flat with one pixel steps at edges (95-99% of neighbors equal, almost no
// in-between values), and bilinear sampling turned each step into a ramp
// whose rays landed in a dotted pattern along the edge.
export const DEPTH_STEP_TOLERANCE = 0.12;
export function sampleDepth(img, w, h, x, y) {
  const fx = Math.min(w - 1.001, Math.max(0, x));
  const fy = Math.min(h - 1.001, Math.max(0, y));
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const q = y0 * w + x0;
  const a = img[q];
  const b = img[q + 1];
  const c = img[q + w];
  const d = img[q + w + 1];
  const lo = Math.min(a, b, c, d);
  const hi = Math.max(a, b, c, d);
  if (hi - lo > DEPTH_STEP_TOLERANCE) {
    const ax = fx - x0;
    const ay = fy - y0;
    return ay < 0.5 ? (ax < 0.5 ? a : b) : ax < 0.5 ? c : d;
  }
  const ax = fx - x0;
  const ay = fy - y0;
  return (a * (1 - ax) + b * ax) * (1 - ay) + (c * (1 - ax) + d * ax) * ay;
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
//            base, baseW, baseH, depth, sigma, aperture, passes, onProgress }
// `passes` (0 = off) adds iterative back-projection: each pass predicts every
// raw sample's brightness from the current result, and splats the
// differences back, recovering detail a single splat smooths away.
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
// Output size and splat settings of a full resolution render (shared with
// the GPU version in gpu/renderer.js).
export function superResParams(sampler, { scale = 3, apertureSigma = Infinity, sigma, aperture } = {}) {
  // At higher output scales there are fewer samples per output pixel; wider
  // splats keep them covering evenly.
  sigma ??= 0.6 * Math.max(1, scale / 3);
  // 0.45 of each lens disc: measured against Lytro Desktop's pictures, much
  // more of the fine detail they show than 0.36 (a third of the detail
  // energy gone at 0.36 on the wall photo) and less noise; the price is a
  // faint dotted pattern with the lens spacing on smooth surfaces, which
  // the lattice and edge smoothing steps hold down.
  aperture ??= 0.45;
  const { grid: g, outW, outH, detail } = sampler;
  const rUse = g.pitch * aperture;
  return {
    W: Math.floor((outW / detail) * scale),
    H: Math.floor((outH / detail) * scale),
    scale,
    sigma,
    rUse,
    // A narrowed aperture spreads each lens's samples over less.
    spreadRadius: Number.isFinite(apertureSigma) ? Math.min(rUse, 2 * apertureSigma) : rUse,
    reach: Math.ceil(1.5 * sigma),
    unit: g.rowStep,
    xMin: sampler.xMin,
    yMin: sampler.yMin,
    detail,
  };
}

export function renderSuperRes(raw, cam, dev, sampler, options) {
  const {
    alpha = 0, allInFocus = false, u0 = 0, v0 = 0, apertureSigma = Infinity, scale = 3, vignetting: vg, base, depth,
    depthTolerance = 0.12, onProgress, passes = 0, calibrate = false, lens = null, rayWarp = null,
  } = options;
  let lensOffsets = options.lensOffsets || null;
  // The depth map the rays follow (edge snapping tries others).
  let rayDepth = depth;
  let tapMap = null;
  let tapFor = null;
  let flagMap = null;
  let flagFor = null;
  const inv2a2 = Number.isFinite(apertureSigma) ? 1 / (2 * apertureSigma * apertureSigma) : 0;
  const { W, H, sigma, rUse, spreadRadius, reach, unit, xMin, yMin, detail } = superResParams(sampler, { scale, apertureSigma, sigma: options.sigma, aperture: options.aperture });
  const { grid: g } = sampler;
  const { width, height } = cam;
  // The lens distortion is corrected where each ray lands, before the rays
  // are combined (see core/lens.js lensWarp), so the picture comes out
  // corrected without resampling it.
  const warp = lensWarp(lens, W, H);
  // Where a position in the uncorrected picture is in the corrected one.
  const landing = (x, y) => (warp ? warp.forward(x + 0.5, y + 0.5).map((q) => q - 0.5) : [x, y]);
  const bw = options.baseW;
  const bh = options.baseH;
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
    for (let k = 0; k < W; k++) {
      // The place in the uncorrected picture that this pixel shows.
      const [sx, sy] = warp ? warp.source(k + 0.5, j + 0.5) : [k + 0.5, j + 0.5];
      const by = Math.min(bh - 1.001, Math.max(0, (sy / scale) * detail - 0.5));
      const y0 = Math.floor(by);
      const ay = by - y0;
      const bx = Math.min(bw - 1.001, Math.max(0, (sx / scale) * detail - 0.5));
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
      let local = alpha;
      if (depth) {
        const q = y0 * bw + x0;
        const d = (depth[q] * (1 - ax) + depth[q + 1] * ax) * (1 - ay) + (depth[q + bw] * (1 - ax) + depth[q + bw + 1] * ax) * ay;
        if (allInFocus) {
          local = d;
        } else {
          const e = (d - alpha) / depthTolerance;
          inFocus = Math.exp(-e * e);
        }
      }
      // Near the depth the camera focused at, every pixel under a lens lands
      // on almost the same spot: there is no detail between the lenses to
      // recover, and the splats pile up in a hexagonal pattern. Detail is
      // only used where one lens's samples spread far enough to interleave
      // with its neighbours'.
      focus[p] = inFocus * coverage(Math.abs(local) * spreadRadius);
    }
  }

  // One splat of every raw pixel; with `estimate`, each sample contributes
  // its difference from the estimate at its position instead (a residual).
  const gpuParams = (estimate) => ({
    W, H, scale, sigma, reach, rUse, alpha, allInFocus, u0, v0, apertureSigma, vignetting: vg,
    xMin, yMin, unit, detail, base, baseW: bw, baseH: bh, depth, estimate, lensOffsets, lens, rayWarp,
  });
  const totalSteps = 1 + passes;
  const splat = (estimate, step) => {
    const progress = onProgress ? (p) => onProgress((step + p) / totalSteps) : undefined;
    if (options.gpuSplat) {
      // The same accumulation on the GPU: one point per raw pixel.
      const r = options.gpuSplat(gpuParams(estimate));
      if (progress) progress(1);
      return r;
    }
    return splatOnCpu(estimate, progress);
  };
  if (options.probeFocus) return probeFocusOffset();

  // How far the depth map is from where the rays meet (see
  // estimateFocusOffset): the rays from the middle of the sensor are splatted
  // with the depth shifted by each candidate (in lambda), and the offset
  // where they agree best is taken (a parabola through the best three).
  function probeFocusOffset() {
    const { lambdaToAlpha, candidates } = options.probeFocus;
    const range = lensRange(g, cam.width, cam.height, g.pitch);
    const rm = (range.r0 + range.r1) / 2;
    const cm = (range.c0 + range.c1) / 2;
    const dr = (range.r1 - range.r0) / 4;
    const dc = (range.c1 - range.c0) / 4;
    const win = { r0: Math.floor(rm - dr), r1: Math.ceil(rm + dr), c0: Math.floor(cm - dc), c1: Math.ceil(cm + dc) };
    // How well the rays landing on each pixel of the middle of the picture
    // agree, averaged (as in the focus sweeps this was tuned against, with
    // every ray of the lenses in the window: fewer rays make the spread look
    // smaller whatever the focus).
    const y0 = Math.floor(H * 0.35);
    const y1 = Math.floor(H * 0.65);
    const x0 = Math.floor(W * 0.35);
    const x1 = Math.floor(W * 0.65);
    // Only where the depth is flat around: at a depth edge the rays come
    // from two surfaces whatever the focus.
    const dHigh = depthFilter(depth, bw, bh, 4, Math.max);
    const dLow = depthFilter(depth, bw, bh, 4, Math.min);
    const flat = new Uint8Array(W * H);
    for (let y = y0; y < y1; y++) {
      const by = Math.min(bh - 1, Math.max(0, Math.floor(((y + 0.5) / scale) * detail)));
      for (let x = x0; x < x1; x++) {
        const bx = Math.min(bw - 1, Math.max(0, Math.floor(((x + 0.5) / scale) * detail)));
        flat[y * W + x] = dHigh[by * bw + bx] - dLow[by * bw + bx] < 0.02 ? 1 : 0;
      }
    }
    const metrics = candidates.map((cand) => {
      rayDepth = Float32Array.from(depth, (x) => x + cand * lambdaToAlpha);
      const dis = rayDisagreement(
        options.gpuSplat
          ? options.gpuSplat({ ...gpuParams(null), rayDepth, squares: true })
          : splatOnCpu(null, null, null, true, win, 1),
        W, H,
      );
      let sum = 0;
      let n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const q = y * W + x;
          if (flat[q] && upY[q] > 0.02 && dis[q] < 9) {
            sum += dis[q];
            n++;
          }
        }
      }
      return n ? sum / n : Infinity;
    });
    rayDepth = depth;
    let best = 0;
    metrics.forEach((m, i) => {
      if (m < metrics[best]) best = i;
    });
    // No minimum among the candidates (the best is at an end): there is no
    // evidence for a shift, so none is made.
    let focusOffset = 0;
    // A real minimum is clearly deeper than the scatter of the others: on a
    // flat curve (every candidate within 4% of the best) the position of the
    // minimum is noise, so there is no shift.
    const worst = Math.max(...metrics.filter(Number.isFinite));
    const clear = worst - metrics[best] >= 0.04 * metrics[best];
    if (clear && best > 0 && best < candidates.length - 1) {
      focusOffset = candidates[best];
      const [a, b, c] = [metrics[best - 1], metrics[best], metrics[best + 1]];
      const denom = a - 2 * b + c;
      if (denom > 0) {
        const step = candidates[best] - candidates[best - 1];
        focusOffset = Math.min(candidates[best + 1], Math.max(candidates[best - 1], candidates[best] - (step * (c - a)) / (2 * denom)));
      }
    }
    return { focusOffset, metrics };
  }

  const { accY, wsum } = splat(null, 0);

  // The depth at every output pixel, for the depth `rayDepth` (rebuilt when
  // edge snapping switches it).
  function tapDepthMap() {
    if (tapFor === rayDepth) return tapMap;
    const m = new Float32Array(W * H);
    for (let j = 0; j < H; j++) {
      for (let k = 0; k < W; k++) {
        const [sx, sy] = warp ? warp.source(k + 0.5, j + 0.5) : [k + 0.5, j + 0.5];
        m[j * W + k] = sampleDepth(rayDepth, bw, bh, (sx / scale) * detail - 0.5, (sy / scale) * detail - 0.5);
      }
    }
    tapMap = m;
    tapFor = rayDepth;
    return m;
  }

  // Pixels at depth edges (flagged), for the depth `rayDepth`.
  function edgeFlags() {
    if (flagFor === rayDepth) return flagMap;
    const mask = depthEdgeMask(rayDepth, bw, bh, { step: ROBUST_EDGE.step, radius: ROBUST_EDGE.radius });
    const slot = new Int32Array(W * H).fill(-1);
    const owners = [];
    for (let j = 0; j < H; j++) {
      for (let k = 0; k < W; k++) {
        const [sx, sy] = warp ? warp.source(k + 0.5, j + 0.5) : [k + 0.5, j + 0.5];
        const bx = Math.min(bw - 1, Math.max(0, Math.floor((sx / scale) * detail)));
        const by = Math.min(bh - 1, Math.max(0, Math.floor((sy / scale) * detail)));
        if (mask[by * bw + bx] > 0.5) {
          slot[j * W + k] = owners.length;
          owners.push(j * W + k);
        }
      }
    }
    flagMap = { slot, owners: Int32Array.from(owners) };
    flagFor = rayDepth;
    return flagMap;
  }

  // `probe`: instead of splatting, add up for every lens how far its samples
  // land from `probe.est` with its center moved by each candidate offset.
  // `squares`: also add up the squared samples (accY2), for how well the
  // rays landing on each pixel agree.
  function splatOnCpu(estimate, progress, probe = null, squares = false, win = null, stride = 1) {
    const accY = new Float32Array(W * H);
    const wsum = new Float32Array(W * H);
    const accY2 = squares ? new Float32Array(W * H) : null;
    const inv2s2 = 1 / (2 * sigma * sigma);
    const tapDepth = allInFocus && depth && TAP_DEPTH.on ? tapDepthMap() : null;
    const invTap = 1 / (2 * TAP_DEPTH.sigma * TAP_DEPTH.sigma);
    const robust = allInFocus && depth && ROBUST_EDGE.on && !probe;
    const zMap = robust ? tapDepthMap() : null;
    const flags = robust ? edgeFlags() : null;
    const zTol = ROBUST_EDGE.tol * LAMBDA_TO_ALPHA;
    // A list of up to CAP rays (brightness, weight) for each flagged pixel.
    const CAP = ROBUST_EDGE.capacity;
    const lists = robust ? { buf: new Float32Array(flags.owners.length * CAP * 2), count: new Uint8Array(flags.owners.length) } : null;
    const taps = 2 * reach + 1;
    const wx = new Float32Array(taps);
    const wy = new Float32Array(taps);
    const binScale = vg.bins / (2 * vg.rMax);
    const binsSq = vg.bins * vg.bins;
    let lastLens = NaN;
    let tw = null;
    let lensAlpha = alpha;
    let cell = null;
    const warpOut = [0, 0, 0, 0];
    const centreOut = [0, 0, 0, 0];
    const cosR = Math.cos(g.rotation);
    const sinR = Math.sin(g.rotation);

    forEachLensPixel(g, cam, rUse, (i, x, y, u, v, lensX, lensY) => {
      if (lensX + lensY * 1e6 !== lastLens) {
        lastLens = lensX + lensY * 1e6;
        tw = tileWeights(vg, x, y);
        if (rayWarp && RAY_WARP.on && allInFocus) {
          // This lens's place on the sensor, for the camera's ray correction.
          const cx = x - (cosR * u - sinR * v);
          const cy = y - (sinR * u + cosR * v);
          cell = rayWarp.lens(cx / width - 0.5, cy / height - 0.5);
        }
        if (allInFocus && depth) {
          lensAlpha = sampleDepth(rayDepth, bw, bh, ((lensX - xMin) / unit) * detail, ((lensY - yMin) / unit) * detail);
        }
      }
      const ch = dev.cfa[y & 1][x & 1];
      const bin = Math.floor((v + vg.rMax) * binScale) * vg.bins + Math.floor((u + vg.rMax) * binScale);
      let gain = 0;
      for (const [t, w] of tw) gain += vg.gain[(t * binsSq + bin) * 3 + ch] * w;
      // Saturated pixels carry no reliable brightness; the standard render
      // (with clipped highlights rendered white) fills in there.
      if (!(gain > 0) || raw[i] >= dev.saturated[ch] || isDefect(raw, width, i)) return;
      const lens = lensOffsets || probe ? lensIndex(lensOffsets || probe.table, g, lensX, lensY) : -1;
      if (lensOffsets && lens >= 0) {
        u -= lensOffsets.dx[lens];
        v -= lensOffsets.dy[lens];
      }
      const du = u - u0;
      const dv = v - v0;
      const conf = (1 - (u * u + v * v) / (rUse * rUse)) * (inv2a2 ? Math.exp(-(du * du + dv * dv) * inv2a2) : 1);
      if (conf < 1e-3) return;
      let lx = (lensX - xMin) / unit;
      let ly = (lensY - yMin) / unit;
      let rdu = du;
      let rdv = dv;
      if (cell && rayWarp) {
        // The ray as the camera really made it: where it comes from and which
        // way it goes differ a little from the ideal, more away from the middle.
        rayWarp.fromLens(cell, u / g.pitch, v / g.pitch, warpOut);
        let sx = warpOut[0] * width;
        let sy = warpOut[1] * height;
        if (!RAY_WARP.centre) {
          rayWarp.fromLens(cell, 0, 0, centreOut);
          sx -= centreOut[0] * width;
          sy -= centreOut[1] * height;
        }
        lx += (cosR * sx + sinR * sy) / unit;
        ly += (-sinR * sx + cosR * sy) / unit;
        rdu += (cosR * warpOut[2] + sinR * warpOut[3]) * g.pitch;
        rdv += (-sinR * warpOut[2] + cosR * warpOut[3]) * g.pitch;
      }
      let rayAlpha = lensAlpha;
      if (allInFocus && depth && RAY_MARCH.on) {
        // Every ray takes the depth of the surface it meets, not the one
        // under its lens: at an edge a lens sees both sides (Lytro's
        // extended depth of field projection). Where a ray's depth does not
        // settle it meets two surfaces: the nearer one wins if the ray
        // lands on it, else the farther.
        const at = (a) => sampleDepth(rayDepth, bw, bh, (lx - a * rdu) * detail, (ly - a * rdv) * detail);
        const a1 = at(rayAlpha);
        const a2 = at(a1);
        if (Math.abs(a2 - a1) <= RAY_DEPTH_TOLERANCE) rayAlpha = a2;
        else {
          const near = Math.min(a1, a2);
          rayAlpha = Math.abs(at(near) - near) <= RAY_DEPTH_TOLERANCE ? near : Math.max(a1, a2);
        }
      }
      let ox = (lx - rayAlpha * rdu) * scale;
      let oy = (ly - rayAlpha * rdv) * scale;
      if (warp) [ox, oy] = warp.forward(ox + 0.5, oy + 0.5).map((q) => q - 0.5);
      const px = Math.round(ox);
      const py = Math.round(oy);
      if (px < reach || py < reach || px >= W - reach || py >= H - reach) return;
      // Visibility: a ray from a surface farther than the one the picture
      // shows where it lands is hidden behind it, and would only mix far
      // color into the edge of the near object, lens by lens.
      if (allInFocus && depth && OCCLUSION.on && rayAlpha - sampleDepth(rayDepth, bw, bh, (ox / scale) * detail, (oy / scale) * detail) > OCCLUSION.tol) return;
      // Brightness estimate from this one color sample and the local color.
      const lp = py * W + px;
      const c = up[3 * lp + ch];
      if (!(c > 1e-5)) return;
      const value = Math.max(0, raw[i] - dev.black[ch]) * dev.scale[ch] * gain;
      let yEst = value * Math.min(8, upY[lp] / c);
      if (estimate) yEst -= sampleBilinear(estimate, W, H, ox, oy);
      if (probe) {
        if (lens < 0) return;
        const { cand, est, err } = probe;
        for (let k = 0; k < cand.length; k++) {
          const e = yEst - sampleBilinear(est, W, H, ...landing((lx - rayAlpha * (rdu - cand[k][0])) * scale, (ly - rayAlpha * (rdv - cand[k][1])) * scale));
          err[lens * cand.length + k] += conf * e * e;
        }
        return;
      }
      for (let k = 0; k < taps; k++) {
        const ex = px - reach + k - ox;
        const ey = py - reach + k - oy;
        wx[k] = Math.exp(-ex * ex * inv2s2);
        wy[k] = Math.exp(-ey * ey * inv2s2) * conf;
      }
      for (let j = 0; j < taps; j++) {
        let o = (py - reach + j) * W + px - reach;
        for (let k = 0; k < taps; k++, o++) {
          let w = wx[k] * wy[j];
          if (tapDepth) {
            const dd = tapDepth[o] - rayAlpha;
            w *= Math.exp(-dd * dd * invTap);
          }
          if (zMap) {
            // Not behind the surface this pixel shows.
            if (rayAlpha - zMap[o] > zTol) continue;
            const sl = flags.slot[o];
            if (sl >= 0 && lists.count[sl] < CAP) {
              const q = (sl * CAP + lists.count[sl]++) * 2;
              lists.buf[q] = yEst;
              lists.buf[q + 1] = w;
              continue;
            }
          }
          accY[o] += yEst * w;
          wsum[o] += w;
          if (accY2) accY2[o] += yEst * yEst * w;
        }
      }
    }, progress, stride, win);
    if (lists) reduceRobust(lists, flags.owners, accY, wsum, accY2);
    return { accY, wsum, accY2 };
  }

  // The median step of Lytro's projection for the pixels that kept a list.
  function reduceRobust(lists, owners, accY, wsum, accY2) {
    const { minCount, sigma, cut, capacity: CAP } = ROBUST_EDGE;
    const keys = new Float32Array(CAP);
    for (let sl = 0; sl < owners.length; sl++) {
      const n = lists.count[sl];
      if (!n) continue;
      const o = owners[sl];
      const base = sl * CAP * 2;
      let total = 0;
      for (let i = 0; i < n; i++) total += lists.buf[base + 2 * i + 1];
      let acc = 0;
      let acc2 = 0;
      let kept = 0;
      if (n > minCount) {
        for (let i = 0; i < n; i++) keys[i] = lists.buf[base + 2 * i];
        const sorted = keys.slice(0, n).sort();
        const med = sorted[n >> 1];
        for (let i = 0; i < n; i++) {
          const y = lists.buf[base + 2 * i];
          const d = Math.abs(y - med);
          if (d >= cut) continue;
          const wt = lists.buf[base + 2 * i + 1] * Math.exp(-(d * d) / (2 * sigma * sigma));
          acc += y * wt;
          acc2 += y * y * wt;
          kept += wt;
        }
        if (kept > 0) {
          const f = total / kept;
          acc *= f;
          acc2 *= f;
        }
      }
      if (!(kept > 0)) {
        acc = 0;
        acc2 = 0;
        for (let i = 0; i < n; i++) {
          const y = lists.buf[base + 2 * i];
          const w = lists.buf[base + 2 * i + 1];
          acc += y * w;
          acc2 += y * y * w;
        }
      }
      accY[o] += acc;
      wsum[o] += total;
      if (accY2) accY2[o] += acc2;
    }
  }

  // Normalize, falling back smoothly to the standard render where samples
  // are sparse; match overall brightness to it; keep detail where in focus.
  const lambda = 0.15;
  const sharpY = new Float32Array(W * H);
  let sumUp = 0;
  let sumSharp = 0;
  for (let p = 0; p < W * H; p++) sharpY[p] = (accY[p] + upY[p] * lambda) / (wsum[p] + lambda);
  if (calibrate && !lensOffsets) {
    // Each lens's center, measured from this photo: the offset that brings
    // its samples closest to the picture just made. Then splat again.
    const table = lensTable(g, cam);
    const cand = lensCandidates();
    const err = new Float64Array(table.dx.length * cand.length);
    splatOnCpu(null, null, { table, cand, est: sharpY, err });
    lensOffsets = chooseLensOffsets(table, cand, err);
    const r = splat(null, 0);
    for (let p = 0; p < W * H; p++) sharpY[p] = (r.accY[p] + upY[p] * lambda) / (r.wsum[p] + lambda);
  }
  let bestDis = null;
  if (allInFocus && depth && EDGE_SNAP.on) {
    // Edge snapping: the depth map is coarser than the picture, so at the
    // edge of a near object a pixel can take the wrong surface's depth and
    // render soft or doubled. Each pixel is rendered with the depth map as
    // is and with the nearest and farthest depth around it, and the three
    // are blended by how well the rays landing on the pixel agree.
    const cands = snapCandidates(depth, bw, bh);
    const renders = cands.map((d) => {
      rayDepth = d;
      return splatOnCpu(null, null, null, true);
    });
    rayDepth = depth;
    if (globalThis.__focus) {
      // Debug: how well the rays agree with the depth as is (lower: better focus).
      const dis = rayDisagreement(renders[0], W, H);
      let sum = 0;
      let n = 0;
      for (let y = Math.floor(H / 4); y < Math.floor((3 * H) / 4); y++) {
        for (let x = Math.floor(W / 4); x < Math.floor((3 * W) / 4); x++) {
          const q = y * W + x;
          if (upY[q] > 0.02 && dis[q] < 9) { sum += dis[q]; n++; }
        }
      }
      globalThis.__focus.val = n ? sum / n : NaN;
    }
    bestDis = snapBlend(renders, upY, lambda, W, H, sharpY);
  }
  // Back-projection: correct the result by how far each raw sample is from
  // what the result predicts for it. Damped, so noise is not amplified.
  // The lattice pattern is divided out before each pass too: otherwise the
  // passes, correcting toward samples that carry it, build it up.
  const lattice = { g, xMin, yMin, unit, scale, warp };
  const edgeMask = allInFocus && depth && BACK_PROJECTION_EDGE.on ? depthEdgeMask(depth, bw, bh) : null;
  for (let pass = 0; pass < passes; pass++) {
    removeLatticePattern(sharpY, upY, focus, wsum, W, H, lattice);
    const r = splat(sharpY, pass + 1);
    for (let p = 0; p < W * H; p++) {
      // Where the rays landing on a pixel disagree (a depth edge) their
      // residuals come from two surfaces and would only draw the edge
      // doubled, lens by lens: leave those pixels to the edge handling.
      let keep = bestDis ? 1 - smoothDisagreement(bestDis[p]) : 1;
      if (edgeMask) keep *= 1 - edgeMask[(Math.min(bh - 1, Math.floor(((Math.floor(p / W) + 0.5) / scale) * detail))) * bw + Math.min(bw - 1, Math.floor((((p % W) + 0.5) / scale) * detail))];
      sharpY[p] = Math.max(0, sharpY[p] + (0.8 * keep * r.accY[p]) / (r.wsum[p] + lambda));
    }
  }
  for (let p = 0; p < W * H; p++) {
    sumUp += upY[p];
    sumSharp += sharpY[p];
  }
  const pattern = removeLatticePattern(sharpY, upY, focus, wsum, W, H, lattice);
  if (bestDis) {
    if (globalThis.__disStats) { const a = Float32Array.from(bestDis).sort(); globalThis.__disStats = [0.5, 0.75, 0.9, 0.95, 0.99].map((q) => a[Math.floor(q * (a.length - 1))]); }
    smoothDisagreeing(sharpY, bestDis, W, H, scale);
  }
  sharpenLuma(sharpY, W, H, scale);
  const match = sumSharp > 0 ? sumUp / sumSharp : 1;
  const out = new Float32Array(W * H * 3);
  for (let p = 0; p < W * H; p++) {
    const ratio = upY[p] > 1e-6 ? Math.min(4, (sharpY[p] * match) / upY[p]) : 1;
    const k = focus[p] * ratio + (1 - focus[p]);
    out[3 * p] = up[3 * p] * k;
    out[3 * p + 1] = up[3 * p + 1] * k;
    out[3 * p + 2] = up[3 * p + 2] * k;
  }
  return { width: W, height: H, rgb: out, pattern, lensOffsets, distortionCorrected: !!warp };
}

// Where the rays landing on a pixel disagree (an edge or a surface whose depth
// is uncertain) each lens puts its samples a little off from its neighbors',
// which leaves a dotted pattern with the lens spacing. There the luma is
// blended toward a blur of half a lens spacing, more the more the rays
// disagree; the final sharpening comes after, so the pixels stay crisp.
// Rays hidden behind a nearer surface at the pixel they land on are dropped
// (see the visibility test in renderSuperRes); `tol` in depth units. Off: on
// the turntable and fence photos it did not change the dotted edge pattern.
// The camera's ray correction (core/raywarp.js). `centre`: keep the part of the
// shift that moves the whole view (it is the lens distortion, which the render
// corrects separately), or leave it out.
export const RAY_WARP = { on: true, centre: false };
export const OCCLUSION = { on: false, tol: 0.1 };
// A sample only counts toward the pixels whose depth it matches: the splat
// kernel reaches a few pixels, so without this a ray that met a near wire
// also brightens the background pixels next to the wire (a halo), where
// Lytro's picture has the wire's edge as sharp as its depth map's.
export const TAP_DEPTH = { on: false, sigma: 0.1 };

// Lytro Desktop's EDOF projection (lfe/projection/project_edof_multiview.cpp,
// read from its code): every ray lands on the pixels around where it falls,
// and counts at a pixel only if it is not farther than that pixel's own depth
// by more than a tolerance (`tol`, in focus units like the depth map). At a
// depth edge (the flagged pixels) the rays are not averaged as they come: they
// are kept in a list, and once there are more than `minCount` the median of
// their brightness is found and each ray is weighted by a Gaussian of its
// distance from the median (exp(-(100 d)^2 / 100) with d in units of
// R+2G+B of the normalized color; here `sigma` in brightness units), and
// rays more than `cut` units away are dropped. The weights are then scaled so
// the pixel keeps the total weight it had. A near wire's rays that reach the
// background beside it, and the background's that reach the wire, are the
// odd ones out there and fall away.
export const ROBUST_EDGE = { on: false, tol: 0.25, minCount: 4, sigma: 0.0177, cut: 1.0, radius: 4, step: 0.3, capacity: 40 };
export const RAY_MARCH = { on: true };
export const DITHER_FIX = { on: true, low: 0.06, high: 0.35, sigma: 0.6 };

// Lytro Desktop keeps its filters off a box of `radius` depth pixels around
// every depth step of `step` lambda or more (its depth edge mask).
export const BACK_PROJECTION_EDGE = { on: true, step: 0.3, radius: 4 };

// 1 within `radius` depth pixels of a step between neighbors (right or below)
// of at least `step` lambda, softened by a 3 x 3 mean; 0 elsewhere.
export function depthEdgeMask(depth, w, h, { step = BACK_PROJECTION_EDGE.step, radius = BACK_PROJECTION_EDGE.radius } = {}) {
  const jump = new Float32Array(w * h);
  const limit = step * LAMBDA_TO_ALPHA;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = depth[y * w + x];
      if ((x + 1 < w && Math.abs(d - depth[y * w + x + 1]) >= limit) || (y + 1 < h && Math.abs(d - depth[(y + 1) * w + x]) >= limit)) jump[y * w + x] = 1;
    }
  }
  const box = depthFilter(jump, w, h, radius, Math.max);
  return depthFilter(box, w, h, 1, (a, b) => a + b).map((v) => Math.min(1, v / 9));
}

// 0 where the rays landing on a pixel agree, 1 where they clearly do not.
function smoothDisagreement(dis) {
  const t = Math.min(1, Math.max(0, (dis - DITHER_FIX.low) / (DITHER_FIX.high - DITHER_FIX.low)));
  return t * t * (3 - 2 * t);
}

function smoothDisagreeing(y, dis, W, H, scale) {
  if (!DITHER_FIX.on) return;
  const sigma = DITHER_FIX.sigma * scale;
  const r = Math.ceil(2.5 * sigma);
  const k = new Float32Array(2 * r + 1);
  let ks = 0;
  for (let i = -r; i <= r; i++) ks += (k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma)));
  for (let i = 0; i < k.length; i++) k[i] /= ks;
  const tmp = new Float32Array(W * H);
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      let s = 0;
      for (let d = -r; d <= r; d++) s += k[d + r] * y[j * W + Math.min(W - 1, Math.max(0, i + d))];
      tmp[j * W + i] = s;
    }
  }
  const blur = new Float32Array(W * H);
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      let s = 0;
      for (let d = -r; d <= r; d++) s += k[d + r] * tmp[Math.min(H - 1, Math.max(0, j + d)) * W + i];
      blur[j * W + i] = s;
    }
  }
  const span = DITHER_FIX.high - DITHER_FIX.low;
  for (let p = 0; p < W * H; p++) {
    const t = Math.min(1, Math.max(0, (dis[p] - DITHER_FIX.low) / span));
    const w = t * t * (3 - 2 * t);
    if (w > 0) y[p] += w * (blur[p] - y[p]);
  }
}

// Edge snapping (see renderSuperRes): `radius` in depth map pixels around
// each pixel for the nearest and farthest depth, `smooth` the window (in
// output pixels) over which ray agreement is compared, `margin` how much
// worse than the best a candidate may agree and still count, `keep` the
// extra weight of the depth map as is. On the fence of one test photo this
// removes the doubled outlines and most of the comb-like striping along a
// near wire's edge; on three other photos it changes under 0.05% of pixels.
// `offsets`: depth shifts that could be tried as well (a surface whose depth
// is a little off all through). Off: shifts of +-0.15 and +-0.3 calmed the
// hatching on a smooth near surface but blurred detail everywhere else (the
// middle of the fence photo). The near and far candidates and these number
// SNAP_CANDIDATES in all.
export const EDGE_SNAP = { on: true, radius: 6, smooth: 2, margin: 0.1, keep: 1, offsets: [] };
export const SNAP_CANDIDATES = 3 + EDGE_SNAP.offsets.length;

// The depth maps rendered for edge snapping: as is, nearest and farthest
// around each pixel, then shifted by each of the offsets.
export function snapCandidates(depth, bw, bh) {
  return [
    depth,
    depthFilter(depth, bw, bh, EDGE_SNAP.radius, Math.min),
    depthFilter(depth, bw, bh, EDGE_SNAP.radius, Math.max),
    ...EDGE_SNAP.offsets.map((o) => Float32Array.from(depth, (x) => x + o)),
  ];
}

// Nearest (fn = Math.min) or farthest (Math.max) depth within `r`.
export function depthFilter(depth, w, h, r, fn) {
  const rows = new Float32Array(depth.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let m = depth[y * w + x];
      for (let i = Math.max(0, x - r); i <= Math.min(w - 1, x + r); i++) m = fn(m, depth[y * w + i]);
      rows[y * w + x] = m;
    }
  }
  const out = new Float32Array(depth.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let m = rows[y * w + x];
      for (let j = Math.max(0, y - r); j <= Math.min(h - 1, y + r); j++) m = fn(m, rows[j * w + x]);
      out[y * w + x] = m;
    }
  }
  return out;
}

// How much the rays landing on each pixel disagree (relative variance,
// capped), averaged over the EDGE_SNAP.smooth window.
export function rayDisagreement({ accY, wsum, accY2 }, W, H) {
  const v = new Float32Array(W * H);
  for (let p = 0; p < W * H; p++) {
    const m = wsum[p] > 1e-6 ? accY[p] / wsum[p] : 0;
    v[p] = wsum[p] > 0.5 ? Math.min(10, Math.max(0, accY2[p] / wsum[p] - m * m) / (m * m + 1e-4)) : 10;
  }
  const R = EDGE_SNAP.smooth;
  const out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let s = 0;
      let n = 0;
      for (let j = Math.max(0, y - R); j <= Math.min(H - 1, y + R); j++) {
        for (let i = Math.max(0, x - R); i <= Math.min(W - 1, x + R); i++, n++) s += v[j * W + i];
      }
      out[y * W + x] = s / n;
    }
  }
  return out;
}

// Blends the candidate renders into `out` by how well their rays agree.
function snapBlend(renders, upY, lambda, W, H, out) {
  const dis = renders.map((r) => rayDisagreement(r, W, H));
  const bestDis = new Float32Array(W * H);
  for (let p = 0; p < W * H; p++) {
    let best = Infinity;
    for (const d of dis) best = Math.min(best, d[p]);
    bestDis[p] = best;
    let ws = 0;
    let acc = 0;
    renders.forEach((r, k) => {
      const w = Math.exp(-(dis[k][p] - best) / (EDGE_SNAP.margin * best + 1e-6)) * (k === 0 ? EDGE_SNAP.keep : 1);
      ws += w;
      acc += (w * (r.accY[p] + upY[p] * lambda)) / (r.wsum[p] + lambda);
    });
    out[p] = acc / ws;
  }
  return bestDis;
}

// Per-lens center correction. Lens centers come from the regular grid fitted
// to the whole sensor, but each lens sits slightly off it, differently in
// every camera and with every zoom and focus, so it is measured from each
// photo: every lens tries moving its center by up to LENS_CAL.step * 2 raw
// pixels each way, and keeps the move that brings its samples closest to the
// picture, if that is at least LENS_CAL.gain better. On the fence of one
// test photo, fine detail rose 12% toward Lytro Desktop's.
export const LENS_CAL = { step: 0.15, reach: 2, gain: 0.05 };

export function lensCandidates() {
  const cand = [];
  for (let a = -LENS_CAL.reach; a <= LENS_CAL.reach; a++) {
    for (let b = -LENS_CAL.reach; b <= LENS_CAL.reach; b++) cand.push([a * LENS_CAL.step, b * LENS_CAL.step]);
  }
  return cand;
}

// An empty table of offsets covering every lens on the sensor.
export function lensTable(g, cam) {
  const { r0, r1, c0, c1 } = lensRange(g, cam.width, cam.height, g.pitch);
  const rows = r1 - r0 + 3;
  const cols = c1 - c0 + 3;
  return { r0: r0 - 1, c0: c0 - 1, rows, cols, dx: new Float32Array(rows * cols), dy: new Float32Array(rows * cols) };
}

export function lensIndex(t, g, lensX, lensY) {
  const rr = Math.round(lensY / g.rowStep);
  const r = rr - t.r0;
  const c = Math.round((lensX - (rr & 1) * g.pitch * 0.5) / g.pitch) - t.c0;
  return r >= 0 && c >= 0 && r < t.rows && c < t.cols ? r * t.cols + c : -1;
}

// From each lens's error per candidate offset, its best offset.
export function chooseLensOffsets(table, cand, err) {
  const zero = cand.findIndex(([a, b]) => a === 0 && b === 0);
  for (let i = 0; i < table.dx.length; i++) {
    const base = err[i * cand.length + zero];
    if (!(base > 0)) continue;
    let best = zero;
    for (let k = 0; k < cand.length; k++) if (err[i * cand.length + k] < err[i * cand.length + best]) best = k;
    if (err[i * cand.length + best] < base * (1 - LENS_CAL.gain)) {
      table.dx[i] = cand[best][0];
      table.dy[i] = cand[best][1];
    }
  }
  return table;
}

// How well the samples of neighbouring lenses interleave, from how far one
// lens's samples spread (in lens spacings): 0 below COVER_LOW, 1 above
// COVER_HIGH.
const COVER_LOW = 0.35;

// Final sharpening of the splatted brightness: measured against Lytro
// Desktop's pictures of 11 photos (1400 aligned patches), this brings the
// fine detail 15% closer to theirs. The radius is in view pixels (times the
// output scale).
export const SR_SHARPEN = { radius: 0.6, amount: 0.6 };
export function sharpenLuma(y, W, H, scale) {
  const s = SR_SHARPEN.radius * scale;
  const r = Math.ceil(3 * s);
  const k = new Float32Array(2 * r + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++) sum += k[i + r] = Math.exp(-(i * i) / (2 * s * s));
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  const tmp = new Float32Array(W * H);
  for (let yy = 0; yy < H; yy++) {
    for (let x = 0; x < W; x++) {
      let v = 0;
      for (let i = -r; i <= r; i++) v += k[i + r] * y[yy * W + Math.min(W - 1, Math.max(0, x + i))];
      tmp[yy * W + x] = v;
    }
  }
  for (let x = 0; x < W; x++) {
    for (let yy = 0; yy < H; yy++) {
      let v = 0;
      for (let i = -r; i <= r; i++) v += k[i + r] * tmp[Math.min(H - 1, Math.max(0, yy + i)) * W + x];
      const p = yy * W + x;
      y[p] = Math.max(0, y[p] + SR_SHARPEN.amount * (y[p] - v));
    }
  }
}
// How far (in focus units) a ray's depth may still move after two steps of
// following it to the surface it meets; beyond that it is left out.
export const RAY_DEPTH_TOLERANCE = 0.08;
const COVER_HIGH = 0.9;
export function coverage(spread) {
  const t = Math.min(1, Math.max(0, (spread - COVER_LOW) / (COVER_HIGH - COVER_LOW)));
  return t * t * (3 - 2 * t);
}

export const PHASE_BINS = 16;
// Lattice pattern tiles: about this many lens pitches across; each tile's
// table leans on the whole picture's where it has few samples.
export const LATTICE_TILE_LENSES = 32;
const LATTICE_PRIOR = 24;

// Lattice pattern tiles for a W x H render: { tx, ty } (shared with the GPU).
export function latticeTiles(W, H, { g, unit, scale }) {
  const tile = Math.max(16, Math.round((LATTICE_TILE_LENSES * g.pitch * scale) / unit));
  return { tx: Math.max(1, Math.round(W / tile)), ty: Math.max(1, Math.round(H / tile)) };
}

// Per tile gain tables from per tile, per phase bin sums of the splatted to
// standard brightness ratio and their counts (tx * ty tables of PHASE_BINS
// x PHASE_BINS): each shrunk toward the whole picture's table where it has
// few samples and normalized to a mean of 1, so only the pattern (not a
// tile's brightness) is divided out. Returns { gain, strength } or null
// when there are too few samples.
export function latticeTables(sum, cnt, tx, ty) {
  const nn = PHASE_BINS * PHASE_BINS;
  const gSum = new Float64Array(nn);
  const gCnt = new Float64Array(nn);
  for (let t = 0; t < tx * ty; t++) {
    for (let i = 0; i < nn; i++) {
      gSum[i] += sum[t * nn + i];
      gCnt[i] += cnt[t * nn + i];
    }
  }
  let total = 0;
  let count = 0;
  for (let i = 0; i < nn; i++) {
    total += gSum[i];
    count += gCnt[i];
  }
  if (count < nn * 20) return null;
  const prior = new Float64Array(nn);
  let var2 = 0;
  for (let i = 0; i < nn; i++) {
    prior[i] = gCnt[i] > 0 ? gSum[i] / gCnt[i] / (total / count) : 1;
    var2 += (prior[i] - 1) ** 2;
  }
  const gain = new Float32Array(tx * ty * nn);
  for (let t = 0; t < tx * ty; t++) {
    let tSum = 0;
    let tCnt = 0;
    for (let i = 0; i < nn; i++) {
      tSum += sum[t * nn + i];
      tCnt += cnt[t * nn + i];
    }
    const mean = tCnt > 0 ? tSum / tCnt : 1;
    let gm = 0;
    for (let i = 0; i < nn; i++) {
      const v = (sum[t * nn + i] / mean + prior[i] * LATTICE_PRIOR) / (cnt[t * nn + i] + LATTICE_PRIOR);
      gain[t * nn + i] = v;
      gm += v;
    }
    gm /= nn;
    for (let i = 0; i < nn; i++) gain[t * nn + i] /= gm || 1;
  }
  return { gain, strength: Math.sqrt(var2 / nn) };
}

// The splatted samples' density and brightness vary slightly with position
// inside each lens cell, so the result carries a faint pattern that repeats
// with the lens grid (hexagons or squares, most visible on smooth surfaces).
// It changes with depth across the picture, so it is measured per tile:
// the ratio of splatted to standard brightness at each position within the
// cell (its lattice phase), averaged over each tile, where the scene evens
// out, then divided out (blended between tile centers). Returns the
// pattern's strength (relative standard deviation, whole picture) before
// correction.
function removeLatticePattern(sharpY, upY, focus, wsum, W, H, { g, xMin, yMin, unit, scale, warp }) {
  const n = PHASE_BINS;
  const nn = n * n;
  const { tx, ty } = latticeTiles(W, H, { g, unit, scale });
  const sum = new Float64Array(tx * ty * nn);
  const cnt = new Float64Array(tx * ty * nn);
  const phase = (k, j) => {
    // The lens grid's phase is that of the uncorrected position.
    if (warp) {
      const [sx, sy] = warp.source(k + 0.5, j + 0.5);
      k = sx - 0.5;
      j = sy - 0.5;
    }
    const ly = yMin + (j / scale) * unit;
    const lx = xMin + (k / scale) * unit;
    const fj = ly / g.rowStep;
    const fi = (lx - fj * g.pitch * 0.5) / g.pitch;
    return [fi - Math.floor(fi), fj - Math.floor(fj)];
  };
  for (let j = 0; j < H; j++) {
    const t0 = Math.min(ty - 1, Math.floor((j / H) * ty)) * tx;
    for (let k = 0; k < W; k++) {
      const p = j * W + k;
      if (focus[p] < 0.5 || !(wsum[p] > 0) || !(upY[p] > 1e-4)) continue;
      const [a, b] = phase(k, j);
      const t = (t0 + Math.min(tx - 1, Math.floor((k / W) * tx))) * nn + Math.min(n - 1, Math.floor(b * n)) * n + Math.min(n - 1, Math.floor(a * n));
      sum[t] += sharpY[p] / upY[p];
      cnt[t] += 1;
    }
  }
  const tables = latticeTables(sum, cnt, tx, ty);
  if (!tables) return 0;
  const { gain } = tables;
  // Bilinear in phase (wrapping around the cell) and between tile centers.
  const at = (t, bb, aa) => gain[t * nn + (((bb % n) + n) % n) * n + (((aa % n) + n) % n)];
  for (let j = 0; j < H; j++) {
    const fy = Math.min(ty - 1, Math.max(0, (j / H) * ty - 0.5));
    const y0 = Math.min(ty - 1, Math.floor(fy));
    const y1 = Math.min(ty - 1, y0 + 1);
    const wy = fy - y0;
    for (let k = 0; k < W; k++) {
      const fx = Math.min(tx - 1, Math.max(0, (k / W) * tx - 0.5));
      const x0 = Math.min(tx - 1, Math.floor(fx));
      const x1 = Math.min(tx - 1, x0 + 1);
      const wx = fx - x0;
      const [a, b] = phase(k, j);
      const fa = a * n - 0.5;
      const fb = b * n - 0.5;
      const a0 = Math.floor(fa);
      const b0 = Math.floor(fb);
      const ta = fa - a0;
      const tb = fb - b0;
      const cell = (t) => (at(t, b0, a0) * (1 - ta) + at(t, b0, a0 + 1) * ta) * (1 - tb) + (at(t, b0 + 1, a0) * (1 - ta) + at(t, b0 + 1, a0 + 1) * ta) * tb;
      const gv = (cell(y0 * tx + x0) * (1 - wx) + cell(y0 * tx + x1) * wx) * (1 - wy) + (cell(y1 * tx + x0) * (1 - wx) + cell(y1 * tx + x1) * wx) * wy;
      if (gv > 0) sharpY[j * W + k] /= gv;
    }
  }
  return tables.strength;
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

// Where Lytro's depth map is off from where the rays from the lenses meet,
// in lambda (shift the map by it): Lytro's depth places surfaces a little off,
// by an amount that differs from photo to photo, and rays placed with it land
// slightly out of focus and come out soft. Found from the middle of the
// sensor at a coarse scale in a few seconds.
export function estimateFocusOffset(raw, cam, dev, sampler, { base, baseW, baseH, depth, vignetting, lensOffsets, lambdaToAlpha, gpuSplat, rayWarp = null, candidates = [-0.6, -0.4, -0.2, 0, 0.2, 0.4] }) {
  const r = renderSuperRes(raw, cam, dev, sampler, {
    gpuSplat, rayWarp,
    allInFocus: true, scale: 3, passes: 0, vignetting, base, baseW, baseH, depth, lensOffsets,
    probeFocus: { lambdaToAlpha, candidates },
  });
  return r;
}
