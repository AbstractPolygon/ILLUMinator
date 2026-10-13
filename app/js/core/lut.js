// 3D color lookup tables (.cube, as made by DaVinci Resolve, Premiere and
// most LUT packs). A LUT maps display (sRGB) colors to new ones and is the
// last step of the look; gpu/renderer.js mirrors sampleLut.
//
// lut: { title, size, min: [r, g, b], max: [r, g, b], data } where data
// holds size^3 RGB triples, red changing fastest, then green, then blue.

export const MAX_LUT_SIZE = 65;

export function parseCube(text) {
  let title = '';
  let size = 0;
  let min = [0, 0, 0];
  let max = [1, 1, 1];
  const values = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const [key, ...rest] = line.split(/\s+/);
    if (key === 'TITLE') title = line.slice(5).trim().replace(/^"|"$/g, '');
    else if (key === 'LUT_3D_SIZE') size = parseInt(rest[0], 10);
    else if (key === 'LUT_1D_SIZE') throw new Error('Only 3D LUTs are supported (this is a 1D LUT).');
    else if (key === 'DOMAIN_MIN') min = rest.slice(0, 3).map(Number);
    else if (key === 'DOMAIN_MAX') max = rest.slice(0, 3).map(Number);
    else if (/^[-+.\d]/.test(key)) {
      const row = [key, ...rest].slice(0, 3).map(Number);
      if (row.length === 3 && row.every(Number.isFinite)) values.push(...row);
    }
  }
  if (!(size >= 2 && size <= MAX_LUT_SIZE)) throw new Error(`Not a 3D LUT this app can use (size ${size || 'missing'}; 2 to ${MAX_LUT_SIZE} supported).`);
  if (values.length !== size ** 3 * 3) throw new Error(`The LUT should have ${size ** 3} entries but has ${values.length / 3}.`);
  if (![...min, ...max].every(Number.isFinite) || max.some((v, i) => !(v > min[i]))) throw new Error('The LUT has an invalid domain.');
  return { title, size, min, max, data: Float32Array.from(values) };
}

// The LUT's color for (r, g, b), trilinear between the nearest entries.
// `out` (length 3) receives it.
export function sampleLut(lut, r, g, b, out) {
  const { size, data, min, max } = lut;
  const n = size - 1;
  const at = (v, c) => {
    const t = Math.min(1, Math.max(0, (v - min[c]) / (max[c] - min[c]))) * n;
    const i = Math.min(n - 1, Math.floor(t));
    return [i, t - i];
  };
  const [ri, rf] = at(r, 0);
  const [gi, gf] = at(g, 1);
  const [bi, bf] = at(b, 2);
  for (let c = 0; c < 3; c++) {
    const v = (x, y, z) => data[3 * (x + size * (y + size * z)) + c];
    const c00 = v(ri, gi, bi) * (1 - rf) + v(ri + 1, gi, bi) * rf;
    const c10 = v(ri, gi + 1, bi) * (1 - rf) + v(ri + 1, gi + 1, bi) * rf;
    const c01 = v(ri, gi, bi + 1) * (1 - rf) + v(ri + 1, gi, bi + 1) * rf;
    const c11 = v(ri, gi + 1, bi + 1) * (1 - rf) + v(ri + 1, gi + 1, bi + 1) * rf;
    out[c] = (c00 * (1 - gf) + c10 * gf) * (1 - bf) + (c01 * (1 - gf) + c11 * gf) * bf;
  }
  return out;
}

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(text) {
  const s = atob(text);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes;
}

// For the edits file: the entries as 16-bit steps between their lowest and
// highest value, in base64 (about a quarter of the .cube's size).
export function encodeLut(lut, name = '') {
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of lut.data) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (!(hi > lo)) hi = lo + 1;
  const q = new Uint16Array(lut.data.length);
  for (let i = 0; i < q.length; i++) q[i] = Math.round(((lut.data[i] - lo) / (hi - lo)) * 65535);
  return { name: name || lut.title || 'LUT', size: lut.size, min: lut.min, max: lut.max, lo, hi, data: toBase64(new Uint8Array(q.buffer)) };
}

export function decodeLut(saved) {
  if (!saved || !(saved.size >= 2) || typeof saved.data !== 'string') return null;
  const bytes = fromBase64(saved.data);
  const q = new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 1);
  if (q.length !== saved.size ** 3 * 3) return null;
  const data = new Float32Array(q.length);
  for (let i = 0; i < q.length; i++) data[i] = saved.lo + (q[i] / 65535) * (saved.hi - saved.lo);
  return { title: saved.name, size: saved.size, min: saved.min || [0, 0, 0], max: saved.max || [1, 1, 1], data };
}
