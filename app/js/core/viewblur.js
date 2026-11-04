// The blur the engine applies to each depth view after the splat (the GPU version is blurViewsGpu in gpu/lytroengine.js).

// Separable filter over the premultiplied view (colour and weight), zero outside. The taps that fall outside are left out of the sum
// (the loop bounds are worked out once per sample, not tested per tap); the sum runs in the same order as the plain version.
export function filterPremultiplied(acc, W, H, kx, ky) {
  const pass = (src, dst, n, stride, lines, lineStride, k) => {
    const r = (k.length - 1) >> 1;
    for (let l = 0; l < lines; l++) {
      const base = 4 * l * lineStride;
      const step = 4 * stride;
      for (let i = 0; i < n; i++) {
        const t0 = Math.max(-r, -i);
        const t1 = Math.min(r, n - 1 - i);
        const o = base + i * step;
        for (let c = 0; c < 4; c++) {
          let a = 0;
          for (let t = t0; t <= t1; t++) a += k[t + r] * src[o + t * step + c];
          dst[o + c] = a;
        }
      }
    }
  };
  const tmp = new Float32Array(acc.length);
  pass(acc, tmp, W, 1, H, W, kx);
  pass(tmp, acc, H, W, W, 1, ky);
}
