import { Engine, toImageData } from './engine.js';
import { blobReader, readThumbnail } from './core/lfp.js';
import { openFiles, pickCameraFolder, isLightFieldName, download, native } from './platform.js';

const $ = (id) => document.getElementById(id);
const engine = new Engine();
const canvas = $('view');
const ctx = canvas.getContext('2d');

const state = {
  info: null,
  mode: 'camera',
  interactive: false, // camera mode: showing the dragged viewpoint, not an animation frame
  frames: [], // ImageBitmap | undefined while rendering
  frameValues: [], // alpha per refocus frame
  loop: 'loop', // or 'pingpong'
  index: 0,
  direction: 1,
  playing: false,
  fps: 24,
  lastTick: 0,
  still: null, // ImageData of the full resolution render
  fullRes: false, // full resolution toggle
  library: [],
  current: null,
  explore: { u: 0, v: 0, busy: false, pending: null },
  stack: null, // pre-rendered stack from a processed LFP
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
  $('placeholder').innerHTML = `<p>Could not open this file.</p><p class="hint"></p>`;
  $('placeholder').querySelector('.hint').textContent = err.message || String(err);
}

// ---------------------------------------------------------------- library

function addToLibrary(entries) {
  for (const e of entries) {
    if (state.library.some((x) => x.name === e.name && x.size === e.size)) continue;
    const item = { name: e.name, size: e.size, file: e.file, thumb: null };
    state.library.push(item);
    readThumbnail(blobReader(e.file)).then((t) => {
      if (t) {
        item.thumb = URL.createObjectURL(new Blob([t.bytes], { type: t.mime }));
        renderLibrary();
      }
    }).catch(() => {});
  }
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
    li.append(img, name);
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

async function openWith(args, transfer) {
  stopFrames();
  state.info = null;
  state.stack = null;
  state.still = null;
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

// ---------------------------------------------------------------- playback

function stopFrames() {
  engine.cancel('frames');
  engine.cancel('refocus');
  state.frames = [];
  state.frameValues = [];
  state.index = 0;
  state.direction = 1;
}

function setFrames(count, loop) {
  state.frames = new Array(count);
  state.loop = loop;
  state.index = 0;
  state.direction = 1;
  $('scrub').max = Math.max(0, count - 1);
}

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

function showFrame(i) {
  const f = state.frames[i];
  if (f && !(state.mode === 'camera' && state.interactive)) draw(f);
  $('scrub').value = i;
  const ready = state.frames.filter(Boolean).length;
  const val = state.frameValues[i];
  $('frame-label').textContent = `${i + 1}/${state.frames.length}` +
    (ready < state.frames.length ? ` (rendering ${ready})` : '') +
    (val !== undefined ? ` · focus ${val.toFixed(2)}` : '');
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
  if (p) state.interactive = false;
  $('play-btn').textContent = p ? 'Pause' : 'Play';
}

async function receiveFrames(type, kind, args) {
  const { promise } = engine.job(type, kind, args, {
    onProgress: showProgress,
    onFrame: async (msg) => {
      hideProgress();
      const bmp = await createImageBitmap(toImageData(msg));
      state.frames[msg.index] = bmp;
      if (msg.index === state.index || !state.frames[state.index]) {
        state.index = msg.index;
        showFrame(msg.index);
      }
    },
  });
  try {
    await promise;
  } catch (err) {
    showError(err);
  }
  hideProgress();
}

// ---------------------------------------------------------------- modes

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

function startPerspective() {
  if (state.stack) {
    state.interactive = false;
    return startStack();
  }
  const n = +$('frames').value;
  const r = state.info.radius * +$('amount').value;
  const path = [];
  for (let i = 0; i < n; i++) {
    const [x, y] = pathPoint($('path').value, i / n);
    path.push({ u: x * r, v: y * r });
  }
  setFrames(n, 'loop');
  receiveFrames('frames', 'frames', { path });
}

function refocusAlphas() {
  const n = +$('steps').value;
  const near = +$('near').value;
  const far = +$('far').value;
  return Array.from({ length: n }, (_, i) => near + ((far - near) * i) / (n - 1));
}

function startRefocus() {
  if (state.stack) return startStack();
  const alphas = refocusAlphas();
  setFrames(alphas.length, 'pingpong');
  state.frameValues = alphas;
  receiveFrames('refocusFrames', 'refocus', { alphas });
}

function startStack() {
  setFrames(state.stack.bitmaps.length, 'pingpong');
  state.frames = [...state.stack.bitmaps];
  state.frameValues = state.stack.values;
  showFrame(0);
}

async function renderExplore() {
  const ex = state.explore;
  if (ex.busy) {
    ex.pending = true;
    return;
  }
  ex.busy = true;
  try {
    const msg = await engine.request('view', { u: ex.u, v: ex.v });
    draw(toImageData(msg));
  } finally {
    ex.busy = false;
    if (ex.pending) {
      ex.pending = false;
      renderExplore();
    }
  }
}

async function renderStill() {
  const alpha = +$('still-focus').value;
  const scale = +$('still-scale').value;
  try {
    const { promise } = engine.job('superRes', 'superres', { alpha, scale }, { onProgress: showProgress });
    const msg = await promise;
    // Ignore a result that arrives after full resolution was switched off.
    if (msg && msg.pixels && state.fullRes) {
      state.still = toImageData(msg);
      draw(state.still);
      $('frame-label').textContent = `${msg.width}×${msg.height} · focus ${alpha.toFixed(2)}`;
    }
  } catch (err) {
    showError(err);
  } finally {
    hideProgress();
  }
}

// Full resolution is a toggle over whatever is on screen: it pauses playback
// and re-renders the current picture from every sensor pixel. In Refocus mode
// it keeps the focus of the current frame.
function setFullRes(on, { restore = true } = {}) {
  if (on && !(state.info && state.info.hasRaw && state.mode !== 'lenslets')) return;
  state.fullRes = on;
  $('fullres-btn').setAttribute('aria-pressed', String(on));
  $('fullres-panel').hidden = !on;
  if (on) {
    setPlaying(false);
    const alpha = state.mode === 'refocus' ? state.frameValues[state.index] : undefined;
    if (alpha !== undefined) $('still-focus').value = alpha.toFixed(2);
    renderStill();
    return;
  }
  engine.cancel('superres');
  hideProgress();
  state.still = null;
  if (!restore) return;
  if (state.mode === 'camera' && state.interactive) renderExplore();
  else if (state.mode === 'lenslets') renderLenslets();
  else showFrame(state.index);
}

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

function setMode(mode) {
  state.mode = mode;
  for (const b of document.querySelectorAll('#modes button')) b.classList.toggle('active', b.dataset.mode === mode);
  for (const p of document.querySelectorAll('[data-panel]')) p.hidden = p.dataset.panel !== mode;
  const raw = state.info && state.info.hasRaw;
  for (const b of document.querySelectorAll('#modes button')) {
    b.disabled = !state.info || (!raw && !['camera', 'refocus'].includes(b.dataset.mode));
  }
  if (!state.info) return;
  if (state.fullRes) setFullRes(false, { restore: false });
  $('fullres-btn').disabled = !raw || mode === 'lenslets';
  layoutCanvas();
  stopFrames();
  const animated = mode === 'camera' || mode === 'refocus';
  $('play-btn').disabled = !animated;
  $('webm-btn').disabled = !animated;
  $('scrub').disabled = !animated;
  $('frame-label').textContent = '';
  if (mode === 'camera') {
    // Show the centre view for dragging; the animation renders behind it.
    startPerspective();
    if (!state.stack) {
      state.interactive = true;
      state.explore.u = 0;
      state.explore.v = 0;
      renderExplore();
    }
  } else if (mode === 'refocus') startRefocus();
  else if (mode === 'lenslets') {
    renderLenslets();
    renderGridInfo();
  }
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
    `centre (${fmt(g.ox, 2)}, ${fmt(g.oy, 2)}). Alignment score ${fmt(info.gridQuality, 3)}.`;
}

// ---------------------------------------------------------------- zoom

// Zoom is a multiple of the fit-to-window scale, and the view centre is kept
// in normalised image coordinates, so both survive switching between the
// animation frames and a larger full resolution still.
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

// Drag to pan when zoomed in (Shift+drag in Explore mode, where a plain drag
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

// ---------------------------------------------------------------- picking

function canvasPoint(event) {
  const rect = canvas.getBoundingClientRect();
  return [((event.clientX - rect.left) / rect.width) * canvas.width, ((event.clientY - rect.top) / rect.height) * canvas.height];
}

// Gradient energy around (x, y) in each frame; returns the sharpest index.
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

async function focusStillAt(x, y) {
  // Map from the still's resolution to view resolution, then probe a sweep.
  const scale = state.still ? state.still.width / state.info.width : 1;
  const alphas = Array.from({ length: 25 }, (_, i) => -1.2 + i * 0.1);
  const frames = [];
  const { promise } = engine.job('refocusFrames', 'refocus', { alphas }, {
    onProgress: showProgress,
    onFrame: async (msg) => { frames[msg.index] = await createImageBitmap(toImageData(msg)); },
  });
  await promise;
  await new Promise((r) => setTimeout(r, 50));
  hideProgress();
  const best = sharpestFrame(frames, x / scale, y / scale, 8);
  if (best >= 0 && state.fullRes) {
    $('still-focus').value = alphas[best].toFixed(2);
    renderStill();
  }
}

canvas.addEventListener('click', (event) => {
  if (suppressClick) {
    suppressClick = false;
    return;
  }
  if (!state.info) return;
  const [x, y] = canvasPoint(event);
  if (state.fullRes) {
    focusStillAt(x, y);
  } else if (state.mode === 'refocus' && state.frames.length) {
    const best = sharpestFrame(state.frames, x, y);
    if (best >= 0) {
      setPlaying(false);
      state.index = best;
      showFrame(best);
    }
  }
});

canvas.addEventListener('pointerdown', (event) => {
  if (!state.info || event.button !== 0) return;
  if (event.shiftKey || (view.k > 1 && state.mode !== 'camera')) {
    startPan(event);
    return;
  }
  if (state.mode !== 'camera' || state.stack) return;
  // Drag to turn the viewpoint, like grabbing the scene: dragging across half
  // the picture moves through the whole aperture.
  canvas.setPointerCapture(event.pointerId);
  const rect = canvas.getBoundingClientRect();
  const r = state.info.radius;
  const start = { x: event.clientX, y: event.clientY, u: state.explore.u, v: state.explore.v };
  let moved = false;
  canvas.onpointermove = (e) => {
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    if (!moved && Math.hypot(dx, dy) < 3) return;
    if (!moved) {
      moved = true;
      if (state.fullRes) setFullRes(false, { restore: false });
      setPlaying(false);
      state.interactive = true;
    }
    let u = start.u - (dx / (rect.width / 2)) * r;
    let v = start.v - (dy / (rect.height / 2)) * r;
    const len = Math.hypot(u, v);
    if (len > r) {
      u *= r / len;
      v *= r / len;
    }
    state.explore.u = u;
    state.explore.v = v;
    renderExplore();
  };
  canvas.onpointerup = () => {
    canvas.onpointermove = null;
    suppressClick = moved;
  };
});

canvas.addEventListener('dblclick', () => {
  if (state.mode !== 'camera' || state.stack) return;
  if (state.fullRes) setFullRes(false, { restore: false });
  setPlaying(false);
  state.interactive = true;
  state.explore.u = 0;
  state.explore.v = 0;
  renderExplore();
});

// ---------------------------------------------------------------- export

function baseName() {
  return state.current ? state.current.name.replace(/\.[^.]+$/, '') : 'lytro';
}

function savePng() {
  canvas.toBlob((blob) => download(blob, `${baseName()}-${state.mode}.png`), 'image/png');
}

async function exportVideo() {
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
  $('webm-btn').disabled = true;
  for (let i = 0; i < order.length; i++) {
    cctx.drawImage(frames[order[i]], 0, 0, c.width, c.height);
    showProgress('Recording video', i / order.length);
    await new Promise((r) => setTimeout(r, 1000 / state.fps));
  }
  recorder.stop();
  await done;
  hideProgress();
  $('webm-btn').disabled = false;
  const ext = mime.includes('mp4') ? 'mp4' : 'webm';
  download(new Blob(chunks, { type: mime }), `${baseName()}-${state.mode}.${ext}`);
}

// ---------------------------------------------------------------- camera

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
$('play-btn').onclick = () => {
  if (state.fullRes) setFullRes(false);
  setPlaying(!state.playing);
};
$('scrub').oninput = () => {
  if (state.fullRes) setFullRes(false, { restore: false });
  setPlaying(false);
  state.interactive = false;
  state.index = +$('scrub').value;
  showFrame(state.index);
};
$('png-btn').onclick = savePng;
$('webm-btn').onclick = exportVideo;
$('fullres-btn').onclick = () => setFullRes(!state.fullRes);
for (const id of ['still-focus', 'still-scale']) $(id).onchange = () => state.fullRes && renderStill();
$('grid-auto').onclick = () => updateGrid({ mode: 'auto' });
$('grid-meta').onclick = () => updateGrid({ mode: 'metadata' });
for (const id of ['lens-x', 'lens-y']) $(id).oninput = () => renderLenslets();

async function updateGrid(args) {
  const info = await engine.request('setGrid', args, { onProgress: showProgress });
  hideProgress();
  state.info = { ...state.info, ...info };
  state.still = null;
  renderInfo();
  if (state.fullRes) renderStill();
  else renderLenslets();
}

for (const b of document.querySelectorAll('#modes button')) b.onclick = () => setMode(b.dataset.mode);
for (const id of ['path', 'amount', 'frames']) $(id).onchange = () => state.info && setMode('camera');
for (const id of ['near', 'far', 'steps']) $(id).onchange = () => state.info && setMode('refocus');

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
  const wasFull = state.fullRes;
  state.still = null;
  setMode(state.mode);
  if (wasFull) setFullRes(true);
}
for (const id of ['ev', 'saturation', 'ccm', 'awb', 'detail']) $(id).onchange = applySettings;

document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, select, textarea')) return;
  if (e.code === 'Space') {
    e.preventDefault();
    setPlaying(!state.playing);
  } else if (e.key === '+' || e.key === '=') {
    zoomBy(1.5);
  } else if (e.key === '-' || e.key === '_') {
    zoomBy(1 / 1.5);
  } else if (e.key === 'f' || e.key === 'F') {
    setFullRes(!state.fullRes);
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
