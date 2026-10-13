// Details panel: noise reduction and sharpening, Lightroom style. Runs on
// linear RGB before color and tone (gpu/renderer.js mirrors it):
//   1. luminance noise reduction: an edge-preserving (bilateral) average of
//      brightness, judged in a square-root space so shadows and highlights
//      are treated alike
//   2. color noise reduction: each pixel takes the color of a blurred
//      neighborhood (its RGB relative to brightness), keeping its own
//      brightness
//   3. sharpening: an unsharp mask on brightness; Detail 0 holds back strong
//      edges (fewer halos), 100 sharpens everything equally

const LUMA = [0.2126, 0.7152, 0.0722];

// Slider values -> filter parameters, or null when nothing is enabled.
export function makeDetail(settings = {}) {
  const s = settings.details || {};
  const p = {
    amount: (s.amount || 0) / 100, // 0..1.5
    radius: s.radius || 1, // pixels, 0.5..3
    detail: (s.detail ?? 25) / 100, // 0..1
    luminance: (s.luminance || 0) / 100, // 0..1
    color: (s.color || 0) / 100, // 0..1
  };
  return p.amount > 0 || p.luminance > 0 || p.color > 0 ? p : null;
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
// Edge strength (in square-root brightness) beyond which Detail 0 stops
// adding sharpening.
export const HALO_LIMIT = 0.03;

function sharpenDelta(diff, p) {
  const limited = Math.max(-HALO_LIMIT, Math.min(HALO_LIMIT, diff));
  return 1.5 * p.amount * (diff * p.detail + limited * (1 - p.detail));
}

// rgb: linear RGB (w x h). Returns a new array.
export function applyDetail(rgb, w, h, p) {
  if (!p) return rgb;
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
        S3[i0] = Math.max(0, S2[i0] + sharpenDelta(S2[i0] - s / gs, p));
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
