// Removes the faint periodic pattern a full sensor render can keep (dots or
// lines with the lens spacing; see removeLatticePattern in superres.js for
// the part tied to the lens grid). What is left is a few narrow peaks in the
// picture's spectrum, far above the scene around them: about 500 times the
// surrounding level, against 30 to 75 in Lytro Desktop's pictures. Their
// frequencies are the same over the whole picture, so they are found once
// from a few tiles, then each is taken out where it is: demodulated against
// its own frequency over a small window (a lock-in), kept only to the extent
// it stands out from the level at nearby frequencies, and subtracted. The
// picture around the peaks is left alone.

export const NOTCH = { on: true, tile: 256, tiles: 40, prominence: 25, maxPeaks: 10, windowPeriods: 6, noiseGain: 1.0, block: 4 };

// In-place radix 2 FFT of n complex values (re, im), n a power of two.
function fft(re, im, n, inverse = false) {
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci;
        const ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

// Box mean of radius r along rows (horizontal) or columns, borders clamped.
function boxMean(src, W, H, r, horizontal) {
  const out = new Float32Array(W * H);
  const len = horizontal ? W : H;
  const stride = horizontal ? 1 : W;
  const lines = horizontal ? H : W;
  const step = horizontal ? W : 1;
  const w = 2 * r + 1;
  for (let l = 0; l < lines; l++) {
    const base = l * step;
    let sum = 0;
    for (let t = -r; t <= r; t++) sum += src[base + Math.min(len - 1, Math.max(0, t)) * stride];
    for (let t = 0; t < len; t++) {
      out[base + t * stride] = sum / w;
      sum += src[base + Math.min(len - 1, t + r + 1) * stride] - src[base + Math.max(0, t - r) * stride];
    }
  }
  return out;
}

// Peaks of the spectrum of `Y` (W x H): [{ fx, fy, prominence }] in cycles per
// pixel, each pair of mirrored peaks once. Empty when there is none.
export function findPeriodicPeaks(Y, W, H, { tile = NOTCH.tile, tiles = NOTCH.tiles, prominence = NOTCH.prominence, maxPeaks = NOTCH.maxPeaks } = {}) {
  if (W < 2 * tile || H < 2 * tile) return [];
  const n = tile;
  const power = new Float64Array(n * n);
  const hann = Float32Array.from({ length: n }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)));
  // A fixed generator: the same picture gives the same peaks.
  let seed = 12345;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const re = new Float64Array(n * n);
  const im = new Float64Array(n * n);
  const rowRe = new Float64Array(n);
  const rowIm = new Float64Array(n);
  for (let t = 0; t < tiles; t++) {
    const x0 = Math.floor(rand() * (W - n));
    const y0 = Math.floor(rand() * (H - n));
    let mean = 0;
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) mean += Y[(y0 + y) * W + x0 + x];
    mean /= n * n;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        re[y * n + x] = (Y[(y0 + y) * W + x0 + x] - mean) * hann[x] * hann[y];
        im[y * n + x] = 0;
      }
    }
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        rowRe[x] = re[y * n + x];
        rowIm[x] = im[y * n + x];
      }
      fft(rowRe, rowIm, n);
      for (let x = 0; x < n; x++) {
        re[y * n + x] = rowRe[x];
        im[y * n + x] = rowIm[x];
      }
    }
    for (let x = 0; x < n; x++) {
      for (let y = 0; y < n; y++) {
        rowRe[y] = re[y * n + x];
        rowIm[y] = im[y * n + x];
      }
      fft(rowRe, rowIm, n);
      for (let y = 0; y < n; y++) power[y * n + x] += rowRe[y] * rowRe[y] + rowIm[y] * rowIm[y];
    }
  }
  // Spectrum with the zero frequency in the middle.
  const half = n >> 1;
  const P = new Float64Array(n * n);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) P[((y + half) % n) * n + ((x + half) % n)] = power[y * n + x];
  // Level around each frequency: the median of the ring at its radius.
  const ringMedian = new Float64Array(half + 8);
  const rings = Array.from({ length: half + 8 }, () => []);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const r = Math.round(Math.hypot(y - half, x - half));
    if (r < rings.length) rings[r].push(P[y * n + x]);
  }
  rings.forEach((a, r) => {
    a.sort((p, q) => p - q);
    ringMedian[r] = a.length ? a[a.length >> 1] : 1;
  });
  const order = Array.from({ length: n * n }, (_, i) => i).sort((p, q) => P[q] - P[p]).slice(0, 4000);
  const taken = new Uint8Array(n * n);
  const found = [];
  for (const i of order) {
    const py = Math.floor(i / n);
    const px = i % n;
    const r = Math.hypot(py - half, px - half);
    if (r < 12 || r >= half - 2 || taken[i]) continue;
    const prom = P[i] / Math.max(1e-30, ringMedian[Math.round(r)]);
    if (prom < prominence) continue;
    if (px < 1 || py < 1 || px >= n - 1 || py >= n - 1) continue;
    // Parabola through the log power around the peak, for a frequency between bins.
    const lg = (yy, xx) => Math.log(P[yy * n + xx] + 1e-30);
    const par = (a, b, c) => {
      const d = a - 2 * b + c;
      return d === 0 ? 0 : (0.5 * (a - c)) / d;
    };
    const fx = (px + par(lg(py, px - 1), lg(py, px), lg(py, px + 1)) - half) / n;
    const fy = (py + par(lg(py - 1, px), lg(py, px), lg(py + 1, px)) - half) / n;
    found.push({ fx, fy, prominence: prom });
    for (let yy = Math.max(0, py - 4); yy <= Math.min(n - 1, py + 4); yy++) for (let xx = Math.max(0, px - 4); xx <= Math.min(n - 1, px + 4); xx++) taken[yy * n + xx] = 1;
    // Its mirror image is the same real component.
    const my = (n - py) % n;
    const mx = (n - px) % n;
    for (let yy = Math.max(0, my - 4); yy <= Math.min(n - 1, my + 4); yy++) for (let xx = Math.max(0, mx - 4); xx <= Math.min(n - 1, mx + 4); xx++) taken[yy * n + xx] = 1;
    if (found.length >= maxPeaks) break;
  }
  return found;
}

// cos and sin of 2 pi f t for t = 0..len-1.
function phaseTable(f, len) {
  const c = new Float32Array(len);
  const s = new Float32Array(len);
  for (let t = 0; t < len; t++) {
    c[t] = Math.cos(2 * Math.PI * f * t);
    s[t] = Math.sin(2 * Math.PI * f * t);
  }
  return { c, s };
}

// The local amplitude of the component at (fx, fy) in `hp`: demodulated, summed
// over blocks of `block` pixels and smoothed by a Gaussian of `sigma` pixels
// on the block grid. Returns { a, b, bw, bh } (cos and sin amplitudes per block).
function demodulate(hp, W, H, fx, fy, block, sigma, stride = 1) {
  const tx = phaseTable(fx, W);
  const ty = phaseTable(fy, H);
  const bw = Math.ceil(W / block);
  const bh = Math.ceil(H / block);
  const a = new Float32Array(bw * bh);
  const b = new Float32Array(bw * bh);
  const cnt = new Float32Array(bw * bh);
  for (let y = 0; y < H; y += stride) {
    const by = Math.floor(y / block) * bw;
    const cy = ty.c[y];
    const sy = ty.s[y];
    for (let x = 0; x < W; x += stride) {
      const v = hp[y * W + x];
      const k = by + Math.floor(x / block);
      a[k] += v * (tx.c[x] * cy - tx.s[x] * sy);
      b[k] += v * (tx.s[x] * cy + tx.c[x] * sy);
      cnt[k]++;
    }
  }
  for (let i = 0; i < a.length; i++) {
    a[i] = (2 * a[i]) / Math.max(1, cnt[i]);
    b[i] = (2 * b[i]) / Math.max(1, cnt[i]);
  }
  const s = Math.max(0.6, sigma / block);
  const r = Math.ceil(3 * s);
  const kern = Float32Array.from({ length: 2 * r + 1 }, (_, i) => Math.exp(-((i - r) ** 2) / (2 * s * s)));
  const ks = kern.reduce((p, q) => p + q, 0);
  const blur = (src) => {
    const tmp = new Float32Array(src.length);
    const out = new Float32Array(src.length);
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        let t = 0;
        for (let k = -r; k <= r; k++) t += kern[k + r] * src[y * bw + Math.min(bw - 1, Math.max(0, x + k))];
        tmp[y * bw + x] = t / ks;
      }
    }
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        let t = 0;
        for (let k = -r; k <= r; k++) t += kern[k + r] * tmp[Math.min(bh - 1, Math.max(0, y + k)) * bw + x];
        out[y * bw + x] = t / ks;
      }
    }
    return out;
  };
  return { a: blur(a), b: blur(b), bw, bh };
}

// Linear RGB (W x H x 3) cleaned of its periodic pattern, in place. Works on
// the square root of the luma (the pattern follows the brightness) and scales
// the color by the change. Returns the peaks that were removed.
export function removePeriodicPattern(rgb, W, H, options = {}) {
  const P = { ...NOTCH, ...options };
  if (!P.on || W < 2 * P.tile || H < 2 * P.tile) return [];
  const n = W * H;
  const Y = new Float32Array(n);
  for (let i = 0; i < n; i++) Y[i] = Math.sqrt(Math.max(0, 0.2126 * rgb[3 * i] + 0.7152 * rgb[3 * i + 1] + 0.0722 * rgb[3 * i + 2]));
  const peaks = findPeriodicPeaks(Y, W, H, P);
  if (!peaks.length) return [];
  const out = Float32Array.from(Y);
  for (const { fx, fy } of peaks) {
    const f = Math.hypot(fx, fy);
    // High pass: the mean over a window several periods across has none of it.
    const r = Math.max(3, Math.round(1.5 / f));
    const lowpass = boxMean(boxMean(Y, W, H, r, true), W, H, r, false);
    const hp = new Float32Array(n);
    for (let i = 0; i < n; i++) hp[i] = Y[i] - lowpass[i];
    const sigma = P.windowPeriods / f;
    const main = demodulate(hp, W, H, fx, fy, P.block, sigma);
    // The level at nearby frequencies: what a real texture there would give.
    const d = 0.13 * f;
    const stride = n > 8e6 ? 2 : 1;
    const noise = [[d, 0], [-d, 0], [0, d], [0, -d]].map(([dx, dy]) => demodulate(hp, W, H, fx + dx, fy + dy, P.block, sigma, stride));
    const { bw, bh } = main;
    const amp = new Float32Array(bw * bh);
    const ka = new Float32Array(bw * bh);
    const kb = new Float32Array(bw * bh);
    for (let i = 0; i < bw * bh; i++) {
      const m = Math.hypot(main.a[i], main.b[i]);
      let z = 0;
      for (const q of noise) z += Math.hypot(q.a[i], q.b[i]) / noise.length;
      const keep = m > 1e-9 ? Math.max(0, Math.min(1, (m - P.noiseGain * z) / m)) : 0;
      amp[i] = m;
      ka[i] = main.a[i] * keep;
      kb[i] = main.b[i] * keep;
    }
    const at = (map, x, y) => {
      const fxb = Math.min(bw - 1, Math.max(0, (x + 0.5) / P.block - 0.5));
      const fyb = Math.min(bh - 1, Math.max(0, (y + 0.5) / P.block - 0.5));
      const x0 = Math.floor(fxb);
      const y0 = Math.floor(fyb);
      const x1 = Math.min(bw - 1, x0 + 1);
      const y1 = Math.min(bh - 1, y0 + 1);
      const ax = fxb - x0;
      const ay = fyb - y0;
      return (map[y0 * bw + x0] * (1 - ax) + map[y0 * bw + x1] * ax) * (1 - ay) + (map[y1 * bw + x0] * (1 - ax) + map[y1 * bw + x1] * ax) * ay;
    };
    const tx = phaseTable(fx, W);
    const ty = phaseTable(fy, H);
    for (let y = 0; y < H; y++) {
      const cy = ty.c[y];
      const sy = ty.s[y];
      for (let x = 0; x < W; x++) {
        const c = tx.c[x] * cy - tx.s[x] * sy;
        const sn = tx.s[x] * cy + tx.c[x] * sy;
        out[y * W + x] -= at(ka, x, y) * c + at(kb, x, y) * sn;
      }
    }
  }
  for (let i = 0; i < n; i++) {
    const before = Y[i] * Y[i];
    const after = Math.max(0, out[i]) ** 2;
    const k = before > 1e-8 ? after / before : 1;
    rgb[3 * i] *= k;
    rgb[3 * i + 1] *= k;
    rgb[3 * i + 2] *= k;
  }
  return peaks;
}

// removePeriodicPattern repeated while it still finds peaks (at most `passes` times). One pass takes out the peaks it finds, but removing the strongest ones shows weaker ones
// next to them (a pattern whose period drifts with depth, as in a blurred background at 3x, is a family of close peaks), and it takes at most `maxPeaks` at a time. Returns every
// peak that was removed.
export function removePeriodicPatternRepeatedly(rgb, W, H, options = {}, passes = 3) {
  const all = [];
  for (let k = 0; k < passes; k++) {
    const found = removePeriodicPattern(rgb, W, H, options);
    if (!found.length) break;
    all.push(...found);
  }
  return all;
}

// The lattice pattern's leftovers, taken out tile by tile in the frequency domain. Where the lens grid's sampling does not meet at the picture's depth (a blurred background at
// 3x) the pattern is not a few sharp peaks but a family of close ones whose frequency drifts from place to place, and removePeriodicPattern leaves most of its energy. Here
// each 128 x 128 tile (half overlapping, Hann windowed) is transformed and, in the ring of frequencies where the picture as a whole has its periodic peaks (the radius of the
// peaks findPeriodicPeaks finds, give or take 0.05 cycles per pixel), every bin that stands out above the bins around it is pulled down to `ratio` times their level. Smooth
// detail has a smooth spectrum and is left alone; a lattice is a set of spikes. Works like removePeriodicPattern: on the square root of the luma, the color scaled by the
// change; in place. Returns the number of peaks that set the ring (0: no pattern, nothing done).
export function removeLatticeByTiles(rgb, W, H, { ratio = 0.8, tile = 128, prominence = 6, maxSeeds = 48, margin = 0.05, around = 4 } = {}) {
  if (W < 2 * tile || H < 2 * tile) return 0;
  const n = W * H;
  const Y = new Float32Array(n);
  for (let i = 0; i < n; i++) Y[i] = Math.sqrt(Math.max(0, 0.2126 * rgb[3 * i] + 0.7152 * rgb[3 * i + 1] + 0.0722 * rgb[3 * i + 2]));
  const seeds = findPeriodicPeaks(Y, W, H, { prominence, maxPeaks: maxSeeds, tiles: 80 }).filter((p) => Math.hypot(p.fx, p.fy) > 0.08);
  if (!seeds.length) return 0;
  const T = tile;
  const step = T / 2;
  const radii = seeds.map((p) => Math.hypot(p.fx, p.fy));
  const rLo = Math.max(0.08, Math.min(...radii) - margin);
  const rHi = Math.min(0.5, Math.max(...radii) + margin);
  const hann = Float64Array.from({ length: T }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / T));
  const re = new Float64Array(T * T);
  const im = new Float64Array(T * T);
  const mag = new Float64Array(T * T);
  const rowRe = new Float64Array(T);
  const rowIm = new Float64Array(T);
  const out = new Float64Array(n);
  const weight = new Float64Array(n);
  const wrap = (v) => ((v % T) + T) % T;
  // the bins in the ring (half of them: each is clipped with its mirror image), and for each the bins around it that give the level
  const ringBins = [];
  for (let v = 0; v <= T / 2; v++) {
    for (let u = -T / 2; u < T / 2; u++) {
      if (v === 0 && u <= 0) continue;
      const r = Math.hypot(u, v) / T;
      if (r < rLo || r > rHi) continue;
      const neighbours = [];
      for (let d = -around; d <= around; d++) {
        neighbours.push(wrap(v - around) * T + wrap(u + d), wrap(v + around) * T + wrap(u + d));
        if (Math.abs(d) < around) neighbours.push(wrap(v + d) * T + wrap(u - around), wrap(v + d) * T + wrap(u + around));
      }
      ringBins.push({ bin: wrap(v) * T + wrap(u), mirror: wrap(-v) * T + wrap(-u), neighbours });
    }
  }
  const levels = new Float64Array(64);
  for (let ty = -step; ty < H; ty += step) {
    for (let tx = -step; tx < W; tx += step) {
      let mean = 0;
      for (let y = 0; y < T; y++) {
        const yy = Math.min(H - 1, Math.max(0, ty + y));
        for (let x = 0; x < T; x++) mean += Y[yy * W + Math.min(W - 1, Math.max(0, tx + x))];
      }
      mean /= T * T;
      for (let y = 0; y < T; y++) {
        const yy = Math.min(H - 1, Math.max(0, ty + y));
        for (let x = 0; x < T; x++) {
          re[y * T + x] = (Y[yy * W + Math.min(W - 1, Math.max(0, tx + x))] - mean) * hann[x] * hann[y];
          im[y * T + x] = 0;
        }
      }
      for (let y = 0; y < T; y++) {
        for (let x = 0; x < T; x++) { rowRe[x] = re[y * T + x]; rowIm[x] = im[y * T + x]; }
        fft(rowRe, rowIm, T);
        for (let x = 0; x < T; x++) { re[y * T + x] = rowRe[x]; im[y * T + x] = rowIm[x]; }
      }
      for (let x = 0; x < T; x++) {
        for (let y = 0; y < T; y++) { rowRe[y] = re[y * T + x]; rowIm[y] = im[y * T + x]; }
        fft(rowRe, rowIm, T);
        for (let y = 0; y < T; y++) { re[y * T + x] = rowRe[y]; im[y * T + x] = rowIm[y]; }
      }
      for (let i = 0; i < T * T; i++) mag[i] = Math.hypot(re[i], im[i]);
      for (const { bin, mirror, neighbours } of ringBins) {
        const m = neighbours.length;
        for (let k = 0; k < m; k++) levels[k] = mag[neighbours[k]];
        const part = levels.subarray(0, m);
        part.sort();
        const limit = ratio * part[m >> 1];
        if (mag[bin] > limit && mag[bin] > 0) {
          const k = limit / mag[bin];
          re[bin] *= k;
          im[bin] *= k;
          re[mirror] *= k;
          im[mirror] *= k;
        }
      }
      for (let x = 0; x < T; x++) {
        for (let y = 0; y < T; y++) { rowRe[y] = re[y * T + x]; rowIm[y] = im[y * T + x]; }
        fft(rowRe, rowIm, T, true);
        for (let y = 0; y < T; y++) { re[y * T + x] = rowRe[y]; im[y * T + x] = rowIm[y]; }
      }
      for (let y = 0; y < T; y++) {
        for (let x = 0; x < T; x++) { rowRe[x] = re[y * T + x]; rowIm[x] = im[y * T + x]; }
        fft(rowRe, rowIm, T, true);
        const yy = ty + y;
        if (yy < 0 || yy >= H) continue;
        for (let x = 0; x < T; x++) {
          const xx = tx + x;
          if (xx < 0 || xx >= W) continue;
          out[yy * W + xx] += rowRe[x] / (T * T) + mean * hann[x] * hann[y];
          weight[yy * W + xx] += hann[x] * hann[y];
        }
      }
    }
  }
  for (let i = 0; i < n; i++) {
    if (!(weight[i] > 1e-3)) continue;
    if (Y[i] > 1e-4) {
      const k = Math.max(0.25, Math.min(4, (Math.max(0, out[i] / weight[i]) / Y[i]) ** 2));
      rgb[3 * i] *= k;
      rgb[3 * i + 1] *= k;
      rgb[3 * i + 2] *= k;
    }
  }
  return seeds.length;
}
