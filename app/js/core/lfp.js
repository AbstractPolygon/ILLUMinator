// Lytro LFP / LFR container format.
//
// A file starts with a 16 byte header ("\x89LFP\r\n\x1a\n" + version + length)
// followed by sections. Each section is:
//   12 byte magic: "\x89LFM..." (table of contents) or "\x89LFC..." (content)
//    4 byte big-endian data length
//   80 byte field holding "sha1-<40 hex>" padded with NULs
//    n bytes of data, then zero padding up to a 16 byte boundary
//
// The table of contents (LFM) is JSON. It points at content sections by their
// sha1 reference. First generation cameras use the "picture.frameArray" layout,
// the ILLUM uses "frames" and puts the LFM at the end of the file.

const FILE_MAGIC = [0x89, 0x4c, 0x46, 0x50, 0x0d, 0x0a, 0x1a, 0x0a];
const SECTION_TAIL = [0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00];
const HEADER_SIZE = 16;
const SHA_FIELD_SIZE = 80;
const SECTION_HEADER_SIZE = HEADER_SIZE + SHA_FIELD_SIZE;
const JSON_SNIFF_LIMIT = 4 * 1024 * 1024;

const textDecoder = new TextDecoder('utf-8');
const textEncoder = new TextEncoder();

export class LfpError extends Error {}

// A reader gives random access to a file: { size, read(offset, length) -> Promise<Uint8Array> }.
export function bufferReader(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  return {
    size: bytes.length,
    read: async (offset, length) => bytes.subarray(offset, Math.min(bytes.length, offset + length)),
  };
}

export function blobReader(blob) {
  return {
    size: blob.size,
    read: async (offset, length) => new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer()),
  };
}

export function isLfp(bytes) {
  if (bytes.length < FILE_MAGIC.length) return false;
  return FILE_MAGIC.every((b, i) => bytes[i] === b);
}

function readU32BE(bytes, offset) {
  return ((bytes[offset] << 24) >>> 0) + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3];
}

function sectionType(bytes) {
  if (bytes[0] !== 0x89 || bytes[1] !== 0x4c || bytes[2] !== 0x46) return null;
  for (let i = 0; i < SECTION_TAIL.length; i++) {
    if (bytes[4 + i] !== SECTION_TAIL[i]) return null;
  }
  const t = String.fromCharCode(bytes[3]);
  return t === 'M' ? 'LFM' : t === 'C' ? 'LFC' : null;
}

// Walks the section headers without reading section data.
// Returns [{ type, sha1, offset, length }] where offset points at the data.
export async function indexSections(reader) {
  const head = await reader.read(0, HEADER_SIZE);
  if (!isLfp(head)) throw new LfpError('Not a Lytro LFP/LFR file');
  const sections = [];
  let pos = HEADER_SIZE;
  while (pos + SECTION_HEADER_SIZE <= reader.size) {
    let header = await reader.read(pos, SECTION_HEADER_SIZE);
    let type = sectionType(header);
    if (!type) {
      // Tolerate padding that is not 16 byte aligned: skip zero bytes.
      const probe = await reader.read(pos, 64);
      let skip = 0;
      while (skip < probe.length && probe[skip] === 0) skip++;
      if (skip === 0 || skip === probe.length) break;
      pos += skip;
      continue;
    }
    const length = readU32BE(header, 12);
    let sha1 = '';
    for (let i = HEADER_SIZE; i < SECTION_HEADER_SIZE && header[i] !== 0; i++) sha1 += String.fromCharCode(header[i]);
    const offset = pos + SECTION_HEADER_SIZE;
    if (offset + length > reader.size) throw new LfpError(`Truncated section ${sha1 || type}`);
    sections.push({ type, sha1, offset, length });
    pos = offset + length;
    pos = Math.ceil(pos / 16) * 16;
  }
  if (!sections.length) throw new LfpError('LFP file contains no sections');
  return sections;
}

export function sniffMime(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png';
  return null;
}

function tryParseJson(bytes) {
  let i = 0;
  while (i < bytes.length && (bytes[i] === 0x20 || bytes[i] === 0x0a || bytes[i] === 0x0d || bytes[i] === 0x09)) i++;
  if (bytes[i] !== 0x7b) return undefined;
  try {
    return JSON.parse(textDecoder.decode(bytes));
  } catch {
    return undefined;
  }
}

// Reads every section header and parses all small JSON sections.
// The large raw sensor section is only read on demand through `readSection`.
export async function openContainer(reader) {
  const sections = await indexSections(reader);
  const bySha = new Map();
  const json = new Map();
  let toc = null;
  for (const s of sections) {
    if (s.sha1) bySha.set(s.sha1, s);
    if (s.length > JSON_SNIFF_LIMIT) continue;
    const first = await reader.read(s.offset, Math.min(s.length, 16));
    if (!first.some((b) => b === 0x7b)) continue;
    const parsed = tryParseJson(await reader.read(s.offset, s.length));
    if (parsed === undefined) continue;
    s.json = parsed;
    if (s.sha1) json.set(s.sha1, parsed);
    if (s.type === 'LFM' && !toc) toc = parsed;
  }
  if (!toc) throw new LfpError('LFP file has no table of contents');

  const readSection = async (ref) => {
    const s = bySha.get(ref);
    return s ? reader.read(s.offset, s.length) : null;
  };

  return { reader, sections, toc, bySha, json, readSection };
}

function asArray(v) {
  return Array.isArray(v) ? v : [];
}

// Picks the light field frame description from either TOC layout.
export function findFrame(toc) {
  const v2 = asArray(toc.frames)[0];
  if (v2 && v2.frame) return v2.frame;
  const v1 = asArray(toc.picture && toc.picture.frameArray)[0];
  if (v1 && v1.frame) return v1.frame;
  return null;
}

export function findThumbnailRefs(toc) {
  const list = asArray(toc.thumbnails).concat(asArray(toc.thumbnailArray));
  return list.filter((t) => t && t.imageRef).map((t) => ({
    ref: t.imageRef,
    width: t.width,
    height: t.height,
    representation: t.representation,
  }));
}

// Processed LFP files (exported from Lytro Desktop or the web viewer) carry
// pre-rendered JPEG stacks: refocus stacks with a "lambda" per image and
// perspective stacks with a coordinate per image. They live in different
// places depending on the schema version, so walk the whole TOC.
export function findImageStacks(toc, container) {
  const stacks = new Map();
  const thumbs = new Set(findThumbnailRefs(toc).map((t) => t.ref));
  const walk = (node, kind) => {
    if (Array.isArray(node)) {
      node.forEach((n) => walk(n, kind));
      return;
    }
    if (!node || typeof node !== 'object') return;
    const k = node.kind || node.type || kind;
    if (typeof node.imageRef === 'string' && !thumbs.has(node.imageRef) && container.bySha.has(node.imageRef)) {
      const name = typeof k === 'string' ? k : 'images';
      if (!stacks.has(name)) stacks.set(name, []);
      stacks.get(name).push({
        ref: node.imageRef,
        lambda: typeof node.lambda === 'number' ? node.lambda : undefined,
        coord: node.coord && typeof node.coord.x === 'number' ? { x: node.coord.x, y: node.coord.y } : undefined,
        width: node.width,
        height: node.height,
        representation: node.representation,
      });
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'imageRef' || key === 'frame' || key === 'thumbnails' || key === 'thumbnailArray') continue;
      walk(value, k);
    }
  };
  walk(toc.views || toc.viewArray || [], undefined);
  walk(toc.accelerations || [], undefined);
  walk(toc.picture && toc.picture.accelerationArray, undefined);
  walk(asArray(toc.frames).map((f) => f.accelerations), undefined);
  return stacks;
}

// Reads the LFP and returns everything the decoder needs. Image data stays
// unread (lazy) except for small JPEG/PNG stacks which are loaded eagerly.
export async function readLightFieldPicture(reader) {
  const container = await openContainer(reader);
  const { toc, json } = container;
  const frame = findFrame(toc);
  let metadata = null;
  let privateMetadata = null;
  let rawRef = null;
  if (frame) {
    metadata = json.get(frame.metadataRef) || frame.metadata || null;
    privateMetadata = json.get(frame.privateMetadataRef) || frame.privateMetadata || null;
    rawRef = frame.imageRef || null;
  }
  const thumbnails = findThumbnailRefs(toc);
  const stacks = [];
  for (const [kind, images] of findImageStacks(toc, container)) {
    const loaded = [];
    for (const img of images) {
      const bytes = await container.readSection(img.ref);
      const mime = bytes && sniffMime(bytes);
      if (mime) loaded.push({ ...img, mime, bytes });
    }
    if (loaded.length) stacks.push({ kind, images: loaded });
  }
  return { container, toc, frame, metadata, privateMetadata, rawRef, thumbnails, stacks };
}

// Returns { mime, bytes } for the first decodable thumbnail, or null.
// Only the thumbnail section is read, so this is cheap even over USB.
export async function readThumbnail(reader) {
  const container = await openContainer(reader);
  for (const t of findThumbnailRefs(container.toc)) {
    const bytes = await container.readSection(t.ref);
    if (!bytes) continue;
    const mime = sniffMime(bytes);
    if (mime) return { mime, bytes, width: t.width, height: t.height };
  }
  return null;
}

// --- writing (used by the synthetic sample generator and tests) ---

async function sha1Hex(bytes) {
  const digest = await globalThis.crypto.subtle.digest('SHA-1', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

export function encodeJson(obj) {
  return textEncoder.encode(JSON.stringify(obj, null, 2));
}

// sections: [{ type: 'LFM' | 'LFC', data: Uint8Array }] -> { bytes, refs }
export async function writeContainer(sections) {
  const refs = [];
  let total = HEADER_SIZE;
  for (const s of sections) {
    refs.push('sha1-' + (await sha1Hex(s.data)));
    total += SECTION_HEADER_SIZE + Math.ceil(s.data.length / 16) * 16;
  }
  const out = new Uint8Array(total);
  out.set(FILE_MAGIC, 0);
  out.set([0, 0, 0, 1], 8);
  let pos = HEADER_SIZE;
  sections.forEach((s, i) => {
    out.set([0x89, 0x4c, 0x46, (s.type === 'LFM' ? 'M' : 'C').charCodeAt(0)], pos);
    out.set(SECTION_TAIL, pos + 4);
    const len = s.data.length;
    out.set([(len >>> 24) & 255, (len >>> 16) & 255, (len >>> 8) & 255, len & 255], pos + 12);
    out.set(textEncoder.encode(refs[i]), pos + HEADER_SIZE);
    out.set(s.data, pos + SECTION_HEADER_SIZE);
    pos += SECTION_HEADER_SIZE + Math.ceil(len / 16) * 16;
  });
  return { bytes: out, refs };
}

// Content sha1 references are needed inside the TOC before writing, so
// compute them up front.
export async function refFor(bytes) {
  return 'sha1-' + (await sha1Hex(bytes));
}
