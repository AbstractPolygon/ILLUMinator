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
// Color after the curve, per hue: for 12 hues around the opponent plane
// (u = (R - G) / sqrt 2, v = (R + G - 2B) / sqrt 6; 30 degrees is red, 90
// yellow, 150 green, 210 cyan, 270 blue, 330 magenta) the factor [re, im]
// that scales and turns a color's offset from gray there.
export const LYTRO_HUE = [
  [0.855, -0.222],
  [0.839, -0.081],
  [0.807, -0.089],
  [0.824, -0.131],
  [0.838, -0.214],
  [0.860, 0.000],
  [0.966, 0.098],
  [1.060, 0.026],
  [1.034, 0.008],
  [0.888, 0.002],
  [0.634, -0.094],
  [0.719, -0.249],
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
export function lytroColor(c, sat = 1) {
  const [r, g, b] = c;
  const u = U * (r - g);
  const v = V * (r + g - 2 * b);
  if (u === 0 && v === 0) return c;
  let t = (Math.atan2(v, u) / (2 * Math.PI)) * 12;
  if (t < 0) t += 12;
  const i = Math.floor(t) % 12;
  const j = (i + 1) % 12;
  const f = t - Math.floor(t);
  const kr = sat * (LYTRO_HUE[i][0] * (1 - f) + LYTRO_HUE[j][0] * f);
  const ki = sat * (LYTRO_HUE[i][1] * (1 - f) + LYTRO_HUE[j][1] * f);
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
