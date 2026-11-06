// Upscaling for export on the GPU (WebGL2): the same Lanczos-3 / bilinear
// filter and unsharp mask as core/upscale.js, and FSR 1 (EASU + RCAS) as
// core/fsr.js, a few milliseconds a frame instead of seconds. Falls back to
// core/upscale.js without WebGL2.
//
// The FSR 1 shaders are ported from AMD FidelityFX Super Resolution 1.0,
// Copyright (c) 2021 Advanced Micro Devices, Inc., under the MIT license;
// the full notice is in core/fsr.js.

import { upscale as upscaleCpu } from '../core/upscale.js';
import { rcasStrength } from '../core/fsr.js';
import { fitsMemory, enlargeVram } from '../core/memorybudget.js';

const VERTEX = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

// One axis of the resampling filter (uAxis 0: rows, 1: columns).
const RESAMPLE = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform int uAxis;
uniform int uLanczos;
uniform float uLobes;
uniform float uRatio;
out vec4 outColor;
const float PI = 3.14159265;
float sinc(float x) { return x == 0.0 ? 1.0 : sin(PI * x) / (PI * x); }
// 16-bit export (upscaleBits16): the final pass run twice, writing the high and then the low byte of round(65535 * value) into 8-bit channels.
uniform int uBytePass;
vec4 packOut(vec4 c) {
  if (uBytePass == 0) return c;
  vec3 v = floor(clamp(c.rgb, 0.0, 1.0) * 65535.0 + 0.5);
  vec3 hi = floor(v / 256.0);
  return vec4((uBytePass == 1 ? hi : v - hi * 256.0) / 255.0, 1.0);
}

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 size = textureSize(uSrc, 0);
  int n = uAxis == 0 ? size.x : size.y;
  float pos = (float(uAxis == 0 ? p.x : p.y) + 0.5) * uRatio - 0.5;
  // Reducing: the filter widens with the reduction (no aliasing).
  float scale = clamp(uRatio, 1.0, 8.0);
  float radius = (uLanczos == 1 ? uLobes : 1.0) * scale;
  float start = floor(pos - radius) + 1.0;
  int taps = int(ceil(2.0 * radius)) + 1;
  vec4 sum = vec4(0.0);
  float wsum = 0.0;
  for (int t = 0; t < 64; t++) {
    if (t >= taps) break;
    float i = start + float(t);
    float d = (pos - i) / scale;
    float w = uLanczos == 1 ? (abs(d) < uLobes ? sinc(d) * sinc(d / uLobes) : 0.0) : max(0.0, 1.0 - abs(d));
    int k = int(clamp(i, 0.0, float(n - 1)));
    sum += texelFetch(uSrc, uAxis == 0 ? ivec2(k, p.y) : ivec2(p.x, k), 0) * w;
    wsum += w;
  }
  outColor = packOut(sum / wsum);
}`;

// Unsharp mask against a box blur of radius uRadius, then clamped.
const SHARPEN = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform int uRadius;
uniform float uAmount;
out vec4 outColor;
// 16-bit export (upscaleBits16): the final pass run twice, writing the high and then the low byte of round(65535 * value) into 8-bit channels.
uniform int uBytePass;
vec4 packOut(vec4 c) {
  if (uBytePass == 0) return c;
  vec3 v = floor(clamp(c.rgb, 0.0, 1.0) * 65535.0 + 0.5);
  vec3 hi = floor(v / 256.0);
  return vec4((uBytePass == 1 ? hi : v - hi * 256.0) / 255.0, 1.0);
}

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 last = textureSize(uSrc, 0) - 1;
  vec4 c = texelFetch(uSrc, p, 0);
  vec3 blur = vec3(0.0);
  for (int y = -4; y <= 4; y++) {
    if (abs(y) > uRadius) continue;
    for (int x = -4; x <= 4; x++) {
      if (abs(x) > uRadius) continue;
      blur += texelFetch(uSrc, clamp(p + ivec2(x, y), ivec2(0), last), 0).rgb;
    }
  }
  float n = float((2 * uRadius + 1) * (2 * uRadius + 1));
  blur /= n;
  outColor = packOut(vec4(clamp(c.rgb + (c.rgb - blur) * uAmount, 0.0, 1.0), clamp(c.a, 0.0, 1.0)));
}`;

// FSR 1 EASU: 12 taps around the sample, weighted along the local edge.
const EASU = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform vec2 uScale;
out vec4 outColor;
vec3 tap(ivec2 p, ivec2 last) { return texelFetch(uSrc, clamp(p, ivec2(0), last), 0).rgb; }
float luma(vec3 c) { return c.r * 0.5 + c.g + c.b * 0.5; }
void setF(inout vec2 dir, inout float len, float w, float a, float b, float c, float d, float e) {
  float lenX = max(abs(d - c), abs(c - b));
  lenX = lenX > 0.0 ? 1.0 / lenX : 0.0;
  float dx = d - b;
  dir.x += dx * w;
  lenX = clamp(abs(dx) * lenX, 0.0, 1.0);
  len += lenX * lenX * w;
  float lenY = max(abs(e - c), abs(c - a));
  lenY = lenY > 0.0 ? 1.0 / lenY : 0.0;
  float dy = e - a;
  dir.y += dy * w;
  lenY = clamp(abs(dy) * lenY, 0.0, 1.0);
  len += lenY * lenY * w;
}
void tapF(inout vec3 ac, inout float aw, vec2 off, vec2 dir, vec2 len2, float lob, float clp, vec3 c) {
  vec2 v = vec2(dot(off, dir), dot(off, vec2(-dir.y, dir.x))) * len2;
  float d2 = min(dot(v, v), clp);
  float wB = 2.0 / 5.0 * d2 - 1.0;
  float wA = lob * d2 - 1.0;
  wB *= wB;
  wA *= wA;
  wB = 25.0 / 16.0 * wB - (25.0 / 16.0 - 1.0);
  float w = wB * wA;
  ac += c * w;
  aw += w;
}
// 16-bit export (upscaleBits16): the final pass run twice, writing the high and then the low byte of round(65535 * value) into 8-bit channels.
uniform int uBytePass;
vec4 packOut(vec4 c) {
  if (uBytePass == 0) return c;
  vec3 v = floor(clamp(c.rgb, 0.0, 1.0) * 65535.0 + 0.5);
  vec3 hi = floor(v / 256.0);
  return vec4((uBytePass == 1 ? hi : v - hi * 256.0) / 255.0, 1.0);
}

void main() {
  ivec2 last = textureSize(uSrc, 0) - 1;
  vec2 pp = (gl_FragCoord.xy) * uScale - 0.5;
  vec2 fp = floor(pp);
  vec2 t = pp - fp;
  ivec2 f0 = ivec2(fp);
  vec3 b = tap(f0 + ivec2(0, -1), last), c = tap(f0 + ivec2(1, -1), last);
  vec3 e = tap(f0 + ivec2(-1, 0), last), f = tap(f0, last), g = tap(f0 + ivec2(1, 0), last), h = tap(f0 + ivec2(2, 0), last);
  vec3 i = tap(f0 + ivec2(-1, 1), last), j = tap(f0 + ivec2(0, 1), last), k = tap(f0 + ivec2(1, 1), last), l = tap(f0 + ivec2(2, 1), last);
  vec3 n = tap(f0 + ivec2(0, 2), last), o = tap(f0 + ivec2(1, 2), last);
  float lB = luma(b), lC = luma(c), lE = luma(e), lF = luma(f), lG = luma(g), lH = luma(h);
  float lI = luma(i), lJ = luma(j), lK = luma(k), lL = luma(l), lN = luma(n), lO = luma(o);
  vec2 dir = vec2(0.0);
  float len = 0.0;
  setF(dir, len, (1.0 - t.x) * (1.0 - t.y), lB, lE, lF, lG, lJ);
  setF(dir, len, t.x * (1.0 - t.y), lC, lF, lG, lH, lK);
  setF(dir, len, (1.0 - t.x) * t.y, lF, lI, lJ, lK, lN);
  setF(dir, len, t.x * t.y, lG, lJ, lK, lL, lO);
  float dr = dot(dir, dir);
  if (dr < 1.0 / 32768.0) dir = vec2(1.0, 0.0);
  else dir *= inversesqrt(dr);
  len = len * 0.5;
  len *= len;
  float stretch = dot(dir, dir) / max(abs(dir.x), abs(dir.y));
  vec2 len2 = vec2(1.0 + (stretch - 1.0) * len, 1.0 - 0.5 * len);
  float lob = 0.5 + (1.0 / 4.0 - 0.04 - 0.5) * len;
  float clp = 1.0 / lob;
  vec3 ac = vec3(0.0);
  float aw = 0.0;
  tapF(ac, aw, vec2(0.0, -1.0) - t, dir, len2, lob, clp, b);
  tapF(ac, aw, vec2(1.0, -1.0) - t, dir, len2, lob, clp, c);
  tapF(ac, aw, vec2(-1.0, 0.0) - t, dir, len2, lob, clp, e);
  tapF(ac, aw, vec2(0.0, 0.0) - t, dir, len2, lob, clp, f);
  tapF(ac, aw, vec2(1.0, 0.0) - t, dir, len2, lob, clp, g);
  tapF(ac, aw, vec2(2.0, 0.0) - t, dir, len2, lob, clp, h);
  tapF(ac, aw, vec2(-1.0, 1.0) - t, dir, len2, lob, clp, i);
  tapF(ac, aw, vec2(0.0, 1.0) - t, dir, len2, lob, clp, j);
  tapF(ac, aw, vec2(1.0, 1.0) - t, dir, len2, lob, clp, k);
  tapF(ac, aw, vec2(2.0, 1.0) - t, dir, len2, lob, clp, l);
  tapF(ac, aw, vec2(0.0, 2.0) - t, dir, len2, lob, clp, n);
  tapF(ac, aw, vec2(1.0, 2.0) - t, dir, len2, lob, clp, o);
  vec3 lo = min(min(f, g), min(j, k));
  vec3 hi = max(max(f, g), max(j, k));
  outColor = packOut(vec4(clamp(ac / aw, lo, hi), 1.0));
}`;

// FSR 1 RCAS: sharpens as far as the neighbors allow without clipping.
const RCAS = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform float uSharp;
out vec4 outColor;
// 16-bit export (upscaleBits16): the final pass run twice, writing the high and then the low byte of round(65535 * value) into 8-bit channels.
uniform int uBytePass;
vec4 packOut(vec4 c) {
  if (uBytePass == 0) return c;
  vec3 v = floor(clamp(c.rgb, 0.0, 1.0) * 65535.0 + 0.5);
  vec3 hi = floor(v / 256.0);
  return vec4((uBytePass == 1 ? hi : v - hi * 256.0) / 255.0, 1.0);
}

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 last = textureSize(uSrc, 0) - 1;
  vec3 e = texelFetch(uSrc, p, 0).rgb;
  vec3 b = texelFetch(uSrc, clamp(p + ivec2(0, 1), ivec2(0), last), 0).rgb;
  vec3 d = texelFetch(uSrc, clamp(p + ivec2(-1, 0), ivec2(0), last), 0).rgb;
  vec3 f = texelFetch(uSrc, clamp(p + ivec2(1, 0), ivec2(0), last), 0).rgb;
  vec3 h = texelFetch(uSrc, clamp(p + ivec2(0, -1), ivec2(0), last), 0).rgb;
  vec3 mn = min(min(b, d), min(f, h));
  vec3 mx = max(max(b, d), max(f, h));
  vec3 hitMin = min(mn, e) / max(4.0 * mx, vec3(1e-6));
  vec3 hitMax = (1.0 - max(mx, e)) / min(4.0 * mn - 4.0, vec3(-1e-6));
  vec3 lobeC = max(-hitMin, hitMax);
  float lobe = max(-(0.25 - 1.0 / 16.0), min(max(lobeC.r, max(lobeC.g, lobeC.b)), 0.0)) * uSharp;
  vec3 c = (lobe * (b + d + f + h) + e) / (4.0 * lobe + 1.0);
  outColor = packOut(vec4(clamp(c, 0.0, 1.0), 1.0));
}`;
let ctx;

function compile(gl, src) {
  const p = gl.createProgram();
  for (const [type, code] of [[gl.VERTEX_SHADER, VERTEX], [gl.FRAGMENT_SHADER, src]]) {
    const s = gl.createShader(type);
    gl.shaderSource(s, code);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    gl.attachShader(p, s);
  }
  gl.bindAttribLocation(p, 0, 'aPos');
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  return p;
}

function setup() {
  if (ctx !== undefined) return ctx;
  ctx = null;
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2', { preserveDrawingBuffer: true, premultipliedAlpha: false, antialias: false });
    if (!gl) return null;
    const float = !!gl.getExtension('EXT_color_buffer_float');
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    ctx = { canvas, gl, float, resample: compile(gl, RESAMPLE), sharpen: compile(gl, SHARPEN), easu: compile(gl, EASU), rcas: compile(gl, RCAS), convert: compile(gl, CONVERT), max: gl.getParameter(gl.MAX_TEXTURE_SIZE) };
  } catch {
    ctx = null;
  }
  return ctx;
}

// The 16-bit source picture (RGBA16UI) as floats between 0 and 1, so the passes that follow read it like any other.
const CONVERT = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
uniform usampler2D uSrcU;
out vec4 outColor;
void main() { outColor = vec4(vec3(texelFetch(uSrcU, ivec2(gl_FragCoord.xy), 0).rgb) / 65535.0, 1.0); }`;

function texture(gl, w, h, float, source) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
  if (source) {
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  } else if (float) {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
  } else {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  }
  return t;
}

function pass(gl, program, src, target, w, h, uniforms) {
  let fb = null;
  if (target) {
    fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target, 0);
  } else {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }
  gl.viewport(0, 0, w, h);
  gl.useProgram(program);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, src);
  gl.uniform1i(gl.getUniformLocation(program, 'uSrc'), 0);
  for (const [name, [kind, v]] of Object.entries({ uBytePass: ['uniform1i', 0], ...uniforms })) gl[kind](gl.getUniformLocation(program, name), ...[].concat(v));
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  if (fb) gl.deleteFramebuffer(fb);
}

// Enlarges (or reduces) `source` (a canvas, ImageBitmap or ImageData) to W x H and returns
// a canvas holding the result. The returned canvas may be reused by the next
// call: draw or save it before upscaling again.
export function upscaleImage(source, W, H, { method = 'lanczos', sharpen = 0, lobes = 3 } = {}) {
  const w = source.width;
  const h = source.height;
  const c = setup();
  if (!c || W > c.max || H > c.max) return upscaleOnCpu(source, W, H, { method, sharpen, lobes });
  const { gl } = c;
  c.canvas.width = W;
  c.canvas.height = H;
  if (method === 'fsr' && W >= w && H >= h) {
    const src = texture(gl, w, h, false, source);
    const sharp = rcasStrength(sharpen);
    const big = sharp ? texture(gl, W, H, c.float) : null;
    pass(gl, c.easu, src, big, W, H, { uScale: ['uniform2f', [w / W, h / H]] });
    if (big) pass(gl, c.rcas, big, null, W, H, { uSharp: ['uniform1f', sharp] });
    for (const t of [src, big]) if (t) gl.deleteTexture(t);
    return c.canvas;
  }
  if (method === 'fsr') method = 'lanczos';
  const lanczos = method === 'lanczos' ? 1 : 0;
  const src = texture(gl, w, h, false, source);
  const rows = texture(gl, W, h, c.float);
  const both = sharpen > 0 ? texture(gl, W, H, c.float) : null;
  pass(gl, c.resample, src, rows, W, h, { uAxis: ['uniform1i', 0], uLanczos: ['uniform1i', lanczos], uLobes: ['uniform1f', lobes], uRatio: ['uniform1f', w / W] });
  pass(gl, c.resample, rows, both, W, H, { uAxis: ['uniform1i', 1], uLanczos: ['uniform1i', lanczos], uLobes: ['uniform1f', lobes], uRatio: ['uniform1f', h / H] });
  if (both) {
    const radius = Math.min(4, Math.max(1, Math.round(Math.max(W / w, H / h))));
    pass(gl, c.sharpen, both, null, W, H, { uRadius: ['uniform1i', radius], uAmount: ['uniform1f', sharpen * 1.5] });
  }
  for (const t of [src, rows, both]) if (t) gl.deleteTexture(t);
  return c.canvas;
}

function upscaleOnCpu(source, W, H, opts) {
  let img = source;
  if (!(source instanceof ImageData)) {
    const tmp = Object.assign(document.createElement('canvas'), { width: source.width, height: source.height });
    const g = tmp.getContext('2d');
    g.drawImage(source, 0, 0);
    img = g.getImageData(0, 0, source.width, source.height);
  }
  const out = upscaleCpu(img, W, H, opts);
  const canvas = Object.assign(document.createElement('canvas'), { width: W, height: H });
  canvas.getContext('2d').putImageData(new ImageData(out.data, W, H), 0, 0);
  return canvas;
}

// The same enlarging as upscaleImage for a picture at 16 bits per channel: `rgb` is a Uint16Array (w * h * 3, the first row the top). Returns the enlarged picture the same
// way (W * H * 3), or null where the card cannot do it (no float render targets, a size beyond its textures): the caller saves the picture as it is. Everything between the
// first and the last pass is in 32-bit floats (16-bit floats above about 24 million pixels, to keep the memory in bounds), and the last pass runs twice, for the two bytes.
export function upscaleBits16(rgb, w, h, W, H, { method = 'lanczos', sharpen = 0, lobes = 3 } = {}) {
  const c = setup();
  if (!c || !c.float || Math.max(W, H, w, h) > c.max) return null;
  const { gl } = c;
  const owned = [];
  const make = (tw, th, f32, internal, format, type) => {
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, tw, th, 0, format, type, null);
    owned.push(t);
    return t;
  };
  const floats = (tw, th, f32) => make(tw, th, f32, f32 ? gl.RGBA32F : gl.RGBA16F, gl.RGBA, f32 ? gl.FLOAT : gl.HALF_FLOAT);
  try {
    // 32-bit floats between the passes where they fit (the video memory limit in Settings, and no more than about 24 million pixels); 16-bit floats where only those fit
    const big32 = W * H <= 24e6 && fitsMemory('vram', enlargeVram(W, H, true));
    if (!fitsMemory('vram', enlargeVram(W, H, big32))) return null;
    const rgba = new Uint16Array(w * h * 4);
    for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) {
      rgba[j] = rgb[i];
      rgba[j + 1] = rgb[i + 1];
      rgba[j + 2] = rgb[i + 2];
      rgba[j + 3] = 65535;
    }
    const src16 = make(w, h, false, gl.RGBA16UI, gl.RGBA_INTEGER, gl.UNSIGNED_SHORT);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA_INTEGER, gl.UNSIGNED_SHORT, rgba);
    const src = floats(w, h, true);
    pass(gl, c.convert, src16, src, w, h, { uSrcU: ['uniform1i', 0] });
    // the passes before the last one, and the last one (run once for each byte)
    let last;
    if (method === 'fsr' && W >= w && H >= h) {
      const sharp = rcasStrength(sharpen);
      const big = sharp ? floats(W, H, big32) : null;
      if (big) {
        pass(gl, c.easu, src, big, W, H, { uScale: ['uniform2f', [w / W, h / H]] });
        last = (target, bytePass) => pass(gl, c.rcas, big, target, W, H, { uSharp: ['uniform1f', sharp], uBytePass: ['uniform1i', bytePass] });
      } else {
        last = (target, bytePass) => pass(gl, c.easu, src, target, W, H, { uScale: ['uniform2f', [w / W, h / H]], uBytePass: ['uniform1i', bytePass] });
      }
    } else {
      const lanczos = method === 'lanczos' || method === 'fsr' ? 1 : 0;
      const rows = floats(W, h, big32);
      pass(gl, c.resample, src, rows, W, h, { uAxis: ['uniform1i', 0], uLanczos: ['uniform1i', lanczos], uLobes: ['uniform1f', lobes], uRatio: ['uniform1f', w / W] });
      const vertical = (target, bytePass) => pass(gl, c.resample, rows, target, W, H, { uAxis: ['uniform1i', 1], uLanczos: ['uniform1i', lanczos], uLobes: ['uniform1f', lobes], uRatio: ['uniform1f', h / H], uBytePass: ['uniform1i', bytePass] });
      if (sharpen > 0) {
        const both = floats(W, H, big32);
        vertical(both, 0);
        const radius = Math.min(4, Math.max(1, Math.round(Math.max(W / w, H / h))));
        last = (target, bytePass) => pass(gl, c.sharpen, both, target, W, H, { uRadius: ['uniform1i', radius], uAmount: ['uniform1f', sharpen * 1.5], uBytePass: ['uniform1i', bytePass] });
      } else {
        last = vertical;
      }
    }
    const out8 = make(W, H, false, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE);
    const out = new Uint16Array(W * H * 3);
    const bytes = new Uint8Array(W * H * 4);
    const fb = gl.createFramebuffer();
    try {
      for (const bytePass of [1, 2]) {
        last(out8, bytePass);
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, out8, 0);
        gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
        gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
        for (let i = 0, j = 0; i < out.length; i += 3, j += 4) {
          if (bytePass === 1) {
            out[i] = bytes[j] << 8;
            out[i + 1] = bytes[j + 1] << 8;
            out[i + 2] = bytes[j + 2] << 8;
          } else {
            out[i] |= bytes[j];
            out[i + 1] |= bytes[j + 1];
            out[i + 2] |= bytes[j + 2];
          }
        }
      }
    } finally {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteFramebuffer(fb);
    }
    if (gl.getError() !== gl.NO_ERROR) return null;
    return out;
  } finally {
    for (const t of owned) gl.deleteTexture(t);
  }
}
