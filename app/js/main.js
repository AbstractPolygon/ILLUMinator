import { VERSION } from './version.js';
import { readEdits, writeEdits, editsStore, EDITS_FORMAT, EDITS_VERSION } from './edits.js';
import { Engine, toImageData } from './engine.js';
import { blobReader, readThumbnail, readPhotoSummary, openContainer } from './core/lfp.js';
import { findRecipe, recipeToEdits } from './core/recipe.js';
import { upscaleImage } from './gpu/upscale.js';
import { VIDEO_FORMATS, VIDEO_CODECS, videoType, chooseVideoType, videoBitrate, videoFrame } from './core/video-format.js';
import { openFiles, pickCameraFolder, pickFolder, isLightFieldName, findSidecar, download, native, NativeFile, CAMERA_IMPORT, LYTRO_USB_VENDOR, listCameraFolder, rememberCameraFolder, recallCameraFolder } from './platform.js';
import { Library } from './library/library.js';
import { openStorage, memoryStorage } from './library/storage.js';
import { groupPhotos } from './library/scan.js';
import { parsePoints, formatPoints } from './core/curve.js';
import { parseMasks, defaultMask, MAX_MASKS } from './core/local.js';
import { parseCube, encodeLut, decodeLut } from './core/lut.js';
import { ARCHIVE_SUFFIX } from './library/archive.js';
import { TRACKS, PRESETS, FPS as DEFAULT_FPS, emptyAnimation, parseAnimation, setKey, sample, hasKeys, cubicBezier, frameCount, valueAt, segmentBezier, isMaskTrack, isSettingTrack } from './core/keyframes.js';

// Frames a second of animations: for playback, keyframe times and video
// (the Frame rate setting).
let KEY_FPS = DEFAULT_FPS;
import { curveEditor } from './ui/curve-editor.js';
import { geometry, isIdentity, apply as applyMatrix, invert, rotateOrientation, flipOrientation, flipVerticalOrientation, fitAspect, FULL_CROP } from './core/geometry.js';

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

const EMPTY_LIBRARY = CAMERA_IMPORT
  ? 'Open .LFR / .LFP files, drop them here, or import from a camera or Lytro Desktop.'
  : 'Open .LFR / .LFP files, drop them here, or import from Lytro Desktop.';

// The Camera section's state (see setCameraSection).
let cameraSection = {};
const cameraThumbs = new Map();
let rememberedFailed = false;

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
  if (state.cameraView && !cameraSection.note && !cameraSection.cam) state.cameraView = false;
  renderCameraSection();
  if (state.cameraView) renderCameraGrid();
  else renderGrid(photos, album);
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
  if (!lib) return;
  const li = document.createElement('li');
  $('album-list').append(li);
  editName(li, '', async (name) => {
    if (name) {
      const album = await lib.createAlbum(name);
      if (photoIds.length) await lib.addToAlbum(album.id, photoIds);
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
    edits = await lib.loadEdits(photo);
    if (edits && edits.reset) edits = null;
  }
  copiedSettings = { id: photo.id, name: photo.name, edits: edits ? JSON.parse(JSON.stringify(edits)) : null };
}
async function pasteSettings(photo) {
  if (!copiedSettings) return;
  const open = state.current && state.current.photo === photo && state.info;
  const { view, focusPoint, ...rest } = copiedSettings.edits || { format: EDITS_FORMAT, version: EDITS_VERSION };
  const mine = open ? { view: { ...state.camera }, focusPoint: { ...state.focusPoint } } : (await lib.loadEdits(photo)) || {};
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
    await lib.saveEdits(photo, edits);
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
  items.push('-');
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
  showMenu(button, items, at);
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
      label: 'Export album…',
      action: () => exportAlbum(id),
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
async function importPhotos(entries, { album = state.album, replace = false } = {}) {
  await libReady;
  if (!entries.length) return [];
  let added = [];
  const before = new Map(lib.photos.map((p) => [p.id, p.added]));
  try {
    added = await lib.add(entries, {
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
  state.geom = g ? { ...g, inverse: invert(k === 1 ? g.matrix : g.matrix.map((v) => v * k)), srcW: img.width, srcH: img.height } : null;
  if (g) drawGeometry(ctx, img, g, k);
  else if (img instanceof ImageData) ctx.putImageData(img, 0, 0);
  else ctx.drawImage(img, 0, 0);
  if (cropState.editing) positionCropBox();
  canvas.classList.remove('hidden');
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
async function renderCamera() {
  // Changes keep coming: wait for them to stop before auto rendering.
  if (autoRenderTimer) scheduleAutoRender();
  if (!canRender()) return;
  const v = state.view;
  if (v.busy) {
    v.pending = true;
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
      const msg = await engine.request('view', { ...cameraParams(), draft }, { onProgress: showProgress });
      hideProgress();
      if (msg && (msg.pixels || msg.bitmap) && showsCamera()) {
        draw(toImageData(msg));
        if (draft) drag.drafted = true;
      }
      if (msg && msg.gpuMs != null) showGpuTime(msg.gpuMs);
    }
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
    // Near and Far may be keyframed: step i is at i / frame rate.
    const alphas = Array.from({ length: n }, (_, i) => {
      const t = i / KEY_FPS;
      const near = valueAt(anim, 'near', t) ?? +$('near').value;
      const far = valueAt(anim, 'far', t) ?? +$('far').value;
      return near + ((far - near) * i) / (n - 1);
    });
    // A small aperture would show little change: sweep at least wide open.
    const aperture = Math.max(p.aperture, 1);
    return { type: 'refocusFrames', kind: 'refocus', loop: 'pingpong', values: alphas, args: { alphas, u: p.u, v: p.v, aperture, dof: p.dof, bokeh: p.bokeh } };
  }
  const n = +$('frames').value;
  const path = Array.from({ length: n }, (_, i) => {
    // Amount may be keyframed: frame i is at i / frame rate.
    const r = state.info.radius * (valueAt(anim, 'amount', i / KEY_FPS) ?? +$('amount').value);
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
  const expected = keyframes ? frameCount(anim, KEY_FPS) : Math.max(1, +$($('anim').value === 'focus' ? 'steps' : 'frames').value);
  // Keyframes without an animation yet render one frame: count the length.
  const total = keyframes ? expected : n || expected;
  // The play bar's slider spans the whole animation, rendered or not, so it
  // can be dragged at once.
  $('scrub').max = String(Math.max(0, expected - 1));
  const index = n > 1 && state.showingFrames ? state.index : keyframes ? Math.round((state.keyTime || 0) * KEY_FPS) : 0;
  const i = Math.min(total - 1, Math.max(0, index));
  const ready = state.frames.filter(Boolean).length;
  const val = state.showingFrames ? state.frameValues[state.index] : undefined;
  $('frame-label').textContent = `Frame ${i + 1} / ${total} · ${(i / KEY_FPS).toFixed(2)} / ${((total - 1) / KEY_FPS).toFixed(2)} s` +
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

async function renderStill() {
  const scale = +$('still-scale').value;
  try {
    const passes = +$('still-passes').value;
    const { promise } = engine.job('superRes', 'superres', { ...cameraParams(), scale, passes }, { onProgress: showProgress });
    const msg = await promise;
    // Ignore a result that arrives after full resolution was switched off.
    if (msg && (msg.pixels || msg.bitmap) && state.fullRes) {
      state.still = toImageData(msg);
      state.lensStill = { img: state.still, scale };
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
// mode on (Scale appears, Render is enabled); Render makes the still. Any change to
// the picture returns to the live view until Render is pressed again.
function setFullResMode(on) {
  if (on && !(state.info && state.info.hasRaw && state.mode === 'camera')) on = false;
  state.fullResMode = on;
  $('fullres-on').checked = on;
  $('fullres-panel').hidden = !on;
  $('render-btn').disabled = !on;
  $('auto-render').disabled = !on;
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
try {
  $('auto-render').checked = localStorage.getItem('illuminator.autoRender') === '1';
} catch {
  // Storage unavailable: starts off.
}
$('auto-render').onchange = () => {
  try {
    localStorage.setItem('illuminator.autoRender', $('auto-render').checked ? '1' : '0');
  } catch {
    // Not remembered; it still applies now.
  }
  scheduleAutoRender(0);
};

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
  scheduleAutoRender();
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
  for (const id of ['depth-btn', 'spread-show', 'depth-smooth', 'depth-hq']) $(id).disabled = !depthTools;
  for (const id of ['fstop', 'bokeh', 'dof-depth', 'highlights', 'spread', 'spread-smooth', 'tilt-on', 'tilt', 'tilt-rotation', ...BOKEH_SHAPE]) $(id).disabled = !depthTools || stack;
  if (!$('tilt-on').checked) for (const id of ['tilt', 'tilt-rotation']) $(id).disabled = true;
  $('mv-on').disabled = !raw;
  $('detail').disabled = !raw;
  for (const id of ['stop-btn', 'pause-btn', 'play-btn', 'loop-btn', 'webm-btn', 'scrub']) $(id).disabled = !state.info || !camera || !$('anim-on').checked;
  $('png-btn').disabled = !state.info;
  $('quick-export-btn').disabled = !state.info;
  $('stereo-btn').disabled = !(state.info && state.info.hasRaw) || !camera;
  $('stereo-on').disabled = !(state.info && state.info.hasRaw) || !camera;
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

for (const id of ['fstop', 'bokeh', 'dof-depth', 'highlights', 'spread', 'spread-smooth', 'tilt', 'tilt-rotation', ...BOKEH_SHAPE]) {
  $(id).oninput = () => {
    if (id === 'bokeh') showBokehShape();
    showFNumber();
    showSliderValue($(id));
    cameraChanged({ final: false });
  };
  $(id).onchange = () => cameraChanged({ final: true });
}

$('spread-show').onchange = updateSpreadOverlay;
$('tilt-on').onchange = () => {
  const off = !$('tilt-on').checked;
  for (const id of ['tilt', 'tilt-rotation']) $(id).disabled = off || $('tilt-on').disabled;
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
  // Libraries are imported by the desktop app; the browser version points
  // there.
  if (!native) {
    $('desktop-only-dialog').showModal();
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
  const album = lib.albums.find((a) => a.name === albumName) || (await lib.createAlbum(albumName));
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

$('settings-btn').onclick = async () => {
  await showLibraryLocation();
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
const FX_SLIDERS = { exposure: 'mx-exposure', contrast: 'mx-contrast', saturation: 'mx-saturation', temperature: 'mx-temperature', tint: 'mx-tint', blur: 'mx-blur', pixelate: 'mx-pixelate', sketch: 'mx-sketch' };
let maskSel = -1;

function getMasks() {
  return parseMasks($('local-masks').value);
}

function setMasks(masks, { final = true } = {}) {
  $('local-masks').value = JSON.stringify(masks);
  applySettingsSoon();
  if (final) scheduleSave();
}

// A mask's name: the one given to it (or its living filter's), else its
// kind and number.
function maskLabel(m, i) {
  if (m.name) return m.name;
  const same = getMasks().slice(0, i + 1).filter((x) => x.kind === m.kind).length;
  return `${MASK_NAMES[m.kind]} ${same}`;
}

const PENCIL_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" d="M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4"/></svg>';
const TRASH_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>';

function deleteMask(i) {
  const list = getMasks();
  if (!list[i]) return;
  // Its animation goes with it.
  const prefix = `mask:${list[i].id}:`;
  let keyed = false;
  for (const k of Object.keys(anim.tracks)) {
    if (!k.startsWith(prefix)) continue;
    keyed = keyed || anim.tracks[k].length > 0;
    delete anim.tracks[k];
  }
  list.splice(i, 1);
  if (maskSel >= i) maskSel = Math.max(list.length ? 0 : -1, maskSel - 1);
  if (!list.length) $('mask-show').checked = false;
  setMasks(list);
  renderMasks();
  clearSelection();
  if (keyed) saveAnimation();
  else renderTimeline();
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
    name.title = 'Double-click to rename';
    const rename = () => editName(li, maskLabel(m, i), (text) => {
      if (text) {
        const list = getMasks();
        if (list[i]) list[i].name = text;
        setMasks(list);
      }
      renderMasks();
      renderTimeline();
    }, 'Mask name');
    name.ondblclick = rename;
    const edit = Object.assign(document.createElement('button'), { type: 'button', className: 'icon-only mask-rename', title: 'Rename' });
    edit.innerHTML = PENCIL_ICON;
    edit.setAttribute('aria-label', `Rename ${maskLabel(m, i)}`);
    edit.onclick = (e) => {
      e.stopPropagation();
      rename();
    };
    const del = Object.assign(document.createElement('button'), { type: 'button', className: 'icon-only mask-del', title: 'Delete mask' });
    del.innerHTML = TRASH_ICON;
    del.setAttribute('aria-label', `Delete ${maskLabel(m, i)}`);
    del.onclick = (e) => {
      e.stopPropagation();
      askDeleteMask(i, del);
    };
    li.append(name, edit, del);
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
  // Disabled: only Enabled (and Delete) show.
  $('mask-editor').classList.toggle('off', !m.on);
  $('mask-invert').checked = m.invert;
  $('mx-strength').value = Math.round((m.strength ?? 1) * 100);
  $('mask-follow').checked = !!m.follow;
  for (const input of document.querySelectorAll('.local-panel input[type=range]')) showSliderValue(input);
  updateKeyButtons();
}

// Editor controls -> the selected mask.
function maskFromEditor(final) {
  const masks = getMasks();
  const m = masks[maskSel];
  if (!m) return;
  for (const [key, [id, k]] of Object.entries(SHAPE_SLIDERS[m.kind])) m[key] = +$(id).value / k;
  for (const [key, id] of Object.entries(FX_SLIDERS)) m.fx[key] = +$(id).value / 100;
  // Turned off: its keyframes leave the editor, so nothing hidden stays selected.
  if (m.on && !$('mask-on').checked) clearSelection();
  m.on = $('mask-on').checked;
  if (!m.on && $('mask-show').checked) $('mask-show').checked = false;
  m.invert = $('mask-invert').checked;
  m.strength = +$('mx-strength').value / 100;
  // Following the focus from where it is now.
  const follow = $('mask-follow').checked;
  if (follow && !m.follow) m.anchor = +$('focus').value;
  m.follow = follow;
  setMasks(masks, { final });
  if (final) {
    renderMasks();
    autoKey();
    renderTimeline();
  }
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
for (const id of ['mask-on', 'mask-invert', 'mask-follow']) $(id).addEventListener('change', () => maskFromEditor(true));
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
const TRACK_NAMES = {
  aperture: 'Aperture', depth: 'Depth of field', focus: 'Focus', view: 'Viewpoint', zoom: 'Zoom', panX: 'Pan X', panY: 'Pan Y', pivot: 'Pivot depth',
  pointX: 'Focus point X', pointY: 'Focus point Y', spread: 'Spread', spreadSmooth: 'Smoothing', tilt: 'Tilt', tiltRotation: 'Rotation', highlights: 'Highlights',
  amount: 'Amount', near: 'Near', far: 'Far',
};

// The camera's tracks by section of the Camera panel (and the Animation
// panel's framing), each a group of its own under Camera.
const CAMERA_SECTIONS = [
  { id: 'cam-depth', name: 'Depth', tracks: ['aperture', 'depth', 'focus'] },
  { id: 'cam-spread', name: 'Focus Spread', tracks: ['pointX', 'pointY', 'spread', 'spreadSmooth'] },
  // Tilt and Pivot depth show (and count) only while they are on.
  { id: 'cam-tilt', name: 'Tilt', tracks: ['tilt', 'tiltRotation'], when: () => $('tilt-on').checked },
  { id: 'cam-perspective', name: 'Perspective', tracks: ['view', 'pivot'] },
  { id: 'cam-bokeh', name: 'Bokeh', tracks: ['highlights'] },
];

// The Animation panel's tracks, by what is animated: Framing with
// keyframes, Amount with the viewpoint path, Near and Far with the focus
// sweep.
const ANIMATION_SECTIONS = [
  { id: 'anim-framing', name: 'Framing', tracks: ['zoom', 'panX', 'panY'], mode: 'keyframes' },
  { id: 'anim-viewpoint', name: 'Viewpoint path', tracks: ['amount'], mode: 'viewpoint' },
  { id: 'anim-focus', name: 'Focus sweep', tracks: ['near', 'far'], mode: 'focus' },
];
// The Animate setting each Animation panel track works with (the others
// work with Keyframes).
const TRACK_MODE = { amount: 'viewpoint', near: 'focus', far: 'focus' };

// Every setting of a local adjustment (living filters included) has a
// track too: 'mask:<id>:<attr>'.
const MASK_FX = ['exposure', 'contrast', 'saturation', 'temperature', 'tint', 'blur', 'pixelate', 'sketch'];
const MASK_SHAPE = { radial: ['x', 'y', 'w', 'h', 'feather'], linear: ['x', 'y', 'angle', 'width'], depth: ['near', 'far', 'feather'] };
const MASK_ATTR_NAMES = {
  strength: 'Strength', exposure: 'Exposure', contrast: 'Contrast', saturation: 'Saturation', temperature: 'Temperature', tint: 'Tint', blur: 'Blur', pixelate: 'Pixelate', sketch: 'Sketch',
  x: 'Center X', y: 'Center Y', w: 'Width', h: 'Height', feather: 'Feather', angle: 'Angle', width: 'Width', near: 'Near', far: 'Far',
};
const MASK_LIMITS = { strength: [0, 1], blur: [0, 1], pixelate: [0, 1], sketch: [0, 1], exposure: [-2, 2], x: [0, 1], y: [0, 1], w: [0.01, 1], h: [0.01, 1], feather: [0, 1], angle: [-180, 180], width: [0.01, 1], near: [-1.6, 1.6], far: [-1.6, 1.6] };
const maskAttrs = (m) => ['strength', ...MASK_SHAPE[m.kind], ...MASK_FX];

function parseMaskTrack(k) {
  const [, id, attr] = k.split(':');
  return { id, attr };
}

function maskAttr(m, a) {
  if (MASK_FX.includes(a)) return m.fx[a];
  return a === 'strength' ? m.strength ?? 1 : m[a];
}

function setMaskAttr(m, a, v) {
  const [lo, hi] = MASK_LIMITS[a] || [-1, 1];
  v = Math.min(hi, Math.max(lo, v));
  if (MASK_FX.includes(a)) m.fx[a] = v;
  else m[a] = v;
}

// The tracks in groups: Camera (with a group for each of its sections,
// `parent: 'camera'`; Camera itself has `sections` and no tracks of its
// own to show), then one for each local adjustment, named after the living
// filter that made it (or the mask).
// Every group is a section (a sidebar panel: `sections`, with every track
// of its subsections) or a subsection of one (`parent`). With `mode` (an
// Animate setting, default the current one) only the groups that animate
// in that mode: Camera, Local Adjustments and Framing with Keyframes; the
// viewpoint path's or focus sweep's settings with those.
function trackGroups(mode = $('anim').value) {
  const groups = [];
  const section = (id, name, subs) => {
    if (!subs.length) return;
    groups.push({ id, name, sections: true, tracks: subs.filter((g) => !g.off).flatMap((g) => g.tracks) }, ...subs.map((g) => ({ ...g, parent: id })));
  };
  // A setting's track shows (and counts) while its slider can be used.
  const settingSection = (panel) => section(panel.id, panel.name, panel.subs.map((sub) => ({
    id: sub.id, name: sub.name, tracks: sub.tracks.filter((k) => !settingControl(k).matches(':disabled')),
  })).filter((sub) => sub.tracks.length));
  const [processPanel, opticsPanel] = settingPanels();
  // In the sidebar's order.
  if (mode === 'keyframes') {
    settingSection(processPanel);
    // `off`: a disabled adjustment, whose keyframes the editor hides.
    section('local', 'Local Adjustments', getMasks().map((m, i) => ({ id: m.id, name: m.name || maskLabel(m, i), off: !m.on, tracks: maskAttrs(m).map((a) => `mask:${m.id}:${a}`) })));
    section('camera', 'Camera', CAMERA_SECTIONS
      .filter((sec) => !sec.when || sec.when())
      .map((sec) => ({ id: sec.id, name: sec.name, tracks: sec.tracks.filter((k) => k !== 'pivot' || $('pivot-on').checked) })));
    settingSection(opticsPanel);
  }
  section('animation', 'Animation', ANIMATION_SECTIONS.filter((sec) => sec.mode === mode).map((sec) => ({ id: sec.id, name: sec.name, tracks: sec.tracks })));
  for (const g of groups) for (const k of g.tracks) if (!anim.tracks[k]) anim.tracks[k] = [];
  return groups;
}

function tracks(mode) {
  return trackGroups(mode).filter((g) => !g.sections && !g.off).flatMap((g) => g.tracks);
}

// Keyframe buttons in the sidebar: a ◆ at the right of each setting that
// can be animated. Lit while the setting has keyframes; clicking it starts
// animating the setting (a keyframe at the playhead) or stops (removes its
// keyframes). Filled when a keyframe sits at the playhead.
const KEY_CONTROLS = {
  fstop: ['aperture'], 'dof-depth': ['depth'], 'focus-point': ['focus', 'pointX', 'pointY'],
  spread: ['spread'], 'spread-smooth': ['spreadSmooth'], tilt: ['tilt'], 'tilt-rotation': ['tiltRotation'],
  viewpoint: ['view'], pivot: ['pivot'], highlights: ['highlights'],
  'frame-zoom': ['zoom'], 'frame-pan-x': ['panX'], 'frame-pan-y': ['panY'],
  amount: ['amount'], near: ['near'], far: ['far'],
};
// Settings of the selected local adjustment: control id -> attribute.
const KEY_MASK_CONTROLS = {
  'mx-strength': 'strength', 'mr-x': 'x', 'mr-y': 'y', 'mr-w': 'w', 'mr-h': 'h', 'mr-feather': 'feather',
  'ml-x': 'x', 'ml-y': 'y', 'ml-angle': 'angle', 'ml-width': 'width', 'md-near': 'near', 'md-far': 'far', 'md-feather': 'feather',
  ...Object.fromEntries(MASK_FX.map((a) => [`mx-${a}`, a])),
};

// The tracks behind a keyframe button (none while they are not shown).
// The Animate setting a sidebar setting's keyframes work with.
const keyButtonMode = (id) => (KEY_CONTROLS[id] && TRACK_MODE[KEY_CONTROLS[id][0]]) || 'keyframes';

function keyButtonTracks(id) {
  const shown = new Set(tracks(keyButtonMode(id)));
  if (KEY_CONTROLS[id]) return KEY_CONTROLS[id].filter((k) => shown.has(k));
  const m = getMasks()[maskSel];
  const k = m && `mask:${m.id}:${KEY_MASK_CONTROLS[id]}`;
  return k && shown.has(k) ? [k] : [];
}

function setupKeyButtons() {
  // Thin chevrons, so the three take little room; the tip sits on the
  // diamond's middle row of pixels.
  const chevron = (dir) => `<svg viewBox="0 0 7 12" width="7" height="12" aria-hidden="true"><path d="${dir < 0 ? 'M5.5 2 1.5 6.5 5.5 11' : 'M1.5 2 5.5 6.5 1.5 11'}" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  for (const id of [...Object.keys(KEY_CONTROLS), ...Object.keys(KEY_MASK_CONTROLS)]) {
    const el = $(id);
    const label = el && el.closest('label');
    if (!label) continue;
    // ◀ ◆ ▶ as in DaVinci Resolve's Inspector: the arrows (shown while the
    // setting is animated) jump to its previous and next keyframe.
    const nav = Object.assign(document.createElement('span'), { className: 'key-nav' });
    nav.dataset.keyFor = id;
    nav.hidden = true;
    const prev = Object.assign(document.createElement('button'), { type: 'button', className: 'key-step', innerHTML: chevron(-1), title: 'Previous keyframe' });
    const b = Object.assign(document.createElement('button'), { type: 'button', className: 'key-toggle' });
    b.append(Object.assign(document.createElement('span'), { className: 'key-diamond' }));
    const next = Object.assign(document.createElement('button'), { type: 'button', className: 'key-step', innerHTML: chevron(1), title: 'Next keyframe' });
    // Not the label's control.
    nav.onclick = (e) => {
      e.preventDefault();
      e.stopPropagation();
    };
    prev.onclick = () => stepKey(id, -1);
    next.onclick = () => stepKey(id, 1);
    b.onclick = () => {
      // The diamonds are always there: one clicked while the animation is
      // off turns keyframe animation on.
      const mode = keyButtonMode(id);
      if (!$('anim-on').checked || $('anim').value !== mode) {
        $('anim-on').checked = true;
        $('anim').value = mode;
        for (const c of ['anim-on', 'anim']) $(c).dispatchEvent(new Event('change'));
      }
      const ks = keyButtonTracks(id);
      if (!ks.length) return;
      if (ks.some((k) => anim.tracks[k].length)) {
        for (const k of ks) anim.tracks[k] = [];
        clearSelection();
      } else {
        const t = Math.round(playheadTime() * KEY_FPS) / KEY_FPS;
        tlSel.clear();
        for (const k of ks) {
          setKey(anim, k, t, currentValue(k), KEY_FPS);
          selectAt(k, t, true);
        }
      }
      saveAnimation();
    };
    nav.append(prev, b, next);
    label.append(nav);
  }
}
// Process and Optics sliders can be keyframed too ('set:<id>' tracks), by
// panel and section as the sidebar has them. Read from the sidebar once.
const SETTING_PANELS = ['Process', 'Optics'];
let settingPanelList = null;
function settingPanels() {
  if (settingPanelList) return settingPanelList;
  settingPanelList = SETTING_PANELS.map((title) => {
    const panel = [...document.querySelectorAll('details.panel')].find((d) => {
      const h = d.querySelector(':scope > summary h2');
      return h && h.textContent.trim() === title;
    });
    const subs = panel ? [...panel.querySelectorAll(':scope > details.subpanel')].map((sub) => {
      const name = sub.querySelector(':scope > summary h3').textContent.trim();
      return {
        id: `set-${name.toLowerCase().replace(/[^a-z]+/g, '-')}`,
        name,
        tracks: [...sub.querySelectorAll('input[type=range]')].filter((el) => el.closest('label')).map((el) => `set:${el.id}`),
      };
    }).filter((sub) => sub.tracks.length) : [];
    return { id: title.toLowerCase(), name: title, subs };
  });
  return settingPanelList;
}
const settingControl = (k) => $(k.slice(4));
// A setting track's name: its slider's label.
function settingName(k) {
  const label = settingControl(k).closest('label');
  return label.firstChild.textContent.trim();
}
for (const panel of settingPanels()) for (const sub of panel.subs) for (const k of sub.tracks) KEY_CONTROLS[k.slice(4)] = [k];

setupKeyButtons();

// The keyframe times of a sidebar setting's tracks, in order.
function keyTimes(id) {
  const times = new Set();
  for (const k of keyButtonTracks(id)) for (const key of anim.tracks[k]) times.add(Math.round(key.t * KEY_FPS));
  return [...times].sort((a, b) => a - b).map((f) => f / KEY_FPS);
}

// Moves the playhead to the setting's previous (dir -1) or next keyframe.
function stepKey(id, dir) {
  const now = playheadTime();
  const eps = 0.5 / KEY_FPS;
  const times = keyTimes(id);
  const t = dir < 0 ? times.filter((x) => x < now - eps).pop() : times.find((x) => x > now + eps);
  if (t !== undefined) seekTo(t);
}

function updateKeyButtons() {
  const on = canRender() && state.mode === 'camera';
  const navs = document.querySelectorAll('.key-nav');
  if (!on) {
    for (const nav of navs) nav.hidden = true;
    return;
  }
  const now = playheadTime();
  const eps = 0.5 / KEY_FPS;
  for (const nav of navs) {
    const id = nav.dataset.keyFor;
    const ks = keyButtonTracks(id);
    nav.hidden = !ks.length;
    if (!ks.length) continue;
    // Lit only while its keyframes are in use (animation on, in their mode).
    const animating = $('anim-on').checked && $('anim').value === keyButtonMode(id);
    const times = animating ? keyTimes(id) : [];
    const keyed = times.length > 0;
    const here = times.some((x) => Math.abs(x - now) < eps);
    const [prev, b, next] = nav.children;
    nav.classList.toggle('on', keyed);
    b.classList.toggle('on', keyed);
    b.classList.toggle('here', here);
    prev.disabled = !times.some((x) => x < now - eps);
    next.disabled = !times.some((x) => x > now + eps);
    const name = nav.closest('label').firstChild.textContent.trim().toLowerCase();
    b.title = keyed ? `Stop animating ${name} (removes its keyframes)` : `Animate ${name}: a keyframe at the playhead`;
  }
}

// Camera starts open, with the sections the keyframes began with (Depth,
// Perspective, Framing); the others, and each adjustment's group, closed.
const OPEN_AT_FIRST = new Set(['camera', 'cam-depth', 'cam-perspective', 'local', 'animation', 'anim-framing', 'anim-viewpoint', 'anim-focus']);
const tlGroups = { closed: new Set(), opened: new Set() };
const groupCollapsed = (id) => (OPEN_AT_FIRST.has(id) ? tlGroups.closed.has(id) : !tlGroups.opened.has(id));
// Only keyed: the editor shows only the settings that have keyframes (and
// the groups holding them). Remembered between sessions.
function onlyKeyed() {
  return $('tl-only-keyed').checked;
}
try {
  $('tl-only-keyed').checked = localStorage.getItem('illuminator.tlOnlyKeyed') === '1';
} catch {
  // Storage unavailable: start with every setting shown.
}
$('tl-only-keyed').onchange = () => {
  try {
    localStorage.setItem('illuminator.tlOnlyKeyed', onlyKeyed() ? '1' : '0');
  } catch {
    // Not remembered; it still applies now.
  }
  renderTimeline();
};

// A group's tracks as the editor shows them.
function shownTracks(g) {
  return onlyKeyed() ? g.tracks.filter((k) => anim.tracks[k] && anim.tracks[k].length) : g.tracks;
}

// Closed itself or inside a closed group.
const groupHidden = (g) => groupCollapsed(g.id) || (!!g.parent && groupCollapsed(g.parent));

function toggleGroup(id) {
  const set = OPEN_AT_FIRST.has(id) ? tlGroups.closed : tlGroups.opened;
  if (set.has(id)) set.delete(id);
  else set.add(id);
  renderTimeline();
}

function trackName(k) {
  if (isSettingTrack(k)) return settingName(k);
  return isMaskTrack(k) ? MASK_ATTR_NAMES[parseMaskTrack(k).attr] || k : TRACK_NAMES[k];
}

// With the group's name, for tooltips.
function trackTitle(k) {
  if (!isMaskTrack(k) && !isSettingTrack(k)) return TRACK_NAMES[k];
  const g = trackGroups().find((x) => !x.sections && x.tracks.includes(k));
  return `${g ? g.name : 'Mask'} ${trackName(k).toLowerCase()}`;
}
let anim = emptyAnimation();
let keySel = null; // { k, t }: the main selected keyframe
// Every selected keyframe (keySel's among them).
const tlSel = new Set();
// The Curves view of the keyframe editor (see drawCurves).
const tlCurves = { on: false, hidden: new Set(), hits: [] };

function keyframesOn() {
  return $('anim-on').checked && $('anim').value === 'keyframes';
}

// The keyframe editor shows with any animation: with Keyframes every
// group, with a viewpoint path or focus sweep the settings of that.
function keyEditorOn() {
  return $('anim-on').checked;
}

// The editor's length: the keyframed animation's, or the viewpoint path's
// or focus sweep's (one frame per step, at the frame rate).
function animLength() {
  const mode = $('anim').value;
  if (mode === 'viewpoint') return Math.max(1, +$('frames').value - 1) / KEY_FPS;
  if (mode === 'focus') return Math.max(1, +$('steps').value - 1) / KEY_FPS;
  return anim.length;
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
      setKey(anim, 'panX', t, k.panX || 0);
      setKey(anim, 'panY', t, k.panY || 0);
    });
    anim.length = Math.max(1, (raw.length - 1) * 2);
  } else {
    anim = parseAnimation($('anim-keys').value);
  }
  clearSelection();
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
  if (isSettingTrack(k)) return +settingControl(k).value;
  if (isMaskTrack(k)) {
    const { id, attr } = parseMaskTrack(k);
    const m = getMasks().find((x) => x.id === id);
    return m ? maskAttr(m, attr) : 0;
  }
  switch (k) {
    case 'aperture': return F_STOPS[+$('fstop').value] ?? 2;
    case 'depth': return +$('dof-depth').value;
    case 'focus': return +$('focus').value;
    case 'view': return [state.camera.u, state.camera.v];
    case 'zoom': return +$('frame-zoom').value / 100;
    case 'panX': return +$('frame-pan-x').value / 100;
    case 'pivot': return +$('pivot').value;
    case 'pointX': return state.focusPoint.x;
    case 'pointY': return state.focusPoint.y;
    case 'spread': return +$('spread').value;
    case 'spreadSmooth': return +$('spread-smooth').value;
    case 'tilt': return +$('tilt').value;
    case 'tiltRotation': return +$('tilt-rotation').value;
    case 'highlights': return +$('highlights').value;
    case 'amount': return +$('amount').value;
    case 'near': return +$('near').value;
    case 'far': return +$('far').value;
    default: return +$('frame-pan-y').value / 100;
  }
}

// Camera tracks set straight from a slider.
const TRACK_SLIDERS = { spread: 'spread', spreadSmooth: 'spread-smooth', tilt: 'tilt', tiltRotation: 'tilt-rotation', highlights: 'highlights', amount: 'amount', near: 'near', far: 'far' };

// Shows a keyframe's value in the controls (and the picture).
// Sets the control behind track k to v.
function applyValue(k, v) {
  if (isSettingTrack(k)) {
    const el = settingControl(k);
    el.value = v;
    showSliderValue(el);
    // Sent to the worker once the values are all set (see settingsShown).
    settingsDirty = true;
    return;
  }
  if (isMaskTrack(k)) {
    const { id, attr } = parseMaskTrack(k);
    const masks = getMasks();
    const m = masks.find((x) => x.id === id);
    if (!m) return;
    setMaskAttr(m, attr, v);
    setMasks(masks, { final: false });
    if (masks.indexOf(m) === maskSel) renderMasks();
    return;
  }
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
  } else if (k === 'pivot') {
    $('pivot').value = Math.round(v);
    showSliderValue($('pivot'));
  } else if (k === 'pointX' || k === 'pointY') {
    state.focusPoint = { ...state.focusPoint, [k === 'pointX' ? 'x' : 'y']: Math.min(1, Math.max(0, v)) };
    showFocusPoint();
  } else if (TRACK_SLIDERS[k]) {
    const el = $(TRACK_SLIDERS[k]);
    // Whole numbers for sliders that step in them.
    el.value = +el.step >= 1 ? Math.round(v) : v;
    showSliderValue(el);
  } else if (k === 'zoom') {
    $('frame-zoom').value = Math.round(v * 100);
    showSliderValue($('frame-zoom'));
  } else {
    const id = k === 'panX' ? 'frame-pan-x' : 'frame-pan-y';
    $(id).value = Math.round(v * 100);
    showSliderValue($(id));
  }
}

// Process and Optics values shown from keyframes go to the worker in one go.
let settingsDirty = false;
function settingsShown() {
  if (!settingsDirty) return;
  settingsDirty = false;
  applySettingsSoon();
}

function showValue(k, v) {
  applyValue(k, v);
  settingsShown();
  // Showing a keyframe is not a change to record.
  autoKeyBase = currentValues();
  if (state.showingFrames) backToCamera();
  cameraChanged({ final: true });
}

// Shows the animation's settings at time t (no frames rendered yet).
function previewAt(t) {
  let any = false;
  for (const k of tracks()) {
    const v = valueAt(anim, k, t);
    if (v === undefined) continue;
    applyValue(k, v);
    any = true;
  }
  autoKeyBase = currentValues();
  if (!any) return;
  settingsShown();
  if (state.showingFrames) backToCamera();
  cameraChanged({ final: false });
}

// Auto key: when on, a change to an animatable setting records a keyframe
// at the playhead, on that setting's track only (settings left alone get
// no keyframes).
let autoKeyBase = null;

function sameValue(k, a, b) {
  if (a === undefined || b === undefined) return a === b;
  if (Array.isArray(a)) return Math.abs(a[0] - b[0]) < 1e-4 && Math.abs(a[1] - b[1]) < 1e-4;
  return Math.abs(a - b) < (k === 'aperture' || k === 'depth' ? 1e-3 : 1e-4);
}

function currentValues() {
  return Object.fromEntries(tracks().map((k) => [k, currentValue(k)]));
}

function autoKey() {
  const now = currentValues();
  const base = autoKeyBase;
  autoKeyBase = now;
  if (!$('tl-autokey').checked || !keyEditorOn() || state.mode !== 'camera' || state.restoring) return;
  const t = Math.round(playheadTime() * KEY_FPS) / KEY_FPS;
  let added = false;
  for (const k of tracks()) {
    if (!base || base[k] === undefined || sameValue(k, base[k], now[k])) continue;
    setKey(anim, k, t, now[k], KEY_FPS);
    selectAt(k, t, added);
    added = true;
  }
  if (added) saveAnimation();
}
$('tl-autokey').onchange = () => {
  autoKeyBase = currentValues();
};

function playheadTime() {
  if (state.showingFrames && state.frames.length > 1) return (state.drawFrame ?? state.index) / KEY_FPS;
  return Math.min(animLength(), state.keyTime || 0);
}

function clearSelection() {
  tlSel.clear();
  keySel = null;
}

// Selects a keyframe (`add`: keeping the others selected).
function selectKey(k, key, add = false) {
  if (!add) tlSel.clear();
  tlSel.add(key);
  keySel = { k, t: key.t };
}

function selectAt(k, t, add = false) {
  const key = anim.tracks[k].find((x) => Math.abs(x.t - t) < 1e-6);
  if (key) selectKey(k, key, add);
}

// The selected keyframes: [{ k, key }].
function selectedKeys() {
  const out = [];
  for (const k of tracks()) for (const key of anim.tracks[k]) if (tlSel.has(key)) out.push({ k, key });
  return out;
}

const isSelected = (k, key) => tlSel.has(key) || (keySel && keySel.k === k && Math.abs(keySel.t - key.t) < 1e-6);

// Moves the selected keyframes `items` ({ k, key, t0 }) by dt seconds,
// all together: kept within the animation and clear of other keyframes.
function moveKeys(items, dt) {
  const t0s = items.map((i) => i.t0);
  dt = Math.min(animLength() - Math.max(...t0s), Math.max(-Math.min(...t0s), dt));
  dt = Math.round(dt * KEY_FPS) / KEY_FPS;
  const moving = new Set(items.map((i) => i.key));
  const next = items.map((i) => Math.round((i.t0 + dt) * KEY_FPS) / KEY_FPS);
  const blocked = items.some((i, n) => anim.tracks[i.k].some((o) => !moving.has(o) && Math.abs(o.t - next[n]) < 0.5 / KEY_FPS));
  if (blocked) return;
  items.forEach((i, n) => {
    i.key.t = next[n];
  });
  for (const k of new Set(items.map((i) => i.k))) anim.tracks[k].sort((a, b) => a.t - b.t);
}

function selectedKey() {
  if (!keySel) return null;
  return anim.tracks[keySel.k].find((key) => Math.abs(key.t - keySel.t) < 1e-6) || null;
}

const fmtTime = (t) => `${t.toFixed(2)} s`;

// The part of the animation the timeline shows: from `start`, `span`
// seconds wide (span 0: all of it).
const tlView = { start: 0, span: 0 };

function viewWindow() {
  const len = animLength();
  const span = tlView.span > 0 ? Math.min(len, tlView.span) : len;
  const start = Math.min(Math.max(0, tlView.start), len - span);
  tlView.start = start;
  return { start, span };
}

// Zooms the timeline by `factor` (> 1 zooms in) around time `at`.
function zoomTimeline(factor, at) {
  const len = animLength();
  const { start, span } = viewWindow();
  const next = Math.min(len, Math.max(4 / KEY_FPS, span / factor));
  const pivot = at ?? Math.min(start + span, Math.max(start, playheadTime()));
  tlView.span = next >= len ? 0 : next;
  tlView.start = pivot - ((pivot - start) / span) * next;
  renderTimeline();
}

// Tick spacing that gives at most about ten labels.
function tickStep(span) {
  return [1 / KEY_FPS, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30].find((s) => span / s <= 10) || 60;
}

// Moves the playhead without redrawing the timeline (while playing).
function updatePlayhead() {
  if ($('timeline').hidden) return;
  const head = playheadTime();
  const { start, span } = viewWindow();
  for (const el of $('tl-grid').querySelectorAll('.tl-playhead')) {
    el.style.left = `${(100 * (head - start)) / span}%`;
    el.hidden = head < start - 1e-6 || head > start + span + 1e-6;
  }
  $('tl-time').textContent = `${fmtTime(head)} / ${fmtTime(animLength())}`;
  // The sidebar's arrows and diamonds follow the playhead.
  updateKeyButtons();
}

const CHEVRON_RIGHT = '<svg viewBox="0 0 10 10" width="9" height="9" aria-hidden="true"><path d="M3 1.5 6.5 5 3 8.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// A group's heading: open / close it, key all its tracks, and a summary of
// its keyframes (drag one to move every keyframe at that time).
// A group's heading (chevron, ◆ to key the whole group, name), the same in
// the Keyframes and Curves views.
function groupHeading(grp) {
  const label = Object.assign(document.createElement('div'), { className: `tl-label tl-group${grp.parent ? ' tl-section' : ''}` });
  if (!groupCollapsed(grp.id)) label.classList.add('open');
  const toggle = Object.assign(document.createElement('button'), { type: 'button', className: 'tl-chevron', innerHTML: CHEVRON_RIGHT, title: groupCollapsed(grp.id) ? 'Show its tracks' : 'Hide its tracks' });
  toggle.setAttribute('aria-expanded', String(!groupCollapsed(grp.id)));
  toggle.onclick = () => toggleGroup(grp.id);
  const name = Object.assign(document.createElement('span'), { className: 'tl-group-name', textContent: grp.name });
  name.onclick = () => toggleGroup(grp.id);
  const add = Object.assign(document.createElement('button'), { type: 'button', textContent: '◆', title: `Keyframe every ${grp.name} setting at the playhead` });
  add.onclick = () => {
    const t = Math.round(playheadTime() * KEY_FPS) / KEY_FPS;
    tlSel.clear();
    for (const k of grp.tracks) {
      setKey(anim, k, t, currentValue(k), KEY_FPS);
      selectAt(k, t, true);
    }
    saveAnimation();
  };
  label.append(toggle, add, name);
  label.dataset.group = grp.id;
  return label;
}

function groupRow(grp, { pos, inView, head }) {
  const label = groupHeading(grp);
  const track = Object.assign(document.createElement('div'), { className: 'tl-track tl-summary' });
  track.onpointerdown = (e) => {
    if (e.target.classList.contains('tl-playhead')) seekTimeline(e, track);
    else if (e.target === track) boxSelectKeys(e, track);
  };
  const times = new Map();
  for (const k of grp.tracks) {
    for (const key of anim.tracks[k]) {
      const t = Math.round(key.t * KEY_FPS);
      if (!times.has(t)) times.set(t, []);
      times.get(t).push({ k, key });
    }
  }
  for (const list of times.values()) {
    const t = list[0].key.t;
    if (!inView(t)) continue;
    const d = Object.assign(document.createElement('span'), { className: 'tl-key tl-sum', style: `left:${pos(t)}` });
    if (list.every((i) => isSelected(i.k, i.key))) d.classList.add('selected');
    d.title = `${grp.name}: ${list.length} keyframe${list.length > 1 ? 's' : ''} at ${fmtTime(t)}`;
    d.tlKeys = list;
    d.onpointerdown = (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!e.shiftKey) tlSel.clear();
      for (const i of list) tlSel.add(i.key);
      keySel = { k: list[0].k, t: list[0].key.t };
      if (e.shiftKey) {
        renderTimeline();
        return;
      }
      dragKey(e, list[0].k, list[0].key, track, { keep: true });
    };
    track.append(d);
  }
  const playhead = Object.assign(document.createElement('span'), { className: 'tl-playhead', style: `left:${pos(head)}` });
  playhead.hidden = !inView(head);
  track.append(playhead);
  return [label, track];
}

function renderTimeline() {
  updateKeyButtons();
  const on = keyEditorOn() && state.mode === 'camera';
  if ($('timeline').hidden === on) {
    $('timeline').hidden = !on;
    // The picture gets less (or more) room.
    layoutCanvas();
  }
  if (!on) return;
  const grid = $('tl-grid');
  const len = animLength();
  const { start, span } = viewWindow();
  const pos = (t) => `${(100 * (t - start)) / span}%`;
  const inView = (t) => t >= start - 1e-6 && t <= start + span + 1e-6;
  const head = playheadTime();
  const rows = [];
  const step = tickStep(span);
  const digits = step < 0.1 ? 2 : step < 1 ? 2 : 0;
  const ruler = Object.assign(document.createElement('div'), { className: 'tl-ruler' });
  for (let n = Math.ceil(start / step - 1e-6); n * step <= start + span + 1e-6; n++) {
    const t = n * step;
    // The last label would hang off the end.
    const label = t > start + span * 0.94 ? '' : `${+t.toFixed(digits)}s`;
    ruler.append(Object.assign(document.createElement('span'), { className: 'tl-tick', textContent: label, style: `left:${pos(t)}` }));
  }
  const rulerHead = Object.assign(document.createElement('span'), { className: 'tl-playhead', style: `left:${pos(head)}` });
  rulerHead.hidden = !inView(head);
  ruler.append(rulerHead);
  ruler.onpointerdown = (e) => seekTimeline(e, ruler);
  rows.push(Object.assign(document.createElement('div'), { className: 'tl-label tl-ruler-label' }), ruler);
  for (const grp of trackGroups()) {
    if (grp.off || (grp.parent && groupCollapsed(grp.parent))) continue;
    const shown = shownTracks(grp);
    if (!shown.length) continue;
    const heading = groupRow(grp, { pos, inView, head });
    for (const el of heading) el.dataset.group = grp.id;
    rows.push(...heading);
    if (groupCollapsed(grp.id) || grp.sections) continue;
    for (const k of shown) {
    const label = Object.assign(document.createElement('div'), { className: `tl-label tl-sub${grp.parent ? ' tl-deep' : ''}` });
    const add = Object.assign(document.createElement('button'), { type: 'button', textContent: '◆', title: `Keyframe ${trackTitle(k).toLowerCase()} at the playhead` });
    add.setAttribute('aria-label', `Add a ${trackTitle(k).toLowerCase()} keyframe`);
    add.onclick = () => {
      const t = Math.round(playheadTime() * KEY_FPS) / KEY_FPS;
      setKey(anim, k, t, currentValue(k), KEY_FPS);
      selectAt(k, t);
      saveAnimation();
    };
    label.append(add, document.createTextNode(trackName(k)));
    const track = Object.assign(document.createElement('div'), { className: 'tl-track' });
    track.onpointerdown = (e) => {
      if (e.target.classList.contains('tl-playhead')) seekTimeline(e, track);
      else if (e.target === track) boxSelectKeys(e, track);
    };
    for (const key of anim.tracks[k]) {
      if (!inView(key.t)) continue;
      const d = Object.assign(document.createElement('span'), { className: 'tl-key', style: `left:${pos(key.t)}` });
      if (isSelected(k, key)) d.classList.add('selected');
      d.tlKey = { k, key };
      if (key.ease.type === 'hold') d.classList.add('hold');
      d.title = `${trackTitle(k)} at ${fmtTime(key.t)}`;
      d.onpointerdown = (e) => dragKey(e, k, key, track);
      track.append(d);
    }
    const trackHead = Object.assign(document.createElement('span'), { className: 'tl-playhead', style: `left:${pos(head)}` });
    trackHead.hidden = !inView(head);
    track.append(trackHead);
    label.dataset.group = grp.id;
    track.dataset.group = grp.id;
    rows.push(label, track);
  }
  }
  grid.replaceChildren(...rows);
  const sel = selectedKey();
  $('tl-delete').disabled = !sel && !tlSel.size;
  $('tl-ease').disabled = !sel;
  if (sel) $('tl-ease').value = sel.ease.type;
  // The Curves view shows the handles on the curve itself.
  const box = !!(sel && sel.ease.type === 'custom') && !tlCurves.on;
  $('tl-curve').hidden = !box;
  if (box) drawCurve();
  $('tl-time').textContent = `${fmtTime(head)} / ${fmtTime(len)}`;
  $('tl-zoom-label').textContent = span >= len ? 'All' : `${Math.round((100 * len) / span)}%`;
  const scroll = $('tl-scroll');
  scroll.hidden = span >= len;
  scroll.max = String(Math.max(0, len - span));
  scroll.step = String(1 / KEY_FPS);
  scroll.value = String(start);
  const curves = tlCurves.on;
  $('tl-grid').hidden = curves;
  $('tl-curves').hidden = !curves;
  if (curves) drawCurves();
}

// The time under the pointer; `r` is the track's (or ruler's) box, taken
// when a drag starts since the timeline is redrawn as it goes.
function timeAt(e, r) {
  const { start, span } = viewWindow();
  const t = Math.min(animLength(), Math.max(0, start + ((e.clientX - r.left) / r.width) * span));
  return Math.round(t * KEY_FPS) / KEY_FPS;
}

// Click or drag on the ruler or a track: the playhead follows the pointer,
// showing the rendered frame there (or the animation's settings).
function seekTimeline(e, el, box) {
  e.preventDefault();
  const r = box || el.getBoundingClientRect();
  let last = -1;
  const seek = (ev) => {
    const t = timeAt(ev, r);
    if (t === last) return;
    last = t;
    seekTo(t);
  };
  const up = () => {
    window.removeEventListener('pointermove', seek);
    window.removeEventListener('pointerup', up);
    if (!state.frames.length) scheduleSave();
  };
  window.addEventListener('pointermove', seek);
  window.addEventListener('pointerup', up);
  seek(e);
}

// Moves the playhead to time t.
function seekTo(t) {
  state.keyTime = t;
  if (state.playing) setPlaying(false);
  if (state.frames.length) {
    const i = Math.min(state.frames.length - 1, Math.round(t * KEY_FPS));
    state.showingFrames = true;
    state.index = i;
    showFrame(i);
    // The slider follows the time (an animation of one frame stays on it).
    $('scrub').value = String(Math.round(t * KEY_FPS));
  } else {
    previewAt(t);
    $('scrub').value = String(Math.round(t * KEY_FPS));
  }
  renderTimeline();
  updateFrameLabel();
}

// Drag on an empty part of a track: select the keyframes in a box (Shift
// adds to the selection). A click without dragging moves the playhead
// there and clears the selection.
function boxSelectKeys(e, track) {
  e.preventDefault();
  const grid = $('tl-grid');
  const r = track.getBoundingClientRect();
  const x0 = e.clientX;
  const y0 = e.clientY;
  const base = e.shiftKey ? [...tlSel] : [];
  let box = null;
  const move = (ev) => {
    if (!box && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 4) return;
    const g = grid.getBoundingClientRect();
    if (!box) {
      box = Object.assign(document.createElement('div'), { className: 'tl-box' });
      grid.append(box);
    }
    const left = Math.min(x0, ev.clientX);
    const right = Math.max(x0, ev.clientX);
    const top = Math.min(y0, ev.clientY);
    const bottom = Math.max(y0, ev.clientY);
    Object.assign(box.style, { left: `${left - g.left}px`, top: `${top - g.top + grid.scrollTop}px`, width: `${right - left}px`, height: `${bottom - top}px` });
    tlSel.clear();
    for (const key of base) tlSel.add(key);
    keySel = null;
    for (const el of grid.querySelectorAll('.tl-key')) {
      const b = el.getBoundingClientRect();
      const cx = (b.left + b.right) / 2;
      const cy = (b.top + b.bottom) / 2;
      const inside = cx >= left && cx <= right && cy >= top && cy <= bottom;
      const keys = el.tlKeys ? el.tlKeys.map((i) => i.key) : [el.tlKey.key];
      if (inside) for (const key of keys) tlSel.add(key);
      el.classList.toggle('selected', keys.every((key) => tlSel.has(key)));
    }
  };
  const up = (ev) => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    if (box) {
      box.remove();
      const first = selectedKeys()[0];
      keySel = first ? { k: first.k, t: first.key.t } : null;
      renderTimeline();
    } else {
      if (!e.shiftKey) clearSelection();
      seekTo(timeAt(ev, r));
      if (!state.frames.length) scheduleSave();
    }
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

// Drag a keyframe along its track (with every other selected keyframe); a
// click without moving selects just it and shows its value. Shift-click
// adds it to the selection or takes it out.
function dragKey(e, k, key, track, { keep = false } = {}) {
  e.preventDefault();
  e.stopPropagation();
  if (e.shiftKey && !keep) {
    if (tlSel.has(key)) {
      tlSel.delete(key);
      const first = selectedKeys()[0];
      keySel = first ? { k: first.k, t: first.key.t } : null;
    } else {
      selectKey(k, key, true);
    }
    renderTimeline();
    return;
  }
  if (!tlSel.has(key)) selectKey(k, key);
  else keySel = { k, t: key.t };
  const startX = e.clientX;
  const r = track.getBoundingClientRect();
  const t0 = key.t;
  const items = selectedKeys().map((i) => ({ ...i, t0: i.key.t }));
  let moved = false;
  const move = (ev) => {
    if (!moved && Math.abs(ev.clientX - startX) < 3) return;
    moved = true;
    moveKeys(items, timeAt(ev, r) - t0);
    keySel = { k, t: key.t };
    renderTimeline();
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    if (moved) {
      saveAnimation();
    } else {
      if (!keep) selectKey(k, key);
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
  if (!sel && !tlSel.size) return;
  for (const k of tracks()) anim.tracks[k] = anim.tracks[k].filter((key) => key !== sel && !tlSel.has(key));
  clearSelection();
  saveAnimation();
}

$('tl-delete').onclick = deleteSelectedKey;
$('tl-zoom-in').onclick = () => zoomTimeline(2);
$('tl-zoom-out').onclick = () => zoomTimeline(0.5);
$('tl-zoom-label').onclick = () => {
  tlView.span = 0;
  renderTimeline();
};
$('tl-scroll').oninput = () => {
  tlView.start = +$('tl-scroll').value;
  renderTimeline();
};
// Ctrl / ⌘ + wheel zooms around the pointer; Shift + wheel (or a sideways
// swipe) scrolls along the animation.
$('tl-grid').parentElement.addEventListener('wheel', (e) => {
  const track = e.target.closest('.tl-track, .tl-ruler, .tl-plot');
  if (!track) return;
  if (e.ctrlKey || e.metaKey) {
    e.preventDefault();
    const r = track.classList.contains('tl-plot') ? plotBox() : track.getBoundingClientRect();
    const { start, span } = viewWindow();
    zoomTimeline(e.deltaY < 0 ? 1.25 : 0.8, start + ((e.clientX - r.left) / r.width) * span);
  } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
    e.preventDefault();
    const { span } = viewWindow();
    const d = e.shiftKey ? e.deltaY || e.deltaX : e.deltaX;
    tlView.start += (d / 400) * span;
    renderTimeline();
  }
}, { passive: false });
$('tl-key-all').onclick = () => {
  const t = Math.round(playheadTime() * KEY_FPS) / KEY_FPS;
  // Every track of the open groups.
  for (const g of trackGroups()) if (!g.off && !g.sections && !groupHidden(g)) for (const k of g.tracks) setKey(anim, k, t, currentValue(k), KEY_FPS);
  saveAnimation();
};
$('tl-ease').onchange = () => {
  const sel = selectedKey();
  const list = new Set([...selectedKeys().map((i) => i.key), ...(sel ? [sel] : [])]);
  if (!list.size) return;
  const type = $('tl-ease').value;
  for (const key of list) {
    // A custom curve starts from the one chosen before.
    if (type === 'custom' && key.ease.type !== 'custom' && PRESETS[key.ease.type]) key.ease.bezier = [...PRESETS[key.ease.type]];
    key.ease.type = type;
  }
  saveAnimation();
};
document.addEventListener('keydown', (e) => {
  if ($('timeline').hidden) return;
  // Not while typing (sliders, checkboxes and buttons may keep the focus).
  if (e.target.matches('textarea, select, input:not([type=range], [type=checkbox], [type=radio], [type=button])')) return;
  // Ctrl / ⌘ + A: select every keyframe.
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a' && state.mode === 'camera') {
    e.preventDefault();
    for (const k of tracks()) for (const key of anim.tracks[k]) tlSel.add(key);
    const first = selectedKeys()[0];
    keySel = first ? { k: first.k, t: first.key.t } : null;
    renderTimeline();
    return;
  }
  if (!keySel && !tlSel.size) return;
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
    g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--live');
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
  $('anim-length').value = kind === 'keyframes' ? frameCount(anim, KEY_FPS) : +$('frames').value;
  $('anim-length').max = String(Math.round(120 * KEY_FPS) + 1);
}

// Length in frames (as the play bar counts them).
$('anim-length').onchange = () => {
  const frames = Math.min(Math.round(120 * KEY_FPS) + 1, Math.max(2, Math.round(+$('anim-length').value) || 2));
  if ($('anim').value === 'keyframes') {
    anim.length = (frames - 1) / KEY_FPS;
    saveAnimation();
  } else {
    $('frames').value = frames;
    scheduleSave();
    animationSettingsChanged();
  }
  showAnimationLength();
  updateFrameLabel();
};

for (const id of ['frame-zoom', 'frame-pan-x', 'frame-pan-y']) {
  $(id).oninput = () => {
    showSliderValue($(id));
    if (state.lastImage) draw(state.lastImage);
  };
  $(id).onchange = () => {
    autoKey();
    scheduleSave();
  };
}

// Values of every track at every frame: camera settings for the worker and
// framing for drawing.
function keyframeFrames() {
  if (!hasKeys(anim)) return null;
  const live = { aperture: F_STOPS[+$('fstop').value] ?? 2, depth: +$('dof-depth').value, focus: +$('focus').value };
  const path = [];
  const frames = [];
  const maskTracks = tracks().filter((k) => isMaskTrack(k) && anim.tracks[k].length);
  // Keyframed Process and Optics sliders: each frame carries its color
  // settings.
  const colorKeyed = tracks().some((k) => isSettingTrack(k) && anim.tracks[k].length);
  for (const v of sample(anim, KEY_FPS)) {
    // Local adjustment settings this frame: { id: { attr: value } }.
    let masks = null;
    for (const k of maskTracks) {
      if (v[k] === undefined) continue;
      const { id, attr } = parseMaskTrack(k);
      masks = masks || {};
      (masks[id] = masks[id] || {})[attr] = v[k];
    }
    const lens = apertureFor(v.aperture ?? live.aperture);
    const depth = v.depth ?? live.depth;
    const view = v.view ?? [state.camera.u, state.camera.v];
    path.push({ u: view[0], v: view[1], alpha: v.focus ?? live.focus, aperture: lens.aperture, dof: lens.dof * 4 ** (-depth / 50), masks, pivot: v.pivot ?? null, bokeh: bokehParams(v),
      color: colorKeyed ? colorSettings((id) => v[`set:${id}`] ?? +$(id).value) : null });
    const z = v.zoom ?? +$('frame-zoom').value / 100;
    const panX = v.panX ?? +$('frame-pan-x').value / 100;
    const panY = v.panY ?? +$('frame-pan-y').value / 100;
    frames.push(framing(z, panX, panY));
  }
  return { path, framing: frames };
}

// ---------------------------------------------------------------- curves view

// The keyframe editor's Curves view (like Blender's Graph Editor): each
// setting as a curve over time, each part of a viewpoint
// separately, each fitted to the height of the view. Drag a keyframe to
// change its time and value; drag anywhere else to move the playhead.

const CHANNELS = [
  { k: 'focus', c: 0, name: 'Focus', color: '#4fc3f7' },
  { k: 'aperture', c: 0, name: 'Aperture', color: '#ffb74d' },
  { k: 'depth', c: 0, name: 'Depth', color: '#ba68c8' },
  { k: 'view', c: 0, name: 'Viewpoint X', color: '#ef5350' },
  { k: 'view', c: 1, name: 'Viewpoint Y', color: '#66bb6a' },
  { k: 'zoom', c: 0, name: 'Zoom', color: '#fff176' },
  { k: 'panX', c: 0, name: 'Pan X', color: '#f48fb1' },
  { k: 'panY', c: 0, name: 'Pan Y', color: '#aed581' },
  { k: 'pivot', c: 0, name: 'Pivot depth', color: '#90caf9' },
  { k: 'pointX', c: 0, name: 'Focus point X', color: '#4dd0e1' },
  { k: 'pointY', c: 0, name: 'Focus point Y', color: '#9ccc65' },
  { k: 'spread', c: 0, name: 'Spread', color: '#7986cb' },
  { k: 'spreadSmooth', c: 0, name: 'Smoothing', color: '#4db6ac' },
  { k: 'tilt', c: 0, name: 'Tilt', color: '#ff8a65' },
  { k: 'tiltRotation', c: 0, name: 'Rotation', color: '#a1887f' },
  { k: 'highlights', c: 0, name: 'Highlights', color: '#f06292' },
  { k: 'amount', c: 0, name: 'Amount', color: '#4fc3f7' },
  { k: 'near', c: 0, name: 'Near', color: '#ba68c8' },
  { k: 'far', c: 0, name: 'Far', color: '#81c784' },
];
const channelId = (ch) => `${ch.k}.${ch.c}`;
const MASK_COLORS = ['#ff8a65', '#4db6ac', '#9575cd', '#e0e0e0', '#81c784', '#64b5f6', '#ffd54f', '#f06292', '#a1887f', '#90a4ae', '#ce93d8'];

// The Curves view's channels, by group (a viewpoint is two).
function channelList() {
  const out = [];
  for (const grp of trackGroups()) {
    if (grp.off) continue;
    if (grp.sections) continue;
    const shown = shownTracks(grp);
    for (const k of shown) {
      // Named channels (a viewpoint is two); the others colored by place in
      // the group, so a curve keeps its color when others are hidden.
      const named = CHANNELS.filter((ch) => ch.k === k);
      if (named.length) out.push(...named.map((ch) => ({ ...ch, group: grp })));
      else out.push({ k, c: 0, name: trackName(k), color: MASK_COLORS[grp.tracks.indexOf(k) % MASK_COLORS.length], group: grp });
    }
  }
  return out;
}
// Room at the plot's sides so keyframes at the ends show whole.
const PLOT_PAD = 8;

// The plot's time axis on screen (its box without the side room).
function plotBox() {
  const r = $('tl-plot').getBoundingClientRect();
  return { left: r.left + PLOT_PAD, top: r.top, width: r.width - 2 * PLOT_PAD, height: r.height };
}

// A channel's value as plotted (aperture in f-stops: log scale).
function channelValue(ch, v) {
  const x = Array.isArray(v) ? v[ch.c] : v;
  return ch.k === 'aperture' ? Math.log2(x) : x;
}

function channelRange(ch) {
  let lo = Infinity;
  let hi = -Infinity;
  for (const key of anim.tracks[ch.k]) {
    const y = channelValue(ch, key.v);
    lo = Math.min(lo, y);
    hi = Math.max(hi, y);
  }
  if (!(hi > lo)) {
    lo -= 0.5;
    hi += 0.5;
  }
  const pad = (hi - lo) * 0.12;
  return [lo - pad, hi + pad];
}

// The limits each channel's value is kept within.
function channelLimits(ch) {
  if (isSettingTrack(ch.k)) return [+settingControl(ch.k).min, +settingControl(ch.k).max];
  if (isMaskTrack(ch.k)) return MASK_LIMITS[parseMaskTrack(ch.k).attr] || [-1, 1];
  const r = (state.info && state.info.radius) || 4.5;
  switch (ch.k) {
    case 'aperture': return [Math.log2(Math.min(...F_STOPS)), Math.log2(Math.max(...F_STOPS))];
    case 'depth': return [-100, 100];
    case 'focus': return [-2, 2];
    case 'view': return [-r, r];
    case 'zoom': return [1, 3];
    case 'pivot': return [-100, 100];
    case 'pointX':
    case 'pointY':
    case 'highlights': return [0, 1];
    case 'spread':
    case 'spreadSmooth': return [0, 100];
    case 'tilt': return [-100, 100];
    case 'tiltRotation': return [-90, 90];
    case 'amount': return [0.1, 1];
    case 'near': return [-1.6, 0];
    case 'far': return [0, 1.6];
    default: return [-1, 1];
  }
}

function setChannelValue(ch, key, y) {
  const [lo, hi] = channelLimits(ch);
  y = Math.min(hi, Math.max(lo, y));
  const x = ch.k === 'aperture' ? 2 ** y : y;
  if (Array.isArray(key.v)) {
    key.v = [...key.v];
    key.v[ch.c] = x;
  } else {
    key.v = x;
  }
}

function renderChannels() {
  const rows = [];
  let group = null;
  let parent = null;
  const groups = trackGroups();
  for (const ch of channelList()) {
    const p = ch.group.parent || null;
    if (p && p !== parent) rows.push(groupHeading(groups.find((g) => g.id === p)));
    parent = p;
    if (p && groupCollapsed(p)) continue;
    if (ch.group !== group) {
      group = ch.group;
      const g = group;
      rows.push(groupHeading(g));
    }
    if (groupCollapsed(ch.group.id)) continue;
    const id = channelId(ch);
    const row = Object.assign(document.createElement('label'), { className: 'tl-channel' });
    if (!anim.tracks[ch.k].length) row.classList.add('empty');
    const box = Object.assign(document.createElement('input'), { type: 'checkbox', checked: !tlCurves.hidden.has(id) });
    box.onchange = () => {
      if (box.checked) tlCurves.hidden.delete(id);
      else tlCurves.hidden.add(id);
      drawCurves();
    };
    const sw = Object.assign(document.createElement('span'), { className: 'tl-swatch' });
    sw.style.background = ch.color;
    row.append(box, sw, document.createTextNode(ch.name));
    row.dataset.group = ch.group.id;
    rows.push(row);
  }
  $('tl-channels').replaceChildren(...rows);
}

function drawCurves() {
  const c = $('tl-plot');
  const dpr = window.devicePixelRatio || 1;
  const cssW = c.clientWidth || 600;
  const cssH = c.clientHeight || 200;
  if (c.width !== Math.round(cssW * dpr) || c.height !== Math.round(cssH * dpr)) {
    c.width = Math.round(cssW * dpr);
    c.height = Math.round(cssH * dpr);
  }
  renderChannels();
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, cssW, cssH);
  const { start, span } = viewWindow();
  const top = 18;
  const bottom = cssH - 6;
  const plotW = cssW - 2 * PLOT_PAD;
  const xOf = (t) => PLOT_PAD + ((t - start) / span) * plotW;
  // Time grid and labels.
  const step = tickStep(span);
  g.font = '10px system-ui, sans-serif';
  g.textBaseline = 'top';
  for (let n = Math.ceil(start / step - 1e-6); n * step <= start + span + 1e-6; n++) {
    const t = n * step;
    const x = Math.round(xOf(t)) + 0.5;
    g.strokeStyle = 'rgba(255,255,255,0.07)';
    g.beginPath();
    g.moveTo(x, top - 4);
    g.lineTo(x, cssH);
    g.stroke();
    g.fillStyle = 'rgba(255,255,255,0.45)';
    if (t < start + span * 0.94) g.fillText(`${+t.toFixed(step < 1 ? 2 : 0)}s`, x + 3, 3);
  }
  tlCurves.hits = [];
  const sel = selectedKey();
  for (const ch of channelList()) {
    const keys = anim.tracks[ch.k];
    if (!keys.length || groupHidden(ch.group) || tlCurves.hidden.has(channelId(ch))) continue;
    const [lo, hi] = tlCurves.drag && tlCurves.drag.id === channelId(ch) ? tlCurves.drag.range : channelRange(ch);
    const yOf = (y) => bottom - ((y - lo) / (hi - lo)) * (bottom - top);
    // The curve, sampled every two pixels.
    g.strokeStyle = ch.color;
    g.lineWidth = 1.5;
    g.beginPath();
    for (let x = 0; x <= cssW + 2; x += 2) {
      const t = Math.min(animLength(), Math.max(0, start + ((x - PLOT_PAD) / plotW) * span));
      const y = yOf(channelValue(ch, valueAt(anim, ch.k, t)));
      if (x === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    }
    g.stroke();
    // Keyframes.
    for (const key of keys) {
      const x = xOf(key.t);
      const y = yOf(channelValue(ch, key.v));
      if (x < -6 || x > cssW + 6) continue;
      const on = key === sel || tlSel.has(key);
      if (on) {
        // Selected: a bright ring around a white key.
        g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--key-selected');
        g.beginPath();
        g.arc(x, y, 7, 0, 2 * Math.PI);
        g.fill();
      }
      g.fillStyle = on ? '#fff' : ch.color;
      g.strokeStyle = '#15181c';
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(x, y - 3.5);
      g.lineTo(x + 3.5, y);
      g.lineTo(x, y + 3.5);
      g.lineTo(x - 3.5, y);
      g.closePath();
      g.fill();
      g.stroke();
      tlCurves.hits.push({ x, y, ch, key, range: [lo, hi] });
    }
    // The selected keyframe's handles: where the curve leaves it and where
    // it arrives, as in Blender.
    const i = sel && keySel.k === ch.k ? keys.indexOf(sel) : -1;
    if (i >= 0) {
      for (const hd of keyHandles(ch, i)) {
        const hx = xOf(hd.t);
        const hy = yOf(hd.y);
        const kx = xOf(sel.t);
        const ky = yOf(channelValue(ch, sel.v));
        g.strokeStyle = 'rgba(255,255,255,0.75)';
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(kx, ky);
        g.lineTo(hx, hy);
        g.stroke();
        g.fillStyle = '#fff';
        g.strokeStyle = '#15181c';
        g.beginPath();
        g.arc(hx, hy, 3, 0, 2 * Math.PI);
        g.fill();
        g.stroke();
        tlCurves.hits.push({ x: hx, y: hy, ch, key: sel, handle: hd, range: [lo, hi] });
      }
    }
  }
  if (tlCurves.box) {
    const b = tlCurves.box;
    g.fillStyle = 'rgba(200, 205, 213, 0.08)';
    g.strokeStyle = 'rgba(200, 205, 213, 0.7)';
    g.setLineDash([4, 3]);
    g.lineWidth = 1;
    g.fillRect(b.x, b.y, b.w, b.h);
    g.strokeRect(b.x + 0.5, b.y + 0.5, b.w, b.h);
    g.setLineDash([]);
  }
  // Playhead.
  const head = playheadTime();
  if (head >= start && head <= start + span) {
    const x = Math.round(xOf(head)) + 0.5;
    g.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--live');
    g.lineWidth = 1.5;
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x, cssH);
    g.stroke();
  }
}

// Handles of keyframe i on a channel: { seg, end, t, y } for the curve
// leaving it (end 1 of segment i) and arriving at it (end 2 of i - 1).
function keyHandles(ch, i) {
  const keys = anim.tracks[ch.k];
  const out = [];
  const val = (key) => channelValue(ch, key.v);
  const after = segmentBezier(anim, ch.k, i, ch.c);
  if (after) {
    const a = keys[i];
    const b = keys[i + 1];
    out.push({ seg: i, end: 1, t: a.t + after[0] * (b.t - a.t), y: val(a) + after[1] * (val(b) - val(a)) });
  }
  const before = i > 0 ? segmentBezier(anim, ch.k, i - 1, ch.c) : null;
  if (before) {
    const a = keys[i - 1];
    const b = keys[i];
    out.push({ seg: i - 1, end: 2, t: a.t + before[2] * (b.t - a.t), y: val(a) + before[3] * (val(b) - val(a)) });
  }
  return out;
}

// Drags a handle of the selected keyframe: the segment becomes a custom
// curve, and the handle on the other side turns with it so the curve stays
// smooth through the keyframe.
function dragHandle(e, hit, r) {
  e.preventDefault();
  const { ch, handle } = hit;
  const keys = anim.tracks[ch.k];
  const i = keys.indexOf(hit.key);
  const [lo, hi] = hit.range;
  const top = 18;
  const bottom = r.height - 6;
  const { start, span } = viewWindow();
  const val = (key) => channelValue(ch, key.v);
  // Both curves at the keyframe become custom, starting as they look now.
  for (const seg of [i - 1, i]) {
    if (seg < 0 || seg >= keys.length - 1 || keys[seg].ease.type === 'hold') continue;
    keys[seg].ease = { type: 'custom', bezier: segmentBezier(anim, ch.k, seg, ch.c) };
  }
  tlCurves.drag = { id: channelId(ch), range: hit.range };
  const other = keyHandles(ch, i).find((h) => h.end !== handle.end);
  const move = (ev) => {
    const t = start + ((ev.clientX - r.left) / r.width) * span;
    const y = lo + ((bottom - (ev.clientY - r.top)) / (bottom - top)) * (hi - lo);
    const k0 = keys[handle.seg];
    const k1 = keys[handle.seg + 1];
    const d = val(k1) - val(k0);
    const bz = k0.ease.bezier;
    const x = Math.min(1, Math.max(0, (t - k0.t) / (k1.t - k0.t)));
    const at = handle.end === 1 ? 0 : 2;
    bz[at] = x;
    if (Math.abs(d) > 1e-9) bz[at + 1] = (y - val(k0)) / d;
    // Aligned: the other handle keeps its length in time and takes the
    // same slope through the keyframe.
    const key = keys[i];
    const dt = handle.end === 1 ? bz[0] * (k1.t - k0.t) : (1 - bz[2]) * (k1.t - k0.t);
    const dy = handle.end === 1 ? bz[1] * d : (1 - bz[3]) * d;
    if (other && dt > 1e-9) {
      const slope = dy / dt;
      const o0 = keys[other.seg];
      const o1 = keys[other.seg + 1];
      const od = val(o1) - val(o0);
      const obz = o0.ease.bezier;
      if (Math.abs(od) > 1e-9) {
        if (other.end === 2) {
          const odt = (1 - obz[2]) * (o1.t - o0.t);
          obz[3] = (val(key) - slope * odt - val(o0)) / od;
        } else {
          const odt = obz[0] * (o1.t - o0.t);
          obz[1] = (slope * odt) / od;
        }
      }
    }
    renderTimeline();
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    tlCurves.drag = null;
    saveAnimation();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

function setCurvesView(on) {
  // The curves take the room the tracks had: switching views keeps the
  // editor's height.
  const tracks = $('tl-grid').offsetHeight;
  if (on && tracks) $('timeline').style.setProperty('--tl-natural', `${tracks}px`);
  tlCurves.on = on;
  $('tl-view-keys').classList.toggle('active', !on);
  $('tl-view-curves').classList.toggle('active', on);
  $('tl-view-keys').setAttribute('aria-pressed', String(!on));
  $('tl-view-curves').setAttribute('aria-pressed', String(on));
  renderTimeline();
  layoutCanvas();
}
// Drag the editor's top edge to make it taller or shorter (the picture
// gets the rest); a double-click goes back to the natural height.
// `h`: the height of the tracks in pixels, down to 0 (only the editor's
// toolbar shows), or null for their natural height.
function setTimelineHeight(h) {
  const tl = $('timeline');
  const sized = Number.isFinite(h) && h >= 0;
  tl.classList.toggle('sized', sized);
  // All the way down: only the toolbar.
  tl.classList.toggle('collapsed', sized && h === 0);
  if (sized) tl.style.setProperty('--tl-h', `${h}px`);
  else tl.style.removeProperty('--tl-h');
  try {
    if (sized) localStorage.setItem('illuminator.timelineHeight', String(h));
    else localStorage.removeItem('illuminator.timelineHeight');
  } catch {
    // Not kept between sessions then.
  }
  layoutCanvas();
  if (tlCurves.on && !tl.hidden) drawCurves();
}
$('tl-resize').addEventListener('pointerdown', (e) => {
  e.preventDefault();
  const handle = $('tl-resize');
  const startY = e.clientY;
  const startH = document.querySelector('.tl-main').getBoundingClientRect().height;
  handle.classList.add('dragging');
  // As tall as every track needs, as long as an 80px strip of the picture
  // (and the bars around the editor) stays in view. Measured once: while
  // dragging, the layout is changing under the pointer.
  const stage = document.querySelector('.stage').getBoundingClientRect().height;
  const h = (el) => (el ? el.getBoundingClientRect().height : 0);
  const others = h(document.querySelector('.modes-row')) + h(document.querySelector('.transport')) + h($('timeline')) - startH;
  const max = Math.max(120, stage - others - 80);
  const move = (ev) => {
    setTimelineHeight(Math.round(Math.min(max, Math.max(0, startH - (ev.clientY - startY)))));
  };
  const up = () => {
    handle.classList.remove('dragging');
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
});
$('tl-resize').ondblclick = () => setTimelineHeight(null);

// The right sidebar's width: drag its left edge (double-click for the
// normal width). Remembered between sessions.
function setSidebarWidth(w) {
  const side = $('controls');
  if (w === null) side.style.removeProperty('width');
  else side.style.width = `${Math.round(w)}px`;
  layoutCanvas();
  try {
    if (w === null) localStorage.removeItem('illuminator.sidebarWidth');
    else localStorage.setItem('illuminator.sidebarWidth', String(Math.round(w)));
  } catch {
    // Not remembered; it still applies now.
  }
}
$('controls-resize').addEventListener('pointerdown', (e) => {
  e.preventDefault();
  const handle = $('controls-resize');
  const startX = e.clientX;
  const startW = $('controls').getBoundingClientRect().width;
  // Room is kept for the picture.
  const max = Math.max(280, Math.min(640, window.innerWidth - 520));
  handle.classList.add('dragging');
  let frame = 0;
  const move = (ev) => {
    const w = Math.min(max, Math.max(260, startW - (ev.clientX - startX)));
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => setSidebarWidth(w));
  };
  const up = () => {
    handle.classList.remove('dragging');
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
});
$('controls-resize').ondblclick = () => setSidebarWidth(null);
try {
  const saved = +localStorage.getItem('illuminator.sidebarWidth');
  if (saved >= 260) $('controls').style.width = `${Math.min(640, saved)}px`;
} catch {
  // Storage unavailable: the normal width.
}
try {
  const saved = localStorage.getItem('illuminator.timelineHeight');
  const h = saved === null ? NaN : +saved;
  if (h >= 0) {
    $('timeline').classList.add('sized');
    $('timeline').classList.toggle('collapsed', h === 0);
    $('timeline').style.setProperty('--tl-h', `${h}px`);
  }
} catch {
  // Natural height.
}
$('tl-view-keys').onclick = () => setCurvesView(false);
$('tl-view-curves').onclick = () => setCurvesView(true);

$('tl-plot').addEventListener('pointerdown', (e) => {
  const c = $('tl-plot');
  const r = plotBox();
  const px = e.clientX - r.left + PLOT_PAD;
  const py = e.clientY - r.top;
  let hit = null;
  let best = 8;
  for (const h of tlCurves.hits) {
    const d = Math.hypot(h.x - px, h.y - py);
    if (d < best) {
      best = d;
      hit = h;
    }
  }
  if (!hit) {
    // Along the time labels: scrub. Elsewhere: box select.
    if (py < 18) seekTimeline(e, c, r);
    else boxSelectCurves(e, r);
    return;
  }
  if (hit.handle) {
    dragHandle(e, hit, r);
    return;
  }
  e.preventDefault();
  const { ch, key } = hit;
  if (e.shiftKey) {
    if (tlSel.has(key)) {
      tlSel.delete(key);
      const first = selectedKeys()[0];
      keySel = first ? { k: first.k, t: first.key.t } : null;
    } else {
      selectKey(ch.k, key, true);
    }
    renderTimeline();
    return;
  }
  const id = channelId(ch);
  const startX = e.clientX;
  const startY = e.clientY;
  const top = 18;
  const bottom = r.height - 6;
  // The value scale stays put while dragging.
  tlCurves.drag = { id, range: hit.range };
  if (!tlSel.has(key)) selectKey(ch.k, key);
  else keySel = { k: ch.k, t: key.t };
  const t0 = key.t;
  // Every selected keyframe moves in time; those on this curve also move
  // up or down by the same amount.
  const items = selectedKeys().map((i) => ({ ...i, t0: i.key.t, y0: i.k === ch.k ? channelValue(ch, i.key.v) : null }));
  let moved = false;
  const move = (ev) => {
    if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 3) return;
    moved = true;
    moveKeys(items, timeAt(ev, r) - t0);
    const [lo, hi] = hit.range;
    const dy = -((ev.clientY - startY) / (bottom - top)) * (hi - lo);
    for (const i of items) if (i.y0 !== null) setChannelValue(ch, i.key, i.y0 + dy);
    keySel = { k: ch.k, t: key.t };
    renderTimeline();
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    tlCurves.drag = null;
    if (moved) {
      saveAnimation();
    } else {
      selectKey(ch.k, key);
      state.keyTime = key.t;
      showValue(ch.k, key.v);
    }
    renderTimeline();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  renderTimeline();
});
window.addEventListener('resize', () => {
  if (tlCurves.on && !$('timeline').hidden) drawCurves();
});

// Box select in the Curves view (Shift adds); a click without dragging
// moves the playhead and clears the selection.
function boxSelectCurves(e, r) {
  e.preventDefault();
  const c = $('tl-plot');
  const cr = c.getBoundingClientRect();
  const x0 = e.clientX - cr.left;
  const y0 = e.clientY - cr.top;
  const base = e.shiftKey ? [...tlSel] : [];
  const move = (ev) => {
    const x1 = ev.clientX - cr.left;
    const y1 = ev.clientY - cr.top;
    if (!tlCurves.box && Math.hypot(x1 - x0, y1 - y0) < 4) return;
    const b = { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
    tlCurves.box = b;
    tlSel.clear();
    for (const key of base) tlSel.add(key);
    for (const h of tlCurves.hits) {
      if (h.handle) continue;
      if (h.x >= b.x && h.x <= b.x + b.w && h.y >= b.y && h.y <= b.y + b.h) tlSel.add(h.key);
    }
    const first = selectedKeys()[0];
    keySel = first ? { k: first.k, t: first.key.t } : null;
    drawCurves();
  };
  const up = (ev) => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    if (tlCurves.box) {
      tlCurves.box = null;
      renderTimeline();
    } else {
      if (!e.shiftKey) clearSelection();
      seekTo(timeAt(ev, r));
      if (!state.frames.length) scheduleSave();
    }
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

// ---------------------------------------------------------------- frame rate

const FPS_PRESETS = ['23.976', '24', '25', '29.97', '30', '48', '50', '59.94', '60'];

// Shows the frame rate setting (#fps) in the preset list, or as custom.
function showFrameRate() {
  const fps = Math.min(240, Math.max(1, +$('fps').value || DEFAULT_FPS));
  const preset = FPS_PRESETS.find((p) => Math.abs(+p - fps) < 1e-3);
  if (!state.customFps || !preset) $('fps-preset').value = preset || 'custom';
  $('fps-custom').hidden = $('fps-preset').value !== 'custom';
  KEY_FPS = fps;
  state.fps = fps;
}

function setFrameRate(fps) {
  // A viewpoint path or focus sweep keeps its length in seconds.
  const seconds = +$('frames').value / KEY_FPS;
  $('fps').value = String(+(+fps).toFixed(3));
  showFrameRate();
  $('frames').value = Math.max(2, Math.round(seconds * KEY_FPS));
  scheduleSave();
  animationSettingsChanged();
  showAnimationLength();
  renderTimeline();
  updateFrameLabel();
}

$('fps-preset').onchange = () => {
  const v = $('fps-preset').value;
  state.customFps = v === 'custom';
  if (state.customFps) {
    $('fps-custom').hidden = false;
    $('fps').focus();
    return;
  }
  setFrameRate(+v);
};
$('fps').onchange = () => setFrameRate(Math.min(240, Math.max(1, +$('fps').value || DEFAULT_FPS)));

// ---------------------------------------------------------------- 3D

// Show 3D: the live picture in the chosen 3D type.
function stereoShown() {
  return $('stereo-on').checked && !!(state.info && state.info.hasRaw);
}

function eyeOffset() {
  return (state.info.radius || 4.5) * (+$('stereo-baseline').value / 100);
}

// One eye's render settings. At a wide aperture every view would use the
// whole lens and both eyes would match, so each eye looks through its own
// smaller part of the aperture.
function eyeParams(p, u) {
  return { ...p, u, aperture: Math.min(p.aperture || 1, 0.5) };
}

// The live 3D picture in the chosen 3D type: an anaglyph, or both eyes
// side by side (drawn by drawPair).
async function stereoPreview(p) {
  const b = eyeOffset();
  const imgs = [];
  for (const u of [p.u - b, p.u + b]) {
    const msg = await engine.request('view', eyeParams(p, u), { onProgress: showProgress });
    if (!msg || !(msg.pixels || msg.bitmap)) return null;
    imgs.push(toImageData(msg));
  }
  const [L, R] = imgs.map((img) => {
    if (img instanceof ImageData) return img;
    const c = Object.assign(document.createElement('canvas'), { width: img.width, height: img.height });
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    return g.getImageData(0, 0, img.width, img.height);
  });
  const mode = $('stereo-mode').value;
  if (mode !== 'anaglyph') return { pair: [L, R], mode, width: L.width, height: L.height };
  const out = new ImageData(new Uint8ClampedArray(R.data), R.width, R.height);
  for (let i = 0; i < out.data.length; i += 4) out.data[i] = 0.299 * L.data[i] + 0.587 * L.data[i + 1] + 0.114 * L.data[i + 2];
  return out;
}

$('stereo-on').onchange = () => {
  if (state.showingFrames) backToCamera();
  setFullRes(false, { restore: false });
  refresh();
};
$('stereo-mode').addEventListener('change', () => {
  if (stereoShown()) refresh();
});
$('stereo-baseline').addEventListener('input', () => {
  if (stereoShown()) refresh();
});

// A stereo pair from two viewpoints across the lens aperture: anaglyph
// (red / cyan glasses), side by side (parallel viewing) or cross-eyed.
// Crop, rotation and the pivot apply to both eyes alike.
async function saveStereo() {
  if (!canRender() || !state.info.hasRaw) return;
  $('stereo-btn').disabled = true;
  try {
    const p = cameraParams();
    const b = eyeOffset();
    const eyes = [p.u - b, p.u + b];
    const shots = [];
    for (const u of eyes) {
      showProgress('Rendering 3D', shots.length / 2);
      const msg = await engine.request('view', eyeParams(p, u), { onProgress: () => {} });
      shots.push(toImageData(msg));
    }
    const pivots = withPivotZoom(eyes.map((u) => pivotFor(u, p.v, p.alpha, eyeParams(p, u).aperture)));
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
    savePhoto(out, `${baseName()}-3d-${mode}`);
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
  const fx = (o) => ({ exposure: 0, contrast: 0, saturation: 0, temperature: 0, tint: 0, blur: 0, pixelate: 0, sketch: 0, ...o });
  // Depth filters follow the focus: animate it and they move with it.
  const depth = (near, far, feather, invert, effect) => ({ ...defaultMask('depth'), near, far, feather, invert, follow: true, anchor: f, fx: fx(effect) });
  switch (name) {
    case 'pop': // in focus keeps its color, the rest goes gray
      return [depth(f - 0.25, f + 0.25, 0.2, true, { saturation: -1 })];
    case 'spotlight': // darker away from the focus point
      return [{ ...defaultMask('radial'), x: state.focusPoint.x, y: state.focusPoint.y, w: 0.35, h: 0.35, feather: 0.7, invert: true, fx: fx({ exposure: -1.2 }) }];
    case 'haze': // farther away is paler and softer, like air
      return [depth(f + 0.2, 1.8, 0.6, false, { exposure: 0.35, contrast: -0.5, saturation: -0.45, temperature: -0.15 })];
    case 'dreamy': // what is not in focus glows a little
      return [depth(f - 0.2, f + 0.2, 0.25, true, { exposure: 0.4, contrast: -0.4, saturation: -0.2, temperature: 0.15 })];
    case 'noir': // hard black and white, the subject lit a little brighter
      return [
        { ...defaultMask('depth'), near: -3, far: 3, feather: 0.2, fx: fx({ saturation: -1, contrast: 0.55, exposure: -0.15 }) },
        depth(f - 0.2, f + 0.2, 0.2, false, { exposure: 0.35 }),
      ];
    case 'melancholy': // everything but the subject goes muted and blue
      return [depth(f - 0.25, f + 0.25, 0.25, true, { saturation: -0.6, temperature: -0.5, exposure: -0.2, contrast: -0.15 })];
    case 'carnival': // the background turns bright and festive
      return [depth(f - 0.2, f + 0.2, 0.2, true, { saturation: 0.85, temperature: 0.25, tint: 0.2, contrast: 0.2 })];
    case 'pinhole': // a deep vignette that shifts with the viewpoint
      return [{ ...defaultMask('radial'), x: 0.5, y: 0.5, w: 0.48, h: 0.48, feather: 0.85, invert: true, followView: true, fx: fx({ exposure: -1.8, saturation: -0.25 }) }];
    case 'blurplus': // what is out of focus goes softer still
      return [depth(f - 0.15, f + 0.15, 0.25, true, { blur: 0.6 })];
    case 'mosaic': // what is out of focus breaks into tiles
      return [depth(f - 0.15, f + 0.15, 0.15, true, { pixelate: 0.5 })];
    case 'crayon': // what is out of focus turns into a colored-pencil drawing
      return [depth(f - 0.15, f + 0.15, 0.2, true, { sketch: 0.9 })];
    case 'golden': // warm, glowing light on the far background
      return [depth(f + 0.15, 1.8, 0.5, false, { temperature: 0.6, exposure: 0.2, saturation: 0.2, contrast: -0.15 })];
    default:
      return [];
  }
}

$('mask-filter').onchange = () => {
  const added = livingFilter($('mask-filter').value);
  // Named after the filter (its group in the keyframe editor, too).
  const name = ($('mask-filter').selectedOptions[0] || {}).textContent || '';
  for (const m of added) m.name = name.trim();
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
  renderTimeline();
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

// Saved photos and 3D images are enlarged by Render Settings > Photo >
// Size, and video frames to Video > Size, both with Upscaling.
function upscaleSettings() {
  return { method: $('upscale-method').value, sharpen: +$('upscale-sharpen').value / 100 };
}

function enlargeForSave(source) {
  const k = +$('photo-size').value || 1;
  if (k === 1) return source;
  return upscaleImage(source, Math.round(source.width * k), Math.round(source.height * k), upscaleSettings());
}

// Photo > File format: PNG, or JPEG at its quality.
function savePhoto(source, name) {
  const jpeg = $('photo-format').value === 'jpeg';
  const type = jpeg ? 'image/jpeg' : 'image/png';
  enlargeForSave(source).toBlob((blob) => download(blob, `${name}.${jpeg ? 'jpg' : 'png'}`), type, jpeg ? +$('photo-quality').value / 100 : undefined);
}

function showPhotoFormat() {
  const jpeg = $('photo-format').value === 'jpeg';
  $('photo-quality-row').hidden = !jpeg;
  $('png-btn').textContent = jpeg ? 'Save JPEG' : 'Save PNG';
}
$('photo-format').addEventListener('change', showPhotoFormat);
$('photo-quality').oninput = () => showSliderValue($('photo-quality'));
$('photo-quality').ondblclick = () => {
  $('photo-quality').value = $('photo-quality').dataset.default;
  showSliderValue($('photo-quality'));
  scheduleSave();
};

function savePng() {
  try {
    savePhoto(canvas, baseName());
  } catch (err) {
    showError(err);
  }
}
// Video: the compression kinds of the chosen file format, those this
// browser cannot record marked and disabled.
const canRecord = (t) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t);
function showVideoCodecs() {
  for (const o of $('video-format').options) {
    const ok = VIDEO_FORMATS[o.value].codecs.some((c) => videoType(o.value, c, canRecord));
    o.disabled = !ok;
    o.textContent = VIDEO_FORMATS[o.value].name + (ok ? '' : ' (not available here)');
  }
  if ($('video-format').selectedOptions[0].disabled) {
    const usable = [...$('video-format').options].find((o) => !o.disabled);
    if (usable) $('video-format').value = usable.value;
  }
  const format = $('video-format').value;
  const select = $('video-codec');
  const fits = VIDEO_FORMATS[format].codecs;
  for (const o of select.options) {
    const ok = fits.includes(o.value) && !!videoType(format, o.value, canRecord);
    o.hidden = !fits.includes(o.value);
    o.disabled = !ok;
    o.textContent = VIDEO_CODECS[o.value].name + (fits.includes(o.value) && !ok ? ' (not available here)' : '');
  }
  const current = select.selectedOptions[0];
  if (!current || current.hidden || current.disabled) {
    const first = fits.find((c) => videoType(format, c, canRecord)) || fits[0];
    select.value = first;
  }
}
$('video-format').addEventListener('change', showVideoCodecs);
showVideoCodecs();
$('video-quality').oninput = () => showSliderValue($('video-quality'));
$('video-quality').ondblclick = () => {
  $('video-quality').value = $('video-quality').dataset.default;
  showSliderValue($('video-quality'));
  scheduleSave();
};
$('upscale-sharpen').oninput = () => showSliderValue($('upscale-sharpen'));
$('upscale-sharpen').ondblclick = () => {
  $('upscale-sharpen').value = $('upscale-sharpen').dataset.default;
  showSliderValue($('upscale-sharpen'));
  scheduleSave();
};

// The crop, rotation and this frame's pivot, pan and zoom, for frame i of
// the animation (an image w x h), or null when there is nothing to apply.
function frameGeometry(i, w, h) {
  const s = {
    ...((state.framePivots && state.framePivots[i]) || null),
    orientation: +$('orientation').value || 1,
    angle: +$('straighten').value,
    crop: cropValues(),
  };
  return isIdentity(s) ? null : geometry(w, h, s);
}

// Each frame of the animation rendered at full resolution (Rendering >
// Full resolution: Scale and Detail recovery), with that frame's camera and
// local adjustment settings. Kept as JPEGs: a hundred full resolution
// frames would not fit in memory as pixels.
async function fullResFrames(n) {
  const req = animationRequest();
  const a = req.args;
  const list = req.type === 'frames'
    ? a.path.map((f) => ({ u: f.u, v: f.v, alpha: f.alpha ?? a.alpha, aperture: f.aperture ?? a.aperture, dof: f.dof ?? a.dof, bokeh: f.bokeh ?? a.bokeh, masks: f.masks || null, color: f.color || null }))
    : a.alphas.map((alpha) => ({ u: a.u, v: a.v, alpha, aperture: a.aperture, dof: a.dof, bokeh: a.bokeh }));
  const scale = +$('still-scale').value;
  const passes = +$('still-passes').value;
  const count = Math.min(n, list.length);
  const render = (i) => engine.job('superRes', 'superres', { ...list[i], scale, passes }, {
    onProgress: (_, p) => showProgress(`Rendering frame ${i + 1} of ${n} from the full sensor`, (i + (p || 0)) / n),
  }).promise;
  const encode = async (msg) => {
    if (!msg || !(msg.pixels || msg.bitmap)) throw new Error('Full sensor rendering was stopped');
    const img = toImageData(msg);
    const c = new OffscreenCanvas(img.width, img.height);
    const g = c.getContext('2d');
    if (img instanceof ImageData) g.putImageData(img, 0, 0);
    else g.drawImage(img, 0, 0);
    return { blob: await c.convertToBlob({ type: 'image/jpeg', quality: 0.95 }), width: img.width, height: img.height };
  };
  // The worker renders the next frame while this one is encoded.
  const out = [];
  let next = count ? render(0) : null;
  for (let i = 0; i < count; i++) {
    const msg = await next;
    next = i + 1 < count ? render(i + 1) : null;
    out.push(await encode(msg));
  }
  return out;
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
    // Full resolution on: every frame rendered again from the whole sensor.
    const full = state.fullResMode && state.info && state.info.hasRaw ? await fullResFrames(frames.length) : null;
    const size = full ? full[0] : frames[0];
    const g0 = frameGeometry(0, size.width, size.height);
    const w = g0 ? g0.width : size.width;
    const h = g0 ? g0.height : size.height;
    // Sized to the chosen Video size: a height (the short side, as in
    // 1080p) keeps the picture's shape; a social media size takes the
    // largest centered part with its shape. Even pixels for the encoder.
    const frame = videoFrame($('video-size').value, w, h);
    const c = document.createElement('canvas');
    c.width = frame.width;
    c.height = frame.height;
    const cctx = c.getContext('2d');
    cctx.imageSmoothingQuality = 'high';
    // Each frame is drawn at its own size, cut to the video's shape, then
    // enlarged (or reduced) by the upscaler.
    const native = Object.assign(document.createElement('canvas'), { width: Math.round(w), height: Math.round(h) });
    const nctx = native.getContext('2d');
    const cut = frame.crop;
    const whole = cut.x === 0 && cut.y === 0 && cut.w === w && cut.h === h;
    const part = whole ? native : Object.assign(document.createElement('canvas'), { width: Math.max(1, Math.round(cut.w)), height: Math.max(1, Math.round(cut.h)) });
    const opts = upscaleSettings();
    const stream = c.captureStream(state.fps);
    const pick = chooseVideoType($('video-format').value, $('video-codec').value, canRecord);
    if (!pick) throw new Error('This browser cannot record video.');
    const mime = pick.type;
    if (pick.fallback) showNotice(`Recording as ${VIDEO_FORMATS[pick.format].name} ${VIDEO_CODECS[pick.codec].name}: this browser cannot record the chosen kind.`);
    const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: videoBitrate($('video-quality').value) });
    const chunks = [];
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const done = new Promise((r) => { recorder.onstop = r; });
    // Frames go out on the frame rate's beat, however long one takes to
    // prepare (a full resolution frame is decoded first).
    const t0 = performance.now();
    recorder.start();
    for (let n = 0; n < order.length; n++) {
      const i = order[n];
      const img = full ? await createImageBitmap(full[i].blob) : frames[i];
      const g = frameGeometry(i, img.width, img.height);
      if (g) drawGeometry(nctx, img, g, native.width / g.width);
      else nctx.drawImage(img, 0, 0, native.width, native.height);
      if (!whole) part.getContext('2d').drawImage(native, cut.x, cut.y, cut.w, cut.h, 0, 0, part.width, part.height);
      const big = upscaleImage(part, c.width, c.height, opts);
      const wait = t0 + (n * 1000) / state.fps - performance.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      cctx.drawImage(big, 0, 0);
      if (full) img.close();
      showProgress('Recording video', n / order.length);
    }
    await new Promise((r) => setTimeout(r, 1000 / state.fps));
    recorder.stop();
    await done;
    const ext = VIDEO_FORMATS[pick.format].ext;
    download(new Blob(chunks, { type: mime }), `${baseName()}-${$('anim').value}.${ext}`);
  } catch (err) {
    showError(err);
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
  if (result.dir) {
    rememberedFailed = false;
    rememberCameraFolder(result.dir);
  }
  if (files.length) setCameraSection({ cam: { kind: 'web', id: `web:${source}`, label: webCameraLabel(source), files } });
  $('camera-choose').hidden = false;
  $('camera-select-row').hidden = true;
  $('camera-dest').hidden = true;
  $('camera-dialog-source').textContent = files.length
    ? `${files.length} light field photo(s) found on ${source}.`
    : `No .LFR files found on ${source}. Open the camera's drive and choose its DCIM folder.`;
  showCameraDialog({
    files,
    thumb: (f) => readThumbnail(blobReader(f.file)),
    onImport: async (picked) => {
      const added = await importCameraFiles({ kind: 'web' }, picked);
      if (added.length) openItem(added[0]);
    },
  });
}

// Desktop app: cameras are detected over USB; photos are copied into the
// import folder, then opened from there.
// `preferId` picks that camera first (the one just plugged in).
async function importFromConnectedCamera(preferId) {
  const cameras = await native.listCameras();
  $('camera-choose').hidden = true;
  // Opened by a plug-in, but the camera has gone again: stay quiet.
  if (preferId && !cameras.some((c) => c.id === preferId)) return;
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
  const preferred = cameras.findIndex((c) => c.id === preferId);
  if (preferred >= 0) select.value = String(preferred);
  const show = () => {
    const cam = cameras[+select.value || 0];
    $('camera-dialog-source').textContent = `${cam.files.length} light field photo(s) on ${cam.label}.`;
    showCameraDialog({
      files: cam.files,
      thumb: (f) => native.cameraThumbnail(cam.id, f.id),
      onImport: async (picked) => {
        const added = await importCameraFiles(cam, picked);
        if (added.length) openItem(added[0]);
      },
    });
  };
  select.onchange = show;
  show();
}

// ---------------------------------------------------------------- camera section

// The Camera section above the library: the connected camera's photos.
// { cam: { kind: 'drive' | 'adb' | 'web', id, label, files }, note, show }
// (`show`: the Show photos… button, to choose or allow reading the drive in
// a browser). Clicking a photo imports it (once) and opens it.

function setCameraSection(next) {
  const was = cameraSection.cam;
  cameraSection = next;
  if (!next.cam || (was && was.id !== next.cam.id)) {
    for (const url of cameraThumbs.values()) URL.revokeObjectURL(url);
    cameraThumbs.clear();
  }
  // The camera's photos just arrived while the library grid is showing:
  // show them.
  if (next.cam && !was && state.grid) state.cameraView = true;
  renderLibrary();
}

// The library photo this camera file was imported as, if any.
function importedAs(f) {
  return lib ? lib.photos.find((p) => p.name === f.name && p.size === f.size) || null : null;
}

function cameraThumb(cam, f) {
  if (cam.kind === 'web') return readThumbnail(blobReader(f.file));
  if (cam.kind === 'drive') return native.cameraThumbnail(cam.id, f.id);
  return Promise.resolve(null);
}

// The Camera row in the sidebar: like an album, it shows the camera's
// photos in the grid.
function renderCameraSection() {
  const { cam, note = '', show = false } = cameraSection;
  $('camera-section').hidden = !cam && !note;
  $('camera-section-note').textContent = cam ? '' : note;
  $('camera-section-note').hidden = !!cam || !note;
  $('camera-show').hidden = !show || !!cam;
  $('camera-show').textContent = rememberedFailed ? 'Choose DCIM folder…' : 'Show photos…';
  const rows = cam || note ? [{ name: cam ? cam.label : 'Lytro camera', count: cam ? cam.files.length : '' }] : [];
  $('camera-rows').replaceChildren(...rows.map((row) => {
    const li = document.createElement('li');
    li.classList.toggle('current', !!state.cameraView);
    const b = Object.assign(document.createElement('button'), { type: 'button', className: 'album', title: 'Show the photos on the camera' });
    b.append(
      Object.assign(document.createElement('span'), { className: 'name', textContent: row.name }),
      Object.assign(document.createElement('span'), { className: 'count', textContent: row.count }),
    );
    b.onclick = () => {
      state.cameraView = true;
      showGrid(true);
    };
    li.append(b);
    return li;
  }));
}

// The camera's photos as thumbnails in the grid: clicking one imports it
// (once) and opens it; ✓ marks photos already in the library.
function renderCameraGrid() {
  if (!state.grid) return;
  const { cam } = cameraSection;
  const files = cam ? cam.files : [];
  $('grid-title').textContent = cam ? cam.label : 'Lytro camera';
  $('grid-count').textContent = cam ? `${files.length} photo${files.length === 1 ? '' : 's'} on the camera` : '';
  $('grid-import-all').hidden = !files.length || files.every(importedAs);
  $('photo-grid').replaceChildren(...files.map((f) => {
    const tile = document.createElement('div');
    const inLib = importedAs(f);
    tile.className = inLib ? 'tile imported' : 'tile';
    tile.tabIndex = 0;
    tile.setAttribute('role', 'button');
    tile.setAttribute('aria-label', inLib ? `Open ${f.name}` : `Import and open ${f.name}`);
    tile.title = inLib ? `${f.name} (in the library)` : `${f.name} · ${(f.size / 1e6).toFixed(0)} MB`;
    const frame = Object.assign(document.createElement('div'), { className: 'frame' });
    const key = `${cam.id}|${f.id || f.path}`;
    if (cameraThumbs.has(key)) frame.append(Object.assign(document.createElement('img'), { src: cameraThumbs.get(key), alt: '' }));
    else {
      cameraThumb(cam, f).then((t) => {
        if (!t || cameraSection.cam !== cam) return;
        const url = URL.createObjectURL(new Blob([t.bytes], { type: t.mime }));
        cameraThumbs.set(key, url);
        frame.append(Object.assign(document.createElement('img'), { src: url, alt: '' }));
      }).catch(() => {});
    }
    const name = Object.assign(document.createElement('div'), { className: 'name', textContent: f.name });
    tile.append(frame, name);
    const open = async () => {
      const photo = importedAs(f) || (await importCameraFiles(cam, [f]))[0];
      if (photo) openItem(photo);
    };
    tile.onclick = open;
    tile.onkeydown = (e) => {
      if (e.target === tile && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        open();
      }
    };
    return tile;
  }));
  // A browser reads the camera only from a drive the user chooses.
  $('grid-camera-choose-row').hidden = !!cam || native !== null;
  $('grid-empty').hidden = files.length > 0;
  $('grid-empty').textContent = cam
    ? `No photos found on ${cam.label}.`
    : native ? 'Looking for the photos on the camera…'
    : 'To see the photos on the camera, open the camera\'s drive in the folder picker and choose its DCIM folder. (Browsers read a camera only through a folder you choose, and do not let a page choose a whole drive.) It is remembered for next time.';
}

// Imports photos from a camera into the library: a camera drive (desktop
// or browser) is read directly; a camera reached over adb is copied to the
// library's staging folder first. Returns the added photos.
async function importCameraFiles(cam, picked) {
  if (!picked.length) return [];
  let entries;
  if (cam.kind === 'web') {
    entries = picked.map((f) => ({ path: f.path, file: f.file }));
  } else if (cam.kind === 'drive') {
    entries = picked.map((f) => ({ path: `${f.folder}/${f.name}`, file: new NativeFile({ path: f.id, name: f.name, size: f.size }) }));
  } else {
    const stop = native.onImportProgress((p) => showProgress(`Copying ${p.file} from the camera (${Math.min(p.index + 1, p.count)} of ${p.count})`, p.total ? p.bytes / p.total : 0));
    try {
      const files = await native.importFromCamera(cam.id, picked.map((f) => f.id));
      entries = files.map((f) => ({ path: f.name, file: new NativeFile(f) }));
    } catch (err) {
      showError(err);
      return [];
    } finally {
      stop();
      hideProgress();
    }
  }
  const added = await importPhotos(groupPhotos(entries));
  if (cam.kind === 'adb') lib.store.remove('.incoming').catch(() => {});
  return added;
}

// The name shown for a camera folder chosen in a browser: its DCIM folder
// (what browsers let a page choose) reads as the camera.
function webCameraLabel(source) {
  return /^dcim$/i.test(source) ? 'Lytro camera' : source;
}

// Browser: lists a camera drive (a folder handle) in the Camera section.
// False when it has no photos or cannot be read (not mounted yet, gone).
async function showWebCamera(dir) {
  try {
    const { source, files } = await listCameraFolder(dir);
    if (!files.length) return false;
    setCameraSection({ cam: { kind: 'web', id: `web:${source}`, label: webCameraLabel(source), files } });
    return true;
  } catch {
    return false;
  }
}

async function showCameraPhotos() {
  // First the drive chosen last time (asking to read it again), then, if
  // that fails, a fresh choice.
  if (!rememberedFailed) {
    const dir = await recallCameraFolder();
    if (dir && dir.requestPermission) {
      const ok = (await dir.requestPermission({ mode: 'read' }).catch(() => 'denied')) === 'granted';
      if (ok && (await showWebCamera(dir))) return;
      rememberedFailed = true;
      renderCameraSection();
      return;
    }
  }
  let result;
  try {
    result = await pickCameraFolder();
  } catch (err) {
    if (err.name !== 'AbortError') showError(err);
    return;
  }
  if (result.dir) {
    rememberedFailed = false;
    rememberCameraFolder(result.dir);
  }
  if (result.dir && (await showWebCamera(result.dir))) return;
  setCameraSection({ ...cameraSection, cam: { kind: 'web', id: `web:${result.source}`, label: webCameraLabel(result.source), files: result.files } });
}

$('camera-show').onclick = () => {
  state.cameraView = true;
  showGrid(true);
  showCameraPhotos();
};
$('grid-camera-choose').onclick = showCameraPhotos;

$('grid-import-all').onclick = async () => {
  const { cam } = cameraSection;
  if (!cam) return;
  const added = await importCameraFiles(cam, cam.files.filter((f) => !importedAs(f)));
  if (added.length) openItem(added[0]);
};

function importFromCamera() {
  return native ? importFromConnectedCamera(null) : importFromCameraFolder();
}

$('camera-select-all').onclick = () => {
  const boxes = [...$('camera-grid').querySelectorAll('input')];
  const all = boxes.every((b) => b.checked);
  boxes.forEach((b) => { b.checked = !all; });
};

// ---------------------------------------------------------------- wiring

// An album as an archive (library/archive.js), to add to another library:
// the browser version's to the desktop app's, say.
async function exportAlbum(id) {
  const album = lib.album(id);
  if (!album) return;
  if (!album.photos.length) {
    showNotice(`“${album.name}” has no photos to export.`);
    startNoticeTimer();
    return;
  }
  try {
    showProgress(`Exporting “${album.name}”`, 0);
    const blob = await lib.exportAlbum(id, { onProgress: (p) => showProgress(`Exporting “${album.name}”`, p) });
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
    const { album, photos } = await lib.importAlbum(file, {
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
  seekTo(+$('scrub').value / KEY_FPS);
};
$('png-btn').onclick = savePng;
$('webm-btn').onclick = exportVideo;

// Quick export (top bar): the Photo and Video settings of Render Settings
// in a popup. Each field mirrors its sidebar control: read when shown, and
// a change is made on the sidebar control (so it is saved and undoable like
// any setting), then everything is read back (the video format limits the
// compressions offered).
const QUICK_EXPORT = ['photo-size', 'photo-format', 'photo-quality', 'video-size', 'video-codec', 'video-format', 'video-quality'];
function showQuickExport() {
  for (const id of QUICK_EXPORT) {
    const src = $(id);
    const el = $(`qe-${id}`);
    if (src.tagName === 'SELECT') el.innerHTML = src.innerHTML;
    else for (const a of ['min', 'max', 'step']) el[a] = src[a];
    el.value = src.value;
    el.disabled = src.disabled;
    const out = document.querySelector(`output[data-for="qe-${id}"]`);
    const shown = document.querySelector(`output[data-for="${id}"]`);
    if (out && shown) out.textContent = shown.textContent;
  }
  $('qe-photo-quality-row').hidden = $('photo-quality-row').hidden;
  $('qe-photo-btn').textContent = $('png-btn').textContent;
  $('qe-photo-btn').disabled = $('png-btn').disabled;
  $('qe-video-btn').disabled = $('webm-btn').disabled;
  $('qe-video-btn').title = $('webm-btn').disabled ? 'Turn on Animation (in the Camera view) to export a video' : '';
}
for (const id of QUICK_EXPORT) {
  const el = $(`qe-${id}`);
  const copy = (type) => {
    $(id).value = el.value;
    $(id).dispatchEvent(new Event(type, { bubbles: true }));
    if (type === 'input') showSliderValue($(id));
    showQuickExport();
  };
  el.addEventListener('input', () => copy('input'));
  el.addEventListener('change', () => copy('change'));
}
$('quick-export-btn').onclick = () => {
  showQuickExport();
  $('quick-export-dialog').showModal();
};
$('qe-photo-btn').onclick = () => {
  $('quick-export-dialog').close();
  savePng();
};
$('qe-video-btn').onclick = () => {
  $('quick-export-dialog').close();
  exportVideo();
};
$('fullres-on').onchange = () => setFullResMode($('fullres-on').checked);
$('render-btn').onclick = renderFullRes;
$('depth-btn').onchange = () => setDepthShown($('depth-btn').checked);
$('still-scale').onchange = () => setFullRes(false);
$('still-passes').onchange = () => setFullRes(false);
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

// The settings the color pass applies (Process and Optics), each slider
// read through `val(id)`: its value, or an animation frame's keyframed one.
function colorSettings(val = (id) => +$(id).value) {
  return {
    lutAmount: val('lut-amount') / 100,
    ev: val('ev'),
    saturation: 1 + val('saturation') / 100,
    autoWb: $('awb').checked,
    wb: { kelvin: val('wb-temperature'), tint: val('wb-tint') },
    tone: Object.fromEntries(TONES.map((k) => [k, val(`tone-${k}`) / 100])),
    curve: { points: parsePoints($('curve-points').value), regions: CURVE_REGIONS.map((k) => val(`curve-${k}`) / 100) },
    useCcm: $('ccm-mode').value !== 'none',
    ccm: $('ccm-mode').value === 'custom' ? Array.from({ length: 9 }, (_, i) => +$(`ccm-${i}`).value || 0) : null,
    color: { vibrance: val('vibrance') / 100, ...Object.fromEntries(HUE_SLIDERS.map((k) => [k, val(`hue-${k}`) / 100])) },
    flare: { on: $('flare-on').checked, amount: val('flare-amount') / 100 },
    lens: { distortion: val('lens-distortion'), vignetting: val('lens-vignetting'), midpoint: val('lens-midpoint') },
    defringe: {
      on: $('fringe-on').checked,
      auto: $('fringe-auto').checked,
      radius: val('fringe-radius'),
      threshold: val('fringe-threshold'),
      // [amount, hue] for purple, green, red and blue fringes.
      colors: FRINGES.map((key) => [val(`fringe-${key}`), (val(`fringe-${key}-hue`) + 360) % 360]),
    },
  };
}

async function applySettings() {
  await sendLut();
  const settings = {
    ...colorSettings(),
    mvDenoise: { on: $('mv-on').checked, blend: $('mv-blend').value / 100 },
    depthSmoothing: $('depth-smooth').value / 100,
    depthQuality: $('depth-hq').checked ? 'high' : 'normal',
    details: {
      amount: +$('sharp-amount').value,
      radius: +$('sharp-radius').value,
      detail: +$('sharp-detail').value,
      masking: +$('sharp-masking').value,
      luminance: +$('nr-luminance').value,
      color: +$('nr-color').value,
      dust: +$('nr-dust').value,
      speckle: +$('nr-speckle').value,
    },
    detail: +$('detail').value,
    local: localSettings(),
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
  await lib.saveEdits(photo, { format: EDITS_FORMAT, version: EDITS_VERSION, reset: true, photo: { id: photo.id, name: photo.name } });
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
  let saved = photo ? await lib.loadEdits(photo) : null;
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
    for (const id of ['tilt', 'tilt-rotation']) $(id).disabled = !$('tilt-on').checked || $('tilt-on').disabled;
    $('pivot').disabled = !$('pivot-on').checked;
    curve.draw();
    showColorMatrix();
    $('flare-amount').disabled = !$('flare-on').checked;
    state.customFps = false;
    showFrameRate();
    showAnimationEnabled();
    showVideoCodecs();
    showPhotoFormat();
    maskSel = getMasks().length ? 0 : -1;
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
      maskSel = masks.length ? 0 : -1;
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
    delete edits.local;
    delete edits.lytroFilter;
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
    saveTimer = 0;
    if (key !== state.editsKey) return;
    const edits = readEdits(document, {
      photo: { id: key, name: state.current ? state.current.name : null },
      view: state.camera,
      focusPoint: state.focusPoint,
    });
    recordHistory(edits);
    if (photo) lib.saveEdits(photo, edits).catch((err) => console.warn('Could not save edits', err));
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
  if (photo) lib.saveEdits(photo, edits).catch((err) => console.warn('Could not save edits', err));
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
  else if (input.id === 'tilt-rotation' || input.id === 'bokeh-rotation') out.textContent = `${v}°`;
  else if (input.id === 'straighten') out.textContent = `${v.toFixed(1)}°`;
  else if (input.id === 'ml-angle') out.textContent = `${v}°`;
  else if (input.id === 'frame-zoom') out.textContent = `${v}%`;
  else if (input.id === 'video-quality') out.textContent = `${v} Mbit/s`;
  else if (input.id === 'photo-quality' || input.id === 'bokeh-blades') out.textContent = `${v}`;
  else if (input.id === 'mx-strength' || input.id === 'lut-amount') out.textContent = `${v}%`;
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
$('version').textContent = VERSION;

// Desktop app: the camera's photos show in the Camera section as soon as
// it is connected (a drive, or adb). WebUSB plug-in events (any OS; the main
// process lets the page see Lytro's vendor ID only) show it at once, before
// its drive mounts, and make the main process look for the drive sooner.
if (native) document.body.classList.add('native');
if (CAMERA_IMPORT) {
  $('camera-btn').hidden = false;
  $('camera-status').hidden = false;
}
if (native && CAMERA_IMPORT) {
  let lastCams = [];
  let usbLytros = 0;
  const showCameras = () => {
    const count = lastCams.reduce((n, c) => n + c.files.length, 0);
    $('camera-status').textContent = lastCams.length
      ? `Lytro camera connected · ${count} photo${count === 1 ? '' : 's'}`
      : usbLytros ? 'Lytro camera connected · looking for photos…' : '';
    $('camera-status').classList.toggle('connected', lastCams.length > 0 || usbLytros > 0);
    const c = lastCams.find((x) => x.files.length) || lastCams[0];
    setCameraSection(c ? { cam: { kind: c.kind, id: c.id, label: c.label, files: c.files } }
      : usbLytros ? { note: 'Lytro camera connected. Looking for its photos…' } : {});
  };
  native.listCameras().then((cams) => {
    lastCams = cams;
    showCameras();
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
    $('usb-watch-btn').hidden = allowed;
  };
  const arrived = async () => {
    showUsbStatus();
    if (cameraSection.cam) return;
    setCameraSection({ note: 'Lytro camera connected.', show: true });
    // The drive chosen last time, if the browser still lets the page read
    // it: list it (it can take a few seconds to mount).
    const dir = await recallCameraFolder();
    if (!dir || !dir.queryPermission || (await dir.queryPermission({ mode: 'read' }).catch(() => 'denied')) !== 'granted') return;
    for (let i = 0; i < 10 && connected && !cameraSection.cam; i++) {
      if (await showWebCamera(dir)) return;
      await new Promise((r) => setTimeout(r, 1500));
    }
  };
  navigator.usb.addEventListener('connect', (e) => {
    if (!isLytro(e.device)) return;
    connected++;
    arrived();
  });
  navigator.usb.addEventListener('disconnect', (e) => {
    if (!isLytro(e.device)) return;
    connected = Math.max(0, connected - 1);
    showUsbStatus();
    if (!connected) setCameraSection({});
  });
  navigator.usb.getDevices().then((devices) => {
    connected = devices.filter(isLytro).length;
    if (connected) {
      allowed = true;
      arrived();
    } else showUsbStatus();
  }).catch(() => showUsbStatus());
  $('usb-watch-btn').onclick = async () => {
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
        arrived();
      }
      showUsbStatus();
      showNotice('ILLUMinator will now notice when this camera is plugged in.');
      startNoticeTimer();
    } catch (err) {
      if (err.name !== 'NotFoundError') showError(err);
    }
  };
}
$('camera-choose').onclick = () => importFromCameraFolder();

// Test hook: ?sample opens the synthetic sample on load.
if (new URLSearchParams(location.search).has('sample')) $('sample-btn').click();

// ---------------------------------------------------------------- LUT

// Process > LUT: a .cube color lookup table, kept with the photo's edits
// (core/lut.js) and applied as the last step of the look.
let lutSent = null;

function showLut() {
  let saved = null;
  try {
    saved = $('lut-data').value ? JSON.parse($('lut-data').value) : null;
  } catch {
    saved = null;
  }
  // The dropdown shows the LUT in use: a film look by name, an imported
  // one as such, or None.
  const film = saved && saved.film && filmLuts.index ? filmLuts.index.luts.findIndex((l) => l.name === saved.name) : -1;
  const imported = $('lut-film').querySelector('option[value="imported"]');
  imported.hidden = !(saved && film < 0);
  imported.textContent = saved ? `Imported: ${saved.name}` : '';
  $('lut-film').value = film >= 0 ? String(film) : saved ? 'imported' : '';
  $('lut-name').textContent = saved ? saved.name : 'None';
  $('lut-name').title = saved ? `${saved.name} (${saved.size}×${saved.size}×${saved.size})` : '';
  $('lut-remove').hidden = !saved;
  $('lut-amount').disabled = !saved;
  return saved;
}

// The worker gets the LUT only when it changes: it is large.
async function sendLut() {
  const text = $('lut-data').value;
  if (text === lutSent) return;
  lutSent = text;
  const saved = showLut();
  await engine.request('setLut', { lut: saved ? decodeLut(saved) : null });
}

// Film looks bundled with the app (app/luts, built by
// scripts/build-film-luts.mjs): the list loads at start, the LUTs themselves
// (one file) the first time one is chosen.
const filmLuts = { index: null, data: null };

async function loadFilmIndex() {
  try {
    const res = await fetch('luts/film-luts.json');
    if (!res.ok) return;
    filmLuts.index = await res.json();
  } catch {
    return;
  }
  const groups = filmLuts.index.categories.map((cat) => {
    const group = Object.assign(document.createElement('optgroup'), { label: cat });
    filmLuts.index.luts.forEach((l, i) => {
      if (l.category === cat) group.append(Object.assign(document.createElement('option'), { value: String(i), textContent: l.name }));
    });
    return group;
  });
  $('lut-film').append(...groups);
  showLut();
}

async function filmLut(i) {
  const entry = filmLuts.index.luts[i];
  if (!filmLuts.data) {
    showProgress('Loading film looks', 0);
    try {
      filmLuts.data = await (await fetch('luts/film-luts.bin')).arrayBuffer();
    } finally {
      hideProgress();
    }
  }
  const n = entry.size ** 3 * 3;
  const q = new Uint16Array(filmLuts.data, entry.offset, n);
  const data = new Float32Array(n);
  for (let k = 0; k < n; k++) data[k] = q[k] / 65535;
  return { title: entry.name, size: entry.size, min: [0, 0, 0], max: [1, 1, 1], data };
}

$('lut-film').onchange = async () => {
  const i = $('lut-film').value;
  if (i === 'imported') return;
  if (i === '') {
    $('lut-remove').click();
    return;
  }
  if (!filmLuts.index) return;
  if (!canRender()) {
    showLut();
    showNotice('Open a photo first: a LUT is kept with the photo.');
    startNoticeTimer();
    return;
  }
  try {
    const lut = await filmLut(+i);
    $('lut-data').value = JSON.stringify({ ...encodeLut(lut, lut.title), film: true });
  } catch (err) {
    showError(err);
    showLut();
    return;
  }
  showLut();
  scheduleSave();
  applySettingsSoon();
};
loadFilmIndex();

$('lut-remove').innerHTML = TRASH_ICON;
$('lut-import').onclick = () => {
  if (!canRender()) {
    showNotice('Open a photo first: a LUT is kept with the photo.');
    startNoticeTimer();
    return;
  }
  $('lut-file').click();
};
$('lut-file').onchange = async () => {
  const file = $('lut-file').files[0];
  $('lut-file').value = '';
  if (!file) return;
  try {
    const lut = parseCube(await file.text());
    $('lut-data').value = JSON.stringify(encodeLut(lut, file.name.replace(/\.cube$/i, '')));
  } catch (err) {
    showNotice(`Could not use ${file.name}: ${err.message}`);
    startNoticeTimer();
    return;
  }
  showLut();
  scheduleSave();
  applySettingsSoon();
};
$('lut-remove').onclick = () => {
  $('lut-data').value = '';
  showLut();
  scheduleSave();
  applySettingsSoon();
};
$('lut-amount').addEventListener('input', () => {
  showSliderValue($('lut-amount'));
  applySettingsSoon();
});
$('lut-amount').addEventListener('change', () => scheduleSave());
showLut();
