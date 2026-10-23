import { signatureDistance } from './objects.js';

// Region cleanup of a depth map, the way Lytro Desktop's maps look: the
// picture is cut into small regions of like color (SLIC superpixels), each
// region takes the confidence-weighted median depth of its pixels, and
// neighbouring regions of similar color pull toward each other. Measured
// against Lytro Desktop's maps of 11 photos, gross depth errors fall from
// 38% to 33% of the picture (72% to 37% on shiny metal).

// sRGB-ish 0..1 -> CIE Lab.
function toLab(r, g, b, out, o) {
  const lin = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const R = lin(r);
  const G = lin(g);
  const B = lin(b);
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f((0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.9505);
  const fy = f(0.2126 * R + 0.7152 * G + 0.0722 * B);
  const fz = f((0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.089);
  out[o] = 116 * fy - 16;
  out[o + 1] = 500 * (fx - fy);
  out[o + 2] = 200 * (fy - fz);
}

// SLIC superpixels of a w x h picture given as Lab (3 per pixel). Returns a
// label per pixel and the number of labels.
export function slic(lab, w, h, count = 2500, compactness = 8, iterations = 6) {
  const step = Math.max(2, Math.sqrt((w * h) / count));
  const centers = [];
  for (let y = step / 2; y < h; y += step) {
    for (let x = step / 2; x < w; x += step) {
      const i = (Math.floor(y) * w + Math.floor(x)) * 3;
      centers.push([x, y, lab[i], lab[i + 1], lab[i + 2]]);
    }
  }
  const k = centers.length;
  const label = new Int32Array(w * h).fill(-1);
  const dist = new Float32Array(w * h);
  const m2 = (compactness / step) ** 2;
  const S = Math.ceil(step);
  for (let it = 0; it < iterations; it++) {
    dist.fill(Infinity);
    for (let c = 0; c < k; c++) {
      const [cx, cy, l, a, b] = centers[c];
      const x0 = Math.max(0, Math.floor(cx - S));
      const x1 = Math.min(w - 1, Math.ceil(cx + S));
      const y0 = Math.max(0, Math.floor(cy - S));
      const y1 = Math.min(h - 1, Math.ceil(cy + S));
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const p = y * w + x;
          const dl = lab[3 * p] - l;
          const da = lab[3 * p + 1] - a;
          const db = lab[3 * p + 2] - b;
          const d = dl * dl + da * da + db * db + ((x - cx) ** 2 + (y - cy) ** 2) * m2;
          if (d < dist[p]) {
            dist[p] = d;
            label[p] = c;
          }
        }
      }
    }
    const acc = new Float64Array(k * 6);
    for (let p = 0; p < w * h; p++) {
      const c = label[p];
      if (c < 0) continue;
      acc[6 * c] += p % w;
      acc[6 * c + 1] += Math.floor(p / w);
      acc[6 * c + 2] += lab[3 * p];
      acc[6 * c + 3] += lab[3 * p + 1];
      acc[6 * c + 4] += lab[3 * p + 2];
      acc[6 * c + 5] += 1;
    }
    for (let c = 0; c < k; c++) {
      const n = acc[6 * c + 5];
      if (n) centers[c] = [acc[6 * c] / n, acc[6 * c + 1] / n, acc[6 * c + 2] / n, acc[6 * c + 3] / n, acc[6 * c + 4] / n];
    }
  }
  // Pixels no center reached (rare) join their left or upper neighbour.
  for (let p = 0; p < w * h; p++) if (label[p] < 0) label[p] = p > 0 ? label[p - 1] : 0;
  return { label, count: k };
}

// The cleanup itself. `alpha` and `confidence` per pixel, `rgb` the
// picture's color (0..1, 3 per pixel). Returns new depths.
export function segmentDepth(alpha, confidence, rgb, w, h, { count = 2500, compactness = 8, strength = 1, iterations = 30, colorSigma = 8, plateau = 0.012, edge = 0.25, snap = 0.05, snapPasses = 2, guide = { radius: 5, eps: 0.003 }, objects = null } = {}) {
  const n = w * h;
  const lab = new Float32Array(n * 3);
  for (let p = 0; p < n; p++) toLab(rgb[3 * p], rgb[3 * p + 1], rgb[3 * p + 2], lab, 3 * p);
  const { label, count: k } = slic(lab, w, h, count, compactness);
  // Each region: confidence-weighted median depth, mean confidence and color.
  const members = Array.from({ length: k }, () => []);
  for (let p = 0; p < n; p++) members[label[p]].push(p);
  const value = new Float32Array(k);
  const trust = new Float32Array(k);
  const mean = new Float32Array(k * 3);
  for (let c = 0; c < k; c++) {
    const ps = members[c];
    if (!ps.length) continue;
    ps.sort((a, b) => alpha[a] - alpha[b]);
    let total = 0;
    for (const p of ps) total += confidence[p] + 1e-4;
    let run = 0;
    value[c] = alpha[ps[ps.length - 1]];
    for (const p of ps) {
      run += confidence[p] + 1e-4;
      if (run >= total / 2) {
        value[c] = alpha[p];
        break;
      }
    }
    trust[c] = total / ps.length;
    for (const p of ps) for (let j = 0; j < 3; j++) mean[3 * c + j] += lab[3 * p + j] / ps.length;
  }
  // Neighbouring regions, weighted by how alike their colors are.
  const seen = new Set();
  const pairs = [];
  const link = (a, b) => {
    if (a === b) return;
    const key = a < b ? a * k + b : b * k + a;
    if (seen.has(key)) return;
    seen.add(key);
    const d2 = (mean[3 * a] - mean[3 * b]) ** 2 + (mean[3 * a + 1] - mean[3 * b + 1]) ** 2 + (mean[3 * a + 2] - mean[3 * b + 2]) ** 2;
    pairs.push(a, b, Math.exp(-d2 / (colorSigma * colorSigma)));
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (x + 1 < w) link(label[p], label[p + 1]);
      if (y + 1 < h) link(label[p], label[p + w]);
    }
  }
  let cur = Float32Array.from(value);
  for (let it = 0; it < iterations; it++) {
    const num = new Float32Array(k);
    const den = new Float32Array(k);
    for (let c = 0; c < k; c++) {
      num[c] = trust[c] * value[c];
      den[c] = trust[c];
    }
    for (let i = 0; i < pairs.length; i += 3) {
      const a = pairs[i];
      const b = pairs[i + 1];
      const wgt = pairs[i + 2] * strength;
      num[a] += wgt * trust[b] * cur[b];
      den[a] += wgt * trust[b];
      num[b] += wgt * trust[a] * cur[a];
      den[b] += wgt * trust[a];
    }
    for (let c = 0; c < k; c++) cur[c] = den[c] > 0 ? num[c] / den[c] : cur[c];
  }
  // Neighbouring regions whose depths ended up within `plateau` of each
  // other become one flat plateau, so the map has hard steps where the depth
  // really changes and exactly flat areas in between (like Lytro Desktop's).
  if (plateau > 0) {
    const parent = Int32Array.from({ length: k }, (_, c) => c);
    const root = (c) => {
      while (parent[c] !== c) c = parent[c] = parent[parent[c]];
      return c;
    };
    // A plateau never spans more than `plateau` in depth, so a gradual ramp
    // stays a ramp (in small steps) instead of chaining into one flat area.
    const lo = Float64Array.from(cur);
    const hi = Float64Array.from(cur);
    const order = [];
    for (let i = 0; i < pairs.length; i += 3) order.push(i);
    order.sort((x, y) => Math.abs(cur[pairs[x]] - cur[pairs[x + 1]]) - Math.abs(cur[pairs[y]] - cur[pairs[y + 1]]));
    for (const i of order) {
      const a = root(pairs[i]);
      const b = root(pairs[i + 1]);
      if (a === b) continue;
      const l = Math.min(lo[a], lo[b]);
      const h = Math.max(hi[a], hi[b]);
      if (h - l >= plateau) continue;
      parent[a] = b;
      lo[b] = l;
      hi[b] = h;
    }
    const num = new Float64Array(k);
    const den = new Float64Array(k);
    for (let c = 0; c < k; c++) {
      const r = root(c);
      num[r] += (trust[c] + 1e-4) * members[c].length * cur[c];
      den[r] += (trust[c] + 1e-4) * members[c].length;
    }
    for (let c = 0; c < k; c++) cur[c] = num[root(c)] / den[root(c)];
  }
  const out = new Float32Array(n);
  for (let p = 0; p < n; p++) out[p] = cur[label[p]];
  if (!(edge > 0)) return out;
  if (!objects) {
    // Steps (any visible one) are put on the photo's edges by a vote among
    // like colored neighbours, twice so the border straightens, then
    // gradual changes are smoothed.
    let d = out;
    d = layerSnap(d, lab, w, h);
    for (let i = 0; i < snapPasses; i++) d = colorMedian(d, lab, w, h);
    d = smoothRamps(d, lab, w, h, edge);
    return guide ? guidedFilter(d, lab, w, h, guide.radius, guide.eps) : d;
  }
  // With objects known, an outline (not the size of a step) is what keeps
  // two sides apart, so depth flows freely within each object.
  const snapped = flattenHalos(snapToObjects(out, objects, w, h), objects, w, h);
  return smoothRamps(OBJECT_FLAT.on ? flattenObjects(snapped, objects, w, h, OBJECT_FLAT) : snapped, lab, w, h, Infinity, objects, 8, 4, 10);
}

// Depth edges (steps larger than `edge`) follow the superpixels' borders,
// which are jagged. Within a few pixels of a step, each pixel takes the value
// that carries the most weight in its 17 x 17 neighbourhood (nearer and
// more alike in color counts more), so the step stays hard but its border
// straightens. Everywhere else the depth is left as it is.
// How strongly an object's outline between two pixels counts against pairing
// them (per outline crossed).
const OBJECT_COST = 5;
const R = 8;
const SIGMA = 4;
export function smoothSteps(depth, lab, w, h, edge, objects = null) {
  const near = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if ((x + 1 < w && Math.abs(depth[p] - depth[p + 1]) > edge) || (y + 1 < h && Math.abs(depth[p] - depth[p + w]) > edge)) {
        for (let dy = -R; dy <= R + 1; dy++) {
          for (let dx = -R; dx <= R + 1; dx++) {
            const xx = x + dx;
            const yy = y + dy;
            if (xx >= 0 && yy >= 0 && xx < w && yy < h) near[yy * w + xx] = 1;
          }
        }
      }
    }
  }
  const out = Float32Array.from(depth);
  const vals = new Float32Array((2 * R + 1) ** 2);
  const wts = new Float32Array((2 * R + 1) ** 2);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (!near[p]) continue;
      let m = 0;
      for (let dy = -R; dy <= R; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -R; dx <= R; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const q = yy * w + xx;
          const dl = lab[3 * q] - lab[3 * p];
          const da = lab[3 * q + 1] - lab[3 * p + 1];
          const db = lab[3 * q + 2] - lab[3 * p + 2];
          const wt = Math.exp(-(dx * dx + dy * dy) / (2 * SIGMA * SIGMA) - (dl * dl + da * da + db * db) / 150 - (objects ? OBJECT_COST * signatureDistance(objects[p], objects[q]) : 0));
          let k = 0;
          while (k < m && Math.abs(vals[k] - depth[q]) > 1e-4) k++;
          if (k === m) {
            vals[m] = depth[q];
            wts[m++] = 0;
          }
          wts[k] += wt;
        }
      }
      let best = 0;
      for (let k = 1; k < m; k++) if (wts[k] > wts[best]) best = k;
      out[p] = vals[best];
    }
  }
  return out;
}

// The superpixels turn a gradual change of depth into small square steps,
// and square borders where an object's edge is not in the photo. Each depth
// is averaged with its neighbours, counting those that look like it in the
// photo (`lab`) and lie nearer, so depth follows the photo's own edges and
// flows smoothly elsewhere. Neighbours more than `edge` away in depth (another
// object across a step) do not count, so real hard steps stay hard.
export function smoothRamps(depth, lab, w, h, edge, objects = null, radius = 8, sigma = 4, colorSigma = 7) {
  const out = new Float32Array(w * h);
  const k = -1 / (2 * sigma * sigma);
  const kc = -1 / (2 * colorSigma * colorSigma);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      const d0 = depth[p];
      let sum = 0;
      let wsum = 0;
      for (let dy = -radius; dy <= radius; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -radius; dx <= radius; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const q = yy * w + xx;
          const d = depth[q];
          if (Math.abs(d - d0) > edge) continue;
          const dl = lab[3 * q] - lab[3 * p];
          const da = lab[3 * q + 1] - lab[3 * p + 1];
          const db = lab[3 * q + 2] - lab[3 * p + 2];
          const wt = Math.exp(k * (dx * dx + dy * dy) + kc * (dl * dl + da * da + db * db) - (objects ? OBJECT_COST * signatureDistance(objects[p], objects[q]) : 0));
          sum += d * wt;
          wsum += wt;
        }
      }
      out[p] = sum / wsum;
    }
  }
  return out;
}

// Depth edges on the objects' outlines. Near an outline (within `inner`
// pixels of a pixel with other objects' signature) the measured depth is
// unreliable, since it comes from blocks of the picture that straddle the
// outline. Each such pixel takes the median depth of the same object's pixels
// further inside (nearer ones count more), so each object's depth reaches
// right up to its outline and stops there.
export function snapToObjects(depth, objects, w, h, inner = 10, reach = 24) {
  const interior = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      const sig = objects[p];
      let same = 1;
      for (let dy = -inner; dy <= inner && same; dy += 1) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -inner; dx <= inner; dx += 1) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          if (objects[yy * w + xx] !== sig) {
            same = 0;
            break;
          }
        }
      }
      interior[p] = same;
    }
  }
  const out = Float32Array.from(depth);
  const k = -1 / (2 * (reach / 2.5) ** 2);
  const vals = [];
  const wts = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (interior[p]) continue;
      const sig = objects[p];
      vals.length = 0;
      wts.length = 0;
      let total = 0;
      for (let dy = -reach; dy <= reach; dy += 2) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -reach; dx <= reach; dx += 2) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const q = yy * w + xx;
          if (!interior[q] || objects[q] !== sig) continue;
          const wt = Math.exp(k * (dx * dx + dy * dy));
          vals.push(depth[q]);
          wts.push(wt);
          total += wt;
        }
      }
      if (total < 0.05) continue;
      // Weighted median: a halo of in-between depths cannot pull it.
      const order = vals.map((_, i) => i).sort((i, j) => vals[i] - vals[j]);
      let run = 0;
      for (const i of order) {
        run += wts[i];
        if (run >= total / 2) {
          out[p] = vals[i];
          break;
        }
      }
    }
  }
  return out;
}

// Each mid-sized object is taken as one surface at the depth most of its
// nearer half has (`quantile` of its depths, from the near end): the blur of
// a thin near object (wires, rails, branches) dilutes its measured depth
// towards the background, so the object's own pixels come out too far.
// Pixels of the object further than that depth are put at it.
export const OBJECT_FLAT = { on: false, min: 0.004, max: 0.2, quantile: 0.3, thin: 0, nearShare: 1, unify: false, reach: 0 };

export function flattenObjects(depth, objects, w, h, { min = 0.004, max = 0.2, quantile = 0.3, thin = 0, nearShare = 1, unify = false, reach = 0 } = {}) {
  const n = w * h;
  const out = Float32Array.from(depth);
  // Only objects in the nearest `nearShare` of the picture are touched.
  const cut = nearShare < 1 ? Float32Array.from(depth).sort()[Math.floor(nearShare * (n - 1))] : Infinity;
  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const l = objects[i];
    if (!groups.has(l)) groups.set(l, []);
    groups.get(l).push(i);
  }
  const picked = [];
  for (const idx of groups.values()) {
    const share = idx.length / n;
    if (share < min || share > max) continue;
    if (thin > 0) {
      // Only long thin objects: area over outline length is their average
      // half width, in pixels.
      let outline = 0;
      for (const i of idx) {
        const x = i % w;
        const y = (i - x) / w;
        const l = objects[i];
        if ((x > 0 && objects[i - 1] !== l) || (x < w - 1 && objects[i + 1] !== l) || (y > 0 && objects[i - w] !== l) || (y < h - 1 && objects[i + w] !== l)) outline++;
      }
      if (idx.length / Math.max(1, outline) > thin) continue;
    }
    const sorted = idx.map((i) => depth[i]).sort((a, b) => a - b);
    const target = sorted[Math.floor(quantile * (sorted.length - 1))];
    if (target > cut) continue;
    picked.push({ idx, target });
  }
  // Objects of one surface (a fence's wires) share a depth: the median of
  // their own.
  const common = unify && picked.length ? picked.map((o) => o.target).sort((a, b) => a - b)[Math.floor((picked.length - 1) / 2)] : null;
  // With `reach`, only pixels within that many pixels of a measured near
  // pixel (the nearest `nearShare` of the picture) are changed: the blur of a
  // near object reaches that far, further out nothing was seen of it.
  let close = null;
  if (reach > 0 && Number.isFinite(cut)) {
    const near = new Uint8Array(n);
    for (let i = 0; i < n; i++) near[i] = depth[i] <= cut ? 1 : 0;
    const spread = (src, step, len) => {
      const dst = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        if (!src[i]) continue;
        const pos = step === 1 ? i % w : Math.floor(i / w);
        const lo = Math.max(0, pos - reach);
        const hi = Math.min(len - 1, pos + reach);
        for (let k = lo; k <= hi; k++) dst[i + (k - pos) * step] = 1;
      }
      return dst;
    };
    close = spread(spread(near, 1, w), w, h);
  }
  for (const { idx, target } of picked) {
    const t = common === null ? target : Math.min(target, common);
    for (const i of idx) if (out[i] > t && (!close || close[i])) out[i] = t;
  }
  return out;
}

// The out-of-focus glow around a near object makes the depth measured on the
// background next to it come out too near: a halo. A large, flat object
// (a wall, a floor, a table top) is fitted with a plane, robustly, so the
// halo does not pull the fit; depth close to the object's outline that is
// off the plane is put back on it. Objects that are not flat (the fit's
// scatter is large) and small objects are left alone.
export function flattenHalos(depth, objects, w, h, { minShare = 0.03, band = 45, off = 0.12, flat = 0.3 } = {}) {
  const n = w * h;
  const out = Float32Array.from(depth);
  const pixels = new Map();
  for (let i = 0; i < n; i++) {
    const l = objects[i];
    if (!l) continue;
    if (!pixels.has(l)) pixels.set(l, []);
    pixels.get(l).push(i);
  }
  for (const [label, ids] of pixels) {
    if (ids.length < minShare * n) continue;
    // Robust plane d = a x + b y + c (x, y in 0..1 of the picture).
    // Start from the median depth, so the halo cannot tilt the first fit.
    const start = Float32Array.from(ids, (i) => depth[i]).sort();
    const median = start[start.length >> 1];
    const spread = Float32Array.from(ids, (i) => Math.abs(depth[i] - median)).sort()[ids.length >> 1];
    let wts = Float32Array.from(ids, (i) => (Math.abs(depth[i] - median) < Math.max(0.05, 2.5 * spread) ? 1 : 0.02));
    let plane = [0, 0, median];
    let mad = spread;
    for (let it = 0; it < 8; it++) {
      let sxx = 0, sxy = 0, sx = 0, syy = 0, sy = 0, s1 = 0, sxd = 0, syd = 0, sd = 0;
      ids.forEach((i, k) => {
        if (k % 3) return;
        const x = (i % w) / w;
        const y = Math.floor(i / w) / h;
        const wt = wts[k];
        sxx += wt * x * x; sxy += wt * x * y; sx += wt * x; syy += wt * y * y; sy += wt * y; s1 += wt;
        sxd += wt * x * depth[i]; syd += wt * y * depth[i]; sd += wt * depth[i];
      });
      const det = (m) => m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
      const A = [sxx, sxy, sx, sxy, syy, sy, sx, sy, s1];
      const D = det(A);
      if (Math.abs(D) < 1e-9) break;
      const col = (c, v) => { const m = A.slice(); m[c] = v[0]; m[c + 3] = v[1]; m[c + 6] = v[2]; return det(m) / D; };
      const rhs = [sxd, syd, sd];
      plane = [col(0, rhs), col(1, rhs), col(2, rhs)];
      const res = ids.map((i) => Math.abs(depth[i] - (plane[0] * ((i % w) / w) + plane[1] * (Math.floor(i / w) / h) + plane[2])));
      const sorted = Float32Array.from(res).sort();
      mad = sorted[sorted.length >> 1];
      const c = Math.max(0.05, 2.5 * mad);
      wts = Float32Array.from(res, (r) => (r < c ? 1 : (c / r) ** 2));
    }
    if (mad > flat) continue;
    // Distance to the outline (to the nearest pixel of another object), roughly.
    const near = new Uint8Array(n);
    for (const i of ids) {
      const x = i % w;
      const y = (i - x) / w;
      if ((x > 0 && objects[i - 1] !== label) || (x < w - 1 && objects[i + 1] !== label) || (y > 0 && objects[i - w] !== label) || (y < h - 1 && objects[i + w] !== label)) near[i] = 1;
    }
    const dist = new Float32Array(n).fill(Infinity);
    const queue = [];
    for (const i of ids) if (near[i]) { dist[i] = 0; queue.push(i); }
    for (let head = 0; head < queue.length; head++) {
      const i = queue[head];
      if (dist[i] >= band) continue;
      const x = i % w;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i >= w ? i - w : -1, i < n - w ? i + w : -1]) {
        if (j >= 0 && objects[j] === label && dist[j] === Infinity) { dist[j] = dist[i] + 1; queue.push(j); }
      }
    }
    for (const i of ids) {
      if (dist[i] > band) continue;
      const p = plane[0] * ((i % w) / w) + plane[1] * (Math.floor(i / w) / h) + plane[2];
      if (Math.abs(depth[i] - p) > off) out[i] = p;
    }
  }
  return out;
}

// Box mean over a (2r + 1) square, edges clamped (summed area table).
function boxMean(a, w, h, r) {
  const sat = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += a[y * w + x];
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
      out[y * w + x] = (sat[y1 * (w + 1) + x1] - sat[y0 * (w + 1) + x1] - sat[y1 * (w + 1) + x0] + sat[y0 * (w + 1) + x0]) / ((x1 - x0) * (y1 - y0));
    }
  }
  return out;
}

// Guided filter (He et al.): each depth becomes a local linear function of
// the photo's brightness (the Lab L channel in `lab`, 0..1 here), so depth
// edges lie on the photo's edges and follow them smoothly, instead of
// following the staircase of the regions.
export function guidedFilter(depth, lab, w, h, r = 6, eps = 0.004) {
  const n = w * h;
  const I = new Float32Array(n);
  for (let i = 0; i < n; i++) I[i] = lab[3 * i] / 100;
  const II = new Float32Array(n);
  const Ip = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    II[i] = I[i] * I[i];
    Ip[i] = I[i] * depth[i];
  }
  const mI = boxMean(I, w, h, r);
  const mp = boxMean(depth, w, h, r);
  const mII = boxMean(II, w, h, r);
  const mIp = boxMean(Ip, w, h, r);
  const a = new Float32Array(n);
  const b = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const varI = mII[i] - mI[i] * mI[i];
    a[i] = (mIp[i] - mI[i] * mp[i]) / (varI + eps);
    b[i] = mp[i] - a[i] * mI[i];
  }
  const ma = boxMean(a, w, h, r);
  const mb = boxMean(b, w, h, r);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = ma[i] * I[i] + mb[i];
  return out;
}

// The guided filter for a depth map without region cleanup (normal
// quality): the guide is the picture's brightness (`rgb`, 0..1, 3 per pixel).
export function guidedFilterColor(depth, rgb, w, h, r = 5, eps = 0.003) {
  const lab = new Float32Array(w * h * 3);
  for (let p = 0; p < w * h; p++) toLab(rgb[3 * p], rgb[3 * p + 1], rgb[3 * p + 2], lab, 3 * p);
  return guidedFilter(depth, lab, w, h, r, eps);
}

// Normal quality depth: the edges of near objects follow the picture's. Where
// the depth spans a lot within a few pixels (a near wire against a far wall)
// each pixel takes the layer whose color it is closer to (layerSnap), then a
// vote among like colored neighbors straightens the border (colorMedian).
// `rgb`: the picture, 0..1, 3 per pixel.
export const EDGE_SNAP_DEPTH = { on: false, passes: 2, layer: { radius: 20, stride: 3, band: 0.2, hard: true } };
export function snapDepthEdges(depth, rgb, w, h) {
  if (!EDGE_SNAP_DEPTH.on) return depth;
  const lab = new Float32Array(w * h * 3);
  for (let p = 0; p < w * h; p++) toLab(rgb[3 * p], rgb[3 * p + 1], rgb[3 * p + 2], lab, 3 * p);
  let d = layerSnap(depth, lab, w, h, EDGE_SNAP_DEPTH.layer);
  for (let i = 0; i < EDGE_SNAP_DEPTH.passes; i++) d = colorMedian(d, lab, w, h);
  return d;
}

// Halos: depth measured next to a near thin object (a wire) comes out in
// between the object's and the background's. Each depth becomes the median
// of its neighbours' depths, counting those of the same color as the pixel
// (in Lab) most, so a pixel with the wire's color takes the wire's depth and
// one with the background's takes the background's: depth edges lie on the
// picture's color edges, at full sharpness.
export function colorMedian(depth, lab, w, h, r = 7, sigma = 9, levels = 128) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const d of depth) {
    if (d < lo) lo = d;
    if (d > hi) hi = d;
  }
  if (!(hi > lo)) return depth;
  const n = w * h;
  const q = new Uint8Array(n);
  for (let i = 0; i < n; i++) q[i] = Math.min(levels - 1, Math.floor(((depth[i] - lo) / (hi - lo)) * levels));
  // Weight by squared color distance, tabulated.
  const STEP = 4;
  const lut = new Float32Array(256);
  for (let i = 0; i < 256; i++) lut[i] = Math.exp(-(i * STEP) / (2 * sigma * sigma));
  const side = 2 * r + 1;
  const spatial = new Float32Array(side * side);
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) spatial[(dy + r) * side + dx + r] = Math.exp(-(dx * dx + dy * dy) / (2 * (r * 0.7) ** 2));
  const hist = new Float32Array(levels);
  const out = new Float32Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      hist.fill(0);
      let total = 0;
      const l0 = lab[3 * p];
      const a0 = lab[3 * p + 1];
      const b0 = lab[3 * p + 2];
      for (let dy = -r; dy <= r; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -r; dx <= r; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const j = yy * w + xx;
          const dl = lab[3 * j] - l0;
          const da = lab[3 * j + 1] - a0;
          const db = lab[3 * j + 2] - b0;
          const wt = spatial[(dy + r) * side + dx + r] * lut[Math.min(255, ((dl * dl + da * da + db * db) / STEP) | 0)];
          hist[q[j]] += wt;
          total += wt;
        }
      }
      let acc = 0;
      let k = 0;
      while (k < levels - 1 && acc + hist[k] < total / 2) acc += hist[k++];
      out[p] = q[p] === k ? depth[p] : lo + ((k + 0.5) / levels) * (hi - lo);
    }
  }
  return out;
}

// Two layers at a depth edge. Where the depth within `radius` pixels spans
// a lot (a near wire against a far wall), each pixel whose depth lies between
// the two ends is given the depth of the layer whose color it is closer to:
// the near layer's mean color is that of the nearest quarter of the depths
// around, the far layer's that of the farthest quarter. Halos next to thin
// near objects, where the measured depth is in between, are put on one
// layer or the other by the picture, with a hard edge.
export function layerSnap(depth, lab, w, h, { radius = 12, stride = 2, minRange = 0.25, band = 0.3, margin = 1.4, hard = false } = {}) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const d of depth) {
    if (d < lo) lo = d;
    if (d > hi) hi = d;
  }
  const total = hi - lo;
  if (!(total > 0)) return depth;
  const out = Float32Array.from(depth);
  const near = [];
  const far = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      let wlo = Infinity;
      let whi = -Infinity;
      for (let dy = -radius; dy <= radius; dy += stride) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -radius; dx <= radius; dx += stride) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const d = depth[yy * w + xx];
          if (d < wlo) wlo = d;
          if (d > whi) whi = d;
        }
      }
      const range = whi - wlo;
      if (range < minRange * total) continue;
      const d0 = depth[p];
      const t = (d0 - wlo) / range;
      if (t < band || t > 1 - band) continue;
      // Mean colors of the two ends.
      let nL = 0, nA = 0, nB = 0, nC = 0, nD = 0, fL = 0, fA = 0, fB = 0, fC = 0, nVal = 0, fVal = 0;
      for (let dy = -radius; dy <= radius; dy += stride) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -radius; dx <= radius; dx += stride) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const j = yy * w + xx;
          const u = (depth[j] - wlo) / range;
          if (u > 1 - band * 0.6) {
            nL += lab[3 * j]; nA += lab[3 * j + 1]; nB += lab[3 * j + 2]; nC++; nVal += depth[j];
          } else if (u < band * 0.6) {
            fL += lab[3 * j]; fA += lab[3 * j + 1]; fB += lab[3 * j + 2]; fC++; fVal += depth[j];
          }
        }
      }
      if (!nC || !fC) continue;
      const dn = (lab[3 * p] - nL / nC) ** 2 + (lab[3 * p + 1] - nA / nC) ** 2 + (lab[3 * p + 2] - nB / nC) ** 2;
      const df = (lab[3 * p] - fL / fC) ** 2 + (lab[3 * p + 1] - fA / fC) ** 2 + (lab[3 * p + 2] - fB / fC) ** 2;
      if (dn * margin < df) out[p] = nVal / nC;
      else if (df * margin < dn) out[p] = fVal / fC;
      // Colors too alike to tell: by depth, whichever layer it is nearer to,
      // so no pixel is left halfway between (which would render out of focus).
      else if (hard) out[p] = t > 0.5 ? nVal / nC : fVal / fC;
    }
  }
  return out;
}
