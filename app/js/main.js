import { VERSION } from './version.js';
import { readEdits, writeEdits, editsStore } from './edits.js';
import { Engine, toImageData } from './engine.js';
import { blobReader, readThumbnail } from './core/lfp.js';
import { openFiles, pickCameraFolder, isLightFieldName, download, native, NativeFile } from './platform.js';

const $ = (id) => document.getElementById(id);
const engine = new Engine();
const canvas = $('view');
const ctx = canvas.getContext('2d', { willReadFrequently: true });

const state = {
  info: null,
  mode: 'camera', // or 'lenslets'
  camera: { u: 0, v: 0 }, // viewpoint, sensor pixels within the lens aperture
  focusPoint: { x: 0.5, y: 0.5 }, // focus spread and tilt center, normalized picture coordinates
  // Camera mode shows either the live camera view or, while playing or
  // scrubbing, a frame of the animation.
  showingFrames: false,
  frames: [], // ImageBitmap | undefined while rendering
  frameValues: [], // focus value per frame of a focus sweep
  animKey: null, // settings the current frames were rendered with
  animDone: null, // promise resolved when every frame has arrived
  loop: 'loop', // or 'pingpong'
  index: 0,
  direction: 1,
  playing: false,
  fps: 24,
  lastTick: 0,
  still: null, // ImageData of the full resolution render
  fullResMode: false, // the Full resolution checkbox
  fullRes: false, // a full resolution still is shown (or rendering)
  depthShown: false,
  library: [],
  current: null,
  view: { busy: false, pending: false },
};

// ---------------------------------------------------------------- progress

function showProgress(stage, p) {
  $('progress').hidden = false;
  $('progress-text').textContent = stage;
  $('progress-fill').style.width = `${Math.round((p || 0) * 100)}%`;
}

function hideProgress() {
  $('progress').hidden = true;
}

function showError(err) {
  hideProgress();
  console.error(err);
  $('placeholder').hidden = false;
  $('placeholder').innerHTML = '<p>Could not open this file.</p><p class="hint"></p>';
  $('placeholder').querySelector('.hint').textContent = err.message || String(err);
}

// ---------------------------------------------------------------- library

function addToLibrary(entries) {
  for (const e of entries) {
    if (state.library.some((x) => x.name === e.name && x.size === e.size)) continue;
    const item = { name: e.name, size: e.size, file: e.file, thumb: null };
    state.library.push(item);
    readThumbnail(blobReader(e.file)).then((t) => {
      if (t && state.library.includes(item)) {
        item.thumb = URL.createObjectURL(new Blob([t.bytes], { type: t.mime }));
        renderLibrary();
      }
    }).catch(() => {});
  }
  renderLibrary();
}

// Removes a photo from the list (the file itself is untouched). Removing the
// open photo clears the picture.
function removeFromLibrary(item) {
  state.library = state.library.filter((x) => x !== item);
  if (item.thumb) URL.revokeObjectURL(item.thumb);
  if (state.current === item) closePhoto();
  renderLibrary();
}

function renderLibrary() {
  const list = $('library-list');
  list.replaceChildren(...state.library.map((item) => {
    const li = document.createElement('li');
    li.className = item === state.current ? 'current' : '';
    const img = item.thumb ? Object.assign(document.createElement('img'), { src: item.thumb, alt: '' }) : Object.assign(document.createElement('div'), { className: 'noimg' });
    const name = document.createElement('span');
    name.textContent = item.name;
    const remove = Object.assign(document.createElement('button'), { className: 'remove', type: 'button', textContent: '×', title: 'Remove from list' });
    remove.setAttribute('aria-label', `Remove ${item.name} from list`);
    remove.onclick = (e) => {
      e.stopPropagation();
      removeFromLibrary(item);
    };
    li.append(img, name, remove);
    li.onclick = () => openItem(item);
    return li;
  }));
  $('library-empty').hidden = state.library.length > 0;
}

// ---------------------------------------------------------------- opening

async function openItem(item) {
  state.current = item;
  renderLibrary();
  const bytes = await item.file.arrayBuffer();
  await openWith({ bytes }, [bytes]);
}

function resetView() {
  resetAnimation();
  state.info = null;
  state.still = null;
  state.camera = { u: 0, v: 0 };
  state.focusPoint = { x: 0.5, y: 0.5 };
  showFocusPoint();
  $('spread-overlay').hidden = true;
  setFullRes(false, { restore: false });
  setDepthShown(false, { restore: false });
}

function closePhoto() {
  resetView();
  $('histogram').getContext('2d').clearRect(0, 0, 256, 80);
  state.current = null;
  canvas.classList.add('hidden');
  $('placeholder').hidden = false;
  $('placeholder').innerHTML = '<p>Drop a Lytro <code>.LFR</code> or <code>.LFP</code> file here.</p>';
  $('info').replaceChildren();
  $('frame-label').textContent = '';
  setMode(state.mode);
}

async function openWith(args, transfer) {
  resetView();
  try {
    const info = await engine.request('open', args, { transfer, onProgress: showProgress });
    hideProgress();
    state.info = info;
    $('placeholder').hidden = true;
    await restoreEdits(info);
    showAutoFringe();
    renderInfo();
    if (!info.hasRaw && !info.processed) throw new Error('The file contains no light field image.');
    setMode(state.mode);
    if (info.hasRaw) engine.request('prepare').catch(() => {});
  } catch (err) {
    showError(err);
  }
}


// ---------------------------------------------------------------- drawing

function draw(img) {
  if (!img) return;
  if (canvas.width !== img.width || canvas.height !== img.height) {
    canvas.width = img.width;
    canvas.height = img.height;
    layoutCanvas();
  }
  if (img instanceof ImageData) ctx.putImageData(img, 0, 0);
  else ctx.drawImage(img, 0, 0);
  canvas.classList.remove('hidden');
  scheduleHistogram();
}

// ---------------------------------------------------------------- histogram

let histogramQueued = false;

// At most once per frame: the picture can change on every pointer move.
function scheduleHistogram() {
  if (histogramQueued) return;
  histogramQueued = true;
  requestAnimationFrame(() => {
    histogramQueued = false;
    drawHistogram();
  });
}

// RGB histogram of what the picture currently shows.
function drawHistogram() {
  const hc = $('histogram');
  const hctx = hc.getContext('2d');
  hctx.clearRect(0, 0, hc.width, hc.height);
  const w = canvas.width;
  const h = canvas.height;
  if (!state.info || !w || !h || canvas.classList.contains('hidden')) return;
  const data = ctx.getImageData(0, 0, w, h).data;
  const bins = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  // Sample about 250k pixels at most.
  const step = Math.max(1, Math.floor((w * h) / 250000)) * 4;
  for (let i = 0; i < data.length; i += step) {
    bins[0][data[i]]++;
    bins[1][data[i + 1]]++;
    bins[2][data[i + 2]]++;
  }
  // Scale to the tallest bin, ignoring the clipped ends, with a square root
  // so shadows and highlights stay readable.
  let max = 1;
  for (const b of bins) for (let i = 1; i < 255; i++) max = Math.max(max, b[i]);
  const H = hc.height;
  const colors = ['rgba(255, 90, 90, 0.75)', 'rgba(90, 220, 110, 0.75)', 'rgba(100, 150, 255, 0.75)'];
  hctx.globalCompositeOperation = 'lighter';
  bins.forEach((b, c) => {
    hctx.fillStyle = colors[c];
    hctx.beginPath();
    hctx.moveTo(0, H);
    for (let i = 0; i < 256; i++) hctx.lineTo(i, H - Math.min(1, Math.sqrt(b[i] / max)) * (H - 2));
    hctx.lineTo(255, H);
    hctx.closePath();
    hctx.fill();
  });
  hctx.globalCompositeOperation = 'source-over';
}

// Aperture stops offered by the f-stop slider, smallest aperture first.
const F_STOPS = [22, 16, 11, 8, 5.6, 4, 2.8, 2, 1.4, 1, 0.7, 0.5];

function fNumber() {
  return F_STOPS[+$('fstop').value];
}

// The camera recorded the light field through its own aperture (f/2 on the
// ILLUM). Stopping down uses a smaller part of it (synthetic aperture as a
// fraction of the recorded one); opening up past it adds blur from the depth
// map, scaled so the blur grows like a real lens's would.
function apertureFor(n) {
  const native = (state.info && state.info.cam && state.info.cam.capture && state.info.cam.capture.fNumber) || 2;
  const ratio = native / n;
  const radius = state.info ? state.info.radius : 4.5;
  // Normally the blur is drawn from the depth map over the sharp single view
  // (or the multi-view denoised merge), like Lytro's own renders: whatever
  // is in focus keeps full sharpness. "Optical" instead refocuses by
  // averaging the views, which is softer but follows the real optics.
  const field = focusField();
  if ($('bokeh').value !== 'optical' || +$('dof-depth').value !== 0 || field.spread > 0 || field.tilt.some((t) => t)) return { aperture: 0, dof: ratio < 0.15 ? 0 : (radius * ratio) / 14 };
  // About one view's worth of the aperture: render that single view (fast).
  if (ratio < 0.15) return { aperture: 0, dof: 0 };
  if (ratio <= 1) return { aperture: ratio, dof: 0 };
  return { aperture: 1, dof: (radius * (ratio - 1)) / 14 };
}

function showFNumber() {
  const n = fNumber();
  $('fstop-label').textContent = `f/${n}`;
}

// Focus spread and tilt. Depth values run from -1.6 to 1.6, so full spread
// keeps that whole range sharp around the focus depth, and full tilt changes
// the focus depth by 1.6 from one edge of the picture to the other. The
// tilted focus plane turns around the focus point (normalized x, y).
function focusField() {
  const tilt = 1.6 * $('tilt').value / 100;
  const angle = (+$('tilt-rotation').value * Math.PI) / 180;
  return {
    spread: 1.6 * $('spread').value / 100,
    tilt: [tilt * Math.cos(angle), tilt * Math.sin(angle)],
    point: [state.focusPoint.x, state.focusPoint.y],
  };
}

function showFocusPoint() {
  const { x, y } = state.focusPoint;
  $('focus-point').textContent = x === 0.5 && y === 0.5 ? 'Center' : `${Math.round(x * 100)}%, ${Math.round(y * 100)}%`;
}

// Show spread: tints what lies outside the sharp depth range, blue where
// nearer and orange where farther. Drawn on its own canvas over the picture
// (the histogram reads the picture). Requests are coalesced like the view.
const spreadView = { busy: false, pending: false };
async function updateSpreadOverlay() {
  const overlay = $('spread-overlay');
  const on = $('spread-show').checked && hasDepth() && state.mode === 'camera' && !state.depthShown;
  overlay.hidden = !on;
  $('spread-legend').hidden = !$('spread-show').checked;
  if (!on) return;
  if (spreadView.busy) {
    spreadView.pending = true;
    return;
  }
  spreadView.busy = true;
  try {
    const msg = await engine.request('spreadMask', { alpha: +$('focus').value, ...focusField() }, { onProgress: showProgress });
    hideProgress();
    if (msg && msg.pixels) {
      overlay.width = msg.width;
      overlay.height = msg.height;
      overlay.getContext('2d').putImageData(toImageData(msg), 0, 0);
    }
  } catch (err) {
    showError(err);
  } finally {
    spreadView.busy = false;
    if (spreadView.pending) {
      spreadView.pending = false;
      updateSpreadOverlay();
    }
  }
}

// Depth slider: the depth of field. Lower is shallower (things away from
// the focus blur faster), higher is deeper; each 50 steps is 4x the blur.
function depthOfFieldScale() {
  return 4 ** (-$('dof-depth').value / 50);
}

// Camera settings shared by the live view, animations and full resolution.
// Blur strength multiplies the simulated blur: a light field camera's own
// aperture is small, so true-to-the-optics blur is often subtle.
function cameraParams() {
  const lens = apertureFor(fNumber());
  return {
    u: state.camera.u,
    v: state.camera.v,
    alpha: +$('focus').value,
    aperture: lens.aperture,
    dof: lens.dof * depthOfFieldScale(),
    // The synthetic blur's options: bokeh shape and brightness, and the
    // focus field (spread and tilt).
    bokeh: { shape: ['natural', 'optical'].includes($('bokeh').value) ? 'smooth' : $('bokeh').value, highlights: +$('highlights').value, ...focusField() },
  };
}

// Raw photos and processed .lfp files both drive the camera view.
function canRender() {
  return !!(state.info && (state.info.hasRaw || state.info.processed));
}

function hasDepth() {
  return !!(state.info && (state.info.hasRaw || (state.info.processed && state.info.processed.hasDepth)));
}

function canDrag() {
  return !!(state.info && (state.info.hasRaw || (state.info.processed && state.info.processed.canDrag)));
}

function showsCamera() {
  return state.mode === 'camera' && !state.fullRes && !state.depthShown && !state.showingFrames;
}

// Live camera view. Requests are coalesced: while one renders, only the
// latest settings are kept for the next.
async function renderCamera() {
  if (!canRender()) return;
  const v = state.view;
  if (v.busy) {
    v.pending = true;
    return;
  }
  v.busy = true;
  try {
    const msg = await engine.request('view', cameraParams(), { onProgress: showProgress });
    hideProgress();
    if (msg && (msg.pixels || msg.bitmap) && showsCamera()) draw(toImageData(msg));
  } catch (err) {
    showError(err);
  } finally {
    v.busy = false;
    if (v.pending) {
      v.pending = false;
      renderCamera();
    }
  }
}

// Shows whatever the current state calls for.
function refresh() {
  if (!state.info) return;
  if (state.mode === 'lenslets') renderLenslets();
  else if (state.fullRes && state.still) draw(state.still);
  else if (state.fullRes) renderStill();
  else if (state.depthShown) renderDepth();
  else if (state.showingFrames) showFrame(state.index);
  else renderCamera();
}

// ---------------------------------------------------------------- animation

function pathPoint(kind, t) {
  const a = 2 * Math.PI * t;
  switch (kind) {
    case 'horizontal': return [Math.sin(a), 0];
    case 'vertical': return [0, Math.sin(a)];
    case 'figure8': return [Math.sin(a), 0.7 * Math.sin(2 * a)];
    case 'diagonal': return [Math.sin(a) * Math.SQRT1_2, Math.sin(a) * Math.SQRT1_2];
    default: return [Math.cos(a), Math.sin(a)];
  }
}

function animationRequest() {
  const p = cameraParams();
  if ($('anim').value === 'focus') {
    const n = +$('steps').value;
    const near = +$('near').value;
    const far = +$('far').value;
    const alphas = Array.from({ length: n }, (_, i) => near + ((far - near) * i) / (n - 1));
    // A small aperture would show little change: sweep at least wide open.
    const aperture = Math.max(p.aperture, 1);
    return { type: 'refocusFrames', kind: 'refocus', loop: 'pingpong', values: alphas, args: { alphas, u: p.u, v: p.v, aperture, dof: p.dof, bokeh: p.bokeh } };
  }
  const n = +$('frames').value;
  const r = state.info.radius * +$('amount').value;
  const path = Array.from({ length: n }, (_, i) => {
    const [x, y] = pathPoint($('path').value, i / n);
    return { u: x * r, v: y * r };
  });
  return { type: 'frames', kind: 'frames', loop: 'loop', values: [], args: { path, alpha: p.alpha, aperture: p.aperture, dof: p.dof, bokeh: p.bokeh } };
}

function resetAnimation() {
  engine.cancel('frames');
  engine.cancel('refocus');
  state.frames = [];
  state.frameValues = [];
  state.animKey = null;
  state.animDone = null;
  state.index = 0;
  state.direction = 1;
  state.showingFrames = false;
  setPlaying(false);
  $('scrub').max = 0;
  $('scrub').value = 0;
}

// Renders the animation frames unless they match the current settings.
function ensureAnimation() {
  const req = animationRequest();
  const key = JSON.stringify([req.type, req.args]);
  if (key === state.animKey) return state.animDone;
  engine.cancel(req.kind === 'frames' ? 'refocus' : 'frames');
  state.animKey = key;
  state.frames = new Array(req.type === 'frames' ? req.args.path.length : req.args.alphas.length);
  state.frameValues = req.values;
  state.loop = req.loop;
  state.index = 0;
  state.direction = 1;
  $('scrub').max = Math.max(0, state.frames.length - 1);
  const { promise } = engine.job(req.type, req.kind, req.args, {
    onProgress: showProgress,
    onFrame: async (msg) => {
      hideProgress();
      if (state.animKey !== key) return;
      state.frames[msg.index] = msg.bitmap || (await createImageBitmap(toImageData(msg)));
      if (state.showingFrames && (msg.index === state.index || !state.frames[state.index])) {
        state.index = msg.index;
        showFrame(msg.index);
      } else {
        updateFrameLabel();
      }
    },
  });
  state.animDone = promise.then(() => hideProgress(), (err) => showError(err));
  return state.animDone;
}

// A camera or animation setting changed: the frames are stale.
function invalidateAnimation() {
  if (state.animKey) {
    engine.cancel('frames');
    engine.cancel('refocus');
  }
  state.animKey = null;
  state.frames = [];
  state.frameValues = [];
  updateFrameLabel();
}

function updateFrameLabel() {
  const n = state.frames.length;
  if (!n || !state.showingFrames) {
    if (!state.fullRes) $('frame-label').textContent = '';
    return;
  }
  const ready = state.frames.filter(Boolean).length;
  const val = state.frameValues[state.index];
  $('frame-label').textContent = `${state.index + 1}/${n}` +
    (ready < n ? ` (rendering ${ready})` : '') +
    (val !== undefined ? ` · focus ${val.toFixed(2)}` : '');
}

function showFrame(i) {
  const f = state.frames[i];
  if (f && !state.fullRes && !state.depthShown) draw(f);
  $('scrub').value = i;
  updateFrameLabel();
}

function advance() {
  const n = state.frames.length;
  if (n < 2) return;
  let next = state.index + state.direction;
  if (state.loop === 'pingpong') {
    if (next >= n || next < 0) {
      state.direction = -state.direction;
      next = state.index + state.direction;
    }
  } else {
    next = (next + n) % n;
  }
  // Wait for frames that are still rendering.
  if (state.frames[next]) state.index = next;
}

function tick(t) {
  if (state.playing && state.frames.length > 1 && t - state.lastTick >= 1000 / state.fps) {
    state.lastTick = t;
    advance();
    showFrame(state.index);
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

function setPlaying(p) {
  state.playing = p;
  $('play-btn').textContent = p ? 'Pause' : 'Play';
  if (p) {
    setFullRes(false, { restore: false });
    setDepthShown(false, { restore: false });
    state.showingFrames = true;
    ensureAnimation();
    showFrame(state.index);
  }
}

// Shows the live camera view again after playing or scrubbing.
function backToCamera() {
  if (!state.showingFrames) return;
  setPlaying(false);
  state.showingFrames = false;
  updateFrameLabel();
}

// ---------------------------------------------------------------- full resolution, depth

async function renderStill() {
  const scale = +$('still-scale').value;
  try {
    const passes = +$('still-passes').value;
    const { promise } = engine.job('superRes', 'superres', { ...cameraParams(), scale, passes }, { onProgress: showProgress });
    const msg = await promise;
    // Ignore a result that arrives after full resolution was switched off.
    if (msg && (msg.pixels || msg.bitmap) && state.fullRes) {
      state.still = toImageData(msg);
      draw(state.still);
      $('frame-label').textContent = `${msg.width}×${msg.height}`;
    }
  } catch (err) {
    showError(err);
  } finally {
    hideProgress();
  }
}

// Full resolution re-renders what the camera shows (viewpoint, focus,
// aperture, depth of field) from every sensor pixel. The checkbox turns the
// mode on (Scale and Render appear); Render makes the still. Any change to
// the picture returns to the live view until Render is pressed again.
function setFullResMode(on) {
  if (on && !(state.info && state.info.hasRaw && state.mode === 'camera')) on = false;
  state.fullResMode = on;
  $('fullres-on').checked = on;
  $('fullres-panel').hidden = !on;
  $('render-btn').disabled = !on;
  if (!on) setFullRes(false);
}

function renderFullRes() {
  if (!state.fullResMode) return;
  if (state.fullRes) renderStill();
  else setFullRes(true);
}

function setFullRes(on, { restore = true } = {}) {
  if (on && !(state.fullResMode && state.info && state.info.hasRaw && state.mode === 'camera')) return;
  if (on === state.fullRes) return;
  state.fullRes = on;
  if (on) {
    setPlaying(false);
    state.showingFrames = false;
    setDepthShown(false, { restore: false });
    renderStill();
    return;
  }
  engine.cancel('superres');
  hideProgress();
  state.still = null;
  $('frame-label').textContent = '';
  if (restore) refresh();
}

async function renderDepth() {
  try {
    const msg = await engine.request('depthMap', {}, { onProgress: showProgress });
    hideProgress();
    if (msg && msg.pixels && state.depthShown) draw(toImageData(msg));
  } catch (err) {
    showError(err);
  }
}

function setDepthShown(on, { restore = true } = {}) {
  if (on && !(hasDepth() && state.mode === 'camera')) {
    $('depth-btn').checked = false;
    return;
  }
  if (on === state.depthShown) return;
  state.depthShown = on;
  updateSpreadOverlay();
  $('depth-btn').checked = on;
  $('depth-legend').hidden = !on;
  if (on) {
    setPlaying(false);
    state.showingFrames = false;
    setFullRes(false, { restore: false });
    renderDepth();
  } else if (restore) {
    refresh();
  }
}

// ---------------------------------------------------------------- lenslets

async function renderLenslets() {
  const info = state.info;
  const x = +$('lens-x').value * info.cam.width;
  const y = +$('lens-y').value * info.cam.height;
  const size = 160;
  const msg = await engine.request('rawCrop', { x, y, size });
  const zoom = 4;
  const img = new OffscreenCanvas(size, size);
  img.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(msg.pixels), size, size), 0, 0);
  canvas.width = size * zoom;
  canvas.height = size * zoom;
  layoutCanvas();
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, 0, 0, size * zoom, size * zoom);
  ctx.imageSmoothingEnabled = true;
  ctx.strokeStyle = 'rgba(242, 179, 61, 0.9)';
  ctx.lineWidth = 1.5;
  for (let i = 0; i < msg.centers.length; i += 2) {
    const cx = (msg.centers[i] + 0.5) * zoom;
    const cy = (msg.centers[i + 1] + 0.5) * zoom;
    ctx.beginPath();
    ctx.arc(cx, cy, 2.5, 0, 2 * Math.PI);
    ctx.stroke();
  }
  canvas.classList.remove('hidden');
  scheduleHistogram();
  $('frame-label').textContent = `sensor ${msg.x0}–${msg.x0 + size}, ${msg.y0}–${msg.y0 + size}`;
}

// ---------------------------------------------------------------- modes

function setMode(mode) {
  state.mode = mode;
  updateSpreadOverlay();
  for (const b of document.querySelectorAll('#modes button')) b.classList.toggle('active', b.dataset.mode === mode);
  for (const p of document.querySelectorAll('[data-panel]')) p.hidden = p.dataset.panel !== mode;
  const raw = !!(state.info && state.info.hasRaw);
  for (const b of document.querySelectorAll('#modes button')) b.disabled = !state.info || (!raw && b.dataset.mode !== 'camera');
  const camera = mode === 'camera';
  // Focus stacks bring their own blur; the depth effects need a depth map.
  const depthTools = hasDepth() && camera;
  const stack = !!(state.info && state.info.processed && state.info.processed.kind === 'focus');
  $('fullres-on').disabled = !raw || !camera;
  if (!raw || !camera) setFullResMode(false);
  for (const id of ['depth-btn', 'spread-show']) $(id).disabled = !depthTools;
  for (const id of ['fstop', 'bokeh', 'dof-depth', 'highlights', 'spread', 'tilt', 'tilt-rotation']) $(id).disabled = !depthTools || stack;
  $('mv-on').disabled = !raw;
  $('detail').disabled = !raw;
  for (const id of ['play-btn', 'webm-btn', 'scrub']) $(id).disabled = !state.info || !camera;
  $('png-btn').disabled = !state.info;
  if (!state.info) return;
  setFullRes(false, { restore: false });
  setDepthShown(false, { restore: false });
  layoutCanvas();
  if (camera) {
    state.showingFrames = false;
  } else {
    setPlaying(false);
    state.showingFrames = false;
    renderGridInfo();
  }
  $('frame-label').textContent = '';
  refresh();
}

// ---------------------------------------------------------------- info

function fmt(v, digits = 2) {
  return typeof v === 'number' ? v.toFixed(digits) : v;
}

// Resolution and Scale options show the picture size they give for this
// photo.
const RESOLUTION_NAMES = { 1: '1× (fast)', 1.5: '1.5×', 2: '2×' };
const SCALE_NAMES = { 2: '2× lens grid', 3: '3× lens grid', 4: '4× lens grid' };
function showResolutionSizes() {
  const label = (select, names, sizes) => {
    for (const o of select.options) {
      const size = sizes && sizes[o.value];
      o.textContent = `${names[o.value]}${size ? ` — ${size[0]}×${size[1]} px` : ''}`;
    }
  };
  label($('detail'), RESOLUTION_NAMES, state.info && state.info.sizes);
  label($('still-scale'), SCALE_NAMES, state.info && state.info.stillSizes);
}

function renderInfo() {
  showResolutionSizes();
  const info = state.info;
  const rows = [];
  if (state.current) rows.push(['File', state.current.name]);
  if (info.hasRaw) {
    const c = info.cam.capture || {};
    rows.push(['Camera', `${info.cam.make || ''} ${info.cam.model}`.trim()]);
    if (c.time) rows.push(['Taken', new Date(c.time).toLocaleString()]);
    if (c.exposure) rows.push(['Shutter', c.exposure >= 1 ? `${fmt(c.exposure, 1)} s` : `1/${Math.round(1 / c.exposure)} s`]);
    if (c.fNumber) rows.push(['Aperture', `f/${fmt(c.fNumber, 1)}`]);
    if (c.focalLength) rows.push(['Focal length', `${fmt(c.focalLength * 1000, 1)} mm`]);
    if (c.iso) rows.push(['ISO', Math.round(c.iso)]);
    rows.push(['Sensor', `${info.cam.width}×${info.cam.height}, ${info.cam.bits} bit`]);
    rows.push(['Views', `${info.width}×${info.height}`]);
    rows.push(['Lens pitch', `${fmt(info.grid.pitch, 3)} px`]);
    if (info.renderer) rows.push(['Rendering', info.renderer]);
  } else if (info.processed) {
    const p = info.processed;
    const kinds = { warp: 'All-in-focus image', single: 'Single image', focus: 'Focus stack', perspective: 'Perspective views' };
    if (info.cam) rows.push(['Camera', `${info.cam.make || ''} ${info.cam.model || ''}`.trim()]);
    if (info.cam && info.cam.capture && info.cam.capture.time) rows.push(['Taken', new Date(info.cam.capture.time).toLocaleString()]);
    rows.push(['Content', `${kinds[p.kind] || p.kind}${p.count > 1 ? ` (${p.count})` : ''}${p.hasDepth ? ' with depth map' : ''}`]);
    rows.push(['Size', `${info.width}×${info.height}`]);
  }
  $('info').replaceChildren(...rows.flatMap(([k, v]) => {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    return [dt, dd];
  }));
  renderGridInfo();
}

function renderGridInfo() {
  const info = state.info;
  if (!info || !info.grid) return;
  const g = info.grid;
  $('grid-info').textContent = `Pitch ${fmt(g.pitch, 3)} px, row step ${fmt(g.rowStep, 3)} px, rotation ${fmt(g.rotation * 1000, 3)} mrad, ` +
    `center (${fmt(g.ox, 2)}, ${fmt(g.oy, 2)}). Alignment score ${fmt(info.gridQuality, 3)}.`;
}

// ---------------------------------------------------------------- zoom

// Zoom is a multiple of the fit-to-window scale, and the view center is kept
// in normalized image coordinates, so both survive switching between the
// camera view and a larger full resolution still.
const view = { k: 1, cx: 0.5, cy: 0.5 };
const viewer = $('drop-zone');
const MAX_SCALE = 16;

function fitScale() {
  const vw = viewer.clientWidth;
  const vh = viewer.clientHeight;
  return Math.min(vw / canvas.width, vh / canvas.height) || 1;
}

function clampView(w, h) {
  const vw = viewer.clientWidth;
  const vh = viewer.clientHeight;
  view.cx = w <= vw ? 0.5 : Math.min(1 - vw / (2 * w), Math.max(vw / (2 * w), view.cx));
  view.cy = h <= vh ? 0.5 : Math.min(1 - vh / (2 * h), Math.max(vh / (2 * h), view.cy));
}

function layoutCanvas() {
  const fit = fitScale();
  view.k = Math.min(MAX_SCALE / fit, Math.max(1, view.k));
  const scale = fit * view.k;
  const w = canvas.width * scale;
  const h = canvas.height * scale;
  clampView(w, h);
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  canvas.style.left = `${viewer.clientWidth / 2 - view.cx * w}px`;
  canvas.style.top = `${viewer.clientHeight / 2 - view.cy * h}px`;
  // Show real pixels when inspecting detail.
  canvas.style.imageRendering = scale >= 2 ? 'pixelated' : 'auto';
  const overlay = $('spread-overlay');
  for (const k of ['width', 'height', 'left', 'top']) overlay.style[k] = canvas.style[k];
  canvas.classList.toggle('pannable', view.k > 1 && state.mode !== 'camera');
  $('zoom-label').textContent = view.k === 1 ? 'Fit' : `${Math.round(scale * 100)}%`;
  $('zoom-out').disabled = view.k <= 1;
  $('zoom-in').disabled = scale >= MAX_SCALE - 1e-6;
}

// Zooms by `factor`, keeping the image point under (mx, my) (viewer
// coordinates) in place; defaults to the middle of the viewer.
function zoomBy(factor, mx = viewer.clientWidth / 2, my = viewer.clientHeight / 2) {
  const fit = fitScale();
  const before = fit * view.k;
  const w = canvas.width * before;
  const h = canvas.height * before;
  const left = viewer.clientWidth / 2 - view.cx * w;
  const top = viewer.clientHeight / 2 - view.cy * h;
  const px = (mx - left) / w;
  const py = (my - top) / h;
  view.k = Math.min(MAX_SCALE / fit, Math.max(1, view.k * factor));
  const after = fit * view.k;
  view.cx = px - (mx - viewer.clientWidth / 2) / (canvas.width * after);
  view.cy = py - (my - viewer.clientHeight / 2) / (canvas.height * after);
  layoutCanvas();
}

function zoomFit() {
  view.k = 1;
  layoutCanvas();
}

function zoomActual() {
  view.k = 1 / fitScale();
  layoutCanvas();
}

viewer.addEventListener('wheel', (event) => {
  if (!state.info) return;
  event.preventDefault();
  const rect = viewer.getBoundingClientRect();
  zoomBy(Math.exp(-event.deltaY * (event.deltaMode === 1 ? 0.05 : 0.0015)), event.clientX - rect.left, event.clientY - rect.top);
}, { passive: false });

// Drag to pan when zoomed in (Shift+drag in camera mode, where a plain drag
// changes the viewpoint). A drag suppresses the click that follows it.
let suppressClick = false;
function startPan(event) {
  const scale = fitScale() * view.k;
  const start = { x: event.clientX, y: event.clientY, cx: view.cx, cy: view.cy };
  let moved = false;
  canvas.setPointerCapture(event.pointerId);
  canvas.classList.add('panning');
  canvas.onpointermove = (e) => {
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    if (Math.hypot(dx, dy) > 3) moved = true;
    view.cx = start.cx - dx / (canvas.width * scale);
    view.cy = start.cy - dy / (canvas.height * scale);
    layoutCanvas();
  };
  canvas.onpointerup = () => {
    canvas.onpointermove = null;
    canvas.classList.remove('panning');
    suppressClick = moved;
  };
}

new ResizeObserver(() => layoutCanvas()).observe(viewer);
$('zoom-in').onclick = () => zoomBy(1.5);
$('zoom-out').onclick = () => zoomBy(1 / 1.5);
$('zoom-label').onclick = zoomFit;
$('zoom-1').onclick = zoomActual;

// ---------------------------------------------------------------- pointer

// Pointer position in camera view pixels (the full resolution still is
// larger than the camera view; both cover the same picture).
function viewPoint(event) {
  const rect = canvas.getBoundingClientRect();
  const fx = (event.clientX - rect.left) / rect.width;
  const fy = (event.clientY - rect.top) / rect.height;
  return state.info && state.info.width ? [fx * state.info.width, fy * state.info.height] : [fx * canvas.width, fy * canvas.height];
}


// Click to focus on the clicked spot. With a small aperture everything is
// already sharp, so a click also opens up to f/2.8 to make the change visible.
async function focusAt(event) {
  const [x, y] = viewPoint(event);
  const rect = canvas.getBoundingClientRect();
  state.focusPoint = {
    x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)),
    y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)),
  };
  showFocusPoint();
  const res = await engine.request('focusAt', { x, y, u: state.camera.u, v: state.camera.v }, { onProgress: showProgress });
  hideProgress();
  if (!res || typeof res.alpha !== 'number') return;
  $('focus').value = res.alpha.toFixed(2);
  showSliderValue($('focus'));
  if (fNumber() > 4) {
    $('fstop').value = F_STOPS.indexOf(2.8);
    showFNumber();
  }
  cameraChanged({ final: true });
}

canvas.addEventListener('click', (event) => {
  if (state.picking) {
    pickWhiteBalance(event);
    return;
  }
  if (suppressClick) {
    suppressClick = false;
    return;
  }
  if (!state.info || state.mode !== 'camera' || state.depthShown) return;
  focusAt(event);
});

canvas.addEventListener('pointerdown', (event) => {
  if (!state.info || event.button !== 0 || state.picking) return;
  if (event.shiftKey || (view.k > 1 && state.mode !== 'camera')) {
    startPan(event);
    return;
  }
  if (state.mode !== 'camera' || !canDrag()) return;
  // Drag to turn the viewpoint, like grabbing the scene: dragging across half
  // the picture moves through the whole aperture.
  canvas.setPointerCapture(event.pointerId);
  const rect = canvas.getBoundingClientRect();
  const r = state.info.radius;
  const start = { x: event.clientX, y: event.clientY, u: state.camera.u, v: state.camera.v };
  let moved = false;
  canvas.onpointermove = (e) => {
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    if (!moved && Math.hypot(dx, dy) < 3) return;
    if (!moved) {
      moved = true;
      setFullRes(false, { restore: false });
      setDepthShown(false, { restore: false });
      backToCamera();
    }
    let u = start.u - (dx / (rect.width / 2)) * r;
    let v = start.v - (dy / (rect.height / 2)) * r;
    const len = Math.hypot(u, v);
    if (len > r) {
      u *= r / len;
      v *= r / len;
    }
    state.camera.u = u;
    state.camera.v = v;
    renderCamera();
  };
  canvas.onpointerup = () => {
    canvas.onpointermove = null;
    suppressClick = moved;
    if (moved) {
      invalidateAnimation();
      scheduleSave();
    }
  };
});

canvas.addEventListener('dblclick', () => {
  if (state.mode !== 'camera' || !canDrag()) return;
  state.camera.u = 0;
  state.camera.v = 0;
  cameraChanged({ final: true });
});

// A camera setting changed: update the picture and drop stale animation
// frames. `final` is false while a slider is being dragged.
function cameraChanged({ final }) {
  invalidateAnimation();
  scheduleSave();
  updateSpreadOverlay();
  if (state.fullRes) setFullRes(false, { restore: false });
  if (!state.depthShown) {
    backToCamera();
    renderCamera();
  }
}

for (const id of ['fstop', 'bokeh', 'dof-depth', 'highlights', 'spread', 'tilt', 'tilt-rotation']) {
  $(id).oninput = () => {
    showFNumber();
    showSliderValue($(id));
    cameraChanged({ final: false });
  };
  $(id).onchange = () => cameraChanged({ final: true });
}

$('spread-show').onchange = updateSpreadOverlay;

// ---------------------------------------------------------------- settings

// Settings window (gear at the right of the top bar).
async function showLibraryLocation() {
  $('library-path').classList.toggle('mono', !!native);
  if (native) {
    $('library-path').textContent = await native.libraryDir();
    $('library-note').textContent = 'Each photo is kept in its own folder in the library, with its edits next to it.';
    $('library-choose').hidden = false;
  } else {
    $('library-path').textContent = 'This browser’s storage';
    $('library-note').textContent = 'In a browser the library is stored privately by the browser. Use the desktop app to keep it in a folder of your choice.';
    $('library-choose').hidden = true;
  }
}

$('settings-btn').onclick = async () => {
  await showLibraryLocation();
  $('settings-btn').setAttribute('aria-expanded', 'true');
  $('settings-dialog').showModal();
};
$('settings-dialog').addEventListener('close', () => $('settings-btn').setAttribute('aria-expanded', 'false'));

$('library-choose').onclick = async () => {
  if (!native) return;
  const dir = await native.chooseLibraryDir();
  if (dir) await showLibraryLocation();
};

// ---------------------------------------------------------------- white balance eyedropper

// Click the eyedropper, then something in the photo that should be neutral:
// the worker finds the temperature and tint that make it so.
function setPicking(on) {
  state.picking = on && canRender() && state.mode === 'camera';
  $('wb-pick').setAttribute('aria-pressed', String(state.picking));
  canvas.classList.toggle('picking', state.picking);
}

async function pickWhiteBalance(event) {
  const [x, y] = viewPoint(event);
  setPicking(false);
  try {
    const res = await engine.request('whiteBalanceAt', { x, y });
    if (!res || !res.kelvin) return;
    $('awb').checked = false;
    $('wb-temperature').value = res.kelvin;
    $('wb-tint').value = res.tint;
    showSliderValue($('wb-temperature'));
    showSliderValue($('wb-tint'));
    await applySettings();
    scheduleSave();
  } catch (err) {
    showError(err);
  }
}

$('wb-pick').onclick = () => setPicking(!state.picking);

// ---------------------------------------------------------------- export

function baseName() {
  return state.current ? state.current.name.replace(/\.[^.]+$/, '') : 'lytro';
}

function savePng() {
  canvas.toBlob((blob) => download(blob, `${baseName()}.png`), 'image/png');
}

async function exportVideo() {
  $('webm-btn').disabled = true;
  try {
    await ensureAnimation();
    const frames = state.frames.filter(Boolean);
    if (frames.length < 2) return;
    const order = state.loop === 'pingpong'
      ? [...frames.keys(), ...[...frames.keys()].reverse().slice(1, -1)]
      : [...frames.keys(), ...frames.keys()];
    const w = frames[0].width;
    const h = frames[0].height;
    const up = Math.max(1, Math.round(1080 / Math.max(w, h)));
    const c = document.createElement('canvas');
    c.width = w * up;
    c.height = h * up;
    const cctx = c.getContext('2d');
    cctx.imageSmoothingQuality = 'high';
    const stream = c.captureStream(state.fps);
    const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4'].find((m) => MediaRecorder.isTypeSupported(m));
    const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 12e6 });
    const chunks = [];
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const done = new Promise((r) => { recorder.onstop = r; });
    recorder.start();
    for (let i = 0; i < order.length; i++) {
      cctx.drawImage(frames[order[i]], 0, 0, c.width, c.height);
      showProgress('Recording video', i / order.length);
      await new Promise((r) => setTimeout(r, 1000 / state.fps));
    }
    recorder.stop();
    await done;
    const ext = mime.includes('mp4') ? 'mp4' : 'webm';
    download(new Blob(chunks, { type: mime }), `${baseName()}-${$('anim').value}.${ext}`);
  } finally {
    hideProgress();
    $('webm-btn').disabled = false;
  }
}

// ---------------------------------------------------------------- camera import

// Shows the photos found on a camera with thumbnails; `onImport(picked)`
// runs when the user confirms. thumb(file) -> Promise<{ mime, bytes } | null>.
function showCameraDialog({ files, thumb, onImport }) {
  const grid = $('camera-grid');
  grid.replaceChildren(...files.map((f, i) => {
    const label = document.createElement('label');
    const ph = document.createElement('div');
    ph.className = 'noimg';
    const name = document.createElement('div');
    name.className = 'name';
    const cb = Object.assign(document.createElement('input'), { type: 'checkbox', checked: true, value: i });
    name.append(cb, document.createTextNode(`${f.name} · ${(f.size / 1e6).toFixed(0)} MB`));
    label.append(ph, name);
    thumb(f).then((t) => {
      if (!t) return;
      const img = Object.assign(document.createElement('img'), { src: URL.createObjectURL(new Blob([t.bytes], { type: t.mime })), alt: '' });
      ph.replaceWith(img);
    }).catch(() => {});
    return label;
  }));
  $('camera-import').disabled = !files.length;
  if (!$('camera-dialog').open) $('camera-dialog').showModal();
  $('camera-dialog').onclose = () => {
    if ($('camera-dialog').returnValue !== 'import') return;
    onImport([...grid.querySelectorAll('input:checked')].map((cb) => files[+cb.value]));
  };
}

// Browser: the camera is a removable drive; the user picks it (or DCIM).
async function importFromCameraFolder() {
  let result;
  try {
    result = await pickCameraFolder();
  } catch (err) {
    if (err.name !== 'AbortError') showError(err);
    return;
  }
  const { files, source } = result;
  $('camera-select-row').hidden = true;
  $('camera-dest').hidden = true;
  $('camera-dialog-source').textContent = files.length
    ? `${files.length} light field photo(s) found on ${source}.`
    : `No .LFR files found on ${source}. Pick the camera drive or its DCIM folder.`;
  showCameraDialog({
    files,
    thumb: (f) => readThumbnail(blobReader(f.file)),
    onImport: (picked) => {
      addToLibrary(picked);
      if (picked.length) openItem(state.library.find((x) => x.name === picked[0].name));
    },
  });
}

// Desktop app: cameras are detected over USB; photos are copied into the
// import folder, then opened from there.
async function importFromConnectedCamera() {
  const cameras = await native.listCameras();
  const select = $('camera-select');
  $('camera-dest').hidden = false;
  $('camera-dest-path').textContent = await native.importDir();
  if (!cameras.length) {
    $('camera-select-row').hidden = true;
    $('camera-dialog-source').textContent = 'No Lytro camera found. Connect it with its USB cable and switch it on: it appears as a drive with a DCIM folder. ' +
      '(Cameras with USB debugging enabled are also found if adb is installed.)';
    showCameraDialog({ files: [], thumb: async () => null, onImport: () => {} });
    return;
  }
  select.replaceChildren(...cameras.map((c, i) => Object.assign(document.createElement('option'), { value: i, textContent: c.label })));
  $('camera-select-row').hidden = cameras.length < 2;
  const show = () => {
    const cam = cameras[+select.value || 0];
    $('camera-dialog-source').textContent = `${cam.files.length} light field photo(s) on ${cam.label}.`;
    showCameraDialog({
      files: cam.files,
      thumb: (f) => native.cameraThumbnail(cam.id, f.id),
      onImport: async (picked) => {
        if (!picked.length) return;
        const stop = native.onImportProgress((p) => showProgress(`Importing ${p.file} (${Math.min(p.index + 1, p.count)} of ${p.count})`, p.total ? p.bytes / p.total : 0));
        try {
          const files = await native.importFromCamera(cam.id, picked.map((f) => f.id), $('camera-dest-path').textContent);
          const entries = files.map((f) => ({ name: f.name, size: f.size, file: new NativeFile(f) }));
          addToLibrary(entries);
          if (entries.length) openItem(state.library.find((x) => x.name === entries[0].name));
        } catch (err) {
          showError(err);
        } finally {
          stop();
          hideProgress();
        }
      },
    });
  };
  select.onchange = show;
  show();
}

$('camera-dest-btn').onclick = async () => {
  const dir = await native.chooseImportDir();
  if (dir) $('camera-dest-path').textContent = dir;
};

function importFromCamera() {
  return native ? importFromConnectedCamera() : importFromCameraFolder();
}

$('camera-select-all').onclick = () => {
  const boxes = [...$('camera-grid').querySelectorAll('input')];
  const all = boxes.every((b) => b.checked);
  boxes.forEach((b) => { b.checked = !all; });
};

// ---------------------------------------------------------------- wiring

async function openPicked(files) {
  const lf = files.filter((f) => isLightFieldName(f.name));
  addToLibrary(lf.map((f) => ({ name: f.name, size: f.size, file: f })));
  if (lf.length) openItem(state.library.find((x) => x.name === lf[0].name));
}

$('open-btn').onclick = async () => openPicked(await openFiles());
$('camera-btn').onclick = importFromCamera;
$('sample-btn').onclick = () => {
  state.current = null;
  renderLibrary();
  openWith({ synthetic: { width: 3864, height: 2684 } });
};
$('play-btn').onclick = () => setPlaying(!state.playing);
$('scrub').oninput = () => {
  if (!state.frames.length) ensureAnimation();
  setFullRes(false, { restore: false });
  setDepthShown(false, { restore: false });
  state.playing = false;
  $('play-btn').textContent = 'Play';
  state.showingFrames = true;
  state.index = Math.min(+$('scrub').value, Math.max(0, state.frames.length - 1));
  showFrame(state.index);
};
$('png-btn').onclick = savePng;
$('webm-btn').onclick = exportVideo;
$('fullres-on').onchange = () => setFullResMode($('fullres-on').checked);
$('render-btn').onclick = renderFullRes;
$('depth-btn').onchange = () => setDepthShown($('depth-btn').checked);
$('still-scale').onchange = () => setFullRes(false);
$('still-passes').onchange = () => setFullRes(false);
$('grid-auto').onclick = () => updateGrid({ mode: 'auto' });
$('grid-meta').onclick = () => updateGrid({ mode: 'metadata' });
for (const id of ['lens-x', 'lens-y']) $(id).oninput = () => renderLenslets();

async function updateGrid(args) {
  const info = await engine.request('setGrid', args, { onProgress: showProgress });
  hideProgress();
  state.info = { ...state.info, ...info };
  if (state.fullRes) setFullRes(false, { restore: false });
  state.still = null;
  invalidateAnimation();
  renderInfo();
  renderLenslets();
}

for (const b of document.querySelectorAll('#modes button')) b.onclick = () => setMode(b.dataset.mode);

function animationSettingsChanged() {
  $('anim-viewpoint').hidden = $('anim').value !== 'viewpoint';
  $('anim-focus').hidden = $('anim').value !== 'focus';
  invalidateAnimation();
  if (state.showingFrames) {
    backToCamera();
    renderCamera();
  }
}
for (const id of ['anim', 'path', 'amount', 'frames', 'near', 'far', 'steps']) $(id).onchange = animationSettingsChanged;

async function applySettings() {
  const settings = {
    ev: +$('ev').value,
    saturation: 1 + $('saturation').value / 100,
    autoWb: $('awb').checked,
    wb: { kelvin: +$('wb-temperature').value, tint: +$('wb-tint').value },
    tone: Object.fromEntries(TONES.map((k) => [k, $(`tone-${k}`).value / 100])),
    mvDenoise: { on: $('mv-on').checked, blend: $('mv-blend').value / 100 },
    details: {
      amount: +$('sharp-amount').value,
      radius: +$('sharp-radius').value,
      detail: +$('sharp-detail').value,
      luminance: +$('nr-luminance').value,
      color: +$('nr-color').value,
    },
    color: { vibrance: $('vibrance').value / 100, ...Object.fromEntries(HUE_SLIDERS.map((k) => [k, $(`hue-${k}`).value / 100])) },
    detail: +$('detail').value,
    defringe: {
      on: $('fringe-on').checked,
      auto: $('fringe-auto').checked,
      radius: +$('fringe-radius').value,
      threshold: +$('fringe-threshold').value,
      // [amount, hue] for purple, green, red and blue fringes.
      colors: FRINGES.map((key) => [+$(`fringe-${key}`).value, (+$(`fringe-${key}-hue`).value + 360) % 360]),
    },
  };
  $('fringe-controls').disabled = !settings.defringe.on;
  $('fringe-auto').disabled = !settings.defringe.on;
  // Auto defringe sets the colors itself.
  for (const key of FRINGES) {
    $(`fringe-${key}`).disabled = settings.defringe.auto;
    $(`fringe-${key}-hue`).disabled = settings.defringe.auto;
  }
  $('wb-temperature').disabled = settings.autoWb;
  $('wb-tint').disabled = settings.autoWb;
  $('mv-blend').disabled = !settings.mvDenoise.on;
  $('fringe-radius-label').textContent = `${settings.defringe.radius} px`;
  showFringeHues();
  if (!canRender()) return;
  const info = await engine.request('settings', { settings });
  if (info) state.info = { ...state.info, ...info };
  showAutoFringe();
  showResolutionSizes();
  // Back to the live view: Render makes a new full resolution still.
  if (state.fullRes) setFullRes(false, { restore: false });
  state.still = null;
  invalidateAnimation();
  if (state.showingFrames) backToCamera();
  refresh();
}
const FRINGES = ['purple', 'green', 'red', 'blue'];

// Moves the defringe sliders to what auto defringe found.
function showAutoFringe() {
  const found = state.info && state.info.fringeAuto;
  if (!found || !$('fringe-auto').checked) return;
  FRINGES.forEach((key, i) => {
    $(`fringe-${key}`).value = found[i][0];
    $(`fringe-${key}-hue`).value = found[i][1];
  });
  showFringeHues();
}

function showFringeHues() {
  for (const key of FRINGES) $(`fringe-${key}-hue-label`).textContent = `${(+$(`fringe-${key}-hue`).value + 360) % 360}°`;
}

// Temperature starts at the white balance the camera used for this photo.
// Temperature starts at the white balance the camera used for this photo
// (`keep`: a saved value stays).
function resetTemperature(info, { keep = false } = {}) {
  const cct = info && info.cam && info.cam.capture && info.cam.capture.cct;
  const k = Math.min(10000, Math.max(2000, Math.round((cct || 5500) / 50) * 50));
  const input = $('wb-temperature');
  input.dataset.default = k;
  if (!keep) input.value = k;
  showSliderValue(input);
}

// ---------------------------------------------------------------- edits

// Every photo keeps its own edits (edits.js): restored when it opens, saved
// shortly after each change. Photos without saved edits start from the
// defaults.
const DEFAULT_EDITS = readEdits(document);
let saveTimer = null;

function photoKey(info) {
  if (info && info.photoId) return info.photoId;
  const cur = state.current;
  return cur ? `file:${cur.name}:${cur.file.size}` : null;
}

async function restoreEdits(info) {
  clearTimeout(saveTimer);
  state.editsKey = photoKey(info);
  const saved = state.editsKey ? await editsStore.load(state.editsKey) : null;
  state.restoring = true;
  try {
    const { view, focusPoint } = writeEdits(document, saved, DEFAULT_EDITS);
    resetTemperature(info, { keep: !!saved });
    state.camera = { ...view };
    state.focusPoint = { ...focusPoint };
    showFocusPoint();
    for (const input of document.querySelectorAll('aside.controls input[type=range]')) showSliderValue(input);
    showFNumber();
    $('anim-viewpoint').hidden = $('anim').value !== 'viewpoint';
    $('anim-focus').hidden = $('anim').value !== 'focus';
    await applySettings();
  } finally {
    state.restoring = false;
  }
}

function scheduleSave() {
  if (state.restoring || !state.editsKey || !canRender()) return;
  clearTimeout(saveTimer);
  const key = state.editsKey;
  saveTimer = setTimeout(() => {
    if (key !== state.editsKey) return;
    editsStore.save(key, readEdits(document, {
      photo: { id: key, name: state.current ? state.current.name : null },
      view: state.camera,
      focusPoint: state.focusPoint,
    }));
  }, 500);
}

for (const type of ['input', 'change']) $('controls').addEventListener(type, scheduleSave);

const TONES = ['contrast', 'highlights', 'shadows', 'whites', 'blacks'];
const HUE_SLIDERS = ['red', 'yellow', 'green', 'cyan', 'blue', 'magenta'];

// Color sliders update the picture while dragging (one request at a time),
// show their value and reset to their default on double-click.
let applying = null;
let applyAgain = false;
function applySettingsSoon() {
  if (applying) {
    applyAgain = true;
    return;
  }
  applying = applySettings().finally(() => {
    applying = null;
    if (applyAgain) {
      applyAgain = false;
      applySettingsSoon();
    }
  });
}
function showSliderValue(input) {
  const out = document.querySelector(`output[data-for="${input.id}"]`);
  if (!out) return;
  const v = +input.value;
  const sign = v > 0 ? '+' : v < 0 ? '−' : '';
  if (input.id === 'ev') out.textContent = `${sign}${Math.abs(v).toFixed(2)} EV`;
  else if (input.id === 'focus') out.textContent = `${sign}${Math.abs(v).toFixed(2)}`;
  else if (input.id === 'tilt-rotation') out.textContent = `${v}°`;
  else if (input.id === 'wb-temperature') out.textContent = `${v} K`;
  else if (input.id === 'sharp-radius') out.textContent = v.toFixed(1);
  else if (input.parentElement.closest('.details-panel')) out.textContent = `${v}`;
  else out.textContent = `${sign}${Math.abs(v)}`;
}
// Camera sliders with a default reset the same way.
for (const input of document.querySelectorAll('[data-panel=camera] input[type=range][data-default]')) {
  showSliderValue(input);
  input.addEventListener('dblclick', () => {
    input.value = input.dataset.default;
    input.oninput();
    input.onchange();
  });
}

for (const input of document.querySelectorAll('.color-panel input[type=range], .details-panel input[type=range]')) {
  showSliderValue(input);
  input.addEventListener('input', () => {
    showSliderValue(input);
    applySettingsSoon();
  });
  input.addEventListener('dblclick', () => {
    input.value = input.dataset.default;
    showSliderValue(input);
    applySettingsSoon();
  });
}

for (const id of ['awb', 'mv-on', 'detail', 'fringe-on', 'fringe-auto', 'fringe-radius', 'fringe-threshold', ...FRINGES.flatMap((k) => [`fringe-${k}`, `fringe-${k}-hue`])]) $(id).onchange = applySettings;
$('fringe-radius').oninput = () => { $('fringe-radius-label').textContent = `${$('fringe-radius').value} px`; };
for (const key of FRINGES) $(`fringe-${key}-hue`).oninput = showFringeHues;

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.picking) {
    setPicking(false);
    return;
  }
  if (e.target.matches('input, select, textarea')) return;
  if (e.code === 'Space') {
    e.preventDefault();
    if (state.mode === 'camera' && state.info) setPlaying(!state.playing);
  } else if (e.key === '+' || e.key === '=') {
    zoomBy(1.5);
  } else if (e.key === '-' || e.key === '_') {
    zoomBy(1 / 1.5);
  } else if (e.key === 'f' || e.key === 'F') {
    setFullResMode(!state.fullResMode);
  } else if (e.key === 'd' || e.key === 'D') {
    setDepthShown(!state.depthShown);
  } else if (e.key === '0') {
    zoomFit();
  } else if (e.key === '1') {
    zoomActual();
  }
});

// Files can be dropped anywhere in the window.
const drop = $('drop-zone');
let dragDepth = 0;
document.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return;
  dragDepth++;
  drop.classList.add('dragover');
});
document.addEventListener('dragover', (e) => {
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
});
document.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) drop.classList.remove('dragover');
});
document.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  drop.classList.remove('dragover');
  const files = [...(e.dataTransfer ? e.dataTransfer.files : [])];
  if (!files.length) return;
  if (!files.some((f) => isLightFieldName(f.name))) {
    showError(new Error(`${files[0].name} is not a Lytro file. Drop an .LFR, .LFP or .RAW file.`));
    return;
  }
  openPicked(files);
});

canvas.classList.add('hidden');
setMode('camera');
$('version').textContent = VERSION;

// Desktop app: show the photos already imported, and announce cameras as
// they are plugged in.
if (native) {
  document.body.classList.add('native');
  native.listLibrary().then((files) => addToLibrary(files.map((f) => ({ name: f.name, size: f.size, file: new NativeFile(f) })))).catch(() => {});
  native.onCamerasChanged((cams) => {
    const count = cams.reduce((n, c) => n + c.files.length, 0);
    $('camera-status').textContent = cams.length ? `Lytro camera connected · ${count} photo${count === 1 ? '' : 's'}` : '';
    $('camera-status').classList.toggle('connected', cams.length > 0);
  });
}

// Test hook: ?sample opens the synthetic sample on load.
if (new URLSearchParams(location.search).has('sample')) $('sample-btn').click();
