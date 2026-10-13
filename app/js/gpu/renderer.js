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

import { rangeSigma, chromaSigma, sharpenWindow, HALO_LIMIT } from '../core/detail.js';

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
  for (int dy = -2; dy <= 2; dy++) {
    for (int dx = -2; dx <= 2; dx++) {
      ivec2 q = p0 + ivec2(dx, dy);
      if (q.x < 0 || q.y < 0 || q.x >= uRawSize.x || q.y >= uRawSize.y) continue;
      vec2 e = vec2(q) - p;
      float w = exp(-dot(e, e) * uInv2s2);
      int ch = uCfa[(q.y & 1) * 2 + (q.x & 1)];
      acc += w * develop(rawAt(q), ch) * toY[ch];
      wsum += w;
    }
  }
  float lum = wsum > 0.0 ? min(uClip * max(uGain.r, max(uGain.g, uGain.b)), acc / wsum) : S.a;
  outColor = vec4(lum * frac, 1.0);
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
out vec4 outColor;
void main() {
  vec2 l = uMin + (gl_FragCoord.xy - 0.5) * uSpacing;
  float pitch = uGrid.x;
  float rowStep = uGrid.y;
  float r2 = uKernel * uKernel;
  int ra = int(floor(l.y / rowStep));
  vec3 sum = vec3(0.0);
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
      sum += texelFetch(uLens, t, 0).rgb * w;
      wsum += w;
    }
  }
  outColor = vec4(wsum > 0.0 ? sum / wsum : vec3(0.0), 1.0);
}`;

const MAX_VIEWS = 64;

const REFOCUS_PASS = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2DArray;
uniform sampler2DArray uViews;
uniform int uCount;
uniform vec4 uView[${MAX_VIEWS}]; // shift x, shift y (output pixels), weight
uniform vec2 uSize;
out vec4 outColor;
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
    sum += texture(uViews, vec3((s + 0.5) / uSize, float(k))).rgb * v.z;
    wsum += v.z;
  }
  outColor = vec4(wsum > 0.0 ? sum / wsum : vec3(0.0), 1.0);
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
  d = sign(d) * e;
  float y = dot(c, vec3(0.2126, 0.7152, 0.0722));
  float knee = 0.8 * uClip;
  float t = clamp((y - knee) / (uClip - knee), 0.0, 1.0);
  // Up to 128x at full strength: real highlights (the sun, lamps) are far
  // brighter than the image can store, and their bokeh should glow.
  c *= 1.0 + (exp2(7.0 * uHighlights) - 1.0) * t * t;
  // Signed radius: positive behind the focus plane, negative in front.
  outColor = vec4(c, uStrength * d);
}`;

const MAX_TAPS = 512;

// Depth of field, step 2: each pixel gathers light from neighbors whose own
// blur reaches it, inside the aperture shape. Bright out-of-focus points thus
// spread into discs or hexagons (bokeh). Points behind this pixel only reach
// it within its own blur, so blurred background does not bleed over sharp
// foreground edges.
const DOF_GATHER = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uPrep;
uniform int uTaps;
uniform float uMaxR;
uniform int uShape;   // 0 smooth, 1 circle, 2 hexagon
uniform float uLod;   // mip level matching the spacing between taps
out vec4 outColor;

float shapeDist(vec2 o) {
  if (uShape == 2) {
    vec2 a = abs(o);
    // Pointy-top regular hexagon with circumradius 1.
    return max(a.x * 1.1547005, a.x * 0.5773503 + a.y);
  }
  return length(o);
}

float weightFor(float dist, float r) {
  r = max(r, 0.5);
  float inside = uShape == 0
    ? exp(-2.0 * (dist / r) * (dist / r))
    : clamp(r + 0.5 - dist, 0.0, 1.0);
  return inside / (r * r);
}

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 size = textureSize(uPrep, 0);
  vec4 c = texelFetch(uPrep, p, 0);
  float rc = abs(c.a);
  vec3 sum = c.rgb * weightFor(0.0, rc);
  float wsum = weightFor(0.0, rc);
  for (int i = 0; i < ${MAX_TAPS}; i++) {
    if (i >= uTaps) break;
    float rr = sqrt((float(i) + 0.5) / float(uTaps)) * uMaxR;
    float th = float(i) * 2.39996323;
    vec2 o = rr * vec2(cos(th), sin(th));
    // Each tap stands for the area between taps: read the pre-averaged
    // (mipmapped) image at that scale, so large blurs are smooth, not grainy.
    vec2 qf = clamp(vec2(p) + o, vec2(0.0), vec2(size - 1));
    vec4 s = textureLod(uPrep, (qf + 0.5) / vec2(size), uLod);
    float rq = abs(s.a);
    float dist = shapeDist(o);
    // Behind this pixel: only within this pixel's own blur.
    if (s.a > c.a + 0.5 && dist > rc + 0.5) continue;
    float w = weightFor(dist, rq);
    sum += s.rgb * w;
    wsum += w;
  }
  outColor = vec4(sum / max(wsum, 1e-9), 1.0);
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
uniform int uFringeOn;
uniform int uFringeRadius;
uniform float uFringeThreshold;
uniform int uLookOn;
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

float srgb(float v) {
  v = clamp(v, 0.0, 1.0);
  return v <= 0.0031308 ? 12.92 * v : 1.055 * pow(v, 1.0 / 2.4) - 0.055;
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
  if (uLookOn == 1) c = applyLook(c);
  outColor = vec4(srgb(c.r), srgb(c.g), srgb(c.b), 1.0);
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

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(`Shader compile failed: ${gl.getShaderInfoLog(sh)}`);
  return sh;
}

function program(gl, fragment, vertex = VERTEX) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vertex));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fragment));
  gl.bindAttribLocation(p, 0, 'aPos');
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`Shader link failed: ${gl.getProgramInfoLog(p)}`);
  const uniforms = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; i++) {
    const info = gl.getActiveUniform(p, i);
    const name = info.name.replace(/\[0\]$/, '');
    uniforms[name] = gl.getUniformLocation(p, info.name);
  }
  return { p, u: uniforms };
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
      const gl = canvas.getContext('webgl2', { antialias: false, depth: false, stencil: false, premultipliedAlpha: false });
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
    this.programs = {
      lens: program(gl, LENS_PASS),
      box: program(gl, BOX_PASS),
      bright: program(gl, BRIGHTNESS_PASS),
      view: program(gl, VIEW_PASS),
      refocus: program(gl, REFOCUS_PASS),
      dofPrep: program(gl, DOF_PREP),
      dofGather: program(gl, DOF_GATHER),
      merge: program(gl, MERGE_PASS),
      detailNr: program(gl, DETAIL_NR),
      detailSharpen: program(gl, DETAIL_SHARPEN),
      present: program(gl, PRESENT),
      splat: program(gl, SPLAT_FRAGMENT, SPLAT_VERTEX),
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

    this.target(tex, sampler.outW, sampler.outH, layer);
    gl.useProgram(P.view.p);
    gl.uniform1i(P.view.u.uLens, 1);
    this.bindTex(1, this.brightTex);
    gl.uniform2i(P.view.u.uLensSize, lensW, lensH);
    gl.uniform2i(P.view.u.uLens0, sampler.lenses.c0, sampler.lenses.r0);
    gl.uniform4f(P.view.u.uGrid, sampler.grid.pitch, sampler.grid.rowStep, 0, 0);
    gl.uniform2f(P.view.u.uMin, sampler.xMin, sampler.yMin);
    gl.uniform1f(P.view.u.uSpacing, sampler.spacing);
    gl.uniform1f(P.view.u.uKernel, sampler.kernel * sampler.grid.pitch);
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
    this.views = null;
  }

  // Renders the views used for refocusing into a texture array. Returns a
  // function reading layer k back as linear RGB (for CPU-side depth work).
  buildViews(samples, detail) {
    const gl = this.gl;
    this.deleteViews();
    const { outW, outH } = this.sampler;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA16F, outW, outH, Math.min(samples.length, MAX_VIEWS));
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.views = { tex, samples: samples.slice(0, MAX_VIEWS), detail };
    this.views.samples.forEach(({ u, v }, k) => this.renderViewTo(u, v, tex, k));
    return (k) => {
      this.target(tex, outW, outH, k);
      return this.readTarget();
    };
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

  // Synthetic depth of field with bokeh. `strength`: blur radius in pixels
  // of this image per unit of focus difference. Returns the result texture.
  depthOfField(src, w, h, { focus, strength, shape = 'smooth', highlights = 0, clip = 1, tilt = [0, 0], point = [0.5, 0.5], spread = 0, smooth = 0 }) {
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
    gl.uniform1f(P.u.uClip, clip);
    gl.uniform1f(P.u.uHighlights, highlights);
    this.draw();

    gl.bindTexture(gl.TEXTURE_2D, prep);
    gl.generateMipmap(gl.TEXTURE_2D);

    const [lo, hi] = this.depthRange;
    const reach = Math.abs(tilt[0]) + Math.abs(tilt[1]);
    const maxR = Math.min(64, strength * Math.max(0, Math.max(Math.abs(hi - focus), Math.abs(lo - focus)) + reach - spread));
    const taps = Math.max(32, Math.min(MAX_TAPS, Math.round(maxR * maxR * 1.2)));
    P = this.programs.dofGather;
    this.target(out, w, h);
    gl.useProgram(P.p);
    gl.uniform1i(P.u.uPrep, 1);
    this.bindTex(1, prep);
    gl.uniform1i(P.u.uTaps, taps);
    gl.uniform1f(P.u.uMaxR, Math.max(1, maxR));
    gl.uniform1f(P.u.uLod, Math.max(0, Math.log2(Math.max(1, maxR) * Math.sqrt(Math.PI / taps)) + 0.5));
    gl.uniform1i(P.u.uShape, shape === 'hexagon' ? 2 : shape === 'circle' ? 1 : 0);
    this.draw();
    return out;
  }

  // Details panel (see core/detail.js): returns a new texture.
  details(src, w, h, p) {
    const gl = this.gl;
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

  // Full resolution accumulation (see renderSuperRes' gpuSplat option):
  // returns { accY, wsum } as Float32Arrays of W * H.
  splat(p) {
    const gl = this.gl;
    const { cam, dev, sampler } = this;
    const g = sampler.grid;
    const { W, H } = p;
    const acc = this.texture(W, H, this.floatBlend ? gl.RGBA32F : gl.RGBA16F);
    // Standard render (upsampled colors) with linear filtering.
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

    // Back-projection pass: the current result, sampled at each raw pixel's
    // position (half floats filter linearly everywhere). Made before the
    // texture units are bound below: creating a texture binds it to the
    // active unit, which would replace the depth map.
    let estimate = null;
    if (p.estimate) {
      estimate = this.texture(W, H, gl.R16F, gl.LINEAR);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, W, H, gl.RED, gl.FLOAT, p.estimate);
    }

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
    gl.useProgram(P.p);
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

    const buf = new Float32Array(W * H * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.FLOAT, buf);
    const accY = new Float32Array(W * H);
    const wsum = new Float32Array(W * H);
    for (let i = 0; i < W * H; i++) {
      accY[i] = buf[4 * i];
      wsum[i] = buf[4 * i + 1];
    }
    for (const t of [acc, base, vig, estimate]) if (t) gl.deleteTexture(t);
    return { accY, wsum };
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

  present(src, w, h, { matrix, exposure, fringe, look = null, veilAmount = 0, lens = null }) {
    const gl = this.gl;
    const P = this.programs.present;
    this.canvas.width = w;
    this.canvas.height = h;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.useProgram(P.p);
    gl.uniform1i(P.u.uSrc, 1);
    this.bindTex(1, src);
    gl.uniformMatrix3fv(P.u.uMatrix, true, matrix);
    gl.uniform1f(P.u.uExposure, exposure);
    const veil = veilAmount > 0 && this.veilTex;
    gl.uniform1f(P.u.uVeilAmount, veil ? veilAmount : 0);
    gl.uniform4f(P.u.uLens, lens ? lens.k : 0, lens ? lens.zoom : 1, lens ? lens.vig : 0, lens ? lens.start : 0);
    gl.uniform1i(P.u.uVeil, 2);
    this.bindTex(2, veil ? this.veilTex : src);
    const f = (fringe && fringe.colors) || [];
    const on = !!(fringe && fringe.on) && f.some(([amount]) => amount > 0);
    gl.uniform1i(P.u.uFringeOn, on ? 1 : 0);
    gl.uniform1i(P.u.uFringeRadius, Math.max(1, Math.min(6, Math.round((fringe && fringe.radius) || 2))));
    gl.uniform1f(P.u.uFringeThreshold, (fringe && fringe.threshold) ?? 0.25);
    gl.uniform2fv(P.u.uFringe, Float32Array.from([0, 1, 2, 3].flatMap((i) => (f[i] ? [f[i][0], f[i][1]] : [0, 0]))));
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
