// The classic and the Lytro-style depth measurements, combined. The
// Lytro-style map (core/depthmatch.js) has the crisp, flat shapes and wins on
// near objects and thin things; the classic map keeps more gradation in the
// distance. The classic depth is first fitted to the Lytro-style scale
// (robust affine), then blended in with a weight that is 0 near and 1 far
// (by the Lytro-style depth itself), and finally a 9 x 9 median cleans up the
// outlines along its depth edges only (a blanket median would erase thin
// features). Measured against Lytro Desktop's maps: see the plan, #112.

export const DEPTH_COMBINE = { near: 0.45, far: 0.65, blendSigma: 3, edge: 0.15, edgeWindow: 9, bandSteps: 3, median: 9 };

// Value at fraction q (0..1) of the sorted finite values.
function percentile(values, q) {
  const sorted = Float32Array.from(values).sort();
  return sorted[Math.floor(q * (sorted.length - 1))];
}

// Robust affine fit a -> r over `ok` pixels (iteratively reweighted least squares).
export function fitAffine(a, r, ok) {
  let weight = new Float32Array(a.length).fill(1);
  let p0 = 1;
  let p1 = 0;
  for (let iter = 0; iter < 5; iter++) {
    let sw = 0, sa = 0, sr = 0, saa = 0, sar = 0;
    for (let i = 0; i < a.length; i++) {
      if (!ok[i]) continue;
      const w = weight[i];
      sw += w; sa += w * a[i]; sr += w * r[i]; saa += w * a[i] * a[i]; sar += w * a[i] * r[i];
    }
    const det = sw * saa - sa * sa;
    if (Math.abs(det) < 1e-12) break;
    p0 = (sw * sar - sa * sr) / det;
    p1 = (saa * sr - sa * sar) / det;
    const err = new Float32Array(a.length);
    const kept = [];
    for (let i = 0; i < a.length; i++) {
      if (!ok[i]) continue;
      err[i] = Math.abs(a[i] * p0 + p1 - r[i]);
      kept.push(err[i]);
    }
    kept.sort();
    const s = kept[kept.length >> 1] * 1.5 + 1e-6;
    for (let i = 0; i < a.length; i++) if (ok[i]) weight[i] = 1 / Math.max(1, err[i] / s);
  }
  return [p0, p1];
}

function gaussianBlur(src, w, h, sigma) {
  const r = Math.ceil(4 * sigma);
  const k = Float32Array.from({ length: 2 * r + 1 }, (_, i) => Math.exp(-((i - r) ** 2) / (2 * sigma * sigma)));
  const ks = k.reduce((x, y) => x + y, 0);
  const tmp = new Float32Array(w * h);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let t = -r; t <= r; t++) s += k[t + r] * src[y * w + Math.min(w - 1, Math.max(0, x + t))];
      tmp[y * w + x] = s / ks;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let t = -r; t <= r; t++) s += k[t + r] * tmp[Math.min(h - 1, Math.max(0, y + t)) * w + x];
      out[y * w + x] = s / ks;
    }
  }
  return out;
}

// max - min over a square window of `size`, separably.
function localRange(src, w, h, size) {
  const r = size >> 1;
  const pass = (from, horizontal) => {
    const hi = new Float32Array(w * h);
    const lo = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let mx = -Infinity;
        let mn = Infinity;
        for (let t = -r; t <= r; t++) {
          const xx = horizontal ? Math.min(w - 1, Math.max(0, x + t)) : x;
          const yy = horizontal ? y : Math.min(h - 1, Math.max(0, y + t));
          const i = yy * w + xx;
          const a = from.hi[i];
          const b = from.lo[i];
          if (a > mx) mx = a;
          if (b < mn) mn = b;
        }
        hi[y * w + x] = mx;
        lo[y * w + x] = mn;
      }
    }
    return { hi, lo };
  };
  const base = { hi: src, lo: src };
  const v = pass(pass(base, true), false);
  return Float32Array.from(v.hi, (x, i) => x - v.lo[i]);
}

// Dilation by a cross-shaped element, `steps` times.
function dilate(mask, w, h, steps) {
  let cur = mask;
  for (let s = 0; s < steps; s++) {
    const next = Uint8Array.from(cur);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (cur[i]) continue;
        if ((x > 0 && cur[i - 1]) || (x < w - 1 && cur[i + 1]) || (y > 0 && cur[i - w]) || (y < h - 1 && cur[i + w])) next[i] = 1;
      }
    }
    cur = next;
  }
  return cur;
}

// `classic` and `match`: depth (alpha) per pixel, w x h. Returns the combined map on `match`'s scale.
export function combineDepth(classic, match, w, h, P = DEPTH_COMBINE) {
  const n = w * h;
  const ok = new Uint8Array(n);
  const valid = [];
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(classic[i]) && Number.isFinite(match[i])) {
      ok[i] = 1;
      valid.push(match[i]);
    }
  }
  if (valid.length < 16) return Float32Array.from(match);
  const [p0, p1] = fitAffine(classic, match, ok);
  const t0 = percentile(valid, P.near);
  const t1 = percentile(valid, P.far);
  const weight = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = Math.min(1, Math.max(0, (match[i] - t0) / (t1 - t0 || 1)));
    weight[i] = t * t * (3 - 2 * t);
  }
  const blend = gaussianBlur(weight, w, h, P.blendSigma);
  const mix = new Float32Array(n);
  for (let i = 0; i < n; i++) mix[i] = Number.isFinite(classic[i]) ? match[i] + blend[i] * (classic[i] * p0 + p1 - match[i]) : match[i];
  const range = percentile(valid, 0.95) - percentile(valid, 0.05);
  const spread = localRange(match, w, h, P.edgeWindow);
  const jump = new Uint8Array(n);
  for (let i = 0; i < n; i++) jump[i] = spread[i] > P.edge * range ? 1 : 0;
  const band = dilate(jump, w, h, P.bandSteps);
  const out = Float32Array.from(mix);
  const r = P.median >> 1;
  const win = new Float32Array(P.median * P.median);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!band[i]) continue;
      let k = 0;
      for (let dy = -r; dy <= r; dy++) {
        const yy = Math.min(h - 1, Math.max(0, y + dy));
        for (let dx = -r; dx <= r; dx++) win[k++] = mix[yy * w + Math.min(w - 1, Math.max(0, x + dx))];
      }
      win.sort();
      out[i] = win[win.length >> 1];
    }
  }
  return out;
}
