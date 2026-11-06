// A monocular depth model's result (core/depthmodels.js) used with the measured depth: the model sees one picture and gives a relative depth with clean object edges and
// an answer on glossy or blank surfaces; the measurement gives the real scale. The model's depth is fitted to the measurement (a straight line through the pixels both
// trust) and the two are mixed by a setting.

import { aiUpscaleAvailable } from './aiupscale.js';

const sessions = new Map();

async function session(model, readModel) {
  if (!sessions.has(model.id)) {
    sessions.set(model.id, (async () => {
      const ort = await import('../../vendor/ort/ort.webgpu.min.mjs');
      ort.env.wasm.wasmPaths = new URL('../../vendor/ort/', import.meta.url).href;
      ort.env.wasm.numThreads = 1;
      const bytes = await readModel(model);
      let s = null;
      if (await aiUpscaleAvailable()) {
        try {
          s = await ort.InferenceSession.create(bytes, { executionProviders: ['webgpu'] });
        } catch {
          s = null;
        }
      }
      s ??= await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'] });
      return { ort, session: s };
    })().catch((e) => {
      sessions.delete(model.id);
      throw e;
    }));
  }
  return sessions.get(model.id);
}

// The model's input: the picture (linear RGB, w x h) exposed so its 99.5th percentile of brightness is white, as sRGB, squashed to S x S and normalised (planar RGB).
export function modelInput(model, rgb, w, h) {
  const n = w * h;
  const luma = new Float32Array(n);
  for (let i = 0; i < n; i++) luma[i] = 0.2126 * rgb[3 * i] + 0.7152 * rgb[3 * i + 1] + 0.0722 * rgb[3 * i + 2];
  const sorted = Float32Array.from(luma).sort();
  const white = Math.max(1e-4, sorted[Math.floor(n * 0.995)]);
  const S = model.input;
  const out = new Float32Array(3 * S * S);
  for (let y = 0; y < S; y++) {
    const sy = Math.min(h - 1, ((y + 0.5) * h) / S - 0.5);
    const y0 = Math.max(0, Math.floor(sy));
    const y1 = Math.min(h - 1, y0 + 1);
    const ay = Math.max(0, sy - y0);
    for (let x = 0; x < S; x++) {
      const sx = Math.min(w - 1, ((x + 0.5) * w) / S - 0.5);
      const x0 = Math.max(0, Math.floor(sx));
      const x1 = Math.min(w - 1, x0 + 1);
      const ax = Math.max(0, sx - x0);
      for (let c = 0; c < 3; c++) {
        const g = (xx, yy) => rgb[3 * (yy * w + xx) + c];
        const v = (g(x0, y0) * (1 - ax) + g(x1, y0) * ax) * (1 - ay) + (g(x0, y1) * (1 - ax) + g(x1, y1) * ax) * ay;
        const srgb = Math.min(1, Math.max(0, v / white)) ** (1 / 2.2);
        out[c * S * S + y * S + x] = (srgb - model.mean[c]) / model.std[c];
      }
    }
  }
  return out;
}

// Bilinear resample of a one-channel S x S map to w x h.
export function resampleMap(map, S, w, h) {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const sy = Math.min(S - 1, Math.max(0, ((y + 0.5) * S) / h - 0.5));
    const y0 = Math.floor(sy);
    const y1 = Math.min(S - 1, y0 + 1);
    const ay = sy - y0;
    for (let x = 0; x < w; x++) {
      const sx = Math.min(S - 1, Math.max(0, ((x + 0.5) * S) / w - 0.5));
      const x0 = Math.floor(sx);
      const x1 = Math.min(S - 1, x0 + 1);
      const ax = sx - x0;
      out[y * w + x] = (map[y0 * S + x0] * (1 - ax) + map[y0 * S + x1] * ax) * (1 - ay) + (map[y1 * S + x0] * (1 - ax) + map[y1 * S + x1] * ax) * ay;
    }
  }
  return out;
}

// The model's relative depth for the picture (linear RGB, w x h), at w x h. Larger is nearer.
export async function runDepthModel(model, readModel, rgb, w, h, onProgress = () => {}) {
  onProgress('Loading the depth model', 0.1);
  const { ort, session: s } = await session(model, readModel);
  onProgress('Running the depth model', 0.4);
  const S = model.input;
  const out = await s.run({ [model.inputName]: new ort.Tensor('float32', modelInput(model, rgb, w, h), [1, 3, S, S]) });
  const data = out[s.outputNames[0]].data;
  onProgress('Running the depth model', 0.9);
  return resampleMap(data, S, w, h);
}

// The straight line `measured = a * rel + b` through the pixels, robust to the pixels where the two disagree (iteratively reweighted least squares with a Tukey weight):
// the model's relative depth in the measurement's units. `confidence` (0..1, optional) weighs the pixels the measurement trusts. Returns { a, b, spread } or null when
// the model has nothing to fit (a flat picture).
export function fitModelDepth(rel, measured, confidence, w, h) {
  const n = w * h;
  const step = Math.max(1, Math.floor(Math.sqrt(n / 20000)));
  const idx = [];
  for (let y = 0; y < h; y += step) for (let x = 0; x < w; x += step) idx.push(y * w + x);
  const base = idx.map((i) => (confidence ? 0.05 + confidence[i] : 1));
  let wt = base.slice();
  let a = 0;
  let b = 0;
  let spread = 0;
  for (let iter = 0; iter < 8; iter++) {
    let sw = 0;
    let sx = 0;
    let sy = 0;
    let sxx = 0;
    let sxy = 0;
    idx.forEach((i, k) => {
      const wk = wt[k];
      sw += wk;
      sx += wk * rel[i];
      sy += wk * measured[i];
      sxx += wk * rel[i] * rel[i];
      sxy += wk * rel[i] * measured[i];
    });
    const den = sw * sxx - sx * sx;
    if (!(den > 1e-12)) return null;
    a = (sw * sxy - sx * sy) / den;
    b = (sy - a * sx) / sw;
    const res = idx.map((i) => Math.abs(measured[i] - (a * rel[i] + b)));
    const sorted = Float32Array.from(res).sort();
    spread = Math.max(1e-6, 1.4826 * sorted[sorted.length >> 1]);
    wt = res.map((r, k) => {
      const u = r / (4.685 * spread);
      return u >= 1 ? 0 : base[k] * (1 - u * u) ** 2;
    });
  }
  return { a, b, spread };
}

// The measured depth mixed with the model's, fitted: `blend` 0 is the measurement, 1 the model alone. The model's values stay within the measurement's range (a little
// beyond it), so a far outlier in the model cannot throw a pixel off the scale.
export function fuseModelDepth(measured, rel, fit, blend) {
  if (!fit || !(blend > 0)) return measured;
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of measured) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const pad = 0.1 * (hi - lo);
  const out = new Float32Array(measured.length);
  for (let i = 0; i < out.length; i++) {
    const m = Math.min(hi + pad, Math.max(lo - pad, fit.a * rel[i] + fit.b));
    out[i] = measured[i] + (m - measured[i]) * blend;
  }
  return out;
}
