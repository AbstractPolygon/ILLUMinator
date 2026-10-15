import test from 'node:test';
import assert from 'node:assert/strict';
import { scanTar, readTarEntry, makeTar } from '../app/js/core/tar.js';

const blobOf = (bytes) => ({ size: bytes.length, slice: (a, b) => ({ arrayBuffer: async () => bytes.slice(a, b).buffer }) });

test('a tar is read entry by entry without loading its data', async () => {
  const enc = new TextEncoder();
  const files = { 'B5100/cal_file_manifest.json': enc.encode('{"calibrationFiles":[]}'), 'B5100/MOD_0000.RAW': new Uint8Array(1300).fill(7), 'B5100/MOD_0000.TXT': enc.encode('{}') };
  const file = blobOf(makeTar(files));
  const entries = await scanTar(file);
  assert.deepEqual(entries.map((e) => e.name), Object.keys(files));
  assert.deepEqual(entries.map((e) => e.size), [23, 1300, 2]);
  assert.equal(new TextDecoder().decode(await readTarEntry(file, entries[0])), '{"calibrationFiles":[]}');
  assert.ok((await readTarEntry(file, entries[1])).every((b) => b === 7));
});
