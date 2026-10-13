// Lens correction: radial distortion and vignetting, applied to the finished
// picture (linear camera RGB) before color. gpu/renderer.js mirrors this.
//
// Positions are measured from the middle in units of the half diagonal, so
// r = 1 at the corners. Each output pixel at radius r takes the source pixel
// at r (1 + k r^2): k < 0 straightens barrel distortion (lines bowing
// outward), k > 0 pincushion; the result is zoomed just enough that the
// corners never fall outside the picture. Vignetting brightens (or darkens)
// from `start` out to the corners.

export function lensParams(s = {}) {
  const k = ((s.distortion || 0) / 100) * 0.25;
  const vig = (s.vignetting || 0) / 100;
  const start = (((s.midpoint ?? 50) / 100)) * 0.9;
  if (!k && !vig) return null;
  return { k, zoom: k > 0 ? 1 / (1 + k) : 1, vig, start };
}

// Source position (pixels) for output pixel center (x, y).
export function lensSource(p, x, y, w, h) {
  const cx = w / 2;
  const cy = h / 2;
  const R = Math.hypot(cx, cy);
  const dx = (x - cx) / R;
  const dy = (y - cy) / R;
  const f = (1 + p.k * (dx * dx + dy * dy)) * p.zoom;
  return [cx + dx * f * R, cy + dy * f * R];
}

// Vignetting gain at source position (x, y).
export function lensGain(p, x, y, w, h) {
  if (!p.vig) return 1;
  const cx = w / 2;
  const cy = h / 2;
  const r = Math.hypot(x - cx, y - cy) / Math.hypot(cx, cy);
  const t = Math.min(1, Math.max(0, (r - p.start) / (1 - p.start)));
  const s = t * t * (3 - 2 * t);
  return Math.max(0, 1 + 1.5 * p.vig * s);
}

// rgb (w x h) through the lens correction, as a new array.
export function applyLens(rgb, w, h, p) {
  if (!p) return rgb;
  const out = new Float32Array(rgb.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sx = x + 0.5;
      let sy = y + 0.5;
      if (p.k) [sx, sy] = lensSource(p, sx, sy, w, h);
      const g = lensGain(p, sx, sy, w, h);
      // Bilinear, between pixel centers.
      const fx = Math.min(w - 1.001, Math.max(0, sx - 0.5));
      const fy = Math.min(h - 1.001, Math.max(0, sy - 0.5));
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const ax = fx - x0;
      const ay = fy - y0;
      const o = (y * w + x) * 3;
      for (let c = 0; c < 3; c++) {
        const q = (y0 * w + x0) * 3 + c;
        const v = (rgb[q] * (1 - ax) + rgb[q + 3] * ax) * (1 - ay) + (rgb[q + w * 3] * (1 - ax) + rgb[q + w * 3 + 3] * ax) * ay;
        out[o + c] = v * g;
      }
    }
  }
  return out;
}
