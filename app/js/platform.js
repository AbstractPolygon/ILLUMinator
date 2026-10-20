// Browser implementations of file access. The Electron preload script can
// provide `window.lytroNative` to replace these with native dialogs and USB
// camera access.

const LF_FILE = /\.(lfr|lfp|raw)$/i;


// Lytro, Inc.'s USB vendor ID (as electron/camera.cjs).
export const LYTRO_USB_VENDOR = 0x24cf;

export const native = typeof window !== 'undefined' ? window.lytroNative || null : null;

// Importing straight from a connected camera (Import from camera…, the
// Camera section): in the desktop app, over USB (electron/camera.cjs). A
// browser notices a Lytro being plugged in (WebUSB, after Detect camera…) and
// reads a card or a copy of it through a folder the user chooses; it cannot
// speak the first generation camera's own USB protocol.
export const CAMERA_IMPORT = true;

function toArrayBuffer(u8) {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
}

// A file on disk in the desktop app, usable wherever the app expects a
// File: arrayBuffer() for the whole file, slice().arrayBuffer() for ranges.
export class NativeFile {
  constructor({ path, name, size }) {
    this.path = path;
    this.name = name;
    this.size = size;
  }

  async arrayBuffer() {
    return toArrayBuffer(await native.readFile(this.path));
  }

  slice(start, end) {
    const from = Math.max(0, start);
    const to = Math.min(this.size, end ?? this.size);
    return { arrayBuffer: async () => toArrayBuffer(await native.readRange(this.path, from, Math.max(0, to - from))) };
  }
}

function pickWithInput(input) {
  return new Promise((resolve) => {
    input.value = '';
    input.onchange = () => resolve([...input.files]);
    input.oncancel = () => resolve([]);
    input.click();
  });
}

export async function openFiles() {
  if (native) return (await native.openFiles()).map((f) => new NativeFile(f));
  return pickWithInput(document.getElementById('file-input'));
}

// A camera calibration backup (.tar), or null when cancelled.
export async function openCalibrationFile() {
  if (native) return (await native.openFiles({ kind: 'calibration' }).then((f) => f.map((x) => new NativeFile(x))))[0] || null;
  return (await pickWithInput(document.getElementById('cal-input')))[0] || null;
}

const PHOTO_FILE = /\.(lfr|lfp)$/i;
const FOLDER_FILE = /\.(lfr|lfp|raw|jpe?g|png)$/i;
const CALIBRATION_FILE = /\.(json|bin|txt|gct|hst|raw)$/i;

async function walkDirectory(handle, prefix, out, wanted = PHOTO_FILE) {
  for await (const entry of handle.values()) {
    if (entry.name.startsWith('.')) continue;
    const path = prefix + entry.name;
    if (entry.kind === 'directory') {
      await walkDirectory(entry, path + '/', out, wanted);
    } else if (wanted.test(entry.name)) {
      const file = await entry.getFile();
      out.push({ name: entry.name, path, size: file.size, file });
    }
  }
}

// In a browser the camera shows up as a removable drive (USB mass storage).
// Ask the user to pick it (or its DCIM folder) and collect light field files.
export async function pickCameraFolder() {
  if (window.showDirectoryPicker) {
    try {
      const dir = await window.showDirectoryPicker({ id: 'lytro-camera', mode: 'read' });
      return { ...(await listCameraFolder(dir)), dir };
    } catch (err) {
      // Cancelled by the user: stop. Not allowed here (e.g. inside an
      // embedded frame): fall back to the folder input below.
      if (err && err.name === 'AbortError') throw err;
    }
  }
  const files = await pickWithInput(document.getElementById('dir-input'));
  return {
    source: files.length ? files[0].webkitRelativePath.split('/')[0] : '',
    files: files.filter((f) => /\.(lfr|lfp)$/i.test(f.name)).map((f) => ({ name: f.name, path: f.webkitRelativePath, size: f.size, file: f })),
  };
}

// The light field files in a folder chosen earlier (a FileSystemDirectoryHandle).
export async function listCameraFolder(dir) {
  const out = [];
  await walkDirectory(dir, dir.name + '/', out);
  return { source: dir.name, files: out };
}

// The camera's drive, remembered between plug-ins (browsers that can keep
// folder handles): IndexedDB holds the handle; reading it again needs the
// user's permission, which the browser may keep or ask for again.
const HANDLE_DB = 'illuminator-handles';

function handleStore(mode, run) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(HANDLE_DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore('handles');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction('handles', mode);
      const req = run(tx.objectStore('handles'));
      tx.oncomplete = () => {
        open.result.close();
        resolve(req && req.result);
      };
      tx.onerror = () => reject(tx.error);
    };
  });
}

export async function rememberCameraFolder(dir) {
  try {
    await handleStore('readwrite', (store) => store.put(dir, 'camera'));
  } catch {
    // Not kept: the drive is chosen again next time.
  }
}

export async function recallCameraFolder() {
  try {
    return (await handleStore('readonly', (store) => store.get('camera'))) || null;
  } catch {
    return null;
  }
}

// Asks for a folder (a Lytro Desktop library, a copy of a camera card) and
// lists the photos and thumbnails in it and all its subfolders:
// { name, files: [{ path, file }] } with paths relative to the folder, or
// null when cancelled.
export async function pickFolder(title, { calibration = false } = {}) {
  const wanted = calibration ? CALIBRATION_FILE : FOLDER_FILE;
  if (native) {
    const r = await native.pickFolder(title);
    return r ? { name: r.name, files: r.files.map((f) => ({ path: f.rel, file: new NativeFile(f) })) } : null;
  }
  if (window.showDirectoryPicker) {
    try {
      const dir = await window.showDirectoryPicker({ id: 'lytro-library', mode: 'read' });
      const out = [];
      await walkDirectory(dir, '', out, wanted);
      return { name: dir.name, files: out.map((e) => ({ path: e.path, file: e.file })) };
    } catch (err) {
      if (err && err.name === 'AbortError') return null;
    }
  }
  const files = await pickWithInput(document.getElementById('dir-input'));
  if (!files.length) return null;
  const strip = (p) => p.split('/').slice(1).join('/');
  return {
    name: files[0].webkitRelativePath.split('/')[0],
    files: files.filter((f) => wanted.test(f.name)).map((f) => ({ path: strip(f.webkitRelativePath), file: f })),
  };
}

// Lytro Desktop's edits file for a picture (its views carry the recipe).
export function isSidecarName(name) {
  return /(^|\.)view\.lfp$/i.test(name);
}

// The edits file next to `file` on disk (desktop app only), or null.
export async function findSidecar(file) {
  if (!native || !native.findSidecar || !(file instanceof NativeFile)) return null;
  try {
    const found = await native.findSidecar(file.path);
    return found ? new NativeFile(found) : null;
  } catch {
    return null;
  }
}

export function isLightFieldName(name) {
  return LF_FILE.test(name);
}

export async function download(blob, name) {
  if (native) {
    await native.saveFile(name, new Uint8Array(await blob.arrayBuffer()));
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
