import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { makeSyntheticLfr } from '../app/js/core/synthetic.js';
import { readThumbnail } from '../app/js/core/lfp.js';

const require = createRequire(import.meta.url);
const camera = require('../electron/camera.cjs');

// A fake camera drive: <root>/DCIM/100PHOTO/IMG_0001.LFR ...
async function fakeDrive() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lytro-drive-'));
  const dir = path.join(root, 'DCIM', '100PHOTO');
  fs.mkdirSync(dir, { recursive: true });
  const bytes = await makeSyntheticLfr({ width: 400, height: 300 });
  fs.writeFileSync(path.join(dir, 'IMG_0001.LFR'), bytes);
  fs.writeFileSync(path.join(dir, 'IMG_0002.LFR'), bytes);
  fs.writeFileSync(path.join(dir, 'IMG_0002.JPG'), 'not a light field');
  fs.mkdirSync(path.join(root, 'DCIM', '101PHOTO'));
  fs.writeFileSync(path.join(root, 'DCIM', '101PHOTO', 'IMG_0001.LFR'), bytes);
  return { root, size: bytes.length };
}

test('finds light field photos on a camera drive', async () => {
  const { root, size } = await fakeDrive();
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'lytro-empty-'));
  const cams = await camera.listCameras({ roots: [empty, root], adb: false });
  assert.equal(cams.length, 1);
  assert.equal(cams[0].kind, 'drive');
  assert.deepEqual(cams[0].files.map((f) => `${f.folder}/${f.name}`), ['100PHOTO/IMG_0001.LFR', '100PHOTO/IMG_0002.LFR', '101PHOTO/IMG_0001.LFR']);
  assert.equal(cams[0].files[0].size, size);
});

test('imports with progress, keeps folder names apart and skips existing copies', async () => {
  const { root, size } = await fakeDrive();
  const [cam] = await camera.listCameras({ roots: [root], adb: false });
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'lytro-import-'));
  const progress = [];
  const out = await camera.importFiles(cam, cam.files.map((f) => f.id), dest, (p) => progress.push(p));
  assert.deepEqual(out.map((p) => path.basename(p)).sort(), ['100PHOTO_IMG_0001.LFR', '100PHOTO_IMG_0002.LFR', '101PHOTO_IMG_0001.LFR']);
  for (const p of out) assert.equal(fs.statSync(p).size, size);
  assert.equal(progress.at(-1).bytes, size * 3);
  assert.equal(fs.readdirSync(dest).some((n) => n.endsWith('.part')), false);
  // A second import finds the copies and does not copy again.
  const before = fs.statSync(out[0]).mtimeMs;
  await camera.importFiles(cam, [cam.files[0].id], dest);
  assert.equal(fs.statSync(out[0]).mtimeMs, before);
});

test('reads parts of a file without loading it whole', async () => {
  const { root } = await fakeDrive();
  const file = path.join(root, 'DCIM', '100PHOTO', 'IMG_0001.LFR');
  const reader = await camera.fileReader(file);
  const head = await reader.read(0, 4);
  await reader.close();
  assert.deepEqual([...head], [0x89, 0x4c, 0x46, 0x50]);
  // Synthetic files have no thumbnail; reading one must not fail.
  const r2 = await camera.fileReader(file);
  assert.equal(await readThumbnail(r2), null);
  await r2.close();
});

test('parses adb ls -l listings', () => {
  const text = [
    'drwxrwx--- root     sdcard_r          2015-05-17 13:31 100PHOTO',
    '-rw-rw---- root     sdcard_r 55561840 2015-05-17 13:31 IMG_0813.LFR',
    '-rw-rw---- root     sdcard_r   102400 2015-05-17 13:31 IMG_0813.JPG',
  ].join('\n');
  const entries = camera.parseLsLong(text);
  assert.deepEqual(entries.map((e) => [e.name, e.dir]), [['100PHOTO', true], ['IMG_0813.LFR', false], ['IMG_0813.JPG', false]]);
  assert.equal(entries[1].size, 55561840);
});
