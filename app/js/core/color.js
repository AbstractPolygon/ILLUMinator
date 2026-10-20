// Color adjustments from the Color panel, Lightroom style. Every slider runs
// from -1 to 1 with 0 meaning "as shot".
//
// White balance (temperature, tint) is folded into the color matrix as
// per-channel gains on camera RGB. The rest runs per pixel on linear output
// RGB after exposure (see applyLook; gpu/renderer.js mirrors it):
//   tone: contrast, highlights, shadows, whites and blacks reshape a curve on
//         luminance in a gamma 2.2 space, keeping each pixel's hue
//   saturation: vibrance (favours muted colors) and six hue ranges
// The overall saturation slider is part of the color matrix.

export const HUES = ['red', 'yellow', 'green', 'cyan', 'blue', 'magenta'];

// Linear RGB of light from a black body at `kelvin` (1000-40000 K), after
// Tanner Helland's fit, with green = 1.
export function blackBody(kelvin) {
  const t = Math.min(400, Math.max(10, kelvin / 100));
  const r = t <= 66 ? 255 : 329.698727446 * Math.pow(t - 60, -0.1332047592);
  const g = t <= 66 ? 99.4708025861 * Math.log(t) - 161.1195681661 : 288.1221695283 * Math.pow(t - 60, -0.0755148492);
  const b = t >= 66 ? 255 : t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  const lin = (v) => {
    const c = Math.min(1, Math.max(1e-3, v / 255));
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  const G = lin(g);
  return [lin(r) / G, 1, lin(b) / G];
}

// Lytro Desktop's own white balance: the red and blue gains (green = 1) that
// it stores for a photo whose temperature and tint are T and t, fitted to
// eleven ILLUM photos set to Auto (their gains from stack.preadjust.lfp, their
// temperature and tint from stack.view.lfp). ln gain = a + b x + c x^2 + d t,
// x = 1000 / kelvin. It reproduces those gains to 0.4% (0.8% leaving one photo
// out, and on a twelfth set to Daylight). Tint moves red and blue together by
// 0.084% a step, a third of what the old blackbody math did.
const LD_WB = {
  r: [0.900531, -3.792749, 3.341364, 0.000836],
  b: [-0.303873, 3.712129, -3.190405, 0.000847],
};
const lnGain = (c, x, t) => c[0] + c[1] * x + c[2] * x * x + c[3] * t;

// Camera RGB gains that re-balance a picture white balanced for `asShot`
// kelvin as if for `kelvin` (higher looks warmer, like Lightroom), and add
// tint (-150 green to 150 magenta), the way Lytro Desktop's temperature and
// tint move its gains. Normalized to keep luminance.
export function whiteBalanceGains(kelvin, asShot, tint = 0) {
  const x = 1000 / kelvin;
  const x0 = 1000 / asShot;
  const r = Math.exp(lnGain(LD_WB.r, x, tint) - lnGain(LD_WB.r, x0, 0));
  const b = Math.exp(lnGain(LD_WB.b, x, tint) - lnGain(LD_WB.b, x0, 0));
  const y = 0.2126 * r + 0.7152 + 0.0722 * b;
  return [r / y, 1 / y, b / y];
}

import { curveTable, curveAt } from './curve.js';

export const DEFAULT_KELVIN = 5500;

// Lytro Desktop's Auto white balance: the camera's own estimate. Read from
// Middleware.dll (awb2.cpp), LFE's automatic white balance is the same
// estimator the camera runs: it averages the picture's colors weighted by a
// per-product table of plausible neutrals (a 64 x 64 map over sqrt(R)+sqrt(B)
// -2 sqrt(G) and sqrt(B)-sqrt(R)), then reports a temperature and tint
// against the camera's calibration. On eleven library photos set to Auto its
// temperature is within 3% of the camera's (the cct in the photo) and its tint
// follows the camera gains (green over the root of red times blue), so the
// gains stored in the photo are Lytro Desktop's Auto. Photos without them
// (processed pictures, other sources) fall back to the gray world estimate.
const AUTO_FLAT = [1, 1, 1];
export function autoWhiteBalance(means, cam) {
  const wb = cam && cam.wb;
  if (wb && wb.some((g) => Math.abs(g - 1) > 1e-4)) return { auto: AUTO_FLAT, manual: AUTO_FLAT };
  return { auto: means.map((m) => means[1] / m), manual: AUTO_FLAT };
}

// The per-pixel adjustments, or null when they are all at zero.
export function makeLook(settings = {}) {
  const tone = settings.tone || {};
  const sat = settings.color || {};
  const look = {
    contrast: tone.contrast || 0,
    highlights: tone.highlights || 0,
    shadows: tone.shadows || 0,
    whites: tone.whites || 0,
    blacks: tone.blacks || 0,
    vibrance: sat.vibrance || 0,
    hues: HUES.map((h) => sat[h] || 0),
    // Tone curve table (core/curve.js), or null.
    curve: settings.curve ? curveTable(settings.curve) : null,
  };
  const active = look.contrast || look.highlights || look.shadows || look.whites || look.blacks
    || look.vibrance || look.hues.some((v) => v) || look.curve;
  return active ? look : null;
}

function smooth(x) {
  const t = x < 0 ? 0 : x > 1 ? 1 : x;
  return t * t * (3 - 2 * t);
}

// Tone curve on gamma-encoded luminance x (0 = black, 1 = white).
export function toneCurve(x, look) {
  // Whites and blacks move the end points.
  const black = -0.12 * look.blacks;
  const white = 1 - 0.15 * look.whites;
  x = (x - black) / (white - black);
  // Shadows lift or deepen the lower part, highlights the upper part.
  const c = x < 0 ? 0 : x > 1 ? 1 : x;
  x += look.shadows * 0.85 * c * (1 - c) * (1 - c);
  x += look.highlights * 0.85 * c * c * (1 - c);
  // Contrast blends toward (or away from) an S curve.
  x += look.contrast * 0.8 * (smooth(x) - (x < 0 ? 0 : x > 1 ? 1 : x));
  if (look.curve) x = curveAt(look.curve, x);
  return x < 0 ? 0 : x;
}

function hueOf(r, g, b, mx, d) {
  let h;
  if (mx === r) h = ((g - b) / d) % 6;
  else if (mx === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}

// Adjusts one linear RGB pixel in place in `px` (length 3).
export function applyLook(px, look) {
  let r = px[0];
  let g = px[1];
  let b = px[2];
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  if (y > 1e-6) {
    const x = toneCurve(Math.pow(y, 1 / 2.2), look);
    const k = Math.pow(x, 2.2) / y;
    r *= k;
    g *= k;
    b *= k;
  }
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const d = mx - mn;
  if (d > 1e-6 && mx > 1e-6) {
    const s = d / mx;
    const h = hueOf(r, g, b, mx, d);
    // Each hue slider covers +-60 degrees around its center.
    let f = 1 + look.vibrance * (1 - s) * 0.9;
    for (let i = 0; i < 6; i++) {
      if (!look.hues[i]) continue;
      const dh = Math.abs(((h - i * 60 + 540) % 360) - 180);
      if (dh < 60) f += look.hues[i] * (1 - dh / 60);
    }
    if (f < 0) f = 0;
    const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    r = l + (r - l) * f;
    g = l + (g - l) * f;
    b = l + (b - l) * f;
  }
  px[0] = r;
  px[1] = g;
  px[2] = b;
}

// Eyedropper: the temperature (kelvin) and tint that make `rgb` (one color
// before white balance, in the camera's RGB) neutral after `matrix` (the
// color matrix without white balance). Searches the slider ranges.
export function solveWhiteBalance(rgb, matrix, asShot) {
  const cost = (kelvin, tint) => {
    const g = whiteBalanceGains(kelvin, asShot, tint);
    const c = [rgb[0] * g[0], rgb[1] * g[1], rgb[2] * g[2]];
    const r = matrix[0] * c[0] + matrix[1] * c[1] + matrix[2] * c[2];
    const gr = matrix[3] * c[0] + matrix[4] * c[1] + matrix[5] * c[2];
    const b = matrix[6] * c[0] + matrix[7] * c[1] + matrix[8] * c[2];
    const y = Math.max(1e-9, (r + gr + b) / 3);
    return ((r - gr) / y) ** 2 + ((b - gr) / y) ** 2;
  };
  let best = { kelvin: asShot, tint: 0, cost: Infinity };
  for (let k = 2000; k <= 10000; k += 100) {
    for (let t = -150; t <= 150; t += 5) {
      const c = cost(k, t);
      if (c < best.cost) best = { kelvin: k, tint: t, cost: c };
    }
  }
  // Refine to the sliders' steps (50 K, 1).
  const { kelvin: k0, tint: t0 } = best;
  for (let k = Math.max(2000, k0 - 100); k <= Math.min(10000, k0 + 100); k += 50) {
    for (let t = Math.max(-150, t0 - 5); t <= Math.min(150, t0 + 5); t++) {
      const c = cost(k, t);
      if (c < best.cost) best = { kelvin: k, tint: t, cost: c };
    }
  }
  return { kelvin: best.kelvin, tint: best.tint };
}
