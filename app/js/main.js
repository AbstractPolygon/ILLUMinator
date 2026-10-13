import { VERSION } from './version.js';
import { readEdits, writeEdits, editsStore } from './edits.js';
import { Engine, toImageData } from './engine.js';
import { blobReader, readThumbnail, readPhotoSummary, openContainer } from './core/lfp.js';
import { findRecipe, recipeToEdits } from './core/recipe.js';
import { openFiles, pickCameraFolder, pickFolder, isLightFieldName, findSidecar, download, native, NativeFile } from './platform.js';
import { Library } from './library/library.js';
import { openStorage, memoryStorage } from './library/storage.js';
import { groupPhotos } from './library/scan.js';
import { parsePoints, formatPoints } from './core/curve.js';
import { parseMasks, defaultMask, MAX_MASKS } from './core/local.js';
import { TRACKS, PRESETS, FPS as KEY_FPS, emptyAnimation, parseAnimation, setKey, sample, hasKeys, cubicBezier } from './core/keyframes.js';
import { curveEditor } from './ui/curve-editor.js';
import { geometry, isIdentity, apply as applyMatrix, invert, rotateOrientation, flipOrientation, fitAspect, FULL_CROP } from './core/geometry.js';

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
  album: null, // album shown in the sidebar (null: all photos)
  current: null, // { photo, name, file, sidecar } of the open photo
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

// The photo library (library/library.js): every photo opened, dropped or
// imported is copied into it, in a folder of its own.
let lib = null;
let libReady = null;
const thumbs = new Map(); // photo id -> object URL (null while loading)
const PHOTO_DRAG = 'application/x-illuminator-photo';

async function openLibrary() {
  for (const url of thumbs.values()) if (url) URL.revokeObjectURL(url);
  thumbs.clear();
  const readSummary = (f) => readPhotoSummary(blobReader(f));
  try {
    lib = await new Library(await openStorage(), { readSummary }).load();
  } catch (err) {
    console.warn('Could not open the library; photos are kept for this session only', err);
    lib = await new Library(memoryStorage(), { readSummary }).load();
  }
  if (state.album && !lib.album(state.album)) state.album = null;
  renderLibrary();
  return lib;
}

async function asBlob(f) {
  if (!f || f instanceof Blob) return f;
  return new Blob([await f.arrayBuffer()], { type: /\.png$/i.test(f.name) ? 'image/png' : 'image/jpeg' });
}

function thumbFor(photo) {
  if (thumbs.has(photo.id)) return thumbs.get(photo.id);
  thumbs.set(photo.id, null);
  if (photo.thumb) {
    lib.thumbnail(photo).then(asBlob).then((blob) => {
      if (!blob || thumbs.get(photo.id) !== null) return;
      thumbs.set(photo.id, URL.createObjectURL(blob));
      renderLibrary();
    }).catch(() => {});
  }
  return null;
}

// A small picture of the photo as first shown, for photos whose file has no
// thumbnail of its own (Lytro Desktop's raw.lfp).
function saveThumbnail() {
  state.wantThumb = false;
  const photo = state.current && state.current.photo;
  if (!photo || !lib || !canvas.width) return;
  const s = Math.min(1, 320 / Math.max(canvas.width, canvas.height));
  const c = document.createElement('canvas');
  c.width = Math.round(canvas.width * s);
  c.height = Math.round(canvas.height * s);
  c.getContext('2d').drawImage(canvas, 0, 0, c.width, c.height);
  c.toBlob((blob) => {
    if (!blob) return;
    lib.saveThumbnail(photo, blob).then(() => {
      const old = thumbs.get(photo.id);
      if (old) URL.revokeObjectURL(old);
      thumbs.set(photo.id, URL.createObjectURL(blob));
      renderLibrary();
    }).catch(() => {});
  }, 'image/jpeg', 0.85);
}

const EMPTY_LIBRARY = 'Open .LFR / .LFP files, drop them here, or import from a camera or Lytro Desktop.';

function renderLibrary() {
  renderAlbums();
  const album = lib && state.album ? lib.album(state.album) : null;
  const photos = lib ? lib.list(state.album) : [];
  $('photos-title').textContent = album ? album.name : 'All photos';
  const current = state.current && state.current.photo;
  $('library-list').replaceChildren(...photos.map((photo) => {
    const li = document.createElement('li');
    li.className = photo === current ? 'current' : '';
    li.draggable = true;
    li.ondragstart = (e) => {
      e.dataTransfer.setData(PHOTO_DRAG, photo.id);
      e.dataTransfer.effectAllowed = 'copy';
    };
    const url = thumbFor(photo);
    const img = url ? Object.assign(document.createElement('img'), { src: url, alt: '' }) : Object.assign(document.createElement('div'), { className: 'noimg' });
    const name = document.createElement('span');
    name.textContent = photo.name;
    const more = Object.assign(document.createElement('button'), { className: 'more', type: 'button', textContent: '•••', title: 'Albums, delete' });
    more.setAttribute('aria-label', `Actions for ${photo.name}`);
    more.setAttribute('aria-haspopup', 'menu');
    more.onclick = (e) => {
      e.stopPropagation();
      photoMenu(photo, more);
    };
    li.append(img, name, more);
    li.onclick = () => openItem(photo);
    return li;
  }));
  renderGrid(photos, album);
  const empty = $('library-empty');
  empty.hidden = photos.length > 0;
  if (album) empty.textContent = 'No photos in this album yet. Drag photos onto the album, or use ••• on a photo.';
  else if (lib && !lib.persistent) empty.textContent = `${EMPTY_LIBRARY} This browser cannot store a library, so photos are kept until the page is closed.`;
  else empty.textContent = EMPTY_LIBRARY;
}

function renderAlbums() {
  const list = $('album-list');
  if (!lib) {
    list.replaceChildren();
    return;
  }
  const rows = [{ id: null, name: 'All photos', count: lib.photos.length }, ...lib.albums.map((a) => ({ id: a.id, name: a.name, count: a.photos.length }))];
  list.replaceChildren(...rows.map((row) => {
    const li = document.createElement('li');
    li.classList.toggle('current', state.album === row.id);
    const b = Object.assign(document.createElement('button'), { type: 'button', className: 'album' });
    const name = Object.assign(document.createElement('span'), { className: 'name', textContent: row.name });
    const count = Object.assign(document.createElement('span'), { className: 'count', textContent: row.count });
    b.append(name, count);
    b.onclick = () => {
      state.album = row.id;
      showGrid(true);
    };
    li.append(b);
    if (row.id) {
      const more = Object.assign(document.createElement('button'), { className: 'more', type: 'button', textContent: '•••', title: 'Rename, delete' });
      more.setAttribute('aria-label', `Actions for album ${row.name}`);
      more.setAttribute('aria-haspopup', 'menu');
      more.onclick = () => albumMenu(row.id, li, more);
      li.append(more);
      // Photos dragged from the list are added to the album.
      li.ondragover = (e) => {
        if (![...e.dataTransfer.types].includes(PHOTO_DRAG)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        li.classList.add('drop');
      };
      li.ondragleave = () => li.classList.remove('drop');
      li.ondrop = async (e) => {
        const id = e.dataTransfer.getData(PHOTO_DRAG);
        li.classList.remove('drop');
        if (!id) return;
        e.preventDefault();
        e.stopPropagation();
        await lib.addToAlbum(row.id, [id]);
        renderLibrary();
      };
    }
    return li;
  }));
}

// ------------------------------------------------ grid

// Choosing an album shows its photos as thumbnails in place of the picture;
// opening a photo goes back to the picture.
const THUMB_SIZE_KEY = 'illuminator.thumbSize';

function showGrid(on) {
  state.grid = on;
  document.querySelector('.stage').classList.toggle('grid', on);
  $('grid-view').hidden = !on;
  if (on) {
    if (state.playing) setPlaying(false);
    renderLibrary();
  } else {
    layoutCanvas();
  }
}

function setThumbSize(px) {
  const input = $('thumb-size');
  const v = Math.min(+input.max, Math.max(+input.min, Math.round(px / 10) * 10));
  input.value = v;
  $('photo-grid').style.setProperty('--thumb', `${v}px`);
  $('thumb-smaller').disabled = v <= +input.min;
  $('thumb-bigger').disabled = v >= +input.max;
  try {
    localStorage.setItem(THUMB_SIZE_KEY, String(v));
  } catch {
    // Storage unavailable: the size is not remembered.
  }
}

$('thumb-size').oninput = () => setThumbSize(+$('thumb-size').value);
$('thumb-smaller').onclick = () => setThumbSize(+$('thumb-size').value / 1.25);
$('thumb-bigger').onclick = () => setThumbSize(+$('thumb-size').value * 1.25);
{
  let saved = 180;
  try {
    saved = +(localStorage.getItem(THUMB_SIZE_KEY) || 180);
  } catch {
    // Storage unavailable: default size.
  }
  setThumbSize(saved);
}

function renderGrid(photos, album) {
  if (!state.grid) return;
  $('grid-title').textContent = album ? album.name : 'All photos';
  $('grid-count').textContent = `${photos.length} photo${photos.length === 1 ? '' : 's'}`;
  const current = state.current && state.current.photo;
  $('photo-grid').replaceChildren(...photos.map((photo) => {
    const tile = document.createElement('div');
    tile.className = photo === current ? 'tile current' : 'tile';
    tile.tabIndex = 0;
    tile.setAttribute('role', 'button');
    tile.setAttribute('aria-label', `Open ${photo.name}`);
    tile.draggable = true;
    tile.ondragstart = (e) => {
      e.dataTransfer.setData(PHOTO_DRAG, photo.id);
      e.dataTransfer.effectAllowed = 'copy';
    };
    const frame = Object.assign(document.createElement('div'), { className: 'frame' });
    const url = thumbFor(photo);
    if (url) frame.append(Object.assign(document.createElement('img'), { src: url, alt: '' }));
    const name = Object.assign(document.createElement('div'), { className: 'name', textContent: photo.name, title: photo.name });
    const more = Object.assign(document.createElement('button'), { className: 'more', type: 'button', textContent: '•••', title: 'Albums, delete' });
    more.setAttribute('aria-label', `Actions for ${photo.name}`);
    more.setAttribute('aria-haspopup', 'menu');
    more.onclick = (e) => {
      e.stopPropagation();
      photoMenu(photo, more);
    };
    tile.append(frame, name, more);
    tile.onclick = () => openItem(photo);
    tile.onkeydown = (e) => {
      if (e.target === tile && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        openItem(photo);
      }
    };
    return tile;
  }));
  $('grid-empty').hidden = photos.length > 0;
  $('grid-empty').textContent = album
    ? 'No photos in this album yet. Drag photos onto the album in the sidebar, or use ••• on a photo.'
    : EMPTY_LIBRARY;
}

// An inline text field in place of `li`'s contents (new album, rename).
function editName(li, value, onDone) {
  const input = Object.assign(document.createElement('input'), { type: 'text', value, maxLength: 80 });
  input.setAttribute('aria-label', 'Album name');
  li.replaceChildren(input);
  let done = false;
  const finish = (ok) => {
    if (done) return;
    done = true;
    onDone(ok ? input.value.trim() : '');
  };
  input.onkeydown = (e) => {
    if (e.key === 'Enter') finish(true);
    else if (e.key === 'Escape') {
      e.stopPropagation();
      finish(false);
    }
  };
  input.onblur = () => finish(true);
  input.focus();
  input.select();
}

function newAlbum(photoIds = []) {
  if (!lib) return;
  const li = document.createElement('li');
  $('album-list').append(li);
  editName(li, '', async (name) => {
    if (name) {
      const album = await lib.createAlbum(name);
      if (photoIds.length) await lib.addToAlbum(album.id, photoIds);
      else state.album = album.id;
    }
    renderLibrary();
  });
}

$('album-new').onclick = () => newAlbum();

// ------------------------------------------------ menus

let menuEl = null;
let menuButton = null;

function closeMenu() {
  if (!menuEl) return;
  menuEl.remove();
  menuEl = null;
  if (menuButton) menuButton.setAttribute('aria-expanded', 'false');
  menuButton = null;
}

function placeMenu(anchor) {
  const r = anchor.getBoundingClientRect();
  const m = menuEl;
  const left = Math.max(8, Math.min(r.left, innerWidth - m.offsetWidth - 8));
  let top = r.bottom + 4;
  if (top + m.offsetHeight > innerHeight - 8) top = Math.max(8, r.top - m.offsetHeight - 4);
  m.style.left = `${left}px`;
  m.style.top = `${top}px`;
}

// items: { label, action, checked?, danger? } | { heading } | '-'. An action
// that returns true keeps the menu open.
function showMenu(anchor, items) {
  closeMenu();
  const m = document.createElement('div');
  m.className = 'menu';
  m.setAttribute('role', 'menu');
  menuEl = m;
  menuButton = anchor;
  anchor.setAttribute('aria-expanded', 'true');
  fillMenu(items);
  document.body.append(m);
  placeMenu(anchor);
  const first = m.querySelector('button');
  if (first) first.focus();
}

function fillMenu(items) {
  menuEl.replaceChildren(...items.map((it) => {
    if (it === '-') return document.createElement('hr');
    if (it.heading) return Object.assign(document.createElement('p'), { className: 'menu-heading', textContent: it.heading });
    const b = Object.assign(document.createElement('button'), { type: 'button' });
    b.setAttribute('role', it.checked === undefined ? 'menuitem' : 'menuitemcheckbox');
    if (it.checked !== undefined) b.setAttribute('aria-checked', String(it.checked));
    if (it.danger) b.classList.add('danger');
    if (it.checked !== undefined) b.append(Object.assign(document.createElement('span'), { className: 'tick', textContent: it.checked ? '✓' : '' }));
    b.append(document.createTextNode(it.label));
    b.onclick = async (e) => {
      e.stopPropagation();
      if ((await it.action()) !== true) closeMenu();
    };
    return b;
  }));
}

// Replaces the menu with a question and two buttons.
function confirmInMenu(text, label, onYes) {
  const p = Object.assign(document.createElement('p'), { textContent: text });
  const row = Object.assign(document.createElement('div'), { className: 'menu-row' });
  const no = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Cancel' });
  const yes = Object.assign(document.createElement('button'), { type: 'button', textContent: label, className: 'danger' });
  no.onclick = closeMenu;
  yes.onclick = async () => {
    closeMenu();
    await onYes();
  };
  row.append(no, yes);
  menuEl.replaceChildren(p, row);
  placeMenu(menuButton);
  yes.focus();
  return true;
}

document.addEventListener('pointerdown', (e) => {
  if (menuEl && !menuEl.contains(e.target) && e.target !== menuButton) closeMenu();
}, true);
document.addEventListener('keydown', (e) => {
  if (menuEl && e.key === 'Escape') {
    e.stopPropagation();
    const b = menuButton;
    closeMenu();
    if (b) b.focus();
  }
}, true);
window.addEventListener('resize', closeMenu);

function photoMenu(photo, button) {
  const items = [];
  items.push({ heading: 'Albums' });
  for (const a of lib.albums) {
    const inside = a.photos.includes(photo.id);
    items.push({
      label: a.name,
      checked: inside,
      action: async () => {
        if (inside) await lib.removeFromAlbum(a.id, [photo.id]);
        else await lib.addToAlbum(a.id, [photo.id]);
        renderLibrary();
      },
    });
  }
  items.push({ label: 'New album…', action: () => newAlbum([photo.id]) });
  items.push('-');
  const where = lib.store.kind === 'folder'
    ? 'Its folder (the photo and its edits) is moved to the trash.'
    : 'The photo and its edits are deleted from this browser’s storage.';
  items.push({
    label: lib.persistent ? 'Delete from library…' : 'Remove from list',
    danger: true,
    action: () => {
      const remove = async () => {
        await lib.remove([photo.id]);
        const url = thumbs.get(photo.id);
        if (url) URL.revokeObjectURL(url);
        thumbs.delete(photo.id);
        if (state.current && state.current.photo === photo) closePhoto();
        renderLibrary();
      };
      if (!lib.persistent) return remove();
      return confirmInMenu(`Delete ${photo.name} from the library? ${where}`, 'Delete', remove);
    },
  });
  showMenu(button, items);
}

function albumMenu(id, li, button) {
  const album = lib.album(id);
  if (!album) return;
  showMenu(button, [
    {
      label: 'Rename…',
      action: () => editName(li, album.name, async (name) => {
        if (name) await lib.renameAlbum(id, name);
        renderLibrary();
      }),
    },
    {
      label: 'Delete album…',
      danger: true,
      action: () => confirmInMenu(`Delete the album “${album.name}”? Its photos stay in the library.`, 'Delete', async () => {
        await lib.deleteAlbum(id);
        if (state.album === id) state.album = null;
        renderLibrary();
      }),
    },
  ]);
}

// Copies photos (scan.js entries) into the library, adding them to the
// album being shown. Returns the library photos.
async function importPhotos(entries, { album = state.album } = {}) {
  await libReady;
  if (!entries.length) return [];
  let added = [];
  try {
    added = await lib.add(entries, {
      onProgress: (e, i, n) => {
        if (e) showProgress(n > 1 ? `Adding ${e.name} to the library (${i + 1} of ${n})` : `Adding ${e.name} to the library`, i / n);
      },
    });
    if (album && lib.album(album)) await lib.addToAlbum(album, added.map((p) => p.id));
  } catch (err) {
    showError(err);
  } finally {
    hideProgress();
    renderLibrary();
  }
  return added;
}

// ---------------------------------------------------------------- opening

async function openItem(photo) {
  closeMenu();
  const file = await lib.file(photo).catch(() => null);
  if (!file) {
    showError(new Error(`${photo.name} is missing from the library folder.`));
    return;
  }
  const sidecar = await lib.sidecar(photo).catch(() => null);
  state.current = { photo, name: photo.name, file, sidecar };
  state.wantThumb = !photo.thumb;
  if (state.grid) showGrid(false);
  renderLibrary();
  const bytes = await file.arrayBuffer();
  await openWith({ bytes }, [bytes]);
  if (state.info && state.current && state.current.photo === photo) lib.setPhotoId(photo, state.info.photoId).catch(() => {});
}

function resetView() {
  finishCrop(false);
  state.lastImage = null;
  state.geom = null;
  hideNotice();
  state.notice = null;
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
  renderMasks();
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
    if (state.notice) showNotice(...state.notice);
    if (info.hasRaw) engine.request('prepare').catch(() => {});
  } catch (err) {
    showError(err);
  }
}


// ---------------------------------------------------------------- drawing

function draw(img) {
  if (!img) return;
  startNoticeTimer();
  state.lastImage = img;
  const g = geometryFor(img.width, img.height);
  const w = g ? g.width : img.width;
  const h = g ? g.height : img.height;
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
    layoutCanvas();
  }
  state.geom = g ? { ...g, inverse: invert(g.matrix), srcW: img.width, srcH: img.height } : null;
  if (g) drawGeometry(ctx, img, g);
  else if (img instanceof ImageData) ctx.putImageData(img, 0, 0);
  else ctx.drawImage(img, 0, 0);
  if (cropState.editing) positionCropBox();
  canvas.classList.remove('hidden');
  scheduleHistogram();
  if (state.wantThumb && state.mode === 'camera') saveThumbnail();
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
  if ($('bokeh').value !== 'optical' || +$('dof-depth').value !== 0 || field.spread > 0 || field.smooth > 0 || field.tilt.some((t) => t)) return { aperture: 0, dof: ratio < 0.15 ? 0 : (radius * ratio) / 14 };
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
    // Width of the soft edge of the sharp range, in the same units.
    smooth: 0.8 * $('spread-smooth').value / 100,
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
      const mask = toImageData(msg);
      const g = state.geom;
      if (g) {
        // Through the same crop and rotation as the picture.
        overlay.width = canvas.width;
        overlay.height = canvas.height;
        const k = geometry(mask.width, mask.height, geometrySettings());
        const o = overlay.getContext('2d');
        drawGeometry(o, mask, k, canvas.width / k.width);
      } else {
        overlay.width = msg.width;
        overlay.height = msg.height;
        overlay.getContext('2d').putImageData(mask, 0, 0);
      }
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
  const keyed = $('anim').value === 'keyframes' ? keyframeFrames() : null;
  if (keyed) {
    return { type: 'frames', kind: 'frames', loop: 'loop', values: [], framing: keyed.framing, args: { path: keyed.path, alpha: p.alpha, aperture: p.aperture, dof: p.dof, bokeh: p.bokeh } };
  }
  if ($('anim').value === 'keyframes') {
    // Fewer than two keyframes: the current view only.
    return { type: 'frames', kind: 'frames', loop: 'loop', values: [], framing: [liveFraming()], args: { path: [{ u: p.u, v: p.v }], alpha: p.alpha, aperture: p.aperture, dof: p.dof, bokeh: p.bokeh } };
  }
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
  state.framePivots = withPivotZoom(req.type === 'frames'
    ? req.args.path.map((f) => pivotFor(f.u, f.v, f.alpha ?? req.args.alpha, f.aperture ?? req.args.aperture))
    : req.args.alphas.map((alpha) => pivotFor(req.args.u, req.args.v, alpha, req.args.aperture)));
  if (req.framing) state.framePivots = state.framePivots.map((p, i) => combineMotion(p, req.framing[i]));
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
  if (typeof updatePlayhead === 'function') updatePlayhead();
}

function showFrame(i) {
  const f = state.frames[i];
  state.drawFrame = i;
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
  if (p && !$('anim-on').checked) return;
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
  for (const id of ['depth-btn', 'spread-show', 'depth-smooth']) $(id).disabled = !depthTools;
  for (const id of ['fstop', 'bokeh', 'dof-depth', 'highlights', 'spread', 'spread-smooth', 'tilt', 'tilt-rotation']) $(id).disabled = !depthTools || stack;
  $('mv-on').disabled = !raw;
  $('detail').disabled = !raw;
  for (const id of ['play-btn', 'webm-btn', 'scrub']) $(id).disabled = !state.info || !camera || !$('anim-on').checked;
  $('png-btn').disabled = !state.info;
  $('stereo-btn').disabled = !(state.info && state.info.hasRaw) || !camera;
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
  renderTimeline();
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
    if (info.hotPixels) rows.push(['Hot pixels fixed', info.hotPixels.toLocaleString()]);
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
  // While cropping, leave room around the picture for the frame's handles.
  const margin = cropState.editing ? 48 : 0;
  const vw = Math.max(1, viewer.clientWidth - margin);
  const vh = Math.max(1, viewer.clientHeight - margin);
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
  positionCropBox();
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
  const [fx, fy] = sourceFraction(event);
  return state.info && state.info.width ? [fx * state.info.width, fy * state.info.height] : [fx * canvas.width, fy * canvas.height];
}


// Click to focus on the clicked spot. With a small aperture everything is
// already sharp, so a click also opens up to f/2.8 to make the change visible.
async function focusAt(event) {
  const [x, y] = viewPoint(event);
  const [fx, fy] = sourceFraction(event);
  state.focusPoint = { x: Math.min(1, Math.max(0, fx)), y: Math.min(1, Math.max(0, fy)) };
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
  if (cropState.editing) return;
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
  if (!state.info || event.button !== 0 || state.picking || cropState.editing) return;
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

// Depth smoothing is applied in the worker like the color settings.
$('depth-smooth').oninput = () => {
  showSliderValue($('depth-smooth'));
  applySettingsSoon();
};
$('depth-smooth').onchange = () => {};

$('pivot-on').onchange = () => {
  $('pivot').disabled = !$('pivot-on').checked;
  invalidateAnimation();
  geometryChanged();
};
$('pivot').oninput = () => {
  showSliderValue($('pivot'));
  if (state.lastImage) draw(state.lastImage);
};
$('pivot').onchange = () => {
  invalidateAnimation();
  geometryChanged();
};

for (const id of ['fstop', 'bokeh', 'dof-depth', 'highlights', 'spread', 'spread-smooth', 'tilt', 'tilt-rotation']) {
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
  await libReady;
  const kind = lib.store.kind;
  $('library-path').classList.toggle('mono', kind === 'folder');
  $('library-choose').hidden = kind !== 'folder';
  if (kind === 'folder') {
    $('library-path').textContent = await native.libraryDir();
    $('library-note').textContent = 'Each photo is kept in its own folder in the library, with its edits next to it. Albums are listed in library.json.';
  } else if (kind === 'browser') {
    $('library-path').textContent = 'This browser’s storage';
    $('library-note').textContent = 'In a browser the library is stored privately by the browser. Use the desktop app to keep it in a folder of your choice.';
  } else {
    $('library-path').textContent = 'Not available';
    $('library-note').textContent = 'This browser cannot store a library here, so photos are kept until the page is closed. Use the desktop app or another browser to keep a library.';
  }
}

// A Lytro Desktop library (or any folder of photos), into a new album.
async function importFolder() {
  const picked = await pickFolder('Import a Lytro Desktop library or a folder of photos').catch((err) => {
    showError(err);
    return null;
  });
  if (!picked) return;
  const entries = groupPhotos(picked.files);
  if ($('settings-dialog').open) $('settings-dialog').close();
  if (!entries.length) {
    showNotice(`No Lytro photos found in ${picked.name}.`);
    startNoticeTimer();
    return;
  }
  await libReady;
  const albumName = picked.name.replace(/\.lytrolibrary$/i, '');
  const album = lib.albums.find((a) => a.name === albumName) || (await lib.createAlbum(albumName));
  const added = await importPhotos(entries, { album: album.id });
  state.album = album.id;
  showGrid(true);
  const withEdits = entries.filter((e) => e.sidecar).length;
  showNotice(`Added ${added.length} photo${added.length === 1 ? '' : 's'} from ${picked.name} to the album “${album.name}”.`,
    withEdits ? `${withEdits === 1 ? 'One carries' : `${withEdits} carry`} Lytro Desktop edits, applied when ${withEdits === 1 ? 'it is' : 'each is'} first opened.` : '');
  startNoticeTimer();
}

$('import-folder').onclick = importFolder;

$('settings-btn').onclick = async () => {
  await showLibraryLocation();
  $('settings-btn').setAttribute('aria-expanded', 'true');
  $('settings-dialog').showModal();
};
$('settings-dialog').addEventListener('close', () => $('settings-btn').setAttribute('aria-expanded', 'false'));

// The About window shows the top bar's logo.
$('about-title').prepend(document.querySelector('.toolbar h1 .logo').cloneNode(true));

$('about-btn').onclick = () => {
  $('about-version').textContent = VERSION;
  $('about-btn').setAttribute('aria-expanded', 'true');
  $('about-dialog').showModal();
};
$('about-dialog').addEventListener('close', () => $('about-btn').setAttribute('aria-expanded', 'false'));

$('library-choose').onclick = async () => {
  if (!native) return;
  const dir = await native.chooseLibraryDir();
  if (!dir) return;
  closePhoto();
  state.album = null;
  libReady = openLibrary();
  await showLibraryLocation();
};

// ---------------------------------------------------------------- crop, straighten, orientation

// Applied to the finished picture in camera mode (core/geometry.js); the
// settings are kept with the photo's edits. While the crop frame is being
// edited the whole straightened picture is shown with the frame over it.
const srcCanvas = document.createElement('canvas');
const cropState = { editing: false, saved: null, rect: null, drag: null };

function cropValues() {
  return { x: +$('crop-x').value, y: +$('crop-y').value, w: +$('crop-w').value, h: +$('crop-h').value };
}

function setCropValues(c) {
  $('crop-x').value = c.x;
  $('crop-y').value = c.y;
  $('crop-w').value = c.w;
  $('crop-h').value = c.h;
}

// Perspective pivot: moving the viewpoint shifts every depth but one: the
// camera's own focus with the aperture closed, the focus plane otherwise.
// A custom pivot keeps another depth still instead, by shifting the picture
// against the viewpoint (and zooming in a little so no edge shows).
// Positions move by (depth - still depth) x viewpoint offset, in lens
// spacings: one view pixel at 1x resolution.
function pivotFor(u, v, alpha, aperture) {
  if (!$('pivot-on').checked || !state.info || !state.info.hasRaw || state.depthShown) return null;
  const pivot = 1.6 * $('pivot').value / 100;
  const still = aperture > 0 ? alpha : 0;
  const k = +$('detail').value;
  const { width: W, height: H } = state.info;
  const s = (still - pivot) * k;
  return { shift: [(s * u) / W, (s * v) / H], reach: Math.abs(s) * (state.info.radius || 0) };
}

// Zoom that hides the edges for every shift in `pivots`.
function withPivotZoom(pivots) {
  const reach = Math.max(0, ...pivots.map((p) => (p ? p.reach : 0)));
  const zoom = state.info ? 1 + (2 * reach) / Math.min(state.info.width, state.info.height) : 1;
  return pivots.map((p) => (p ? { shift: p.shift, zoom } : null));
}

function currentPivot() {
  if (state.showingFrames && state.framePivots) return state.framePivots[state.drawFrame ?? state.index] || null;
  const p = cameraParams();
  const pivot = withPivotZoom([pivotFor(p.u, p.v, p.alpha, p.aperture)])[0];
  return keyframesOn() ? combineMotion(pivot, liveFraming()) : pivot;
}

function geometrySettings() {
  return {
    ...(state.mode === 'camera' ? currentPivot() : null),
    orientation: +$('orientation').value || 1,
    angle: +$('straighten').value,
    crop: cropState.editing ? FULL_CROP : cropValues(),
  };
}

// Geometry for an image of this size, or null when there is none to apply.
function geometryFor(w, h) {
  if (state.mode !== 'camera') return null;
  const s = geometrySettings();
  return isIdentity(s) ? null : geometry(w, h, s);
}

// Draws `img` through `g` into a 2D context (scaled by `k`).
function drawGeometry(c2d, img, g, k = 1) {
  let src = img;
  if (img instanceof ImageData) {
    if (srcCanvas.width !== img.width || srcCanvas.height !== img.height) {
      srcCanvas.width = img.width;
      srcCanvas.height = img.height;
    }
    srcCanvas.getContext('2d').putImageData(img, 0, 0);
    src = srcCanvas;
  }
  c2d.setTransform(1, 0, 0, 1, 0, 0);
  c2d.fillStyle = '#000';
  c2d.fillRect(0, 0, c2d.canvas.width, c2d.canvas.height);
  const m = g.matrix;
  c2d.setTransform(m[0] * k, m[1] * k, m[2] * k, m[3] * k, m[4] * k, m[5] * k);
  c2d.imageSmoothingEnabled = true;
  c2d.imageSmoothingQuality = 'high';
  c2d.drawImage(src, 0, 0);
  c2d.setTransform(1, 0, 0, 1, 0, 0);
}

// Where an event on the picture falls in the rendered picture, as fractions.
function sourceFraction(event) {
  const rect = canvas.getBoundingClientRect();
  const fx = (event.clientX - rect.left) / rect.width;
  const fy = (event.clientY - rect.top) / rect.height;
  if (!state.geom) return [fx, fy];
  const [x, y] = applyMatrix(state.geom.inverse, fx * canvas.width, fy * canvas.height);
  return [x / state.geom.srcW, y / state.geom.srcH];
}

function geometryChanged() {
  if (state.lastImage) draw(state.lastImage);
  updateSpreadOverlay();
  scheduleSave();
}

// The crop as a pixel aspect ratio (width / height), or 0 for free.
function aspectRatio() {
  const v = $('crop-aspect').value;
  if (v === 'free') return 0;
  const g = state.geom;
  const fw = g ? g.frameWidth : canvas.width;
  const fh = g ? g.frameHeight : canvas.height;
  if (v === 'original') return fw / fh;
  // Portrait frames take the portrait form of the ratio.
  return fh > fw ? 1 / +v : +v;
}

function frameSize() {
  if (state.geom) return [state.geom.frameWidth, state.geom.frameHeight];
  return [canvas.width, canvas.height];
}

function constrainCrop(c) {
  const r = aspectRatio();
  if (!r) return c;
  const [fw, fh] = frameSize();
  return fitAspect(c, r, fw, fh);
}

function turnCrop(c, dir) {
  // A quarter turn of the picture turns its crop with it.
  return dir > 0 ? { x: 1 - c.y - c.h, y: c.x, w: c.h, h: c.w } : { x: c.y, y: 1 - c.x - c.w, w: c.h, h: c.w };
}

function rotatePicture(dir) {
  if (!canRender()) return;
  $('orientation').value = rotateOrientation(+$('orientation').value || 1, dir);
  if (cropState.editing) cropState.rect = turnCrop(cropState.rect, dir);
  else setCropValues(turnCrop(cropValues(), dir));
  geometryChanged();
}

$('rotate-left').onclick = () => rotatePicture(-1);
$('rotate-right').onclick = () => rotatePicture(1);
$('flip-h').onclick = () => {
  if (!canRender()) return;
  $('orientation').value = flipOrientation(+$('orientation').value || 1);
  const flip = (c) => ({ ...c, x: 1 - c.x - c.w });
  if (cropState.editing) cropState.rect = flip(cropState.rect);
  else setCropValues(flip(cropValues()));
  geometryChanged();
};
$('straighten').oninput = () => {
  showSliderValue($('straighten'));
  if (state.lastImage) draw(state.lastImage);
};
$('straighten').onchange = geometryChanged;
// Choosing an aspect ratio opens the crop frame to adjust.
$('crop-aspect').onchange = () => {
  if (!cropState.editing) startCrop();
  if (!cropState.editing) return;
  cropState.rect = constrainCrop(cropState.rect);
  positionCropBox();
};
$('geometry-reset').onclick = () => {
  $('orientation').value = 1;
  $('straighten').value = 0;
  $('crop-aspect').value = 'free';
  showSliderValue($('straighten'));
  setCropValues(FULL_CROP);
  if (cropState.editing) cropState.rect = { ...FULL_CROP };
  geometryChanged();
  if (cropState.editing) positionCropBox();
};

function startCrop() {
  if (!canRender() || state.mode !== 'camera' || cropState.editing) return;
  if (state.playing) setPlaying(false);
  cropState.editing = true;
  cropState.saved = cropValues();
  cropState.rect = cropValues();
  $('crop-btn').setAttribute('aria-pressed', 'true');
  $('crop-btn').textContent = 'Done';
  viewer.classList.add('cropping');
  $('crop-box').hidden = false;
  if (state.lastImage) draw(state.lastImage);
  layoutCanvas();
}

function finishCrop(keep) {
  if (!cropState.editing) return;
  cropState.editing = false;
  if (keep) setCropValues(cropState.rect);
  $('crop-btn').setAttribute('aria-pressed', 'false');
  $('crop-btn').textContent = 'Crop';
  viewer.classList.remove('cropping');
  $('crop-box').hidden = true;
  if (keep) geometryChanged();
  else if (state.lastImage) draw(state.lastImage);
  layoutCanvas();
}

$('crop-btn').onclick = () => (cropState.editing ? finishCrop(true) : startCrop());

// The frame over the picture, in the viewer's coordinates.
function positionCropBox() {
  if (!cropState.editing) return;
  const box = $('crop-box');
  const left = parseFloat(canvas.style.left) || 0;
  const top = parseFloat(canvas.style.top) || 0;
  const w = parseFloat(canvas.style.width) || canvas.width;
  const h = parseFloat(canvas.style.height) || canvas.height;
  const c = cropState.rect;
  box.style.left = `${left + c.x * w}px`;
  box.style.top = `${top + c.y * h}px`;
  box.style.width = `${c.w * w}px`;
  box.style.height = `${c.h * h}px`;
}

const MIN_CROP = 0.05;

$('crop-box').addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  const handle = e.target.dataset.h || 'move';
  const c = cropState.rect;
  if (handle === 'move' && c.w > 0.995 && c.h > 0.995) {
    // Nothing to move yet: draw a crop from here instead.
    const rect = canvas.getBoundingClientRect();
    cropState.drag = {
      handle: 'draw',
      ax: Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)),
      ay: Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)),
    };
  } else {
    cropState.drag = { handle, x: e.clientX, y: e.clientY, start: { ...c } };
  }
  $('crop-box').setPointerCapture(e.pointerId);
});

// Dragging on the picture outside the frame draws a new one.
canvas.addEventListener('pointerdown', (e) => {
  if (!cropState.editing || e.button !== 0) return;
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const ax = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  const ay = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
  cropState.drag = { handle: 'draw', ax, ay, moved: false };
  $('crop-box').setPointerCapture(e.pointerId);
});

function drawCrop(d, e) {
  const rect = canvas.getBoundingClientRect();
  const bx = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  const by = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
  let w = Math.max(MIN_CROP, Math.abs(bx - d.ax));
  let h = Math.max(MIN_CROP, Math.abs(by - d.ay));
  const ratio = aspectRatio();
  if (ratio) {
    // The ratio holds; the longer drag direction leads.
    const [fw, fh] = frameSize();
    const rn = (ratio * fh) / fw;
    if (w / h > rn) h = w / rn;
    else w = h * rn;
    const maxW = bx >= d.ax ? 1 - d.ax : d.ax;
    const maxH = by >= d.ay ? 1 - d.ay : d.ay;
    const k = Math.min(1, maxW / w, maxH / h);
    w *= k;
    h *= k;
  }
  const x = bx >= d.ax ? d.ax : d.ax - w;
  const y = by >= d.ay ? d.ay : d.ay - h;
  cropState.rect = { x: Math.max(0, x), y: Math.max(0, y), w: Math.min(w, 1), h: Math.min(h, 1) };
}

$('crop-box').addEventListener('pointermove', (e) => {
  const d = cropState.drag;
  if (!d) return;
  if (d.handle === 'draw') {
    d.moved = true;
    drawCrop(d, e);
    positionCropBox();
    return;
  }
  const w = parseFloat(canvas.style.width) || canvas.width;
  const h = parseFloat(canvas.style.height) || canvas.height;
  const dx = (e.clientX - d.x) / w;
  const dy = (e.clientY - d.y) / h;
  const s = d.start;
  let { x, y } = s;
  let r = s.x + s.w;
  let b = s.y + s.h;
  if (d.handle === 'move') {
    x = Math.min(1 - s.w, Math.max(0, s.x + dx));
    y = Math.min(1 - s.h, Math.max(0, s.y + dy));
    cropState.rect = { x, y, w: s.w, h: s.h };
  } else {
    if (d.handle.includes('w')) x = Math.min(r - MIN_CROP, Math.max(0, s.x + dx));
    if (d.handle.includes('e')) r = Math.max(x + MIN_CROP, Math.min(1, r + dx));
    if (d.handle.includes('n')) y = Math.min(b - MIN_CROP, Math.max(0, s.y + dy));
    if (d.handle.includes('s')) b = Math.max(y + MIN_CROP, Math.min(1, b + dy));
    let c = { x, y, w: r - x, h: b - y };
    const ratio = aspectRatio();
    if (ratio) {
      // Keep the ratio: the dragged side leads, the edge opposite the
      // handle stays where it is.
      const [fw, fh] = frameSize();
      const rn = (ratio * fh) / fw;
      const sideOnly = d.handle.length === 1;
      if (sideOnly && (d.handle === 'n' || d.handle === 's')) {
        const nw = Math.min(1, c.h * rn);
        const cx = s.x + s.w / 2;
        c = { ...c, w: nw, x: Math.min(1 - nw, Math.max(0, cx - nw / 2)) };
      } else {
        let nh = c.w / rn;
        let nw = c.w;
        const maxH = d.handle.includes('n') ? b : 1 - y;
        if (nh > maxH) {
          nh = maxH;
          nw = nh * rn;
        }
        const nx = d.handle.includes('w') ? r - nw : x;
        if (sideOnly) {
          const cy = s.y + s.h / 2;
          const ny = Math.min(1 - nh, Math.max(0, cy - nh / 2));
          c = { x: nx, y: ny, w: nw, h: nh };
        } else {
          c = { x: nx, y: d.handle.includes('n') ? b - nh : y, w: nw, h: nh };
        }
      }
    }
    cropState.rect = c;
  }
  positionCropBox();
});

for (const type of ['pointerup', 'pointercancel']) {
  $('crop-box').addEventListener(type, () => {
    cropState.drag = null;
  });
}

document.addEventListener('keydown', (e) => {
  if (!cropState.editing || e.target.matches('input, select, textarea')) return;
  if (e.key === 'Enter') {
    e.preventDefault();
    finishCrop(true);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    finishCrop(false);
  }
}, true);

// ---------------------------------------------------------------- color matrix

// Camera: the matrix in the photo's metadata; None: camera RGB as is;
// Custom: editable, starting from the camera's.
function showColorMatrix() {
  $('ccm-grid').hidden = $('ccm-mode').value !== 'custom';
}

$('ccm-mode').onchange = () => {
  if ($('ccm-mode').value === 'custom') {
    const cam = state.info && state.info.cam && state.info.cam.ccm;
    const m = cam || [1, 0, 0, 0, 1, 0, 0, 0, 1];
    m.forEach((v, i) => { $(`ccm-${i}`).value = +v.toFixed(3); });
  }
  showColorMatrix();
  applySettings();
};
for (let i = 0; i < 9; i++) $(`ccm-${i}`).addEventListener('input', () => applySettingsSoon());

// ---------------------------------------------------------------- local adjustments

// Masks (core/local.js) kept as JSON in a hidden field, so they are saved
// with the photo's edits like every other control. The editor shows the
// selected mask.
const MASK_NAMES = { radial: 'Radial', linear: 'Gradient', depth: 'Depth' };
const SHAPE_SLIDERS = {
  radial: { x: ['mr-x', 100], y: ['mr-y', 100], w: ['mr-w', 100], h: ['mr-h', 100], feather: ['mr-feather', 100] },
  linear: { x: ['ml-x', 100], y: ['ml-y', 100], angle: ['ml-angle', 1], width: ['ml-width', 100] },
  depth: { near: ['md-near', 100], far: ['md-far', 100], feather: ['md-feather', 100] },
};
const FX_SLIDERS = { exposure: 'mx-exposure', contrast: 'mx-contrast', saturation: 'mx-saturation', temperature: 'mx-temperature', tint: 'mx-tint' };
let maskSel = -1;

function getMasks() {
  return parseMasks($('local-masks').value);
}

function setMasks(masks, { final = true } = {}) {
  $('local-masks').value = JSON.stringify(masks);
  applySettingsSoon();
  if (final) scheduleSave();
}

function maskLabel(m, i) {
  const same = getMasks().slice(0, i + 1).filter((x) => x.kind === m.kind).length;
  return `${MASK_NAMES[m.kind]} ${same}`;
}

const TRASH_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>';

function deleteMask(i) {
  const list = getMasks();
  if (!list[i]) return;
  list.splice(i, 1);
  if (maskSel >= i) maskSel = Math.max(list.length ? 0 : -1, maskSel - 1);
  if (!list.length) $('mask-show').checked = false;
  setMasks(list);
  renderMasks();
}

// Asks before deleting mask i, in a small menu by `anchor`.
function askDeleteMask(i, anchor) {
  const m = getMasks()[i];
  if (!m) return;
  showMenu(anchor, []);
  confirmInMenu(`Delete ${maskLabel(m, i)}? Its effect is removed from the photo.`, 'Delete', () => deleteMask(i));
}

function renderMasks() {
  const masks = getMasks();
  if (maskSel >= masks.length) maskSel = masks.length - 1;
  $('mask-list').replaceChildren(...masks.map((m, i) => {
    const li = document.createElement('li');
    li.className = i === maskSel ? 'current' : '';
    if (!m.on) li.classList.add('off');
    const name = Object.assign(document.createElement('button'), { type: 'button', className: 'mask-name', textContent: maskLabel(m, i) });
    name.onclick = () => {
      maskSel = i;
      renderMasks();
      applySettingsSoon();
    };
    const del = Object.assign(document.createElement('button'), { type: 'button', className: 'icon-only mask-del', title: 'Delete mask' });
    del.innerHTML = TRASH_ICON;
    del.setAttribute('aria-label', `Delete ${maskLabel(m, i)}`);
    del.onclick = (e) => {
      e.stopPropagation();
      askDeleteMask(i, del);
    };
    li.append(name, del);
    return li;
  }));
  // Masks belong to a photo: none can be added until one is open.
  for (const kind of Object.keys(MASK_NAMES)) $(`mask-add-${kind}`).disabled = masks.length >= MAX_MASKS || !canRender();
  $('mask-filter').disabled = masks.length >= MAX_MASKS || !canRender();
  const m = masks[maskSel];
  $('mask-editor').hidden = !m;
  if (!m) {
    $('mask-show').checked = false;
    return;
  }
  for (const kind of Object.keys(SHAPE_SLIDERS)) $(`mask-shape-${kind}`).hidden = kind !== m.kind;
  for (const [key, [id, k]] of Object.entries(SHAPE_SLIDERS[m.kind])) $(id).value = Math.round(m[key] * k);
  for (const [key, id] of Object.entries(FX_SLIDERS)) $(id).value = Math.round(m.fx[key] * 100);
  $('mask-on').checked = m.on;
  $('mask-invert').checked = m.invert;
  for (const input of document.querySelectorAll('.local-panel input[type=range]')) showSliderValue(input);
}

// Editor controls -> the selected mask.
function maskFromEditor(final) {
  const masks = getMasks();
  const m = masks[maskSel];
  if (!m) return;
  for (const [key, [id, k]] of Object.entries(SHAPE_SLIDERS[m.kind])) m[key] = +$(id).value / k;
  for (const [key, id] of Object.entries(FX_SLIDERS)) m.fx[key] = +$(id).value / 100;
  m.on = $('mask-on').checked;
  m.invert = $('mask-invert').checked;
  setMasks(masks, { final });
  if (final) renderMasks();
}

for (const kind of Object.keys(MASK_NAMES)) {
  $(`mask-add-${kind}`).onclick = () => {
    const masks = getMasks();
    if (masks.length >= MAX_MASKS || !canRender()) return;
    masks.push(defaultMask(kind));
    maskSel = masks.length - 1;
    $('mask-show').checked = true;
    setMasks(masks);
    renderMasks();
  };
}

for (const input of document.querySelectorAll('.local-panel input[type=range]')) {
  input.addEventListener('input', () => {
    showSliderValue(input);
    maskFromEditor(false);
  });
  input.addEventListener('change', () => maskFromEditor(true));
  input.addEventListener('dblclick', () => {
    input.value = input.dataset.default;
    showSliderValue(input);
    maskFromEditor(true);
  });
}
for (const id of ['mask-on', 'mask-invert']) $(id).addEventListener('change', () => maskFromEditor(true));
$('mask-show').addEventListener('change', () => applySettingsSoon());
$('mask-delete').onclick = () => askDeleteMask(maskSel, $('mask-delete'));

renderMasks();

function localSettings() {
  return { masks: $('local-masks').value, show: $('mask-show').checked ? maskSel : -1 };
}

// ---------------------------------------------------------------- keyframes

// Keyframed animation (core/keyframes.js): a track per property on the
// timeline under the picture. Each track's diamonds are its keyframes: drag
// to move, click to select (and show), Delete to remove; the selected one
// sets the curve to the next. Framing (zoom and pan) is applied when the
// picture is drawn, like the pivot.
const TRACK_NAMES = { aperture: 'Aperture', depth: 'Depth of field', focus: 'Focus', view: 'Viewpoint', zoom: 'Zoom', pan: 'Pan' };
let anim = emptyAnimation();
let keySel = null; // { k, t }

function keyframesOn() {
  return $('anim-on').checked && $('anim').value === 'keyframes';
}

// Earlier versions kept a plain list of keyframes, evenly spaced.
function loadAnimation() {
  let raw = null;
  try {
    raw = JSON.parse($('anim-keys').value || 'null');
  } catch {
    raw = null;
  }
  if (Array.isArray(raw) && raw.length) {
    anim = emptyAnimation();
    raw.forEach((k, i) => {
      const t = i * 2;
      setKey(anim, 'aperture', t, F_STOPS[k.fstop] ?? 2);
      setKey(anim, 'focus', t, k.focus || 0);
      setKey(anim, 'view', t, [k.u || 0, k.v || 0]);
      setKey(anim, 'zoom', t, k.zoom || 1);
      setKey(anim, 'pan', t, [k.panX || 0, k.panY || 0]);
    });
    anim.length = Math.max(1, (raw.length - 1) * 2);
  } else {
    anim = parseAnimation($('anim-keys').value);
  }
  keySel = null;
  showAnimationLength();
  renderTimeline();
}

function saveAnimation() {
  $('anim-keys').value = JSON.stringify(anim);
  scheduleSave();
  invalidateAnimation();
  if (state.showingFrames) {
    backToCamera();
    renderCamera();
  }
  renderTimeline();
}

// Zoom (1..3) and pan (-1..1 each way) -> a picture shift and zoom.
function framing(zoom, panX, panY) {
  const room = (1 - 1 / zoom) / 2;
  return { shift: [-panX * room, -panY * room], zoom };
}

function liveFraming() {
  return framing(+$('frame-zoom').value / 100, +$('frame-pan-x').value / 100, +$('frame-pan-y').value / 100);
}

// Pivot and framing together.
function combineMotion(a, b) {
  if (!a) return b;
  if (!b) return a;
  return { shift: [a.shift[0] + b.shift[0], a.shift[1] + b.shift[1]], zoom: a.zoom * b.zoom };
}

function currentValue(k) {
  switch (k) {
    case 'aperture': return F_STOPS[+$('fstop').value] ?? 2;
    case 'depth': return +$('dof-depth').value;
    case 'focus': return +$('focus').value;
    case 'view': return [state.camera.u, state.camera.v];
    case 'zoom': return +$('frame-zoom').value / 100;
    default: return [+$('frame-pan-x').value / 100, +$('frame-pan-y').value / 100];
  }
}

// Shows a keyframe's value in the controls (and the picture).
function showValue(k, v) {
  if (k === 'aperture') {
    let best = 0;
    F_STOPS.forEach((n, i) => { if (Math.abs(Math.log(n / v)) < Math.abs(Math.log(F_STOPS[best] / v))) best = i; });
    $('fstop').value = best;
    showFNumber();
  } else if (k === 'depth') {
    $('dof-depth').value = Math.round(v);
    showSliderValue($('dof-depth'));
  } else if (k === 'focus') {
    $('focus').value = v;
  } else if (k === 'view') {
    state.camera = { u: v[0], v: v[1] };
  } else if (k === 'zoom') {
    $('frame-zoom').value = Math.round(v * 100);
    showSliderValue($('frame-zoom'));
  } else {
    $('frame-pan-x').value = Math.round(v[0] * 100);
    $('frame-pan-y').value = Math.round(v[1] * 100);
    showSliderValue($('frame-pan-x'));
    showSliderValue($('frame-pan-y'));
  }
  if (state.showingFrames) backToCamera();
  cameraChanged({ final: true });
}

function playheadTime() {
  if (state.showingFrames && state.frames.length) return (state.drawFrame ?? state.index) / KEY_FPS;
  return Math.min(anim.length, state.keyTime || 0);
}

function selectedKey() {
  if (!keySel) return null;
  return anim.tracks[keySel.k].find((key) => Math.abs(key.t - keySel.t) < 1e-6) || null;
}

const fmtTime = (t) => `${t.toFixed(2)} s`;

// Moves the playhead without redrawing the timeline (while playing).
function updatePlayhead() {
  if ($('timeline').hidden) return;
  const head = playheadTime();
  for (const el of $('tl-grid').querySelectorAll('.tl-playhead')) el.style.left = `${(100 * head) / anim.length}%`;
  $('tl-time').textContent = `${fmtTime(head)} / ${fmtTime(anim.length)}`;
}

function renderTimeline() {
  const on = keyframesOn() && state.mode === 'camera';
  if ($('timeline').hidden === on) {
    $('timeline').hidden = !on;
    // The picture gets less (or more) room.
    layoutCanvas();
  }
  if (!on) return;
  const grid = $('tl-grid');
  const len = anim.length;
  const pos = (t) => `${(100 * t) / len}%`;
  const head = playheadTime();
  const rows = [];
  // Ruler: a tick each second (or each 5 s for long animations).
  const step = len > 20 ? 5 : 1;
  const ruler = Object.assign(document.createElement('div'), { className: 'tl-ruler' });
  for (let t = 0; t <= len + 1e-6; t += step) {
    ruler.append(Object.assign(document.createElement('span'), { className: 'tl-tick', textContent: `${t}s`, style: `left:${pos(t)}` }));
  }
  ruler.append(Object.assign(document.createElement('span'), { className: 'tl-playhead', style: `left:${pos(head)}` }));
  ruler.onpointerdown = (e) => seekTimeline(e, ruler);
  rows.push(Object.assign(document.createElement('div'), { className: 'tl-label' }), ruler);
  for (const k of TRACKS) {
    const label = Object.assign(document.createElement('div'), { className: 'tl-label' });
    const add = Object.assign(document.createElement('button'), { type: 'button', textContent: '◆', title: `Keyframe ${TRACK_NAMES[k].toLowerCase()} at the playhead` });
    add.setAttribute('aria-label', `Add a ${TRACK_NAMES[k].toLowerCase()} keyframe`);
    add.onclick = () => {
      const t = Math.round(playheadTime() * KEY_FPS) / KEY_FPS;
      setKey(anim, k, t, currentValue(k));
      keySel = { k, t };
      saveAnimation();
    };
    label.append(add, document.createTextNode(TRACK_NAMES[k]));
    const track = Object.assign(document.createElement('div'), { className: 'tl-track' });
    track.onpointerdown = (e) => {
      if (e.target === track) seekTimeline(e, track);
    };
    for (const key of anim.tracks[k]) {
      const d = Object.assign(document.createElement('span'), { className: 'tl-key', style: `left:${pos(key.t)}` });
      if (keySel && keySel.k === k && Math.abs(keySel.t - key.t) < 1e-6) d.classList.add('selected');
      if (key.ease.type === 'hold') d.classList.add('hold');
      d.title = `${TRACK_NAMES[k]} at ${fmtTime(key.t)}`;
      d.onpointerdown = (e) => dragKey(e, k, key, track);
      track.append(d);
    }
    track.append(Object.assign(document.createElement('span'), { className: 'tl-playhead', style: `left:${pos(head)}` }));
    rows.push(label, track);
  }
  grid.replaceChildren(...rows);
  const sel = selectedKey();
  $('tl-delete').disabled = !sel;
  $('tl-ease').disabled = !sel;
  if (sel) $('tl-ease').value = sel.ease.type;
  $('tl-curve').hidden = !(sel && sel.ease.type === 'custom');
  if (sel && sel.ease.type === 'custom') drawCurve();
  $('tl-time').textContent = `${fmtTime(head)} / ${fmtTime(len)}`;
}

function timeAt(e, el) {
  const r = el.getBoundingClientRect();
  const t = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * anim.length;
  return Math.round(t * KEY_FPS) / KEY_FPS;
}

// Click on the ruler or a track: move the playhead there.
function seekTimeline(e, el) {
  const t = timeAt(e, el);
  state.keyTime = t;
  if (state.frames.length) {
    const i = Math.min(state.frames.length - 1, Math.round(t * KEY_FPS));
    if (state.playing) setPlaying(false);
    state.showingFrames = true;
    state.index = i;
    showFrame(i);
  }
  renderTimeline();
}

// Drag a keyframe along its track; a click without moving selects it and
// shows its value.
function dragKey(e, k, key, track) {
  e.preventDefault();
  e.stopPropagation();
  const startX = e.clientX;
  let moved = false;
  keySel = { k, t: key.t };
  const move = (ev) => {
    if (!moved && Math.abs(ev.clientX - startX) < 3) return;
    moved = true;
    const t = timeAt(ev, track);
    if (anim.tracks[k].some((other) => other !== key && Math.abs(other.t - t) < 0.5 / KEY_FPS)) return;
    key.t = t;
    keySel = { k, t };
    anim.tracks[k].sort((a, b) => a.t - b.t);
    renderTimeline();
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    if (moved) {
      saveAnimation();
    } else {
      state.keyTime = key.t;
      showValue(k, key.v);
      renderTimeline();
    }
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  renderTimeline();
}

function deleteSelectedKey() {
  const sel = selectedKey();
  if (!sel) return;
  anim.tracks[keySel.k] = anim.tracks[keySel.k].filter((key) => key !== sel);
  keySel = null;
  saveAnimation();
}

$('tl-delete').onclick = deleteSelectedKey;
$('tl-key-all').onclick = () => {
  const t = Math.round(playheadTime() * KEY_FPS) / KEY_FPS;
  for (const k of TRACKS) setKey(anim, k, t, currentValue(k));
  saveAnimation();
};
$('tl-ease').onchange = () => {
  const sel = selectedKey();
  if (!sel) return;
  const type = $('tl-ease').value;
  // A custom curve starts from the one chosen before.
  if (type === 'custom' && sel.ease.type !== 'custom' && PRESETS[sel.ease.type]) sel.ease.bezier = [...PRESETS[sel.ease.type]];
  sel.ease.type = type;
  saveAnimation();
};
document.addEventListener('keydown', (e) => {
  if (!keySel || $('timeline').hidden || e.target.matches('input, select, textarea')) return;
  if (e.key === 'Delete' || e.key === 'Backspace') {
    e.preventDefault();
    deleteSelectedKey();
  }
});

// The custom curve: from (0, 0) to (1, 1), two handles to drag.
const curvePad = 14;
function curveGeom() {
  const c = $('tl-curve-canvas');
  const dpr = window.devicePixelRatio || 1;
  const size = c.clientWidth || 150;
  if (c.width !== size * dpr) {
    c.width = size * dpr;
    c.height = size * dpr;
  }
  // y from -0.5 to 1.5, so curves can overshoot.
  const s = size - 2 * curvePad;
  return { c, dpr, size, X: (x) => curvePad + x * s, Y: (y) => curvePad + (1.5 - y) / 2 * s, s };
}

function drawCurve() {
  const sel = selectedKey();
  if (!sel) return;
  const { c, dpr, size, X, Y } = curveGeom();
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, size, size);
  g.fillStyle = '#0f1114';
  g.fillRect(X(0), Y(1.5), X(1) - X(0), Y(-0.5) - Y(1.5));
  g.strokeStyle = '#2a2e35';
  g.strokeRect(X(0), Y(1), X(1) - X(0), Y(0) - Y(1));
  const [x1, y1, x2, y2] = sel.ease.bezier;
  const f = cubicBezier(x1, y1, x2, y2);
  g.strokeStyle = '#e6e6e6';
  g.lineWidth = 1.6;
  g.beginPath();
  for (let i = 0; i <= 60; i++) {
    const x = i / 60;
    if (i) g.lineTo(X(x), Y(f(x)));
    else g.moveTo(X(x), Y(f(x)));
  }
  g.stroke();
  g.lineWidth = 1;
  g.strokeStyle = '#888';
  for (const [ax, ay, hx, hy] of [[0, 0, x1, y1], [1, 1, x2, y2]]) {
    g.beginPath();
    g.moveTo(X(ax), Y(ay));
    g.lineTo(X(hx), Y(hy));
    g.stroke();
    g.beginPath();
    g.arc(X(hx), Y(hy), 5, 0, 2 * Math.PI);
    g.fillStyle = '#e5534b';
    g.fill();
  }
}

$('tl-curve-canvas').addEventListener('pointerdown', (e) => {
  const sel = selectedKey();
  if (!sel) return;
  const { c, X, Y, s } = curveGeom();
  const r = c.getBoundingClientRect();
  const px = e.clientX - r.left;
  const py = e.clientY - r.top;
  const b = sel.ease.bezier;
  const d1 = Math.hypot(px - X(b[0]), py - Y(b[1]));
  const d2 = Math.hypot(px - X(b[2]), py - Y(b[3]));
  const h = d1 <= d2 ? 0 : 2;
  c.setPointerCapture(e.pointerId);
  const move = (ev) => {
    const x = Math.min(1, Math.max(0, (ev.clientX - r.left - curvePad) / s));
    const y = Math.min(1.5, Math.max(-0.5, 1.5 - ((ev.clientY - r.top - curvePad) / s) * 2));
    b[h] = x;
    b[h + 1] = y;
    drawCurve();
  };
  const up = () => {
    c.removeEventListener('pointermove', move);
    c.removeEventListener('pointerup', up);
    saveAnimation();
  };
  c.addEventListener('pointermove', move);
  c.addEventListener('pointerup', up);
  move(e);
});

// Length, beside the play bar: of the keyframed animation, or of the
// viewpoint path (its number of frames).
function showAnimationLength() {
  const kind = $('anim').value;
  $('anim-length-row').hidden = kind === 'focus';
  $('anim-length').value = kind === 'keyframes' ? anim.length : +(+$('frames').value / KEY_FPS).toFixed(2);
}

$('anim-length').onchange = () => {
  const len = Math.min(120, Math.max(0.5, +$('anim-length').value || 4));
  if ($('anim').value === 'keyframes') {
    anim.length = len;
    saveAnimation();
  } else {
    $('frames').value = Math.max(2, Math.round(len * KEY_FPS));
    scheduleSave();
    animationSettingsChanged();
  }
  showAnimationLength();
};

for (const id of ['frame-zoom', 'frame-pan-x', 'frame-pan-y']) {
  $(id).oninput = () => {
    showSliderValue($(id));
    if (state.lastImage) draw(state.lastImage);
  };
  $(id).onchange = () => scheduleSave();
}

// Values of every track at every frame: camera settings for the worker and
// framing for drawing.
function keyframeFrames() {
  if (!hasKeys(anim)) return null;
  const live = { aperture: F_STOPS[+$('fstop').value] ?? 2, depth: +$('dof-depth').value, focus: +$('focus').value };
  const path = [];
  const frames = [];
  for (const v of sample(anim)) {
    const lens = apertureFor(v.aperture ?? live.aperture);
    const depth = v.depth ?? live.depth;
    const view = v.view ?? [state.camera.u, state.camera.v];
    path.push({ u: view[0], v: view[1], alpha: v.focus ?? live.focus, aperture: lens.aperture, dof: lens.dof * 4 ** (-depth / 50) });
    const z = v.zoom ?? +$('frame-zoom').value / 100;
    const pan = v.pan ?? [+$('frame-pan-x').value / 100, +$('frame-pan-y').value / 100];
    frames.push(framing(z, pan[0], pan[1]));
  }
  return { path, framing: frames };
}

// ---------------------------------------------------------------- 3D

// A stereo pair from two viewpoints across the lens aperture: anaglyph
// (red / cyan glasses), side by side (parallel viewing) or cross-eyed.
// Crop, rotation and the pivot apply to both eyes alike.
async function saveStereo() {
  if (!canRender() || !state.info.hasRaw) return;
  $('stereo-btn').disabled = true;
  try {
    const p = cameraParams();
    const b = (state.info.radius || 4.5) * (+$('stereo-baseline').value / 100);
    const eyes = [p.u - b, p.u + b];
    const shots = [];
    for (const u of eyes) {
      showProgress('Rendering 3D', shots.length / 2);
      const msg = await engine.request('view', { ...p, u }, { onProgress: () => {} });
      shots.push(toImageData(msg));
    }
    const pivots = withPivotZoom(eyes.map((u) => pivotFor(u, p.v, p.alpha, p.aperture)));
    const base = { orientation: +$('orientation').value || 1, angle: +$('straighten').value, crop: cropValues() };
    const views = shots.map((img, i) => {
      const g = geometry(img.width, img.height, { ...base, ...(pivots[i] || {}) });
      const c = Object.assign(document.createElement('canvas'), { width: g.width, height: g.height });
      drawGeometry(c.getContext('2d'), img, g);
      return c;
    });
    const [L, R] = views;
    const mode = $('stereo-mode').value;
    let out;
    if (mode === 'anaglyph') {
      // Red from the left eye, green and blue from the right.
      out = Object.assign(document.createElement('canvas'), { width: L.width, height: L.height });
      const o = out.getContext('2d');
      const l = L.getContext('2d').getImageData(0, 0, L.width, L.height);
      const r = R.getContext('2d').getImageData(0, 0, R.width, R.height);
      for (let i = 0; i < l.data.length; i += 4) {
        r.data[i] = 0.299 * l.data[i] + 0.587 * l.data[i + 1] + 0.114 * l.data[i + 2];
      }
      o.putImageData(r, 0, 0);
    } else {
      const [first, second] = mode === 'cross' ? [R, L] : [L, R];
      out = Object.assign(document.createElement('canvas'), { width: L.width * 2, height: L.height });
      const o = out.getContext('2d');
      o.drawImage(first, 0, 0);
      o.drawImage(second, L.width, 0);
    }
    out.toBlob((blob) => download(blob, `${baseName()}-3d-${mode}.png`), 'image/png');
  } catch (err) {
    showError(err);
  } finally {
    hideProgress();
    $('stereo-btn').disabled = !canRender();
    refresh();
  }
}
$('stereo-btn').onclick = saveStereo;
$('stereo-baseline').oninput = () => showSliderValue($('stereo-baseline'));

// ---------------------------------------------------------------- living filters

// Looks built from masks around the current focus; once added they are
// ordinary masks to adjust.
function livingFilter(name) {
  const f = +$('focus').value;
  const fx = (o) => ({ exposure: 0, contrast: 0, saturation: 0, temperature: 0, tint: 0, ...o });
  const depth = (near, far, feather, invert, effect) => ({ ...defaultMask('depth'), near, far, feather, invert, fx: fx(effect) });
  switch (name) {
    case 'pop': // in focus keeps its color, the rest goes gray
      return [depth(f - 0.25, f + 0.25, 0.2, true, { saturation: -1 })];
    case 'spotlight': // darker away from the focus point
      return [{ ...defaultMask('radial'), x: state.focusPoint.x, y: state.focusPoint.y, w: 0.35, h: 0.35, feather: 0.7, invert: true, fx: fx({ exposure: -1.2 }) }];
    case 'haze': // farther away is paler and softer, like air
      return [depth(f + 0.2, 1.8, 0.6, false, { exposure: 0.35, contrast: -0.5, saturation: -0.45, temperature: -0.15 })];
    case 'dreamy': // what is not in focus glows a little
      return [depth(f - 0.2, f + 0.2, 0.25, true, { exposure: 0.4, contrast: -0.4, saturation: -0.2, temperature: 0.15 })];
    default:
      return [];
  }
}

$('mask-filter').onchange = () => {
  const added = livingFilter($('mask-filter').value);
  $('mask-filter').value = '';
  if (!added.length || !canRender()) return;
  const masks = getMasks();
  const room = MAX_MASKS - masks.length;
  if (room < added.length) {
    showNotice(`Up to ${MAX_MASKS} masks: delete one to add this filter.`);
    startNoticeTimer();
    return;
  }
  masks.push(...added);
  maskSel = masks.length - 1;
  setMasks(masks);
  renderMasks();
};

// ---------------------------------------------------------------- number fields

// Number fields get plain up/down arrows in place of the browser's spinner
// (which draws a box behind them).
const CHEVRON = (d) => `<svg viewBox="0 0 10 6" width="10" height="6" aria-hidden="true"><path d="${d}" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
function addSteppers(input) {
  const wrap = Object.assign(document.createElement('span'), { className: 'num' });
  input.replaceWith(wrap);
  const arrows = Object.assign(document.createElement('span'), { className: 'num-arrows' });
  for (const [dir, d, label] of [[1, 'M1 5l4-4 4 4', 'Increase'], [-1, 'M1 1l4 4 4-4', 'Decrease']]) {
    const b = Object.assign(document.createElement('button'), { type: 'button', tabIndex: -1, innerHTML: CHEVRON(d) });
    b.setAttribute('aria-label', label);
    b.onclick = () => {
      if (input.disabled) return;
      if (dir > 0) input.stepUp();
      else input.stepDown();
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    };
    arrows.append(b);
  }
  wrap.append(input, arrows);
}
for (const input of document.querySelectorAll('input[type=number]')) addSteppers(input);

// ---------------------------------------------------------------- tone curve

const CURVE_REGIONS = ['shadows', 'darks', 'lights', 'highlights'];
function curveRegions() {
  return CURVE_REGIONS.map((k) => $(`curve-${k}`).value / 100);
}

const curve = curveEditor($('curve-canvas'), {
  getPoints: () => parsePoints($('curve-points').value),
  getRegions: curveRegions,
  setPoints: (pts, final) => {
    $('curve-points').value = formatPoints(pts);
    applySettingsSoon();
    if (final) scheduleSave();
  },
});
for (const k of CURVE_REGIONS) $(`curve-${k}`).addEventListener('input', () => curve.draw());
$('curve-reset').onclick = () => {
  $('curve-points').value = '0,0;1,1';
  for (const k of CURVE_REGIONS) {
    $(`curve-${k}`).value = 0;
    showSliderValue($(`curve-${k}`));
  }
  curve.draw();
  applySettingsSoon();
  scheduleSave();
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
    const g = geometryFor(frames[0].width, frames[0].height);
    const w = g ? g.width : frames[0].width;
    const h = g ? g.height : frames[0].height;
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
      if (g) drawGeometry(cctx, frames[order[i]], g, up);
      else cctx.drawImage(frames[order[i]], 0, 0, c.width, c.height);
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
    onImport: async (picked) => {
      const added = await importPhotos(groupPhotos(picked.map((f) => ({ path: f.path, file: f.file }))));
      if (added.length) openItem(added[0]);
    },
  });
}

// Desktop app: cameras are detected over USB; photos are copied into the
// import folder, then opened from there.
async function importFromConnectedCamera() {
  const cameras = await native.listCameras();
  const select = $('camera-select');
  $('camera-dest').hidden = false;
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
        // A camera drive is read directly; a camera reached over adb is
        // copied to the library's staging folder first.
        let entries;
        if (cam.kind === 'drive') {
          entries = picked.map((f) => ({ path: `${f.folder}/${f.name}`, file: new NativeFile({ path: f.id, name: f.name, size: f.size }) }));
        } else {
          const stop = native.onImportProgress((p) => showProgress(`Copying ${p.file} from the camera (${Math.min(p.index + 1, p.count)} of ${p.count})`, p.total ? p.bytes / p.total : 0));
          try {
            const files = await native.importFromCamera(cam.id, picked.map((f) => f.id));
            entries = files.map((f) => ({ path: f.name, file: new NativeFile(f) }));
          } catch (err) {
            showError(err);
            return;
          } finally {
            stop();
            hideProgress();
          }
        }
        const added = await importPhotos(groupPhotos(entries));
        if (cam.kind !== 'drive') lib.store.remove('.incoming').catch(() => {});
        if (added.length) openItem(added[0]);
      },
    });
  };
  select.onchange = show;
  show();
}

function importFromCamera() {
  return native ? importFromConnectedCamera() : importFromCameraFolder();
}

$('camera-select-all').onclick = () => {
  const boxes = [...$('camera-grid').querySelectorAll('input')];
  const all = boxes.every((b) => b.checked);
  boxes.forEach((b) => { b.checked = !all; });
};

// ---------------------------------------------------------------- wiring

// Picked or dropped files are added to the library; Lytro Desktop edits
// picked with a photo go with it (scan.js).
async function openPicked(files) {
  const entries = groupPhotos(files.filter((f) => isLightFieldName(f.name)).map((f) => ({ path: f.name, file: f })));
  const added = await importPhotos(entries);
  if (added.length) openItem(added[0]);
}

$('open-btn').onclick = async () => openPicked(await openFiles());
$('camera-btn').onclick = importFromCamera;
$('sample-btn').onclick = () => {
  state.current = null;
  state.wantThumb = false;
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
  $('anim-keyframes').hidden = $('anim').value !== 'keyframes';
  showAnimationLength();
  renderTimeline();
  if (state.lastImage) draw(state.lastImage);
  invalidateAnimation();
  if (state.showingFrames) {
    backToCamera();
    renderCamera();
  }
}
for (const id of ['anim', 'path', 'amount', 'frames', 'near', 'far', 'steps']) $(id).onchange = animationSettingsChanged;

// Animation > Enabled: playing, scrubbing and video export.
function showAnimationEnabled() {
  const on = $('anim-on').checked;
  $('anim-controls').disabled = !on;
  const camera = state.mode === 'camera';
  for (const id of ['play-btn', 'webm-btn', 'scrub']) $(id).disabled = !state.info || !camera || !on;
}
$('anim-on').onchange = () => {
  if (!$('anim-on').checked) {
    setPlaying(false);
    if (state.showingFrames) {
      backToCamera();
      renderCamera();
    }
  }
  showAnimationEnabled();
  renderTimeline();
  if (state.lastImage) draw(state.lastImage);
};

async function applySettings() {
  const settings = {
    ev: +$('ev').value,
    saturation: 1 + $('saturation').value / 100,
    autoWb: $('awb').checked,
    wb: { kelvin: +$('wb-temperature').value, tint: +$('wb-tint').value },
    tone: Object.fromEntries(TONES.map((k) => [k, $(`tone-${k}`).value / 100])),
    curve: { points: parsePoints($('curve-points').value), regions: curveRegions() },
    useCcm: $('ccm-mode').value !== 'none',
    ccm: $('ccm-mode').value === 'custom' ? Array.from({ length: 9 }, (_, i) => +$(`ccm-${i}`).value || 0) : null,
    mvDenoise: { on: $('mv-on').checked, blend: $('mv-blend').value / 100 },
    depthSmoothing: $('depth-smooth').value / 100,
    details: {
      amount: +$('sharp-amount').value,
      radius: +$('sharp-radius').value,
      detail: +$('sharp-detail').value,
      masking: +$('sharp-masking').value,
      luminance: +$('nr-luminance').value,
      color: +$('nr-color').value,
    },
    color: { vibrance: $('vibrance').value / 100, ...Object.fromEntries(HUE_SLIDERS.map((k) => [k, $(`hue-${k}`).value / 100])) },
    detail: +$('detail').value,
    flare: { on: $('flare-on').checked, amount: $('flare-amount').value / 100 },
    local: localSettings(),
    lens: { distortion: +$('lens-distortion').value, vignetting: +$('lens-vignetting').value, midpoint: +$('lens-midpoint').value },
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
  // Progress shows when a setting needs work first (a depth mask measures depth).
  const info = await engine.request('settings', { settings }, { onProgress: showProgress });
  hideProgress();
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
  const photo = state.current && state.current.photo;
  // Library photos keep their edits in their folder; earlier versions kept
  // them in the app's storage, which is still read for those photos.
  let saved = photo ? await lib.loadEdits(photo) : null;
  if (!saved && state.editsKey) saved = await editsStore.load(state.editsKey);
  if (!saved) saved = await lytroEdits(info, state.current);
  state.restoring = true;
  try {
    const { view, focusPoint } = writeEdits(document, saved, DEFAULT_EDITS);
    $('pivot').disabled = !$('pivot-on').checked;
    curve.draw();
    showColorMatrix();
    $('flare-amount').disabled = !$('flare-on').checked;
    showAnimationEnabled();
    maskSel = getMasks().length ? 0 : -1;
    $('mask-show').checked = false;
    renderMasks();
    resetTemperature(info, { keep: !!saved });
    state.camera = { ...view };
    state.focusPoint = { ...focusPoint };
    showFocusPoint();
    for (const input of document.querySelectorAll('aside.controls input[type=range]')) showSliderValue(input);
    showFNumber();
    $('anim-viewpoint').hidden = $('anim').value !== 'viewpoint';
    $('anim-keyframes').hidden = $('anim').value !== 'keyframes';
    loadAnimation();
    $('anim-focus').hidden = $('anim').value !== 'focus';
    await applySettings();
  } finally {
    state.restoring = false;
  }
}

// The edits Lytro Desktop saved for a photo (in its stack.view.lfp, or in
// the file itself), as ILLUMinator edits, or null. Used for photos that have
// no ILLUMinator edits yet; they are saved as ours once changed.
async function lytroEdits(info, item) {
  let recipe = null;
  try {
    const sidecar = item ? item.sidecar || (await findSidecar(item.file)) : null;
    if (sidecar) recipe = findRecipe((await openContainer(blobReader(sidecar))).toc);
  } catch (err) {
    console.warn('Could not read Lytro Desktop edits', err);
  }
  if (!recipe) recipe = info && info.recipe;
  if (!recipe) return null;
  const capture = (info.cam && info.cam.capture) || {};
  const { edits, unsupported } = recipeToEdits(recipe, {
    nativeF: capture.fNumber || 2,
    asShot: capture.cct || 5500,
    radius: info.radius || 4.5,
    viewWidth: info.width || 615,
  });
  // A processed file's pictures already carry Lytro's color and detail
  // edits; only its focus, aperture and viewpoint apply.
  if (!info.hasRaw) {
    delete edits.process;
    delete edits.details;
    delete edits.defringe;
  }
  state.notice = ['Applied this photo\u2019s edits from Lytro Desktop.', unsupported.length ? `Not supported yet: ${unsupported.join(', ')}.` : ''];
  return edits;
}

// A note over the picture; it goes away by itself a while after the picture
// first shows.
let noticeTimer = null;
function showNotice(text, detail = '') {
  hideNotice();
  $('notice-text').textContent = text;
  $('notice-detail').textContent = detail;
  $('notice-detail').hidden = !detail;
  $('notice').hidden = false;
}

function startNoticeTimer() {
  if (noticeTimer || $('notice').hidden) return;
  noticeTimer = setTimeout(hideNotice, $('notice-detail').hidden ? 6000 : 12000);
}

function hideNotice() {
  clearTimeout(noticeTimer);
  noticeTimer = null;
  $('notice').hidden = true;
}

$('notice-close').onclick = hideNotice;

function scheduleSave() {
  if (state.restoring || !state.editsKey || !canRender()) return;
  clearTimeout(saveTimer);
  const key = state.editsKey;
  const photo = state.current && state.current.photo;
  saveTimer = setTimeout(() => {
    if (key !== state.editsKey) return;
    const edits = readEdits(document, {
      photo: { id: key, name: state.current ? state.current.name : null },
      view: state.camera,
      focusPoint: state.focusPoint,
    });
    if (photo) lib.saveEdits(photo, edits).catch((err) => console.warn('Could not save edits', err));
    else editsStore.save(key, edits);
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
  else if (input.id === 'straighten') out.textContent = `${v.toFixed(1)}°`;
  else if (input.id === 'ml-angle') out.textContent = `${v}°`;
  else if (input.id === 'frame-zoom') out.textContent = `${v}%`;
  else if (input.id === 'mx-exposure') out.textContent = `${sign}${Math.abs(v / 100).toFixed(2)} EV`;
  else if (input.id === 'md-near' || input.id === 'md-far') out.textContent = `${sign}${Math.abs(v / 100).toFixed(2)}`;
  else if (input.closest('.mask-shape')) out.textContent = `${v}`;
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

$('flare-on').onchange = () => {
  $('flare-amount').disabled = !$('flare-on').checked;
  applySettings();
};
for (const id of ['lens-distortion', 'lens-vignetting', 'lens-midpoint']) {
  $(id).oninput = () => {
    showSliderValue($(id));
    applySettingsSoon();
  };
  $(id).ondblclick = () => {
    $(id).value = $(id).dataset.default;
    $(id).oninput();
  };
}
$('flare-amount').oninput = () => {
  showSliderValue($('flare-amount'));
  applySettingsSoon();
};
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
  } else if (state.grid && (e.key === '+' || e.key === '=')) {
    setThumbSize(+$('thumb-size').value * 1.25);
  } else if (state.grid && (e.key === '-' || e.key === '_')) {
    setThumbSize(+$('thumb-size').value / 1.25);
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
libReady = openLibrary();
$('version').textContent = VERSION;

// Desktop app: show the photos already imported, and announce cameras as
// they are plugged in.
if (native) {
  document.body.classList.add('native');
  native.onCamerasChanged((cams) => {
    const count = cams.reduce((n, c) => n + c.files.length, 0);
    $('camera-status').textContent = cams.length ? `Lytro camera connected · ${count} photo${count === 1 ? '' : 's'}` : '';
    $('camera-status').classList.toggle('connected', cams.length > 0);
  });
}

// Test hook: ?sample opens the synthetic sample on load.
if (new URLSearchParams(location.search).has('sample')) $('sample-btn').click();
