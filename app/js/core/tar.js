// Reading a .tar without loading it: only each entry's 512-byte header is
// read, and an entry's data is cut out of the file by position. Calibration
// backups from the camera are over a gigabyte, so they are never held whole.
//
// `file` is anything with `size` and `slice(start, end).arrayBuffer()` (a
// File, or the desktop app's NativeFile).

const decoder = new TextDecoder();

function text(bytes, from, to) {
  const s = decoder.decode(bytes.subarray(from, to));
  const nul = s.indexOf('\0');
  return nul < 0 ? s : s.slice(0, nul);
}

// Sizes are octal text, or base-256 (high bit set) for very large entries.
function number(bytes, from, to) {
  if (bytes[from] & 0x80) {
    let v = 0;
    for (let i = from + 1; i < to; i++) v = v * 256 + bytes[i];
    return v;
  }
  return parseInt(text(bytes, from, to).trim() || '0', 8);
}

// Returns [{ name, size, offset }] for every regular file in the archive,
// `offset` being where its data starts in the file.
export async function scanTar(file) {
  const entries = [];
  let offset = 0;
  let longName = null;
  while (offset + 512 <= file.size) {
    const header = new Uint8Array(await file.slice(offset, offset + 512).arrayBuffer());
    if (header.every((b) => b === 0)) break;
    const size = number(header, 124, 136);
    const type = String.fromCharCode(header[156] || 48);
    const prefix = text(header, 345, 500);
    let name = (prefix ? `${prefix}/` : '') + text(header, 0, 100);
    const data = offset + 512;
    if (type === 'L') {
      // GNU long name: the data is the next entry's name.
      longName = text(new Uint8Array(await file.slice(data, data + size).arrayBuffer()), 0, size);
    } else if (type === 'x') {
      // POSIX extended header: "<length> path=<name>\n".
      const m = /\d+ path=([^\n]*)\n/.exec(decoder.decode(await file.slice(data, data + size).arrayBuffer()));
      if (m) longName = m[1];
    } else if (type !== 'g') {
      if (longName) {
        name = longName;
        longName = null;
      }
      if (type === '0' || type === '7') entries.push({ name: name.replace(/^\.\//, ''), size, offset: data });
    }
    offset = data + Math.ceil(size / 512) * 512;
  }
  return entries;
}

// One entry's bytes.
export async function readTarEntry(file, entry) {
  return new Uint8Array(await file.slice(entry.offset, entry.offset + entry.size).arrayBuffer());
}

// A minimal tar of { name: Uint8Array } (for tests).
export function makeTar(files) {
  const chunks = [];
  const enc = new TextEncoder();
  const put = (bytes, at, s) => bytes.set(enc.encode(s), at);
  for (const [name, data] of Object.entries(files)) {
    const header = new Uint8Array(512);
    put(header, 0, name.slice(0, 100));
    put(header, 100, '0000644\0');
    put(header, 124, `${data.length.toString(8).padStart(11, '0')}\0`);
    put(header, 148, '        ');
    header[156] = 48;
    put(header, 257, 'ustar\0');
    let sum = 0;
    for (const b of header) sum += b;
    put(header, 148, `${sum.toString(8).padStart(6, '0')}\0 `);
    chunks.push(header, data, new Uint8Array((512 - (data.length % 512)) % 512));
  }
  chunks.push(new Uint8Array(1024));
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}
