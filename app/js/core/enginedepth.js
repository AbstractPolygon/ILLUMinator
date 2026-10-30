// The engine's depth estimator on its own raster (Lytro Desktop's tnt, LFE DepthMapAlgorithmSimple, read from the shipped Windows binary by driving
// its functions with synthetic inputs and dumping the real ones; see docs/lytro-re-notes.md). Stages in the engine's order:
//   views (9: eight on a ring of radius 0.25 at 0, 45 .. 315 degrees, the centre last) -> data cost volume -> noisy / blown-out entries zeroed ->
//   cross-based aggregation -> TRW-S -> sub-label estimate -> 3 x 3 median.
// Everything here is float32 arithmetic the way the engine does it (Math.fround), including its floor-by-rounding trick, because the result is compared
// with the engine's own volume entry by entry.
const f32 = Math.fround;

// The views' (u, v) as the engine computes them in single precision (cosf / sinf of k x 45 degrees x 0.25).
export const RING_UV = [
  [0.25, 0],
  [0.1767766922712326, 0.1767766922712326],
  [-1.0927847071684482e-8, 0.25],
  [-0.1767767369747162, 0.17677664756774902],
  [-0.25, -2.1855694143368964e-8],
  [-0.1767767071723938, -0.1767766773700714],
  [1.221905137072099e-7, -0.25],
  [0.17677675187587738, -0.17677663266658783],
];

export const ENGINE_COST = { truncate: 0.2, scale: 1.25, top: 4, blownOut: 0.95, noisy: 0.075, noisyQuantile: 0.5 };

// floor() the way the engine's vector code does it: round to nearest through 2^23, subtract one if that rounded up.
function floor32(x) {
  const m = x < 0 ? -8388608 : 8388608;
  const r = f32(f32(x + m) - m);
  return x < r ? r - 1 : r;
}

// Cost volume of `views` (nine Float32Array, RGB per pixel, w x h; index 8 the centre) for the label values `labels` (lambda): per label and pixel
// 1.25 x (sum of the 4 largest of min(sad, 0.2) over the eight ring views), sad the L1 distance between the ring view's bilinear sample at
// (x + lambda u, y + lambda v) and the centre pixel; every label of a pixel is zeroed when the mean ring colour of any label tops 0.95 in a channel,
// and when the cost curve is flat (the label at the median rank within 0.075 of the best). Layout: ((y * w + x) * L + l).
export function engineCostVolume(views, w, h, labels, opts = ENGINE_COST) {
  const L = labels.length;
  const out = new Float32Array(w * h * L);
  const ref = views[8];
  const T = f32(opts.truncate);
  const scale = f32(opts.scale);
  const topK = opts.top;
  const limit = f32(8 * f32(opts.blownOut));
  const sads = new Float32Array(8);
  const sorted = new Float32Array(8);
  const tbl = new Float32Array(L * 8 * 2);
  for (let l = 0; l < L; l++) for (let k = 0; k < 8; k++) {
    tbl[(l * 8 + k) * 2] = f32(f32(labels[l]) * f32(RING_UV[k][1]));
    tbl[(l * 8 + k) * 2 + 1] = f32(f32(labels[l]) * f32(RING_UV[k][0]));
  }
  const kth = Math.ceil((L - 1) * opts.noisyQuantile);
  const vec = new Float32Array(L);
  const hm1 = h - 1;
  const wm1 = w - 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const rr = ref[3 * i];
      const rg = ref[3 * i + 1];
      const rb = ref[3 * i + 2];
      let blown = false;
      const base = i * L;
      for (let l = 0; l < L; l++) {
        let sr = 0;
        let sg = 0;
        let sb = 0;
        for (let k = 0; k < 8; k++) {
          const py = f32(f32(tbl[(l * 8 + k) * 2]) + y);
          const px = f32(f32(tbl[(l * 8 + k) * 2 + 1]) + x);
          const y0 = floor32(py);
          const x0 = floor32(px);
          const y1 = floor32(f32(py + 1));
          const x1 = floor32(f32(px + 1));
          const fy = f32(py - y0);
          const fx = f32(px - x0);
          const cy0 = y0 < 0 ? 0 : y0 > hm1 ? hm1 : y0;
          const cy1 = y1 < 0 ? 0 : y1 > hm1 ? hm1 : y1;
          const cx0 = x0 < 0 ? 0 : x0 > wm1 ? wm1 : x0;
          const cx1 = x1 < 0 ? 0 : x1 > wm1 ? wm1 : x1;
          const w00 = f32(f32(1 - fx) * f32(1 - fy));
          const w01 = f32(f32(1 - fx) * fy);
          const w10 = f32(fx * f32(1 - fy));
          const w11 = f32(fx * fy);
          const v = views[k];
          const a = 3 * (cy0 * w + cx0);
          const b = 3 * (cy1 * w + cx0);
          const c = 3 * (cy0 * w + cx1);
          const d = 3 * (cy1 * w + cx1);
          const r = f32(f32(f32(f32(w11 * v[d]) + f32(w10 * v[c])) + f32(w01 * v[b])) + f32(w00 * v[a]));
          const g = f32(f32(f32(f32(w11 * v[d + 1]) + f32(w10 * v[c + 1])) + f32(w01 * v[b + 1])) + f32(w00 * v[a + 1]));
          const bl = f32(f32(f32(f32(w11 * v[d + 2]) + f32(w10 * v[c + 2])) + f32(w01 * v[b + 2])) + f32(w00 * v[a + 2]));
          sr = f32(sr + r);
          sg = f32(sg + g);
          sb = f32(sb + bl);
          const sad = f32(f32(f32(Math.abs(f32(bl - rb))) + f32(Math.abs(f32(g - rg)))) + f32(Math.abs(f32(r - rr))));
          sads[k] = sad < T ? sad : T;
        }
        if (Math.max(sr, sg, sb) > limit) blown = true;
        sorted.set(sads);
        sorted.sort();
        let acc = 0;
        for (let k = 8 - topK; k < 8; k++) acc = f32(acc + sorted[k]);
        out[base + l] = f32(acc * scale);
      }
      if (blown) {
        out.fill(0, base, base + L);
        continue;
      }
      // cost curves with (almost) no information: the label at the median rank within `noisy` of the best
      for (let l = 0; l < L; l++) vec[l] = out[base + l];
      vec.sort();
      const median = kth < L - 1 ? vec[kth] : vec[L - 1];
      if (f32(median - vec[0]) < f32(opts.noisy)) out.fill(0, base, base + L);
    }
  }
  return out;
}

// ---- cross-based aggregation (CrossBasedDataCostAggregation with the ILLUM's parameters 0.04, 0.025, 34, 17, 4 rounds, blend 1.0 .. 1.5) ----
export const ENGINE_AGG = { tau1: 0.04, tau2: 0.025, arm: 34, long: 17, rounds: 4, lo: 1.0, hi: 1.5, sigma: 1, tap: 2, pad: 'renorm' };

// Arms of every pixel: [left, right, up, down] as absolute coordinates (CrossSkeletonImage): an arm grows while the max-norm RGB difference of the
// candidate to the anchor and to the previous pixel stays under tau1, and (after `long` steps) to the anchor under tau2, to at most `arm - 1` pixels.
export function engineArms(guide, w, h, { tau1, tau2, arm, long } = ENGINE_AGG) {
  const n = w * h;
  const arms = new Int32Array(n * 4);
  const diff = (i, j) => Math.max(Math.abs(f32(guide[3 * i] - guide[3 * j])), Math.abs(f32(guide[3 * i + 1] - guide[3 * j + 1])), Math.abs(f32(guide[3 * i + 2] - guide[3 * j + 2])));
  tau1 = f32(tau1);
  tau2 = f32(tau2);
  const reach = (i, step, room) => {
    let k = 1;
    while (k < arm && k <= room) {
      const j = i + step * k;
      const d1 = diff(i, j);
      if (d1 >= tau1 || diff(j - step, j) >= tau1 || (k > long && d1 >= tau2)) break;
      k++;
    }
    return k - 1;
  };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    arms[4 * i] = x - reach(i, -1, x);
    arms[4 * i + 1] = x + reach(i, 1, w - 1 - x);
    arms[4 * i + 2] = y - reach(i, -w, y);
    arms[4 * i + 3] = y + reach(i, w, h - 1 - y);
  }
  return arms;
}

// Weight of the aggregated cost against the raw one: 1 on flat picture, falling to 0 where the Sobel strength (R + 2G + B, |gx| + |gy|) goes from `lo` to
// `hi`, then a 5 tap Gaussian (sigma 1), edge pixels replicated.
export let kernelMode = 'exp';
export function setKernelMode(m) { kernelMode = m; }
export function engineBlendMap(guide, w, h, { lo, hi, sigma, tap, pad } = ENGINE_AGG) {
  const at = (v, n) => (v >= 0 && v < n ? v : pad === 'zero' || pad === 'renorm' ? -1 : pad === 'mirror' ? (v < 0 ? -v - 1 : 2 * n - 1 - v) : pad === 'mirror101' ? (v < 0 ? -v : 2 * n - 2 - v) : Math.min(n - 1, Math.max(0, v)));
  const e = new Float32Array(w * h).fill(1);
  const wc = [1, 2, 1];
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    let v = 0;
    for (let c = 0; c < 3; c++) {
      const p = (dx, dy) => guide[3 * ((y + dy) * w + x + dx) + c];
      const sx = p(1, -1) + 2 * p(1, 0) + p(1, 1) - p(-1, -1) - 2 * p(-1, 0) - p(-1, 1);
      const sy = p(-1, 1) + 2 * p(0, 1) + p(1, 1) - p(-1, -1) - 2 * p(0, -1) - p(1, -1);
      v += wc[c] * (Math.abs(sx) + Math.abs(sy));
    }
    v -= lo;
    if (v > 0) { const b = 1 - v * (1 / (hi - lo)); e[y * w + x] = b >= 0 ? b : 0; }
  }
  const erf = (x) => { const t = 1 / (1 + 0.3275911 * Math.abs(x)); const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return x >= 0 ? y : -y; };
  const k = Float32Array.from({ length: 2 * tap + 1 }, (_, i) => (kernelMode === 'erf' ? erf((i - tap + 0.5) / (sigma * Math.SQRT2)) - erf((i - tap - 0.5) / (sigma * Math.SQRT2)) : Math.exp(-((i - tap) ** 2) / (2 * sigma * sigma))));
  const ks = k.reduce((a, b) => a + b, 0);
  for (let i = 0; i < k.length; i++) k[i] /= ks;
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0;
    let ws = 0;
    for (let t = -tap; t <= tap; t++) { const xx = at(x + t, w); if (xx >= 0) { s += k[t + tap] * e[y * w + xx]; ws += k[t + tap]; } }
    tmp[y * w + x] = pad === 'renorm' ? s / ws : s;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let s = 0;
    let ws = 0;
    for (let t = -tap; t <= tap; t++) { const yy = at(y + t, h); if (yy >= 0) { s += k[t + tap] * tmp[yy * w + x]; ws += k[t + tap]; } }
    out[y * w + x] = pad === 'renorm' ? s / ws : s;
  }
  return out;
}

// One aggregation round on a w x h slice: even rounds sum, for each pixel, the horizontal arm sums of the pixels down its vertical arm; odd rounds the
// vertical arm sums of the pixels along its horizontal arm; both divided by the number of pixels summed.
function roundOnce(src, arms, w, h, even) {
  const out = new Float64Array(w * h);
  if (even) {
    const hs = new Float64Array(w * h);
    const hc = new Int32Array(w * h);
    const row = new Float64Array(w + 1);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) row[x + 1] = row[x] + src[y * w + x];
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        hs[i] = row[arms[4 * i + 1] + 1] - row[arms[4 * i]];
        hc[i] = arms[4 * i + 1] - arms[4 * i] + 1;
      }
    }
    const cs = new Float64Array((h + 1) * w);
    const cc = new Float64Array((h + 1) * w);
    for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) {
      cs[(y + 1) * w + x] = cs[y * w + x] + hs[y * w + x];
      cc[(y + 1) * w + x] = cc[y * w + x] + hc[y * w + x];
    }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const t = arms[4 * i + 2];
      const b = arms[4 * i + 3] + 1;
      out[i] = (cs[b * w + x] - cs[t * w + x]) / (cc[b * w + x] - cc[t * w + x]);
    }
  } else {
    const vs = new Float64Array(w * h);
    const vc = new Int32Array(w * h);
    const col = new Float64Array((h + 1) * w);
    for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) col[(y + 1) * w + x] = col[y * w + x] + src[y * w + x];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      vs[i] = col[(arms[4 * i + 3] + 1) * w + x] - col[arms[4 * i + 2] * w + x];
      vc[i] = arms[4 * i + 3] - arms[4 * i + 2] + 1;
    }
    const rs = new Float64Array(w + 1);
    const rc = new Float64Array(w + 1);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) { rs[x + 1] = rs[x] + vs[y * w + x]; rc[x + 1] = rc[x] + vc[y * w + x]; }
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        out[i] = (rs[arms[4 * i + 1] + 1] - rs[arms[4 * i]]) / (rc[arms[4 * i + 1] + 1] - rc[arms[4 * i]]);
      }
    }
  }
  return out;
}

// The aggregated volume (layout as engineCostVolume): per label slice `rounds` rounds, then (1 - b) raw + b aggregated.
export function engineAggregate(volume, guide, w, h, L, opts = ENGINE_AGG) {
  const arms = engineArms(guide, w, h, opts);
  const blend = engineBlendMap(guide, w, h, opts);
  const out = new Float32Array(volume.length);
  const slice = new Float32Array(w * h);
  for (let l = 0; l < L; l++) {
    for (let i = 0; i < w * h; i++) slice[i] = volume[i * L + l];
    let cur = slice;
    for (let r = 0; r < opts.rounds; r++) cur = roundOnce(cur, arms, w, h, r % 2 === 0);
    for (let i = 0; i < w * h; i++) out[i * L + l] = Math.fround((1 - blend[i]) * slice[i] + blend[i] * cur[i]);
  }
  return out;
}

// ---- TRW-S (MRFSolverTRWS<float>, serial order) ----
// Four message volumes per pixel and label: M0 from above, M1 from the right, M2 from below, M3 from the left (stored at the receiver). The belief is
// data + M0 + M1 + M3 + M2 (in that order); a message is min(cap, t - min t) with t = 0.5 belief - message back, passed once forward and once backward
// through t[k] = min(t[k], t[k -/+ 1] + slope). Iteration i (counted from 0) runs the sweep right/down then left/up when i is even, left/down then right/up when odd.
export const ENGINE_MRF = { slope: 0.1, truncate: 6, iterations: 10, gamma: 0.5 };

export function engineTrws(data, hCue, vCue, w, h, L, { slope, truncate, iterations, gamma } = ENGINE_MRF, wantBeliefs = false) {
  const n = w * h * L;
  const M = [new Float32Array(n), new Float32Array(n), new Float32Array(n), new Float32Array(n)];
  const belief = new Float32Array(L);
  const t = new Float32Array(L);
  const g = f32(gamma);
  const compute = (p) => {
    const o = p * L;
    for (let k = 0; k < L; k++) belief[k] = f32(f32(f32(f32(data[o + k] + M[0][o + k]) + M[1][o + k]) + M[3][o + k]) + M[2][o + k]);
  };
  // message from the belief at the sender into dst (the receiver's buffer at offset `to`), given the message back `back` (the sender's buffer at `from`)
  const send = (dst, to, back, from, weight) => {
    const a = f32(f32(slope) * weight);
    const cap = f32(a * f32(truncate));
    let lo = Infinity;
    for (let k = 0; k < L; k++) {
      const v = f32(f32(belief[k] * g) - back[from + k]);
      t[k] = v;
      if (v < lo) lo = v;
    }
    for (let k = 1; k < L; k++) { const c = f32(t[k - 1] + a); if (c < t[k]) t[k] = c; }
    for (let k = L - 2; k >= 0; k--) { const c = f32(t[k + 1] + a); if (c < t[k]) t[k] = c; }
    for (let k = 0; k < L; k++) { const v = f32(t[k] - lo); dst[to + k] = v < cap ? v : cap; }
  };
  const right = (y, x, p) => { if (x < w - 1) send(M[3], (p + 1) * L, M[1], p * L, hCue[p]); };
  const down = (y, x, p) => { if (y < h - 1) send(M[0], (p + w) * L, M[2], p * L, vCue[p]); };
  const left = (y, x, p) => { if (x > 0) send(M[1], (p - 1) * L, M[3], p * L, hCue[p - 1]); };
  const up = (y, x, p) => { if (y > 0) send(M[2], (p - w) * L, M[0], p * L, vCue[p - w]); };
  for (let it = 0; it < iterations; it++) {
    const odd = it % 2 === 1;
    for (let y = 0; y < h; y++) for (let xx = 0; xx < w; xx++) {
      const x = odd ? w - 1 - xx : xx;
      const p = y * w + x;
      compute(p);
      if (odd) left(y, x, p); else right(y, x, p);
      down(y, x, p);
    }
    for (let yy = 0; yy < h; yy++) {
      const y = h - 1 - yy;
      for (let xx = 0; xx < w; xx++) {
        const x = odd ? xx : w - 1 - xx;
        const p = y * w + x;
        compute(p);
        if (odd) right(y, x, p); else left(y, x, p);
        up(y, x, p);
      }
    }
  }
  // label per pixel: the smallest belief (first on ties)
  const best = new Int32Array(w * h);
  const beliefs = wantBeliefs ? new Float32Array(n) : null;
  for (let p = 0; p < w * h; p++) {
    compute(p);
    if (beliefs) beliefs.set(belief, p * L);
    let bk = 0;
    for (let k = 1; k < L; k++) if (belief[k] < belief[bk]) bk = k;
    best[p] = bk;
  }
  return wantBeliefs ? { labels: best, beliefs } : best;
}

// Smoothness weights between neighbours (BuildEdgeAdaptiveSmoothnessCost): 1, or 0.5 where |dR| + 2|dG| + |dB| to the right / lower neighbour tops 0.2.
export function engineCues(guide, w, h, { threshold = 0.2, weak = 0.5 } = {}) {
  const hc = new Float32Array(w * h).fill(1);
  const vc = new Float32Array(w * h).fill(1);
  const d = (i, j) => f32(f32(Math.abs(f32(guide[3 * i] - guide[3 * j])) + f32(2 * Math.abs(f32(guide[3 * i + 1] - guide[3 * j + 1])))) + Math.abs(f32(guide[3 * i + 2] - guide[3 * j + 2])));
  const thr = f32(threshold);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (x < w - 1 && d(i, i + 1) > thr) hc[i] = weak;
    if (y < h - 1 && d(i, i + w) > thr) vc[i] = weak;
  }
  return { hc, vc };
}

// Sub-label estimate on the beliefs (parabola through the label and its neighbours, kept when it moves less than one step) and the 3 x 3 median.
export function engineFinishDepth(labels, best, beliefs, w, h, L) {
  const sub = new Float32Array(w * h);
  for (let p = 0; p < w * h; p++) {
    const idx = best[p];
    const dep = labels[idx];
    sub[p] = dep;
    if (idx > 0 && idx < L - 1) {
      const cp = beliefs[p * L + idx + 1];
      const cm = beliefs[p * L + idx - 1];
      const c0 = beliefs[p * L + idx];
      const den = f32(f32(cp + cm) - f32(c0 * 2));
      if (Math.abs(den) > 0) {
        const delta = f32(f32(cp - cm) / f32(den * 2));
        if (Math.abs(delta) < 1) sub[p] = f32(dep - delta);
      }
    }
  }
  const out = new Float32Array(sub);
  const a = new Float32Array(9);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    let k = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) a[k++] = sub[(y + dy) * w + x + dx];
    a.sort();
    out[y * w + x] = a[4];
  }
  return out;
}

// The labels the engine measures: whole lambdas from -35 up to floor(infinity lambda) + 3 (at most 100), padded to a multiple of four.
export function engineLabels(infinityLambda) {
  const top = Math.min(Math.floor(infinityLambda) + 3, 100);
  const labels = [];
  for (let v = -35; v <= top; v++) labels.push(v);
  while (labels.length % 4) labels.push(labels[labels.length - 1] + 1);
  return labels;
}

// views: nine Float32Array (RGB, w x h; the colour views after the colour matrix, gamma and match colour; index 8 the centre). Returns the depth map (lambda).
export function engineDepthMap(views, w, h, labels, onProgress = () => {}) {
  const L = labels.length;
  onProgress('cost', 0);
  const cost = engineCostVolume(views, w, h, labels);
  onProgress('aggregate', 0.3);
  const agg = engineAggregate(cost, views[8], w, h, L);
  onProgress('smooth', 0.4);
  const { hc, vc } = engineCues(views[8], w, h);
  const { labels: best, beliefs } = engineTrws(agg, hc, vc, w, h, L, undefined, true);
  onProgress('finish', 0.95);
  return engineFinishDepth(labels, best, beliefs, w, h, L);
}
