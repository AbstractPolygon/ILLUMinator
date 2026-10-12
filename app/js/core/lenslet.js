// Hexagonal microlens array model.
//
// Lens (r, c) sits at grid-local position
//   lx = c * pitch + (r odd ? pitch / 2 : 0),  ly = r * rowStep
// which is rotated by `rotation` and translated to (ox, oy) on the sensor.
// The lattice has basis (pitch, 0) and (pitch / 2, rowStep), so any origin
// shift can be reduced to [0, pitch) x [0, rowStep).

const SQRT3_2 = Math.sqrt(3) / 2;

export function gridFromCamera(cam) {
  const { mla, width, height } = cam;
  return normalizeGrid({
    pitch: mla.pitch,
    rowStep: mla.pitch * SQRT3_2 * mla.scaleY,
    rotation: mla.rotation,
    ox: width / 2 + mla.offsetX,
    oy: height / 2 + mla.offsetY,
  }, cam);
}

// Moves the origin to the lens nearest the sensor center so that rotation and
// pitch adjustments pivot around the middle of the image.
export function normalizeGrid(grid, cam) {
  const g = { ...grid };
  const cx = cam.width / 2;
  const cy = cam.height / 2;
  const [lx, ly] = toLocal(g, cx, cy);
  const r = Math.round(ly / g.rowStep);
  const c = Math.round((lx - (r & 1) * g.pitch / 2) / g.pitch);
  const [x, y] = lensCenter(g, r, c);
  g.ox = x;
  g.oy = y;
  return g;
}

export function lensCenter(g, r, c) {
  const lx = c * g.pitch + (r & 1) * g.pitch * 0.5;
  const ly = r * g.rowStep;
  const cos = Math.cos(g.rotation);
  const sin = Math.sin(g.rotation);
  return [g.ox + cos * lx - sin * ly, g.oy + sin * lx + cos * ly];
}

export function toLocal(g, x, y) {
  const dx = x - g.ox;
  const dy = y - g.oy;
  const cos = Math.cos(g.rotation);
  const sin = Math.sin(g.rotation);
  return [cos * dx + sin * dy, -sin * dx + cos * dy];
}

// Range of lens rows/columns whose centers fall inside the sensor (with margin).
export function lensRange(g, width, height, margin) {
  const corners = [[margin, margin], [width - margin, margin], [margin, height - margin], [width - margin, height - margin]]
    .map(([x, y]) => toLocal(g, x, y));
  const xs = corners.map((p) => p[0]);
  const ys = corners.map((p) => p[1]);
  return {
    r0: Math.ceil(Math.max(...ys.slice(0, 2)) / g.rowStep),
    r1: Math.floor(Math.min(...ys.slice(2)) / g.rowStep),
    c0: Math.ceil((Math.max(xs[0], xs[2]) + g.pitch / 2) / g.pitch),
    c1: Math.floor((Math.min(xs[1], xs[3]) - g.pitch / 2) / g.pitch),
  };
}

// Returns lens centers for the whole sensor as flat arrays indexed by
// (r - r0) * cols + (c - c0).
export function lensCenters(g, width, height) {
  const margin = g.pitch;
  const { r0, r1, c0, c1 } = lensRange(g, width, height, margin);
  const rows = r1 - r0 + 1;
  const cols = c1 - c0 + 1;
  const cx = new Float32Array(rows * cols);
  const cy = new Float32Array(rows * cols);
  let i = 0;
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++, i++) {
      const [x, y] = lensCenter(g, r, c);
      cx[i] = x;
      cy[i] = y;
    }
  }
  return { r0, r1, c0, c1, rows, cols, cx, cy };
}

// --- calibration -----------------------------------------------------------

// Luminance proxy: the mean of a 2x2 block contains each Bayer color once, so
// it is independent of the mosaic position. Bilinear between block centers.
function makeLuminance(raw, width, height) {
  return (x, y) => {
    const fx = x - 1;
    const fy = y - 1;
    const ix = Math.floor(fx);
    const iy = Math.floor(fy);
    if (ix < 0 || iy < 0 || ix + 3 >= width || iy + 3 >= height) return 0;
    const ax = fx - ix;
    const ay = fy - iy;
    const p = iy * width + ix;
    const b00 = raw[p] + raw[p + 1] + raw[p + width] + raw[p + width + 1];
    const b10 = raw[p + 1] + raw[p + 2] + raw[p + width + 1] + raw[p + width + 2];
    const q = p + width;
    const b01 = raw[q] + raw[q + 1] + raw[q + width] + raw[q + width + 1];
    const b11 = raw[q + 1] + raw[q + 2] + raw[q + width + 1] + raw[q + width + 2];
    return (b00 * (1 - ax) + b10 * ax) * (1 - ay) + (b01 * (1 - ax) + b11 * ax) * ay;
  };
}

function pickSamples(g, width, height, radiusFraction, count) {
  const { r0, r1, c0, c1 } = lensRange(g, width, height, g.pitch * 2);
  const maxR = Math.min(width, height) * radiusFraction;
  const all = [];
  for (let r = r0; r <= r1; r++) {
    for (let c = c0; c <= c1; c++) {
      const lx = c * g.pitch + (r & 1) * g.pitch / 2;
      const ly = r * g.rowStep;
      if (lx * lx + ly * ly <= maxR * maxR) all.push(r, c);
    }
  }
  const n = all.length / 2;
  const step = Math.max(1, n / count);
  const out = [];
  for (let k = 0; k < n; k += step) {
    const i = Math.floor(k) * 2;
    out.push(all[i], all[i + 1]);
  }
  return Int32Array.from(out);
}

// Contrast between lens centers and the dark triple junctions between lenses
// (at distance pitch / sqrt(3) straight above and below every center).
function score(g, lum, samples) {
  const cos = Math.cos(g.rotation);
  const sin = Math.sin(g.rotation);
  const j = g.pitch / Math.sqrt(3) * (g.rowStep / (g.pitch * SQRT3_2));
  const jx = -sin * j;
  const jy = cos * j;
  let s = 0;
  for (let k = 0; k < samples.length; k += 2) {
    const r = samples[k];
    const c = samples[k + 1];
    const lx = c * g.pitch + (r & 1) * g.pitch * 0.5;
    const ly = r * g.rowStep;
    const x = g.ox + cos * lx - sin * ly;
    const y = g.oy + sin * lx + cos * ly;
    s += 2 * lum(x, y) - lum(x + jx, y + jy) - lum(x - jx, y - jy);
  }
  return s;
}

function searchOffset(g, lum, samples, range, step) {
  let best = g;
  let bestScore = -Infinity;
  for (let dy = -range.y; dy <= range.y + 1e-9; dy += step) {
    for (let dx = -range.x; dx <= range.x + 1e-9; dx += step) {
      const cand = { ...g, ox: g.ox + dx, oy: g.oy + dy };
      const s = score(cand, lum, samples);
      if (s > bestScore) {
        bestScore = s;
        best = cand;
      }
    }
  }
  return { grid: best, score: bestScore };
}

function searchParam(g, lum, samples, apply, range, steps) {
  let best = g;
  let bestScore = score(g, lum, samples);
  for (let i = -steps; i <= steps; i++) {
    if (i === 0) continue;
    const cand = apply(g, (range * i) / steps);
    const s = score(cand, lum, samples);
    if (s > bestScore) {
      bestScore = s;
      best = cand;
    }
  }
  return best;
}

// Aligns the grid to the image: microlens images are brightest at their
// centers because of vignetting, whatever the scene. Coarse-to-fine search
// over origin, then rotation and pitch with samples spread over the sensor.
export function calibrateGrid(raw, cam, initial, onProgress = () => {}) {
  const { width, height } = cam;
  const lum = makeLuminance(raw, width, height);
  let g = normalizeGrid(initial, cam);

  const center = pickSamples(g, width, height, 0.12, 1500);
  onProgress(0.05);
  g = searchOffset(g, lum, center, { x: g.pitch / 2, y: g.rowStep / 2 }, 0.5).grid;
  onProgress(0.25);
  g = searchOffset(g, lum, center, { x: 0.5, y: 0.5 }, 0.1).grid;
  onProgress(0.35);

  const wide = pickSamples(g, width, height, 0.9, 4000);
  const rotate = (grid, d) => ({ ...grid, rotation: grid.rotation + d });
  const scale = (grid, d) => ({ ...grid, pitch: grid.pitch * (1 + d), rowStep: grid.rowStep * (1 + d) });
  const stretchY = (grid, d) => ({ ...grid, rowStep: grid.rowStep * (1 + d) });
  let rotRange = 0.004;
  let scaleRange = 0.01;
  for (let iter = 0; iter < 4; iter++) {
    g = searchParam(g, lum, wide, rotate, rotRange, 10);
    g = searchParam(g, lum, wide, scale, scaleRange, 10);
    g = searchParam(g, lum, wide, stretchY, scaleRange / 4, 5);
    g = searchOffset(g, lum, center, { x: 0.3, y: 0.3 }, 0.1).grid;
    rotRange /= 3;
    scaleRange /= 3;
    onProgress(0.35 + 0.15 * (iter + 1));
  }
  g = normalizeGrid(g, cam);
  return { grid: g, quality: gridQuality(g, lum, wide) };
}

// Normalized contrast in [0, 1]-ish; low values mean the grid is off.
export function gridQuality(g, lum, samples) {
  let center = 0;
  for (let k = 0; k < samples.length; k += 2) {
    const [x, y] = lensCenter(g, samples[k], samples[k + 1]);
    center += lum(x, y);
  }
  return center > 0 ? score(g, lum, samples) / (2 * center) : 0;
}

export function measureGrid(raw, cam, g) {
  const lum = makeLuminance(raw, cam.width, cam.height);
  return gridQuality(g, lum, pickSamples(g, cam.width, cam.height, 0.9, 4000));
}
