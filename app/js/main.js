import { VERSION } from './version.js';
import { readEdits, writeEdits, editsStore, EDITS_FORMAT, EDITS_VERSION } from './edits.js';
import { Engine, toImageData } from './engine.js';
import { blobReader, readPhotoSummary, openContainer } from './core/lfp.js';
import { findRecipe, recipeToEdits } from './core/recipe.js';
import { decodePngGray, parseDepthRange, stackDepth } from './core/userdepth.js';
import { upscaleBits16 } from './gpu/upscale.js';
import { importCalibration, listCalibrations, loadCalibration, removeCalibration } from './core/calibration.js';
import { encodeProcessed, decodeProcessed } from './core/processed-cache.js';
import { hashKey, stillKeyText } from './core/still-cache.js';
import { UPSCALE_MODELS, modelMethod, methodModel, modelState, downloadModel, removeModel, readModel } from './core/upscalemodels.js';
import { aiUpscale, aiUpscaleAvailable, denoiseRgb16, addGrain16 } from './core/aiupscale.js';
import { DEPTH_MODELS, depthModelMethod, methodDepthModel, depthModelState, downloadDepthModel, removeDepthModel } from './core/depthmodels.js';
import { setMemoryLimits, fitsMemory, memoryProblem, superResVram } from './core/memorybudget.js';
import { openFiles, openCalibrationFile, pickFolder, isLightFieldName, findSidecar, download, native, CAMERA_IMPORT, LYTRO_USB_VENDOR, recallCameraFolder } from './platform.js';
import { Library } from './library/library.js';
import { openStorage, memoryStorage } from './library/storage.js';
import { groupPhotos } from './library/scan.js';
import { MAX_MASKS } from './core/local.js';
import { ARCHIVE_SUFFIX } from './library/archive.js';
import { TRACKS, FPS as DEFAULT_FPS, emptyAnimation, frameCount, valueAt, isSettingTrack } from './core/keyframes.js';

// Frames a second of animations: for playback, keyframe times and video
// (the Frame rate setting).
import { geometry, isIdentity, apply as applyMatrix, invert, rotateOrientation, flipOrientation, flipVerticalOrientation, fitAspect, FULL_CROP } from './core/geometry.js';
import { hook, setHook } from './core/debugflags.js';
import { colorSettings as buildColorSettings, renderSettings as buildRenderSettings, FRINGES } from './settingsmap.js';
import { initStereo } from './ui/stereo.js';
import { initFrameRate } from './ui/framerate.js';
import { initUpdates, updateCheckOn } from './ui/updates.js';
import { initLocalAdjustments } from './ui/localadjust.js';
import { initLivingFilters } from './ui/livingfilters.js';
import { initKeyframes } from './ui/keyframes.js';
import { initCurvesView } from './ui/curvesview.js';
import { initExport } from './ui/export.js';
import { initCameraImport } from './ui/cameraimport.js';
import { initCameraSection } from './ui/camerasection.js';
import { initLut } from './ui/lut.js';
import { initWhiteBalancePicker } from './ui/whitebalance.js';
import { initColorMatrix } from './ui/colormatrix.js';
import { initToneCurve } from './ui/tonecurve.js';
import { initNumberFields } from './ui/numberfields.js';

const $ = (id) => document.getElementById(id);
const engine = new Engine();
engine.onNotice = (text) => showNotice(text);
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
  repeat: true, // play over and over (the loop button)
  index: 0,
  direction: 1,
  playing: false,
  fps: DEFAULT_FPS,
  lastTick: 0,
  still: null, // ImageData of the full resolution render
  fullResMode: false, // the Full sensor checkbox
  fullRes: false, // a full resolution still is shown (or rendering)
  depthShown: false,
  album: null, // album shown in the sidebar (null: all photos)
  current: null, // { photo, name, file, sidecar } of the open photo
  view: { busy: false, pending: false },
  maskSel: -1, // the local adjustment mask being edited (-1: none)
  anim: emptyAnimation(), // the keyframes of the animation (core/keyframes.js)
  keySel: null, // { k, t }: the main selected keyframe
  upscaleShown: null, // the upscaling method whose settings the sliders hold
  lib: null, // the photo library (library/library.js), once opened
  cameraSection: {}, // what the camera section of the sidebar shows
  rememberedFailed: false, // the remembered camera folder could not be read
  webUsbConn: null, // the connected camera over WebUSB
  webUsbDevice: null,
  webUsbReport: '',
  askCameraPermission: async () => false, // set when the desktop app can watch for a camera
};
// Lenslets mode view: `z` screen pixels per sensor pixel, (x, y) the sensor
// point at the middle of the viewer.
const lensView = { x: null, y: null, z: 4 };

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
let libReady = null;
let calReady = Promise.resolve();
const thumbs = new Map(); // photo id -> object URL (null while loading)
const PHOTO_DRAG = 'application/x-illuminator-photo';

async function openLibrary() {
  for (const url of thumbs.values()) if (url) URL.revokeObjectURL(url);
  thumbs.clear();
  const readSummary = (f) => readPhotoSummary(blobReader(f));
  try {
    state.lib = await new Library(await openStorage(), { readSummary }).load();
  } catch (err) {
    console.warn('Could not open the library; photos are kept for this session only', err);
    state.lib = await new Library(memoryStorage(), { readSummary }).load();
  }
  if (state.album && !state.lib.album(state.album)) state.album = null;
  renderLibrary();
  return state.lib;
}

async function asBlob(f) {
  if (!f || f instanceof Blob) return f;
  return new Blob([await f.arrayBuffer()], { type: /\.png$/i.test(f.name) ? 'image/png' : 'image/jpeg' });
}

function thumbFor(photo) {
  if (thumbs.has(photo.id)) return thumbs.get(photo.id);
  thumbs.set(photo.id, null);
  if (photo.thumb) {
    state.lib.thumbnail(photo).then(asBlob).then((blob) => {
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
  if (!photo || !state.lib || !canvas.width) return;
  const s = Math.min(1, 320 / Math.max(canvas.width, canvas.height));
  const c = document.createElement('canvas');
  c.width = Math.round(canvas.width * s);
  c.height = Math.round(canvas.height * s);
  c.getContext('2d').drawImage(canvas, 0, 0, c.width, c.height);
  c.toBlob((blob) => {
    if (!blob) return;
    state.lib.saveThumbnail(photo, blob).then(() => {
      const old = thumbs.get(photo.id);
      if (old) URL.revokeObjectURL(old);
      thumbs.set(photo.id, URL.createObjectURL(blob));
      renderLibrary();
    }).catch(() => {});
  }, 'image/jpeg', 0.85);
}

const EMPTY_LIBRARY = CAMERA_IMPORT
  ? 'Open .LFR / .LFP files, drop them here, or import from a camera or Lytro Desktop.'
  : 'Open .LFR / .LFP files, drop them here, or import from Lytro Desktop.';

// The Camera section's state (see setCameraSection).
const cameraThumbs = new Map();

function renderLibrary() {
  renderAlbums();
  const album = state.lib && state.album ? state.lib.album(state.album) : null;
  const photos = state.lib ? state.lib.list(state.album) : [];
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
    const more = Object.assign(document.createElement('button'), { className: 'more', type: 'button', textContent: '•••', title: 'Albums, copy and paste settings, delete' });
    more.setAttribute('aria-label', `Actions for ${photo.name}`);
    more.setAttribute('aria-haspopup', 'menu');
    more.onclick = (e) => {
      e.stopPropagation();
      photoMenu(photo, more);
    };
    li.append(img, name, more);
    li.onclick = () => openItem(photo);
    li.oncontextmenu = (e) => {
      e.preventDefault();
      photoMenu(photo, more, { x: e.clientX, y: e.clientY });
    };
    return li;
  }));
  if (state.cameraView && !state.cameraSection.note && !state.cameraSection.cam) state.cameraView = false;
  renderCameraSection();
  if (state.cameraView) renderCameraGrid();
  else renderGrid(photos, album);
  const empty = $('library-empty');
  empty.hidden = photos.length > 0;
  if (album) empty.textContent = 'No photos in this album yet. Drag photos onto the album, or use ••• on a photo.';
  else if (state.lib && !state.lib.persistent) empty.textContent = `${EMPTY_LIBRARY} This browser cannot store a library, so photos are kept until the page is closed.`;
  else empty.textContent = EMPTY_LIBRARY;
}

function renderAlbums() {
  const list = $('album-list');
  if (!state.lib) {
    list.replaceChildren();
    return;
  }
  const rows = [{ id: null, name: 'All photos', count: state.lib.photos.length }, ...state.lib.albums.map((a) => ({ id: a.id, name: a.name, count: a.photos.length }))];
  list.replaceChildren(...rows.map((row) => {
    const li = document.createElement('li');
    li.classList.toggle('current', !state.cameraView && state.album === row.id);
    const b = Object.assign(document.createElement('button'), { type: 'button', className: 'album' });
    const name = Object.assign(document.createElement('span'), { className: 'name', textContent: row.name });
    const count = Object.assign(document.createElement('span'), { className: 'count', textContent: row.count });
    b.append(name, count);
    b.onclick = () => {
      state.album = row.id;
      state.cameraView = false;
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
        await state.lib.addToAlbum(row.id, [id]);
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
  $('grid-import-all').hidden = true;
  $('grid-camera-choose-row').hidden = true;
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
    const more = Object.assign(document.createElement('button'), { className: 'more', type: 'button', textContent: '•••', title: 'Albums, copy and paste settings, delete' });
    more.setAttribute('aria-label', `Actions for ${photo.name}`);
    more.setAttribute('aria-haspopup', 'menu');
    more.onclick = (e) => {
      e.stopPropagation();
      photoMenu(photo, more);
    };
    tile.append(frame, name, more);
    tile.onclick = () => openItem(photo);
    tile.oncontextmenu = (e) => {
      e.preventDefault();
      photoMenu(photo, more, { x: e.clientX, y: e.clientY });
    };
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
function editName(li, value, onDone, label = 'Album name') {
  const input = Object.assign(document.createElement('input'), { type: 'text', value, maxLength: 80 });
  input.setAttribute('aria-label', label);
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
  if (!state.lib) return;
  const li = document.createElement('li');
  $('album-list').append(li);
  editName(li, '', async (name) => {
    if (name) {
      const album = await state.lib.createAlbum(name);
      if (photoIds.length) await state.lib.addToAlbum(album.id, photoIds);
      else {
        state.album = album.id;
        state.cameraView = false;
      }
    }
    renderLibrary();
  });
}

$('album-new').onclick = () => newAlbum();

// ------------------------------------------------ menus

let menuEl = null;
let menuButton = null;
let menuAt = null;

function closeMenu() {
  if (!menuEl) return;
  menuEl.remove();
  menuEl = null;
  if (menuButton) menuButton.setAttribute('aria-expanded', 'false');
  menuButton = null;
}

function placeMenu(anchor, at = null) {
  const r = at ? { left: at.x, top: at.y, bottom: at.y } : anchor.getBoundingClientRect();
  const m = menuEl;
  const left = Math.max(8, Math.min(r.left, innerWidth - m.offsetWidth - 8));
  let top = r.bottom + 4;
  if (top + m.offsetHeight > innerHeight - 8) top = Math.max(8, r.top - m.offsetHeight - 4);
  m.style.left = `${left}px`;
  m.style.top = `${top}px`;
}

// items: { label, action, checked?, danger? } | { heading } | '-'. An action
// that returns true keeps the menu open.
// at: { x, y } to open at the pointer (right-click) instead of below anchor.
function showMenu(anchor, items, at = null) {
  closeMenu();
  const m = document.createElement('div');
  m.className = 'menu';
  m.setAttribute('role', 'menu');
  menuEl = m;
  menuButton = anchor;
  menuAt = at;
  anchor.setAttribute('aria-expanded', 'true');
  fillMenu(items);
  document.body.append(m);
  placeMenu(anchor, at);
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
    if (it.disabled) b.disabled = true;
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
  placeMenu(menuButton, menuAt);
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

// Copy settings / Paste settings (a photo's ••• menu): every setting of one
// photo onto another, except where it was focused by clicking and its
// viewpoint, which belong to the scene.
let copiedSettings = null;
async function copySettings(photo) {
  let edits;
  if (state.current && state.current.photo === photo && state.info) {
    flushSave();
    edits = currentEdits();
  } else {
    edits = await state.lib.loadEdits(photo);
    if (edits && edits.reset) edits = null;
  }
  copiedSettings = { id: photo.id, name: photo.name, edits: edits ? JSON.parse(JSON.stringify(edits)) : null };
}
async function pasteSettings(photo) {
  if (!copiedSettings) return;
  const open = state.current && state.current.photo === photo && state.info;
  const { view, focusPoint, ...rest } = copiedSettings.edits || { format: EDITS_FORMAT, version: EDITS_VERSION };
  const mine = open ? { view: { ...state.camera }, focusPoint: { ...state.focusPoint } } : (await state.lib.loadEdits(photo)) || {};
  const edits = { ...rest, photo: { id: photo.id, name: photo.name }, view: mine.view, focusPoint: mine.focusPoint, modified: new Date().toISOString() };
  if (!copiedSettings.edits) {
    // Copied from a photo never edited: its defaults.
    for (const group of Object.keys(DEFAULT_EDITS || {})) edits[group] = DEFAULT_EDITS[group];
  }
  if (open) {
    flushSave();
    await applyEdits(state.info, edits);
    // One undo step, saved like any change.
    scheduleSave();
  } else {
    await state.lib.saveEdits(photo, edits);
  }
}

function photoMenu(photo, button, at = null) {
  const items = [];
  // Settings first, so they stay in view however many albums there are.
  items.push({ label: 'Copy settings', action: () => copySettings(photo) });
  items.push({
    label: copiedSettings ? `Paste settings from ${copiedSettings.name}…` : 'Paste settings',
    disabled: !copiedSettings || copiedSettings.id === photo.id,
    action: () => confirmInMenu(`Replace the settings of ${photo.name} with those copied from ${copiedSettings.name}?`, 'Paste', () => pasteSettings(photo)),
  });
  items.push({
    label: 'Reset settings…',
    action: () => confirmInMenu(`Reset every setting of ${photo.name}? Its adjustments, keyframes and local adjustments go back to how a newly opened photo starts.`, 'Reset', () => resetPhotoSettings(photo)),
  });
  // Desktop only: the photo's folder in the library, in the system's file manager.
  if (native && native.library && native.library.open) {
    const fileManager = /Mac/i.test(navigator.platform) ? 'Finder' : /Win/i.test(navigator.platform) ? 'Explorer' : 'file manager';
    items.push({ label: `Open in ${fileManager}`, action: () => native.library.open(`Photos/${photo.id}`).catch((err) => console.warn('Could not open the photo folder', err)) });
  }
  items.push('-');
  items.push({ heading: 'Albums' });
  for (const a of state.lib.albums) {
    const inside = a.photos.includes(photo.id);
    items.push({
      label: a.name,
      checked: inside,
      action: async () => {
        if (inside) await state.lib.removeFromAlbum(a.id, [photo.id]);
        else await state.lib.addToAlbum(a.id, [photo.id]);
        renderLibrary();
      },
    });
  }
  items.push({ label: 'New album…', action: () => newAlbum([photo.id]) });
  items.push('-');
  const where = state.lib.store.kind === 'folder'
    ? 'Its folder (the photo and its edits) is moved to the trash.'
    : 'The photo and its edits are deleted from this browser’s storage.';
  items.push({
    label: state.lib.persistent ? 'Delete from library…' : 'Remove from list',
    danger: true,
    action: () => {
      const remove = async () => {
        await state.lib.remove([photo.id]);
        const url = thumbs.get(photo.id);
        if (url) URL.revokeObjectURL(url);
        thumbs.delete(photo.id);
        if (state.current && state.current.photo === photo) closePhoto();
        renderLibrary();
      };
      if (!state.lib.persistent) return remove();
      return confirmInMenu(`Delete ${photo.name} from the library? ${where}`, 'Delete', remove);
    },
  });
  showMenu(button, items, at);
}

function albumMenu(id, li, button) {
  const album = state.lib.album(id);
  if (!album) return;
  showMenu(button, [
    {
      label: 'Rename…',
      action: () => editName(li, album.name, async (name) => {
        if (name) await state.lib.renameAlbum(id, name);
        renderLibrary();
      }),
    },
    {
      label: 'Export album…',
      action: () => exportAlbum(id),
    },
    {
      label: 'Delete album…',
      danger: true,
      action: () => confirmInMenu(`Delete the album “${album.name}”? Its photos stay in the library.`, 'Delete', async () => {
        await state.lib.deleteAlbum(id);
        if (state.album === id) state.album = null;
        renderLibrary();
      }),
    },
  ]);
}

// Copies photos (scan.js entries) into the library, adding them to the
// album being shown. Returns the library photos.
async function importPhotos(entries, { album = state.album, replace = false } = {}) {
  await libReady;
  if (!entries.length) return [];
  let added = [];
  const before = new Map(state.lib.photos.map((p) => [p.id, p.added]));
  try {
    added = await state.lib.add(entries, {
      replace,
      onProgress: (e, i, n) => {
        if (e) showProgress(n > 1 ? `Adding ${e.name} to the library (${i + 1} of ${n})` : `Adding ${e.name} to the library`, i / n);
      },
    });
    // Replaced photos: their thumbnails are new, and an open one opens again
    // from its new files.
    const replaced = added.filter((p) => before.has(p.id) && before.get(p.id) !== p.added);
    for (const p of replaced) {
      const url = thumbs.get(p.id);
      if (url) URL.revokeObjectURL(url);
      thumbs.delete(p.id);
    }
    const open = state.current && state.current.photo;
    if (open && replaced.includes(open)) openItem(open);
    if (album && state.lib.album(album)) await state.lib.addToAlbum(album, added.map((p) => p.id));
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
  await calReady;
  const file = await state.lib.file(photo).catch(() => null);
  if (!file) {
    showError(new Error(`${photo.name} is missing from the library folder.`));
    return;
  }
  const sidecar = await state.lib.sidecar(photo).catch(() => null);
  state.current = { photo, name: photo.name, file, sidecar };
  state.wantThumb = !photo.thumb;
  if (state.grid) showGrid(false);
  renderLibrary();
  const bytes = await file.arrayBuffer();
  const userDepth = await readUserDepth(photo);
  // Desktop app: the processed version kept next to the photo, so the depth is not measured again (core/processed-cache.js).
  const depthCache = native ? decodeProcessed(await state.lib.processed(photo).catch(() => null)) : null;
  const transfer = [bytes];
  if (userDepth) transfer.push(userDepth.data.buffer);
  if (depthCache) transfer.push(depthCache.alpha.buffer, ...depthCache.extra.flatMap((e) => [e.alpha.buffer, e.confidence.buffer]));
  await openWith({ bytes, userDepth, depthCache }, transfer);
  if (state.info && state.current && state.current.photo === photo) state.lib.setPhotoId(photo, state.info.photoId).catch(() => {});
}

// The worker measured something worth keeping (the depth, the focus offset): saved next to the photo, a moment after the last change.
let processedTimer = null;
engine.onCache = (msg) => {
  if (!native || !state.current || !state.info || state.info.photoId !== msg.photoId) return;
  const photo = state.current.photo;
  clearTimeout(processedTimer);
  processedTimer = setTimeout(() => {
    state.lib.saveProcessed(photo, encodeProcessed(msg.cache)).catch((err) => console.warn('Could not save the processed version', err));
  }, 1500);
};

// The depth map from Lytro Desktop, kept with the photo when its library
// was imported: used instead of measuring depth (core/userdepth.js). An
// edited one if there is one, else the one Lytro computed (in stack.lfp).
async function readUserDepth(photo) {
  try {
    const files = await state.lib.userDepth(photo);
    if (!files) {
      const stack = await state.lib.stack(photo);
      return stack ? await stackDepth(new Uint8Array(await stack.arrayBuffer())) : null;
    }
    const range = parseDepthRange(new TextDecoder().decode(await files.range.arrayBuffer()));
    if (!range) return null;
    const bytes = new Uint8Array(await files.image.arrayBuffer());
    let map = await decodePngGray(bytes).catch(() => null);
    if (!map) {
      // Not a PNG we read ourselves: the browser decodes it (8 bit).
      const bmp = await createImageBitmap(new Blob([bytes]));
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const g = c.getContext('2d');
      g.drawImage(bmp, 0, 0);
      const px = g.getImageData(0, 0, bmp.width, bmp.height).data;
      const data = new Float32Array(bmp.width * bmp.height);
      for (let i = 0; i < data.length; i++) data[i] = px[i * 4] / 255;
      map = { width: bmp.width, height: bmp.height, data };
    }
    return { ...map, ...range };
  } catch (err) {
    console.warn('Lytro depth map unreadable', err);
    return null;
  }
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
  state.lensStill = null;
  state.lensPicture = null;
  lensView.x = lensView.y = null;
  state.camera = { u: 0, v: 0 };
  state.focusPoint = { x: 0.5, y: 0.5 };
  showFocusPoint();
  $('spread-overlay').hidden = true;
  setFullRes(false, { restore: false });
  setDepthShown(false, { restore: false });
  showSidebarEnabled();
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
  state.enlarged = false;
  if (img.pair) return drawPair(img);
  startNoticeTimer();
  state.lastImage = img;
  const g = geometryFor(img.width, img.height);
  const k = g && state.showingFrames ? state.frameScale || 1 : 1;
  const w = Math.round((g ? g.width : img.width) * k);
  const h = Math.round((g ? g.height : img.height) * k);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
    layoutCanvas();
  }
  if (!state.photoBase || state.photoBase[0] !== w || state.photoBase[1] !== h) {
    state.photoBase = [w, h];
    showPhotoSizes();
  }
  state.geom = g ? { ...g, inverse: invert(k === 1 ? g.matrix : g.matrix.map((v) => v * k)), srcW: img.width, srcH: img.height } : null;
  if (g) drawGeometry(ctx, img, g, k);
  else if (img instanceof ImageData) ctx.putImageData(img, 0, 0);
  else ctx.drawImage(img, 0, 0);
  if (cropState.editing) positionCropBox();
  canvas.classList.remove('hidden');
  // What the app shows is enlarged with the Upscaling settings too, as it will be saved or exported (not while dragging, nor the depth map).
  if (!drag.on && !state.depthShown && !state.skipEnlarge && state.mode === 'camera') showAtPhotoSize(shownScale(w, h));
  scheduleHistogram();
  if (state.wantThumb && state.mode === 'camera') saveThumbnail();
}

// A stereo pair next to each other (left eye first, or right eye first for
// cross-eyed viewing), each eye through the crop and rotation.
function drawPair(img) {
  startNoticeTimer();
  state.lastImage = img;
  const [first, second] = img.mode === 'cross' ? [img.pair[1], img.pair[0]] : img.pair;
  const g = geometryFor(first.width, first.height);
  const w = g ? g.width : first.width;
  const h = g ? g.height : first.height;
  if (canvas.width !== 2 * w || canvas.height !== h) {
    canvas.width = 2 * w;
    canvas.height = h;
    layoutCanvas();
  }
  state.geom = null;
  const eye = Object.assign(document.createElement('canvas'), { width: w, height: h });
  const e = eye.getContext('2d');
  [first, second].forEach((view, i) => {
    if (g) drawGeometry(e, view, g);
    else e.putImageData(view, 0, 0);
    ctx.drawImage(eye, i * w, 0);
  });
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
let histogramCanvas = null;
function drawHistogram() {
  const hc = $('histogram');
  const hctx = hc.getContext('2d');
  hctx.clearRect(0, 0, hc.width, hc.height);
  const w = canvas.width;
  const h = canvas.height;
  if (!state.info || !w || !h || canvas.classList.contains('hidden')) return;
  // About 250k pixels at most: a large picture is first drawn small (nearest pixels, so the values stay real ones) and only that is read back.
  let data;
  let step = 4;
  if (w * h <= 300000) {
    data = ctx.getImageData(0, 0, w, h).data;
  } else {
    const k = Math.sqrt(250000 / (w * h));
    const sw = Math.max(1, Math.round(w * k));
    const sh = Math.max(1, Math.round(h * k));
    histogramCanvas ||= document.createElement('canvas');
    if (histogramCanvas.width !== sw || histogramCanvas.height !== sh) {
      histogramCanvas.width = sw;
      histogramCanvas.height = sh;
    }
    const sctx = histogramCanvas.getContext('2d', { willReadFrequently: true });
    sctx.imageSmoothingEnabled = false;
    sctx.drawImage(canvas, 0, 0, w, h, 0, 0, sw, sh);
    data = sctx.getImageData(0, 0, sw, sh).data;
  }
  const bins = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
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
  if ($('bokeh').value !== 'optical' || +$('dof-depth').value !== 0 || field.spread > 0 || field.smooth > 0 || field.blur > 0 || field.tilt.some((t) => t)) return { aperture: 0, dof: ratio < 0.15 ? 0 : (radius * ratio) / 14 };
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
// The focus field (spread and tilt) for the worker, from the controls, or
// with any of them replaced by `v` (an animation frame's values).
function focusField(v = {}) {
  // Tilt off: a flat plane of focus, the settings kept for later.
  const tilt = $('tilt-on').checked ? 1.6 * (v.tilt ?? +$('tilt').value) / 100 : 0;
  const angle = ((v.tiltRotation ?? +$('tilt-rotation').value) * Math.PI) / 180;
  return {
    spread: 1.6 * (v.spread ?? +$('spread').value) / 100,
    // Width of the soft edge of the sharp range, in the same units.
    smooth: 0.8 * (v.spreadSmooth ?? +$('spread-smooth').value) / 100,
    // Feathering of the spread in the picture: the blur radius map is smoothed over this many units of the depth of field strength (pixels = blur x
    // the image's pixels per unit; full Blur is the camera's own f/2 blur three focus units away).
    blur: (3 * (state.info ? state.info.radius : 4.5) / 14) * (v.spreadBlur ?? +$('spread-blur').value) / 100,
    tilt: [tilt * Math.cos(angle), tilt * Math.sin(angle)],
    point: [v.pointX ?? state.focusPoint.x, v.pointY ?? state.focusPoint.y],
  };
}

// Bokeh options for the worker: shape and highlights, and the focus field.
const BOKEH_SHAPE = ['bokeh-blades', 'bokeh-oval', 'bokeh-rotation', 'bokeh-onion'];
function bokehParams(v = {}) {
  const shape = ['natural', 'optical'].includes($('bokeh').value) ? 'smooth' : $('bokeh').value;
  return {
    shape,
    highlights: v.highlights ?? +$('highlights').value,
    blades: +$('bokeh-blades').value,
    oval: shape === 'circle' ? +$('bokeh-oval').value / 100 : 0,
    rotation: +$('bokeh-rotation').value,
    onion: shape === 'smooth' ? 0 : +$('bokeh-onion').value / 100,
    ...focusField(v),
  };
}

function showViewpoint() {
  const r = (state.info && state.info.radius) || 1;
  const { u, v } = state.camera;
  $('viewpoint').textContent = Math.abs(u) < 1e-3 && Math.abs(v) < 1e-3 ? 'Center' : `${Math.round((100 * u) / r)}%, ${Math.round((100 * v) / r)}%`;
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
  // Show tilt: the same tint, measured from the tilted plane of focus alone
  // (no sharp range around it), fading in over a short distance from it.
  const tiltView = $('tilt-show').checked && $('tilt-on').checked;
  const on = ($('spread-show').checked || tiltView) && hasDepth() && state.mode === 'camera' && !state.depthShown;
  overlay.hidden = !on;
  if (!on) return;
  if (spreadView.busy) {
    spreadView.pending = true;
    return;
  }
  spreadView.busy = true;
  try {
    const field = tiltView ? { ...focusField(), spread: 0, smooth: 0.3 } : focusField();
    const msg = await engine.request('spreadMask', { alpha: +$('focus').value, ...field }, { onProgress: showProgress });
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
        drawGeometry(o, mask, k, canvas.width / k.width, false);
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
    bokeh: bokehParams(),
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

// While a slider or the picture is dragged the camera view renders a quicker
// draft (strong blur at half size); the full picture follows on release.
const drag = { on: false, drafted: false };
document.addEventListener('pointerdown', (e) => {
  if (e.button === 0 && (e.target === canvas || (e.target.matches && e.target.matches('input[type=range]')))) drag.on = true;
}, true);
for (const type of ['pointerup', 'pointercancel']) {
  document.addEventListener(type, () => {
    if (!drag.on) return;
    drag.on = false;
    if (drag.drafted && showsCamera()) renderCamera();
    drag.drafted = false;
  }, true);
}

// Live camera view. Requests are coalesced: while one renders, only the
// latest settings are kept for the next.
// The engine's noise reduction takes long at the larger picture sizes: a camera view is shown without it first, and the finished picture (with it) is asked for
// once the changes stop (the worker says so with nrDeferred). `final`: that request.
let nrFinalTimer = 0;
let recoveryRunning = false;
async function renderCamera({ final = false } = {}) {
  clearTimeout(nrFinalTimer);
  cancelSharp();
  // Changes keep coming: wait for them to stop before auto rendering.
  if (autoRenderTimer) scheduleAutoRender();
  if (!canRender()) return;
  const v = state.view;
  if (v.busy) {
    v.pending = true;
    // A Detail recovery in progress is for a picture that has changed: stop it.
    if (recoveryRunning) engine.cancel('superres').catch(() => {});
    return;
  }
  v.busy = true;
  try {
    if (stereoShown()) {
      const img = await stereoPreview(cameraParams());
      hideProgress();
      if (img && showsCamera()) draw(img);
    } else {
      const draft = drag.on;
      // Detail recovery also rebuilds the picture itself (not just the full
      // sensor still): from every sensor pixel, at the picture's own size.
      // That takes long, so a change shows the quick view first and the
      // rebuilt picture follows once the changes stop (`final`), as the
      // noise reduction does.
      const passes = +$('still-passes').value;
      const recovery = passes > 0 && !draft && state.info.hasRaw;
      let msg = null;
      if (recovery && final) {
        recoveryRunning = true;
        try {
          const { promise } = engine.job('superRes', 'superres', { ...cameraParams(), scale: +$('detail').value, passes, label: 'Processing' }, { onProgress: showProgress });
          msg = await promise;
        } finally {
          recoveryRunning = false;
        }
        if (!(msg && (msg.pixels || msg.bitmap))) msg = null;
      }
      // (a recovery stopped for a newer change: that change is rendered next)
      if (!msg && !(recovery && final && v.pending)) {
        msg = await engine.request('view', { ...cameraParams(), draft, deferNr: !draft && !final, final: final && !recovery }, {
          onProgress: showProgress,
          // A picture before its noise reduction (a CPU step) is done: shown at once, replaced when the finished one arrives.
          onFrame: (f) => { if (f.preview && f.bitmap && showsCamera()) draw(f.bitmap); },
        });
      }
      hideProgress();
      if (msg && (msg.pixels || msg.bitmap) && showsCamera()) {
        draw(toImageData(msg));
        if (draft) drag.drafted = true;
      }
      if (msg && msg.gpuMs != null) showGpuTime(msg.gpuMs);
      if (msg && !final && (msg.nrDeferred || recovery)) nrFinalTimer = setTimeout(() => { if (showsCamera()) renderCamera({ final: true }); }, 350);
    }
  } catch (err) {
    showError(err);
  } finally {
    v.busy = false;
    if (v.pending) {
      v.pending = false;
      renderCamera();
    } else {
      scheduleSharp();
    }
  }
}

// At f/22 (aperture closed, no depth-of-field blur) the live view is one view of the light field, at the lens grid's resolution: sharp in
// depth but with a lens per pixel. Once changes stop, the all-in-focus picture from every sensor pixel (the engine's, as Render makes it, at
// twice the view's size) is made in the background and shown instead; any change goes back to the live view and cancels it. Not on a
// software renderer (minutes), not while Full resolution mode is on (it has its own Render), and not when the card's memory limit says no.
const SHARP_DELAY = 1500;
const SHARP_SCALE = 2;
let sharpTimer = 0;
const sharp = { running: false, token: 0 };

function sharpWanted() {
  const info = state.info;
  if (!info || !info.hasRaw || state.mode !== 'camera' || !showsCamera() || state.fullResMode || state.playing || drag.on || stereoShown()) return false;
  if (!hook('sharpAnyGpu') && /swiftshader|llvmpipe|software|softpipe|^CPU/i.test(info.renderer || 'CPU')) return false;  // (the flag: tests on a software renderer)
  const lens = apertureFor(fNumber());
  if (lens.aperture !== 0 || lens.dof !== 0) return false;
  const size = info.stillSizes && info.stillSizes[SHARP_SCALE];
  return !(size && !fitsMemory('vram', superResVram(size[0], size[1])));
}

function cancelSharp() {
  clearTimeout(sharpTimer);
  sharpTimer = 0;
  sharp.token++;
  if (sharp.running) engine.cancel('superres').catch(() => {});
}

function scheduleSharp() {
  clearTimeout(sharpTimer);
  sharpTimer = 0;
  if (!sharpWanted()) return;
  sharpTimer = setTimeout(runSharp, SHARP_DELAY);
}

async function runSharp() {
  sharpTimer = 0;
  if (!sharpWanted() || state.view.busy) return;
  if (sharp.running) return;  // (when it ends, a cancelled one starts the next, see below)
  const token = ++sharp.token;
  const photo = state.current && state.current.photo;
  sharp.running = true;
  try {
    const { promise } = engine.job('superRes', 'superres', { ...cameraParams(), scale: SHARP_SCALE, passes: 0, label: 'Sharpening', quiet: true }, { onProgress: (stage, p) => { if (sharp.token === token) $('frame-label').textContent = `Sharpening ${Math.round((p ?? 0) * 100)}%`; } });
    const msg = await promise;
    // A change since (or another photo) makes it stale.
    if (token === sharp.token && msg && (msg.pixels || msg.bitmap) && sharpWanted() && state.current && state.current.photo === photo) {
      const img = toImageData(msg);
      draw(img);
      $('frame-label').textContent = `${canvas.width}×${canvas.height}`;
    }
  } catch (err) {
    // the quick view stays; nothing to tell the user about a background picture
    console.warn('Sharp preview failed', err);
  } finally {
    sharp.running = false;
    if (token === sharp.token && !$('frame-label').textContent.includes('×')) $('frame-label').textContent = `${canvas.width}×${canvas.height}`;
    // A change cancelled it (or came while it ran, and its own try found it busy): start again once the live view is up to date.
    if (token !== sharp.token && !sharpTimer && !state.view.busy && !state.view.pending) scheduleSharp();
  }
}

// Shows whatever the current state calls for.
function refresh() {
  if (!state.info) return;
  if (state.mode === 'lenslets') renderLenslets();
  else if (state.depthShown) {
    renderDepth();
    if (state.fullRes && !state.still) renderStill();
  } else if (state.fullRes && state.still) draw(state.still);
  else if (state.fullRes) renderStill();
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
    // Near and Far may be keyframed: step i is at i / frame rate.
    const alphas = Array.from({ length: n }, (_, i) => {
      const t = i / state.fps;
      const near = valueAt(state.anim, 'near', t) ?? +$('near').value;
      const far = valueAt(state.anim, 'far', t) ?? +$('far').value;
      return near + ((far - near) * i) / (n - 1);
    });
    // A small aperture would show little change: sweep at least wide open.
    const aperture = Math.max(p.aperture, 1);
    return { type: 'refocusFrames', kind: 'refocus', loop: 'pingpong', values: alphas, args: { alphas, u: p.u, v: p.v, aperture, dof: p.dof, bokeh: p.bokeh } };
  }
  const n = +$('frames').value;
  const path = Array.from({ length: n }, (_, i) => {
    // Amount may be keyframed: frame i is at i / frame rate.
    const r = state.info.radius * (valueAt(state.anim, 'amount', i / state.fps) ?? +$('amount').value);
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
    ? req.args.path.map((f) => pivotFor(f.u, f.v, f.alpha ?? req.args.alpha, f.aperture ?? req.args.aperture, f.pivot ?? null))
    : req.args.alphas.map((alpha) => pivotFor(req.args.u, req.args.v, alpha, req.args.aperture)));
  if (req.framing) state.framePivots = state.framePivots.map((p, i) => combineMotion(p, req.framing[i]));
  // Zoomed frames are drawn into a canvas this much larger, so the zoom is
  // resampled once (straight to the screen) instead of blown up twice.
  state.frameScale = Math.min(3, Math.max(1, ...state.framePivots.map((p) => (p && p.zoom) || 1)));
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
  // The playhead stays on the frame that was showing (while frames play, only
  // their index moves, not the playhead's time).
  if (state.showingFrames && state.frames.length > 1) state.keyTime = (state.drawFrame ?? state.index) / state.fps;
  if (state.animKey) {
    engine.cancel('frames');
    engine.cancel('refocus');
  }
  state.animKey = null;
  state.frames = [];
  state.frameValues = [];
  updateFrameLabel();
}

// The play bar's readout: current frame of all frames, and the time of the
// length (shown whenever the animation is on).
function updateFrameLabel() {
  const n = state.frames.length;
  const animOn = $('anim-on').checked && state.mode === 'camera' && state.info;
  if (!animOn && (!n || !state.showingFrames)) {
    if (!state.fullRes) $('frame-label').textContent = '';
    return;
  }
  const keyframes = $('anim').value === 'keyframes';
  const expected = keyframes ? frameCount(state.anim, state.fps) : Math.max(1, +$($('anim').value === 'focus' ? 'steps' : 'frames').value);
  // Keyframes without an animation yet render one frame: count the length.
  const total = keyframes ? expected : n || expected;
  // The play bar's slider spans the whole animation, rendered or not, so it
  // can be dragged at once.
  $('scrub').max = String(Math.max(0, expected - 1));
  const index = n > 1 && state.showingFrames ? state.index : keyframes ? Math.round((state.keyTime || 0) * state.fps) : 0;
  const i = Math.min(total - 1, Math.max(0, index));
  const ready = state.frames.filter(Boolean).length;
  const val = state.showingFrames ? state.frameValues[state.index] : undefined;
  $('frame-label').textContent = `Frame ${i + 1} / ${total} · ${(i / state.fps).toFixed(2)} / ${((total - 1) / state.fps).toFixed(2)} s` +
    (n && ready < n ? ` (rendering ${ready})` : '') +
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
  if (!state.repeat && (next >= n || (state.loop === 'pingpong' && next < 0))) {
    // Played once (a focus sweep: there and back): stop at the end.
    if (state.loop === 'pingpong' && next >= n) {
      state.direction = -state.direction;
      next = state.index + state.direction;
    } else {
      setPlaying(false);
      return;
    }
  } else if (state.loop === 'pingpong') {
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
  showPlayIcon(p);
  if (p) {
    // Played to the end without repeating: start over.
    if (!state.repeat && state.loop !== 'pingpong' && state.index >= state.frames.length - 1) state.index = 0;
    if (!state.repeat && state.loop === 'pingpong' && state.direction < 0 && state.index <= 0) state.direction = 1;
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

// The saved render (desktop app, a library photo) of these settings: the hash naming it, or null where renders are not kept.
function stillHash(scale, passes) {
  if (!native || !state.lib || !state.current || !state.current.photo) return null;
  return hashKey(stillKeyText({
    edits: currentEdits(), camera: cameraParams(), scale, passes, frame: state.stillFrame, photoId: state.current.photo.photoId || state.current.photo.id, version: VERSION,
  }));
}

// PNG of a render (an ImageData, or an ImageBitmap from the GPU).
async function stillPng(img) {
  const c = new OffscreenCanvas(img.width, img.height);
  const g = c.getContext('2d');
  if (img instanceof ImageData) g.putImageData(img, 0, 0);
  else g.drawImage(img, 0, 0);
  return c.convertToBlob({ type: 'image/png' });
}

// ImageData of a saved render, or null.
async function stillFromFile(file) {
  try {
    const bmp = await createImageBitmap(file, { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const g = c.getContext('2d');
    g.drawImage(bmp, 0, 0);
    bmp.close();
    return g.getImageData(0, 0, c.width, c.height);
  } catch {
    return null;
  }
}

async function renderStill() {
  const scale = +$('still-scale').value;
  // The card's memory (Settings > Memory): a full sensor render of this size needs about this much.
  const size = state.info && state.info.stillSizes && state.info.stillSizes[scale];
  if (size && !fitsMemory('vram', superResVram(size[0], size[1]))) {
    showNotice('Not rendered', memoryProblem('vram', superResVram(size[0], size[1]), `A ${size[0]}×${size[1]} full sensor render`, 'Lower the Scale (Render Settings > Quality) or raise the limit.'));
    setFullRes(false);
    return;
  }
  try {
    const passes = +$('still-passes').value;
    const hash = stillHash(scale, passes);
    const photo = state.current && state.current.photo;
    // The same render was made before: show it.
    if (hash) {
      const file = await state.lib.still(photo, hash);
      const img = file && (await stillFromFile(file));
      if (img && state.fullRes && state.current && state.current.photo === photo) {
        state.still = img;
        state.lensStill = { img, scale };
        if (!state.depthShown) {
          draw(img);
          showAtPhotoSize();
          $('frame-label').textContent = `${canvas.width}×${canvas.height}`;
        }
        return;
      }
    }
    // The animation frame on show renders as it is (its camera and local
    // adjustment settings), not the live camera's.
    const { promise } = engine.job('superRes', 'superres', { ...(state.stillFrame || cameraParams()), scale, passes }, { onProgress: showProgress });
    const msg = await promise;
    // Ignore a result that arrives after full resolution was switched off.
    if (msg && (msg.pixels || msg.bitmap) && state.fullRes) {
      state.still = toImageData(msg);
      state.lensStill = { img: state.still, scale };
      if (!state.depthShown) {
        draw(state.still);
        showAtPhotoSize();
        $('frame-label').textContent = `${canvas.width}×${canvas.height}`;
      }
      // Kept next to the photo for next time (not waited for).
      if (hash) {
        const shown = state.still;
        stillPng(shown).then((blob) => state.lib.saveStill(photo, hash, blob)).catch((err) => console.warn('Could not keep the full sensor render', err));
      }
    }
  } catch (err) {
    showError(err);
  } finally {
    hideProgress();
  }
}

// Full resolution re-renders what the camera shows (viewpoint, focus,
// aperture, depth of field) from every sensor pixel. The checkbox turns the
// mode on (Scale appears, Render is enabled); Render makes the still. Any change to
// the picture returns to the live view until Render is pressed again.
// Render works for any raw photo in the camera view: at the Photo Size with the chosen Upscaling (a downloaded model enlarges the picture here), or, with Full
// sensor on, as the full sensor still.
function updateRenderButton() {
  $('render-btn').disabled = !(state.info && state.info.hasRaw && state.mode === 'camera');
}

function setFullResMode(on) {
  if (on && !(state.info && state.info.hasRaw && state.mode === 'camera')) on = false;
  state.fullResMode = on;
  $('fullres-on').checked = on;
  $('fullres-panel').hidden = !on;
  updateRenderButton();
  $('auto-render').disabled = !on;
  showPhotoSizes();
  if (!on) setFullRes(false);
  else if ($('auto-render').checked) scheduleAutoRender(0);
}

// Auto render: with Full resolution on, the still is rendered again by
// itself once changes stop (not while a slider or the picture is dragged,
// during playback, or while frames or the depth map are shown).
const AUTO_RENDER_DELAY = 800;
let autoRenderTimer = 0;
function scheduleAutoRender(delay = AUTO_RENDER_DELAY) {
  clearTimeout(autoRenderTimer);
  autoRenderTimer = 0;
  if (!$('auto-render').checked || !state.fullResMode || state.fullRes) return;
  autoRenderTimer = setTimeout(() => {
    autoRenderTimer = 0;
    if (drag.on) return scheduleAutoRender();
    if (state.playing || state.showingFrames || state.depthShown || $('auto-render').disabled) return;
    setFullRes(true);
  }, delay);
}
// Auto render is saved with each photo (edits.js), not remembered globally.
$('auto-render').onchange = () => scheduleAutoRender(0);

function renderFullRes() {
  if (!state.fullResMode) {
    renderAtPhotoSize();
    return;
  }
  if (state.fullRes) renderStill();
  else setFullRes(true);
}

// The picture shown at the Photo Size, made with the chosen Upscaling: the plain methods are already what draw() shows; a downloaded model enlarges the picture on
// show here (it takes a while, so it is made when Render is pressed), blended with the plain enlargement by Model strength. Save writes what is on show.
let renderingAtSize = false;
async function renderAtPhotoSize() {
  if (renderingAtSize || !state.lastImage || state.lastImage.pair || state.mode !== 'camera') return;
  const k = +$('photo-size').value || 1;
  if (!(k > 1)) {
    showNotice('Photo Size is Native', 'Choose a larger Photo Size (Render Settings > Photo) to enlarge the picture.');
    return;
  }
  const model = methodModel($('upscale-method').value);
  if (!model) {
    draw(state.lastImage);
    return;
  }
  renderingAtSize = true;
  try {
    // the picture at its own size (through crop and rotation), before any enlargement
    state.skipEnlarge = true;
    draw(state.lastImage);
    state.skipEnlarge = false;
    const w = canvas.width;
    const h = canvas.height;
    const base = ctx.getImageData(0, 0, w, h);
    const rgb = new Uint16Array(w * h * 3);
    for (let i = 0; i < w * h; i++) {
      rgb[3 * i] = base.data[4 * i] * 257;
      rgb[3 * i + 1] = base.data[4 * i + 1] * 257;
      rgb[3 * i + 2] = base.data[4 * i + 2] * 257;
    }
    const W = Math.round(w * k);
    const H = Math.round(h * k);
    const P = modelUpscaleParams();
    const grown = await aiUpscale(model, () => readModel(model), denoiseRgb16(rgb, w, h, P.denoise), w, h, showProgress);
    hideProgress();
    let big = { rgb: grown.rgb, width: grown.width, height: grown.height };
    if (grown.width !== W) {
      const sized = upscaleBits16(grown.rgb, grown.width, grown.height, W, H, { method: 'lanczos', sharpen: 0 });
      if (sized) big = { rgb: sized, width: W, height: H };
    }
    big = finishModelEnlargement(big, rgb, w, h, P);
    const out = new ImageData(big.width, big.height);
    for (let i = 0; i < big.width * big.height; i++) {
      out.data[4 * i] = big.rgb[3 * i] >> 8;
      out.data[4 * i + 1] = big.rgb[3 * i + 1] >> 8;
      out.data[4 * i + 2] = big.rgb[3 * i + 2] >> 8;
      out.data[4 * i + 3] = 255;
    }
    canvas.width = big.width;
    canvas.height = big.height;
    ctx.putImageData(out, 0, 0);
    layoutCanvas();
    if (state.geom) state.geom = { ...state.geom, inverse: invert(state.geom.matrix.map((v) => v * (big.width / w))) };
    state.enlarged = true;
    $('frame-label').textContent = `${canvas.width}×${canvas.height}`;
  } catch (err) {
    hideProgress();
    state.skipEnlarge = false;
    showNotice('Could not enlarge with the model', `${err && err.message ? err.message : err} The picture is enlarged with Lanczos instead.`);
    draw(state.lastImage);
  } finally {
    renderingAtSize = false;
  }
}

// The downloaded model's own settings (Render > Upscaling, kept per model): how much of its result is used, how much the picture is smoothed before it goes in, the
// sharpening and the grain applied to what comes out.
function modelUpscaleParams() {
  return { strength: +$('upscale-strength').value / 100, denoise: +$('upscale-denoise').value / 100, sharpen: +$('upscale-sharpen').value / 100, grain: +$('upscale-grain').value / 100 };
}

// The model's enlargement `big` (16-bit RGB of the picture `rgb`, w x h) with the model settings applied: mixed with the plain enlargement, sharpened, grained.
function finishModelEnlargement(big, rgb, w, h, P) {
  big = blendWithPlain(big, rgb, w, h, P.strength);
  if (P.sharpen > 0) {
    const sharp = upscaleBits16(big.rgb, big.width, big.height, big.width, big.height, { method: 'lanczos', sharpen: P.sharpen });
    if (sharp) big = { rgb: sharp, width: big.width, height: big.height };
  }
  if (P.grain > 0) big = { rgb: addGrain16(big.rgb, big.width, big.height, P.grain), width: big.width, height: big.height };
  return big;
}

// `big` (the model's enlargement, 16-bit RGB) mixed with the plain Lanczos enlargement of `rgb` (w x h) of the same size: strength 1 is the model alone.
function blendWithPlain(big, rgb, w, h, strength) {
  if (!(strength < 1)) return big;
  const plain = upscaleBits16(rgb, w, h, big.width, big.height, { method: 'lanczos', sharpen: 0 });
  if (!plain) return big;
  const out = new Uint16Array(big.rgb.length);
  for (let i = 0; i < out.length; i++) out[i] = plain[i] + (big.rgb[i] - plain[i]) * strength;
  return { rgb: out, width: big.width, height: big.height };
}

function setFullRes(on, { restore = true } = {}) {
  if (on && !(state.fullResMode && state.info && state.info.hasRaw && state.mode === 'camera')) return;
  if (on === state.fullRes) return;
  state.fullRes = on;
  showPhotoSizes();
  if (on) {
    // Rendering from an animation frame keeps that frame's settings.
    state.stillFrame = state.showingFrames ? frameList()[state.index] || null : null;
    state.stillIndex = state.index;
    setPlaying(false);
    state.showingFrames = false;
    // The depth map, if shown, stays on screen; the still is made meanwhile and shows when the depth map goes off.
    renderStill();
    return;
  }
  engine.cancel('superres');
  hideProgress();
  state.still = null;
  state.stillFrame = null;
  $('frame-label').textContent = '';
  if (restore) refresh();
  scheduleAutoRender();
}

async function renderDepth() {
  try {
    const msg = await engine.request('depthMap', { grey: $('depth-grey').checked, contrast: $('depth-contrast').value / 100 }, { onProgress: showProgress });
    hideProgress();
    if (msg && msg.pixels && state.depthShown) draw(toImageData(msg));
  } catch (err) {
    showError(err);
  }
}

// Depth map contrast reshapes the depth itself (the worker applies it with the other depth settings), so the picture's blur and the shown map change together.
$('depth-contrast').oninput = () => {
  showSliderValue($('depth-contrast'));
  applySettingsSoon();
};
$('depth-grey').addEventListener('change', () => {
  if (state.depthShown) renderDepth();
});

function setDepthShown(on, { restore = true } = {}) {
  if (on && !(hasDepth() && state.mode === 'camera')) {
    $('depth-btn').checked = false;
    return;
  }
  if (on === state.depthShown) return;
  state.depthShown = on;
  updateSpreadOverlay();
  $('depth-btn').checked = on;
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

// Lenslets mode: the raw sensor, zoomed and moved like a map (scroll to
// zoom, drag to move); lensView is declared with the other view state.
const LENS_MAX_ZOOM = 32;
let lensBusy = false;
let lensAgain = false;

function lensMinZoom() {
  const cam = state.info.cam;
  return Math.min(viewer.clientWidth / cam.width, viewer.clientHeight / cam.height);
}

function lensClamp() {
  const cam = state.info.cam;
  if (lensView.x == null) {
    lensView.x = cam.width / 2;
    lensView.y = cam.height / 2;
  }
  lensView.z = Math.min(LENS_MAX_ZOOM, Math.max(lensMinZoom(), lensView.z));
  // Keep the sensor in view; centered along a side that fits entirely.
  const hw = viewer.clientWidth / (2 * lensView.z);
  const hh = viewer.clientHeight / (2 * lensView.z);
  lensView.x = hw * 2 >= cam.width ? cam.width / 2 : Math.min(cam.width - hw, Math.max(hw, lensView.x));
  lensView.y = hh * 2 >= cam.height ? cam.height / 2 : Math.min(cam.height - hh, Math.max(hh, lensView.y));
}

// Zooms by `factor` keeping the sensor point under (mx, my) in place.
function lensZoomBy(factor, mx = viewer.clientWidth / 2, my = viewer.clientHeight / 2) {
  if (!state.info || !state.info.cam) return;
  lensClamp();
  const sx = lensView.x + (mx - viewer.clientWidth / 2) / lensView.z;
  const sy = lensView.y + (my - viewer.clientHeight / 2) / lensView.z;
  lensView.z *= factor;
  lensClamp();
  lensView.x = sx - (mx - viewer.clientWidth / 2) / lensView.z;
  lensView.y = sy - (my - viewer.clientHeight / 2) / lensView.z;
  renderLenslets();
}

function lensDrag(event) {
  canvas.setPointerCapture(event.pointerId);
  canvas.classList.add('panning');
  const start = { x: event.clientX, y: event.clientY, sx: lensView.x, sy: lensView.y };
  canvas.onpointermove = (e) => {
    lensView.x = start.sx - (e.clientX - start.x) / lensView.z;
    lensView.y = start.sy - (e.clientY - start.y) / lensView.z;
    renderLenslets();
  };
  canvas.onpointerup = () => {
    canvas.onpointermove = null;
    canvas.classList.remove('panning');
  };
}

async function renderLenslets() {
  if (!state.info || !state.info.cam || state.mode !== 'lenslets') return;
  if (lensBusy) {
    lensAgain = true;
    return;
  }
  lensBusy = true;
  try {
    lensClamp();
    const ow = Math.max(1, Math.round(viewer.clientWidth));
    const oh = Math.max(1, Math.round(viewer.clientHeight));
    const { z } = lensView;
    const w = ow / z;
    const h = oh / z;
    const x0 = lensView.x - w / 2;
    const y0 = lensView.y - h / 2;
    const scale = +$('still-scale').value;
    const p = cameraParams();
    const msg = await engine.request('rawCrop', { x0, y0, w, h, ow, oh, scale, alpha: p.alpha, allInFocus: !(p.aperture > 0) });
    if (state.mode !== 'lenslets' || !msg) return;
    canvas.width = ow;
    canvas.height = oh;
    view.k = 1;
    view.cx = view.cy = 0.5;
    layoutCanvas();
    $('zoom-label').textContent = `${Math.round(z * 100)}%`;
    $('zoom-out').disabled = z <= lensMinZoom() + 1e-9;
    $('zoom-in').disabled = z >= LENS_MAX_ZOOM - 1e-9;
    ctx.putImageData(new ImageData(new Uint8ClampedArray(msg.pixels), ow, oh), 0, 0);
    ctx.lineWidth = 1.5;
    const circles = $('lens-circles').checked && msg.rUse * z >= 6;
    for (let i = 0; i < msg.centers.length; i += 2) {
      const cx = msg.centers[i] * z;
      const cy = msg.centers[i + 1] * z;
      if (circles) {
        ctx.strokeStyle = 'rgba(77, 182, 255, 0.75)';
        ctx.beginPath();
        ctx.arc(cx, cy, msg.rUse * z, 0, 2 * Math.PI);
        ctx.stroke();
      }
      ctx.strokeStyle = 'rgba(242, 179, 61, 0.9)';
      ctx.beginPath();
      ctx.arc(cx, cy, Math.min(2.5, msg.pitch * z * 0.15), 0, 2 * Math.PI);
      ctx.stroke();
    }
    canvas.classList.remove('hidden');
    canvas.classList.add('pannable');
    scheduleHistogram();
    $('frame-label').textContent = `sensor ${Math.max(0, Math.round(x0))}–${Math.round(x0 + w)}, ${Math.max(0, Math.round(y0))}–${Math.round(y0 + h)}`;
    showLensSampling(msg, scale);
  } catch (err) {
    showError(err);
  } finally {
    lensBusy = false;
    if (lensAgain) {
      lensAgain = false;
      renderLenslets();
    }
  }
}

// Sidebar: the coverage map and the matching part of the rendered picture.
function showLensSampling(msg, scale) {
  const cov = $('lens-coverage');
  const patch = $('lens-patch');
  const cctx = cov.getContext('2d');
  const pctx = patch.getContext('2d');
  for (const id of ['lens-patch', 'lens-patch-title']) $(id).hidden = false;
  // Coverage: the splat weight each output pixel gets, against the mean.
  const { cw, ch } = msg;
  const data = new Float32Array(msg.coverage);
  let sum = 0;
  for (const v of data) sum += v;
  const mean = sum / data.length || 1;
  const img = new ImageData(cw, ch);
  const STOPS = [[18, 12, 28], [150, 40, 60], [230, 120, 40], [240, 210, 90], [250, 250, 225]];
  for (let i = 0; i < data.length; i++) {
    const t = Math.min(1, data[i] / mean / 2);
    const f = t * (STOPS.length - 1);
    const k = Math.min(STOPS.length - 2, Math.floor(f));
    const a = f - k;
    for (let c = 0; c < 3; c++) img.data[4 * i + c] = STOPS[k][c] * (1 - a) + STOPS[k + 1][c] * a;
    img.data[4 * i + 3] = 255;
  }
  // Both views keep one size, the viewer's shape across the sidebar; the
  // window is fitted inside it.
  const VW = 560;
  const VH = Math.round((VW * viewer.clientHeight) / Math.max(1, viewer.clientWidth));
  for (const c of [cov, patch]) {
    if (c.width !== VW || c.height !== VH) {
      c.width = VW;
      c.height = VH;
    }
  }
  const place = (c2d, src, sx, sy, sw, sh) => {
    const k = Math.min(VW / sw, VH / sh);
    c2d.fillStyle = '#000';
    c2d.fillRect(0, 0, VW, VH);
    c2d.imageSmoothingEnabled = false;
    c2d.drawImage(src, sx, sy, sw, sh, (VW - sw * k) / 2, (VH - sh * k) / 2, sw * k, sh * k);
  };
  const tmp = Object.assign(document.createElement('canvas'), { width: cw, height: ch });
  tmp.getContext('2d').putImageData(img, 0, 0);
  place(cctx, tmp, 0, 0, cw, ch);

  // The same part of the last full sensor render, or else of the picture.
  const still = state.lensStill;
  const src = still ? still.img : state.lensPicture;
  if (!src) {
    for (const id of ['lens-patch', 'lens-patch-title']) $(id).hidden = true;
    return;
  }
  const k = src.width / msg.baseW;
  const [bx0, by0, bx1, by1] = msg.box;
  const sw = (bx1 - bx0) * k;
  const sh = (by1 - by0) * k;
  let drawable = src;
  if (src instanceof ImageData) {
    drawable = Object.assign(document.createElement('canvas'), { width: src.width, height: src.height });
    drawable.getContext('2d').putImageData(src, 0, 0);
  }
  place(pctx, drawable, bx0 * k, by0 * k, sw, sh);
  $('lens-patch-title').textContent = still ? `Last Full sensor render (${still.scale}×)` : 'Camera view';
}

// ---------------------------------------------------------------- modes

// Without a photo nothing in the right sidebar can be used: every section's
// settings (and the Render buttons) are disabled; the sections still open.
function showSidebarEnabled() {
  const off = !state.info;
  for (const el of document.querySelectorAll('.controls > .panel > :not(summary), .controls > .render-actions')) el.inert = off;
  $('controls').classList.toggle('no-photo', off);
}

function setMode(mode) {
  showSidebarEnabled();
  // The Lenslets view compares the sensor with the picture shown before.
  if (mode === 'lenslets' && state.mode === 'camera' && state.lastImage && !state.lastImage.pair) state.lensPicture = state.lastImage;
  state.mode = mode;
  updateRenderButton();
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
  for (const id of ['depth-btn', 'depth-grey', 'depth-contrast', 'spread-show', 'depth-smooth', 'depth-hq', 'depth-style', 'depth-blend', 'depth-model-blend', 'depth-objects', 'depth-objects-soft', 'depth-model-smooth', 'depth-model-curve', 'lytro-depth']) $(id).disabled = !depthTools;
  // Photos imported with a depth map edited in Lytro Desktop can use it.
  $('lytro-depth-row').hidden = !(state.info && state.info.userDepth);
  for (const id of ['fstop', 'bokeh', 'dof-depth', 'highlights', 'spread', 'spread-smooth', 'spread-blur', 'tilt-on', 'tilt', 'tilt-rotation', 'tilt-show', ...BOKEH_SHAPE]) $(id).disabled = !depthTools || stack;
  if (!$('tilt-on').checked) for (const id of ['tilt', 'tilt-rotation', 'tilt-show']) $(id).disabled = true;
  $('mv-on').disabled = !raw;
  $('nr-hot').disabled = !raw;
  // Pictures Lytro Desktop finished already have its look.
  $('base-look').disabled = !raw;
  $('detail').disabled = !raw;
  for (const id of ['stop-btn', 'pause-btn', 'play-btn', 'loop-btn', 'webm-btn', 'scrub']) $(id).disabled = !state.info || !camera || !$('anim-on').checked;
  $('png-btn').disabled = !state.info;
  $('quick-export-btn').disabled = !state.info;
  $('stereo-btn').disabled = !(state.info && state.info.hasRaw) || !camera;
  $('vr-btn').disabled = !(state.info && state.info.hasRaw) || !camera;
  $('stereo-on').disabled = !(state.info && state.info.hasRaw) || !camera;
  if (!state.info) return;
  setFullRes(false, { restore: false });
  // The depth map stays on through camera-mode changes (a new photo or leaving the camera view turns it off elsewhere).
  if (mode !== 'camera') setDepthShown(false, { restore: false });
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
  updateKeyButtons();
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
  showPhotoSizes();
}

// Photo > Size options show the saved photo's size: the picture as shown
// (through crop and rotation; with Full sensor on but not yet rendered, the
// size its still will have) times each option.
const PHOTO_SIZE_NAMES = { 1: 'Native', 1.5: '1.5×', 2: '2×', 3: '3×', 4: '4×' };
function showPhotoSizes() {
  let base = state.info && state.photoBase ? [...state.photoBase] : null;
  if (base && state.fullResMode && !state.fullRes && state.info.stillSizes && state.info.sizes) {
    const still = state.info.stillSizes[$('still-scale').value];
    const view = state.info.sizes[$('detail').value];
    if (still && view) base = base.map((v) => v * (still[0] / view[0]));
  }
  for (const o of $('photo-size').options) {
    const k = +o.value;
    o.textContent = `${PHOTO_SIZE_NAMES[o.value] || `${k}×`}${base ? ` — ${Math.round(base[0] * k)}×${Math.round(base[1] * k)} px` : ''}`;
  }
}

function renderInfo() {
  showResolutionSizes();
  updateKeyButtons();
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
    if (state.gpuMs != null) rows.push(['GPU time', gpuTimeText()]);
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

// GPU time of a recent camera view (measured where the browser allows it).
function gpuTimeText() {
  return `${state.gpuMs < 10 ? fmt(state.gpuMs, 1) : Math.round(state.gpuMs)} ms per view`;
}

function showGpuTime(ms) {
  const first = state.gpuMs == null;
  state.gpuMs = ms;
  if (first) {
    if (state.info) renderInfo();
    return;
  }
  const dd = [...$('info').querySelectorAll('dt')].find((dt) => dt.textContent === 'GPU time');
  if (dd) dd.nextElementSibling.textContent = gpuTimeText();
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
  if (state.mode === 'lenslets') {
    lensZoomBy(Math.exp(-event.deltaY * (event.deltaMode === 1 ? 0.05 : 0.0015)), event.clientX - rect.left, event.clientY - rect.top);
    return;
  }
  zoomBy(Math.exp(-event.deltaY * (event.deltaMode === 1 ? 0.05 : 0.0015)), event.clientX - rect.left, event.clientY - rect.top);
}, { passive: false });

// Drag to pan when zoomed in (Shift+drag in camera mode, where a plain drag
// changes the viewpoint; a middle button drag anywhere). A drag suppresses the click that follows it.
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
    // A middle button drag is followed by no click to suppress.
    suppressClick = moved && event.button === 0;
  };
}

new ResizeObserver(() => (state.mode === 'lenslets' ? renderLenslets() : layoutCanvas())).observe(viewer);
const lenslets = () => state.mode === 'lenslets' && state.info && state.info.cam;
$('zoom-in').onclick = () => (lenslets() ? lensZoomBy(1.5) : zoomBy(1.5));
$('zoom-out').onclick = () => (lenslets() ? lensZoomBy(1 / 1.5) : zoomBy(1 / 1.5));
$('zoom-label').onclick = () => (lenslets() ? lensZoomBy(lensMinZoom() / lensView.z) : zoomFit());
$('zoom-1').onclick = () => (lenslets() ? lensZoomBy(1 / lensView.z) : zoomActual());

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
  await applyFocusAt(x, y, true);
}

// The click's own measurement, then (once the full depth map exists, see engine.onDepthReady) again on it if nothing has moved the focus since.
let lastClick = null;
async function applyFocusAt(x, y, opening) {
  // Blur drawn from the depth map (the default): the focus value is the depth map's value at the click. Optical refocusing: measured from the views.
  const depth = apertureFor(Math.min(fNumber(), 2.8)).aperture === 0;
  const res = await engine.request('focusAt', { x, y, u: state.camera.u, v: state.camera.v, depth }, { onProgress: opening ? showProgress : undefined });
  if (opening) hideProgress();
  if (!res || typeof res.alpha !== 'number') return;
  if (!opening && !(lastClick && lastClick.x === x && lastClick.y === y && $('focus').value === lastClick.value)) return;
  $('focus').value = res.alpha.toFixed(2);
  showSliderValue($('focus'));
  lastClick = { x, y, value: $('focus').value, again: depth && !res.final };
  if (opening && fNumber() > 4) {
    $('fstop').value = F_STOPS.indexOf(2.8);
    showFNumber();
  }
  cameraChanged({ final: true });
}

engine.onDepthReady = (msg) => {
  if (lastClick && (lastClick.again || (msg && msg.reapply))) {
    lastClick.again = false;
    applyFocusAt(lastClick.x, lastClick.y, false);
  }
};

// Only a short click on the picture sets the focus: not one that follows a
// drag (turning the viewpoint, panning) or a press held down for a while.
const CLICK_MAX_MS = 400;
const CLICK_MAX_MOVE = 4;
let pressed = null;
canvas.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  suppressClick = false;
  pressed = { x: event.clientX, y: event.clientY, t: performance.now(), moved: false };
}, true);
window.addEventListener('pointermove', (event) => {
  if (pressed && Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y) > CLICK_MAX_MOVE) pressed.moved = true;
}, true);
window.addEventListener('pointercancel', () => {
  pressed = null;
}, true);

canvas.addEventListener('click', (event) => {
  const press = pressed;
  pressed = null;
  if (cropState.editing) return;
  if (state.picking) {
    pickWhiteBalance(event);
    return;
  }
  if (suppressClick) {
    suppressClick = false;
    return;
  }
  if (press && (press.moved || performance.now() - press.t > CLICK_MAX_MS)) return;
  if (!state.info || state.mode !== 'camera' || state.depthShown) return;
  focusAt(event);
});

// Middle button drag pans the picture in any mode (instead of the browser's
// autoscroll).
canvas.addEventListener('pointerdown', (event) => {
  if (event.button !== 1 || !state.info) return;
  event.preventDefault();
  if (state.mode === 'lenslets') lensDrag(event);
  else startPan(event);
});
canvas.addEventListener('mousedown', (event) => {
  if (event.button === 1) event.preventDefault();
});

canvas.addEventListener('pointerdown', (event) => {
  if (!state.info || event.button !== 0 || state.picking || cropState.editing) return;
  if (state.mode === 'lenslets') {
    lensDrag(event);
    return;
  }
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
      // Moving the viewpoint keeps the depth map on screen (it does not change with the viewpoint).
      if (!state.depthShown) backToCamera();
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
    if (!state.depthShown) renderCamera();
  };
  canvas.onpointerup = () => {
    canvas.onpointermove = null;
    suppressClick = moved;
    if (moved) {
      autoKey();
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
  showViewpoint();
  if (final) autoKey();
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
// Normal or high quality depth: the depth map is measured again.
$('depth-hq').onchange = () => applySettingsSoon();
// The mix of the two depth measurements, shown for Blended only; the worker recombines without measuring again.
const showDepthBlend = (loaded = false) => {
  $('depth-blend-row').hidden = $('depth-style').value !== 'combined';
  showDepthModelControls(loaded);
};
// Each depth model keeps its own settings (Model blend, Model smoothing, Model curve): the sliders show the chosen method's, and every model's are kept together in the
// hidden `depth-model-params` (saved with the photo).
const DEPTH_MODEL_SLIDERS = { blend: 'depth-model-blend', smooth: 'depth-model-smooth', curve: 'depth-model-curve' };
let depthModelShown = null; // the method whose settings the sliders hold
function rememberDepthModel() {
  const all = readParams('depth-model-params');
  all[depthModelShown ?? $('depth-style').value] = Object.fromEntries(Object.entries(DEPTH_MODEL_SLIDERS).map(([k, id]) => [k, +$(id).value]));
  $('depth-model-params').value = JSON.stringify(all);
}
// `loaded`: the settings were just read from a photo's saved edits, so the sliders already hold the chosen method's values.
function showDepthModelControls(loaded = false) {
  const method = $('depth-style').value;
  const model = !!methodDepthModel(method);
  if (model && depthModelShown !== method) {
    const saved = readParams('depth-model-params')[method];
    if (!loaded || saved) {
      for (const [k, id] of Object.entries(DEPTH_MODEL_SLIDERS)) {
        $(id).value = saved && saved[k] !== undefined ? saved[k] : $(id).dataset.default;
        showSliderValue($(id));
      }
    }
  }
  depthModelShown = model ? method : null;
  for (const id of ['depth-model-blend-row', 'depth-model-smooth-row', 'depth-model-curve-row']) $(id).hidden = !model;
}
for (const id of Object.values(DEPTH_MODEL_SLIDERS)) {
  $(id).oninput = () => {
    showSliderValue($(id));
    rememberDepthModel();
    applySettingsSoon();
  };
  $(id).ondblclick = () => {
    $(id).value = $(id).dataset.default;
    showSliderValue($(id));
    rememberDepthModel();
    applySettingsSoon();
  };
}
$('depth-style').onchange = () => {
  if (depthModelShown) rememberDepthModel(); // the old model's settings, still in the sliders
  showDepthBlend();
  applySettingsSoon();
};
$('depth-blend').oninput = () => {
  showSliderValue($('depth-blend'));
  applySettingsSoon();
};
showDepthBlend();
// Object edges work on their own: with or without the high quality depth map.
const showObjectSoft = () => { $('depth-objects-soft-row').hidden = !$('depth-objects').checked; };
$('depth-objects').onchange = () => { showObjectSoft(); applySettingsSoon(); };
$('depth-objects-soft').oninput = () => {
  showSliderValue($('depth-objects-soft'));
  applySettingsSoon();
};
showObjectSoft();
$('lytro-depth').onchange = () => applySettingsSoon();

$('pivot-on').onchange = () => {
  $('pivot').disabled = !$('pivot-on').checked;
  // Its keyframes show only while it is on.
  clearSelection();
  renderTimeline();
  invalidateAnimation();
  geometryChanged();
};
$('pivot').oninput = () => {
  showSliderValue($('pivot'));
  if (state.lastImage) draw(state.lastImage);
};
$('pivot').onchange = () => {
  autoKey();
  invalidateAnimation();
  geometryChanged();
};

// Shape settings show for the shapes they change: blades for Blades, oval
// for Circle, rotation for both (a round circle has nothing to turn).
function showBokehShape() {
  const shape = $('bokeh').value;
  $('bokeh-blades-row').hidden = shape !== 'blades';
  $('bokeh-oval-row').hidden = shape !== 'circle';
  $('bokeh-rotation-row').hidden = shape !== 'blades' && shape !== 'circle';
  $('bokeh-onion-row').hidden = shape !== 'blades' && shape !== 'circle';
}

for (const id of ['fstop', 'bokeh', 'dof-depth', 'highlights', 'spread', 'spread-smooth', 'spread-blur', 'tilt', 'tilt-rotation', ...BOKEH_SHAPE]) {
  $(id).oninput = () => {
    if (id === 'bokeh') showBokehShape();
    showFNumber();
    showSliderValue($(id));
    cameraChanged({ final: false });
  };
  $(id).onchange = () => cameraChanged({ final: true });
}

// One tint at a time: Show spread and Show tilt switch each other off.
$('spread-show').onchange = () => {
  if ($('spread-show').checked) $('tilt-show').checked = false;
  updateSpreadOverlay();
};
$('tilt-show').onchange = () => {
  if ($('tilt-show').checked) $('spread-show').checked = false;
  updateSpreadOverlay();
};
$('tilt-on').onchange = () => {
  const off = !$('tilt-on').checked;
  for (const id of ['tilt', 'tilt-rotation', 'tilt-show']) $(id).disabled = off || $('tilt-on').disabled;
  // Its keyframes show only while it is on.
  clearSelection();
  renderTimeline();
  invalidateAnimation();
  cameraChanged({ final: true });
};

// ---------------------------------------------------------------- settings

// Settings window (gear at the right of the top bar).
async function showLibraryLocation() {
  await libReady;
  const kind = state.lib.store.kind;
  $('library-path').classList.toggle('mono', kind === 'folder');
  $('library-choose').hidden = kind !== 'folder';
  if (kind === 'folder') {
    $('library-path').textContent = await native.libraryDir();
  } else if (kind === 'browser') {
    $('library-path').textContent = 'This browser’s storage';
  } else {
    $('library-path').textContent = 'Not available';
  }
}

// A Lytro Desktop library (or any folder of photos), into a new album.
async function importFolder() {
  // Libraries are imported by the desktop app; the browser version points
  // there.
  if (!native) {
    showDesktopOnly();
    return;
  }
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
  const album = state.lib.albums.find((a) => a.name === albumName) || (await state.lib.createAlbum(albumName));
  // Photos imported before with the same names are replaced by these.
  const added = await importPhotos(entries, { album: album.id, replace: true });
  state.album = album.id;
  state.cameraView = false;
  showGrid(true);
  const withEdits = entries.filter((e) => e.sidecar).length;
  showNotice(`Added ${added.length} photo${added.length === 1 ? '' : 's'} from ${picked.name} to the album “${album.name}”.`,
    withEdits ? `${withEdits === 1 ? 'One carries' : `${withEdits} carry`} Lytro Desktop edits, applied when ${withEdits === 1 ? 'it is' : 'each is'} first opened.` : '');
  startNoticeTimer();
}

$('import-folder').onclick = importFolder;

// The browser version points to the desktop app for imports that need it.
const LIBRARY_ONLY = { title: $('desktop-only-title').textContent, text: $('desktop-only-text').textContent };
function showDesktopOnly(title = LIBRARY_ONLY.title, text = LIBRARY_ONLY.text) {
  $('desktop-only-title').textContent = title;
  $('desktop-only-text').textContent = text;
  $('desktop-only-hint').hidden = title !== LIBRARY_ONLY.title;
  $('desktop-only-dialog').showModal();
}

// ---- camera calibration

const lensSource = () => {
  try {
    return localStorage.getItem('illuminator.lensSource') === 'measured' ? 'measured' : 'calibration';
  } catch {
    return 'calibration';
  }
};

// Kept calibration goes to the render worker, keyed by camera serial number.
async function sendCalibrations() {
  await libReady;
  const kept = await listCalibrations(state.lib.store).catch(() => []);
  const list = [];
  for (const k of kept) list.push(await loadCalibration(state.lib.store, k.serial).catch(() => null));
  await engine.request('setCalibrations', { list: list.filter(Boolean), useWhites: lensSource() === 'calibration' });
  return kept;
}

async function showCalibrations() {
  const kept = await sendCalibrations();
  const ul = $('cal-list');
  ul.replaceChildren();
  for (const k of kept) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.textContent = `Camera ${k.serial}${k.hotPixels ? ' · hot pixel list' : ''}${k.whites && k.whites.length ? ` · ${k.whites.length} white images` : ''}`;
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'link';
    del.textContent = 'Remove';
    del.onclick = async () => {
      await removeCalibration(state.lib.store, k.serial);
      $('cal-note').textContent = `Removed the calibration for camera ${k.serial}.`;
      showCalibrations();
    };
    li.append(name, del);
    ul.append(li);
  }
  if (!kept.length) $('cal-note').textContent ||= 'No camera calibration added yet.';
}

async function addCalibration(source) {
  if (!source) return;
  await libReady;
  $('cal-note').textContent = 'Reading calibration data…';
  try {
    const info = await importCalibration(source, state.lib.store, {
      onProgress: (p, name) => { $('cal-note').textContent = `Reading ${name}…`; },
      // The white images are measured in the render worker.
      measure: (bytes, meta) => engine.request('measureWhite', { bytes: bytes.buffer, meta }, { transfer: [bytes.buffer] }),
    });
    $('cal-note').textContent = `Added camera ${info.serial}: ${info.saved} files kept` +
      (info.hotPixels ? `, its hot pixel list` : '') +
      (info.whites.length ? ` and ${info.whites.length} white images` : '') +
      '. Photos from this camera use it the next time they are opened.';
    await showCalibrations();
  } catch (err) {
    $('cal-note').textContent = err.message || String(err);
  }
}

const CALIBRATION_ONLY = ['Add camera calibration', 'Adding camera calibration data needs the Illuminator desktop app, for Windows, macOS and Linux. Backups are over a gigabyte, so the desktop app reads them on your computer and keeps the calibration in your library.'];
$('cal-lens-source').value = lensSource();
$('cal-lens-source').onchange = () => {
  try {
    localStorage.setItem('illuminator.lensSource', $('cal-lens-source').value);
  } catch {
    // Not remembered.
  }
  sendCalibrations();
};
$('cal-add').onclick = async () => (!native ? showDesktopOnly(...CALIBRATION_ONLY) : addCalibration(await openCalibrationFile().catch(() => null)));
$('cal-folder').onclick = async () => {
  if (!native) return showDesktopOnly(...CALIBRATION_ONLY);
  const picked = await pickFolder('Choose the camera’s calibration folder', { calibration: true }).catch(() => null);
  if (picked && picked.files.length) addCalibration(picked.files.map((f) => ({ path: f.path, file: f.file })));
};

// Settings > Upscaling models: a checkbox per optional model (core/upscalemodels.js). Ticking downloads it, unticking deletes it; a downloaded model appears in Render Settings >
// Upscaling > Method. They need a graphics card with WebGPU.
let modelBusy = false;
const updatingModels = new Set();
// Depth models (Settings > Depth models): a downloaded model is a choice under Camera > Depth > Depth method.
let depthModelBusy = false;
async function refreshDepthModels() {
  const select = $('depth-style');
  const before = select.value;
  const list = $('depth-models-list');
  if (!list.children.length) {
    for (const m of DEPTH_MODELS) {
      const row = document.createElement('label');
      row.className = 'check model-row';
      const box = Object.assign(document.createElement('input'), { type: 'checkbox' });
      box.dataset.model = m.id;
      const text = document.createElement('span');
      text.textContent = `${m.name}, ${m.note} (${Math.round(m.size / 1e6)} MB)`;
      const status = Object.assign(document.createElement('span'), { className: 'hint model-state' });
      row.append(box, text, status);
      list.append(row);
      box.onchange = async () => {
        if (depthModelBusy) {
          box.checked = !box.checked;
          return;
        }
        depthModelBusy = true;
        box.disabled = true;
        try {
          if (box.checked) {
            status.textContent = 'Downloading… 0%';
            await downloadDepthModel(m, (p) => { status.textContent = `Downloading… ${Math.round(p * 100)}%`; });
          } else {
            await removeDepthModel(m);
          }
          status.textContent = '';
        } catch (err) {
          box.checked = false;
          status.textContent = err && err.message ? err.message : String(err);
        }
        depthModelBusy = false;
        await refreshDepthModels();
      };
    }
  }
  for (const m of DEPTH_MODELS) {
    const have = (await depthModelState(m)) === 'ready';
    const box = list.querySelector(`input[data-model="${m.id}"]`);
    box.checked = have;
    box.disabled = false;
    const value = depthModelMethod(m.id);
    const option = [...select.options].find((o) => o.value === value);
    if (have && !option) select.append(new Option(`${m.name} (model)`, value));
    else if (!have && option) option.remove();
  }
  // a model that was the method and is gone: back to Automatic
  if (before && ![...select.options].some((o) => o.value === before)) {
    select.value = 'auto';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  } else if (before) {
    select.value = before;
  }
  showDepthBlend();
}
refreshDepthModels().catch(() => {});

async function refreshUpscaleModels() {
  const select = $('upscale-method');
  const before = select.value;
  const gpuOk = await aiUpscaleAvailable();
  const list = $('models-list');
  if (!list.children.length) {
    for (const m of UPSCALE_MODELS) {
      const row = document.createElement('label');
      row.className = 'check model-row';
      const box = Object.assign(document.createElement('input'), { type: 'checkbox' });
      box.dataset.model = m.id;
      const text = document.createElement('span');
      text.textContent = `${m.name}, ${m.note} (${Math.round(m.size / 1e6)} MB)`;
      const status = Object.assign(document.createElement('span'), { className: 'hint model-state' });
      row.append(box, text, status);
      list.append(row);
      box.onchange = async () => {
        if (modelBusy) {
          box.checked = !box.checked;
          return;
        }
        modelBusy = true;
        box.disabled = true;
        try {
          if (box.checked) {
            status.textContent = 'Downloading… 0%';
            await downloadModel(m, (p) => { status.textContent = `Downloading… ${Math.round(p * 100)}%`; });
          } else {
            await removeModel(m);
          }
          status.textContent = '';
        } catch (err) {
          box.checked = false;
          status.textContent = err && err.message ? err.message : String(err);
        }
        modelBusy = false;
        await refreshUpscaleModels();
      };
    }
  }
  for (const m of UPSCALE_MODELS) {
    const state = await modelState(m);
    const have = state === 'ready';
    const box = list.querySelector(`input[data-model="${m.id}"]`);
    // a model replaced in the repository since it was downloaded: the new one is fetched again by itself (it was chosen once already)
    if (state === 'stale' && !modelBusy && !updatingModels.has(m.id)) {
      updatingModels.add(m.id);
      const status = box.parentElement.querySelector('.model-state');
      status.textContent = 'Updating…';
      downloadModel(m, (p) => { status.textContent = `Updating… ${Math.round(p * 100)}%`; })
        .then(() => { status.textContent = ''; }, (err) => { status.textContent = err && err.message ? err.message : String(err); })
        .finally(() => { updatingModels.delete(m.id); refreshUpscaleModels().catch(() => {}); });
    }
    box.checked = have || state === 'stale';
    box.disabled = !gpuOk && !have;
    box.title = gpuOk ? '' : 'Needs a graphics card with WebGPU';
    const value = modelMethod(m.id);
    const option = [...select.options].find((o) => o.value === value);
    if (have && !option) select.append(new Option(`${m.name} (${m.note})`, value));
    else if (!have && option) option.remove();
  }
  // a model that was the method and is gone: back to Lanczos
  if (before && ![...select.options].some((o) => o.value === before)) {
    select.value = 'lanczos';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  } else if (before) {
    select.value = before;
  }
  showUpscaleControls();
}
refreshUpscaleModels().catch(() => {});

// Settings > Memory (the desktop app): the most RAM and video memory the app may plan to use, from 1 GB up to what the computer has less what the system keeps (4 GB of RAM, 512 MB of video memory). At the top
// of the range (the start) there is no limit of the app's own. The limits size the heavy steps (a full sensor render, a 16-bit export, an upscaling model; core/memorybudget.js)
// and, when the app starts, cap its JavaScript heap and the video memory Chromium plans for (electron/main.cjs).
const GIB = 1024 ** 3;
async function setupMemorySettings() {
  if (!native || !native.systemMemory) return;
  const sys = await native.systemMemory();
  const top = (bytes, reserve) => Math.max(1, Math.floor(((bytes - reserve) / GIB) * 2) / 2);
  const rows = [
    { key: 'ramGb', input: $('mem-ram'), out: $('mem-ram-out'), max: top(sys.ramBytes, sys.ramReserveBytes), title: `This computer has ${(sys.ramBytes / GIB).toFixed(1)} GB of RAM; 4 GB are left for the system. Applies when the app starts.` },
    { key: 'vramGb', input: $('mem-vram'), out: $('mem-vram-out'), max: top(sys.vramBytes, sys.vramReserveBytes), title: `Video memory found: ${(sys.vramBytes / GIB).toFixed(1)} GB (${sys.vramSource}); 512 MB are left for the system. Applies when the app starts.` },
  ];
  const apply = (save) => {
    const gb = Object.fromEntries(rows.map((r) => [r.key, +r.input.value]));
    setMemoryLimits({ ramBytes: gb.ramGb * GIB, vramBytes: gb.vramGb * GIB });
    engine.request('memoryLimits', { ramBytes: gb.ramGb * GIB, vramBytes: gb.vramGb * GIB }).catch(() => {});
    // at the top of a range: no limit kept, so more memory in the computer later raises it by itself
    if (save) native.setMemoryLimits(Object.fromEntries(rows.map((r) => [r.key, gb[r.key] >= r.max ? null : gb[r.key]]))).catch(() => {});
  };
  for (const r of rows) {
    const saved = sys.limits && sys.limits[r.key];
    r.input.max = r.max;
    r.input.min = Math.min(1, r.max);
    r.input.value = saved ? Math.min(saved, r.max) : r.max;
    r.input.disabled = r.max <= 1;
    r.input.title = r.title;
    r.out.textContent = `${r.input.value} GB`;
    r.input.oninput = () => {
      r.out.textContent = `${r.input.value} GB`;
      apply(false);
    };
    r.input.onchange = () => apply(true);
  }
  $('memory-setting').hidden = false;
  apply(false);
}
setupMemorySettings().catch((err) => console.warn('Could not read the computer\'s memory', err));

// Settings > Check for updates on startup (the desktop app; Help > Check for Updates works whatever it says).
$('updates-setting').hidden = !native;
$('check-updates').checked = updateCheckOn();
$('check-updates').onchange = () => {
  try {
    localStorage.setItem('illuminator.checkUpdates', $('check-updates').checked ? '1' : '0');
  } catch {
    // Not remembered.
  }
};

$('settings-btn').onclick = async () => {
  await showLibraryLocation();
  $('cal-note').textContent = '';
  showCalibrations();
  $('settings-btn').setAttribute('aria-expanded', 'true');
  $('settings-dialog').showModal();
};
$('settings-dialog').addEventListener('close', () => $('settings-btn').setAttribute('aria-expanded', 'false'));

// The About window shows the top bar's logo.
$('about-title').prepend(document.querySelector('.toolbar h1 .logo').cloneNode(true));

// Full screen: the whole app fills the screen (the desktop app's window too).
function showFullscreen() {
  const on = !!document.fullscreenElement;
  const b = $('fullscreen-btn');
  b.setAttribute('aria-pressed', String(on));
  b.title = on ? 'Exit full screen' : 'Full screen';
  b.setAttribute('aria-label', b.title);
  b.querySelector('.fs-enter').hidden = on;
  b.querySelector('.fs-exit').hidden = !on;
}
$('fullscreen-btn').hidden = !document.fullscreenEnabled;
$('fullscreen-btn').onclick = () => {
  const done = document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen();
  Promise.resolve(done).catch(() => {});
};
document.addEventListener('fullscreenchange', showFullscreen);

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
  state.cameraView = false;
  libReady = openLibrary();
  calReady = libReady.then(() => sendCalibrations()).catch(() => {});
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
// `depth`: an animation's Pivot depth for this frame, or null for the
// slider's. Either is used only with Custom pivot on.
function pivotFor(u, v, alpha, aperture, depth = null) {
  const keyed = Number.isFinite(depth);
  if (!$('pivot-on').checked || !state.info || !state.info.hasRaw || state.depthShown) return null;
  const pivot = 1.6 * (keyed ? depth : +$('pivot').value) / 100;
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
  // A still rendered from an animation frame keeps that frame's framing.
  if (state.fullRes && state.stillFrame && state.framePivots) return state.framePivots[state.stillIndex] || null;
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

// Draws `img` through `g` into a 2D context (scaled by `k`), on black (or,
// with `fill` false, on transparency: overlays).
function drawGeometry(c2d, img, g, k = 1, fill = true) {
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
  if (fill) {
    c2d.fillStyle = '#000';
    c2d.fillRect(0, 0, c2d.canvas.width, c2d.canvas.height);
  } else {
    c2d.clearRect(0, 0, c2d.canvas.width, c2d.canvas.height);
  }
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
  let fx = (event.clientX - rect.left) / rect.width;
  const fy = (event.clientY - rect.top) / rect.height;
  // Side by side: either half points at the same place.
  if (state.lastImage && state.lastImage.pair) fx = (fx * 2) % 1;
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
  // Wide ratios on a portrait frame (and tall ones on a landscape frame)
  // turn with it: 3 : 2 on a portrait picture is 2 : 3.
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
$('flip-v').onclick = () => {
  if (!canRender()) return;
  $('orientation').value = flipVerticalOrientation(+$('orientation').value || 1);
  const flip = (c) => ({ ...c, y: 1 - c.y - c.h });
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

// color matrix: ui/colormatrix.js
const { showColorMatrix } = initColorMatrix({ $, state, applySettings: (...a) => applySettings(...a), applySettingsSoon: (...a) => applySettingsSoon(...a) });

// local adjustments: ui/localadjust.js
const { getMasks, setMasks, maskLabel, TRASH_ICON, renderMasks, localSettings } = initLocalAdjustments({ $, applySettingsSoon: (...a) => applySettingsSoon(...a), scheduleSave: (...a) => scheduleSave(...a), state, clearSelection: (...a) => clearSelection(...a), saveAnimation: (...a) => saveAnimation(...a), renderTimeline: (...a) => renderTimeline(...a), showMenu: (...a) => showMenu(...a), confirmInMenu: (...a) => confirmInMenu(...a), editName: (...a) => editName(...a), canRender: (...a) => canRender(...a), showSliderValue: (...a) => showSliderValue(...a), updateKeyButtons: (...a) => updateKeyButtons(...a), autoKey: (...a) => autoKey(...a) });

// keyframes: ui/keyframes.js
const { MASK_LIMITS, parseMaskTrack, trackGroups, tracks, KEY_CONTROLS, settingControl, updateKeyButtons, groupCollapsed, shownTracks, groupHidden, trackName, tlSel, tlCurves, keyframesOn, animLength, loadAnimation, saveAnimation, liveFraming, combineMotion, showValue, previewAt, autoKey, playheadTime, clearSelection, selectKey, selectedKeys, moveKeys, selectedKey, viewWindow, tickStep, updatePlayhead, groupHeading, renderTimeline, timeAt, seekTimeline, seekTo, showAnimationLength, keyframeFrames } = initKeyframes({ $, getMasks, maskLabel, state, canRender: (...a) => canRender(...a), F_STOPS, scheduleSave: (...a) => scheduleSave(...a), invalidateAnimation: (...a) => invalidateAnimation(...a), backToCamera: (...a) => backToCamera(...a), renderCamera: (...a) => renderCamera(...a), showSliderValue: (...a) => showSliderValue(...a), setMasks, renderMasks, showFNumber: (...a) => showFNumber(...a), showFocusPoint: (...a) => showFocusPoint(...a), applySettingsSoon: (...a) => applySettingsSoon(...a), cameraChanged: (...a) => cameraChanged(...a), layoutCanvas: (...a) => layoutCanvas(...a), drawCurves: (...a) => drawCurves(...a), setPlaying: (...a) => setPlaying(...a), showFrame: (...a) => showFrame(...a), updateFrameLabel: (...a) => updateFrameLabel(...a), plotBox: (...a) => plotBox(...a), animationSettingsChanged: (...a) => animationSettingsChanged(...a), draw: (...a) => draw(...a), apertureFor: (...a) => apertureFor(...a), view, bokehParams: (...a) => bokehParams(...a), colorSettings: (...a) => colorSettings(...a) });

// curves view: ui/curvesview.js
const { plotBox, drawCurves } = initCurvesView({ trackGroups, shownTracks, trackName, $, state, settingControl, MASK_LIMITS, parseMaskTrack, F_STOPS, groupHeading, groupCollapsed, tlCurves, viewWindow, tickStep, selectedKey, groupHidden, animLength, tlSel, playheadTime, renderTimeline, saveAnimation, tracks, layoutCanvas: (...a) => layoutCanvas(...a), seekTimeline, selectedKeys, selectKey, moveKeys, timeAt, showValue, clearSelection, seekTo, scheduleSave: (...a) => scheduleSave(...a) });

// frame rate: ui/framerate.js
const { showFrameRate } = initFrameRate({ $, state, scheduleSave: (...a) => scheduleSave(...a), animationSettingsChanged: (...a) => animationSettingsChanged(...a), showAnimationLength: (...a) => showAnimationLength(...a), renderTimeline: (...a) => renderTimeline(...a), updateFrameLabel: (...a) => updateFrameLabel(...a) });

// 3D: ui/stereo.js
const { stereoShown, eyeOffset, eyeParams, stereoPreview, stereoTag } = initStereo({ $, state, engine, showProgress: (...a) => showProgress(...a), backToCamera: (...a) => backToCamera(...a), setFullRes: (...a) => setFullRes(...a), refresh: (...a) => refresh(...a), cameraParams: (...a) => cameraParams(...a), withPivotZoom: (...a) => withPivotZoom(...a), pivotFor: (...a) => pivotFor(...a), cropValues: (...a) => cropValues(...a), drawGeometry: (...a) => drawGeometry(...a), canRender: (...a) => canRender(...a), savePhoto: (...a) => savePhoto(...a), baseName: (...a) => baseName(...a), showError: (...a) => showError(...a), hideProgress: (...a) => hideProgress(...a), showSliderValue: (...a) => showSliderValue(...a) });

// living filters: ui/livingfilters.js
const { livingFilter } = initLivingFilters({ $, state, canRender: (...a) => canRender(...a), getMasks, showNotice: (...a) => showNotice(...a), startNoticeTimer: (...a) => startNoticeTimer(...a), setMasks, renderMasks, renderTimeline: (...a) => renderTimeline(...a) });

// number fields: ui/numberfields.js
initNumberFields();

// tone curve: ui/tonecurve.js
const { curve } = initToneCurve({ $, applySettingsSoon: (...a) => applySettingsSoon(...a), scheduleSave: (...a) => scheduleSave(...a), showSliderValue: (...a) => showSliderValue(...a) });

// white balance eyedropper: ui/whitebalance.js
const { setPicking, pickWhiteBalance } = initWhiteBalancePicker({ state, canRender: (...a) => canRender(...a), $, canvas, viewPoint: (...a) => viewPoint(...a), engine, showSliderValue: (...a) => showSliderValue(...a), applySettings: (...a) => applySettings(...a), scheduleSave: (...a) => scheduleSave(...a), showError: (...a) => showError(...a) });

// export: ui/export.js
const { baseName, shownScale, showAtPhotoSize, savePhoto, showPhotoFormat, savePng, showVideoCodecs, readParams, showUpscaleControls, frameList, exportVideo } = initExport({ state, $, canvas, ctx, layoutCanvas: (...a) => layoutCanvas(...a), showsCamera: (...a) => showsCamera(...a), stereoShown, showNotice: (...a) => showNotice(...a), engine, cameraParams: (...a) => cameraParams(...a), showProgress: (...a) => showProgress(...a), hideProgress: (...a) => hideProgress(...a), modelUpscaleParams: (...a) => modelUpscaleParams(...a), finishModelEnlargement: (...a) => finishModelEnlargement(...a), showError: (...a) => showError(...a), showSliderValue: (...a) => showSliderValue(...a), scheduleSave: (...a) => scheduleSave(...a), draw: (...a) => draw(...a), cropValues: (...a) => cropValues(...a), animationRequest: (...a) => animationRequest(...a), eyeOffset, eyeParams, ensureAnimation: (...a) => ensureAnimation(...a), drawGeometry: (...a) => drawGeometry(...a), stereoTag });

// camera import: ui/cameraimport.js
const { showCameraDialog, openWebUsbCamera, importFromCameraFolder, importFromConnectedCamera } = initCameraImport({ $, state, setCameraSection: (...a) => setCameraSection(...a), showError: (...a) => showError(...a), webCameraLabel: (...a) => webCameraLabel(...a), importCameraFiles: (...a) => importCameraFiles(...a), openItem: (...a) => openItem(...a) });

// camera section: ui/camerasection.js
const { setCameraSection, renderCameraSection, renderCameraGrid, importCameraFiles, webCameraLabel, showWebCamera, importFromCamera } = initCameraSection({ state, cameraThumbs, renderLibrary: (...a) => renderLibrary(...a), $, showGrid: (...a) => showGrid(...a), openItem: (...a) => openItem(...a), showProgress: (...a) => showProgress(...a), showError: (...a) => showError(...a), hideProgress: (...a) => hideProgress(...a), importPhotos: (...a) => importPhotos(...a), importFromConnectedCamera, importFromCameraFolder, showCameraDialog });

// ---------------------------------------------------------------- wiring

// An album as an archive (library/archive.js), to add to another library:
// the browser version's to the desktop app's, say.
async function exportAlbum(id) {
  const album = state.lib.album(id);
  if (!album) return;
  if (!album.photos.length) {
    showNotice(`“${album.name}” has no photos to export.`);
    startNoticeTimer();
    return;
  }
  try {
    showProgress(`Exporting “${album.name}”`, 0);
    const blob = await state.lib.exportAlbum(id, { onProgress: (p) => showProgress(`Exporting “${album.name}”`, p) });
    download(blob, `${album.name.replace(/[\\/:*?"<>|]+/g, '_') || 'Album'}${ARCHIVE_SUFFIX}`);
  } catch (err) {
    showError(err);
  } finally {
    hideProgress();
  }
}

// An exported album: its photos join the library and the album is made
// again (or joined, if one has its name).
async function importAlbumArchive(file) {
  await libReady;
  try {
    const { album, photos } = await state.lib.importAlbum(file, {
      onProgress: (e, i, n) => {
        if (e) showProgress(`Importing ${e.name} (${i + 1} of ${n})`, i / n);
      },
    });
    state.album = album.id;
    state.cameraView = false;
    showNotice(`Imported the album “${album.name}”: ${photos.length} photo${photos.length === 1 ? '' : 's'}.`);
    startNoticeTimer();
  } catch (err) {
    showError(err);
  } finally {
    hideProgress();
    renderLibrary();
  }
}

// Picked or dropped files are added to the library; Lytro Desktop edits
// picked with a photo go with it (scan.js). Album archives are imported as
// albums.
async function openPicked(files) {
  for (const f of files.filter((f) => /\.zip$/i.test(f.name))) await importAlbumArchive(f);
  const entries = groupPhotos(files.filter((f) => isLightFieldName(f.name)).map((f) => ({ path: f.name, file: f })));
  const added = await importPhotos(entries);
  if (added.length) openItem(added[0]);
}

$('open-btn').onclick = async () => openPicked(await openFiles());
$('library-import').onclick = () => importFolder();
// Commands from the desktop app's menu bar.
let checkForUpdateNow = () => {};
if (native && native.onMenu) {
  native.onMenu((id) => {
    if (id === 'undo' || id === 'redo') {
      // The key itself may already have been handled in the page.
      if (performance.now() - lastHistoryKey < 300) return;
      if (typing(document.activeElement)) document.execCommand(id);
      else if (id === 'undo') undo();
      else redo();
    } else if (id === 'open') $('open-btn').click();
    else if (id === 'import-library') importFolder();
    else if (id === 'about') $('about-btn').click();
    else if (id === 'check-update') checkForUpdateNow();
  });
}
$('camera-btn').onclick = importFromCamera;
$('sample-btn').onclick = () => {
  state.current = null;
  state.wantThumb = false;
  renderLibrary();
  openWith({ synthetic: { width: 3864, height: 2684 } });
};
$('play-btn').onclick = () => setPlaying(true);
$('pause-btn').onclick = () => setPlaying(false);
// Stop: pause and go back to the start.
$('stop-btn').onclick = () => {
  setPlaying(false);
  state.index = 0;
  state.direction = 1;
  state.keyTime = 0;
  if (state.frames.length && state.showingFrames) showFrame(0);
  else if (keyframesOn()) previewAt(0);
  renderTimeline();
  updateFrameLabel();
};
$('loop-btn').onclick = () => {
  state.repeat = !state.repeat;
  showLoop();
};

const icon = (d) => `<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="${d}"/></svg>`;
$('stop-btn').innerHTML = icon('M3.5 3.5h9v9h-9z');
$('pause-btn').innerHTML = icon('M3.5 2.5h3v11h-3zM9.5 2.5h3v11h-3z');
$('play-btn').innerHTML = icon('M4 2.5v11l9.5-5.5z');
$('loop-btn').innerHTML = '<svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 9V7.5a3 3 0 0 1 3-3h8M11 2l2.5 2.5L11 7"/><path d="M13.5 7v1.5a3 3 0 0 1-3 3h-8M5 14l-2.5-2.5L5 9"/></g></svg>';

// The play button lights up while playing.
function showPlayIcon(playing) {
  $('play-btn').classList.toggle('active', playing);
  $('pause-btn').classList.toggle('active', !playing && state.showingFrames && state.frames.length > 0);
}

function showLoop() {
  $('loop-btn').classList.toggle('active', state.repeat);
  $('loop-btn').setAttribute('aria-pressed', String(state.repeat));
}
showPlayIcon(false);
showLoop();
// Dragging the play bar's slider moves the playhead: a rendered frame
// where there is one, the animation's settings there until then.
$('scrub').oninput = () => {
  setFullRes(false, { restore: false });
  setDepthShown(false, { restore: false });
  state.playing = false;
  showPlayIcon(false);
  if (!state.frames.length) ensureAnimation();
  seekTo(+$('scrub').value / state.fps);
};
$('png-btn').onclick = savePng;
$('webm-btn').onclick = exportVideo;

// Quick export (top bar): the Photo and Video settings of Render Settings
// in a popup. Each field mirrors its sidebar control: read when shown, and
// a change is made on the sidebar control (so it is saved and undoable like
// any setting), then everything is read back (the video format limits the
// compressions offered).
const QUICK_EXPORT = ['stereo-on', 'stereo-mode', 'stereo-baseline', 'depth-hq', 'detail', 'fullres-on', 'still-scale', 'still-passes',
  'upscale-method', 'upscale-sharpen', 'photo-size', 'photo-format', 'photo-quality', 'video-size', 'video-codec', 'video-format', 'video-quality'];
const QUICK_ROWS = ['stereo-on-row', 'depth-hq-row', 'fullres-panel', 'photo-quality-row'];
const QUICK_BUTTONS = { 'qe-stereo-btn': 'stereo-btn', 'qe-render-btn': 'render-btn', 'qe-photo-btn': 'png-btn', 'qe-video-btn': 'webm-btn' };
function showQuickExport() {
  for (const id of QUICK_EXPORT) {
    const src = $(id);
    const el = $(`qe-${id}`);
    if (src.type === 'checkbox') el.checked = src.checked;
    else {
      if (src.tagName === 'SELECT') el.innerHTML = src.innerHTML;
      else for (const a of ['min', 'max', 'step']) el[a] = src[a];
      el.value = src.value;
    }
    el.disabled = src.disabled;
    const out = document.querySelector(`output[data-for="qe-${id}"]`);
    const shown = document.querySelector(`output[data-for="${id}"]`);
    if (out && shown) out.textContent = shown.textContent;
  }
  for (const id of QUICK_ROWS) $(`qe-${id}`).hidden = $(id).hidden;
  for (const [id, src] of Object.entries(QUICK_BUTTONS)) {
    $(id).textContent = $(src).textContent;
    $(id).disabled = $(src).disabled;
  }
  $('qe-video-btn').title = $('webm-btn').disabled ? 'Turn on Animation (in the Camera view) to export a video' : '';
}
for (const id of QUICK_EXPORT) {
  const el = $(`qe-${id}`);
  const copy = (type) => {
    if (el.type === 'checkbox') $(id).checked = el.checked;
    else $(id).value = el.value;
    $(id).dispatchEvent(new Event(type, { bubbles: true }));
    if (type === 'input' && el.type === 'range') showSliderValue($(id));
    showQuickExport();
  };
  el.addEventListener('input', () => copy('input'));
  el.addEventListener('change', () => copy('change'));
}
for (const [id, src] of Object.entries(QUICK_BUTTONS)) {
  $(id).onclick = () => {
    // Render keeps the popup open, to save the still once it is ready.
    if (id !== 'qe-render-btn') $('quick-export-dialog').close();
    $(src).click();
    showQuickExport();
  };
}
// Photo or Video: only the settings that kind of export uses.
function showQuickExportKind() {
  const kind = $('qe-kind').value;
  for (const el of document.querySelectorAll('#quick-export-dialog [data-qe]')) el.hidden = el.dataset.qe !== kind;
}
$('qe-kind').onchange = showQuickExportKind;
$('quick-export-btn').onclick = () => {
  showQuickExportKind();
  showQuickExport();
  $('quick-export-dialog').showModal();
};
$('fullres-on').onchange = () => setFullResMode($('fullres-on').checked);
$('render-btn').onclick = renderFullRes;
$('depth-btn').onchange = () => setDepthShown($('depth-btn').checked);
$('still-scale').onchange = () => setFullRes(false);
$('lens-centres').onchange = () => {
  applySettingsSoon();
  setFullRes(false);
};
$('still-scale').addEventListener('change', showPhotoSizes);
// The lattice filter's controls (under Scale, in the Full sensor panel, so shown with Full sensor on); changing one is a new render.
for (const id of ['lattice-on', 'lattice-strength', 'lattice-detect']) {
  $(id).addEventListener('input', () => {
    if ($(id).type === 'range') showSliderValue($(id));
    applySettingsSoon();
    setFullRes(false);
  });
}
for (const id of ['lattice-strength', 'lattice-detect']) {
  $(id).ondblclick = () => {
    $(id).value = $(id).dataset.default;
    showSliderValue($(id));
    applySettingsSoon();
    setFullRes(false);
  };
}
$('still-passes').onchange = () => {
  setFullRes(false);
  if (!state.fullRes) refresh();
};
$('grid-auto').onclick = () => updateGrid({ mode: 'auto' });
$('grid-meta').onclick = () => updateGrid({ mode: 'metadata' });
$('lens-circles').onchange = () => renderLenslets();
$('still-scale').addEventListener('change', () => renderLenslets());

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
for (const id of ['anim', 'path', 'frames', 'steps']) $(id).onchange = animationSettingsChanged;
// Amount, Near and Far can be keyframed (Auto key records them).
// Auto key for Process and Optics sliders.
$('controls').addEventListener('change', (e) => {
  const k = KEY_CONTROLS[e.target.id] && KEY_CONTROLS[e.target.id][0];
  if (k && isSettingTrack(k)) autoKey();
});
for (const id of ['amount', 'near', 'far']) {
  $(id).onchange = () => {
    autoKey();
    animationSettingsChanged();
  };
}

// Animation > Enabled: playing, scrubbing and video export.
function showAnimationEnabled() {
  const on = $('anim-on').checked;
  $('anim-controls').disabled = !on;
  const camera = state.mode === 'camera';
  for (const id of ['stop-btn', 'pause-btn', 'play-btn', 'loop-btn', 'webm-btn', 'scrub']) $(id).disabled = !state.info || !camera || !on;
  // The keyframe controls in the sidebar show only while animation is enabled.
  updateKeyButtons();
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
  updateKeyButtons();
  renderTimeline();
  if (state.lastImage) draw(state.lastImage);
};

// The settings the color pass applies (Process and Optics), each slider read through `val(id)`: its value, or an animation frame's keyframed one (core: settingsmap.js).
function colorSettings(val = (id) => +$(id).value) {
  return buildColorSettings({ el: $, num: val });
}

async function applySettings() {
  await sendLut();
  const settings = buildRenderSettings({ el: $, num: (id) => +$(id).value }, localSettings());
  setHook('appliedSettings', settings); // for tests: what the page sends the engine
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
  // Which sliders can be used decides which of their tracks show.
  renderTimeline();
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
let saveTimer = 0;

function photoKey(info) {
  if (info && info.photoId) return info.photoId;
  const cur = state.current;
  return cur ? `file:${cur.name}:${cur.file.size}` : null;
}

// Reset settings (a photo's ••• menu): its edits are replaced by a reset
// mark, so it opens as a new photo does, without Lytro Desktop's edits; an
// open photo starts over at once.
async function resetPhotoSettings(photo) {
  clearTimeout(saveTimer);
  await state.lib.saveEdits(photo, { format: EDITS_FORMAT, version: EDITS_VERSION, reset: true, photo: { id: photo.id, name: photo.name } });
  if (state.current && state.current.photo === photo && state.info) {
    if (state.playing) setPlaying(false);
    await restoreEdits(state.info);
    renderInfo();
  }
}

async function restoreEdits(info) {
  clearTimeout(saveTimer);
  state.editsKey = photoKey(info);
  const photo = state.current && state.current.photo;
  // Library photos keep their edits in their folder; earlier versions kept
  // them in the app's storage, which is still read for those photos.
  let saved = photo ? await state.lib.loadEdits(photo) : null;
  if (!saved && state.editsKey) saved = await editsStore.load(state.editsKey);
  const reset = !!(saved && saved.reset);
  if (reset) saved = null;
  else if (!saved) saved = await lytroEdits(info, state.current);
  await applyEdits(info, saved);
  resetHistory();
}

// Sets every control from an edits document (null: the defaults) and
// renders the result.
async function applyEdits(info, saved) {
  state.restoring = true;
  try {
    const { view, focusPoint } = writeEdits(document, saved, DEFAULT_EDITS);
    // Tilt is off by default; edits saved before it could be turned off keep
    // the tilt they had.
    const cam = saved && saved.camera;
    if (cam && !('tilt-on' in cam) && +cam.tilt) $('tilt-on').checked = true;
    // Hexagon became Blades (six of them by default).
    if (cam && cam.bokeh === 'hexagon') $('bokeh').value = 'blades';
    showBokehShape();
    for (const id of ['tilt', 'tilt-rotation', 'tilt-show']) $(id).disabled = !$('tilt-on').checked || $('tilt-on').disabled;
    $('pivot').disabled = !$('pivot-on').checked;
    curve.draw();
    showColorMatrix();
    $('flare-amount').disabled = !$('flare-on').checked;
    state.customFps = false;
    showFrameRate();
    showAnimationEnabled();
    showVideoCodecs();
    showPhotoFormat();
    state.upscaleShown = null;
    showUpscaleControls(true);
    showObjectSoft();
    depthModelShown = null;
    showDepthBlend(true);
    state.maskSel = getMasks().length ? 0 : -1;
    $('mask-show').checked = false;
    renderMasks();
    resetTemperature(info, { keep: !!saved });
    state.camera = { ...view };
    state.focusPoint = { ...focusPoint };
    // Lytro Desktop's living filter: ours like it, around the focus.
    if (saved && saved.lytroFilter) {
      const opt = [...$('mask-filter').options].find((o) => o.value === saved.lytroFilter);
      const added = livingFilter(saved.lytroFilter).map((m) => ({ ...m, name: opt ? opt.textContent.trim() : '' }));
      const masks = [...getMasks(), ...added].slice(0, MAX_MASKS);
      $('local-masks').value = JSON.stringify(masks);
      state.maskSel = masks.length ? 0 : -1;
      renderMasks();
    }
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
  // Full sensor is a mode (the panel, the Render button, Auto render), not just a value.
  setFullResMode($('fullres-on').checked);
}

// The edits Lytro Desktop saved for a photo (in its stack.view.lfp, or in
// the file itself), as Illuminator edits, or null. Used for photos that have
// no Illuminator edits yet; they are saved as ours once changed.
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
    delete edits.local;
    delete edits.lytroFilter;
  }
  state.notice = ['Applied this photo\u2019s edits from Lytro Desktop.', unsupported.length ? `Not supported yet: ${unsupported.join(', ')}.` : ''];
  return edits;
}

// A note over the picture; it goes away by itself a while after the picture
// first shows.
let noticeTimer = null;
// Where the notice lives when no dialog is open.
const noticeHome = $('notice').parentElement;

function showNotice(text, detail = '') {
  hideNotice();
  $('notice-text').textContent = text;
  $('notice-detail').textContent = detail;
  $('notice-detail').hidden = !detail;
  $('notice').hidden = false;
  // Above an open dialog and its backdrop, and usable: everything outside a
  // modal dialog is inert (its text cannot be selected), so the notice goes
  // into the dialog while one is open.
  const dialog = document.querySelector('dialog[open]');
  if (dialog && $('notice').parentElement !== dialog) dialog.prepend($('notice'));
  else if (!dialog && $('notice').parentElement !== noticeHome) noticeHome.prepend($('notice'));
  try {
    if ($('notice').matches(':popover-open')) $('notice').hidePopover();
    $('notice').showPopover();
  } catch {
    // No popover support: it stays under a dialog's backdrop.
  }
}

// While the pointer is over a notice (to select its text) it stays.
$('notice').addEventListener('pointerenter', () => { clearTimeout(noticeTimer); noticeTimer = null; });

function startNoticeTimer() {
  if (noticeTimer || $('notice').hidden) return;
  noticeTimer = setTimeout(hideNotice, $('notice-detail').hidden ? 6000 : 12000);
}

function hideNotice() {
  clearTimeout(noticeTimer);
  noticeTimer = null;
  try {
    if ($('notice').matches(':popover-open')) $('notice').hidePopover();
  } catch {
    // Not a popover here.
  }
  $('notice').hidden = true;
}

$('notice-close').onclick = hideNotice;

function scheduleSave() {
  if (state.restoring || !state.editsKey || !canRender()) return;
  clearTimeout(saveTimer);
  const key = state.editsKey;
  const photo = state.current && state.current.photo;
  saveTimer = setTimeout(() => {
    saveTimer = 0;
    if (key !== state.editsKey) return;
    const edits = readEdits(document, {
      photo: { id: key, name: state.current ? state.current.name : null },
      view: state.camera,
      focusPoint: state.focusPoint,
    });
    recordHistory(edits);
    if (photo) state.lib.saveEdits(photo, edits).catch((err) => console.warn('Could not save edits', err));
    else editsStore.save(key, edits);
  }, 500);
}

// ---------------------------------------------------------------- undo

// Undo and redo (Ctrl / ⌘ + Z, Ctrl / ⌘ + Y or Shift + Ctrl / ⌘ + Z): every
// saved state of the open photo's edits is a step, so one slider drag or
// keyframe change is one step. History starts over when a photo opens.
const HISTORY_LIMIT = 200;
const history = { undo: [], redo: [], current: null };
const editsState = (edits) => {
  const { modified, photo, ...rest } = edits;
  return JSON.stringify(rest);
};
function currentEdits() {
  return readEdits(document, { view: { ...state.camera }, focusPoint: { ...state.focusPoint } });
}
function resetHistory() {
  history.undo = [];
  history.redo = [];
  history.current = state.info ? currentEdits() : null;
}
function recordHistory(edits) {
  if (!history.current) {
    history.current = edits;
    return;
  }
  if (editsState(edits) === editsState(history.current)) return;
  history.undo.push(history.current);
  if (history.undo.length > HISTORY_LIMIT) history.undo.shift();
  history.redo = [];
  history.current = edits;
}
// A change still waiting to be saved counts as a step.
function flushSave() {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  saveTimer = 0;
  const key = state.editsKey;
  const photo = state.current && state.current.photo;
  const edits = readEdits(document, { photo: { id: key, name: state.current ? state.current.name : null }, view: state.camera, focusPoint: state.focusPoint });
  recordHistory(edits);
  if (photo) state.lib.saveEdits(photo, edits).catch((err) => console.warn('Could not save edits', err));
  else if (key) editsStore.save(key, edits);
}
let historyBusy = false;
async function stepHistory(back) {
  if (historyBusy || !state.info || state.restoring) return;
  flushSave();
  const from = back ? history.undo : history.redo;
  const to = back ? history.redo : history.undo;
  if (!from.length) return;
  historyBusy = true;
  try {
    if (state.playing) setPlaying(false);
    to.push(history.current);
    await applyEdits(state.info, from.pop());
    // What the controls hold now (the document as applied).
    history.current = currentEdits();
    scheduleSave();
  } catch (err) {
    showError(err);
  } finally {
    historyBusy = false;
  }
}
const undo = () => stepHistory(true);
const redo = () => stepHistory(false);
// Text fields keep their own undo.
const typing = (el) => el && (el.isContentEditable || el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && /^(text|search|number|email|url|password)$/.test(el.type)));
let lastHistoryKey = 0;
document.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || typing(document.activeElement)) return;
  const k = e.key.toLowerCase();
  const isUndo = k === 'z' && !e.shiftKey;
  const isRedo = k === 'y' || (k === 'z' && e.shiftKey);
  if (!isUndo && !isRedo) return;
  e.preventDefault();
  lastHistoryKey = performance.now();
  if (isUndo) undo();
  else redo();
});

for (const type of ['input', 'change']) $('controls').addEventListener(type, scheduleSave);


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
  else if (input.id === 'tilt-rotation' || input.id === 'bokeh-rotation') out.textContent = `${v}°`;
  else if (input.id === 'straighten') out.textContent = `${v.toFixed(1)}°`;
  else if (input.id === 'ml-angle') out.textContent = `${v}°`;
  else if (input.id === 'frame-zoom') out.textContent = `${v}%`;
  else if (input.id === 'video-quality') out.textContent = `${v} Mbit/s`;
  else if (['photo-quality', 'bokeh-blades', 'stereo-baseline', 'upscale-sharpen', 'upscale-strength', 'upscale-lobes', 'upscale-denoise', 'upscale-grain', 'depth-model-smooth', 'depth-model-curve', 'lattice-strength', 'lattice-detect'].includes(input.id)) out.textContent = `${v}`;
  else if (input.id === 'mx-strength' || input.id === 'lut-amount') out.textContent = `${v}%`;
  else if (input.id === 'mx-exposure') out.textContent = `${sign}${Math.abs(v / 100).toFixed(2)} EV`;
  else if (input.id === 'md-near' || input.id === 'md-far') out.textContent = `${sign}${Math.abs(v / 100).toFixed(2)}`;
  else if (input.closest('.mask-shape')) out.textContent = `${v}`;
  else if (input.id === 'wb-temperature') out.textContent = `${v} K`;
  else if (input.id === 'sharp-radius') out.textContent = v.toFixed(1);
  else if (input.id === 'nr-speckle-size') out.textContent = `${v} px`;
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
$('lens-auto').onchange = applySettings;
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
for (const id of ['awb', 'base-look', 'mv-on', 'nr-hot', 'detail', 'fringe-on', 'fringe-auto', 'fringe-radius', 'fringe-threshold', ...FRINGES.flatMap((k) => [`fringe-${k}`, `fringe-${k}-hue`])]) $(id).onchange = applySettings;
$('fringe-radius').oninput = () => { $('fringe-radius-label').textContent = `${$('fringe-radius').value} px`; };
for (const key of FRINGES) $(`fringe-${key}-hue`).oninput = showFringeHues;

// A focused button or checkbox would also act on Space (on key up): not
// when Space just played or paused.
let spacePlayed = false;
document.addEventListener('keyup', (e) => {
  if (e.code === 'Space' && spacePlayed) {
    spacePlayed = false;
    e.preventDefault();
  }
}, true);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state.picking) {
    setPicking(false);
    return;
  }
  // Space plays and pauses from anywhere, also right after using a slider,
  // button or checkbox; only fields that take typing keep it.
  if (e.code === 'Space' && !e.repeat && state.mode === 'camera' && state.info && $('anim-on').checked
    && !e.target.matches('textarea, select, [contenteditable], input:not([type=range]):not([type=checkbox]):not([type=radio]):not([type=button])')) {
    e.preventDefault();
    setPlaying(!state.playing);
    spacePlayed = true;
    return;
  }
  if (e.target.matches('input, select, textarea')) return;
  if (e.code === 'Space') {
    e.preventDefault();
  } else if (state.grid && (e.key === '+' || e.key === '=')) {
    setThumbSize(+$('thumb-size').value * 1.25);
  } else if (state.grid && (e.key === '-' || e.key === '_')) {
    setThumbSize(+$('thumb-size').value / 1.25);
  } else if (e.key === '+' || e.key === '=') {
    $('zoom-in').click();
  } else if (e.key === '-' || e.key === '_') {
    $('zoom-out').click();
  } else if (e.key === 'f' || e.key === 'F') {
    setFullResMode(!state.fullResMode);
  } else if (e.key === 'd' || e.key === 'D') {
    setDepthShown(!state.depthShown);
  } else if (e.key === '0') {
    $('zoom-label').click();
  } else if (e.key === '1') {
    $('zoom-1').click();
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
calReady = libReady.then(() => sendCalibrations()).catch(() => {});
$('version').textContent = VERSION;

// Desktop app: the camera's photos show in the Camera section as soon as
// it is connected (a drive, or adb). WebUSB plug-in events (any OS; the main
// process lets the page see Lytro's vendor ID only) show it at once, before
// its drive mounts, and make the main process look for the drive sooner.
if (native) document.body.classList.add('native');
if (CAMERA_IMPORT) {
  // The desktop app shows the button once a camera is detected (below);
  // a browser has no way to tell, so it always shows it.
  $('camera-btn').hidden = !!native;
  $('camera-status').hidden = false;
}
if (native && CAMERA_IMPORT) {
  let lastCams = [];
  let usbLytros = 0;
  let usbProblem = '';
  const showCameras = () => {
    const count = lastCams.reduce((n, c) => n + c.files.length, 0);
    $('camera-status').textContent = lastCams.length
      ? `Lytro camera connected · ${count} photo${count === 1 ? '' : 's'}`
      : usbLytros ? 'Lytro camera connected · looking for photos…' : '';
    $('camera-status').classList.toggle('connected', lastCams.length > 0 || usbLytros > 0);
    $('camera-btn').hidden = !(lastCams.length > 0 || usbLytros > 0);
    const c = lastCams.find((x) => x.files.length) || lastCams[0];
    setCameraSection(c ? { cam: { kind: c.kind, id: c.id, label: c.label, files: c.files } }
      : usbProblem ? { note: usbProblem } : usbLytros ? { note: 'Lytro camera connected. Looking for its photos…' } : {});
  };
  // A Lytro on USB the app could not use: say why (a driver, a protocol the
  // camera does not answer), instead of showing nothing.
  const refreshProblems = () => {
    if (lastCams.length || !native.cameraProblems) return;
    native.cameraProblems().then(({ problems }) => {
      const next = problems && problems.length ? problems[0] : '';
      if (next === usbProblem) return;
      usbProblem = next;
      if (!lastCams.length) setCameraSection(usbProblem ? { note: usbProblem } : usbLytros ? { note: 'Lytro camera connected. Looking for its photos…' } : {});
    }).catch(() => {});
  };
  setInterval(refreshProblems, 5000);
  native.listCameras().then((cams) => {
    lastCams = cams;
    showCameras();
    refreshProblems();
  }).catch(() => {});
  native.onCamerasChanged((cams) => {
    lastCams = cams;
    showCameras();
  });
  if (navigator.usb) {
    const isLytro = (d) => d.vendorId === LYTRO_USB_VENDOR;
    navigator.usb.addEventListener('connect', (e) => {
      if (!isLytro(e.device)) return;
      usbLytros++;
      showCameras();
      native.cameraUsbConnected();
    });
    navigator.usb.addEventListener('disconnect', (e) => {
      if (!isLytro(e.device)) return;
      usbLytros = Math.max(0, usbLytros - 1);
      showCameras();
    });
    navigator.usb.getDevices().then((devices) => {
      usbLytros = devices.filter(isLytro).length;
      showCameras();
    }).catch(() => {});
  }
}

// Browser: WebUSB tells the page when a Lytro is plugged in, once the user
// has allowed this site to see it (Detect camera…, Chrome and Edge). It
// cannot read the photos over USB (browsers keep USB drives to the OS):
// the camera's drive is chosen once and remembered, and its photos show in
// the Camera section on later plug-ins (the browser may ask to allow
// reading it again).
if (!native && !navigator.usb && CAMERA_IMPORT) {
  // Firefox and Safari have no WebUSB: say so instead of hiding the button.
  $('usb-watch-btn').hidden = false;
  $('usb-watch-btn').onclick = () => {
    showNotice('This browser cannot detect a camera being plugged in (it has no WebUSB). Use Chrome or Edge, or choose the camera\'s DCIM folder instead.');
    startNoticeTimer();
  };
}
if (!native && navigator.usb && CAMERA_IMPORT) {
  const isLytro = (d) => d.vendorId === LYTRO_USB_VENDOR;
  const allowedKey = 'illuminator.usbWatch';
  let allowed = false;
  try {
    allowed = localStorage.getItem(allowedKey) === '1';
  } catch {
    allowed = false;
  }
  let connected = 0;
  const showUsbStatus = () => {
    $('camera-status').textContent = connected ? 'Lytro camera connected' : '';
    $('camera-status').classList.toggle('connected', connected > 0);
    // Always shown, so the camera can be chosen again.
    $('usb-watch-btn').hidden = false;
  };
  const arrived = async () => {
    showUsbStatus();
    if (state.cameraSection.cam) return;
    setCameraSection({ note: 'Lytro camera connected.', show: true });
    // The drive chosen last time, if the browser still lets the page read
    // it: list it (it can take a few seconds to mount).
    const dir = await recallCameraFolder();
    if (!dir || !dir.queryPermission || (await dir.queryPermission({ mode: 'read' }).catch(() => 'denied')) !== 'granted') return;
    for (let i = 0; i < 10 && connected && !state.cameraSection.cam; i++) {
      if (await showWebCamera(dir)) return;
      await new Promise((r) => setTimeout(r, 1500));
    }
  };
  navigator.usb.addEventListener('connect', (e) => {
    if (!isLytro(e.device)) return;
    connected++;
    openWebUsbCamera(e.device).then((ok) => { if (!ok) arrived(); });
  });
  navigator.usb.addEventListener('disconnect', (e) => {
    if (!isLytro(e.device)) return;
    if (state.webUsbDevice === e.device) {
      state.webUsbConn = null;
      state.webUsbDevice = null;
    }
    connected = Math.max(0, connected - 1);
    showUsbStatus();
    if (!connected) setCameraSection({});
  });
  navigator.usb.getDevices().then(async (devices) => {
    const cameras = devices.filter(isLytro);
    connected = cameras.length;
    if (connected) {
      allowed = true;
      if (await openWebUsbCamera(cameras[0])) {
        showUsbStatus();
        return;
      }
      arrived();
    } else showUsbStatus();
  }).catch(() => showUsbStatus());
  state.askCameraPermission = async () => {
    try {
      const device = await navigator.usb.requestDevice({ filters: [{ vendorId: LYTRO_USB_VENDOR }] });
      allowed = true;
      try {
        localStorage.setItem(allowedKey, '1');
      } catch {
        // Only hides the button next time.
      }
      if (isLytro(device)) {
        connected = Math.max(connected, 1);
        // Read the camera over USB if it has an interface a browser can use.
        if (await openWebUsbCamera(device)) {
          showUsbStatus();
          return true;
        }
        arrived();
      }
      showUsbStatus();
      showNotice(state.webUsbReport ? `The camera was found but could not be read over USB. ${state.cameraSection.note || ''} ${state.webUsbReport.replace(/\n/g, ' · ')}` : 'Illuminator will now notice when this camera is plugged in.');
      startNoticeTimer();
      return true;
    } catch (err) {
      if (err.name === 'SecurityError') {
        // A page embedded in another (a preview frame) is not allowed to use USB.
        showNotice('This page is not allowed to use USB because it is shown inside another page (a preview or an artifact viewer, even in a separate tab). Open Illuminator from its web address, such as the website\'s Try online link, in Chrome or Edge.');
        startNoticeTimer();
      } else if (err.name === 'NotFoundError') {
        // Also what a closed chooser gives. A first generation camera shows
        // itself to the computer only as a USB drive, a kind of device the
        // browser does not offer to pages, so it may not be listed at all.
        showNotice('No camera was chosen. If none was listed: the browser only offers cameras that are not plain USB drives (a first generation camera may not be listed), and the camera must be plugged in and switched on.');
        startNoticeTimer();
      } else showError(err);
    }
    return false;
  };
  $('usb-watch-btn').onclick = () => state.askCameraPermission();
}
$('camera-choose').onclick = () => importFromCameraFolder();

// Test hook: ?sample opens the synthetic sample on load.
if (new URLSearchParams(location.search).has('sample')) $('sample-btn').click();

// LUT: ui/lut.js
const { sendLut } = initLut({ $, engine, showProgress: (...a) => showProgress(...a), hideProgress: (...a) => hideProgress(...a), canRender: (...a) => canRender(...a), showNotice: (...a) => showNotice(...a), startNoticeTimer: (...a) => startNoticeTimer(...a), showError: (...a) => showError(...a), scheduleSave: (...a) => scheduleSave(...a), applySettingsSoon: (...a) => applySettingsSoon(...a), TRASH_ICON, showSliderValue: (...a) => showSliderValue(...a) });

// updates: ui/updates.js
const { checkNow } = initUpdates({ showNotice: (...a) => showNotice(...a), $ });
checkForUpdateNow = checkNow;
