// Browser implementations of file access. The Electron preload script can
// provide `window.lytroNative` to replace these with native dialogs and USB
// camera access.

const LF_FILE = /\.(lfr|lfp|raw)$/i;

export const native = typeof window !== 'undefined' ? window.lytroNative || null : null;

function pickWithInput(input) {
  return new Promise((resolve) => {
    input.value = '';
    input.onchange = () => resolve([...input.files]);
    input.click();
  });
}

export async function openFiles() {
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
    const dir = await window.showDirectoryPicker({ id: 'lytro-camera', mode: 'read' });
    const out = [];
    await walkDirectory(dir, dir.name + '/', out);
    return { source: dir.name, files: out };
  }
  const files = await pickWithInput(document.getElementById('dir-input'));
  return {
    source: files.length ? files[0].webkitRelativePath.split('/')[0] : '',
    files: files.filter((f) => /\.(lfr|lfp)$/i.test(f.name)).map((f) => ({ name: f.name, path: f.webkitRelativePath, size: f.size, file: f })),
  };
}

export function isLightFieldName(name) {
  return LF_FILE.test(name);
}

export function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
