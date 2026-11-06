// A control that changes the picture must be saved with the photo (EDIT_GROUPS in edits.js), or it resets every time the photo is opened again.
// This keeps the controls in app/index.html and the saved list in step: a new slider with a default that is not listed fails here.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EDIT_GROUPS } from '../app/js/edits.js';

const html = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../app/index.html'), 'utf8');
const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
const saved = new Set(Object.values(EDIT_GROUPS).flat());

// Controls with a default that are deliberately not in EDIT_GROUPS: the local adjustment sliders edit the selected mask, and the masks are saved whole as `local-masks`.
const SAVED_ELSEWHERE = /^(mx|mr|ml|md)-/;

test('every saved control exists in the page', () => {
  const missing = [...saved].filter((id) => !ids.has(id));
  assert.deepEqual(missing, [], `saved but not in index.html: ${missing.join(', ')}`);
});

test('every slider or setting with a default is saved with the photo', () => {
  const controls = [...html.matchAll(/<(?:input|select)\b[^>]*\bid="([^"]+)"[^>]*\bdata-default="[^"]*"[^>]*>/g)].map((m) => m[1]);
  assert.ok(controls.length > 80, 'the scan finds the sliders');
  const unsaved = controls.filter((id) => !saved.has(id) && !SAVED_ELSEWHERE.test(id));
  assert.deepEqual(unsaved, [], `controls with a default that are not saved with the photo (add them to EDIT_GROUPS in edits.js): ${unsaved.join(', ')}`);
});

test('no control is saved twice', () => {
  const all = Object.values(EDIT_GROUPS).flat();
  const dup = all.filter((id, i) => all.indexOf(id) !== i);
  assert.deepEqual(dup, []);
});

test('every control the page code looks up by name exists in the page', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const dir = path.join(root, 'app/js/ui');
  const files = [path.join(root, 'app/js/main.js'), ...fs.readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => path.join(dir, f))];
  const used = new Set();
  for (const f of files) for (const m of fs.readFileSync(f, 'utf8').matchAll(/\$\('([A-Za-z0-9_-]+)'\)/g)) used.add(m[1]);
  assert.ok(used.size > 200);
  const missing = [...used].filter((id) => !ids.has(id));
  assert.deepEqual(missing, [], `main.js or app/js/ui uses ids that index.html does not have (a typo, or a control that was removed): ${missing.join(', ')}`);
});
