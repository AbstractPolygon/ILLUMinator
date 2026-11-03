// The processed version of a photo, kept next to the original in the desktop app's library (processed.illuminator.bin), so reopening it does not
// measure everything again: the depth the engine's way (rendering its depth views and solving them is the slowest step of opening a raw photo)
// and the focus offset found for the photo. Like Lytro Desktop's stack.lfp next to its raw.lfp, but in Illuminator's own format.
//
// Layout: 'ILPC', uint32 format version, uint32 header length, the header (JSON, UTF-8, padded to 4 bytes), then the depth as float32.
// The header's `key` says what the depth was measured with (this app's version, the photo, the settings that change it); a cache whose key
// differs from the photo's current one is not used, and is written again after the new measurement.

export const PROCESSED_FILE = 'processed.illuminator.bin';
const MAGIC = 0x434c5049; // 'ILPC' read as a little endian uint32
const FORMAT = 1;

// { key, w, h, alpha: Float32Array, focusOffset?: number, open?: object } -> Uint8Array
// `open` (any JSON) is what opening the photo works out and would otherwise work out again (the engine's colour units and white balance, with its own key);
// w and h are 0 and alpha empty while the depth has not been measured yet.
export function encodeProcessed({ key, w, h, alpha, focusOffset, open }) {
  const header = new TextEncoder().encode(JSON.stringify({ key, w, h, focusOffset: Number.isFinite(focusOffset) ? focusOffset : null, open: open || null }));
  const padded = Math.ceil(header.length / 4) * 4;
  const out = new Uint8Array(12 + padded + alpha.length * 4);
  const view = new DataView(out.buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint32(4, FORMAT, true);
  view.setUint32(8, header.length, true);
  out.set(header, 12);
  out.set(new Uint8Array(alpha.buffer, alpha.byteOffset, alpha.length * 4), 12 + padded);
  return out;
}

// ArrayBuffer -> { key, w, h, alpha, focusOffset } or null when it is not a usable cache.
export function decodeProcessed(buffer) {
  try {
    if (!buffer || buffer.byteLength < 12) return null;
    const view = new DataView(buffer);
    if (view.getUint32(0, true) !== MAGIC || view.getUint32(4, true) !== FORMAT) return null;
    const length = view.getUint32(8, true);
    const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 12, length)));
    const at = 12 + Math.ceil(length / 4) * 4;
    const n = header.w * header.h;
    if (!(n >= 0) || (n === 0 && !header.open) || buffer.byteLength < at + n * 4) return null;
    return { key: header.key, w: header.w, h: header.h, focusOffset: Number.isFinite(header.focusOffset) ? header.focusOffset : undefined, open: header.open || undefined, alpha: new Float32Array(buffer.slice(at, at + n * 4)) };
  } catch {
    return null;
  }
}
