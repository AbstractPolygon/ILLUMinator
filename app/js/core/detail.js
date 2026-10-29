// Details panel: noise reduction and sharpening, Lightroom style. Runs on
// linear RGB before color and tone (gpu/renderer.js mirrors it):
//   0. spot removal: Speckles clamps single pixels that stand out from all
//      eight neighbors (hot, dead and stray pixels) to the neighbors'
//      range; Dust fills small, faint dark spots (sensor and lens dust)
//      from their surroundings, found by a grayscale closing of a lightly
//      blurred brightness. Only gentle darkening is lifted, so dark detail
//      like eyes and lettering stays
//   1. luminance noise reduction: an edge-preserving (bilateral) average of
//      brightness, judged in a square-root space so shadows and highlights
//      are treated alike
//   2. color noise reduction: each pixel takes the color of a blurred
//      neighborhood (its RGB relative to brightness), keeping its own
//      brightness
//   3. sharpening: an unsharp mask on brightness; Detail 0 holds back strong
//      edges (fewer halos), 100 sharpens everything equally; Masking limits
//      it to edges (0 everywhere, 100 only the strongest edges), so smooth
//      areas like skin and sky stay smooth

const LUMA = [0.2126, 0.7152, 0.0722];

// Slider values -> filter parameters, or null when nothing is enabled.
export function makeDetail(settings = {}) {
  const s = settings.details || {};
  const p = {
    amount: (s.amount || 0) / 100, // 0..1.5
    radius: s.radius || 1, // pixels, 0.5..3
    detail: (s.detail ?? 25) / 100, // 0..1
    masking: (s.masking || 0) / 100, // 0..1
    luminance: (s.luminance || 0) / 100, // 0..1
    color: (s.color || 0) / 100, // 0..1
    dust: (s.dust || 0) / 100, // 0..1
    speckle: (s.speckle || 0) / 100, // 0..1
    speckleSize: Math.max(1, Math.min(5, Math.round(s.speckleSize || 2))), // pixels
  };
  // The engine's own sharpening (Lytro Desktop's recipe path ignores the slider's size and only switches a fixed unsharp mask on): the slider's 25 is the engine's, other values scale it.
  p.engine = settings.engineSharpen === true && settings.lytroLook !== false && p.amount > 0 ? Math.min(3, (s.amount || 0) / 25) : 0;
  if (p.engine) p.amount = 0;
  return p.engine > 0 || p.amount > 0 || p.luminance > 0 || p.color > 0 || p.dust > 0 || p.speckle > 0 ? p : null;
}

// Sharpening radius is set for a picture one pixel per lens wide (the view).
// A render with more pixels per lens has finer pixels, so its radius grows to
// keep the same look: 1.5 at 3 pixels per lens, 2 at 4 (measured against
// Lytro Desktop's sharpness on 10 photos at 4x). `lensColumns`: lens columns
// across the picture at one pixel per lens.
export function detailForSize(p, width, lensColumns) {
  if (!p || !(lensColumns > 0)) return p;
  const f = Math.max(1, width / lensColumns / 2);
  return f === 1 ? p : { ...p, radius: Math.min(3, p.radius * f) };
}

// Window half-sizes and filter constants, shared with the GPU shaders.
export const NR_RADIUS = 2; // luminance: 5 x 5
export const CHROMA_RADIUS = 6; // color: up to 13 x 13
export function chromaSigma(p) {
  return 0.5 + 2.5 * p.color;
}
export function rangeSigma(p) {
  return 0.01 + 0.09 * p.luminance;
}
export function sharpenWindow(p) {
  return Math.min(6, Math.ceil(2 * p.radius));
}
// Despeckle: how far (in square-root brightness, per channel) a speck must
// stand out from its surroundings (see removeSpeckles).
export function speckleThreshold(p) {
  return 0.01 + 0.3 * (1 - p.speckle) ** 2;
}
// Dust: the largest spot filled, as a half size in pixels.
export function dustRadius(p) {
  return 1 + Math.round(9 * p.dust);
}
// Dust: how much of a spot's darkening is lifted, from its brightness
// relative to the filled surroundings (r = blurred Y / closed Y). Faint
// spots (r near 1 down to 0.5) are lifted fully, strong dark detail not.
export const DUST_LOW = 0.35;
export const DUST_HIGH = 0.5;
export function dustGain(r) {
  if (!(r > 0) || r >= 1) return 1;
  const x = Math.min(1, Math.max(0, (r - DUST_LOW) / (DUST_HIGH - DUST_LOW)));
  return 1 + x * x * (3 - 2 * x) * (1 / r - 1);
}
const BLUR5 = [0.0545, 0.2442, 0.4026, 0.2442, 0.0545]; // Gaussian, sigma 1

// Edge strength (in square-root brightness) beyond which Detail 0 stops
// adding sharpening.
export const HALO_LIMIT = 0.03;

// Edge mask for sharpening from the brightness gradient g (square-root
// brightness per pixel): 1 everywhere at Masking 0, only strong edges at 1.
export function edgeMask(g, masking) {
  if (!(masking > 0)) return 1;
  const t = 0.06 * masking;
  const x = Math.min(1, Math.max(0, (g - 0.5 * t) / t));
  return x * x * (3 - 2 * x);
}

function sharpenDelta(diff, p) {
  const limited = Math.max(-HALO_LIMIT, Math.min(HALO_LIMIT, diff));
  return 1.5 * p.amount * (diff * p.detail + limited * (1 - p.detail));
}

// rgb: linear RGB (w x h). Returns a new array.
export function applyDetail(rgb, w, h, p) {
  if (!p) return rgb;
  if (p.speckle > 0) rgb = removeSpeckles(rgb, w, h, p);
  if (p.dust > 0) rgb = removeDust(rgb, w, h, p);
  if (!(p.amount > 0 || p.luminance > 0 || p.color > 0)) return rgb;
  const n = w * h;
  const Y = new Float32Array(n);
  const S = new Float32Array(n); // sqrt(Y)
  for (let i = 0; i < n; i++) {
    const y = Math.max(0, LUMA[0] * rgb[3 * i] + LUMA[1] * rgb[3 * i + 1] + LUMA[2] * rgb[3 * i + 2]);
    Y[i] = y;
    S[i] = Math.sqrt(y);
  }

  // 1. Luminance: bilateral average of sqrt(Y).
  let S2 = S;
  if (p.luminance > 0) {
    S2 = new Float32Array(n);
    const sr = rangeSigma(p);
    const k = -0.5 / (sr * sr);
    const ks = -0.5 / (1.5 * 1.5);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const c = S[y * w + x];
        let sum = 0;
        let wsum = 0;
        for (let dy = -NR_RADIUS; dy <= NR_RADIUS; dy++) {
          const yy = Math.min(h - 1, Math.max(0, y + dy));
          for (let dx = -NR_RADIUS; dx <= NR_RADIUS; dx++) {
            const xx = Math.min(w - 1, Math.max(0, x + dx));
            const v = S[yy * w + xx];
            const d = v - c;
            const wt = Math.exp(ks * (dx * dx + dy * dy) + k * d * d);
            sum += v * wt;
            wsum += wt;
          }
        }
        S2[y * w + x] = sum / wsum;
      }
    }
  }

  // 2. Color: Gaussian blur of RGB (separable); the color is the blurred
  // RGB divided by its brightness.
  const out = new Float32Array(rgb.length);
  if (p.color > 0) {
    const sigma = chromaSigma(p);
    const r = CHROMA_RADIUS;
    const g = [];
    for (let i = -r; i <= r; i++) g.push(Math.exp(-0.5 * (i / sigma) ** 2));
    const C = rgb;
    const T = new Float32Array(rgb.length);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        for (let c = 0; c < 3; c++) {
          let s = 0;
          let ws = 0;
          for (let i = -r; i <= r; i++) {
            const xx = Math.min(w - 1, Math.max(0, x + i));
            s += C[3 * (y * w + xx) + c] * g[i + r];
            ws += g[i + r];
          }
          T[3 * (y * w + x) + c] = s / ws;
        }
      }
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        for (let c = 0; c < 3; c++) {
          let s = 0;
          let ws = 0;
          for (let i = -r; i <= r; i++) {
            const yy = Math.min(h - 1, Math.max(0, y + i));
            s += T[3 * (yy * w + x) + c] * g[i + r];
            ws += g[i + r];
          }
          out[3 * (y * w + x) + c] = s / ws;
        }
      }
    }
  } else {
    out.set(rgb);
  }
  // Color as RGB relative to brightness.
  for (let i = 0; i < n; i++) {
    const o = 3 * i;
    const y = LUMA[0] * out[o] + LUMA[1] * out[o + 1] + LUMA[2] * out[o + 2];
    if (y > 1e-9) {
      out[o] /= y;
      out[o + 1] /= y;
      out[o + 2] /= y;
    } else {
      out[o] = out[o + 1] = out[o + 2] = 1;
    }
  }

  // 3. Sharpening: unsharp mask on the noise-reduced sqrt(Y).
  let S3 = S2;
  if (p.amount > 0) {
    const sigma = p.radius;
    const r = sharpenWindow(p);
    const g = [];
    for (let i = -r; i <= r; i++) g.push(Math.exp(-0.5 * (i / sigma) ** 2));
    const gs = g.reduce((a, b) => a + b, 0);
    const T = new Float32Array(n);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0;
        for (let i = -r; i <= r; i++) s += S2[y * w + Math.min(w - 1, Math.max(0, x + i))] * g[i + r];
        T[y * w + x] = s / gs;
      }
    }
    S3 = new Float32Array(n);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0;
        for (let i = -r; i <= r; i++) s += T[Math.min(h - 1, Math.max(0, y + i)) * w + x] * g[i + r];
        const i0 = y * w + x;
        let mask = 1;
        if (p.masking > 0) {
          const gx = S2[y * w + Math.min(w - 1, x + 1)] - S2[y * w + Math.max(0, x - 1)];
          const gy = S2[Math.min(h - 1, y + 1) * w + x] - S2[Math.max(0, y - 1) * w + x];
          mask = edgeMask(0.5 * Math.hypot(gx, gy), p.masking);
        }
        S3[i0] = Math.max(0, S2[i0] + mask * sharpenDelta(S2[i0] - s / gs, p));
      }
    }
  }

  // Recombine: color times the new brightness.
  for (let i = 0; i < n; i++) {
    const y = S3[i] * S3[i];
    for (let c = 0; c < 3; c++) out[3 * i + c] = Math.max(0, out[3 * i + c] * y);
  }
  return out;
}

// Despeckle: a pixel belongs to a speck when, in a channel, it stands out
// by more than the threshold from every pixel on the square ring `size`
// pixels around it. A speck up to `size` pixels across never reaches that
// ring; anything larger, and any line or edge, does, and is kept. A speck
// takes the mean of the ring (the background around it).
export function speckRing(size) {
  const ring = [];
  for (let d = -size; d <= size; d++) {
    ring.push([d, -size], [d, size]);
    if (Math.abs(d) < size) ring.push([-size, d], [size, d]);
  }
  return ring;
}

export function removeSpeckles(rgb, w, h, p) {
  const t = speckleThreshold(p);
  const ring = speckRing(p.speckleSize);
  const out = new Float32Array(rgb.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      for (let c = 0; c < 3; c++) {
        let lo = Infinity;
        let hi = -Infinity;
        let sum = 0;
        for (const [dx, dy] of ring) {
          const xx = Math.min(w - 1, Math.max(0, x + dx));
          const yy = Math.min(h - 1, Math.max(0, y + dy));
          const v = Math.sqrt(Math.max(0, rgb[3 * (yy * w + xx) + c]));
          if (v < lo) lo = v;
          if (v > hi) hi = v;
          sum += v;
        }
        const v = Math.sqrt(Math.max(0, rgb[3 * i + c]));
        const m = sum / ring.length;
        out[3 * i + c] = v > hi + t || v < lo - t ? m * m : rgb[3 * i + c];
      }
    }
  }
  return out;
}

// One separable pass over a single-channel image along x (dir 0) or y
// (dir 1): 'max', 'min' or 'blur' (BLUR5).
function pass1(src, w, h, dir, r, mode) {
  const out = new Float32Array(src.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let m = mode === 'max' ? -Infinity : mode === 'min' ? Infinity : 0;
      for (let k = -r; k <= r; k++) {
        const xx = dir ? x : Math.min(w - 1, Math.max(0, x + k));
        const yy = dir ? Math.min(h - 1, Math.max(0, y + k)) : y;
        const v = src[yy * w + xx];
        if (mode === 'max') m = Math.max(m, v);
        else if (mode === 'min') m = Math.min(m, v);
        else m += v * BLUR5[k + 2];
      }
      out[y * w + x] = m;
    }
  }
  return out;
}

// Lifts small dark spots to the level of their surroundings.
export function removeDust(rgb, w, h, p) {
  const n = w * h;
  let Y = new Float32Array(n);
  for (let i = 0; i < n; i++) Y[i] = Math.max(0, LUMA[0] * rgb[3 * i] + LUMA[1] * rgb[3 * i + 1] + LUMA[2] * rgb[3 * i + 2]);
  const B = pass1(pass1(Y, w, h, 0, 2, 'blur'), w, h, 1, 2, 'blur');
  const r = dustRadius(p);
  let C = pass1(pass1(B, w, h, 0, r, 'max'), w, h, 1, r, 'max');
  C = pass1(pass1(C, w, h, 0, r, 'min'), w, h, 1, r, 'min');
  const out = new Float32Array(rgb.length);
  for (let i = 0; i < n; i++) {
    const g = C[i] > 1e-9 ? dustGain(B[i] / C[i]) : 1;
    for (let c = 0; c < 3; c++) out[3 * i + c] = rgb[3 * i + c] * g;
  }
  return out;
}

// The engine's unsharp mask (stage 5 of the engine read, SmoothlyVaryingUnsharpMaskImage at the ILLUM's baseline bank): on the picture after the tone curve and before the sRGB
// encoding, a Gaussian unsharp mask of the Lab lightness L* (a and b untouched), sigma = 0.38 lens pitches (the picture is 7728 / 14.29 = 540.8 lens pitches wide), amount 1.5,
// a soft threshold of 0.4 L*. Fitted against the engine's own render of b4-1 (no halo limiter: it fitted worse). `scale` scales the amount.
export const ENGINE_USM = { amount: 1.5, radius: 0.38, threshold: 0.4, lensColumns: 540.8 };
const XYZ_RGB = [0.4124564, 0.3575761, 0.1804375, 0.2126729, 0.7151522, 0.0721750, 0.0193339, 0.1191920, 0.9503041];
const RGB_XYZ = [3.2404542, -1.5371385, -0.4985314, -0.9692660, 1.8760108, 0.0415560, 0.0556434, -0.2040259, 1.0572252];
const SRGB_DEC = Float32Array.from({ length: 256 }, (_, i) => {
  const v = i / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
});
const srgbEnc = (x) => 255 * (x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055);
const labF = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787037 * t + 0.137931);
const labFinv = (f) => (f > 0.206893 ? f * f * f : (f - 0.137931) / 7.787037);

// px: RGBA bytes (w x h), changed in place.
export function engineUnsharp(px, w, h, scale = 1) {
  if (!(scale > 0)) return px;
  const sigma = (w / ENGINE_USM.lensColumns) * (globalThis.__usmRadius ?? ENGINE_USM.radius);
  const r = Math.ceil(2.6 * sigma);
  const g = [];
  let gs = 0;
  for (let i = -r; i <= r; i++) {
    const v = Math.exp(-0.5 * (i / sigma) ** 2);
    g.push(v);
    gs += v;
  }
  const n = w * h;
  const Y = new Float32Array(n);
  for (let i = 0; i < n; i++) Y[i] = 116 * labF(XYZ_RGB[3] * SRGB_DEC[px[4 * i]] + XYZ_RGB[4] * SRGB_DEC[px[4 * i + 1]] + XYZ_RGB[5] * SRGB_DEC[px[4 * i + 2]]) - 16;
  const T = new Float32Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let a = 0;
      for (let i = -r; i <= r; i++) a += Y[y * w + Math.min(w - 1, Math.max(0, x + i))] * g[i + r];
      T[y * w + x] = a / gs;
    }
  }
  const amount = (globalThis.__usmAmount ?? ENGINE_USM.amount) * scale;
  const thr = ENGINE_USM.threshold;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let a = 0;
      for (let i = -r; i <= r; i++) a += T[Math.min(h - 1, Math.max(0, y + i)) * w + x] * g[i + r];
      const i = y * w + x;
      const d = Y[i] - a / gs;
      const core = Math.abs(d) >= thr ? d - Math.sign(d) * thr : 0;
      if (core === 0) continue;
      const o = 4 * i;
      const R = SRGB_DEC[px[o]];
      const G = SRGB_DEC[px[o + 1]];
      const B = SRGB_DEC[px[o + 2]];
      const X = XYZ_RGB[0] * R + XYZ_RGB[1] * G + XYZ_RGB[2] * B;
      const Yc = XYZ_RGB[3] * R + XYZ_RGB[4] * G + XYZ_RGB[5] * B;
      const Z = XYZ_RGB[6] * R + XYZ_RGB[7] * G + XYZ_RGB[8] * B;
      const fY = labF(Yc);
      const aa = 500 * (labF(X / 0.95047) - fY);
      const bb = 200 * (fY - labF(Z / 1.08883));
      const fN = (Y[i] + amount * core + 16) / 116;
      const Yn = labFinv(fN);
      const X2 = 0.95047 * labFinv(fN + aa / 500);
      const Z2 = 1.08883 * labFinv(fN - bb / 200);
      px[o] = srgbEnc(Math.min(1, Math.max(0, RGB_XYZ[0] * X2 + RGB_XYZ[1] * Yn + RGB_XYZ[2] * Z2)));
      px[o + 1] = srgbEnc(Math.min(1, Math.max(0, RGB_XYZ[3] * X2 + RGB_XYZ[4] * Yn + RGB_XYZ[5] * Z2)));
      px[o + 2] = srgbEnc(Math.min(1, Math.max(0, RGB_XYZ[6] * X2 + RGB_XYZ[7] * Yn + RGB_XYZ[8] * Z2)));
    }
  }
  return px;
}
