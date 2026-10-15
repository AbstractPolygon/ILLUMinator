// Camera calibration data (an ILLUM "caldata" backup). Each camera has its
// own: a list of defective pixels, white images, the microlens grid at every
// zoom and focus setting, and more. Pieces are read here one at a time.

import { scanTar, readTarEntry } from './tar.js';

// HOTPIXEL.BIN: a 32-bit count N, then N/2 column entries followed by N/2
// row pairs, all little-endian 32-bit words made of two 16-bit halves.
//   first half:  the column x of each entry (both halves equal x)
//   second half: two rows of that column, (rowB << 16) | rowA
// So the file lists N defective pixels, two per entry. Returns the sorted
// pixel indices (y * width + x), or null when the file does not fit.
export function parseHotPixels(bytes, width, height) {
  if (!bytes || bytes.length < 8) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const n = view.getUint32(0, true);
  const half = n / 2;
  if (!Number.isInteger(half) || n === 0 || bytes.length < 4 + n * 4) return null;
  const out = new Uint32Array(n);
  let k = 0;
  for (let i = 0; i < half; i++) {
    const x = view.getUint32(4 + i * 4, true) & 0xffff;
    const rows = view.getUint32(4 + (half + i) * 4, true);
    if (x >= width) return null;
    for (const y of [rows & 0xffff, rows >>> 16]) {
      if (y >= height) return null;
      out[k++] = y * width + x;
    }
  }
  return out.sort().filter((v, i, a) => i === 0 || v !== a[i - 1]);
}

// Builds a HOTPIXEL.BIN (for tests).
export function makeHotPixelFile(entries) {
  const out = new Uint8Array(4 + entries.length * 8);
  const view = new DataView(out.buffer);
  view.setUint32(0, entries.length * 2, true);
  entries.forEach(([x, a, b], i) => {
    view.setUint32(4 + i * 4, ((x << 16) | x) >>> 0, true);
    view.setUint32(4 + (entries.length + i) * 4, ((b << 16) | a) >>> 0, true);
  });
  return out;
}

// ---------------------------------------------------------------- importing

// A backup holds big white images next to the small tables. The tables and
// hot pixel list are kept; files over this size are left where they are.
export const KEEP_BYTES = 4 * 1024 * 1024;
export const CALIBRATION_DIR = 'Calibration';

const base = (path) => path.split('/').pop();

// Entries of a calibration source as { name, size, read() }: a .tar (never
// loaded whole) or a list of files from a picked folder.
export async function calibrationEntries(source) {
  if (Array.isArray(source)) {
    return source.map((s) => ({ name: base(s.path || s.file.name), size: s.file.size, read: async () => new Uint8Array(await s.file.arrayBuffer()) }));
  }
  const tar = await scanTar(source);
  return tar.map((e) => ({ name: base(e.name), size: e.size, read: () => readTarEntry(source, e) }));
}

const decode = new TextDecoder();

// Reads the camera's serial number from the unit data.
export async function findSerial(entries) {
  const unit = entries.find((e) => e.name.toLowerCase() === 'unit_info.json');
  if (!unit) return null;
  try {
    const json = JSON.parse(decode.decode(await unit.read()));
    return json && json.camera && json.camera.serialNumber ? String(json.camera.serialNumber) : null;
  } catch {
    return null;
  }
}

const safeName = (s) => s.replace(/[^A-Za-z0-9._-]/g, '_');

// Keeps the small files of a calibration source under Calibration/<serial>/.
// Returns { serial, saved, left, hotPixels }.
export async function importCalibration(source, storage, { onProgress = () => {} } = {}) {
  const entries = await calibrationEntries(source);
  const serial = await findSerial(entries);
  if (!serial) throw new Error('This does not look like camera calibration data: there is no unit_info.json with a serial number in it.');
  const dir = `${CALIBRATION_DIR}/${safeName(serial)}`;
  await storage.remove(dir).catch(() => {});
  const keep = entries.filter((e) => e.size <= KEEP_BYTES);
  const left = entries.filter((e) => e.size > KEEP_BYTES).map((e) => ({ name: e.name, size: e.size }));
  const seen = new Set();
  let saved = 0;
  for (const [i, e] of keep.entries()) {
    if (seen.has(e.name)) continue;
    seen.add(e.name);
    onProgress(i / keep.length, e.name);
    const bytes = await e.read();
    await storage.writeBlob(`${dir}/${safeName(e.name)}`, new Blob([bytes]));
    saved++;
  }
  const info = { serial, imported: new Date().toISOString(), saved, left, hotPixels: seen.has('HOTPIXEL.BIN') };
  await storage.writeText(`${dir}/index.json`, JSON.stringify(info));
  return info;
}

// The cameras whose calibration is kept: [{ serial, imported, saved, ... }].
export async function listCalibrations(storage) {
  const out = [];
  for (const d of await storage.list(CALIBRATION_DIR)) {
    if (!d.dir) continue;
    try {
      const text = await storage.readText(`${CALIBRATION_DIR}/${d.name}/index.json`);
      if (text) out.push(JSON.parse(text));
    } catch {
      // Unreadable entries are skipped.
    }
  }
  return out;
}

// What rendering needs from one camera's kept calibration.
export async function loadCalibration(storage, serial) {
  const dir = `${CALIBRATION_DIR}/${safeName(serial)}`;
  const file = await storage.file(`${dir}/HOTPIXEL.BIN`);
  return { serial, hotPixelFile: file ? new Uint8Array(await file.arrayBuffer()) : null };
}

export async function removeCalibration(storage, serial) {
  await storage.remove(`${CALIBRATION_DIR}/${safeName(serial)}`);
}
