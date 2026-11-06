// Lists the periodic peaks (frequency in cycles per pixel : prominence) the notch filter finds in a linear RGB float32 render.
//
//   node find-peaks.mjs render.bin WIDTH HEIGHT
//
// The lens lattice's peaks sit at about 0.25-0.29 (3x) and 0.19-0.24 (4x) with prominence above 8; peaks below 0.15 are picture detail, which is why the filter is not run at 2x.
import fs from 'node:fs';
import { findPeriodicPeaks } from '../../app/js/core/notch.js';

const [file, W, H] = [process.argv[2], +process.argv[3], +process.argv[4]];
const bytes = fs.readFileSync(file);
const a = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4);
const Y = new Float32Array(W * H);
for (let i = 0; i < W * H; i++) Y[i] = Math.sqrt(Math.max(0, 0.2126 * a[3 * i] + 0.7152 * a[3 * i + 1] + 0.0722 * a[3 * i + 2]));
const peaks = findPeriodicPeaks(Y, W, H, { prominence: 2, maxPeaks: 200, tiles: 80 });
console.log(peaks.map((p) => `${Math.hypot(p.fx, p.fy).toFixed(3)}:${p.prominence.toFixed(1)}`).join(' '));
