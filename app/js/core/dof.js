// Synthetic depth of field: blur each pixel in proportion to how far its
// depth is from the focus depth. This can narrow the depth of field beyond
// what the camera's small aperture records. A stack of increasingly blurred
// copies is built once and each pixel interpolates between the two levels
// around its blur radius.

// Separable box blur of radius r (in place via a scratch buffer), RGB.
function boxBlur(src, w, h, r) {
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  const n = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    for (let c = 0; c < 3; c++) {
      let acc = 0;
      for (let k = -r; k <= r; k++) acc += src[(y * w + Math.min(w - 1, Math.max(0, k))) * 3 + c];
      for (let x = 0; x < w; x++) {
        tmp[(y * w + x) * 3 + c] = acc / n;
        const add = Math.min(w - 1, x + r + 1);
        const sub = Math.max(0, x - r);
        acc += src[(y * w + add) * 3 + c] - src[(y * w + sub) * 3 + c];
      }
    }
  }
  for (let x = 0; x < w; x++) {
    for (let c = 0; c < 3; c++) {
      let acc = 0;
      for (let k = -r; k <= r; k++) acc += tmp[(Math.min(h - 1, Math.max(0, k)) * w + x) * 3 + c];
      for (let y = 0; y < h; y++) {
        out[(y * w + x) * 3 + c] = acc / n;
        const add = Math.min(h - 1, y + r + 1);
        const sub = Math.max(0, y - r);
        acc += tmp[(add * w + x) * 3 + c] - tmp[(sub * w + x) * 3 + c];
      }
    }
  }
  return out;
}

// Two box passes approximate a Gaussian.
function blur(src, w, h, r) {
  return r < 1 ? src : boxBlur(boxBlur(src, w, h, r), w, h, r);
}

// rgb: linear RGB (w x h). depth: per-pixel focus values (dw x dh, may be a
// lower resolution than rgb). focus: the focus value kept sharp.
// strength: 0 (off) .. 1. Blur radius in pixels of `rgb` is
// strength * |depth - focus| * pxPerUnit.
export function applyDepthOfField(rgb, w, h, depth, dw, dh, focus, strength, pxPerUnit = 14) {
  if (!(strength > 0)) return rgb;
  const maxR = Math.max(1, strength * 1.5 * pxPerUnit);
  const radii = [0];
  for (let r = 1; r < maxR * 2; r *= 2) radii.push(r);
  const levels = radii.map((r) => blur(rgb, w, h, r));
  const out = new Float32Array(rgb.length);
  const sx = dw / w;
  const sy = dh / h;
  for (let y = 0; y < h; y++) {
    const dy = Math.min(dh - 1, Math.floor((y + 0.5) * sy));
    for (let x = 0; x < w; x++) {
      const d = depth[dy * dw + Math.min(dw - 1, Math.floor((x + 0.5) * sx))];
      const r = strength * Math.abs(d - focus) * pxPerUnit;
      let k = 0;
      while (k < radii.length - 2 && radii[k + 1] < r) k++;
      const t = Math.max(0, Math.min(1, (r - radii[k]) / (radii[k + 1] - radii[k] || 1)));
      const p = (y * w + x) * 3;
      for (let c = 0; c < 3; c++) out[p + c] = levels[k][p + c] * (1 - t) + levels[k + 1][p + c] * t;
    }
  }
  return out;
}
