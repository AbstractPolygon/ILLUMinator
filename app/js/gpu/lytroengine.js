// The sensor side of core/lytroedof.js on the GPU: the corrected plane (white
// image flat field, hot pixels), the engine's light field demosaic, the luma
// boost of SharpenRecoverHighlights and the ray splat itself. The result is
// the same W x H accumulation (premultiplied colour, summed weight) lytroSplat
// returns, which the hole filling and the filter bank (CPU) go on with.
//
// The sensor is processed in bands of rows with an overlap that is more than
// everything one row depends on (demosaic 6, the luma smoothing's 64), so the
// textures stay small and the answer does not change at the seams.
import { program } from './renderer.js';
import { EXPFLUT, H1, V1, S1, H2, V2 } from '../core/lfdemosaic.js';
import { forEachLensPixel } from '../core/superres.js';
import { lensRange } from '../core/lenslet.js';
import { LAMBDA_TO_ALPHA } from '../core/recipe.js';
import { DEPTH_STEP_TOLERANCE } from '../core/superres.js';

const BAND = 256;
const MARGIN = 80;
const SHIFTS = 6; // the luma smoothing's recursion, in 2^k steps: 63 taps, 0.7^64 is gone

const VERTEX = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

const HEAD = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
precision highp sampler2D;
uniform ivec2 uSize;   // sensor size
uniform int uT0;       // sensor row of the band texture's first row
uniform int uCfa[4];
int colour(int x, int y) { return uCfa[((y & 1) << 1) | (x & 1)]; }
`;

const arr = (name, values) => `const float ${name}[${values.length}] = float[${values.length}](${Array.from(values, (v) => v.toFixed(9)).join(', ')});`;
const iarr = (name, values) => `const int ${name}[${values.length}] = int[${values.length}](${values.join(', ')});`;


// BlendIlluminantSharpenGain (core/lytroedof.js bisgFilter): the chroma suppression map from the raw, the suppressed colour's XYZ, and the Lab luma sharpen's inverse.
const SRGB_XYZ_ROWS = [0.4124564, 0.3575761, 0.1804375, 0.2126729, 0.7151522, 0.0721750, 0.0193339, 0.1191920, 0.9503041];
const XYZ_SRGB_ROWS = [3.2404542, -1.5371385, -0.4985314, -0.9692660, 1.8760108, 0.0415560, 0.0556434, -0.2040259, 1.0572252];
const glMat = (rows) => `mat3(${[0, 3, 6, 1, 4, 7, 2, 5, 8].map((i) => rows[i].toFixed(9)).join(', ')})`;
const BISG = `
uniform usampler2D uRaw;
uniform vec3 uBlack;
uniform vec2 uBisgA;     // engine units per ours (white - black over 1023), 1 - black / 1023
uniform mat3 uCcm;
uniform mat3 uCcmInv;
const mat3 SRGB_XYZ = ${glMat(SRGB_XYZ_ROWS)};
const mat3 XYZ_SRGB = ${glMat(XYZ_SRGB_ROWS)};
float planeAt(ivec2 p) { return max(0.0, float(texelFetch(uRaw, p, 0).r) - uBlack[colour(p.x, p.y)]) / 1023.0; }
float suppressCurve(float v) {
  if (v <= 0.6) return 0.0;
  if (v <= 0.75) return (v - 0.6) / 0.15 * 0.2;
  if (v <= 0.84) return 0.2 + (v - 0.75) / 0.09 * 0.8;
  return 1.0;
}
float suppressMap(ivec2 p) {
  if (p.x < 1 || p.y < 1 || p.x >= uSize.x - 1 || p.y >= uSize.y - 1) return suppressCurve(min(1.0, planeAt(p)));
  vec3 M = vec3(0.0);
  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      ivec2 q = p + ivec2(dx, dy);
      int ch = colour(q.x, q.y);
      M[ch] = max(M[ch], planeAt(q));
    }
  }
  M = min(M, vec3(uBisgA.y));
  return suppressCurve(min(1.0, 0.4 * M.r + 0.4 * M.g + 0.2 * M.b));
}
vec3 suppressedXyz(vec3 rgb, ivec2 p) {
  vec3 s = uCcm * (rgb * uBisgA.x);
  float Y = 0.299 * s.r + 0.587 * s.g + 0.114 * s.b;
  float Cb = -0.168736 * s.r - 0.331264 * s.g + 0.5 * s.b;
  float Cr = 0.5 * s.r - 0.418688 * s.g - 0.081312 * s.b;
  float w;
  if (Cr >= 0.0) w = clamp((Cb / (Cr + 0.001) + 0.8) / 0.5, 0.0, 1.0);
  else w = clamp((-Cb / Cr - 4.0) / 2.0, 0.0, 1.0);
  float k = 1.0 - suppressMap(p) * w;
  Cb *= k;
  Cr *= k;
  return SRGB_XYZ * vec3(Y + 1.402 * Cr, Y - 0.344136 * Cb - 0.714136 * Cr, Y + 1.772 * Cb);
}
float labF(float t) { return t > 0.008856 ? pow(t, 1.0 / 3.0) : 7.787037 * t + 0.137931; }
float labFinv(float f) { return f > 0.206893 ? f * f * f : (f - 0.137931) / 7.787037; }
`;

// ---- the corrected plane -----------------------------------------------------------------------------------

const PLANE = `${HEAD}
uniform usampler2D uRaw;
uniform usampler2D uMod;
uniform sampler2D uRef;  // per lens, per colour: the white image at the lens centre
uniform vec3 uBlack;
uniform vec3 uScale;
uniform vec3 uSaturated;
uniform vec4 uGrid;      // pitch, rowStep, cos, sin
uniform vec2 uOrigin;
uniform ivec4 uLens;     // first row, first column, rows, columns
uniform float uRadius;
uniform float uRefMin;
out vec4 o;
float rawAt(int x, int y) { return float(texelFetch(uRaw, ivec2(x, y), 0).r); }
void main() {
  int x = int(gl_FragCoord.x);
  int y = int(gl_FragCoord.y) + uT0;
  o = vec4(-1.0, 0.0, 0.0, 0.0);
  if (x < 2 || y < 2 || x >= uSize.x - 2 || y >= uSize.y - 2) return;
  float pitch = uGrid.x;
  float rowStep = uGrid.y;
  vec2 d = vec2(x, y) - uOrigin;
  float lx = uGrid.z * d.x + uGrid.w * d.y;
  float ly = -uGrid.w * d.x + uGrid.z * d.y;
  int r0 = int(floor(ly / rowStep));
  float best = 1e9;
  int br = 0;
  int bc = 0;
  for (int r = r0; r <= r0 + 1; r++) {
    float off = float(r & 1) * pitch * 0.5;
    int c = int(floor((lx - off) / pitch + 0.5));
    float uu = lx - (float(c) * pitch + off);
    float vv = ly - float(r) * rowStep;
    float dd = uu * uu + vv * vv;
    if (dd < best) { best = dd; br = r; bc = c; }
  }
  if (best > uRadius * uRadius) return;
  ivec2 cell = ivec2(bc - uLens.y, br - uLens.x);
  if (cell.x < 0 || cell.y < 0 || cell.x >= uLens.w || cell.y >= uLens.z) return;
  int ch = colour(x, y);
  float b = uBlack[ch];
  float m = max(0.0, float(texelFetch(uMod, ivec2(x, y), 0).r) - b);
  float ref = texelFetch(uRef, cell, 0)[ch];
  float gain = m > ref * uRefMin ? ref / m : 0.0;
  if (!(gain > 0.0)) return;
  float value = rawAt(x, y);
  float mean = 0.25 * (rawAt(x - 2, y) + rawAt(x + 2, y) + rawAt(x, y - 2) + rawAt(x, y + 2));
  if (value > mean * 3.0 + 40.0 || (value < mean * 0.2 && mean > 100.0)) {
    // HotPixelCorrectionImage::SimpleCorrection
    float vert = abs(rawAt(x, y - 2) - rawAt(x, y + 2)) + abs(rawAt(x, y - 1) - rawAt(x, y + 1));
    float horiz = abs(rawAt(x - 2, y) - rawAt(x + 2, y)) + abs(rawAt(x - 1, y) - rawAt(x + 1, y));
    float est = (vert <= horiz ? rawAt(x, y - 2) + rawAt(x, y + 2) : rawAt(x - 2, y) + rawAt(x + 2, y)) * 0.5 - b;
    if (value - b > 1.2 * est || value > 0.99 * uSaturated[ch]) value = est + b;
    else return;
  }
  o = vec4(max(0.0, value - b) * uScale[ch] * gain, 1.0 / gain, 0.0, 0.0);
}`;

// Unusable pixels take the mean of their valid same colour neighbours (completePlane).
const COMPLETE = `${HEAD}
uniform sampler2D uPlane;
uniform usampler2D uRaw;
uniform vec3 uBlack;
uniform vec3 uScale;
out vec4 o;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int x = p.x;
  int y = p.y + uT0;
  float v = texelFetch(uPlane, p, 0).r;
  if (v >= 0.0) { o = vec4(v); return; }
  float s = 0.0;
  float n = 0.0;
  for (int k = 0; k < 4; k++) {
    ivec2 q = ivec2(x, y) + (k == 0 ? ivec2(-2, 0) : k == 1 ? ivec2(2, 0) : k == 2 ? ivec2(0, -2) : ivec2(0, 2));
    if (q.x < 0 || q.y < 0 || q.x >= uSize.x || q.y >= uSize.y) continue;
    float w = texelFetch(uPlane, ivec2(q.x, q.y - uT0), 0).r;
    if (w >= 0.0) { s += w; n += 1.0; }
  }
  int ch = colour(x, y);
  o = vec4(n > 0.0 ? s / n : max(0.0, float(texelFetch(uRaw, ivec2(x, y), 0).r) - uBlack[ch]) * uScale[ch]);
}`;

// ---- the demosaic (core/lfdemosaic.js) ---------------------------------------------------------------------

const DEMOSAIC_COMMON = `${HEAD}
uniform sampler2D uC;   // the completed plane
uniform sampler2D uT;   // the previous pass
out vec4 o;
${arr('EXPFLUT', EXPFLUT)}
${iarr('H1', H1)}
${iarr('V1', V1)}
${arr('S1', S1)}
${iarr('H2', H2)}
${iarr('V2', V2)}
float P(ivec2 a) { return texelFetch(uC, ivec2(a.x, a.y - uT0), 0).r; }
vec3 T(ivec2 a) { return texelFetch(uT, ivec2(a.x, a.y - uT0), 0).rgb; }
float expw(float g, float f) {
  float v = g * f - 1.0;
  int i = v <= 0.0 ? 0 : (v >= 64.0 ? 64 : int(v));
  return EXPFLUT[i];
}
bool interior(int x, int y) { return x >= 4 && y >= 4 && x < uSize.x - 4 && y < uSize.y - 4; }
`;

const DEMOSAIC_1 = `${DEMOSAIC_COMMON}
// the init value of channel ch at a green site q
float initAt(ivec2 q, int ch) {
  int hc = colour(q.x + 1, q.y);
  return ch == hc ? 0.5 * (P(q + ivec2(-1, 0)) + P(q + ivec2(1, 0))) : 0.5 * (P(q + ivec2(0, -1)) + P(q + ivec2(0, 1)));
}
void main() {
  int x = int(gl_FragCoord.x);
  int y = int(gl_FragCoord.y) + uT0;
  ivec2 p = ivec2(x, y);
  int c = colour(x, y);
  o = vec4(0.0);
  if (!interior(x, y)) {
    // processBorder: the 3 x 3 average of each colour
    vec3 sum = vec3(0.0);
    vec3 cnt = vec3(0.0);
    for (int yy = max(0, y - 1); yy < min(uSize.y, y + 2); yy++) {
      for (int xx = max(0, x - 1); xx < min(uSize.x, x + 2); xx++) {
        int cc = colour(xx, yy);
        sum[cc] += P(ivec2(xx, yy));
        cnt[cc] += 1.0;
      }
    }
    o = vec4(sum[0] / cnt[0], c == 1 ? P(p) : sum[1] / cnt[1], sum[2] / cnt[2], 0.0);
    return;
  }
  if (c == 1) {
    int hc = colour(x + 1, y);
    vec3 r = vec3(0.0);
    r[1] = P(p);
    r[hc] = 0.5 * (P(p + ivec2(-1, 0)) + P(p + ivec2(1, 0)));
    r[2 - hc] = 0.5 * (P(p + ivec2(0, -1)) + P(p + ivec2(0, 1)));
    o = vec4(r, 0.0);
    return;
  }
  // green at red and blue sites
  float c0 = P(p);
  float dg[12];
  float sum = 0.0;
  for (int k = 0; k < 12; k++) {
    ivec2 off = ivec2(H1[k], V1[k]);
    dg[k] = (abs(c0 - P(p + 2 * off)) + abs(P(p + off) - P(p - off))) * S1[k];
    sum += dg[k];
  }
  float f = sum > 0.0 ? 192.0 / sum : 1.0;
  float num = 0.0;
  float den = 0.0;
  for (int k = 0; k < 12; k++) {
    ivec2 off = ivec2(H1[k], V1[k]);
    float w = expw(dg[k], f);
    num += w * (P(p + off) - initAt(p + off, c));
    den += w;
  }
  vec3 r = vec3(0.0);
  r[c] = c0;
  r[1] = c0 + num / den;
  o = vec4(r, 0.0);
}`;

const DEMOSAIC_2 = `${DEMOSAIC_COMMON}
void main() {
  int x = int(gl_FragCoord.x);
  int y = int(gl_FragCoord.y) + uT0;
  ivec2 p = ivec2(x, y);
  o = vec4(T(p), 0.0);
  int c = colour(x, y);
  if (!interior(x, y) || c == 1) return;
  // red at blue sites, blue at red sites
  float c0 = P(p);
  float dd[4];
  float sum = 0.0;
  for (int k = 0; k < 4; k++) {
    ivec2 off = ivec2(H2[k], V2[k]);
    dd[k] = abs(c0 - P(p + 2 * off)) + abs(P(p + off) - P(p - off));
    sum += dd[k];
  }
  float f = sum > 0.0 ? 64.0 / sum : 1.0;
  float num = 0.0;
  float den = 0.0;
  for (int k = 0; k < 4; k++) {
    ivec2 off = ivec2(H2[k], V2[k]);
    float w = expw(dd[k], f);
    num += w * (T(p + off).g - P(p + off));
    den += w;
  }
  vec3 r = T(p);
  r[2 - c] = r.g - num / den;
  o = vec4(r, 0.0);
}`;

const DEMOSAIC_3 = `${DEMOSAIC_COMMON}
void main() {
  int x = int(gl_FragCoord.x);
  int y = int(gl_FragCoord.y) + uT0;
  ivec2 p = ivec2(x, y);
  o = vec4(T(p), 0.0);
  if (!interior(x, y) || colour(x, y) != 1) return;
  // red and blue at green sites
  float g0 = P(p);
  float dg[12];
  float sum = 0.0;
  for (int k = 0; k < 12; k++) {
    ivec2 off = ivec2(H1[k], V1[k]);
    dg[k] = (abs(g0 - P(p + 2 * off)) + abs(P(p + off) - P(p - off))) * S1[k];
    sum += dg[k];
  }
  float f = sum > 0.0 ? 192.0 / sum : 1.0;
  float nr = 0.0;
  float nb = 0.0;
  float den = 0.0;
  for (int k = 0; k < 12; k++) {
    ivec2 off = ivec2(H1[k], V1[k]);
    float w = expw(dg[k], f);
    vec3 t = T(p + off);
    nr += (t.g - t.r) * w;
    nb += (t.g - t.b) * w;
    den += w;
  }
  o = vec4(g0 - nr / den, g0, g0 - nb / den, 0.0);
}`;

// ---- the luma smoothing of SharpenRecoverHighlightsYCbCr ---------------------------------------------------
// y[n] = a x[n] + c y[n - 1], forward then backward, along rows and then columns, by recursive doubling.

const LUMA = `${HEAD}
${BISG}
uniform sampler2D uT;
uniform float uClamp;  // every channel is clamped at white first (0: off)
uniform int uBisg;
out vec4 o;
void main() {
  vec3 t = texelFetch(uT, ivec2(gl_FragCoord.xy), 0).rgb;
  if (uBisg == 1) {
    o = vec4(suppressedXyz(t, ivec2(int(gl_FragCoord.x), int(gl_FragCoord.y) + uT0)).y);
    return;
  }
  if (uClamp > 0.0) t = min(t, vec3(uClamp));
  o = vec4(0.299 * t.r + 0.587 * t.g + 0.114 * t.b);
}`;

// s0 = a x everywhere but at the recursion's first sample, which keeps x (the engine starts with y[0] = x[0]).
const IIR_INIT = `${HEAD}
uniform sampler2D uSrc;
uniform ivec2 uAxis;
uniform int uStart;  // index along the axis (in this texture) of the first sample, or -1
uniform float uA;
out vec4 o;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float x = texelFetch(uSrc, p, 0).r;
  int n = uAxis.x == 1 ? p.x : p.y;
  o = vec4(n == uStart ? x : uA * x);
}`;

const IIR_STEP = `${HEAD}
uniform sampler2D uSrc;
uniform ivec2 uStep;   // minus the direction of the recursion times 2^k
uniform float uCoef;   // c^(2^k)
out vec4 o;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 q = p + uStep;
  float v = texelFetch(uSrc, p, 0).r;
  ivec2 sz = textureSize(uSrc, 0);
  if (q.x >= 0 && q.y >= 0 && q.x < sz.x && q.y < sz.y) v += uCoef * texelFetch(uSrc, q, 0).r;
  o = vec4(v);
}`;

// ---- the rays ----------------------------------------------------------------------------------------------

const SPLAT_VERTEX = `${HEAD}
${BISG}
uniform int uBisg;
uniform sampler2D uT;      // demosaiced
uniform sampler2D uLow;    // smoothed luma
uniform sampler2D uPlane;  // plane, modulation
uniform highp sampler2D uDepth;
uniform highp sampler2D uDepthLo;
uniform highp sampler2D uDepthHi;
uniform highp sampler2D uZ;
uniform vec4 uGrid;
uniform vec2 uOrigin;
uniform vec2 uMin;
uniform float uUnit;
uniform vec4 uHex;         // apothem, rise, plane radius (unused here), 0
uniform ivec4 uLens;
uniform int uStart;
uniform int uY0;           // first ray row
uniform int uRows;
uniform float uScaleOut;
uniform ivec2 uOutSize;
uniform vec2 uSharpen;     // amount, clamp at white (0: off)
uniform float uModPow;
uniform float uTolerance;
uniform vec2 uMarch;       // tolA, tolB
uniform vec2 uRayShift;    // viewpoint shift of every ray (px, lens array axes)
uniform int uExact;        // the engine's ray model (lytroSplat opts.exact)
uniform highp sampler2D uGct;
uniform vec4 uExactA;      // pitch.y, ratio.x, ratio.y, lambda gain
uniform vec4 uExactB;      // sampler grid: origin x, origin y, cos, sin
uniform vec2 uCam;
uniform int uRayWarp;
uniform highp sampler2D uRayGrid;
uniform highp sampler2D uRayCover;
uniform vec4 uRayMin;
uniform vec4 uRayStep;
uniform ivec4 uRayN;
uniform float uRayBorder;
flat out vec2 vQ;
flat out vec4 vRgb;
flat out float vW;
flat out float vLam;

const float LTA = ${LAMBDA_TO_ALPHA};

vec4 rayWarpAt(vec4 q) {
  vec4 t = uRayBorder + (q - uRayMin) / uRayStep;
  vec4 f0 = clamp(floor(t), vec4(0.0), vec4(uRayN) - 2.0);
  ivec4 i = ivec4(f0);
  vec4 f = t - f0;
  vec4 acc = vec4(0.0);
  float w = 0.0;
  for (int c = 0; c < 16; c++) {
    ivec4 o = ivec4(c & 1, (c >> 1) & 1, (c >> 2) & 1, (c >> 3) & 1);
    float k = ((o.x == 1) ? f.x : 1.0 - f.x) * ((o.y == 1) ? f.y : 1.0 - f.y) * ((o.z == 1) ? f.z : 1.0 - f.z) * ((o.w == 1) ? f.w : 1.0 - f.w);
    ivec4 n = i + o;
    ivec2 px = ivec2(n.x * uRayN.z + n.z, n.y * uRayN.w + n.w);
    if (texelFetch(uRayCover, px, 0).r > 0.5) {
      acc += k * texelFetch(uRayGrid, px, 0);
      w += k;
    }
  }
  return w > 0.0 ? acc / w : vec4(0.0);
}

// superres.js sampleDepth
float sampleDepth(highp sampler2D t, vec2 p) {
  ivec2 sz = textureSize(t, 0);
  vec2 f = clamp(p, vec2(0.0), vec2(sz) - 1.001);
  ivec2 i = ivec2(floor(f));
  vec2 a = f - vec2(i);
  float d00 = texelFetch(t, i, 0).r;
  float d10 = texelFetch(t, i + ivec2(1, 0), 0).r;
  float d01 = texelFetch(t, i + ivec2(0, 1), 0).r;
  float d11 = texelFetch(t, i + ivec2(1, 1), 0).r;
  float lo = min(min(d00, d10), min(d01, d11));
  float hi = max(max(d00, d10), max(d01, d11));
  if (hi - lo > ${DEPTH_STEP_TOLERANCE.toFixed(3)}) return a.y < 0.5 ? (a.x < 0.5 ? d00 : d10) : (a.x < 0.5 ? d01 : d11);
  return mix(mix(d00, d10, a.x), mix(d01, d11, a.x), a.y);
}

// the ray march reads the nearest texel of the depth map, upscaled uFactor times (the centre of texel i is at (i + 0.5) / factor - 0.5 lens map pixels)
uniform float uFactor;
float nearestDepth(vec2 p) {
  ivec2 sz = textureSize(uDepth, 0);
  ivec2 i = clamp(ivec2(floor(p * uFactor + (uFactor - 1.0) * 0.5 + 0.5)), ivec2(0), sz - 1);
  return texelFetch(uDepth, i, 0).r;
}

float b3(float t) {
  t = abs(t);
  if (t <= 1.0) return 1.0 - 1.5 * t * t + 0.75 * t * t * t;
  if (t <= 2.0) { float s = 2.0 - t; return 0.25 * s * s * s; }
  return 0.0;
}

void main() {
  gl_PointSize = 2.0;
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  vQ = vec2(0.0);
  vRgb = vec4(0.0);
  vW = 0.0;
  vLam = 0.0;
  int idx = uStart + gl_VertexID;
  int x = idx % uSize.x;
  int y = uY0 + idx / uSize.x;
  if (idx / uSize.x >= uRows) return;
  if (x < 2 || y < 2 || x >= uSize.x - 2 || y >= uSize.y - 2) return;
  ivec2 pl = ivec2(x, y - uT0);
  vec4 pm = texelFetch(uPlane, pl, 0);
  if (!(pm.r >= 0.0)) return;
  float pitch = uGrid.x;
  float rowStep = uGrid.y;
  float cosR = uGrid.z;
  float sinR = uGrid.w;
  vec2 d = vec2(x, y) - uOrigin;
  float lx0 = cosR * d.x + sinR * d.y;
  float ly0 = -sinR * d.x + cosR * d.y;
  int r0 = int(floor(ly0 / rowStep));
  float best = 1e9;
  int br = 0;
  int bc = 0;
  for (int r = r0; r <= r0 + 1; r++) {
    float off = float(r & 1) * pitch * 0.5;
    int c = int(floor((lx0 - off) / pitch + 0.5));
    float uu = lx0 - (float(c) * pitch + off);
    float vv = ly0 - float(r) * rowStep;
    float dd = uu * uu + vv * vv;
    if (dd < best) { best = dd; br = r; bc = c; }
  }
  float lensX = float(bc) * pitch + float(br & 1) * pitch * 0.5;
  float lensY = float(br) * rowStep;
  float u = lx0 - lensX;
  float v = ly0 - lensY;
  // HexAperture: flat sides at |u| = apothem, corners on the v axis
  // (on the direction after the geometry table, like the engine: centred on the table's mean shift)
  float ap = uHex.x;
  float rise = uHex.y;
  vec2 ev = vec2(0.0);
  vec2 centreIdx = vec2(uOrigin.x + cosR * lensX - sinR * lensY, uOrigin.y + sinR * lensX + cosR * lensY);
  if (uExact == 1) {
    // geometry table: the nearest cell at the disk centre, taken off the direction; the window is on that direction (in lens pitches)
    ivec2 gs = textureSize(uGct, 0);
    vec2 n = (centreIdx + 0.5) / uCam;
    ivec2 gi = clamp(ivec2(floor(vec2(gs) * n + 0.5)), ivec2(0), gs - 1);
    vec2 G = texelFetch(uGct, gi, 0).rg;
    ev = vec2(u / pitch, v / uExactA.x) - G;
    float eau = abs(ev.x);
    if (max(eau, (eau + 1.7320508 * abs(ev.y)) / 2.0) > ap / pitch) return;
  } else {
    float au = abs(u + uRayShift.x);
    float av = abs(v + uRayShift.y);
    if (au > ap || av > 2.0 * rise || (av > rise && av + au / 1.7320508 > 2.0 * rise)) return;
  }
  // the colour: demosaic, then the luma boost
  vec3 rgb = texelFetch(uT, pl, 0).rgb;
  if (uBisg == 1) {
    vec3 xyz = suppressedXyz(rgb, ivec2(x, y));
    float low = texelFetch(uLow, pl, 0).r;
    float Yn = low + (1.0 + uSharpen.x) * (xyz.y - low);
    float fY = labF(xyz.y);
    float aa = 500.0 * (labF(xyz.x / 0.95047) - fY);
    float bb = 200.0 * (fY - labF(xyz.z / 1.08883));
    float fN = labF(Yn);
    vec3 xyz2 = vec3(0.95047 * labFinv(fN + aa / 500.0), Yn, 1.08883 * labFinv(fN - bb / 200.0));
    rgb = (uCcmInv * (XYZ_SRGB * xyz2)) / uBisgA.x;
  } else {
  if (uSharpen.y > 0.0) rgb = min(rgb, vec3(uSharpen.y));
  float Y = 0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b;
  float low = texelFetch(uLow, pl, 0).r;
  float dl = (Y - low) * (1.0 + uSharpen.x);
  float wt = b3(2.0 * Y);
  float nY = wt * (low + dl) + (1.0 - wt) * (low + (dl > 0.0 ? dl : 0.0));
  rgb += vec3(nY - Y);
  }
  vec2 lens = vec2((lensX - uMin.x) / uUnit, (lensY - uMin.y) / uUnit);
  float ru = u;
  float rv = v;
  if (uExact == 1) {
    vec4 wv = rayWarpAt(vec4((centreIdx + 0.5) / uCam - 0.5, ev));
    vec2 P = centreIdx + wv.xy * uCam - uExactB.xy;
    lens = vec2((uExactB.z * P.x + uExactB.w * P.y - uMin.x) / uUnit, (-uExactB.w * P.x + uExactB.z * P.y - uMin.y) / uUnit);
    vec2 dir = vec2(cosR * ev.x - sinR * ev.y + wv.z, cosR * ev.y + sinR * ev.x + wv.w);
    vec2 dpx = dir * uExactA.yz;
    ru = (uExactB.z * dpx.x + uExactB.w * dpx.y) / uUnit / uExactA.w;
    rv = (-uExactB.w * dpx.x + uExactB.z * dpx.y) / uUnit / uExactA.w;
  } else if (uRayWarp == 1) {
    vec2 centre = centreIdx;
    vec4 wv = rayWarpAt(vec4(centre / uCam - 0.5, (u + uRayShift.x) / pitch, (v + uRayShift.y) / pitch));
    vec2 s = wv.xy * uCam;
    lens += vec2(cosR * s.x + sinR * s.y, -sinR * s.x + cosR * s.y) / uUnit;
    ru += (cosR * wv.z + sinR * wv.w) * pitch;
    rv += (-sinR * wv.z + cosR * wv.w) * pitch;
  }
  if (uExact == 0) {
    ru += uRayShift.x;
    rv += uRayShift.y;
  }
  // BackProjectDepthMap::RayTraceRegion
  float lam0 = sampleDepth(uDepthLo, lens) / LTA;
  float lam1 = sampleDepth(uDepthHi, lens) / LTA + 1.0;
  float far = 1e30;
  float lamR = 0.0;
  bool found = false;
  float lam = lam0;
  for (int it = 0; it < 1024; it++) {
    if (lam > lam1) break;
    float a = lam * LTA;
    float dd = nearestDepth(lens - a * vec2(ru, rv)) / LTA;
    if (abs(dd - lam) < uMarch.x) { lamR = dd; found = true; break; }
    if (dd < lam && far < 1e29 && far > lam && far - dd < uMarch.y) {
      float t = far - (lam - 1.0);
      lamR = ((dd - far) * t) / ((lam - dd) + t) + far;
      found = true;
      break;
    }
    if (lam < dd) far = dd;
    lam += 1.0;
  }
  if (!found) {
    if (far < 1e29) { lamR = far; found = true; }
  }
  if (!found) return;
  float a = lamR * LTA;
  vec2 q = (lens - a * vec2(ru, rv)) * uScaleOut;
  vec2 f = floor(q);
  gl_Position = vec4(((f + 1.0) / vec2(uOutSize)) * 2.0 - 1.0, 0.0, 1.0);
  vQ = q;
  float rayWeight = uModPow > 0.0 ? pow(pm.g, uModPow) : 1.0;
  vRgb = vec4(rgb, 1.0);
  vW = rayWeight;
  vLam = lamR;
}`;

const SPLAT_FRAGMENT = `#version 300 es
precision highp float;
uniform highp sampler2D uZ;
uniform float uTolerance;
flat in vec2 vQ;
flat in vec4 vRgb;
flat in float vW;
flat in float vLam;
out vec4 o;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec2 k = vec2(1.0) - abs(vec2(p) - vQ);
  if (k.x <= 0.0 || k.y <= 0.0) discard;
  if (vLam - texelFetch(uZ, p, 0).r >= uTolerance) discard;
  float w = k.x * k.y * vW;
  o = vec4(vRgb.rgb * w, w);
}`;

// ---- driver -----------------------------------------------------------------------------------------------

function programs(gpu) {
  const gl = gpu.gl;
  if (!gpu.lytroPrograms) {
    gpu.lytroPrograms = {
      plane: program(gl, PLANE, VERTEX),
      complete: program(gl, COMPLETE, VERTEX),
      dm1: program(gl, DEMOSAIC_1, VERTEX),
      dm2: program(gl, DEMOSAIC_2, VERTEX),
      dm3: program(gl, DEMOSAIC_3, VERTEX),
      luma: program(gl, LUMA, VERTEX),
      iirInit: program(gl, IIR_INIT, VERTEX),
      iirStep: program(gl, IIR_STEP, VERTEX),
      splat: program(gl, SPLAT_FRAGMENT, SPLAT_VERTEX),
    };
  }
  return gpu.lytroPrograms;
}

function upload(gpu, w, h, internal, format, type, data, alignment = 4) {
  const gl = gpu.gl;
  const t = gpu.texture(w, h, internal);
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, alignment);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, format, type, data);
  return t;
}

// The usable pixels' white image level at every lens centre: [r, g, b, 0] per lens, rows x cols.
function lensReferences(modulation, cam, dev, g, range) {
  const rows = range.r1 - range.r0 + 1;
  const cols = range.c1 - range.c0 + 1;
  const sum = new Float64Array(rows * cols * 3);
  const cnt = new Float64Array(rows * cols * 3);
  forEachLensPixel(g, cam, 2.3, (i, x, y, u, v, lensX, lensY) => {
    if (u * u + v * v > 5.3) return;
    const ch = dev.cfa[y & 1][x & 1];
    const r = Math.round(lensY / g.rowStep);
    const c = Math.round((lensX - (r & 1) * g.pitch * 0.5) / g.pitch);
    const cell = (r - range.r0) * cols + (c - range.c0);
    sum[cell * 3 + ch] += Math.max(0, modulation[i] - dev.black[ch]);
    cnt[cell * 3 + ch]++;
  });
  const out = new Float32Array(rows * cols * 4);
  for (let k = 0; k < rows * cols; k++) for (let ch = 0; ch < 3; ch++) out[4 * k + ch] = cnt[3 * k + ch] ? sum[3 * k + ch] / cnt[3 * k + ch] : 0;
  return { data: out, rows, cols };
}

// P: { raw, modulation, cam, dev, grid, sampler: { xMin, yMin }, unit, rayWarp, depth, lw, lh, lo, hi, zMap, scale,
//      W, H, apothem, rise, planeRadius, opts }.
// Returns the W x H x 4 accumulation, or null when this GPU cannot do it.
export function lytroSplatGpu(gpu, P, onProgress = null) {
  const gl = gpu.gl;
  if (!gpu.floatBlend || !P.modulation || !P.rayWarp) return null;
  if (gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE)[1] < 2) return null;
  const { cam, dev, W, H } = P;
  const g = P.grid;
  const prog = programs(gpu);
  const range = lensRange(g, cam.width, cam.height, g.pitch);
  const cos = Math.cos(g.rotation);
  const sin = Math.sin(g.rotation);
  const cfa = [dev.cfa[0][0], dev.cfa[0][1], dev.cfa[1][0], dev.cfa[1][1]];
  const created = [];
  const tex = (w, h, internal) => {
    const t = gpu.texture(w, h, internal);
    created.push(t);
    return t;
  };
  const keep = (t) => {
    created.push(t);
    return t;
  };

  // inputs that live for the whole run
  const rawTex = gpu.rawTex;
  if (!rawTex) return null;
  const modTex = keep(upload(gpu, cam.width, cam.height, gl.R16UI, gl.RED_INTEGER, gl.UNSIGNED_SHORT, P.modulation, 2));
  const refs = lensReferences(P.modulation, cam, dev, g, range);
  if (P.opts.modGlobal) {
    // one reference per colour for the whole sensor (the engine's modulation bitmap is normalised globally), as in correctedPlane
    const mean = [0, 0, 0];
    const cnt = [0, 0, 0];
    for (let k = 0; k < refs.data.length; k += 4) for (let ch = 0; ch < 3; ch++) if (refs.data[k + ch] > 0) { mean[ch] += refs.data[k + ch]; cnt[ch]++; }
    for (let ch = 0; ch < 3; ch++) mean[ch] = cnt[ch] ? mean[ch] / cnt[ch] : 0;
    for (let k = 0; k < refs.data.length; k += 4) for (let ch = 0; ch < 3; ch++) if (refs.data[k + ch] > 0) refs.data[k + ch] = mean[ch];
  }
  const refTex = keep(upload(gpu, refs.cols, refs.rows, gl.RGBA32F, gl.RGBA, gl.FLOAT, refs.data));
  const d5 = P.depth5;
  const depthTex = keep(d5 ? upload(gpu, d5.width, d5.height, gl.R32F, gl.RED, gl.FLOAT, d5.data) : upload(gpu, P.lw, P.lh, gl.R32F, gl.RED, gl.FLOAT, P.depth));
  const loTex = keep(upload(gpu, P.lw, P.lh, gl.R32F, gl.RED, gl.FLOAT, P.lo));
  const hiTex = keep(upload(gpu, P.lw, P.lh, gl.R32F, gl.RED, gl.FLOAT, P.hi));
  const zTex = keep(upload(gpu, W, H, gl.R32F, gl.RED, gl.FLOAT, P.zMap));
  const ex = !!P.opts.exact && !!P.geoTable;
  const gctTex = keep(ex ? upload(gpu, P.geoTable.w, P.geoTable.h, gl.RG32F, gl.RG, gl.FLOAT, P.geoTable.data, 4) : upload(gpu, 1, 1, gl.RG32F, gl.RG, gl.FLOAT, new Float32Array(2), 4));
  const acc = tex(W, H, gl.RGBA32F);
  gpu.target(acc, W, H);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);

  // the band textures
  const rowsMax = BAND + 2 * MARGIN;
  const planeTex = tex(cam.width, rowsMax, gl.RG32F);
  const compTex = tex(cam.width, rowsMax, gl.R32F);
  const dmA = tex(cam.width, rowsMax, gl.RGBA32F);
  const dmB = tex(cam.width, rowsMax, gl.RGBA32F);
  const lumaA = tex(cam.width, rowsMax, gl.R32F);
  const lumaB = tex(cam.width, rowsMax, gl.R32F);

  const sharp = P.opts.sharpen || { amount: 0, c: 0.7 };
  const c = sharp.c;
  const a = 1 - c;

  const bis = !!P.opts.bisg;
  const ccm = cam.ccm && cam.ccm.length === 9 ? cam.ccm : [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const inv3 = (m) => {
    const [a0, b0, c0, d0, e0, f0, g0, h0, i0] = m;
    const A = e0 * i0 - f0 * h0;
    const B = -(d0 * i0 - f0 * g0);
    const C = d0 * h0 - e0 * g0;
    const det = a0 * A + b0 * B + c0 * C;
    return [A / det, -(b0 * i0 - c0 * h0) / det, (b0 * f0 - c0 * e0) / det, B / det, (a0 * i0 - c0 * g0) / det, -(a0 * f0 - c0 * d0) / det, C / det, -(a0 * h0 - b0 * g0) / det, (a0 * e0 - b0 * d0) / det];
  };
  const colMajor = (m) => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
  const bisgUniforms = (U) => {
    gl.uniform1i(U.uBisg, bis ? 1 : 0);
    gl.uniform3fv(U.uBlack, dev.black);
    gl.uniform2f(U.uBisgA, (cam.white[0] - cam.black[0]) / 1023, 1 - cam.black[1] / 1023);
    gl.uniformMatrix3fv(U.uCcm, false, colMajor(ccm));
    gl.uniformMatrix3fv(U.uCcmInv, false, colMajor(inv3(ccm)));
  };
  const common = (U, t0) => {
    gl.uniform2i(U.uSize, cam.width, cam.height);
    gl.uniform1i(U.uT0, t0);
    gl.uniform1iv(U.uCfa, cfa);
  };
  const fullscreen = (p, target, w, h, setup) => {
    gl.disable(gl.BLEND);
    gl.useProgram(p.p);
    gpu.target(target, w, h);
    setup(p.u);
    gpu.draw();
  };
  const bind = (unit, t, uniform) => {
    gpu.bindTex(unit, t);
    gl.uniform1i(uniform, unit);
  };

  for (let y0 = 0; y0 < H_SENSOR(cam); y0 += BAND) {
    const y1 = Math.min(cam.height, y0 + BAND);
    const t0 = Math.max(0, y0 - MARGIN);
    const t1 = Math.min(cam.height, y1 + MARGIN);
    const th = t1 - t0;
    if (onProgress) onProgress(y0 / cam.height);

    fullscreen(prog.plane, planeTex, cam.width, th, (U) => {
      common(U, t0);
      bind(0, rawTex, U.uRaw);
      bind(1, modTex, U.uMod);
      bind(2, refTex, U.uRef);
      gl.uniform3fv(U.uBlack, dev.black);
      gl.uniform3fv(U.uScale, dev.scale);
      gl.uniform3fv(U.uSaturated, dev.saturated);
      gl.uniform4f(U.uGrid, g.pitch, g.rowStep, cos, sin);
      gl.uniform2f(U.uOrigin, g.ox, g.oy);
      gl.uniform4i(U.uLens, range.r0, range.c0, refs.rows, refs.cols);
      gl.uniform1f(U.uRadius, P.planeRadius);
      gl.uniform1f(U.uRefMin, P.opts.modGlobal ? 0.02 : 0.15);
    });
    fullscreen(prog.complete, compTex, cam.width, th, (U) => {
      common(U, t0);
      bind(0, planeTex, U.uPlane);
      bind(1, rawTex, U.uRaw);
      gl.uniform3fv(U.uBlack, dev.black);
      gl.uniform3fv(U.uScale, dev.scale);
    });
    const demosaic = (p, src, dst) => fullscreen(p, dst, cam.width, th, (U) => {
      common(U, t0);
      bind(0, compTex, U.uC);
      bind(1, src, U.uT);
    });
    demosaic(prog.dm1, dmA, dmB);
    demosaic(prog.dm2, dmB, dmA);
    demosaic(prog.dm3, dmA, dmB);
    // the smoothed luma
    fullscreen(prog.luma, lumaA, cam.width, th, (U) => {
      common(U, t0);
      bind(0, dmB, U.uT);
      gl.uniform1f(U.uClamp, sharp.clampPre || 0);
      bisgUniforms(U);
      bind(1, rawTex, U.uRaw);
    });
    let src = lumaA;
    let dst = lumaB;
    const swap = () => {
      [src, dst] = [dst, src];
    };
    const recurse = (axis, backward) => {
      const x = axis === 0;
      const start = x ? (backward ? cam.width - 1 : 0) : (backward ? cam.height - 1 : 0) - t0;
      const inside = x || (start >= 0 && start < th);
      fullscreen(prog.iirInit, dst, cam.width, th, (U) => {
        common(U, t0);
        bind(0, src, U.uSrc);
        gl.uniform2i(U.uAxis, x ? 1 : 0, x ? 0 : 1);
        gl.uniform1i(U.uStart, inside ? start : -1);
        gl.uniform1f(U.uA, a);
      });
      swap();
      for (let k = 0; k < SHIFTS; k++) {
        const s = 1 << k;
        fullscreen(prog.iirStep, dst, cam.width, th, (U) => {
          common(U, t0);
          bind(0, src, U.uSrc);
          const dir = backward ? s : -s;
          gl.uniform2i(U.uStep, x ? dir : 0, x ? 0 : dir);
          gl.uniform1f(U.uCoef, Math.pow(c, s));
        });
        swap();
      }
    };
    recurse(0, false);
    recurse(0, true);
    recurse(1, false);
    recurse(1, true);
    const low = src;

    // the rays of this band
    gl.useProgram(prog.splat.p);
    gpu.target(acc, W, H);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    const U = prog.splat.u;
    common(U, t0);
    bind(0, dmB, U.uT);
    bind(1, low, U.uLow);
    bind(2, planeTex, U.uPlane);
    bind(3, depthTex, U.uDepth);
    bind(4, loTex, U.uDepthLo);
    bind(5, hiTex, U.uDepthHi);
    bind(6, zTex, U.uZ);
    gpu.setRayWarp(U, P.rayWarp);
    gl.uniform4f(U.uGrid, g.pitch, g.rowStep, cos, sin);
    gl.uniform2f(U.uOrigin, g.ox, g.oy);
    gl.uniform2f(U.uMin, P.sampler.xMin, P.sampler.yMin);
    gl.uniform1f(U.uUnit, P.unit);
    gl.uniform4f(U.uHex, P.apothem, P.rise, P.planeRadius, 0);
    gl.uniform1i(U.uY0, y0);
    gl.uniform1i(U.uRows, y1 - y0);
    gl.uniform1f(U.uScaleOut, P.scale);
    gl.uniform2i(U.uOutSize, W, H);
    gl.uniform2f(U.uSharpen, sharp.amount, sharp.clampPre || 0);
    bisgUniforms(U);
    bind(7 + 3, rawTex, U.uRaw);
    gl.uniform1f(U.uModPow, P.opts.modPow || 0);
    gl.uniform1f(U.uTolerance, P.opts.tolerance);
    gl.uniform2f(U.uMarch, P.opts.tolA, P.opts.tolB);
    gl.uniform2f(U.uRayShift, P.rayShift ? P.rayShift[0] : 0, P.rayShift ? P.rayShift[1] : 0);
    gl.uniform2f(U.uCam, cam.width, cam.height);
    gl.uniform1f(U.uFactor, d5 ? d5.factor : 1);
    gl.uniform1i(U.uExact, ex ? 1 : 0);
    gl.uniform1i(U.uGct, 9);
    gpu.bindTex(9, gctTex);
    if (ex) {
      const sg = P.sampleGrid;
      const pitchY = g.rowStep / 0.8660254037844386;
      gl.uniform4f(U.uExactA, pitchY, cos * g.pitch - sin * pitchY, cos * pitchY + sin * g.pitch, LAMBDA_TO_ALPHA * (P.opts.dispScale || 1));
      gl.uniform4f(U.uExactB, sg.ox, sg.oy, Math.cos(sg.rotation), Math.sin(sg.rotation));
    }
    gl.bindVertexArray(gpu.emptyVao);
    const total = (y1 - y0) * cam.width;
    const chunk = 1 << 22;
    for (let start = 0; start < total; start += chunk) {
      gl.uniform1i(U.uStart, start);
      gl.drawArrays(gl.POINTS, 0, Math.min(chunk, total - start));
    }
    gl.disable(gl.BLEND);
  }

  gpu.target(acc, W, H);
  const out = new Float32Array(W * H * 4);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.FLOAT, out);
  for (const t of created) gl.deleteTexture(t);
  return out;
}

function H_SENSOR(cam) {
  return cam.height;
}
