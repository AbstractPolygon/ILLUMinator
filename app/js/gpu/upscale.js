// Upscaling for export on the GPU (WebGL2): the same Lanczos-3 / bilinear
// filter and unsharp mask as core/upscale.js, a few milliseconds a frame
// instead of seconds. Falls back to core/upscale.js without WebGL2.

import { upscale as upscaleCpu } from '../core/upscale.js';

const VERTEX = `#version 300 es
in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

// One axis of the resampling filter (uAxis 0: rows, 1: columns).
const RESAMPLE = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform int uAxis;
uniform int uLanczos;
uniform float uRatio;
out vec4 outColor;
const float PI = 3.14159265;
float sinc(float x) { return x == 0.0 ? 1.0 : sin(PI * x) / (PI * x); }
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 size = textureSize(uSrc, 0);
  int n = uAxis == 0 ? size.x : size.y;
  float pos = (float(uAxis == 0 ? p.x : p.y) + 0.5) * uRatio - 0.5;
  // Reducing: the filter widens with the reduction (no aliasing).
  float scale = clamp(uRatio, 1.0, 8.0);
  float radius = (uLanczos == 1 ? 3.0 : 1.0) * scale;
  float start = floor(pos - radius) + 1.0;
  int taps = int(ceil(2.0 * radius)) + 1;
  vec4 sum = vec4(0.0);
  float wsum = 0.0;
  for (int t = 0; t < 64; t++) {
    if (t >= taps) break;
    float i = start + float(t);
    float d = (pos - i) / scale;
    float w = uLanczos == 1 ? (abs(d) < 3.0 ? sinc(d) * sinc(d / 3.0) : 0.0) : max(0.0, 1.0 - abs(d));
    int k = int(clamp(i, 0.0, float(n - 1)));
    sum += texelFetch(uSrc, uAxis == 0 ? ivec2(k, p.y) : ivec2(p.x, k), 0) * w;
    wsum += w;
  }
  outColor = sum / wsum;
}`;

// Unsharp mask against a box blur of radius uRadius, then clamped.
const SHARPEN = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform int uRadius;
uniform float uAmount;
out vec4 outColor;
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
  outColor = vec4(clamp(c.rgb + (c.rgb - blur) * uAmount, 0.0, 1.0), clamp(c.a, 0.0, 1.0));
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
    ctx = { canvas, gl, float, resample: compile(gl, RESAMPLE), sharpen: compile(gl, SHARPEN), max: gl.getParameter(gl.MAX_TEXTURE_SIZE) };
  } catch {
    ctx = null;
  }
  return ctx;
}

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
  for (const [name, [kind, v]] of Object.entries(uniforms)) gl[kind](gl.getUniformLocation(program, name), v);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  if (fb) gl.deleteFramebuffer(fb);
}

// Enlarges (or reduces) `source` (a canvas, ImageBitmap or ImageData) to W x H and returns
// a canvas holding the result. The returned canvas may be reused by the next
// call: draw or save it before upscaling again.
export function upscaleImage(source, W, H, { method = 'lanczos', sharpen = 0 } = {}) {
  const w = source.width;
  const h = source.height;
  const c = setup();
  if (!c || W > c.max || H > c.max) return upscaleOnCpu(source, W, H, { method, sharpen });
  const { gl } = c;
  c.canvas.width = W;
  c.canvas.height = H;
  const lanczos = method === 'lanczos' ? 1 : 0;
  const src = texture(gl, w, h, false, source);
  const rows = texture(gl, W, h, c.float);
  const both = sharpen > 0 ? texture(gl, W, H, c.float) : null;
  pass(gl, c.resample, src, rows, W, h, { uAxis: ['uniform1i', 0], uLanczos: ['uniform1i', lanczos], uRatio: ['uniform1f', w / W] });
  pass(gl, c.resample, rows, both, W, H, { uAxis: ['uniform1i', 1], uLanczos: ['uniform1i', lanczos], uRatio: ['uniform1f', h / H] });
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
