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
  // not copied again. Returns the library photo for each entry, in order.
  async add(entries, { onProgress = () => {} } = {}) {
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
      const dir = `${PHOTOS}/${id}`;
      const fileName = e.file.name || e.name;
      await this.store.copyIn(e.file, `${dir}/${fileName}`);
      let sidecar = null;
      if (e.sidecar && e.sidecar.name.toLowerCase() !== fileName.toLowerCase()) {
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
      const photo = { id, name: e.name, file: fileName, sidecar, thumb, size: e.file.size, photoId: summary.photoId, added: new Date().toISOString() };
      this.photos.push(photo);
      out.push(photo);
      await this.save();
    }
    onProgress(null, entries.length, entries.length);
    return out;
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

  // Photos in an album (or all photos when id is null), newest first.
  list(albumId = null) {
    const a = albumId ? this.album(albumId) : null;
    const photos = a ? a.photos.map((id) => this.get(id)).filter(Boolean) : [...this.photos].reverse();
    return photos;
  }
}
