// The engine's noise reduction (Lytro Desktop runs a third-party denoising library, NILib, on the picture after the colour matrix and before the tone curve),
// ported from its machine code. The library works on three planes (0..255): a luma / two chroma planes (BT.601 YCbCr here), each through a three level pyramid;
// at every level the band is normalized by a per pixel noise sigma (from per-camera lookup tables and the 2x2-averaged picture), then eight (luma) or four (chroma)
// directional box filters along lines of different slopes find the direction in which the band is smoothest, and the band is replaced by a blend of the
// directional estimate and the residual weighted by how noise-like each is. 96 px tiles with 16 px of context.
// Verified against the library tile by tile (every helper, every level and channel call, and whole pictures of many sizes): see docs/lytro-re-notes.md.
// Known difference: straight lines no longer than the filter radius (only at the coarsest level of strips 1-3 px wide) follow the library's out-of-range reads.
import { ENGINE_NR_PROFILES } from './enginenr-profiles.js';

const f32 = Math.fround;
const PI2 = f32(1.5707963705062866);
const MODE2 = { angles: [0, 1.5707964, 0.7853982, 2.3561945, 0.4636476, 2.0344439, 1.1071488, 2.677945], slopes: [0, 0, 1.0, 0.9999999403953552, 0.5, 0.49999985098838806, 0.5, 0.5000002980232239], perp: [1, 0, 3, 2, 1, 0, 0, 1], alt: [-1, -1, -1, -1, 0, 1, 1, 0], altr: 1, radius: 4, ndirs: 8 };
const MODE1 = { angles: [0, 1.5707964, 0.7853982, 2.3561945], slopes: [0, 0, 1.0, 0.9999999403953552], perp: [1, 0, 3, 2], alt: [-1, -1, -1, -1], altr: 1, radius: 3, ndirs: 4 };
const MODES = { 1: MODE1, 2: MODE2 };
// ---- digital lines (FUN_18002e5b0) ----
function makeLine(w, h, angle, slope) {
  const a = f32(angle);
  if (Math.abs(a) < 0.01) return { flagH: true, flagV: false, table: null, recs: null, nrec: 0 };
  if (Math.abs(PI2 - a) < 0.01) return { flagH: false, flagV: true, table: null, recs: null, nrec: 0 };
  const mirrored = a > PI2;
  const fold = mirrored ? f32(3.1415927410125732 - a) : a;
  const steep = 0.7853981633974483 < fold;
  const arg = steep ? f32(PI2 - fold) : fold;
  const s = slope === undefined ? f32(Math.tan(arg)) : f32(slope);
  const n = steep ? h : w;
  const al = new Int32Array(n);
  for (let k = 0; k < n; k++) al[k] = rint(f32(f32(k * s) + 0.25));
  const table = new Int32Array(n);
  const recs = [];
  if (steep) {
    for (let k = 0; k < h; k++) table[k] = mirrored ? al[k] + w * (h - 1) - k * w : al[k] + k * w;
    for (let st = -al[h - 1]; st < w; st++) {
      let k0 = -1;
      let len = 0;
      for (let k = 0; k < h; k++) {
        const x = st + al[k];
        if (x >= 0 && x < w) {
          if (k0 < 0) k0 = k;
          len++;
        }
      }
      recs.push(st, k0, len);
    }
  } else {
    for (let k = 0; k < w; k++) table[k] = mirrored ? w - 1 + al[k] * w - k : al[k] * w + k;
    for (let row = -al[w - 1]; row < h; row++) {
      let k0 = -1;
      let len = 0;
      for (let k = 0; k < w; k++) {
        const y = row + al[k];
        if (y >= 0 && y < h) {
          if (k0 < 0) k0 = k;
          len++;
        }
      }
      recs.push(row * w, k0, len);
    }
  }
  return { flagH: false, flagV: false, table, recs: Int32Array.from(recs), nrec: recs.length / 3 };
}
// round half to even (what the library's ROUND does)
function rint(x) {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

class LineSet {
  constructor(w, h, mode) {
    this.w = w;
    this.h = h;
    this.m = mode;
    this.dirs = mode.angles.map((a, i) => makeLine(w, h, a, mode.slopes[i]));
    this.H = makeLine(w, h, 0);
    this.V = makeLine(w, h, PI2);
  }
}
const lineCache = new Map();
function lineSet(w, h, mi) {
  const key = `${w}x${h}:${mi}`;
  let l = lineCache.get(key);
  if (!l) {
    if (lineCache.size > 64) lineCache.clear();
    lineCache.set(key, (l = new LineSet(w, h, MODES[mi])));
  }
  return l;
}

// ---- directional box mean (FUN_1800288c0): mirror reflection on straight lines, truncated window on diagonals ----
const tmpLine = new Float64Array(8192);
const tmpOut = new Float32Array(8192);
function lineFilt(src, dst, w, h, line, r) {
  if (r === 0) {
    dst.set(src.subarray(0, w * h));
    return;
  }
  if (line.flagH || line.flagV) {
    const len = line.flagH ? w : h;
    const cnt = line.flagH ? h : w;
    const step = line.flagH ? 1 : w;
    const lstep = line.flagH ? w : 1;
    const inv = 1 / (2 * r + 1);
    if (len === 1) {
      for (let c = 0; c < cnt; c++) dst[c * lstep] = f32(src[c * lstep] * inv);
      return;
    }
    const P = 2 * (len - 1);
    for (let c = 0; c < cnt; c++) {
      const base = c * lstep;
      for (let i = 0; i < len; i++) {
        let s = 0;
        for (let j = i - r; j <= i + r; j++) {
          let k = j % P;
          if (k < 0) k += P;
          if (k >= len) k = P - k;
          s += src[base + k * step];
        }
        dst[base + i * step] = f32(s * inv);
      }
    }
    return;
  }
  const { table, recs, nrec } = line;
  for (let q = 0; q < nrec; q++) {
    const st = recs[3 * q];
    const t0 = recs[3 * q + 1];
    const len = recs[3 * q + 2];
    let c = 0;
    // prefix sums of the line
    const pre = tmpLine;
    pre[0] = 0;
    for (let i = 0; i < len; i++) {
      c += src[st + table[t0 + i]];
      pre[i + 1] = c;
    }
    if (len < 2 * r + 1) {
      const m = f32(pre[len] / len);
      for (let i = 0; i < len; i++) dst[st + table[t0 + i]] = m;
    } else {
      for (let i = 0; i < len; i++) {
        const lo = i - r < 0 ? 0 : i - r;
        const hi = i + r > len - 1 ? len - 1 : i + r;
        dst[st + table[t0 + i]] = f32((pre[hi + 1] - pre[lo]) / (hi - lo + 1));
      }
    }
  }
}

// ---- per level denoise (FUN_1800231b0) ----
const fl = (b, o) => b.getFloat32(o, true);
function levelPass(X, S, M, idx, w, h, lvl, A, B, ls, mi) {
  const n = w * h;
  const m = MODES[mi];
  const nd = m.ndirs;
  const R4 = m.radius;
  const fA = f32(fl(A, 4 * lvl) + f32(1e-4));
  const B16 = fl(B, 0x10 + 4 * lvl);
  const Bc = fl(B, 0x120 + mi * 0xa0 + 4 * lvl);
  const Bd = fl(B, 0x130 + mi * 0xa0 + 4 * lvl);
  const g = fl(A, 0x10 + 4 * lvl);
  const flag47 = A.getUint8(0x47) === 1;
  const flag45 = A.getUint8(0x45) === 1;
  const flag46 = A.getUint8(0x46) === 1;
  const Z = new Float32Array(n);
  for (let i = 0; i < n; i++) Z[i] = f32(X[i] / f32(S[i] + f32(1e-4)));
  const t1 = new Float32Array(n);
  const t2 = new Float32Array(n);
  const sqInto = (a, o) => {
    for (let i = 0; i < n; i++) o[i] = f32(a[i] * a[i]);
  };
  const box3 = (a, o) => {
    sqInto(a, t1);
    lineFilt(t1, t2, w, h, ls.H, 1);
    lineFilt(t2, o, w, h, ls.V, 1);
  };
  const R = new Float32Array(n);
  box3(Z, R);
  for (let i = 0; i < n; i++) R[i] = f32(Math.sqrt(Math.abs(R[i])));
  const limitInto = (a, b, p, o) => {
    const ip = f32(1 / p);
    for (let i = 0; i < n; i++) {
      const v = f32(Math.abs(b[i]) * ip);
      o[i] = v < 1 ? a[i] : f32(a[i] / v);
    }
  };
  const Zl = new Float32Array(n);
  limitInto(Z, R, f32(f32(3 * B16) * fA), Zl);
  const E = new Float32Array(nd * n);
  const V = new Float32Array(nd * n);
  const Md = new Float32Array(n);
  const Dd = new Float32Array(n);
  const Zd = new Float32Array(n);
  const Et = new Float32Array(n);
  const cdOff = 0xa0 + mi * 0xa0 + lvl * 0x20;
  const p2 = f32(f32(B16 * 0.5) * fA);
  for (let d = 0; d < nd; d++) {
    const L = ls.dirs[d];
    lineFilt(Zl, Md, w, h, L, R4);
    for (let i = 0; i < n; i++) Dd[i] = f32(Zl[i] - Md[i]);
    limitInto(Zl, Dd, p2, Zd);
    const Ed = E.subarray(d * n, (d + 1) * n);
    if (m.alt[d] === -1) lineFilt(Zd, Ed, w, h, L, R4);
    else {
      lineFilt(Zd, Et, w, h, L, R4);
      lineFilt(Et, Ed, w, h, ls.dirs[m.alt[d]], m.altr);
    }
    sqInto(Ed, t1);
    const Vd = V.subarray(d * n, (d + 1) * n);
    lineFilt(t1, Vd, w, h, ls.dirs[m.perp[d]], 1);
    const sc = f32(1 / fl(B, cdOff + 4 * d));
    for (let i = 0; i < n; i++) {
      const x = Math.abs(Vd[i]);
      Vd[i] = f32(f32(x * f32(1 / Math.sqrt(x + 1.1754943508222875e-38))) * sc);
    }
  }
  // best direction
  const best = new Uint8Array(n);
  const Vmax = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let bv = V[i];
    let bk = 0;
    for (let d = 1; d < nd; d++) {
      const v = V[d * n + i];
      if (v >= bv) {
        bv = v;
        bk = d;
      }
    }
    best[i] = bk;
    Vmax[i] = bv;
  }
  const k = f32(f32(f32(0.5) / fA) * f32(-4));
  const clampAff = (a, s, o) => {
    for (let i = 0; i < n; i++) {
      let v = f32(f32(a[i] * s) + 2.5);
      if (v < 0) v = 0;
      if (1 <= v) v = 1;
      o[i] = v;
    }
  };
  const Mout = M.slice();
  const idxOut = idx.slice();
  if (flag47) {
    const Wa = new Float32Array(n);
    clampAff(Vmax, k, Wa);
    const T = new Float32Array(n);
    for (let i = 0; i < n; i++) T[i] = f32(M[i] * Wa[i]);
    if (lvl !== 0) for (let i = 0; i < n; i++) Mout[i] = f32(f32(Wa[i] * -1) + 1);
    for (let i = 0; i < n; i++) {
      const prev = idx[i];
      idxOut[i] = best[i];
      const cand = f32(f32(T[i] + 1) * V[prev * n + i]);
      if (Vmax[i] <= cand && cand !== Vmax[i]) {
        Vmax[i] = cand;
        best[i] = prev;
      }
    }
  }
  const Eb = new Float32Array(n);
  for (let i = 0; i < n; i++) Eb[i] = E[best[i] * n + i];
  const Dn = new Float32Array(n);
  for (let i = 0; i < n; i++) Dn[i] = f32(Zl[i] - Eb[i]);
  const Wb = new Float32Array(n);
  clampAff(Vmax, k, Wb);
  const E2 = new Float32Array(n);
  for (let i = 0; i < n; i++) E2[i] = f32(Wb[i] * Eb[i]);
  const R2 = new Float32Array(n);
  box3(Dn, R2);
  for (let i = 0; i < n; i++) R2[i] = f32(Math.sqrt(Math.abs(R2[i])));
  if (flag45) for (let i = 0; i < n; i++) R2[i] = f32(R2[i] * f32(f32(Wb[i] * 0.5) + 0.5));
  const Wc = new Float32Array(n);
  clampAff(R2, f32(f32(f32(0.5) / f32(Bc * fA)) * f32(-4)), Wc);
  for (let i = 0; i < n; i++) E2[i] = f32(f32(Wc[i] * Dn[i]) + E2[i]);
  if (flag46) {
    const q = new Float32Array(n);
    limitInto(Dn, R, f32(B16 * fA), q);
    sqInto(q, t1);
    lineFilt(t1, t2, w, h, ls.H, 4);
    lineFilt(t2, t1, w, h, ls.V, 4);
    for (let i = 0; i < n; i++) t1[i] = f32(Math.sqrt(Math.abs(t1[i])));
    const Wd = new Float32Array(n);
    clampAff(t1, f32(f32(f32(0.5) / f32(Bd * fA)) * f32(-4)), Wd);
    for (let i = 0; i < n; i++) E2[i] = f32(Wd[i] * E2[i]);
  }
  const out = new Float32Array(n);
  const mg = f32(-g);
  for (let i = 0; i < n; i++) out[i] = f32(f32(E2[i] * mg) * S[i]);
  return { out, Mout, idxOut };
}

// ---- pyramid helpers ----
function down2(img, w, h) {
  const ww = w >> 1;
  const hh = h >> 1;
  const o = new Float32Array(ww * hh);
  for (let y = 0; y < hh; y++) {
    for (let x = 0; x < ww; x++) {
      const a = img[2 * y * w + 2 * x];
      const b = img[2 * y * w + 2 * x + 1];
      const c = img[(2 * y + 1) * w + 2 * x];
      const d = img[(2 * y + 1) * w + 2 * x + 1];
      o[y * ww + x] = f32(f32(f32(a + c) + b) + d) * 0.25;
    }
  }
  return o;
}
function upAxisX(src, w, h) {
  const o = new Float32Array(2 * w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = src[y * w + x];
      const p = src[y * w + (x > 0 ? x - 1 : 0)];
      const nx = src[y * w + (x < w - 1 ? x + 1 : w - 1)];
      o[y * 2 * w + 2 * x] = f32(f32(0.75 * v) + f32(0.25 * p));
      o[y * 2 * w + 2 * x + 1] = f32(f32(0.75 * v) + f32(0.25 * nx));
    }
  }
  return o;
}
function up2(src, w, h, oddW, oddH) {
  const a = upAxisX(src, w, h);
  const w2 = 2 * w;
  const o = new Float32Array(w2 * 2 * h);
  for (let y = 0; y < h; y++) {
    const ym = y > 0 ? y - 1 : 0;
    const yp = y < h - 1 ? y + 1 : h - 1;
    for (let x = 0; x < w2; x++) {
      const v = a[y * w2 + x];
      o[2 * y * w2 + x] = f32(f32(0.75 * v) + f32(0.25 * a[ym * w2 + x]));
      o[(2 * y + 1) * w2 + x] = f32(f32(0.75 * v) + f32(0.25 * a[yp * w2 + x]));
    }
  }
  return padOdd(o, w2, 2 * h, oddW, oddH, Float32Array);
}
function padOdd(src, w, h, oddW, oddH, T) {
  if (!oddW && !oddH) return src;
  const W = w + (oddW ? 1 : 0);
  const H = h + (oddH ? 1 : 0);
  const o = new T(W * H);
  for (let y = 0; y < H; y++) {
    const sy = y < h ? y : h - 1;
    for (let x = 0; x < W; x++) o[y * W + x] = src[sy * w + (x < w ? x : w - 1)];
  }
  return o;
}
function upBytes(src, w, h, oddW, oddH) {
  const w2 = 2 * w;
  const o = new Uint8Array(w2 * 2 * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const v = src[y * w + x];
    o[2 * y * w2 + 2 * x] = v;
    o[2 * y * w2 + 2 * x + 1] = v;
    o[(2 * y + 1) * w2 + 2 * x] = v;
    o[(2 * y + 1) * w2 + 2 * x + 1] = v;
  }
  return padOdd(o, w2, 2 * h, oddW, oddH, Uint8Array);
}
const cropOf = (img, w, ylo, xlo, rh, rw) => {
  const o = new img.constructor(rh * rw);
  for (let y = 0; y < rh; y++) o.set(img.subarray((ylo + y) * w + xlo, (ylo + y) * w + xlo + rw), y * rw);
  return o;
};

// ---- per channel (FUN_180021b80) ----
function chanPass(Y, Spyr, rect, A, B, W, H) {
  const nlev = Number(A.getBigInt64(0x48, true));
  const mi = Number(A.getBigInt64(0x50, true));
  const sizes = [[W, H]];
  for (let i = 0; i < 4; i++) sizes.push([sizes[i][0] >> 1, sizes[i][1] >> 1]);
  const G = [Y];
  const bands = [];
  for (let i = 0; i < nlev; i++) {
    const [w, h] = sizes[i];
    const ls = lineSet(w, h, mi);
    const t = new Float32Array(w * h);
    const Bx = new Float32Array(w * h);
    lineFilt(G[i], t, w, h, ls.H, 1);
    lineFilt(t, Bx, w, h, ls.V, 1);
    const Gn = down2(Bx, w, h);
    G.push(Gn);
    const U = up2(Gn, sizes[i + 1][0], sizes[i + 1][1], w & 1, h & 1);
    const band = new Float32Array(w * h);
    for (let p = 0; p < w * h; p++) band[p] = f32(G[i][p] - U[p]);
    bands.push(band);
  }
  const [y0, x0, cw, ch] = rect;
  const y1 = y0 - 1 + ch;
  const x1 = x0 - 1 + cw;
  let acc = new Float32Array(sizes[nlev - 1][0] * sizes[nlev - 1][1]);
  let Mfull = new Float32Array(acc.length);
  let Ifull = new Uint8Array(acc.length);
  const flag47 = A.getUint8(0x47) === 1;
  for (let L = nlev - 1; L >= 0; L--) {
    const [w, h] = sizes[L];
    const ylo = Math.max((y0 >> L) - 4, 0);
    const yhi = Math.min((y1 >> L) + 4, h - 1);
    const xlo = Math.max((x0 >> L) - 4, 0);
    const xhi = Math.min((x1 >> L) + 4, w - 1);
    const rh = yhi - ylo + 1;
    const rw = xhi - xlo + 1;
    const X = cropOf(bands[L], w, ylo, xlo, rh, rw);
    const Sc = cropOf(Spyr[L], w, ylo, xlo, rh, rw);
    const Mc = cropOf(Mfull, w, ylo, xlo, rh, rw);
    const Ic = cropOf(Ifull, w, ylo, xlo, rh, rw);
    const lv = levelPass(X, Sc, Mc, Ic, rw, rh, L, A, B, lineSet(rw, rh, mi), mi);
    const F = bands[L];
    for (let y = 0; y < rh; y++) for (let x = 0; x < rw; x++) F[(ylo + y) * w + xlo + x] = lv.out[y * rw + x];
    const accn = new Float32Array(w * h);
    for (let p = 0; p < w * h; p++) accn[p] = f32(acc[p] + F[p]);
    if (L === 0) {
      acc = accn;
      break;
    }
    for (let y = 0; y < rh; y++) {
      for (let x = 0; x < rw; x++) {
        Mfull[(ylo + y) * w + xlo + x] = lv.Mout[y * rw + x];
        Ifull[(ylo + y) * w + xlo + x] = lv.idxOut[y * rw + x];
      }
    }
    const [wp, hp] = sizes[L - 1];
    acc = up2(accn, w, h, wp & 1, hp & 1);
    if (flag47) {
      Mfull = up2(Mfull, w, h, wp & 1, hp & 1);
      Ifull = upBytes(Ifull, w, h, wp & 1, hp & 1);
    }
  }
  const out = new Float32Array(W * H);
  for (let p = 0; p < W * H; p++) out[p] = f32(Y[p] + acc[p]);
  return out;
}

// ---- noise sigma pyramids (FUN_180009da0) ----
const MAT1 = [[0.0892999992, 0.344000012, 0.0131000001], [0.25, 0.174999997, 0.00659999996], [0.0284000002, 0.1096, 0.25]].map((r) => r.map(f32));
function noisePyramids(R, G, B, W, H, prof, nlev) {
  const sizes = [[W, H]];
  for (let i = 0; i < 5; i++) sizes.push([sizes[i][0] >> 1, sizes[i][1] >> 1]);
  let cur = [R, G, B];
  const outs = [[], [], []];
  for (let l = 0; l < nlev; l++) {
    const [wl, hl] = sizes[l];
    const [wn, hn] = sizes[l + 1];
    const nxt = cur.map((p) => down2(p, wl, hl));
    const n = wn * hn;
    const lut = (c) => prof.lut[c][l];
    const idx = nxt.map((p) => {
      const o = new Int32Array(n);
      for (let i = 0; i < n; i++) o[i] = Math.min(255, Math.max(0, rint(p[i])));
      return o;
    });
    const v = [0, 1, 2].map((c) => {
      const o = new Float32Array(n);
      const t = lut(c);
      for (let i = 0; i < n; i++) o[i] = t[idx[c][i]];
      return o;
    });
    const f = [0, 1, 2].map((c) => f32(prof.scalars[c * 4 + l] * prof.scalars[c * 4 + l]));
    for (let r = 0; r < 3; r++) {
      const den = f32(f32(f[0] * MAT1[r][0] + f[1] * MAT1[r][1]) + f[2] * MAT1[r][2]);
      const kk = f32(1 / den);
      const m = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        m[i] = f32(f32(f32(f[0] * kk) * MAT1[r][0]) * v[0][i] + f32(f32(f[1] * kk) * MAT1[r][1]) * v[1][i] + f32(f32(kk * f[2]) * MAT1[r][2]) * v[2][i]);
        m[i] = f32(Math.sqrt(Math.abs(m[i])));
      }
      outs[r].push(up2(m, wn, hn, wl & 1, hl & 1));
    }
    cur = nxt;
  }
  return outs;
}

// ---- profile tables ----
const b64 = (s) => {
  const bin = typeof atob === 'function' ? atob(s) : Buffer.from(s, 'base64').toString('binary');
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
};
const profileCache = new Map();
// The table set for profile `index` and the luma strength `luma` (the gain table value).
export function nrTables(index, luma) {
  const key = `${index}:${luma}`;
  if (profileCache.has(key)) return profileCache.get(key);
  const P = ENGINE_NR_PROFILES.profiles[index];
  const sc = new Float32Array(b64(P.scalars).buffer);
  const ctrl = new Float32Array(b64(P.ctrl).buffer);
  const Abytes = b64(P.A);
  const Bbytes = b64(P.B);
  const A = [0, 1, 2].map((c) => {
    const u = Abytes.slice(c * 88, (c + 1) * 88);
    const dv = new DataView(u.buffer);
    if (c === 0) for (let l = 0; l < 4; l++) dv.setFloat32(0x10 + 4 * l, luma, true);
    return dv;
  });
  const B = [0, 1, 2].map((c) => new DataView(Bbytes.slice(c * 640, (c + 1) * 640).buffer));
  // sigma lookup tables: 8 control points per channel, linear in between, scaled and squared
  const lut = [0, 1, 2].map((c) => [0, 1, 2, 3].map((l) => {
    const t = new Float32Array(257);
    const cf = (o) => ctrl[c * 63 + o / 4];
    for (let i = 0; i < 257; i++) {
      const k = Math.min(Math.trunc(f32(i * 0.03125)), 7);
      const frac = f32(f32(i * 0.03125) - k);
      const v0 = f32(cf(0x1c * k) * cf(4 * l + 4 + 0x1c * k));
      const v1 = f32(cf(0x1c + 0x1c * k) * cf(4 * l + 0x20 + 0x1c * k));
      const v = f32(v0 + f32(frac * f32(v1 - v0)));
      t[i] = f32(v * v);
    }
    return t;
  }));
  const tab = { A, B, lut, scalars: sc, ctype: P.ctype, nlev: Number(A[0].getBigInt64(0x48, true)) };
  profileCache.set(key, tab);
  return tab;
}
// Which of the eight ILLUM noise profiles a photo uses: the one whose key is nearest the sensor's total gain.
export function nrProfileIndex(totalGain) {
  const keys = ENGINE_NR_PROFILES.keys;
  let best = 0;
  for (let i = 1; i < keys.length; i++) if (Math.abs(keys[i] - totalGain) < Math.abs(keys[best] - totalGain)) best = i;
  return best;
}
// The luma strength the engine uses for a total gain (YNRAmountVsTotalGain, piecewise linear, clamped).
export function nrLumaStrength(totalGain) {
  const t = [[2, 0.1], [8, 0.2], [16, 0.25], [32, 0.3], [64, 0.5]];
  if (totalGain <= t[0][0]) return t[0][1];
  for (let i = 1; i < t.length; i++) if (totalGain <= t[i][0]) return f32(t[i - 1][1] + ((t[i][1] - t[i - 1][1]) * (totalGain - t[i - 1][0])) / (t[i][0] - t[i - 1][0]));
  return t[t.length - 1][1];
}

// ---- colour transform (BT.601, planes 0..255) ----
function yccForward(R, G, B, Y, C1, C2, n) {
  for (let i = 0; i < n; i++) {
    const y = f32(f32(f32(0.298900008 * R[i]) + f32(G[i] * 0.586600006)) + f32(0.114500001 * B[i]));
    Y[i] = y;
    C1[i] = f32(f32(f32(R[i] - y) * 0.713165045) + 127.5);
    C2[i] = f32(f32(f32(B[i] - y) * 0.564652741) + 127.5);
  }
}
function yccInverse(Y, C1, C2, R, G, B, n) {
  for (let i = 0; i < n; i++) {
    const a = f32(C1[i] - 127.5);
    const b = f32(C2[i] - 127.5);
    R[i] = f32(f32(1.40219998 * a) + Y[i]);
    G[i] = f32(f32(Y[i] - f32(a * 0.71450001)) - f32(0.345600009 * b));
    B[i] = f32(Y[i] + f32(b * 1.77100003));
  }
}

function tileLayout(n, pad = 16, core = 96, minpad = 40) {
  const out = [];
  for (let s = 0; s < n; s += core) {
    const c = Math.min(core, n - s);
    const p = c >= minpad ? pad : Math.max(pad, minpad);
    out.push([s, c, Math.min(s, p), Math.min(p, n - s - c)]);
  }
  return out;
}

// The whole filter on three float planes (values 0..255, row major w x h). Returns three new planes. `onProgress(0..1)` per tile.
export function nrFilter(planes, w, h, tables, onProgress) {
  const out = planes.map((p) => Float32Array.from(p));
  if (w < 40 || h < 40) return out;
  const xs = tileLayout(w);
  const ys = tileLayout(h);
  let done = 0;
  for (const [y0, ch, pt, pb] of ys) {
    for (const [x0, cw, pl, pr] of xs) {
      const tw = pl + cw + pr;
      const th = pt + ch + pb;
      const cut = (p) => cropOf(p, w, y0 - pt, x0 - pl, th, tw);
      const [R, G, B] = planes.map(cut);
      const S = noisePyramids(R, G, B, tw, th, tables, tables.nlev);
      const n = tw * th;
      const Y = new Float32Array(n);
      const C1 = new Float32Array(n);
      const C2 = new Float32Array(n);
      yccForward(R, G, B, Y, C1, C2, n);
      const rect = [pt, pl, cw, ch];
      const o = [Y, C1, C2].map((chn, ci) => chanPass(chn, S[ci], rect, tables.A[ci], tables.B[ci], tw, th));
      const Ro = new Float32Array(n);
      const Go = new Float32Array(n);
      const Bo = new Float32Array(n);
      yccInverse(o[0], o[1], o[2], Ro, Go, Bo, n);
      [Ro, Go, Bo].forEach((v, c) => {
        for (let y = 0; y < ch; y++) out[c].set(v.subarray((pt + y) * tw + pl, (pt + y) * tw + pl + cw), (y0 + y) * w + x0);
      });
      done++;
      if (onProgress) onProgress(done / (xs.length * ys.length));
    }
  }
  return out;
}

export const __internals = { makeLine, lineFilt, levelPass, chanPass, noisePyramids, down2, up2, lineSet, tileLayout };
