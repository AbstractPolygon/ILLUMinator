// The settings object the page sends the engine is built from the controls by app/js/settingsmap.js. test/fixtures/settings-golden.json holds four states of the page's controls
// and the settings the page's code sent for each (recorded with scripts/capture-settings.mjs from the version before the table existed): they must still come out the same.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { colorSettings, renderSettings, readTable, COLOR_SETTINGS, RENDER_SETTINGS } from '../app/js/settingsmap.js';
import { EDIT_GROUPS } from '../app/js/edits.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const golden = JSON.parse(fs.readFileSync(path.join(root, 'test/fixtures/settings-golden.json'), 'utf8'));
const html = fs.readFileSync(path.join(root, 'app/index.html'), 'utf8');

// Controls as plain objects: a checkbox holds true or false, anything else a string.
function reader(state) {
  const el = (id) => {
    if (!(id in state)) throw new Error(`the recorded state has no control "${id}"`);
    const v = state[id];
    return typeof v === 'boolean' ? { checked: v, value: String(v) } : { value: v, checked: false };
  };
  return { el, num: (id) => +el(id).value };
}

for (const g of golden) {
  test(`settings from the controls are what the page sent (${typeof g.mode === 'number' ? `random state ${g.mode}` : g.mode})`, () => {
    const { local, ...expected } = g.settings;
    const { local: ignored, ...actual } = renderSettings(reader(g.state), null);
    assert.deepEqual(actual, expected);
    assert.ok(local && ignored === null);
  });
}

test('an animation frame can override a slider: the color settings read sliders through num', () => {
  const g = golden[0];
  const c = reader(g.state);
  const settings = colorSettings({ el: c.el, num: (id) => (id === 'ev' ? 1.5 : c.num(id)) });
  assert.equal(settings.ev, 1.5);
  assert.equal(settings.lutAmount, g.settings.lutAmount);
});

test('every control in the tables exists in the page and is saved with the photo', () => {
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  const saved = new Set(Object.values(EDIT_GROUPS).flat());
  const rows = [...COLOR_SETTINGS, ...RENDER_SETTINGS];
  assert.ok(rows.length > 50);
  const missing = rows.filter(([, id]) => !ids.has(id)).map(([path, id]) => `${path} (${id})`);
  assert.deepEqual(missing, [], `table rows whose control is not in index.html: ${missing.join(', ')}`);
  const unsaved = rows.filter(([, id]) => !saved.has(id)).map(([path, id]) => `${path} (${id})`);
  assert.deepEqual(unsaved, [], `table rows whose control is not in EDIT_GROUPS (edits.js), so it would reset when the photo is opened again: ${unsaved.join(', ')}`);
});

test('a row with an unknown way of reading fails loudly, and no setting is set twice', () => {
  assert.throws(() => readTable([['x', 'a', 'bogus']], { el: () => ({}), num: () => 0 }), /no way to read/);
  const paths = [...COLOR_SETTINGS, ...RENDER_SETTINGS].map(([p]) => p);
  assert.deepEqual(paths.filter((p, i) => paths.indexOf(p) !== i), []);
});
