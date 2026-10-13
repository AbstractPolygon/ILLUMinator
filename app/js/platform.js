// Browser implementations of file access. The Electron preload script can
// provide `window.lytroNative` to replace these with native dialogs and USB
// camera access.

const LF_FILE = /\.(lfr|lfp|raw)$/i;

export const native = typeof window !== 'undefined' ? window.lytroNative || null : null;

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
    input.click();
  });
}

export async function openFiles() {
  if (native) return (await native.openFiles()).map((f) => new NativeFile(f));
  return pickWithInput(document.getElementById('file-input'));
}

async function walkDirectory(handle, prefix, out) {
  for await (const entry of handle.values()) {
    const path = prefix + entry.name;
    if (entry.kind === 'directory') {
      await walkDirectory(entry, path + '/', out);
    } else if (/\.(lfr|lfp)$/i.test(entry.name)) {
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
      const out = [];
      await walkDirectory(dir, dir.name + '/', out);
      return { source: dir.name, files: out };
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
