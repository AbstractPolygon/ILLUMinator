// Raw sensor data and the camera metadata needed to interpret it.

export const ILLUM = { width: 7728, height: 5368, bits: 10 };
export const F01 = { width: 3280, height: 3280, bits: 12 };

const CHANNEL = { r: 0, gr: 1, gb: 1, g: 1, b: 2 };

// Bayer layouts by upper-left pixel, as [[(0,0), (1,0)], [(0,1), (1,1)]].
const MOSAICS = {
  r: [['r', 'gr'], ['gb', 'b']],
  gr: [['gr', 'r'], ['b', 'gb']],
  gb: [['gb', 'b'], ['r', 'gr']],
  b: [['b', 'gb'], ['gr', 'r']],
};

function get(obj, ...path) {
  let o = obj;
  for (const p of path) {
    if (o == null) return undefined;
    o = o[p];
  }
  return o;
}

function first(...values) {
  return values.find((v) => v !== undefined && v !== null);
}

// 10 bit, 4 pixels in 5 bytes: four high bytes then one byte of low bits.
export function unpack10(bytes, count) {
  const out = new Uint16Array(count);
  const n = Math.min(count, Math.floor(bytes.length / 5) * 4);
  for (let i = 0, j = 0; i < n; i += 4, j += 5) {
    const lsb = bytes[j + 4];
    out[i] = (bytes[j] << 2) | (lsb & 3);
    out[i + 1] = (bytes[j + 1] << 2) | ((lsb >> 2) & 3);
    out[i + 2] = (bytes[j + 2] << 2) | ((lsb >> 4) & 3);
    out[i + 3] = (bytes[j + 3] << 2) | ((lsb >> 6) & 3);
  }
  return out;
}

// 12 bit big endian, 2 pixels in 3 bytes.
export function unpack12(bytes, count) {
  const out = new Uint16Array(count);
  const n = Math.min(count, Math.floor(bytes.length / 3) * 2);
  for (let i = 0, j = 0; i < n; i += 2, j += 3) {
    const b1 = bytes[j + 1];
    out[i] = (bytes[j] << 4) | (b1 >> 4);
    out[i + 1] = ((b1 & 15) << 8) | bytes[j + 2];
  }
  return out;
}

export function unpack16le(bytes, count) {
  const out = new Uint16Array(count);
  const n = Math.min(count, bytes.length >> 1);
  for (let i = 0; i < n; i++) out[i] = bytes[2 * i] | (bytes[2 * i + 1] << 8);
  return out;
}

export function packedSize(width, height, bits) {
  return Math.ceil((width * height * bits) / 8);
}

export function unpackRaw(bytes, width, height, bits) {
  const count = width * height;
  if (bits === 10) return unpack10(bytes, count);
  if (bits === 12) return unpack12(bytes, count);
  if (bits === 16) return unpack16le(bytes, count);
  throw new Error(`Unsupported raw bit depth: ${bits}`);
}

// Headerless .RAW dumps (e.g. IMG_0001__frame.raw) are recognised by size.
export function guessRawLayout(byteLength) {
  for (const cam of [ILLUM, F01]) {
    if (byteLength === packedSize(cam.width, cam.height, cam.bits)) return cam;
  }
  return null;
}

function channelGains(obj, fallback) {
  if (!obj) return fallback;
  return [first(obj.r, fallback[0]), first(obj.gr, obj.gb, fallback[1]), first(obj.b, fallback[2])];
}

// Collects everything needed from the (ILLUM or first generation) metadata.
// Works with a missing or partial metadata object by falling back to defaults
// for the camera the image size identifies.
export function cameraInfo(metadata, fallbackLayout) {
  const md = metadata || {};
  const image = md.image || {};
  const raw = image.rawDetails || {};
  const width = first(image.width, get(md, 'devices', 'sensor', 'pixelWidth'), fallbackLayout && fallbackLayout.width);
  const height = first(image.height, get(md, 'devices', 'sensor', 'pixelHeight'), fallbackLayout && fallbackLayout.height);
  const bits = first(get(image, 'pixelPacking', 'bitsPerPixel'), get(raw, 'pixelPacking', 'bitsPerPixel'),
    get(md, 'devices', 'sensor', 'bitsPerPixel'), fallbackLayout && fallbackLayout.bits, 10);
  const isFirstGen = bits === 12 || width === F01.width;
  const model = first(get(md, 'camera', 'model'), isFirstGen ? 'F01' : 'ILLUM');

  const mosaic = first(image.mosaic, raw.mosaic, get(md, 'devices', 'sensor', 'mosaic'), {});
  const upperLeft = MOSAICS[mosaic.upperLeftPixel] ? mosaic.upperLeftPixel : isFirstGen ? 'b' : 'gr';

  const pixelFormat = first(image.pixelFormat, raw.pixelFormat, {});
  const max = 2 ** bits - 1;
  const defaultBlack = isFirstGen ? 168 : 64;
  const black = channelGains(pixelFormat.black, [defaultBlack, defaultBlack, defaultBlack]);
  const white = channelGains(pixelFormat.white, [max, max, max]);

  const color = image.color || {};
  const wb = channelGains(first(get(md, 'algorithms', 'awb', 'computed', 'gain'), color.whiteBalanceGain), [1, 1, 1]);
  const ccm = first(color.ccm, color.ccmRgbToSrgbArray);

  const pixelPitch = first(get(md, 'devices', 'sensor', 'pixelPitch'), 1.4e-6);
  const mlaMd = get(md, 'devices', 'mla') || {};
  const lensPitch = first(mlaMd.lensPitch, isFirstGen ? 1.4e-5 : 2e-5);
  const mla = {
    pitch: (lensPitch / pixelPitch) * first(get(mlaMd, 'scaleFactor', 'x'), 1),
    scaleY: first(get(mlaMd, 'scaleFactor', 'y'), 1),
    rotation: first(mlaMd.rotation, 0),
    offsetX: first(get(mlaMd, 'sensorOffset', 'x'), 0) / pixelPitch,
    offsetY: first(get(mlaMd, 'sensorOffset', 'y'), 0) / pixelPitch,
    tiling: first(mlaMd.tiling, 'hexUniformRowMajor'),
  };

  const lens = get(md, 'devices', 'lens') || {};
  const shutter = get(md, 'devices', 'shutter') || {};
  return {
    model,
    make: first(get(md, 'camera', 'make'), 'Lytro, Inc.'),
    firmware: get(md, 'camera', 'firmware'),
    width,
    height,
    bits,
    upperLeft,
    // cfa[y & 1][x & 1] -> channel index 0 = R, 1 = G, 2 = B
    cfa: MOSAICS[upperLeft].map((row) => row.map((c) => CHANNEL[c])),
    black,
    white,
    wb,
    ccm: Array.isArray(ccm) && ccm.length === 9 ? ccm : null,
    exposureBias: first(image.modulationExposureBias, 0),
    mla,
    capture: {
      time: get(md, 'devices', 'clock', 'zuluTime'),
      iso: first(image.iso, get(md, 'devices', 'sensor', 'iso')),
      exposure: first(shutter.frameExposureDuration, shutter.pixelExposureDuration),
      fNumber: lens.fNumber,
      focalLength: lens.focalLength,
      dcfFile: get(md, 'picture', 'dcfFile'),
    },
  };
}
