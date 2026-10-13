// Defringing, in the spirit of Lightroom's tool: purple, green, red and blue color
// fringes appear along high-contrast edges (lens chromatic aberration, and
// here also light field sampling). Pixels near such edges whose hue falls in
// one of the chosen hue ranges lose that color; everything else is left
// alone.

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
// fringe: [[amount 0..1, hue in degrees], ...] e.g. purple, green, red, blue.
export function defringe(rgb, w, h, fringe = []) {
  const ranges = fringe.filter(([amount]) => amount > 0);
  if (!ranges.length) return rgb;
  const n = w * h;
  const lum = new Float32Array(n);
  for (let i = 0; i < n; i++) lum[i] = 0.2126 * rgb[3 * i] + 0.7152 * rgb[3 * i + 1] + 0.0722 * rgb[3 * i + 2];
  // Local contrast: brightness range in a 5x5 window relative to its maximum.
  const R = 2;
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
      const edge = Math.max(0, Math.min(1, (contrast - 0.25) / 0.35));
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
