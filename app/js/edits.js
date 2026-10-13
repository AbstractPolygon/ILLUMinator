// Per-photo edits: every adjustment a photo was given, as a small versioned
// JSON document. In the library it is saved next to the photo
// (edits.illuminator.json in the photo's folder); until then it is kept in
// the app's own storage, keyed by the photo's id.
//
// {
//   "format": "illuminator-edits", "version": 1, "modified": ISO date,
//   "photo": { "id", "name" },
//   "process": { control id: value, ... }, "camera": {...}, "details": {...},
//   "defringe": {...}, "animation": {...}, "rendering": {...}, "geometry": {...},
//   "view": { "u", "v" }, "focusPoint": { "x", "y" }
// }

export const EDITS_FORMAT = 'illuminator-edits';
export const EDITS_VERSION = 1;

const HUES = ['red', 'yellow', 'green', 'cyan', 'blue', 'magenta'];
const FRINGES = ['purple', 'green', 'red', 'blue'];

// Controls saved with a photo, by panel. View toggles (show depth map, show
// spread, full resolution) are not edits and are left out.
export const EDIT_GROUPS = {
  process: ['lut-data', 'lut-amount', 'awb', 'wb-temperature', 'wb-tint', 'ev', 'tone-contrast', 'tone-highlights', 'tone-shadows', 'tone-whites',
    'tone-blacks', 'saturation', 'vibrance', ...HUES.map((h) => `hue-${h}`),
    'ccm-mode', ...Array.from({ length: 9 }, (_, i) => `ccm-${i}`),
    'curve-points', 'curve-highlights', 'curve-lights', 'curve-darks', 'curve-shadows'],
  camera: ['fstop', 'focus', 'dof-depth', 'depth-smooth', 'depth-hq', 'spread', 'spread-smooth', 'tilt-on', 'tilt', 'tilt-rotation', 'pivot-on', 'pivot', 'bokeh', 'highlights'],
  details: ['sharp-amount', 'sharp-radius', 'sharp-detail', 'sharp-masking', 'mv-on', 'mv-blend', 'nr-luminance', 'nr-color'],
  defringe: ['lens-distortion', 'lens-vignetting', 'lens-midpoint', 'flare-on', 'flare-amount', 'fringe-on', 'fringe-auto', 'fringe-radius', 'fringe-threshold', ...FRINGES.flatMap((k) => [`fringe-${k}`, `fringe-${k}-hue`])],
  animation: ['anim-on', 'fps', 'anim', 'anim-keys', 'frame-zoom', 'frame-pan-x', 'frame-pan-y', 'path', 'amount', 'frames', 'near', 'far', 'steps'],
  rendering: ['detail', 'still-scale', 'still-passes', 'stereo-mode', 'stereo-baseline', 'video-size'],
  local: ['local-masks'],
  geometry: ['orientation', 'straighten', 'crop-aspect', 'crop-x', 'crop-y', 'crop-w', 'crop-h'],
};

function readValue(el) {
  if (el.type === 'checkbox') return el.checked;
  if ('text' in el.dataset) return el.value;
  if (el.tagName === 'SELECT') return el.value;
  return Number(el.value);
}

function writeValue(el, value) {
  if (el.type === 'checkbox') el.checked = !!value;
  else el.value = String(value);
}

// Current controls -> edits document. `extra`: { view, focusPoint, photo }.
export function readEdits(doc, extra = {}) {
  const edits = { format: EDITS_FORMAT, version: EDITS_VERSION, modified: new Date().toISOString() };
  for (const [group, ids] of Object.entries(EDIT_GROUPS)) {
    edits[group] = {};
    for (const id of ids) {
      const el = doc.getElementById(id);
      if (el) edits[group][id] = readValue(el);
    }
  }
  return { ...edits, ...extra };
}

// Edits document -> controls. Values missing from the document keep what
// `base` (usually the defaults) says. Returns the document's view and focus
// point, for the caller to apply.
export function writeEdits(doc, edits, base) {
  if (edits && edits.format && edits.format !== EDITS_FORMAT) throw new Error('Not an ILLUMinator edits file');
  if (edits && edits.version > EDITS_VERSION) console.warn('Edits were saved by a newer ILLUMinator; some may not apply');
  for (const [group, ids] of Object.entries(EDIT_GROUPS)) {
    for (const id of ids) {
      const el = doc.getElementById(id);
      if (!el) continue;
      const own = edits && edits[group] && id in edits[group] ? edits[group][id] : undefined;
      const fallback = base && base[group] ? base[group][id] : undefined;
      const value = own !== undefined ? own : fallback;
      if (value !== undefined) writeValue(el, value);
    }
  }
  return {
    view: (edits && edits.view) || { u: 0, v: 0 },
    focusPoint: (edits && edits.focusPoint) || { x: 0.5, y: 0.5 },
  };
}

// ---------------------------------------------------------------- storage

// Edits kept in the app's own storage (IndexedDB), by photo id. Works in
// browsers and in the desktop app; the library will add files next to each
// photo.
const DB_NAME = 'illuminator';
const STORE = 'edits';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

let dbPromise = null;
function db() {
  if (!dbPromise) dbPromise = openDb().catch((err) => {
    dbPromise = null;
    throw err;
  });
  return dbPromise;
}

function request(mode, fn) {
  return db().then((d) => new Promise((resolve, reject) => {
    const tx = d.transaction(STORE, mode);
    const req = fn(tx.objectStore(STORE));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }));
}

export const editsStore = {
  async load(id) {
    try {
      return (await request('readonly', (s) => s.get(id))) || null;
    } catch {
      return null; // storage unavailable (private window etc.): no saved edits
    }
  },
  async save(id, edits) {
    try {
      await request('readwrite', (s) => s.put(edits, id));
      return true;
    } catch {
      return false;
    }
  },
};
