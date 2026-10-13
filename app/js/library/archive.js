// Album archives: a .zip of an album's photos, their edits and thumbnails,
// to move an album from one library to another (the browser version's to
// the desktop app's, say). Files are stored as they are (Lytro files do not
// compress); Zip64 takes over past 4 GB.
//
//   album.json                 { format, version, name, photos: [{ folder,
//                                name, file, sidecar, thumb, edits }] }
//   Photos/<folder>/<file>     the photo, its Lytro Desktop edits (sidecar),
//   Photos/<folder>/...        thumbnail and edits.illuminator.json

export const ARCHIVE_FORMAT = 'illuminator-album';
export const ARCHIVE_VERSION = 1;
export const ARCHIVE_SUFFIX = '.illuminator-album.zip';

const U32 = 0xffffffff;

let crcTable = null;
function crc32(bytes, crc = 0) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = ~crc >>> 0;
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

async function blobCrc(blob, onBytes) {
  const CHUNK = 8 << 20;
  let crc = 0;
  for (let at = 0; at < blob.size; at += CHUNK) {
    const bytes = new Uint8Array(await blob.slice(at, Math.min(blob.size, at + CHUNK)).arrayBuffer());
    crc = crc32(bytes, crc);
    onBytes(bytes.length);
  }
  return crc;
}

function dosTime(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

// files: [{ path, data }] (data: a Blob or a string). onProgress(fraction).
// Returns the archive as a Blob, built from the files without copying them.
export async function writeZip(files, { onProgress = () => {} } = {}) {
  const enc = new TextEncoder();
  const { time, date } = dosTime(new Date());
  const blobs = files.map((f) => ({ path: f.path, blob: typeof f.data === 'string' ? new Blob([f.data]) : f.data }));
  const total = blobs.reduce((n, f) => n + f.blob.size, 0) || 1;
  let done = 0;
  const parts = [];
  const central = [];
  let offset = 0;
  for (const f of blobs) {
    const name = enc.encode(f.path);
    const size = f.blob.size;
    const crc = await blobCrc(f.blob, (n) => {
      done += n;
      onProgress(done / total);
    });
    const big = size >= U32;
    const local = new DataView(new ArrayBuffer(30 + name.length + (big ? 20 : 0)));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, big ? 45 : 20, true);
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, 0, true); // stored
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, big ? U32 : size, true);
    local.setUint32(22, big ? U32 : size, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, big ? 20 : 0, true);
    new Uint8Array(local.buffer).set(name, 30);
    if (big) {
      local.setUint16(30 + name.length, 1, true);
      local.setUint16(32 + name.length, 16, true);
      local.setBigUint64(34 + name.length, BigInt(size), true);
      local.setBigUint64(42 + name.length, BigInt(size), true);
    }
    central.push({ name, size, crc, offset });
    parts.push(local.buffer, f.blob);
    offset += local.byteLength + size;
  }
  const cdStart = offset;
  for (const e of central) {
    const extra = [];
    if (e.size >= U32) extra.push(e.size, e.size);
    if (e.offset >= U32) extra.push(e.offset);
    const extraLen = extra.length ? 4 + 8 * extra.length : 0;
    const h = new DataView(new ArrayBuffer(46 + e.name.length + extraLen));
    h.setUint32(0, 0x02014b50, true);
    h.setUint16(4, 45, true);
    h.setUint16(6, extraLen ? 45 : 20, true);
    h.setUint16(8, 0x0800, true);
    h.setUint16(10, 0, true);
    h.setUint16(12, time, true);
    h.setUint16(14, date, true);
    h.setUint32(16, e.crc, true);
    h.setUint32(20, e.size >= U32 ? U32 : e.size, true);
    h.setUint32(24, e.size >= U32 ? U32 : e.size, true);
    h.setUint16(28, e.name.length, true);
    h.setUint16(30, extraLen, true);
    h.setUint32(42, e.offset >= U32 ? U32 : e.offset, true);
    new Uint8Array(h.buffer).set(e.name, 46);
    if (extraLen) {
      const at = 46 + e.name.length;
      h.setUint16(at, 1, true);
      h.setUint16(at + 2, 8 * extra.length, true);
      extra.forEach((v, i) => h.setBigUint64(at + 4 + 8 * i, BigInt(v), true));
    }
    parts.push(h.buffer);
    offset += h.byteLength;
  }
  const cdSize = offset - cdStart;
  const count = central.length;
  if (count >= 0xffff || cdStart >= U32 || cdSize >= U32) {
    const z = new DataView(new ArrayBuffer(56 + 20));
    z.setUint32(0, 0x06064b50, true);
    z.setBigUint64(4, 44n, true);
    z.setUint16(12, 45, true);
    z.setUint16(14, 45, true);
    z.setBigUint64(24, BigInt(count), true);
    z.setBigUint64(32, BigInt(count), true);
    z.setBigUint64(40, BigInt(cdSize), true);
    z.setBigUint64(48, BigInt(cdStart), true);
    z.setUint32(56, 0x07064b50, true);
    z.setBigUint64(64, BigInt(offset), true);
    z.setUint32(72, 1, true);
    parts.push(z.buffer);
  }
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, Math.min(count, 0xffff), true);
  end.setUint16(10, Math.min(count, 0xffff), true);
  end.setUint32(12, Math.min(cdSize, U32), true);
  end.setUint32(16, Math.min(cdStart, U32), true);
  parts.push(end.buffer);
  onProgress(1);
  return new Blob(parts, { type: 'application/zip' });
}

// A stored entry of `src` as a file: a real File for a Blob source, or a
// file-like object (name, size, arrayBuffer, slice) for others.
function entryFile(src, start, size, name) {
  if (typeof Blob !== 'undefined' && src instanceof Blob) return new File([src.slice(start, start + size)], name);
  return {
    name,
    size,
    arrayBuffer: () => src.slice(start, start + size).arrayBuffer(),
    slice: (a = 0, b = size) => src.slice(start + Math.max(0, a), start + Math.min(size, b)),
  };
}

// The entries of a zip (`src`: a Blob or file-like with slice()): a map from
// path to file. Only stored (uncompressed) entries, as writeZip makes.
export async function readZip(src) {
  const read = async (at, n) => new DataView(await src.slice(at, at + n).arrayBuffer());
  const tailLen = Math.min(src.size, 22 + 0xffff);
  const tail = await read(src.size - tailLen, tailLen);
  let eocd = -1;
  for (let i = tailLen - 22; i >= 0; i--) {
    if (tail.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a zip file');
  let count = tail.getUint16(eocd + 10, true);
  let cdSize = tail.getUint32(eocd + 12, true);
  let cdStart = tail.getUint32(eocd + 16, true);
  if (count === 0xffff || cdSize === U32 || cdStart === U32) {
    const loc = eocd - 20;
    if (loc < 0 || tail.getUint32(loc, true) !== 0x07064b50) throw new Error('Damaged zip file');
    const z = await read(Number(tail.getBigUint64(loc + 8, true)), 56);
    count = Number(z.getBigUint64(32, true));
    cdSize = Number(z.getBigUint64(40, true));
    cdStart = Number(z.getBigUint64(48, true));
  }
  const cd = await read(cdStart, cdSize);
  const dec = new TextDecoder();
  const out = new Map();
  for (let at = 0, i = 0; i < count; i++) {
    if (cd.getUint32(at, true) !== 0x02014b50) throw new Error('Damaged zip file');
    const method = cd.getUint16(at + 10, true);
    let size = cd.getUint32(at + 24, true);
    const nameLen = cd.getUint16(at + 28, true);
    const extraLen = cd.getUint16(at + 30, true);
    const commentLen = cd.getUint16(at + 32, true);
    let offset = cd.getUint32(at + 42, true);
    const name = dec.decode(new Uint8Array(cd.buffer, cd.byteOffset + at + 46, nameLen));
    // Zip64 sizes and offset, in that order, for the fields that overflowed.
    for (let e = at + 46 + nameLen; e < at + 46 + nameLen + extraLen;) {
      const id = cd.getUint16(e, true);
      const len = cd.getUint16(e + 2, true);
      if (id === 1) {
        let p = e + 4;
        if (size === U32) {
          size = Number(cd.getBigUint64(p, true));
          p += 16;
        }
        if (offset === U32) offset = Number(cd.getBigUint64(p, true));
      }
      e += 4 + len;
    }
    at += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    if (method !== 0) throw new Error(`${name} is compressed; only ILLUMinator album archives can be imported`);
    const local = await read(offset, 30);
    const start = offset + 30 + local.getUint16(26, true) + local.getUint16(28, true);
    out.set(name, entryFile(src, start, size, name.split('/').pop()));
  }
  return out;
}
