// Lytro's light field demosaic, as read from the engine (DemosaicImageLF,
// the path ProcessRawImage takes when its flag is set, which is the default;
// the line-based Process() runs the same math as the scalar *_Gold passes).
//
// A 3 x 3 colour average on the 4 pixel border (processBorder), then, inside:
//   init      zeros, the raw value in its own channel; at green sites red and
//             blue are the mean of the two raw neighbours of that colour
//   G of R/B  green at red and blue sites: the colour difference raw_G - X
//             of the 12 neighbouring green sites, weighted by EXPFLUT of the
//             directional gradient
//   RB of R/B red at blue sites and blue at red sites from the 4 diagonals
//   RB of G   red and blue at green sites from the 12 green neighbours
// No clamp and no median filter (the flags are off by default). Weight index
// = trunc(clamp(g * (scale / sum) - 1, 0, 64)) with scale = 2^4 * 12 for the
// 12 direction passes and 2^4 * 4 for the diagonal pass.

const MARGIN = 4;

const EXPFLUT = new Float32Array([
  0.9602019786834717, 0.9205020070075989, 0.8809999823570251, 0.8418700098991394, 0.8030499815940857,
  0.764710009098053, 0.7270119786262512, 0.6898900270462036, 0.6535000205039978, 0.6179860234260559,
  0.5832740068435669, 0.5494999885559082, 0.5167840123176575, 0.485044002532959, 0.4543899893760681,
  0.424917995929718, 0.39653798937797546, 0.3693319857120514, 0.3433699905872345, 0.31855401396751404,
  0.29494398832321167, 0.27257999777793884, 0.25136199593544006, 0.23132599890232086, 0.21248599886894226,
  0.1947460025548935, 0.1781180053949356, 0.16259999573230743, 0.1480959951877594, 0.13459999859333038,
  0.12207599729299545, 0.11050400137901306, 0.09979599714279175, 0.08993200212717056, 0.08088400214910507,
  0.07257399708032608, 0.06497599929571152, 0.05806000158190727, 0.05175400152802467, 0.04602999985218048,
  0.040860000997781754, 0.03618000075221062, 0.031964000314474106, 0.02818400040268898, 0.024790000170469284,
  0.021754000335931778, 0.01905200071632862, 0.016642000526189804, 0.01450399961322546, 0.012613999657332897,
  0.010941999964416027, 0.009469999931752682, 0.008178000338375568, 0.007044000085443258, 0.006051999982446432,
  0.005189999938011169, 0.004435999784618616, 0.003783999942243099, 0.003220000071451068, 0.002732000080868602,
  0.002309999894350767, 0.0019499999471008778, 0.0016400000313296914, 0.0013760000001639128, 9.999999747378752e-6,
]);

// the 12 directions (h1, v1) and their scale, the 4 diagonals (h2, v2)
const H1 = [-1, 0, 1, 0, -2, -1, 1, 2, 2, 1, -1, -2];
const V1 = [0, -1, 0, 1, -1, -2, -2, -1, 1, 2, 2, 1];
const S1 = [1, 1, 1, 1, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5];
const H2 = [-1, 1, 1, -1];
const V2 = [-1, -1, 1, 1];
const SCALE12 = 16 * 12;
const SCALE4 = 16 * 4;

function weightIndex(g, factor) {
  const v = g * factor - 1;
  return v <= 0 ? 0 : v >= 64 ? 64 : Math.trunc(v);
}

// cfa[y & 1][x & 1] is 0 (red), 1 (green) or 2 (blue). `plane` is a
// width x height Float32Array of the corrected raw. Returns an object whose
// at(x, y, out) writes r, g, b and returns true when all are finite.
export function createLfDemosaic(plane, width, height, cfa, bandRows = 64) {
  const W = width;
  const H = height;
  const colour = (x, y) => cfa[y & 1][x & 1];
  const bands = new Map();
  const order = [];

  function borderAt(x, y, buf, o) {
    const y0 = Math.max(0, y - 1);
    const y1 = Math.min(H, y + 2);
    const x0 = Math.max(0, x - 1);
    const x1 = Math.min(W, x + 2);
    const sum = [0, 0, 0];
    const cnt = [0, 0, 0];
    for (let yy = y0; yy < y1; yy++) {
      for (let xx = x0; xx < x1; xx++) {
        const c = colour(xx, yy);
        sum[c] += plane[yy * W + xx];
        cnt[c]++;
      }
    }
    buf[o] = sum[0] / cnt[0];
    buf[o + 1] = colour(x, y) === 1 ? plane[y * W + x] : sum[1] / cnt[1];
    buf[o + 2] = sum[2] / cnt[2];
  }

  function compute(y0, y1) {
    const A = Math.max(0, y0 - 5);
    const B = Math.min(H, y1 + 5);
    const buf = new Float32Array((B - A) * W * 3);
    const px = (x, y) => ((y - A) * W + x) * 3;
    // border colour averages and the interior initialisation
    for (let y = A; y < B; y++) {
      const inside = y >= MARGIN && y < H - MARGIN;
      for (let x = 0; x < W; x++) {
        const o = px(x, y);
        if (!inside || x < MARGIN || x >= W - MARGIN) {
          borderAt(x, y, buf, o);
          continue;
        }
        const c = colour(x, y);
        const i = y * W + x;
        buf[o + c] = plane[i];
        if (c === 1) {
          const hc = colour(x + 1, y);
          buf[o + hc] = (plane[i - 1] + plane[i + 1]) * 0.5;
          buf[o + 2 - hc] = (plane[i - W] + plane[i + W]) * 0.5;
        }
      }
    }
    const dg = new Float64Array(12);
    const ya = Math.max(MARGIN, A + 2);
    const yb = Math.min(H - MARGIN, B - 2);
    // green at red and blue sites
    for (let y = ya; y < yb; y++) {
      for (let x = colour(MARGIN, y) !== 1 ? MARGIN : MARGIN + 1; x < W - MARGIN; x += 2) {
        const i = y * W + x;
        const c = colour(x, y);
        const c0 = plane[i];
        let sum = 0;
        for (let k = 0; k < 12; k++) {
          const o = V1[k] * W + H1[k];
          dg[k] = (Math.abs(c0 - plane[i + 2 * o]) + Math.abs(plane[i + o] - plane[i - o])) * S1[k];
          sum += dg[k];
        }
        const f = sum > 0 ? SCALE12 / sum : 1;
        let num = 0;
        let den = 0;
        for (let k = 0; k < 12; k++) {
          const w = EXPFLUT[weightIndex(dg[k], f)];
          num += w * (plane[i + V1[k] * W + H1[k]] - buf[px(x + H1[k], y + V1[k]) + c]);
          den += w;
        }
        buf[px(x, y) + 1] = c0 + num / den;
      }
    }
    // red at blue sites, blue at red sites
    const yc = Math.max(MARGIN, y0 - 2);
    const yd = Math.min(H - MARGIN, y1 + 2);
    const dd = new Float64Array(4);
    for (let y = yc; y < yd; y++) {
      for (let x = colour(MARGIN, y) !== 1 ? MARGIN : MARGIN + 1; x < W - MARGIN; x += 2) {
        const i = y * W + x;
        const c = colour(x, y);
        const c0 = plane[i];
        let sum = 0;
        for (let k = 0; k < 4; k++) {
          const o = V2[k] * W + H2[k];
          dd[k] = Math.abs(c0 - plane[i + 2 * o]) + Math.abs(plane[i + o] - plane[i - o]);
          sum += dd[k];
        }
        const f = sum > 0 ? SCALE4 / sum : 1;
        let num = 0;
        let den = 0;
        for (let k = 0; k < 4; k++) {
          const w = EXPFLUT[weightIndex(dd[k], f)];
          num += w * (buf[px(x + H2[k], y + V2[k]) + 1] - plane[i + V2[k] * W + H2[k]]);
          den += w;
        }
        const o = px(x, y);
        buf[o + 2 - c] = buf[o + 1] - num / den;
      }
    }
    // red and blue at green sites
    const ye = Math.max(MARGIN, y0);
    const yf = Math.min(H - MARGIN, y1);
    for (let y = ye; y < yf; y++) {
      for (let x = colour(MARGIN, y) === 1 ? MARGIN : MARGIN + 1; x < W - MARGIN; x += 2) {
        const i = y * W + x;
        const g0 = plane[i];
        let sum = 0;
        for (let k = 0; k < 12; k++) {
          const o = V1[k] * W + H1[k];
          dg[k] = (Math.abs(g0 - plane[i + 2 * o]) + Math.abs(plane[i + o] - plane[i - o])) * S1[k];
          sum += dg[k];
        }
        const f = sum > 0 ? SCALE12 / sum : 1;
        let nr = 0;
        let nb = 0;
        let den = 0;
        for (let k = 0; k < 12; k++) {
          const w = EXPFLUT[weightIndex(dg[k], f)];
          const o = px(x + H1[k], y + V1[k]);
          nr += (buf[o + 1] - buf[o]) * w;
          nb += (buf[o + 1] - buf[o + 2]) * w;
          den += w;
        }
        const o = px(x, y);
        buf[o] = g0 - nr / den;
        buf[o + 2] = g0 - nb / den;
      }
    }
    return { y0, y1, A, data: buf };
  }

  function band(b) {
    let e = bands.get(b);
    if (e) return e;
    e = compute(b * bandRows, Math.min(H, (b + 1) * bandRows));
    bands.set(b, e);
    order.push(b);
    if (order.length > 8) bands.delete(order.shift());
    return e;
  }

  return {
    band,
    at(x, y, out) {
      const e = band(Math.floor(y / bandRows));
      const o = ((y - e.A) * W + x) * 3;
      out[0] = e.data[o];
      out[1] = e.data[o + 1];
      out[2] = e.data[o + 2];
      return out[0] === out[0] && out[1] === out[1] && out[2] === out[2];
    },
  };
}
