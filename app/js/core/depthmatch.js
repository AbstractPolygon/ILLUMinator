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
  step: 1,
  lambda: 0.0814,
  // The views measured as references in pass 1 (null: all of them).
  refs: null,
  // Visible / hidden choice: cost of a hole, of choosing hidden, and its smoothing.
  hole: 2,
  hidden: 0.05,
  // Cost of a view's own pixel being hidden from the reference (per hidden view, over the view count), the
  // brightness above which a pixel is blown out, and the cost spread under which it is flat.
  behind: 1.2,
  satur: 0.95,
  flat: 0.15,
  iterations: 3,
  slope: 1,
  trunc: 10,
  // Off: pass 2 uses the same labels as pass 1, as the maker's tool does. On: fine labels over the depth
  // range the first measurement found.
  stats: [],
  // Match every view's mean and spread to the center view's: 'gamma', 'linear' or off.
  matchColor: 'gamma',
  // Box smoothing radius of each view before the cost (0: none).
  blur: 1,
  adapt: { on: false, fine: 48, lowQ: 0.005, highQ: 0.995, pad: 1 },
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
export function viewColors(views, n, w, h) {
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

// Bilinear sample of `img` (3 channels) at (x, y) the way the maker's tool does it: every corner
// outside the picture simply adds nothing (no renormalising). `maps` (1 channel) likewise.
function sampleOpen(img, ch, w, h, x, y, out) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  for (let k = 0; k < ch; k++) out[k] = 0;
  for (let j = 0; j < 2; j++) {
    const yy = y0 + j;
    if (yy < 0 || yy >= h) continue;
    for (let i = 0; i < 2; i++) {
      const xx = x0 + i;
      if (xx < 0 || xx >= w) continue;
      const wt = (i ? fx : 1 - fx) * (j ? fy : 1 - fy);
      for (let k = 0; k < ch; k++) out[k] += img[ch * (yy * w + xx) + k] * wt;
    }
  }
}

// The match cost of every trial depth for reference `r` (FUN_18088bea0), in units of the mean over
// the other views (the maker's tool's cost is ten times that). Per view the capped color difference
// (L1 over the three channels, `tc`) at the shifted spot; `hidden[k]` (1: reference pixel hidden from
// view k) leaves a view out and the rest is scaled up to the full count; `behind[k]` (1: the view's own
// pixel at the shifted spot is hidden from the reference) adds `DEPTH_PASSES.behind` / count.
// A pixel is set to zero cost at every depth where the shifted views are on average brighter than
// `satur` in some channel (blown out) and where the costs hardly differ (`flat`, in tool units).
function costVolume(colors, views, r, alphas, w, h, hidden, behind) {
  const n = w * h;
  const P = DEPTH_PASSES;
  const rc = colors[r];
  const others = views.length - 1;
  const cap = DEPTH_LCOST.tc;
  const K = alphas.length;
  const cost = alphas.map(() => new Float32Array(n));
  const blown = new Uint8Array(n);
  const acc0 = new Float32Array(n);
  const accH = new Float32Array(n);
  const accB = new Float32Array(n);
  const sum = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  const tmp = [0, 0, 0];
  const one = [0];
  for (let k = 0; k < K; k++) {
    acc0.fill(0);
    accH.fill(0);
    accB.fill(0);
    for (const s of sum) s.fill(0);
    views.forEach((view, v) => {
      if (v === r) return;
      const sx = alphas[k] * (view.u - views[r].u) * view.detail;
      const sy = alphas[k] * (view.v - views[r].v) * view.detail;
      const hid = hidden ? hidden[v] : null;
      const bh = behind ? behind[v] : null;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const d = y * w + x;
          sampleOpen(colors[v], 3, w, h, x + sx, y + sy, tmp);
          const cd = Math.abs(tmp[0] - rc[3 * d]) + Math.abs(tmp[1] - rc[3 * d + 1]) + Math.abs(tmp[2] - rc[3 * d + 2]);
          const a = hid ? hid[d] : 0;
          acc0[d] += (1 - a) * (cd < cap ? cd : cap);
          accH[d] += a;
          if (bh) {
            sampleOpen(bh, 1, w, h, x + sx, y + sy, one);
            accB[d] += one[0];
          }
          sum[0][d] += tmp[0];
          sum[1][d] += tmp[1];
          sum[2][d] += tmp[2];
        }
      }
    });
    const c = cost[k];
    for (let i = 0; i < n; i++) {
      let a0 = acc0[i];
      if (accH[i] > 0 && accH[i] < others) a0 = (a0 * others) / (others - accH[i]);
      c[i] = (a0 + (P.behind * accB[i]) / others) / others;
      if (Math.max(sum[0][i], sum[1][i], sum[2][i]) > P.satur * others) blown[i] = 1;
    }
  }
  for (let i = 0; i < n; i++) {
    let lo = Infinity;
    let hi = -Infinity;
    for (let k = 0; k < K; k++) {
      const v = cost[k][i];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (blown[i] || (hi - lo) * 10 < P.flat) for (let k = 0; k < K; k++) cost[k][i] = 0;
  }
  return cost;
}

// One reference view's depth (labels in `alphas`), views left out per `weights`
// (1 visible, 0 hidden) and `behind` (1 where the other view's pixel is hidden from the reference).
function measureView(colors, views, r, alphas, w, h, weights, refine = false, behind = null) {
  const n = w * h;
  const guide = depthColorGuide(Float32Array.from(views[r].rgb, (x) => x * views[r].gain));
  const arms = crossArms(guide, w, h, DEPTH_CBCA);
  const flat = DEPTH_EDGE.on ? flatness(guide, w, h, DEPTH_EDGE) : null;
  const hidden = weights ? weights.map((m) => (m ? Float32Array.from(m, (x) => 1 - x) : null)) : null;
  const volume = costVolume(colors, views, r, alphas, w, h, hidden, behind);
  const scores = volume.map((cost) => {
    const agg = aggregateCross(cost, arms, DEPTH_CBCA.iterations);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = -(flat ? (1 - flat[i]) * cost[i] + flat[i] * agg[i] : agg[i]);
    return out;
  });
  const beliefs = trwsVolume(scores, guide, w, h, DEPTH_TRWS);
  return bestDepth(beliefs, alphas, n, refine ? scores : null);
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
  const count = Math.floor((P.top - P.first) / P.step) + 1;
  const alphas = Array.from({ length: count }, (_, i) => (P.first + i * P.step) * P.lambda);
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
  // And which pixels of each other view the center cannot see (they are hidden from it).
  const behind = views.map(() => null);
  refs.forEach((v) => {
    if (v !== c) behind[v] = Float32Array.from(seenBy(colors, views, v, c, depths[v], depths[c], w, h), (x) => 1 - x);
  });
  const measured = measureView(colors, views, c, labels, w, h, weights, true, behind);
  return measured;
}
