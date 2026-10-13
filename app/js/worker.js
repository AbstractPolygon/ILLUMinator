// Decoding and rendering run here so the UI stays responsive.
// Requests: { id, type, ...args }. Replies: { id, type: 'result' | 'progress' | 'frame' | 'error', ... }.

import { decodeLightField } from './core/decode.js';
import { normalizeGrid, measureGrid, calibrateGrid, lensCenters } from './core/lenslet.js';
import {
  buildSampler, renderView, makeDevelopParams, apertureSamples, refocus,
  colorMatrix, autoExposure, toneMap, sensorToOutput, viewSizes,
} from './core/render.js';
import { makeSyntheticLfr } from './core/synthetic.js';
import { estimateDepth, focusAtPoint, smoothDepth, finishDepth, depthGuide, luminance, brightnessFloor, DEPTH_SEARCH } from './core/depth.js';
import { applyDepthOfField } from './core/dof.js';
import { defringe, autoDefringe } from './core/defringe.js';
import { makeLook, whiteBalanceGains, DEFAULT_KELVIN, solveWhiteBalance } from './core/color.js';
import { makeDetail, applyDetail } from './core/detail.js';
import { mergeViews, mergeSigma } from './core/mvdenoise.js';
import { ProcessedPicture, decodeDepth } from './core/processed.js';
import { cameraInfo } from './core/raw.js';
import { renderSuperRes, superResParams, estimateVignetting, vignettingGainAt } from './core/superres.js';
import { estimateVeil, subtractVeil } from './core/flare.js';
import { lensParams, applyLens } from './core/lens.js';
import { parseMasks, activeMasks, packMasks, resolveMasks, hasSpatial, applySpatial } from './core/local.js';
import { GpuRenderer } from './gpu/renderer.js';

const state = {
  lut: null, // the photo's LUT (core/lut.js), or null
  lf: null,
  sampler: null,
  dev: null,
  settings: { ev: 0, saturation: 1, useCcm: true, autoWb: false, detail: 1, defringe: null, wb: { kelvin: null, tint: 0 }, tone: {}, color: {}, mvDenoise: { on: false, blend: 1 } },
  pp: null, // ProcessedPicture for .lfp files without raw data
  fringeAuto: null, // colors found by auto defringe
  look: null,
  detail: null, // Details panel filters (core/detail.js)
  baseExposure: 1,
  matrix: null,
  wbGains: [1, 1, 1],
  centerMeans: [1, 1, 1],
  refocusViews: null,
  vignetting: null,
  depth: null,
  // GpuRenderer when WebGL2 is available (false: not used, e.g. ?cpu).
  gpu: typeof location !== 'undefined' && new URLSearchParams(location.search).has('cpu') ? false : null,
  // Changes whenever the photo, the views or the depth map change (see
  // view()); `kept` is the last view before its color pass, on the GPU.
  gen: 0,
  kept: null,
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

// The center view (linear RGB), rendered once per sampler: color settings
// measure it on every change. Read only.
function centerView() {
  if (!state.center) state.center = render(0, 0);
  return state.center;
}

function asShotKelvin() {
  const c = state.lf && state.lf.cam && state.lf.cam.capture;
  return (c && c.cct) || DEFAULT_KELVIN;
}

function updateColor() {
  const { lf } = state;
  if (state.pp) {
    updateProcessedColor();
    return;
  }
  const center = centerView();
  state.centerMeans = channelMeans(center);
  const s = state.settings;
  const auto = s.autoWb ? state.centerMeans.map((m) => state.centerMeans[1] / m) : [1, 1, 1];
  const asShot = asShotKelvin();
  // Auto white balance replaces the manual temperature and tint.
  const manual = s.autoWb ? [1, 1, 1] : whiteBalanceGains(s.wb.kelvin || asShot, asShot, s.wb.tint);
  state.wbGains = auto.map((g, i) => g * manual[i]);
  state.look = makeLook(s);
  state.detail = makeDetail(s);
  state.lens = lensParams(s.lens);
  // Local adjustments: the masks that change something (or the one shown).
  const masks = parseMasks(s.local && s.local.masks);
  const show = s.local && s.local.show >= 0 && masks[s.local.show] ? s.local.show : -1;
  state.masks = masks.filter((m, i) => i === show || activeMasks([m]).length);
  state.maskShow = show >= 0 ? state.masks.indexOf(masks[show]) : -1;
  const ccm = colorMatrix(lf.cam, s);
  // Fold the white balance gains into the matrix columns.
  state.matrix = ccm.map((v, i) => v * state.wbGains[i % 3]);
  // Reduce flare: the veil is measured once on the center view.
  const { outW, outH } = state.sampler;
  if (!(s.flare && s.flare.on)) state.veil = null;
  else if (!state.veil || state.veilOf !== center) state.veil = estimateVeil(center, outW, outH);
  state.veilOf = state.veil ? center : null;
  state.veilAmount = state.veil ? s.flare.amount : 0;
  if (state.gpu) state.gpu.setVeil(state.veil);
  state.baseExposure = autoExposure(state.veil ? subtractVeil(center, outW, outH, state.veil, state.veilAmount) : center, state.matrix);
  applyAutoDefringe(center, state.sampler.outW, state.sampler.outH);
}

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];

// Local adjustments for a w x h picture (core/local.js), or null. `ctx`:
// { focus, overrides } of this picture (see resolveMasks).
function localFor(w, h, ctx) {
  if (!state.masks || !state.masks.length) return null;
  const d = state.depth && state.sampler ? { depth: state.depth.alpha, dw: state.sampler.outW, dh: state.sampler.outH } : {};
  return { masks: resolveMasks(state.masks, ctx), w, h, show: state.maskShow, ...d };
}

// Linear camera RGB (w x h) -> displayable RGBA bytes.
function toPixels(rgb, w, h, ctx) {
  rgb = applyDetail(rgb, w, h, state.detail);
  rgb = subtractVeil(rgb, w, h, state.veil, state.veilAmount);
  rgb = applyLens(rgb, w, h, state.lens);
  const exposure = state.baseExposure * Math.pow(2, state.settings.ev);
  const f = state.settings.defringe;
  const local = localFor(w, h, ctx);
  // Blur, pixelate and sketch look at neighbouring pixels: before the rest.
  if (local && hasSpatial(local.masks)) rgb = applySpatial(rgb, w, h, local);
  const grade = state.lut ? { lut: state.lut, amount: state.settings.lutAmount ?? 1 } : null;
  if (!f || !f.on || !f.colors.some(([amount]) => amount > 0)) return toneMap(rgb, state.matrix, exposure, undefined, state.look, local, grade);
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
  return toneMap(defringe(srgb, w, h, f), IDENTITY, exposure, undefined, state.look, local, grade);
}

// GPU path: finishes a picture held in a GPU texture (synthetic depth of
// field and bokeh, then color, defringing and tone mapping) and posts it as
// an ImageBitmap. `pxPerUnit`: blur pixels per unit of focus difference per
// unit of `dof`, for this image's size. `keep`: keep the picture as it is
// before the color pass, so color changes can redraw it (see view()).
async function presentGpu(id, tex, w, h, { alpha = 0, dof = 0, bokeh = {}, pxPerUnit, masks = { focus: alpha }, keep = null, draft = false }, message) {
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
      smooth: bokeh.smooth,
      clip: state.dev.clip,
      draft,
    });
  }
  if (state.detail) tex = gpu.details(tex, w, h, state.detail);
  const packed = packedMasks(masks);
  if (packed && packed.spatial) tex = gpu.localSpatial(tex, w, h, packed);
  if (keep) state.kept = { key: keep, tex: gpu.keep(tex, w, h), w, h };
  finishGpu(tex, w, h, packed, message);
}

// Local adjustments resolved for a picture, packed for the GPU, or null.
function packedMasks(ctx) {
  const resolved = state.masks && state.masks.length ? resolveMasks(state.masks, ctx) : null;
  return resolved ? { ...packMasks(resolved), show: state.maskShow, spatial: hasSpatial(resolved) } : null;
}

// The color pass: color, defringing, local adjustments and tone mapping.
function finishGpu(tex, w, h, packed, message) {
  const bitmap = state.gpu.present(tex, w, h, {
    matrix: state.matrix,
    exposure: state.baseExposure * Math.pow(2, state.settings.ev),
    fringe: state.settings.defringe,
    look: state.look,
    veilAmount: state.veil ? state.veilAmount : 0,
    lens: state.lens,
    lutAmount: state.lut ? state.settings.lutAmount ?? 1 : 0,
    local: packed,
  });
  post({ ...message, width: w, height: h, bitmap }, [bitmap]);
}

// The viewpoint for masks that follow it (see resolveMasks).
function viewOf(u = 0, v = 0) {
  return { u, v, r: apertureRadius() };
}

// Blur pixels per unit of focus difference per unit of `dof` in the view.
function viewPxPerUnit() {
  return 14 * state.settings.detail;
}

function frameMessage(id, index, rgb, ctx) {
  const pixels = toPixels(rgb, state.sampler.outW, state.sampler.outH, ctx);
  post({ id, type: 'frame', index, width: state.sampler.outW, height: state.sampler.outH, pixels: pixels.buffer }, [pixels.buffer]);
}

function rebuildSampler() {
  const { lf } = state;
  state.sampler = buildSampler(lf.grid, lf.cam, state.settings.detail);
  state.center = null;
  state.gen++;
  state.refocusViews = null;
  state.vignetting = null;
  state.depth = null;
  state.depthRaw = null;
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
    stacks: lf.stacks.map((s) => ({ kind: s.kind, source: s.source, count: s.images.length })),
    photoId: lf.photoId,
    recipe: lf.recipe || null,
  };
  if (state.pp) {
    const pp = state.pp;
    let cam = null;
    try {
      const c = lf.metadata ? cameraInfo(lf.metadata) : null;
      if (c) cam = { model: c.model, make: c.make, capture: c.capture };
    } catch {
      // Not every processed file keeps the camera metadata.
    }
    return {
      ...base,
      cam,
      processed: { kind: pp.kind, source: pp.source, count: pp.images.length, hasDepth: pp.hasDepth, canDrag: pp.canDrag },
      width: pp.width,
      height: pp.height,
      sizes: { 1: [pp.width, pp.height], 1.5: [pp.width, pp.height], 2: [pp.width, pp.height] },
      radius: pp.radius,
      settings: state.settings,
      fringeAuto: state.fringeAuto,
      renderer: 'CPU',
    };
  }
  if (!base.hasRaw) return base;
  const { cam } = lf;
  return {
    ...base,
    cam: { model: cam.model, make: cam.make, firmware: cam.firmware, width: cam.width, height: cam.height, bits: cam.bits, upperLeft: cam.upperLeft, capture: cam.capture, hasCcm: !!cam.ccm, ccm: cam.ccm ? Array.from(cam.ccm) : null },
    grid: lf.grid,
    metadataGrid: lf.metadataGrid,
    gridQuality: lf.gridQuality,
    hotPixels: lf.hotPixels || 0,
    width: sampler.outW,
    height: sampler.outH,
    // View size at each Resolution setting, and full resolution size at each
    // Scale (as renderSuperRes computes it).
    sizes: viewSizes(lf.grid, cam, [1, 1.5, 2]),
    stillSizes: Object.fromEntries([2, 3, 4].map((k) => [k, [
      Math.floor((sampler.outW / state.settings.detail) * k),
      Math.floor((sampler.outH / state.settings.detail) * k),
    ]])),
    radius: apertureRadius(),
    settings: state.settings,
    fringeAuto: state.fringeAuto,
    renderer: state.gpu ? `GPU (${state.gpu.name})` : 'CPU',
  };
}

function requireRaw() {
  if (!state.lf || !state.lf.raw) throw new Error('No light field loaded');
}

async function open({ id, bytes, synthetic }) {
  state.lf = null;
  state.gen++;
  state.refocusViews = null;
  for (const k of Object.keys(state.jobs)) state.jobs[k] = null;
  const onProgress = (stage, p) => post({ id, type: 'progress', stage, progress: p });
  let data = bytes ? new Uint8Array(bytes) : null;
  if (synthetic) {
    onProgress('Generating sample', 0);
    data = await makeSyntheticLfr(synthetic);
  }
  state.pp = null;
  state.lf = await decodeLightField(data, { onProgress });
  if (!state.lf.raw && state.lf.stacks.length) {
    onProgress('Decoding images', 0.5);
    state.pp = await buildProcessed(state.lf);
    state.pp.setSmoothing(state.settings.depthSmoothing ?? 0.3);
    updateColor();
  }
  if (state.lf.raw) {
    state.dev = makeDevelopParams(state.lf.cam);
    if (state.gpu === null && state.settings.gpu !== false) {
      state.gpu = GpuRenderer.create(state.lf.cam) || false;
      if (state.gpu && state.lut) state.gpu.setLut(state.lut);
    }
    if (state.gpu) state.gpu.setRaw(state.lf.raw, state.lf.cam, state.dev);
    rebuildSampler();
  }
  return summary();
}

// Viewpoint animation along `path`; with an open aperture each frame is
// refocused at `alpha` through an aperture around the path point.
// Animation frames along `path`: [{ u, v }] with the shared focus, aperture
// and blur, or with any of them per frame ({ u, v, alpha, aperture, dof },
// for keyframed animations).
async function frames({ id, job, path, alpha = 0, aperture = 0, dof = 0, bokeh }) {
  const list = path.map((f) => ({ u: f.u, v: f.v, alpha: f.alpha ?? alpha, aperture: f.aperture ?? aperture, dof: f.dof ?? dof, bokeh: f.bokeh ?? bokeh, masks: f.masks || null }));
  if (state.pp) return processedFrames({ id, job, kind: 'frames', list });
  requireRaw();
  state.jobs.frames = job;
  if (list.some((f) => f.aperture > 0) && !(await ensureRefocusViews(id))) return { cancelled: true };
  const { outW, outH } = state.sampler;
  for (let i = 0; i < list.length; i++) {
    if (state.jobs.frames !== job) return { cancelled: true };
    const f = list[i];
    if (state.gpu) {
      const tex = f.aperture > 0 ? state.gpu.refocusTo(f.alpha, apertureOptions(f)) : await singleView(id, f.u, f.v);
      await presentGpu(id, tex, outW, outH, { alpha: f.alpha, dof: f.dof, bokeh: f.bokeh, pxPerUnit: viewPxPerUnit(), masks: { focus: f.alpha, overrides: f.masks, view: viewOf(f.u, f.v) } }, { id, type: 'frame', index: i });
      await tick();
      continue;
    }
    const rgb = f.aperture > 0 ? refocusRGB(f.alpha, apertureOptions(f)) : await singleView(id, f.u, f.v);
    frameMessage(id, i, await withDepthOfField(id, rgb, outW, outH, f.alpha, f.dof, 1, f.bokeh), { focus: f.alpha, overrides: f.masks, view: viewOf(f.u, f.v) });
    await tick();
  }
  return { done: true };
}

// The picture seen from viewpoint (u, v) through a pinhole: one view, or
// with multi-view denoising on, every refocus view merged into it (see
// core/mvdenoise.js). A GPU texture on the GPU, linear RGB otherwise.
async function singleView(id, u, v) {
  const mv = state.settings.mvDenoise;
  if (mv && mv.on && mv.blend > 0 && (await ensureDepth(id))) {
    const m = state.centerMeans;
    const sigma = mergeSigma(0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]);
    if (state.gpu) return state.gpu.mergedViewTex(u, v, { sigma, blend: mv.blend });
    const { outW, outH } = state.sampler;
    return mergeViews(state.refocusViews, outW, outH, state.depth.alpha, equalize(render(u, v)), {
      u0: u, v0: v, detail: state.settings.detail, sigma, blend: mv.blend,
    });
  }
  return state.gpu ? state.gpu.renderViewTex(u, v) : equalize(render(u, v));
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
      // On the GPU the views stay in GPU memory: refocusing, depth and
      // focus measuring all work there.
      if (state.gpu) {
        state.gpu.buildViews(samples, state.settings.detail);
        for (const l of listeners) post({ id: l, type: 'progress', stage: 'Preparing refocus', progress: 1 });
        await tick();
        return state.sampler === sampler ? state.gpu.views : null;
      }
      const views = [];
      for (let i = 0; i < samples.length; i++) {
        if (state.sampler !== sampler) return null;
        const { u, v } = samples[i];
        // Stored as 16 bit to keep ~37 full views affordable in memory.
        const rgb = equalize(render(u, v));
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
    smooth: bokeh.smooth,
  });
}

async function refocusFrames({ id, job, alphas, u, v, aperture, dof = 0, bokeh }) {
  if (state.pp) return processedFrames({ id, job, kind: 'refocus', list: alphas.map((alpha) => ({ u, v, alpha, aperture, dof, bokeh })) });
  requireRaw();
  state.jobs.refocus = job;
  if (!(await ensureRefocusViews(id))) return { cancelled: true };
  const { outW, outH } = state.sampler;
  const opts = apertureOptions({ u, v, aperture });
  for (let i = 0; i < alphas.length; i++) {
    if (state.jobs.refocus !== job) return { cancelled: true };
    if (state.gpu) {
      const tex = state.gpu.refocusTo(alphas[i], opts);
      await presentGpu(id, tex, outW, outH, { alpha: alphas[i], dof, bokeh, pxPerUnit: viewPxPerUnit(), masks: { focus: alphas[i], view: viewOf(u, v) } }, { id, type: 'frame', index: i });
      await tick();
      continue;
    }
    const rgb = refocusRGB(alphas[i], opts);
    frameMessage(id, i, await withDepthOfField(id, rgb, outW, outH, alphas[i], dof, 1, bokeh), { focus: alphas[i], view: viewOf(u, v) });
    await tick();
  }
  return { done: true };
}

// Full resolution still of what the camera shows: every raw pixel splatted at
// its refocused position. With the aperture closed every depth is kept sharp
// (each lens uses the depth under it); otherwise the picture is refocused at
// `alpha` with detail where it is in focus and smooth blur elsewhere.
// `masks`: an animation frame's local adjustment settings (see resolveMasks).
async function superRes({ id, job, alpha = 0, scale, u = 0, v = 0, aperture = 0, dof = 0, bokeh, passes = 0, masks = null }) {
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
  if (state.gpu) {
    // The whole render on the GPU: the picture stays there for the color pass.
    progress('Rendering full resolution', 0);
    const params = superResParams(sampler, { scale, apertureSigma: allInFocus ? Infinity : opts.sigma });
    const tex = state.gpu.superRes({
      ...params, alpha, allInFocus, u0: u, v0: v, apertureSigma: allInFocus ? Infinity : opts.sigma,
      vignetting: state.vignetting, base, baseW: sampler.outW, baseH: sampler.outH, depth: state.depth.alpha, passes,
    });
    if (tex) {
      if (state.jobs.superres !== job) return { cancelled: true };
      await presentGpu(id, tex, params.W, params.H, { alpha, dof, bokeh, pxPerUnit: 14 * scale, masks: { focus: alpha, overrides: masks, view: viewOf(u, v) } }, { id, type: 'result' });
      return undefined;
    }
  }
  const sr = renderSuperRes(lf.raw, lf.cam, dev, sampler, {
    alpha, allInFocus, u0: u, v0: v, apertureSigma: allInFocus ? Infinity : opts.sigma,
    scale, passes, vignetting: state.vignetting, base, baseW: sampler.outW, baseH: sampler.outH, depth: state.depth.alpha,
    onProgress: (p) => progress('Rendering full resolution', p),
    gpuSplat: state.gpu ? (params) => state.gpu.splat(params) : undefined,
  });
  if (state.jobs.superres !== job) return { cancelled: true };
  if (state.gpu) {
    const tex = state.gpu.uploadRGB(sr.rgb, sr.width, sr.height);
    await presentGpu(id, tex, sr.width, sr.height, { alpha, dof, bokeh, pxPerUnit: 14 * scale, masks: { focus: alpha, overrides: masks, view: viewOf(u, v) } }, { id, type: 'result' });
    return undefined;
  }
  if (dof > 0) progress('Applying depth of field', 1);
  const rgb = await withDepthOfField(id, sr.rgb, sr.width, sr.height, alpha, dof, scale / state.settings.detail, bokeh);
  const pixels = toPixels(rgb, sr.width, sr.height, { focus: alpha, overrides: masks, view: viewOf(u, v) });
  post({ id, type: 'result', width: sr.width, height: sr.height, pixels: pixels.buffer }, [pixels.buffer]);
  return undefined;
}

// One picture for the interactive camera: a single view when the aperture
// is closed, otherwise refocused at `alpha` through an aperture around (u, v).
// `draft`: a quicker picture while the user drags (see main.js).
async function view({ id, u, v, alpha = 0, aperture = 0, dof = 0, bokeh, draft = false }) {
  if (state.pp) return processedView({ id, u, v, alpha, aperture, dof, bokeh });
  requireRaw();
  if (state.gpu) {
    const { outW, outH } = state.sampler;
    const masks = { focus: alpha, view: viewOf(u, v) };
    // Everything that decides the picture before the color pass. When only
    // color settings changed since the last view, redraw from the kept
    // picture instead of rendering it again.
    if (dof > 0 && !(await ensureDepth(id))) return { cancelled: true };
    const packed = packedMasks(masks);
    const key = JSON.stringify([state.gen, u, v, alpha, aperture, dof, dof > 0 && draft, bokeh || null, state.settings.mvDenoise, state.detail, packed && packed.spatial ? packed : null]);
    // The GPU time of each view, for the photo info (where available).
    const message = { id, type: 'result', gpuMs: state.gpu.gpuMs() };
    state.gpu.beginTiming();
    if (state.kept && state.kept.key === key) {
      finishGpu(state.kept.tex, outW, outH, packed, message);
      state.gpu.endTiming();
      return undefined;
    }
    let tex;
    if (aperture > 0) {
      if (!(await ensureRefocusViews(id))) return { cancelled: true };
      tex = state.gpu.refocusTo(alpha, apertureOptions({ u, v, aperture }));
    } else {
      tex = await singleView(id, u, v);
    }
    await presentGpu(id, tex, outW, outH, { alpha, dof, bokeh, pxPerUnit: viewPxPerUnit(), masks, keep: key, draft }, message);
    state.gpu.endTiming();
    return undefined;
  }
  let rgb;
  if (aperture > 0) {
    if (!(await ensureRefocusViews(id))) return { cancelled: true };
    rgb = refocusRGB(alpha, apertureOptions({ u, v, aperture }));
  } else {
    rgb = await singleView(id, u, v);
  }
  rgb = await withDepthOfField(id, rgb, state.sampler.outW, state.sampler.outH, alpha, dof, 1, bokeh);
  const pixels = toPixels(rgb, state.sampler.outW, state.sampler.outH, { focus: alpha, view: viewOf(u, v) });
  post({ id, type: 'result', width: state.sampler.outW, height: state.sampler.outH, pixels: pixels.buffer }, [pixels.buffer]);
  return undefined;
}

async function settings({ id, settings: s }) {
  const detailChanged = s.detail !== undefined && s.detail !== state.settings.detail;
  const smoothingChanged = s.depthSmoothing !== undefined && s.depthSmoothing !== state.settings.depthSmoothing;
  const qualityChanged = s.depthQuality !== undefined && s.depthQuality !== (state.settings.depthQuality ?? 'normal');
  Object.assign(state.settings, s);
  if (qualityChanged && state.depthRaw && !detailChanged) {
    // Measure the depth again, the new way.
    state.depth = null;
    state.depthRaw = null;
    await ensureDepth(id);
  } else if (smoothingChanged && !detailChanged) applyDepthSmoothing();
  // A depth mask needs the depth map.
  if (state.lf && state.lf.raw && !state.depth && parseMasks(s.local && s.local.masks).some((m) => m.kind === 'depth')) await ensureDepth(id);
  if (state.pp) {
    updateColor();
    return summary();
  }
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
    // Normal quality: the plain cost volume, about twice as fast; high adds
    // occlusion-aware matching and edge-aware filtering (core/depth.js).
    const fast = state.settings.depthQuality !== 'high';
    if (state.gpu) {
      post({ id, type: 'progress', stage: 'Measuring depth', progress: 0 });
      const center = luminance(centerView());
      const guide = depthGuide(center);
      const measured = state.gpu.measureDepth({ ...DEPTH_SEARCH, occlusion: !fast, guided: !fast, floor: brightnessFloor(center), guide });
      state.depthRaw = finishDepth(measured, outW, outH, guide, { refine: !fast });
    } else {
      state.depthRaw = estimateDepth(state.refocusViews, outW, outH, {
        ...(fast ? { occlusion: false, guided: false, refine: false } : {}),
        onProgress: (p) => post({ id, type: 'progress', stage: 'Measuring depth', progress: p }),
      });
    }
    applyDepthSmoothing();
  }
  return true;
}

// The measured depth, smoothed by the Depth > Smoothing setting (edge-aware,
// guided by the picture). Re-run when the setting changes.
function applyDepthSmoothing() {
  const amount = state.settings.depthSmoothing ?? 0.3;
  if (state.pp) {
    state.pp.setSmoothing(amount);
    return;
  }
  const raw = state.depthRaw;
  if (!raw) return;
  const { outW, outH } = state.sampler;
  const guide = equalize(Float32Array.from(centerView()));
  const smooth = state.gpu ? state.gpu.smoothDepth.bind(state.gpu) : smoothDepth;
  state.depth = { ...raw, alpha: smooth(raw.alpha, outW, outH, guide, { amount, confidence: raw.confidence }) };
  state.depthSmoothingApplied = amount;
  state.gen++;
  if (state.gpu) state.gpu.setDepth(state.depth.alpha, outW, outH);
}

// Color-coded depth map: near is warm, far is cool.
// Depth in camera focus units for the depth view and spread overlay:
// measured for raw photos, from the file for processed ones.
async function depthSource(id) {
  if (state.pp) {
    if (!state.pp.hasDepth) throw new Error('This file has no depth map');
    if (!state.pp.alpha) state.pp.alpha = state.pp.alphaMap();
    return { alpha: state.pp.alpha, w: state.pp.width, h: state.pp.height };
  }
  requireRaw();
  if (!(await ensureDepth(id))) return null;
  return { alpha: state.depth.alpha, w: state.sampler.outW, h: state.sampler.outH };
}

async function depthMap({ id }) {
  const src = await depthSource(id);
  if (!src) return { cancelled: true };
  const { alpha } = src;
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
  post({ id, type: 'result', width: src.w, height: src.h, pixels: pixels.buffer, near: lo, far: hi }, [pixels.buffer]);
  return undefined;
}

// Eyedropper: temperature and tint that make the area around view pixel
// (x, y) neutral. The area is averaged (5 x 5) so noise does not decide.
async function whiteBalanceAt({ x, y }) {
  let rgb;
  let w;
  let h;
  let matrix;
  if (state.pp) {
    const pp = state.pp;
    rgb = pp.linear(pp.images[0]);
    w = pp.width;
    h = pp.height;
    matrix = colorMatrix({ ccm: null }, { ...state.settings, useCcm: false, ccm: null });
  } else {
    requireRaw();
    rgb = centerView();
    w = state.sampler.outW;
    h = state.sampler.outH;
    matrix = colorMatrix(state.lf.cam, state.settings);
  }
  const sum = [0, 0, 0];
  let n = 0;
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const px = Math.round(x) + dx;
      const py = Math.round(y) + dy;
      if (px < 0 || py < 0 || px >= w || py >= h) continue;
      for (let c = 0; c < 3; c++) sum[c] += rgb[3 * (py * w + px) + c];
      n++;
    }
  }
  if (!n || !(sum[1] > 0)) return null;
  return solveWhiteBalance(sum.map((s) => s / n), matrix, asShotKelvin());
}

// Show spread overlay: pixels outside the sharp depth range around the
// focus (with spread and tilt) in blue when nearer, orange when farther.
// Tints what lies outside the sharp range: blue nearer, orange farther,
// fading in over the Smoothing width the way the blur builds up there.
async function spreadMask({ id, alpha = 0, spread = 0, smooth = 0, tilt = [0, 0], point = [0.5, 0.5] }) {
  const src = await depthSource(id);
  if (!src) return { cancelled: true };
  const { w, h } = src;
  const depth = src.alpha;
  const pixels = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const rowFocus = alpha + tilt[1] * ((y + 0.5) / h - point[1]);
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      // alpha < 0 is nearer than the focus.
      const d = depth[i] - (rowFocus + tilt[0] * ((x + 0.5) / w - point[0]));
      const excess = Math.abs(d) - spread;
      if (excess <= 0) continue;
      const o = i * 4;
      if (d < 0) {
        pixels[o] = 40;
        pixels[o + 1] = 120;
        pixels[o + 2] = 255;
      } else {
        pixels[o] = 255;
        pixels[o + 1] = 140;
        pixels[o + 2] = 20;
      }
      pixels[o + 3] = smooth > 0 ? Math.round(255 * Math.min(1, excess / smooth)) : 255;
    }
  }
  post({ id, type: 'result', width: w, height: h, pixels: pixels.buffer }, [pixels.buffer]);
  return undefined;
}

// Focus value (alpha) that makes the picture sharp at output pixel (x, y)
// of the camera view. Measured at the point itself; where the spot has no
// texture to judge by, the (filled-in) depth map is used instead. The point
// is shifted back by the parallax of the current viewpoint, since the views
// are centered.
async function focusAt({ id, x, y, u = 0, v = 0 }) {
  if (state.pp) return { alpha: state.pp.focusAt(x, y), confidence: 1 };
  requireRaw();
  if (!(await ensureRefocusViews(id))) return { cancelled: true };
  const { outW, outH } = state.sampler;
  const d = state.settings.detail;
  const measure = (px, py, opts) => {
    if (!state.gpu) return focusAtPoint(state.refocusViews, outW, outH, px, py, opts);
    // On the GPU only the views around the point are read back: the window,
    // plus the largest shift a trial depth makes, plus the detail filter.
    const reach = Math.ceil(Math.max(Math.abs(opts.min), Math.abs(opts.max)) * apertureRadius() * d);
    const m = opts.radius + reach + 6;
    const x0 = Math.max(0, Math.round(px) - m);
    const y0 = Math.max(0, Math.round(py) - m);
    const x1 = Math.min(outW, Math.round(px) + m + 1);
    const y1 = Math.min(outH, Math.round(py) + m + 1);
    if (!(x1 > x0 && y1 > y0)) return { alpha: 0, confidence: 0 };
    if (state.focusFloorOf !== state.center) {
      state.focusFloor = brightnessFloor(luminance(centerView()));
      state.focusFloorOf = state.center;
    }
    const views = state.gpu.readViewsRect(x0, y0, x1 - x0, y1 - y0);
    return focusAtPoint(views, x1 - x0, y1 - y0, px - x0, py - y0, { ...opts, floor: state.focusFloor });
  };
  // Grow the window until it contains enough texture to judge by.
  let est = null;
  for (const radius of [5, 10, 20]) {
    const opts = { radius, min: -1.6, max: 1.6 };
    est = measure(x, y, opts);
    // A viewpoint away from the center sees a point at depth alpha displaced
    // by -alpha * (u, v): measure again at the matching centered position.
    if (u || v) est = measure(x - est.alpha * u * d, y - est.alpha * v * d, opts);
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
  if (state.pp) return { done: true };
  if (!state.lf || !state.lf.raw) return { done: false };
  return { done: await ensureRefocusViews(id) };
}

async function readSection({ ref }) {
  return state.lf ? state.lf.readSection(ref) : null;
}

// ---------------------------------------------------------------- processed .lfp files

// RGBA pixels of a JPEG or PNG, optionally scaled to w x h.
async function decodeImage(bytes, mime, w, h) {
  const bitmap = await createImageBitmap(new Blob([bytes], { type: mime }));
  const width = w || bitmap.width;
  const height = h || bitmap.height;
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  return { width, height, data: ctx.getImageData(0, 0, width, height).data };
}

async function loadDepth(desc) {
  if (!desc || !desc.bytes) return null;
  const image = desc.mime ? await decodeImage(desc.bytes, desc.mime) : null;
  return decodeDepth({ ...desc, width: desc.width || (image && image.width), height: desc.height || (image && image.height) }, image);
}

// Picks the most capable content of the file: images with a depth map
// first (viewpoint and focus both work), then perspective, then focus
// stacks, then a single image.
async function buildProcessed(lf) {
  const rank = (s) => {
    const depth = !!(s.depth || lf.frameDepth);
    if (s.block) return -1; // H.264 blocks are not decoded yet
    if ((s.kind === 'warp' || s.kind === 'single') && depth) return 5;
    if (s.kind === 'perspective') return 4;
    if (s.kind === 'focus') return 3;
    return 1;
  };
  const stacks = [...lf.stacks].sort((a, b) => rank(b) - rank(a));
  const stack = stacks[0];
  if (!stack || rank(stack) < 0) {
    throw new Error('This .lfp file stores its pictures as H.264 video, which ILLUMinator cannot show yet.');
  }
  const first = await decodeImage(stack.images[0].bytes, stack.images[0].mime);
  const images = [];
  for (const img of stack.images) {
    const px = img === stack.images[0] ? first : await decodeImage(img.bytes, img.mime, first.width, first.height);
    images.push({ ...px, lambda: img.lambda, u: img.coord ? img.coord.x : 0, v: img.coord ? img.coord.y : 0 });
  }
  const depth = await loadDepth(stack.depth || lf.frameDepth);
  return new ProcessedPicture({ kind: stack.kind, source: stack.source, images, depth, pitchRatio: stack.pitchRatio });
}

// Processed images are already developed (sRGB): only the color sliders
// apply, with white balance relative to how the picture was rendered.
function updateProcessedColor() {
  const s = state.settings;
  const pp = state.pp;
  const center = pp.linear(pp.images[0]);
  state.centerMeans = channelMeans(center);
  const asShot = asShotKelvin();
  const auto = s.autoWb ? state.centerMeans.map((m) => state.centerMeans[1] / m) : [1, 1, 1];
  const manual = s.autoWb ? [1, 1, 1] : whiteBalanceGains(s.wb.kelvin || asShot, asShot, s.wb.tint);
  const sat = colorMatrix({ ccm: null }, { ...s, useCcm: false, ccm: null });
  state.matrix = sat.map((v, i) => v * auto[i % 3] * manual[i % 3]);
  state.baseExposure = 1;
  state.look = makeLook(s);
  state.detail = makeDetail(s);
  applyAutoDefringe(center, pp.width, pp.height);
}

// Auto defringe: finds the fringe colors in the center view (in output
// colors, as defringing judges them) and uses them in place of the sliders.
function applyAutoDefringe(center, w, h) {
  const f = state.settings.defringe;
  state.fringeAuto = null;
  if (!f || !f.auto) return;
  const m = state.matrix;
  const k = state.baseExposure * Math.pow(2, state.settings.ev);
  const out = new Float32Array(center.length);
  for (let i = 0; i < center.length; i += 3) {
    const r = center[i];
    const g = center[i + 1];
    const b = center[i + 2];
    out[i] = (m[0] * r + m[1] * g + m[2] * b) * k;
    out[i + 1] = (m[3] * r + m[4] * g + m[5] * b) * k;
    out[i + 2] = (m[6] * r + m[7] * g + m[8] * b) * k;
  }
  state.fringeAuto = autoDefringe(out, w, h, f);
  state.settings.defringe = { ...f, colors: state.fringeAuto.map(([amount, hue]) => [amount, (hue + 360) % 360]) };
}

// Camera parameters -> blur for the processed picture: 1 is the camera's
// own f/2 blur (aperture 1), synthetic depth of field adds to it.
function processedBlur({ aperture = 0, dof = 0 }) {
  const r = state.pp.radius || 0.5;
  return aperture + (dof * 14) / Math.max(1e-6, r);
}

function processedPixels(params) {
  const pp = state.pp;
  const rgb = pp.render({ ...params, blur: processedBlur(params) });
  return toPixels(rgb, pp.width, pp.height);
}

async function processedView({ id, ...params }) {
  const pixels = processedPixels(params);
  post({ id, type: 'result', width: state.pp.width, height: state.pp.height, pixels: pixels.buffer }, [pixels.buffer]);
  return undefined;
}

async function processedFrames({ id, job, list, kind }) {
  state.jobs[kind] = job;
  for (let i = 0; i < list.length; i++) {
    if (state.jobs[kind] !== job) return { cancelled: true };
    const pixels = processedPixels(list[i]);
    post({ id, type: 'frame', index: i, width: state.pp.width, height: state.pp.height, pixels: pixels.buffer }, [pixels.buffer]);
    await tick();
  }
  return { done: true };
}

// The photo's LUT, sent once when it changes (it is large).
async function setLut({ lut }) {
  state.lut = lut && lut.data ? lut : null;
  if (state.gpu) state.gpu.setLut(state.lut);
  return null;
}

const handlers = { setLut, open, frames, refocusFrames, superRes, view, focusAt, depthMap, spreadMask, whiteBalanceAt, prepare, settings, setGrid, rawCrop, outputToSensor, readSection,
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
