// Enlarging a picture with a super resolution model (core/upscalemodels.js), tile by tile so any picture size fits in the card's memory. Every tile is the same size
// (the model compiles once): a window of `tile` pixels whose outer `pad` pixels are context only, taken with the picture's edge pixels repeated where the window leaves
// the picture, and only the middle is kept. `run(chw)` takes one window as a float32 [3, tile, tile] array (RGB 0..1) and returns [3, tile * scale, tile * scale].

import { fitsMemory, memoryProblem, modelRam } from './memorybudget.js';
import { debugFlags } from './debugflags.js';

export const AI_TILE = 256;
export const AI_PAD = 16;
// A smaller tile where the video memory limit is low (Settings > Memory).
const SMALL_TILE = 128;
const LOW_VRAM = 1.5 * 1024 ** 3;
// The result (scale squared times as many pixels) is one array: never more than this, and never more than the RAM limit.
const MAX_RESULT_BYTES = 1.5 * 1024 ** 3;

// rgb: Uint16Array (w * h * 3, interleaved, 0..65535). Returns the enlarged picture the same way (w*scale by h*scale).
export async function tiledUpscale(rgb, w, h, scale, run, { tile = AI_TILE, pad = AI_PAD, onProgress = () => {} } = {}) {
  const core = tile - 2 * pad;
  const W = w * scale;
  const H = h * scale;
  const out = new Uint16Array(W * H * 3);
  const cols = Math.ceil(w / core);
  const rows = Math.ceil(h / core);
  const plane = tile * tile;
  const chw = new Float32Array(3 * plane);
  const xs = new Int32Array(tile);
  let done = 0;
  for (let ty = 0; ty < rows; ty++) {
    for (let tx = 0; tx < cols; tx++) {
      const x0 = tx * core;
      const y0 = ty * core;
      for (let i = 0; i < tile; i++) xs[i] = Math.min(w - 1, Math.max(0, x0 - pad + i));
      for (let j = 0; j < tile; j++) {
        const row = Math.min(h - 1, Math.max(0, y0 - pad + j)) * w;
        for (let i = 0; i < tile; i++) {
          const s = 3 * (row + xs[i]);
          const d = j * tile + i;
          chw[d] = rgb[s] / 65535;
          chw[plane + d] = rgb[s + 1] / 65535;
          chw[2 * plane + d] = rgb[s + 2] / 65535;
        }
      }
      const res = await run(chw);
      const T = tile * scale;
      const cw = Math.min(core, w - x0);
      const ch = Math.min(core, h - y0);
      for (let j = 0; j < ch * scale; j++) {
        const oy = y0 * scale + j;
        const sy = pad * scale + j;
        for (let i = 0; i < cw * scale; i++) {
          const sx = pad * scale + i;
          const o = 3 * (oy * W + x0 * scale + i);
          const s = sy * T + sx;
          for (let c = 0; c < 3; c++) {
            const v = res[c * T * T + s];
            out[o + c] = v <= 0 ? 0 : v >= 1 ? 65535 : Math.round(v * 65535);
          }
        }
      }
      done++;
      onProgress(done / (cols * rows));
    }
  }
  return out;
}

const sessions = new Map();

async function hasWebGpu() {
  try {
    return !!(typeof navigator !== 'undefined' && navigator.gpu && (await navigator.gpu.requestAdapter()));
  } catch {
    return false;
  }
}

export const aiUpscaleAvailable = () => hasWebGpu();

// A model's ONNX Runtime session (on the card, WebGPU); loaded once per model.
export async function loadUpscaleSession(model, readModel) {
  if (!sessions.has(model.id)) {
    sessions.set(model.id, (async () => {
      if (!(await hasWebGpu()) && !debugFlags().aiCpu) throw new Error('Upscaling models need a graphics card with WebGPU.');
      const ort = await import('../../vendor/ort/ort.webgpu.min.mjs');
      ort.env.wasm.wasmPaths = new URL('../../vendor/ort/', import.meta.url).href;
      ort.env.wasm.numThreads = 1;
      const bytes = await readModel(model);
      const gpu = await hasWebGpu();
      const session = await ort.InferenceSession.create(bytes, { executionProviders: [gpu ? 'webgpu' : 'wasm'] });
      return { ort, session };
    })().catch((e) => {
      sessions.delete(model.id);
      throw e;
    }));
  }
  return sessions.get(model.id);
}

// Enlarges `rgb` (see tiledUpscale) with `model`. Returns { rgb, width, height }.
export async function aiUpscale(model, readModel, rgb, w, h, onProgress = () => {}) {
  const need = modelRam(w, h, model.scale);
  if (need > MAX_RESULT_BYTES * 2 || !fitsMemory('ram', need)) {
    throw new Error(memoryProblem('ram', need, `Enlarging ${w}×${h} with a model`, 'Lower the render size or the Photo Size, or raise the limit.'));
  }
  onProgress('Loading the upscaling model', 0);
  const { ort, session } = await loadUpscaleSession(model, readModel);
  const tile = fitsMemory('vram', LOW_VRAM) ? AI_TILE : SMALL_TILE;
  const run = async (chw) => {
    const out = await session.run({ input: new ort.Tensor('float32', chw, [1, 3, tile, tile]) });
    return out.output.data;
  };
  const big = await tiledUpscale(rgb, w, h, model.scale, run, { tile, onProgress: (p) => onProgress(`Enlarging with ${model.name}`, p) });
  return { rgb: big, width: w * model.scale, height: h * model.scale };
}

