// Defringing, in the spirit of Lightroom's tool: purple, green, red and blue color
// fringes appear along high-contrast edges (lens chromatic aberration, and
// here also light field sampling). Pixels near such edges whose hue falls in
// one of the chosen hue ranges lose that color; everything else is left
// alone. autoDefringe() picks the colors and amounts from the picture.

const HUE_WIDTH = 35; // degrees either side of the chosen hue

function hueOf(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d <= 1e-9) return -1;
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

// rgb: linear sRGB (w x h), modified copy returned.
// options: { on, radius (pixels searched for an edge), threshold (contrast
// that counts as an edge, 0..1), colors: [[amount 0..1, hue degrees], ...] }.
export function defringe(rgb, w, h, { on = true, radius = 2, threshold = 0.25, colors = [] } = {}) {
  const ranges = colors.filter(([amount]) => amount > 0);
  if (!on || !ranges.length) return rgb;
  const n = w * h;
  const lum = new Float32Array(n);
  for (let i = 0; i < n; i++) lum[i] = 0.2126 * rgb[3 * i] + 0.7152 * rgb[3 * i + 1] + 0.0722 * rgb[3 * i + 2];
  // Local contrast: brightness range in a window relative to its maximum.
  const R = Math.max(1, Math.round(radius));
  const rowMax = new Float32Array(n);
  const rowMin = new Float32Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let mx = 0;
      let mn = Infinity;
      for (let k = Math.max(0, x - R); k <= Math.min(w - 1, x + R); k++) {
        const v = lum[y * w + k];
        if (v > mx) mx = v;
        if (v < mn) mn = v;
      }
      rowMax[y * w + x] = mx;
      rowMin[y * w + x] = mn;
    }
  }
  const out = new Float32Array(rgb);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let mx = 0;
      let mn = Infinity;
      for (let k = Math.max(0, y - R); k <= Math.min(h - 1, y + R); k++) {
        const i = k * w + x;
        if (rowMax[i] > mx) mx = rowMax[i];
        if (rowMin[i] < mn) mn = rowMin[i];
      }
      const contrast = mx > 1e-6 ? (mx - mn) / mx : 0;
      const edge = Math.max(0, Math.min(1, (contrast - threshold) / 0.35));
      if (edge <= 0) continue;
      const p = y * w + x;
      const r = rgb[3 * p];
      const g = rgb[3 * p + 1];
      const b = rgb[3 * p + 2];
      // Hue judged on gamma-encoded values, closer to how it looks. (The
      // color matrix can leave small negative values: clamp them.)
      const hue = hueOf(Math.sqrt(Math.max(0, r)), Math.sqrt(Math.max(0, g)), Math.sqrt(Math.max(0, b)));
      if (hue < 0) continue;
      let k = 0;
      for (const [amount, center] of ranges) {
        const dh = Math.abs(((hue - center + 540) % 360) - 180);
        k = Math.max(k, amount * Math.max(0, 1 - dh / HUE_WIDTH));
      }
      if (k <= 0) continue;
      const keep = 1 - k * edge;
      const Y = lum[p];
      out[3 * p] = Y + (r - Y) * keep;
      out[3 * p + 1] = Y + (g - Y) * keep;
      out[3 * p + 2] = Y + (b - Y) * keep;
    }
  }
  return out;
}

// Fringe colors in the order of the Defringe panel, with the hue range each
// covers and its default hue.
// `likely` is the narrower range auto defringe considers: the colors lens
// and light field fringes actually take (purple-magenta, green, orange-
// yellow, blue), not every red or green in the scene.
export const FRINGE_BANDS = [
  { name: 'purple', min: 240, max: 340, hue: 300, likely: [265, 330] },
  { name: 'green', min: 50, max: 160, hue: 100, likely: [80, 150] },
  { name: 'red', min: -30, max: 60, hue: 0, likely: [20, 60] },
  { name: 'blue', min: 180, max: 260, hue: 220, likely: [195, 245] },
];

function inLikely(hue, band) {
  const [lo, hi] = band.likely;
  return hue >= lo && hue <= hi;
}

// Local contrast per pixel: brightness range in a (2r+1)^2 window relative
// to its maximum.
function localContrast(lum, w, h, r) {
  const n = w * h;
  const rowMax = new Float32Array(n);
  const rowMin = new Float32Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let mx = 0;
      let mn = Infinity;
      for (let k = Math.max(0, x - r); k <= Math.min(w - 1, x + r); k++) {
        const v = lum[y * w + k];
        if (v > mx) mx = v;
        if (v < mn) mn = v;
      }
      rowMax[y * w + x] = mx;
      rowMin[y * w + x] = mn;
    }
  }
  const out = new Float32Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let mx = 0;
      let mn = Infinity;
      for (let k = Math.max(0, y - r); k <= Math.min(h - 1, y + r); k++) {
        const i = k * w + x;
        if (rowMax[i] > mx) mx = rowMax[i];
        if (rowMin[i] < mn) mn = rowMin[i];
      }
      out[y * w + x] = mx > 1e-6 ? (mx - mn) / mx : 0;
    }
  }
  return out;
}

// Auto defringe: fringes are thin lines of color (1-2 pixels) along
// high-contrast edges. A colored edge pixel counts as fringe when little of
// the same color surrounds it, so the outline of a colored object does not.
// Each fringe color gets an amount from how much of the edges it covers,
// and the hue where it peaks.
// rgb: linear output RGB (w x h). Returns [[amount, hue], ...] per band.
// `stats`, when given, receives the measured edge shares (for tuning).
export function autoDefringe(rgb, w, h, { radius = 2, threshold = 0.25, stats = null } = {}) {
  const n = w * h;
  const lum = new Float32Array(n);
  for (let i = 0; i < n; i++) lum[i] = 0.2126 * rgb[3 * i] + 0.7152 * rgb[3 * i + 1] + 0.0722 * rgb[3 * i + 2];
  const contrast = localContrast(lum, w, h, Math.max(1, Math.round(radius)));
  // Band membership (bit k) of strongly colored pixels, and their hue.
  const bands = new Uint8Array(n);
  const hues = new Float32Array(n);
  const sats = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const r = Math.sqrt(Math.max(0, rgb[3 * i]));
    const g = Math.sqrt(Math.max(0, rgb[3 * i + 1]));
    const b = Math.sqrt(Math.max(0, rgb[3 * i + 2]));
    const mx = Math.max(r, g, b);
    const sat = mx > 0.05 ? (mx - Math.min(r, g, b)) / mx : 0;
    if (sat < 0.2) continue;
    const hue = hueOf(r, g, b);
    hues[i] = hue;
    sats[i] = sat;
    FRINGE_BANDS.forEach((band, k) => {
      if (inLikely(hue, band)) bands[i] |= 1 << k;
    });
  }
  const mass = FRINGE_BANDS.map(() => 0);
  const hueSum = FRINGE_BANDS.map(() => [0, 0]);
  let edges = 0;
  const R = 2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      // Strong edges only: fringing shows at bright/dark boundaries, not in
      // texture.
      if (contrast[i] <= Math.max(0.6, threshold + 0.1)) continue;
      edges++;
      if (!bands[i]) continue;
      FRINGE_BANDS.forEach((band, k) => {
        const bit = 1 << k;
        if (!(bands[i] & bit)) return;
        let same = 0;
        let count = 0;
        for (let yy = Math.max(0, y - R); yy <= Math.min(h - 1, y + R); yy++) {
          for (let xx = Math.max(0, x - R); xx <= Math.min(w - 1, x + R); xx++) {
            count++;
            if (bands[yy * w + xx] & bit) same++;
          }
        }
        // Thin: at most about two lines' worth of the window.
        if (same / count > 0.42) return;
        mass[k] += sats[i];
        const a = (hues[i] * Math.PI) / 180;
        hueSum[k][0] += Math.cos(a) * sats[i];
        hueSum[k][1] += Math.sin(a) * sats[i];
      });
    }
  }
  if (stats) {
    stats.edges = edges / n;
    stats.shares = mass.map((m) => (edges ? m / edges : 0));
  }
  return FRINGE_BANDS.map((band, k) => {
    if (edges < n * 0.002 || mass[k] <= 0) return [0, band.hue];
    // About a tenth of the edges fringed calls for full strength.
    let amount = Math.max(0, Math.min(1, (mass[k] / edges - 0.01) * 10));
    amount = Math.round(amount * 20) / 20;
    let hue = (Math.atan2(hueSum[k][1], hueSum[k][0]) * 180) / Math.PI;
    hue = (hue + 360) % 360;
    if (band.min < 0 && hue > 180) hue -= 360;
    hue = Math.round(Math.max(band.min, Math.min(band.max, hue)) / 5) * 5;
    return [amount, hue];
  });
}
