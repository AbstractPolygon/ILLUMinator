// The engine's automatic white balance (LFE::AWB2, read from tnt.exe and checked against the running engine, see docs/lytro-re-notes.md).
// The engine does not use the camera's own gains: it measures the picture again. The picture is one colour sample per lens (the raw
// picture at the lens centre, bilinear between the four pixels, divided by the modulation frame, scattered bilinearly onto a raster of one
// texel per lens pitch), the statistics are a weighted mean of the colours picked by a 64 x 64 table over chroma, and a correction by
// colour temperature follows.
import { AWB_LUT1, AWB_LUT2, AWB_CFG as C, AWB_DEFAULT_RESPONSE, AWB_TARGET_GAINS, AWB_CCT_TABLE } from './enginewb-tables.js';

const LUT1 = Uint8Array.from(AWB_LUT1, (ch) => parseInt(ch, 16));
const LUT2 = Uint8Array.from(AWB_LUT2, (ch) => parseInt(ch, 16));

// The engine's colour units (raw less black over 1023, divided by the modulation frame normalised by its mean per colour): one RGBA texel per
// lens (alpha is BT.601 luma). `grid` is the engine's lens lattice in pixel indices (pitch, rowStep, rotation, ox, oy).
export function awbImage(raw, modulation, cam, dev, grid, W, H) {
  const { width, height } = cam;
  const cfa = dev.cfa;
  const mean = [0, 0, 0];
  const count = [0, 0, 0];
  for (let y = 0; y < height; y++) {
    const row = cfa[y & 1];
    for (let x = 0; x < width; x++) {
      const ch = row[x & 1];
      mean[ch] += Math.max(0, modulation[y * width + x] - dev.black[ch]);
      count[ch]++;
    }
  }
  for (let c = 0; c < 3; c++) mean[c] = mean[c] / count[c] || 1;
  const value = (x, y) => {
    const ch = cfa[y & 1][x & 1];
    const i = y * width + x;
    const m = Math.max(0, modulation[i] - dev.black[ch]) / mean[ch];
    return m > 0.02 ? Math.max(0, raw[i] - dev.black[ch]) / m : 0;
  };
  const sum = new Float64Array(4 * W * H);
  const wt = new Float64Array(4 * W * H);
  const { pitch, rowStep, rotation, ox, oy } = grid;
  const co = Math.cos(rotation);
  const si = Math.sin(rotation);
  const rows = Math.ceil(height / rowStep) + 4;
  const cols = Math.ceil(width / pitch) + 4;
  const bsum = [0, 0, 0, 0];
  const bwt = [0, 0, 0, 0];
  for (let r = -2; r < rows; r++) {
    for (let c = -2; c < cols; c++) {
      const lx = c * pitch + (r & 1) * pitch * 0.5;
      const ly = r * rowStep;
      const sx = ox + co * lx - si * ly;
      const sy = oy + si * lx + co * ly;
      if (!(sx > 1 && sy > 1 && sx < width - 2 && sy < height - 2)) continue;
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const fx = sx - x0;
      const fy = sy - y0;
      bsum.fill(0);
      bwt.fill(0);
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const w = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy);
          const x = x0 + dx;
          const y = y0 + dy;
          const k = ((y & 1) << 1) | (x & 1);
          bsum[k] += w * value(x, y);
          bwt[k] += w;
        }
      }
      // the lens lands on the raster at (sx, sy) / pitch, texel centres at integers + 0.5
      const px = (sx * W) / width - 0.5;
      const py = (sy * H) / height - 0.5;
      const X0 = Math.floor(px);
      const Y0 = Math.floor(py);
      const FX = px - X0;
      const FY = py - Y0;
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const X = Math.min(W - 1, Math.max(0, X0 + dx));
          const Y = Math.min(H - 1, Math.max(0, Y0 + dy));
          const w = (dx ? FX : 1 - FX) * (dy ? FY : 1 - FY);
          const o = 4 * (Y * W + X);
          for (let k = 0; k < 4; k++) {
            sum[o + k] += w * bsum[k];
            wt[o + k] += w * bwt[k];
          }
        }
      }
    }
  }
  const img = new Float32Array(4 * W * H);
  const chOf = (k) => cfa[k >> 1][k & 1];
  for (let p = 0; p < W * H; p++) {
    const rgb = [0, 0, 0];
    const n = [0, 0, 0];
    for (let k = 0; k < 4; k++) {
      const v = wt[4 * p + k] > 1e-12 ? sum[4 * p + k] / wt[4 * p + k] : 0;
      rgb[chOf(k)] += v;
      n[chOf(k)]++;
    }
    for (let c = 0; c < 3; c++) img[4 * p + c] = n[c] ? rgb[c] / n[c] / 1023 : 0;
    img[4 * p + 3] = 0.299 * img[4 * p] + 0.587 * img[4 * p + 1] + 0.114 * img[4 * p + 2];
  }
  return img;
}

function gaussian(img, W, H, sigma) {
  if (!(sigma > 0)) return img;
  const r = Math.max(1, Math.floor(4 * sigma + 0.5));
  const k = new Float64Array(2 * r + 1);
  let s = 0;
  for (let i = -r; i <= r; i++) s += k[i + r] = Math.exp((-i * i) / (2 * sigma * sigma));
  for (let i = 0; i < k.length; i++) k[i] /= s;
  const tmp = new Float32Array(img.length);
  const out = new Float32Array(img.length);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      for (let c = 0; c < 4; c++) {
        let a = 0;
        for (let t = -r; t <= r; t++) a += k[t + r] * img[4 * (y * W + Math.min(W - 1, Math.max(0, x + t))) + c];
        tmp[4 * (y * W + x) + c] = a;
      }
    }
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      for (let c = 0; c < 4; c++) {
        let a = 0;
        for (let t = -r; t <= r; t++) a += k[t + r] * tmp[4 * (Math.min(H - 1, Math.max(0, y + t)) * W + x) + c];
        out[4 * (y * W + x) + c] = a;
      }
    }
  }
  return out;
}

// piecewise linear table lookup (ratio r / b -> cct), clamped at both ends
export function awbCct(gains) {
  const t = AWB_CCT_TABLE;
  const ratio = gains[0] / gains[2];
  if (ratio < t[0][0]) return t[0][1];
  if (ratio >= t[t.length - 1][0]) return t[t.length - 1][1];
  for (let i = 0; i < t.length - 1; i++) {
    if (ratio >= t[i][0] && ratio < t[i + 1][0]) {
      const f = (ratio - t[i][0]) / (t[i + 1][0] - t[i][0]);
      return (1 - f) * t[i][1] + f * t[i + 1][1];
    }
  }
  return t[0][1];
}

// piecewise linear in cct over knots, clamped
function byKnots(values, knots, cct) {
  if (cct < knots[0]) return values[0];
  for (let i = 0; i < knots.length - 1; i++) if (cct >= knots[i] && cct < knots[i + 1]) {
    const f = (cct - knots[i]) / (knots[i + 1] - knots[i]);
    return (1 - f) * values[i] + f * values[i + 1];
  }
  return values[knots.length - 1];
}

// The stages after the weighted mean: the temperature, the shift for cool light and the correction by temperature, then the gains over the smallest.
export function awbPost(gains, w) {
  const cct = awbCct(gains);
  if (C.highBrightness) {
    // the engine's shift for bright, cool light: a trapezoid of cct towards the target gains, scaled by the low light weight
    const k = C.shiftKnots;
    let f = 0;
    if (cct > k[0] && cct < k[1]) f = ((cct - k[0]) / (k[1] - k[0])) * C.shiftAmount;
    else if (cct >= k[1] && cct < k[2]) f = (1 - (cct - k[1]) / (k[2] - k[1])) * C.shiftAmount;
    else if (cct >= k[3] && cct < k[4]) f = ((cct - k[3]) / (k[4] - k[3])) * C.shiftAmount;
    else if (cct >= k[4] && cct < k[5]) f = (1 - (cct - k[4]) / (k[5] - k[4])) * C.shiftAmount;
    gains = gains.map((g, i) => g + (AWB_TARGET_GAINS[i] - g) * f * w);
  }
  if (C.correction) {
    const T = C.tables;
    const add = [0, 1, 2].map((i) => byKnots(T.cold[i].map((c, j) => (T.hot[i][j] - c) * w + c), T.knots, cct));
    gains = gains.map((g, i) => g + add[i]);
  }
  const m = Math.min(...gains);
  gains = m > 0 ? gains.map((g) => g / m) : [1, 1, 1];
  return { gains, cct };
}

// img: awbImage's RGBA texels. exposure (s) and gain: the capture's; responses: the photo's normalizedResponses [r, g, b]; camera: its gains [r, g, b];
// mode: the engine's region of interest (1 for the full frame). Returns { gains, lut, cct, weight } with the gains normalised to the smallest.
export function engineAwb({ image, W, H, exposure, gain, responses, camera, mode = 1 }) {
  const low = exposure * gain;
  const w = low < C.lowLight[0] ? 1 : low >= C.lowLight[1] ? 0 : (C.lowLight[1] - low) / (C.lowLight[1] - C.lowLight[0]);
  const sigma = gain < C.sigmaGain[1] ? Math.max(C.sigmaValue[0], C.sigmaValue[0] + ((gain - C.sigmaGain[0]) * (C.sigmaValue[1] - C.sigmaValue[0])) / (C.sigmaGain[1] - C.sigmaGain[0])) : C.sigmaValue[1];
  const I = C.noiseReduction ? gaussian(image, W, H, sigma) : image;
  const scale = C.moduleCorrection ? [AWB_DEFAULT_RESPONSE[0] / responses[0], AWB_DEFAULT_RESPONSE[1] / responses[1], AWB_DEFAULT_RESPONSE[2] / responses[2]] : [1, 1, 1];
  const Hc = H * C.roiFraction;
  const Wc = W * C.roiFraction;
  const sums = [0, 0, 0];
  let total = 0;
  const range = C.vRamp[1] - C.vRamp[0];
  for (let y = 0; y < H; y++) {
    let roi = 0;
    if (mode === 1 || mode === 2) roi = Math.max(0, (Hc - y) / Hc);
    else if (mode === 3 || mode === 4) roi = Math.max(0, (y - Hc) / Hc);
    for (let x = 0; x < W; x++) {
      let r = roi;
      if (mode === 5 || mode === 6) r = Math.max(0, (Wc - x) / Wc);
      else if (mode === 7 || mode === 8) r = Math.max(0, (x - Wc) / Wc);
      const o = 4 * (y * W + x);
      const Y = I[o + 3];
      if (Y < C.lumaMin || Y > C.lumaMax) continue;
      const lr = Math.log2(I[o] * scale[0]);
      const lg = Math.log2(I[o + 1] * scale[1]);
      const lb = Math.log2(I[o + 2] * scale[2]);
      const u = Math.floor((lr + lb - 2 * lg + C.u[0]) * C.u[1]);
      const v = Math.floor((lb - lr + C.v[0]) * C.v[1]);
      if (!(u >= 0 && u < 64 && v >= 0 && v < 64)) continue;
      const idx = (63 - v) * 64 + u;
      let wt = C.blendLut2 ? LUT1[idx] * (1 - w) + LUT2[idx] * w : LUT1[idx];
      const ramp = v >= C.vRamp[1] ? 1 : v >= C.vRamp[0] ? (v - C.vRamp[0]) / range : 0;
      wt *= 1 - ramp * r;
      sums[0] += wt * I[o];
      sums[1] += wt * I[o + 1];
      sums[2] += wt * I[o + 2];
      total += wt;
    }
  }
  const weight = total * 0.0625;
  let gains = camera.slice();
  let lut = null;
  if (C.weightLow > 0 && weight > C.weightLow && sums.every((s) => s > 0)) {
    const mean = sums.map((s) => s / total);
    const top = Math.max(...mean);
    lut = mean.map((m) => top / m);
    gains = lut.slice();
    if (weight < C.weightHigh) {
      const t = (weight - C.weightLow) / (C.weightHigh - C.weightLow);
      gains = gains.map((g, i) => t * g + (1 - t) * camera[i]);
    }
  }
  const fin = awbPost(gains, w);
  return { gains: fin.gains, lut, cct: fin.cct, weight };
}
