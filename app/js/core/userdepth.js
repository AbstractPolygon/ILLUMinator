// Lytro Desktop user depth maps.
//
// When a depth map is edited in Lytro Desktop, the picture's folder keeps it
// as stack.userdepthmap.png (gray, usually 16 bit, the size of Lytro's
// rendered picture) with stack.userdepthmap.txt giving the lambda range the
// grays span: {"LambdaMin":-35,"LambdaMax":28}. Black is LambdaMin, white
// LambdaMax.
//
// Lytro's picture covers the sensor almost exactly: measured against our
// views of four shots, it is the sensor scaled to the picture size, shrunk
// 0.5% down about its center and moved 1 pixel left and up (in a 2022 x
// 1404 picture).

import { sensorToOutput } from './render.js';
import { LAMBDA_TO_ALPHA } from './recipe.js';

const FIT = { kx: 1, ky: 0.995, dx: -1 / 2022, dy: -1 / 1404 };

// The lambda range from stack.userdepthmap.txt (null if unreadable).
export function parseDepthRange(text) {
  try {
    const j = JSON.parse(text);
    const min = Number(j.LambdaMin);
    const max = Number(j.LambdaMax);
    return Number.isFinite(min) && Number.isFinite(max) && max > min ? { min, max } : null;
  } catch {
    return null;
  }
}

async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Decodes a non-interlaced PNG to one channel (gray, or the first of RGB)
// scaled 0..1, keeping 16-bit precision. Returns null for anything else so
// the caller can fall back to the browser's own decoder.
export async function decodePngGray(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  if (b.length < 33 || sig.some((v, i) => b[i] !== v)) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let width = 0, height = 0, depth = 0, type = 0, interlace = 0;
  const idat = [];
  for (let p = 8; p + 8 <= b.length;) {
    const len = dv.getUint32(p);
    const name = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]);
    const data = b.subarray(p + 8, p + 8 + len);
    if (name === 'IHDR') {
      width = dv.getUint32(p + 8);
      height = dv.getUint32(p + 12);
      depth = b[p + 16];
      type = b[p + 17];
      interlace = b[p + 20];
    } else if (name === 'IDAT') idat.push(data);
    else if (name === 'IEND') break;
    p += 12 + len;
  }
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[type];
  if (!channels || interlace || (depth !== 8 && depth !== 16) || !width || !height) return null;
  const joined = new Uint8Array(idat.reduce((n, d) => n + d.length, 0));
  let o = 0;
  for (const d of idat) {
    joined.set(d, o);
    o += d.length;
  }
  const raw = await inflate(joined);
  const bpp = channels * (depth / 8);
  const stride = width * bpp;
  if (raw.length < height * (stride + 1)) return null;
  const out = new Float32Array(width * height);
  let prev = new Uint8Array(stride);
  let cur = new Uint8Array(stride);
  const scale = depth === 16 ? 1 / 65535 : 1 / 255;
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const up = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (f === 1) v += a;
      else if (f === 2) v += up;
      else if (f === 3) v += (a + up) >> 1;
      else if (f === 4) {
        const pa = Math.abs(up - c), pb = Math.abs(a - c), pc = Math.abs(a + up - 2 * c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? up : c;
      }
      cur[i] = v & 255;
    }
    for (let x = 0; x < width; x++) {
      const q = x * bpp;
      out[y * width + x] = (depth === 16 ? (cur[q] << 8) | cur[q + 1] : cur[q]) * scale;
    }
    [prev, cur] = [cur, prev];
  }
  return { width, height, data: out };
}

// The user depth map as focus depth (alpha) on the sampler's output grid.
// map: { width, height, data (0..1), min, max } in lambda.
export function userDepthAlpha(map, sampler, cam) {
  const { outW, outH } = sampler;
  const { width: W, height: H, data, min, max } = map;
  // Output position -> sensor position (sensorToOutput is affine).
  const [ax, ay] = sensorToOutput(sampler, 0, 0);
  const [bx, by] = sensorToOutput(sampler, 1, 0);
  const [cx, cy] = sensorToOutput(sampler, 0, 1);
  const det = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay);
  const alpha = new Float32Array(outW * outH);
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      const dx = x + 0.5 - ax;
      const dy = y + 0.5 - ay;
      const sx = (dx * (cy - ay) - dy * (cx - ax)) / det;
      const sy = ((bx - ax) * dy - (by - ay) * dx) / det;
      const X = Math.min(W - 1, Math.max(0, ((sx / cam.width - 0.5) * FIT.kx + 0.5 + FIT.dx) * W));
      const Y = Math.min(H - 1, Math.max(0, ((sy / cam.height - 0.5) * FIT.ky + 0.5 + FIT.dy) * H));
      const x0 = Math.min(W - 2, Math.floor(X));
      const y0 = Math.min(H - 2, Math.floor(Y));
      const fx = X - x0;
      const fy = Y - y0;
      const q = y0 * W + x0;
      const g = (data[q] * (1 - fx) + data[q + 1] * fx) * (1 - fy) + (data[q + W] * (1 - fx) + data[q + W + 1] * fx) * fy;
      alpha[y * outW + x] = (min + g * (max - min)) * LAMBDA_TO_ALPHA;
    }
  }
  return alpha;
}
