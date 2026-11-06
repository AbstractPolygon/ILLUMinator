// The engine depth estimator's data cost volume (core/enginedepth.js engineCostVolume) on the GPU.
// Per label and pixel: 1.25 x (sum of the 4 largest of min(sad, 0.2) over the eight ring views), sad the L1 distance between the ring view's bilinear
// sample at (x + lambda u, y + lambda v) and the centre pixel, taps clamped to the picture the way the engine's gather does. Four labels per draw (RGBA).
// A label whose mean ring colour tops 0.95 in a channel is encoded as -1 - cost; the whole pixel is zeroed for those, and for the flat cost curves (those two
// rules need every label of a pixel). engineCostVolumeGpu returns the volume as an array with the rules applied on the CPU; engineCostVolumeResident keeps it on the
// graphics card (an array texture, one layer per four labels, and a flag per pixel for the rules, applied by the shader that reads a label's slice), which is what
// engineSolveGpu (gpu/depthmatch.js) takes without any read-back or upload in between.
import { program } from './renderer.js';
import { RING_UV, ENGINE_COST } from '../core/enginedepth.js';

const SHADER = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2DArray;
uniform sampler2DArray uViews;   // nine layers, RGB in the first three channels, the centre last
uniform vec4 uLabels;            // four label values (lambda)
uniform vec2 uRing[8];           // (u, v) of the eight ring views
uniform float uTrunc;
uniform float uScale;
uniform float uLimit;            // 8 x the blown-out level
out vec4 outColor;

vec3 tap(int k, ivec2 q, ivec2 size) {
  return texelFetch(uViews, ivec3(clamp(q, ivec2(0), size - 1), k), 0).rgb;
}

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 size = textureSize(uViews, 0).xy;
  vec3 ref = texelFetch(uViews, ivec3(p, 8), 0).rgb;
  vec4 result = vec4(0.0);
  for (int j = 0; j < 4; j++) {
    float lab = uLabels[j];
    float s[8];
    vec3 sum = vec3(0.0);
    for (int k = 0; k < 8; k++) {
      float py = lab * uRing[k].y + float(p.y);
      float px = lab * uRing[k].x + float(p.x);
      float y0 = floor(py);
      float x0 = floor(px);
      float fy = py - y0;
      float fx = px - x0;
      // the engine floors (p + 1) on its own, so for a tiny negative p the upper tap is 1, not 0
      float y1 = floor(py + 1.0);
      float x1 = floor(px + 1.0);
      ivec2 q0 = ivec2(int(x0), int(y0));
      ivec2 q1 = ivec2(int(x1), int(y1));
      float w00 = (1.0 - fx) * (1.0 - fy);
      float w01 = (1.0 - fx) * fy;
      float w10 = fx * (1.0 - fy);
      float w11 = fx * fy;
      vec3 c = w11 * tap(k, q1, size) + w10 * tap(k, ivec2(q1.x, q0.y), size) + w01 * tap(k, ivec2(q0.x, q1.y), size) + w00 * tap(k, q0, size);
      sum += c;
      vec3 d = abs(c - ref);
      s[k] = min(d.b + d.g + d.r, uTrunc);
    }
    // the four largest of eight: sort ascending, add the top half
    for (int a = 0; a < 7; a++) {
      for (int b = 0; b < 7 - a; b++) {
        if (s[b] > s[b + 1]) { float t = s[b]; s[b] = s[b + 1]; s[b + 1] = t; }
      }
    }
    float cost = ((s[4] + s[5]) + s[6] + s[7]) * uScale;
    bool blown = max(sum.r, max(sum.g, sum.b)) > uLimit;
    result[j] = blown ? -1.0 - cost : cost;
  }
  outColor = result;
}`;


// The two whole-pixel rules of the engine, for every pixel at once: 1 where the volume is zeroed (a blown-out label, or a cost curve whose median is within
// `uNoisy` of its minimum), else 0. uRaw: one layer per four labels.
// The most labels the engine's range can come to: -35 up to its top (at most 100), padded to a multiple of four.
const MAX_LABELS = 144;
const RULES = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2DArray;
uniform sampler2DArray uRaw;
uniform int uGroups;
uniform int uKth;
uniform float uNoisy;
out vec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int L = uGroups * 4;
  float v[${MAX_LABELS}];
  bool blown = false;
  for (int g = 0; g < ${MAX_LABELS / 4}; g++) {
    if (g >= uGroups) break;
    vec4 t = texelFetch(uRaw, ivec3(p, g), 0);
    v[4 * g] = t.x;
    v[4 * g + 1] = t.y;
    v[4 * g + 2] = t.z;
    v[4 * g + 3] = t.w;
    if (min(min(t.x, t.y), min(t.z, t.w)) < 0.0) blown = true;
  }
  float zero = 1.0;
  if (!blown) {
    for (int i = 1; i < ${MAX_LABELS}; i++) {
      if (i >= L) break;
      float x = v[i];
      int j = i - 1;
      while (j >= 0 && v[j] > x) {
        v[j + 1] = v[j];
        j--;
      }
      v[j + 1] = x;
    }
    float median = uKth < L - 1 ? v[uKth] : v[L - 1];
    zero = (median - v[0]) < uNoisy ? 1.0 : 0.0;
  }
  outColor = vec4(zero, 0.0, 0.0, 1.0);
}`;

// views: as engineCostVolumeGpu. Returns the volume on the graphics card: { gpuVolume: true, w, h, L, raw, flag, toArray(), dispose() }. `raw` holds the label costs
// (a blown-out label as -1 - cost) and `flag` the pixels the rules zero. toArray() is the same array engineCostVolumeGpu returns (for the CPU to take over); the
// caller disposes the volume.
export function engineCostVolumeResident(gpu, views, w, h, labels, opts = ENGINE_COST) {
  const gl = gpu.gl;
  const L = labels.length;
  const G = L / 4;
  if (L % 4) throw new Error('The label count must be a multiple of four');
  if (L > MAX_LABELS) throw new Error('Too many labels for the GPU volume');
  if (views.length !== 9) throw new Error('The engine cost needs nine views');
  if (!gpu.engineCostProgram) gpu.engineCostProgram = program(gl, SHADER);
  if (!gpu.engineRulesProgram) gpu.engineRulesProgram = program(gl, RULES);
  const prog = gpu.engineCostProgram;
  const n = w * h;
  while (gl.getError() !== gl.NO_ERROR); // an error an earlier step left is not this one's
  const input = uploadViews(gl, views, w, h);
  const raw = makeArray(gl, w, h, G);
  const flag = gpu.texture(w, h, gl.R32F);
  const dispose = () => {
    gl.deleteTexture(raw);
    gl.deleteTexture(flag);
  };
  try {
    gl.useProgram(prog.p);
    gl.uniform1i(prog.u.uViews, 1);
    gl.uniform2fv(prog.u.uRing, new Float32Array(RING_UV.flat()));
    gl.uniform1f(prog.u.uTrunc, opts.truncate);
    gl.uniform1f(prog.u.uScale, opts.scale);
    gl.uniform1f(prog.u.uLimit, 8 * opts.blownOut);
    gpu.bindTex(1, input, gl.TEXTURE_2D_ARRAY);
    // every group queued back to back: nothing is read until the solver needs it
    for (let g = 0; g < G; g++) {
      gpu.target(raw, w, h, g);
      gl.uniform4f(prog.u.uLabels, labels[4 * g], labels[4 * g + 1], labels[4 * g + 2], labels[4 * g + 3]);
      gpu.draw();
    }
    const rules = gpu.engineRulesProgram;
    gpu.target(flag, w, h);
    gl.useProgram(rules.p);
    gl.uniform1i(rules.u.uRaw, 1);
    gl.uniform1i(rules.u.uGroups, G);
    gl.uniform1i(rules.u.uKth, Math.ceil((L - 1) * opts.noisyQuantile));
    gl.uniform1f(rules.u.uNoisy, opts.noisy);
    gpu.bindTex(1, raw, gl.TEXTURE_2D_ARRAY);
    gpu.draw();
    const error = gl.getError();
    if (error !== gl.NO_ERROR) throw new Error(`The GPU could not build the cost volume (GL error ${error})`);
  } catch (e) {
    dispose();
    throw e;
  } finally {
    gl.deleteTexture(input);
  }
  return {
    gpuVolume: true,
    w,
    h,
    L,
    raw,
    flag,
    toArray() {
      const out = new Float32Array(n * L);
      const buf = new Float32Array(n * 4);
      const f = new Float32Array(n * 4);
      gpu.target(flag, w, h);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, f);
      for (let g = 0; g < G; g++) {
        gpu.target(raw, w, h, g);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, buf);
        for (let i = 0; i < n; i++) if (f[4 * i] < 0.5) for (let j = 0; j < 4; j++) out[i * L + 4 * g + j] = buf[4 * i + j];
      }
      return out;
    },
    dispose,
  };
}

function uploadViews(gl, views, w, h) {
  const n = w * h;
  gl.activeTexture(gl.TEXTURE0 + 15);
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
  gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA32F, w, h, 9);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  const rgba = new Float32Array(n * 4);
  for (let k = 0; k < 9; k++) {
    const v = views[k];
    for (let i = 0; i < n; i++) {
      rgba[4 * i] = v[3 * i];
      rgba[4 * i + 1] = v[3 * i + 1];
      rgba[4 * i + 2] = v[3 * i + 2];
    }
    gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, k, w, h, 1, gl.RGBA, gl.FLOAT, rgba);
  }
  return tex;
}

function makeArray(gl, w, h, layers) {
  gl.activeTexture(gl.TEXTURE0 + 15);
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
  gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.RGBA32F, w, h, layers);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  return tex;
}

// views: nine Float32Array (RGB, w x h; the centre last). Returns the cost volume ((y * w + x) * L + l) like engineCostVolume.
export function engineCostVolumeGpu(gpu, views, w, h, labels, opts = ENGINE_COST) {
  const gl = gpu.gl;
  const L = labels.length;
  if (L % 4) throw new Error('The label count must be a multiple of four');
  if (views.length !== 9) throw new Error('The engine cost needs nine views');
  if (!gpu.engineCostProgram) gpu.engineCostProgram = program(gl, SHADER);
  const prog = gpu.engineCostProgram;
  const n = w * h;
  const tex = uploadViews(gl, views, w, h);
  const target = gpu.texture(w, h, gl.RGBA32F);
  const out = new Float32Array(n * L);
  const buf = new Float32Array(n * 4);
  try {
    for (let g = 0; g < L / 4; g++) {
      gpu.target(target, w, h);
      gl.useProgram(prog.p);
      gl.uniform1i(prog.u.uViews, 1);
      gpu.bindTex(1, tex, gl.TEXTURE_2D_ARRAY);
      gl.uniform4f(prog.u.uLabels, labels[4 * g], labels[4 * g + 1], labels[4 * g + 2], labels[4 * g + 3]);
      gl.uniform2fv(prog.u.uRing, new Float32Array(RING_UV.flat()));
      gl.uniform1f(prog.u.uTrunc, opts.truncate);
      gl.uniform1f(prog.u.uScale, opts.scale);
      gl.uniform1f(prog.u.uLimit, 8 * opts.blownOut);
      gpu.draw();
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, buf);
      for (let i = 0; i < n; i++) for (let j = 0; j < 4; j++) out[i * L + 4 * g + j] = buf[4 * i + j];
    }
  } finally {
    gl.deleteTexture(tex);
    gl.deleteTexture(target);
  }
  // the whole-pixel rules
  const kth = Math.ceil((L - 1) * opts.noisyQuantile);
  const vec = new Float32Array(L);
  for (let i = 0; i < n; i++) {
    const base = i * L;
    let blown = false;
    for (let l = 0; l < L; l++) if (out[base + l] < 0) { blown = true; break; }
    if (blown) {
      out.fill(0, base, base + L);
      continue;
    }
    for (let l = 0; l < L; l++) vec[l] = out[base + l];
    vec.sort();
    const median = kth < L - 1 ? vec[kth] : vec[L - 1];
    if (Math.fround(median - vec[0]) < Math.fround(opts.noisy)) out.fill(0, base, base + L);
  }
  return out;
}
