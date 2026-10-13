import test from 'node:test';
import assert from 'node:assert/strict';
import { groupPhotos } from '../app/js/library/scan.js';
import { memoryStorage } from '../app/js/library/storage.js';
import { Library } from '../app/js/library/library.js';

const file = (name, size = 10) => new File([new Uint8Array(size)], name);

test('groups Lytro Desktop picture folders, camera files and exported LFPs', () => {
  const raw = file('raw.lfp');
  const view = file('stack.view.lfp');
  const stack = file('stack.lfp');
  const thumb = file('thumbnail.jpg');
  const lfr = file('IMG_0001.LFR');
  const exp = file('IMG_0001.LFP');
  const fork = file('._IMG_0002.LFR');
  const photos = groupPhotos([
    { path: 'Lib/images/Beach/raw.lfp', file: raw },
    { path: 'Lib/images/Beach/stack.view.lfp', file: view },
    { path: 'Lib/images/Beach/stack.lfp', file: stack },
    { path: 'Lib/images/Beach/thumbnail.jpg', file: thumb },
    { path: 'DCIM/100PHOTO/IMG_0001.LFR', file: lfr },
    { path: 'DCIM/100PHOTO/IMG_0001.LFP', file: exp },
    { path: 'DCIM/100PHOTO/._IMG_0002.LFR', file: fork },
  ]);
  assert.equal(photos.length, 3);
  const beach = photos.find((p) => p.file === raw);
  assert.equal(beach.name, 'Beach');
  assert.equal(beach.sidecar, view);
  assert.equal(beach.thumb, thumb);
  assert.equal(photos.find((p) => p.file === lfr).sidecar, exp);
  assert.ok(photos.find((p) => p.file === exp));
});

test('a single edits file picked with a single photo belongs to it', () => {
  const lfr = file('IMG_9.LFR');
  const view = file('stack.view.lfp');
  const photos = groupPhotos([{ path: 'IMG_9.LFR', file: lfr }, { path: 'stack.view.lfp', file: view }]);
  assert.equal(photos.length, 1);
  assert.equal(photos[0].sidecar, view);
});

const summaries = new Map();
const readSummary = async (f) => summaries.get(f) || { photoId: null, thumbnail: null };

test('adds photos into their own folders and skips ones already there', async () => {
  const store = memoryStorage();
  const lib = await new Library(store, { readSummary }).load();
  const a = file('IMG_0001.LFR', 100);
  const b = file('IMG_0001.LFR', 100);
  summaries.set(a, { photoId: 'sha1-a', thumbnail: { mime: 'image/jpeg', bytes: new Uint8Array([0xff, 0xd8, 0xff]) } });
  summaries.set(b, { photoId: 'sha1-b', thumbnail: null });
  const [pa] = await lib.add([{ name: 'IMG_0001.LFR', label: 'IMG_0001', file: a }]);
  const [pb] = await lib.add([{ name: 'IMG_0001.LFR', label: 'IMG_0001', file: b }]);
  assert.equal(pa.id, 'IMG_0001');
  assert.equal(pb.id, 'IMG_0001-2');
  assert.equal(pa.thumb, 'thumb.jpg');
  assert.equal((await lib.file(pa)).size, 100);
  const [again] = await lib.add([{ name: 'IMG_0001.LFR', label: 'IMG_0001', file: a }]);
  assert.equal(again, pa);
  assert.equal(lib.photos.length, 2);

  // Reloading reads library.json back.
  const reloaded = await new Library(store, { readSummary }).load();
  assert.deepEqual(reloaded.photos.map((p) => p.id), ['IMG_0001', 'IMG_0001-2']);
});

test('keeps edits next to the photo and albums in the index', async () => {
  const store = memoryStorage();
  const lib = await new Library(store, { readSummary }).load();
  const [p] = await lib.add([{ name: 'x.lfr', label: 'x', file: file('x.lfr') }]);
  await lib.saveEdits(p, { format: 'illuminator-edits', camera: { fstop: 3 } });
  assert.deepEqual((await lib.loadEdits(p)).camera, { fstop: 3 });
  const album = await lib.createAlbum('Trips');
  await lib.addToAlbum(album.id, [p.id, 'nope']);
  assert.deepEqual(lib.list(album.id), [p]);
  await lib.renameAlbum(album.id, 'Holidays');
  const reloaded = await new Library(store, { readSummary }).load();
  assert.equal(reloaded.albums[0].name, 'Holidays');
  assert.deepEqual(reloaded.albums[0].photos, [p.id]);
  await reloaded.remove([p.id]);
  assert.deepEqual(reloaded.albums[0].photos, []);
  assert.deepEqual(await store.list('Photos'), []);
});

test('adopts loose photos and unknown folders when loading', async () => {
  const store = memoryStorage();
  await store.copyIn(file('100PHOTO_IMG_0005.LFR', 50), 'Photos/100PHOTO_IMG_0005.LFR');
  await store.copyIn(file('raw.lfp', 70), 'Photos/Old/raw.lfp');
  await store.copyIn(file('stack.view.lfp', 5), 'Photos/Old/stack.view.lfp');
  const lib = await new Library(store, { readSummary }).load();
  const ids = lib.photos.map((p) => p.id).sort();
  assert.deepEqual(ids, ['100PHOTO_IMG_0005', 'Old']);
  const old = lib.get('Old');
  assert.equal(old.file, 'raw.lfp');
  assert.equal(old.sidecar, 'stack.view.lfp');
  assert.equal(old.name, 'Old');
  assert.equal((await lib.file(lib.get('100PHOTO_IMG_0005'))).size, 50);
});
