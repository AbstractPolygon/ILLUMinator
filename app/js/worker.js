// Decoding and rendering run here so the UI stays responsive.
// Requests: { id, type, ...args }. Replies: { id, type: 'result' | 'progress' | 'frame' | 'error', ... }.

import { decodeLightField } from './core/decode.js';
import { normalizeGrid, measureGrid, calibrateGrid, lensCenters } from './core/lenslet.js';
import {
  buildSampler, renderView, makeDevelopParams, apertureSamples, refocus,
  colorMatrix, autoExposure, toneMap, sensorToOutput,
} from './core/render.js';
import { makeSyntheticLfr } from './core/synthetic.js';
import { estimateDepth, focusAtPoint } from './core/depth.js';
import { applyDepthOfField } from './core/dof.js';
import { defringe } from './core/defringe.js';
import { makeLook, whiteBalanceGains, DEFAULT_KELVIN } from './core/color.js';
import { renderSuperRes, estimateVignetting, vignettingGainAt } from './core/superres.js';
import { GpuRenderer } from './gpu/renderer.js';

const state = {
  lf: null,
  sampler: null,
  dev: null,
  settings: { ev: 0, saturation: 1, useCcm: true, autoWb: false, detail: 1, defringe: null, wb: { kelvin: null, tint: 0 }, tone: {}, color: {} },
  look: null,
  baseExposure: 1,
  matrix: null,
  wbGains: [1, 1, 1],
  centerMeans: [1, 1, 1],
  refocusViews: null,
  vignetting: null,
  depth: null,
  gpu: null, // GpuRenderer when WebGL2 is available
  refocusBuild: null,
  jobs: {},
  scratch: null,
};

const VIEW_SCALE = 8192;

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function post(msg, transfer) {
  self.postMessage(msg, transfer || []);
}

function channelMeans(rgb) {
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

// Views away from the center are darker and slightly tinted because of
// microlens vignetting; scale each channel to match the center view.
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
  if (state.gpu) return state.gpu.renderView(u, v);
  const { lf, dev, sampler } = state;
  const per = sampler.lenses.cx.length * 3;
  if (!state.scratch || state.scratch.length !== per) state.scratch = new Float32Array(per);
  return renderView(lf.raw, lf.cam, dev, sampler, u, v, state.scratch);
}

function asShotKelvin() {
  const c = state.lf && state.lf.cam && state.lf.cam.capture;
  return (c && c.cct) || DEFAULT_KELVIN;
}

function updateColor() {
  const { lf } = state;
  const center = render(0, 0);
  state.centerMeans = channelMeans(center);
  const s = state.settings;
  const auto = s.autoWb ? state.centerMeans.map((m) => state.centerMeans[1] / m) : [1, 1, 1];
  const asShot = asShotKelvin();
  const manual = whiteBalanceGains(s.wb.kelvin || asShot, asShot, s.wb.tint);
  state.wbGains = auto.map((g, i) => g * manual[i]);
  state.look = makeLook(s);
  const ccm = colorMatrix(lf.cam, s);
  // Fold the white balance gains into the matrix columns.
  state.matrix = ccm.map((v, i) => v * state.wbGains[i % 3]);
  state.baseExposure = autoExposure(center, state.matrix);
}

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];

// Linear camera RGB (w x h) -> displayable RGBA bytes.
function toPixels(rgb, w, h) {
  const exposure = state.baseExposure * Math.pow(2, state.settings.ev);
  const f = state.settings.defringe;
  if (!f || !f.on || !f.colors.some(([amount]) => amount > 0)) return toneMap(rgb, state.matrix, exposure, undefined, state.look);
  // Defringing judges hue in output colors, so apply the color matrix first.
  const m = state.matrix;
  const srgb = new Float32Array(rgb.length);
  for (let i = 0; i < rgb.length; i += 3) {
    const r = rgb[i];
    const g = rgb[i + 1];
    const b = rgb[i + 2];
    srgb[i] = m[0] * r + m[1] * g + m[2] * b;
    srgb[i + 1] = m[3] * r + m[4] * g + m[5] * b;
    srgb[i + 2] = m[6] * r + m[7] * g + m[8] * b;
  }
  return toneMap(defringe(srgb, w, h, f), IDENTITY, exposure, undefined, state.look);
}

// GPU path: finishes a picture held in a GPU texture (synthetic depth of
// field and bokeh, then color, defringing and tone mapping) and posts it as
// an ImageBitmap. `pxPerUnit`: blur pixels per unit of focus difference per
// unit of `dof`, for this image's size.
async function presentGpu(id, tex, w, h, { alpha = 0, dof = 0, bokeh = {}, pxPerUnit }, message) {
  const gpu = state.gpu;
  if (dof > 0 && (await ensureDepth(id))) {
    tex = gpu.depthOfField(tex, w, h, {
      focus: alpha,
      strength: dof * pxPerUnit,
      shape: bokeh.shape,
      highlights: bokeh.highlights,
      tilt: bokeh.tilt,
      point: bokeh.point,
      spread: bokeh.spread,
      clip: state.dev.clip,
    });
  }
  const bitmap = gpu.present(tex, w, h, {
    matrix: state.matrix,
    exposure: state.baseExposure * Math.pow(2, state.settings.ev),
    fringe: state.settings.defringe,
    look: state.look,
  });
  post({ ...message, width: w, height: h, bitmap }, [bitmap]);
}

// Blur pixels per unit of focus difference per unit of `dof` in the view.
function viewPxPerUnit() {
  return 14 * state.settings.detail;
}

function frameMessage(id, index, rgb) {
  const pixels = toPixels(rgb, state.sampler.outW, state.sampler.outH);
  post({ id, type: 'frame', index, width: state.sampler.outW, height: state.sampler.outH, pixels: pixels.buffer }, [pixels.buffer]);
}

function rebuildSampler() {
  const { lf } = state;
  state.sampler = buildSampler(lf.grid, lf.cam, state.settings.detail);
  state.refocusViews = null;
  state.vignetting = null;
  state.depth = null;
  if (state.gpu) {
    state.vignetting = estimateVignetting(lf.raw, lf.cam, state.dev, lf.grid);
    const vg = state.vignetting;
    state.gpu.setSampler(state.sampler, (u, v) => vignettingGainAt(vg, u, v));
  }
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
    renderer: state.gpu ? `GPU (${state.gpu.name})` : 'CPU',
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
    if (state.gpu === null && state.settings.gpu !== false) state.gpu = GpuRenderer.create(state.lf.cam) || false;
    if (state.gpu) state.gpu.setRaw(state.lf.raw, state.lf.cam, state.dev);
    rebuildSampler();
  }
  return summary();
}

// Viewpoint animation along `path`; with an open aperture each frame is
// refocused at `alpha` through an aperture around the path point.
async function frames({ id, job, path, alpha = 0, aperture = 0, dof = 0, bokeh }) {
  requireRaw();
  state.jobs.frames = job;
  if (aperture > 0 && !(await ensureRefocusViews(id))) return { cancelled: true };
  const { outW, outH } = state.sampler;
  for (let i = 0; i < path.length; i++) {
    if (state.jobs.frames !== job) return { cancelled: true };
    const { u, v } = path[i];
    if (state.gpu) {
      const tex = aperture > 0 ? state.gpu.refocusTo(alpha, apertureOptions({ u, v, aperture })) : state.gpu.renderViewTex(u, v);
      await presentGpu(id, tex, outW, outH, { alpha, dof, bokeh, pxPerUnit: viewPxPerUnit() }, { id, type: 'frame', index: i });
      await tick();
      continue;
    }
    const rgb = aperture > 0
      ? refocusRGB(alpha, apertureOptions({ u, v, aperture }))
      : equalize(render(u, v));
    frameMessage(id, i, await withDepthOfField(id, rgb, outW, outH, alpha, dof, 1, bokeh));
    await tick();
  }
  return { done: true };
}

// The views used for refocusing are built once per sampler and shared by
// every request that needs them (refocus, the camera view, depth). Requests
// that arrive while they are being built wait for the same build and all
// receive its progress.
async function ensureRefocusViews(id) {
  if (state.refocusViews) return true;
  if (!state.refocusBuild) {
    const sampler = state.sampler;
    const listeners = new Set();
    const build = (async () => {
      const samples = apertureSamples(apertureRadius(), 7);
      const views = [];
      // On the GPU all views render at once into GPU memory (for refocusing
      // there); copies are read back for depth estimation on the CPU.
      const readGpuView = state.gpu ? state.gpu.buildViews(samples, state.settings.detail) : null;
      for (let i = 0; i < samples.length; i++) {
        if (state.sampler !== sampler) return null;
        const { u, v } = samples[i];
        // Stored as 16 bit to keep ~37 full views affordable in memory.
        const rgb = readGpuView ? readGpuView(i) : equalize(render(u, v));
        const q = new Uint16Array(rgb.length);
        for (let k = 0; k < rgb.length; k++) q[k] = Math.min(65535, rgb[k] * VIEW_SCALE + 0.5);
        views.push({ u, v, rgb: q, gain: 1 / VIEW_SCALE, detail: state.settings.detail });
        for (const l of listeners) post({ id: l, type: 'progress', stage: 'Preparing refocus', progress: (i + 1) / samples.length });
        await tick();
      }
      return views;
    })();
    state.refocusBuild = { build, listeners, sampler };
  }
  const { build, listeners, sampler } = state.refocusBuild;
  listeners.add(id);
  const views = await build;
  listeners.delete(id);
  if (state.refocusBuild && state.refocusBuild.build === build) state.refocusBuild = null;
  if (!views || state.sampler !== sampler) return false;
  state.refocusViews = views;
  return true;
}

// Refocused picture (linear RGB) at `alpha` with aperture options `opts`.
function refocusRGB(alpha, opts) {
  if (state.gpu && state.gpu.views) return state.gpu.refocus(alpha, opts);
  return refocus(state.refocusViews, state.sampler.outW, state.sampler.outH, alpha, opts);
}

// Synthetic aperture options from a request: viewpoint (u, v) and aperture
// size as a fraction of the lens aperture (0 = a single view).
function apertureOptions({ u = 0, v = 0, aperture = 1 }) {
  return { u0: u, v0: v, sigma: aperture >= 1 ? Infinity : Math.max(0.05, aperture) * apertureRadius() * 0.6 };
}

// Narrows the depth of field synthetically (strength `dof`, 0 = off) around
// focus value `alpha`; `scale` is the image's size relative to the views.
// `bokeh` is { shape: 'smooth' | 'circle' | 'hexagon', highlights: 0..1 }.
async function withDepthOfField(id, rgb, w, h, alpha, dof, scale = 1, bokeh = {}) {
  if (!(dof > 0)) return rgb;
  if (!(await ensureDepth(id))) return rgb;
  const { outW, outH } = state.sampler;
  return applyDepthOfField(rgb, w, h, state.depth.alpha, outW, outH, alpha, dof, 14 * scale * state.settings.detail, {
    shape: bokeh.shape, highlights: bokeh.highlights, clip: state.dev.clip, tilt: bokeh.tilt, point: bokeh.point, spread: bokeh.spread,
  });
}

async function refocusFrames({ id, job, alphas, u, v, aperture, dof = 0, bokeh }) {
  requireRaw();
  state.jobs.refocus = job;
  if (!(await ensureRefocusViews(id))) return { cancelled: true };
  const { outW, outH } = state.sampler;
  const opts = apertureOptions({ u, v, aperture });
  for (let i = 0; i < alphas.length; i++) {
    if (state.jobs.refocus !== job) return { cancelled: true };
    if (state.gpu) {
      const tex = state.gpu.refocusTo(alphas[i], opts);
      await presentGpu(id, tex, outW, outH, { alpha: alphas[i], dof, bokeh, pxPerUnit: viewPxPerUnit() }, { id, type: 'frame', index: i });
      await tick();
      continue;
    }
    const rgb = refocusRGB(alphas[i], opts);
    frameMessage(id, i, await withDepthOfField(id, rgb, outW, outH, alphas[i], dof, 1, bokeh));
    await tick();
  }
  return { done: true };
}

// Full resolution still of what the camera shows: every raw pixel splatted at
// its refocused position. With the aperture closed every depth is kept sharp
// (each lens uses the depth under it); otherwise the picture is refocused at
// `alpha` with detail where it is in focus and smooth blur elsewhere.
async function superRes({ id, job, alpha = 0, scale, u = 0, v = 0, aperture = 0, dof = 0, bokeh }) {
  requireRaw();
  state.jobs.superres = job;
  const { lf, dev, sampler } = state;
  const progress = (stage, p) => post({ id, type: 'progress', stage, progress: p });
  if (!state.vignetting) {
    progress('Measuring lens vignetting', 0);
    state.vignetting = estimateVignetting(lf.raw, lf.cam, dev, lf.grid);
  }
  if (!(await ensureDepth(id))) return { cancelled: true };
  const allInFocus = aperture <= 0;
  const opts = apertureOptions({ u, v, aperture });
  const base = allInFocus ? equalize(render(u, v)) : refocusRGB(alpha, opts);
  const sr = renderSuperRes(lf.raw, lf.cam, dev, sampler, {
    alpha, allInFocus, u0: u, v0: v, apertureSigma: allInFocus ? Infinity : opts.sigma,
    scale, vignetting: state.vignetting, base, baseW: sampler.outW, baseH: sampler.outH, depth: state.depth.alpha,
    onProgress: (p) => progress('Rendering full resolution', p),
    gpuSplat: state.gpu ? (params) => state.gpu.splat(params) : undefined,
  });
  if (state.jobs.superres !== job) return { cancelled: true };
  if (state.gpu) {
    const tex = state.gpu.uploadRGB(sr.rgb, sr.width, sr.height);
    await presentGpu(id, tex, sr.width, sr.height, { alpha, dof, bokeh, pxPerUnit: 14 * scale }, { id, type: 'result' });
    return undefined;
  }
  if (dof > 0) progress('Applying depth of field', 1);
  const rgb = await withDepthOfField(id, sr.rgb, sr.width, sr.height, alpha, dof, scale / state.settings.detail, bokeh);
  const pixels = toPixels(rgb, sr.width, sr.height);
  post({ id, type: 'result', width: sr.width, height: sr.height, pixels: pixels.buffer }, [pixels.buffer]);
  return undefined;
}

// One picture for the interactive camera: a single view when the aperture
// is closed, otherwise refocused at `alpha` through an aperture around (u, v).
async function view({ id, u, v, alpha = 0, aperture = 0, dof = 0, bokeh }) {
  requireRaw();
  if (state.gpu) {
    let tex;
    if (aperture > 0) {
      if (!(await ensureRefocusViews(id))) return { cancelled: true };
      tex = state.gpu.refocusTo(alpha, apertureOptions({ u, v, aperture }));
    } else {
      tex = state.gpu.renderViewTex(u, v);
    }
    await presentGpu(id, tex, state.sampler.outW, state.sampler.outH, { alpha, dof, bokeh, pxPerUnit: viewPxPerUnit() }, { id, type: 'result' });
    return undefined;
  }
  let rgb;
  if (aperture > 0) {
    if (!(await ensureRefocusViews(id))) return { cancelled: true };
    rgb = refocusRGB(alpha, apertureOptions({ u, v, aperture }));
  } else {
    rgb = equalize(render(u, v));
  }
  rgb = await withDepthOfField(id, rgb, state.sampler.outW, state.sampler.outH, alpha, dof, 1, bokeh);
  const pixels = toPixels(rgb, state.sampler.outW, state.sampler.outH);
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

// Grey-scale crop of the raw sensor image plus the lens centers inside it,
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

async function ensureDepth(id) {
  if (state.depth) return true;
  if (!(await ensureRefocusViews(id))) return false;
  if (!state.depth) {
    const { outW, outH } = state.sampler;
    state.depth = estimateDepth(state.refocusViews, outW, outH, {
      onProgress: (p) => post({ id, type: 'progress', stage: 'Measuring depth', progress: p }),
    });
    if (state.gpu) state.gpu.setDepth(state.depth.alpha, outW, outH);
  }
  return true;
}

// Color-coded depth map: near is warm, far is cool.
async function depthMap({ id }) {
  requireRaw();
  if (!(await ensureDepth(id))) return { cancelled: true };
  const { alpha } = state.depth;
  const sorted = Float32Array.from(alpha).sort();
  const lo = sorted[Math.floor(sorted.length * 0.02)];
  const hi = sorted[Math.floor(sorted.length * 0.98)];
  const pixels = new Uint8ClampedArray(alpha.length * 4);
  for (let i = 0; i < alpha.length; i++) {
    // alpha < 0 is nearer than the camera's focus plane.
    const t = Math.max(0, Math.min(1, (alpha[i] - lo) / Math.max(1e-6, hi - lo)));
    pixels[4 * i] = Math.round(255 * Math.min(1, 1.6 - 1.6 * t));
    pixels[4 * i + 1] = Math.round(255 * (1 - Math.abs(t - 0.5) * 1.4));
    pixels[4 * i + 2] = Math.round(255 * Math.min(1, 1.6 * t));
    pixels[4 * i + 3] = 255;
  }
  post({ id, type: 'result', width: state.sampler.outW, height: state.sampler.outH, pixels: pixels.buffer, near: lo, far: hi }, [pixels.buffer]);
  return undefined;
}

// Focus value (alpha) that makes the picture sharp at output pixel (x, y)
// of the camera view. Measured at the point itself; where the spot has no
// texture to judge by, the (filled-in) depth map is used instead. The point
// is shifted back by the parallax of the current viewpoint, since the views
// are centered.
async function focusAt({ id, x, y, u = 0, v = 0 }) {
  requireRaw();
  if (!(await ensureRefocusViews(id))) return { cancelled: true };
  const { outW, outH } = state.sampler;
  const views = state.refocusViews;
  const d = state.settings.detail;
  // Grow the window until it contains enough texture to judge by.
  let est = null;
  for (const radius of [5, 10, 20]) {
    const opts = { radius, min: -1.6, max: 1.6 };
    est = focusAtPoint(views, outW, outH, x, y, opts);
    // A viewpoint away from the center sees a point at depth alpha displaced
    // by -alpha * (u, v): measure again at the matching centered position.
    if (u || v) est = focusAtPoint(views, outW, outH, x - est.alpha * u * d, y - est.alpha * v * d, opts);
    if (est.confidence >= 0.15) return { alpha: est.alpha, confidence: est.confidence };
  }
  if (!(await ensureDepth(id))) return { cancelled: true };
  const xi = Math.max(0, Math.min(outW - 1, Math.round(x)));
  const yi = Math.max(0, Math.min(outH - 1, Math.round(y)));
  return { alpha: state.depth.alpha[yi * outW + xi], confidence: est.confidence };
}

// Builds the views used by refocusing and click-to-focus in the background
// after a photo opens, so the first click or aperture change is quick. The
// build yields between views, so other requests are served meanwhile.
async function prepare({ id }) {
  if (!state.lf || !state.lf.raw) return { done: false };
  return { done: await ensureRefocusViews(id) };
}

async function readSection({ ref }) {
  return state.lf ? state.lf.readSection(ref) : null;
}

const handlers = { open, frames, refocusFrames, superRes, view, focusAt, depthMap, prepare, settings, setGrid, rawCrop, outputToSensor, readSection,
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
