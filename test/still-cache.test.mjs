import test from 'node:test';
import assert from 'node:assert/strict';
import { hashKey, touchIndex, stillKeyText, stillFileName, STILLS_KEPT } from '../app/js/core/still-cache.js';

const base = () => ({
  edits: { modified: 'a', photo: { id: 1 }, process: { ev: 0 }, camera: { fstop: 4 }, animation: { fps: 24 }, rendering: { detail: 1, 'fullres-on': true, 'still-scale': 2, 'still-passes': 1, 'video-codec': 'x', 'photo-format': 'png' } },
  camera: { u: 0, v: 0, alpha: 0.2, aperture: 1, dof: 3 }, scale: 2, passes: 1, frame: null, photoId: 'P', version: '0.5.40',
});

test('the key follows what shapes the picture and ignores the date, animation and export settings', () => {
  const k = stillKeyText(base());
  const other = base();
  other.edits.modified = 'b';
  other.edits.animation.fps = 30;
  other.edits.rendering['video-codec'] = 'y';
  other.edits.rendering['photo-format'] = 'jpeg';
  assert.equal(stillKeyText(other), k);
  for (const change of [(b) => { b.edits.process.ev = 1; }, (b) => { b.camera.alpha = 0.3; }, (b) => { b.scale = 3; }, (b) => { b.passes = 2; }, (b) => { b.version = '0.5.41'; }, (b) => { b.photoId = 'Q'; }, (b) => { b.edits.rendering['still-scale'] = 4; }]) {
    const b = base();
    change(b);
    assert.notEqual(stillKeyText(b), k);
  }
});

test('hashes are stable, different for different text, and file safe', () => {
  assert.equal(hashKey('abc'), hashKey('abc'));
  assert.notEqual(hashKey('abc'), hashKey('abd'));
  assert.match(hashKey('anything'), /^[0-9a-f]{16}$/);
  assert.equal(stillFileName('00ff'), 'still-00ff.png');
});

test('only the newest renders are kept, and a repeated one moves to the end', () => {
  let index = [];
  const dropped = [];
  for (const h of ['a', 'b', 'c', 'd', 'e']) {
    const r = touchIndex(index, h);
    index = r.index;
    dropped.push(...r.dropped);
  }
  assert.equal(index.length, STILLS_KEPT);
  assert.deepEqual(dropped, ['a']);
  assert.deepEqual(touchIndex(index, 'c').index, ['b', 'd', 'e', 'c']);
  assert.deepEqual(touchIndex(index, 'c').dropped, []);
  assert.deepEqual(touchIndex('junk', 'x'), { index: ['x'], dropped: [] });
});
