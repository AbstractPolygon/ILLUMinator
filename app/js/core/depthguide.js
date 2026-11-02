// Lytro Desktop's depth edges with our depth values.
//
// Lytro Desktop's depth map is flat inside regions and steps at the objects' edges (95 .. 99 % of neighbouring pixels share a value). Ours is measured, so its values can be
// closer to the scene (a dark panel Lytro puts at the back wall) but its edges are softer. This takes Lytro's regions (4-connected pixels whose depth differs by less than `tol`)
// and gives each the median of OUR depth inside it: Lytro's edges, our depth. Regions under `minSize` pixels keep our value.
export function guideDepthEdges(ours, guide, W, H, { tol = 0.02, minSize = 12 } = {}) {
  const n = W * H;
  const out = Float32Array.from(ours);
  const label = new Int32Array(n).fill(-1);
  const stack = new Int32Array(n);
  let count = 0;
  for (let start = 0; start < n; start++) {
    if (label[start] >= 0 || !Number.isFinite(guide[start])) continue;
    const id = count++;
    let top = 0;
    let size = 0;
    stack[top++] = start;
    label[start] = id;
    const members = [];
    while (top) {
      const p = stack[--top];
      members.push(p);
      size++;
      const x = p % W;
      const y = (p / W) | 0;
      const g = guide[p];
      if (x > 0) { const q = p - 1; if (label[q] < 0 && Math.abs(guide[q] - g) < tol) { label[q] = id; stack[top++] = q; } }
      if (x < W - 1) { const q = p + 1; if (label[q] < 0 && Math.abs(guide[q] - g) < tol) { label[q] = id; stack[top++] = q; } }
      if (y > 0) { const q = p - W; if (label[q] < 0 && Math.abs(guide[q] - g) < tol) { label[q] = id; stack[top++] = q; } }
      if (y < H - 1) { const q = p + W; if (label[q] < 0 && Math.abs(guide[q] - g) < tol) { label[q] = id; stack[top++] = q; } }
    }
    if (size < minSize) continue;
    // the median of our depth over the region (a regular sample of very large regions)
    const step = size > 20000 ? Math.ceil(size / 20000) : 1;
    const vals = [];
    for (let k = 0; k < members.length; k += step) { const v = ours[members[k]]; if (Number.isFinite(v)) vals.push(v); }
    if (!vals.length) continue;
    vals.sort((a, b) => a - b);
    const med = vals[vals.length >> 1];
    for (const p of members) out[p] = med;
  }
  return out;
}
