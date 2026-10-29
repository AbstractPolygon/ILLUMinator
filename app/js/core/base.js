// The Lytro Desktop look: how Lytro Desktop turns linear color into the
// picture it shows, so photos open looking as they do there.
//
// Measured on eleven ILLUM photos against Lytro Desktop's own renderings
// of them (stack.lfp, untouched edits): Lytro keeps the camera's exposure
// (a fixed gain over our white-level scaled raw, where our flat look picks
// an exposure per photo; it held to within 0.1 EV on ten of the eleven),
// then puts each channel through a film-like curve with a deep toe and a
// shoulder that takes the sensor's white to white, and finally sets color
// per hue: reds, oranges and yellows keep more of their color than greens
// and purples, sky blues keep nearly all of it, and yellows lean a little
// toward orange.

// Exposure applied to linear color before the curve (ev 0).
export const LYTRO_EXPOSURE = 1.46;
// A slight balance of the linear color before the curve (red, green, blue):
// without it the look leans yellow-green on grays next to Lytro Desktop's.
export const LYTRO_BALANCE = [1.0223, 0.9836, 1.09];
// Lytro Desktop's automatic white balance leans bluer than the camera's own
// at warm light and less blue at daylight. Measured on low saturation
// midtones of 10 photos against its pictures: blue wants about 1.12 at
// 3000 K, falling 0.05 per 1000 K to about 1.0 at 5500 K.
export function lytroBalance(cct) {
  if (!Number.isFinite(cct)) return LYTRO_BALANCE;
  const t = Math.min(2.5, Math.max(0, (cct - 3000) / 1000));
  return [LYTRO_BALANCE[0], LYTRO_BALANCE[1], 1.12 - 0.05 * t];
}
// Color after the curve, per hue: for 12 hues around the opponent plane
// (u = (R - G) / sqrt 2, v = (R + G - 2B) / sqrt 6; 30 degrees is red, 90
// yellow, 150 green, 210 cyan, 270 blue, 330 magenta) the factor [re, im]
// that scales and turns a color's offset from gray there.
export const LYTRO_HUE = [
  [0.908, -0.055],
  [0.860, -0.051],
  [0.787, -0.045],
  [0.984, -0.055],
  [1.125, -0.065],
  [1.096, -0.066],
  [1.048, -0.067],
  [1.005, -0.067],
  [0.980, -0.067],
  [1.003, -0.066],
  [0.987, -0.063],
  [0.954, -0.060],
];
// Curve: encoded output (0..1) for linear input 2^x, x from CURVE_START in
// steps of CURVE_STEP.
export const CURVE_START = -12;
export const CURVE_STEP = 0.5;
export const LYTRO_CURVE = [
  0.0, 0.0078, 0.0078, 0.0079, 0.008, 0.0089, 0.01, 0.0116, 0.0142, 0.018, 0.0225, 0.0294, 0.0398, 0.0565,
  0.0841, 0.1139, 0.1591, 0.2184, 0.2943, 0.374, 0.4432, 0.5262, 0.6225, 0.7172, 0.8445, 0.9709, 1.0, 1.0,
];
// Linear input at which the curve reaches white.
export const CURVE_MAX = 2 ** (CURVE_START + CURVE_STEP * (LYTRO_CURVE.length - 1));

// Encoded output for linear input x.
export function lytroCurve(x) {
  if (!(x > 0)) return 0;
  const t = (Math.log2(x) - CURVE_START) / CURVE_STEP;
  if (t <= 0) return LYTRO_CURVE[0] * (x / 2 ** CURVE_START);
  const i = Math.floor(t);
  if (i >= LYTRO_CURVE.length - 1) return 1;
  return LYTRO_CURVE[i] + (LYTRO_CURVE[i + 1] - LYTRO_CURVE[i]) * (t - i);
}

// Byte lookup for linear input 0..CURVE_MAX in `size` steps.
export function lytroTable(size) {
  const t = new Uint8ClampedArray(size + 1);
  for (let i = 0; i <= size; i++) t[i] = Math.round(255 * lytroCurve((i / size) * CURVE_MAX));
  return t;
}

const U = Math.SQRT1_2;
const V = 1 / Math.sqrt(6);

// Lytro's color per hue on an encoded (0..1) color c, in place; `sat`
// scales it further (the Saturation slider). Brightness is kept.
export function lytroColor(c, sat = 1, exact = false) {
  const [r, g, b] = c;
  const u = U * (r - g);
  const v = V * (r + g - 2 * b);
  if (u === 0 && v === 0) return c;
  let t = (Math.atan2(v, u) / (2 * Math.PI)) * 12;
  if (t < 0) t += 12;
  const i = Math.floor(t) % 12;
  const j = (i + 1) % 12;
  const f = t - Math.floor(t);
  const kr = sat * (exact ? 1 : LYTRO_HUE[i][0] * (1 - f) + LYTRO_HUE[j][0] * f);
  const ki = sat * (exact ? 0 : LYTRO_HUE[i][1] * (1 - f) + LYTRO_HUE[j][1] * f);
  const du = u * kr - v * ki - u;
  const dv = u * ki + v * kr - v;
  let R = r + U * du + V * dv;
  let G = g - U * du + V * dv;
  let B = b - 2 * V * dv;
  const dy = 0.2126 * (r - R) + 0.7152 * (g - G) + 0.0722 * (b - B);
  c[0] = Math.min(1, Math.max(0, R + dy));
  c[1] = Math.min(1, Math.max(0, G + dy));
  c[2] = Math.min(1, Math.max(0, B + dy));
  return c;
}

// The engine's own tone and colour (stage 5 of the engine read): camera RGB in the engine's linear units x the colour matrix (cam.ccm) -> a natural cubic spline T through 14 knots per
// channel (looked up through a 4097 entry table) -> the sRGB encoding. No hue step: `lytroColor` with hue factors (1, 0) is just the saturation slider.
export const ENGINE_KNOTS = [
  [0, 0], [0.01, 0.004], [0.03, 0.02], [0.05, 0.045], [0.076, 0.088], [0.108, 0.143], [0.15, 0.206],
  [0.35, 0.49], [0.54, 0.705], [0.625, 0.786], [0.75, 0.885], [0.865, 0.955], [0.924, 0.981], [1, 1],
];
// Segment coefficients y = a + b t + c t^2 + d t^3, t = x - x_i, of the natural cubic spline.
export function naturalSpline(knots) {
  const n = knots.length - 1;
  const x = knots.map((k) => k[0]);
  const y = knots.map((k) => k[1]);
  const h = Array.from({ length: n }, (_, i) => x[i + 1] - x[i]);
  const alpha = new Array(n + 1).fill(0);
  for (let i = 1; i < n; i++) alpha[i] = (3 / h[i]) * (y[i + 1] - y[i]) - (3 / h[i - 1]) * (y[i] - y[i - 1]);
  const l = new Array(n + 1).fill(1);
  const mu = new Array(n + 1).fill(0);
  const z = new Array(n + 1).fill(0);
  for (let i = 1; i < n; i++) {
    l[i] = 2 * (x[i + 1] - x[i - 1]) - h[i - 1] * mu[i - 1];
    mu[i] = h[i] / l[i];
    z[i] = (alpha[i] - h[i - 1] * z[i - 1]) / l[i];
  }
  const c = new Array(n + 1).fill(0);
  const b = new Array(n).fill(0);
  const d = new Array(n).fill(0);
  for (let j = n - 1; j >= 0; j--) {
    c[j] = z[j] - mu[j] * c[j + 1];
    b[j] = (y[j + 1] - y[j]) / h[j] - (h[j] * (c[j + 1] + 2 * c[j])) / 3;
    d[j] = (c[j + 1] - c[j]) / (3 * h[j]);
  }
  return { x: x.slice(0, n), a: y.slice(0, n), b, c: c.slice(0, n), d };
}
export const ENGINE_SPLINE = naturalSpline(ENGINE_KNOTS);
// T at x (clamped to 0..1, through the engine's 4097 entry nearest lookup).
export function engineTone(x) {
  const v = Math.round(Math.min(1, Math.max(0, x)) * 4095) / 4095;
  const S = ENGINE_SPLINE;
  let i = 0;
  for (let k = 1; k < S.x.length; k++) if (v >= S.x[k]) i = k;
  const t = v - S.x[i];
  return ((S.d[i] * t + S.c[i]) * t + S.b[i]) * t + S.a[i];
}
const srgbEncode = (x) => (x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055);
// Byte lookup for linear input 0..CURVE_MAX in `size` steps (the engine's colour pipeline).
export function engineTable(size) {
  const t = new Uint8ClampedArray(size + 1);
  for (let i = 0; i <= size; i++) t[i] = Math.round(255 * srgbEncode(engineTone(Math.min(1, (i / size) * CURVE_MAX))));
  return t;
}
