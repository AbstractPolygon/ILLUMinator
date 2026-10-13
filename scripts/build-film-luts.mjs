// Packs the G'MIC Film LUTs Collection (https://github.com/YahiaAngelo/Film-Luts,
// MIT License) into app/luts: film-luts.json (names, categories, sizes) and
// film-luts.bin (every LUT's entries as 16-bit steps of 0..1, in order).
//
//   git clone --depth 1 https://github.com/YahiaAngelo/Film-Luts.git
//   node scripts/build-film-luts.mjs path/to/Film-Luts
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseCube } from '../app/js/core/lut.js';

const src = process.argv[2];
if (!src) throw new Error('Usage: node scripts/build-film-luts.mjs path/to/Film-Luts');
const out = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'app', 'luts');

const CATEGORIES = {
  'Negative Color': 'Color negative',
  'Negative New': 'Color negative (new)',
  'Negative Old': 'Color negative (vintage)',
  Colorslide: 'Color slide',
  Bw: 'Black and white',
  Print: 'Print film',
  'Instant Consumer': 'Instant (consumer)',
  'Instant Pro': 'Instant (pro)',
  Fujixtransiii: 'Fujifilm X-Trans III',
};

const { filmLUTs } = JSON.parse(await fs.readFile(path.join(src, 'film_luts.json'), 'utf8'));
const entries = [];
const chunks = [];
let offset = 0;
for (const item of filmLUTs) {
  const lut = parseCube(await fs.readFile(path.join(src, item.lut_file), 'utf8'));
  const q = new Uint16Array(lut.data.length);
  for (let i = 0; i < q.length; i++) q[i] = Math.round(Math.min(1, Math.max(0, lut.data[i])) * 65535);
  chunks.push(Buffer.from(q.buffer));
  entries.push({ name: item.name, category: CATEGORIES[item.category] || item.category, size: lut.size, offset });
  offset += q.byteLength;
}
const order = Object.values(CATEGORIES);
entries.sort((a, b) => order.indexOf(a.category) - order.indexOf(b.category) || a.name.localeCompare(b.name, 'en', { numeric: true }));
await fs.mkdir(out, { recursive: true });
await fs.writeFile(path.join(out, 'film-luts.bin'), Buffer.concat(chunks));
await fs.writeFile(path.join(out, 'film-luts.json'), `${JSON.stringify({
  source: 'G’MIC Film LUTs Collection, https://github.com/YahiaAngelo/Film-Luts (MIT License, see LICENSE-film-luts.txt)',
  categories: order,
  luts: entries,
}, null, 1)}\n`);
await fs.copyFile(path.join(src, 'LICENSE'), path.join(out, 'LICENSE-film-luts.txt'));
console.log(`${entries.length} LUTs, ${(offset / 1e6).toFixed(1)} MB`);
