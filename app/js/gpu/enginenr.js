// The engine's noise reduction (core/enginenr.js, the NILib port) on the GPU. Tiles of equal shape are laid side by side in one atlas, so one draw covers all
// of them: a pixel finds its tile from its position and works in tile-local coordinates, which keeps the library's per-tile boundaries (mirror reflection on
// straight lines, truncated windows on diagonals) exactly as the CPU version has them.
import { program } from './renderer.js';
import { __internals as CPU } from '../core/enginenr.js';

const HEAD = `#version 300 es
precision highp float;
precision highp int;
`;

// Directional box mean (core/enginenr.js lineFilt): kind 0 along rows and 1 along columns with mirror reflection, kind 2 along a digital line
// (offset table `al`, one record per line: start, first index, length), the window truncated at the line's ends.
const LINE = `${HEAD}
uniform sampler2D uSrc;
uniform sampler2D uAl;
uniform sampler2D uRecs;
uniform ivec2 uCell;
uniform int uKind;
uniform int uR;
uniform int uSteep;
uniform int uMirrored;
uniform int uOff;
out vec4 outColor;

float src(ivec2 o, int x, int y) { return texelFetch(uSrc, o + ivec2(x, y), 0).r; }
int al(int k) { return int(texelFetch(uAl, ivec2(k, 0), 0).r + 0.5); }

void main() {
  ivec2 f = ivec2(gl_FragCoord.xy);
  ivec2 o = (f / uCell) * uCell;
  ivec2 p = f - o;
  int w = uCell.x;
  int h = uCell.y;
  if (uR == 0) { outColor = vec4(src(o, p.x, p.y)); return; }
  float inv = 1.0 / float(2 * uR + 1);
  if (uKind < 2) {
    int len = uKind == 0 ? w : h;
    int pos = uKind == 0 ? p.x : p.y;
    if (len == 1) { outColor = vec4(src(o, p.x, p.y) * inv); return; }
    int P = 2 * (len - 1);
    float s = 0.0;
    for (int j = -4; j <= 4; j++) {
      if (j < -uR || j > uR) continue;
      int k = (pos + j) % P;
      if (k < 0) k += P;
      if (k >= len) k = P - k;
      s += uKind == 0 ? src(o, k, p.y) : src(o, p.x, k);
    }
    outColor = vec4(s * inv);
    return;
  }
  int k = uSteep == 1 ? (uMirrored == 1 ? h - 1 - p.y : p.y) : (uMirrored == 1 ? w - 1 - p.x : p.x);
  int base = (uSteep == 1 ? p.x : p.y) - al(k);
  vec4 rec = texelFetch(uRecs, ivec2(base + uOff, 0), 0);
  int k0 = int(rec.y + 0.5);
  int len = int(rec.z + 0.5);
  int i = k - k0;
  int lo = 0;
  int hi = len - 1;
  if (len >= 2 * uR + 1) { lo = max(0, i - uR); hi = min(len - 1, i + uR); }
  float s = 0.0;
  for (int t = 0; t < 9; t++) {
    int tt = lo + t;
    if (tt > hi) break;
    int kk = k0 + tt;
    int a = al(kk);
    if (uSteep == 1) s += src(o, base + a, uMirrored == 1 ? h - 1 - kk : kk);
    else s += src(o, uMirrored == 1 ? w - 1 - kk : kk, base + a);
  }
  outColor = vec4(s / float(hi - lo + 1));
}`;


// Elementwise expression over same-shaped atlases: v0..v5 are the sources at this pixel, u0..u7 float uniforms.
const ewSource = (expr, n) => `${HEAD}
${Array.from({ length: n }, (_, i) => `uniform sampler2D uS${i};`).join('\n')}
uniform float u[8];
out vec4 outColor;
void main() {
  ivec2 f = ivec2(gl_FragCoord.xy);
${Array.from({ length: n }, (_, i) => `  float v${i} = texelFetch(uS${i}, f, 0).r;`).join('\n')}
  float u0 = u[0]; float u1 = u[1]; float u2 = u[2]; float u3 = u[3]; float u4 = u[4]; float u5 = u[5]; float u6 = u[6]; float u7 = u[7];
  float r = ${expr};
  outColor = vec4(r);
}`;

// 2 x 2 average (down2): ((a + c) + b) + d, times 0.25.
const DOWN2 = `${HEAD}
uniform sampler2D uSrc;
uniform ivec2 uCell;     // the destination tile
out vec4 outColor;
void main() {
  ivec2 f = ivec2(gl_FragCoord.xy);
  ivec2 t = f / uCell;
  ivec2 p = f - t * uCell;
  ivec2 so = t * (uCell * 2) + p * 2;
  float a = texelFetch(uSrc, so, 0).r;
  float b = texelFetch(uSrc, so + ivec2(1, 0), 0).r;
  float c = texelFetch(uSrc, so + ivec2(0, 1), 0).r;
  float d = texelFetch(uSrc, so + ivec2(1, 1), 0).r;
  outColor = vec4(((a + c) + b + d) * 0.25);
}`;

// 2 x up-sampling (up2) with the odd sizes padded by replicating the last column / row. uMode 1: bytes (nearest, no filtering).
const UP2 = `${HEAD}
uniform sampler2D uSrc;
uniform ivec2 uCell;     // the destination tile (size of the padded result)
uniform ivec2 uSrcCell;  // the source tile
uniform int uMode;
out vec4 outColor;
float s(ivec2 o, int x, int y) { return texelFetch(uSrc, o + ivec2(x, y), 0).r; }
void main() {
  ivec2 f = ivec2(gl_FragCoord.xy);
  ivec2 t = f / uCell;
  ivec2 p = f - t * uCell;
  ivec2 o = t * uSrcCell;
  int w = uSrcCell.x;
  int h = uSrcCell.y;
  int X = min(p.x, 2 * w - 1);
  int Y = min(p.y, 2 * h - 1);
  int x = X >> 1;
  int y = Y >> 1;
  if (uMode == 1) { outColor = vec4(s(o, x, y)); return; }
  int xn = (X & 1) == 0 ? max(x - 1, 0) : min(x + 1, w - 1);
  int yn = (Y & 1) == 0 ? max(y - 1, 0) : min(y + 1, h - 1);
  float a0 = 0.75 * s(o, x, y) + 0.25 * s(o, xn, y);
  float a1 = 0.75 * s(o, x, yn) + 0.25 * s(o, xn, yn);
  outColor = vec4(0.75 * a0 + 0.25 * a1);
}`;

// Copies a window of each source tile into a smaller tile (uOrigin = the window's corner in the source tile) or, uPaste 1, writes the window back into a copy.
const CROP = `${HEAD}
uniform sampler2D uSrc;
uniform sampler2D uOld;
uniform ivec2 uCell;     // destination tile
uniform ivec2 uSrcCell;  // source tile
uniform ivec2 uOrigin;
uniform int uPaste;
out vec4 outColor;
void main() {
  ivec2 f = ivec2(gl_FragCoord.xy);
  ivec2 t = f / uCell;
  ivec2 p = f - t * uCell;
  if (uPaste == 0) {
    outColor = vec4(texelFetch(uSrc, t * uSrcCell + uOrigin + p, 0).r);
    return;
  }
  // paste: the destination tile is the big one, uSrc the window, uSrcCell the window size
  ivec2 q = p - uOrigin;
  if (q.x >= 0 && q.y >= 0 && q.x < uSrcCell.x && q.y < uSrcCell.y) outColor = vec4(texelFetch(uSrc, t * uSrcCell + q, 0).r);
  else outColor = vec4(texelFetch(uOld, f, 0).r);
}`;

// Picks, per pixel, from up to eight sources by an index atlas: out = src[idx].
const PICK = `${HEAD}
uniform sampler2D uIdx;
uniform sampler2D uS0;
uniform sampler2D uS1;
uniform sampler2D uS2;
uniform sampler2D uS3;
uniform sampler2D uS4;
uniform sampler2D uS5;
uniform sampler2D uS6;
uniform sampler2D uS7;
out vec4 outColor;
void main() {
  ivec2 f = ivec2(gl_FragCoord.xy);
  int k = int(texelFetch(uIdx, f, 0).r + 0.5);
  float v = 0.0;
  if (k == 0) v = texelFetch(uS0, f, 0).r;
  else if (k == 1) v = texelFetch(uS1, f, 0).r;
  else if (k == 2) v = texelFetch(uS2, f, 0).r;
  else if (k == 3) v = texelFetch(uS3, f, 0).r;
  else if (k == 4) v = texelFetch(uS4, f, 0).r;
  else if (k == 5) v = texelFetch(uS5, f, 0).r;
  else if (k == 6) v = texelFetch(uS6, f, 0).r;
  else v = texelFetch(uS7, f, 0).r;
  outColor = vec4(v);
}`;

// Look up a 256 entry table (one row of uLut) by the rounded value: the noise sigma of the library's profile.
const LUT = `${HEAD}
uniform sampler2D uSrc;
uniform sampler2D uLut;
uniform int uRow;
out vec4 outColor;
void main() {
  ivec2 f = ivec2(gl_FragCoord.xy);
  float v = texelFetch(uSrc, f, 0).r;
  int i = int(clamp(roundEven(v), 0.0, 255.0));
  outColor = vec4(texelFetch(uLut, ivec2(i, uRow), 0).r);
}`;


const f32 = Math.fround;
const fl = (b, o) => b.getFloat32(o, true);

// One level's pass (core/enginenr.js levelPass) on atlases of crop tiles: X band, S noise sigma, M and I (blend weight and best direction carried from the level
// below). Returns { out, Mout, idxOut } atlases; the caller releases them.
export function levelPassGpu(nr, X, S, M, I, lvl, A, B, mi, ls) {
  const m = CPU.MODES[mi];
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
  const mk = () => nr.like(X);
  const tmp = [];
  const t = () => { const a = mk(); tmp.push(a); return a; };
  const box3 = (a, o) => {
    const t1 = t();
    const t2 = t();
    nr.ew(t1, 'v0 * v0', [a]);
    nr.lineFilt(t1, t2, ls.H, 1);
    nr.lineFilt(t2, o, ls.V, 1);
  };
  const limit = (a, b, p, o) => nr.ew(o, 'abs(v1) * u0 < 1.0 ? v0 : v0 / (abs(v1) * u0)', [a, b], [f32(1 / p)]);
  const affine = (a, s, o) => nr.ew(o, 'clamp(v0 * u0 + 2.5, 0.0, 1.0)', [a], [s]);
  const Z = t();
  nr.ew(Z, 'v0 / (v1 + 1.0e-4)', [X, S]);
  const R = t();
  box3(Z, R);
  nr.ew(R, 'sqrt(abs(v0))', [R].map((a) => a));
  const Zl = t();
  limit(Z, R, f32(f32(3 * B16) * fA), Zl);
  const E = [];
  const V = [];
  const p2 = f32(f32(B16 * 0.5) * fA);
  for (let d = 0; d < nd; d++) {
    const L = ls.dirs[d];
    const Md = t();
    nr.lineFilt(Zl, Md, L, R4);
    const Dd = t();
    nr.ew(Dd, 'v0 - v1', [Zl, Md]);
    const Zd = t();
    limit(Zl, Dd, p2, Zd);
    const Ed = mk();
    E.push(Ed);
    if (m.alt[d] === -1) nr.lineFilt(Zd, Ed, L, R4);
    else {
      const Et = t();
      nr.lineFilt(Zd, Et, L, R4);
      nr.lineFilt(Et, Ed, ls.dirs[m.alt[d]], m.altr);
    }
    const t1 = t();
    nr.ew(t1, 'v0 * v0', [Ed]);
    const Vd = mk();
    V.push(Vd);
    nr.lineFilt(t1, Vd, ls.dirs[m.perp[d]], 1);
    nr.ew(Vd, 'abs(v0) * (1.0 / sqrt(abs(v0) + 1.17549435e-38)) * u0', [Vd], [f32(1 / fl(B, 0xa0 + mi * 0xa0 + lvl * 0x20 + 4 * d))]);
  }
  // best direction: the last of equal values wins (v >= best)
  let best = t();
  let Vmax = t();
  nr.ew(best, '0.0 * v0', [V[0]]);
  nr.ew(Vmax, 'v0', [V[0]]);
  for (let d = 1; d < nd; d++) {
    const nb = t();
    nr.ew(nb, 'v2 >= v1 ? u0 : v0', [best, Vmax, V[d]], [d]);
    const nv = t();
    nr.ew(nv, 'v2 >= v1 ? v2 : v1', [best, Vmax, V[d]]);
    best = nb;
    Vmax = nv;
  }
  const k = f32(f32(f32(0.5) / fA) * f32(-4));
  let Mout = M;
  let idxOut = I;
  const keep = [];
  if (flag47) {
    const Wa = t();
    affine(Vmax, k, Wa);
    const T = t();
    nr.ew(T, 'v0 * v1', [M, Wa]);
    if (lvl !== 0) {
      Mout = mk();
      nr.ew(Mout, 'v0 * -1.0 + 1.0', [Wa]);
      keep.push(Mout);
    }
    idxOut = mk();
    nr.ew(idxOut, 'v0', [best]);
    keep.push(idxOut);
    const Vp = t();
    nr.pick(I, V, Vp);
    const cand = t();
    nr.ew(cand, '(v0 + 1.0) * v1', [T, Vp]);
    const nb = t();
    nr.ew(nb, '(v0 <= v1 && v1 != v0) ? v2 : v3', [Vmax, cand, I, best]);
    const nv = t();
    nr.ew(nv, '(v0 <= v1 && v1 != v0) ? v1 : v0', [Vmax, cand]);
    best = nb;
    Vmax = nv;
  }
  const Eb = t();
  nr.pick(best, E, Eb);
  const Dn = t();
  nr.ew(Dn, 'v0 - v1', [Zl, Eb]);
  const Wb = t();
  affine(Vmax, k, Wb);
  const E2 = t();
  nr.ew(E2, 'v0 * v1', [Wb, Eb]);
  const R2 = t();
  box3(Dn, R2);
  nr.ew(R2, 'sqrt(abs(v0))', [R2]);
  if (flag45) nr.ew(R2, 'v0 * (v1 * 0.5 + 0.5)', [R2, Wb]);
  const Wc = t();
  affine(R2, f32(f32(f32(0.5) / f32(Bc * fA)) * f32(-4)), Wc);
  nr.ew(E2, 'v0 * v1 + v2', [Wc, Dn, E2]);
  if (flag46) {
    const q = t();
    limit(Dn, R, f32(B16 * fA), q);
    const t1 = t();
    const t2 = t();
    nr.ew(t1, 'v0 * v0', [q]);
    nr.lineFilt(t1, t2, ls.H, 4);
    nr.lineFilt(t2, t1, ls.V, 4);
    nr.ew(t1, 'sqrt(abs(v0))', [t1]);
    const Wd = t();
    affine(t1, f32(f32(f32(0.5) / f32(Bd * fA)) * f32(-4)), Wd);
    nr.ew(E2, 'v0 * v1', [Wd, E2]);
  }
  const out = mk();
  nr.ew(out, 'v0 * u0 * v1', [E2, S], [f32(-g)]);
  nr.release(...tmp, ...E, ...V);
  return { out, Mout, idxOut, own: keep };
}


const MAT1 = [[0.0892999992, 0.344000012, 0.0131000001], [0.25, 0.174999997, 0.00659999996], [0.0284000002, 0.1096, 0.25]].map((r) => r.map(f32));
const ceilTiles = (n) => n;

// The sigma pyramids of the library's profile (core/enginenr.js noisePyramids): for the R, G and B tile atlases, three arrays (one per output plane) of
// atlases, one per level, each at that level's size.
export function noisePyramidsGpu(nr, R, G, B, prof, nlev, lutTex) {
  let cur = [R, G, B];
  const outs = [[], [], []];
  const owned = [];
  let wl = R.w;
  let hl = R.h;
  for (let l = 0; l < nlev; l++) {
    const wn = wl >> 1;
    const hn = hl >> 1;
    const nxt = cur.map(() => nr.get(R.cols, R.rows, wn, hn));
    cur.forEach((a, i) => nr.down2(a, nxt[i]));
    const v = [0, 1, 2].map((c) => {
      const o = nr.get(R.cols, R.rows, wn, hn);
      nr.lut(nxt[c], lutTex, c * 4 + l, o);
      return o;
    });
    const f = [0, 1, 2].map((c) => f32(prof.scalars[c * 4 + l] * prof.scalars[c * 4 + l]));
    for (let r = 0; r < 3; r++) {
      const den = f32(f32(f[0] * MAT1[r][0] + f[1] * MAT1[r][1]) + f[2] * MAT1[r][2]);
      const kk = f32(1 / den);
      const m = nr.get(R.cols, R.rows, wn, hn);
      nr.ew(m, 'sqrt(abs(u0 * v0 + u1 * v1 + u2 * v2))', v, [f32(f32(f[0] * kk) * MAT1[r][0]), f32(f32(f[1] * kk) * MAT1[r][1]), f32(f32(kk * f[2]) * MAT1[r][2])]);
      const up = nr.get(R.cols, R.rows, wl, hl);
      nr.up2(m, up);
      outs[r].push(up);
      nr.release(m);
    }
    nr.release(...v);
    if (l > 0) nr.release(...cur);
    owned.push(...[]);
    cur = nxt;
    wl = wn;
    hl = hn;
  }
  nr.release(...cur);
  return outs;
}

// One plane through the pyramid (core/enginenr.js chanPass). Y: tile atlas (W x H); Spyr: the sigma atlases per level; rect: [y0, x0, cw, ch] of the tile core.
// Returns a new atlas (the caller releases it).
export function chanPassGpu(nr, Y, Spyr, rect, A, B) {
  const nlev = Number(A.getBigInt64(0x48, true));
  let any = A.getFloat32(0x20, true) > 0;
  for (let l = 0; l < 4 && !any; l++) any = A.getFloat32(0x10 + 4 * l, true) !== 0 || A.getFloat32(0x34 + 4 * l, true) !== 0;
  const out = nr.like(Y);
  if (!any) {
    nr.ew(out, 'v0', [Y]);
    return out;
  }
  const mi = Number(A.getBigInt64(0x50, true));
  const W = Y.w;
  const H = Y.h;
  const sizes = [[W, H]];
  for (let i = 0; i < 4; i++) sizes.push([sizes[i][0] >> 1, sizes[i][1] >> 1]);
  const cols = Y.cols;
  const rows = Y.rows;
  const at = (i) => nr.get(cols, rows, sizes[i][0], sizes[i][1]);
  const G = [Y];
  const bands = [];
  const keep = [];
  for (let i = 0; i < nlev; i++) {
    const [w, h] = sizes[i];
    const ls = CPU.lineSet(w, h, mi);
    const t = at(i);
    const Bx = at(i);
    nr.lineFilt(G[i], t, ls.H, 1);
    nr.lineFilt(t, Bx, ls.V, 1);
    const Gn = at(i + 1);
    nr.down2(Bx, Gn);
    G.push(Gn);
    const U = at(i);
    nr.up2(Gn, U);
    const band = at(i);
    nr.ew(band, 'v0 - v1', [G[i], U]);
    bands.push(band);
    nr.release(t, Bx, U);
    keep.push(Gn);
  }
  const [y0, x0, cw, chh] = rect;
  const y1 = y0 - 1 + chh;
  const x1 = x0 - 1 + cw;
  const flag47 = A.getUint8(0x47) === 1;
  let acc = at(nlev - 1);
  nr.ew(acc, '0.0', []);
  let Mfull = at(nlev - 1);
  nr.ew(Mfull, '0.0', []);
  let Ifull = at(nlev - 1);
  nr.ew(Ifull, '0.0', []);
  for (let L = nlev - 1; L >= 0; L--) {
    const [w, h] = sizes[L];
    const ylo = Math.max((y0 >> L) - 4, 0);
    const yhi = Math.min((y1 >> L) + 4, h - 1);
    const xlo = Math.max((x0 >> L) - 4, 0);
    const xhi = Math.min((x1 >> L) + 4, w - 1);
    const rh = yhi - ylo + 1;
    const rw = xhi - xlo + 1;
    const crop = () => nr.get(cols, rows, rw, rh);
    const X = crop();
    const Sc = crop();
    const Mc = crop();
    const Ic = crop();
    nr.crop(bands[L], X, xlo, ylo);
    nr.crop(Spyr[L], Sc, xlo, ylo);
    nr.crop(Mfull, Mc, xlo, ylo);
    nr.crop(Ifull, Ic, xlo, ylo);
    const lv = levelPassGpu(nr, X, Sc, Mc, Ic, L, A, B, mi, CPU.lineSet(rw, rh, mi));
    const F = at(L);
    nr.paste(lv.out, bands[L], F, xlo, ylo);
    const accn = at(L);
    nr.ew(accn, 'v0 + v1', [acc, F]);
    nr.release(acc, F);
    if (L === 0) {
      acc = accn;
      nr.release(lv.out, X, Sc, Mc, Ic, Mfull, Ifull);
      if (lv.Mout !== Mc) nr.release(lv.Mout);
      if (lv.idxOut !== Ic) nr.release(lv.idxOut);
      break;
    }
    const M2 = at(L);
    const I2 = at(L);
    nr.paste(lv.Mout, Mfull, M2, xlo, ylo);
    nr.paste(lv.idxOut, Ifull, I2, xlo, ylo);
    nr.release(Mfull, Ifull, lv.out, X, Sc, Mc, Ic);
    if (lv.Mout !== Mc) nr.release(lv.Mout);
    if (lv.idxOut !== Ic) nr.release(lv.idxOut);
    Mfull = M2;
    Ifull = I2;
    const [wp, hp] = sizes[L - 1];
    acc = at(L - 1);
    nr.up2(accn, acc);
    nr.release(accn);
    if (flag47) {
      const Mu = at(L - 1);
      nr.up2(Mfull, Mu);
      const Iu = at(L - 1);
      nr.up2(Ifull, Iu, true);
      nr.release(Mfull, Ifull);
      Mfull = Mu;
      Ifull = Iu;
    } else {
      const Mu = at(L - 1);
      const Iu = at(L - 1);
      nr.up2(Mfull, Mu);
      nr.up2(Ifull, Iu, true);
      nr.release(Mfull, Ifull);
      Mfull = Mu;
      Ifull = Iu;
    }
    if (wp < 0 || hp < 0) throw new Error('size');
  }
  nr.ew(out, 'v0 + v1', [Y, acc]);
  nr.release(acc, ...bands, ...keep);
  return out;
}


// The whole filter on three float planes (0..255, row major w x h), like core/enginenr.js nrFilter: returns three new planes.
export function nrFilterGpu(gpu, planes, w, h, tables, onProgress) {
  const out = planes.map((p) => Float32Array.from(p));
  if (w < 40 || h < 40) return out;
  const gl = gpu.gl;
  const xs = CPU.tileLayout(w);
  const ys = CPU.tileLayout(h);
  const groups = new Map();
  for (const [y0, ch, pt, pb] of ys) {
    for (const [x0, cw, pl, pr] of xs) {
      const key = `${pt}|${ch}|${pb}|${pl}|${cw}|${pr}`;
      if (!groups.has(key)) groups.set(key, { pt, ch, pb, pl, cw, pr, tiles: [] });
      groups.get(key).tiles.push([x0, y0]);
    }
  }
  const nr = new NrGpu(gpu);
  const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
  // the profile's sigma tables, one 257 entry row per (plane, level)
  const lutData = new Float32Array(257 * 12);
  for (let c = 0; c < 3; c++) for (let l = 0; l < 4; l++) lutData.set(tables.lut[c][l], 257 * (c * 4 + l));
  const lutTex = gpu.texture(257, 12, gl.R32F);
  gl.activeTexture(gl.TEXTURE0 + 15);
  gl.bindTexture(gl.TEXTURE_2D, lutTex);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 257, 12, gl.RED, gl.FLOAT, lutData);
  const total = xs.length * ys.length;
  let done = 0;
  try {
    for (const g of groups.values()) {
      const tw = g.pl + g.cw + g.pr;
      const th = g.pt + g.ch + g.pb;
      const perBatch = Math.max(1, Math.min(48, Math.floor(maxTex / tw) * Math.floor(maxTex / th)));
      for (let b0 = 0; b0 < g.tiles.length; b0 += perBatch) {
        const batch = g.tiles.slice(b0, b0 + perBatch);
        const cols = Math.min(batch.length, Math.max(1, Math.min(Math.floor(maxTex / tw), Math.ceil(Math.sqrt((batch.length * th) / tw)))));
        const rows = Math.ceil(batch.length / cols);
        const atlas = () => nr.get(cols, rows, tw, th);
        const R = atlas();
        const G = atlas();
        const B = atlas();
        const bufs = [R, G, B].map(() => new Float32Array(cols * tw * rows * th));
        batch.forEach(([x0, y0], t) => {
          const ox = (t % cols) * tw;
          const oy = Math.floor(t / cols) * th;
          for (let c = 0; c < 3; c++) {
            for (let y = 0; y < th; y++) {
              const src = (y0 - g.pt + y) * w + (x0 - g.pl);
              bufs[c].set(planes[c].subarray(src, src + tw), (oy + y) * cols * tw + ox);
            }
          }
        });
        [R, G, B].forEach((a, c) => nr.upload(a, bufs[c]));
        const S = noisePyramidsGpu(nr, R, G, B, tables, tables.nlev, lutTex);
        const Y = atlas();
        const C1 = atlas();
        const C2 = atlas();
        nr.ew(Y, '0.298900008 * v0 + v1 * 0.586600006 + 0.114500001 * v2', [R, G, B]);
        nr.ew(C1, '(v0 - v1) * 0.713165045 + 127.5', [R, Y]);
        nr.ew(C2, '(v0 - v1) * 0.564652741 + 127.5', [B, Y]);
        const rect = [g.pt, g.pl, g.cw, g.ch];
        const o = [Y, C1, C2].map((chn, ci) => chanPassGpu(nr, chn, S[ci], rect, tables.A[ci], tables.B[ci]));
        const Ro = atlas();
        const Go = atlas();
        const Bo = atlas();
        nr.ew(Ro, '1.40219998 * (v0 - 127.5) + v1', [o[1], o[0]]);
        nr.ew(Go, '(v0 - (v1 - 127.5) * 0.71450001) - 0.345600009 * (v2 - 127.5)', [o[0], o[1], o[2]]);
        nr.ew(Bo, 'v0 + (v1 - 127.5) * 1.77100003', [o[0], o[2]]);
        [Ro, Go, Bo].forEach((a, c) => {
          const data = nr.read(a);
          batch.forEach(([x0, y0], t) => {
            const ox = (t % cols) * tw;
            const oy = Math.floor(t / cols) * th;
            for (let y = 0; y < g.ch; y++) {
              const from = (oy + g.pt + y) * cols * tw + ox + g.pl;
              out[c].set(data.subarray(from, from + g.cw), (y0 + y) * w + x0);
            }
          });
        });
        nr.release(R, G, B, Y, C1, C2, Ro, Go, Bo, ...o, ...S.flat());
        done += batch.length;
        if (onProgress) onProgress(done / total);
      }
    }
  } finally {
    gl.deleteTexture(lutTex);
    nr.dispose();
  }
  return out;
}

export class NrGpu {
  constructor(gpu) {
    this.gpu = gpu;
    this.gl = gpu.gl;
    this.programs = { line: program(this.gl, LINE), down2: program(this.gl, DOWN2), up2: program(this.gl, UP2), crop: program(this.gl, CROP), pick: program(this.gl, PICK), lut: program(this.gl, LUT) };
    this.ewPrograms = new Map();
    this.free = new Map();
    this.lines = new Map();
    this.owned = [];
  }

  // An atlas of cols x rows tiles of w x h (one float per pixel).
  atlas(cols, rows, w, h) {
    const tex = this.gpu.texture(cols * w, rows * h, this.gl.R32F);
    this.owned.push(tex);
    return { tex, cols, rows, w, h, width: cols * w, height: rows * h };
  }

  upload(at, data) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + 15);
    gl.bindTexture(gl.TEXTURE_2D, at.tex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, at.width, at.height, gl.RED, gl.FLOAT, data);
  }

  read(at) {
    const gl = this.gl;
    this.gpu.target(at.tex, at.width, at.height);
    const out = new Float32Array(at.width * at.height * 4);
    gl.readPixels(0, 0, at.width, at.height, gl.RGBA, gl.FLOAT, out);
    const r = new Float32Array(at.width * at.height);
    for (let i = 0; i < r.length; i++) r[i] = out[4 * i];
    return r;
  }

  // The textures for a digital line of core/enginenr.js makeLine (cached by the line object).
  lineTextures(line) {
    let t = this.lines.get(line);
    if (t) return t;
    const gl = this.gl;
    const al = this.gpu.texture(line.al.length, 1, gl.R32F);
    const recs = this.gpu.texture(line.nrec, 1, gl.RGBA32F);
    gl.activeTexture(gl.TEXTURE0 + 15);
    gl.bindTexture(gl.TEXTURE_2D, al);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, line.al.length, 1, gl.RED, gl.FLOAT, Float32Array.from(line.al));
    const r4 = new Float32Array(line.nrec * 4);
    for (let q = 0; q < line.nrec; q++) {
      r4[4 * q] = line.recs[3 * q];
      r4[4 * q + 1] = line.recs[3 * q + 1];
      r4[4 * q + 2] = line.recs[3 * q + 2];
    }
    gl.bindTexture(gl.TEXTURE_2D, recs);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, line.nrec, 1, gl.RGBA, gl.FLOAT, r4);
    t = { al, recs, off: line.al[line.al.length - 1] };
    this.owned.push(al, recs);
    this.lines.set(line, t);
    return t;
  }

  // dst = box mean of src along `line` (a core/enginenr.js line: flagH, flagV or a digital line) with radius r.
  lineFilt(src, dst, line, r) {
    if (src === dst) return this.inPlace(dst, (tmp) => this.lineFilt(src, tmp, line, r));
    const gl = this.gl;
    const P = this.programs.line;
    this.gpu.target(dst.tex, dst.width, dst.height);
    gl.useProgram(P.p);
    gl.uniform1i(P.u.uSrc, 1);
    this.gpu.bindTex(1, src.tex);
    gl.uniform2i(P.u.uCell, src.w, src.h);
    gl.uniform1i(P.u.uR, r);
    if (line.flagH || line.flagV) {
      gl.uniform1i(P.u.uKind, line.flagH ? 0 : 1);
      // the line tables are not read, but their samplers must not point at the render target's unit
      gl.uniform1i(P.u.uAl, 2);
      this.gpu.bindTex(2, src.tex);
      gl.uniform1i(P.u.uRecs, 3);
      this.gpu.bindTex(3, src.tex);
    } else {
      const t = this.lineTextures(line);
      gl.uniform1i(P.u.uKind, 2);
      gl.uniform1i(P.u.uAl, 2);
      this.gpu.bindTex(2, t.al);
      gl.uniform1i(P.u.uRecs, 3);
      this.gpu.bindTex(3, t.recs);
      gl.uniform1i(P.u.uSteep, line.steep ? 1 : 0);
      gl.uniform1i(P.u.uMirrored, line.mirrored ? 1 : 0);
      gl.uniform1i(P.u.uOff, t.off);
    }
    this.gpu.draw();
  }



  // Runs draw(scratch) and leaves the result in `dst` (swapping the textures), for a pass that reads the atlas it writes.
  inPlace(dst, draw) {
    const tmp = this.like(dst);
    draw(tmp);
    const t = dst.tex;
    dst.tex = tmp.tex;
    tmp.tex = t;
    this.release(tmp);
  }

  // A scratch atlas of the given shape (reused after release).
  get(cols, rows, w, h) {
    const key = `${cols}x${rows}:${w}x${h}`;
    const list = this.free.get(key);
    if (list && list.length) return list.pop();
    const a = this.atlas(cols, rows, w, h);
    a.key = key;
    return a;
  }

  release(...atlases) {
    for (const a of atlases) {
      if (!a) continue;
      if (!this.free.has(a.key)) this.free.set(a.key, []);
      this.free.get(a.key).push(a);
    }
  }

  like(a) {
    return this.get(a.cols, a.rows, a.w, a.h);
  }

  // dst = expr over the sources (same shape); uniforms u0..u7.
  ew(dst, expr, srcs, uniforms = []) {
    if (srcs.includes(dst)) return this.inPlace(dst, (tmp) => this.ew(tmp, expr, srcs, uniforms));
    const gl = this.gl;
    const key = `${srcs.length}|${expr}`;
    let P = this.ewPrograms.get(key);
    if (!P) this.ewPrograms.set(key, (P = program(gl, ewSource(expr, srcs.length))));
    this.gpu.target(dst.tex, dst.width, dst.height);
    gl.useProgram(P.p);
    srcs.forEach((a, i) => {
      gl.uniform1i(P.u[`uS${i}`], i + 1);
      this.gpu.bindTex(i + 1, a.tex);
    });
    if (uniforms.length) {
      const u = new Float32Array(8);
      uniforms.forEach((v, i) => { u[i] = v; });
      gl.uniform1fv(P.u.u, u);
    }
    this.gpu.draw();
  }

  down2(src, dst) {
    const gl = this.gl;
    const P = this.programs.down2;
    this.gpu.target(dst.tex, dst.width, dst.height);
    gl.useProgram(P.p);
    gl.uniform1i(P.u.uSrc, 1);
    this.gpu.bindTex(1, src.tex);
    gl.uniform2i(P.u.uCell, dst.w, dst.h);
    this.gpu.draw();
  }

  // dst tile = 2 x src tile, padded to dst's size (replicating the last column / row when a size was odd). bytes: nearest instead of filtered.
  up2(src, dst, bytes = false) {
    const gl = this.gl;
    const P = this.programs.up2;
    this.gpu.target(dst.tex, dst.width, dst.height);
    gl.useProgram(P.p);
    gl.uniform1i(P.u.uSrc, 1);
    this.gpu.bindTex(1, src.tex);
    gl.uniform2i(P.u.uCell, dst.w, dst.h);
    gl.uniform2i(P.u.uSrcCell, src.w, src.h);
    gl.uniform1i(P.u.uMode, bytes ? 1 : 0);
    this.gpu.draw();
  }

  // dst (small tile) = the window of src (big tile) at (x0, y0).
  crop(src, dst, x0, y0) {
    const gl = this.gl;
    const P = this.programs.crop;
    this.gpu.target(dst.tex, dst.width, dst.height);
    gl.useProgram(P.p);
    gl.uniform1i(P.u.uSrc, 1);
    this.gpu.bindTex(1, src.tex);
    gl.uniform2i(P.u.uCell, dst.w, dst.h);
    gl.uniform2i(P.u.uSrcCell, src.w, src.h);
    gl.uniform2i(P.u.uOrigin, x0, y0);
    gl.uniform1i(P.u.uPaste, 0);
    this.gpu.draw();
  }

  // dst (big tile) = old with the window at (x0, y0) replaced by win.
  paste(win, old, dst, x0, y0) {
    const gl = this.gl;
    const P = this.programs.crop;
    this.gpu.target(dst.tex, dst.width, dst.height);
    gl.useProgram(P.p);
    gl.uniform1i(P.u.uSrc, 1);
    this.gpu.bindTex(1, win.tex);
    gl.uniform1i(P.u.uOld, 2);
    this.gpu.bindTex(2, old.tex);
    gl.uniform2i(P.u.uCell, dst.w, dst.h);
    gl.uniform2i(P.u.uSrcCell, win.w, win.h);
    gl.uniform2i(P.u.uOrigin, x0, y0);
    gl.uniform1i(P.u.uPaste, 1);
    this.gpu.draw();
  }

  // dst = srcs[idx] per pixel (up to eight sources).
  pick(idx, srcs, dst) {
    const gl = this.gl;
    const P = this.programs.pick;
    this.gpu.target(dst.tex, dst.width, dst.height);
    gl.useProgram(P.p);
    gl.uniform1i(P.u.uIdx, 1);
    this.gpu.bindTex(1, idx.tex);
    for (let i = 0; i < 8; i++) {
      gl.uniform1i(P.u[`uS${i}`], 2 + i);
      this.gpu.bindTex(2 + i, (srcs[i] || srcs[0]).tex);
    }
    this.gpu.draw();
  }

  // dst = table[row][round(src)] (round half to even, clamped to 0..255).
  lut(src, lutTex, row, dst) {
    const gl = this.gl;
    const P = this.programs.lut;
    this.gpu.target(dst.tex, dst.width, dst.height);
    gl.useProgram(P.p);
    gl.uniform1i(P.u.uSrc, 1);
    this.gpu.bindTex(1, src.tex);
    gl.uniform1i(P.u.uLut, 2);
    this.gpu.bindTex(2, lutTex);
    gl.uniform1i(P.u.uRow, row);
    this.gpu.draw();
  }

  dispose() {
    for (const t of this.owned) this.gl.deleteTexture(t);
    this.owned = [];
    this.lines.clear();
  }
}
