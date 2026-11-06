// docs/debug-flags.md lists every debug switch and test hook the code reads; this fails when a switch is added or removed without regenerating it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('docs/debug-flags.md is up to date (node scripts/debug-flags.mjs)', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const r = spawnSync(process.execPath, ['scripts/debug-flags.mjs', '--check'], { cwd: root, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});
