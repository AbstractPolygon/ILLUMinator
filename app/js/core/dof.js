// Synthetic depth of field: blur each pixel in proportion to how far its
// depth is from the focus depth. This can narrow the depth of field beyond
// what the camera's small aperture records. A stack of increasingly blurred
// copies is built once and each pixel interpolates between the two levels
// around its blur radius.
//
// The blur's shape is the bokeh: 'smooth' (Gaussian), 'circle' or 'blades'
// (a polygon, like an aperture of that many blades). The circle can be
// stretched into an oval, both can be turned, and both can carry onion
// rings (concentric rings, as from aspherical lens elements). Shaped kernels
// are summed row by row from running sums, so a radius-r blur costs about
// 2r operations per pixel (times the number of ring bands with onion rings).

// The kernel's shape from the bokeh options. kind: 0 smooth, 1 circle, 2
// blades. aspect: the oval's width to height (1 = round). cos, sin: the
// rotation. 'hexagon' is the six-blade shape of older edits.
export function bokehKernel({ shape = 'smooth', blades = 6, oval = 0, rotation = 0, onion = 0 } = {}) {
  const kind = shape === 'blades' || shape === 'hexagon' ? 2 : shape === 'circle' ? 1 : 0;
  const a = (rotation * Math.PI) / 180;
  return {
    kind,
    blades: Math.max(3, Math.min(12, Math.round(shape === 'hexagon' ? 6 : blades))),
    aspect: kind === 1 ? 1 - 0.6 * Math.max(0, Math.min(1, oval)) : 1,
    cos: Math.cos(a),
    sin: Math.sin(a),
    onion: kind === 0 ? 0 : Math.max(0, Math.min(1, onion)),
  };
}

// Distance from the kernel's center in units of its radius: 1 on its edge.
// Blades: a regular polygon with one corner up and circumradius 1.
export function kernelDistance(k, x, y) {
  const qx = k.cos * x + k.sin * y;
  const qy = -k.sin * x + k.cos * y;
  if (k.kind === 2) {
    const seg = (2 * Math.PI) / k.blades;
    const a = Math.atan2(qx, qy);
    const m = ((a % seg) + seg) % seg - seg / 2;
    return (Math.hypot(qx, qy) * Math.cos(m)) / Math.cos(seg / 2);
  }
  return Math.hypot(qx / k.aspect, qy);
}

// Onion rings: brightness at distance t (0 center, 1 edge), averaging 1.
export const ONION_RINGS = 3;
export function onionGain(onion, t) {
  return 1 + onion * 0.6 * Math.cos(2 * Math.PI * ONION_RINGS * t);
}

// Kernel rows at radius r: [dy, x0, x1] spans (inclusive) inside the shape.
// The shape is convex, so each row is one span.
function kernelRows(k, r) {
  const rows = [];
  const R = Math.ceil(r);
  for (let dy = -R; dy <= R; dy++) {
    let x0 = Infinity;
    let x1 = -Infinity;
    for (let dx = -R; dx <= R; dx++) {
      if (kernelDistance(k, dx, dy) <= r + 1e-6) {
        x0 = Math.min(x0, dx);
        x1 = Math.max(x1, dx);
      }
    }
    if (x1 >= x0) rows.push([dy, x0, x1]);
  }
  if (!rows.length) rows.push([0, 0, 0]);
  return rows;
}

// Shaped blur: the weighted average over the kernel, built from per-row
// prefix sums. Onion rings split the kernel into nested shapes, each adding
// the change in ring brightness at its edge.
function shapedBlur(src, w, h, r, k) {
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
  // Nested shapes [rows, weight]: weight is the ring brightness inside its
  // edge minus the brightness just outside it.
  const bands = k.onion > 0 ? Math.max(1, Math.min(4 * ONION_RINGS, Math.floor(r / 1.5))) : 1;
  const shapes = [];
  for (let b = bands; b >= 1; b--) {
    const gain = (t) => (bands > 1 ? onionGain(k.onion, t) : 1);
    const inside = gain((b - 0.5) / bands);
    const outside = b === bands ? 0 : gain((b + 0.5) / bands);
    shapes.push([kernelRows(k, (r * b) / bands), inside - outside]);
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s0 = 0;
      let s1 = 0;
      let s2 = 0;
      let n = 0;
      for (const [rows, wt] of shapes) {
        for (const [dy, a0, a1] of rows) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          const x0 = Math.max(0, x + a0);
          const x1 = Math.min(w, x + a1 + 1);
          if (x1 <= x0) continue;
          const a = (yy * (w + 1) + x0) * 3;
          const b = (yy * (w + 1) + x1) * 3;
          s0 += wt * (prefix[b] - prefix[a]);
          s1 += wt * (prefix[b + 1] - prefix[a + 1]);
          s2 += wt * (prefix[b + 2] - prefix[a + 2]);
          n += wt * (x1 - x0);
        }
      }
      const o = (y * w + x) * 3;
      if (n > 1e-9) {
        out[o] = s0 / n;
        out[o + 1] = s1 / n;
        out[o + 2] = s2 / n;
      } else {
        out[o] = src[o];
        out[o + 1] = src[o + 1];
        out[o + 2] = src[o + 2];
      }
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

function blur(src, w, h, r, k) {
  if (r < 1) return src;
  if (k.kind) return shapedBlur(src, w, h, r, k);
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
// pxPerUnit. Options: shape ('smooth' | 'circle' | 'blades') with blades,
// oval (0..1), rotation (degrees) and onion (0..1) (see bokehKernel),
// highlights (0..1), clip (the developed level where highlights clip), and
// the focus field: spread (depth kept sharp on each side of the focus),
// smooth (width of the soft edge where blur starts after the spread), blur
// (pixels of blur added everywhere, the sharp range included),
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
  if (!(strength > 0) && !(options.blur > 0)) return rgb;
  const { blur: blurPx = 0, highlights = 0, clip = 1, spread = 0, smooth = 0, tilt = [0, 0], point = [0.5, 0.5] } = options;
  const kernel = bokehKernel(options);
  const src = boostHighlights(rgb, clip, highlights);
  const maxR = Math.max(1, strength * 1.6 * pxPerUnit + blurPx);
  const radii = [0];
  for (let r = 1; r < maxR * 1.5; r *= kernel.kind ? Math.SQRT2 : 2) radii.push(r);
  if (radii.length < 2) radii.push(1);
  const levels = radii.map((r) => blur(src, w, h, r, kernel));
  const out = new Float32Array(rgb.length);
  const sx = dw / w;
  const sy = dh / h;
  for (let y = 0; y < h; y++) {
    const dy = Math.min(dh - 1, Math.floor((y + 0.5) * sy));
    const rowFocus = focus + tilt[1] * ((y + 0.5) / h - point[1]);
    for (let x = 0; x < w; x++) {
      const d = depth[dy * dw + Math.min(dw - 1, Math.floor((x + 0.5) * sx))];
      const f = rowFocus + tilt[0] * ((x + 0.5) / w - point[0]);
      const r = strength * softEdge(Math.abs(d - f) - spread, smooth) * pxPerUnit + blurPx;
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
