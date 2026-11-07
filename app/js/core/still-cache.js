// Full sensor renders kept next to the photo in the desktop app's library, so pressing Render (or Auto render) again with the same settings shows the
// finished picture at once instead of rendering it again. Each is a lossless PNG named by a hash of everything that shapes the picture (this app's
// version, the photo, every setting, the view, Scale and Detail recovery passes); an index file lists them, newest last, and the oldest are dropped.

export const STILL_INDEX_FILE = 'stills.illuminator.json';
export const STILLS_KEPT = 4;
export const stillFileName = (hash) => `still-${hash}.png`;
// The full sensor picture before its color pass (core/keptpicture.js), kept for the last few settings that shaped it.
export const KEPT_INDEX_FILE = 'kept.illuminator.json';
export const KEPT_PICTURES = 2;
export const keptFileName = (hash) => `kept-${hash}.bin`;

// Two 32 bit FNV-1a hashes with different seeds, as 16 hex digits.
export function hashKey(text) {
  let a = 0x811c9dc5;
  let b = 0x9747b28c;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x85ebca6b) >>> 0;
    b ^= b >>> 13;
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

// The index after `hash` was rendered: it moves to the end; { index, dropped } where `dropped` are hashes whose files can go.
export function touchIndex(index, hash, kept = STILLS_KEPT) {
  const list = (Array.isArray(index) ? index : []).filter((h) => typeof h === 'string' && h !== hash);
  list.push(hash);
  const dropped = list.splice(0, Math.max(0, list.length - kept));
  return { index: list, dropped };
}

// The text a render is keyed on: the edits document (without its date, the animation tracks and the export settings, which do not change the still),
// the camera, the Scale and passes, the animation frame on show, the photo and the app version.
export function stillKeyText({ edits, camera, scale, passes, frame, photoId, version }) {
  const { modified, photo, animation, ...rest } = edits;
  if (rest.rendering) {
    const keep = {};
    for (const k of ['detail', 'fullres-on', 'still-scale', 'still-passes']) keep[k] = rest.rendering[k];
    rest.rendering = keep;
  }
  return JSON.stringify({ version, photoId, scale, passes, camera, frame: frame || null, edits: rest });
}
