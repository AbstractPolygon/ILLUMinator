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

// { key, w, h, alpha: Float32Array, focusOffset?: number, open?: object, extra?: [{ key, w, h, alpha, confidence, range, flat }] } -> Uint8Array
// `open` (any JSON) is what opening the photo works out and would otherwise work out again (the engine's colour units and white balance, with its own key);
// w and h are 0 and alpha empty while the depth has not been measured yet. `extra` are the depths of other depth methods (each with the key it was measured with),
// stored after the main depth as float32 (alpha, then confidence); an older reader skips them.
export function encodeProcessed({ key, w, h, alpha, focusOffset, open, extra = [] }) {
  const entries = extra.filter((e) => e.alpha && e.alpha.length === e.w * e.h && e.confidence && e.confidence.length === e.alpha.length);
  const header = new TextEncoder().encode(JSON.stringify({
    key, w, h, focusOffset: Number.isFinite(focusOffset) ? focusOffset : null, open: open || null,
    extra: entries.map((e) => ({ key: e.key, w: e.w, h: e.h, range: e.range || null, flat: !!e.flat })),
  }));
  const padded = Math.ceil(header.length / 4) * 4;
  const out = new Uint8Array(12 + padded + (alpha.length + entries.reduce((n, e) => n + 2 * e.alpha.length, 0)) * 4);
  const view = new DataView(out.buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint32(4, FORMAT, true);
  view.setUint32(8, header.length, true);
  out.set(header, 12);
  let at = 12 + padded;
  const put = (a) => {
    out.set(new Uint8Array(a.buffer, a.byteOffset, a.length * 4), at);
    at += a.length * 4;
  };
  put(alpha);
  for (const e of entries) {
    put(e.alpha);
    put(e.confidence);
  }
  return out;
}

// ArrayBuffer -> { key, w, h, alpha, focusOffset, open, extra } or null when it is not a usable cache.
export function decodeProcessed(buffer) {
  try {
    if (!buffer || buffer.byteLength < 12) return null;
    const view = new DataView(buffer);
    if (view.getUint32(0, true) !== MAGIC || view.getUint32(4, true) !== FORMAT) return null;
    const length = view.getUint32(8, true);
    const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 12, length)));
    let at = 12 + Math.ceil(length / 4) * 4;
    const n = header.w * header.h;
    const listed = Array.isArray(header.extra) ? header.extra : [];
    if (!(n >= 0) || (n === 0 && !header.open && !listed.length) || buffer.byteLength < at + n * 4) return null;
    const alpha = new Float32Array(buffer.slice(at, at + n * 4));
    at += n * 4;
    const extra = [];
    for (const e of listed) {
      const m = e.w * e.h;
      if (!(m > 0) || buffer.byteLength < at + 2 * m * 4) break;
      extra.push({ key: e.key, w: e.w, h: e.h, range: e.range || undefined, flat: !!e.flat, alpha: new Float32Array(buffer.slice(at, at + m * 4)), confidence: new Float32Array(buffer.slice(at + m * 4, at + 2 * m * 4)) });
      at += 2 * m * 4;
    }
    return { key: header.key, w: header.w, h: header.h, focusOffset: Number.isFinite(header.focusOffset) ? header.focusOffset : undefined, open: header.open || undefined, alpha, extra };
  } catch {
    return null;
  }
}
