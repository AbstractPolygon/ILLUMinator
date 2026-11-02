import test from 'node:test';
import assert from 'node:assert/strict';
import { EDIT_GROUPS, readEdits, writeEdits } from '../app/js/edits.js';

// A minimal document: just the controls, by id.
function fakeDoc(values) {
  const els = {};
  for (const [id, v] of Object.entries(values)) els[id] = typeof v === 'boolean' ? { type: 'checkbox', checked: v, dataset: {} } : { type: 'select', tagName: 'SELECT', value: String(v), dataset: {} };
  return { getElementById: (id) => els[id] || null, els };
}

test('every Render Settings control is saved with the photo', () => {
  for (const id of ['detail', 'still-passes', 'fullres-on', 'still-scale', 'auto-render', 'stereo-on', 'stereo-mode', 'photo-size', 'photo-format', 'video-size', 'upscale-method']) {
    assert.ok(EDIT_GROUPS.rendering.includes(id), id);
  }
});

test('two photos keep their own quality settings', () => {
  const doc = fakeDoc({ detail: '2', 'still-passes': '4', 'fullres-on': true, 'still-scale': '4', 'auto-render': true, 'stereo-on': false });
  const first = readEdits(doc);
  Object.assign(doc.els['detail'], { value: '1' });
  Object.assign(doc.els['still-passes'], { value: '0' });
  doc.els['fullres-on'].checked = false;
  doc.els['auto-render'].checked = false;
  const second = readEdits(doc);
  // opening the first photo again restores its values, the second keeps its own
  writeEdits(doc, first, second);
  assert.equal(doc.els['detail'].value, '2');
  assert.equal(doc.els['still-passes'].value, '4');
  assert.equal(doc.els['fullres-on'].checked, true);
  assert.equal(doc.els['auto-render'].checked, true);
  writeEdits(doc, second, first);
  assert.equal(doc.els['detail'].value, '1');
  assert.equal(doc.els['fullres-on'].checked, false);
});
