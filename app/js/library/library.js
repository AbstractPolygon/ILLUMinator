// The photo library: one folder holding every photo in its own folder, with
// its Lytro Desktop edits, its ILLUMinator edits and a thumbnail beside it,
// plus library.json listing the photos and the user's albums.
//
//   library.json
//   Photos/IMG_0001/IMG_0001.LFR
//                  /edits.illuminator.json
//                  /thumb.jpg
//   Photos/Beach/raw.lfp            (imported from Lytro Desktop)
//               /stack.view.lfp
//
// library.json:
// { "format": "illuminator-library", "version": 1,
//   "photos": [{ "id", "name", "file", "sidecar", "thumb", "size", "photoId", "added" }],
//   "albums": [{ "id", "name", "photos": [photo id, ...] }] }
//
// A photo's id is its folder name. The folder is the truth: photos found in
// Photos/ that library.json does not list are added when the library loads,
// and photos whose folder has gone are dropped.

import { groupPhotos, stem } from './scan.js';
import { writeZip, readZip, ARCHIVE_FORMAT, ARCHIVE_VERSION } from './archive.js';

export const LIBRARY_FORMAT = 'illuminator-library';
export const LIBRARY_VERSION = 1;
export const EDITS_FILE = 'edits.illuminator.json';
const INDEX = 'library.json';
const PHOTOS = 'Photos';

const LIGHT_FIELD = /\.(lfr|lfp|raw)$/i;

function folderName(label) {
  const clean = String(label || 'photo').replace(/[^\w.-]+/g, '_').replace(/^[._]+/, '').slice(0, 60);
  return clean || 'photo';
}

export class Library {
  // store: storage.js backend. readSummary(file) -> { photoId, thumbnail }
  // reads a photo's id and embedded thumbnail ({ mime, bytes } or null).
  constructor(store, { readSummary = async () => ({ photoId: null, thumbnail: null }) } = {}) {
    this.store = store;
    this.readSummary = readSummary;
    this.photos = [];
    this.albums = [];
    this.saving = Promise.resolve();
  }

  get persistent() {
    return this.store.kind !== 'memory';
  }

  async load() {
    let index = null;
    try {
      const text = await this.store.readText(INDEX);
      index = text ? JSON.parse(text) : null;
    } catch (err) {
      console.warn('library.json is unreadable; rebuilding it from the photo folders', err);
    }
    if (index && index.format && index.format !== LIBRARY_FORMAT) index = null;
    this.photos = (index && Array.isArray(index.photos) ? index.photos : []).filter((p) => p && p.id && p.file);
    this.albums = (index && Array.isArray(index.albums) ? index.albums : []).filter((a) => a && a.id);
    const changed = await this.reconcile();
    if (changed || !index) await this.save();
    return this;
  }

  // Brings the list in line with the Photos folder.
  async reconcile() {
    const entries = await this.store.list(PHOTOS);
    const dirs = new Set(entries.filter((e) => e.dir).map((e) => e.name));
    let changed = false;

    const kept = this.photos.filter((p) => dirs.has(p.id));
    if (kept.length !== this.photos.length) changed = true;
    this.photos = kept;

    // Folders the index does not know (copied in by hand, or an index lost).
    const known = new Set(this.photos.map((p) => p.id));
    for (const dir of dirs) {
      if (known.has(dir)) continue;
      const files = await this.store.list(`${PHOTOS}/${dir}`);
      const found = groupPhotos(files.filter((f) => !f.dir).map((f) => ({ path: f.name, file: { name: f.name, size: f.size } })))[0];
      if (!found) continue;
      const thumb = files.find((f) => /^thumb\.(jpe?g|png)$/i.test(f.name));
      this.photos.push({
        id: dir, name: found.name === 'raw' ? dir : found.name, file: found.file.name, sidecar: found.sidecar ? found.sidecar.name : null,
        thumb: thumb ? thumb.name : null, size: found.file.size, photoId: null, added: new Date().toISOString(),
      });
      changed = true;
    }

    // Photos left loose in Photos/ (camera imports of earlier versions):
    // each moves into a folder of its own.
    const loose = entries.filter((e) => !e.dir && LIGHT_FIELD.test(e.name));
    if (loose.length) {
      for (const g of groupPhotos(loose.map((e) => ({ path: e.name, file: { name: e.name, size: e.size } })))) {
        const id = this.uniqueId(g.label);
        await this.store.move(`${PHOTOS}/${g.file.name}`, `${PHOTOS}/${id}/${g.file.name}`);
        if (g.sidecar) await this.store.move(`${PHOTOS}/${g.sidecar.name}`, `${PHOTOS}/${id}/${g.sidecar.name}`);
        this.photos.push({ id, name: g.name, file: g.file.name, sidecar: g.sidecar ? g.sidecar.name : null, thumb: null, size: g.file.size, photoId: null, added: new Date().toISOString() });
      }
      changed = true;
    }

    const ids = new Set(this.photos.map((p) => p.id));
    for (const a of this.albums) {
      const inside = (a.photos || []).filter((id) => ids.has(id));
      if (inside.length !== (a.photos || []).length) changed = true;
      a.photos = inside;
    }
    return changed;
  }

  uniqueId(label) {
    const base = folderName(label);
    const taken = new Set(this.photos.map((p) => p.id.toLowerCase()));
    let id = base;
    for (let n = 2; taken.has(id.toLowerCase()); n++) id = `${base}-${n}`;
    return id;
  }

  save() {
    const doc = { format: LIBRARY_FORMAT, version: LIBRARY_VERSION, photos: this.photos, albums: this.albums };
    const text = JSON.stringify(doc, null, 2);
    // One write at a time, in order.
    this.saving = this.saving.catch(() => {}).then(() => this.store.writeText(INDEX, text));
    return this.saving;
  }

  get(id) {
    return this.photos.find((p) => p.id === id) || null;
  }

  // Copies photos into the library. entries: [{ name, label, file, sidecar,
  // thumb }] (scan.js). A photo already in the library (same photo id) is
  // not copied again; with `replace`, one with the same name (or photo id)
  // is replaced by the new files, keeping its place in albums, and its
  // edits start over from the new files. Returns the library photo for
  // each entry, in order.
  async add(entries, { onProgress = () => {}, replace = false } = {}) {
    const out = [];
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      onProgress(e, i, entries.length);
      let summary = { photoId: null, thumbnail: null };
      try {
        summary = await this.readSummary(e.file);
      } catch {
        // Not readable as an LFP (a .raw dump): no id, no thumbnail.
      }
      const sameName = (p) => p.name.toLowerCase() === String(e.name).toLowerCase();
      const old = replace && (this.photos.find(sameName) || (summary.photoId && this.photos.find((p) => p.photoId === summary.photoId)));
      if (old) {
        await this.store.remove(`${PHOTOS}/${old.id}`);
        Object.assign(old, await this.copyFiles(e, old.id, summary), { name: e.name, size: e.file.size, photoId: summary.photoId, added: new Date().toISOString() });
        out.push(old);
        await this.save();
        continue;
      }
      const existing = summary.photoId && this.photos.find((p) => p.photoId === summary.photoId);
      if (existing) {
        if (e.sidecar && !existing.sidecar) {
          await this.store.copyIn(e.sidecar, `${PHOTOS}/${existing.id}/${e.sidecar.name}`);
          existing.sidecar = e.sidecar.name;
        }
        out.push(existing);
        continue;
      }
      const id = this.uniqueId(e.label || stem(e.name));
      const photo = { id, name: e.name, ...(await this.copyFiles(e, id, summary)), size: e.file.size, photoId: summary.photoId, added: new Date().toISOString() };
      this.photos.push(photo);
      out.push(photo);
      await this.save();
    }
    onProgress(null, entries.length, entries.length);
    return out;
  }

  // Copies an entry's photo, edits and thumbnail into the folder `id`.
  async copyFiles(e, id, summary) {
    const dir = `${PHOTOS}/${id}`;
    const file = e.file.name || e.name;
    await this.store.copyIn(e.file, `${dir}/${file}`);
    let sidecar = null;
    if (e.sidecar && e.sidecar.name.toLowerCase() !== file.toLowerCase()) {
      sidecar = e.sidecar.name;
      await this.store.copyIn(e.sidecar, `${dir}/${sidecar}`);
    }
    let thumb = null;
    try {
      if (e.thumb) {
        thumb = /\.png$/i.test(e.thumb.name) ? 'thumb.png' : 'thumb.jpg';
        await this.store.copyIn(e.thumb, `${dir}/${thumb}`);
      } else if (summary.thumbnail) {
        thumb = summary.thumbnail.mime === 'image/png' ? 'thumb.png' : 'thumb.jpg';
        await this.store.writeBlob(`${dir}/${thumb}`, new Blob([summary.thumbnail.bytes], { type: summary.thumbnail.mime }));
      }
    } catch {
      thumb = null;
    }
    return { file, sidecar, thumb };
  }

  async remove(ids) {
    const gone = new Set(ids);
    for (const id of gone) await this.store.remove(`${PHOTOS}/${id}`);
    this.photos = this.photos.filter((p) => !gone.has(p.id));
    for (const a of this.albums) a.photos = a.photos.filter((id) => !gone.has(id));
    await this.save();
  }

  file(photo) {
    return this.store.file(`${PHOTOS}/${photo.id}/${photo.file}`);
  }

  sidecar(photo) {
    return photo.sidecar ? this.store.file(`${PHOTOS}/${photo.id}/${photo.sidecar}`) : Promise.resolve(null);
  }

  thumbnail(photo) {
    return photo.thumb ? this.store.file(`${PHOTOS}/${photo.id}/${photo.thumb}`) : Promise.resolve(null);
  }

  async saveThumbnail(photo, blob) {
    const name = blob.type === 'image/png' ? 'thumb.png' : 'thumb.jpg';
    await this.store.writeBlob(`${PHOTOS}/${photo.id}/${name}`, blob);
    photo.thumb = name;
    await this.save();
  }

  async setPhotoId(photo, photoId) {
    if (!photoId || photo.photoId === photoId) return;
    photo.photoId = photoId;
    await this.save();
  }

  async loadEdits(photo) {
    try {
      const text = await this.store.readText(`${PHOTOS}/${photo.id}/${EDITS_FILE}`);
      return text ? JSON.parse(text) : null;
    } catch {
      return null;
    }
  }

  saveEdits(photo, edits) {
    return this.store.writeText(`${PHOTOS}/${photo.id}/${EDITS_FILE}`, JSON.stringify(edits, null, 2));
  }

  // ------------------------------------------------------------ albums

  album(id) {
    return this.albums.find((a) => a.id === id) || null;
  }

  async createAlbum(name) {
    let n = this.albums.length + 1;
    while (this.albums.some((a) => a.id === `album-${n}`)) n++;
    const album = { id: `album-${n}`, name: String(name).trim() || 'Untitled album', photos: [] };
    this.albums.push(album);
    await this.save();
    return album;
  }

  async renameAlbum(id, name) {
    const a = this.album(id);
    if (!a || !String(name).trim()) return;
    a.name = String(name).trim();
    await this.save();
  }

  async deleteAlbum(id) {
    this.albums = this.albums.filter((a) => a.id !== id);
    await this.save();
  }

  async addToAlbum(id, photoIds) {
    const a = this.album(id);
    if (!a) return;
    for (const p of photoIds) if (!a.photos.includes(p) && this.get(p)) a.photos.push(p);
    await this.save();
  }

  async removeFromAlbum(id, photoIds) {
    const a = this.album(id);
    if (!a) return;
    a.photos = a.photos.filter((p) => !photoIds.includes(p));
    await this.save();
  }

  // ------------------------------------------------------------ archives

  // An album as a zip (archive.js): its photos with their edits, Lytro
  // Desktop edits and thumbnails. onProgress(fraction).
  async exportAlbum(id, { onProgress = () => {} } = {}) {
    const album = this.album(id);
    if (!album) throw new Error('No such album');
    const asBlob = async (f) => (f instanceof Blob ? f : new Blob([await f.arrayBuffer()]));
    const files = [];
    const photos = [];
    for (const p of this.list(id)) {
      const dir = `${PHOTOS}/${p.id}`;
      const file = await this.file(p);
      if (!file) continue;
      files.push({ path: `${dir}/${p.file}`, data: await asBlob(file) });
      const sidecar = await this.sidecar(p);
      if (sidecar) files.push({ path: `${dir}/${p.sidecar}`, data: await asBlob(sidecar) });
      const thumb = await this.thumbnail(p).catch(() => null);
      if (thumb) files.push({ path: `${dir}/${p.thumb}`, data: await asBlob(thumb) });
      const edits = await this.store.readText(`${dir}/${EDITS_FILE}`).catch(() => null);
      if (edits) files.push({ path: `${dir}/${EDITS_FILE}`, data: edits });
      photos.push({ folder: p.id, name: p.name, file: p.file, sidecar: sidecar ? p.sidecar : null, thumb: thumb ? p.thumb : null, edits: !!edits });
    }
    const index = { format: ARCHIVE_FORMAT, version: ARCHIVE_VERSION, name: album.name, exported: new Date().toISOString(), photos };
    return writeZip([{ path: 'album.json', data: JSON.stringify(index, null, 2) }, ...files], { onProgress });
  }

  // Adds an exported album (a zip) to this library: its photos (one already
  // here is not copied twice), their edits (unless the photo here has some)
  // and the album, joined to one of the same name if there is one.
  // onProgress as for add(). Returns { album, photos }.
  async importAlbum(src, { onProgress = () => {} } = {}) {
    const entries = await readZip(src);
    const indexFile = entries.get('album.json');
    if (!indexFile) throw new Error('Not an ILLUMinator album (album.json is missing)');
    const index = JSON.parse(new TextDecoder().decode(await indexFile.arrayBuffer()));
    if (index.format !== ARCHIVE_FORMAT) throw new Error('Not an ILLUMinator album');
    const at = (folder, name) => (name ? entries.get(`${PHOTOS}/${folder}/${name}`) || null : null);
    const items = (index.photos || [])
      .map((p) => ({ meta: p, entry: { name: p.name, label: p.folder, file: at(p.folder, p.file), sidecar: at(p.folder, p.sidecar), thumb: at(p.folder, p.thumb) } }))
      .filter((i) => i.entry.file);
    const photos = await this.add(items.map((i) => i.entry), { onProgress });
    for (let i = 0; i < photos.length; i++) {
      const edits = items[i].meta.edits ? at(items[i].meta.folder, EDITS_FILE) : null;
      if (!edits || (await this.loadEdits(photos[i]))) continue;
      await this.store.writeText(`${PHOTOS}/${photos[i].id}/${EDITS_FILE}`, new TextDecoder().decode(await edits.arrayBuffer()));
    }
    const name = String(index.name || 'Imported album');
    const album = this.albums.find((a) => a.name === name) || (await this.createAlbum(name));
    await this.addToAlbum(album.id, photos.map((p) => p.id));
    return { album, photos };
  }

  // Photos in an album (or all photos when id is null), newest first.
  list(albumId = null) {
    const a = albumId ? this.album(albumId) : null;
    const photos = a ? a.photos.map((id) => this.get(id)).filter(Boolean) : [...this.photos].reverse();
    return photos;
  }
}
