// WebGL2 renderer for sub-aperture views and refocusing. Mirrors
// core/render.js (see there for the reasoning behind each step) but runs on
// the GPU, so the camera view, dragging and animation frames stay real-time.
//
// Pipeline for one view at aperture offset (u, v):
//   lens pass     one texel per lens: demosaiced color at lens center + (u, v)
//   chroma blur   box sum of color over neighboring lenses (two passes)
//   brightness    per lens: every raw pixel near the sample point, converted
//                 to brightness with the neighborhood color
//   view pass     output pixels from nearby lenses (round kernel)
// Views for refocusing are kept in a texture array; a refocused picture is
// one pass that shifts and averages them.
//
// Results are read back as linear RGB (Float32Array, w * h * 3) so the rest
// of the pipeline (depth of field, defringing, tone mapping) is unchanged.

import { rangeSigma, chromaSigma, sharpenWindow, HALO_LIMIT, speckleThreshold, dustRadius, DUST_LOW, DUST_HIGH } from '../core/detail.js';
import { MAX_MASKS } from '../core/local.js';
import { bokehKernel } from '../core/dof.js';
import { CHROMA_EDGE } from '../core/render.js';
import { LYTRO_CURVE, LYTRO_HUE, CURVE_START, CURVE_STEP } from '../core/base.js';
import { PHASE_BINS, latticeTiles, latticeTables, RAY_DEPTH_TOLERANCE, SR_SHARPEN } from '../core/superres.js';

// Texture unit used only for making and uploading textures.
const SPARE_UNIT = 15;
const VERTEX = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

const RAW_COMMON = `
uniform highp usampler2D uRaw;
uniform ivec2 uRawSize;
uniform vec3 uBlack;
uniform vec3 uScale;
uniform float uClip;
uniform vec3 uSaturated; // raw level where each channel saturates
uniform vec3 uGain;
uniform ivec2 uOrigR;
uniform ivec2 uOrigG1;
uniform ivec2 uOrigG2;
uniform ivec2 uOrigB;
uniform int uCfa[4];
uniform vec4 uGrid;   // pitch, rowStep, cos, sin
uniform vec2 uOrigin; // grid origin on the sensor
uniform ivec2 uLens0; // first lens column, first lens row
uniform vec2 uUV;     // aperture offset, rotated to sensor axes

float rawAt(ivec2 p) { return float(texelFetch(uRaw, p, 0).r); }

float lattice(ivec2 o, vec2 p) {
  vec2 f = (p - vec2(o)) * 0.5;
  vec2 i = floor(f);
  vec2 a = f - i;
  ivec2 s = o + 2 * ivec2(i);
  if (s.x < 0 || s.y < 0 || s.x + 2 >= uRawSize.x || s.y + 2 >= uRawSize.y) return 0.0;
  float v00 = rawAt(s);
  float v10 = rawAt(s + ivec2(2, 0));
  float v01 = rawAt(s + ivec2(0, 2));
  float v11 = rawAt(s + ivec2(2, 2));
  return mix(mix(v00, v10, a.x), mix(v01, v11, a.x), a.y);
}

vec2 lensCenter(ivec2 lc) {
  int c = lc.x + uLens0.x;
  int r = lc.y + uLens0.y;
  float lx = float(c) * uGrid.x + float(r & 1) * uGrid.x * 0.5;
  float ly = float(r) * uGrid.y;
  return uOrigin + vec2(uGrid.z * lx - uGrid.w * ly, uGrid.w * lx + uGrid.z * ly);
}

float develop(float v, int ch) {
  return clamp((v - uBlack[ch]) * uScale[ch], 0.0, uClip) * uGain[ch];
}
`;

const LENS_PASS = `#version 300 es
precision highp float;
precision highp int;
${RAW_COMMON}
out vec4 outColor;
void main() {
  ivec2 lc = ivec2(gl_FragCoord.xy);
  vec2 p = lensCenter(lc) + uUV;
  float r = develop(lattice(uOrigR, p), 0);
  float g = develop(0.5 * (lattice(uOrigG1, p) + lattice(uOrigG2, p)), 1);
  float b = develop(lattice(uOrigB, p), 2);
  outColor = vec4(r, g, b, dot(vec3(r, g, b), vec3(0.2126, 0.7152, 0.0722)));
}`;

const BOX_PASS = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uSrc;
uniform ivec2 uDir;
uniform ivec2 uSize;
uniform int uRadius;
out vec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 s = vec4(0.0);
  for (int k = -8; k <= 8; k++) {
    if (k < -uRadius || k > uRadius) continue;
    ivec2 q = p + uDir * k;
    if (q.x < 0 || q.y < 0 || q.x >= uSize.x || q.y >= uSize.y) continue;
    s += texelFetch(uSrc, q, 0);
  }
  outColor = s;
}`;

const COPY_PASS = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
out vec4 outColor;
void main() {
  outColor = texelFetch(uSrc, ivec2(gl_FragCoord.xy), 0);
}`;

const BRIGHTNESS_PASS = `#version 300 es
precision highp float;
precision highp int;
${RAW_COMMON}
uniform sampler2D uSum;
uniform float uInv2s2;
out vec4 outColor;
void main() {
  ivec2 lc = ivec2(gl_FragCoord.xy);
  vec4 S = texelFetch(uSum, lc, 0);
  if (!(S.a > 1e-9)) { outColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
  vec3 frac = S.rgb / S.a;
  vec3 toY = vec3(frac.r > 1e-4 ? 1.0 / frac.r : 0.0, frac.g > 1e-4 ? 1.0 / frac.g : 0.0, frac.b > 1e-4 ? 1.0 / frac.b : 0.0);
  vec2 p = lensCenter(lc) + uUV;
  ivec2 p0 = ivec2(floor(p + 0.5));
  float acc = 0.0;
  float wsum = 0.0;
  float clipped = 0.0;
  for (int dy = -2; dy <= 2; dy++) {
    for (int dx = -2; dx <= 2; dx++) {
      ivec2 q = p0 + ivec2(dx, dy);
      if (q.x < 0 || q.y < 0 || q.x >= uRawSize.x || q.y >= uRawSize.y) continue;
      vec2 e = vec2(q) - p;
      float w = exp(-dot(e, e) * uInv2s2);
      int ch = uCfa[(q.y & 1) * 2 + (q.x & 1)];
      float raw = rawAt(q);
      acc += w * develop(raw, ch) * toY[ch];
      wsum += w;
      if (raw >= uSaturated[ch]) clipped += w;
    }
  }
  float lum = wsum > 0.0 ? min(uClip * max(uGain.r, max(uGain.g, uGain.b)), acc / wsum) : S.a;
  // Trust: how much of this sample was not clipped. Where the middle of a
  // lens image is blown out, its darker (vignetted) edge often is not, and
  // refocusing then takes the highlight from there (see REFOCUS_PASS).
  float trust = wsum > 0.0 ? 1.0 - clipped / wsum : 1.0;
  outColor = vec4(lum * frac, max(0.03, trust * trust));
}`;

// Edge-aware color (core/render.js edgeAwareChroma): each lens takes its
// color from the neighboring lenses whose brightness is like its own, so
// color stops at edges instead of bleeding across them. Brightness and
// trust (alpha) are kept.
const CHROMA_PASS = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uLens;   // per lens r, g, b, luminance (LENS_PASS)
uniform sampler2D uBright; // per lens color, trust (BRIGHTNESS_PASS)
uniform ivec2 uSize;
uniform int uRadius;
uniform float uSigma;
out vec4 outColor;
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 c = texelFetch(uBright, p, 0);
  float lum = dot(c.rgb, LUMA);
  float lc = sqrt(max(lum, 0.0));
  float k = -1.0 / (2.0 * uSigma * uSigma);
  vec4 s = vec4(0.0);
  for (int dy = -3; dy <= 3; dy++) {
    for (int dx = -3; dx <= 3; dx++) {
      if (abs(dx) > uRadius || abs(dy) > uRadius) continue;
      ivec2 q = p + ivec2(dx, dy);
      if (q.x < 0 || q.y < 0 || q.x >= uSize.x || q.y >= uSize.y) continue;
      float l = sqrt(max(dot(texelFetch(uBright, q, 0).rgb, LUMA), 0.0));
      float d = (l - lc) / max(0.02, lc);
      s += texelFetch(uLens, q, 0) * exp(k * d * d);
    }
  }
  vec3 f = s.a > 1e-9 ? s.rgb / s.a : vec3(0.0);
  float norm = dot(f, LUMA);
  outColor = norm > 1e-9 && s.a > 1e-9 ? vec4(lum * f / norm, c.a) : c;
}`;

const VIEW_PASS = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uLens;
uniform ivec2 uLensSize;
uniform ivec2 uLens0;
uniform vec4 uGrid;     // pitch, rowStep
uniform vec2 uMin;      // grid-local position of output pixel (0, 0)
uniform float uSpacing; // sensor pixels per output pixel
uniform float uKernel;  // kernel radius, sensor pixels
uniform int uTrust;     // 1: alpha carries the samples' trust (refocus views)
out vec4 outColor;
void main() {
  vec2 l = uMin + (gl_FragCoord.xy - 0.5) * uSpacing;
  float pitch = uGrid.x;
  float rowStep = uGrid.y;
  float r2 = uKernel * uKernel;
  int ra = int(floor(l.y / rowStep));
  vec4 sum = vec4(0.0);
  float wsum = 0.0;
  for (int r = ra - 1; r <= ra + 2; r++) {
    float dy = l.y - float(r) * rowStep;
    if (dy * dy >= r2) continue;
    float off = float(r & 1) * pitch * 0.5;
    int cc = int(floor((l.x - off) / pitch + 0.5));
    for (int c = cc - 1; c <= cc + 1; c++) {
      float dx = l.x - (float(c) * pitch + off);
      float d2 = dx * dx + dy * dy;
      if (d2 >= r2) continue;
      ivec2 t = ivec2(c - uLens0.x, r - uLens0.y);
      if (t.x < 0 || t.y < 0 || t.x >= uLensSize.x || t.y >= uLensSize.y) continue;
      float q = 1.0 - d2 / r2;
      float w = q * q;
      sum += texelFetch(uLens, t, 0) * w;
      wsum += w;
    }
  }
  outColor = wsum > 0.0 ? sum / wsum : vec4(0.0, 0.0, 0.0, 1.0);
  if (uTrust == 0) outColor.a = 1.0;
}`;

const MAX_VIEWS = 64;
const MAX_RING = 8;

const REFOCUS_PASS = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2DArray;
uniform sampler2DArray uViews;
uniform int uCount;
uniform vec4 uView[${MAX_VIEWS}]; // shift x, shift y (output pixels), weight
uniform vec2 uSize;
// Highlight views (see buildViews): from the darker outer ring of each lens
// image, used only where the picture is near clipping.
uniform sampler2DArray uRing;
uniform int uRingCount;
uniform vec2 uRingView[${MAX_RING}];
uniform float uClip;
out vec4 outColor;
// Each view's alpha is its trust (BRIGHTNESS_PASS): clipped samples count
// for little when other views saw the same point unclipped.
void main() {
  vec2 x = gl_FragCoord.xy - 0.5;
  vec3 sum = vec3(0.0);
  float wsum = 0.0;
  for (int k = 0; k < ${MAX_VIEWS}; k++) {
    if (k >= uCount) break;
    vec4 v = uView[k];
    if (v.z < 1e-3) continue;
    vec2 s = x + v.xy;
    if (s.x < 0.0 || s.y < 0.0 || s.x > uSize.x - 1.0 || s.y > uSize.y - 1.0) continue;
    vec4 c = texture(uViews, vec3((s + 0.5) / uSize, float(k)));
    float w = v.z * c.a;
    sum += c.rgb * w;
    wsum += w;
  }
  vec3 col = wsum > 0.0 ? sum / wsum : vec3(0.0);
  float m = max(col.r, max(col.g, col.b));
  if (uRingCount > 0 && m > 0.85 * uClip) {
    // Even a clipped ring sample is a lower bound above the clip level, so
    // the brighter of the two estimates is kept.
    vec3 rs = vec3(0.0);
    float rw = 0.0;
    for (int k = 0; k < ${MAX_RING}; k++) {
      if (k >= uRingCount) break;
      vec2 s = x + uRingView[k];
      if (s.x < 0.0 || s.y < 0.0 || s.x > uSize.x - 1.0 || s.y > uSize.y - 1.0) continue;
      vec4 c = texture(uRing, vec3((s + 0.5) / uSize, float(k)));
      rs += c.rgb * c.a;
      rw += c.a;
    }
    if (rw > 0.0) col = mix(col, max(col, rs / rw), smoothstep(0.85 * uClip, 0.97 * uClip, m));
  }
  outColor = vec4(col, 1.0);
}`;

// Multi-view denoising (core/mvdenoise.js): every refocus view sampled
// where this pixel's scene point appears (shift from the depth map), weighted
// by agreement with the current view, then blended with it.
const MERGE_PASS = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2DArray;
uniform sampler2DArray uViews;
uniform sampler2D uRef;
uniform highp sampler2D uDepth;
uniform int uCount;
uniform vec4 uView[${MAX_VIEWS}]; // (u_k - u0) * detail, (v_k - v0) * detail
uniform vec2 uCenter;             // u0 * detail, v0 * detail
uniform vec2 uSize;
uniform float uSigma;
uniform float uBlend;
out vec4 outColor;
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec2 x = gl_FragCoord.xy - 0.5;
  vec3 ref = texelFetch(uRef, p, 0).rgb;
  float refS = sqrt(max(dot(ref, LUMA), 0.0));
  ivec2 dsz = textureSize(uDepth, 0);
  float a0 = texelFetch(uDepth, clamp(p, ivec2(0), dsz - 1), 0).r;
  ivec2 pc = clamp(ivec2(floor(x - a0 * uCenter + 0.5)), ivec2(0), dsz - 1);
  float a = texelFetch(uDepth, pc, 0).r;
  float k = -0.5 / (uSigma * uSigma);
  vec3 sum = ref;
  float wsum = 1.0;
  for (int i = 0; i < ${MAX_VIEWS}; i++) {
    if (i >= uCount) break;
    vec2 s = x + a * uView[i].xy;
    if (s.x < 0.0 || s.y < 0.0 || s.x > uSize.x - 1.0 || s.y > uSize.y - 1.0) continue;
    vec3 c = texture(uViews, vec3((s + 0.5) / uSize, float(i))).rgb;
    float d = sqrt(max(dot(c, LUMA), 0.0)) - refS;
    float w = exp(k * d * d);
    sum += c * w;
    wsum += w;
  }
  outColor = vec4(mix(ref, sum / wsum, uBlend), 1.0);
}`;

// Depth of field, step 1: per pixel, the blur radius (from the depth map)
// and the color with clipped highlights given back some of their light.
const DOF_PREP = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uSrc;
uniform highp sampler2D uDepth;
uniform vec2 uDepthScale;   // depth map pixels per image pixel
uniform float uFocus;
uniform vec2 uTilt;         // focus change across the picture (normalized x, y)
uniform vec2 uPoint;        // the tilted focus plane turns around this point
uniform float uSpread;      // depth range on each side of the focus kept sharp
uniform float uSmooth;      // width of the soft edge after the sharp range
uniform float uStrength;    // blur radius in pixels per unit of focus difference
uniform float uBlur;        // blur radius (pixels) added everywhere, the sharp range included
uniform float uClip;
uniform float uHighlights;
out vec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec3 c = texelFetch(uSrc, p, 0).rgb;
  ivec2 dsz = textureSize(uDepth, 0);
  ivec2 dp = clamp(ivec2((vec2(p) + 0.5) * uDepthScale), ivec2(0), dsz - 1);
  vec2 n = (vec2(p) + 0.5) / vec2(textureSize(uSrc, 0));
  float d = texelFetch(uDepth, dp, 0).r - (uFocus + dot(uTilt, n - uPoint));
  // Past the sharp range blur builds up gradually over uSmooth (see
  // softEdge in core/dof.js).
  float e = max(abs(d) - uSpread, 0.0);
  if (uSmooth > 0.0) e = e < uSmooth ? e * e / (2.0 * uSmooth) : e - 0.5 * uSmooth;
  d = (d < 0.0 ? -1.0 : 1.0) * (uStrength * e + uBlur);
  float y = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float knee = 0.8 * uClip;
  float t = clamp((y - knee) / (uClip - knee), 0.0, 1.0);
  // Up to 128x at full strength: real highlights (the sun, lamps) are far
  // brighter than the image can store, and their bokeh should glow.
  c *= 1.0 + (exp2(7.0 * uHighlights) - 1.0) * t * t;
  // Signed radius: positive behind the focus plane, negative in front.
  outColor = vec4(c, d);
}`;

const MAX_TAPS = 512;

// Depth of field, step 2: each pixel gathers light from neighbors whose own
// blur reaches it, inside the aperture shape. Bright out-of-focus points thus
// spread into discs, ovals or polygons (bokeh). Points behind this pixel only reach
// it within its own blur, so blurred background does not bleed over sharp
// foreground edges.
// Each pixel looks only as far as the largest blur around it reaches
// (uTiles: per 8 x 8 tile, the largest blur radius within reach), so sharp
// areas far from strong blur cost little. uPass 1 renders the picture at
// half size; uPass 2 then uses that for pixels that are themselves strongly
// blurred (at least uHalfFrom pixels), where half size looks the same.
const DOF_TILE = 8;
const DOF_GATHER = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uPrep;
uniform sampler2D uTiles;
uniform sampler2D uHalf;
uniform int uTaps;
uniform float uMaxR;
uniform float uReach;  // how far past its radius a blur still counts
uniform int uShape;    // 0 smooth, 1 circle, 2 blades (see core/dof.js bokehKernel)
uniform int uBlades;
uniform float uAspect; // the circle's width to height
uniform vec2 uRot;     // rotation: cos, sin
uniform float uOnion;  // onion rings, 0..1
uniform int uPass;     // 0 full size, 1 half size, 2 full size with half size
uniform float uHalfFrom;
out vec4 outColor;

// Distance in units of the shape's radius (as kernelDistance in core/dof.js).
float shapeDist(vec2 o) {
  vec2 q = vec2(uRot.x * o.x + uRot.y * o.y, -uRot.y * o.x + uRot.x * o.y);
  if (uShape == 2) {
    // Regular polygon, one corner up, circumradius 1.
    float seg = 6.2831853 / float(uBlades);
    float m = mod(atan(q.x, q.y), seg) - 0.5 * seg;
    return length(q) * cos(m) / cos(0.5 * seg);
  }
  return length(vec2(q.x / uAspect, q.y));
}

float weightFor(float dist, float r) {
  r = max(r, 0.5);
  float inside = uShape == 0
    ? exp(-2.0 * (dist / r) * (dist / r))
    : clamp(r + 0.5 - dist, 0.0, 1.0);
  // Onion rings (as onionGain in core/dof.js), once the ball is big enough
  // to show them.
  if (uOnion > 0.0 && uShape != 0 && r > 4.0) inside *= 1.0 + uOnion * 0.6 * cos(6.2831853 * 3.0 * dist / r);
  return inside / (r * r * uAspect);
}

// The gathered color at full size pixel position pf (pixel centers at
// integers), whose own prepared value is c.
vec3 gather(vec2 pf, vec4 c, ivec2 size) {
  float rc = abs(c.a);
  vec3 sum = c.rgb * weightFor(0.0, rc);
  float wsum = weightFor(0.0, rc);
  ivec2 t = clamp(ivec2(pf) / ${DOF_TILE}, ivec2(0), textureSize(uTiles, 0) - 1);
  float maxR = min(uMaxR, texelFetch(uTiles, t, 0).r * uReach + 1.0);
  if (maxR < 0.75) return c.rgb;
  int taps = clamp(int(maxR * maxR * 1.2 + 0.5), 16, uTaps);
  // Each tap stands for the area between taps: read the pre-averaged
  // (mipmapped) image at that scale, so large blurs are smooth, not grainy.
  float lod = max(0.0, log2(maxR * sqrt(3.14159265 / float(taps))) + 0.5);
  for (int i = 0; i < ${MAX_TAPS}; i++) {
    if (i >= taps) break;
    float rr = sqrt((float(i) + 0.5) / float(taps)) * maxR;
    float th = float(i) * 2.39996323;
    vec2 o = rr * vec2(cos(th), sin(th));
    vec2 qf = clamp(pf + o, vec2(0.0), vec2(size - 1));
    vec4 s = textureLod(uPrep, (qf + 0.5) / vec2(size), lod);
    float rq = abs(s.a);
    float dist = shapeDist(o);
    // Behind this pixel: only within this pixel's own blur.
    if (s.a > c.a + 0.5 && dist > rc + 0.5) continue;
    float w = weightFor(dist, rq);
    sum += s.rgb * w;
    wsum += w;
  }
  return sum / max(wsum, 1e-9);
}

void main() {
  ivec2 size = textureSize(uPrep, 0);
  ivec2 p = ivec2(gl_FragCoord.xy);
  if (uPass == 1) {
    // Half size: one pixel per 2 x 2 block, at the block's center.
    ivec2 q = min(p * 2, size - 1);
    vec4 c = texelFetch(uPrep, q, 0);
    outColor = vec4(gather(vec2(p * 2) + 0.5, c, size), c.a);
    return;
  }
  vec4 c = texelFetch(uPrep, p, 0);
  if (uPass == 2 && abs(c.a) >= uHalfFrom) {
    // Upsample the half size result, preferring samples blurred like this
    // pixel (so foreground and background stay apart at their edges).
    ivec2 hs = textureSize(uHalf, 0);
    vec2 h = (vec2(p) + 0.5) * 0.5 - 0.5;
    ivec2 h0 = ivec2(floor(h));
    vec2 f = h - vec2(h0);
    vec3 sum = vec3(0.0);
    float wsum = 0.0;
    for (int j = 0; j < 2; j++) {
      for (int i = 0; i < 2; i++) {
        ivec2 hq = clamp(h0 + ivec2(i, j), ivec2(0), hs - 1);
        vec4 s = texelFetch(uHalf, hq, 0);
        float w = (i == 0 ? 1.0 - f.x : f.x) * (j == 0 ? 1.0 - f.y : f.y);
        w *= exp(-abs(s.a - c.a) / max(1.0, 0.25 * abs(c.a)));
        sum += s.rgb * w;
        wsum += w;
      }
    }
    if (wsum > 1e-4) {
      outColor = vec4(sum / wsum, 1.0);
      return;
    }
  }
  outColor = vec4(gather(vec2(p), c, size), 1.0);
}`;

// Largest blur radius in each 8 x 8 tile (uPass 0), then the largest within
// uRadius tiles along uDir (uPass 1, twice), so each tile knows how far the
// blur around it reaches.
const DOF_TILES = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uSrc;
uniform int uPass;
uniform ivec2 uDir;
uniform int uRadius;
out vec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 size = textureSize(uSrc, 0);
  float m = 0.0;
  if (uPass == 0) {
    for (int y = 0; y < ${DOF_TILE}; y++) {
      for (int x = 0; x < ${DOF_TILE}; x++) {
        ivec2 q = p * ${DOF_TILE} + ivec2(x, y);
        if (q.x < size.x && q.y < size.y) m = max(m, abs(texelFetch(uSrc, q, 0).a));
      }
    }
  } else {
    for (int k = -16; k <= 16; k++) {
      if (k < -uRadius || k > uRadius) continue;
      ivec2 q = p + uDir * k;
      if (q.x < 0 || q.y < 0 || q.x >= size.x || q.y >= size.y) continue;
      m = max(m, texelFetch(uSrc, q, 0).r);
    }
  }
  outColor = vec4(m, 0.0, 0.0, 0.0);
}`;

// Details, spot removal (core/detail.js removeSpeckles): each channel
// clamped to its eight neighbors' range when it stands out beyond all of
// them (uThreshold 0 = off). Brightness goes to alpha for the dust passes.
const DETAIL_SPECKLE = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uSrc;
uniform float uThreshold;
uniform int uSize;
out vec4 outColor;
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
void main() {
  ivec2 size = textureSize(uSrc, 0);
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec3 c = max(texelFetch(uSrc, p, 0).rgb, vec3(0.0));
  if (uThreshold > 0.0) {
    // As removeSpeckles in core/detail.js: the ring uSize pixels around.
    vec3 lo = vec3(1e9);
    vec3 hi = vec3(-1e9);
    vec3 sum = vec3(0.0);
    float n = 0.0;
    for (int dy = -5; dy <= 5; dy++) {
      for (int dx = -5; dx <= 5; dx++) {
        if (max(abs(dx), abs(dy)) != uSize) continue;
        vec3 v = sqrt(max(texelFetch(uSrc, clamp(p + ivec2(dx, dy), ivec2(0), size - 1), 0).rgb, vec3(0.0)));
        lo = min(lo, v);
        hi = max(hi, v);
        sum += v;
        n += 1.0;
      }
    }
    vec3 v = sqrt(c);
    vec3 m = sum / n;
    vec3 speck = max(step(hi + uThreshold, v), step(v, lo - uThreshold));
    c = mix(c, m * m, speck);
  }
  outColor = vec4(c, dot(c, LUMA));
}`;

// Details, dust: one separable pass over channel uChan (0 = red, 3 =
// alpha) along uDir, written to red: uMode 0 max, 1 min, 2 Gaussian blur
// (sigma 1, 5 taps).
const DETAIL_MORPH = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uSrc;
uniform ivec2 uDir;
uniform int uRadius;
uniform int uMode;
uniform int uChan;
out vec4 outColor;
void main() {
  ivec2 size = textureSize(uSrc, 0);
  ivec2 p = ivec2(gl_FragCoord.xy);
  float m = uMode == 0 ? -1e9 : uMode == 1 ? 1e9 : 0.0;
  const float BLUR[5] = float[5](0.0545, 0.2442, 0.4026, 0.2442, 0.0545);
  for (int k = -10; k <= 10; k++) {
    if (k < -uRadius || k > uRadius) continue;
    vec4 t = texelFetch(uSrc, clamp(p + uDir * k, ivec2(0), size - 1), 0);
    float v = uChan == 3 ? t.a : t.r;
    if (uMode == 0) m = max(m, v);
    else if (uMode == 1) m = min(m, v);
    else m += v * BLUR[k + 2];
  }
  outColor = vec4(m, 0.0, 0.0, 0.0);
}`;

// Details, dust: lifts each pixel by its spot's darkening (dustGain in
// core/detail.js) from the blurred (uBlur) and closed (uClosed) brightness.
const DETAIL_DUST = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uSrc;
uniform sampler2D uBlur;
uniform sampler2D uClosed;
out vec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec3 c = texelFetch(uSrc, p, 0).rgb;
  float b = texelFetch(uBlur, p, 0).r;
  float cl = texelFetch(uClosed, p, 0).r;
  float g = 1.0;
  if (cl > 1e-9) {
    float r = b / cl;
    if (r > 0.0 && r < 1.0) g = 1.0 + smoothstep(${DUST_LOW}, ${DUST_HIGH}, r) * (1.0 / r - 1.0);
  }
  outColor = vec4(c * g, 1.0);
}`;

// Details, pass 1 (core/detail.js): luminance noise reduction (bilateral
// on sqrt brightness) and color noise reduction (color of the blurred
// neighborhood). Writes color (RGB relative to brightness) to rgb and sqrt
// brightness to alpha.
const DETAIL_NR = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uSrc;
uniform float uRangeSigma;   // 0 = off
uniform float uChromaSigma;  // 0 = off
out vec4 outColor;
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
vec3 at(ivec2 q, ivec2 size) { return texelFetch(uSrc, clamp(q, ivec2(0), size - 1), 0).rgb; }
void main() {
  ivec2 size = textureSize(uSrc, 0);
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec3 c = at(p, size);
  float y = max(dot(c, LUMA), 0.0);
  float s = sqrt(y);
  if (uRangeSigma > 0.0) {
    float k = -0.5 / (uRangeSigma * uRangeSigma);
    float sum = 0.0;
    float wsum = 0.0;
    for (int dy = -2; dy <= 2; dy++) {
      for (int dx = -2; dx <= 2; dx++) {
        float v = sqrt(max(dot(at(p + ivec2(dx, dy), size), LUMA), 0.0));
        float d = v - s;
        float w = exp(-0.5 / 2.25 * float(dx * dx + dy * dy) + k * d * d);
        sum += v * w;
        wsum += w;
      }
    }
    s = sum / wsum;
  }
  vec3 col = c;
  if (uChromaSigma > 0.0) {
    col = vec3(0.0);
    for (int dy = -6; dy <= 6; dy++) {
      for (int dx = -6; dx <= 6; dx++) {
        col += at(p + ivec2(dx, dy), size) * exp(-0.5 * float(dx * dx + dy * dy) / (uChromaSigma * uChromaSigma));
      }
    }
  }
  float cy = dot(col, LUMA);
  outColor = vec4(cy > 1e-9 ? col / cy : vec3(1.0), s);
}`;

// Details, pass 2: unsharp mask on sqrt brightness, then recombine.
const DETAIL_SHARPEN = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uSrc;
uniform float uAmount;
uniform float uRadius;
uniform int uWindow;
uniform float uDetail;
uniform float uHalo;
uniform float uMasking;
out vec4 outColor;
float aAt(ivec2 q, ivec2 size) { return texelFetch(uSrc, clamp(q, ivec2(0), size - 1), 0).a; }
void main() {
  ivec2 size = textureSize(uSrc, 0);
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 c = texelFetch(uSrc, p, 0);
  float s = c.a;
  if (uAmount > 0.0) {
    float sum = 0.0;
    float wsum = 0.0;
    for (int dy = -6; dy <= 6; dy++) {
      if (dy < -uWindow || dy > uWindow) continue;
      for (int dx = -6; dx <= 6; dx++) {
        if (dx < -uWindow || dx > uWindow) continue;
        float w = exp(-0.5 * float(dx * dx + dy * dy) / (uRadius * uRadius));
        sum += texelFetch(uSrc, clamp(p + ivec2(dx, dy), ivec2(0), size - 1), 0).a * w;
        wsum += w;
      }
    }
    float diff = s - sum / wsum;
    float limited = clamp(diff, -uHalo, uHalo);
    float mask = 1.0;
    if (uMasking > 0.0) {
      // Same as edgeMask in core/detail.js.
      vec2 g = vec2(aAt(p + ivec2(1, 0), size) - aAt(p - ivec2(1, 0), size), aAt(p + ivec2(0, 1), size) - aAt(p - ivec2(0, 1), size));
      float t = 0.06 * uMasking;
      mask = smoothstep(0.0, 1.0, clamp((0.5 * length(g) - 0.5 * t) / t, 0.0, 1.0));
    }
    s = max(0.0, s + mask * 1.5 * uAmount * (diff * uDetail + limited * (1.0 - uDetail)));
  }
  outColor = vec4(max(c.rgb * (s * s), vec3(0.0)), 1.0);
}`;

// Final step: color matrix, defringing, exposure and sRGB encoding, drawn
// straight to the canvas (flipped: canvas rows run top to bottom).
// A local adjustment mask's weight at n (0..1 across the picture); needs
// the mask uniforms, uDepth and uDepthOn.
const MASK_WEIGHT = `float maskWeight(int i, vec2 n, float aspect) {
  int kind = uMaskKind[i];
  vec4 s = uMaskShape[i];
  float w = 0.0;
  if (kind == 0) {
    float d = length((n - s.xy) / max(s.zw, vec2(1e-4)));
    w = 1.0 - smoothstep(1.0 - min(0.999, uMaskExtra[i].x), 1.0, d);
  } else if (kind == 1) {
    float a = radians(s.z);
    float t = ((n.x - s.x) * aspect * cos(a) + (n.y - s.y) * sin(a)) / max(1e-4, s.w) + 0.5;
    w = 1.0 - smoothstep(0.0, 1.0, t);
  } else if (kind == 2) {
    if (uDepthOn == 0) return 0.0;
    ivec2 dsz = textureSize(uDepth, 0);
    float d = texelFetch(uDepth, clamp(ivec2(n * vec2(dsz)), ivec2(0), dsz - 1), 0).r;
    float f = max(1e-4, s.z);
    w = smoothstep(s.x - f, s.x, d) * (1.0 - smoothstep(s.y, s.y + f, d));
  }
  return uMaskExtra[i].w > 0.5 ? 1.0 - w : w;
}
`;

// Spatial effects of local adjustments (core/local.js applySpatial): blur,
// pixelate and sketch, before the picture is finished.
const LOCAL_SPATIAL = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uSrc;
uniform int uMaskCount;
uniform int uMaskKind[${MAX_MASKS}];
uniform vec4 uMaskShape[${MAX_MASKS}];
uniform vec4 uMaskExtra[${MAX_MASKS}];
uniform vec4 uMaskFx2[${MAX_MASKS}];  // tint, blur, pixelate, sketch
uniform highp sampler2D uDepth;
uniform int uDepthOn;
out vec4 outColor;
${MASK_WEIGHT}
vec3 at(vec2 q, ivec2 size) {
  return texelFetch(uSrc, clamp(ivec2(floor(q)), ivec2(0), size - 1), 0).rgb;
}
float lum(vec3 c) {
  return dot(c, vec3(0.2126, 0.7152, 0.0722));
}
float logLum(ivec2 q, ivec2 size) {
  return log2(lum(texelFetch(uSrc, clamp(q, ivec2(0), size - 1), 0).rgb) + 1e-4);
}
void main() {
  ivec2 size = textureSize(uSrc, 0);
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec3 c = texelFetch(uSrc, p, 0).rgb;
  vec2 n = (vec2(p) + 0.5) / vec2(size);
  float aspect = float(size.x) / float(size.y);
  float big = float(max(size.x, size.y));
  vec2 fp = vec2(p) + 0.5;
  for (int i = 0; i < ${MAX_MASKS}; i++) {
    if (i >= uMaskCount) break;
    vec4 e = uMaskFx2[i];
    if (e.y <= 0.0 && e.z <= 0.0 && e.w <= 0.0) continue;
    float w = maskWeight(i, n, aspect);
    if (w <= 0.0) continue;
    vec3 base = texelFetch(uSrc, p, 0).rgb;
    if (e.y > 0.0) {
      float r = e.y * 0.02 * big;
      vec3 acc = vec3(0.0);
      for (int k = 0; k < 32; k++) {
        float a = float(k) * 2.39996;
        acc += at(fp + vec2(cos(a), sin(a)) * r * sqrt((float(k) + 0.5) / 32.0), size);
      }
      c = mix(c, acc / 32.0, w);
    }
    if (e.z > 0.0) {
      float b = max(2.0, floor(e.z * 0.04 * big));
      vec2 cell = floor(vec2(p) / b) * b;
      vec3 acc = vec3(0.0);
      for (int y = 0; y < 4; y++) for (int x = 0; x < 4; x++) acc += at(cell + (vec2(x, y) + 0.5) * b / 4.0, size);
      c = mix(c, acc / 16.0, w);
    }
    if (e.w > 0.0) {
      float gx = logLum(p + ivec2(1, -1), size) + 2.0 * logLum(p + ivec2(1, 0), size) + logLum(p + ivec2(1, 1), size)
        - logLum(p + ivec2(-1, -1), size) - 2.0 * logLum(p + ivec2(-1, 0), size) - logLum(p + ivec2(-1, 1), size);
      float gy = logLum(p + ivec2(-1, 1), size) + 2.0 * logLum(p + ivec2(0, 1), size) + logLum(p + ivec2(1, 1), size)
        - logLum(p + ivec2(-1, -1), size) - 2.0 * logLum(p + ivec2(0, -1), size) - logLum(p + ivec2(1, -1), size);
      float edge = clamp((length(vec2(gx, gy)) / 4.0 - 0.15) / 0.6, 0.0, 1.0);
      vec3 fill = (0.65 * base + 0.35 * lum(base)) * 1.25 * (1.0 - 0.85 * edge);
      c = mix(c, fill, w * e.w);
    }
  }
  outColor = vec4(c, 1.0);
}`;

const PRESENT = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uSrc;
uniform mat3 uMatrix;
uniform float uExposure;
uniform vec2 uFringe[4];   // amount, hue (degrees): purple, green, red, blue
uniform sampler2D uVeil;   // flare veil per tile (core/flare.js), linear
uniform float uVeilAmount;
uniform vec4 uLens;        // core/lens.js: k, zoom, vignetting, start (0 0 0 0: off)
// Local adjustments (core/local.js).
uniform int uMaskCount;
uniform int uMaskKind[${MAX_MASKS}];  // 0 radial, 1 linear, 2 depth
uniform vec4 uMaskShape[${MAX_MASKS}];
uniform vec4 uMaskExtra[${MAX_MASKS}]; // feather (radial), -, -, invert
uniform vec4 uMaskFx[${MAX_MASKS}];   // exposure, contrast, saturation, temperature
uniform vec4 uMaskFx2[${MAX_MASKS}];  // tint
uniform int uMaskShow;
uniform highp sampler2D uDepth;
uniform int uDepthOn;
uniform int uFringeOn;
uniform int uFringeRadius;
uniform float uFringeThreshold;
uniform int uLookOn;
uniform highp sampler3D uLut; // core/lut.js, on sRGB colors
uniform float uLutAmount;    // 0: no LUT
uniform vec3 uLutMin;
uniform vec3 uLutMax;
uniform vec4 uTone;        // contrast, highlights, shadows, whites
uniform vec2 uTone2;       // blacks, vibrance
uniform float uHues[6];    // red, yellow, green, cyan, blue, magenta
uniform int uCurveOn;
uniform float uCurve[65];  // tone curve table (core/curve.js)
out vec4 outColor;

// Bilinear between pixel centers (pos in pixels).
vec3 srcAt(vec2 pos) {
  ivec2 size = textureSize(uSrc, 0);
  vec2 f = clamp(pos - 0.5, vec2(0.0), vec2(size) - 1.001);
  ivec2 i = ivec2(floor(f));
  vec2 a = f - vec2(i);
  vec3 c00 = texelFetch(uSrc, i, 0).rgb;
  vec3 c10 = texelFetch(uSrc, i + ivec2(1, 0), 0).rgb;
  vec3 c01 = texelFetch(uSrc, i + ivec2(0, 1), 0).rgb;
  vec3 c11 = texelFetch(uSrc, i + ivec2(1, 1), 0).rgb;
  return mix(mix(c00, c10, a.x), mix(c01, c11, a.x), a.y);
}

vec3 colorAt(ivec2 q) {
  vec2 size = vec2(textureSize(uSrc, 0));
  vec2 pos = vec2(q) + 0.5;
  vec3 c;
  // Lens correction, as in core/lens.js.
  if (uLens.x != 0.0) {
    vec2 mid = size * 0.5;
    float R = length(mid);
    vec2 d = (pos - mid) / R;
    pos = mid + d * (1.0 + uLens.x * dot(d, d)) * uLens.y * R;
    c = srcAt(pos);
  } else {
    c = texelFetch(uSrc, q, 0).rgb;
  }
  if (uVeilAmount > 0.0) c = max(c - uVeilAmount * texture(uVeil, pos / size).rgb, vec3(0.0));
  if (uLens.z != 0.0) {
    float r = length(pos - size * 0.5) / length(size * 0.5);
    float t = smoothstep(0.0, 1.0, clamp((r - uLens.w) / (1.0 - uLens.w), 0.0, 1.0));
    c *= max(0.0, 1.0 + 1.5 * uLens.z * t);
  }
  return uMatrix * c;
}

float hueOf(vec3 c) {
  float mx = max(c.r, max(c.g, c.b));
  float mn = min(c.r, min(c.g, c.b));
  float d = mx - mn;
  if (d <= 1e-6) return -1.0;
  float h;
  if (mx == c.r) h = mod((c.g - c.b) / d, 6.0);
  else if (mx == c.g) h = (c.b - c.r) / d + 2.0;
  else h = (c.r - c.g) / d + 4.0;
  return mod(h * 60.0 + 360.0, 360.0);
}

// Same as toneCurve / applyLook in core/color.js.
float toneCurve(float x) {
  float black = -0.12 * uTone2.x;
  float white = 1.0 - 0.15 * uTone.w;
  x = (x - black) / (white - black);
  float c = clamp(x, 0.0, 1.0);
  x += uTone.z * 0.85 * c * (1.0 - c) * (1.0 - c);
  x += uTone.y * 0.85 * c * c * (1.0 - c);
  x += uTone.x * 0.8 * (smoothstep(0.0, 1.0, x) - clamp(x, 0.0, 1.0));
  if (uCurveOn == 1) {
    if (x <= 0.0) x = uCurve[0] + x;
    else if (x >= 1.0) x = uCurve[64] + (x - 1.0);
    else {
      float f = x * 64.0;
      int i = int(floor(f));
      x = mix(uCurve[i], uCurve[i + 1], f - float(i));
    }
  }
  return max(x, 0.0);
}

vec3 applyLook(vec3 c) {
  float y = dot(c, vec3(0.2126, 0.7152, 0.0722));
  if (y > 1e-6) c *= pow(toneCurve(pow(y, 1.0 / 2.2)), 2.2) / y;
  float mx = max(c.r, max(c.g, c.b));
  float d = mx - min(c.r, min(c.g, c.b));
  if (d > 1e-6 && mx > 1e-6) {
    float h = hueOf(c);
    float f = 1.0 + uTone2.y * (1.0 - d / mx) * 0.9;
    for (int i = 0; i < 6; i++) {
      float dh = abs(mod(h - float(i) * 60.0 + 540.0, 360.0) - 180.0);
      f += uHues[i] * max(0.0, 1.0 - dh / 60.0);
    }
    float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
    c = l + (c - l) * max(f, 0.0);
  }
  return c;
}

${MASK_WEIGHT}
// Same as applyEffects / applyLocal in core/local.js.
vec3 applyLocal(vec3 c, vec2 n, float aspect) {
  for (int i = 0; i < ${MAX_MASKS}; i++) {
    if (i >= uMaskCount) break;
    float w = maskWeight(i, n, aspect);
    if (w > 0.0) {
      vec4 fx = uMaskFx[i];
      c *= exp2(fx.x * w);
      c.r *= 1.0 + 0.25 * fx.w * w;
      c.b *= 1.0 - 0.25 * fx.w * w;
      c.g *= 1.0 - 0.15 * uMaskFx2[i].x * w;
      float y = dot(c, vec3(0.2126, 0.7152, 0.0722));
      if (fx.y != 0.0 && y > 1e-6) c *= pow(y / 0.18, fx.y * w * 0.6);
      float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = l + (c - l) * max(0.0, 1.0 + fx.z * w);
      c = max(c, vec3(0.0));
    }
    if (i == uMaskShow) c = vec3(c.r * (1.0 - 0.5 * w) + 0.4 * w, c.g * (1.0 - 0.5 * w), c.b * (1.0 - 0.5 * w));
  }
  return c;
}

float srgb(float v) {
  v = clamp(v, 0.0, 1.0);
  return v <= 0.0031308 ? 12.92 * v : 1.055 * pow(v, 1.0 / 2.4) - 0.055;
}

// The Lytro Desktop look (core/base.js): a curve on log2 of each channel.
uniform int uLytro;
uniform float uLytroCurve[${LYTRO_CURVE.length}];
uniform float uLytroSat;
uniform vec2 uLytroHue[${LYTRO_HUE.length}];
float lytroCurve(float v) {
  if (v <= 0.0) return 0.0;
  float t = (log2(v) - float(${CURVE_START})) / ${CURVE_STEP.toFixed(3)};
  if (t <= 0.0) return uLytroCurve[0] * v / exp2(float(${CURVE_START}));
  if (t >= float(${LYTRO_CURVE.length - 1})) return 1.0;
  int i = int(floor(t));
  return mix(uLytroCurve[i], uLytroCurve[i + 1], t - float(i));
}

vec3 encodeOut(vec3 c) {
  if (uLytro == 0) return vec3(srgb(c.r), srgb(c.g), srgb(c.b));
  vec3 s = vec3(lytroCurve(c.r), lytroCurve(c.g), lytroCurve(c.b));
  // Color per hue (lytroColor in core/base.js).
  float u = 0.70710678 * (s.r - s.g);
  float v = 0.40824829 * (s.r + s.g - 2.0 * s.b);
  if (u == 0.0 && v == 0.0) return clamp(s, 0.0, 1.0);
  float t = atan(v, u) / 6.28318531 * 12.0;
  if (t < 0.0) t += 12.0;
  int i = int(floor(t)) % 12;
  vec2 k = uLytroSat * mix(uLytroHue[i], uLytroHue[(i + 1) % 12], fract(t));
  float du = u * k.x - v * k.y - u;
  float dv = u * k.y + v * k.x - v;
  vec3 q = s + vec3(0.70710678 * du + 0.40824829 * dv, -0.70710678 * du + 0.40824829 * dv, -0.81649658 * dv);
  q += dot(s - q, vec3(0.2126, 0.7152, 0.0722));
  return clamp(q, 0.0, 1.0);
}

void main() {
  ivec2 size = textureSize(uSrc, 0);
  ivec2 p = ivec2(int(gl_FragCoord.x), size.y - 1 - int(gl_FragCoord.y));
  vec3 c = colorAt(p);
  if (uFringeOn == 1) {
    float mx = 0.0;
    float mn = 1e9;
    for (int dy = -6; dy <= 6; dy++) {
      if (dy < -uFringeRadius || dy > uFringeRadius) continue;
      for (int dx = -6; dx <= 6; dx++) {
        if (dx < -uFringeRadius || dx > uFringeRadius) continue;
        ivec2 q = clamp(p + ivec2(dx, dy), ivec2(0), size - 1);
        float y = dot(colorAt(q), vec3(0.2126, 0.7152, 0.0722));
        mx = max(mx, y);
        mn = min(mn, y);
      }
    }
    float contrast = mx > 1e-6 ? (mx - mn) / mx : 0.0;
    float edge = clamp((contrast - uFringeThreshold) / 0.35, 0.0, 1.0);
    float hue = hueOf(sqrt(max(c, vec3(0.0))));
    if (edge > 0.0 && hue >= 0.0) {
      float k = 0.0;
      for (int i = 0; i < 4; i++) {
        if (uFringe[i].x <= 0.0) continue;
        float dh = abs(mod(hue - uFringe[i].y + 540.0, 360.0) - 180.0);
        k = max(k, uFringe[i].x * max(0.0, 1.0 - dh / 35.0));
      }
      float y = dot(c, vec3(0.2126, 0.7152, 0.0722));
      c = y + (c - y) * (1.0 - k * edge);
    }
  }
  c *= uExposure;
  // In the Lytro Desktop look the sliders act after its curve.
  if (uLookOn == 1 && uLytro == 0) c = applyLook(c);
  if (uMaskCount > 0) c = applyLocal(c, (vec2(p) + 0.5) / vec2(size), float(size.x) / float(size.y));
  vec3 s = encodeOut(c);
  if (uLookOn == 1 && uLytro == 1) s = pow(max(applyLook(pow(s, vec3(2.2))), vec3(0.0)), vec3(1.0 / 2.2));
  if (uLutAmount > 0.0) {
    float n = float(textureSize(uLut, 0).x);
    vec3 q = clamp((s - uLutMin) / max(uLutMax - uLutMin, vec3(1e-6)), 0.0, 1.0);
    vec3 g = texture(uLut, q * (n - 1.0) / n + 0.5 / n).rgb;
    s = mix(s, clamp(g, 0.0, 1.0), uLutAmount);
  }
  outColor = vec4(s, 1.0);
}`;

// Full resolution: one point per raw pixel, drawn at the pixel's refocused
// position and summed with additive blending (see core/superres.js).
const SPLAT_VERTEX = `#version 300 es
precision highp float;
precision highp int;
uniform highp usampler2D uRaw;
uniform ivec2 uRawSize;
uniform int uStart;
uniform vec3 uBlack;
uniform vec3 uScale;
uniform vec3 uSaturated;
uniform int uCfa[4];
uniform vec4 uGrid;        // pitch, rowStep, cos, sin
uniform vec2 uOrigin;
uniform float uRUse;
uniform vec2 uUV0;
uniform float uInv2a2;     // 0: no aperture weighting
uniform sampler2D uVig;    // bins x bins, RGB gains
uniform float uVigRMax;
uniform int uVigBins;
uniform sampler2D uBase;   // standard render (linear filtering)
uniform vec2 uBaseSize;
uniform highp sampler2D uDepth;
uniform int uAllInFocus;
uniform float uAlpha;
uniform vec2 uMin;
uniform float uUnit;
uniform float uDetail;
uniform float uOutScale;
uniform ivec2 uOutSize;
uniform int uReach;
uniform sampler2D uEstimate;  // back-projection: current result (linear)
uniform int uResidual;        // 1: splat the difference from uEstimate
flat out vec2 vCenter;
flat out float vY;
flat out float vConf;

float rawAt(ivec2 p) { return float(texelFetch(uRaw, p, 0).r); }

float depthAt(vec2 p) {
  ivec2 sz = textureSize(uDepth, 0);
  vec2 f = clamp(p, vec2(0.0), vec2(sz) - 1.001);
  ivec2 i = ivec2(floor(f));
  vec2 a = f - vec2(i);
  float d00 = texelFetch(uDepth, i, 0).r;
  float d10 = texelFetch(uDepth, i + ivec2(1, 0), 0).r;
  float d01 = texelFetch(uDepth, i + ivec2(0, 1), 0).r;
  float d11 = texelFetch(uDepth, i + ivec2(1, 1), 0).r;
  return mix(mix(d00, d10, a.x), mix(d01, d11, a.x), a.y);
}

void main() {
  gl_PointSize = float(2 * uReach + 1);
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // culled unless accepted below
  vY = 0.0;
  vConf = 0.0;
  vCenter = vec2(0.0);
  int idx = uStart + gl_VertexID;
  int x = idx % uRawSize.x;
  int y = idx / uRawSize.x;
  if (x < 2 || y < 2 || x >= uRawSize.x - 2 || y >= uRawSize.y - 2) return;
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
  float lensX = float(bc) * pitch + float(br & 1) * pitch * 0.5;
  float lensY = float(br) * rowStep;
  float u = lx - lensX;
  float v = ly - lensY;
  if (u * u + v * v > uRUse * uRUse) return;
  int ch = uCfa[(y & 1) * 2 + (x & 1)];
  float raw = rawAt(ivec2(x, y));
  if (raw >= uSaturated[ch]) return;
  float m = 0.25 * (rawAt(ivec2(x - 2, y)) + rawAt(ivec2(x + 2, y)) + rawAt(ivec2(x, y - 2)) + rawAt(ivec2(x, y + 2)));
  if (raw > m * 3.0 + 40.0 || (raw < m * 0.2 && m > 100.0)) return;
  float binScale = float(uVigBins) / (2.0 * uVigRMax);
  int bu = int(floor((u + uVigRMax) * binScale));
  int bv = int(floor((v + uVigRMax) * binScale));
  if (bu < 0 || bv < 0 || bu >= uVigBins || bv >= uVigBins) return;
  float gain = texelFetch(uVig, ivec2(bu, bv), 0)[ch];
  if (!(gain > 0.0)) return;
  float du = u - uUV0.x;
  float dv = v - uUV0.y;
  float conf = (1.0 - (u * u + v * v) / (uRUse * uRUse)) * (uInv2a2 > 0.0 ? exp(-(du * du + dv * dv) * uInv2a2) : 1.0);
  if (conf < 1e-3) return;
  vec2 lens = vec2((lensX - uMin.x) / uUnit, (lensY - uMin.y) / uUnit);
  float alpha = uAllInFocus == 1 ? depthAt(lens * uDetail) : uAlpha;
  if (uAllInFocus == 1) {
    // Each ray at the depth of the surface it meets (core/superres.js).
    float a1 = depthAt((lens - alpha * vec2(du, dv)) * uDetail);
    float a2 = depthAt((lens - a1 * vec2(du, dv)) * uDetail);
    if (abs(a2 - a1) <= ${RAY_DEPTH_TOLERANCE.toFixed(3)}) alpha = a2;
    else {
      // Two surfaces: the nearer wins if the ray lands on it.
      float nearA = min(a1, a2);
      alpha = abs(depthAt((lens - nearA * vec2(du, dv)) * uDetail) - nearA) <= ${RAY_DEPTH_TOLERANCE.toFixed(3)} ? nearA : max(a1, a2);
    }
  }
  vec2 o = (lens - alpha * vec2(du, dv)) * uOutScale;
  ivec2 pp = ivec2(floor(o + 0.5));
  if (pp.x < uReach || pp.y < uReach || pp.x >= uOutSize.x - uReach || pp.y >= uOutSize.y - uReach) return;
  vec3 up = texture(uBase, (vec2(pp) + 0.5) / uOutScale * uDetail / uBaseSize).rgb;
  float c = up[ch];
  if (!(c > 1e-5)) return;
  float upY = dot(up, vec3(0.2126, 0.7152, 0.0722));
  float value = max(0.0, raw - uBlack[ch]) * uScale[ch] * gain;
  vY = value * min(8.0, upY / c);
  if (uResidual == 1) vY -= texture(uEstimate, (o + 0.5) / vec2(uOutSize)).r;
  vConf = conf;
  vCenter = o;
  gl_Position = vec4((vec2(pp) + 0.5) / vec2(uOutSize) * 2.0 - 1.0, 0.0, 1.0);
}`;

const SPLAT_FRAGMENT = `#version 300 es
precision highp float;
uniform float uInv2s2;
flat in vec2 vCenter;
flat in float vY;
flat in float vConf;
out vec4 outColor;
void main() {
  vec2 e = gl_FragCoord.xy - 0.5 - vCenter;
  float w = exp(-dot(e, e) * uInv2s2) * vConf;
  outColor = vec4(vY * w, w, 0.0, 0.0);
}`;

// ---------------------------------------------------------------- full resolution
// The steps of core/superres.js renderSuperRes around the splat, on the GPU,
// so a full resolution picture never leaves GPU memory.

// PHASE_BINS (lattice pattern bins per cell side) comes from core/superres.js.

// Upsampled standard render and how much splatted detail to keep:
// (r, g, b, focus).
const SR_PREP = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uBase;
uniform vec2 uBaseSize;
uniform highp sampler2D uDepth;
uniform float uDetail;
uniform float uScale;
uniform int uAllInFocus;
uniform float uAlpha;
uniform float uTolerance;
uniform float uSpread;
out vec4 outColor;
void main() {
  vec2 p = gl_FragCoord.xy - 0.5;
  vec2 b = clamp((p + 0.5) / uScale * uDetail - 0.5, vec2(0.0), uBaseSize - 1.001);
  ivec2 i = ivec2(floor(b));
  vec2 a = b - vec2(i);
  // Bilinear with full precision weights (as core/superres.js).
  vec3 up = mix(
    mix(texelFetch(uBase, i, 0).rgb, texelFetch(uBase, i + ivec2(1, 0), 0).rgb, a.x),
    mix(texelFetch(uBase, i + ivec2(0, 1), 0).rgb, texelFetch(uBase, i + ivec2(1, 1), 0).rgb, a.x),
    a.y);
  float d = mix(
    mix(texelFetch(uDepth, i, 0).r, texelFetch(uDepth, i + ivec2(1, 0), 0).r, a.x),
    mix(texelFetch(uDepth, i + ivec2(0, 1), 0).r, texelFetch(uDepth, i + ivec2(1, 1), 0).r, a.x),
    a.y);
  float inFocus = 1.0;
  float local = uAlpha;
  if (uAllInFocus == 1) {
    local = d;
  } else {
    float e = (d - uAlpha) / uTolerance;
    inFocus = exp(-e * e);
  }
  // coverage() of core/superres.js.
  float t = clamp((abs(local) * uSpread - 0.35) / (0.9 - 0.35), 0.0, 1.0);
  outColor = vec4(up, inFocus * t * t * (3.0 - 2.0 * t));
}`;

// The splatted brightness, normalized (uPass 0), or corrected by a
// back-projection residual (uPass 1).
const SR_COMBINE = `#version 300 es
precision highp float;
uniform sampler2D uAcc;    // r: sum, g: weight
uniform sampler2D uPrep;
uniform sampler2D uSharp;
uniform int uPass;
out vec4 outColor;
const float LAMBDA = 0.15;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec2 acc = texelFetch(uAcc, p, 0).rg;
  if (uPass == 0) {
    float upY = dot(texelFetch(uPrep, p, 0).rgb, vec3(0.2126, 0.7152, 0.0722));
    outColor = vec4((acc.r + upY * LAMBDA) / (acc.g + LAMBDA), 0.0, 0.0, 0.0);
  } else {
    outColor = vec4(max(0.0, texelFetch(uSharp, p, 0).r + 0.8 * acc.r / (acc.g + LAMBDA)), 0.0, 0.0, 0.0);
  }
}`;

const SR_PHASE = `
uniform vec2 uMin;
uniform float uUnit;
uniform float uScale;
uniform vec2 uLattice;  // pitch, rowStep
vec2 phaseAt(vec2 k) {
  float ly = uMin.y + (k.y / uScale) * uUnit;
  float lx = uMin.x + (k.x / uScale) * uUnit;
  float fj = ly / uLattice.y;
  float fi = (lx - fj * uLattice.x * 0.5) / uLattice.x;
  return vec2(fract(fi), fract(fj));
}`;

// Lattice pattern measurement: one point per pixel, added up by blending
// into PHASE_BINS x PHASE_BINS bins of (ratio sum, count) (uPass 0), or
// into one pixel of (standard brightness sum, splatted brightness sum)
// (uPass 1).
const SR_HIST_VERTEX = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uPrep;
uniform sampler2D uSharp;
uniform sampler2D uAcc;
uniform int uWidth;
uniform int uPass;
uniform ivec2 uTiles;  // lattice pattern tiles across, down
uniform vec2 uSize;    // the render's size
${SR_PHASE}
out vec2 vValue;
void main() {
  gl_PointSize = 1.0;
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
  ivec2 p = ivec2(gl_VertexID % uWidth, gl_VertexID / uWidth);
  vec4 prep = texelFetch(uPrep, p, 0);
  float upY = dot(prep.rgb, vec3(0.2126, 0.7152, 0.0722));
  float sharp = texelFetch(uSharp, p, 0).r;
  if (uPass == 1) {
    vValue = vec2(upY, sharp);
    gl_Position = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  if (prep.a < 0.5 || !(texelFetch(uAcc, p, 0).g > 0.0) || !(upY > 1e-4)) return;
  vec2 ph = phaseAt(vec2(p));
  ivec2 bin = min(ivec2(floor(ph * ${PHASE_BINS}.0)), ivec2(${PHASE_BINS} - 1));
  ivec2 tile = min(ivec2(floor(vec2(p) / uSize * vec2(uTiles))), uTiles - 1);
  vValue = vec2(sharp / upY, 1.0);
  gl_Position = vec4((vec2(tile * ${PHASE_BINS} + bin) + 0.5) / vec2(uTiles * ${PHASE_BINS}) * 2.0 - 1.0, 0.0, 1.0);
}`;

const SR_HIST_FRAGMENT = `#version 300 es
precision highp float;
in vec2 vValue;
out vec4 outColor;
void main() {
  outColor = vec4(vValue, 0.0, 0.0);
}`;

// The full resolution picture: the standard render's color with the
// splatted brightness (lattice pattern divided out) where in focus.
// The lattice pattern divided out of the splatted brightness: per tile
// gain tables (core/superres.js latticeTables), bilinear in phase and
// between tile centers.
// Sharpening of the splatted brightness (core/superres.js sharpenLuma), one
// direction per pass: pass 0 blurs across, pass 1 blurs down and sharpens.
const SR_SHARPEN_FS = `#version 300 es
precision highp float;
uniform sampler2D uSharp;
uniform sampler2D uBlur;
uniform float uSigma;
uniform float uAmount;
uniform int uPass;
out vec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 sz = textureSize(uSharp, 0);
  int r = int(ceil(3.0 * uSigma));
  ivec2 d = uPass == 0 ? ivec2(1, 0) : ivec2(0, 1);
  float v = 0.0;
  float ws = 0.0;
  for (int i = -24; i <= 24; i++) {
    if (i < -r || i > r) continue;
    float w = exp(-float(i * i) / (2.0 * uSigma * uSigma));
    ivec2 q = clamp(p + d * i, ivec2(0), sz - 1);
    v += w * (uPass == 0 ? texelFetch(uSharp, q, 0).r : texelFetch(uBlur, q, 0).r);
    ws += w;
  }
  v /= ws;
  if (uPass == 0) { outColor = vec4(v, 0.0, 0.0, 1.0); return; }
  float s = texelFetch(uSharp, p, 0).r;
  outColor = vec4(max(0.0, s + uAmount * (s - v)), 0.0, 0.0, 1.0);
}`;

const SR_DIVIDE = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uSharp;
uniform sampler2D uGain;  // tiles of PHASE_BINS x PHASE_BINS
uniform ivec2 uTiles;
uniform vec2 uSize;
${SR_PHASE}
out vec4 outColor;
float gainAt(ivec2 tile, int b, int a) {
  int n = ${PHASE_BINS};
  return texelFetch(uGain, tile * n + ivec2(((a % n) + n) % n, ((b % n) + n) % n), 0).r;
}
float cell(ivec2 tile, ivec2 i, vec2 t) {
  return mix(mix(gainAt(tile, i.y, i.x), gainAt(tile, i.y, i.x + 1), t.x), mix(gainAt(tile, i.y + 1, i.x), gainAt(tile, i.y + 1, i.x + 1), t.x), t.y);
}
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float sharp = texelFetch(uSharp, p, 0).r;
  vec2 f = phaseAt(vec2(p)) * ${PHASE_BINS}.0 - 0.5;
  ivec2 i = ivec2(floor(f));
  vec2 t = f - vec2(i);
  vec2 ft = clamp(vec2(p) / uSize * vec2(uTiles) - 0.5, vec2(0.0), vec2(uTiles - 1));
  ivec2 t0 = min(ivec2(floor(ft)), uTiles - 1);
  ivec2 t1 = min(t0 + 1, uTiles - 1);
  vec2 w = ft - vec2(t0);
  float g = mix(mix(cell(t0, i, t), cell(ivec2(t1.x, t0.y), i, t), w.x), mix(cell(ivec2(t0.x, t1.y), i, t), cell(t1, i, t), w.x), w.y);
  outColor = vec4(g > 0.0 ? sharp / g : sharp, 0.0, 0.0, 0.0);
}`;

const SR_FINAL = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uPrep;
uniform sampler2D uSharp;
uniform float uMatch;
out vec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 prep = texelFetch(uPrep, p, 0);
  float sharp = texelFetch(uSharp, p, 0).r;
  float upY = dot(prep.rgb, vec3(0.2126, 0.7152, 0.0722));
  float ratio = upY > 1e-6 ? min(4.0, sharp * uMatch / upY) : 1.0;
  float k = prep.a * ratio + (1.0 - prep.a);
  outColor = vec4(prep.rgb * k, 1.0);
}`;

// ---------------------------------------------------------------- depth
// The depth measurement of core/depth.js (estimateDepth) on the GPU: views'
// fine detail, their spread at each trial depth, cost aggregation and the
// best depth per pixel. The finishing steps (filling in, outlier removal)
// stay on the CPU, on one small read back.

const DEPTH_STEPS_MAX = 64;

// Luminance of view `uLayer`.
const DEPTH_LUM = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2DArray;
uniform sampler2DArray uViews;
uniform int uLayer;
out vec4 outColor;
void main() {
  vec3 c = texelFetch(uViews, ivec3(ivec2(gl_FragCoord.xy), uLayer), 0).rgb;
  outColor = vec4(dot(c, vec3(0.2126, 0.7152, 0.0722)), 0.0, 0.0, 0.0);
}`;

// Mean over a (2 uRadius + 1) window along uDir, counting only pixels inside
// the picture (two passes make core/depth.js's boxSum). Boxes rgb; alpha is
// passed through.
const BOX_MEAN = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uSrc;
uniform ivec2 uDir;
uniform int uRadius;
out vec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 size = textureSize(uSrc, 0);
  vec3 s = vec3(0.0);
  float n = 0.0;
  for (int k = -16; k <= 16; k++) {
    if (k < -uRadius || k > uRadius) continue;
    ivec2 q = p + uDir * k;
    if (q.x < 0 || q.y < 0 || q.x >= size.x || q.y >= size.y) continue;
    s += texelFetch(uSrc, q, 0).rgb;
    n += 1.0;
  }
  outColor = vec4(s / n, texelFetch(uSrc, p, 0).a);
}`;

// Fine detail: luminance minus its local mean.
const DEPTH_DETAIL = `#version 300 es
precision highp float;
uniform sampler2D uLum;
uniform sampler2D uLocal;
out vec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  outColor = vec4(texelFetch(uLum, p, 0).r - texelFetch(uLocal, p, 0).r, 0.0, 0.0, 0.0);
}`;

// Spread of the views' detail, shifted for trial depth uAlpha, relative to
// local brightness; with occlusion the best half of the aperture where it
// is clearly better. Output: (cost, guide * cost) for the guided filter.
const DEPTH_VARIANCE = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2DArray;
uniform sampler2DArray uDetail;
uniform sampler2D uLevel;
uniform sampler2D uGuide;
uniform int uCount;
uniform vec4 uView[${MAX_VIEWS}]; // u * detail, v * detail
uniform float uAlpha;
uniform float uFloor;
uniform int uOcclusion;
out vec4 outColor;

float detailAt(ivec2 q, int k) {
  return texelFetch(uDetail, ivec3(q, k), 0).r;
}

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 size = textureSize(uLevel, 0);
  // 0: every view; 1-4: views with u <= 0, u >= 0, v <= 0, v >= 0.
  float s[5];
  float q[5];
  float c[5];
  for (int h = 0; h < 5; h++) {
    s[h] = 0.0;
    q[h] = 0.0;
    c[h] = 0.0;
  }
  for (int k = 0; k < ${MAX_VIEWS}; k++) {
    if (k >= uCount) break;
    vec2 sh = uAlpha * uView[k].xy;
    vec2 fl = floor(sh);
    vec2 a = sh - fl;
    ivec2 b = p + ivec2(fl);
    if (b.x < 0 || b.y < 0 || b.x >= size.x - 1 || b.y >= size.y - 1) continue;
    float v = mix(
      mix(detailAt(b, k), detailAt(b + ivec2(1, 0), k), a.x),
      mix(detailAt(b + ivec2(0, 1), k), detailAt(b + ivec2(1, 1), k), a.x),
      a.y);
    s[0] += v; q[0] += v * v; c[0] += 1.0;
    if (uOcclusion == 1) {
      if (uView[k].x <= 0.0) { s[1] += v; q[1] += v * v; c[1] += 1.0; }
      if (uView[k].x >= 0.0) { s[2] += v; q[2] += v * v; c[2] += 1.0; }
      if (uView[k].y <= 0.0) { s[3] += v; q[3] += v * v; c[3] += 1.0; }
      if (uView[k].y >= 0.0) { s[4] += v; q[4] += v * v; c[4] += 1.0; }
    }
  }
  float level = texelFetch(uLevel, p, 0).r;
  float norm = level * level + uFloor;
  float var[5];
  for (int h = 0; h < 5; h++) {
    float n = c[h] > 0.0 ? c[h] : 1.0;
    float m = s[h] / n;
    var[h] = max(0.0, q[h] / n - m * m) / norm;
  }
  float cost = var[0];
  if (uOcclusion == 1) cost = min(var[0], 1.6 * min(min(var[1], var[2]), min(var[3], var[4])));
  outColor = vec4(cost, texelFetch(uGuide, p, 0).r * cost, 0.0, 0.0);
}`;

// Guided filter coefficients from the boxed (cost, guide * cost); the
// boxed guide statistics (mean, mean square) are in uGuideMeans.
const DEPTH_GUIDED_AB = `#version 300 es
precision highp float;
uniform sampler2D uMeans;
uniform sampler2D uGuideMeans;
uniform float uEps;
out vec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec2 m = texelFetch(uMeans, p, 0).rg;
  vec2 g = texelFetch(uGuideMeans, p, 0).rg;
  float a = (m.y - g.x * m.x) / (g.y - g.x * g.x + uEps);
  outColor = vec4(a, m.x - a * g.x, 0.0, m.x);
}`;

const DEPTH_GUIDED_OUT = `#version 300 es
precision highp float;
uniform sampler2D uAB;
uniform sampler2D uGuide;
out vec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec4 ab = texelFetch(uAB, p, 0);
  outColor = vec4(max(ab.r * texelFetch(uGuide, p, 0).r + ab.g, 0.5 * ab.a), 0.0, 0.0, 0.0);
}`;

// Best trial depth per pixel (with a parabola through its neighbours),
// its cost and the mean cost: (alpha, cost, mean cost).
const DEPTH_BEST = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2DArray;
uniform sampler2DArray uCost;
uniform int uSteps;
uniform float uMin;
uniform float uStep;
out vec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  float best = 0.0;
  int bi = 0;
  float sum = 0.0;
  for (int k = 0; k < ${DEPTH_STEPS_MAX}; k++) {
    if (k >= uSteps) break;
    float c = texelFetch(uCost, ivec3(p, k), 0).r;
    sum += c;
    if (k == 0 || c < best) {
      best = c;
      bi = k;
    }
  }
  float offset = 0.0;
  if (bi > 0 && bi < uSteps - 1) {
    float a = -texelFetch(uCost, ivec3(p, bi - 1), 0).r;
    float b = -best;
    float c = -texelFetch(uCost, ivec3(p, bi + 1), 0).r;
    float d = a - 2.0 * b + c;
    if (d < 0.0) offset = clamp(0.5 * (a - c) / d, -0.5, 0.5);
  }
  outColor = vec4(uMin + (float(bi) + offset) * uStep, best, sum / float(uSteps), 0.0);
}`;

// Edge-aware depth smoothing (core/depth.js smoothDepth), one 5 x 5 pass.
const DEPTH_SMOOTH = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uSrc;   // r: depth
uniform sampler2D uGuide; // r: sqrt luminance, g: confidence
uniform float uKRange;
uniform int uUseConf;
out vec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 size = textureSize(uSrc, 0);
  float gi = texelFetch(uGuide, p, 0).r;
  float sum = 0.0;
  float wsum = 0.0;
  for (int dy = -2; dy <= 2; dy++) {
    for (int dx = -2; dx <= 2; dx++) {
      ivec2 q = p + ivec2(dx, dy);
      if (q.x < 0 || q.y < 0 || q.x >= size.x || q.y >= size.y) continue;
      vec2 g = texelFetch(uGuide, q, 0).rg;
      float d = g.r - gi;
      float w = exp(-0.5 / (1.2 * 1.2) * float(dx * dx + dy * dy) + uKRange * d * d);
      if (uUseConf == 1) w *= 0.15 + g.g;
      sum += texelFetch(uSrc, q, 0).r * w;
      wsum += w;
    }
  }
  outColor = vec4(wsum > 0.0 ? sum / wsum : texelFetch(uSrc, p, 0).r, 0.0, 0.0, 0.0);
}`;

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  return sh;
}

// Starts compiling and linking a program without waiting for it: the
// status is checked the first time the program is used, so the driver can
// compile every program at once (KHR_parallel_shader_compile) while the
// photo opens.
function program(gl, fragment, vertex = VERTEX) {
  const p = gl.createProgram();
  const vs = compile(gl, gl.VERTEX_SHADER, vertex);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fragment);
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.bindAttribLocation(p, 0, 'aPos');
  gl.linkProgram(p);
  let uniforms = null;
  const ready = () => {
    if (uniforms) return;
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      for (const sh of [vs, fs]) {
        if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(`Shader compile failed: ${gl.getShaderInfoLog(sh)}`);
      }
      throw new Error(`Shader link failed: ${gl.getProgramInfoLog(p)}`);
    }
    uniforms = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i);
      const name = info.name.replace(/\[0\]$/, '');
      uniforms[name] = gl.getUniformLocation(p, info.name);
    }
  };
  return {
    get p() {
      ready();
      return p;
    },
    get u() {
      ready();
      return uniforms;
    },
  };
}

function latticeOrigins(cfa) {
  const out = [[], [], []];
  for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) out[cfa[y][x]].push([x, y]);
  return out;
}

export class GpuRenderer {
  // Returns a renderer, or null when WebGL2 with float render targets is not
  // available (or the sensor image is larger than the GPU's textures).
  static create(cam) {
    if (typeof OffscreenCanvas === 'undefined') return null;
    try {
      const canvas = new OffscreenCanvas(1, 1);
      // Ask for the faster GPU on computers that have two (laptops).
      const gl = canvas.getContext('webgl2', { antialias: false, depth: false, stencil: false, premultipliedAlpha: false, powerPreference: 'high-performance' });
      if (!gl || !gl.getExtension('EXT_color_buffer_float')) return null;
      const max = gl.getParameter(gl.MAX_TEXTURE_SIZE);
      if (cam.width > max || cam.height > max) return null;
      return new GpuRenderer(gl);
    } catch {
      return null;
    }
  }

  constructor(gl) {
    this.gl = gl;
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    this.name = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
    gl.getExtension('KHR_parallel_shader_compile');
    this.programs = {
      lens: program(gl, LENS_PASS),
      box: program(gl, BOX_PASS),
      copy: program(gl, COPY_PASS),
      depthLum: program(gl, DEPTH_LUM),
      boxMean: program(gl, BOX_MEAN),
      depthDetail: program(gl, DEPTH_DETAIL),
      depthVariance: program(gl, DEPTH_VARIANCE),
      depthGuidedAB: program(gl, DEPTH_GUIDED_AB),
      depthGuidedOut: program(gl, DEPTH_GUIDED_OUT),
      depthBest: program(gl, DEPTH_BEST),
      depthSmooth: program(gl, DEPTH_SMOOTH),
      bright: program(gl, BRIGHTNESS_PASS),
      view: program(gl, VIEW_PASS),
      refocus: program(gl, REFOCUS_PASS),
      chroma: program(gl, CHROMA_PASS),
      dofPrep: program(gl, DOF_PREP),
      dofGather: program(gl, DOF_GATHER),
      dofTiles: program(gl, DOF_TILES),
      merge: program(gl, MERGE_PASS),
      detailNr: program(gl, DETAIL_NR),
      detailSpeckle: program(gl, DETAIL_SPECKLE),
      detailMorph: program(gl, DETAIL_MORPH),
      detailDust: program(gl, DETAIL_DUST),
      detailSharpen: program(gl, DETAIL_SHARPEN),
      present: program(gl, PRESENT),
      localSpatial: program(gl, LOCAL_SPATIAL),
      splat: program(gl, SPLAT_FRAGMENT, SPLAT_VERTEX),
      srPrep: program(gl, SR_PREP),
      srCombine: program(gl, SR_COMBINE),
      srHist: program(gl, SR_HIST_FRAGMENT, SR_HIST_VERTEX),
      srFinal: program(gl, SR_FINAL),
      srDivide: program(gl, SR_DIVIDE),
      srSharpen: program(gl, SR_SHARPEN_FS),
    };
    // Additive blending into 32-bit floats needs EXT_float_blend; otherwise
    // accumulate in half floats (enough for these sums).
    this.floatBlend = !!gl.getExtension('EXT_float_blend');
    this.emptyVao = gl.createVertexArray();
    this.canvas = gl.canvas;
    this.pool = new Map();
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.fbo = gl.createFramebuffer();
    this.views = null;
    // GPU timing (EXT_disjoint_timer_query_webgl2), where the browser offers
    // it: queries waiting for their result, and the last result in ms.
    this.timer = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    this.timings = [];
    this.lastGpuMs = null;
  }

  // Measures the GPU time of the work between beginTiming() and
  // endTiming(); the result arrives a few frames later (gpuMs()).
  beginTiming() {
    if (!this.timer || this.timing) return;
    this.timing = this.gl.createQuery();
    this.gl.beginQuery(this.timer.TIME_ELAPSED_EXT, this.timing);
  }

  endTiming() {
    if (!this.timing) return;
    this.gl.endQuery(this.timer.TIME_ELAPSED_EXT);
    this.timings.push(this.timing);
    this.timing = null;
  }

  // The most recent finished measurement in ms, or null.
  gpuMs() {
    const gl = this.gl;
    if (!this.timer) return null;
    const disjoint = gl.getParameter(this.timer.GPU_DISJOINT_EXT);
    while (this.timings.length && gl.getQueryParameter(this.timings[0], gl.QUERY_RESULT_AVAILABLE)) {
      const q = this.timings.shift();
      if (!disjoint) this.lastGpuMs = gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6;
      gl.deleteQuery(q);
    }
    return this.lastGpuMs;
  }

  // Made on a texture unit no shader reads, so making a texture never
  // replaces one bound for drawing (units 0-4).
  texture(w, h, internal = this.gl.RGBA32F, filter = this.gl.NEAREST) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + SPARE_UNIT);
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texStorage2D(gl.TEXTURE_2D, 1, internal, w, h);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  // Uploads the raw sensor image (once per photo).
  setRaw(raw, cam, dev) {
    const gl = this.gl;
    if (this.rawTex) gl.deleteTexture(this.rawTex);
    this.rawTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.rawTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 2);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R16UI, cam.width, cam.height);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, cam.width, cam.height, gl.RED_INTEGER, gl.UNSIGNED_SHORT, raw);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    this.cam = cam;
    this.dev = dev;
  }

  // Lens grid and output geometry (once per grid or detail change).
  // gainAt(u, v) -> [r, g, b]: vignetting correction for aperture offset (u, v).
  setSampler(sampler, gainAt) {
    const gl = this.gl;
    for (const t of [this.lensTex, this.sumTex, this.tmpTex, this.brightTex, this.outTex]) if (t) gl.deleteTexture(t);
    this.deleteViews();
    this.sampler = sampler;
    this.gainAt = gainAt;
    const { lenses, outW, outH } = sampler;
    this.lensW = lenses.cols;
    this.lensH = lenses.rows;
    this.lensTex = this.texture(this.lensW, this.lensH);
    this.tmpTex = this.texture(this.lensW, this.lensH);
    this.sumTex = this.texture(this.lensW, this.lensH);
    this.brightTex = this.texture(this.lensW, this.lensH);
    this.outTex = this.texture(outW, outH);
    this.readBuf = new Float32Array(outW * outH * 4);
  }

  target(tex, w, h, layer) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    if (layer === undefined) gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    else gl.framebufferTextureLayer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, tex, 0, layer);
    gl.viewport(0, 0, w, h);
  }

  draw() {
    this.gl.bindVertexArray(this.vao);
    this.gl.drawArrays(this.gl.TRIANGLES, 0, 3);
  }

  bindTex(unit, tex, kind = this.gl.TEXTURE_2D) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(kind, tex);
  }

  setRawUniforms(prog, u, v) {
    const gl = this.gl;
    const { cam, dev, sampler } = this;
    const g = sampler.grid;
    const U = prog.u;
    gl.uniform1i(U.uRaw, 0);
    this.bindTex(0, this.rawTex);
    gl.uniform2i(U.uRawSize, cam.width, cam.height);
    gl.uniform3fv(U.uBlack, dev.black);
    gl.uniform3fv(U.uScale, dev.scale);
    gl.uniform1f(U.uClip, dev.clip);
    if (U.uSaturated) gl.uniform3fv(U.uSaturated, dev.saturated);
    gl.uniform3fv(U.uGain, this.gainAt(u, v));
    const [rO, gO, bO] = latticeOrigins(dev.cfa);
    gl.uniform2i(U.uOrigR, rO[0][0], rO[0][1]);
    gl.uniform2i(U.uOrigG1, gO[0][0], gO[0][1]);
    gl.uniform2i(U.uOrigG2, gO[1][0], gO[1][1]);
    gl.uniform2i(U.uOrigB, bO[0][0], bO[0][1]);
    if (U.uCfa) gl.uniform1iv(U.uCfa, [dev.cfa[0][0], dev.cfa[0][1], dev.cfa[1][0], dev.cfa[1][1]]);
    const cos = Math.cos(g.rotation);
    const sin = Math.sin(g.rotation);
    gl.uniform4f(U.uGrid, g.pitch, g.rowStep, cos, sin);
    gl.uniform2f(U.uOrigin, g.ox, g.oy);
    gl.uniform2i(U.uLens0, sampler.lenses.c0, sampler.lenses.r0);
    gl.uniform2f(U.uUV, cos * u - sin * v, sin * u + cos * v);
  }

  // Renders view (u, v) into `tex` (or layer `layer` of the view array).
  renderViewTo(u, v, tex, layer) {
    const gl = this.gl;
    const { lensW, lensH, sampler } = this;
    const P = this.programs;

    this.target(this.lensTex, lensW, lensH);
    gl.useProgram(P.lens.p);
    this.setRawUniforms(P.lens, u, v);
    this.draw();

    gl.useProgram(P.box.p);
    gl.uniform1i(P.box.u.uSrc, 1);
    gl.uniform2i(P.box.u.uSize, lensW, lensH);
    gl.uniform1i(P.box.u.uRadius, 3);
    this.target(this.tmpTex, lensW, lensH);
    this.bindTex(1, this.lensTex);
    gl.uniform2i(P.box.u.uDir, 1, 0);
    this.draw();
    this.target(this.sumTex, lensW, lensH);
    this.bindTex(1, this.tmpTex);
    gl.uniform2i(P.box.u.uDir, 0, 1);
    this.draw();

    this.target(this.brightTex, lensW, lensH);
    gl.useProgram(P.bright.p);
    this.setRawUniforms(P.bright, u, v);
    gl.uniform1i(P.bright.u.uSum, 1);
    this.bindTex(1, this.sumTex);
    gl.uniform1f(P.bright.u.uInv2s2, 1 / (2 * 0.9 * 0.9));
    this.draw();

    // Edge-aware color into tmpTex (free again after the box passes).
    this.target(this.tmpTex, lensW, lensH);
    gl.useProgram(P.chroma.p);
    gl.uniform1i(P.chroma.u.uLens, 1);
    this.bindTex(1, this.lensTex);
    gl.uniform1i(P.chroma.u.uBright, 2);
    this.bindTex(2, this.brightTex);
    gl.uniform2i(P.chroma.u.uSize, lensW, lensH);
    gl.uniform1i(P.chroma.u.uRadius, 3);
    gl.uniform1f(P.chroma.u.uSigma, CHROMA_EDGE);
    this.draw();

    this.target(tex, sampler.outW, sampler.outH, layer);
    gl.useProgram(P.view.p);
    gl.uniform1i(P.view.u.uLens, 1);
    this.bindTex(1, this.tmpTex);
    gl.uniform2i(P.view.u.uLensSize, lensW, lensH);
    gl.uniform2i(P.view.u.uLens0, sampler.lenses.c0, sampler.lenses.r0);
    gl.uniform4f(P.view.u.uGrid, sampler.grid.pitch, sampler.grid.rowStep, 0, 0);
    gl.uniform2f(P.view.u.uMin, sampler.xMin, sampler.yMin);
    gl.uniform1f(P.view.u.uSpacing, sampler.spacing);
    gl.uniform1f(P.view.u.uKernel, sampler.kernel * sampler.grid.pitch);
    gl.uniform1i(P.view.u.uTrust, layer === undefined ? 0 : 1);
    this.draw();
  }

  readTarget() {
    const gl = this.gl;
    const { outW, outH } = this.sampler;
    gl.readPixels(0, 0, outW, outH, gl.RGBA, gl.FLOAT, this.readBuf);
    const rgb = new Float32Array(outW * outH * 3);
    for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) {
      rgb[i] = this.readBuf[j];
      rgb[i + 1] = this.readBuf[j + 1];
      rgb[i + 2] = this.readBuf[j + 2];
    }
    return rgb;
  }

  // One sub-aperture view as linear RGB.
  renderView(u, v) {
    this.renderViewTo(u, v, this.outTex);
    return this.readTarget();
  }

  deleteViews() {
    if (this.views) this.gl.deleteTexture(this.views.tex);
    if (this.ring) this.gl.deleteTexture(this.ring.tex);
    this.views = null;
    this.ring = null;
  }

  // Renders the views used for refocusing into a texture array. Returns a
  // function reading layer k back as linear RGB (for CPU-side depth work).
  // `ring`: highlight views from the outer ring of each lens image (darker
  // through vignetting, so they clip later), kept apart from the views used
  // for depth and denoising; refocusing takes highlights from them.
  buildViews(samples, detail, ring = []) {
    const gl = this.gl;
    this.deleteViews();
    const { outW, outH } = this.sampler;
    const array = (n) => {
      const t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, t);
      gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA16F, outW, outH, n);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    };
    const tex = array(Math.min(samples.length, MAX_VIEWS));
    this.views = { tex, samples: samples.slice(0, MAX_VIEWS), detail };
    this.views.samples.forEach(({ u, v }, k) => this.renderViewTo(u, v, tex, k));
    if (ring.length) {
      this.ring = { tex: array(Math.min(ring.length, MAX_RING)), samples: ring.slice(0, MAX_RING) };
      this.ring.samples.forEach(({ u, v }, k) => this.renderViewTo(u, v, this.ring.tex, k));
    }
    return (k) => {
      this.target(tex, outW, outH, k);
      return this.readTarget();
    };
  }

  // The views' pixels in a rectangle (for measuring focus at a point), as
  // views for core/depth.js: [{ u, v, rgb, gain, detail }].
  readViewsRect(x0, y0, w, h) {
    const gl = this.gl;
    const { outW, outH } = this.sampler;
    const { tex, samples, detail } = this.views;
    const buf = new Float32Array(w * h * 4);
    return samples.map(({ u, v }, k) => {
      this.target(tex, outW, outH, k);
      gl.readPixels(x0, y0, w, h, gl.RGBA, gl.FLOAT, buf);
      const rgb = new Float32Array(w * h * 3);
      for (let i = 0; i < w * h; i++) {
        rgb[3 * i] = buf[4 * i];
        rgb[3 * i + 1] = buf[4 * i + 1];
        rgb[3 * i + 2] = buf[4 * i + 2];
      }
      return { u, v, rgb, gain: 1, detail };
    });
  }

  // Refocused picture at `alpha` through an aperture centered on (u0, v0)
  // with Gaussian radius `sigma` (Infinity = the whole aperture).
  refocus(alpha, opts) {
    this.refocusTo(alpha, opts);
    return this.readTarget();
  }

  // As refocus(), leaving the result in the view-size output texture.
  refocusTo(alpha, { u0 = 0, v0 = 0, sigma = Infinity } = {}) {
    const gl = this.gl;
    const { outW, outH } = this.sampler;
    const { tex, samples, detail } = this.views;
    const data = new Float32Array(MAX_VIEWS * 4);
    samples.forEach(({ u, v }, k) => {
      const du = u - u0;
      const dv = v - v0;
      data[4 * k] = alpha * du * detail;
      data[4 * k + 1] = alpha * dv * detail;
      data[4 * k + 2] = Number.isFinite(sigma) ? Math.exp(-(du * du + dv * dv) / (2 * sigma * sigma)) : 1;
    });
    const P = this.programs.refocus;
    this.target(this.outTex, outW, outH);
    gl.useProgram(P.p);
    gl.uniform1i(P.u.uViews, 2);
    this.bindTex(2, tex, gl.TEXTURE_2D_ARRAY);
    gl.uniform1i(P.u.uCount, samples.length);
    gl.uniform4fv(P.u.uView, data);
    gl.uniform2f(P.u.uSize, outW, outH);
    const ring = this.ring;
    gl.uniform1i(P.u.uRingCount, ring ? ring.samples.length : 0);
    gl.uniform1i(P.u.uRing, 3);
    if (ring) {
      this.bindTex(3, ring.tex, gl.TEXTURE_2D_ARRAY);
      const shifts = new Float32Array(MAX_RING * 2);
      ring.samples.forEach(({ u, v }, k) => {
        shifts[2 * k] = alpha * (u - u0) * detail;
        shifts[2 * k + 1] = alpha * (v - v0) * detail;
      });
      gl.uniform2fv(P.u.uRingView, shifts);
      gl.uniform1f(P.u.uClip, this.dev.clip);
    } else {
      // A sampler array must still be bound to an array texture.
      this.bindTex(3, tex, gl.TEXTURE_2D_ARRAY);
    }
    this.draw();
    return this.outTex;
  }

  // Multi-view denoised view at (u0, v0): needs buildViews() and setDepth().
  // Returns a view-size texture.
  mergedViewTex(u0, v0, { sigma, blend }) {
    const gl = this.gl;
    const { outW, outH } = this.sampler;
    const { tex, samples, detail } = this.views;
    const ref = this.renderViewTex(u0, v0);
    const out = this.scratch(outW, outH, 'merged');
    const data = new Float32Array(MAX_VIEWS * 4);
    samples.forEach(({ u, v }, k) => {
      data[4 * k] = (u - u0) * detail;
      data[4 * k + 1] = (v - v0) * detail;
    });
    const P = this.programs.merge;
    this.target(out, outW, outH);
    gl.useProgram(P.p);
    gl.uniform1i(P.u.uViews, 2);
    this.bindTex(2, tex, gl.TEXTURE_2D_ARRAY);
    gl.uniform1i(P.u.uRef, 1);
    this.bindTex(1, ref);
    gl.uniform1i(P.u.uDepth, 3);
    this.bindTex(3, this.depthTex);
    gl.uniform1i(P.u.uCount, samples.length);
    gl.uniform4fv(P.u.uView, data);
    gl.uniform2f(P.u.uCenter, u0 * detail, v0 * detail);
    gl.uniform2f(P.u.uSize, outW, outH);
    gl.uniform1f(P.u.uSigma, sigma);
    gl.uniform1f(P.u.uBlend, blend);
    this.draw();
    return out;
  }

  // As renderView(), leaving the result in the view-size output texture.
  renderViewTex(u, v) {
    this.renderViewTo(u, v, this.outTex);
    return this.outTex;
  }

  // A copy of `src` that later renders leave alone (full float, so drawing
  // from it gives the same picture as drawing from `src`).
  keep(src, w, h) {
    const gl = this.gl;
    const key = `${w}x${h}:kept`;
    let t = this.pool.get(key);
    if (!t) {
      t = this.texture(w, h);
      this.pool.set(key, t);
    }
    const P = this.programs.copy;
    this.target(t, w, h);
    gl.useProgram(P.p);
    gl.uniform1i(P.u.uSrc, 1);
    this.bindTex(1, src);
    this.draw();
    return t;
  }

  // Scratch textures by size, reused between frames.
  scratch(w, h, name) {
    const key = `${w}x${h}:${name}`;
    let t = this.pool.get(key);
    if (!t) {
      // Half floats: plenty for display, and half the memory at full
      // resolution.
      t = this.texture(w, h, this.gl.RGBA16F);
      this.pool.set(key, t);
    }
    return t;
  }

  // Scratch texture with a full mip chain (for blurs that read averages).
  mipmapped(w, h, name) {
    const key = `${w}x${h}:${name}:mip`;
    let t = this.pool.get(key);
    if (!t) {
      const gl = this.gl;
      t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texStorage2D(gl.TEXTURE_2D, Math.floor(Math.log2(Math.max(w, h))) + 1, gl.RGBA16F, w, h);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.pool.set(key, t);
    }
    return t;
  }

  // Linear RGB from the CPU (e.g. a full resolution render) as a texture.
  uploadRGB(rgb, w, h) {
    const gl = this.gl;
    const rgba = new Float32Array(w * h * 4);
    for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) {
      rgba[j] = rgb[i];
      rgba[j + 1] = rgb[i + 1];
      rgba[j + 2] = rgb[i + 2];
      rgba[j + 3] = 1;
    }
    const t = this.scratch(w, h, 'upload');
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.FLOAT, rgba);
    return t;
  }

  // Per-pixel focus values (view size) for depth of field.
  // The LUT for present (core/lut.js), or null: a 3D texture, red along x.
  setLut(lut) {
    const gl = this.gl;
    if (this.lutTex) gl.deleteTexture(this.lutTex);
    this.lutTex = null;
    this.lut = lut;
    if (!lut) return;
    const n = lut.size;
    const rgba = new Float32Array(n * n * n * 4);
    for (let i = 0; i < n * n * n; i++) rgba.set([lut.data[3 * i], lut.data[3 * i + 1], lut.data[3 * i + 2], 1], 4 * i);
    gl.activeTexture(gl.TEXTURE0 + SPARE_UNIT);
    this.lutTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_3D, this.lutTex);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA16F, n, n, n, 0, gl.RGBA, gl.FLOAT, rgba);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    for (const w of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R]) gl.texParameteri(gl.TEXTURE_3D, w, gl.CLAMP_TO_EDGE);
  }

  setDepth(alpha, w, h) {
    const gl = this.gl;
    if (this.depthTex) gl.deleteTexture(this.depthTex);
    this.depthTex = this.texture(w, h, gl.R32F);
    gl.bindTexture(gl.TEXTURE_2D, this.depthTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RED, gl.FLOAT, alpha);
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = 0; i < alpha.length; i++) {
      if (alpha[i] < lo) lo = alpha[i];
      if (alpha[i] > hi) hi = alpha[i];
    }
    this.depthRange = [lo, hi];
    this.depthSize = [w, h];
  }

  // Float texture array (one channel) for depth work, reused by size.
  layers(w, h, n, name) {
    const key = `${w}x${h}x${n}:${name}:layers`;
    let t = this.pool.get(key);
    if (!t) {
      const gl = this.gl;
      gl.activeTexture(gl.TEXTURE0 + SPARE_UNIT);
      t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, t);
      gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.R32F, w, h, n);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      this.pool.set(key, t);
    }
    return t;
  }

  // Full float scratch texture (depth work needs the precision).
  scratch32(w, h, name) {
    const key = `${w}x${h}:${name}:32`;
    let t = this.pool.get(key);
    if (!t) {
      t = this.texture(w, h);
      this.pool.set(key, t);
    }
    return t;
  }

  // Frees the depth work textures (they are large; depth is measured once
  // per photo and detail setting).
  releaseDepthWork() {
    for (const [key, t] of this.pool) {
      if (key.includes(':depth')) {
        this.gl.deleteTexture(t);
        this.pool.delete(key);
      }
    }
  }

  // Box mean of radius r (see BOX_MEAN) from `src` into `dst` (or a layer).
  boxMean(src, w, h, r, dst, layer) {
    const gl = this.gl;
    const P = this.programs.boxMean;
    const tmp = this.scratch32(w, h, 'depthBoxTmp');
    gl.useProgram(P.p);
    gl.uniform1i(P.u.uSrc, 1);
    gl.uniform1i(P.u.uRadius, r);
    this.target(tmp, w, h);
    this.bindTex(1, src);
    gl.uniform2i(P.u.uDir, 1, 0);
    this.draw();
    this.target(dst, w, h, layer);
    this.bindTex(1, tmp);
    gl.uniform2i(P.u.uDir, 0, 1);
    this.draw();
  }

  // Uploads w x h values (1 to 4 per pixel) as a full float texture.
  uploadFloat(values, w, h, name, perPixel = 1) {
    const gl = this.gl;
    const rgba = new Float32Array(w * h * 4);
    for (let i = 0; i < w * h; i++) for (let c = 0; c < perPixel; c++) rgba[4 * i + c] = values[perPixel * i + c];
    const t = this.scratch32(w, h, name);
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.FLOAT, rgba);
    return t;
  }

  // Reads channels of a full float texture back: [Float32Array] per channel.
  readChannels(tex, w, h, count) {
    const gl = this.gl;
    this.target(tex, w, h);
    const buf = new Float32Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, buf);
    const out = Array.from({ length: count }, () => new Float32Array(w * h));
    for (let i = 0; i < w * h; i++) for (let c = 0; c < count; c++) out[c][i] = buf[4 * i + c];
    return out;
  }

  // The depth measurement of core/depth.js on the views from buildViews():
  // returns { alpha, cost, meanCost } for finishDepth(). `guide` (0..1 per
  // pixel) and `floor` come from the center view (depthGuide,
  // brightnessFloor).
  measureDepth({ min, max, steps, window, detail: detailRadius = 4, occlusion, guided, floor, guide }) {
    const gl = this.gl;
    const P = this.programs;
    const { outW: w, outH: h } = this.sampler;
    const { tex: views, samples, detail } = this.views;
    const count = samples.length;
    steps = Math.min(steps, DEPTH_STEPS_MAX);

    // Each view's fine detail, and the center view's local brightness.
    const detailTex = this.layers(w, h, count, 'depthDetail');
    const lum = this.scratch32(w, h, 'depthLum');
    const local = this.scratch32(w, h, 'depthLocal');
    const level = this.scratch32(w, h, 'depthLevel');
    const mid = Math.floor(count / 2);
    for (let k = 0; k < count; k++) {
      this.target(lum, w, h);
      gl.useProgram(P.depthLum.p);
      gl.uniform1i(P.depthLum.u.uViews, 2);
      this.bindTex(2, views, gl.TEXTURE_2D_ARRAY);
      gl.uniform1i(P.depthLum.u.uLayer, k);
      this.draw();
      this.boxMean(lum, w, h, detailRadius, k === mid ? level : local);
      this.target(detailTex, w, h, k);
      gl.useProgram(P.depthDetail.p);
      gl.uniform1i(P.depthDetail.u.uLum, 1);
      this.bindTex(1, lum);
      gl.uniform1i(P.depthDetail.u.uLocal, 3);
      this.bindTex(3, k === mid ? level : local);
      this.draw();
    }

    // Guide and its local statistics for the guided filter.
    const r = window + 1;
    const guideTex = this.uploadFloat(guide, w, h, 'depthGuide');
    let guideMeans = null;
    if (guided) {
      const g2 = new Float32Array(w * h * 2);
      for (let i = 0; i < w * h; i++) {
        g2[2 * i] = guide[i];
        g2[2 * i + 1] = guide[i] * guide[i];
      }
      guideMeans = this.scratch32(w, h, 'depthGuideMeans');
      this.boxMean(this.uploadFloat(g2, w, h, 'depthGuide2', 2), w, h, r, guideMeans);
    }

    const shifts = new Float32Array(MAX_VIEWS * 4);
    samples.forEach(({ u, v }, k) => {
      shifts[4 * k] = u * detail;
      shifts[4 * k + 1] = v * detail;
    });
    const costTex = this.layers(w, h, steps, 'depthCost');
    const variance = this.scratch32(w, h, 'depthVariance');
    const means = this.scratch32(w, h, 'depthMeans');
    const ab = this.scratch32(w, h, 'depthAB');
    const abMeans = this.scratch32(w, h, 'depthABMeans');
    for (let k = 0; k < steps; k++) {
      const alpha = min + ((max - min) * k) / (steps - 1);
      let Q = P.depthVariance;
      this.target(variance, w, h);
      gl.useProgram(Q.p);
      gl.uniform1i(Q.u.uDetail, 2);
      this.bindTex(2, detailTex, gl.TEXTURE_2D_ARRAY);
      gl.uniform1i(Q.u.uLevel, 1);
      this.bindTex(1, level);
      gl.uniform1i(Q.u.uGuide, 3);
      this.bindTex(3, guideTex);
      gl.uniform1i(Q.u.uCount, count);
      gl.uniform4fv(Q.u.uView, shifts);
      gl.uniform1f(Q.u.uAlpha, alpha);
      gl.uniform1f(Q.u.uFloor, floor);
      gl.uniform1i(Q.u.uOcclusion, occlusion ? 1 : 0);
      this.draw();
      if (!guided) {
        this.boxMean(variance, w, h, window, costTex, k);
        continue;
      }
      this.boxMean(variance, w, h, r, means);
      Q = P.depthGuidedAB;
      this.target(ab, w, h);
      gl.useProgram(Q.p);
      gl.uniform1i(Q.u.uMeans, 1);
      this.bindTex(1, means);
      gl.uniform1i(Q.u.uGuideMeans, 3);
      this.bindTex(3, guideMeans);
      gl.uniform1f(Q.u.uEps, 1e-3);
      this.draw();
      this.boxMean(ab, w, h, r, abMeans);
      Q = P.depthGuidedOut;
      this.target(costTex, w, h, k);
      gl.useProgram(Q.p);
      gl.uniform1i(Q.u.uAB, 1);
      this.bindTex(1, abMeans);
      gl.uniform1i(Q.u.uGuide, 3);
      this.bindTex(3, guideTex);
      this.draw();
    }

    const best = this.scratch32(w, h, 'depthBest');
    const Q = P.depthBest;
    this.target(best, w, h);
    gl.useProgram(Q.p);
    gl.uniform1i(Q.u.uCost, 2);
    this.bindTex(2, costTex, gl.TEXTURE_2D_ARRAY);
    gl.uniform1i(Q.u.uSteps, steps);
    gl.uniform1f(Q.u.uMin, min);
    gl.uniform1f(Q.u.uStep, (max - min) / (steps - 1));
    this.draw();
    const [alpha, cost, meanCost] = this.readChannels(best, w, h, 3);
    this.releaseDepthWork();
    return { alpha, cost, meanCost };
  }

  // Edge-aware depth smoothing (core/depth.js smoothDepth) on the GPU.
  // `guide`: linear RGB (w x h); returns a new Float32Array.
  smoothDepth(alpha, w, h, guide, { amount = 0.3, confidence = null } = {}) {
    const passes = Math.round(amount * 8);
    if (passes <= 0) return alpha;
    const gl = this.gl;
    const g = new Float32Array(w * h * 2);
    let mean = 0;
    for (let i = 0; i < w * h; i++) {
      const y = Math.sqrt(Math.max(0, 0.2126 * guide[3 * i] + 0.7152 * guide[3 * i + 1] + 0.0722 * guide[3 * i + 2]));
      g[2 * i] = y;
      g[2 * i + 1] = confidence ? confidence[i] : 0;
      mean += y;
    }
    mean = Math.max(1e-6, mean / (w * h));
    const guideTex = this.uploadFloat(g, w, h, 'depthSmoothGuide', 2);
    let src = this.uploadFloat(alpha, w, h, 'depthSmoothA');
    let dst = this.scratch32(w, h, 'depthSmoothB');
    const P = this.programs.depthSmooth;
    gl.useProgram(P.p);
    gl.uniform1i(P.u.uSrc, 1);
    gl.uniform1i(P.u.uGuide, 3);
    gl.uniform1f(P.u.uKRange, -0.5 / (0.08 * mean) ** 2);
    gl.uniform1i(P.u.uUseConf, confidence ? 1 : 0);
    for (let pass = 0; pass < passes; pass++) {
      this.target(dst, w, h);
      this.bindTex(1, src);
      this.bindTex(3, guideTex);
      this.draw();
      [src, dst] = [dst, src];
    }
    const [out] = this.readChannels(src, w, h, 1);
    this.releaseDepthWork();
    return out;
  }

  // Synthetic depth of field with bokeh. `strength`: blur radius in pixels
  // of this image per unit of focus difference. Returns the result texture.
  // `draft`: quicker, for previews while dragging: more of the blur at half
  // size and fewer taps.
  depthOfField(src, w, h, { focus, strength, shape = 'smooth', blades = 6, oval = 0, rotation = 0, onion = 0, highlights = 0, clip = 1, tilt = [0, 0], point = [0.5, 0.5], spread = 0, smooth = 0, blur = 0, draft = false }) {
    const gl = this.gl;
    const prep = this.mipmapped(w, h, 'dofPrep');
    const out = this.scratch(w, h, 'dofOut');
    let P = this.programs.dofPrep;
    this.target(prep, w, h);
    gl.useProgram(P.p);
    gl.uniform1i(P.u.uSrc, 1);
    this.bindTex(1, src);
    gl.uniform1i(P.u.uDepth, 3);
    this.bindTex(3, this.depthTex);
    gl.uniform2f(P.u.uDepthScale, this.depthSize[0] / w, this.depthSize[1] / h);
    gl.uniform1f(P.u.uFocus, focus);
    gl.uniform2f(P.u.uTilt, tilt[0], tilt[1]);
    gl.uniform2f(P.u.uPoint, point[0], point[1]);
    gl.uniform1f(P.u.uSpread, spread);
    gl.uniform1f(P.u.uSmooth, smooth);
    gl.uniform1f(P.u.uStrength, strength);
    gl.uniform1f(P.u.uBlur, blur);
    gl.uniform1f(P.u.uClip, clip);
    gl.uniform1f(P.u.uHighlights, highlights);
    this.draw();

    gl.bindTexture(gl.TEXTURE_2D, prep);
    gl.generateMipmap(gl.TEXTURE_2D);

    const [lo, hi] = this.depthRange;
    const reach = Math.abs(tilt[0]) + Math.abs(tilt[1]);
    const maxR = Math.min(64, strength * Math.max(0, Math.max(Math.abs(hi - focus), Math.abs(lo - focus)) + reach - spread) + blur);
    const taps = Math.max(32, Math.min(draft ? 160 : MAX_TAPS, Math.round(maxR * maxR * 1.2)));
    const kernel = bokehKernel({ shape, blades, oval, rotation, onion });
    const shapeId = kernel.kind;
    // How far past its own radius a blur still adds light (the smooth shape
    // fades out gradually).
    const blurReach = shapeId === 0 ? 1.5 : 1.05;

    // Largest blur within reach of each tile.
    const tw = Math.ceil(w / DOF_TILE);
    const th = Math.ceil(h / DOF_TILE);
    const tiles = this.scratch32(tw, th, 'dofTiles');
    const tilesTmp = this.scratch32(tw, th, 'dofTilesTmp');
    P = this.programs.dofTiles;
    gl.useProgram(P.p);
    gl.uniform1i(P.u.uSrc, 1);
    gl.uniform1i(P.u.uPass, 0);
    this.target(tiles, tw, th);
    this.bindTex(1, prep);
    this.draw();
    gl.uniform1i(P.u.uPass, 1);
    gl.uniform1i(P.u.uRadius, Math.min(16, Math.ceil((maxR * blurReach + 1) / DOF_TILE)));
    this.target(tilesTmp, tw, th);
    this.bindTex(1, tiles);
    gl.uniform2i(P.u.uDir, 1, 0);
    this.draw();
    this.target(tiles, tw, th);
    this.bindTex(1, tilesTmp);
    gl.uniform2i(P.u.uDir, 0, 1);
    this.draw();

    P = this.programs.dofGather;
    gl.useProgram(P.p);
    gl.uniform1i(P.u.uPrep, 1);
    this.bindTex(1, prep);
    gl.uniform1i(P.u.uTiles, 3);
    this.bindTex(3, tiles);
    gl.uniform1i(P.u.uTaps, taps);
    gl.uniform1f(P.u.uMaxR, Math.max(1, maxR));
    gl.uniform1f(P.u.uReach, blurReach);
    gl.uniform1i(P.u.uShape, shapeId);
    gl.uniform1i(P.u.uBlades, kernel.blades);
    gl.uniform1f(P.u.uAspect, kernel.aspect);
    gl.uniform2f(P.u.uRot, kernel.cos, kernel.sin);
    gl.uniform1f(P.u.uOnion, kernel.onion);
    // Strong blur: render the strongly blurred pixels at half size.
    const halfFrom = draft ? 1.5 : 6;
    const half = maxR > 2 * halfFrom ? this.scratch(Math.ceil(w / 2), Math.ceil(h / 2), 'dofHalf') : null;
    gl.uniform1i(P.u.uHalf, 2);
    if (half) {
      this.target(half, Math.ceil(w / 2), Math.ceil(h / 2));
      gl.uniform1i(P.u.uPass, 1);
      this.bindTex(2, prep);
      this.draw();
      this.bindTex(2, half);
    } else {
      this.bindTex(2, tiles);
    }
    gl.uniform1i(P.u.uPass, half ? 2 : 0);
    gl.uniform1f(P.u.uHalfFrom, halfFrom);
    this.target(out, w, h);
    this.draw();
    return out;
  }

  // Details panel (see core/detail.js): returns a new texture.
  details(src, w, h, p) {
    const gl = this.gl;
    if (p.speckle > 0 || p.dust > 0) src = this.spots(src, w, h, p);
    if (!(p.amount > 0 || p.luminance > 0 || p.color > 0)) return src;
    const mid = this.scratch(w, h, 'detailMid');
    const out = this.scratch(w, h, 'detailOut');
    let P = this.programs.detailNr;
    this.target(mid, w, h);
    gl.useProgram(P.p);
    gl.uniform1i(P.u.uSrc, 1);
    this.bindTex(1, src);
    gl.uniform1f(P.u.uRangeSigma, p.luminance > 0 ? rangeSigma(p) : 0);
    gl.uniform1f(P.u.uChromaSigma, p.color > 0 ? chromaSigma(p) : 0);
    this.draw();
    P = this.programs.detailSharpen;
    this.target(out, w, h);
    gl.useProgram(P.p);
    gl.uniform1i(P.u.uSrc, 1);
    this.bindTex(1, mid);
    gl.uniform1f(P.u.uAmount, p.amount);
    gl.uniform1f(P.u.uRadius, p.radius);
    gl.uniform1i(P.u.uWindow, sharpenWindow(p));
    gl.uniform1f(P.u.uDetail, p.detail);
    gl.uniform1f(P.u.uHalo, HALO_LIMIT);
    gl.uniform1f(P.u.uMasking, p.masking || 0);
    this.draw();
    return out;
  }

  // Spot removal (core/detail.js removeSpeckles, removeDust): returns a
  // new texture.
  spots(src, w, h, p) {
    const gl = this.gl;
    let P = this.programs.detailSpeckle;
    const clean = this.scratch(w, h, 'spotClean');
    this.target(clean, w, h);
    gl.useProgram(P.p);
    gl.uniform1i(P.u.uSrc, 1);
    this.bindTex(1, src);
    gl.uniform1f(P.u.uThreshold, p.speckle > 0 ? speckleThreshold(p) : 0);
    gl.uniform1i(P.u.uSize, p.speckleSize);
    this.draw();
    if (!(p.dust > 0)) return clean;
    P = this.programs.detailMorph;
    gl.useProgram(P.p);
    gl.uniform1i(P.u.uSrc, 1);
    const a = this.scratch(w, h, 'spotA');
    const blur = this.scratch(w, h, 'spotBlur');
    const b = this.scratch(w, h, 'spotB');
    const r = dustRadius(p);
    const run = (from, to, dir, radius, mode, chan) => {
      this.target(to, w, h);
      this.bindTex(1, from);
      gl.uniform2i(P.u.uDir, dir[0], dir[1]);
      gl.uniform1i(P.u.uRadius, radius);
      gl.uniform1i(P.u.uMode, mode);
      gl.uniform1i(P.u.uChan, chan);
      this.draw();
    };
    run(clean, a, [1, 0], 2, 2, 3);
    run(a, blur, [0, 1], 2, 2, 0);
    run(blur, a, [1, 0], r, 0, 0);
    run(a, b, [0, 1], r, 0, 0);
    run(b, a, [1, 0], r, 1, 0);
    run(a, b, [0, 1], r, 1, 0);
    P = this.programs.detailDust;
    const out = this.scratch(w, h, 'spotOut');
    this.target(out, w, h);
    gl.useProgram(P.p);
    gl.uniform1i(P.u.uSrc, 1);
    gl.uniform1i(P.u.uBlur, 2);
    gl.uniform1i(P.u.uClosed, 3);
    this.bindTex(1, clean);
    this.bindTex(2, blur);
    this.bindTex(3, b);
    this.draw();
    return out;
  }

  // What the splat reads: the standard render (upsampled colors, linear
  // filtering) and the vignetting table. New textures, for the caller to
  // delete.
  splatInputs(p) {
    const gl = this.gl;
    const base = this.texture(p.baseW, p.baseH, gl.RGBA16F, gl.LINEAR);
    const rgba = new Float32Array(p.baseW * p.baseH * 4);
    for (let i = 0, j = 0; i < p.base.length; i += 3, j += 4) {
      rgba[j] = p.base[i];
      rgba[j + 1] = p.base[i + 1];
      rgba[j + 2] = p.base[i + 2];
      rgba[j + 3] = 1;
    }
    gl.bindTexture(gl.TEXTURE_2D, base);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, p.baseW, p.baseH, gl.RGBA, gl.FLOAT, rgba);
    const vg = p.vignetting;
    const vig = this.texture(vg.bins, vg.bins, gl.RGBA32F);
    const vigData = new Float32Array(vg.bins * vg.bins * 4);
    for (let i = 0; i < vg.bins * vg.bins; i++) {
      vigData[4 * i] = vg.gain[3 * i];
      vigData[4 * i + 1] = vg.gain[3 * i + 1];
      vigData[4 * i + 2] = vg.gain[3 * i + 2];
    }
    gl.bindTexture(gl.TEXTURE_2D, vig);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, vg.bins, vg.bins, gl.RGBA, gl.FLOAT, vigData);
    return { base, vig };
  }

  // One splat of every raw pixel into a new W x H texture (r: brightness
  // sum, g: weight); with `estimate` (a linearly filtered texture of the
  // current result) the residuals instead.
  splatInto(p, { base, vig, estimate = null }) {
    const gl = this.gl;
    const { cam, dev, sampler } = this;
    const g = sampler.grid;
    const { W, H } = p;
    const vg = p.vignetting;
    const acc = this.texture(W, H, this.floatBlend ? gl.RGBA32F : gl.RGBA16F);
    this.target(acc, W, H);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    const P = this.programs.splat;
    const U = P.u;
    gl.useProgram(P.p);
    gl.uniform1i(U.uRaw, 0);
    this.bindTex(0, this.rawTex);
    gl.uniform2i(U.uRawSize, cam.width, cam.height);
    gl.uniform3fv(U.uBlack, dev.black);
    gl.uniform3fv(U.uScale, dev.scale);
    gl.uniform3fv(U.uSaturated, dev.saturated);
    gl.uniform1iv(U.uCfa, [dev.cfa[0][0], dev.cfa[0][1], dev.cfa[1][0], dev.cfa[1][1]]);
    gl.uniform4f(U.uGrid, g.pitch, g.rowStep, Math.cos(g.rotation), Math.sin(g.rotation));
    gl.uniform2f(U.uOrigin, g.ox, g.oy);
    gl.uniform1f(U.uRUse, p.rUse);
    gl.uniform2f(U.uUV0, p.u0, p.v0);
    gl.uniform1f(U.uInv2a2, Number.isFinite(p.apertureSigma) ? 1 / (2 * p.apertureSigma * p.apertureSigma) : 0);
    gl.uniform1i(U.uVig, 1);
    this.bindTex(1, vig);
    gl.uniform1f(U.uVigRMax, vg.rMax);
    gl.uniform1i(U.uVigBins, vg.bins);
    gl.uniform1i(U.uBase, 2);
    this.bindTex(2, base);
    gl.uniform2f(U.uBaseSize, p.baseW, p.baseH);
    gl.uniform1i(U.uDepth, 3);
    this.bindTex(3, this.depthTex);
    gl.uniform1i(U.uAllInFocus, p.allInFocus && p.depth ? 1 : 0);
    gl.uniform1f(U.uAlpha, p.alpha);
    gl.uniform2f(U.uMin, p.xMin, p.yMin);
    gl.uniform1f(U.uUnit, p.unit);
    gl.uniform1f(U.uDetail, p.detail);
    gl.uniform1f(U.uOutScale, p.scale);
    gl.uniform2i(U.uOutSize, W, H);
    gl.uniform1i(U.uReach, p.reach);
    gl.uniform1f(U.uInv2s2, 1 / (2 * p.sigma * p.sigma));
    gl.uniform1i(U.uResidual, estimate ? 1 : 0);
    gl.uniform1i(U.uEstimate, 4);
    this.bindTex(4, estimate || base);
    gl.bindVertexArray(this.emptyVao);
    // In chunks, so no single draw runs long enough to trip a GPU watchdog.
    const total = cam.width * cam.height;
    const chunk = 1 << 22;
    for (let start = 0; start < total; start += chunk) {
      gl.uniform1i(U.uStart, start);
      gl.drawArrays(gl.POINTS, 0, Math.min(chunk, total - start));
    }
    gl.disable(gl.BLEND);
    return acc;
  }

  // Full resolution accumulation (see renderSuperRes' gpuSplat option):
  // returns { accY, wsum } as Float32Arrays of W * H.
  splat(p) {
    const gl = this.gl;
    const { W, H } = p;
    const { base, vig } = this.splatInputs(p);
    // Back-projection pass: the current result, sampled at each raw pixel's
    // position (half floats filter linearly everywhere). Made before the
    // texture units are bound: creating a texture binds it to the active
    // unit, which would replace the depth map.
    let estimate = null;
    if (p.estimate) {
      estimate = this.texture(W, H, gl.R16F, gl.LINEAR);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, W, H, gl.RED, gl.FLOAT, p.estimate);
    }
    const acc = this.splatInto(p, { base, vig, estimate });
    const [accY, wsum] = this.readChannels(acc, W, H, 2);
    for (const t of [acc, base, vig, estimate]) if (t) gl.deleteTexture(t);
    return { accY, wsum };
  }

  // The whole full resolution render of core/superres.js on the GPU, from
  // superResParams() plus renderSuperRes' options (alpha, allInFocus, u0, v0,
  // apertureSigma, vignetting, base, baseW, baseH, depthTolerance, passes).
  // Needs float blending (for the lattice pattern measurement); returns a
  // W x H texture, or null without it.
  superRes(p) {
    if (!this.floatBlend) return null;
    const gl = this.gl;
    const P = this.programs;
    const { W, H } = p;
    const inputs = this.splatInputs(p);
    const owned = [inputs.base, inputs.vig];

    // Upsampled colors and the detail weight.
    const prep = this.texture(W, H);
    owned.push(prep);
    let Q = P.srPrep;
    this.target(prep, W, H);
    gl.useProgram(Q.p);
    gl.uniform1i(Q.u.uBase, 2);
    this.bindTex(2, inputs.base);
    gl.uniform2f(Q.u.uBaseSize, p.baseW, p.baseH);
    gl.uniform1i(Q.u.uDepth, 3);
    this.bindTex(3, this.depthTex);
    gl.uniform1f(Q.u.uDetail, p.detail);
    gl.uniform1f(Q.u.uScale, p.scale);
    gl.uniform1i(Q.u.uAllInFocus, p.allInFocus ? 1 : 0);
    gl.uniform1f(Q.u.uAlpha, p.alpha);
    gl.uniform1f(Q.u.uTolerance, p.depthTolerance ?? 0.12);
    gl.uniform1f(Q.u.uSpread, p.spreadRadius);
    this.draw();

    // Splat, normalize, then back-projection passes.
    const acc = this.splatInto(p, inputs);
    owned.push(acc);
    let sharp = this.texture(W, H, gl.R32F);
    let next = this.texture(W, H, gl.R32F);
    const estimate = p.passes > 0 ? this.texture(W, H, gl.R16F, gl.LINEAR) : null;
    owned.push(sharp, next, estimate);
    const combine = (accTex, pass) => {
      Q = P.srCombine;
      this.target(next, W, H);
      gl.useProgram(Q.p);
      gl.uniform1i(Q.u.uAcc, 1);
      this.bindTex(1, accTex);
      gl.uniform1i(Q.u.uPrep, 2);
      this.bindTex(2, prep);
      gl.uniform1i(Q.u.uSharp, 3);
      this.bindTex(3, sharp);
      gl.uniform1i(Q.u.uPass, pass);
      this.draw();
      [sharp, next] = [next, sharp];
    };
    const g = this.sampler.grid;
    const { tx, ty } = latticeTiles(W, H, { g, unit: p.unit, scale: p.scale });
    const hist = this.texture(tx * PHASE_BINS, ty * PHASE_BINS);
    const sums = this.texture(1, 1);
    owned.push(hist, sums);
    // Point passes over every pixel, added up by blending: pass 0 into the
    // lattice tiles' phase bins, pass 1 into the brightness sums.
    const histogram = (tex, w, h, pass) => {
      Q = P.srHist;
      gl.useProgram(Q.p);
      gl.uniform1i(Q.u.uPrep, 1);
      this.bindTex(1, prep);
      gl.uniform1i(Q.u.uSharp, 2);
      this.bindTex(2, sharp);
      gl.uniform1i(Q.u.uAcc, 3);
      this.bindTex(3, acc);
      gl.uniform1i(Q.u.uWidth, W);
      gl.uniform2i(Q.u.uTiles, tx, ty);
      gl.uniform2f(Q.u.uSize, W, H);
      gl.uniform2f(Q.u.uMin, p.xMin, p.yMin);
      gl.uniform1f(Q.u.uUnit, p.unit);
      gl.uniform1f(Q.u.uScale, p.scale);
      gl.uniform2f(Q.u.uLattice, g.pitch, g.rowStep);
      gl.bindVertexArray(this.emptyVao);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      this.target(tex, w, h);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform1i(Q.u.uPass, pass);
      gl.drawArrays(gl.POINTS, 0, W * H);
      gl.disable(gl.BLEND);
    };
    // Lattice pattern (core/superres.js removeLatticePattern): measured per
    // tile and divided out of the splatted brightness.
    const removePattern = () => {
      histogram(hist, tx * PHASE_BINS, ty * PHASE_BINS, 0);
      const [binSum, binCount] = this.readChannels(hist, tx * PHASE_BINS, ty * PHASE_BINS, 2);
      // Texture rows of tiles -> one table per tile.
      const nn = PHASE_BINS * PHASE_BINS;
      const sum = new Float64Array(tx * ty * nn);
      const cnt = new Float64Array(tx * ty * nn);
      const rowW = tx * PHASE_BINS;
      for (let y = 0; y < ty * PHASE_BINS; y++) {
        for (let x = 0; x < rowW; x++) {
          const t = Math.floor(y / PHASE_BINS) * tx + Math.floor(x / PHASE_BINS);
          const i = t * nn + (y % PHASE_BINS) * PHASE_BINS + (x % PHASE_BINS);
          sum[i] = binSum[y * rowW + x];
          cnt[i] = binCount[y * rowW + x];
        }
      }
      const tables = latticeTables(sum, cnt, tx, ty);
      if (!tables) return;
      const flat = new Float32Array(tx * ty * nn);
      for (let t = 0; t < tx * ty; t++) {
        for (let i = 0; i < nn; i++) {
          const x = (t % tx) * PHASE_BINS + (i % PHASE_BINS);
          const y = Math.floor(t / tx) * PHASE_BINS + Math.floor(i / PHASE_BINS);
          flat[y * rowW + x] = tables.gain[t * nn + i];
        }
      }
      const gainTex = this.uploadFloat(flat, rowW, ty * PHASE_BINS, 'srGain');
      Q = P.srDivide;
      this.target(next, W, H);
      gl.useProgram(Q.p);
      gl.uniform1i(Q.u.uSharp, 1);
      this.bindTex(1, sharp);
      gl.uniform1i(Q.u.uGain, 2);
      this.bindTex(2, gainTex);
      gl.uniform2i(Q.u.uTiles, tx, ty);
      gl.uniform2f(Q.u.uSize, W, H);
      gl.uniform2f(Q.u.uMin, p.xMin, p.yMin);
      gl.uniform1f(Q.u.uUnit, p.unit);
      gl.uniform1f(Q.u.uScale, p.scale);
      gl.uniform2f(Q.u.uLattice, g.pitch, g.rowStep);
      this.draw();
      [sharp, next] = [next, sharp];
    };

    combine(acc, 0);
    for (let pass = 0; pass < (p.passes || 0); pass++) {
      // Divided out before each pass too, or the passes build it up.
      removePattern();
      // The splat samples the current result with linear filtering: half
      // floats filter everywhere.
      Q = P.copy;
      this.target(estimate, W, H);
      gl.useProgram(Q.p);
      gl.uniform1i(Q.u.uSrc, 1);
      this.bindTex(1, sharp);
      this.draw();
      const residual = this.splatInto(p, { ...inputs, estimate });
      combine(residual, 1);
      gl.deleteTexture(residual);
    }
    removePattern();
    {
      // Final sharpening (core/superres.js sharpenLuma).
      const blur = this.texture(W, H, gl.R32F);
      owned.push(blur);
      Q = P.srSharpen;
      gl.useProgram(Q.p);
      gl.uniform1f(Q.u.uSigma, SR_SHARPEN.radius * p.scale);
      gl.uniform1f(Q.u.uAmount, SR_SHARPEN.amount);
      gl.uniform1i(Q.u.uSharp, 1);
      this.bindTex(1, sharp);
      gl.uniform1i(Q.u.uBlur, 2);
      this.target(blur, W, H);
      gl.uniform1i(Q.u.uPass, 0);
      this.draw();
      this.target(next, W, H);
      this.bindTex(2, blur);
      gl.uniform1i(Q.u.uPass, 1);
      this.draw();
      [sharp, next] = [next, sharp];
    }
    histogram(sums, 1, 1, 1);
    const [[sumUp], [sumSharp]] = this.readChannels(sums, 1, 1, 2);

    const out = this.scratch(W, H, 'superres');
    Q = P.srFinal;
    this.target(out, W, H);
    gl.useProgram(Q.p);
    gl.uniform1i(Q.u.uPrep, 1);
    this.bindTex(1, prep);
    gl.uniform1i(Q.u.uSharp, 2);
    this.bindTex(2, sharp);
    gl.uniform1f(Q.u.uMatch, sumSharp > 0 ? sumUp / sumSharp : 1);
    this.draw();
    for (const t of owned) if (t) gl.deleteTexture(t);
    return out;
  }

  // Color matrix, defringing, exposure and sRGB, drawn to the canvas and
  // handed over as an ImageBitmap. fringe: defringe settings
  // { on, radius, threshold, colors: [[amount, hue] x 4] }.
  // Flare veil (core/flare.js) for present, or null.
  setVeil(veil) {
    const gl = this.gl;
    if (this.veilTex) gl.deleteTexture(this.veilTex);
    this.veilTex = null;
    if (!veil) return;
    const { tilesX: w, tilesY: h, data } = veil;
    this.veilTex = this.texture(w, h, gl.RGBA16F, gl.LINEAR);
    const rgba = new Float32Array(w * h * 4);
    for (let i = 0; i < w * h; i++) rgba.set([data[3 * i], data[3 * i + 1], data[3 * i + 2], 1], 4 * i);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.FLOAT, rgba);
  }

  // Blur, pixelate and sketch of local adjustments (`local` from
  // packMasks): returns a new texture.
  localSpatial(src, w, h, local) {
    const gl = this.gl;
    const out = this.scratch(w, h, 'localSpatial');
    const P = this.programs.localSpatial;
    this.target(out, w, h);
    gl.useProgram(P.p);
    gl.uniform1i(P.u.uSrc, 1);
    this.bindTex(1, src);
    gl.uniform1i(P.u.uMaskCount, local.count);
    gl.uniform1iv(P.u.uMaskKind, local.kinds);
    gl.uniform4fv(P.u.uMaskShape, local.shape);
    gl.uniform4fv(P.u.uMaskExtra, local.extra);
    gl.uniform4fv(P.u.uMaskFx2, local.fx2);
    gl.uniform1i(P.u.uDepthOn, this.depthTex ? 1 : 0);
    gl.uniform1i(P.u.uDepth, 3);
    this.bindTex(3, this.depthTex || src);
    this.draw();
    return out;
  }

  present(src, w, h, { matrix, exposure, fringe, look = null, veilAmount = 0, lens = null, local = null, lutAmount = 0, lytro = false }) {
    const gl = this.gl;
    const P = this.programs.present;
    // Resizing reallocates the canvas: only when the size changes.
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.useProgram(P.p);
    gl.uniform1i(P.u.uSrc, 1);
    this.bindTex(1, src);
    gl.uniformMatrix3fv(P.u.uMatrix, true, matrix);
    gl.uniform1f(P.u.uExposure, exposure);
    const veil = veilAmount > 0 && this.veilTex;
    gl.uniform1f(P.u.uVeilAmount, veil ? veilAmount : 0);
    gl.uniform1i(P.u.uMaskCount, local ? local.count : 0);
    if (local) {
      gl.uniform1iv(P.u.uMaskKind, local.kinds);
      gl.uniform4fv(P.u.uMaskShape, local.shape);
      gl.uniform4fv(P.u.uMaskExtra, local.extra);
      gl.uniform4fv(P.u.uMaskFx, local.fx);
      gl.uniform4fv(P.u.uMaskFx2, local.fx2);
      gl.uniform1i(P.u.uMaskShow, local.show);
    }
    gl.uniform1i(P.u.uDepthOn, local && this.depthTex ? 1 : 0);
    gl.uniform1i(P.u.uDepth, 3);
    this.bindTex(3, this.depthTex || src);
    gl.uniform4f(P.u.uLens, lens ? lens.k : 0, lens ? lens.zoom : 1, lens ? lens.vig : 0, lens ? lens.start : 0);
    gl.uniform1i(P.u.uVeil, 2);
    this.bindTex(2, veil ? this.veilTex : src);
    const f = (fringe && fringe.colors) || [];
    const on = !!(fringe && fringe.on) && f.some(([amount]) => amount > 0);
    gl.uniform1i(P.u.uFringeOn, on ? 1 : 0);
    gl.uniform1i(P.u.uFringeRadius, Math.max(1, Math.min(6, Math.round((fringe && fringe.radius) || 2))));
    gl.uniform1f(P.u.uFringeThreshold, (fringe && fringe.threshold) ?? 0.25);
    gl.uniform2fv(P.u.uFringe, Float32Array.from([0, 1, 2, 3].flatMap((i) => (f[i] ? [f[i][0], f[i][1]] : [0, 0]))));
    // The LUT sampler always points at its own unit: an unused 3D sampler
    // left on unit 0 would clash with the 2D texture there.
    const lutOn = !!this.lutTex && lutAmount > 0;
    gl.uniform1i(P.u.uLut, 4);
    if (lutOn) this.bindTex(4, this.lutTex, gl.TEXTURE_3D);
    gl.uniform1f(P.u.uLutAmount, lutOn ? Math.min(1, lutAmount) : 0);
    gl.uniform3fv(P.u.uLutMin, this.lut ? this.lut.min : [0, 0, 0]);
    gl.uniform3fv(P.u.uLutMax, this.lut ? this.lut.max : [1, 1, 1]);
    gl.uniform1i(P.u.uLytro, lytro ? 1 : 0);
    if (lytro) {
      gl.uniform1fv(P.u.uLytroCurve, LYTRO_CURVE);
      gl.uniform1f(P.u.uLytroSat, lytro.saturation ?? 1);
      gl.uniform2fv(P.u.uLytroHue, LYTRO_HUE.flat());
    }
    gl.uniform1i(P.u.uLookOn, look ? 1 : 0);
    if (look) {
      gl.uniform4f(P.u.uTone, look.contrast, look.highlights, look.shadows, look.whites);
      gl.uniform2f(P.u.uTone2, look.blacks, look.vibrance);
      gl.uniform1fv(P.u.uHues, Float32Array.from(look.hues));
      gl.uniform1i(P.u.uCurveOn, look.curve ? 1 : 0);
      if (look.curve) gl.uniform1fv(P.u.uCurve, look.curve);
    }
    this.draw();
    return this.canvas.transferToImageBitmap();
  }
}
