// The Lytro Desktop look: how Lytro Desktop turns linear color into the
// picture it shows, so photos open looking as they do there.
//
// Measured on four ILLUM photos against Lytro Desktop's own renderings of
// them (stack.lfp, untouched edits): Lytro keeps the camera's exposure (a
// fixed gain over our white-level scaled raw, where our flat look picks an
// exposure per photo), then puts each channel through a film-like curve
// with a deep toe and a soft shoulder, and lowers saturation a little to
// offset what the curve adds. Against Lytro's pictures this is 2 to 11
// times closer than the flat look.

// Exposure applied to linear color before the curve (ev 0).
export const LYTRO_EXPOSURE = 1.46;
// Saturation in the encoded picture after the curve.
export const LYTRO_SATURATION = 0.7;
// Curve: encoded output (0..1) for linear input 2^x, x from CURVE_START in
// steps of CURVE_STEP.
export const CURVE_START = -12;
export const CURVE_STEP = 0.5;
export const LYTRO_CURVE = [
  0, 0.0045, 0.006, 0.009, 0.0105, 0.012, 0.0138, 0.0157, 0.0172, 0.0196, 0.0233, 0.0275, 0.0361, 0.0537,
  0.0824, 0.1098, 0.1503, 0.2151, 0.2824, 0.3509, 0.4301, 0.5216, 0.6093, 0.6897, 0.7747, 0.86, 0.94, 1,
];
// Linear input at which the curve reaches white.
export const CURVE_MAX = 2 ** (CURVE_START + CURVE_STEP * (LYTRO_CURVE.length - 1));

// Encoded output for linear input x.
export function lytroCurve(x) {
  if (!(x > 0)) return 0;
  const t = (Math.log2(x) - CURVE_START) / CURVE_STEP;
  if (t <= 0) return LYTRO_CURVE[0] + (LYTRO_CURVE[1] - LYTRO_CURVE[0]) * Math.max(0, x / 2 ** CURVE_START);
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
