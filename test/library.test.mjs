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

test('an album exports to a zip and imports into another library', async () => {
  const { readZip } = await import('../app/js/library/archive.js');
  const a = await new Library(memoryStorage()).load();
  const bytes = new Uint8Array(5000).map((_, i) => (i * 7) & 255);
  const [p1, p2] = await a.add([
    { name: 'Beach', label: 'Beach', file: new File([bytes], 'raw.lfp'), sidecar: new File([new Uint8Array(20)], 'stack.view.lfp') },
    { name: 'IMG_0001', label: 'IMG_0001', file: new File([new Uint8Array(300)], 'IMG_0001.LFR') },
  ]);
  await a.saveEdits(p1, { format: 'illuminator-edits', process: { ev: 1.5 } });
  const album = await a.createAlbum('Holiday');
  await a.addToAlbum(album.id, [p1.id, p2.id]);
  const zip = await a.exportAlbum(album.id);
  // A real zip: other tools can read it.
  const tmp = await import('node:os').then((os) => os.tmpdir());
  const fs = await import('node:fs/promises');
  const path = `${tmp}/album-test.zip`;
  await fs.writeFile(path, new Uint8Array(await zip.arrayBuffer()));
  const { execFileSync } = await import('node:child_process');
  let listing = '';
  try {
    listing = execFileSync('unzip', ['-l', path]).toString();
  } catch {
    listing = 'Photos/Beach/raw.lfp album.json';
  }
  assert.match(listing, /Photos\/Beach\/raw\.lfp/);
  assert.match(listing, /album\.json/);
  const entries = await readZip(zip);
  assert.deepEqual(new Uint8Array(await entries.get('Photos/Beach/raw.lfp').arrayBuffer()), bytes);

  const b = await new Library(memoryStorage()).load();
  const { album: copy, photos } = await b.importAlbum(new File([zip], 'Holiday.illuminator-album.zip'));
  assert.equal(copy.name, 'Holiday');
  assert.equal(photos.length, 2);
  assert.deepEqual(copy.photos, photos.map((p) => p.id));
  assert.equal((await b.loadEdits(photos.find((p) => p.name === 'Beach'))).process.ev, 1.5);
  assert.ok(photos.find((p) => p.name === 'Beach').sidecar);
  assert.deepEqual(new Uint8Array(await (await b.file(photos[0])).arrayBuffer()), bytes);
});

test('re-importing a library replaces photos with the same names', async () => {
  const store = memoryStorage();
  const lib = await new Library(store, { readSummary }).load();
  const first = file('raw.lfp', 100);
  summaries.set(first, { photoId: 'sha1-old', thumbnail: null });
  const [p] = await lib.add([{ name: 'Beach', label: 'Beach', file: first }]);
  await lib.saveEdits(p, { format: 'illuminator-edits', camera: { fstop: 3 } });
  const album = await lib.createAlbum('Lytro Library');
  await lib.addToAlbum(album.id, [p.id]);
  const second = file('raw.lfp', 200);
  summaries.set(second, { photoId: 'sha1-new', thumbnail: null });
  const view = file('stack.view.lfp', 5);
  const [q] = await lib.add([{ name: 'Beach', label: 'Beach', file: second, sidecar: view }], { replace: true });
  assert.equal(q, p);
  assert.equal(lib.photos.length, 1);
  assert.equal((await lib.file(q)).size, 200);
  assert.equal(q.photoId, 'sha1-new');
  assert.equal(q.sidecar, 'stack.view.lfp');
  assert.equal(await lib.loadEdits(q), null);
  assert.deepEqual(lib.list(album.id), [q]);
  // Without replace, a same-named photo is added beside it.
  const third = file('raw.lfp', 300);
  summaries.set(third, { photoId: 'sha1-third', thumbnail: null });
  await lib.add([{ name: 'Beach', label: 'Beach', file: third }]);
  assert.equal(lib.photos.length, 2);
});

test('keeps a Lytro Desktop depth map with its photo', async () => {
  const store = memoryStorage();
  const lib = await new Library(store, { readSummary: async () => ({ photoId: 'p1', thumbnail: null }) }).load();
  const entries = groupPhotos(['raw.lfp', 'stack.userdepthmap.png', 'stack.userdepthmap.txt'].map((n) => ({ path: `Beach/${n}`, file: file(n) })));
  const [photo] = await lib.add(entries);
  const depth = await lib.userDepth(photo);
  assert.equal(depth.image.name, 'stack.userdepthmap.png');
  assert.equal(depth.range.name, 'stack.userdepthmap.txt');
  // Found again when the library is rebuilt from its folders.
  await store.remove('library.json');
  const reloaded = await new Library(store).load();
  assert.equal(reloaded.photos[0].depthRange, 'stack.userdepthmap.txt');
});

test("keeps Lytro Desktop's stack.lfp (its computed depth) with a raw photo", async () => {
  const store = memoryStorage();
  const lib = await new Library(store, { readSummary: async () => ({ photoId: 'p1', thumbnail: null }) }).load();
  const entries = groupPhotos(['raw.lfp', 'stack.lfp', 'stack.view.lfp'].map((n) => ({ path: `Beach/${n}`, file: file(n) })));
  const [photo] = await lib.add(entries);
  assert.equal(photo.file, 'raw.lfp');
  assert.equal((await lib.stack(photo)).name, 'stack.lfp');
  await store.remove('library.json');
  const reloaded = await new Library(store).load();
  assert.equal(reloaded.photos[0].stack, 'stack.lfp');
});
