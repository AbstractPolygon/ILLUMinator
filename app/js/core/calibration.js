// Camera calibration data (an ILLUM "caldata" backup). Each camera has its
// own: a list of defective pixels, white images, the microlens grid at every
// zoom and focus setting, and more. Pieces are read here one at a time.

import { scanTar, readTarEntry } from './tar.js';
import { cameraInfo, unpackRaw } from './raw.js';
import { gridFromCamera, lensCenters, lensCenter, toLocal } from './lenslet.js';

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

// ---------------------------------------------------------------- white images

// A white image is a picture of an evenly lit white surface, one per zoom and
// focus setting the camera was calibrated at. Under it every microlens shows
// as a bright disc, so the disc's center is the lens's true center. Here each
// lens's center is measured as the brightness-weighted center of its disc and
// kept as its offset from the lens grid of that white image, in 1/WHITE_SCALE
// raw pixels (one byte each; -128 marks a lens that could not be measured).
export const WHITE_SCALE = 128;

// `meta`: the white image's .TXT (its camera metadata, as JSON text).
export function measureWhite(rawBytes, meta) {
  const md = JSON.parse(meta).master.picture.frameArray[0].frame.metadata;
  const cam = cameraInfo(md);
  const { width, height } = cam;
  const raw = unpackRaw(rawBytes, width, height, cam.bits);
  const grid = gridFromCamera(cam);
  const lc = lensCenters(grid, width, height);
  const black = cam.black[0];
  const R = grid.pitch * 0.42;
  const off = new Int8Array(lc.rows * lc.cols * 2).fill(-128);
  for (let i = 0; i < lc.rows * lc.cols; i++) {
    const cx = lc.cx[i];
    const cy = lc.cy[i];
    if (cx < R + 2 || cy < R + 2 || cx > width - R - 2 || cy > height - R - 2) continue;
    let sx = 0;
    let sy = 0;
    let s = 0;
    for (let y = Math.ceil(cy - R); y <= cy + R; y++) {
      for (let x = Math.ceil(cx - R); x <= cx + R; x++) {
        const dx = x - cx;
        const dy = y - cy;
        if (dx * dx + dy * dy > R * R) continue;
        const v = Math.max(0, raw[y * width + x] - black);
        sx += v * dx;
        sy += v * dy;
        s += v;
      }
    }
    if (!(s > 0)) continue;
    off[2 * i] = Math.max(-127, Math.min(127, Math.round((sx / s) * WHITE_SCALE)));
    off[2 * i + 1] = Math.max(-127, Math.min(127, Math.round((sy / s) * WHITE_SCALE)));
  }
  return { grid, r0: lc.r0, c0: lc.c0, rows: lc.rows, cols: lc.cols, off };
}

// Fills `table` (superres.js lensTable: the lenses of a photo whose lens grid
// is `grid`) with each lens's measured offset from the smooth grid of its
// white image. Lenses are matched by position, so the two grids need not share
// an origin; a shift all lenses have in common is left to the grid and removed. Returns how many
// lenses got an offset.
export function whiteOffsets(white, grid, table) {
  const w = white;
  const found = [];
  for (let r = 0; r < table.rows; r++) {
    for (let c = 0; c < table.cols; c++) {
      const [px, py] = lensCenter(grid, r + table.r0, c + table.c0);
      const [lx, ly] = toLocal(w.grid, px, py);
      const rw = Math.round(ly / w.grid.rowStep);
      const cw = Math.round((lx - (rw & 1) * w.grid.pitch * 0.5) / w.grid.pitch);
      const rr = rw - w.r0;
      const cc = cw - w.c0;
      if (rr < 0 || cc < 0 || rr >= w.rows || cc >= w.cols) continue;
      const k = (rr * w.cols + cc) * 2;
      if (w.off[k] === -128) continue;
      // Only the lens's offset from the smooth grid carries over: the whole
      // array moves with focus, so the white image's absolute positions are
      // not those of the photo.
      const dx = w.off[k] / WHITE_SCALE;
      const dy = w.off[k + 1] / WHITE_SCALE;
      // A lens farther than this from its grid place is a bad match.
      if (Math.abs(dx) > 1.5 || Math.abs(dy) > 1.5) continue;
      found.push(r * table.cols + c, dx, dy);
    }
  }
  const n = found.length / 3;
  if (!n) return 0;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < found.length; i += 3) {
    mx += found[i + 1];
    my += found[i + 2];
  }
  mx /= n;
  my /= n;
  for (let i = 0; i < found.length; i += 3) {
    table.dx[found[i]] = found[i + 1] - mx;
    table.dy[found[i]] = found[i + 2] - my;
  }
  return n;
}

const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
const sha1 = async (bytes) => hex(await crypto.subtle.digest('SHA-1', bytes));

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
export async function importCalibration(source, storage, { onProgress = () => {}, measure = measureWhite } = {}) {
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
  // White images: kept as each lens's measured center (a few hundred kilobytes
  // each), found again by the SHA-1 of the geometry file made with them.
  const whites = [];
  const byName = new Map(entries.map((e) => [e.name.toUpperCase(), e]));
  const raws = entries.filter((e) => /^MOD_\d+\.RAW$/i.test(e.name));
  for (const [i, e] of raws.entries()) {
    const stem = e.name.replace(/\.RAW$/i, '');
    const txt = byName.get(`${stem}.TXT`.toUpperCase());
    const gct = byName.get(`${stem}.GCT`.toUpperCase());
    if (!txt || !gct) continue;
    onProgress((i + 0.5) / raws.length, `white image ${i + 1} of ${raws.length}`);
    try {
      const m = await measure(await e.read(), decode.decode(await txt.read()));
      await storage.writeBlob(`${dir}/White_${stem}.bin`, new Blob([m.off]));
      const { off, ...meta } = m;
      whites.push({ stem, gct: await sha1(await gct.read()), ...meta });
    } catch (err) {
      console.warn(`White image ${stem} not used`, err);
    }
  }
  const info = { serial, imported: new Date().toISOString(), saved, left: left.filter((l) => !whites.some((w) => `${w.stem}.RAW`.toUpperCase() === l.name.toUpperCase())), whites: whites.map(({ off, ...w }) => w), hotPixels: seen.has('HOTPIXEL.BIN') };
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
  const index = JSON.parse((await storage.readText(`${dir}/index.json`)) || '{}');
  const whites = [];
  for (const w of index.whites || []) {
    const f = await storage.file(`${dir}/White_${w.stem}.bin`);
    if (f) whites.push({ ...w, off: new Int8Array(await f.arrayBuffer()) });
  }
  return { serial, hotPixelFile: file ? new Uint8Array(await file.arrayBuffer()) : null, whites };
}

export async function removeCalibration(storage, serial) {
  await storage.remove(`${CALIBRATION_DIR}/${safeName(serial)}`);
}
