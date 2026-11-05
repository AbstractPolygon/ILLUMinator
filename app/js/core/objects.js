// Object identification: turns the masks a segmentation model finds in the
// photo (MobileSAM) into one object label per pixel. Depth uses it to put
// steps on the objects' outlines (core/segments.js).

// Whether two pixels lie in different objects: 0 or 1.
export function signatureDistance(a, b) {
  return a === b ? 0 : 1;
}

// `masks`: [{ bin: Uint8Array (w * h, 1 inside), area, quality }]. Keeps up to
// 32 clearly different, reliable objects (not specks, not the whole picture).
export function pickObjects(masks, w, h, opts = {}) {
  const n = w * h;
  return chooseDistinct(objectCandidates(masks, n, opts), (m, c) => {
    let inter = 0;
    for (let i = 0; i < n; i++) inter += m.bin[i] & c.bin[i];
    return inter;
  }, opts);
}

// The reliable masks of a sensible size, best first.
export function objectCandidates(masks, n, { quality = 0.85, minArea = 0.01, maxArea = 0.6 } = {}) {
  return masks.filter((m) => m.quality >= quality && m.area >= minArea * n && m.area <= maxArea * n).sort((a, b) => b.quality * Math.sqrt(b.area) - a.quality * Math.sqrt(a.area));
}

// Greedy: a candidate is kept unless it overlaps one already kept by more than `overlap` (intersection over union). `intersect(m, c)`: how many
// pixels two masks share (counted here, or on the graphics card for all pairs at once, see gpu/regions.js).
export function chooseDistinct(candidates, intersect, { overlap = 0.85, limit = 32 } = {}) {
  const chosen = [];
  for (const m of candidates) {
    if (chosen.length >= limit) break;
    let same = false;
    for (const c of chosen) {
      const inter = intersect(m, c);
      if (inter / (m.area + c.area - inter) > overlap) {
        same = true;
        break;
      }
    }
    if (!same) chosen.push(m);
  }
  return chosen;
}

// The masks in the order they are painted: largest first, so the smallest mask covering a pixel has the last word.
export function paintOrder(chosen) {
  return [...chosen].sort((a, b) => b.area - a.area);
}

// A label picture (sw x sh) as nearest-neighbour samples at the size of the depth map.
export function upsampleLabels(small, sw, sh, outW, outH) {
  const labels = new Uint32Array(outW * outH);
  for (let y = 0; y < outH; y++) {
    const sy = Math.min(sh - 1, Math.floor(((y + 0.5) * sh) / outH));
    for (let x = 0; x < outW; x++) labels[y * outW + x] = small[sy * sw + Math.min(sw - 1, Math.floor(((x + 0.5) * sw) / outW))];
  }
  return labels;
}

// One object label per pixel (0: none): each pixel belongs to the smallest
// chosen mask that contains it, then specks and ragged borders are cleaned up
// by a majority vote over each pixel's neighbourhood.
export function signatures(chosen, w, h, { radius = 3, passes = 3 } = {}) {
  const n = w * h;
  let label = new Uint32Array(n);
  paintOrder(chosen).forEach((m, k) => {
    for (let i = 0; i < n; i++) if (m.bin[i]) label[i] = k + 1;
  });
  for (let pass = 0; pass < passes; pass++) {
    const next = new Uint32Array(n);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const votes = new Map();
        let best = label[y * w + x];
        let bestCount = 0;
        for (let dy = -radius; dy <= radius; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -radius; dx <= radius; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            const l = label[yy * w + xx];
            const c = (votes.get(l) || 0) + 1;
            votes.set(l, c);
            if (c > bestCount) {
              bestCount = c;
              best = l;
            }
          }
        }
        next[y * w + x] = best;
      }
    }
    label = next;
  }
  return label;
}
