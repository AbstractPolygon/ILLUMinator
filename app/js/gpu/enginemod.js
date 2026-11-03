// The engine's modulation plane (core/enginemod.js engineModulationPlane + engineModulation) on the GPU. The CPU version makes about six passes over the whole
// sensor (41 million pixels on an ILLUM): here every pixel pass is a shader, and the sums, the maximum and the histogram that the plane depends on are reduced on
// the card (per cell of the 100 x 100 grid the plane's tile statistics use, and one point per pixel into a 65536 bin histogram) with only small tables read back.
// The lens-centre levels the final rescale needs are sampled on the card at the lens centres, the finished plane is read back packed as the same 16 bit values.
// Values agree with the CPU version to within the precision of 32 bit floats (the CPU adds in 64 bit): see test/enginemod-gpu.test.mjs.
import { program } from './renderer.js';
import { curve, phaseChannels, MOD_UNIT } from '../core/enginemod.js';

const HEAD = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
`;
const GRID = 100; // cells across and down (the plane's tile statistics)
const BINS = 1 << 16;

// 10 bit white image value -> the engine's 16 bit sample, black subtracted
const BUILD = `${HEAD}
uniform usampler2D uMod;
uniform int uBlack16;
out vec4 outColor;
void main() {
  int m = int(texelFetch(uMod, ivec2(gl_FragCoord.xy), 0).r);
  outColor = vec4(float(((m << 6) | (m >> 4)) - uBlack16));
}`;

// Per cell of the grid: the sum of the values of each Bayer phase (mode 0), or the maximum of A (mode 1)
const CELLS = `${HEAD}
uniform sampler2D uSrc;
uniform ivec2 uSize;
uniform int uMode;
uniform vec4 uMean;
out vec4 outColor;
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  int x0 = (c.x * uSize.x + ${GRID - 1}) / ${GRID};
  int x1 = ((c.x + 1) * uSize.x + ${GRID - 1}) / ${GRID};
  int y0 = (c.y * uSize.y + ${GRID - 1}) / ${GRID};
  int y1 = ((c.y + 1) * uSize.y + ${GRID - 1}) / ${GRID};
  vec4 acc = vec4(0.0);
  for (int y = y0; y < y1; y++) {
    for (int x = x0; x < x1; x++) {
      float v = texelFetch(uSrc, ivec2(x, y), 0).r;
      int p = ((y & 1) << 1) | (x & 1);
      if (uMode == 0) {
        acc[p] += v;
      } else {
        float a = max(1e-6, v) / uMean[p];
        if (a < 0.02) a = 0.02;
        acc[p] = max(acc[p], a);
      }
    }
  }
  outColor = acc;
}`;

// The hot pixels' replacements written into the plane
const HOT_VERTEX = `${HEAD}
uniform sampler2D uHot;
uniform int uHotWidth;
uniform vec2 uSize;
flat out float vValue;
void main() {
  vec4 h = texelFetch(uHot, ivec2(gl_VertexID % uHotWidth, gl_VertexID / uHotWidth), 0);
  vValue = h.z;
  gl_PointSize = 1.0;
  gl_Position = vec4((h.x + 0.5) / uSize.x * 2.0 - 1.0, (h.y + 0.5) / uSize.y * 2.0 - 1.0, 0.0, 1.0);
}`;
const HOT_FRAGMENT = `${HEAD}
flat in float vValue;
out vec4 outColor;
void main() { outColor = vec4(vValue); }`;

// S1 = A / max(A), A = max(0.02, max(1e-6, P) / the phase's mean)
const S1 = `${HEAD}
uniform sampler2D uSrc;
uniform vec4 uMean;
uniform float uInv;
out vec4 outColor;
void main() {
  ivec2 f = ivec2(gl_FragCoord.xy);
  int p = ((f.y & 1) << 1) | (f.x & 1);
  float a = max(1e-6, texelFetch(uSrc, f, 0).r) / uMean[p];
  if (a < 0.02) a = 0.02;
  outColor = vec4(a * uInv);
}`;

// One point per pixel into the histogram of its phase
const HIST_VERTEX = `${HEAD}
uniform sampler2D uSrc;
uniform int uWidth;
flat out float vOne;
void main() {
  ivec2 f = ivec2(gl_VertexID % uWidth, gl_VertexID / uWidth);
  float v = texelFetch(uSrc, f, 0).r;
  int bin = min(${BINS - 1}, int(v * ${BINS}.0));
  int p = ((f.y & 1) << 1) | (f.x & 1);
  vOne = 1.0;
  gl_PointSize = 1.0;
  gl_Position = vec4((float(bin & 255) + 0.5) / 256.0 * 2.0 - 1.0, (float(p * 256 + (bin >> 8)) + 0.5) / 1024.0 * 2.0 - 1.0, 0.0, 1.0);
}`;
const HIST_FRAGMENT = `${HEAD}
flat in float vOne;
out vec4 outColor;
void main() { outColor = vec4(vOne); }`;

// S2 = S1 * curve[c][clamp(floor(4096 S1 / (tile(p) q(p))), 0, 4095)]
const S2 = `
uniform sampler2D uTile;
uniform sampler2D uLut;
uniform vec4 uQ;
uniform ivec4 uLutCh;
uniform ivec2 uSize;
float s2(float v, ivec2 f) {
  int p = ((f.y & 1) << 1) | (f.x & 1);
  ivec2 cell = ivec2(min(${GRID - 1}, (f.x * ${GRID}) / uSize.x), min(${GRID - 1}, (f.y * ${GRID}) / uSize.y));
  float t = texelFetch(uTile, cell, 0)[p];
  float idx = floor(4096.0 * v / (t * uQ[p]));
  if (!(idx >= 0.0)) idx = 0.0;
  else if (idx > 4095.0) idx = 4095.0;
  return v * texelFetch(uLut, ivec2(int(idx), 0), 0)[uLutCh[p]];
}`;

// Each lens centre's value of every Bayer phase (bilinear among the four nearest pixels of that phase; -1 outside), of S1 or S2
const DISK = `${HEAD}
uniform sampler2D uSrc;
uniform sampler2D uPos;
uniform int uApply;
${S2}
float val(ivec2 f) {
  float v = texelFetch(uSrc, f, 0).r;
  return uApply == 1 ? s2(v, f) : v;
}
float phaseSample(int py, int px, vec2 xy) {
  float gx = (xy.x - float(px)) / 2.0;
  float gy = (xy.y - float(py)) / 2.0;
  int x0 = int(floor(gx));
  int y0 = int(floor(gy));
  float fx = gx - float(x0);
  float fy = gy - float(y0);
  int xa = x0 * 2 + px;
  int ya = y0 * 2 + py;
  if (x0 < 0 || y0 < 0 || xa + 2 >= uSize.x || ya + 2 >= uSize.y) return -1.0;
  return val(ivec2(xa, ya)) * (1.0 - fx) * (1.0 - fy) + val(ivec2(xa + 2, ya)) * fx * (1.0 - fy) + val(ivec2(xa, ya + 2)) * (1.0 - fx) * fy + val(ivec2(xa + 2, ya + 2)) * fx * fy;
}
out vec4 outColor;
void main() {
  vec2 xy = texelFetch(uPos, ivec2(gl_FragCoord.xy), 0).xy;
  outColor = vec4(phaseSample(0, 0, xy), phaseSample(0, 1, xy), phaseSample(1, 0, xy), phaseSample(1, 1, xy));
}`;

// The finished plane as 16 bit values, two per RGBA8 texel (little endian): round(E * unit + black), E = S2 * ratio of its colour
const FINAL = `${HEAD}
uniform sampler2D uSrc;
uniform vec3 uRatio;
uniform vec3 uBlack;
uniform ivec4 uCfa;
uniform float uUnit;
${S2}
float one(ivec2 f) {
  int c = uCfa[((f.y & 1) << 1) | (f.x & 1)];
  float e = s2(texelFetch(uSrc, f, 0).r, f) * uRatio[c];
  return min(65535.0, floor(e * uUnit + uBlack[c] + 0.5));
}
out vec4 outColor;
void main() {
  ivec2 f = ivec2(gl_FragCoord.xy);
  float a = one(ivec2(f.x * 2, f.y));
  float b = one(ivec2(f.x * 2 + 1, f.y));
  outColor = vec4(mod(a, 256.0), floor(a / 256.0), mod(b, 256.0), floor(b / 256.0)) / 255.0;
}`;

// True when the card can run engineModulationGpu for a plane of this size.
export function engineModulationGpuAvailable(gpu, cam) {
  if (!gpu || !gpu.floatBlend) return false;
  const max = gpu.gl.getParameter(gpu.gl.MAX_TEXTURE_SIZE);
  return cam.width % 2 === 0 && cam.height % 2 === 0 && Math.max(cam.width, cam.height) <= max;
}

// Same arguments and result as engineModulation() (the Uint16Array with .eUnit), with `gpu` (a GpuRenderer) first.
export function engineModulationGpu(gpu, mod, cam, dev, grid, hot) {
  const gl = gpu.gl;
  const { width: W, height: H } = cam;
  const N = W * H;
  const cfa = dev.cfa;
  const black = Number.isFinite(mod.black) ? mod.black : 64;
  const black16 = ((black << 6) | (black >> 4)) >>> 0;
  const lutch = phaseChannels(cfa);
  const programs = (gpu.modPrograms ||= {
    build: program(gl, BUILD), cells: program(gl, CELLS), hot: program(gl, HOT_FRAGMENT, HOT_VERTEX), s1: program(gl, S1),
    hist: program(gl, HIST_FRAGMENT, HIST_VERTEX), disk: program(gl, DISK), final: program(gl, FINAL),
  });
  const owned = [];
  const make = (w, h, fmt, filter) => {
    const t = gpu.texture(w, h, fmt, filter);
    owned.push(t);
    return t;
  };
  const drop = (t) => {
    gl.deleteTexture(t);
    owned.splice(owned.indexOf(t), 1);
  };
  const upload = (t, w, h, format, type, data) => {
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, format, type, data);
  };
  const readFloat = (t, w, h) => {
    gpu.target(t, w, h);
    gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
    const out = new Float32Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, out);
    return out;
  };
  const fullscreen = (P, target, w, h, setup) => {
    gpu.target(target, w, h);
    gl.useProgram(P.p);
    setup(P.u);
    gl.bindVertexArray(gpu.vao);
    gpu.draw();
  };
  try {
    // P: the 10 bit value as the engine's 16 bit sample, black subtracted
    const M = make(W, H, gl.R16UI, gl.NEAREST);
    upload(M, W, H, gl.RED_INTEGER, gl.UNSIGNED_SHORT, mod);
    const Ptex = make(W, H, gl.R32F, gl.NEAREST);
    fullscreen(programs.build, Ptex, W, H, (u) => {
      gl.uniform1i(u.uMod, 1);
      gpu.bindTex(1, M);
      gl.uniform1i(u.uBlack16, black16);
    });
    drop(M);

    const cellTex = make(GRID, GRID, gl.RGBA32F, gl.NEAREST);
    const cells = (src, mode, mean) => {
      fullscreen(programs.cells, cellTex, GRID, GRID, (u) => {
        gl.uniform1i(u.uSrc, 1);
        gpu.bindTex(1, src);
        gl.uniform2i(u.uSize, W, H);
        gl.uniform1i(u.uMode, mode);
        gl.uniform4f(u.uMean, ...(mean || [1, 1, 1, 1]));
      });
      return readFloat(cellTex, GRID, GRID);
    };
    // pixels of each phase in each cell
    const spans = (n) => Array.from({ length: GRID }, (_, c) => [Math.ceil((c * n) / GRID), Math.ceil(((c + 1) * n) / GRID)]);
    const cx = spans(W);
    const cy = spans(H);
    const countIn = ([a, b], bit) => {
      // odd numbers in [a, b) = floor(b / 2) - floor(a / 2); even = (b - a) - odd
      const odd = (b >> 1) - (a >> 1);
      return bit ? odd : b - a - odd;
    };
    const sums = [0, 0, 0, 0];
    const sum0 = cells(Ptex, 0);
    for (let k = 0; k < GRID * GRID; k++) for (let p = 0; p < 4; p++) sums[p] += sum0[4 * k + p];
    const cntPhase = (W / 2) * (H / 2);
    const mean = sums.map((s) => s / cntPhase);
    const greens = [0, 1, 2, 3].filter((p) => cfa[p >> 1][p & 1] === 1);
    if (greens.length === 2) {
      const g = (mean[greens[0]] + mean[greens[1]]) / 2;
      mean[greens[0]] = g;
      mean[greens[1]] = g;
    }
    // hot pixels: replaced by the mean of the not listed neighbours within the radius 2 diamond (scaled by the phase means); computed here from the white image
    // (a few thousand pixels), written into the plane as points
    if (hot && hot.length) {
      const mask = new Uint8Array(N);
      for (let k = 0; k < hot.length; k++) mask[hot[k]] = 1;
      const at = (j) => {
        const m = mod[j];
        return Math.fround(((m << 6) | (m >> 4)) - black16);
      };
      const offs = [];
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if ((dx || dy) && Math.abs(dx) + Math.abs(dy) <= 2) offs.push([dx, dy]);
      const list = [];
      for (let k = 0; k < hot.length; k++) {
        const i = hot[k];
        const y = (i / W) | 0;
        const x = i - y * W;
        if (x < 3 || y < 3 || x >= W - 3 || y >= H - 3) continue;
        const pt = (y & 1) * 2 + (x & 1);
        let acc = 0;
        let n = 0;
        for (const [dx, dy] of offs) {
          const j = i + dy * W + dx;
          if (mask[j]) continue;
          const v = at(j);
          if (!(v >= 0)) continue;
          const pn = (((y + dy) & 1) << 1) | ((x + dx) & 1);
          acc += v * (mean[pt] / mean[pn]);
          n++;
        }
        if (n) list.push(x, y, Math.fround(acc / n), 0);
      }
      if (list.length) {
        const count = list.length / 4;
        const hw = Math.min(count, 1024);
        const hh = Math.ceil(count / hw);
        const data = new Float32Array(hw * hh * 4);
        data.set(list);
        const T = make(hw, hh, gl.RGBA32F, gl.NEAREST);
        upload(T, hw, hh, gl.RGBA, gl.FLOAT, data);
        gpu.target(Ptex, W, H);
        gl.useProgram(programs.hot.p);
        gl.uniform1i(programs.hot.u.uHot, 1);
        gpu.bindTex(1, T);
        gl.uniform1i(programs.hot.u.uHotWidth, hw);
        gl.uniform2f(programs.hot.u.uSize, W, H);
        gl.bindVertexArray(gpu.emptyVao);
        gl.drawArrays(gl.POINTS, 0, count);
        drop(T);
      }
    }
    // A and its maximum
    const maxCells = cells(Ptex, 1, mean);
    let amax = 0;
    for (let k = 0; k < GRID * GRID; k++) for (let p = 0; p < 4; p++) if (maxCells[4 * k + p] > amax) amax = maxCells[4 * k + p];
    const inv = 1 / amax;
    const S1tex = make(W, H, gl.R32F, gl.NEAREST);
    fullscreen(programs.s1, S1tex, W, H, (u) => {
      gl.uniform1i(u.uSrc, 1);
      gpu.bindTex(1, Ptex);
      gl.uniform4f(u.uMean, ...mean);
      gl.uniform1f(u.uInv, inv);
    });
    drop(Ptex);

    // tile means (the 100 x 100 grid per phase, over the centre cell) and the 0.998 quantile of every phase
    const tsum = cells(S1tex, 0);
    const tile = new Float32Array(GRID * GRID * 4);
    const centreK = 50 * GRID + 50;
    for (let p = 0; p < 4; p++) {
      const count = (k) => countIn(cx[k % GRID], p & 1) * countIn(cy[(k / GRID) | 0], p >> 1);
      const centre = tsum[4 * centreK + p] / count(centreK);
      for (let k = 0; k < GRID * GRID; k++) {
        const n = count(k);
        tile[4 * k + p] = n ? tsum[4 * k + p] / n / centre : 0;
      }
    }
    const histTex = make(256, 1024, gl.R32F, gl.NEAREST);
    gpu.target(histTex, 256, 1024);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(programs.hist.p);
    gl.uniform1i(programs.hist.u.uSrc, 1);
    gpu.bindTex(1, S1tex);
    gl.uniform1i(programs.hist.u.uWidth, W);
    gl.bindVertexArray(gpu.emptyVao);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.drawArrays(gl.POINTS, 0, N);
    gl.disable(gl.BLEND);
    const histRGBA = readFloat(histTex, 256, 1024);
    drop(histTex);
    const q = [0, 0, 0, 0];
    for (let p = 0; p < 4; p++) {
      const target = 0.998 * (cntPhase - 1);
      let acc = 0;
      let b = 0;
      const bin = (i) => histRGBA[4 * (p * BINS + i)];
      while (b < BINS - 1 && acc + bin(b) <= target) acc += bin(b++);
      q[p] = (b + 0.5) / BINS;
    }

    const tileTex = make(GRID, GRID, gl.RGBA32F, gl.NEAREST);
    upload(tileTex, GRID, GRID, gl.RGBA, gl.FLOAT, tile);
    const lutTex = make(4096, 1, gl.RGBA32F, gl.NEAREST);
    upload(lutTex, 4096, 1, gl.RGBA, gl.FLOAT, curve());

    // the mean over the central third of the lens centres of the colour at the lens centre, before and after the response curve
    const cs = Math.cos(grid.rotation);
    const sn = Math.sin(grid.rotation);
    const rows = Math.floor((H - grid.oy) / grid.rowStep) + 1;
    const cols = W / grid.pitch;
    const r0 = Math.floor(rows / 3);
    const r1 = Math.floor((2 * rows) / 3);
    const c0 = Math.floor(cols / 3);
    const c1 = Math.floor((2 * cols) / 3);
    const lw = Math.max(0, c1 - c0);
    const lh = Math.max(0, r1 - r0);
    const disk = [[0, 0, 0], [0, 0, 0]];
    const dcnt = [0, 0, 0];
    if (lw > 0 && lh > 0) {
      const pos = new Float32Array(lw * lh * 4);
      for (let r = r0; r < r1; r++) {
        const off = (r & 1) * grid.pitch * 0.5;
        for (let c = c0; c < c1; c++) {
          const u = c * grid.pitch + off;
          const v = r * grid.rowStep;
          const k = ((r - r0) * lw + (c - c0)) * 4;
          pos[k] = grid.ox + cs * u - sn * v;
          pos[k + 1] = grid.oy + sn * u + cs * v;
        }
      }
      const posTex = make(lw, lh, gl.RGBA32F, gl.NEAREST);
      upload(posTex, lw, lh, gl.RGBA, gl.FLOAT, pos);
      const outTex = make(lw, lh, gl.RGBA32F, gl.NEAREST);
      for (let apply = 0; apply < 2; apply++) {
        fullscreen(programs.disk, outTex, lw, lh, (u) => {
          gl.uniform1i(u.uSrc, 1);
          gpu.bindTex(1, S1tex);
          gl.uniform1i(u.uPos, 2);
          gpu.bindTex(2, posTex);
          gl.uniform1i(u.uTile, 3);
          gpu.bindTex(3, tileTex);
          gl.uniform1i(u.uLut, 4);
          gpu.bindTex(4, lutTex);
          gl.uniform4f(u.uQ, ...q);
          gl.uniform4i(u.uLutCh, ...lutch);
          gl.uniform2i(u.uSize, W, H);
          gl.uniform1i(u.uApply, apply);
        });
        const res = readFloat(outTex, lw, lh);
        for (let k = 0; k < lw * lh; k++) {
          for (let p = 0; p < 4; p++) {
            const s = res[4 * k + p];
            if (s < 0) continue;
            const col = cfa[p >> 1][p & 1];
            disk[apply][col] += s;
            if (apply === 0) dcnt[col]++;
          }
        }
      }
    }
    const dBefore = disk[0].map((s, c) => (dcnt[c] ? s / dcnt[c] : 0));
    const dAfter = disk[1].map((s, c) => (dcnt[c] ? s / dcnt[c] : 0));
    const ratio = [0, 1, 2].map((c) => (dAfter[c] ? (dBefore[c] * amax) / dAfter[c] : 1));

    // E = S2 * ratio, as 16 bit values
    const packed = make(W / 2, H, gl.RGBA8, gl.NEAREST);
    fullscreen(programs.final, packed, W / 2, H, (u) => {
      gl.uniform1i(u.uSrc, 1);
      gpu.bindTex(1, S1tex);
      gl.uniform1i(u.uTile, 3);
      gpu.bindTex(3, tileTex);
      gl.uniform1i(u.uLut, 4);
      gpu.bindTex(4, lutTex);
      gl.uniform4f(u.uQ, ...q);
      gl.uniform4i(u.uLutCh, ...lutch);
      gl.uniform2i(u.uSize, W, H);
      gl.uniform3f(u.uRatio, ratio[0], ratio[1], ratio[2]);
      gl.uniform3f(u.uBlack, dev.black[0], dev.black[1], dev.black[2]);
      gl.uniform4i(u.uCfa, cfa[0][0], cfa[0][1], cfa[1][0], cfa[1][1]);
      gl.uniform1f(u.uUnit, MOD_UNIT);
    });
    const out = new Uint16Array(N);
    gpu.target(packed, W / 2, H);
    gl.pixelStorei(gl.PACK_ALIGNMENT, 1);
    gl.readPixels(0, 0, W / 2, H, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(out.buffer));
    if (gl.getError() !== gl.NO_ERROR) throw new Error('The GPU could not build the modulation plane');
    out.eUnit = MOD_UNIT;
    return out;
  } finally {
    for (const t of owned) gl.deleteTexture(t);
    gl.disable(gl.BLEND);
  }
}
