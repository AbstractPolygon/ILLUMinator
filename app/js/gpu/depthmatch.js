// The Lytro-style depth (core/depthmatch.js) on the GPU, step for step: the
// capped color cost per trial depth, cross-based aggregation, the
// message-passing smoothing, the label pick and the hidden / visible choice
// per view. The CPU version stays as the fallback and the reference; the two
// agree to within float rounding (test/depthmatch-gpu.test.mjs).
//
// The smoothing is a raster sweep on the CPU. Here each sweep runs along
// anti-diagonals: every pixel of a diagonal depends only on the previous
// diagonal, so a diagonal is one draw of points. Messages and costs are kept
// in "atlases": four labels per texel (RGBA), one tile per group of four.
import { program } from './renderer.js';
import { DEPTH_CBCA, DEPTH_EDGE, DEPTH_TRWS, DEPTH_LCOST, depthColorGuide, median3 } from '../core/depth.js';
import { DEPTH_PASSES, viewColors } from '../core/depthmatch.js';

const MAX_VIEWS = 64;
const MAX_LABELS = 64;

const HEAD = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2DArray;
`;

const ATLAS_COMMON = `
uniform int uW;
uniform int uH;
uniform int uG;
uniform int uCols;
ivec2 at(ivec2 p, int g) { return ivec2(p.x + uW * (g % uCols), p.y + uH * (g / uCols)); }
`;

// The match cost of one trial depth (core/depthmatch.js costVolume): the capped color difference to the
// reference, in units of the mean over the other views. Red: the cost. Green: 1 where the shifted views
// average above `uSatur` in some channel (blown out). Corners outside the picture add nothing.
const COST = `${HEAD}
uniform sampler2DArray uColors;
uniform sampler2DArray uWeights;
uniform sampler2DArray uBehind;
uniform int uUseWeights;
uniform int uUseBehind;
uniform int uCount;
uniform int uRef;
uniform vec4 uView[${MAX_VIEWS}];
uniform float uAlpha;
uniform float uCap;
uniform float uBehindW;
uniform float uSatur;
out vec4 outColor;

vec3 sampleOpen(sampler2DArray tex, int k, vec2 pos, ivec2 size) {
  vec2 f0 = floor(pos);
  ivec2 b = ivec2(f0);
  vec2 a = pos - f0;
  vec3 c = vec3(0.0);
  for (int j = 0; j < 2; j++) {
    for (int i = 0; i < 2; i++) {
      ivec2 q = b + ivec2(i, j);
      if (q.x < 0 || q.y < 0 || q.x >= size.x || q.y >= size.y) continue;
      float wt = (i == 1 ? a.x : 1.0 - a.x) * (j == 1 ? a.y : 1.0 - a.y);
      c += texelFetch(tex, ivec3(q, k), 0).rgb * wt;
    }
  }
  return c;
}

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 size = textureSize(uColors, 0).xy;
  vec3 rc = texelFetch(uColors, ivec3(p, uRef), 0).rgb;
  float others = float(uCount - 1);
  float acc0 = 0.0;
  float accH = 0.0;
  float accB = 0.0;
  vec3 sum = vec3(0.0);
  for (int k = 0; k < ${MAX_VIEWS}; k++) {
    if (k >= uCount) break;
    if (k == uRef) continue;
    vec2 pos = vec2(p) + uAlpha * uView[k].xy;
    vec3 c = sampleOpen(uColors, k, pos, size);
    vec3 d = abs(c - rc);
    float cd = d.r + d.g + d.b;
    float a = uUseWeights == 1 ? 1.0 - texelFetch(uWeights, ivec3(p, k), 0).r : 0.0;
    acc0 += (1.0 - a) * min(cd, uCap);
    accH += a;
    if (uUseBehind == 1) accB += sampleOpen(uBehind, k, pos, size).r;
    sum += c;
  }
  if (accH > 0.0 && accH < others) acc0 = acc0 * others / (others - accH);
  float cost = (acc0 + uBehindW * accB / others) / others;
  float blown = max(sum.r, max(sum.g, sum.b)) > uSatur * others ? 1.0 : 0.0;
  outColor = vec4(cost, blown, 0.0, 0.0);
}`;

// A label's value into one channel of an atlas tile: component 0 (cost) or 1 (blown flag) of the source.
const STORE = `${HEAD}
uniform sampler2D uSrc;
uniform int uComp;
uniform ivec2 uOrigin;
out vec4 outColor;
void main() {
  vec4 t = texelFetch(uSrc, ivec2(gl_FragCoord.xy) - uOrigin, 0);
  outColor = vec4(uComp == 0 ? t.r : t.g);
}`;

// Pixels whose cost vector is set to zero: blown out at some depth, or costs (in tool units, ten times
// ours) that differ by less than uFlat. Red: 1 to zero.
const ZERO = `${HEAD}
${ATLAS_COMMON}
uniform sampler2D uRaw;
uniform sampler2D uFlags;
uniform int uK;
uniform float uFlat;
out vec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float lo = 1e30;
  float hi = -1e30;
  float blown = 0.0;
  for (int k = 0; k < ${MAX_LABELS}; k++) {
    if (k >= uK) break;
    ivec2 t = at(p, k >> 2);
    float v = texelFetch(uRaw, t, 0)[k & 3];
    lo = min(lo, v);
    hi = max(hi, v);
    blown = max(blown, texelFetch(uFlags, t, 0)[k & 3]);
  }
  outColor = vec4(blown > 0.5 || (hi - lo) * 10.0 < uFlat ? 1.0 : 0.0);
}`;

// One label's raw cost back out of its atlas tile, zeroed where uZero says so.
const PULL = `${HEAD}
${ATLAS_COMMON}
uniform sampler2D uRaw;
uniform sampler2D uZeroed;
uniform int uLabel;
out vec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float v = texelFetch(uRaw, at(p, uLabel >> 2), 0)[uLabel & 3];
  outColor = vec4(texelFetch(uZeroed, p, 0).r > 0.5 ? 0.0 : v, 0.0, 0.0, 0.0);
}`;

// Each pixel's arms (core/depth.js crossArms): how far it reaches left,
// right, up and down along pixels of a similar color.
const ARMS = `${HEAD}
uniform sampler2D uGuide;
uniform int uArm;
uniform int uLong;
uniform float uTau;
uniform float uTau2;
out vec4 outColor;

float diff(ivec2 i, ivec2 j) {
  vec3 d = abs(texelFetch(uGuide, i, 0).rgb - texelFetch(uGuide, j, 0).rgb);
  return max(d.r, max(d.g, d.b));
}

float reach(ivec2 i, ivec2 step, int room) {
  int k = 1;
  for (int n = 0; n < 128; n++) {
    if (k >= uArm || k > room) break;
    ivec2 j = i + step * k;
    float d = diff(i, j);
    if (d >= uTau || diff(j, j - step) >= uTau || (k > uLong && d >= uTau2)) break;
    k++;
  }
  return float(k - 1);
}

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 size = textureSize(uGuide, 0);
  outColor = vec4(
    reach(p, ivec2(-1, 0), p.x),
    reach(p, ivec2(1, 0), size.x - 1 - p.x),
    reach(p, ivec2(0, -1), p.y),
    reach(p, ivec2(0, 1), size.y - 1 - p.y));
}`;

// Sobel strength of the guide (R + 2G + B weights): 1 below `lo`, falling to 0
// at `hi`; 1 on the border (core/depth.js flatness).
const SOBEL = `${HEAD}
uniform sampler2D uGuide;
uniform float uLo;
uniform float uHi;
out vec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 size = textureSize(uGuide, 0);
  float e = 1.0;
  if (p.x >= 1 && p.y >= 1 && p.x < size.x - 1 && p.y < size.y - 1) {
    vec3 sx = vec3(0.0);
    vec3 sy = vec3(0.0);
    vec3 a = texelFetch(uGuide, p + ivec2(-1, -1), 0).rgb;
    vec3 b = texelFetch(uGuide, p + ivec2(0, -1), 0).rgb;
    vec3 c = texelFetch(uGuide, p + ivec2(1, -1), 0).rgb;
    vec3 d = texelFetch(uGuide, p + ivec2(-1, 0), 0).rgb;
    vec3 f = texelFetch(uGuide, p + ivec2(1, 0), 0).rgb;
    vec3 g = texelFetch(uGuide, p + ivec2(-1, 1), 0).rgb;
    vec3 h = texelFetch(uGuide, p + ivec2(0, 1), 0).rgb;
    vec3 i = texelFetch(uGuide, p + ivec2(1, 1), 0).rgb;
    sx = c + 2.0 * f + i - a - 2.0 * d - g;
    sy = g + 2.0 * h + i - a - 2.0 * b - c;
    vec3 m = abs(sx) + abs(sy);
    float v = m.r + 2.0 * m.g + m.b;
    if (v > uLo) e = max(0.0, 1.0 - (v - uLo) / (uHi - uLo));
  }
  outColor = vec4(e, 0.0, 0.0, 0.0);
}`;

const GAUSS = `${HEAD}
uniform sampler2D uSrc;
uniform ivec2 uDir;
uniform float uSigma;
out vec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 size = textureSize(uSrc, 0);
  int r = max(1, int(ceil(2.6 * uSigma)));
  float a = 0.0;
  float ks = 0.0;
  for (int t = -r; t <= r; t++) {
    float k = exp(-float(t * t) / (2.0 * uSigma * uSigma));
    ivec2 q = clamp(p + uDir * t, ivec2(0), size - 1);
    a += k * texelFetch(uSrc, q, 0).r;
    ks += k;
  }
  outColor = vec4(a / ks, 0.0, 0.0, 0.0);
}`;

// Smoothing weight of each edge to the right (r) and below (g): 1 across flat
// color, `low` across a jump over `edge`.
const EDGE_WEIGHTS = `${HEAD}
uniform sampler2D uGuide;
uniform float uEdge;
uniform float uLow;
out vec4 outColor;
float jump(ivec2 i, ivec2 j) {
  vec3 d = abs(texelFetch(uGuide, i, 0).rgb - texelFetch(uGuide, j, 0).rgb);
  return d.r + 2.0 * d.g + d.b;
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 size = textureSize(uGuide, 0);
  float r = 0.0;
  float d = 0.0;
  if (p.x < size.x - 1) r = jump(p, p + ivec2(1, 0)) <= uEdge ? 1.0 : uLow;
  if (p.y < size.y - 1) d = jump(p, p + ivec2(0, 1)) <= uEdge ? 1.0 : uLow;
  outColor = vec4(r, d, 0.0, 0.0);
}`;

// Mean of a value along each pixel's arm on one axis (two passes, one per
// axis, make one round of core/depth.js aggregateCross). The first pass of a
// round sums plain values; the second sums (sum, count) pairs and divides.
const AGG = `${HEAD}
uniform sampler2D uSrc;
uniform sampler2D uArms;
uniform int uAxis;
uniform int uFirst;
uniform int uFinal;
out vec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 a = texelFetch(uArms, p, 0);
  int lo = int(uAxis == 0 ? a.x : a.z);
  int hi = int(uAxis == 0 ? a.y : a.w);
  float s = 0.0;
  float c = 0.0;
  for (int t = -lo; t <= hi; t++) {
    vec4 v = texelFetch(uSrc, p + (uAxis == 0 ? ivec2(t, 0) : ivec2(0, t)), 0);
    s += v.r;
    c += uFirst == 1 ? 1.0 : v.g;
  }
  outColor = uFinal == 1 ? vec4(s / max(1.0, c), 1.0, 0.0, 0.0) : vec4(s, c, 0.0, 0.0);
}`;

// One label's unary cost into its channel of the cost atlas.
const PACK = `${HEAD}
uniform sampler2D uCost;
uniform sampler2D uAgg;
uniform sampler2D uFlat;
uniform int uUseFlat;
uniform float uScale;
uniform ivec2 uOrigin;
out vec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy) - uOrigin;
  float c = texelFetch(uCost, p, 0).r;
  float a = texelFetch(uAgg, p, 0).r;
  float f = uUseFlat == 1 ? texelFetch(uFlat, p, 0).r : 0.0;
  float v = uUseFlat == 1 ? (1.0 - f) * c + f * a : a;
  outColor = vec4(v * uScale);
}`;

// A sweep along anti-diagonal uS: one point per (pixel, group of four labels).
const SWEEP_VERTEX = `#version 300 es
precision highp float;
precision highp int;
${ATLAS_COMMON}
uniform int uDX;
uniform int uDY;
uniform int uS;
uniform int uStart;
uniform vec2 uAtlas;
flat out ivec2 vP;
flat out int vG;
void main() {
  int id = gl_VertexID;
  int t = id / uG;
  int g = id - t * uG;
  int sx = uStart + t;
  int sy = uS - sx;
  int x = uDX > 0 ? sx : uW - 1 - sx;
  int y = uDY > 0 ? sy : uH - 1 - sy;
  vP = ivec2(x, y);
  vG = g;
  gl_Position = vec4((vec2(at(vP, g)) + 0.5) / uAtlas * 2.0 - 1.0, 0.0, 1.0);
  gl_PointSize = 1.0;
}`;

// One diagonal of a message-passing sweep (core/depth.js trwsVolume), pulling:
// each pixel takes the belief of its upstream neighbors (stored one diagonal
// ago) less the message coming back, and turns it into the message into itself
// (truncated-linear transform, capped). Writes the two new messages and its
// own belief.
const SWEEP = `${HEAD}
${ATLAS_COMMON}
uniform sampler2D uU;
uniform sampler2D uOldH;
uniform sampler2D uOldV;
uniform sampler2D uBprev;
uniform sampler2D uEdge;
uniform int uUniformW;
uniform int uK;
uniform int uDX;
uniform int uDY;
uniform float uGamma;
uniform float uSlope;
uniform int uTrunc;
flat in ivec2 vP;
flat in int vG;
layout(location = 0) out vec4 outH;
layout(location = 1) out vec4 outV;
layout(location = 2) out vec4 outB;

vec4 message(ivec2 q, sampler2D old, float w, int g) {
  float tv[${MAX_LABELS}];
  float lo = 1e30;
  for (int gg = 0; gg < ${MAX_LABELS / 4}; gg++) {
    if (gg >= uG) break;
    vec4 t4 = texelFetch(uBprev, at(q, gg), 0) * uGamma - texelFetch(old, at(q, gg), 0);
    for (int j = 0; j < 4; j++) {
      tv[4 * gg + j] = t4[j];
      if (4 * gg + j < uK) lo = min(lo, t4[j]);
    }
  }
  float a = uSlope * w;
  float cap = a * float(uTrunc);
  vec4 r = vec4(0.0);
  for (int j = 0; j < 4; j++) {
    int k = 4 * g + j;
    if (k >= uK) continue;
    float best = 1e30;
    for (int m = max(0, k - uTrunc); m <= min(uK - 1, k + uTrunc); m++) best = min(best, tv[m] + a * float(abs(k - m)));
    r[j] = min(cap, best - lo);
  }
  return r;
}

void main() {
  ivec2 p = vP;
  int g = vG;
  ivec2 qh = p - ivec2(uDX, 0);
  ivec2 qv = p - ivec2(0, uDY);
  vec4 mh = vec4(0.0);
  vec4 mv = vec4(0.0);
  if (qh.x >= 0 && qh.x < uW) mh = message(qh, uOldH, uUniformW == 1 ? 1.0 : texelFetch(uEdge, ivec2(min(p.x, qh.x), p.y), 0).r, g);
  if (qv.y >= 0 && qv.y < uH) mv = message(qv, uOldV, uUniformW == 1 ? 1.0 : texelFetch(uEdge, ivec2(p.x, min(p.y, qv.y)), 0).g, g);
  vec4 base = texelFetch(uU, at(p, g), 0) + texelFetch(uOldH, at(p, g), 0) + texelFetch(uOldV, at(p, g), 0);
  outH = mh;
  outV = mv;
  outB = base + mh + mv;
}`;

// The labels' beliefs at the end: best label (core/depth.js bestDepth), the
// depth refined by a parabola through the match costs (bestDepth with data costs)
// or the hidden / visible choice.
const RESULT = `${HEAD}
${ATLAS_COMMON}
uniform sampler2D uU;
uniform sampler2D uML;
uniform sampler2D uMR;
uniform sampler2D uMU;
uniform sampler2D uMD;
uniform int uK;
uniform int uMode; // 0 best, 1 refined, 2 visible
uniform int uDiscrete;
uniform float uScale;
uniform float uFirst;
uniform float uStep;
out vec4 outColor;

float belief(ivec2 p, int k) {
  ivec2 t = at(p, k >> 2);
  int c = k & 3;
  return -(texelFetch(uU, t, 0)[c] + texelFetch(uML, t, 0)[c] + texelFetch(uMR, t, 0)[c] + texelFetch(uMU, t, 0)[c] + texelFetch(uMD, t, 0)[c]) / uScale;
}

float dataCost(ivec2 p, int k) {
  return texelFetch(uU, at(p, k >> 2), 0)[k & 3] / uScale;
}

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  if (uMode == 2) {
    outColor = vec4(belief(p, 0) >= belief(p, 1) ? 1.0 : 0.0);
    return;
  }
  int best = 0;
  float bv = belief(p, 0);
  float sum = -bv;
  for (int k = 1; k < ${MAX_LABELS}; k++) {
    if (k >= uK) break;
    float v = belief(p, k);
    sum -= v;
    if (v > bv) { bv = v; best = k; }
  }
  float value = uFirst + float(best) * uStep;
  if (best > 0 && best < uK - 1) {
    if (uMode == 1) {
      // A parabola through the three match costs around the label (not the beliefs).
      float cm = dataCost(p, best - 1);
      float c0 = dataCost(p, best);
      float cp = dataCost(p, best + 1);
      float den = cp + cm - 2.0 * c0;
      if (den > 0.0) {
        float o = ((cp - cm) / (den * 2.0)) * uStep;
        if (abs(o) < abs(uStep)) value -= o;
      }
    } else if (uDiscrete == 0) {
      float a = belief(p, best - 1);
      float c = belief(p, best + 1);
      float d = a - 2.0 * bv + c;
      if (d < 0.0) value += clamp(0.5 * (a - c) / d, -0.5, 0.5) * uStep;
    }
  }
  outColor = vec4(value, -bv, sum / float(uK), 0.0);
}`;

// Where the other view's depth lands in the reference: a point per pixel.
const LANDED_VERTEX = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uDepth;
uniform vec2 uShift;
void main() {
  ivec2 size = textureSize(uDepth, 0);
  int x = gl_VertexID % size.x;
  int y = gl_VertexID / size.x;
  float d = texelFetch(uDepth, ivec2(x, y), 0).r;
  ivec2 t = ivec2(floor(vec2(x, y) - d * uShift + 0.5));
  if (t.x < 0 || t.y < 0 || t.x >= size.x || t.y >= size.y) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  } else {
    gl_Position = vec4((vec2(t) + 0.5) / vec2(size) * 2.0 - 1.0, 0.0, 1.0);
  }
  gl_PointSize = 1.0;
}`;
const LANDED = `${HEAD}
out vec4 outColor;
void main() { outColor = vec4(1.0); }`;

// Costs of a pixel being seen by view v (visible) or not (hidden), in the
// first two channels (core/depthmatch.js seenBy).
const SEEN = `${HEAD}
uniform sampler2DArray uColors;
uniform sampler2D uLanded;
uniform sampler2D uDepth;
uniform int uView;
uniform int uRef;
uniform vec2 uShift;
uniform float uCap;
uniform float uHole;
uniform float uHidden;
uniform float uPer;
out vec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 size = textureSize(uLanded, 0);
  float hole = texelFetch(uLanded, p, 0).r > 0.5 ? 0.0 : 1.0;
  float diff = uCap;
  float d = texelFetch(uDepth, p, 0).r;
  vec2 pos = vec2(p) + d * uShift;
  vec2 f0 = floor(pos);
  ivec2 b = ivec2(f0);
  if (!(b.x < 0 || b.y < 0 || b.x >= size.x - 1 || b.y >= size.y - 1)) {
    vec2 a = pos - f0;
    vec3 c = (texelFetch(uColors, ivec3(b, uView), 0).rgb * (1.0 - a.x) + texelFetch(uColors, ivec3(b + ivec2(1, 0), uView), 0).rgb * a.x) * (1.0 - a.y)
      + (texelFetch(uColors, ivec3(b + ivec2(0, 1), uView), 0).rgb * (1.0 - a.x) + texelFetch(uColors, ivec3(b + ivec2(1, 1), uView), 0).rgb * a.x) * a.y;
    vec3 e = abs(c - texelFetch(uColors, ivec3(p, uRef), 0).rgb);
    diff = min(uCap, e.r + e.g + e.b);
  }
  outColor = vec4(hole * uHole + uPer * diff, (1.0 - hole) * uHole + uHidden, 0.0, 0.0);
}`;

const WRITE_LAYER = `${HEAD}
uniform sampler2D uSrc;
uniform float uInvert;
out vec4 outColor;
void main() {
  float v = texelFetch(uSrc, ivec2(gl_FragCoord.xy), 0).r;
  outColor = vec4(uInvert > 0.5 ? 1.0 - v : v);
}`;

function programs(gpu) {
  if (!gpu.matchPrograms) {
    const gl = gpu.gl;
    gpu.matchPrograms = {
      cost: program(gl, COST),
      store: program(gl, STORE),
      zero: program(gl, ZERO),
      pull: program(gl, PULL),
      arms: program(gl, ARMS),
      sobel: program(gl, SOBEL),
      gauss: program(gl, GAUSS),
      edge: program(gl, EDGE_WEIGHTS),
      agg: program(gl, AGG),
      pack: program(gl, PACK),
      sweep: program(gl, SWEEP, SWEEP_VERTEX),
      result: program(gl, RESULT),
      landed: program(gl, LANDED, LANDED_VERTEX),
      seen: program(gl, SEEN),
      layer: program(gl, WRITE_LAYER),
    };
  }
  return gpu.matchPrograms;
}

// Everything one measurement allocates, so it can be freed together.
class Work {
  constructor(gpu, w, h) {
    this.gpu = gpu;
    this.gl = gpu.gl;
    this.w = w;
    this.h = h;
    this.owned = [];
    this.fbo = this.gl.createFramebuffer();
    this.maxTex = this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE);
    this.maxDraw = this.gl.getParameter(this.gl.MAX_DRAW_BUFFERS);
    if (this.maxDraw < 3) throw new Error('Needs three draw buffers');
  }

  tex(w, h, internal = this.gl.RGBA32F) {
    const t = this.gpu.texture(w, h, internal);
    this.owned.push(t);
    return t;
  }

  // 2D array texture; layers are filled with `fill` (Float32Array w*h*4).
  array(w, h, n, internal = this.gl.RGBA32F) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + 15);
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, t);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, internal, w, h, n);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    this.owned.push(t);
    return t;
  }

  // The atlas for `groups` groups of four labels: tiles of w x h.
  atlasShape(groups) {
    const { w, h, maxTex } = this;
    const cols = Math.max(1, Math.min(groups, Math.floor(maxTex / w), Math.round(Math.sqrt((groups * h) / w))));
    const rows = Math.ceil(groups / cols);
    if (cols * w > maxTex || rows * h > maxTex) throw new Error('Depth atlas does not fit in a texture');
    return { cols, rows, width: cols * w, height: rows * h, groups };
  }

  dispose() {
    for (const t of this.owned) this.gl.deleteTexture(t);
    this.gl.deleteFramebuffer(this.fbo);
    this.owned = [];
  }
}

function clear(work, tex) {
  const gl = work.gl;
  gl.bindFramebuffer(gl.FRAMEBUFFER, work.fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
  gl.clearBufferfv(gl.COLOR, 0, [0, 0, 0, 0]);
}

// The solver's textures for atlases of `shape`.
function solverSet(work, shape) {
  const make = () => work.tex(shape.width, shape.height);
  return { shape, U: make(), ML: make(), MR: make(), MU: make(), MD: make(), B: [make(), make()] };
}

function zeroMessages(work, set) {
  for (const t of [set.ML, set.MR, set.MU, set.MD, ...set.B]) clear(work, t);
}

// `iterations` rounds of message passing on the costs in set.U over labels
// 0..K-1. `edge`: texture of weights (r: to the right, g: below), or null for
// uniform smoothing. Leaves the messages in the set.
function solve(work, set, K, { iterations, slope, trunc, gamma }, edge, onSweep = null) {
  const gl = work.gl;
  const gpu = work.gpu;
  const P = programs(gpu).sweep;
  const { shape } = set;
  const { w, h } = work;
  zeroMessages(work, set);
  gl.bindFramebuffer(gl.FRAMEBUFFER, work.fbo);
  gl.viewport(0, 0, shape.width, shape.height);
  gl.useProgram(P.p);
  const u = P.u;
  gl.uniform1i(u.uW, w);
  gl.uniform1i(u.uH, h);
  gl.uniform1i(u.uG, shape.groups);
  gl.uniform1i(u.uCols, shape.cols);
  gl.uniform1i(u.uK, K);
  gl.uniform1f(u.uGamma, gamma);
  gl.uniform1f(u.uSlope, slope);
  gl.uniform1i(u.uTrunc, Math.round(trunc));
  gl.uniform2f(u.uAtlas, shape.width, shape.height);
  gl.uniform1i(u.uUniformW, edge ? 0 : 1);
  gl.uniform1i(u.uU, 0);
  gl.uniform1i(u.uOldH, 1);
  gl.uniform1i(u.uOldV, 2);
  gl.uniform1i(u.uBprev, 3);
  gl.uniform1i(u.uEdge, 4);
  gpu.bindTex(0, set.U);
  gpu.bindTex(4, edge || set.U);
  gl.bindVertexArray(gpu.emptyVao);
  const diagonals = w + h - 1;
  for (let it = 0; it < iterations; it++) {
    const odd = it % 2 === 1;
    // Even rounds: right and down, then left and up; odd: left and down, then right and up.
    const passes = odd ? [[-1, 1], [1, -1]] : [[1, 1], [-1, -1]];
    for (const [dx, dy] of passes) {
      // The messages written take the arrays opposite the ones read.
      const destH = dx > 0 ? set.ML : set.MR;
      const oldH = dx > 0 ? set.MR : set.ML;
      const destV = dy > 0 ? set.MU : set.MD;
      const oldV = dy > 0 ? set.MD : set.MU;
      gl.bindFramebuffer(gl.FRAMEBUFFER, work.fbo);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2]);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, destH, 0);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, destV, 0);
      gpu.bindTex(1, oldH);
      gpu.bindTex(2, oldV);
      gl.uniform1i(u.uDX, dx);
      gl.uniform1i(u.uDY, dy);
      for (let s = 0; s < diagonals; s++) {
        const start = Math.max(0, s - (h - 1));
        const count = Math.min(s, w - 1) - start + 1;
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT2, gl.TEXTURE_2D, set.B[s & 1], 0);
        gpu.bindTex(3, set.B[(s + 1) & 1]);
        gl.uniform1i(u.uS, s);
        gl.uniform1i(u.uStart, start);
        gl.drawArrays(gl.POINTS, 0, count * shape.groups);
      }
    }
    if (onSweep) onSweep(it + 1, iterations);
  }
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, null, 0);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT2, gl.TEXTURE_2D, null, 0);
  gl.drawBuffers([gl.COLOR_ATTACHMENT0]);
  gl.bindVertexArray(gpu.vao);
}

// Reads the beliefs of `set` into the result texture (RESULT) and returns it as Float32Array rgba.
function readResult(work, set, K, mode, { first = 0, step = 1, discrete = 0, scale = 1 } = {}, out) {
  const gl = work.gl;
  const gpu = work.gpu;
  const P = programs(gpu).result;
  const { shape } = set;
  gpu.target(out, work.w, work.h);
  gl.useProgram(P.p);
  const u = P.u;
  gl.uniform1i(u.uW, work.w);
  gl.uniform1i(u.uH, work.h);
  gl.uniform1i(u.uG, shape.groups);
  gl.uniform1i(u.uCols, shape.cols);
  gl.uniform1i(u.uK, K);
  gl.uniform1i(u.uMode, mode);
  gl.uniform1i(u.uDiscrete, discrete);
  gl.uniform1f(u.uScale, scale);
  gl.uniform1f(u.uFirst, first);
  gl.uniform1f(u.uStep, step);
  [set.U, set.ML, set.MR, set.MU, set.MD].forEach((t, i) => {
    gl.uniform1i(u[['uU', 'uML', 'uMR', 'uMU', 'uMD'][i]], i);
    gpu.bindTex(i, t);
  });
  gpu.draw();
}

function readRGBA(work, tex) {
  const gl = work.gl;
  work.gpu.target(tex, work.w, work.h);
  const buf = new Float32Array(work.w * work.h * 4);
  gl.readPixels(0, 0, work.w, work.h, gl.RGBA, gl.FLOAT, buf);
  return buf;
}

// `perPixel` 1 into an R32F texture, 3 or 4 into an RGBA32F one.
function upload2D(work, tex, data, perPixel) {
  const gl = work.gl;
  const n = work.w * work.h;
  let rgba = data;
  if (perPixel === 1) {
    gl.activeTexture(gl.TEXTURE0 + 15);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, work.w, work.h, gl.RED, gl.FLOAT, data);
    return;
  }
  if (perPixel !== 4) {
    rgba = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) for (let c = 0; c < perPixel; c++) rgba[4 * i + c] = data[perPixel * i + c];
  }
  gl.activeTexture(gl.TEXTURE0 + 15);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, work.w, work.h, gl.RGBA, gl.FLOAT, rgba);
}

function uploadLayer(work, array, layer, data, perPixel) {
  const gl = work.gl;
  const n = work.w * work.h;
  let rgba = data;
  if (perPixel === 1) {
    gl.activeTexture(gl.TEXTURE0 + 15);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, array);
    gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, layer, work.w, work.h, 1, gl.RED, gl.FLOAT, data);
    return;
  }
  if (perPixel !== 4) {
    rgba = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) for (let c = 0; c < perPixel; c++) rgba[4 * i + c] = data[perPixel * i + c];
  }
  gl.activeTexture(gl.TEXTURE0 + 15);
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, array);
  gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, layer, work.w, work.h, 1, gl.RGBA, gl.FLOAT, rgba);
}

// Depth of the center view, as core/depthmatch.js measureMatch: { alpha, cost, meanCost }.
// `views`: [{ u, v, rgb, gain, detail }]. Throws when the GPU cannot do it
// (the caller falls back to the CPU version).
export function measureMatchGpu(gpu, views, w, h, { onProgress } = {}) {
  const gl = gpu.gl;
  const P = DEPTH_PASSES;
  const pr = programs(gpu);
  const n = w * h;
  const V = views.length;
  if (V > MAX_VIEWS) throw new Error('Too many views for the GPU depth');
  const c = Math.floor(V / 2);
  const count = P.top - P.first + 1;
  const fineCount = P.adapt.on ? P.adapt.fine : count;
  if (Math.max(count, fineCount) > MAX_LABELS) throw new Error('Too many depth labels for the GPU');
  const alphas = Array.from({ length: count }, (_, i) => (P.first + i) * P.lambda);
  const refs = P.refs ?? views.map((_, k) => k);
  if (!refs.includes(c)) refs.push(c);
  const work = new Work(gpu, w, h);
  const done = (p) => {
    gl.finish();
    if (onProgress) onProgress(p);
  };
  try {
    // Prepared like the CPU version, then up to the GPU.
    const colors = viewColors(views, n, w, h);
    const colorTex = work.array(w, h, V);
    const rgba = new Float32Array(n * 4);
    colors.forEach((img, k) => {
      for (let i = 0; i < n; i++) {
        rgba[4 * i] = img[3 * i];
        rgba[4 * i + 1] = img[3 * i + 1];
        rgba[4 * i + 2] = img[3 * i + 2];
      }
      uploadLayer(work, colorTex, k, rgba, 4);
    });
    const weightTex = work.array(w, h, V, gl.R32F);
    const guideTex = work.tex(w, h);
    const armsTex = work.tex(w, h);
    const flatTex = work.tex(w, h, gl.R32F);
    const flatTmp = work.tex(w, h, gl.R32F);
    const edgeTex = work.tex(w, h);
    const costTex = work.tex(w, h);
    const behindTex = work.array(w, h, V, gl.R32F);
    const zeroTex = work.tex(w, h, gl.R32F);
    const aggA = work.tex(w, h);
    const aggB = work.tex(w, h);
    const outTex = work.tex(w, h);
    const bigShape = work.atlasShape(Math.ceil(Math.max(count, fineCount) / 4));
    const big = solverSet(work, bigShape);
    const rawAtlas = work.tex(bigShape.width, bigShape.height);
    const flagAtlas = work.tex(bigShape.width, bigShape.height);

    const fullscreen = (prog, target, layer) => {
      gpu.target(target, w, h, layer);
      gl.useProgram(prog.p);
    };
    const bind = (prog, name, unit, tex, kind = gl.TEXTURE_2D) => {
      gl.uniform1i(prog.u[name], unit);
      gpu.bindTex(unit, tex, kind);
    };

    // One reference view's depth over `labels` (linear: first + k * step).
    const measureView = (r, labels, weights, refine, behind = false) => {
      const K = labels.length;
      const guide = depthColorGuide(Float32Array.from(views[r].rgb, (x) => x * views[r].gain));
      upload2D(work, guideTex, guide, 3);
      let Q = pr.arms;
      fullscreen(Q, armsTex);
      bind(Q, 'uGuide', 1, guideTex);
      gl.uniform1i(Q.u.uArm, DEPTH_CBCA.arm);
      gl.uniform1i(Q.u.uLong, DEPTH_CBCA.long);
      gl.uniform1f(Q.u.uTau, DEPTH_CBCA.tau);
      gl.uniform1f(Q.u.uTau2, DEPTH_CBCA.tau2);
      gpu.draw();
      if (DEPTH_EDGE.on) {
        Q = pr.sobel;
        fullscreen(Q, flatTmp);
        bind(Q, 'uGuide', 1, guideTex);
        gl.uniform1f(Q.u.uLo, DEPTH_EDGE.lo);
        gl.uniform1f(Q.u.uHi, DEPTH_EDGE.hi);
        gpu.draw();
        Q = pr.gauss;
        fullscreen(Q, outTex);
        bind(Q, 'uSrc', 1, flatTmp);
        gl.uniform2i(Q.u.uDir, 1, 0);
        gl.uniform1f(Q.u.uSigma, DEPTH_EDGE.sigma);
        gpu.draw();
        fullscreen(Q, flatTex);
        bind(Q, 'uSrc', 1, outTex);
        gl.uniform2i(Q.u.uDir, 0, 1);
        gpu.draw();
      }
      Q = pr.edge;
      fullscreen(Q, edgeTex);
      bind(Q, 'uGuide', 1, guideTex);
      gl.uniform1f(Q.u.uEdge, DEPTH_TRWS.edge);
      gl.uniform1f(Q.u.uLow, DEPTH_TRWS.low);
      gpu.draw();
      const shifts = new Float32Array(MAX_VIEWS * 4);
      views.forEach((v, k) => {
        shifts[4 * k] = (v.u - views[r].u) * v.detail;
        shifts[4 * k + 1] = (v.v - views[r].v) * v.detail;
      });
      const a0 = labels.first;
      const step = labels.step;
      const tile = (k) => {
        const g = k >> 2;
        return { ox: (g % bigShape.cols) * w, oy: Math.floor(g / bigShape.cols) * h, ch: k & 3 };
      };
      // The raw costs of every label (and which pixels are blown out), kept in atlases.
      for (let k = 0; k < K; k++) {
        const alpha = a0 + k * step;
        Q = pr.cost;
        fullscreen(Q, costTex);
        bind(Q, 'uColors', 1, colorTex, gl.TEXTURE_2D_ARRAY);
        bind(Q, 'uWeights', 2, weightTex, gl.TEXTURE_2D_ARRAY);
        bind(Q, 'uBehind', 3, behindTex, gl.TEXTURE_2D_ARRAY);
        gl.uniform1i(Q.u.uUseWeights, weights ? 1 : 0);
        gl.uniform1i(Q.u.uUseBehind, behind ? 1 : 0);
        gl.uniform1i(Q.u.uCount, V);
        gl.uniform1i(Q.u.uRef, r);
        gl.uniform4fv(Q.u.uView, shifts);
        gl.uniform1f(Q.u.uAlpha, alpha);
        gl.uniform1f(Q.u.uCap, DEPTH_LCOST.tc);
        gl.uniform1f(Q.u.uBehindW, P.behind);
        gl.uniform1f(Q.u.uSatur, P.satur);
        gpu.draw();
        const { ox, oy, ch } = tile(k);
        for (const [atlas, comp] of [[rawAtlas, 0], [flagAtlas, 1]]) {
          Q = pr.store;
          gpu.target(atlas, bigShape.width, bigShape.height);
          gl.viewport(ox, oy, w, h);
          gl.useProgram(Q.p);
          bind(Q, 'uSrc', 1, costTex);
          gl.uniform1i(Q.u.uComp, comp);
          gl.uniform2i(Q.u.uOrigin, ox, oy);
          gl.colorMask(ch === 0, ch === 1, ch === 2, ch === 3);
          gpu.draw();
          gl.colorMask(true, true, true, true);
        }
      }
      const atlasUniforms = (prog) => {
        gl.uniform1i(prog.u.uW, w);
        gl.uniform1i(prog.u.uH, h);
        gl.uniform1i(prog.u.uG, bigShape.groups);
        gl.uniform1i(prog.u.uCols, bigShape.cols);
      };
      // Pixels set to zero cost at every depth: blown out, or hardly any difference between depths.
      Q = pr.zero;
      fullscreen(Q, zeroTex);
      bind(Q, 'uRaw', 1, rawAtlas);
      bind(Q, 'uFlags', 2, flagAtlas);
      atlasUniforms(Q);
      gl.uniform1i(Q.u.uK, K);
      gl.uniform1f(Q.u.uFlat, P.flat);
      gpu.draw();
      for (let k = 0; k < K; k++) {
        Q = pr.pull;
        fullscreen(Q, costTex);
        bind(Q, 'uRaw', 1, rawAtlas);
        bind(Q, 'uZeroed', 2, zeroTex);
        atlasUniforms(Q);
        gl.uniform1i(Q.u.uLabel, k);
        gpu.draw();
        // Rounds of aggregation: horizontal then vertical, or the other way.
        let src = costTex;
        for (let round = 0; round < DEPTH_CBCA.iterations; round++) {
          const vertFirst = round % 2 === 0;
          const aggPass = (from, to, axis, first, final) => {
            const A = pr.agg;
            fullscreen(A, to);
            bind(A, 'uSrc', 1, from);
            bind(A, 'uArms', 2, armsTex);
            gl.uniform1i(A.u.uAxis, axis);
            gl.uniform1i(A.u.uFirst, first);
            gl.uniform1i(A.u.uFinal, final);
            gpu.draw();
          };
          aggPass(src, aggA, vertFirst ? 0 : 1, 1, 0);
          aggPass(aggA, aggB, vertFirst ? 1 : 0, 0, 1);
          src = aggB;
        }
        Q = pr.pack;
        const { ox, oy, ch } = tile(k);
        gpu.target(big.U, bigShape.width, bigShape.height);
        gl.viewport(ox, oy, w, h);
        gl.useProgram(Q.p);
        bind(Q, 'uCost', 1, costTex);
        bind(Q, 'uAgg', 2, src === costTex ? costTex : src);
        bind(Q, 'uFlat', 3, flatTex);
        gl.uniform1i(Q.u.uUseFlat, DEPTH_EDGE.on ? 1 : 0);
        gl.uniform1f(Q.u.uScale, DEPTH_TRWS.scale);
        gl.uniform2i(Q.u.uOrigin, ox, oy);
        gl.colorMask(ch === 0, ch === 1, ch === 2, ch === 3);
        gpu.draw();
        gl.colorMask(true, true, true, true);
      }
      solve(work, big, K, DEPTH_TRWS, edgeTex);
      readResult(work, big, K, refine ? 1 : 0, { first: a0, step, discrete: DEPTH_LCOST.discrete ? 1 : 0, scale: DEPTH_TRWS.scale }, outTex);
      const buf = readRGBA(work, outTex);
      const alphaOut = new Float32Array(n);
      const costOut = new Float32Array(n);
      const meanOut = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        alphaOut[i] = buf[4 * i];
        costOut[i] = buf[4 * i + 1];
        meanOut[i] = buf[4 * i + 2];
      }
      return { alpha: alphaOut, cost: costOut, meanCost: meanOut };
    };

    const labelsOf = (first, step, K) => Object.assign(new Array(K), { first, step });

    // Pass 1: every view as the reference.
    const depths = new Array(V).fill(null);
    const pass1 = labelsOf(alphas[0], alphas[1] - alphas[0], count);
    refs.forEach((r, i) => {
      done((0.8 * i) / refs.length);
      depths[r] = median3(measureView(r, pass1, false, false).alpha, w, h);
    });

    // Which views see each pixel of the center.
    const small = solverSet(work, work.atlasShape(1));
    const depthC = work.tex(w, h, gl.R32F);
    const depthV = work.tex(w, h, gl.R32F);
    const landed = work.tex(w, h, gl.R32F);
    const seenTex = work.tex(w, h);
    const visTex = work.tex(w, h, gl.R32F);
    const nv = V - 1;
    // Where `other` sees the pixels of `ref`: 1 visible, 0 hidden, into layer `layer` of `target`.
    const pairVisible = (ref, other, target, layer, invert = false) => {
      upload2D(work, depthC, depths[ref], 1);
      upload2D(work, depthV, depths[other], 1);
      const sx = (views[other].u - views[ref].u) * views[other].detail;
      const sy = (views[other].v - views[ref].v) * views[other].detail;
      clear(work, landed);
      let Q = pr.landed;
      gpu.target(landed, w, h);
      gl.useProgram(Q.p);
      bind(Q, 'uDepth', 1, depthV);
      gl.uniform2f(Q.u.uShift, sx, sy);
      gl.bindVertexArray(gpu.emptyVao);
      gl.drawArrays(gl.POINTS, 0, n);
      gl.bindVertexArray(gpu.vao);
      Q = pr.seen;
      gpu.target(small.U, w, h);
      gl.useProgram(Q.p);
      bind(Q, 'uColors', 1, colorTex, gl.TEXTURE_2D_ARRAY);
      bind(Q, 'uLanded', 2, landed);
      bind(Q, 'uDepth', 3, depthC);
      gl.uniform1i(Q.u.uView, other);
      gl.uniform1i(Q.u.uRef, ref);
      gl.uniform2f(Q.u.uShift, sx, sy);
      gl.uniform1f(Q.u.uCap, DEPTH_LCOST.tc);
      gl.uniform1f(Q.u.uHole, P.hole);
      gl.uniform1f(Q.u.uHidden, P.hidden);
      gl.uniform1f(Q.u.uPer, 10 / nv);
      gpu.draw();
      solve(work, small, 2, { iterations: P.iterations, slope: P.slope, trunc: P.trunc, gamma: DEPTH_TRWS.gamma }, null);
      readResult(work, small, 2, 2, { scale: 1 }, visTex);
      Q = pr.layer;
      fullscreen(Q, target, layer);
      bind(Q, 'uSrc', 1, visTex);
      gl.uniform1f(Q.u.uInvert, invert ? 1 : 0);
      gpu.draw();
    };
    refs.forEach((v) => {
      if (v === c) return;
      pairVisible(c, v, weightTex, v);
    });
    // And which pixels of each other view the center cannot see (hidden from it): 1 - visible.
    refs.forEach((v) => {
      if (v === c) return;
      pairVisible(v, c, behindTex, v, true);
    });

    // Views never measured count fully, as on the CPU.
    const ones = new Float32Array(n).fill(1);
    views.forEach((_, k) => {
      if (k === c || !refs.includes(k)) uploadLayer(work, weightTex, k, ones, 1);
    });

    // Pass 2: the center again, hidden views left out, over the range pass 1 found.
    let labels = pass1;
    if (P.adapt.on) {
      const sorted = Float32Array.from(depths[c]).sort();
      const step = alphas[1] - alphas[0];
      const lo = Math.max(alphas[0], sorted[Math.floor(P.adapt.lowQ * (n - 1))] - P.adapt.pad * step);
      const hi = Math.min(alphas[count - 1], sorted[Math.floor(P.adapt.highQ * (n - 1))] + P.adapt.pad * step);
      labels = labelsOf(lo, (hi - lo) / (P.adapt.fine - 1), P.adapt.fine);
    }
    done(0.85);
    const measured = measureView(c, labels, true, true, true);
    done(1);
    return measured;
  } finally {
    gl.colorMask(true, true, true, true);
    work.dispose();
  }
}
