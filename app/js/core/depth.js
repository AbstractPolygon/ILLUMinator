import { segmentDepth, guidedFilterColor } from './segments.js';

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
// `color` (optional, from depthColorGuide): compare neighbours by color
// instead of brightness, so edges between colors of similar brightness hold.
function weightedMedian(alpha, guide, w, h, r = 4, sigma = 0.06, levels = 96, color = null) {
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
  const c8 = color ? Uint8Array.from(color, (v) => Math.min(255, Math.max(0, Math.round(v * 255)))) : null;
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
          let d = Math.abs(g8[j] - gi);
          if (c8) {
            const i3 = 3 * (y * w + x);
            const j3 = 3 * j;
            d = Math.max(Math.abs(c8[j3] - c8[i3]), Math.abs(c8[j3 + 1] - c8[i3 + 1]), Math.abs(c8[j3 + 2] - c8[i3 + 2]));
          }
          const wt = lut[d];
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
function detailOf(lum, w, h, r = DEPTH_SEARCH.detail) {
  const local = boxSum(lum, w, h, r);
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
    out[i] = Math.min(full[i], DEPTH_SEARCH.occlusion * best);
  }
  return out;
}


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

// Edge-aware normalized convolution (domain transform, Gastal and Oliveira
// 2011, recursive filter): spreads `values`, weighted by `conf`, along the
// picture but not across its edges (`guide`, 0..1). `sigmaS` (pixels) sets
// how far values travel, `sigmaR` how strong an edge in `guide` must be to
// stop them. Fills unreliable regions from reliable ones on the same surface.
export function edgeAwareFill(values, conf, guide, w, h, sigmaS, sigmaR, iterations = 3, color = null) {
  const n = w * h;
  const num = new Float32Array(n);
  const den = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    num[i] = values[i] * conf[i];
    den[i] = conf[i];
  }
  // Distance between neighbours in the transformed domain.
  const ratio = sigmaS / sigmaR;
  const dx = new Float32Array(n);
  const dy = new Float32Array(n);
  // Difference between two pixels: in brightness, or the largest of the
  // color channels' differences.
  const diff = color
    ? (i, j) => Math.max(Math.abs(color[3 * i] - color[3 * j]), Math.abs(color[3 * i + 1] - color[3 * j + 1]), Math.abs(color[3 * i + 2] - color[3 * j + 2]))
    : (i, j) => Math.abs(guide[i] - guide[j]);
  for (let y = 0; y < h; y++) {
    for (let x = 1; x < w; x++) dx[y * w + x] = 1 + ratio * diff(y * w + x, y * w + x - 1);
  }
  for (let y = 1; y < h; y++) {
    for (let x = 0; x < w; x++) dy[y * w + x] = 1 + ratio * diff(y * w + x, (y - 1) * w + x);
  }
  const pass = (arr, a, d, step, count, starts) => {
    for (const s0 of starts) {
      for (let k = 1; k < count; k++) {
        const i = s0 + k * step;
        const f = a ** d[i];
        arr[i] += f * (arr[i - step] - arr[i]);
      }
      for (let k = count - 2; k >= 0; k--) {
        const i = s0 + k * step;
        const f = a ** d[i + step];
        arr[i] += f * (arr[i + step] - arr[i]);
      }
    }
  };
  const rows = Array.from({ length: h }, (_, y) => y * w);
  const cols = Array.from({ length: w }, (_, x) => x);
  for (let it = 0; it < iterations; it++) {
    const sigmaH = (sigmaS * Math.sqrt(3) * 2 ** (iterations - it - 1)) / Math.sqrt(4 ** iterations - 1);
    const a = Math.exp(-Math.SQRT2 / sigmaH);
    for (const arr of [num, den]) {
      pass(arr, a, dx, 1, w, rows);
      pass(arr, a, dy, w, h, cols);
    }
  }
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = den[i] > 1e-12 ? num[i] / den[i] : values[i];
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
function removeOutliers(alpha, confidence, w, h, threshold = 0.45, guide = null, color = null, fill = edgeAwareFill) {
  // The reference stays within the photo's edges when it has them, so a
  // replaced value is never a blend of two surfaces.
  const reference = guide
    ? fill(alpha, confidence.map((c) => c + 1e-3), guide, w, h, 12, DEPTH_FILL.edge, 3, color)
    : fillSmooth(alpha, confidence.map((c) => c + 1e-3), w, h, 10);
  const out = new Float32Array(alpha);
  for (let i = 0; i < out.length; i++) {
    if (Math.abs(out[i] - reference[i]) > threshold) out[i] = reference[i];
  }
  return out;
}

// Filling unreliable depths: how far (share of the picture) and how
// strictly within the photo's edges, and how much confidence counts as sure.
export const DEPTH_FILL = { reach: 0.2, edge: 0.12, trust: 2 };

// Region cleanup of high quality depth maps (core/segments.js).
export const DEPTH_REGIONS = { on: true, count: 2500, compactness: 8, strength: 1, colorSigma: 8 };

// View visibility (off unless `on`). Given a first depth, each view is asked
// where it cannot see a pixel because a nearer surface is in the way. The
// first depth is warped into the view (the nearest depth wins where several
// land on one pixel, as in a z-buffer); a pixel is probably hidden when a
// nearer one landed on its spot there. Each pixel then chooses between
// "visible" (cost: how badly the view's color at the warped spot differs
// from the center view's, plus a penalty when something nearer landed there)
// and "hidden" (a fixed cost, higher when nothing nearer landed), and the
// choices are smoothed in a few directions across the picture, less across
// photo edges. The second measurement leaves hidden views out of each
// pixel's match.
export const DEPTH_VIS = { on: false, raw: false, color: 6, clip: 0.35, landed: 0.6, hidden: 0.25, margin: 0.06, smooth: 0.35, sigma: 0.04, rounds: 1 };

export function viewVisibility(raw, views, alpha, guide, w, h, floor, { color, clip, landed, hidden, margin, smooth, sigma }) {
  const n = w * h;
  const centre = Math.floor(raw.length / 2);
  const ref = raw[centre];
  const masks = views.map(() => null);
  views.forEach((view, k) => {
    if (k === centre) return;
    const lum = raw[k];
    const zb = new Float32Array(n).fill(Infinity);
    const target = new Int32Array(n).fill(-1);
    const fx = new Float32Array(n);
    const fy = new Float32Array(n);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const sx = x + alpha[i] * view.u * view.detail;
        const sy = y + alpha[i] * view.v * view.detail;
        fx[i] = sx;
        fy[i] = sy;
        const qx = Math.round(sx);
        const qy = Math.round(sy);
        if (qx < 0 || qy < 0 || qx >= w || qy >= h) continue;
        const q = qy * w + qx;
        target[i] = q;
        if (alpha[i] < zb[q]) zb[q] = alpha[i];
      }
    }
    const c0 = new Float32Array(n);
    const c1 = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const q = target[i];
      let diff = clip;
      let o = 1;
      if (q >= 0) {
        o = zb[q] < alpha[i] - margin ? 1 : 0;
        const sx = fx[i];
        const sy = fy[i];
        const x0 = Math.floor(sx);
        const y0 = Math.floor(sy);
        if (x0 >= 0 && y0 >= 0 && x0 + 1 < w && y0 + 1 < h) {
          const ax = sx - x0;
          const ay = sy - y0;
          const b = y0 * w + x0;
          const v = (lum[b] * (1 - ax) + lum[b + 1] * ax) * (1 - ay) + (lum[b + w] * (1 - ax) + lum[b + w + 1] * ax) * ay;
          diff = Math.min(clip, Math.abs(v - ref[i]) / (0.5 * (v + ref[i]) + Math.sqrt(floor)));
        }
      }
      c0[i] = color * diff + landed * o;
      c1[i] = (1 - o) * landed + hidden;
    }
    masks[k] = smoothBinary(c0, c1, guide, w, h, smooth, sigma);
  });
  return masks;
}

// Two-label smoothing: sums along four directions of the cheapest way to
// reach each label with a cost `smooth` for a change (less across edges).
// Returns 1 where label 0 ("visible") is cheaper.
function smoothBinary(c0, c1, guide, w, h, smooth, sigma) {
  const n = w * h;
  const t0 = new Float32Array(n);
  const t1 = new Float32Array(n);
  for (const [dx, dy] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
    const L0 = new Float32Array(n);
    const L1 = new Float32Array(n);
    for (let yy = 0; yy < h; yy++) {
      const y = dy < 0 ? h - 1 - yy : yy;
      for (let xx = 0; xx < w; xx++) {
        const x = dx < 0 ? w - 1 - xx : xx;
        const i = y * w + x;
        const px = x - dx;
        const py = y - dy;
        if (px < 0 || py < 0 || px >= w || py >= h) {
          L0[i] = c0[i];
          L1[i] = c1[i];
          continue;
        }
        const j = py * w + px;
        const edge = Math.abs(guide[i] - guide[j]);
        const pen = smooth / (1 + (edge / sigma) ** 2);
        const m = Math.min(L0[j], L1[j]);
        L0[i] = c0[i] + Math.min(L0[j], L1[j] + pen) - m;
        L1[i] = c1[i] + Math.min(L1[j], L0[j] + pen) - m;
      }
    }
    for (let i = 0; i < n; i++) {
      t0[i] += L0[i];
      t1[i] += L1[i];
    }
  }
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = t0[i] <= t1[i] ? 1 : 0;
  return out;
}

// Like angularVarianceOf, but a view only counts at the pixels its mask
// marks visible.
function maskedVariance(lums, views, masks, w, h, alpha, floor, level) {
  const sum = new Float32Array(w * h);
  const sq = new Float32Array(w * h);
  const cnt = new Float32Array(w * h);
  views.forEach((view, k) => {
    const lum = lums[k];
    const mask = masks[k];
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
        const d = y * w + x;
        if (mask && !mask[d]) continue;
        const s = src + x;
        const v = (lum[s] * (1 - ax) + lum[s + 1] * ax) * (1 - ay) + (lum[s + w] * (1 - ax) + lum[s + w + 1] * ax) * ay;
        sum[d] += v;
        sq[d] += v * v;
        cnt[d]++;
      }
    }
  });
  const out = new Float32Array(w * h);
  for (let i = 0; i < out.length; i++) {
    const n = cnt[i];
    if (n < 3) {
      out[i] = 1e3;
      continue;
    }
    const m = sum[i] / n;
    out[i] = Math.max(0, sq[i] / n - m * m) / (level[i] * level[i] + floor);
  }
  return out;
}

// Cross-based cost aggregation (off unless `on`): every pixel gets a
// horizontal and vertical "arm" in each direction that runs along pixels of
// a similar color (at most `arm` long, and past `long` only while the color
// stays within the tighter `tau2`); its support region is every pixel
// reached by a vertical arm from a pixel on its horizontal arms. A cost is
// averaged over that region, so a flat object's interior takes its depth from
// the object's textured edges, and never from the other side of the edge.
export const DEPTH_CBCA = { on: false, arm: 24, long: 8, tau: 0.1, tau2: 0.05 };

export function crossArms(color, w, h, { arm = 24, long = 8, tau = 0.1, tau2 = 0.05 } = {}) {
  const n = w * h;
  const left = new Uint8Array(n);
  const right = new Uint8Array(n);
  const up = new Uint8Array(n);
  const down = new Uint8Array(n);
  const diff = (i, j) => Math.max(Math.abs(color[3 * i] - color[3 * j]), Math.abs(color[3 * i + 1] - color[3 * j + 1]), Math.abs(color[3 * i + 2] - color[3 * j + 2]));
  const reach = (i, step, room) => {
    let k = 0;
    while (k < Math.min(arm, room)) {
      const j = i + step * (k + 1);
      const d = diff(i, j);
      const prev = diff(j, i + step * k);
      if (d >= (k + 1 > long ? tau2 : tau) || prev >= tau) break;
      k++;
    }
    return k;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      left[i] = reach(i, -1, x);
      right[i] = reach(i, 1, w - 1 - x);
      up[i] = reach(i, -w, y);
      down[i] = reach(i, w, h - 1 - y);
    }
  }
  return { left, right, up, down, w, h };
}

// Mean of `cost` over each pixel's support region.
export function crossAggregate(cost, arms) {
  const { left, right, up, down, w, h } = arms;
  const n = w * h;
  // Vertical sums over each pixel's own vertical arm (column prefix sums).
  const col = new Float64Array((h + 1) * w);
  for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) col[(y + 1) * w + x] = col[y * w + x] + cost[y * w + x];
  const vs = new Float32Array(n);
  const vc = new Float32Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const a = y - up[i];
      const b = y + down[i] + 1;
      vs[i] = col[b * w + x] - col[a * w + x];
      vc[i] = b - a;
    }
  }
  // Then along each pixel's horizontal arm.
  const out = new Float32Array(n);
  const rowS = new Float64Array(w + 1);
  const rowC = new Float64Array(w + 1);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      rowS[x + 1] = rowS[x] + vs[y * w + x];
      rowC[x + 1] = rowC[x] + vc[y * w + x];
    }
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const a = x - left[i];
      const b = x + right[i] + 1;
      out[i] = (rowS[b] - rowS[a]) / Math.max(1, rowC[b] - rowC[a]);
    }
  }
  return out;
}

// High quality: a second, coarse match on blurred views (local detail over
// `detail` pixels after a `blur` box), used where the fine match is flat.
// Far out-of-focus texture keeps no fine detail, so the fine match finds no
// depth there. Measured against Lytro Desktop's depth maps of 11 photos,
// gross errors fall from 21% to 14% of the picture (a blurred textured wall:
// 97% to 40%). `gain`: how much sharper the coarse match must be; `flat`:
// the fine match counts as flat below this sharpness.
export const DEPTH_COARSE = { on: true, blur: 4, detail: 10, gain: 1.2, flat: 0.5 };

// Sharpness of a match: how far its best cost lies below its mean cost,
// relative to the mean (0: flat, 1: perfect).
const sharpnessOf = (cost, meanCost) => (meanCost > 0 ? (meanCost - cost) / meanCost : 0);

// Takes the coarse match's depth where the fine one is flat and the coarse
// one clearly sharper; the cost is put on the fine match's scale.
export function combineCoarse(fine, coarse) {
  const alpha = Float32Array.from(fine.alpha);
  const cost = Float32Array.from(fine.cost);
  for (let i = 0; i < alpha.length; i++) {
    const f = sharpnessOf(fine.cost[i], fine.meanCost[i]);
    const c = sharpnessOf(coarse.cost[i], coarse.meanCost[i]);
    if (f < DEPTH_COARSE.flat && c > DEPTH_COARSE.gain * f) {
      alpha[i] = coarse.alpha[i];
      cost[i] = fine.meanCost[i] * (1 - c);
    }
  }
  return { alpha, cost, meanCost: fine.meanCost };
}

// The trial depths and cost window of the depth measurement.
export const DEPTH_SEARCH = { min: -1.6, max: 1.6, steps: 33, window: 1, detail: 2, occlusion: 1.6 };

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

// The photo's color (square root per channel, 0..1) from the center view's
// linear RGB: lets the edge-aware steps tell apart colors of similar
// brightness.
export function depthColorGuide(rgb) {
  const out = new Float32Array(rgb.length);
  let m = 1e-9;
  for (let i = 0; i < rgb.length; i++) {
    out[i] = Math.sqrt(Math.max(0, rgb[i]));
    if (out[i] > m) m = out[i];
  }
  for (let i = 0; i < out.length; i++) out[i] /= m;
  return out;
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
  const guide = depthGuide(center);
  const coarse = refine && DEPTH_COARSE.on;
  const arms = DEPTH_CBCA.on ? crossArms(depthColorGuide(Float32Array.from(views[Math.floor(views.length / 2)].rgb, (x) => x * views[Math.floor(views.length / 2)].gain)), width, height, DEPTH_CBCA) : null;
  // Best trial depth per pixel for one set of detail images.
  const match = (lums, level, occl, win, from, span, masks = null) => {
    // Higher score = better agreement.
    const scores = alphas.map((a, k) => {
      if (onProgress) onProgress(from + (span * k) / steps);
      const variance = masks ? maskedVariance(lums, views, masks, width, height, a, minLevel, level) : angularVariance(lums, views, width, height, a, minLevel, level, occl);
      const cost = arms ? crossAggregate(variance, arms) : guided ? guidedFilter(guide, variance, width, height, win + 1, 1e-3) : boxSum(variance, width, height, win);
      for (let i = 0; i < n; i++) cost[i] = -cost[i];
      return cost;
    });
    return bestDepth(scores, alphas, n);
  };
  // With `raw`, views are compared as they are (flat, textureless objects
  // then still tell a right depth from a wrong one) instead of by their
  // local detail.
  const detailImages = DEPTH_VIS.raw ? raw : raw.map((l) => detailOf(l, width, height).detail);
  const centerLocal = DEPTH_VIS.raw ? Float32Array.from(center, (x) => Math.max(x, 0) ** 0.5) : detailOf(center, width, height).local;
  let measured = match(detailImages, centerLocal, occlusion, window, 0, coarse ? 0.6 : 1);
  if (DEPTH_VIS.on) {
    for (let round = 0; round < DEPTH_VIS.rounds; round++) {
      const first = finishDepth(measured, width, height, guide, { refine: true, min, max, color: depthColorGuide(Float32Array.from(views[Math.floor(views.length / 2)].rgb, (x) => x * views[Math.floor(views.length / 2)].gain)) }).alpha;
      const masks = viewVisibility(raw, views, first, guide, width, height, minLevel, DEPTH_VIS);
      measured = match(detailImages, centerLocal, occlusion, window, 0, coarse ? 0.6 : 1, masks);
    }
  }
  if (coarse) {
    const blurred = raw.map((l) => boxSum(l, width, height, DEPTH_COARSE.blur));
    const mid = blurred[Math.floor(blurred.length / 2)];
    const lums = blurred.map((l) => detailOf(l, width, height, DEPTH_COARSE.detail).detail);
    measured = combineCoarse(measured, match(lums, detailOf(mid, width, height, DEPTH_COARSE.detail).local, false, window + 1, 0.6, 0.4));
  }
  if (onProgress) onProgress(1);
  const cv = views[Math.floor(views.length / 2)];
  const color = depthColorGuide(Float32Array.from(cv.rgb, (x) => x * cv.gain));
  return finishDepth(measured, width, height, guide, { refine, min, max, color });
}

// From the scores (higher = better) of each trial depth: the best depth per
// pixel (sub-step by a parabola through the peak), its cost and the mean cost.
function bestDepth(scores, alphas, n) {
  const steps = alphas.length;
  const alpha = new Float32Array(n);
  const cost = new Float32Array(n);
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
    let offset = 0;
    if (best > 0 && best < steps - 1) {
      const a = scores[best - 1][i];
      const b = scores[best][i];
      const c = scores[best + 1][i];
      const d = a - 2 * b + c;
      if (d < 0) offset = Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / d));
    }
    alpha[i] = alphas[best] + offset * step;
    cost[i] = -scores[best][i];
  }
  return { alpha, cost, meanCost };
}

// The finishing steps of the depth measurement, from the best trial depth
// per pixel (`alpha`), its cost and the mean cost over the trial depths
// (measured here or on the GPU): confidence, filling in, outlier removal.
// `median` and `fill`: the edge-aware weighted median and fill to use (the
// GPU's, if given; they need `color`).
export function finishDepth({ alpha, cost, meanCost }, width, height, guide, { refine = true, min = DEPTH_SEARCH.min, max = DEPTH_SEARCH.max, color = null, median = null, fill = null } = {}) {
  const fillOf = fill && color ? (v, c, g, w, h, sigmaS, sigmaR, it, col) => fill(v, c, col, w, h, sigmaS, sigmaR, it) : edgeAwareFill;
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
  // Keep confident estimates; fill the rest from confident parts of the
  // same surface (as far as it reaches, but not across the photo's edges).
  const reach = Math.max(width, height) * DEPTH_FILL.reach;
  const smooth = fillOf(alpha, confidence, guide, width, height, reach, DEPTH_FILL.edge, 3, color);
  for (let i = 0; i < n; i++) {
    const c = Math.min(1, confidence[i] * DEPTH_FILL.trust);
    alpha[i] = c * alpha[i] + (1 - c) * smooth[i];
  }
  const cleaned = removeOutliers(median5(alpha, width, height), confidence, width, height, 0.45, guide, color, fillOf);
  let result = refine ? (median && color ? median(cleaned, color, width, height, 4, 0.06, 96) : weightedMedian(cleaned, guide, width, height, 4, 0.06, 96, color)) : fillSmooth(cleaned, new Float32Array(n).fill(1), width, height, 1);
  // High quality: region cleanup (core/segments.js).
  const flat = !!(refine && color && DEPTH_REGIONS.on);
  if (flat) result = segmentDepth(result, confidence, color, width, height, DEPTH_REGIONS);
  // Normal quality: no region cleanup, but the edges still follow the picture's.
  else if (color && DEPTH_REGIONS.guide !== false) result = guidedFilterColor(result, color, width, height);
  return { alpha: result, confidence, range: [min, max], flat };
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

// Steps in the depth map (in focus units) that smoothing leaves alone: a
// neighbor that far off belongs to another surface, so flat areas stay flat
// and depth edges stay hard, as in Lytro Desktop's maps.
export const DEPTH_STEP = 0.04;

// Edge-aware depth smoothing (a joint bilateral filter): each depth value
// becomes a weighted average of its neighbors, where neighbors that look
// different in the photo (`guide`, linear RGB at the depth map's size)
// count for little. Rough patches inside a surface even out while depth
// edges stay on the photo's edges. `confidence` (0..1 per pixel, optional)
// lets well-measured values outweigh guesses. `amount` 0..1 sets how far
// the smoothing reaches (repeated 5 x 5 passes). Returns a new array.
export function smoothDepth(alpha, width, height, guide, { amount = 0.3, confidence = null, step = 0 } = {}) {
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
            if (step > 0 && Math.abs(src[j] - src[i]) > step) continue;
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
