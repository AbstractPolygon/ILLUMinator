// Decoding and rendering run here so the UI stays responsive.
// Requests: { id, type, ...args }. Replies: { id, type: 'result' | 'progress' | 'frame' | 'error', ... }.

import { decodeLightField } from './core/decode.js';
import { normalizeGrid, measureGrid, calibrateGrid, lensCenters } from './core/lenslet.js';
import {
  buildSampler, renderView, makeDevelopParams, apertureSamples, refocus,
  colorMatrix, autoExposure, toneMap, sensorToOutput,
} from './core/render.js';
import { makeSyntheticLfr } from './core/synthetic.js';

const state = {
  lf: null,
  sampler: null,
  dev: null,
  settings: { ev: 0, saturation: 1, useCcm: true, autoWb: false, detail: 1 },
  baseExposure: 1,
  matrix: null,
  wbGains: [1, 1, 1],
  centerMeans: [1, 1, 1],
  refocusViews: null,
  jobs: {},
  scratch: null,
};

const VIEW_SCALE = 8192;

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function post(msg, transfer) {
  self.postMessage(msg, transfer || []);
}

function channelMeans(rgb) {
  // Ignore the darkest border pixels to keep vignetting out of the estimate.
  const m = [0, 0, 0];
  const n = rgb.length / 3;
  for (let i = 0; i < rgb.length; i += 3) {
    m[0] += rgb[i];
    m[1] += rgb[i + 1];
    m[2] += rgb[i + 2];
  }
  return m.map((v) => Math.max(1e-6, v / Math.max(1, n)));
}

function apertureRadius() {
  return state.lf ? state.lf.grid.pitch * 0.32 : 0;
}

// Views away from the centre are darker and slightly tinted because of
// microlens vignetting; scale each channel to match the centre view.
function equalize(rgb) {
  const m = channelMeans(rgb);
  const g = state.centerMeans.map((c, i) => c / m[i]);
  for (let i = 0; i < rgb.length; i += 3) {
    rgb[i] *= g[0];
    rgb[i + 1] *= g[1];
    rgb[i + 2] *= g[2];
  }
  return rgb;
}

function render(u, v) {
  const { lf, dev, sampler } = state;
  const per = sampler.lenses.cx.length * 3;
  if (!state.scratch || state.scratch.length !== per) state.scratch = new Float32Array(per);
  return renderView(lf.raw, lf.cam, dev, sampler, u, v, state.scratch);
}

function updateColor() {
  const { lf } = state;
  const center = render(0, 0);
  state.centerMeans = channelMeans(center);
  const s = state.settings;
  state.wbGains = s.autoWb ? state.centerMeans.map((m) => state.centerMeans[1] / m) : [1, 1, 1];
  const ccm = colorMatrix(lf.cam, s);
  // Fold the white balance gains into the matrix columns.
  state.matrix = ccm.map((v, i) => v * state.wbGains[i % 3]);
  state.baseExposure = autoExposure(center, state.matrix);
}

function toPixels(rgb) {
  const exposure = state.baseExposure * Math.pow(2, state.settings.ev);
  return toneMap(rgb, state.matrix, exposure);
}

function frameMessage(id, index, rgb) {
  const pixels = toPixels(rgb);
  post({ id, type: 'frame', index, width: state.sampler.outW, height: state.sampler.outH, pixels: pixels.buffer }, [pixels.buffer]);
}

function rebuildSampler() {
  const { lf } = state;
  state.sampler = buildSampler(lf.grid, lf.cam, state.settings.detail);
  state.refocusViews = null;
  updateColor();
}

function summary() {
  const { lf, sampler } = state;
  const base = {
    hasRaw: !!(lf && lf.raw),
    metadata: lf.metadata,
    privateMetadata: lf.privateMetadata,
    stacks: lf.stacks.map((s) => ({
      kind: s.kind,
      images: s.images.map(({ lambda, coord, mime, bytes, width, height }) => ({ lambda, coord, mime, bytes, width, height })),
    })),
  };
  if (!base.hasRaw) return base;
  const { cam } = lf;
  return {
    ...base,
    cam: { model: cam.model, make: cam.make, firmware: cam.firmware, width: cam.width, height: cam.height, bits: cam.bits, upperLeft: cam.upperLeft, capture: cam.capture, hasCcm: !!cam.ccm },
    grid: lf.grid,
    metadataGrid: lf.metadataGrid,
    gridQuality: lf.gridQuality,
    width: sampler.outW,
    height: sampler.outH,
    radius: apertureRadius(),
    settings: state.settings,
  };
}

function requireRaw() {
  if (!state.lf || !state.lf.raw) throw new Error('No light field loaded');
}

async function open({ id, bytes, synthetic }) {
  state.lf = null;
  state.refocusViews = null;
  for (const k of Object.keys(state.jobs)) state.jobs[k] = null;
  const onProgress = (stage, p) => post({ id, type: 'progress', stage, progress: p });
  let data = bytes ? new Uint8Array(bytes) : null;
  if (synthetic) {
    onProgress('Generating sample', 0);
    data = await makeSyntheticLfr(synthetic);
  }
  state.lf = await decodeLightField(data, { onProgress });
  if (state.lf.raw) {
    state.dev = makeDevelopParams(state.lf.cam);
    rebuildSampler();
  }
  return summary();
}

async function frames({ id, job, path }) {
  requireRaw();
  state.jobs.frames = job;
  for (let i = 0; i < path.length; i++) {
    if (state.jobs.frames !== job) return { cancelled: true };
    frameMessage(id, i, equalize(render(path[i].u, path[i].v)));
    await tick();
  }
  return { done: true };
}

async function ensureRefocusViews(id, job) {
  if (state.refocusViews) return true;
  const radius = apertureRadius();
  const samples = apertureSamples(radius, 7);
  const views = [];
  for (let i = 0; i < samples.length; i++) {
    if (state.jobs.refocus !== job) return false;
    const { u, v } = samples[i];
    // Stored as 16 bit to keep ~37 full views affordable in memory.
    const rgb = equalize(render(u, v));
    const q = new Uint16Array(rgb.length);
    for (let k = 0; k < rgb.length; k++) q[k] = Math.min(65535, rgb[k] * VIEW_SCALE + 0.5);
    views.push({ u, v, rgb: q, gain: 1 / VIEW_SCALE, detail: state.settings.detail });
    post({ id, type: 'progress', stage: 'Preparing refocus', progress: (i + 1) / samples.length });
    await tick();
  }
  state.refocusViews = views;
  return true;
}

async function refocusFrames({ id, job, alphas }) {
  requireRaw();
  state.jobs.refocus = job;
  if (!(await ensureRefocusViews(id, job))) return { cancelled: true };
  const { outW, outH } = state.sampler;
  for (let i = 0; i < alphas.length; i++) {
    if (state.jobs.refocus !== job) return { cancelled: true };
    frameMessage(id, i, refocus(state.refocusViews, outW, outH, alphas[i]));
    await tick();
  }
  return { done: true };
}

async function view({ id, u, v }) {
  requireRaw();
  const pixels = toPixels(equalize(render(u, v)));
  post({ id, type: 'result', width: state.sampler.outW, height: state.sampler.outH, pixels: pixels.buffer }, [pixels.buffer]);
  return undefined;
}

async function settings({ settings: s }) {
  const detailChanged = s.detail !== undefined && s.detail !== state.settings.detail;
  Object.assign(state.settings, s);
  if (state.lf && state.lf.raw) {
    if (detailChanged) rebuildSampler();
    else updateColor();
  }
  return state.lf && state.lf.raw ? summary() : null;
}

async function setGrid({ id, grid, mode }) {
  requireRaw();
  const { lf } = state;
  if (mode === 'metadata') {
    lf.grid = lf.metadataGrid;
  } else if (mode === 'auto') {
    const cal = calibrateGrid(lf.raw, lf.cam, lf.metadataGrid, (p) => post({ id, type: 'progress', stage: 'Locating microlenses', progress: p }));
    lf.grid = cal.grid;
  } else {
    lf.grid = normalizeGrid(grid, lf.cam);
  }
  lf.gridQuality = measureGrid(lf.raw, lf.cam, lf.grid);
  rebuildSampler();
  return summary();
}

// Grey-scale crop of the raw sensor image plus the lens centres inside it,
// for the calibration view.
async function rawCrop({ id, x, y, size }) {
  requireRaw();
  const { raw, cam, grid } = state.lf;
  const x0 = Math.max(0, Math.min(cam.width - size, Math.round(x - size / 2)));
  const y0 = Math.max(0, Math.min(cam.height - size, Math.round(y - size / 2)));
  const pixels = new Uint8ClampedArray(size * size * 4);
  let max = 1;
  for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) max = Math.max(max, raw[(y0 + j) * cam.width + x0 + i]);
  const black = state.dev.black[1];
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const v = Math.max(0, raw[(y0 + j) * cam.width + x0 + i] - black) / Math.max(1, max - black);
      const o = (j * size + i) * 4;
      pixels[o] = pixels[o + 1] = pixels[o + 2] = Math.round(255 * Math.sqrt(v));
      pixels[o + 3] = 255;
    }
  }
  const lenses = lensCenters(grid, cam.width, cam.height);
  const centers = [];
  for (let k = 0; k < lenses.cx.length; k++) {
    const cx = lenses.cx[k] - x0;
    const cy = lenses.cy[k] - y0;
    if (cx >= -grid.pitch && cy >= -grid.pitch && cx < size + grid.pitch && cy < size + grid.pitch) centers.push(cx, cy);
  }
  post({ id, type: 'result', x0, y0, size, pitch: grid.pitch, pixels: pixels.buffer, centers }, [pixels.buffer]);
  return undefined;
}

// Maps a point of the rendered image back to the sensor (for the calibration
// view: clicking the picture shows the raw lenslets under that point).
async function outputToSensor({ x, y }) {
  requireRaw();
  const { sampler } = state;
  // Invert sensorToOutput numerically using its affine form.
  const [ax, ay] = sensorToOutput(sampler, 0, 0);
  const [bx, by] = sensorToOutput(sampler, 1, 0);
  const [cx, cy] = sensorToOutput(sampler, 0, 1);
  const det = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
  const dx = x - ax;
  const dy = y - ay;
  return { x: (dx * (cy - ay) - dy * (cx - ax)) / det, y: ((bx - ax) * dy - (by - ay) * dx) / det };
}

async function readSection({ ref }) {
  return state.lf ? state.lf.readSection(ref) : null;
}

const handlers = { open, frames, refocusFrames, view, settings, setGrid, rawCrop, outputToSensor, readSection,
  cancel: async ({ kind }) => { state.jobs[kind] = null; } };

self.onmessage = async (event) => {
  const msg = event.data;
  const handler = handlers[msg.type];
  try {
    if (!handler) throw new Error(`Unknown request ${msg.type}`);
    const result = await handler(msg);
    if (result !== undefined) post({ id: msg.id, type: 'result', result });
  } catch (err) {
    post({ id: msg.id, type: 'error', message: err && err.message ? err.message : String(err) });
  }
};
