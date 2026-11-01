// The engine depth estimator's data cost volume (core/enginedepth.js engineCostVolume) on the GPU.
// Per label and pixel: 1.25 x (sum of the 4 largest of min(sad, 0.2) over the eight ring views), sad the L1 distance between the ring view's bilinear
// sample at (x + lambda u, y + lambda v) and the centre pixel, taps clamped to the picture the way the engine's gather does. Four labels per draw (RGBA).
// A label whose mean ring colour tops 0.95 in a channel is encoded as -1 - cost; the caller zeroes the whole pixel for those, and for the flat cost
// curves (those two rules need every label of a pixel, so they stay on the CPU, where they cost a fraction of a second).
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

// views: nine Float32Array (RGB, w x h; the centre last). Returns the cost volume ((y * w + x) * L + l) like engineCostVolume.
export function engineCostVolumeGpu(gpu, views, w, h, labels, opts = ENGINE_COST) {
  const gl = gpu.gl;
  const L = labels.length;
  if (L % 4) throw new Error('The label count must be a multiple of four');
  if (views.length !== 9) throw new Error('The engine cost needs nine views');
  if (!gpu.engineCostProgram) gpu.engineCostProgram = program(gl, SHADER);
  const prog = gpu.engineCostProgram;
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
