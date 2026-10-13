// Crop, straighten and orientation: where each pixel of the finished picture
// comes from in the rendered one.
//
// The rendered picture (W x H) is first turned to its orientation (EXIF
// codes 1-8: a mirror and quarter turns), then straightened by a small angle
// and scaled so the turned picture still covers the frame (no empty
// corners), then cropped. The crop is { x, y, w, h } as fractions of that
// straightened frame.
//
// Transforms are 2D affine matrices [a, b, c, d, e, f], as canvas uses them:
// x' = a x + c y + e, y' = b x + d y + f.

export const IDENTITY = [1, 0, 0, 1, 0, 0];
export const FULL_CROP = { x: 0, y: 0, w: 1, h: 1 };

export function multiply(m, n) {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

export function invert(m) {
  const det = m[0] * m[3] - m[1] * m[2];
  return [
    m[3] / det, -m[1] / det, -m[2] / det, m[0] / det,
    (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det,
  ];
}

export function apply(m, x, y) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

const translate = (x, y) => [1, 0, 0, 1, x, y];
const scale = (x, y) => [x, 0, 0, y, 0, 0];
function rotate(rad) {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return [c, s, -s, c, 0, 0];
}

// EXIF orientation -> mirror first, then quarter turns clockwise.
const PARTS = { 1: [false, 0], 2: [true, 0], 3: [false, 2], 4: [true, 2], 5: [true, 3], 6: [false, 1], 7: [true, 1], 8: [false, 3] };

export function orientationParts(code) {
  const [flip, turns] = PARTS[code] || PARTS[1];
  return { flip, turns };
}

export function orientationCode(flip, turns) {
  const t = ((turns % 4) + 4) % 4;
  return +Object.keys(PARTS).find((k) => PARTS[k][0] === !!flip && PARTS[k][1] === t);
}

// Turning the shown picture a quarter turn (dir 1 clockwise, -1 counter).
export function rotateOrientation(code, dir) {
  const { flip, turns } = orientationParts(code);
  return orientationCode(flip, turns + dir);
}

// Mirroring the shown picture left to right.
export function flipOrientation(code) {
  const { flip, turns } = orientationParts(code);
  return orientationCode(!flip, -turns);
}

// How much a w x h picture turned by `deg` must shrink so the turned
// picture covers a frame of the same shape.
export function straightenScale(w, h, deg) {
  const t = Math.abs((deg * Math.PI) / 180);
  return 1 / (Math.cos(t) + Math.max(w / h, h / w) * Math.sin(t));
}

export function isIdentity({ orientation = 1, angle = 0, crop = FULL_CROP, shift = [0, 0], zoom = 1 } = {}) {
  return orientation === 1 && !angle && crop.x === 0 && crop.y === 0 && crop.w === 1 && crop.h === 1
    && !shift[0] && !shift[1] && zoom === 1;
}

function clampCrop(crop) {
  const w = Math.min(1, Math.max(0.02, +crop.w || 1));
  const h = Math.min(1, Math.max(0.02, +crop.h || 1));
  return { x: Math.min(1 - w, Math.max(0, +crop.x || 0)), y: Math.min(1 - h, Math.max(0, +crop.y || 0)), w, h };
}

// For a W x H picture: the finished size, the straightened frame's size and
// the matrix from rendered pixels to finished pixels. `shift` ([x, y],
// fractions of the picture) and `zoom` (about the middle) move the rendered
// picture first (the perspective pivot).
export function geometry(W, H, { orientation = 1, angle = 0, crop = FULL_CROP, shift = [0, 0], zoom = 1 } = {}) {
  const { flip, turns } = orientationParts(orientation);
  const OW = turns % 2 ? H : W;
  const OH = turns % 2 ? W : H;
  const s = straightenScale(OW, OH, angle);
  const frameWidth = s * OW;
  const frameHeight = s * OH;
  const c = clampCrop(crop);
  let m = translate(-c.x * frameWidth, -c.y * frameHeight);
  m = multiply(m, translate(frameWidth / 2, frameHeight / 2));
  m = multiply(m, rotate((angle * Math.PI) / 180));
  m = multiply(m, rotate((turns * Math.PI) / 2));
  m = multiply(m, scale(flip ? -1 : 1, 1));
  m = multiply(m, scale(zoom, zoom));
  m = multiply(m, translate(shift[0] * W - W / 2, shift[1] * H - H / 2));
  return {
    // Rounded down: never a sliver past the picture's edge.
    width: Math.max(1, Math.floor(c.w * frameWidth + 1e-6)),
    height: Math.max(1, Math.floor(c.h * frameHeight + 1e-6)),
    frameWidth,
    frameHeight,
    crop: c,
    matrix: m,
  };
}

// The largest crop of aspect `ratio` (width / height, in pixels) centered
// on `crop`, inside the frame.
export function fitAspect(crop, ratio, frameWidth, frameHeight) {
  if (!ratio) return crop;
  const cx = crop.x + crop.w / 2;
  const cy = crop.y + crop.h / 2;
  // Normalized width / height for that pixel ratio.
  const r = (ratio * frameHeight) / frameWidth;
  let w = crop.w;
  let h = w / r;
  if (h > crop.h) {
    h = crop.h;
    w = h * r;
  }
  if (w > 1) {
    w = 1;
    h = w / r;
  }
  if (h > 1) {
    h = 1;
    w = h * r;
  }
  return clampCrop({ x: cx - w / 2, y: cy - h / 2, w, h });
}
