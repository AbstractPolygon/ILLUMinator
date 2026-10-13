// Reduce flare: light scattered in the lens lays a faint, smooth veil over
// the picture that lifts the blacks and washes out color, most where the
// light came in. Anything dark in the scene should be near black, so the
// darkest values in each part of the picture measure the veil there; a
// smooth version of that is subtracted (in linear camera RGB, before color).

const TILES_X = 16;
const TILES_Y = 12;
const PERCENTILE = 0.02;

// rgb: linear RGB (w x h) -> { tilesX, tilesY, data } (RGB per tile).
export function estimateVeil(rgb, w, h) {
  const tx = TILES_X;
  const ty = TILES_Y;
  const raw = new Float32Array(tx * ty * 3);
  const values = [[], [], []];
  for (let j = 0; j < ty; j++) {
    const y0 = Math.floor((j * h) / ty);
    const y1 = Math.floor(((j + 1) * h) / ty);
    for (let i = 0; i < tx; i++) {
      const x0 = Math.floor((i * w) / tx);
      const x1 = Math.floor(((i + 1) * w) / tx);
      for (const v of values) v.length = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const p = (y * w + x) * 3;
          values[0].push(rgb[p]);
          values[1].push(rgb[p + 1]);
          values[2].push(rgb[p + 2]);
        }
      }
      for (let c = 0; c < 3; c++) {
        const v = values[c].sort((a, b) => a - b);
        raw[(j * tx + i) * 3 + c] = v.length ? Math.max(0, v[Math.floor(PERCENTILE * (v.length - 1))]) : 0;
      }
    }
  }
  // A tile that is bright all over (sky, a white wall) is not flare: take
  // the smallest value around each tile, then smooth.
  const min = new Float32Array(raw.length);
  for (let j = 0; j < ty; j++) {
    for (let i = 0; i < tx; i++) {
      for (let c = 0; c < 3; c++) {
        let m = Infinity;
        for (let dj = -1; dj <= 1; dj++) {
          for (let di = -1; di <= 1; di++) {
            const jj = Math.min(ty - 1, Math.max(0, j + dj));
            const ii = Math.min(tx - 1, Math.max(0, i + di));
            m = Math.min(m, raw[(jj * tx + ii) * 3 + c]);
          }
        }
        min[(j * tx + i) * 3 + c] = m;
      }
    }
  }
  let data = min;
  for (let pass = 0; pass < 2; pass++) {
    const next = new Float32Array(data.length);
    for (let j = 0; j < ty; j++) {
      for (let i = 0; i < tx; i++) {
        for (let c = 0; c < 3; c++) {
          let s = 0;
          let n = 0;
          for (let dj = -1; dj <= 1; dj++) {
            for (let di = -1; di <= 1; di++) {
              const jj = j + dj;
              const ii = i + di;
              if (jj < 0 || ii < 0 || jj >= ty || ii >= tx) continue;
              s += data[(jj * tx + ii) * 3 + c];
              n++;
            }
          }
          next[(j * tx + i) * 3 + c] = s / n;
        }
      }
    }
    data = next;
  }
  return { tilesX: tx, tilesY: ty, data };
}

// The veil at normalized position (nx, ny), bilinear between tile centers.
export function veilAt(veil, nx, ny, out = [0, 0, 0]) {
  const { tilesX: tx, tilesY: ty, data } = veil;
  const fx = Math.min(tx - 1, Math.max(0, nx * tx - 0.5));
  const fy = Math.min(ty - 1, Math.max(0, ny * ty - 0.5));
  const x0 = Math.min(tx - 2, Math.floor(fx));
  const y0 = Math.min(ty - 2, Math.floor(fy));
  const ax = fx - x0;
  const ay = fy - y0;
  for (let c = 0; c < 3; c++) {
    const at = (x, y) => data[(y * tx + x) * 3 + c];
    out[c] = (at(x0, y0) * (1 - ax) + at(x0 + 1, y0) * ax) * (1 - ay) + (at(x0, y0 + 1) * (1 - ax) + at(x0 + 1, y0 + 1) * ax) * ay;
  }
  return out;
}

// rgb minus `amount` (0..1) of the veil, as a new array.
export function subtractVeil(rgb, w, h, veil, amount) {
  if (!veil || !(amount > 0)) return rgb;
  const out = new Float32Array(rgb.length);
  const v = [0, 0, 0];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      veilAt(veil, (x + 0.5) / w, (y + 0.5) / h, v);
      const p = (y * w + x) * 3;
      out[p] = Math.max(0, rgb[p] - amount * v[0]);
      out[p + 1] = Math.max(0, rgb[p + 1] - amount * v[1]);
      out[p + 2] = Math.max(0, rgb[p + 2] - amount * v[2]);
    }
  }
  return out;
}
