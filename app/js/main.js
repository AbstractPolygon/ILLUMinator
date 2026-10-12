import { Engine, toImageData } from './engine.js';
import { blobReader, readThumbnail } from './core/lfp.js';
import { openFiles, pickCameraFolder, isLightFieldName, download, native } from './platform.js';

const $ = (id) => document.getElementById(id);
const engine = new Engine();
const canvas = $('view');
const ctx = canvas.getContext('2d');

const state = {
  info: null,
  mode: 'camera', // or 'lenslets'
  camera: { u: 0, v: 0 }, // viewpoint, sensor pixels within the lens aperture
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
  fullRes: false,
  depthShown: false,
  library: [],
  current: null,
  stack: null, // pre-rendered focus stack from a processed LFP
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
  state.stack = null;
  state.still = null;
  state.camera = { u: 0, v: 0 };
  setFullRes(false, { restore: false });
  setDepthShown(false, { restore: false });
}

function closePhoto() {
  resetView();
  state.current = null;
  canvas.classList.add('hidden');
  $('placeholder').hidden = false;
  $('placeholder').innerHTML = '<p>Drop a Lytro ILLUM <code>.LFR</code> or first generation <code>.LFP</code> file here.</p>';
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
    renderInfo();
    if (!info.hasRaw && info.stacks.length) {
      await loadStack(info.stacks);
    } else if (!info.hasRaw) {
      throw new Error('The file contains no light field image.');
    }
    setMode(state.mode);
  } catch (err) {
    showError(err);
  }
}

// Processed LFP files carry pre-rendered JPEG frames instead of raw data.
async function loadStack(stacks) {
  const focus = stacks.find((s) => s.images.some((i) => i.lambda !== undefined)) || stacks[0];
  const images = [...focus.images].sort((a, b) => (a.lambda ?? 0) - (b.lambda ?? 0));
  const bitmaps = await Promise.all(images.map((i) => createImageBitmap(new Blob([i.bytes], { type: i.mime }))));
  state.stack = { kind: focus.kind, bitmaps, values: images.map((i) => i.lambda ?? 0) };
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
  // About one view's worth of the aperture: render that single view (fast).
  if (ratio < 0.15) return { aperture: 0, dof: 0 };
  if (ratio <= 1) return { aperture: ratio, dof: 0 };
  const radius = state.info ? state.info.radius : 4.5;
  return { aperture: 1, dof: (radius * (ratio - 1)) / 14 };
}

function showFNumber() {
  const n = fNumber();
  $('fstop-label').textContent = `f/${n}`;
}

// Camera settings shared by the live view, animations and full resolution.
function cameraParams() {
  return {
    u: state.camera.u,
    v: state.camera.v,
    alpha: +$('focus').value,
    ...apertureFor(fNumber()),
  };
}

function showsCamera() {
  return state.mode === 'camera' && !state.fullRes && !state.depthShown && !state.showingFrames;
}

// Live camera view. Requests are coalesced: while one renders, only the
// latest settings are kept for the next.
async function renderCamera() {
  if (!state.info || !state.info.hasRaw) return;
  const v = state.view;
  if (v.busy) {
    v.pending = true;
    return;
  }
  v.busy = true;
  try {
    const msg = await engine.request('view', cameraParams(), { onProgress: showProgress });
    hideProgress();
    if (msg && msg.pixels && showsCamera()) draw(toImageData(msg));
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
    return { type: 'refocusFrames', kind: 'refocus', loop: 'pingpong', values: alphas, args: { alphas, u: p.u, v: p.v, aperture, dof: p.dof } };
  }
  const n = +$('frames').value;
  const r = state.info.radius * +$('amount').value;
  const path = Array.from({ length: n }, (_, i) => {
    const [x, y] = pathPoint($('path').value, i / n);
    return { u: x * r, v: y * r };
  });
  return { type: 'frames', kind: 'frames', loop: 'loop', values: [], args: { path, alpha: p.alpha, aperture: p.aperture, dof: p.dof } };
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
  if (state.stack) {
    if (!state.frames.length) {
      state.frames = [...state.stack.bitmaps];
      state.frameValues = state.stack.values;
      state.loop = 'pingpong';
      $('scrub').max = state.frames.length - 1;
      state.animDone = Promise.resolve();
    }
    return state.animDone;
  }
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
      state.frames[msg.index] = await createImageBitmap(toImageData(msg));
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
  if (state.stack) return;
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
  if (!state.showingFrames || state.stack) return;
  setPlaying(false);
  state.showingFrames = false;
  updateFrameLabel();
}

// ---------------------------------------------------------------- full resolution, depth

async function renderStill() {
  const scale = +$('still-scale').value;
  try {
    const { promise } = engine.job('superRes', 'superres', { ...cameraParams(), scale }, { onProgress: showProgress });
    const msg = await promise;
    // Ignore a result that arrives after full resolution was switched off.
    if (msg && msg.pixels && state.fullRes) {
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

// Full resolution is a toggle over the camera view: it re-renders what the
// camera shows (viewpoint, focus, aperture, depth of field) from every
// sensor pixel.
function setFullRes(on, { restore = true } = {}) {
  if (on && !(state.info && state.info.hasRaw && state.mode === 'camera')) return;
  if (on === state.fullRes) return;
  state.fullRes = on;
  $('fullres-btn').setAttribute('aria-pressed', String(on));
  $('fullres-panel').hidden = !on;
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
  if (on && !(state.info && state.info.hasRaw && state.mode === 'camera')) return;
  if (on === state.depthShown) return;
  state.depthShown = on;
  $('depth-btn').setAttribute('aria-pressed', String(on));
  $('depth-btn').textContent = on ? 'Hide depth' : 'Show depth';
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
  $('frame-label').textContent = `sensor ${msg.x0}–${msg.x0 + size}, ${msg.y0}–${msg.y0 + size}`;
}

// ---------------------------------------------------------------- modes

function setMode(mode) {
  state.mode = mode;
  for (const b of document.querySelectorAll('#modes button')) b.classList.toggle('active', b.dataset.mode === mode);
  for (const p of document.querySelectorAll('[data-panel]')) p.hidden = p.dataset.panel !== mode;
  const raw = !!(state.info && state.info.hasRaw);
  for (const b of document.querySelectorAll('#modes button')) b.disabled = !state.info || (!raw && b.dataset.mode !== 'camera');
  const camera = mode === 'camera';
  for (const id of ['fullres-btn', 'depth-btn', 'focus', 'fstop']) $(id).disabled = !raw || !camera;
  for (const id of ['play-btn', 'webm-btn', 'scrub']) $(id).disabled = !state.info || !camera;
  if (!state.info) return;
  setFullRes(false, { restore: false });
  setDepthShown(false, { restore: false });
  layoutCanvas();
  if (camera) {
    state.showingFrames = !!state.stack;
    if (state.stack) ensureAnimation();
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

function renderInfo() {
  const info = state.info;
  const rows = [];
  if (state.current) rows.push(['File', state.current.name]);
  if (info.cam) {
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
  } else if (info.stacks.length) {
    rows.push(['Content', info.stacks.map((s) => `${s.kind} (${s.images.length})`).join(', ')]);
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

// Gradient energy around (x, y) in each frame; returns the sharpest index.
// Used for pre-rendered focus stacks, which have no depth map.
function sharpestFrame(frames, x, y, radius = 10) {
  const size = radius * 2;
  const probe = new OffscreenCanvas(size, size);
  const pctx = probe.getContext('2d', { willReadFrequently: true });
  let best = -1;
  let bestScore = -Infinity;
  frames.forEach((f, i) => {
    if (!f) return;
    pctx.clearRect(0, 0, size, size);
    pctx.drawImage(f, x - radius, y - radius, size, size, 0, 0, size, size);
    const d = pctx.getImageData(0, 0, size, size).data;
    let s = 0;
    let m = 0;
    for (let j = 1; j < size - 1; j++) {
      for (let k = 1; k < size - 1; k++) {
        const o = (j * size + k) * 4;
        const l = d[o] + 2 * d[o + 1] + d[o + 2];
        const gx = d[o + 4] + 2 * d[o + 5] + d[o + 6] - (d[o - 4] + 2 * d[o - 3] + d[o - 2]);
        const gy = d[o + size * 4] + 2 * d[o + size * 4 + 1] + d[o + size * 4 + 2] - (d[o - size * 4] + 2 * d[o - size * 4 + 1] + d[o - size * 4 + 2]);
        s += gx * gx + gy * gy;
        m += l;
      }
    }
    const score = s / Math.max(1, m * m);
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  });
  return best;
}

// Click to focus on the clicked spot. With a small aperture everything is
// already sharp, so a click also opens up to f/2.8 to make the change visible.
async function focusAt(event) {
  if (state.stack) {
    const rect = canvas.getBoundingClientRect();
    const best = sharpestFrame(state.frames, ((event.clientX - rect.left) / rect.width) * canvas.width, ((event.clientY - rect.top) / rect.height) * canvas.height);
    if (best >= 0) {
      setPlaying(false);
      state.index = best;
      showFrame(best);
    }
    return;
  }
  const [x, y] = viewPoint(event);
  const res = await engine.request('focusAt', { x, y, u: state.camera.u, v: state.camera.v }, { onProgress: showProgress });
  hideProgress();
  if (!res || typeof res.alpha !== 'number') return;
  $('focus').value = res.alpha.toFixed(2);
  if (fNumber() > 4) {
    $('fstop').value = F_STOPS.indexOf(2.8);
    showFNumber();
  }
  cameraChanged({ final: true });
}

canvas.addEventListener('click', (event) => {
  if (suppressClick) {
    suppressClick = false;
    return;
  }
  if (!state.info || state.mode !== 'camera' || state.depthShown) return;
  focusAt(event);
});

canvas.addEventListener('pointerdown', (event) => {
  if (!state.info || event.button !== 0) return;
  if (event.shiftKey || (view.k > 1 && state.mode !== 'camera')) {
    startPan(event);
    return;
  }
  if (state.mode !== 'camera' || state.stack || !state.info.hasRaw) return;
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
    if (moved) invalidateAnimation();
  };
});

canvas.addEventListener('dblclick', () => {
  if (state.mode !== 'camera' || state.stack || !state.info) return;
  state.camera.u = 0;
  state.camera.v = 0;
  cameraChanged({ final: true });
});

// A camera setting changed: update the picture and drop stale animation
// frames. `final` is false while a slider is being dragged.
function cameraChanged({ final }) {
  invalidateAnimation();
  if (state.fullRes) {
    if (final) renderStill();
  } else if (!state.depthShown) {
    backToCamera();
    renderCamera();
  }
}

for (const id of ['focus', 'fstop']) {
  $(id).oninput = () => {
    showFNumber();
    cameraChanged({ final: false });
  };
  $(id).onchange = () => cameraChanged({ final: true });
}

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

async function importFromCamera() {
  let result;
  try {
    result = await pickCameraFolder();
  } catch (err) {
    if (err.name !== 'AbortError') showError(err);
    return;
  }
  const { files, source } = result;
  $('camera-dialog-source').textContent = files.length
    ? `${files.length} light field photo(s) found on ${source}.`
    : `No .LFR files found on ${source}. Pick the camera drive or its DCIM folder.`;
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
    readThumbnail(blobReader(f.file)).then((t) => {
      if (!t) return;
      const img = Object.assign(document.createElement('img'), { src: URL.createObjectURL(new Blob([t.bytes], { type: t.mime })), alt: '' });
      ph.replaceWith(img);
    }).catch(() => {});
    return label;
  }));
  $('camera-dialog').showModal();
  $('camera-dialog').onclose = () => {
    if ($('camera-dialog').returnValue !== 'import') return;
    const picked = [...grid.querySelectorAll('input:checked')].map((cb) => files[+cb.value]);
    addToLibrary(picked);
    if (picked.length) openItem(state.library.find((x) => x.name === picked[0].name));
  };
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
$('fullres-btn').onclick = () => setFullRes(!state.fullRes);
$('depth-btn').onclick = () => setDepthShown(!state.depthShown);
$('still-scale').onchange = () => state.fullRes && renderStill();
$('grid-auto').onclick = () => updateGrid({ mode: 'auto' });
$('grid-meta').onclick = () => updateGrid({ mode: 'metadata' });
for (const id of ['lens-x', 'lens-y']) $(id).oninput = () => renderLenslets();

async function updateGrid(args) {
  const info = await engine.request('setGrid', args, { onProgress: showProgress });
  hideProgress();
  state.info = { ...state.info, ...info };
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
  if (state.showingFrames && !state.stack) {
    backToCamera();
    renderCamera();
  }
}
for (const id of ['anim', 'path', 'amount', 'frames', 'near', 'far', 'steps']) $(id).onchange = animationSettingsChanged;

async function applySettings() {
  const settings = {
    ev: +$('ev').value,
    saturation: +$('saturation').value,
    useCcm: $('ccm').checked,
    autoWb: $('awb').checked,
    detail: +$('detail').value,
  };
  if (!state.info || !state.info.hasRaw) return;
  const info = await engine.request('settings', { settings });
  if (info) state.info = { ...state.info, ...info };
  state.still = null;
  invalidateAnimation();
  if (state.showingFrames) backToCamera();
  refresh();
}
for (const id of ['ev', 'saturation', 'ccm', 'awb', 'detail']) $(id).onchange = applySettings;

document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, select, textarea')) return;
  if (e.code === 'Space') {
    e.preventDefault();
    if (state.mode === 'camera' && state.info) setPlaying(!state.playing);
  } else if (e.key === '+' || e.key === '=') {
    zoomBy(1.5);
  } else if (e.key === '-' || e.key === '_') {
    zoomBy(1 / 1.5);
  } else if (e.key === 'f' || e.key === 'F') {
    setFullRes(!state.fullRes);
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
if (native) document.body.classList.add('native');

// Test hook: ?sample opens the synthetic sample on load.
if (new URLSearchParams(location.search).has('sample')) $('sample-btn').click();
