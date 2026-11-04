// The per-pixel filters of the depth map's region cleanup (core/segments.js) as fragment shaders: colorMedian, layerSnap and smoothRamps,
// the stages that cost the CPU seconds (the superpixel bookkeeping between them is small). Each returns the same values as its CPU
// version to float rounding, or null when it cannot run (the caller then uses the CPU version).

import { program } from './renderer.js';
import { OBJECT_COST } from '../core/segments.js';

const VERTEX = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

const HEAD = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp usampler2D;
out vec4 o;`;

// Weighted average of the neighbours within `radius` that are within `edge` in depth, weighted by distance, colour and (with objects) by the
// outline crossed: smoothRamps.
const SMOOTH_RAMPS = `${HEAD}
uniform sampler2D uDepth;
uniform sampler2D uLab;
uniform usampler2D uObj;
uniform int uHasObj;
uniform int uRadius;
uniform float uK;
uniform float uKc;
uniform float uEdge;
uniform float uCost;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 sz = textureSize(uDepth, 0);
  float d0 = texelFetch(uDepth, p, 0).r;
  vec3 l0 = texelFetch(uLab, p, 0).rgb;
  uint ob0 = uHasObj == 1 ? texelFetch(uObj, p, 0).r : 0u;
  float sum = 0.0;
  float wsum = 0.0;
  for (int dy = -uRadius; dy <= uRadius; dy++) {
    int yy = p.y + dy;
    if (yy < 0 || yy >= sz.y) continue;
    for (int dx = -uRadius; dx <= uRadius; dx++) {
      int xx = p.x + dx;
      if (xx < 0 || xx >= sz.x) continue;
      ivec2 q = ivec2(xx, yy);
      float d = texelFetch(uDepth, q, 0).r;
      if (abs(d - d0) > uEdge) continue;
      vec3 dl = texelFetch(uLab, q, 0).rgb - l0;
      float e = uK * float(dx * dx + dy * dy) + uKc * dot(dl, dl);
      if (uHasObj == 1 && texelFetch(uObj, q, 0).r != ob0) e -= uCost;
      float wt = exp(e);
      sum += d * wt;
      wsum += wt;
    }
  }
  o = vec4(sum / wsum);
}`;

// colorMedian: the weighted median of the quantised depths around each pixel (weights by distance and colour, tabulated as on the CPU).
const COLOR_MEDIAN = `${HEAD}
uniform sampler2D uDepth;
uniform sampler2D uQ;        // the quantised depth of each pixel, as a float
uniform sampler2D uLab;
uniform sampler2D uSpatial;  // (2r+1) x (2r+1) distance weights
uniform sampler2D uLut;      // 256 x 1 colour weights
uniform int uR;
uniform float uStep;
uniform float uLo;
uniform float uHi;
const int LEVELS = 128;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 sz = textureSize(uDepth, 0);
  float hist[LEVELS];
  for (int i = 0; i < LEVELS; i++) hist[i] = 0.0;
  float total = 0.0;
  vec3 l0 = texelFetch(uLab, p, 0).rgb;
  for (int dy = -uR; dy <= uR; dy++) {
    int yy = p.y + dy;
    if (yy < 0 || yy >= sz.y) continue;
    for (int dx = -uR; dx <= uR; dx++) {
      int xx = p.x + dx;
      if (xx < 0 || xx >= sz.x) continue;
      ivec2 j = ivec2(xx, yy);
      vec3 dl = texelFetch(uLab, j, 0).rgb - l0;
      float wt = texelFetch(uSpatial, ivec2(dx + uR, dy + uR), 0).r * texelFetch(uLut, ivec2(min(255, int(dot(dl, dl) / uStep)), 0), 0).r;
      hist[int(texelFetch(uQ, j, 0).r)] += wt;
      total += wt;
    }
  }
  float acc = 0.0;
  int k = 0;
  while (k < LEVELS - 1 && acc + hist[k] < total / 2.0) {
    acc += hist[k];
    k++;
  }
  float d = texelFetch(uDepth, p, 0).r;
  o = vec4(int(texelFetch(uQ, p, 0).r) == k ? d : uLo + ((float(k) + 0.5) / float(LEVELS)) * (uHi - uLo));
}`;

// layerSnap: where the depth around a pixel spans a lot, a pixel between the two ends takes the layer whose colour it is closer to.
const LAYER_SNAP = `${HEAD}
uniform sampler2D uDepth;
uniform sampler2D uLab;
uniform int uRadius;
uniform int uStride;
uniform float uTotal;
uniform float uMinRange;
uniform float uBand;
uniform float uMargin;
uniform int uHard;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 sz = textureSize(uDepth, 0);
  float d0 = texelFetch(uDepth, p, 0).r;
  o = vec4(d0);
  float wlo = 3.4e38;
  float whi = -3.4e38;
  for (int dy = -uRadius; dy <= uRadius; dy += uStride) {
    int yy = p.y + dy;
    if (yy < 0 || yy >= sz.y) continue;
    for (int dx = -uRadius; dx <= uRadius; dx += uStride) {
      int xx = p.x + dx;
      if (xx < 0 || xx >= sz.x) continue;
      float d = texelFetch(uDepth, ivec2(xx, yy), 0).r;
      wlo = min(wlo, d);
      whi = max(whi, d);
    }
  }
  float range = whi - wlo;
  if (range < uMinRange * uTotal) return;
  float t = (d0 - wlo) / range;
  if (t < uBand || t > 1.0 - uBand) return;
  vec3 nSum = vec3(0.0);
  vec3 fSum = vec3(0.0);
  float nC = 0.0;
  float fC = 0.0;
  float nVal = 0.0;
  float fVal = 0.0;
  for (int dy = -uRadius; dy <= uRadius; dy += uStride) {
    int yy = p.y + dy;
    if (yy < 0 || yy >= sz.y) continue;
    for (int dx = -uRadius; dx <= uRadius; dx += uStride) {
      int xx = p.x + dx;
      if (xx < 0 || xx >= sz.x) continue;
      ivec2 j = ivec2(xx, yy);
      float d = texelFetch(uDepth, j, 0).r;
      float u = (d - wlo) / range;
      if (u > 1.0 - uBand * 0.6) {
        nSum += texelFetch(uLab, j, 0).rgb;
        nC += 1.0;
        nVal += d;
      } else if (u < uBand * 0.6) {
        fSum += texelFetch(uLab, j, 0).rgb;
        fC += 1.0;
        fVal += d;
      }
    }
  }
  if (nC == 0.0 || fC == 0.0) return;
  vec3 l0 = texelFetch(uLab, p, 0).rgb;
  vec3 dn3 = l0 - nSum / nC;
  vec3 df3 = l0 - fSum / fC;
  float dn = dot(dn3, dn3);
  float df = dot(df3, df3);
  if (dn * uMargin < df) o = vec4(nVal / nC);
  else if (df * uMargin < dn) o = vec4(fVal / fC);
  else if (uHard == 1) o = vec4(t > 0.5 ? nVal / nC : fVal / fC);
}`;


// snapToObjects, pass 1: a pixel is interior when every pixel within `inner` (clipped to the picture) is in its object.
const OBJECT_INTERIOR = `${HEAD}
uniform usampler2D uObj;
uniform int uInner;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 sz = textureSize(uObj, 0);
  uint sig = texelFetch(uObj, p, 0).r;
  float same = 1.0;
  for (int dy = -uInner; dy <= uInner; dy++) {
    int yy = p.y + dy;
    if (yy < 0 || yy >= sz.y) continue;
    for (int dx = -uInner; dx <= uInner; dx++) {
      int xx = p.x + dx;
      if (xx < 0 || xx >= sz.x) continue;
      if (texelFetch(uObj, ivec2(xx, yy), 0).r != sig) same = 0.0;
    }
  }
  o = vec4(same);
}`;

// snapToObjects, pass 2: an outline pixel takes the weighted median depth of the interior pixels of its own object around it (every
// second pixel within `reach`, nearer counts more). The median is the smallest sample value whose cumulative weight reaches half the
// total, found by bisection on the value, then the smallest sample above the last value that fell short.
const OBJECT_SNAP = `${HEAD}
uniform sampler2D uDepth;
uniform sampler2D uInterior;
uniform usampler2D uObj;
uniform int uReach;
uniform float uK;
const int MAXS = 625;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 sz = textureSize(uDepth, 0);
  float d0 = texelFetch(uDepth, p, 0).r;
  o = vec4(d0);
  if (texelFetch(uInterior, p, 0).r > 0.5) return;
  uint sig = texelFetch(uObj, p, 0).r;
  float vals[MAXS];
  float wts[MAXS];
  int m = 0;
  float total = 0.0;
  float vmin = 3.4e38;
  float vmax = -3.4e38;
  for (int dy = -uReach; dy <= uReach; dy += 2) {
    int yy = p.y + dy;
    if (yy < 0 || yy >= sz.y) continue;
    for (int dx = -uReach; dx <= uReach; dx += 2) {
      int xx = p.x + dx;
      if (xx < 0 || xx >= sz.x) continue;
      ivec2 q = ivec2(xx, yy);
      if (texelFetch(uInterior, q, 0).r < 0.5 || texelFetch(uObj, q, 0).r != sig) continue;
      float wt = exp(uK * float(dx * dx + dy * dy));
      float v = texelFetch(uDepth, q, 0).r;
      vals[m] = v;
      wts[m] = wt;
      m++;
      total += wt;
      vmin = min(vmin, v);
      vmax = max(vmax, v);
    }
  }
  if (total < 0.05) return;
  float half_ = total / 2.0;
  float lo = vmin - 1.0;   // the cumulative weight up to lo is 0: short of half
  float hi = vmax;         // up to hi it is the total: enough
  for (int it = 0; it < 30; it++) {
    float mid = 0.5 * (lo + hi);
    if (mid <= lo || mid >= hi) break;
    float acc = 0.0;
    for (int i = 0; i < m; i++) if (vals[i] <= mid) acc += wts[i];
    if (acc >= half_) hi = mid; else lo = mid;
  }
  float best = vmax;
  for (int i = 0; i < m; i++) if (vals[i] > lo) best = min(best, vals[i]);
  o = vec4(best);
}`;

function programs(gpu) {
  if (!gpu.regionPrograms) {
    const gl = gpu.gl;
    gpu.regionPrograms = {
      smoothRamps: program(gl, SMOOTH_RAMPS, VERTEX),
      colorMedian: program(gl, COLOR_MEDIAN, VERTEX),
      layerSnap: program(gl, LAYER_SNAP, VERTEX),
      objectInterior: program(gl, OBJECT_INTERIOR, VERTEX),
      objectSnap: program(gl, OBJECT_SNAP, VERTEX),
    };
  }
  return gpu.regionPrograms;
}

function upload(gpu, w, h, internal, format, type, data) {
  const gl = gpu.gl;
  const t = gpu.texture(w, h, internal);
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, format, type, data);
  return t;
}

const uploadR = (gpu, w, h, data) => upload(gpu, w, h, gpu.gl.R32F, gpu.gl.RED, gpu.gl.FLOAT, data);

// Lab as 3 per pixel -> 4 per pixel.
function uploadLab(gpu, lab, w, h) {
  const rgba = new Float32Array(w * h * 4);
  for (let p = 0; p < w * h; p++) {
    rgba[4 * p] = lab[3 * p];
    rgba[4 * p + 1] = lab[3 * p + 1];
    rgba[4 * p + 2] = lab[3 * p + 2];
  }
  return upload(gpu, w, h, gpu.gl.RGBA32F, gpu.gl.RGBA, gpu.gl.FLOAT, rgba);
}

// Runs a program over the w x h picture and returns the red channel as a Float32Array.
function run(gpu, prog, w, h, setup, textures) {
  const gl = gpu.gl;
  const out = gpu.texture(w, h, gl.RGBA32F);
  try {
    gl.disable(gl.BLEND);
    gl.useProgram(prog.p);
    gpu.target(out, w, h);
    setup(prog.u);
    gpu.draw();
    const rgba = new Float32Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, rgba);
    const result = new Float32Array(w * h);
    for (let p = 0; p < w * h; p++) result[p] = rgba[4 * p];
    return result;
  } finally {
    gl.deleteTexture(out);
    for (const t of textures) gl.deleteTexture(t);
  }
}

// The GPU versions, or null where the graphics card cannot render to float textures. `fellBack(stage, error)` is told of a failure.
export function regionsGpu(gpu, fellBack = () => {}) {
  const gl = gpu && gpu.gl;
  if (!gl || !gpu.floatBlend) return null;
  const guard = (stage, f) => (...args) => {
    try {
      return f(...args);
    } catch (e) {
      fellBack(stage, e);
      return null;
    }
  };
  const bind = (U, units) => units.forEach(([name, tex], i) => {
    gpu.bindTex(i, tex);
    gl.uniform1i(U[name], i);
  });

  return {
    smoothRamps: guard('Smoothing the depth', (depth, lab, w, h, edge, objects = null, radius = 8, sigma = 4, colorSigma = 7) => {
      const prog = programs(gpu).smoothRamps;
      const dT = uploadR(gpu, w, h, depth);
      const lT = uploadLab(gpu, lab, w, h);
      const oT = objects ? upload(gpu, w, h, gl.R32UI, gl.RED_INTEGER, gl.UNSIGNED_INT, objects) : upload(gpu, 1, 1, gl.R32UI, gl.RED_INTEGER, gl.UNSIGNED_INT, new Uint32Array(1));
      return run(gpu, prog, w, h, (U) => {
        bind(U, [['uDepth', dT], ['uLab', lT], ['uObj', oT]]);
        gl.uniform1i(U.uHasObj, objects ? 1 : 0);
        gl.uniform1i(U.uRadius, radius);
        gl.uniform1f(U.uK, -1 / (2 * sigma * sigma));
        gl.uniform1f(U.uKc, -1 / (2 * colorSigma * colorSigma));
        gl.uniform1f(U.uEdge, Number.isFinite(edge) ? edge : 3.4e38);
        gl.uniform1f(U.uCost, OBJECT_COST);
      }, [dT, lT, oT]);
    }),

    colorMedian: guard('Sharpening depth edges', (depth, lab, w, h, r = 7, sigma = 9, levels = 128) => {
      if (levels !== 128) return null;
      let lo = Infinity;
      let hi = -Infinity;
      for (const d of depth) {
        if (d < lo) lo = d;
        if (d > hi) hi = d;
      }
      if (!(hi > lo)) return depth;
      const n = w * h;
      const q = new Float32Array(n);
      for (let i = 0; i < n; i++) q[i] = Math.min(levels - 1, Math.floor(((depth[i] - lo) / (hi - lo)) * levels));
      const STEP = 4;
      const lut = new Float32Array(256);
      for (let i = 0; i < 256; i++) lut[i] = Math.exp(-(i * STEP) / (2 * sigma * sigma));
      const side = 2 * r + 1;
      const spatial = new Float32Array(side * side);
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) spatial[(dy + r) * side + dx + r] = Math.exp(-(dx * dx + dy * dy) / (2 * (r * 0.7) ** 2));
      const prog = programs(gpu).colorMedian;
      const dT = uploadR(gpu, w, h, depth);
      const qT = uploadR(gpu, w, h, q);
      const lT = uploadLab(gpu, lab, w, h);
      const sT = uploadR(gpu, side, side, spatial);
      const uT = uploadR(gpu, 256, 1, lut);
      return run(gpu, prog, w, h, (U) => {
        bind(U, [['uDepth', dT], ['uQ', qT], ['uLab', lT], ['uSpatial', sT], ['uLut', uT]]);
        gl.uniform1i(U.uR, r);
        gl.uniform1f(U.uStep, STEP);
        gl.uniform1f(U.uLo, lo);
        gl.uniform1f(U.uHi, hi);
      }, [dT, qT, lT, sT, uT]);
    }),

    snapToObjects: guard('Snapping depth to objects', (depth, objects, w, h, inner = 10, reach = 24) => {
      if (((reach >> 1) * 2 + 1) ** 2 > 625 || reach % 2) return null;
      const progs = programs(gpu);
      const oT = upload(gpu, w, h, gl.R32UI, gl.RED_INTEGER, gl.UNSIGNED_INT, objects);
      const interior = run(gpu, progs.objectInterior, w, h, (U) => {
        bind(U, [['uObj', oT]]);
        gl.uniform1i(U.uInner, inner);
      }, []);
      const dT = uploadR(gpu, w, h, depth);
      const iT = uploadR(gpu, w, h, interior);
      return run(gpu, progs.objectSnap, w, h, (U) => {
        bind(U, [['uDepth', dT], ['uInterior', iT], ['uObj', oT]]);
        gl.uniform1i(U.uReach, reach);
        gl.uniform1f(U.uK, -1 / (2 * (reach / 2.5) ** 2));
      }, [oT, dT, iT]);
    }),

    layerSnap: guard('Layering the depth', (depth, lab, w, h, { radius = 12, stride = 2, minRange = 0.25, band = 0.3, margin = 1.4, hard = false } = {}) => {
      let lo = Infinity;
      let hi = -Infinity;
      for (const d of depth) {
        if (d < lo) lo = d;
        if (d > hi) hi = d;
      }
      const total = hi - lo;
      if (!(total > 0)) return depth;
      const prog = programs(gpu).layerSnap;
      const dT = uploadR(gpu, w, h, depth);
      const lT = uploadLab(gpu, lab, w, h);
      return run(gpu, prog, w, h, (U) => {
        bind(U, [['uDepth', dT], ['uLab', lT]]);
        gl.uniform1i(U.uRadius, radius);
        gl.uniform1i(U.uStride, stride);
        gl.uniform1f(U.uTotal, total);
        gl.uniform1f(U.uMinRange, minRange);
        gl.uniform1f(U.uBand, band);
        gl.uniform1f(U.uMargin, margin);
        gl.uniform1i(U.uHard, hard ? 1 : 0);
      }, [dT, lT]);
    }),
  };
}
