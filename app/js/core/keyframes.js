// Keyframed animation: each property has its own track of keyframes, and
// each keyframe sets the curve the value follows to the next keyframe.
//
// { length: seconds, tracks: { aperture: [{ t, v, ease }], ... } }
//   aperture  f-number (eases in f-stops, on a log scale)
//   depth     the Depth slider (-100..100)
//   focus     focus value
//   view      [u, v] viewpoint
//   zoom      1..3
//   pan       [x, y], -1..1 each
// ease: { type: 'linear' | 'smooth' | 'in' | 'out' | 'hold' | 'custom',
//         bezier: [x1, y1, x2, y2] } (custom: a cubic Bezier from (0, 0) to
//         (1, 1) through those handles; y may leave 0..1 to overshoot).

export const TRACKS = ['aperture', 'depth', 'focus', 'view', 'zoom', 'pan'];
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

const isVec = (k) => k === 'view' || k === 'pan';

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
  for (const k of TRACKS) {
    const list = a.tracks && Array.isArray(a.tracks[k]) ? a.tracks[k] : [];
    out.tracks[k] = list
      .filter((key) => key && Number.isFinite(key.t) && (isVec(k) ? Array.isArray(key.v) && key.v.length === 2 : Number.isFinite(key.v)))
      .map((key) => ({ t: Math.max(0, key.t), v: key.v, ease: normalizeEase(key.ease) }))
      .sort((x, y) => x.t - y.t);
  }
  return out;
}

function normalizeEase(e) {
  const type = e && ['linear', 'smooth', 'in', 'out', 'hold', 'custom'].includes(e.type) ? e.type : 'smooth';
  const b = e && Array.isArray(e.bezier) && e.bezier.length === 4 && e.bezier.every(Number.isFinite) ? e.bezier : PRESETS.smooth;
  return { type, bezier: [Math.min(1, Math.max(0, b[0])), b[1], Math.min(1, Math.max(0, b[2])), b[3]] };
}

export function defaultEase() {
  return { type: 'smooth', bezier: [...PRESETS.smooth] };
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

function mix(k, a, b, e) {
  if (k === 'aperture') return Math.exp(Math.log(a) + (Math.log(b) - Math.log(a)) * e);
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
  const x = (t - a.t) / Math.max(1e-9, b.t - a.t);
  return mix(k, a.v, b.v, easeFunction(a.ease)(x));
}

export function frameCount(anim) {
  return Math.max(1, Math.round(anim.length * FPS) + 1);
}

// Values of every track at every frame: [{ aperture, depth, ... }] (missing
// tracks undefined).
export function sample(anim) {
  const n = frameCount(anim);
  return Array.from({ length: n }, (_, i) => Object.fromEntries(TRACKS.map((k) => [k, valueAt(anim, k, i / FPS)])));
}

export function hasKeys(anim) {
  return TRACKS.some((k) => anim.tracks[k].length);
}

// Sets (or replaces) the keyframe of track k at time t.
export function setKey(anim, k, t, v) {
  const keys = anim.tracks[k];
  const at = keys.findIndex((key) => Math.abs(key.t - t) < 0.5 / FPS);
  if (at >= 0) keys[at] = { ...keys[at], v };
  else keys.push({ t, v, ease: defaultEase() });
  keys.sort((x, y) => x.t - y.t);
  return anim;
}
