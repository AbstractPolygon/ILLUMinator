// Lens correction: radial distortion and vignetting, applied to the finished
// picture (linear camera RGB) before color. gpu/renderer.js mirrors this.
//
// Positions are measured from the middle in units of the half diagonal, so
// r = 1 at the corners. Each output pixel at radius r takes the source pixel
// at r (1 + k r^2): k < 0 straightens barrel distortion (lines bowing
// outward), k > 0 pincushion; the result is zoomed just enough that the
// corners never fall outside the picture. Vignetting brightens (or darkens)
// from `start` out to the corners.
//
// The camera's own distortion is corrected by default (`auto`), as Lytro
// Desktop does: the factor is 1 + k1 r^2 + k2 r^4 with k1, k2 from the zoom
// the photo was taken at. The table was measured against Lytro Desktop's
// pictures of 15 ILLUM photos at zooms from -500 to 479: dense optical flow
// between its all in focus picture and ours, with the scale fixed by the lens
// pitch, left a purely radial difference that grows with zoom (about 2% of
// the half diagonal at the corners at the widest zoom, 10% at the longest).
// Applying it brings the difference at the edges down from about 20 pixels
// to 2 (of a 922 pixel wide picture). A second pass over the longest zooms
// (420 and up) and zoom 11, which still fell about 1 to 2.7% of the corner
// distance short of Lytro's, scaled those rows up by 12 to 20%.
const AUTO_DISTORTION = [
  // zoom step, k1, k2
  [-500, 0.020, -0.041],
  [-278, 0.021, -0.059],
  [-106, 0.016, -0.047],
  [11, 0.017, -0.071],
  [159, 0.030, -0.082],
  [222, 0.022, -0.079],
  [420, 0.058, -0.165],
  [479, 0.072, -0.206],
];

// { k1, k2 } for a camera at `zoomStep` (null: unknown camera or zoom).
export function autoDistortion(zoomStep) {
  if (!Number.isFinite(zoomStep)) return null;
  const t = AUTO_DISTORTION;
  if (zoomStep <= t[0][0]) return { k1: t[0][1], k2: t[0][2] };
  for (let i = 1; i < t.length; i++) {
    if (zoomStep <= t[i][0]) {
      const a = (zoomStep - t[i - 1][0]) / (t[i][0] - t[i - 1][0]);
      return { k1: t[i - 1][1] + a * (t[i][1] - t[i - 1][1]), k2: t[i - 1][2] + a * (t[i][2] - t[i - 1][2]) };
    }
  }
  const last = t[t.length - 1];
  return { k1: last[1], k2: last[2] };
}

// `cam`: the camera's info (capture.zoomStep picks the automatic correction).
export function lensParams(s = {}, cam = null) {
  const k = ((s.distortion || 0) / 100) * 0.25;
  const vig = (s.vignetting || 0) / 100;
  const start = (((s.midpoint ?? 50) / 100)) * 0.9;
  const auto = s.auto !== false && cam && cam.capture ? autoDistortion(cam.capture.zoomStep) : null;
  const k2 = auto ? auto.k2 : 0;
  const kk = k + (auto ? auto.k1 : 0);
  if (!kk && !k2 && !vig) return null;
  return { k: kk, k2, zoom: k > 0 ? 1 / (1 + k) : 1, vig, start };
}

// Source position (pixels) for output pixel center (x, y).
export function lensSource(p, x, y, w, h) {
  const cx = w / 2;
  const cy = h / 2;
  const R = Math.hypot(cx, cy);
  const dx = (x - cx) / R;
  const dy = (y - cy) / R;
  const r2 = dx * dx + dy * dy;
  const f = (1 + p.k * r2 + (p.k2 || 0) * r2 * r2) * p.zoom;
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
      if (p.k || p.k2) [sx, sy] = lensSource(p, sx, sy, w, h);
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
