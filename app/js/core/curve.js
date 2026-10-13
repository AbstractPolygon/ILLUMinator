// Tone curve: a point curve the user drags, after four parametric region
// sliders (shadows, darks, lights, highlights), both on gamma-encoded
// brightness from 0 (black) to 1 (white). They are combined into one table
// that the CPU and GPU renderers interpolate.

export const CURVE_SIZE = 65;
export const IDENTITY_POINTS = [[0, 0], [1, 1]];

// "x,y;x,y;..." <-> [[x, y], ...], sorted, with both end points present.
export function parsePoints(text) {
  const pts = String(text || '')
    .split(';')
    .map((p) => p.split(',').map(Number))
    .filter((p) => p.length === 2 && p.every(Number.isFinite))
    .map(([x, y]) => [Math.min(1, Math.max(0, x)), Math.min(1, Math.max(0, y))])
    .sort((a, b) => a[0] - b[0]);
  if (!pts.length || pts[0][0] > 0) pts.unshift([0, 0]);
  if (pts[pts.length - 1][0] < 1) pts.push([1, 1]);
  // One point per x.
  return pts.filter((p, i) => i === 0 || p[0] > pts[i - 1][0]);
}

export function formatPoints(pts) {
  return pts.map(([x, y]) => `${+x.toFixed(4)},${+y.toFixed(4)}`).join(';');
}

// Monotone cubic through the points (Fritsch-Carlson): no overshoot, so
// brightness never reverses between points.
export function monotoneCurve(pts) {
  const n = pts.length;
  if (n < 2) return (x) => x;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const d = [];
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i] || 1e-9));
  const m = new Array(n);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i] / d[i];
    const b = m[i + 1] / d[i];
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * d[i];
      m[i + 1] = t * b * d[i];
    }
  }
  return (x) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (i < n - 2 && x > xs[i + 1]) i++;
    const h = xs[i + 1] - xs[i];
    const t = (x - xs[i]) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1];
  };
}

// Parametric regions [shadows, darks, lights, highlights], each -1..1: a
// smooth bump over its quarter of the range.
const CENTERS = [0.125, 0.375, 0.625, 0.875];
const WIDTH = 0.25;

export function parametric(x, regions) {
  let y = x;
  for (let i = 0; i < 4; i++) {
    if (!regions[i]) continue;
    const u = (x - CENTERS[i]) / WIDTH;
    if (Math.abs(u) < 1) y += regions[i] * 0.12 * (1 - u * u) ** 2;
  }
  return y;
}

// The combined table (CURVE_SIZE values for x = 0..1), or null when it
// changes nothing.
export function curveTable({ points = IDENTITY_POINTS, regions = [0, 0, 0, 0] } = {}) {
  const pts = Array.isArray(points) ? points : parsePoints(points);
  const identityPoints = pts.length === 2 && pts[0][0] === 0 && pts[0][1] === 0 && pts[1][0] === 1 && pts[1][1] === 1;
  if (identityPoints && !regions.some((r) => r)) return null;
  const curve = monotoneCurve(pts);
  const out = new Float32Array(CURVE_SIZE);
  let prev = 0;
  for (let i = 0; i < CURVE_SIZE; i++) {
    const x = i / (CURVE_SIZE - 1);
    const v = curve(Math.min(1, Math.max(0, parametric(x, regions))));
    // Never darker than the step before: stacked region bumps could dip.
    prev = Math.max(prev, Math.min(1, Math.max(0, v)));
    out[i] = prev;
  }
  return out;
}

// Looks up x in the table; beyond 0..1 (highlights pushed past white) the
// curve continues straight.
export function curveAt(table, x) {
  if (x <= 0) return table[0] + x;
  if (x >= 1) return table[CURVE_SIZE - 1] + (x - 1);
  const f = x * (CURVE_SIZE - 1);
  const i = Math.floor(f);
  const t = f - i;
  return table[i] * (1 - t) + table[i + 1] * t;
}
