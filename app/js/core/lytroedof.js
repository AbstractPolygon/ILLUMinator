// Lytro Desktop's all in focus reconstruction (see docs/lytro-re-notes.md,
// "ILLUM all-in-focus (EDOF) image"): the rays are splatted with a per-ray
// depth, holes are filled, and a depth aware filter bank (the photo's
// reconstructionFilterRef) reconstructs the picture from the splat.

import { lensWarp } from './lens.js';

// ---- the photo's reconstruction filter bank --------------------------------

async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// A non interlaced 8 bit RGB PNG as { width, height, data } (RGB bytes).
export async function decodePngRgb(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let p = 8;
  let width = 0;
  let height = 0;
  const idat = [];
  while (p < bytes.length) {
    const n = dv.getUint32(p);
    const type = String.fromCharCode(bytes[p + 4], bytes[p + 5], bytes[p + 6], bytes[p + 7]);
    if (type === 'IHDR') {
      width = dv.getUint32(p + 8);
      height = dv.getUint32(p + 12);
      if (bytes[p + 16] !== 8 || bytes[p + 17] !== 2 || bytes[p + 20] !== 0) throw new Error('unsupported PNG');
    } else if (type === 'IDAT') idat.push(bytes.subarray(p + 8, p + 8 + n));
    else if (type === 'IEND') break;
    p += 12 + n;
  }
  const total = idat.reduce((a, b) => a + b.length, 0);
  const joined = new Uint8Array(total);
  let o = 0;
  for (const c of idat) {
    joined.set(c, o);
    o += c.length;
  }
  const raw = await inflate(joined);
  const stride = width * 3;
  const out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    for (let i = 0; i < stride; i++) {
      const a = i >= 3 ? out[y * stride + i - 3] : 0;
      const up = y > 0 ? out[(y - 1) * stride + i] : 0;
      const c = y > 0 && i >= 3 ? out[(y - 1) * stride + i - 3] : 0;
      let v = raw[src + i];
      if (f === 1) v += a;
      else if (f === 2) v += up;
      else if (f === 3) v += (a + up) >> 1;
      else if (f === 4) {
        const pa = Math.abs(up - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + up - 2 * c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? up : c;
      }
      out[y * stride + i] = v & 255;
    }
  }
  return { width, height, data: out };
}

// Kernel scale as a function of lambda (preset 0x4400, ILLUM): linear
// between these points, 1 outside.
const SCALE_POINTS = [[-100, 1], [-6, 1], [-5, 0.75], [-4, 0.5], [-3, 0.75], [-2, 1], [2, 1], [3, 0.75], [4, 0.5], [5, 0.75], [6, 1], [100, 1]];
export function kernelScale(lambda) {
  const P = SCALE_POINTS;
  if (lambda <= P[0][0]) return P[0][1];
  for (let i = 1; i < P.length; i++) {
    if (lambda <= P[i][0]) {
      const t = (lambda - P[i - 1][0]) / (P[i][0] - P[i - 1][0]);
      return P[i - 1][1] * (1 - t) + P[i][1] * t;
    }
  }
  return P[P.length - 1][1];
}

export const BANK = { sparsify: 0.01, rank: 1, mono: true, overlap: 0.1 };

// The green plane of every 65 x 65 kernel of the PNG, as signed floats
// summing to 1: entries[lambdaIndex * tiles + tile].
export function bankKernels(png, meta) {
  const tiles = meta.numKernelsX * meta.numKernelsY;
  const size = png.width;
  const n = meta.lambdas.length * tiles;
  const entries = [];
  for (let e = 0; e < n; e++) {
    const k = new Float64Array(size * size);
    let sum = 0;
    for (let i = 0; i < size * size; i++) {
      k[i] = png.data[(e * size * size + i) * 3 + 1] / 255 - 0.5;
      sum += k[i];
    }
    for (let i = 0; i < k.length; i++) k[i] /= sum;
    entries.push(k);
  }
  return { entries, size, tiles, meta };
}

// The kernel resampled by (sx, sy): its new size is rounded up to an odd
// number; larger kernels are sampled bilinearly, smaller ones are splatted
// and divided by their coverage (FUN_180bf4500).
function resampleKernel(k, size, sx, sy) {
  let w = Math.ceil(size * sx);
  let h = Math.ceil(size * sy);
  if (w % 2 === 0) w++;
  if (h % 2 === 0) h++;
  const out = new Float64Array(w * h);
  if (size < w || size < h ? size < w : false) {
    // upscaling
  }
  if (w > size) {
    const ix = 1 / sx;
    const iy = 1 / sy;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const px = (x - (w >> 1)) * ix + (size >> 1) + 0.5 - 0.5;
        const py = (y - (h >> 1)) * iy + (size >> 1) + 0.5 - 0.5;
        const x0 = Math.floor(px);
        const y0 = Math.floor(py);
        const ax = px - x0;
        const ay = py - y0;
        const at = (xx, yy) => (xx < 0 || yy < 0 || xx >= size || yy >= size ? 0 : k[yy * size + xx]);
        out[y * w + x] = (at(x0, y0) * (1 - ax) + at(x0 + 1, y0) * ax) * (1 - ay) + (at(x0, y0 + 1) * (1 - ax) + at(x0 + 1, y0 + 1) * ax) * ay;
      }
    }
    return { k: out, w, h };
  }
  // splat: every source tap spreads over the new grid with bilinear weights
  const cov = new Float64Array(w * h);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = (x - (size >> 1)) * sx + (w >> 1);
      const py = (y - (size >> 1)) * sy + (h >> 1);
      const x0 = Math.floor(px);
      const y0 = Math.floor(py);
      const ax = px - x0;
      const ay = py - y0;
      const v = k[y * size + x];
      for (let j = 0; j < 2; j++) {
        for (let i = 0; i < 2; i++) {
          const xx = x0 + i;
          const yy = y0 + j;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const wt = (i ? ax : 1 - ax) * (j ? ay : 1 - ay);
          out[yy * w + xx] += v * wt;
          cov[yy * w + xx] += wt;
        }
      }
    }
  }
  for (let i = 0; i < out.length; i++) out[i] = cov[i] > 0 ? out[i] / cov[i] : 0;
  return { k: out, w, h };
}

// Dominant separable term of a w x h matrix (power iteration): the column and
// row vectors (each summing to 1) and the gain that restores the kernel's sum.
function rank1(k, w, h) {
  let v = new Float64Array(w).fill(1);
  let u = new Float64Array(h);
  let s = 0;
  for (let it = 0; it < 60; it++) {
    for (let y = 0; y < h; y++) {
      let a = 0;
      for (let x = 0; x < w; x++) a += k[y * w + x] * v[x];
      u[y] = a;
    }
    let nu = 0;
    for (let y = 0; y < h; y++) nu += u[y] * u[y];
    nu = Math.sqrt(nu) || 1;
    for (let y = 0; y < h; y++) u[y] /= nu;
    for (let x = 0; x < w; x++) {
      let a = 0;
      for (let y = 0; y < h; y++) a += k[y * w + x] * u[y];
      v[x] = a;
    }
    let nv = 0;
    for (let x = 0; x < w; x++) nv += v[x] * v[x];
    s = Math.sqrt(nv) || 1;
    for (let x = 0; x < w; x++) v[x] /= s;
  }
  let su = 0;
  let sv = 0;
  for (let y = 0; y < h; y++) su += u[y];
  for (let x = 0; x < w; x++) sv += v[x];
  const col = Float32Array.from(u, (a) => a / su);
  const row = Float32Array.from(v, (a) => a / sv);
  return { col, row, gain: su * s * sv };
}

// The bank for pictures of W x H: per entry a rank 1 filter.
export function buildBank(src, W, H, opts = BANK) {
  const { entries, size, tiles, meta } = src;
  const out = [];
  for (let e = 0; e < entries.length; e++) {
    const lam = meta.lambdas[Math.floor(e / tiles)];
    const s = kernelScale(lam);
    const sx = (s * W) / meta.targetWidth;
    const sy = (s * H) / meta.targetHeight;
    let { k, w, h } = sx === 1 && sy === 1 ? { k: entries[e], w: size, h: size } : resampleKernel(entries[e], size, sx, sy);
    if (opts.sparsify > 0) {
      let max = -Infinity;
      for (let i = 0; i < k.length; i++) if (k[i] > max) max = k[i];
      const t = opts.sparsify * max;
      k = Float64Array.from(k, (a) => (Math.abs(a) <= t ? 0 : a));
    }
    // the smallest centred window holding every non zero tap
    let rx = 0;
    let ry = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (k[y * w + x] !== 0) {
          rx = Math.max(rx, Math.abs(x - (w >> 1)));
          ry = Math.max(ry, Math.abs(y - (h >> 1)));
        }
      }
    }
    const nw = 2 * rx + 1;
    const nh = 2 * ry + 1;
    const c = new Float64Array(nw * nh);
    for (let y = 0; y < nh; y++) for (let x = 0; x < nw; x++) c[y * nw + x] = k[(y + (h >> 1) - ry) * w + x + (w >> 1) - rx];
    out.push(rank1(c, nw, nh));
  }
  return { filters: out, tiles, tilesX: meta.numKernelsX, tilesY: meta.numKernelsY, lambdas: meta.lambdas };
}

// ---- the splat ---------------------------------------------------------------

import { forEachLensPixel, tileWeights, isDefect, sampleDepth, depthFilter } from './superres.js';
import { LAMBDA_TO_ALPHA } from './recipe.js';
import { createLfDemosaic } from './lfdemosaic.js';

// aperture: the engine's HexAperture value, LightfieldLogic::NominalApertureFraction = min(micro f-number / main f-number, 2 - that - 2 / pitch)
// clamped to 0..1, which is 1 - 2/14 on the 14 px standardized lightfield; 'hex' is HexAperture's shape (apothem 0.5 * value lens pitches),
// 'circle' the earlier disc of radius 0.5 * value.
// LightfieldLogic::NominalApertureFraction on the 14 px standardized lightfield (K: 2 for the ILLUM, 4 for the first generation).
export function nominalAperture(cam) {
  const fm = cam.mla && cam.mla.fNumberMicrolens;
  const fn = cam.capture && cam.capture.fNumber;
  if (!(fm > 0) && !(fn > 0)) return SPLAT.aperture;
  const ratio = fm / fn;
  const k = cam.bits === 12 ? 4 : 2;
  const clamp01 = (v) => Math.min(1, Math.max(0, v));
  return Math.min(clamp01(ratio), clamp01(2 - ratio - k / 14));
}

export const SPLAT = { aperture: 1 - 2 / 14, shape: 'hex', tolerance: 2, tolA: 1, tolB: 2, reach: 1, step: 1, demosaic: 'engine' };

// The raw picture corrected for the lens (black level, white balance,
// vignetting) at every pixel under a lens: NaN where it cannot be used.
export function correctedPlane(raw, cam, dev, g, vg, radius) {
  const { width, height } = cam;
  const plane = new Float32Array(width * height).fill(NaN);
  // SaturationState: pixels at the sensor's white keep their (clipped) value and are raised later by the diffusion.
  plane.sat = new Uint8Array(width * height);
  const binScale = vg.bins / (2 * vg.rMax);
  const binsSq = vg.bins * vg.bins;
  let lastLens = NaN;
  let tw = null;
  forEachLensPixel(g, cam, radius, (i, x, y, u, v, lensX, lensY) => {
    if (lensX + lensY * 1e6 !== lastLens) {
      lastLens = lensX + lensY * 1e6;
      tw = tileWeights(vg, x, y);
    }
    const ch = dev.cfa[y & 1][x & 1];
    const bin = Math.floor((v + vg.rMax) * binScale) * vg.bins + Math.floor((u + vg.rMax) * binScale);
    let gain = 0;
    for (const [t, w] of tw) gain += vg.gain[(t * binsSq + bin) * 3 + ch] * w;
    if (!(gain > 0)) return;
    let value = raw[i];
    if (isDefect(raw, width, i)) {
      // HotPixelCorrectionImage::SimpleCorrection: the mean of the two same-colour neighbours along the smoother axis, if the pixel is
      // 1.2 times brighter than it (cfg 0xa30) or above 0.99 of the white level.
      const b = dev.black[ch];
      const vert = Math.abs(raw[i - 2 * width] - raw[i + 2 * width]) + Math.abs(raw[i - width] - raw[i + width]);
      const horiz = Math.abs(raw[i - 2] - raw[i + 2]) + Math.abs(raw[i - 1] - raw[i + 1]);
      const est = (vert <= horiz ? raw[i - 2 * width] + raw[i + 2 * width] : raw[i - 2] + raw[i + 2]) * 0.5 - b;
      if (value - b > 1.2 * est || value > 0.99 * dev.saturated[ch]) value = est + b;
      else return;
    }
    if (value >= dev.saturated[ch]) plane.sat[i] = 1;
    plane[i] = Math.max(0, value - dev.black[ch]) * dev.scale[ch] * gain;
  });
  return plane;
}

// Bilinear demosaic of one pixel of the corrected plane: the pixel's own
// channel plus the mean of the nearest pixels of the other two.
function rgbAt(plane, width, cfa, x, y, out) {
  const ch = cfa[y & 1][x & 1];
  const at = (xx, yy) => plane[yy * width + xx];
  const mean = (list) => {
    let s = 0;
    let n = 0;
    for (const v of list) {
      if (v === v) {
        s += v;
        n++;
      }
    }
    return n ? s / n : NaN;
  };
  const own = at(x, y);
  const horiz = [at(x - 1, y), at(x + 1, y)];
  const vert = [at(x, y - 1), at(x, y + 1)];
  const diag = [at(x - 1, y - 1), at(x + 1, y - 1), at(x - 1, y + 1), at(x + 1, y + 1)];
  if (ch === 1) {
    // green: red and blue are the horizontal and vertical neighbours
    const hch = cfa[y & 1][(x + 1) & 1];
    out[1] = own;
    out[hch] = mean(horiz);
    out[hch === 0 ? 2 : 0] = mean(vert);
  } else {
    out[ch] = own;
    out[1] = mean(horiz.concat(vert));
    out[ch === 0 ? 2 : 0] = mean(diag);
  }
  return out[0] === out[0] && out[1] === out[1] && out[2] === out[2];
}

// Lytro's per ray depth (FUN_1809b8280): walk the ray's depth from the
// lowest to the highest depth near its lens and stop where the depth map at
// the ray's landing place agrees. Returns lambda, or NaN for none.
function marchRay(lx, ly, rdu, rdv, lam0, lam1, D, lw, lh, opts) {
  let far = Infinity;
  for (let lam = lam0; lam <= lam1; lam += opts.step) {
    const a = lam * LAMBDA_TO_ALPHA;
    const d = sampleDepth(D, lw, lh, lx - a * rdu, ly - a * rdv) / LAMBDA_TO_ALPHA;
    if (Math.abs(d - lam) < opts.tolA) return d;
    if (d < lam && far !== Infinity && far - d < opts.tolB) {
      const t = far - (lam - opts.step);
      return ((d - far) * t) / ((lam - d) + t) + far;
    }
    if (lam < d) far = d;
  }
  return far !== Infinity ? far : NaN;
}


// The engine demosaics the whole sensor, so every pixel needs a value: those
// not under a usable lens get the plain black level and white balance, and
// unusable ones (saturated, defect) the mean of their valid same colour
// neighbours (the engine's hot pixel and saturation recovery stages are not
// ported yet).
function completePlane(plane, raw, cam, dev) {
  const { width, height } = cam;
  const out = Float32Array.from(plane);
  const sat = plane.sat;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (plane[i] === plane[i]) continue;
      const ch = dev.cfa[y & 1][x & 1];
      let s = 0;
      let n = 0;
      for (const [dx, dy] of [[-2, 0], [2, 0], [0, -2], [0, 2]]) {
        const xx = x + dx;
        const yy = y + dy;
        if (xx < 0 || yy < 0 || xx >= width || yy >= height) continue;
        const v = plane[yy * width + xx];
        if (v === v) {
          s += v;
          n++;
        }
      }
      out[i] = n ? s / n : Math.max(0, raw[i] - dev.black[ch]) * dev.scale[ch];
      if (raw[i] >= dev.saturated[ch]) sat[i] = 1;
    }
  }
  diffuseSaturation(out, sat, width, height, dev.cfa);
  return out;
}

// SaturationRecoveryDiffusion (the engine's mode 1, on the mosaic before the
// demosaic): 20 in-place raster sweeps in which every saturated pixel becomes
// the mean of its four same-colour neighbours (diagonals at green, two pixels
// away at red and blue) if that is larger than its own value.
function diffuseSaturation(a, sat, W, H, cfa) {
  for (let it = 0; it < 20; it++) {
    for (let y = 2; y < H - 2; y++) {
      for (let x = 2; x < W - 2; x++) {
        const i = y * W + x;
        if (!sat[i]) continue;
        const m = cfa[y & 1][x & 1] === 1
          ? a[i - W - 1] + a[i - W + 1] + a[i + W - 1] + a[i + W + 1]
          : a[i - 2 * W] + a[i - 2] + a[i + 2] + a[i + 2 * W];
        const v = m * 0.25;
        if (a[i] < v) a[i] = v;
      }
    }
  }
}

// Splats the rays: premultiplied RGBA of W x H (alpha = summed weight).
export function lytroSplat({ raw, cam, dev, grid: g, sampler, vignetting: vg, depth, scale, lens, W, H, onProgress, rayWarp = null }, opts = SPLAT) {
  const { width } = cam;
  const unit = g.rowStep;
  const { xMin, yMin, outW: lw, outH: lh } = sampler;
  const hex = opts.shape !== 'circle';
  const apothem = g.pitch * opts.aperture * 0.5;
  // the pixels to read reach the hexagon's corners
  const radius = hex ? (apothem * 2) / Math.sqrt(3) : apothem;
  const hexRise = apothem / Math.sqrt(3);
  const plane = correctedPlane(raw, cam, dev, g, vg, radius + 2);
  const dm = opts.demosaic === 'engine' ? createLfDemosaic(completePlane(plane, raw, cam, dev), width, cam.height, dev.cfa) : null;
  // With the camera's ray table every ray carries the distortion correction itself (as in the engine), so there is no picture warp afterwards.
  const warp = rayWarp ? null : lensWarp(lens, W, H);
  const cosR = Math.cos(g.rotation);
  const sinR = Math.sin(g.rotation);
  const warpOut = [0, 0, 0, 0];
  let cell = null;
  let lastCell = NaN;
  // z of every output pixel, in lambda
  const zMap = new Float32Array(W * H);
  for (let j = 0; j < H; j++) {
    for (let k = 0; k < W; k++) {
      const [sx, sy] = warp ? warp.source(k + 0.5, j + 0.5) : [k + 0.5, j + 0.5];
      zMap[j * W + k] = sampleDepth(depth, lw, lh, sx / scale - 0.5, sy / scale - 0.5) / LAMBDA_TO_ALPHA;
    }
  }
  const lo = depthFilter(depth, lw, lh, opts.reach, Math.min);
  const hi = depthFilter(depth, lw, lh, opts.reach, Math.max);
  const acc = new Float32Array(W * H * 4);
  const rgb = [0, 0, 0];
  const r2 = radius * radius;
  let count = 0;
  let accepted = 0;
  forEachLensPixel(g, cam, radius, (i, x, y, u, v, lensX, lensY) => {
    if (hex) {
      // HexAperture::operator()(u, v): flat sides at |u| = apothem, corners on the v axis (u, v are in the lens array's own frame)
      const au = Math.abs(u);
      const av = Math.abs(v);
      if (au > apothem || av > 2 * hexRise || (av > hexRise && av + au / Math.sqrt(3) > 2 * hexRise)) return;
    } else if (u * u + v * v > r2) return;
    if (dm ? !(plane[i] === plane[i] && dm.at(x, y, rgb)) : !rgbAt(plane, width, dev.cfa, x, y, rgb)) return;
    let lx = (lensX - xMin) / unit;
    let ly = (lensY - yMin) / unit;
    let ru = u;
    let rv = v;
    if (rayWarp) {
      // The engine corrects every ray with the camera's table: where it comes
      // from (dx, dy: fractions of the picture) and its direction (du, dv: lens
      // pitches), then projects the corrected ray (HexLightfieldGeometry::Project).
      const key = lensX + lensY * 1e6;
      if (key !== lastCell) {
        lastCell = key;
        const cx = x - (cosR * u - sinR * v);
        const cy = y - (sinR * u + cosR * v);
        cell = rayWarp.lens(cx / cam.width - 0.5, cy / cam.height - 0.5);
      }
      rayWarp.fromLens(cell, u / g.pitch, v / g.pitch, warpOut);
      const sx = warpOut[0] * cam.width;
      const sy = warpOut[1] * cam.height;
      lx += (cosR * sx + sinR * sy) / unit;
      ly += (-sinR * sx + cosR * sy) / unit;
      ru += (cosR * warpOut[2] + sinR * warpOut[3]) * g.pitch;
      rv += (-sinR * warpOut[2] + cosR * warpOut[3]) * g.pitch;
    }
    const lam0 = sampleDepth(lo, lw, lh, lx, ly) / LAMBDA_TO_ALPHA;
    const lam1 = sampleDepth(hi, lw, lh, lx, ly) / LAMBDA_TO_ALPHA + 1;
    const lamR = marchRay(lx, ly, ru, rv, lam0, lam1, depth, lw, lh, opts);
    count++;
    if (!(lamR === lamR)) return;
    const a = lamR * LAMBDA_TO_ALPHA;
    let qx = (lx - a * ru) * scale;
    let qy = (ly - a * rv) * scale;
    if (warp) [qx, qy] = warp.forward(qx + 0.5, qy + 0.5).map((q) => q - 0.5);
    const x0 = Math.floor(qx);
    const y0 = Math.floor(qy);
    const fx = qx - x0;
    const fy = qy - y0;
    for (let j = 0; j < 2; j++) {
      for (let k = 0; k < 2; k++) {
        const xx = x0 + k;
        const yy = y0 + j;
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
        const p = yy * W + xx;
        if (lamR - zMap[p] >= opts.tolerance) continue;
        const w = (k ? fx : 1 - fx) * (j ? fy : 1 - fy);
        acc[4 * p] += rgb[0] * w;
        acc[4 * p + 1] += rgb[1] * w;
        acc[4 * p + 2] += rgb[2] * w;
        acc[4 * p + 3] += w;
        if (j === 0 && k === 0) accepted++;
      }
    }
  }, onProgress);
  return { acc, W, H, zMap, stats: { rays: count, accepted } };
}

// ---- hole filling (FUN_180c5fa60 and the pyramid FUN_180c60140) -------------

// One red black relaxation sweep of the filled picture B towards the data A
// (FUN_180c60990): every pixel becomes the sum of A's pixel and its four
// neighbours in B, divided by their summed weights (alpha), so alpha is 1.
function relax(A, B, w, h) {
  const upd = (x, y) => {
    const i = y * w + x;
    let r = A[4 * i];
    let g = A[4 * i + 1];
    let b = A[4 * i + 2];
    let a = A[4 * i + 3];
    const add = (j) => {
      r += B[4 * j];
      g += B[4 * j + 1];
      b += B[4 * j + 2];
      a += B[4 * j + 3];
    };
    if (y > 0) add(i - w);
    if (x > 0) add(i - 1);
    if (x < w - 1) add(i + 1);
    if (y < h - 1) add(i + w);
    if (a <= 0) {
      B[4 * i] = B[4 * i + 1] = B[4 * i + 2] = B[4 * i + 3] = 0;
    } else {
      B[4 * i] = r / a;
      B[4 * i + 1] = g / a;
      B[4 * i + 2] = b / a;
      B[4 * i + 3] = 1;
    }
  };
  for (let y = 0; y <= h; y++) {
    for (let x = ~y & 1; x < w; x += 2) {
      if (y < h) upd(x, y);
      if (y - 1 >= 0) upd(x, y - 1);
    }
  }
}

// 3 x 3 binomial reduction by two (FUN_180c5fee0); samples outside are skipped.
function reduce(src, w, h) {
  const nw = Math.ceil(w / 2);
  const nh = Math.ceil(h / 2);
  const out = new Float32Array(nw * nh * 4);
  const k = [0.25, 0.5, 0.25];
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let j = 0; j < 3; j++) {
        const yy = 2 * y - 1 + j;
        if (yy < 0 || yy >= h) continue;
        for (let i = 0; i < 3; i++) {
          const xx = 2 * x - 1 + i;
          if (xx < 0 || xx >= w) continue;
          const wt = k[i] * k[j];
          const q = 4 * (yy * w + xx);
          r += wt * src[q];
          g += wt * src[q + 1];
          b += wt * src[q + 2];
          a += wt * src[q + 3];
        }
      }
      const o = 4 * (y * nw + x);
      out[o] = r;
      out[o + 1] = g;
      out[o + 2] = b;
      out[o + 3] = a;
    }
  }
  return { data: out, w: nw, h: nh };
}

export const FILL = { full: 1, scale: 1, small: 1, minSize: 20, levels: 10, sweeps: 3 };

// The premultiplied splat as a picture (alpha 1 wherever anything reached it).
export function fillHoles(acc, W, H, o = FILL) {
  // pixels with enough weight become colour, the rest stay premultiplied
  const A0 = new Float32Array(acc.length);
  for (let p = 0; p < W * H; p++) {
    const a = acc[4 * p + 3];
    const f = a >= o.full ? o.scale / a : o.small;
    for (let c = 0; c < 4; c++) A0[4 * p + c] = acc[4 * p + c] * f;
  }
  const As = [{ data: A0, w: W, h: H }];
  const Bs = [{ data: new Float32Array(W * H * 4), w: W, h: H }];
  for (let l = 0; l < o.levels; l++) {
    const last = As[As.length - 1];
    if (last.w < o.minSize && last.h < o.minSize) break;
    const nw = Math.floor((last.w + 1) / 2);
    const nh = Math.floor((last.h + 1) / 2);
    As.push({ data: null, w: nw, h: nh });
    Bs.push({ data: new Float32Array(nw * nh * 4), w: nw, h: nh });
  }
  for (let l = 0; l + 1 < As.length; l++) As[l + 1] = reduce(As[l].data, As[l].w, As[l].h);
  for (let l = As.length - 1; l >= 1; l--) {
    for (let s = 0; s < o.sweeps; s++) relax(As[l].data, Bs[l].data, As[l].w, As[l].h);
    // the coarse result seeds the even pixels of the next finer level
    const c = Bs[l];
    const f = Bs[l - 1];
    for (let y = 0; y < c.h; y++) {
      for (let x = 0; x < c.w; x++) {
        const yy = 2 * y;
        const xx = 2 * x;
        if (yy >= f.h || xx >= f.w) continue;
        const q = 4 * (yy * f.w + xx);
        const s0 = 4 * (y * c.w + x);
        f.data[q] = c.data[s0];
        f.data[q + 1] = c.data[s0 + 1];
        f.data[q + 2] = c.data[s0 + 2];
        f.data[q + 3] = c.data[s0 + 3];
      }
    }
  }
  for (let s = 0; s < o.sweeps; s++) relax(As[0].data, Bs[0].data, W, H);
  return Bs[0].data;
}

// ---- the depth aware filter bank (FUN_180c651c0 and below) -------------------

// Weight of a neighbour whose lambda differs from the pixel's by d: the
// trapezoid through (-4, 0), (-2, 1), (2, 1), (4, 0), looked up at
// int(d + 4.5) (clamped to 0..8) as the table of whole numbers -4..4.
const RANGE_LUT = [0, 0.5, 1, 1, 1, 1, 1, 0.5, 0];

function entryIndex(bank, tx, ty, lam) {
  const L = bank.lambdas;
  let i;
  if (!(L[0] <= lam && lam !== L[0])) i = 0;
  else if (!(lam < L[L.length - 1])) i = L.length - 1;
  else {
    i = 0;
    while (L[i] <= lam) i++;
    if ((lam - L[i - 1]) * 2 <= L[i] - L[i - 1]) i--;
  }
  return (i * bank.tilesY + ty) * bank.tilesX + tx;
}

function ramp(n, total, i, m) {
  // window of tile i of `n` along an axis of `total` pixels with overlap m
  const a = Math.trunc((total * i) / n);
  const b = Math.trunc((total * (i + 1)) / n);
  const start = i > 0 ? a - m : a;
  const end = i < n - 1 ? b + m : b;
  const upEnd = i > 0 ? a + m : a;
  const downStart = i < n - 1 ? b - m : b;
  const w = new Float32Array(end - start);
  for (let x = start; x < end; x++) {
    let v = 1;
    if (x < upEnd) v = (x - start + 1) / (upEnd - start + 1);
    else if (x >= downStart) v = (end - x) / (end - downStart + 1);
    w[x - start] = v;
  }
  return { start, end, w };
}

// img: RGB (Float32 W*H*3), depth: lambda per pixel (Float32 W*H).
export function applyBank(img, depth, W, H, bank) {
  const out = new Float32Array(W * H * 3);
  const wsum = new Float32Array(W * H);
  const m = Math.trunc((H * BANK.overlap + 1) * 0.5);
  const tmp = new Float32Array(W * H * 3);
  for (let ty = 0; ty < bank.tilesY; ty++) {
    const ry = ramp(bank.tilesY, H, ty, m);
    for (let tx = 0; tx < bank.tilesX; tx++) {
      const rx = ramp(bank.tilesX, W, tx, m);
      const tw = rx.end - rx.start;
      const th = ry.end - ry.start;
      // horizontal pass over the tile (taps stay inside the tile)
      for (let y = 0; y < th; y++) {
        for (let x = 0; x < tw; x++) {
          const gi = (ry.start + y) * W + rx.start + x;
          const lc = depth[gi];
          const f = bank.filters[entryIndex(bank, tx, ty, lc)];
          const hw = f.row.length >> 1;
          const x0 = Math.max(0, x - hw);
          const x1 = Math.min(tw - 1, x + hw);
          let r = 0;
          let g = 0;
          let b = 0;
          let s = 0;
          for (let xx = x0; xx <= x1; xx++) {
            const q = (ry.start + y) * W + rx.start + xx;
            const idx = Math.min(8, Math.max(0, Math.trunc(depth[q] - lc + 4.5)));
            const wt = f.row[xx - x + hw] * RANGE_LUT[idx];
            r += wt * img[3 * q];
            g += wt * img[3 * q + 1];
            b += wt * img[3 * q + 2];
            s += wt;
          }
          tmp[3 * gi] = s > 0 ? r / s : 0;
          tmp[3 * gi + 1] = s > 0 ? g / s : 0;
          tmp[3 * gi + 2] = s > 0 ? b / s : 0;
        }
      }
      // vertical pass
      for (let y = 0; y < th; y++) {
        for (let x = 0; x < tw; x++) {
          const gi = (ry.start + y) * W + rx.start + x;
          const lc = depth[gi];
          const f = bank.filters[entryIndex(bank, tx, ty, lc)];
          const hh = f.col.length >> 1;
          const y0 = Math.max(0, y - hh);
          const y1 = Math.min(th - 1, y + hh);
          let r = 0;
          let g = 0;
          let b = 0;
          let s = 0;
          for (let yy = y0; yy <= y1; yy++) {
            const q = (ry.start + yy) * W + rx.start + x;
            const idx = Math.min(8, Math.max(0, Math.trunc(depth[q] - lc + 4.5)));
            const wt = f.col[yy - y + hh] * RANGE_LUT[idx];
            r += wt * tmp[3 * q];
            g += wt * tmp[3 * q + 1];
            b += wt * tmp[3 * q + 2];
            s += wt;
          }
          const win = rx.w[x] * ry.w[y];
          const k = win; // Lytro normalises by the weighted kernel sum (GridFilterImage1DDepthMasked), so the kernel gain cancels
          if (s > 0) {
            out[3 * gi] += (r / s) * k;
            out[3 * gi + 1] += (g / s) * k;
            out[3 * gi + 2] += (b / s) * k;
          }
          wsum[gi] += win;
        }
      }
    }
  }
  return { rgb: out, wsum };
}
