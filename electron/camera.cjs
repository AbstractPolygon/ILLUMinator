// Finds Lytro cameras connected over USB and imports their photos, three
// ways:
//   - the camera's own USB protocol (lytro-usb.cjs, lytro-protocol.cjs), the
//     way the first generation camera is reached by Lytro Desktop; kind
//     'lytro'. Not checked on the ILLUM, which may answer it too.
//   - a USB mass storage drive holding DCIM/<nnn>PHOTO/IMG_xxxx.LFR (the
//     ILLUM's card in a card reader); kind 'drive'.
//   - Android debugging (hold AEL + Lytro while switching on), the route
//     Lytro's own power tools used (the ILLUM runs Android; USB vendor
//     0x24CF is in its adb_usb.ini); needs adb installed; kind 'adb'.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const lytroUsb = require('./lytro-usb.cjs');
const lytroScsi = require('./lytro-scsi-win.cjs');
const { LytroCamera } = require('./lytro-protocol.cjs');

const LIGHT_FIELD = /\.(lfr|lfp)$/i;
// Lytro, Inc.'s USB vendor ID (usb.ids), shared by its cameras.
const LYTRO_USB_VENDOR = 0x24cf;

function isLytroUsb(device) {
  return !!device && device.vendorId === LYTRO_USB_VENDOR;
}
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
  // Lytro Desktop (WinSDCardCamera) knows an ILLUM drive by MISC/.LYT_VER.inf
  // and DCIM; a camera with no photos yet still shows up, empty.
  const dcim = path.join(root, 'DCIM');
  const isLytro = await isDir(path.join(root, 'MISC')) && (await readJson(path.join(root, 'MISC', '.LYT_VER.inf'))) !== null;
  if (!(await isDir(dcim)) && !isLytro) return null;
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
  if (!files.length && !isLytro) return null;
  const info = await driveInfo(root);
  return { id: `drive:${root}`, kind: 'drive', label: `Camera drive ${root}`, root, files, info, hasCalibration: await isDir(path.join(root, CALIBRATION_FOLDER)) };
}

// An ILLUM shown as a drive keeps its factory calibration in <drive>/unitdata
// (listed in cal_file_manifest.json) and its firmware in MISC/.LYT_VER.inf.
const CALIBRATION_FOLDER = 'unitdata';

async function readJson(file) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

async function driveInfo(root) {
  const version = await readJson(path.join(root, 'MISC', '.LYT_VER.inf'));
  const unit = await readJson(path.join(root, CALIBRATION_FOLDER, 'unit_info.json'));
  return {
    firmware: (version && (version['fw-version'] || version.fwVersion)) || null,
    model: (version && version.model) || null,
    // The version file names the serial too; unit_info.json is the fallback.
    serial: (version && version.serial && String(version.serial).trim()) || (unit && unit.camera && String(unit.camera.serialNumber || '').trim()) || null,
  };
}

// Copies the calibration folder of a camera drive to <destDir>/cameras/<serial>.
async function pullDriveCalibration(root, destDir) {
  const source = path.join(root, CALIBRATION_FOLDER);
  if (!(await isDir(source))) throw new Error('This camera drive has no unitdata folder.');
  const { serial } = await driveInfo(root);
  const dest = path.join(destDir, 'cameras', serial || path.basename(root.replace(/[\\/]+$/, '')) || 'camera');
  await fsp.cp(source, dest, { recursive: true });
  return dest;
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

// The ILLUM keeps its factory calibration in the `unitdata` folder (the
// serial number is in unit_info.json); Lytro's power tools pulled it with
// `adb pull unitdata`, after `adb root`. Returns the folder written.
async function pullAdbCalibration(serial, destDir) {
  const run1 = (args) => run(adbCommand(), ['-s', serial, ...args], 30000);
  const info = await run1(['shell', 'cat', 'unitdata/unit_info.json']);
  let camera = serial;
  try {
    camera = JSON.parse(info).camera.serialNumber.trim() || serial;
  } catch {
    // No readable unit info: file the data under the adb serial.
  }
  const dest = path.join(destDir, 'cameras', camera);
  await fsp.mkdir(dest, { recursive: true });
  await new Promise((resolve, reject) => {
    const p = spawn(adbCommand(), ['-s', serial, 'pull', 'unitdata', dest]);
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`adb pull failed (${code}); the camera may need adb root`))));
  });
  return dest;
}

// Cameras reached over the camera's own USB protocol, kept open between
// scans (asking a camera for its picture list over and over upsets it):
// device key -> { entry, close } or { failed } when it could not be used.
const usbCameras = new Map();
const usbLog = [];
const log = (line) => {
  usbLog.push(`${new Date().toISOString()} ${line}`);
  if (usbLog.length > 400) usbLog.shift();
};

async function openUsbCamera(found) {
  try {
    // The first generation camera on Windows is reached through its disk, as
    // Lytro Desktop does; otherwise over USB (libusb).
    const { camera, close, product } = found.scsi ? await lytroScsi.connect(found, log) : await lytroUsb.connect(found, log);
    const info = await camera.hardwareInfo();
    log(`hardware info: ${JSON.stringify(info)}`);
    const pictures = await camera.pictureList();
    log(`${pictures.length} pictures`);
    const label = `Lytro camera${info.serial ? ` ${info.serial}` : ''} (USB)`;
    const entry = {
      id: `lytro:${found.key}`,
      kind: 'lytro',
      label,
      info,
      product,
      camera,
      pictures,
      files: pictures.map((p) => ({ id: p.id, name: p.name, folder: p.folder, size: 0 })),
    };
    return { entry, close };
  } catch (err) {
    // A first generation camera on Windows should have been reached through its disk: say why that did not work.
    const why = !found.scsi && process.platform === 'win32' && found.product === lytroUsb.FIRST_GENERATION_PRODUCT ? ` Reaching it through its disk did not work: ${lytroScsi.scanStatus()}` : '';
    log(`failed: ${err.message}${why}`);
    return { failed: err.message + why, at: Date.now() };
  }
}

const USB_RETRY_MS = 30000;

async function scanLytroUsb() {
  const scsi = process.platform === 'win32' ? lytroScsi.listDevices().map((d) => ({ ...d, product: lytroUsb.FIRST_GENERATION_PRODUCT, scsi: true })) : [];
  // On Windows the first generation camera is taken through its disk (above):
  // its USB entry is the same camera.
  const present = scsi.concat(lytroUsb.listDevices().filter((d) => !(scsi.length && d.product === lytroUsb.FIRST_GENERATION_PRODUCT)));
  const keys = new Set(present.map((d) => d.key));
  for (const [key, c] of usbCameras) {
    if (!keys.has(key)) {
      if (c.close) await c.close();
      usbCameras.delete(key);
    }
  }
  const out = [];
  for (const found of present) {
    let c = usbCameras.get(found.key);
    if (!c || (c.failed && Date.now() - c.at > USB_RETRY_MS)) {
      c = await openUsbCamera(found);
      usbCameras.set(found.key, c);
    }
    if (c.entry) out.push(c.entry);
  }
  return out;
}

// What went wrong the last time a Lytro on USB could not be used, if it is
// plugged in, and the protocol log (for sending in).
function usbProblems() {
  return [...usbCameras.values()].filter((c) => c.failed).map((c) => c.failed);
}

function usbDiagnostics() {
  return usbLog.join('\n');
}

// Saves the first generation camera's calibration files (C:\\T1CALIB\\MOD_xxxx)
// to <destDir>/cameras/<serial>/T1CALIB. Returns the folder.
async function pullUsbCalibration(entry, destDir, onFile = () => {}) {
  const files = await entry.camera.calibrationFiles(onFile);
  if (!files.length) throw new Error('The camera has no calibration files to read.');
  const dest = path.join(destDir, 'cameras', (entry.info && entry.info.serial) || 'camera', 'T1CALIB');
  await fsp.mkdir(dest, { recursive: true });
  for (const f of files) await fsp.writeFile(path.join(dest, f.name), f.data);
  return dest;
}

// All connected cameras: [{ id, kind, label, files: [{ id, name, size }] }].
// `roots` overrides the drive locations (tests).
let lastWake = 0;
async function listCameras({ roots, adb = true, lytro = true } = {}) {
  if (!roots && lytro && process.platform === 'win32' && Date.now() - lastWake > 20000) {
    lastWake = Date.now();
    try {
      lytroScsi.wakeStorage(log);
    } catch (err) {
      log(`storage wake failed: ${err.message}`);
    }
  }
  const drives = [];
  for (const root of roots || (await volumeRoots())) {
    const cam = await scanVolume(root);
    if (cam) drives.push(cam);
  }
  const usbFound = lytro ? await scanLytroUsb() : [];
  return usbFound.concat(drives, adb ? await scanAdb() : []);
}

// A PNG of 8 bit RGB pixels (a first generation camera's thumbnail may be raw).
function crc32(buf) {
  let c;
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngOfRgb(rgb, width, height) {
  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'latin1');
    data.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // RGB
  const rows = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) rgb.copy(rows, y * (width * 3 + 1) + 1, y * width * 3, (y + 1) * width * 3);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', require('node:zlib').deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}

// The first generation camera's thumbnail file (.128) is a raw 128 x 128 picture whose pixel format is not documented. Every plausible layout for the file's
// size is decoded and the one that reads as a picture (smooth, as a photo is; a wrong layout is colour noise) is used.
const SIDE = 128;
const NPIX = SIDE * SIDE;
const u8 = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

function yuvToRgb(out, i, y, u, v) {
  out[i * 3] = u8(y + 1.402 * (v - 128));
  out[i * 3 + 1] = u8(y - 0.344 * (u - 128) - 0.714 * (v - 128));
  out[i * 3 + 2] = u8(y + 1.772 * (u - 128));
}

const planar = (order) => (d) => {
  const out = Buffer.alloc(NPIX * 3);
  for (let i = 0; i < NPIX; i++) for (let c = 0; c < 3; c++) out[i * 3 + order[c]] = d[c * NPIX + i];
  return out;
};
const packed = (bytes, map) => (d) => {
  const out = Buffer.alloc(NPIX * 3);
  for (let i = 0; i < NPIX; i++) for (let c = 0; c < 3; c++) out[i * 3 + c] = d[i * bytes + map[c]];
  return out;
};
const rgb565 = (big) => (d) => {
  const out = Buffer.alloc(NPIX * 3);
  for (let i = 0; i < NPIX; i++) {
    const v = big ? (d[i * 2] << 8) | d[i * 2 + 1] : d[i * 2] | (d[i * 2 + 1] << 8);
    out[i * 3] = ((v >> 11) & 31) * 255 / 31;
    out[i * 3 + 1] = ((v >> 5) & 63) * 255 / 63;
    out[i * 3 + 2] = (v & 31) * 255 / 31;
  }
  return out;
};
const yuv422 = (order) => (d) => {
  const out = Buffer.alloc(NPIX * 3);
  for (let i = 0; i < NPIX; i++) {
    const o = (i >> 1) * 4;
    yuvToRgb(out, i, d[o + order[i & 1 ? 2 : 0]], d[o + order[1]], d[o + order[3]]);
  }
  return out;
};
const grey = (stride, at) => (d) => {
  const out = Buffer.alloc(NPIX * 3);
  for (let i = 0; i < NPIX; i++) out[i * 3] = out[i * 3 + 1] = out[i * 3 + 2] = d[i * stride + at];
  return out;
};
// Planar 4:2:0: Y plane, then U and V (V first for YV12); NV12/NV21 have the chroma interleaved.
const yuv420 = (kind) => (d) => {
  const out = Buffer.alloc(NPIX * 3);
  const q = NPIX >> 2;
  for (let i = 0; i < NPIX; i++) {
    const x = i % SIDE;
    const y = (i / SIDE) | 0;
    const c = (y >> 1) * (SIDE >> 1) + (x >> 1);
    let u;
    let v;
    if (kind === 'i420') { u = d[NPIX + c]; v = d[NPIX + q + c]; }
    else if (kind === 'yv12') { v = d[NPIX + c]; u = d[NPIX + q + c]; }
    else if (kind === 'nv12') { u = d[NPIX + c * 2]; v = d[NPIX + c * 2 + 1]; }
    else { v = d[NPIX + c * 2]; u = d[NPIX + c * 2 + 1]; }
    yuvToRgb(out, i, d[i], u, v);
  }
  return out;
};
// A Bayer mosaic with 2 x 2 blocks taken as one colour (pattern: where red, green, green, blue sit in the block).
const bayer = (pos) => (d) => {
  const out = Buffer.alloc(NPIX * 3);
  for (let y = 0; y < SIDE; y += 2) {
    for (let x = 0; x < SIDE; x += 2) {
      const at = [d[y * SIDE + x], d[y * SIDE + x + 1], d[(y + 1) * SIDE + x], d[(y + 1) * SIDE + x + 1]];
      const rgb = [at[pos[0]], (at[pos[1]] + at[pos[2]]) / 2, at[pos[3]]];
      for (const [dy, dx] of [[0, 0], [0, 1], [1, 0], [1, 1]]) for (let c = 0; c < 3; c++) out[((y + dy) * SIDE + x + dx) * 3 + c] = rgb[c];
    }
  }
  return out;
};

// [name, bytes per pixel, decoder], in the order preferred when two read equally well.
const RAW_LAYOUTS = [
  ['rgb', 3, packed(3, [0, 1, 2])], ['bgr', 3, packed(3, [2, 1, 0])], ['planar-rgb', 3, planar([0, 1, 2])], ['planar-bgr', 3, planar([2, 1, 0])],
  ['rgba', 4, packed(4, [0, 1, 2])], ['bgra', 4, packed(4, [2, 1, 0])], ['argb', 4, packed(4, [1, 2, 3])], ['abgr', 4, packed(4, [3, 2, 1])],
  ['yuyv', 2, yuv422([0, 1, 2, 3])], ['uyvy', 2, yuv422([1, 0, 3, 2])], ['rgb565', 2, rgb565(false)], ['rgb565-be', 2, rgb565(true)],
  ['rgb48', 6, packed(6, [1, 3, 5])], ['rgb48-be', 6, packed(6, [0, 2, 4])], ['grey16', 2, grey(2, 1)], ['grey16-be', 2, grey(2, 0)],
  ['i420', 1.5, yuv420('i420')], ['yv12', 1.5, yuv420('yv12')], ['nv12', 1.5, yuv420('nv12')], ['nv21', 1.5, yuv420('nv21')],
  ['grey', 1, grey(1, 0)], ['bayer-rggb', 1, bayer([0, 1, 2, 3])], ['bayer-bggr', 1, bayer([3, 1, 2, 0])], ['bayer-grbg', 1, bayer([1, 0, 3, 2])], ['bayer-gbrg', 1, bayer([2, 0, 3, 1])],
];

// How noisy an RGB picture is: the mean difference between neighbouring pixels in each channel, against the spread of the channels. A photo is smooth; a wrongly read layout is not.
function noise(rgb) {
  let diff = 0;
  let spread = 0;
  for (let c = 0; c < 3; c++) {
    let sum = 0;
    let sq = 0;
    for (let i = 0; i < NPIX; i++) {
      const v = rgb[i * 3 + c];
      sum += v;
      sq += v * v;
      const x = i % SIDE;
      if (x < SIDE - 1) diff += Math.abs(v - rgb[(i + 1) * 3 + c]);
      if (i + SIDE < NPIX) diff += Math.abs(v - rgb[(i + SIDE) * 3 + c]);
    }
    spread += Math.sqrt(Math.max(0, sq / NPIX - (sum / NPIX) ** 2));
  }
  return (diff / (NPIX * 6)) / (spread / 3 + 4);
}

// { name, rgb, scores } of the layout of a 128 x 128 raw thumbnail, or null when the size fits none of them. Data after a header of up to 1 KB counts.
function decodeRawThumbnail(data) {
  let best = null;
  const scores = {};
  for (const [name, bpp, decode] of RAW_LAYOUTS) {
    const head = data.length - NPIX * bpp;
    if (head < 0 || head > 1024) continue;
    const rgb = decode(data.subarray(head));
    const score = noise(rgb);
    scores[name] = Number(score.toFixed(4));
    // A later layout has to read clearly better than the earlier one.
    if (!best || score < best.score * 0.9) best = { name, rgb, score };
  }
  return best ? { name: best.name, rgb: best.rgb, scores } : null;
}

// The picture of a first generation camera's thumbnail file (.128): a JPEG or PNG (maybe after a header) as it is, a raw picture as a PNG, anything else null.
function thumbnailPicture(data) {
  if (!data || data.length < 16) return null;
  if (data[0] === 0xff && data[1] === 0xd8) return { mime: 'image/jpeg', bytes: data, width: SIDE, height: SIDE };
  const jpeg = data.indexOf(Buffer.from([0xff, 0xd8, 0xff]));
  if (jpeg > 0 && jpeg < 4096) return { mime: 'image/jpeg', bytes: data.subarray(jpeg), width: SIDE, height: SIDE };
  const png = data.indexOf(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  if (png >= 0 && png < 4096) return { mime: 'image/png', bytes: data.subarray(png), width: SIDE, height: SIDE };
  const raw = decodeRawThumbnail(data);
  if (raw) return { mime: 'image/png', bytes: pngOfRgb(raw.rgb, SIDE, SIDE), width: SIDE, height: SIDE, layout: raw.name, scores: raw.scores };
  // Some other square of 8 bit RGB.
  const side = Math.round(Math.sqrt(data.length / 3));
  if (side * side * 3 === data.length) return { mime: 'image/png', bytes: pngOfRgb(data, side, side), width: side, height: side, layout: 'rgb' };
  return null;
}

// An LFP file from the parts a first generation camera hands out for a picture: RAW (sensor data), TXT (metadata, JSON) and 128 (thumbnail, optional).
// The TXT file is { master: { picture: { frameArray: [{ frame: { metadata, privateMetadata } }] } }, compressedFrame, debug }: the frame's metadata is inside `master`.
async function assembleLfp({ raw, txt, thumb = null }) {
  const lfp = await import(pathToFileURL(path.join(__dirname, '..', 'app', 'js', 'core', 'lfp.js')).href);
  const parsed = JSON.parse(txt.toString('utf8').replace(/\0+$/, ''));
  const inner = parsed.master && parsed.master.picture && parsed.master.picture.frameArray && parsed.master.picture.frameArray[0] && parsed.master.picture.frameArray[0].frame;
  const metadata = inner && inner.metadata ? inner.metadata : parsed.metadata || parsed;
  const privateMetadata = (inner && inner.privateMetadata) || parsed.privateMetadata || parsed.private || {};
  const metaBytes = lfp.encodeJson(metadata);
  const privBytes = lfp.encodeJson(privateMetadata);
  const rawBytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.length);
  const picture = thumbnailPicture(thumb);
  const toc = {
    picture: {
      frameArray: [{
        frame: {
          metadataRef: await lfp.refFor(metaBytes),
          privateMetadataRef: await lfp.refFor(privBytes),
          imageRef: await lfp.refFor(rawBytes),
        },
      }],
    },
  };
  const sections = [
    { type: 'LFC', data: metaBytes },
    { type: 'LFC', data: privBytes },
    { type: 'LFC', data: rawBytes },
  ];
  if (picture) {
    const thumbBytes = new Uint8Array(picture.bytes.buffer, picture.bytes.byteOffset, picture.bytes.length);
    toc.thumbnailArray = [{ imageRef: await lfp.refFor(thumbBytes), width: picture.width, height: picture.height, representation: picture.mime === 'image/png' ? 'png' : 'jpeg' }];
    sections.push({ type: 'LFC', data: thumbBytes });
  }
  sections.push({ type: 'LFM', data: lfp.encodeJson(toc) });
  const { bytes } = await lfp.writeContainer(sections);
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length);
}

// The camera answers one request at a time: thumbnails (the grid asks for many at once) and downloads queue here.
function withCamera(entry, fn) {
  const run = (entry.busy || Promise.resolve()).then(fn, fn);
  entry.busy = run.catch(() => {});
  return run;
}

// The thumbnail of a picture on a first generation camera reached over USB or its disk: { mime, bytes } or null. Kept, as asking the camera is slow.
const thumbnailCache = new Map();
async function lytroThumbnail(entry, fileId) {
  const key = `${entry.id}/${fileId}`;
  if (thumbnailCache.has(key)) return thumbnailCache.get(key);
  const pic = entry.pictures.find((p) => p.id === fileId);
  if (!pic || entry.product !== lytroUsb.FIRST_GENERATION_PRODUCT) return null;
  try {
    const result = await withCamera(entry, async () => {
      const data = await entry.camera.download('file', LytroCamera.pathOf(pic, '128'));
      const t = thumbnailPicture(data);
      if (!t) {
        log(`thumbnail of ${pic.name} is in a form not understood: ${data.length} bytes, starting ${Buffer.from(data.subarray(0, 16)).toString('hex')}`);
        return null;
      }
      log(`thumbnail of ${pic.name}: ${data.length} bytes, ${t.mime}${t.layout ? `, read as ${t.layout} (${JSON.stringify(t.scores || {})}), starting ${Buffer.from(data.subarray(0, 16)).toString('hex')}` : ''}`);
      return { mime: t.mime, bytes: t.bytes };
    });
    thumbnailCache.set(key, result);
    return result;
  } catch (err) {
    // Not kept: the camera may only have been busy.
    log(`no thumbnail for ${pic.name}: ${err.message}`);
    return null;
  }
}

// A picture off a camera on its own USB protocol: the ILLUM's single
// .LFR file where the camera has one (tried first when it is not the first
// generation), else the first generation's parts, put together as a .LFP.
async function downloadLytroPicture(entry, file) {
  const pic = entry.pictures.find((p) => p.id === file.id);
  if (!pic) throw new Error('That picture is no longer on the camera.');
  const cam = entry.camera;
  return withCamera(entry, () => downloadLytroPictureNow(entry, file, pic, cam));
}

async function downloadLytroPictureNow(entry, file, pic, cam) {
  const firstGeneration = entry.product === lytroUsb.FIRST_GENERATION_PRODUCT;
  if (!firstGeneration) {
    try {
      return { name: `${pic.folder}_${pic.name}.LFR`, data: await cam.download('file', LytroCamera.pathOf(pic, 'LFR')) };
    } catch (err) {
      log(`no .LFR file for ${pic.name}: ${err.message}`);
    }
  }
  const raw = await cam.download('file', LytroCamera.pathOf(pic, 'RAW'));
  const txt = await cam.download('file', LytroCamera.pathOf(pic, 'TXT'));
  const thumb = await cam.download('file', LytroCamera.pathOf(pic, '128')).catch(() => null);
  return { name: `${pic.folder}_${pic.name}.lfp`, data: await assembleLfp({ raw, txt, thumb }) };
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
    } else if (camera.kind === 'lytro') {
      onProgress({ file: f.name, index: i, count: files.length, bytes: done, total });
      const got = await downloadLytroPicture(camera, f);
      const out = path.join(destDir, got.name);
      await fsp.writeFile(`${out}.part`, got.data);
      await fsp.rename(`${out}.part`, out);
      imported.push(out);
      onProgress({ file: f.name, index: i + 1, count: files.length, bytes: done, total });
      continue;
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

module.exports = { lytroThumbnail, thumbnailPicture, decodeRawThumbnail, pullUsbCalibration, pullDriveCalibration, driveInfo, pullAdbCalibration, usbProblems, usbDiagnostics, assembleLfp, LYTRO_USB_VENDOR, isLytroUsb, listCameras, importFiles, scanVolume, volumeRoots, parseLsLong, fileReader, LIGHT_FIELD };
