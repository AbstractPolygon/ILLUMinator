// Generates a synthetic ILLUM-style LFR: a layered 3D scene seen through a
// hexagonal microlens array, mosaiced and packed exactly like camera output.
// Used by the test suite and the "sample" button so the app can be tried
// without a camera.

import { writeContainer, encodeJson, refFor } from './lfp.js';

const SQRT3_2 = Math.sqrt(3) / 2;

function hash(x, y) {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

// Scene layers from back to front. Each has a disparity: sensor pixels of
// image shift per sensor pixel of aperture offset.
function makeScene(width, height) {
  const cx = width / 2;
  const cy = height / 2;
  const unit = Math.min(width, height);
  return [
    {
      disparity: -0.45,
      color(x, y) {
        const t = (x / width) * 6.283;
        const checker = (Math.floor(x / (unit * 0.06)) + Math.floor(y / (unit * 0.06))) & 1;
        const k = checker ? 0.85 : 0.45;
        return [k * (0.5 + 0.4 * Math.sin(t)), k * (0.55 + 0.35 * Math.sin(t + 2.1)), k * (0.6 + 0.35 * Math.sin(t + 4.2))];
      },
      covers: () => true,
    },
    {
      disparity: 0,
      color(x, y) {
        const ring = Math.floor(Math.hypot(x - cx, y - cy) / (unit * 0.025)) & 1;
        return ring ? [0.95, 0.75, 0.2] : [0.8, 0.25, 0.15];
      },
      covers: (x, y) => Math.hypot(x - cx, y - cy) < unit * 0.27,
    },
    {
      disparity: 0.45,
      color(x, y) {
        // Coarse bands (resolvable per lens) plus fine noise (finer than a lens).
        const band = Math.floor(y / 40) & 1 ? 0.25 : 0;
        const n = hash(Math.floor(x / 6), Math.floor(y / 6));
        return [0.15 + 0.2 * n + band * 0.4, 0.3 + 0.3 * n + band, 0.3 + 0.2 * n];
      },
      covers(x, y) {
        const bars = [cx - unit * 0.42, cx + unit * 0.3];
        return bars.some((bx) => x > bx && x < bx + unit * 0.1 && y > cy - unit * 0.38 && y < cy + unit * 0.38);
      },
    },
  ];
}

// options: { width, height, pitch, rotation }
export async function makeSyntheticLfr(options = {}) {
  const width = options.width || 7728;
  const height = options.height || 5368;
  const pitch = options.pitch || 14.2857;
  const rotation = options.rotation ?? 0.0006;
  const rowStep = pitch * SQRT3_2;
  const ox = width / 2 + (options.offsetX ?? 3.3);
  const oy = height / 2 + (options.offsetY ?? -2.1);
  const layers = makeScene(width, height);
  const wb = { r: 1.4, gr: 1, gb: 1, b: 1.2 };
  const black = 64;
  const white = 1023;
  // GRBG mosaic, like the ILLUM.
  const cfa = [[1, 0], [2, 1]];
  const gainFor = [1 / wb.r, 1, 1 / wb.b];
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const radius = pitch * 0.5;

  const packed = new Uint8Array(Math.ceil((width * height * 10) / 8));
  const quad = new Uint16Array(4);
  let q = 0;
  let j = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // Nearest lens centre on the hex grid.
      const dx = x - ox;
      const dy = y - oy;
      const lx = cos * dx + sin * dy;
      const ly = -sin * dx + cos * dy;
      const r0 = Math.floor(ly / rowStep);
      let best = Infinity;
      let bu = 0;
      let bv = 0;
      for (let r = r0; r <= r0 + 1; r++) {
        const off = (r & 1) * pitch * 0.5;
        const c = Math.round((lx - off) / pitch);
        const u = lx - (c * pitch + off);
        const v = ly - r * rowStep;
        const d = u * u + v * v;
        if (d < best) {
          best = d;
          bu = u;
          bv = v;
        }
      }
      const rr = Math.sqrt(best) / radius;
      const vignette = rr >= 1 ? 0 : 1 - rr * rr * 0.6;
      // Lens centre in sensor coordinates is the point (x, y) minus (u, v).
      const lcx = x - (cos * bu - sin * bv);
      const lcy = y - (sin * bu + cos * bv);
      let rgb = null;
      for (let k = layers.length - 1; k >= 0; k--) {
        const L = layers[k];
        const sx = lcx + L.disparity * bu * pitch * 0.5;
        const sy = lcy + L.disparity * bv * pitch * 0.5;
        if (L.covers(sx, sy)) {
          rgb = L.color(sx, sy);
          break;
        }
      }
      const ch = cfa[y & 1][x & 1];
      const noise = (hash(x, y) - 0.5) * 0.01;
      const val = Math.max(0, Math.min(1, rgb[ch] * vignette * gainFor[ch] * 0.8 + noise));
      quad[q++] = Math.round(black + val * (white - black));
      if (q === 4) {
        packed[j] = quad[0] >> 2;
        packed[j + 1] = quad[1] >> 2;
        packed[j + 2] = quad[2] >> 2;
        packed[j + 3] = quad[3] >> 2;
        packed[j + 4] = (quad[0] & 3) | ((quad[1] & 3) << 2) | ((quad[2] & 3) << 4) | ((quad[3] & 3) << 6);
        j += 5;
        q = 0;
      }
    }
  }

  const pixelPitch = 1.4e-6;
  const metadata = {
    generator: 'lytro-illuminator synthetic sample',
    camera: { make: 'Lytro, Inc.', model: 'ILLUM', firmware: 'synthetic' },
    image: {
      width,
      height,
      orientation: 1,
      pixelPacking: { bitsPerPixel: 10, endianness: 'little' },
      pixelFormat: { black: { r: black, gr: black, gb: black, b: black }, white: { r: white, gr: white, gb: white, b: white }, rightShift: 0 },
      mosaic: { tile: 'r,gr:gb,b', upperLeftPixel: 'gr' },
      color: { whiteBalanceGain: wb },
      iso: 100,
    },
    devices: {
      clock: { zuluTime: new Date(0).toISOString() },
      sensor: { pixelPitch, pixelWidth: width, pixelHeight: height, bitsPerPixel: 10 },
      // Deliberately slightly off so calibration has something to do.
      mla: {
        tiling: 'hexUniformRowMajor',
        lensPitch: pitch * pixelPitch,
        rotation: 0,
        scaleFactor: { x: 1, y: 1 },
        sensorOffset: { x: 0, y: 0, z: 0.000037 },
      },
      lens: { fNumber: 2, focalLength: 0.03 },
      shutter: { frameExposureDuration: 1 / 125 },
    },
    algorithms: { awb: { computed: { gain: wb } } },
  };
  const privateMetadata = { camera: { serialNumber: 'SYNTHETIC' } };
  const metaBytes = encodeJson(metadata);
  const privBytes = encodeJson(privateMetadata);
  const toc = {
    schema: 'http://schema.lytro.com/lfp/picture/2.1.4/picture_schema.json',
    frames: [{
      frame: {
        metadataRef: await refFor(metaBytes),
        privateMetadataRef: await refFor(privBytes),
        imageRef: await refFor(packed),
      },
    }],
    views: [],
    thumbnails: [],
  };
  const { bytes } = await writeContainer([
    { type: 'LFC', data: metaBytes },
    { type: 'LFC', data: privBytes },
    { type: 'LFC', data: packed },
    { type: 'LFM', data: encodeJson(toc) },
  ]);
  return bytes;
}

// Ground truth for tests: the true grid and the per-layer disparities.
export const SYNTHETIC_LAYERS = { back: -0.45, middle: 0, front: 0.45 };
