// Local adjustments: up to 16 masks, each with its own effects, applied
// to the finished picture (linear output RGB, after the tone and color
// adjustments). gpu/renderer.js mirrors this.
//
// Mask kinds (positions are fractions of the picture, 0..1):
//   radial  { x, y, w, h, feather }   an ellipse centered at (x, y) with half
//           sizes w, h; full effect inside, fading over `feather` (0..1)
//   linear  { x, y, angle, width }    a graduated filter: full effect on one
//           side of the line through (x, y) at `angle` degrees, none on the
//           other, fading over `width`
//   depth   { near, far, feather }    by the depth map (focus values): full
//           effect between near and far, fading over `feather`
// Each mask: { id, kind, on, invert, strength (0..1, scales the effects),
// ...shape, fx: { exposure (EV), contrast, saturation, temperature, tint
// (each -1..1); blur, pixelate, sketch (each 0..1: spatial effects, see
// applySpatial) } }. A depth mask with `follow` set moves with the focus:
// near and far shift by how far the focus is from `anchor`, the focus the
// mask was made at. A radial mask with `followView` set moves a little
// with the viewpoint, like the edge of a lens seen from off center.

export const MAX_MASKS = 16;
export const MASK_KINDS = ['radial', 'linear', 'depth'];

const newId = () => Math.random().toString(36).slice(2, 10);

export function defaultMask(kind) {
  const base = { id: newId(), kind, on: true, invert: false, strength: 1, follow: false, anchor: 0, fx: { exposure: 0, contrast: 0, saturation: 0, temperature: 0, tint: 0, blur: 0, pixelate: 0, sketch: 0 } };
  if (kind === 'radial') return { ...base, x: 0.5, y: 0.5, w: 0.25, h: 0.25, feather: 0.5 };
  if (kind === 'linear') return { ...base, x: 0.5, y: 0.5, angle: 90, width: 0.3 };
  return { ...base, near: -0.3, far: 0.3, feather: 0.2 };
}

export function parseMasks(text) {
  let list;
  try {
    list = JSON.parse(text || '[]');
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  return list
    .filter((m) => m && MASK_KINDS.includes(m.kind))
    .slice(0, MAX_MASKS)
    .map((m, i) => {
      const d = defaultMask(m.kind);
      // Masks saved before ids existed are named by their place.
      const id = typeof m.id === 'string' && m.id ? m.id : `m${i}`;
      return { ...d, ...m, id, fx: { ...d.fx, ...(m.fx || {}) } };
    });
}

// The masks as one picture uses them: `overrides[id]` ({ attr: value },
// an animation's values for this frame: strength, shape or effect) applied,
// effects scaled by the strength, and depth masks that follow the focus
// moved to `focus`.
export function resolveMasks(masks, { focus = null, overrides = null, view = null } = {}) {
  return (masks || []).map((m) => {
    const out = { ...m, fx: { ...m.fx } };
    for (const [a, v] of Object.entries((overrides && overrides[m.id]) || {})) {
      if (!Number.isFinite(v)) continue;
      if (a in out.fx) out.fx[a] = v;
      else out[a] = v;
    }
    const s = Math.min(1, Math.max(0, out.strength ?? 1));
    for (const k of Object.keys(out.fx)) out.fx[k] *= s;
    if (out.kind === 'radial' && out.followView && view && view.r > 0) {
      out.x += 0.12 * (view.u / view.r);
      out.y += 0.12 * (view.v / view.r);
    }
    if (out.kind === 'depth' && out.follow && Number.isFinite(focus)) {
      const shift = focus - (out.anchor || 0);
      out.near += shift;
      out.far += shift;
    }
    return out;
  });
}

// Masks that change something.
export function activeMasks(masks) {
  return (masks || []).filter((m) => m.on && Object.values(m.fx).some((v) => v));
}

const smooth = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a || 1e-6)));
  return t * t * (3 - 2 * t);
};

// Mask weight 0..1 at (nx, ny); `aspect` is width / height; `depth` the
// focus value there (or null).
export function maskWeight(m, nx, ny, aspect, depth) {
  let w = 0;
  if (m.kind === 'radial') {
    const u = (nx - m.x) / Math.max(1e-4, m.w);
    const v = (ny - m.y) / Math.max(1e-4, m.h);
    const d = Math.sqrt(u * u + v * v);
    w = 1 - smooth(1 - Math.min(0.999, m.feather), 1, d);
  } else if (m.kind === 'linear') {
    const a = (m.angle * Math.PI) / 180;
    const t = ((nx - m.x) * aspect * Math.cos(a) + (ny - m.y) * Math.sin(a)) / Math.max(1e-4, m.width) + 0.5;
    w = 1 - smooth(0, 1, t);
  } else if (m.kind === 'depth') {
    if (depth == null) return 0;
    const f = Math.max(1e-4, m.feather);
    w = smooth(m.near - f, m.near, depth) * (1 - smooth(m.far, m.far + f, depth));
  }
  return m.invert ? 1 - w : w;
}

// Adjusts one linear RGB pixel `px` (length 3) by mask weight `w`.
export function applyEffects(px, fx, w) {
  if (!(w > 0)) return;
  let [r, g, b] = px;
  if (fx.exposure) {
    const k = 2 ** (fx.exposure * w);
    r *= k;
    g *= k;
    b *= k;
  }
  if (fx.temperature || fx.tint) {
    r *= 1 + 0.25 * fx.temperature * w;
    b *= 1 - 0.25 * fx.temperature * w;
    g *= 1 - 0.15 * fx.tint * w;
  }
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  if (fx.contrast && y > 1e-6) {
    // Around middle gray, in a perceptual (log) sense.
    const k = (y / 0.18) ** (fx.contrast * w * 0.6);
    r *= k;
    g *= k;
    b *= k;
  }
  if (fx.saturation) {
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const s = Math.max(0, 1 + fx.saturation * w);
    r = l + (r - l) * s;
    g = l + (g - l) * s;
    b = l + (b - l) * s;
  }
  px[0] = Math.max(0, r);
  px[1] = Math.max(0, g);
  px[2] = Math.max(0, b);
}

// All masks at (nx, ny). `show`: index of a mask to tint red (or -1).
export function applyLocal(px, masks, nx, ny, aspect, depth, show = -1) {
  for (let i = 0; i < masks.length; i++) {
    const m = masks[i];
    const w = maskWeight(m, nx, ny, aspect, depth);
    applyEffects(px, m.fx, w);
    if (i === show) {
      px[0] = px[0] * (1 - 0.5 * w) + 0.8 * w * 0.5;
      px[1] *= 1 - 0.5 * w;
      px[2] *= 1 - 0.5 * w;
    }
  }
}

// Uniform data for the GPU: per mask a kind code, shape and effects.
export function packMasks(masks) {
  const kinds = new Int32Array(MAX_MASKS).fill(-1);
  const shape = new Float32Array(MAX_MASKS * 4);
  const extra = new Float32Array(MAX_MASKS * 4);
  const fx = new Float32Array(MAX_MASKS * 4);
  const fx2 = new Float32Array(MAX_MASKS * 4);
  masks.slice(0, MAX_MASKS).forEach((m, i) => {
    kinds[i] = MASK_KINDS.indexOf(m.kind);
    if (m.kind === 'radial') shape.set([m.x, m.y, m.w, m.h], 4 * i);
    else if (m.kind === 'linear') shape.set([m.x, m.y, m.angle, m.width], 4 * i);
    else shape.set([m.near, m.far, m.feather, 0], 4 * i);
    extra.set([m.kind === 'radial' ? m.feather : 0, 0, 0, m.invert ? 1 : 0], 4 * i);
    fx.set([m.fx.exposure, m.fx.contrast, m.fx.saturation, m.fx.temperature], 4 * i);
    fx2.set([m.fx.tint, m.fx.blur || 0, m.fx.pixelate || 0, m.fx.sketch || 0], 4 * i);
  });
  return { count: Math.min(MAX_MASKS, masks.length), kinds, shape, extra, fx, fx2 };
}

// ---------------------------------------------------------------- spatial

// Masks with an effect that looks at neighbouring pixels.
export function hasSpatial(masks) {
  return (masks || []).some((m) => m.fx.blur > 0 || m.fx.pixelate > 0 || m.fx.sketch > 0);
}

// Box blur of radius r, twice (close to a Gaussian), of 3-channel rgb.
function boxBlur(src, w, h, r) {
  let a = src;
  for (let pass = 0; pass < 2; pass++) {
    const tmp = new Float32Array(a.length);
    for (let y = 0; y < h; y++) {
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        for (let x = -r; x <= r; x++) sum += a[3 * (y * w + Math.min(w - 1, Math.max(0, x))) + c];
        for (let x = 0; x < w; x++) {
          tmp[3 * (y * w + x) + c] = sum / (2 * r + 1);
          sum += a[3 * (y * w + Math.min(w - 1, x + r + 1)) + c] - a[3 * (y * w + Math.max(0, x - r)) + c];
        }
      }
    }
    const out = new Float32Array(a.length);
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        for (let y = -r; y <= r; y++) sum += tmp[3 * (Math.min(h - 1, Math.max(0, y)) * w + x) + c];
        for (let y = 0; y < h; y++) {
          out[3 * (y * w + x) + c] = sum / (2 * r + 1);
          sum += tmp[3 * (Math.min(h - 1, y + r + 1) * w + x) + c] - tmp[3 * (Math.max(0, y - r) * w + x) + c];
        }
      }
    }
    a = out;
  }
  return a;
}

const lum = (p, i) => 0.2126 * p[i] + 0.7152 * p[i + 1] + 0.0722 * p[i + 2];

// The spatial effects of masks on linear RGB (w x h), before tone mapping
// (gpu/renderer.js mirrors this): blur (radius up to 2% of the picture),
// pixelate (tiles up to 4%) and sketch (pencil outlines over light colors),
// each blended in by the mask's weight. `local` as for toneMap.
export function applySpatial(rgb, w, h, local) {
  const big = Math.max(w, h);
  const aspect = w / h;
  let out = rgb;
  for (const m of local.masks) {
    const { blur = 0, pixelate = 0, sketch = 0 } = m.fx;
    if (!(blur > 0 || pixelate > 0 || sketch > 0)) continue;
    const weight = new Float32Array(w * h);
    let any = false;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const nx = (x + 0.5) / w;
        const ny = (y + 0.5) / h;
        let d = null;
        if (local.depth) d = local.depth[Math.min(local.dh - 1, Math.floor(ny * local.dh)) * local.dw + Math.min(local.dw - 1, Math.floor(nx * local.dw))];
        const v = maskWeight(m, nx, ny, aspect, d);
        weight[y * w + x] = v;
        any = any || v > 0;
      }
    }
    if (!any) continue;
    const src = out;
    const next = new Float32Array(src);
    const blend = (i, r, g, b, k) => {
      next[3 * i] += (r - next[3 * i]) * k;
      next[3 * i + 1] += (g - next[3 * i + 1]) * k;
      next[3 * i + 2] += (b - next[3 * i + 2]) * k;
    };
    if (blur > 0) {
      const b = boxBlur(src, w, h, Math.max(1, Math.round(blur * 0.02 * big * 0.5)));
      for (let i = 0; i < w * h; i++) if (weight[i] > 0) blend(i, b[3 * i], b[3 * i + 1], b[3 * i + 2], weight[i]);
    }
    if (pixelate > 0) {
      const s = Math.max(2, Math.floor(pixelate * 0.04 * big));
      for (let by = 0; by < h; by += s) {
        for (let bx = 0; bx < w; bx += s) {
          let r = 0;
          let g = 0;
          let bl = 0;
          let n = 0;
          for (let y = by; y < Math.min(h, by + s); y++) {
            for (let x = bx; x < Math.min(w, bx + s); x++) {
              const i = 3 * (y * w + x);
              r += src[i];
              g += src[i + 1];
              bl += src[i + 2];
              n++;
            }
          }
          for (let y = by; y < Math.min(h, by + s); y++) for (let x = bx; x < Math.min(w, bx + s); x++) {
            const i = y * w + x;
            if (weight[i] > 0) blend(i, r / n, g / n, bl / n, weight[i]);
          }
        }
      }
    }
    if (sketch > 0) {
      const L = new Float32Array(w * h);
      for (let i = 0; i < w * h; i++) L[i] = Math.log2(lum(src, 3 * i) + 1e-4);
      const at = (x, y) => L[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))];
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          if (!(weight[i] > 0)) continue;
          const gx = at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1);
          const gy = at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1);
          const g = Math.hypot(gx, gy) / 4;
          const e = Math.min(1, Math.max(0, (g - 0.15) / 0.6));
          const l = lum(src, 3 * i);
          // Light, washed colors with dark strokes along the edges.
          const k = 1.25 * (1 - 0.85 * e);
          blend(i, (0.65 * src[3 * i] + 0.35 * l) * k, (0.65 * src[3 * i + 1] + 0.35 * l) * k, (0.65 * src[3 * i + 2] + 0.35 * l) * k, weight[i] * sketch);
        }
      }
    }
    out = next;
  }
  return out;
}
