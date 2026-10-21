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

// The polynomial overshoots in the outermost fifth of the picture (measured
// against Lytro Desktop on 9 photos: 8 to 20 pixels at the corners), so the
// correction is eased off there: EDGE_EASE * ((r - 0.75) / 0.25)^2 / r more
// source distance past r = 0.75 (r in half diagonals), more at long zooms.
export const EDGE_START = 0.75;
export function edgeEase(zoomStep) {
  const t = Math.min(1, Math.max(0, (Math.min(zoomStep, AUTO_DISTORTION[AUTO_DISTORTION.length - 1][0]) + 100) / 579));
  return 0.018 + 0.012 * t;
}

// The picture is also a little smaller than the plain curve gives, and the
// curve's shape is slightly off (fitted against Lytro Desktop with a scale
// term, on 10 photos): zoom step, scale, then k1 and k2 to add.
const DISTORTION_FIT = [
  [-278, 0.0096, -0.0354, 0.0262],
  [11, 0.014, -0.0257, 0.0141],
  [159, 0.0166, -0.0624, 0.0482],
  [420, 0.0333, -0.1351, 0.1233],
  [479, 0.0361, -0.1444, 0.1332],
];

function interpolate(t, zoomStep, cols) {
  if (zoomStep <= t[0][0]) return cols.map((c) => t[0][c]);
  for (let i = 1; i < t.length; i++) {
    if (zoomStep <= t[i][0]) {
      const a = (zoomStep - t[i - 1][0]) / (t[i][0] - t[i - 1][0]);
      return cols.map((c) => t[i - 1][c] + a * (t[i][c] - t[i - 1][c]));
    }
  }
  return cols.map((c) => t[t.length - 1][c]);
}

// { scale, k1, k2, edge } for a camera at `zoomStep` (null: unknown camera or
// zoom). The picture is scaled by 1 + scale and the source distance is
// 1 + k1 r^2 + k2 r^4 + edge ease, as lensSource does.
export function autoDistortion(zoomStep) {
  if (!Number.isFinite(zoomStep)) return null;
  const [k1, k2] = interpolate(AUTO_DISTORTION, zoomStep, [1, 2]);
  const [scale, dk1, dk2] = interpolate(DISTORTION_FIT, zoomStep, [1, 2, 3]);
  return { scale, k1: k1 + dk1, k2: k2 + dk2, edge: edgeEase(zoomStep) };
}

// The automatic correction fitted to a distortion profile of (r, ratio) pairs
// (core/raywarp.js distortionProfile), in the same form as autoDistortion:
// ratio = scale + k1 r^2 + k2 r^4 + edge ease, by least squares.
export function fitDistortion(profile) {
  if (!profile || profile.length < 8) return null;
  const A = Array.from({ length: 4 }, () => new Float64Array(5));
  for (const { r, ratio } of profile) {
    const g = r > EDGE_START ? ((r - EDGE_START) / (1 - EDGE_START)) ** 2 / r : 0;
    const b = [1, r * r, r ** 4, g];
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) A[i][j] += b[i] * b[j];
      A[i][4] += b[i] * ratio;
    }
  }
  for (let i = 0; i < 4; i++) {
    let p = i;
    for (let j = i + 1; j < 4; j++) if (Math.abs(A[j][i]) > Math.abs(A[p][i])) p = j;
    [A[i], A[p]] = [A[p], A[i]];
    if (Math.abs(A[i][i]) < 1e-12) return null;
    for (let j = i + 1; j < 4; j++) {
      const f = A[j][i] / A[i][i];
      for (let k = i; k < 5; k++) A[j][k] -= f * A[i][k];
    }
  }
  const x = new Float64Array(4);
  for (let i = 3; i >= 0; i--) {
    let t = A[i][4];
    for (let j = i + 1; j < 4; j++) t -= A[i][j] * x[j];
    x[i] = t / A[i][i];
  }
  return { scale: x[0] - 1, k1: x[1], k2: x[2], edge: x[3] };
}

// `cam`: the camera's info (capture.zoomStep picks the automatic correction;
// `distortionFit` is the photo's own, when it came with its ray table).
export function lensParams(s = {}, cam = null) {
  const k = ((s.distortion || 0) / 100) * 0.25;
  const vig = (s.vignetting || 0) / 100;
  const start = (((s.midpoint ?? 50) / 100)) * 0.9;
  const auto = s.auto !== false && cam ? cam.distortionFit || (cam.capture ? autoDistortion(cam.capture.zoomStep) : null) : null;
  const sc = auto ? 1 + auto.scale : 1;
  const k2 = auto ? auto.k2 / sc : 0;
  const kk = (k + (auto ? auto.k1 : 0)) / sc;
  const edge = auto ? auto.edge / sc : 0;
  if (!kk && !k2 && !vig) return null;
  return { k: kk, k2, edge, zoom: (k > 0 ? 1 / (1 + k) : 1) * sc, vig, start };
}

// Source position (pixels) for output pixel center (x, y).
export function lensSource(p, x, y, w, h) {
  const cx = w / 2;
  const cy = h / 2;
  const R = Math.hypot(cx, cy);
  const dx = (x - cx) / R;
  const dy = (y - cy) / R;
  const r2 = dx * dx + dy * dy;
  const r = Math.sqrt(r2);
  const e = r > EDGE_START ? (p.edge || 0) * ((r - EDGE_START) / (1 - EDGE_START)) ** 2 / r : 0;
  const f = (1 + p.k * r2 + (p.k2 || 0) * r2 * r2 + e) * p.zoom;
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

// Catmull-Rom weights for the 4 samples around a point at fraction t.
function catmullRom(t) {
  const t2 = t * t;
  const t3 = t2 * t;
  return [(-t3 + 2 * t2 - t) / 2, (3 * t3 - 5 * t2 + 2) / 2, (-3 * t3 + 4 * t2 + t) / 2, (t3 - t2) / 2];
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
      // Catmull-Rom, between pixel centers: a bilinear lookup would blur the
      // detail the render has just been given, wherever the correction moves
      // the picture by a fraction of a pixel.
      const fx = Math.min(w - 1.001, Math.max(0, sx - 0.5));
      const fy = Math.min(h - 1.001, Math.max(0, sy - 0.5));
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const ax = fx - x0;
      const ay = fy - y0;
      const wx = catmullRom(ax);
      const wy = catmullRom(ay);
      const o = (y * w + x) * 3;
      for (let c = 0; c < 3; c++) {
        let v = 0;
        for (let j = 0; j < 4; j++) {
          const yy = Math.min(h - 1, Math.max(0, y0 - 1 + j));
          let row = 0;
          for (let i = 0; i < 4; i++) {
            const xx = Math.min(w - 1, Math.max(0, x0 - 1 + i));
            row += wx[i] * rgb[(yy * w + xx) * 3 + c];
          }
          v += wy[j] * row;
        }
        out[o + c] = Math.max(0, v) * g;
      }
    }
  }
  return out;
}

// The lens correction as a position map, for correcting where each ray lands
// before the rays are combined (rather than resampling the combined picture,
// which blurs it): `source(x, y)` is lensSource; `forward(x, y)` its inverse,
// from a position in the uncorrected picture to the corrected one.
// Positions are pixel center coordinates (the first pixel's center is 0.5).
// null when there is no distortion to correct.
export function lensWarp(p, w, h) {
  if (!p || !(p.k || p.k2 || p.edge || (p.zoom && p.zoom !== 1))) return null;
  const cx = w / 2;
  const cy = h / 2;
  const R = Math.hypot(cx, cy);
  const N = 4096;
  const rMax = 1.4;
  // Source radius at each corrected radius (monotonic), then the corrected
  // radius at evenly spaced source radii.
  const ratio = (r) => {
    const r2 = r * r;
    const e = r > EDGE_START ? (p.edge || 0) * ((r - EDGE_START) / (1 - EDGE_START)) ** 2 / r : 0;
    return (1 + p.k * r2 + (p.k2 || 0) * r2 * r2 + e) * p.zoom;
  };
  const rs = new Float64Array(N + 1);
  for (let i = 0; i <= N; i++) {
    const r = (i / N) * rMax;
    rs[i] = r * (i === 0 ? ratio(1e-6) : ratio(r));
  }
  const sMax = rs[N];
  const inv = new Float64Array(N + 1);
  let j = 0;
  for (let i = 0; i <= N; i++) {
    const target = (i / N) * sMax;
    while (j < N - 1 && rs[j + 1] < target) j++;
    const span = rs[j + 1] - rs[j] || 1;
    inv[i] = ((j + (target - rs[j]) / span) / N) * rMax;
  }
  return {
    source: (x, y) => lensSource(p, x, y, w, h),
    forward(x, y) {
      const dx = (x - cx) / R;
      const dy = (y - cy) / R;
      const r = Math.hypot(dx, dy);
      if (r === 0) return [x, y];
      const t = (r / sMax) * N;
      let ro;
      if (t >= N) ro = r * (inv[N] / sMax);
      else {
        const i = Math.floor(t);
        ro = inv[i] + (inv[i + 1] - inv[i]) * (t - i);
      }
      const k = ro / r;
      return [cx + dx * k * R, cy + dy * k * R];
    },
  };
}

// The same lens parameters with the distortion left out (it is already
// corrected): only vignetting stays.
export function withoutDistortion(p) {
  return p ? { ...p, k: 0, k2: 0, edge: 0, zoom: 1 } : p;
}
