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
export function segmentDepth(alpha, confidence, rgb, w, h, { count = 2500, compactness = 8, strength = 1, iterations = 30, colorSigma = 8, plateau = 0.012, edge = 0.25, objects = null } = {}) {
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
  if (!objects) return smoothRamps(smoothSteps(out, lab, w, h, edge), lab, w, h, edge);
  // With objects known, an outline (not the size of a step) is what keeps
  // two sides apart, so depth flows freely within each object.
  return smoothRamps(snapToObjects(out, objects, w, h), lab, w, h, Infinity, objects, 8, 4, 10);
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
          const wt = Math.exp(-(dx * dx + dy * dy) / (2 * SIGMA * SIGMA) - (dl * dl + da * da + db * db) / 400 - (objects ? OBJECT_COST * signatureDistance(objects[p], objects[q]) : 0));
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
