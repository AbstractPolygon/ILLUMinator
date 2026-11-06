// Multi-view denoising: a light field photo holds many views of the same
// instant (the refocus views), so noise can be averaged away without
// blurring, like merging a burst of shots. For each output pixel every view
// is sampled where that pixel's scene point appears (the depth map gives the
// shift), and samples that disagree with the current view (occlusion, depth
// errors) are weighted down. gpu/renderer.js mirrors this.
//
// Views shift a point at focus value a by a * (u_k - u0) * detail output
// pixels (as in refocusing); the depth map was measured from the centered
// views, so a pixel's depth is looked up at its centered position.

const LUMA = [0.2126, 0.7152, 0.0722];

// How far (in square-root brightness) a sample may differ from the current
// view and still count fully, relative to the picture's typical level.
export function mergeSigma(meanLevel) {
  return 0.12 * Math.sqrt(Math.max(1e-6, meanLevel));
}

// views: [{ u, v, rgb (Uint16 or Float32), gain }]; depth: focus value per
// pixel (w x h); ref: the current view's linear RGB at (u0, v0).
// Returns new linear RGB: ref blended toward the merge by `blend` (0..1).
export function mergeViews(views, w, h, depth, ref, { u0 = 0, v0 = 0, detail = 1, sigma, blend = 1 }) {
  const out = new Float32Array(ref.length);
  // The weight exp(-0.5 * (d / sigma)^2) of a brightness difference d, from a table over t = d^2 / (2 sigma^2) (linear interpolation, error under 1e-7;
  // beyond MERGE_MAX the weight is below 1e-7 and the sample is dropped).
  const tScale = (1 / (2 * sigma * sigma)) * (MERGE_STEPS / MERGE_MAX);
  const nv = views.length;
  const du = new Float64Array(nv);
  const dv = new Float64Array(nv);
  for (let n = 0; n < nv; n++) {
    du[n] = (views[n].u - u0) * detail;
    dv[n] = (views[n].v - v0) * detail;
  }
  const wMax = w - 1;
  const hMax = h - 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const r0 = ref[3 * i];
      const r1 = ref[3 * i + 1];
      const r2 = ref[3 * i + 2];
      const refS = Math.sqrt(Math.max(0, LUMA[0] * r0 + LUMA[1] * r1 + LUMA[2] * r2));
      // Depth where the centered views see this point.
      const a0 = depth[i];
      const cx = Math.min(wMax, Math.max(0, Math.round(x - a0 * u0 * detail)));
      const cy = Math.min(hMax, Math.max(0, Math.round(y - a0 * v0 * detail)));
      const a = depth[cy * w + cx];
      let sr = r0;
      let sg = r1;
      let sb = r2;
      let wsum = 1;
      for (let n = 0; n < nv; n++) {
        const sx = x + a * du[n];
        const sy = y + a * dv[n];
        if (sx < 0 || sy < 0 || sx > wMax || sy > hMax) continue;
        // bilinear sample of the view (inlined: this loop runs views x pixels times)
        const x0 = Math.floor(sx);
        const y0 = Math.floor(sy);
        const fx = sx - x0;
        const fy = sy - y0;
        const xa = x0 < 0 ? 0 : x0 > wMax ? wMax : x0;
        const xb = x0 + 1 > wMax ? wMax : x0 + 1;
        const ya = y0 < 0 ? 0 : y0 > hMax ? hMax : y0;
        const yb = y0 + 1 > hMax ? hMax : y0 + 1;
        const view = views[n];
        const g = view.gain;
        const v = view.rgb;
        const pa = (ya * w + xa) * 3;
        const pb = (ya * w + xb) * 3;
        const pc = (yb * w + xa) * 3;
        const pd = (yb * w + xb) * 3;
        const gx = 1 - fx;
        const gy = 1 - fy;
        const s0 = ((v[pa] * gx + v[pb] * fx) * gy + (v[pc] * gx + v[pd] * fx) * fy) * g;
        const s1 = ((v[pa + 1] * gx + v[pb + 1] * fx) * gy + (v[pc + 1] * gx + v[pd + 1] * fx) * fy) * g;
        const s2 = ((v[pa + 2] * gx + v[pb + 2] * fx) * gy + (v[pc + 2] * gx + v[pd + 2] * fx) * fy) * g;
        const d = Math.sqrt(Math.max(0, LUMA[0] * s0 + LUMA[1] * s1 + LUMA[2] * s2)) - refS;
        const t = d * d * tScale;
        if (t >= MERGE_STEPS) continue;
        const k = t | 0;
        const wt = mergeTable[k] + (mergeTable[k + 1] - mergeTable[k]) * (t - k);
        sr += s0 * wt;
        sg += s1 * wt;
        sb += s2 * wt;
        wsum += wt;
      }
      out[3 * i] = r0 + (sr / wsum - r0) * blend;
      out[3 * i + 1] = r1 + (sg / wsum - r1) * blend;
      out[3 * i + 2] = r2 + (sb / wsum - r2) * blend;
    }
  }
  return out;
}

const MERGE_STEPS = 8192;
const MERGE_MAX = 16;
const mergeTable = new Float32Array(MERGE_STEPS + 2);
for (let i = 0; i < mergeTable.length; i++) mergeTable[i] = Math.exp(-(i * MERGE_MAX) / MERGE_STEPS);
