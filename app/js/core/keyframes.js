// Keyframed animation: each property has its own track of keyframes, and
// each keyframe sets the curve the value follows to the next keyframe.
//
// { length: seconds, tracks: { aperture: [{ t, v, ease }], ... } }
//   aperture  f-number (eases in f-stops, on a log scale)
//   depth     the Depth slider (-100..100)
//   focus     focus value
//   view      [u, v] viewpoint
//   zoom      1..3
//   panX      -1..1 (earlier versions kept one 'pan' track of [x, y])
//   panY      -1..1
//   pivot     the Pivot depth slider (-100..100): a keyframed pivot is a
//             custom pivot
// ease: { type: 'auto' | 'linear' | 'smooth' | 'in' | 'out' | 'hold' | 'custom',
//         bezier: [x1, y1, x2, y2] } (custom: a cubic Bezier from (0, 0) to
//         (1, 1) through those handles; y may leave 0..1 to overshoot).
// auto: one continuous curve through the keyframes, like Blender's auto
// clamped handles: the speed carries through each keyframe, flattening at
// highs, lows and the ends, without overshooting.

export const TRACKS = ['aperture', 'depth', 'focus', 'view', 'zoom', 'panX', 'panY', 'pivot'];
// Besides those, 'mask:<id>:<attr>': a setting of local adjustment <id>
// (its strength, a shape setting or an effect; see core/local.js).
export const isMaskTrack = (k) => /^mask:[\w-]+:[a-z]+$/.test(k);

// Every track the animation has.
export function trackNames(anim) {
  return [...TRACKS, ...Object.keys(anim.tracks).filter(isMaskTrack)];
}
export const FPS = 24;
export const DEFAULT_LENGTH = 4;

export const PRESETS = {
  linear: [0, 0, 1, 1],
  smooth: [0.42, 0, 0.58, 1],
  in: [0.42, 0, 1, 1],
  out: [0, 0, 0.58, 1],
};

export function emptyAnimation() {
  return { length: DEFAULT_LENGTH, tracks: Object.fromEntries(TRACKS.map((k) => [k, []])) };
}

const isVec = (k) => k === 'view';

export function parseAnimation(text) {
  let a;
  try {
    a = JSON.parse(text || 'null');
  } catch {
    a = null;
  }
  const out = emptyAnimation();
  if (!a || typeof a !== 'object') return out;
  if (Number.isFinite(a.length) && a.length > 0) out.length = Math.min(120, a.length);
  // An old 'pan' track becomes Pan X and Pan Y.
  if (a.tracks && Array.isArray(a.tracks.pan) && !a.tracks.panX && !a.tracks.panY) {
    const keys = a.tracks.pan.filter((key) => key && Array.isArray(key.v) && key.v.length === 2);
    a.tracks.panX = keys.map((key) => ({ ...key, v: key.v[0] }));
    a.tracks.panY = keys.map((key) => ({ ...key, v: key.v[1] }));
  }
  const names = [...TRACKS, ...Object.keys((a.tracks && typeof a.tracks === 'object' && a.tracks) || {}).filter(isMaskTrack)];
  for (const k of names) {
    const list = a.tracks && Array.isArray(a.tracks[k]) ? a.tracks[k] : [];
    out.tracks[k] = list
      .filter((key) => key && Number.isFinite(key.t) && (isVec(k) ? Array.isArray(key.v) && key.v.length === 2 : Number.isFinite(key.v)))
      .map((key) => ({ t: Math.max(0, key.t), v: key.v, ease: normalizeEase(key.ease) }))
      .sort((x, y) => x.t - y.t);
  }
  return out;
}

function normalizeEase(e) {
  const type = e && ['auto', 'linear', 'smooth', 'in', 'out', 'hold', 'custom'].includes(e.type) ? e.type : 'smooth';
  const b = e && Array.isArray(e.bezier) && e.bezier.length === 4 && e.bezier.every(Number.isFinite) ? e.bezier : PRESETS.smooth;
  return { type, bezier: [Math.min(1, Math.max(0, b[0])), b[1], Math.min(1, Math.max(0, b[2])), b[3]] };
}

export function defaultEase() {
  return { type: 'auto', bezier: [...PRESETS.smooth] };
}

// Cubic Bezier from (0, 0) to (1, 1) with handles (x1, y1), (x2, y2), as
// y for a given x (like CSS cubic-bezier).
export function cubicBezier(x1, y1, x2, y2) {
  const bx = (t) => 3 * (1 - t) * (1 - t) * t * x1 + 3 * (1 - t) * t * t * x2 + t * t * t;
  const by = (t) => 3 * (1 - t) * (1 - t) * t * y1 + 3 * (1 - t) * t * t * y2 + t * t * t;
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    // x(t) is monotone for handles inside 0..1: bisection is enough.
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (bx(mid) < x) lo = mid;
      else hi = mid;
    }
    return by((lo + hi) / 2);
  };
}

export function easeFunction(ease) {
  if (!ease || ease.type === 'hold') return (x) => (x >= 1 ? 1 : 0);
  const b = ease.type === 'custom' ? ease.bezier : PRESETS[ease.type] || PRESETS.smooth;
  return cubicBezier(...b);
}

// Aperture moves in f-stops (log scale); views and pans per component.
// Aperture moves in f-stops and zoom in doublings (log scales), so each
// step of either takes the same time; views and pans per component.
const isLog = (k) => k === 'aperture' || k === 'zoom';
const toLinear = (k, v) => (isLog(k) ? [Math.log(v)] : isVec(k) ? v : [v]);
const fromLinear = (k, c) => (isLog(k) ? Math.exp(c[0]) : isVec(k) ? c : c[0]);

// Tangent (value per second) at keys[i], per component, for auto curves.
function autoSlope(keys, i, k, c) {
  if (i <= 0 || i >= keys.length - 1) return 0;
  const p = toLinear(k, keys[i - 1].v)[c];
  const v = toLinear(k, keys[i].v)[c];
  const n = toLinear(k, keys[i + 1].v)[c];
  const d0 = (v - p) / Math.max(1e-9, keys[i].t - keys[i - 1].t);
  const d1 = (n - v) / Math.max(1e-9, keys[i + 1].t - keys[i].t);
  // A high or low point (or a flat stretch) stays flat.
  if (d0 * d1 <= 0) return 0;
  const m = (n - p) / Math.max(1e-9, keys[i + 1].t - keys[i - 1].t);
  // No overshoot: at most three times the gentler neighbouring slope.
  const limit = 3 * Math.min(Math.abs(d0), Math.abs(d1));
  return Math.sign(m) * Math.min(Math.abs(m), limit);
}

function autoValue(k, keys, i, t) {
  const a = keys[i];
  const b = keys[i + 1];
  const h = Math.max(1e-9, b.t - a.t);
  const s = (t - a.t) / h;
  const s2 = s * s;
  const s3 = s2 * s;
  const va = toLinear(k, a.v);
  const vb = toLinear(k, b.v);
  const out = va.map((_, c) => {
    // Cubic Hermite between the two keys.
    const ma = autoSlope(keys, i, k, c);
    const mb = autoSlope(keys, i + 1, k, c);
    return (2 * s3 - 3 * s2 + 1) * va[c] + (s3 - 2 * s2 + s) * h * ma + (-2 * s3 + 3 * s2) * vb[c] + (s3 - s2) * h * mb;
  });
  return fromLinear(k, out);
}

// The curve from keys[i] to the next keyframe as Bezier handles
// [x1, y1, x2, y2] (fractions of the time and of the value change between
// the two keys; component c of a viewpoint or pan), or null after the last
// keyframe or a hold.
export function segmentBezier(anim, k, i, c = 0) {
  const keys = anim.tracks[k];
  const a = keys[i];
  const b = keys[i + 1];
  if (!a || !b || a.ease.type === 'hold') return null;
  if (a.ease.type === 'custom') return [...a.ease.bezier];
  if (a.ease.type === 'linear') return [1 / 3, 1 / 3, 2 / 3, 2 / 3];
  if (a.ease.type !== 'auto') return [...(PRESETS[a.ease.type] || PRESETS.smooth)];
  // Auto: the Hermite tangents as handles a third of the way along.
  const h = b.t - a.t;
  const d = toLinear(k, b.v)[c] - toLinear(k, a.v)[c];
  if (Math.abs(d) < 1e-12) return [1 / 3, 0, 2 / 3, 1];
  const ma = autoSlope(keys, i, k, c);
  const mb = autoSlope(keys, i + 1, k, c);
  return [1 / 3, (ma * h) / 3 / d, 2 / 3, 1 - (mb * h) / 3 / d];
}

function mix(k, a, b, e) {
  if (isLog(k)) return Math.exp(Math.log(a) + (Math.log(b) - Math.log(a)) * e);
  if (isVec(k)) return [a[0] + (b[0] - a[0]) * e, a[1] + (b[1] - a[1]) * e];
  return a + (b - a) * e;
}

// A track's value at time t, or undefined when it has no keyframes.
export function valueAt(anim, k, t) {
  const keys = anim.tracks[k];
  if (!keys || !keys.length) return undefined;
  if (t <= keys[0].t) return keys[0].v;
  const last = keys[keys.length - 1];
  if (t >= last.t) return last.v;
  let i = 0;
  while (i < keys.length - 2 && t >= keys[i + 1].t) i++;
  const a = keys[i];
  const b = keys[i + 1];
  if (a.ease.type === 'auto') return autoValue(k, keys, i, t);
  const x = (t - a.t) / Math.max(1e-9, b.t - a.t);
  return mix(k, a.v, b.v, easeFunction(a.ease)(x));
}

export function frameCount(anim, fps = FPS) {
  return Math.max(1, Math.round(anim.length * fps) + 1);
}

// Values of every track at every frame: [{ aperture, depth, ... }] (missing
// tracks undefined), at `fps` frames a second.
export function sample(anim, fps = FPS) {
  const n = frameCount(anim, fps);
  const names = trackNames(anim);
  return Array.from({ length: n }, (_, i) => Object.fromEntries(names.map((k) => [k, valueAt(anim, k, i / fps)])));
}

export function hasKeys(anim) {
  return trackNames(anim).some((k) => anim.tracks[k].length);
}

// Sets (or replaces) the keyframe of track k at time t.
export function setKey(anim, k, t, v, fps = FPS) {
  const keys = anim.tracks[k];
  const at = keys.findIndex((key) => Math.abs(key.t - t) < 0.5 / fps);
  if (at >= 0) keys[at] = { ...keys[at], v };
  else keys.push({ t, v, ease: defaultEase() });
  keys.sort((x, y) => x.t - y.t);
  return anim;
}
