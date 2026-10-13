// Synthetic depth of field: blur each pixel in proportion to how far its
// depth is from the focus depth. This can narrow the depth of field beyond
// what the camera's small aperture records. A stack of increasingly blurred
// copies is built once and each pixel interpolates between the two levels
// around its blur radius.
//
// The blur's shape is the bokeh: 'smooth' (Gaussian), 'circle' or 'hexagon'
// (like a six-blade aperture). Shaped kernels are summed row by row from
// running sums, so a radius-r blur costs about 2r operations per pixel.

// Half width of the kernel's row at vertical offset dy, for radius r.
function halfWidth(shape, r, dy) {
  const a = Math.abs(dy);
  if (a > r) return -1;
  if (shape === 'hexagon') {
    // Pointy top and bottom: full width in the middle half, tapering above
    // and below.
    const full = (Math.sqrt(3) / 2) * r;
    return a <= r / 2 ? full : full * ((r - a) / (r / 2));
  }
  return Math.sqrt(r * r - dy * dy);
}

// Shaped blur: the average over the kernel, built from per-row prefix sums.
function shapedBlur(src, w, h, r, shape) {
  const out = new Float32Array(src.length);
  const prefix = new Float64Array((w + 1) * h * 3);
  for (let y = 0; y < h; y++) {
    for (let c = 0; c < 3; c++) {
      let acc = 0;
      const base = (y * (w + 1)) * 3 + c;
      prefix[base] = 0;
      for (let x = 0; x < w; x++) {
        acc += src[(y * w + x) * 3 + c];
        prefix[base + (x + 1) * 3] = acc;
      }
    }
  }
  const rows = [];
  for (let dy = -Math.ceil(r); dy <= Math.ceil(r); dy++) {
    const hw = halfWidth(shape, r, dy);
    if (hw >= 0) rows.push([dy, Math.floor(hw + 0.5)]);
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s0 = 0;
      let s1 = 0;
      let s2 = 0;
      let n = 0;
      for (const [dy, hw] of rows) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        const x0 = Math.max(0, x - hw);
        const x1 = Math.min(w, x + hw + 1);
        const a = (yy * (w + 1) + x0) * 3;
        const b = (yy * (w + 1) + x1) * 3;
        s0 += prefix[b] - prefix[a];
        s1 += prefix[b + 1] - prefix[a + 1];
        s2 += prefix[b + 2] - prefix[a + 2];
        n += x1 - x0;
      }
      const o = (y * w + x) * 3;
      out[o] = s0 / n;
      out[o + 1] = s1 / n;
      out[o + 2] = s2 / n;
    }
  }
  return out;
}

// Separable box blur of radius r, RGB.
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

function blur(src, w, h, r, shape) {
  if (r < 1) return src;
  if (shape === 'circle' || shape === 'hexagon') return shapedBlur(src, w, h, r, shape);
  // Two box passes approximate a Gaussian.
  return boxBlur(boxBlur(src, w, h, Math.round(r)), w, h, Math.round(r));
}

// Clipped highlights hold far more light than the picture can store; give
// them back some of it before blurring so they spread into bright bokeh
// balls instead of dull smudges. `amount` 0..1 (up to 128x).
function boostHighlights(rgb, clip, amount) {
  if (!(amount > 0)) return rgb;
  const out = new Float32Array(rgb.length);
  const knee = 0.8 * clip;
  for (let i = 0; i < rgb.length; i += 3) {
    const y = 0.2126 * rgb[i] + 0.7152 * rgb[i + 1] + 0.0722 * rgb[i + 2];
    const t = Math.max(0, Math.min(1, (y - knee) / (clip - knee)));
    const k = 1 + (2 ** (7 * amount) - 1) * t * t;
    out[i] = rgb[i] * k;
    out[i + 1] = rgb[i + 1] * k;
    out[i + 2] = rgb[i + 2] * k;
  }
  return out;
}

// rgb: linear RGB (w x h). depth: per-pixel focus values (dw x dh, may be a
// lower resolution than rgb). focus: the focus value kept sharp.
// strength: blur radius in pixels of `rgb` is strength * |depth - focus| *
// pxPerUnit. Options: shape ('smooth' | 'circle' | 'hexagon'),
// highlights (0..1), clip (the developed level where highlights clip), and
// the focus field: spread (depth kept sharp on each side of the focus),
// smooth (width of the soft edge where blur starts after the spread),
// tilt ([x, y] focus change across the picture) turning around point
// Focus distance past the sharp range -> amount of blur. With `smooth` the
// blur starts gradually (a quadratic ease over that width) instead of at
// once; the sharp range itself stays sharp.
export function softEdge(excess, smooth) {
  if (!(excess > 0)) return 0;
  if (!(smooth > 0)) return excess;
  return excess < smooth ? (excess * excess) / (2 * smooth) : excess - smooth / 2;
}

// ([x, y], normalized).
export function applyDepthOfField(rgb, w, h, depth, dw, dh, focus, strength, pxPerUnit = 14, options = {}) {
  if (!(strength > 0)) return rgb;
  const { shape = 'smooth', highlights = 0, clip = 1, spread = 0, smooth = 0, tilt = [0, 0], point = [0.5, 0.5] } = options;
  const src = boostHighlights(rgb, clip, highlights);
  const maxR = Math.max(1, strength * 1.6 * pxPerUnit);
  const radii = [0];
  for (let r = 1; r < maxR * 1.5; r *= shape === 'smooth' ? 2 : Math.SQRT2) radii.push(r);
  if (radii.length < 2) radii.push(1);
  const levels = radii.map((r) => blur(src, w, h, r, shape));
  const out = new Float32Array(rgb.length);
  const sx = dw / w;
  const sy = dh / h;
  for (let y = 0; y < h; y++) {
    const dy = Math.min(dh - 1, Math.floor((y + 0.5) * sy));
    const rowFocus = focus + tilt[1] * ((y + 0.5) / h - point[1]);
    for (let x = 0; x < w; x++) {
      const d = depth[dy * dw + Math.min(dw - 1, Math.floor((x + 0.5) * sx))];
      const f = rowFocus + tilt[0] * ((x + 0.5) / w - point[0]);
      const r = strength * softEdge(Math.abs(d - f) - spread, smooth) * pxPerUnit;
      let k = 0;
      while (k < radii.length - 2 && radii[k + 1] < r) k++;
      const t = Math.max(0, Math.min(1, (r - radii[k]) / (radii[k + 1] - radii[k] || 1)));
      const p = (y * w + x) * 3;
      // In-focus pixels keep their original (unboosted) values.
      const lo = k === 0 ? rgb : levels[k];
      for (let c = 0; c < 3; c++) out[p + c] = lo[p + c] * (1 - t) + levels[k + 1][p + c] * t;
    }
  }
  return out;
}
