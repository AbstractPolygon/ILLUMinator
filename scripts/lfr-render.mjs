#!/usr/bin/env node
// Command line decoder: renders the centre view (and optionally a refocus
// sweep) of an LFR/LFP file to PNG. Useful for checking the decoder without
// the GUI.  Usage: node scripts/lfr-render.mjs <file> [outdir]
import fs from 'node:fs';
import path from 'node:path';
import { decodeLightField } from '../app/js/core/decode.js';
import { buildSampler, renderView, toneMap, colorMatrix, autoExposure, makeDevelopParams } from '../app/js/core/render.js';
import { encodePng } from './png.mjs';

const [file, outDir = '.'] = process.argv.slice(2);
if (!file) {
  console.error('usage: lfr-render <file.lfr> [outdir]');
  process.exit(1);
}
const t0 = Date.now();
const lf = await decodeLightField(new Uint8Array(fs.readFileSync(file)), {
  onProgress: (stage, p) => process.stderr.write(`\r${stage} ${Math.round(p * 100)}%   `),
});
process.stderr.write('\n');
if (!lf.raw) {
  console.log('No raw light field in file; stacks:', lf.stacks.map((s) => `${s.kind}(${s.images.length})`).join(', '));
  process.exit(0);
}
const { cam, grid } = lf;
console.log(`${cam.model} ${cam.width}x${cam.height} ${cam.bits}bit mosaic=${cam.upperLeft}`);
console.log('grid', grid, 'quality', lf.gridQuality.toFixed(4), 'metadata quality', lf.metadataGridQuality.toFixed(4));
const sampler = buildSampler(grid, cam, 1);
const dev = makeDevelopParams(cam);
const matrix = colorMatrix(cam, { useCcm: true, saturation: 1 });
const base = path.join(outDir, path.basename(file).replace(/\.[^.]+$/, ''));
let exposure;
for (const [name, u, v] of [['center', 0, 0], ['left', -4, 0], ['right', 4, 0]]) {
  const rgb = renderView(lf.raw, cam, dev, sampler, u, v);
  exposure ??= autoExposure(rgb, matrix);
  fs.writeFileSync(`${base}-${name}.png`, encodePng(sampler.outW, sampler.outH, toneMap(rgb, matrix, exposure)));
}
console.log(`wrote ${sampler.outW}x${sampler.outH} views in ${Date.now() - t0} ms`);
