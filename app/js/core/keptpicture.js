// A full sensor picture before its color pass, kept next to the photo (desktop app) so the color settings can be changed on a photo opened again without combining the
// sensor's rays again (worker.js stillKey / core/precolorkey.js). Stored as half floats: a quarter of the size of RGBA floats, and the rounding (about 1 part in 2000)
// is far below what 8 bits show.
//
// File: 'ILKP', version (u8), width (u32), height (u32), the 16 hex digits of the key's hash (16 bytes of text), 3 bytes of padding, then width * height * 3 half floats (RGB).

import { hashKey } from './still-cache.js';

const MAGIC = [0x49, 0x4c, 0x4b, 0x50];
const FORMAT = 1;
const HEADER = 32; // 4 + 1 + 4 + 4 + 16 = 29, padded so the half floats start on an even byte

// A 32 bit hash of bytes (two FNV-1a runs with different seeds, over 32 bit words), as 16 hex digits. For the contents of a depth map and the like.
export function hashBytes(view) {
  let u8 = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  // (the words are read from an aligned copy, so the same bytes give the same hash wherever they sit)
  if (u8.byteOffset & 3) u8 = u8.slice();
  let a = 0x811c9dc5;
  let b = 0x9747b28c;
  const words = u8.byteLength >> 2;
  const w = new Uint32Array(u8.buffer, u8.byteOffset, words);
  for (let i = 0; i < words; i++) {
    a = Math.imul(a ^ w[i], 0x01000193) >>> 0;
    b = Math.imul(b ^ w[i], 0x85ebca6b) >>> 0;
    b ^= b >>> 13;
  }
  for (let i = words * 4; i < u8.byteLength; i++) {
    a = Math.imul(a ^ u8[i], 0x01000193) >>> 0;
    b = Math.imul(b ^ u8[i], 0x85ebca6b) >>> 0;
    b ^= b >>> 13;
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

// What a value holds, as text for a key: numbers, strings, nested values, and the contents (not the identity) of typed arrays, so two runs that made the same depth map agree.
// Objects are walked a few levels down; a function or anything else odd counts as nothing.
export function fingerprint(value, depth = 0) {
  if (value === null || value === undefined) return 'n';
  const t = typeof value;
  if (t === 'number') return Number.isFinite(value) ? String(value) : 'x';
  if (t === 'string') return JSON.stringify(value);
  if (t === 'boolean') return value ? 't' : 'f';
  if (t !== 'object' || depth > 4) return '_';
  if (ArrayBuffer.isView(value)) return `${value.constructor.name}:${value.length}:${hashBytes(value)}`;
  if (value instanceof ArrayBuffer) return `AB:${value.byteLength}:${hashBytes(new Uint8Array(value))}`;
  if (value instanceof Map) return `{${[...value].map(([k, v]) => `${fingerprint(k, depth + 1)}=${fingerprint(v, depth + 1)}`).join(',')}}`;
  if (Array.isArray(value)) return `[${value.map((v) => fingerprint(v, depth + 1)).join(',')}]`;
  return `{${Object.keys(value).sort().map((k) => `${k}:${fingerprint(value[k], depth + 1)}`).join(',')}}`;
}

// Float32 to half float bits (round to nearest even; too large goes to infinity, tiny to zero or a subnormal).
const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
export function toHalfBits(x) {
  f32[0] = x;
  const bits = u32[0];
  const sign = (bits >>> 16) & 0x8000;
  const exp = (bits >>> 23) & 0xff;
  let mant = bits & 0x7fffff;
  if (exp === 0xff) return sign | 0x7c00 | (mant ? 0x200 : 0);
  let e = exp - 127 + 15;
  if (e >= 0x1f) return sign | 0x7c00;
  if (e <= 0) {
    if (e < -10) return sign;
    mant |= 0x800000;
    const shift = 14 - e;
    let half = mant >> shift;
    const rem = mant & ((1 << shift) - 1);
    const mid = 1 << (shift - 1);
    if (rem > mid || (rem === mid && (half & 1))) half++;
    return sign | half;
  }
  let half = (e << 10) | (mant >> 13);
  const rem = mant & 0x1fff;
  if (rem > 0x1000 || (rem === 0x1000 && (half & 1))) half++;
  return sign | half;
}
export function fromHalfBits(h) {
  const sign = (h & 0x8000) << 16;
  const exp = (h >> 10) & 0x1f;
  const mant = h & 0x3ff;
  if (exp === 0) {
    if (!mant) {
      u32[0] = sign;
    } else {
      // a subnormal half: mant * 2^-24
      f32[0] = mant * 2 ** -24;
      u32[0] = (u32[0] & 0x7fffffff) | sign;
    }
  } else if (exp === 0x1f) {
    u32[0] = sign | 0x7f800000 | (mant << 13);
  } else {
    u32[0] = sign | ((exp - 15 + 127) << 23) | (mant << 13);
  }
  return f32[0];
}

// The file's bytes for an RGB picture (Float32Array of w * h * 3) kept under `key` (a hash of what decides the picture).
export function encodeKept({ key, w, h, rgb }) {
  const out = new ArrayBuffer(HEADER + rgb.length * 2);
  const bytes = new Uint8Array(out);
  const dv = new DataView(out);
  bytes.set(MAGIC, 0);
  dv.setUint8(4, FORMAT);
  dv.setUint32(5, w, true);
  dv.setUint32(9, h, true);
  for (let i = 0; i < 16; i++) bytes[13 + i] = key.charCodeAt(i) || 0;
  const half = new Uint16Array(out, HEADER, rgb.length);
  for (let i = 0; i < rgb.length; i++) half[i] = toHalfBits(rgb[i]);
  return out;
}

// { key, w, h, rgb } from a kept picture's bytes, or null where they are not one (or are cut short).
export function decodeKept(buffer) {
  if (!buffer || buffer.byteLength < HEADER) return null;
  const bytes = new Uint8Array(buffer);
  if (MAGIC.some((m, i) => bytes[i] !== m)) return null;
  const dv = new DataView(buffer);
  if (dv.getUint8(4) !== FORMAT) return null;
  const w = dv.getUint32(5, true);
  const h = dv.getUint32(9, true);
  if (!w || !h || buffer.byteLength !== HEADER + w * h * 6) return null;
  const key = String.fromCharCode(...bytes.subarray(13, 29)).replace(/\0+$/, '');
  const half = new Uint16Array(buffer.slice(HEADER));
  const rgb = new Float32Array(half.length);
  for (let i = 0; i < half.length; i++) rgb[i] = fromHalfBits(half[i]);
  return { key, w, h, rgb };
}

// The 16 characters naming a picture, from the text of its key. (hashKey can give 17, with a minus sign, when its second hash goes negative: the header holds 16, so the sign becomes an 'n'.)
export const keptHash = (keyText) => hashKey(keyText).replace('-', 'n').padEnd(16, '0').slice(0, 16);
