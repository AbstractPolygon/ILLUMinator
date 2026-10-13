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
// sha1 reference. Version 1 files use the "picture.frameArray" layout,
// version 2 files (ILLUM) use "frames" and "views" and put the LFM at the end.

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

// --- processed pictures ---
//
// Processed LFP files (exported from Lytro Desktop or shared online) carry
// pre-rendered images instead of, or next to, the raw sensor data:
//   focus        refocus stack: one image per focus depth (lambda)
//   perspective  one image per viewpoint (u, v)
//   warp         all-in-focus image(s) plus a depth map ("edofWarp"); the
//                player shifts pixels by depth to change viewpoint
//   single       one picture, sometimes with a depth map
// Depth maps hold lambda (focus depth) values.
//
// Second generation files (ILLUM, picture schema 2.x) list these under
// views[].accelerations[] with a "kind"; images are perImage[] entries with
// { imageRef, focus } or { imageRef, perspective: { u, v } }, or a
// blockOfImagesRef holding all of them as H.264. Frame accelerations can
// hold an uncropped depth map. First generation files use
// picture.accelerationArray[] with "type" and vendorContent.imageArray[]
// entries with { imageRef, lambda } and a float depthLut.

const KINDS = {
  focusStack: 'focus',
  edofPerspective: 'perspective',
  edofWarp: 'warp',
  edofWarpPreAdjust: 'warp',
  singleImage: 'single',
  uncropped: 'single',
};

function depthDescriptor(d, extra = {}) {
  if (!d || typeof d.imageRef !== 'string') return null;
  return {
    ref: d.imageRef,
    representation: d.representation || extra.representation || 'packedFloat',
    width: d.width ?? extra.width,
    height: d.height ?? extra.height,
    minLambda: d.minLambda ?? extra.minLambda,
    maxLambda: d.maxLambda ?? extra.maxLambda,
    mapToImage: d.mapToImage || extra.mapToImage || null,
  };
}

function imageEntry(img) {
  const p = img.perspective;
  return {
    ref: img.imageRef,
    lambda: typeof img.focus === 'number' ? img.focus : typeof img.lambda === 'number' ? img.lambda : undefined,
    coord: p && typeof p.u === 'number' ? { x: p.u, y: p.v }
      : img.coord && typeof img.coord.x === 'number' ? { x: img.coord.x, y: img.coord.y } : undefined,
  };
}

function v2Stacks(toc) {
  const stacks = [];
  for (const view of asArray(toc.views)) {
    for (const acc of asArray(view && view.accelerations)) {
      const kind = acc && KINDS[acc.kind];
      if (!kind) continue;
      const stack = {
        kind,
        source: acc.kind,
        width: acc.width,
        height: acc.height,
        pitchRatio: acc.pitchRatio || null,
        representation: acc.representation,
        images: [],
        depth: depthDescriptor(acc.depthMap),
      };
      if (typeof acc.imageRef === 'string') stack.images.push({ ref: acc.imageRef });
      const perImage = asArray(acc.perImage).concat(...asArray(acc.perFrame).map((f) => {
        if (!stack.depth && f.depthMap) stack.depth = depthDescriptor(f.depthMap);
        if (f.representation) stack.representation = f.representation;
        return asArray(f.perImage);
      }));
      if (typeof acc.blockOfImagesRef === 'string') {
        stack.blockRef = acc.blockOfImagesRef;
        stack.images = perImage.map(imageEntry);
      } else {
        for (const img of perImage) if (img && typeof img.imageRef === 'string') stack.images.push(imageEntry(img));
      }
      if (stack.images.length) stacks.push(stack);
    }
  }
  return stacks;
}

// Uncropped depth map stored with the raw frame (second generation).
export function findFrameDepth(toc) {
  for (const f of asArray(toc.frames)) {
    for (const acc of asArray(f && f.accelerations)) {
      if (acc && acc.kind === 'depthMap') {
        const d = depthDescriptor(acc.depthMap, acc);
        if (d) return { ...d, frame: true };
      }
    }
  }
  return null;
}

// First generation: walk the acceleration tree for image arrays.
function v1Stacks(toc, container) {
  const stacks = new Map();
  const thumbs = new Set(findThumbnailRefs(toc).map((t) => t.ref));
  let depth = null;
  const walk = (node, type) => {
    if (Array.isArray(node)) {
      node.forEach((n) => walk(n, type));
      return;
    }
    if (!node || typeof node !== 'object') return;
    const t = typeof node.type === 'string' ? node.type : type;
    if (typeof node.imageRef === 'string' && !thumbs.has(node.imageRef) && container.bySha.has(node.imageRef)) {
      if (!stacks.has(t)) stacks.set(t, []);
      stacks.get(t).push(imageEntry(node));
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'depthLut' || key === 'depthMap') {
        depth = depth || depthDescriptor(value, { representation: 'packedFloat' });
        continue;
      }
      if (key === 'imageRef' || key === 'frame' || key === 'thumbnails' || key === 'thumbnailArray' || key === 'confidenceMap') continue;
      walk(value, t);
    }
  };
  walk(toc.picture && toc.picture.accelerationArray, undefined);
  walk(toc.accelerations || [], undefined);
  walk(toc.viewArray || [], undefined);
  return [...stacks].map(([type, images]) => {
    const kind = images.some((i) => i.lambda !== undefined) ? 'focus'
      : images.some((i) => i.coord) ? 'perspective' : 'single';
    return { kind, source: type || 'images', images, depth: kind === 'focus' || kind === 'single' ? depth : null };
  });
}

export function findImageStacks(toc, container) {
  return Array.isArray(toc.views) ? v2Stacks(toc) : v1Stacks(toc, container);
}

// Reads the LFP and returns everything the decoder needs. The raw sensor
// data stays unread (lazy); processed images and depth maps are loaded.
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
  const compressed = asArray(toc.frames).some((f) => asArray(f && f.accelerations).some((a) => a && a.kind === 'compressed'));
  const thumbnails = findThumbnailRefs(toc);
  const loadDepth = async (d) => {
    if (!d) return null;
    const bytes = await container.readSection(d.ref);
    return bytes ? { ...d, bytes, mime: sniffMime(bytes) } : null;
  };
  const stacks = [];
  for (const stack of findImageStacks(toc, container)) {
    const loaded = { ...stack, depth: await loadDepth(stack.depth) };
    if (stack.blockRef) {
      loaded.block = await container.readSection(stack.blockRef);
      if (!loaded.block) continue;
    } else {
      loaded.images = [];
      for (const img of stack.images) {
        const bytes = await container.readSection(img.ref);
        const mime = bytes && sniffMime(bytes);
        if (mime) loaded.images.push({ ...img, mime, bytes });
      }
      if (!loaded.images.length) continue;
    }
    stacks.push(loaded);
  }
  const frameDepth = await loadDepth(findFrameDepth(toc));
  return { container, toc, frame, metadata, privateMetadata, rawRef, thumbnails, stacks, frameDepth, compressed };
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
