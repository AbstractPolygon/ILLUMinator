// Depth from the light field: for a range of refocus depths (alpha), shift
// every view as refocusing would and measure how well they agree. At the
// right depth all views see the same scene point, so their spread (angular
// variance) is smallest. Unlike measuring sharpness this does not produce
// halos at object edges. The result is the per-pixel refocus parameter that
// brings that pixel into focus, which the high quality renderer uses to keep
// every depth sharp.

export function luminance(rgb, n = rgb.length / 3) {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = 0.2126 * rgb[3 * i] + 0.7152 * rgb[3 * i + 1] + 0.0722 * rgb[3 * i + 2];
  return out;
}

// Box filter (sum over a (2r+1)^2 window) via a summed area table.
function boxSum(src, w, h, r) {
  const sat = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += src[y * w + x];
      sat[(y + 1) * (w + 1) + x + 1] = sat[y * (w + 1) + x + 1] + row;
    }
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(w, x + r + 1);
      const s = sat[y1 * (w + 1) + x1] - sat[y0 * (w + 1) + x1] - sat[y1 * (w + 1) + x0] + sat[y0 * (w + 1) + x0];
      out[y * w + x] = s / ((x1 - x0) * (y1 - y0));
    }
  }
  return out;
}

// Guided filter (He et al.): smooths `p` like a box filter of radius r, but
// only within regions that look alike in `guide` (0..1), so costs do not
// bleed across the photo's edges.
function guidedFilter(guide, p, w, h, r, eps) {
  const n = w * h;
  const ip = new Float32Array(n);
  const ii = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    ip[i] = guide[i] * p[i];
    ii[i] = guide[i] * guide[i];
  }
  const mI = boxSum(guide, w, h, r);
  const mP = boxSum(p, w, h, r);
  const mIP = boxSum(ip, w, h, r);
  const mII = boxSum(ii, w, h, r);
  const a = new Float32Array(n);
  const b = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const v = mII[i] - mI[i] * mI[i];
    a[i] = (mIP[i] - mI[i] * mP[i]) / (v + eps);
    b[i] = mP[i] - a[i] * mI[i];
  }
  const mA = boxSum(a, w, h, r);
  const mB = boxSum(b, w, h, r);
  const out = new Float32Array(n);
  // The filter can overshoot below zero, which would make a wrong depth
  // look like a perfect match; keep each cost near the plain box mean.
  for (let i = 0; i < n; i++) out[i] = Math.max(mA[i] * guide[i] + mB[i], 0.5 * mP[i]);
  return out;
}

// Edge-aware weighted median: each depth becomes the median of its
// neighbourhood, counting neighbours that look like it in the photo more.
// Depth edges snap to the photo's edges and thin halos disappear.
function weightedMedian(alpha, guide, w, h, r = 4, sigma = 0.06, levels = 96) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const a of alpha) {
    if (a < lo) lo = a;
    if (a > hi) hi = a;
  }
  if (!(hi > lo)) return alpha;
  const q = new Uint16Array(alpha.length);
  for (let i = 0; i < q.length; i++) q[i] = Math.min(levels - 1, Math.floor(((alpha[i] - lo) / (hi - lo)) * levels));
  const lut = new Float32Array(256);
  for (let d = 0; d < 256; d++) lut[d] = Math.exp(-((d / 255) ** 2) / (2 * sigma * sigma));
  const hist = new Float32Array(levels);
  const out = new Float32Array(alpha.length);
  const g8 = new Uint8Array(guide.length);
  for (let i = 0; i < g8.length; i++) g8[i] = Math.min(255, Math.max(0, Math.round(guide[i] * 255)));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      hist.fill(0);
      const gi = g8[y * w + x];
      let total = 0;
      for (let dy = -r; dy <= r; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -r; dx <= r; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const j = yy * w + xx;
          const wt = lut[Math.abs(g8[j] - gi)];
          hist[q[j]] += wt;
          total += wt;
        }
      }
      let acc = 0;
      let k = 0;
      while (k < levels - 1 && acc + hist[k] < total / 2) acc += hist[k++];
      // Keep the pixel's own value when it is already in the median bin.
      const own = q[y * w + x];
      out[y * w + x] = own === k ? alpha[y * w + x] : lo + ((k + 0.5) / levels) * (hi - lo);
    }
  }
  return out;
}

// Fine detail of a view: brightness minus its local (9x9) average. Views
// from different parts of the lens can differ in overall brightness (lens
// flare veils some more than others); comparing only detail ignores that.
// Returns { detail, local } where local is the local average.
function detailOf(lum, w, h) {
  const local = boxSum(lum, w, h, 4);
  const detail = new Float32Array(lum.length);
  for (let i = 0; i < lum.length; i++) detail[i] = lum[i] - local[i];
  return { detail, local };
}

// (15% of the picture's mean brightness)^2: the smallest brightness the
// depth measures normalize by.
export function brightnessFloor(lum) {
  let s = 0;
  for (let i = 0; i < lum.length; i++) s += lum[i];
  const mean = s / Math.max(1, lum.length);
  return (0.15 * mean) ** 2 + 1e-8;
}

// Mean squared deviation of the shifted views from their mean, per pixel,
// over all views and over each half of the aperture (left, right, top,
// bottom). Near an object's edge only the views on one side see past it, so
// at a depth edge one half agrees far better than all of them together:
// `occlusion` uses the best half there, which keeps foreground objects from
// spreading over the background in the depth map.
function angularVariance(lums, views, w, h, alpha, floor, level, occlusion = true) {
  if (!occlusion) return angularVarianceOf(lums, views, w, h, alpha, floor, level, () => true);
  const full = angularVarianceOf(lums, views, w, h, alpha, floor, level, () => true);
  const halves = [(v) => v.u <= 0, (v) => v.u >= 0, (v) => v.v <= 0, (v) => v.v >= 0]
    .map((keep) => angularVarianceOf(lums, views, w, h, alpha, floor, level, keep));
  const out = new Float32Array(w * h);
  for (let i = 0; i < out.length; i++) {
    let best = Infinity;
    for (const hv of halves) if (hv[i] < best) best = hv[i];
    // A half has fewer views and so less noise averaging: it wins only when
    // clearly better than the whole aperture.
    out[i] = Math.min(full[i], OCCLUSION_MARGIN * best);
  }
  return out;
}

const OCCLUSION_MARGIN = 1.6;

function angularVarianceOf(lums, views, w, h, alpha, floor, level, keep) {
  const sum = new Float32Array(w * h);
  const sq = new Float32Array(w * h);
  const cnt = new Float32Array(w * h);
  views.forEach((view, k) => {
    if (!keep(view)) return;
    const lum = lums[k];
    const sx = alpha * view.u * view.detail;
    const sy = alpha * view.v * view.detail;
    const ix = Math.floor(sx);
    const iy = Math.floor(sy);
    const ax = sx - ix;
    const ay = sy - iy;
    const x0 = Math.max(0, -ix);
    const x1 = Math.min(w, w - ix - 1);
    const y0 = Math.max(0, -iy);
    const y1 = Math.min(h, h - iy - 1);
    for (let y = y0; y < y1; y++) {
      const src = (y + iy) * w + ix;
      for (let x = x0; x < x1; x++) {
        const s = src + x;
        const v = (lum[s] * (1 - ax) + lum[s + 1] * ax) * (1 - ay) + (lum[s + w] * (1 - ax) + lum[s + w + 1] * ax) * ay;
        const d = y * w + x;
        sum[d] += v;
        sq[d] += v * v;
        cnt[d]++;
      }
    }
  });
  const out = new Float32Array(w * h);
  for (let i = 0; i < out.length; i++) {
    const n = cnt[i] || 1;
    const m = sum[i] / n;
    // Relative to local brightness so dark and bright regions are judged
    // alike, but not below `floor`: in dark areas that amplifies noise.
    out[i] = Math.max(0, sq[i] / n - m * m) / (level[i] * level[i] + floor);
  }
  return out;
}

// Confidence-weighted Gaussian-ish smoothing (three box passes) that fills
// textureless regions from their reliable neighbours.
function fillSmooth(values, conf, w, h, r) {
  let num = new Float32Array(w * h);
  let den = new Float32Array(w * h);
  for (let i = 0; i < num.length; i++) {
    num[i] = values[i] * conf[i];
    den[i] = conf[i];
  }
  for (let pass = 0; pass < 3; pass++) {
    num = boxSum(num, w, h, r);
    den = boxSum(den, w, h, r);
  }
  const out = new Float32Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = den[i] > 1e-6 ? num[i] / den[i] : 0;
  return out;
}

// 5x5 median: removes isolated speckles of wrong depth.
function median5(src, w, h) {
  const out = new Float32Array(src.length);
  const win = new Float32Array(25);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let k = 0;
      for (let dy = -2; dy <= 2; dy++) {
        const yy = Math.min(h - 1, Math.max(0, y + dy));
        for (let dx = -2; dx <= 2; dx++) win[k++] = src[yy * w + Math.min(w - 1, Math.max(0, x + dx))];
      }
      win.sort();
      out[y * w + x] = win[12];
    }
  }
  return out;
}

// Replaces blobs that disagree strongly with their wider neighborhood (a
// confidence-weighted smooth reference): depth edges between real objects
// differ far less than these failures, which jump to the ends of the range.
function removeOutliers(alpha, confidence, w, h, threshold = 0.45) {
  const reference = fillSmooth(alpha, confidence.map((c) => c + 1e-3), w, h, 10);
  const out = new Float32Array(alpha);
  for (let i = 0; i < out.length; i++) {
    if (Math.abs(out[i] - reference[i]) > threshold) out[i] = reference[i];
  }
  return out;
}

// The trial depths and cost window of the depth measurement.
export const DEPTH_SEARCH = { min: -1.6, max: 1.6, steps: 33, window: 3 };

// The photo's brightness (square root, 0..1) from the center view's
// luminance: guides the edge-aware steps.
export function depthGuide(center) {
  const n = center.length;
  const guide = new Float32Array(n);
  let gmax = 1e-9;
  for (let i = 0; i < n; i++) {
    guide[i] = Math.sqrt(Math.max(0, center[i]));
    if (guide[i] > gmax) gmax = guide[i];
  }
  for (let i = 0; i < n; i++) guide[i] /= gmax;
  return guide;
}

// views: [{ u, v, rgb, gain, detail }] as used by refocus().
// Returns { alpha: Float32Array (per pixel), confidence: Float32Array }.
// Options: occlusion (best half of the aperture at depth edges), guided
// (edge-aware cost aggregation) and refine (edge-aware weighted median),
// all on by default.
export function estimateDepth(views, width, height, { min = DEPTH_SEARCH.min, max = DEPTH_SEARCH.max, steps = DEPTH_SEARCH.steps, window = DEPTH_SEARCH.window, onProgress, ...opts } = {}) {
  const { occlusion = true, guided = true, refine = true } = opts;
  const n = width * height;
  const alphas = Array.from({ length: steps }, (_, i) => min + ((max - min) * i) / (steps - 1));
  const raw = views.map((v) => luminance(v.rgb, n).map((x) => x * v.gain));
  const center = raw[Math.floor(raw.length / 2)];
  const minLevel = brightnessFloor(center);
  const level = detailOf(center, width, height).local;
  const lums = raw.map((l) => detailOf(l, width, height).detail);
  const guide = depthGuide(center);
  // Higher score = better agreement.
  const scores = alphas.map((a, k) => {
    if (onProgress) onProgress(k / steps);
    const variance = angularVariance(lums, views, width, height, a, minLevel, level, occlusion);
    const cost = guided ? guidedFilter(guide, variance, width, height, window + 1, 1e-3) : boxSum(variance, width, height, window);
    for (let i = 0; i < n; i++) cost[i] = -cost[i];
    return cost;
  });
  const alpha = new Float32Array(n);
  const confidence = new Float32Array(n);
  const meanCost = new Float32Array(n);
  const step = alphas[1] - alphas[0];
  for (let i = 0; i < n; i++) {
    let best = 0;
    let sum = 0;
    for (let k = 0; k < steps; k++) {
      sum -= scores[k][i];
      if (scores[k][i] > scores[best][i]) best = k;
    }
    meanCost[i] = sum / steps;
    // Parabolic fit around the peak for sub-step precision.
    let offset = 0;
    if (best > 0 && best < steps - 1) {
      const a = scores[best - 1][i];
      const b = scores[best][i];
      const c = scores[best + 1][i];
      const d = a - 2 * b + c;
      if (d < 0) offset = Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / d));
    }
    alpha[i] = alphas[best] + offset * step;
    confidence[i] = -scores[best][i];
  }
  if (onProgress) onProgress(1);
  return finishDepth({ alpha, cost: confidence, meanCost }, width, height, guide, { refine, min, max });
}

// The finishing steps of the depth measurement, from the best trial depth
// per pixel (`alpha`), its cost and the mean cost over the trial depths
// (measured here or on the GPU): confidence, filling in, outlier removal.
export function finishDepth({ alpha, cost, meanCost }, width, height, guide, { refine = true, min = DEPTH_SEARCH.min, max = DEPTH_SEARCH.max } = {}) {
  const n = width * height;
  const confidence = Float32Array.from(cost);
  // A pronounced minimum is trustworthy; in blank regions every depth looks
  // alike apart from sensor noise. The median cost stands in for the noise
  // floor, so only differences well above it count.
  const floor = Float32Array.from(meanCost).sort()[n >> 1];
  for (let i = 0; i < n; i++) {
    const gain = Math.max(0, meanCost[i] - confidence[i]);
    confidence[i] = (gain / (meanCost[i] + floor)) ** 2;
  }
  // Keep confident estimates; fill the rest from confident neighbours.
  const smooth = fillSmooth(alpha, confidence, width, height, 2);
  for (let i = 0; i < n; i++) {
    const c = Math.min(1, confidence[i] * 4);
    alpha[i] = c * alpha[i] + (1 - c) * smooth[i];
  }
  const cleaned = removeOutliers(median5(alpha, width, height), confidence, width, height);
  const result = refine ? weightedMedian(cleaned, guide, width, height) : fillSmooth(cleaned, new Float32Array(n).fill(1), width, height, 1);
  return { alpha: result, confidence, range: [min, max] };
}

// Focus value that makes the neighborhood of (x, y) sharpest, measured
// directly in a small window around the point (more faithful to the exact
// spot than the smoothed depth map). Returns { alpha, confidence }.
// `floor`: brightnessFloor() of the whole center view, when `views` hold
// only part of the picture.
export function focusAtPoint(views, width, height, x, y, { min = -1.2, max = 1.2, step = 0.025, radius = 5, floor = null } = {}) {
  const n = width * height;
  const raw = views.map((v) => luminance(v.rgb, n).map((l) => l * v.gain));
  const center = raw[Math.floor(raw.length / 2)];
  floor ??= brightnessFloor(center);
  const level = detailOf(center, width, height).local;
  const lums = raw.map((l) => detailOf(l, width, height).detail);
  const cx = Math.round(x);
  const cy = Math.round(y);
  const costs = [];
  const alphas = [];
  for (let a = min; a <= max + 1e-9; a += step) {
    let cost = 0;
    let count = 0;
    for (let yy = cy - radius; yy <= cy + radius; yy++) {
      for (let xx = cx - radius; xx <= cx + radius; xx++) {
        let sum = 0;
        let sq = 0;
        let m = 0;
        for (let k = 0; k < views.length; k++) {
          const view = views[k];
          const sx = xx + a * view.u * view.detail;
          const sy = yy + a * view.v * view.detail;
          const ix = Math.floor(sx);
          const iy = Math.floor(sy);
          if (ix < 0 || iy < 0 || ix >= width - 1 || iy >= height - 1) continue;
          const ax = sx - ix;
          const ay = sy - iy;
          const lum = lums[k];
          const p = iy * width + ix;
          const val = (lum[p] * (1 - ax) + lum[p + 1] * ax) * (1 - ay) + (lum[p + width] * (1 - ax) + lum[p + width + 1] * ax) * ay;
          sum += val;
          sq += val * val;
          m++;
        }
        if (m < 2) continue;
        const mean = sum / m;
        const lv = level[Math.max(0, Math.min(height - 1, yy)) * width + Math.max(0, Math.min(width - 1, xx))];
        cost += Math.max(0, sq / m - mean * mean) / (lv * lv + floor);
        count++;
      }
    }
    costs.push(count ? cost / count : Infinity);
    alphas.push(a);
  }
  let best = 0;
  for (let k = 1; k < costs.length; k++) if (costs[k] < costs[best]) best = k;
  let offset = 0;
  if (best > 0 && best < costs.length - 1) {
    const [a, b, c] = [costs[best - 1], costs[best], costs[best + 1]];
    const d = a - 2 * b + c;
    if (d > 0) offset = Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / d));
  }
  const finite = costs.filter(Number.isFinite);
  const mean = finite.reduce((s, c) => s + c, 0) / Math.max(1, finite.length);
  return { alpha: alphas[best] + offset * step, confidence: mean > 0 ? (mean - costs[best]) / mean : 0 };
}

// Edge-aware depth smoothing (a joint bilateral filter): each depth value
// becomes a weighted average of its neighbors, where neighbors that look
// different in the photo (`guide`, linear RGB at the depth map's size)
// count for little. Rough patches inside a surface even out while depth
// edges stay on the photo's edges. `confidence` (0..1 per pixel, optional)
// lets well-measured values outweigh guesses. `amount` 0..1 sets how far
// the smoothing reaches (repeated 5 x 5 passes). Returns a new array.
export function smoothDepth(alpha, width, height, guide, { amount = 0.3, confidence = null } = {}) {
  const passes = Math.round(amount * 8);
  if (passes <= 0) return alpha;
  const n = width * height;
  // Guide brightness in a square-root space, so dark and bright areas
  // separate edges alike.
  const g = new Float32Array(n);
  let mean = 0;
  for (let i = 0; i < n; i++) {
    g[i] = Math.sqrt(Math.max(0, 0.2126 * guide[3 * i] + 0.7152 * guide[3 * i + 1] + 0.0722 * guide[3 * i + 2]));
    mean += g[i];
  }
  mean = Math.max(1e-6, mean / n);
  const kRange = -0.5 / (0.08 * mean) ** 2;
  const kSpace = -0.5 / (1.2 * 1.2);
  const conf = confidence || null;
  let src = Float32Array.from(alpha);
  let dst = new Float32Array(n);
  for (let pass = 0; pass < passes; pass++) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        const gi = g[i];
        let sum = 0;
        let wsum = 0;
        for (let dy = -2; dy <= 2; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= height) continue;
          for (let dx = -2; dx <= 2; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= width) continue;
            const j = yy * width + xx;
            const d = g[j] - gi;
            let w = Math.exp(kSpace * (dx * dx + dy * dy) + kRange * d * d);
            if (conf) w *= 0.15 + conf[j];
            sum += src[j] * w;
            wsum += w;
          }
        }
        dst[i] = wsum > 0 ? sum / wsum : src[i];
      }
    }
    [src, dst] = [dst, src];
  }
  return src;
}
