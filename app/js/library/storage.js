// Where the library keeps its files. Every backend offers the same small set
// of calls on paths relative to the library folder ('Photos/IMG_0001/...'):
//
//   list(dir)              -> [{ name, dir, size }] ([] if the folder is missing)
//   readText(path)         -> string, or null if the file is missing
//   writeText(path, text)
//   writeBlob(path, blob)
//   copyIn(file, path)     copies a picked or dropped file into the library
//   file(path)             -> File-like ({ name, size, arrayBuffer, slice }), or null
//   move(from, to)
//   remove(path)           removes a file or a folder with everything in it
//
// The desktop app keeps the library in a real folder (the main process does
// the file work); browsers keep it in their private file system (OPFS); when
// neither is available the photos are only held for this session.

import { native, NativeFile } from '../platform.js';

const parts = (path) => path.split('/').filter(Boolean);

// ---------------------------------------------------------------- desktop

export function folderStorage() {
  const lib = native.library;
  return {
    kind: 'folder',
    list: (dir) => lib.list(dir),
    readText: (path) => lib.readText(path),
    writeText: (path, text) => lib.write(path, text),
    writeBlob: async (path, blob) => lib.write(path, new Uint8Array(await blob.arrayBuffer())),
    copyIn: async (file, path) => {
      if (file instanceof NativeFile) return lib.copyIn(file.path, path);
      return lib.write(path, new Uint8Array(await file.arrayBuffer()));
    },
    file: async (path) => {
      const found = await lib.stat(path);
      return found ? new NativeFile(found) : null;
    },
    move: (from, to) => lib.move(from, to),
    remove: (path) => lib.remove(path),
  };
}

// ---------------------------------------------------------------- browser

async function opfsDir(root, path, create) {
  let dir = root;
  for (const name of parts(path)) dir = await dir.getDirectoryHandle(name, { create });
  return dir;
}

async function opfsParent(root, path, create) {
  const p = parts(path);
  const name = p.pop();
  return { dir: await opfsDir(root, p.join('/'), create), name };
}

async function opfsWrite(root, path, data) {
  const { dir, name } = await opfsParent(root, path, true);
  const handle = await dir.getFileHandle(name, { create: true });
  const out = await handle.createWritable();
  try {
    if (data && typeof data.stream === 'function') {
      // Large photos are streamed in rather than read into memory at once.
      const reader = data.stream().getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        await out.write(value);
      }
    } else {
      await out.write(data);
    }
    await out.close();
  } catch (err) {
    await out.abort().catch(() => {});
    throw err;
  }
}

const missing = (err) => err && (err.name === 'NotFoundError' || err.name === 'TypeMismatchError');

export async function browserStorage() {
  if (!navigator.storage || !navigator.storage.getDirectory) throw new Error('No private file system');
  const root = await opfsDir(await navigator.storage.getDirectory(), 'library', true);
  // Writing needs createWritable (not available everywhere): try it once.
  await opfsWrite(root, '.probe', 'ok');
  await root.removeEntry('.probe');
  if (navigator.storage.persist) navigator.storage.persist().catch(() => {});

  const file = async (path) => {
    try {
      const { dir, name } = await opfsParent(root, path, false);
      return await (await dir.getFileHandle(name)).getFile();
    } catch (err) {
      if (missing(err)) return null;
      throw err;
    }
  };

  return {
    kind: 'browser',
    async list(path) {
      let dir;
      try {
        dir = await opfsDir(root, path, false);
      } catch (err) {
        if (missing(err)) return [];
        throw err;
      }
      const out = [];
      for await (const entry of dir.values()) {
        out.push({ name: entry.name, dir: entry.kind === 'directory', size: entry.kind === 'file' ? (await entry.getFile()).size : 0 });
      }
      return out;
    },
    async readText(path) {
      const f = await file(path);
      return f ? f.text() : null;
    },
    writeText: (path, text) => opfsWrite(root, path, text),
    writeBlob: (path, blob) => opfsWrite(root, path, blob),
    copyIn: (src, path) => opfsWrite(root, path, src),
    file,
    async move(from, to) {
      const src = await file(from);
      if (src) {
        await opfsWrite(root, to, src);
      } else {
        // A folder: move what is inside it.
        for (const e of await this.list(from)) await this.move(`${from}/${e.name}`, `${to}/${e.name}`);
      }
      await this.remove(from);
    },
    async remove(path) {
      try {
        const { dir, name } = await opfsParent(root, path, false);
        await dir.removeEntry(name, { recursive: true });
      } catch (err) {
        if (!missing(err)) throw err;
      }
    },
  };
}

// ---------------------------------------------------------------- memory

// Holds the files themselves (picked or dropped Files) for this session.
export function memoryStorage() {
  const files = new Map();
  const norm = (path) => parts(path).join('/');
  const under = (dir) => (dir ? norm(dir) + '/' : '');
  return {
    kind: 'memory',
    async list(dir) {
      const prefix = under(dir);
      const seen = new Map();
      for (const [path, blob] of files) {
        if (!path.startsWith(prefix)) continue;
        const rest = path.slice(prefix.length).split('/');
        const name = rest[0];
        if (!seen.has(name)) seen.set(name, { name, dir: rest.length > 1, size: rest.length > 1 ? 0 : blob.size });
      }
      return [...seen.values()];
    },
    async readText(path) {
      const blob = files.get(norm(path));
      return blob ? blob.text() : null;
    },
    async writeText(path, text) {
      files.set(norm(path), new Blob([text], { type: 'application/json' }));
    },
    async writeBlob(path, blob) {
      files.set(norm(path), blob);
    },
    async copyIn(file, path) {
      files.set(norm(path), file);
    },
    async file(path) {
      return files.get(norm(path)) || null;
    },
    async move(from, to) {
      const src = norm(from);
      for (const [path, blob] of [...files]) {
        if (path === src || path.startsWith(src + '/')) {
          files.delete(path);
          files.set(norm(to) + path.slice(src.length), blob);
        }
      }
    },
    async remove(path) {
      const p = norm(path);
      for (const key of [...files.keys()]) if (key === p || key.startsWith(p + '/')) files.delete(key);
    },
  };
}

// The best storage this app can use here.
export async function openStorage() {
  if (native && native.library) return folderStorage();
  try {
    return await browserStorage();
  } catch (err) {
    console.warn('Library storage unavailable; photos are kept for this session only', err);
    return memoryStorage();
  }
}
