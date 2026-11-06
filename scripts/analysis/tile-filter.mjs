// Runs the lattice filter (core/notch.js) the way the renderer does, on a linear RGB float32 file, so its settings can be tried without a render.
//
//   node tile-filter.mjs input.bin WIDTH HEIGHT RATIO PROMINENCE output.bin
//
// RATIO is what Lattice strength maps to (1.1 - strength; 0.35 at the default 75), PROMINENCE what Lattice detection maps to (12 - 12 * detection; 6 at the default 50).
// Then measure with lattice-band.py.
import fs from 'node:fs';
import { removeLatticeByTiles, removePeriodicPatternRepeatedly } from '../../app/js/core/notch.js';

const [file, W, H, ratio, prominence, out] = [process.argv[2], +process.argv[3], +process.argv[4], +process.argv[5], +process.argv[6], process.argv[7]];
const bytes = fs.readFileSync(file);
const rgb = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4).slice();
const seeds = removeLatticeByTiles(rgb, W, H, { ratio, prominence });
removePeriodicPatternRepeatedly(rgb, W, H, { prominence });
console.log(`${out}: ${seeds} seeds`);
fs.writeFileSync(out, Buffer.from(rgb.buffer));
