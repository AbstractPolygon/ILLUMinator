// The depth map's region cleanup (core/segments.js) on the graphics card. Every pixel-scale stage is a shader and the stages hand each other
// textures, so only the finished depth map comes back: colour to Lab, the SLIC superpixels (assignment and centre update), each region's
// confidence-weighted median / trust / colour (point scatters with additive and min blending, and a bisection on the value), the table of
// touching regions, then (after the small solve over the regions, which stays on the CPU: a few thousand nodes and a greedy sequential merge)
// the lookup of each pixel's region value, layerSnap, colorMedian, smoothRamps / the guided filter, and with objects snapToObjects and
// flattenHalos. Each function returns the same values as its CPU version to float rounding, or null when it cannot run (the caller then uses
// the CPU version).

import { program } from './renderer.js';
import { OBJECT_COST, pairWeight, solveRegions } from '../core/segments.js';

const VERTEX = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

const HEAD = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
precision highp usampler2D;
out vec4 o;`;

const SCATTER_FRAGMENT = `#version 300 es
precision highp float;
in vec4 vVal;
out vec4 o;
void main() { o = vVal; }`;

// A vertex shader that sends every pixel of the picture to its group's texel of a groups x 1 texture. `VALUE` is GLSL for the vec4 it adds.
const scatterVertex = (value, extra = '') => `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform sampler2D uGroup;   // the group of each pixel, as a float (negative: none)
uniform int uW;
uniform int uGroups;
${extra}
out vec4 vVal;
void main() {
  ivec2 p = ivec2(gl_VertexID % uW, gl_VertexID / uW);
  float gf = texelFetch(uGroup, p, 0).r;
  int g = int(gf);
  if (gf < 0.0) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 1.0;
    vVal = vec4(0.0);
    return;
  }
  gl_Position = vec4((float(g) + 0.5) / float(uGroups) * 2.0 - 1.0, 0.0, 0.0, 1.0);
  gl_PointSize = 1.0;
  ${value}
}`;

// ---- pixel stages -------------------------------------------------------------------------------------------------------------------

const LAB = `${HEAD}
uniform sampler2D uRgb;
float lin(float v) { return v <= 0.04045 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4); }
float f(float t) { return t > 0.008856 ? pow(t, 1.0 / 3.0) : 7.787 * t + 16.0 / 116.0; }
void main() {
  vec3 c = texelFetch(uRgb, ivec2(gl_FragCoord.xy), 0).rgb;
  float R = lin(c.r);
  float G = lin(c.g);
  float B = lin(c.b);
  float fx = f((0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.9505);
  float fy = f(0.2126 * R + 0.7152 * G + 0.0722 * B);
  float fz = f((0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.089);
  o = vec4(116.0 * fy - 16.0, 500.0 * (fx - fy), 200.0 * (fy - fz), 0.0);
}`;

// The first centres: Lab sampled at the grid positions. uPos: (cx, cy) per texel.
const SLIC_INIT = `${HEAD}
uniform sampler2D uLab;
uniform sampler2D uPos;
void main() {
  vec2 c = texelFetch(uPos, ivec2(gl_FragCoord.xy), 0).rg;
  vec3 l = texelFetch(uLab, ivec2(int(floor(c.x)), int(floor(c.y))), 0).rgb;
  o = vec4(l, 0.0);
}`;

// Each pixel takes the nearest of the centres whose window holds it (the lowest index on ties), as in slic().
const SLIC_ASSIGN = `${HEAD}
uniform sampler2D uLab;
uniform sampler2D uCenterPos;  // k x 1: (cx, cy)
uniform sampler2D uCenterLab;  // k x 1: (l, a, b)
uniform int uCols;
uniform int uRows;
uniform float uStep;
uniform float uM2;
uniform int uS;
uniform int uReach;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 sz = textureSize(uLab, 0);
  vec3 l = texelFetch(uLab, p, 0).rgb;
  int gc = clamp(int(float(p.x) / uStep), 0, uCols - 1);
  int gr = clamp(int(float(p.y) / uStep), 0, uRows - 1);
  float best = 3.4e38;
  float label = -1.0;
  for (int r = max(0, gr - uReach); r <= min(uRows - 1, gr + uReach); r++) {
    for (int c = max(0, gc - uReach); c <= min(uCols - 1, gc + uReach); c++) {
      int idx = r * uCols + c;
      vec2 cp = texelFetch(uCenterPos, ivec2(idx, 0), 0).rg;
      int x0 = max(0, int(floor(cp.x - float(uS))));
      int x1 = min(sz.x - 1, int(ceil(cp.x + float(uS))));
      int y0 = max(0, int(floor(cp.y - float(uS))));
      int y1 = min(sz.y - 1, int(ceil(cp.y + float(uS))));
      if (p.x < x0 || p.x > x1 || p.y < y0 || p.y > y1) continue;
      vec3 d3 = l - texelFetch(uCenterLab, ivec2(idx, 0), 0).rgb;
      vec2 dp = vec2(p) - cp;
      float d = dot(d3, d3) + dot(dp, dp) * uM2;
      if (d < best) {
        best = d;
        label = float(idx);
      }
    }
  }
  o = vec4(label);
}`;

// Pixels no centre reached join the pixel before them in raster order (after its own fix), as in slic(). Rare.
const SLIC_FIX = `${HEAD}
uniform sampler2D uLabel;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 sz = textureSize(uLabel, 0);
  float l = texelFetch(uLabel, p, 0).r;
  if (l >= 0.0) { o = vec4(l); return; }
  int idx = p.y * sz.x + p.x;
  for (int i = 1; i < 4096; i++) {
    int j = idx - i;
    if (j < 0) { o = vec4(0.0); return; }
    float v = texelFetch(uLabel, ivec2(j % sz.x, j / sz.x), 0).r;
    if (v >= 0.0) { o = vec4(v); return; }
  }
  o = vec4(0.0);
}`;

// New centres from the sums (x, y, count) and (l, a, b); a centre nobody joined keeps its old place.
const SLIC_UPDATE = `${HEAD}
uniform sampler2D uSumPos;
uniform sampler2D uSumLab;
uniform sampler2D uOldPos;
uniform sampler2D uOldLab;
uniform int uWhich;  // 0: positions, 1: colours
void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  vec4 sp = texelFetch(uSumPos, t, 0);
  float n = sp.z;
  if (n > 0.0) {
    o = uWhich == 0 ? vec4(sp.xy / n, 0.0, 0.0) : vec4(texelFetch(uSumLab, t, 0).rgb / n, 0.0);
  } else {
    o = uWhich == 0 ? texelFetch(uOldPos, t, 0) : texelFetch(uOldLab, t, 0);
  }
}`;

// The region of each pixel -> its value.
const LOOKUP = `${HEAD}
uniform sampler2D uLabel;
uniform sampler2D uValue;
void main() {
  float l = texelFetch(uLabel, ivec2(gl_FragCoord.xy), 0).r;
  o = vec4(texelFetch(uValue, ivec2(int(l), 0), 0).r);
}`;

// The regions that touch each region: for region c (a texel of the k x ROWS table) the first 4 * ROWS different labels next to a pixel of c,
// scanned over the window around its centre. Each fragment writes 4 of them; a region with more is flagged by -2 in its first slot.
const NEIGHBORS = `${HEAD}
uniform sampler2D uLabel;
uniform sampler2D uCenterPos;
uniform int uWindow;
const int SLOTS = 24;
void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  int c = t.x;
  ivec2 sz = textureSize(uLabel, 0);
  vec2 cp = texelFetch(uCenterPos, ivec2(c, 0), 0).rg;
  int x0 = max(0, int(floor(cp.x)) - uWindow);
  int x1 = min(sz.x - 1, int(floor(cp.x)) + uWindow);
  int y0 = max(0, int(floor(cp.y)) - uWindow);
  int y1 = min(sz.y - 1, int(floor(cp.y)) + uWindow);
  int list[SLOTS];
  int n = 0;
  bool over = false;
  float fc = float(c);
  for (int y = y0; y <= y1; y++) {
    for (int x = x0; x <= x1; x++) {
      if (texelFetch(uLabel, ivec2(x, y), 0).r != fc) continue;
      for (int d = 0; d < 4; d++) {
        ivec2 q = ivec2(x, y) + (d == 0 ? ivec2(1, 0) : d == 1 ? ivec2(-1, 0) : d == 2 ? ivec2(0, 1) : ivec2(0, -1));
        if (q.x < 0 || q.y < 0 || q.x >= sz.x || q.y >= sz.y) continue;
        int nb = int(texelFetch(uLabel, q, 0).r);
        if (nb == c) continue;
        bool seen = false;
        for (int i = 0; i < SLOTS; i++) {
          if (i >= n) break;
          if (list[i] == nb) { seen = true; break; }
        }
        if (seen) continue;
        if (n < SLOTS) list[n++] = nb; else over = true;
      }
    }
  }
  vec4 r = vec4(-1.0);
  for (int k = 0; k < 4; k++) {
    int i = t.y * 4 + k;
    if (i < n) r[k] = float(list[i]);
  }
  if (over && t.y == 0) r[0] = -2.0;
  o = r;
}`;

// ---- the per-pixel filters (see core/segments.js) ----------------------------------------------------------------------------------------

// min and max of a texture, halving the size each pass (r: min, g: max). The first pass reads the depth itself.
const MINMAX = `${HEAD}
uniform sampler2D uSrc;
uniform int uFirst;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy) * 2;
  ivec2 sz = textureSize(uSrc, 0);
  float lo = 3.4e38;
  float hi = -3.4e38;
  for (int dy = 0; dy < 2; dy++) {
    for (int dx = 0; dx < 2; dx++) {
      ivec2 q = p + ivec2(dx, dy);
      if (q.x >= sz.x || q.y >= sz.y) continue;
      vec4 v = texelFetch(uSrc, q, 0);
      if (uFirst == 1) { lo = min(lo, v.r); hi = max(hi, v.r); }
      else { lo = min(lo, v.r); hi = max(hi, v.g); }
    }
  }
  o = vec4(lo, hi, 0.0, 0.0);
}`;

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

// The quantised depth of each pixel (colorMedian's histogram bins), from the picture's min and max.
const QUANT = `${HEAD}
uniform sampler2D uDepth;
uniform sampler2D uMinMax;
void main() {
  vec2 m = texelFetch(uMinMax, ivec2(0, 0), 0).rg;
  float d = texelFetch(uDepth, ivec2(gl_FragCoord.xy), 0).r;
  o = vec4(m.g > m.r ? min(127.0, floor(((d - m.r) / (m.g - m.r)) * 128.0)) : 0.0);
}`;

const COLOR_MEDIAN = `${HEAD}
uniform sampler2D uDepth;
uniform sampler2D uQ;
uniform sampler2D uMinMax;
uniform sampler2D uLab;
uniform sampler2D uSpatial;
uniform sampler2D uLut;
uniform int uR;
uniform float uStep;
const int LEVELS = 128;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 sz = textureSize(uDepth, 0);
  vec2 m = texelFetch(uMinMax, ivec2(0, 0), 0).rg;
  float d = texelFetch(uDepth, p, 0).r;
  if (!(m.g > m.r)) { o = vec4(d); return; }
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
  o = vec4(int(texelFetch(uQ, p, 0).r) == k ? d : m.r + ((float(k) + 0.5) / float(LEVELS)) * (m.g - m.r));
}`;

const LAYER_SNAP = `${HEAD}
uniform sampler2D uDepth;
uniform sampler2D uLab;
uniform sampler2D uMinMax;
uniform int uRadius;
uniform int uStride;
uniform float uMinRange;
uniform float uBand;
uniform float uMargin;
uniform int uHard;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 sz = textureSize(uDepth, 0);
  float d0 = texelFetch(uDepth, p, 0).r;
  o = vec4(d0);
  vec2 mm = texelFetch(uMinMax, ivec2(0, 0), 0).rg;
  float uTotal = mm.g - mm.r;
  if (!(uTotal > 0.0)) return;
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

// An outline pixel takes the weighted median depth of the interior pixels of its own object around it: the smallest sample value whose
// cumulative weight reaches half the total, found by bisection on the value, then the smallest sample above the last value that fell short.
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
  float lo = vmin - 1.0;
  float hi = vmax;
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

// The guided filter's pieces: pack (I, p, I I, I p), box sums (clipped windows, so the mean divides by the window's own pixel count),
// the coefficients, the output.
const GUIDE_PACK = `${HEAD}
uniform sampler2D uDepth;
uniform sampler2D uLab;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float I = texelFetch(uLab, p, 0).r / 100.0;
  float d = texelFetch(uDepth, p, 0).r;
  o = vec4(I, d, I * I, I * d);
}`;
const BOX = `${HEAD}
uniform sampler2D uSrc;
uniform ivec2 uAxis;
uniform int uR;
uniform int uMean;  // divide by the pixel count of the clipped window (second pass of a mean)
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 sz = textureSize(uSrc, 0);
  vec4 s = vec4(0.0);
  for (int t = -uR; t <= uR; t++) {
    ivec2 q = p + uAxis * t;
    if (q.x < 0 || q.y < 0 || q.x >= sz.x || q.y >= sz.y) continue;
    s += texelFetch(uSrc, q, 0);
  }
  o = s;
}`;
const BOX_MEAN_V = `${HEAD}
uniform sampler2D uSrc;   // horizontal sums
uniform int uR;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 sz = textureSize(uSrc, 0);
  vec4 s = vec4(0.0);
  int cy = 0;
  for (int t = -uR; t <= uR; t++) {
    int y = p.y + t;
    if (y < 0 || y >= sz.y) continue;
    s += texelFetch(uSrc, ivec2(p.x, y), 0);
    cy++;
  }
  int cx = min(sz.x - 1, p.x + uR) - max(0, p.x - uR) + 1;
  o = s / float(cx * cy);
}`;
const GUIDE_AB = `${HEAD}
uniform sampler2D uMean;
uniform float uEps;
void main() {
  vec4 m = texelFetch(uMean, ivec2(gl_FragCoord.xy), 0);  // mI, mp, mII, mIp
  float varI = m.z - m.x * m.x;
  float a = (m.w - m.x * m.y) / (varI + uEps);
  o = vec4(a, m.y - a * m.x, 0.0, 0.0);
}`;
const GUIDE_OUT = `${HEAD}
uniform sampler2D uAB;
uniform sampler2D uLab;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec2 ab = texelFetch(uAB, p, 0).rg;
  o = vec4(ab.x * (texelFetch(uLab, p, 0).r / 100.0) + ab.y);
}`;

// ---- region statistics: scatters and a bisection -------------------------------------------------------------------------------------------

const SC_COUNT_TRUST = scatterVertex('vVal = vec4(texelFetch(uConf, p, 0).r + 1e-4, 1.0, 0.0, 0.0);', 'uniform sampler2D uConf;');
const SC_LAB = scatterVertex('vVal = vec4(texelFetch(uLab, p, 0).rgb, 0.0);', 'uniform sampler2D uLab;');
const SC_POS_COUNT = scatterVertex('vVal = vec4(float(p.x), float(p.y), 1.0, 0.0);');
const SC_MINMAX = scatterVertex('float a = texelFetch(uAlpha, p, 0).r; vVal = vec4(a, -a, 0.0, 0.0);', 'uniform sampler2D uAlpha;');
// weight of the pixels at or below the region's trial value (loHi: lo, hi per region)
const SC_BELOW = scatterVertex(
  `vec2 lh = texelFetch(uLoHi, ivec2(g, 0), 0).rg;
  float mid = 0.5 * (lh.x + lh.y);
  vVal = vec4(texelFetch(uAlpha, p, 0).r <= mid ? texelFetch(uConf, p, 0).r + 1e-4 : 0.0, 0.0, 0.0, 0.0);`,
  'uniform sampler2D uAlpha; uniform sampler2D uConf; uniform sampler2D uLoHi;',
);
// the smallest value above the region's lo
const SC_ABOVE = scatterVertex(
  `float a = texelFetch(uAlpha, p, 0).r;
  vVal = vec4(a > texelFetch(uLoHi, ivec2(g, 0), 0).r ? a : 3.4e38, 0.0, 0.0, 0.0);`,
  'uniform sampler2D uAlpha; uniform sampler2D uLoHi;',
);

const BISECT_INIT = `${HEAD}
uniform sampler2D uMinMax;   // (min, -max) per region
void main() {
  vec2 m = texelFetch(uMinMax, ivec2(gl_FragCoord.xy), 0).rg;
  o = vec4(m.x - 1.0, -m.y, 0.0, 0.0);
}`;
const BISECT_STEP = `${HEAD}
uniform sampler2D uLoHi;
uniform sampler2D uBelow;   // weight (or count) at or below the trial value
uniform sampler2D uThresh;  // the weight (or count) the median must reach
void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  vec2 lh = texelFetch(uLoHi, t, 0).rg;
  float mid = 0.5 * (lh.x + lh.y);
  if (mid <= lh.x || mid >= lh.y) { o = vec4(lh, 0.0, 0.0); return; }
  if (texelFetch(uBelow, t, 0).r >= texelFetch(uThresh, t, 0).r) o = vec4(lh.x, mid, 0.0, 0.0);
  else o = vec4(mid, lh.y, 0.0, 0.0);
}`;
const THRESH_HALF = `${HEAD}
uniform sampler2D uTotal;
void main() { o = vec4(texelFetch(uTotal, ivec2(gl_FragCoord.xy), 0).r / 2.0); }`;
const THRESH_COUNT = `${HEAD}
uniform sampler2D uCount;
void main() { o = vec4(floor(texelFetch(uCount, ivec2(gl_FragCoord.xy), 0).r / 2.0) + 1.0); }`;


// ---- flattenHalos: robust plane fits per big object, the distance to its outline, and the pull of the halo onto the plane ------------------

const SLOT = `${HEAD}
uniform usampler2D uObj;
uniform uint uLabels[32];
uniform int uM;
void main() {
  uint l = texelFetch(uObj, ivec2(gl_FragCoord.xy), 0).r;
  float slot = -1.0;
  for (int i = 0; i < 32; i++) {
    if (i >= uM) break;
    if (uLabels[i] == l) { slot = float(i); break; }
  }
  o = vec4(slot);
}`;
const SC_ONE = scatterVertex('vVal = vec4(1.0, 0.0, 0.0, 0.0);');
const SC_BELOW_N = scatterVertex(
  `vec2 lh = texelFetch(uLoHi, ivec2(g, 0), 0).rg;
  vVal = vec4(texelFetch(uAlpha, p, 0).r <= 0.5 * (lh.x + lh.y) ? 1.0 : 0.0, 0.0, 0.0, 0.0);`,
  'uniform sampler2D uAlpha; uniform sampler2D uLoHi;',
);
// |depth - median of its object|
const ABS_DEV = `${HEAD}
uniform sampler2D uDepth;
uniform sampler2D uSlot;
uniform sampler2D uMedian;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int s = int(texelFetch(uSlot, p, 0).r);
  o = vec4(s < 0 ? 0.0 : abs(texelFetch(uDepth, p, 0).r - texelFetch(uMedian, ivec2(s, 0), 0).r));
}`;
const HALO_W0 = `${HEAD}
uniform sampler2D uDev;
uniform sampler2D uSlot;
uniform sampler2D uSpread;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int s = int(texelFetch(uSlot, p, 0).r);
  if (s < 0) { o = vec4(0.0); return; }
  float spread = texelFetch(uSpread, ivec2(s, 0), 0).r;
  o = vec4(texelFetch(uDev, p, 0).r < max(0.05, 2.5 * spread) ? 1.0 : 0.02);
}`;
// sums of the weighted normal equations in coordinates centred on the picture: x' = x / w - 0.5, y' = y / h - 0.5
const planeSums = (value) => scatterVertex(
  `float x = float(p.x) / float(uSize.x) - 0.5;
  float y = float(p.y) / float(uSize.y) - 0.5;
  float d = texelFetch(uDepth, p, 0).r;
  float wt = texelFetch(uWeight, p, 0).r;
  ${value}`,
  'uniform sampler2D uDepth; uniform sampler2D uWeight; uniform ivec2 uSize;',
);
const SC_SUMS1 = planeSums('vVal = wt * vec4(x * x, x * y, x, y * y);');
const SC_SUMS2 = planeSums('vVal = wt * vec4(y, 1.0, x * d, y * d);');
const SC_SUMS3 = planeSums('vVal = vec4(wt * d, 0.0, 0.0, 0.0);');
// Cramer's rule per object, then back to the uncentred plane d = a x + b y + c; a (near) singular system keeps the old plane.
const PLANE_SOLVE = `${HEAD}
uniform sampler2D uS1;
uniform sampler2D uS2;
uniform sampler2D uS3;
uniform sampler2D uOld;
float det3(float a, float b, float c, float d, float e, float f, float g, float h, float i) {
  return a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
}
void main() {
  ivec2 t = ivec2(gl_FragCoord.xy);
  vec4 s1 = texelFetch(uS1, t, 0);
  vec4 s2 = texelFetch(uS2, t, 0);
  float sd = texelFetch(uS3, t, 0).r;
  float sxx = s1.x, sxy = s1.y, sx = s1.z, syy = s1.w, sy = s2.x, s1w = s2.y, sxd = s2.z, syd = s2.w;
  float D = det3(sxx, sxy, sx, sxy, syy, sy, sx, sy, s1w);
  if (abs(D) < 1e-9) { o = texelFetch(uOld, t, 0); return; }
  float a = det3(sxd, sxy, sx, syd, syy, sy, sd, sy, s1w) / D;
  float b = det3(sxx, sxd, sx, sxy, syd, sy, sx, sd, s1w) / D;
  float c = det3(sxx, sxy, sxd, sxy, syy, syd, sx, sy, sd) / D;
  o = vec4(a, b, c - 0.5 * a - 0.5 * b, 0.0);
}`;
const PLANE_INIT = `${HEAD}
uniform sampler2D uMedian;
void main() { o = vec4(0.0, 0.0, texelFetch(uMedian, ivec2(gl_FragCoord.xy), 0).r, 0.0); }`;
const HALO_RESID = `${HEAD}
uniform sampler2D uDepth;
uniform sampler2D uSlot;
uniform sampler2D uPlane;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 sz = textureSize(uDepth, 0);
  int s = int(texelFetch(uSlot, p, 0).r);
  if (s < 0) { o = vec4(0.0); return; }
  vec4 pl = texelFetch(uPlane, ivec2(s, 0), 0);
  o = vec4(abs(texelFetch(uDepth, p, 0).r - (pl.x * (float(p.x) / float(sz.x)) + pl.y * (float(p.y) / float(sz.y)) + pl.z)));
}`;
const HALO_WEIGHTS = `${HEAD}
uniform sampler2D uResid;
uniform sampler2D uSlot;
uniform sampler2D uMad;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int s = int(texelFetch(uSlot, p, 0).r);
  if (s < 0) { o = vec4(0.0); return; }
  float c = max(0.05, 2.5 * texelFetch(uMad, ivec2(s, 0), 0).r);
  float r = texelFetch(uResid, p, 0).r;
  float q = c / r;
  o = vec4(r < c ? 1.0 : q * q);
}`;
// distance (4-neighbour steps inside the object) to the object's outline, up to the band; the outline: a pixel with a different label next to it
const HALO_OUTLINE = `${HEAD}
uniform usampler2D uObj;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 sz = textureSize(uObj, 0);
  uint l = texelFetch(uObj, p, 0).r;
  bool edge = false;
  if (p.x > 0 && texelFetch(uObj, p + ivec2(-1, 0), 0).r != l) edge = true;
  if (p.x < sz.x - 1 && texelFetch(uObj, p + ivec2(1, 0), 0).r != l) edge = true;
  if (p.y > 0 && texelFetch(uObj, p + ivec2(0, -1), 0).r != l) edge = true;
  if (p.y < sz.y - 1 && texelFetch(uObj, p + ivec2(0, 1), 0).r != l) edge = true;
  o = vec4(l != 0u && edge ? 0.0 : 1e9);
}`;
const HALO_RELAX = `${HEAD}
uniform sampler2D uDist;
uniform usampler2D uObj;
uniform float uBand;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 sz = textureSize(uObj, 0);
  uint l = texelFetch(uObj, p, 0).r;
  float d = texelFetch(uDist, p, 0).r;
  for (int k = 0; k < 4; k++) {
    ivec2 q = p + (k == 0 ? ivec2(-1, 0) : k == 1 ? ivec2(1, 0) : k == 2 ? ivec2(0, -1) : ivec2(0, 1));
    if (q.x < 0 || q.y < 0 || q.x >= sz.x || q.y >= sz.y) continue;
    if (texelFetch(uObj, q, 0).r != l) continue;
    float v = texelFetch(uDist, q, 0).r;
    if (v < uBand && v + 1.0 < d) d = v + 1.0;
  }
  o = vec4(d);
}`;
const HALO_APPLY = `${HEAD}
uniform sampler2D uDepth;
uniform sampler2D uSlot;
uniform sampler2D uPlane;
uniform sampler2D uMad;
uniform sampler2D uDist;
uniform float uBand;
uniform float uOff;
uniform float uFlat;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 sz = textureSize(uDepth, 0);
  float d = texelFetch(uDepth, p, 0).r;
  o = vec4(d);
  int s = int(texelFetch(uSlot, p, 0).r);
  if (s < 0) return;
  if (texelFetch(uMad, ivec2(s, 0), 0).r > uFlat) return;
  if (texelFetch(uDist, p, 0).r > uBand) return;
  vec4 pl = texelFetch(uPlane, ivec2(s, 0), 0);
  float v = pl.x * (float(p.x) / float(sz.x)) + pl.y * (float(p.y) / float(sz.y)) + pl.z;
  if (abs(d - v) > uOff) o = vec4(v);
}`;


// The object model's input: brightness, and the resize to a long side of 1024 with the exposure and gamma (core/segmodel.js segmentInput).
const SEG_LUMA = `${HEAD}
uniform sampler2D uRgb;
void main() {
  vec3 c = texelFetch(uRgb, ivec2(gl_FragCoord.xy), 0).rgb;
  o = vec4(0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b);
}`;
const SEG_RESIZE = `${HEAD}
uniform sampler2D uRgb;
uniform sampler2D uWhite;
uniform float uScale;
void main() {
  ivec2 sz = textureSize(uRgb, 0);
  float white = max(1e-4, texelFetch(uWhite, ivec2(0, 0), 0).r);
  vec2 s = min(vec2(sz - 1), (gl_FragCoord.xy - 0.5) / uScale);
  ivec2 p0 = ivec2(floor(s));
  ivec2 p1 = min(sz - 1, p0 + 1);
  vec2 a = s - vec2(p0);
  vec3 v = (texelFetch(uRgb, p0, 0).rgb * (1.0 - a.x) + texelFetch(uRgb, ivec2(p1.x, p0.y), 0).rgb * a.x) * (1.0 - a.y)
         + (texelFetch(uRgb, ivec2(p0.x, p1.y), 0).rgb * (1.0 - a.x) + texelFetch(uRgb, p1, 0).rgb * a.x) * a.y;
  o = vec4(255.0 * pow(clamp(v / white, 0.0, 1.0), vec3(1.0 / 2.2)), 0.0);
}`;

// ---- host ---------------------------------------------------------------------------------------------------------------------------

function programs(gpu) {
  if (!gpu.regionPrograms) {
    const gl = gpu.gl;
    const frag = (src) => program(gl, src, VERTEX);
    const sc = (vs) => program(gl, SCATTER_FRAGMENT, vs);
    gpu.regionPrograms = {
      lab: frag(LAB),
      slicInit: frag(SLIC_INIT),
      slicAssign: frag(SLIC_ASSIGN),
      slicFix: frag(SLIC_FIX),
      slicUpdate: frag(SLIC_UPDATE),
      lookup: frag(LOOKUP),
      neighbors: frag(NEIGHBORS),
      minmax: frag(MINMAX),
      smoothRamps: frag(SMOOTH_RAMPS),
      quant: frag(QUANT),
      colorMedian: frag(COLOR_MEDIAN),
      layerSnap: frag(LAYER_SNAP),
      objectInterior: frag(OBJECT_INTERIOR),
      objectSnap: frag(OBJECT_SNAP),
      guidePack: frag(GUIDE_PACK),
      box: frag(BOX),
      boxMeanV: frag(BOX_MEAN_V),
      guideAb: frag(GUIDE_AB),
      guideOut: frag(GUIDE_OUT),
      bisectInit: frag(BISECT_INIT),
      bisectStep: frag(BISECT_STEP),
      segLuma: frag(SEG_LUMA),
      segResize: frag(SEG_RESIZE),
      threshHalf: frag(THRESH_HALF),
      threshCount: frag(THRESH_COUNT),
      slot: frag(SLOT),
      scOne: sc(SC_ONE),
      scBelowN: sc(SC_BELOW_N),
      absDev: frag(ABS_DEV),
      haloW0: frag(HALO_W0),
      scSums1: sc(SC_SUMS1),
      scSums2: sc(SC_SUMS2),
      scSums3: sc(SC_SUMS3),
      planeSolve: frag(PLANE_SOLVE),
      planeInit: frag(PLANE_INIT),
      haloResid: frag(HALO_RESID),
      haloWeights: frag(HALO_WEIGHTS),
      haloOutline: frag(HALO_OUTLINE),
      haloRelax: frag(HALO_RELAX),
      haloApply: frag(HALO_APPLY),
      scCountTrust: sc(SC_COUNT_TRUST),
      scLab: sc(SC_LAB),
      scPosCount: sc(SC_POS_COUNT),
      scMinMax: sc(SC_MINMAX),
      scBelow: sc(SC_BELOW),
      scAbove: sc(SC_ABOVE),
    };
  }
  return gpu.regionPrograms;
}

// A run's textures, deleted together.
class Scope {
  constructor(gpu) {
    this.gpu = gpu;
    this.gl = gpu.gl;
    this.list = [];
    this.prog = programs(gpu);
  }

  tex(w, h, internal = this.gl.RGBA32F) {
    const t = this.gpu.texture(w, h, internal);
    this.list.push(t);
    return t;
  }

  up(w, h, internal, format, type, data) {
    const gl = this.gl;
    const t = this.tex(w, h, internal);
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, format, type, data);
    return t;
  }

  upR(w, h, data) {
    return this.up(w, h, this.gl.R32F, this.gl.RED, this.gl.FLOAT, data);
  }

  upRGBA(w, h, data) {
    return this.up(w, h, this.gl.RGBA32F, this.gl.RGBA, this.gl.FLOAT, data);
  }

  upU(w, h, data) {
    return this.up(w, h, this.gl.R32UI, this.gl.RED_INTEGER, this.gl.UNSIGNED_INT, data);
  }

  // Lab / rgb as 3 per pixel -> a 4 per pixel texture.
  up3(w, h, data) {
    const rgba = new Float32Array(w * h * 4);
    for (let p = 0; p < w * h; p++) {
      rgba[4 * p] = data[3 * p];
      rgba[4 * p + 1] = data[3 * p + 1];
      rgba[4 * p + 2] = data[3 * p + 2];
    }
    return this.upRGBA(w, h, rgba);
  }

  bind(U, units) {
    units.forEach(([name, tex], i) => {
      this.gpu.bindTex(i, tex);
      this.gl.uniform1i(U[name], i);
    });
  }

  // A full-screen pass into a new w x h RGBA32F texture.
  pass(prog, w, h, setup) {
    const gl = this.gl;
    const out = this.tex(w, h);
    gl.disable(gl.BLEND);
    gl.useProgram(prog.p);
    this.gpu.target(out, w, h);
    setup(prog.u);
    this.gpu.draw();
    return out;
  }

  // Every pixel of the w x h picture added (or min-blended) into its group's texel of a groups x 1 texture.
  scatter(prog, w, h, groups, groupTex, setup, { min = false, clear = [0, 0, 0, 0] } = {}) {
    const gl = this.gl;
    const out = this.tex(groups, 1);
    this.gpu.target(out, groups, 1);
    gl.clearColor(...clear);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendEquation(min ? gl.MIN : gl.FUNC_ADD);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.useProgram(prog.p);
    const U = prog.u;
    this.gpu.bindTex(15, groupTex);
    gl.uniform1i(U.uGroup, 15);
    gl.uniform1i(U.uW, w);
    gl.uniform1i(U.uGroups, groups);
    setup(U);
    gl.bindVertexArray(this.gpu.emptyVao);
    gl.drawArrays(gl.POINTS, 0, w * h);
    gl.disable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    return out;
  }

  read(tex, w, h) {
    const gl = this.gl;
    this.gpu.target(tex, w, h);
    const rgba = new Float32Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, rgba);
    return rgba;
  }

  readRed(tex, w, h) {
    const rgba = this.read(tex, w, h);
    const out = new Float32Array(w * h);
    for (let p = 0; p < w * h; p++) out[p] = rgba[4 * p];
    return out;
  }

  free() {
    for (const t of this.list) this.gl.deleteTexture(t);
    this.list = [];
  }

  // ---- stages: textures in, a texture out --------------------------------------------------------------------------------------------

  lab(rgbTex, w, h) {
    return this.pass(this.prog.lab, w, h, (U) => this.bind(U, [['uRgb', rgbTex]]));
  }

  // (min, max) of a depth texture in a 1 x 1 texture.
  minmax(dT, w, h) {
    let src = dT;
    let sw = w;
    let sh = h;
    let first = 1;
    for (;;) {
      const nw = Math.max(1, (sw + 1) >> 1);
      const nh = Math.max(1, (sh + 1) >> 1);
      const f = first;
      const s = src;
      src = this.pass(this.prog.minmax, nw, nh, (U) => {
        this.bind(U, [['uSrc', s]]);
        this.gl.uniform1i(U.uFirst, f);
      });
      first = 0;
      sw = nw;
      sh = nh;
      if (sw === 1 && sh === 1) return src;
    }
  }

  smoothRamps(dT, labT, objT, w, h, edge, radius = 8, sigma = 4, colorSigma = 7) {
    const gl = this.gl;
    const oT = objT || this.upU(1, 1, new Uint32Array(1));
    return this.pass(this.prog.smoothRamps, w, h, (U) => {
      this.bind(U, [['uDepth', dT], ['uLab', labT], ['uObj', oT]]);
      gl.uniform1i(U.uHasObj, objT ? 1 : 0);
      gl.uniform1i(U.uRadius, radius);
      gl.uniform1f(U.uK, -1 / (2 * sigma * sigma));
      gl.uniform1f(U.uKc, -1 / (2 * colorSigma * colorSigma));
      gl.uniform1f(U.uEdge, Number.isFinite(edge) ? edge : 3.4e38);
      gl.uniform1f(U.uCost, OBJECT_COST);
    });
  }

  colorMedian(dT, labT, w, h, r = 7, sigma = 9) {
    const gl = this.gl;
    const mm = this.minmax(dT, w, h);
    const q = this.pass(this.prog.quant, w, h, (U) => this.bind(U, [['uDepth', dT], ['uMinMax', mm]]));
    const STEP = 4;
    const lut = new Float32Array(256);
    for (let i = 0; i < 256; i++) lut[i] = Math.exp(-(i * STEP) / (2 * sigma * sigma));
    const side = 2 * r + 1;
    const spatial = new Float32Array(side * side);
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) spatial[(dy + r) * side + dx + r] = Math.exp(-(dx * dx + dy * dy) / (2 * (r * 0.7) ** 2));
    const sT = this.upR(side, side, spatial);
    const uT = this.upR(256, 1, lut);
    return this.pass(this.prog.colorMedian, w, h, (U) => {
      this.bind(U, [['uDepth', dT], ['uQ', q], ['uMinMax', mm], ['uLab', labT], ['uSpatial', sT], ['uLut', uT]]);
      gl.uniform1i(U.uR, r);
      gl.uniform1f(U.uStep, STEP);
    });
  }

  layerSnap(dT, labT, w, h, { radius = 12, stride = 2, minRange = 0.25, band = 0.3, margin = 1.4, hard = false } = {}) {
    const gl = this.gl;
    const mm = this.minmax(dT, w, h);
    return this.pass(this.prog.layerSnap, w, h, (U) => {
      this.bind(U, [['uDepth', dT], ['uLab', labT], ['uMinMax', mm]]);
      gl.uniform1i(U.uRadius, radius);
      gl.uniform1i(U.uStride, stride);
      gl.uniform1f(U.uMinRange, minRange);
      gl.uniform1f(U.uBand, band);
      gl.uniform1f(U.uMargin, margin);
      gl.uniform1i(U.uHard, hard ? 1 : 0);
    });
  }

  snapToObjects(dT, objT, w, h, inner = 10, reach = 24) {
    const gl = this.gl;
    const interior = this.pass(this.prog.objectInterior, w, h, (U) => {
      this.bind(U, [['uObj', objT]]);
      gl.uniform1i(U.uInner, inner);
    });
    return this.pass(this.prog.objectSnap, w, h, (U) => {
      this.bind(U, [['uDepth', dT], ['uInterior', interior], ['uObj', objT]]);
      gl.uniform1i(U.uReach, reach);
      gl.uniform1f(U.uK, -1 / (2 * (reach / 2.5) ** 2));
    });
  }

  boxMean(src, w, h, r) {
    const gl = this.gl;
    const hsum = this.pass(this.prog.box, w, h, (U) => {
      this.bind(U, [['uSrc', src]]);
      gl.uniform2i(U.uAxis, 1, 0);
      gl.uniform1i(U.uR, r);
    });
    return this.pass(this.prog.boxMeanV, w, h, (U) => {
      this.bind(U, [['uSrc', hsum]]);
      gl.uniform1i(U.uR, r);
    });
  }

  guidedFilter(dT, labT, w, h, r = 6, eps = 0.004) {
    const gl = this.gl;
    const packed = this.pass(this.prog.guidePack, w, h, (U) => this.bind(U, [['uDepth', dT], ['uLab', labT]]));
    const mean = this.boxMean(packed, w, h, r);
    const ab = this.pass(this.prog.guideAb, w, h, (U) => {
      this.bind(U, [['uMean', mean]]);
      gl.uniform1f(U.uEps, eps);
    });
    const mab = this.boxMean(ab, w, h, r);
    return this.pass(this.prog.guideOut, w, h, (U) => this.bind(U, [['uAB', mab], ['uLab', labT]]));
  }

  // The element at index floor(count / 2) of the sorted values of each group (a texture of M values): bisection on the value with counts, then
  // the smallest value above the last one that fell short.
  groupMedian(valueT, slotT, w, h, M, cntT, iterations = 26, threshOverride = null) {
    const mm = this.scatter(this.prog.scMinMax, w, h, M, slotT, (U) => this.bind(U, [['uAlpha', valueT]]), { min: true, clear: [3.4e38, 3.4e38, 0, 0] });
    let loHi = this.pass(this.prog.bisectInit, M, 1, (U) => this.bind(U, [['uMinMax', mm]]));
    const thresh = threshOverride || this.pass(this.prog.threshCount, M, 1, (U) => this.bind(U, [['uCount', cntT]]));
    for (let it = 0; it < iterations; it++) {
      const lh = loHi;
      const below = this.scatter(this.prog.scBelowN, w, h, M, slotT, (U) => this.bind(U, [['uAlpha', valueT], ['uLoHi', lh]]));
      loHi = this.pass(this.prog.bisectStep, M, 1, (U) => this.bind(U, [['uLoHi', lh], ['uBelow', below], ['uThresh', thresh]]));
    }
    const lhF = loHi;
    return this.scatter(this.prog.scAbove, w, h, M, slotT, (U) => this.bind(U, [['uAlpha', valueT], ['uLoHi', lhF]]), { min: true, clear: [3.4e38, 0, 0, 0] });
  }

  // Large flat objects (a wall, a floor) are fitted with a plane, robustly, and depth near their outline that is off the plane is put back on it
  // (core/segments.js flattenHalos). The fit uses every pixel of the object (the CPU version every third). `labels`: the objects' labels with at
  // least minShare of the picture (at most 32), found by the caller.
  flattenHalos(dT, objT, w, h, labels, { band = 45, off = 0.12, flat = 0.3 } = {}) {
    const gl = this.gl;
    const M = labels.length;
    const slotT = this.pass(this.prog.slot, w, h, (U) => {
      this.bind(U, [['uObj', objT]]);
      gl.uniform1uiv(U.uLabels, Uint32Array.from({ length: 32 }, (_, i) => labels[i] || 0));
      gl.uniform1i(U.uM, M);
    });
    const cnt = this.scatter(this.prog.scOne, w, h, M, slotT, () => {});
    const median = this.groupMedian(dT, slotT, w, h, M, cnt);
    const dev = this.pass(this.prog.absDev, w, h, (U) => this.bind(U, [['uDepth', dT], ['uSlot', slotT], ['uMedian', median]]));
    const spread = this.groupMedian(dev, slotT, w, h, M, cnt);
    let weight = this.pass(this.prog.haloW0, w, h, (U) => this.bind(U, [['uDev', dev], ['uSlot', slotT], ['uSpread', spread]]));
    let plane = this.pass(this.prog.planeInit, M, 1, (U) => this.bind(U, [['uMedian', median]]));
    let mad = spread;
    for (let it = 0; it < 8; it++) {
      const wt = weight;
      const pl = plane;
      const sums = (prog) => this.scatter(prog, w, h, M, slotT, (U) => {
        this.bind(U, [['uDepth', dT], ['uWeight', wt]]);
        gl.uniform2i(U.uSize, w, h);
      });
      const s1 = sums(this.prog.scSums1);
      const s2 = sums(this.prog.scSums2);
      const s3 = sums(this.prog.scSums3);
      plane = this.pass(this.prog.planeSolve, M, 1, (U) => this.bind(U, [['uS1', s1], ['uS2', s2], ['uS3', s3], ['uOld', pl]]));
      const pn = plane;
      const resid = this.pass(this.prog.haloResid, w, h, (U) => this.bind(U, [['uDepth', dT], ['uSlot', slotT], ['uPlane', pn]]));
      mad = this.groupMedian(resid, slotT, w, h, M, cnt);
      const md = mad;
      weight = this.pass(this.prog.haloWeights, w, h, (U) => this.bind(U, [['uResid', resid], ['uSlot', slotT], ['uMad', md]]));
    }
    // distance to the outline: the band's worth of relaxation passes, two textures taking turns
    let dist = this.pass(this.prog.haloOutline, w, h, (U) => this.bind(U, [['uObj', objT]]));
    const other = this.tex(w, h);
    let cur = dist;
    let spare = other;
    for (let i = 0; i < band; i++) {
      gl.disable(gl.BLEND);
      gl.useProgram(this.prog.haloRelax.p);
      this.gpu.target(spare, w, h);
      this.bind(this.prog.haloRelax.u, [['uDist', cur], ['uObj', objT]]);
      gl.uniform1f(this.prog.haloRelax.u.uBand, band);
      this.gpu.draw();
      [cur, spare] = [spare, cur];
    }
    dist = cur;
    const pf = plane;
    const mf = mad;
    return this.pass(this.prog.haloApply, w, h, (U) => {
      this.bind(U, [['uDepth', dT], ['uSlot', slotT], ['uPlane', pf], ['uMad', mf], ['uDist', dist]]);
      gl.uniform1f(U.uBand, band);
      gl.uniform1f(U.uOff, off);
      gl.uniform1f(U.uFlat, flat);
    });
  }

  // The input of the object model (core/segmodel.js segmentInput) made on the card: the 99.5th percentile of brightness (an exact element, by
  // bisection on the value), then the resize with exposure and gamma. Returns { input, nw, nh, scale }.
  segmentInput(rgbT, w, h) {
    const n = w * h;
    const luma = this.pass(this.prog.segLuma, w, h, (U) => this.bind(U, [['uRgb', rgbT]]));
    const zero = this.upR(w, h, new Float32Array(n));
    const target = this.upR(1, 1, new Float32Array([Math.floor(n * 0.995) + 1]));
    const white = this.groupMedian(luma, zero, w, h, 1, null, 28, target);
    const scale = 1024 / Math.max(w, h);
    const nw = Math.round(w * scale);
    const nh = Math.round(h * scale);
    const out = this.pass(this.prog.segResize, nw, nh, (U) => {
      this.bind(U, [['uRgb', rgbT], ['uWhite', white]]);
      this.gl.uniform1f(U.uScale, scale);
    });
    const rgba = this.read(out, nw, nh);
    const input = new Float32Array(nw * nh * 3);
    for (let p = 0; p < nw * nh; p++) {
      input[3 * p] = rgba[4 * p];
      input[3 * p + 1] = rgba[4 * p + 1];
      input[3 * p + 2] = rgba[4 * p + 2];
    }
    return { input, nw, nh, scale };
  }

  // SLIC superpixels (core/segments.js slic): the label of each pixel (a float R channel) and the number of regions.
  slic(labT, w, h, count = 2500, compactness = 8, iterations = 6) {
    const gl = this.gl;
    const step = Math.max(2, Math.sqrt((w * h) / count));
    const pos = [];
    let cols = 0;
    let rows = 0;
    for (let y = step / 2; y < h; y += step) {
      rows++;
      cols = 0;
      for (let x = step / 2; x < w; x += step) {
        cols++;
        pos.push(x, y, 0, 0);
      }
    }
    const k = cols * rows;
    const m2 = (compactness / step) ** 2;
    const S = Math.ceil(step);
    const posT0 = this.upRGBA(k, 1, Float32Array.from(pos));
    let cPos = posT0;
    let cLab = this.pass(this.prog.slicInit, k, 1, (U) => this.bind(U, [['uLab', labT], ['uPos', posT0]]));
    let label = null;
    for (let it = 0; it < iterations; it++) {
      const cp = cPos;
      const cl = cLab;
      label = this.pass(this.prog.slicAssign, w, h, (U) => {
        this.bind(U, [['uLab', labT], ['uCenterPos', cp], ['uCenterLab', cl]]);
        gl.uniform1i(U.uCols, cols);
        gl.uniform1i(U.uRows, rows);
        gl.uniform1f(U.uStep, step);
        gl.uniform1f(U.uM2, m2);
        gl.uniform1i(U.uS, S);
        gl.uniform1i(U.uReach, 3);
      });
      if (it === iterations - 1) break;
      const lab0 = label;
      const sumPos = this.scatter(this.prog.scPosCount, w, h, k, lab0, () => {});
      const sumLab = this.scatter(this.prog.scLab, w, h, k, lab0, (U) => this.bind(U, [['uLab', labT]]));
      const sp = sumPos;
      const sl = sumLab;
      const np = this.pass(this.prog.slicUpdate, k, 1, (U) => {
        this.bind(U, [['uSumPos', sp], ['uSumLab', sl], ['uOldPos', cp], ['uOldLab', cl]]);
        gl.uniform1i(U.uWhich, 0);
      });
      const nl = this.pass(this.prog.slicUpdate, k, 1, (U) => {
        this.bind(U, [['uSumPos', sp], ['uSumLab', sl], ['uOldPos', cp], ['uOldLab', cl]]);
        gl.uniform1i(U.uWhich, 1);
      });
      cPos = np;
      cLab = nl;
    }
    const fixed = this.pass(this.prog.slicFix, w, h, (U) => this.bind(U, [['uLabel', label]]));
    return { label: fixed, k, centerPos: cPos, cols, rows, S };
  }
}

// The labels (not 0) that cover at least minShare of the picture, or null if there are more than 32.
function bigLabels(objects, minShare = 0.03) {
  const counts = new Map();
  for (let i = 0; i < objects.length; i++) {
    const l = objects[i];
    if (l) counts.set(l, (counts.get(l) || 0) + 1);
  }
  const labels = [];
  for (const [l, c] of counts) if (c >= minShare * objects.length) labels.push(l);
  return labels.length <= 32 ? labels : null;
}

const NEIGHBOR_ROWS = 6;

// The whole cleanup. Same arguments and result as segmentDepth() in core/segments.js (without `gpu`).
function segmentDepthGpu(gpu, alpha, confidence, rgb, w, h, opts, fellBack) {
  const { count = 2500, compactness = 8, iterations = 30, colorSigma = 8, strength = 1, plateau = 0.012, edge = 0.25, snapPasses = 2, guide = { radius: 5, eps: 0.003 }, objects = null } = opts;
  if (!(edge > 0)) return null;
  const gl = gpu.gl;
  const sc = new Scope(gpu);
  try {
    const n = w * h;
    const rgbT = sc.up3(w, h, rgb);
    const labT = sc.lab(rgbT, w, h);
    const alphaT = sc.upR(w, h, alpha);
    const confT = sc.upR(w, h, confidence);
    const sl = sc.slic(labT, w, h, count, compactness);
    const { k } = sl;
    if (k > 4096) return null;

    // each region's trust and count, mean colour, and weighted median depth
    const ct = sc.scatter(sc.prog.scCountTrust, w, h, k, sl.label, (U) => sc.bind(U, [['uConf', confT]]));
    const labSum = sc.scatter(sc.prog.scLab, w, h, k, sl.label, (U) => sc.bind(U, [['uLab', labT]]));
    const mm = sc.scatter(sc.prog.scMinMax, w, h, k, sl.label, (U) => sc.bind(U, [['uAlpha', alphaT]]), { min: true, clear: [3.4e38, 3.4e38, 0, 0] });
    let loHi = sc.pass(sc.prog.bisectInit, k, 1, (U) => sc.bind(U, [['uMinMax', mm]]));
    const half = sc.pass(sc.prog.threshHalf, k, 1, (U) => sc.bind(U, [['uTotal', ct]]));
    for (let it = 0; it < 30; it++) {
      const lh = loHi;
      const below = sc.scatter(sc.prog.scBelow, w, h, k, sl.label, (U) => sc.bind(U, [['uAlpha', alphaT], ['uConf', confT], ['uLoHi', lh]]));
      loHi = sc.pass(sc.prog.bisectStep, k, 1, (U) => sc.bind(U, [['uLoHi', lh], ['uBelow', below], ['uThresh', half]]));
    }
    const lhFinal = loHi;
    const above = sc.scatter(sc.prog.scAbove, w, h, k, sl.label, (U) => sc.bind(U, [['uAlpha', alphaT], ['uLoHi', lhFinal]]), { min: true, clear: [3.4e38, 0, 0, 0] });
    const nb = sc.pass(sc.prog.neighbors, k, NEIGHBOR_ROWS, (U) => {
      sc.bind(U, [['uLabel', sl.label], ['uCenterPos', sl.centerPos]]);
      gl.uniform1i(U.uWindow, sl.S + 1);
    });

    // the small solve over the regions, on the CPU
    const ctR = sc.read(ct, k, 1);
    const labR = sc.read(labSum, k, 1);
    const aboveR = sc.read(above, k, 1);
    const nbR = sc.read(nb, k, NEIGHBOR_ROWS);
    const value = new Float32Array(k);
    const trust = new Float32Array(k);
    const cnt = new Float32Array(k);
    const mean = new Float32Array(k * 3);
    for (let c = 0; c < k; c++) {
      cnt[c] = ctR[4 * c + 1];
      if (!cnt[c]) continue;
      value[c] = aboveR[4 * c];
      trust[c] = ctR[4 * c] / cnt[c];
      for (let j = 0; j < 3; j++) mean[3 * c + j] = labR[4 * c + j] / cnt[c];
    }
    const pairs = [];
    for (let c = 0; c < k; c++) {
      for (let row = 0; row < NEIGHBOR_ROWS; row++) {
        for (let j = 0; j < 4; j++) {
          const v = nbR[4 * (row * k + c) + j];
          if (v === -2) return null;
          if (v >= 0 && c < v) pairs.push(c, v, pairWeight(mean, c, v, colorSigma));
        }
      }
    }
    const cur = solveRegions({ k, value, trust, count: cnt, pairs }, { strength, iterations, plateau });
    if (opts.debug) Object.assign(opts.debug, { k, value, trust, count: cnt, mean, pairs, cur, label: sc.readRed(sl.label, w, h) });

    // back on the card: every pixel takes its region's value, then the filters
    const curT = sc.upR(k, 1, cur);
    let d = sc.pass(sc.prog.lookup, w, h, (U) => sc.bind(U, [['uLabel', sl.label], ['uValue', curT]]));
    if (!objects) {
      d = sc.layerSnap(d, labT, w, h);
      for (let i = 0; i < snapPasses; i++) d = sc.colorMedian(d, labT, w, h);
      d = sc.smoothRamps(d, labT, null, w, h, edge);
      if (guide) d = sc.guidedFilter(d, labT, w, h, guide.radius, guide.eps);
      return sc.readRed(d, w, h);
    }
    // with objects known: depth snapped to their outlines, halos pulled onto flat objects' planes, then the smoothing within each object
    if (opts.flatten) return null;  // the experimental per-object flattening (OBJECT_FLAT) stays on the CPU
    const labels = bigLabels(objects);
    if (!labels) return null;
    const objT = sc.upU(w, h, objects);
    d = sc.snapToObjects(d, objT, w, h);
    if (labels.length) d = sc.flattenHalos(d, objT, w, h, labels);
    d = sc.smoothRamps(d, labT, objT, w, h, Infinity, 8, 4, 10);
    return sc.readRed(d, w, h);
  } catch (e) {
    fellBack('Cleaning up the depth regions', e);
    return null;
  } finally {
    sc.free();
  }
}

// The GPU versions, or null where the graphics card cannot render to float textures with blending. `fellBack(stage, error)` is told of a failure.
export function regionsGpu(gpu, fellBack = () => {}) {
  const gl = gpu && gpu.gl;
  if (!gl || !gpu.floatBlend) return null;
  const guard = (stage, f) => (...args) => {
    const sc = new Scope(gpu);
    try {
      return f(sc, ...args);
    } catch (e) {
      fellBack(stage, e);
      return null;
    } finally {
      sc.free();
    }
  };

  return {
    smoothRamps: guard('Smoothing the depth', (sc, depth, lab, w, h, edge, objects = null, radius = 8, sigma = 4, colorSigma = 7) => {
      const out = sc.smoothRamps(sc.upR(w, h, depth), sc.up3(w, h, lab), objects ? sc.upU(w, h, objects) : null, w, h, edge, radius, sigma, colorSigma);
      return sc.readRed(out, w, h);
    }),

    colorMedian: guard('Sharpening depth edges', (sc, depth, lab, w, h, r = 7, sigma = 9, levels = 128) => {
      if (levels !== 128) return null;
      return sc.readRed(sc.colorMedian(sc.upR(w, h, depth), sc.up3(w, h, lab), w, h, r, sigma), w, h);
    }),

    layerSnap: guard('Layering the depth', (sc, depth, lab, w, h, opts) => sc.readRed(sc.layerSnap(sc.upR(w, h, depth), sc.up3(w, h, lab), w, h, opts), w, h)),

    snapToObjects: guard('Snapping depth to objects', (sc, depth, objects, w, h, inner = 10, reach = 24) => {
      if (((reach >> 1) * 2 + 1) ** 2 > 625 || reach % 2) return null;
      return sc.readRed(sc.snapToObjects(sc.upR(w, h, depth), sc.upU(w, h, objects), w, h, inner, reach), w, h);
    }),

    flattenHalos: guard('Flattening halos', (sc, depth, objects, w, h, opts) => {
      const labels = bigLabels(objects, (opts && opts.minShare) || 0.03);
      if (!labels) return null;
      if (!labels.length) return depth;
      return sc.readRed(sc.flattenHalos(sc.upR(w, h, depth), sc.upU(w, h, objects), w, h, labels, opts), w, h);
    }),

    guidedFilter: guard('Filtering the depth', (sc, depth, lab, w, h, r = 6, eps = 0.004) => sc.readRed(sc.guidedFilter(sc.upR(w, h, depth), sc.up3(w, h, lab), w, h, r, eps), w, h)),

    // the Lab conversion and the SLIC labels, for checking against the CPU
    labOf: guard('Converting to Lab', (sc, rgb, w, h) => {
      const t = sc.lab(sc.up3(w, h, rgb), w, h);
      const rgba = sc.read(t, w, h);
      const out = new Float32Array(w * h * 3);
      for (let p = 0; p < w * h; p++) for (let c = 0; c < 3; c++) out[3 * p + c] = rgba[4 * p + c];
      return out;
    }),

    // the guided filter of a depth map on the picture's brightness (core/segments.js guidedFilterColor): Lab and the filter, on the card
    guidedFilterRgb: guard('Filtering the depth', (sc, depth, rgb, w, h, r = 5, eps = 0.003) => {
      const labT = sc.lab(sc.up3(w, h, rgb), w, h);
      return sc.readRed(sc.guidedFilter(sc.upR(w, h, depth), labT, w, h, r, eps), w, h);
    }),

    // the object model's input, made on the card (see Scope.segmentInput)
    segInput: guard('Preparing the picture for the object model', (sc, rgb, w, h) => sc.segmentInput(sc.up3(w, h, rgb), w, h)),

    // the SLIC labels of a Lab picture, for checking against the CPU
    slicLabels: guard('Finding superpixels', (sc, lab, w, h, count = 2500, compactness = 8) => {
      const sl = sc.slic(sc.up3(w, h, lab), w, h, count, compactness);
      return sc.readRed(sl.label, w, h);
    }),

    // the whole region cleanup
    segmentDepth: (alpha, confidence, rgb, w, h, opts) => segmentDepthGpu(gpu, alpha, confidence, rgb, w, h, opts || {}, fellBack),
  };
}
