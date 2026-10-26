// patchraw.mjs IN.lfp OUT.lfp kind  : replace the raw section with a synthetic pattern (in place, same size)
import fs from 'node:fs';
import { bufferReader, indexSections, readLightFieldPicture } from '/home/user/lytro-illuminator/app/js/core/lfp.js';
const [inp, outp, kind, p1] = process.argv.slice(2);
const bytes = new Uint8Array(fs.readFileSync(inp));
const picture = await readLightFieldPicture(bufferReader(bytes));
const secs = await indexSections(bufferReader(bytes));
const ref = picture.rawRef;
const sec = secs.find((s) => s.sha1 === ref || ('sha1-' + s.sha1) === ref || s.sha1 === String(ref).replace(/^sha1-/, ''));
if (!sec) { console.error('raw section not found', ref, secs.map((s) => s.sha1).slice(0, 5)); process.exit(1); }
const W = 7728, H = 5368;
const px = new Uint16Array(W * H);
const f = {
  const: (x, y) => 500,
  stripes: (x, y) => [64, 100, 150, 200, 250, 300, 350, 400, 500, 600, 700, 800, 900, 950, 1000, 1023][Math.min(15, Math.floor(x / 483))],
  const300: (x, y) => 300,
  const800: (x, y) => 800,
  xramp: (x, y) => 100 + 0.4 * (x % 1000),
  yramp: (x, y) => 100 + 0.4 * (y % 1000),
  xramp2: (x, y) => 100 + 0.8 * (x % 500),
  yramp2: (x, y) => 100 + 0.8 * (y % 500),
  xstep: (x, y) => ((Math.floor(x / 64) & 1) ? 700 : 200),
  ystep: (x, y) => ((Math.floor(y / 64) & 1) ? 700 : 200),
}[kind];
if (!f) { console.error('kind?'); process.exit(1); }
for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) px[y * W + x] = Math.max(0, Math.min(1023, Math.round(f(x, y))));
const packed = bytes.subarray(sec.offset, sec.offset + sec.length);
if (packed.length !== Math.ceil(W * H * 10 / 8)) { console.error('size', packed.length); process.exit(1); }
const out = new Uint8Array(bytes);
for (let i = 0, j = sec.offset; i < W * H; i += 4, j += 5) {
  const a = px[i], b = px[i + 1], c = px[i + 2], d = px[i + 3];
  out[j] = a >> 2; out[j + 1] = b >> 2; out[j + 2] = c >> 2; out[j + 3] = d >> 2;
  out[j + 4] = (a & 3) | ((b & 3) << 2) | ((c & 3) << 4) | ((d & 3) << 6);
}
fs.writeFileSync(outp, out);
console.log('patched', sec.offset, sec.length, kind);
