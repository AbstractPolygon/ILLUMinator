import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { wakeStorage } = createRequire(import.meta.url)('../electron/lytro-scsi-win.cjs');

// A fake disk that is not ready until it has been sent START STOP UNIT.
function fakeApi() {
  const state = { started: false, cdbs: [] };
  return {
    state,
    open: (path) => (path === '\\\\.\\E:' ? {} : null),
    close() {},
    ioctl(_h, _code, buf) {
      const op = buf[0x24];
      state.cdbs.push(op);
      if (op === 0x12) buf.write('Lytro   ILLUM           ', 0x41 + 8, 'latin1');
      if (op === 0x00 && !state.started) buf[2] = 2;
      if (op === 0x1b) state.started = true;
      if (op === 0x03) { buf[0x41 + 2] = 2; buf[0x41 + 12] = 0x3a; }
      return 0;
    },
  };
}

test('an ILLUM drive that is not ready is told to start', () => {
  const api = fakeApi();
  const lines = [];
  assert.deepEqual(wakeStorage((l) => lines.push(l), api, 'DEF'), ['E']);
  assert.ok(api.state.cdbs.includes(0x1b));
  assert.match(lines.join('\n'), /sense key 2 asc 3a/);
  assert.match(lines.join('\n'), /now ready/);
});
