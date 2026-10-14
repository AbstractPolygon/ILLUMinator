// FSR 1 upscaling on the CPU: EASU (edge-adaptive spatial upsampling) and
// RCAS (robust contrast-adaptive sharpening), ported from AMD FidelityFX
// Super Resolution 1.0 (ffx_fsr1.h). The GPU version (gpu/upscale.js) does
// the same math; this one runs where WebGL 2 is not available.
//
// FidelityFX Super Resolution 1.0
// Copyright (c) 2021 Advanced Micro Devices, Inc. All rights reserved.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the "Software"),
// to deal in the Software without restriction, including without limitation
// the rights to use, copy, modify, merge, publish, distribute, sublicense,
// and/or sell copies of the Software, and to permit persons to whom the
// Software is furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
// FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
// DEALINGS IN THE SOFTWARE.

// RCAS never sharpens past this (FSR_RCAS_LIMIT).
const RCAS_LIMIT = 0.25 - 1 / 16;

// The Upscaling Sharpen setting (0..1) as RCAS sharpness: 0 is none, the
// default 0.25 is gentle, 1 is RCAS at its strongest (0 stops).
export function rcasStrength(sharpen) {
  return sharpen > 0 ? 2 ** (-2 * (1 - sharpen)) : 0;
}

// EASU: enlarges `img` ({ width, height, data: RGBA bytes }) to W x H (each
// at least the input size). Returns RGB floats 0..1, 4 per pixel.
export function easu(img, W, H) {
  const { width: w, height: h, data } = img;
  const out = new Float32Array(W * H * 4);
  // Input as floats 0..1 and luma (r/2 + g + b/2, as FSR).
  const px = new Float32Array(w * h * 3);
  const lum = new Float32Array(w * h);
  for (let i = 0, j = 0; i < w * h; i++, j += 4) {
    const r = data[j] / 255;
    const g = data[j + 1] / 255;
    const b = data[j + 2] / 255;
    px[i * 3] = r;
    px[i * 3 + 1] = g;
    px[i * 3 + 2] = b;
    lum[i] = r * 0.5 + g + b * 0.5;
  }
  const at = (x, y) => (y < 0 ? 0 : y >= h ? h - 1 : y) * w + (x < 0 ? 0 : x >= w ? w - 1 : x);
  // The 12 taps around the sample, relative to f (its top-left neighbor):
  //     b c
  //   e f g h
  //   i j k l
  //     n o
  const TAPS = [[0, -1], [1, -1], [-1, 0], [0, 0], [1, 0], [2, 0], [-1, 1], [0, 1], [1, 1], [2, 1], [0, 2], [1, 2]];
  const idx = new Int32Array(12);
  const L = new Float32Array(12);
  const sx = w / W;
  const sy = h / H;
  for (let oy = 0; oy < H; oy++) {
    const py = (oy + 0.5) * sy - 0.5;
    const fy = Math.floor(py);
    const ty = py - fy;
    for (let ox = 0; ox < W; ox++) {
      const pxx = (ox + 0.5) * sx - 0.5;
      const fx = Math.floor(pxx);
      const tx = pxx - fx;
      for (let t = 0; t < 12; t++) {
        idx[t] = at(fx + TAPS[t][0], fy + TAPS[t][1]);
        L[t] = lum[idx[t]];
      }
      // Direction and edge length from the 4 bilinear neighbors f g j k,
      // each with its cross of luma (top, left, center, right, bottom).
      let dirX = 0;
      let dirY = 0;
      let len = 0;
      const set = (wgt, a, bl, c, d, e) => {
        const dc = d - c;
        const cb = c - bl;
        let lenX = Math.max(Math.abs(dc), Math.abs(cb));
        lenX = lenX > 0 ? 1 / lenX : 0;
        const dx = d - bl;
        dirX += dx * wgt;
        lenX = Math.min(1, Math.abs(dx) * lenX);
        len += lenX * lenX * wgt;
        const ec = e - c;
        const ca = c - a;
        let lenY = Math.max(Math.abs(ec), Math.abs(ca));
        lenY = lenY > 0 ? 1 / lenY : 0;
        const dy = e - a;
        dirY += dy * wgt;
        lenY = Math.min(1, Math.abs(dy) * lenY);
        len += lenY * lenY * wgt;
      };
      // b0 c1 e2 f3 g4 h5 i6 j7 k8 l9 n10 o11
      set((1 - tx) * (1 - ty), L[0], L[2], L[3], L[4], L[7]);
      set(tx * (1 - ty), L[1], L[3], L[4], L[5], L[8]);
      set((1 - tx) * ty, L[3], L[6], L[7], L[8], L[10]);
      set(tx * ty, L[4], L[7], L[8], L[9], L[11]);
      let dr = dirX * dirX + dirY * dirY;
      if (dr < 1 / 32768) {
        dirX = 1;
        dirY = 0;
        dr = 1;
      } else {
        dr = 1 / Math.sqrt(dr);
        dirX *= dr;
        dirY *= dr;
      }
      len = len * 0.5;
      len *= len;
      const stretch = (dirX * dirX + dirY * dirY) / Math.max(Math.abs(dirX), Math.abs(dirY));
      const len2x = 1 + (stretch - 1) * len;
      const len2y = 1 - 0.5 * len;
      const lob = 0.5 + (1 / 4 - 0.04 - 0.5) * len;
      const clp = 1 / lob;
      let ar = 0;
      let ag = 0;
      let ab = 0;
      let aw = 0;
      for (let t = 0; t < 12; t++) {
        const offX = TAPS[t][0] - tx;
        const offY = TAPS[t][1] - ty;
        const vx = (offX * dirX + offY * dirY) * len2x;
        const vy = (offX * -dirY + offY * dirX) * len2y;
        const d2 = Math.min(vx * vx + vy * vy, clp);
        let wB = 2 / 5 * d2 - 1;
        let wA = lob * d2 - 1;
        wB *= wB;
        wA *= wA;
        wB = 25 / 16 * wB - (25 / 16 - 1);
        const wt = wB * wA;
        const k = idx[t] * 3;
        ar += px[k] * wt;
        ag += px[k + 1] * wt;
        ab += px[k + 2] * wt;
        aw += wt;
      }
      // Clamped to the 4 nearest inputs (no ringing).
      const o = (oy * W + ox) * 4;
      for (let ch = 0; ch < 3; ch++) {
        const f = px[idx[3] * 3 + ch];
        const g = px[idx[4] * 3 + ch];
        const j = px[idx[7] * 3 + ch];
        const k = px[idx[8] * 3 + ch];
        const lo = Math.min(f, g, j, k);
        const hi = Math.max(f, g, j, k);
        const v = (ch === 0 ? ar : ch === 1 ? ag : ab) / aw;
        out[o + ch] = v < lo ? lo : v > hi ? hi : v;
      }
      out[o + 3] = 1;
    }
  }
  return out;
}

// RCAS: sharpens RGB floats 0..1 (4 per pixel, W x H) by `sharpness`
// (rcasStrength) and returns RGBA bytes.
export function rcas(src, W, H, sharpness) {
  const out = new Uint8ClampedArray(W * H * 4);
  const at = (x, y) => ((y < 0 ? 0 : y >= H ? H - 1 : y) * W + (x < 0 ? 0 : x >= W ? W - 1 : x)) * 4;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const e = at(x, y);
      const o = e;
      if (!sharpness) {
        for (let ch = 0; ch < 3; ch++) out[o + ch] = src[e + ch] * 255 + 0.5;
        out[o + 3] = 255;
        continue;
      }
      const b = at(x, y - 1);
      const d = at(x - 1, y);
      const f = at(x + 1, y);
      const hh = at(x, y + 1);
      let lobe = -Infinity;
      for (let ch = 0; ch < 3; ch++) {
        const mn = Math.min(src[b + ch], src[d + ch], src[f + ch], src[hh + ch]);
        const mx = Math.max(src[b + ch], src[d + ch], src[f + ch], src[hh + ch]);
        const ev = src[e + ch];
        const hitMin = Math.min(mn, ev) / (4 * mx || 1e-6);
        const hitMax = (1 - Math.max(mx, ev)) / (4 * mn - 4 || -1e-6);
        lobe = Math.max(lobe, Math.max(-hitMin, hitMax));
      }
      lobe = Math.max(-RCAS_LIMIT, Math.min(lobe, 0)) * sharpness;
      const rcp = 1 / (4 * lobe + 1);
      for (let ch = 0; ch < 3; ch++) {
        const v = (lobe * (src[b + ch] + src[d + ch] + src[f + ch] + src[hh + ch]) + src[e + ch]) * rcp;
        out[o + ch] = v * 255 + 0.5;
      }
      out[o + 3] = 255;
    }
  }
  return out;
}
