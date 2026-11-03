// A 16 bit per channel RGB PNG, written here because the browser's own encoder only makes 8 bit pictures.
// rgb: Uint16Array (width * height * 3, the first row the top). Returns the file as a Uint8Array.
// Marked sRGB (the picture is already in sRGB). Each row is stored with the Sub filter, which shrinks smooth pictures a little.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

async function deflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function encodePng16(rgb, width, height) {
  if (rgb.length !== width * height * 3) throw new Error('encodePng16: the picture does not match its size');
  const stride = width * 6;
  const raw = new Uint8Array(height * (stride + 1));
  const line = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    // big endian samples
    for (let i = 0, o = y * width * 3; i < width * 3; i++, o++) {
      line[2 * i] = rgb[o] >> 8;
      line[2 * i + 1] = rgb[o] & 255;
    }
    const at = y * (stride + 1);
    raw[at] = 1; // Sub: each byte less the one a pixel (6 bytes) before it
    for (let i = 0; i < stride; i++) raw[at + 1 + i] = (line[i] - (i >= 6 ? line[i - 6] : 0)) & 255;
  }
  const header = new Uint8Array(13);
  const hv = new DataView(header.buffer);
  hv.setUint32(0, width);
  hv.setUint32(4, height);
  header[8] = 16; // bit depth
  header[9] = 2; // truecolor
  const parts = [
    Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10),
    chunk('IHDR', header),
    chunk('sRGB', Uint8Array.of(0)),
    chunk('IDAT', await deflate(raw)),
    chunk('IEND', new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
