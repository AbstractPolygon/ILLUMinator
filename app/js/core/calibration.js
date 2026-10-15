// Camera calibration data (an ILLUM "caldata" backup). Each camera has its
// own: a list of defective pixels, white images, the microlens grid at every
// zoom and focus setting, and more. Pieces are read here one at a time.

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
