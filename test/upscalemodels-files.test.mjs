import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { MODEL_DATA, MODEL_SOURCE } from '../app/js/core/upscalemodels-data.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'models', 'manifest.json'), 'utf8'));

test('the app knows the models the manifest lists', () => {
  assert.deepEqual(MODEL_DATA, manifest.models);
  assert.deepEqual(MODEL_SOURCE, manifest.source);
  assert.equal(manifest.source.license, 'BSD-3-Clause');
  assert.match(manifest.source.revision, /^[0-9a-f]{40}$/);
});

test('the copies in models/ are the files the manifest names', () => {
  for (const m of manifest.models) {
    const file = path.join(root, 'models', m.file);
    const bytes = fs.readFileSync(file);
    assert.equal(bytes.length, m.size, `${m.file} size`);
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), m.sha256, `${m.file} SHA-256`);
    assert.ok(fs.readFileSync(path.join(root, 'models', 'README.md'), 'utf8').includes(m.sha256), `${m.file} hash in the README`);
  }
  assert.ok(fs.existsSync(path.join(root, 'models', 'LICENSE-Real-ESRGAN.txt')));
});
