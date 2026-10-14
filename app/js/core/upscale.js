// Upscaling for export: enlarges a rendered picture (RGBA bytes) to a bigger
// size for saved photos and videos. Two methods:
//  - 'lanczos': a Lanczos-3 filter, sharper than ordinary smoothing and
//    without its softness (overshoot at edges is clamped);
//  - 'smooth': bilinear, the browser's ordinary enlarging.
// `sharpen` (0..1) then adds an unsharp mask scaled to the enlargement, to
// bring back the crispness enlarging takes away. Enlarging adds pixels, not
// detail: the light field's detail is set by Rendering > Full resolution.

const A = 3;

function sinc(x) {
  if (x === 0) return 1;
  const p = Math.PI * x;
  return Math.sin(p) / p;
}

// For each output position along one axis: the first input index and the
// normalized weights of the input samples it takes.
function weights(inSize, outSize, method) {
  const ratio = inSize / outSize;
  // Reducing: the filter widens with the reduction, so every input pixel
  // counts and fine detail does not alias.
  const scale = Math.max(1, ratio);
  const radius = (method === 'lanczos' ? A : 1) * scale;
  const taps = Math.ceil(2 * radius) + 1;
  const first = new Int32Array(outSize);
  const w = new Float32Array(outSize * taps);
  for (let o = 0; o < outSize; o++) {
    const center = (o + 0.5) * ratio - 0.5;
    const start = Math.floor(center - radius) + 1;
    first[o] = start;
    let sum = 0;
    for (let t = 0; t < taps; t++) {
      const d = (center - (start + t)) / scale;
      const v = method === 'lanczos'
        ? (Math.abs(d) < A ? sinc(d) * sinc(d / A) : 0)
        : Math.max(0, 1 - Math.abs(d));
      w[o * taps + t] = v;
      sum += v;
    }
    for (let t = 0; t < taps; t++) w[o * taps + t] /= sum;
  }
  return { first, w, taps };
}

const clampIndex = (i, n) => (i < 0 ? 0 : i >= n ? n - 1 : i);

// Enlarges (or reduces) `img` ({ width, height, data: RGBA bytes }) to
// width W and height H. Returns { width, height, data: Uint8ClampedArray }.
export function upscale(img, W, H, { method = 'lanczos', sharpen = 0 } = {}) {
  const { width: w, height: h, data } = img;
  if (W === w && H === h && !sharpen) return { width: w, height: h, data: new Uint8ClampedArray(data) };
  // Rows first: w x h -> W x h (floats), then columns: -> W x H.
  const X = weights(w, W, method);
  const mid = new Float32Array(W * h * 4);
  for (let y = 0; y < h; y++) {
    const row = y * w * 4;
    for (let o = 0; o < W; o++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      const s = X.first[o];
      for (let t = 0; t < X.taps; t++) {
        const k = X.w[o * X.taps + t];
        if (k === 0) continue;
        const i = row + clampIndex(s + t, w) * 4;
        r += data[i] * k;
        g += data[i + 1] * k;
        b += data[i + 2] * k;
        a += data[i + 3] * k;
      }
      const j = (y * W + o) * 4;
      mid[j] = r;
      mid[j + 1] = g;
      mid[j + 2] = b;
      mid[j + 3] = a;
    }
  }
  const Y = weights(h, H, method);
  const out = new Float32Array(W * H * 4);
  for (let o = 0; o < H; o++) {
    const s = Y.first[o];
    const j0 = o * W * 4;
    for (let t = 0; t < Y.taps; t++) {
      const k = Y.w[o * Y.taps + t];
      if (k === 0) continue;
      const i0 = clampIndex(s + t, h) * W * 4;
      for (let x = 0; x < W * 4; x++) out[j0 + x] += mid[i0 + x] * k;
    }
  }
  if (sharpen > 0) unsharp(out, W, H, sharpen, Math.max(1, Math.max(W / w, H / h)));
  return { width: W, height: H, data: new Uint8ClampedArray(out) };
}

// Unsharp mask on float RGB (alpha untouched): adds `amount` times the
// difference from a box-blurred copy whose radius follows the enlargement.
function unsharp(px, W, H, amount, factor) {
  const r = Math.max(1, Math.round(factor));
  const blur = boxBlur(px, W, H, r);
  const k = amount * 1.5;
  for (let i = 0; i < px.length; i += 4) {
    for (let c = 0; c < 3; c++) px[i + c] += (px[i + c] - blur[i + c]) * k;
  }
}

function boxBlur(px, W, H, r) {
  const tmp = new Float32Array(px.length);
  const out = new Float32Array(px.length);
  const n = 2 * r + 1;
  for (let y = 0; y < H; y++) {
    for (let c = 0; c < 3; c++) {
      let sum = 0;
      for (let x = -r; x <= r; x++) sum += px[(y * W + clampIndex(x, W)) * 4 + c];
      for (let x = 0; x < W; x++) {
        tmp[(y * W + x) * 4 + c] = sum / n;
        sum += px[(y * W + clampIndex(x + r + 1, W)) * 4 + c] - px[(y * W + clampIndex(x - r, W)) * 4 + c];
      }
    }
  }
  for (let x = 0; x < W; x++) {
    for (let c = 0; c < 3; c++) {
      let sum = 0;
      for (let y = -r; y <= r; y++) sum += tmp[(clampIndex(y, H) * W + x) * 4 + c];
      for (let y = 0; y < H; y++) {
        out[(y * W + x) * 4 + c] = sum / n;
        sum += tmp[(clampIndex(y + r + 1, H) * W + x) * 4 + c] - tmp[(clampIndex(y - r, H) * W + x) * 4 + c];
      }
    }
  }
  return out;
}

// The size `w` x `h` enlarged by `factor`, in whole pixels (even, for video
// encoders, when `even` is set).
export function scaledSize(w, h, factor, { even = false } = {}) {
  const round = even ? (v) => Math.max(2, 2 * Math.round(v / 2)) : (v) => Math.max(1, Math.round(v));
  return [round(w * factor), round(h * factor)];
}
