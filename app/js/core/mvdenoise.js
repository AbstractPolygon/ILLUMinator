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

function sampleBilinear(view, w, h, x, y, out) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const xa = Math.min(w - 1, Math.max(0, x0));
  const xb = Math.min(w - 1, Math.max(0, x0 + 1));
  const ya = Math.min(h - 1, Math.max(0, y0));
  const yb = Math.min(h - 1, Math.max(0, y0 + 1));
  const g = view.gain;
  const v = view.rgb;
  for (let c = 0; c < 3; c++) {
    const a = v[(ya * w + xa) * 3 + c] * (1 - fx) + v[(ya * w + xb) * 3 + c] * fx;
    const b = v[(yb * w + xa) * 3 + c] * (1 - fx) + v[(yb * w + xb) * 3 + c] * fx;
    out[c] = (a * (1 - fy) + b * fy) * g;
  }
}

// views: [{ u, v, rgb (Uint16 or Float32), gain }]; depth: focus value per
// pixel (w x h); ref: the current view's linear RGB at (u0, v0).
// Returns new linear RGB: ref blended toward the merge by `blend` (0..1).
export function mergeViews(views, w, h, depth, ref, { u0 = 0, v0 = 0, detail = 1, sigma, blend = 1 }) {
  const out = new Float32Array(ref.length);
  const k = -0.5 / (sigma * sigma);
  const s = [0, 0, 0];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const r0 = ref[3 * i];
      const r1 = ref[3 * i + 1];
      const r2 = ref[3 * i + 2];
      const refS = Math.sqrt(Math.max(0, LUMA[0] * r0 + LUMA[1] * r1 + LUMA[2] * r2));
      // Depth where the centered views see this point.
      const a0 = depth[i];
      const cx = Math.min(w - 1, Math.max(0, Math.round(x - a0 * u0 * detail)));
      const cy = Math.min(h - 1, Math.max(0, Math.round(y - a0 * v0 * detail)));
      const a = depth[cy * w + cx];
      let sr = r0;
      let sg = r1;
      let sb = r2;
      let wsum = 1;
      for (const view of views) {
        const sx = x + a * (view.u - u0) * detail;
        const sy = y + a * (view.v - v0) * detail;
        if (sx < 0 || sy < 0 || sx > w - 1 || sy > h - 1) continue;
        sampleBilinear(view, w, h, sx, sy, s);
        const d = Math.sqrt(Math.max(0, LUMA[0] * s[0] + LUMA[1] * s[1] + LUMA[2] * s[2])) - refS;
        const wt = Math.exp(k * d * d);
        sr += s[0] * wt;
        sg += s[1] * wt;
        sb += s[2] * wt;
        wsum += wt;
      }
      out[3 * i] = r0 + (sr / wsum - r0) * blend;
      out[3 * i + 1] = r1 + (sg / wsum - r1) * blend;
      out[3 * i + 2] = r2 + (sb / wsum - r2) * blend;
    }
  }
  return out;
}
