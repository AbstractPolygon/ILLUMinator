// Finds Lytro cameras connected over USB and imports their photos.
//
// The ILLUM appears as a USB mass storage drive holding DCIM/<nnn>PHOTO/
// IMG_xxxx.LFR. Cameras with Android debugging enabled (hold AEL + Lytro
// while switching on) can also be reached with adb, the route Lytro's own
// power tools used; that needs adb installed.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');

const LIGHT_FIELD = /\.(lfr|lfp)$/i;
const ADB_DCIM = '/storage/sdcard1/DCIM';

async function isDir(p) {
  try {
    return (await fsp.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function listDir(p) {
  try {
    return await fsp.readdir(p);
  } catch {
    return [];
  }
}

// Places where removable drives are mounted on this platform.
async function volumeRoots(platform = process.platform) {
  if (platform === 'win32') {
    const roots = [];
    for (let c = 'D'.charCodeAt(0); c <= 'Z'.charCodeAt(0); c++) {
      const root = `${String.fromCharCode(c)}:\\`;
      if (await isDir(root)) roots.push(root);
    }
    return roots;
  }
  const parents = platform === 'darwin'
    ? ['/Volumes']
    : [`/media/${os.userInfo().username}`, `/run/media/${os.userInfo().username}`, '/media', '/mnt'];
  const roots = [];
  for (const parent of parents) {
    for (const name of await listDir(parent)) {
      const p = path.join(parent, name);
      if (await isDir(p)) roots.push(p);
    }
  }
  return roots;
}

// Light field photos under <root>/DCIM/*/.
async function scanVolume(root) {
  const dcim = path.join(root, 'DCIM');
  if (!(await isDir(dcim))) return null;
  const files = [];
  for (const folder of (await listDir(dcim)).sort()) {
    const dir = path.join(dcim, folder);
    if (!(await isDir(dir))) continue;
    for (const name of (await listDir(dir)).sort()) {
      if (!LIGHT_FIELD.test(name)) continue;
      const full = path.join(dir, name);
      try {
        const st = await fsp.stat(full);
        files.push({ id: full, name, folder, size: st.size, mtime: st.mtimeMs });
      } catch {
        // Vanished while listing (card ejected): skip.
      }
    }
  }
  if (!files.length) return null;
  return { id: `drive:${root}`, kind: 'drive', label: `Camera drive ${root}`, root, files };
}

function run(cmd, args, timeout = 5000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, maxBuffer: 16 << 20 }, (err, stdout) => resolve(err ? null : String(stdout)));
  });
}

function adbCommand() {
  return process.env.ADB || 'adb';
}

// `ls -l` lines from Android's toolbox/toybox: the size is the field before
// the date (yyyy-mm-dd), the name is the last field.
function parseLsLong(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    const d = parts.findIndex((p) => /^\d{4}-\d{2}-\d{2}$/.test(p));
    if (d < 1) continue;
    const name = parts.slice(d + 2).join(' ');
    if (!name) continue;
    out.push({ name, size: Number(parts[d - 1]) || 0, dir: line.trim().startsWith('d') });
  }
  return out;
}

async function scanAdb() {
  const devices = await run(adbCommand(), ['devices', '-l'], 3000);
  if (!devices) return [];
  const cameras = [];
  for (const line of devices.split(/\r?\n/).slice(1)) {
    const [serial, status] = line.trim().split(/\s+/);
    if (!serial || status !== 'device') continue;
    const top = await run(adbCommand(), ['-s', serial, 'shell', 'ls', '-l', ADB_DCIM]);
    if (!top) continue;
    const files = [];
    for (const entry of parseLsLong(top).filter((e) => e.dir)) {
      const listing = await run(adbCommand(), ['-s', serial, 'shell', 'ls', '-l', `${ADB_DCIM}/${entry.name}`]);
      for (const f of parseLsLong(listing || '')) {
        if (!LIGHT_FIELD.test(f.name)) continue;
        files.push({ id: `${ADB_DCIM}/${entry.name}/${f.name}`, name: f.name, folder: entry.name, size: f.size });
      }
    }
    if (files.length) cameras.push({ id: `adb:${serial}`, kind: 'adb', label: `Lytro camera (USB debugging, ${serial})`, serial, files });
  }
  return cameras;
}

// All connected cameras: [{ id, kind, label, files: [{ id, name, size }] }].
// `roots` overrides the drive locations (tests).
async function listCameras({ roots, adb = true } = {}) {
  const drives = [];
  for (const root of roots || (await volumeRoots())) {
    const cam = await scanVolume(root);
    if (cam) drives.push(cam);
  }
  return drives.concat(adb ? await scanAdb() : []);
}

function copyWithProgress(src, dest, onBytes) {
  return new Promise((resolve, reject) => {
    const tmp = `${dest}.part`;
    const input = fs.createReadStream(src);
    const output = fs.createWriteStream(tmp);
    input.on('data', (chunk) => onBytes(chunk.length));
    input.on('error', reject);
    output.on('error', reject);
    output.on('finish', () => fsp.rename(tmp, dest).then(resolve, reject));
    input.pipe(output);
  });
}

function adbPull(serial, src, dest) {
  return new Promise((resolve, reject) => {
    const p = spawn(adbCommand(), ['-s', serial, 'pull', src, `${dest}.part`]);
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? fsp.rename(`${dest}.part`, dest).then(resolve, reject) : reject(new Error(`adb pull failed (${code})`))));
  });
}

// Copies the chosen photos into destDir (skipping ones already there with
// the same size). onProgress({ file, index, count, bytes, total }).
async function importFiles(camera, fileIds, destDir, onProgress = () => {}) {
  await fsp.mkdir(destDir, { recursive: true });
  const files = camera.files.filter((f) => fileIds.includes(f.id));
  const total = files.reduce((s, f) => s + f.size, 0);
  let done = 0;
  const imported = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    // Keep the camera's folder in the name: IMG_0001 repeats across folders.
    const dest = path.join(destDir, `${f.folder ? `${f.folder}_` : ''}${f.name}`);
    let existing = null;
    try {
      existing = await fsp.stat(dest);
    } catch {
      // Not there yet.
    }
    if (existing && existing.size === f.size) {
      done += f.size;
    } else if (camera.kind === 'adb') {
      onProgress({ file: f.name, index: i, count: files.length, bytes: done, total });
      await adbPull(camera.serial, f.id, dest);
      done += f.size;
    } else {
      await copyWithProgress(f.id, dest, (n) => {
        done += n;
        onProgress({ file: f.name, index: i, count: files.length, bytes: done, total });
      });
    }
    imported.push(dest);
    onProgress({ file: f.name, index: i + 1, count: files.length, bytes: done, total });
  }
  return imported;
}

// Random access reader over a local file, for reading thumbnails without
// loading whole 50 MB photos.
async function fileReader(file) {
  const handle = await fsp.open(file, 'r');
  const { size } = await handle.stat();
  return {
    size,
    read: async (offset, length) => {
      const buf = Buffer.alloc(Math.max(0, Math.min(length, size - offset)));
      await handle.read(buf, 0, buf.length, offset);
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.length);
    },
    close: () => handle.close(),
  };
}

module.exports = { listCameras, importFiles, scanVolume, volumeRoots, parseLsLong, fileReader, LIGHT_FIELD };
