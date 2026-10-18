// Depth by the method of the camera maker's own tool, step by step. Every
// view is measured as a reference (pass 1); where each other view can see a
// reference pixel is then decided from those depth maps (a hidden / visible
// choice per pixel, solved as a small random field); the reference view is
// measured again with the hidden views left out (pass 2). The measurement
// itself: a capped color difference against the reference at each trial
// depth, cross-based aggregation, message-passing smoothing, whole labels,
// and a 3 x 3 median. See depth.js for the pieces.
import { crossArms, aggregateCross, flatness, trwsVolume, bestDepth, depthColorGuide, median3, DEPTH_CBCA, DEPTH_EDGE, DEPTH_TRWS, DEPTH_LCOST } from './depth.js';

export const DEPTH_PASSES = {
  on: false,
  // Trial depths: whole lambda steps (LAMBDA_ALPHA alpha each) from `first` to `top`.
  first: -35,
  top: 8,
  lambda: 0.0814,
  // The views measured as references in pass 1 (null: all of them).
  refs: null,
  // Visible / hidden choice: cost of a hole, of choosing hidden, and its smoothing.
  hole: 2,
  hidden: 0.05,
  iterations: 3,
  slope: 1,
  trunc: 10,
  // Fine labels over the depth range the first measurement found (pass 2).
  stats: [],
  // Match every view's mean and spread to the center view's: 'gamma', 'linear' or off.
  matchColor: 'gamma',
  // Box smoothing radius of each view before the cost (0: none).
  blur: 1,
  adapt: { on: true, fine: 48, lowQ: 0.005, highQ: 0.995, pad: 1 },
};

// Moves each view's per-channel mean and spread onto the center view's (the
// maker's tool does this to every other view before measuring depth).
function matchColor(colors, mid, n) {
  const stats = (img, c) => {
    let mean = 0;
    let m2 = 0;
    for (let i = 0; i < n; i++) {
      const d = img[3 * i + c] - mean;
      mean += d / (i + 1);
      m2 += d * (img[3 * i + c] - mean);
    }
    return [mean, Math.max(1e-6, m2 / n)];
  };
  const ref = [0, 1, 2].map((c) => stats(colors[mid], c));
  colors.forEach((img, k) => {
    if (k === mid) return;
    for (let c = 0; c < 3; c++) {
      const [mean, variance] = stats(img, c);
      const scale = Math.sqrt(ref[c][1] / variance);
      for (let i = 0; i < n; i++) img[3 * i + c] = ref[c][0] + (img[3 * i + c] - mean) * scale;
    }
  });
}

// Box smoothing of a 3-channel image, `r` pixels each way.
function boxBlur3(img, w, h, r) {
  const out = new Float32Array(img.length);
  const tmp = new Float32Array(img.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < 3; c++) {
        let a = 0;
        let m = 0;
        for (let t = -r; t <= r; t++) {
          const xx = Math.min(w - 1, Math.max(0, x + t));
          a += img[3 * (y * w + xx) + c];
          m++;
        }
        tmp[3 * (y * w + x) + c] = a / m;
      }
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < 3; c++) {
        let a = 0;
        let m = 0;
        for (let t = -r; t <= r; t++) {
          const yy = Math.min(h - 1, Math.max(0, y + t));
          a += tmp[3 * (yy * w + x) + c];
          m++;
        }
        out[3 * (y * w + x) + c] = a / m;
      }
    }
  }
  return out;
}

// Color images the cost compares: gamma, scaled by the center view's top value.
function viewColors(views, n, w, h) {
  const mid = Math.floor(views.length / 2);
  const linear = views.map((v) => {
    const out = new Float32Array(n * 3);
    for (let i = 0; i < n * 3; i++) out[i] = Math.max(0, v.rgb[i] * v.gain);
    return out;
  });
  if (DEPTH_PASSES.matchColor === 'linear') matchColor(linear, mid, n);
  if (DEPTH_PASSES.blur > 0) for (let k = 0; k < linear.length; k++) linear[k] = boxBlur3(linear[k], w, h, DEPTH_PASSES.blur);
  const colors = linear.map((img) => {
    const out = new Float32Array(n * 3);
    for (let i = 0; i < n * 3; i++) out[i] = Math.max(0, img[i]) ** DEPTH_LCOST.gamma;
    return out;
  });
  if (DEPTH_PASSES.matchColor === 'gamma') matchColor(colors, mid, n);
  let top = 1e-9;
  if (DEPTH_LCOST.normQ <= 0) {
    top = DEPTH_LCOST.fixedTop || 1;
  } else if (DEPTH_LCOST.normQ >= 1) {
    for (const c of colors[mid]) if (c > top) top = c;
  } else {
    const count = Math.min(colors[mid].length, 200000);
    const sample = Float32Array.from({ length: count }, (_, i) => colors[mid][Math.floor((i * colors[mid].length) / count)]).sort();
    top = Math.max(1e-9, sample[Math.floor(DEPTH_LCOST.normQ * (count - 1))]);
  }
  for (const c of colors) for (let i = 0; i < c.length; i++) c[i] /= top;
  return colors;
}

// Bilinear sample of a 3-channel image at (x, y) into out[0..2]; false outside.
function sample3(img, w, h, x, y, out) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  if (x0 < 0 || y0 < 0 || x0 >= w - 1 || y0 >= h - 1) return false;
  const fx = x - x0;
  const fy = y - y0;
  const a = 3 * (y0 * w + x0);
  const b = a + 3;
  const c = a + 3 * w;
  const d = c + 3;
  for (let k = 0; k < 3; k++) out[k] = (img[a + k] * (1 - fx) + img[b + k] * fx) * (1 - fy) + (img[c + k] * (1 - fx) + img[d + k] * fx) * fy;
  return true;
}

// Mean over the views of the capped color difference to reference `r` at
// trial depth `alpha`; `weights[k]` (1: counts, 0: left out) per pixel or null.
function costSlice(colors, views, r, alpha, w, h, weights) {
  const n = w * h;
  const rc = colors[r];
  const sum = new Float32Array(n);
  const cnt = new Float32Array(n);
  const tmp = [0, 0, 0];
  const cap = DEPTH_LCOST.tc;
  views.forEach((view, k) => {
    if (k === r) return;
    const sx = alpha * (view.u - views[r].u) * view.detail;
    const sy = alpha * (view.v - views[r].v) * view.detail;
    const wt = weights ? weights[k] : null;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const d = y * w + x;
        const q = wt ? wt[d] : 1;
        if (q <= 0 || !sample3(colors[k], w, h, x + sx, y + sy, tmp)) continue;
        const cd = Math.abs(tmp[0] - rc[3 * d]) + Math.abs(tmp[1] - rc[3 * d + 1]) + Math.abs(tmp[2] - rc[3 * d + 2]);
        sum[d] += q * (cd < cap ? cd : cap);
        cnt[d] += q;
      }
    }
  });
  const floor = 0.05 * (views.length - 1);
  for (let i = 0; i < n; i++) sum[i] = cnt[i] >= floor ? sum[i] / cnt[i] : cap;
  return sum;
}

// One reference view's depth (labels in `alphas`), views left out per `weights`.
function measureView(colors, views, r, alphas, w, h, weights, refine = false) {
  const n = w * h;
  const guide = depthColorGuide(Float32Array.from(views[r].rgb, (x) => x * views[r].gain));
  const arms = crossArms(guide, w, h, DEPTH_CBCA);
  const flat = DEPTH_EDGE.on ? flatness(guide, w, h, DEPTH_EDGE) : null;
  const scores = alphas.map((a) => {
    const cost = costSlice(colors, views, r, a, w, h, weights);
    const agg = aggregateCross(cost, arms, DEPTH_CBCA.iterations);
    for (let i = 0; i < n; i++) cost[i] = -(flat ? (1 - flat[i]) * cost[i] + flat[i] * agg[i] : agg[i]);
    return cost;
  });
  const beliefs = trwsVolume(scores, guide, w, h, DEPTH_TRWS);
  return refine ? refinedLabels(beliefs, alphas, n) : bestDepth(beliefs, alphas, n);
}

// The final pass puts each depth between its labels: a parabola through the
// beliefs of the neighboring labels, kept when it moves less than one step.
function refinedLabels(beliefs, alphas, n) {
  const K = alphas.length;
  const step = alphas[1] - alphas[0];
  const alpha = new Float32Array(n);
  const cost = new Float32Array(n);
  const meanCost = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let best = 0;
    let sum = 0;
    for (let k = 0; k < K; k++) {
      sum -= beliefs[k][i];
      if (beliefs[k][i] > beliefs[best][i]) best = k;
    }
    let value = alphas[best];
    if (best > 0 && best < K - 1) {
      const a = -beliefs[best - 1][i];
      const b = -beliefs[best][i];
      const c = -beliefs[best + 1][i];
      const curve = a + c - 2 * b;
      if (Math.abs(curve) > 0) {
        const shift = ((c - a) / (2 * curve)) * step;
        if (Math.abs(shift) < step) value -= shift;
      }
    }
    alpha[i] = value;
    cost[i] = -beliefs[best][i];
    meanCost[i] = sum / K;
  }
  return { alpha, cost, meanCost };
}

// Where view `v` sees the pixels of reference `c`: 1 visible, 0 hidden.
function seenBy(colors, views, c, v, depthC, depthV, w, h) {
  const n = w * h;
  const P = DEPTH_PASSES;
  const sx = (views[v].u - views[c].u) * views[v].detail;
  const sy = (views[v].v - views[c].v) * views[v].detail;
  // The other view's depth, moved into the reference view: where something lands.
  const landed = new Uint8Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = depthV[y * w + x];
      const tx = Math.floor(x - d * sx + 0.5);
      const ty = Math.floor(y - d * sy + 0.5);
      if (tx >= 0 && ty >= 0 && tx < w && ty < h) landed[ty * w + tx] = 1;
    }
  }
  const nv = views.length - 1;
  const seen = new Float32Array(n);
  const hiddenCost = new Float32Array(n);
  const tmp = [0, 0, 0];
  const rc = colors[c];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const hole = landed[i] ? 0 : 1;
      let diff = DEPTH_LCOST.tc;
      if (sample3(colors[v], w, h, x + depthC[i] * sx, y + depthC[i] * sy, tmp)) diff = Math.min(DEPTH_LCOST.tc, Math.abs(tmp[0] - rc[3 * i]) + Math.abs(tmp[1] - rc[3 * i + 1]) + Math.abs(tmp[2] - rc[3 * i + 2]));
      seen[i] = -(hole * P.hole + (10 / nv) * diff);
      hiddenCost[i] = -((1 - hole) * P.hole + P.hidden);
    }
  }
  // Two labels (visible, hidden) with uniform smoothing.
  const volume = trwsVolume([seen, hiddenCost], null, w, h, { iterations: P.iterations, slope: P.slope, trunc: P.trunc, gamma: DEPTH_TRWS.gamma, edge: 0, low: 1, scale: 1 });
  const out = new Float32Array(n);
  let hid = 0;
  let holes = 0;
  for (let i = 0; i < n; i++) {
    out[i] = volume[0][i] >= volume[1][i] ? 1 : 0;
    hid += 1 - out[i];
    holes += 1 - landed[i];
  }
  P.stats.push({ view: v, hidden: hid / n, holes: holes / n });
  return out;
}

// Depth of the center view: { alpha, cost, meanCost } (see depth.js bestDepth).
export function measureMatch(views, w, h, { onProgress } = {}) {
  const P = DEPTH_PASSES;
  const n = w * h;
  const c = Math.floor(views.length / 2);
  const colors = viewColors(views, n, w, h);
  const count = P.top - P.first + 1;
  const alphas = Array.from({ length: count }, (_, i) => (P.first + i) * P.lambda);
  const refs = P.refs ?? views.map((_, k) => k);
  if (!refs.includes(c)) refs.push(c);
  // Pass 1: every view as the reference.
  const depths = new Array(views.length).fill(null);
  refs.forEach((r, i) => {
    if (onProgress) onProgress((0.8 * i) / refs.length);
    depths[r] = median3(measureView(colors, views, r, alphas, w, h, null).alpha, w, h);
  });
  // Which views see each pixel of the center.
  const weights = views.map(() => null);
  refs.forEach((v) => {
    if (v !== c) weights[v] = seenBy(colors, views, c, v, depths[c], depths[v], w, h);
  });
  // Pass 2: the center again, hidden views left out, over the range pass 1 found.
  let labels = alphas;
  if (P.adapt.on) {
    const sorted = Float32Array.from(depths[c]).sort();
    const step = alphas[1] - alphas[0];
    const lo = Math.max(alphas[0], sorted[Math.floor(P.adapt.lowQ * (n - 1))] - P.adapt.pad * step);
    const hi = Math.min(alphas[count - 1], sorted[Math.floor(P.adapt.highQ * (n - 1))] + P.adapt.pad * step);
    labels = Array.from({ length: P.adapt.fine }, (_, i) => lo + ((hi - lo) * i) / (P.adapt.fine - 1));
  }
  if (onProgress) onProgress(0.85);
  const measured = measureView(colors, views, c, labels, w, h, weights, true);
  return measured;
}
