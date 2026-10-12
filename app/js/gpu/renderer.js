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

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(`Shader compile failed: ${gl.getShaderInfoLog(sh)}`);
  return sh;
}

function program(gl, fragment) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VERTEX));
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
    };
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

  texture(w, h, internal = this.gl.RGBA32F, filter = this.gl.NEAREST) {
    const gl = this.gl;
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
  refocus(alpha, { u0 = 0, v0 = 0, sigma = Infinity } = {}) {
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
    return this.readTarget();
  }
}
