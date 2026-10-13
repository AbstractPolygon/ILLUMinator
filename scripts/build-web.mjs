#!/usr/bin/env node
// Builds the browser version: copies the app into dist/web, ready to upload
// to any static host (GitHub Pages, Netlify, a plain web server).
// npm run build:web [-- --out <dir>]
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const outArg = process.argv.indexOf('--out');
const out = path.resolve(outArg > 0 ? process.argv[outArg + 1] : path.join(root, 'dist', 'web'));

await fs.rm(out, { recursive: true, force: true });
await fs.cp(path.join(root, 'app'), out, { recursive: true });
// Stops GitHub Pages from running the files through Jekyll.
await fs.writeFile(path.join(out, '.nojekyll'), '');

let count = 0;
let bytes = 0;
for (const entry of await fs.readdir(out, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile()) continue;
  count++;
  bytes += (await fs.stat(path.join(entry.parentPath ?? entry.path, entry.name))).size;
}
console.log(`Web build: ${count} files, ${(bytes / 1024).toFixed(0)} KB in ${path.relative(process.cwd(), out) || out}`);
