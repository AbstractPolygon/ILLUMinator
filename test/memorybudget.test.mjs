import test from 'node:test';
import assert from 'node:assert/strict';
import { setMemoryLimits, memoryLimits, fitsMemory, memoryProblem, superResVram, exportRam, modelRam } from '../app/js/core/memorybudget.js';

const GB = 1024 ** 3;

test('without limits nothing is refused', () => {
  setMemoryLimits({});
  assert.equal(fitsMemory('ram', 1e15), true);
  assert.equal(fitsMemory('vram', 1e15), true);
});

test('a limit refuses what is larger and the message names it', () => {
  setMemoryLimits({ ramBytes: 4 * GB, vramBytes: 2 * GB });
  assert.deepEqual(memoryLimits(), { ram: 4 * GB, vram: 2 * GB });
  assert.equal(fitsMemory('vram', 1.5 * GB), true);
  assert.equal(fitsMemory('vram', 3 * GB), false);
  const m = memoryProblem('vram', superResVram(8088, 5616), 'A render', 'Lower the Scale.');
  assert.match(m, /video memory; the limit in Settings > Memory is 2\.0 GB\. Lower the Scale\.$/);
  setMemoryLimits({});
});

test('sizes grow with the picture', () => {
  assert.ok(superResVram(8000, 5000) > superResVram(2000, 1400));
  assert.ok(exportRam(2000, 1400, 4) > exportRam(2000, 1400, 1));
  assert.equal(modelRam(100, 100, 4), 100 * 100 * 16 * 12 + 100 * 100 * 6);
});
