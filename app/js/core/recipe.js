// Lytro Desktop edits ("recipes") -> ILLUMinator edits.
//
// Lytro Desktop keeps a picture's edits in its views[].recipe..recipe5 (in a
// stack.view.lfp next to raw.lfp, or inside exported .lfp files). Its tone
// and color fields follow Adobe Camera Raw (crs:*), so most map one to one;
// focus, spread and tilt are in lambda, converted with LAMBDA_TO_ALPHA.

// ILLUMinator focus value per Lytro lambda, measured by fitting our depth
// map of an ILLUM photo against Lytro Desktop's for the same shot
// (alpha = 0.0814 lambda + 0.001, r = 0.998).
export const LAMBDA_TO_ALPHA = 0.0814;

const F_STOPS = [22, 16, 11, 8, 5.6, 4, 2.8, 2, 1.4, 1, 0.7, 0.5];
const FOCUS_RANGE = 1.6;
const HUES = ['red', 'yellow', 'green', 'cyan', 'blue', 'magenta'];
const PRESET_KELVIN = { daylight: 5500, cloudy: 6500, shade: 7500, tungsten: 2850, fluorescent: 3800, flash: 5500 };

// The newest recipe in a table of contents, or null.
export function findRecipe(toc) {
  for (const view of Array.isArray(toc && toc.views) ? toc.views : []) {
    for (const key of ['recipe5', 'recipe4', 'recipe3', 'recipe2', 'recipe']) {
      if (view && view[key] && typeof view[key] === 'object') return { version: key, ...view[key] };
    }
  }
  return null;
}

const num = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// ctx: { nativeF (camera f-number), asShot (kelvin), radius (camera view
// drag radius), viewWidth (camera view width in pixels) }.
// Returns { edits, unsupported: [field names with no equivalent] }.
export function recipeToEdits(recipe, ctx = {}) {
  const { nativeF = 2, asShot = 5500, radius = 4.5, viewWidth = 615 } = ctx;
  const r = recipe || {};
  const unsupported = [];
  const process = {};
  const camera = {};
  const details = {};
  const defringe = {};
  const geometry = {};

  // Camera: aperture is a fraction of the camera's own (f/2 on the ILLUM).
  const aperture = num(r.viewAperture, 1);
  if (aperture > 0) {
    const f = nativeF / aperture;
    let best = 0;
    F_STOPS.forEach((n, i) => {
      if (Math.abs(Math.log(n / f)) < Math.abs(Math.log(F_STOPS[best] / f))) best = i;
    });
    camera.fstop = best;
  }
  camera.focus = clamp(num(r.viewFocus, 0) * LAMBDA_TO_ALPHA, -FOCUS_RANGE, FOCUS_RANGE);
  camera.spread = Math.round(clamp((num(r.viewFocusSpread, 0) * LAMBDA_TO_ALPHA) / FOCUS_RANGE * 100, 0, 100));
  // Tilt: change in lambda from edge to edge, as a direction and amount.
  const tilted = tiltOf(num(r.viewTiltX, 0), num(r.viewTiltY, 0));
  camera.tilt = tilted.tilt;
  camera['tilt-rotation'] = tilted.rotation;
  // Perspective pivot (lambda; Lytro Desktop's default, -20, is its own
  // automatic pivot).
  const pivot = num(r.viewPivot, -20);
  camera['pivot-on'] = pivot !== -20;
  camera.pivot = camera['pivot-on'] ? Math.round(clamp((pivot * LAMBDA_TO_ALPHA) / FOCUS_RANGE * 100, -100, 100)) : 0;

  // Process.
  process.ev = clamp(num(r.viewExposure, 0), -3, 3);
  const wb = r.viewWhiteBalance || 'as shot';
  process.awb = wb === 'auto';
  if (wb === 'custom' && typeof r.viewTemperature === 'number') process['wb-temperature'] = Math.round(clamp(r.viewTemperature, 2000, 10000) / 50) * 50;
  else if (PRESET_KELVIN[wb]) process['wb-temperature'] = PRESET_KELVIN[wb];
  else process['wb-temperature'] = Math.round(asShot / 50) * 50;
  process['wb-tint'] = Math.round(clamp(wb === 'custom' ? num(r.viewTint, 0) : 0, -150, 150));
  process['tone-contrast'] = num(r.viewContrast, 0);
  process['tone-highlights'] = num(r.viewHighlights2, num(r.viewHighlights, 0));
  process['tone-shadows'] = num(r.viewShadows2, num(r.viewShadows, 0));
  process['tone-whites'] = num(r.viewWhites2, num(r.viewWhites, 0));
  process['tone-blacks'] = num(r.viewBlacks2, num(r.viewBlacks, 0));
  process.saturation = num(r.viewSaturation, 0);
  process.vibrance = num(r.viewVibrance, 0);
  for (const h of HUES) process[`hue-${h}`] = num(r[`viewSaturation${h[0].toUpperCase()}${h.slice(1)}`], 0);
  // Tone curve: its points, and the parametric curve's four regions (at
  // Lytro's default splits; others are moved to ours).
  const points = r.viewLuminanceToneCurve && Array.isArray(r.viewLuminanceToneCurve.controlPoints) ? r.viewLuminanceToneCurve.controlPoints : null;
  if (points && points.length >= 2) {
    const list = points.filter((q) => q && Number.isFinite(q.x) && Number.isFinite(q.y)).map((q) => [clamp(q.x, 0, 1), clamp(q.y, 0, 1)]).sort((a, b) => a[0] - b[0]);
    if (list.length >= 2) process['curve-points'] = list.map(([x, y]) => `${+x.toFixed(4)},${+y.toFixed(4)}`).join(';');
  }
  for (const [field, id] of [['Highlights', 'highlights'], ['Lights', 'lights'], ['Darks', 'darks'], ['Shadows', 'shadows']]) {
    process[`curve-${id}`] = Math.round(clamp(num(r[`viewParametric${field}`], 0), -100, 100));
  }
  const splits = [[r.viewParametricShadowSplit, 25], [r.viewParametricMidtoneSplit, 50], [r.viewParametricHighlightSplit, 75]];
  if (splits.some(([v, d]) => Number.isFinite(v) && Math.abs(v - d) > 2)) unsupported.push('tone curve region splits');
  // A custom color matrix.
  if (Array.isArray(r.viewCcm) && r.viewCcm.length === 9 && r.viewCcm.every(Number.isFinite)) {
    process['ccm-mode'] = 'custom';
    r.viewCcm.forEach((v, i) => { process[`ccm-${i}`] = Math.round(v * 1000) / 1000; });
  }

  // Details. Lytro's noise reduction defaults to 50 on its own renders,
  // which are noisier than ours; 40% of its strength looks alike.
  details['sharp-amount'] = clamp(num(r.viewSharpness2, num(r.viewSharpness, 25)), 0, 150);
  details['sharp-radius'] = clamp(num(r.viewSharpenRadius, 1), 0.5, 3);
  details['sharp-detail'] = clamp(num(r.viewSharpenDetail, 25), 0, 100);
  details['sharp-masking'] = clamp(num(r.viewSharpenEdgeMasking, 0), 0, 100);
  details['nr-luminance'] = Math.round(clamp(num(r.viewLuminanceNoiseReduction, 50) * 0.4, 0, 100));
  details['nr-color'] = Math.round(clamp(num(r.viewColorNoiseReduction, 50) * 0.4, 0, 100));

  // Optics: Lytro's defringe finds the colors itself, like our Auto. Its
  // radius is in pixels of its full size render (about 2450 wide).
  defringe['flare-on'] = !!r.viewReduceFlare;
  defringe['fringe-on'] = !!r.viewDefringe;
  defringe['fringe-auto'] = !!r.viewDefringe;
  defringe['fringe-radius'] = Math.round(clamp((num(r.viewDefringeRadius, 5.5) * viewWidth) / 2450 * 2, 1, 6));
  defringe['fringe-threshold'] = Math.round(clamp(0.05 + (0.75 * num(r.viewDefringeThreshold, 50)) / 100, 0.05, 0.8) * 20) / 20;

  // Geometry: the crop is left/top/right/bottom fractions of the picture,
  // the straightening angle in degrees; orientation is an EXIF code.
  const crop = r.viewCrop || {};
  const left = clamp(num(crop.left, 0), 0, 1);
  const top = clamp(num(crop.top, 0), 0, 1);
  const right = clamp(num(crop.right, 1), left, 1);
  const bottom = clamp(num(crop.bottom, 1), top, 1);
  geometry.orientation = Math.round(clamp(num(r.viewOrientation, 1), 1, 8));
  geometry.straighten = Math.round(clamp(num(crop.angle, 0), -45, 45) * 10) / 10;
  geometry['crop-aspect'] = 'free';
  geometry['crop-x'] = left;
  geometry['crop-y'] = top;
  geometry['crop-w'] = right - left || 1;
  geometry['crop-h'] = bottom - top || 1;

  // Pan and zoom: Lytro's window is `zoom` times smaller than the picture,
  // centered at (panX, panY); ours pans by a fraction of the room left.
  const animation = {};
  const zoom = clamp(num(r.viewZoom, 1), 1, 3);
  animation['frame-zoom'] = Math.round(zoom * 20) * 5;
  animation['frame-pan-x'] = Math.round(panAmount(num(r.viewPanX, 0.5), zoom) * 100);
  animation['frame-pan-y'] = Math.round(panAmount(num(r.viewPanY, 0.5), zoom) * 100);

  // 3D: Lytro's baseline is the distance between the eyes, in lens radii;
  // ours is how far each eye is from the middle.
  const rendering = {};
  const baseline = num(r.viewStereoBaseline, 0);
  if (baseline > 0) rendering['stereo-baseline'] = Math.round(clamp((baseline / 2) * 100, 10, 100) / 5) * 5;
  if (num(r.viewStereoPivot, 0) !== 0) unsupported.push('3D pivot');

  // Animations: Lytro's keyframes, curves included, on our tracks.
  const keyed = recipeAnimation(r, { nativeF, radius, unsupported });
  if (keyed) {
    animation['anim-on'] = true;
    animation.anim = 'keyframes';
    animation['anim-keys'] = JSON.stringify(keyed);
    if (keyed.tracks.tilt) camera['tilt-on'] = true;
    if (keyed.tracks.pivot) camera['pivot-on'] = true;
  }

  // Effects: each of Lytro's containers becomes a local adjustment, and the
  // older living filter one of ours.
  const masks = recipeMasks(r.viewFx, unsupported);
  const lytroFilter = LIVING_FILTERS[r.viewFilterEffect];
  if (r.viewFilterEffect && r.viewFilterEffect !== 'none' && !lytroFilter) unsupported.push(`the ${r.viewFilterEffect} filter`);

  return {
    edits: {
      format: 'illuminator-edits',
      version: 1,
      source: { lytroRecipe: r.version || 'recipe' },
      process,
      camera,
      details,
      defringe,
      geometry,
      animation,
      rendering,
      ...(masks.length ? { local: { 'local-masks': JSON.stringify(masks) } } : {}),
      ...(lytroFilter ? { lytroFilter } : {}),
      view: { u: clamp(num(r.viewPerspectiveU, 0), -1, 1) * radius, v: clamp(num(r.viewPerspectiveV, 0), -1, 1) * radius },
      focusPoint: { x: clamp(num(r.viewFocusX, 0.5), 0, 1), y: clamp(num(r.viewFocusY, 0.5), 0, 1) },
    },
    unsupported,
  };
}

// Lytro's pan center (0..1 across the picture) -> our pan (-1..1 of the
// room the zoom leaves).
function panAmount(center, zoom) {
  const room = (1 - 1 / zoom) / 2;
  return room > 1e-6 ? clamp((center - 0.5) / room, -1, 1) : 0;
}

// Lytro Desktop's living filters with one of ours like them.
const LIVING_FILTERS = { 'Film Noir': 'noir', Carnival: 'carnival', Mosaic: 'mosaic', Crayon: 'crayon', 'Blur+': 'blurplus', Pop: 'pop' };

// ---------------------------------------------------------------- animation

// One Lytro animation as keys of raw values: [{ t, v, ease }]. The first
// key is at 0 (its initial value, else the setting's own); the rest follow
// at their times (1 s apart where times are missing). handlePairs bend the
// curve into each key; a key without one is reached in a straight line.
// Null when the setting is not animated.
export function lytroKeys(anim, still) {
  if (!anim || !Array.isArray(anim.values) || !anim.values.length) return null;
  const values = anim.values.filter(Number.isFinite);
  if (!values.length) return null;
  const times = (Array.isArray(anim.times) ? anim.times : []).filter(Number.isFinite);
  const v0 = Number.isFinite(anim.initialValue) ? anim.initialValue : Number.isFinite(still) ? still : values[0];
  const keys = [{ t: 0, v: v0 }];
  values.forEach((v, i) => {
    const prev = keys[keys.length - 1].t;
    const t = i < times.length && times[i] > prev ? times[i] : prev + 1;
    keys.push({ t, v });
  });
  const pairs = Array.isArray(anim.handlePairs) ? anim.handlePairs : [];
  return keys.map((k, i) => {
    const next = keys[i + 1];
    return { ...k, ease: next ? segmentEase(k, next, pairs[i]) : { type: 'linear' } };
  });
}

// The curve from key a to key b, from Lytro's handles: the first leaves a
// by (dt0, dv0), the second arrives at b from (dt1, dv1) (pointing back).
function segmentEase(a, b, h) {
  if (!h || ![h.dt0, h.dv0, h.dt1, h.dv1].every(Number.isFinite)) return { type: 'linear' };
  const T = b.t - a.t;
  const D = b.v - a.v;
  if (!(T > 0)) return { type: 'linear' };
  const back = h.dt1 <= 0 ? 1 : -1;
  const x1 = clamp(h.dt0 / T, 0, 1);
  const x2 = clamp(1 + (back * h.dt1) / T, 0, 1);
  if (Math.abs(D) < 1e-9) return x1 < 0.05 && x2 > 0.95 ? { type: 'linear' } : { type: 'smooth' };
  const y1 = clamp(h.dv0 / D, -1, 2);
  const y2 = clamp(1 + (back * h.dv1) / D, -1, 2);
  return { type: 'custom', bezier: [x1, y1, x2, y2].map((n) => Math.round(n * 1000) / 1000) };
}

// The value of raw keys at time t (straight lines between them).
function rawAt(keys, t, still) {
  if (!keys) return still;
  if (t <= keys[0].t) return keys[0].v;
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i].t) {
      const a = keys[i - 1];
      const b = keys[i];
      return a.v + ((b.v - a.v) * (t - a.t)) / (b.t - a.t || 1);
    }
  }
  return keys[keys.length - 1].v;
}

const roundTo = (v, step) => Math.round(v / step) * step;

// Every animated setting of a recipe as our animation, or null.
export function recipeAnimation(r, { nativeF = 2, radius = 4.5, unsupported = [] } = {}) {
  const tracks = {};
  const raw = (field) => lytroKeys(r[`${field}Animation`], r[field]);
  const put = (name, keys, convert) => {
    if (keys) tracks[name] = keys.map((k) => ({ t: k.t, v: convert(k.v, k.t), ease: k.ease }));
  };
  const lambda = (l) => clamp(l * LAMBDA_TO_ALPHA, -FOCUS_RANGE, FOCUS_RANGE);
  const percentOfRange = (l) => clamp((l * LAMBDA_TO_ALPHA) / FOCUS_RANGE * 100, -100, 100);

  // Camera.
  put('aperture', raw('viewAperture'), (a) => clamp(nativeF / Math.max(0.05, a), 0.5, 22));
  put('focus', raw('viewFocus'), lambda);
  put('spread', raw('viewFocusSpread'), (l) => Math.round(clamp(percentOfRange(l), 0, 100)));
  put('pointX', raw('viewFocusX'), (v) => clamp(v, 0, 1));
  put('pointY', raw('viewFocusY'), (v) => clamp(v, 0, 1));
  put('pivot', raw('viewPivot'), (l) => Math.round(percentOfRange(l)));
  // Pairs (tilt, viewpoint) key at the times of either.
  const pair = (fx, fy, make) => {
    const kx = raw(fx);
    const ky = raw(fy);
    if (!kx && !ky) return null;
    const times = [...new Set([...(kx || []), ...(ky || [])].map((k) => k.t))].sort((a, b) => a - b);
    const same = kx && ky && kx.length === ky.length && kx.every((k, i) => k.t === ky[i].t);
    const easeOf = (t) => (same || !ky ? kx : !kx ? ky : null)?.find((k) => k.t === t)?.ease || { type: 'linear' };
    return times.map((t) => ({ t, v: make(rawAt(kx, t, num(r[fx], 0)), rawAt(ky, t, num(r[fy], 0))), ease: easeOf(t) }));
  };
  const tilt = pair('viewTiltX', 'viewTiltY', (x, y) => tiltOf(x, y));
  if (tilt) {
    tracks.tilt = tilt.map((k) => ({ ...k, v: k.v.tilt }));
    tracks.tiltRotation = tilt.map((k) => ({ ...k, v: k.v.rotation }));
  }
  const view = pair('viewPerspectiveU', 'viewPerspectiveV', (u, v) => [clamp(u, -1, 1) * radius, clamp(v, -1, 1) * radius]);
  if (view) tracks.view = view;
  // Pan and zoom.
  const zoomKeys = raw('viewZoom');
  put('zoom', zoomKeys, (z) => clamp(z, 1, 3));
  const zoomAt = (t) => clamp(rawAt(zoomKeys, t, num(r.viewZoom, 1)), 1, 3);
  put('panX', raw('viewPanX'), (c, t) => panAmount(c, zoomAt(t)));
  put('panY', raw('viewPanY'), (c, t) => panAmount(c, zoomAt(t)));

  // Process and Optics sliders.
  const set = (id, field, convert = (v) => v) => put(`set:${id}`, raw(field), convert);
  set('ev', 'viewExposure', (v) => roundTo(clamp(v, -3, 3), 0.05));
  set('wb-temperature', 'viewTemperature', (v) => roundTo(clamp(v, 2000, 10000), 50));
  set('wb-tint', 'viewTint', (v) => Math.round(clamp(v, -150, 150)));
  set('tone-contrast', 'viewContrast');
  for (const [id, field] of [['tone-highlights', 'Highlights'], ['tone-shadows', 'Shadows'], ['tone-whites', 'Whites'], ['tone-blacks', 'Blacks']]) {
    set(id, r[`view${field}2Animation`] ? `view${field}2` : `view${field}`);
  }
  set('saturation', 'viewSaturation');
  set('vibrance', 'viewVibrance');
  for (const h of HUES) set(`hue-${h}`, `viewSaturation${h[0].toUpperCase()}${h.slice(1)}`);
  set('fringe-threshold', 'viewDefringeThreshold', (v) => roundTo(clamp(0.05 + (0.75 * v) / 100, 0.05, 0.8), 0.05));

  // Not keyframed in ILLUMinator: these keep their value at the start.
  const still = { sharpening: ['viewSharpness2', 'viewSharpness', 'viewSharpenRadius', 'viewSharpenDetail', 'viewSharpenEdgeMasking'], 'noise reduction': ['viewLuminanceNoiseReduction', 'viewColorNoiseReduction'], 'defringe radius': ['viewDefringeRadius'], '3D': ['viewStereoBaseline', 'viewStereoPivot'] };
  for (const [name, fields] of Object.entries(still)) if (fields.some((f) => raw(f))) unsupported.push(`${name} animation`);

  const names = Object.keys(tracks);
  if (!names.length) return null;
  const end = Math.max(...names.map((k) => tracks[k][tracks[k].length - 1].t));
  return { length: Math.min(120, Math.max(1, Math.ceil(end * 10) / 10)), tracks };
}

// Lytro's tilt (change in lambda across the picture, x and y) -> our Tilt
// and its rotation.
function tiltOf(lx, ly) {
  const tx = lx * LAMBDA_TO_ALPHA;
  const ty = ly * LAMBDA_TO_ALPHA;
  let tilt = (Math.hypot(tx, ty) / FOCUS_RANGE) * 100;
  let rotation = tilt > 0 ? (Math.atan2(ty, tx) * 180) / Math.PI : 0;
  if (rotation > 90) {
    rotation -= 180;
    tilt = -tilt;
  } else if (rotation < -90) {
    rotation += 180;
    tilt = -tilt;
  }
  return { tilt: Math.round(clamp(tilt, -100, 100)), rotation: Math.round(rotation) };
}

// ---------------------------------------------------------------- effects

// Lytro's depth masks run from the nearest (0) to the farthest (1) depth in
// the picture; ours are in focus values. A typical ILLUM picture spans about
// this range.
const DEPTH_SPAN = [-1.2, 1.2];

// viewFx -> our local adjustments (core/local.js). Each enabled container is
// one mask: its first mask effect gives the shape, its color effects the
// effects. What has no equivalent is listed in `unsupported`.
export function recipeMasks(viewFx, unsupported = []) {
  const containers = viewFx && Array.isArray(viewFx.fxContainerSequence) ? viewFx.fxContainerSequence : [];
  const masks = [];
  const missing = new Set();
  const allOn = !viewFx || viewFx.fxEnable !== false;
  containers.forEach((c, i) => {
    if (!c || !Array.isArray(c.fxSequence) || masks.length >= 16) return;
    const effects = c.fxSequence.filter((e) => e && e.enable !== false);
    const shapes = effects.filter((e) => /Mask$/.test(e.kind || ''));
    const fx = { exposure: 0, contrast: 0, saturation: 0, temperature: 0, tint: 0, blur: 0, pixelate: 0, sketch: 0 };
    for (const e of effects) {
      switch (e.kind) {
        case 'fxExposure':
          fx.exposure += num(e.exposure, 0);
          break;
        case 'fxContrastBrightness':
          fx.contrast += num(e.contrast, 0) / 100;
          fx.exposure += num(e.brightness, 0) / 100; // about one stop at full brightness
          break;
        case 'fxSaturation':
          fx.saturation += num(e.saturation, 0) / 100;
          break;
        case 'fxColorize': {
          // A gray ramp is black and white; colored ones are not supported.
          const pts = Array.isArray(e.controlPoints) ? e.controlPoints : [];
          if (pts.length && pts.every((q) => Math.abs(q.r - q.g) < 0.02 && Math.abs(q.g - q.b) < 0.02)) fx.saturation = -1;
          else missing.add('colorize');
          break;
        }
        case 'fxHue':
          if (num(e.hue, 0)) missing.add('hue shift');
          break;
        case 'fxColor':
          missing.add('color fill');
          break;
        case 'fxImage':
          missing.add('inserted images');
          break;
        default:
          break;
      }
    }
    fx.exposure = clamp(fx.exposure, -2, 2);
    fx.contrast = clamp(fx.contrast, -1, 1);
    fx.saturation = clamp(fx.saturation, -1, 1);
    if (shapes.length > 1) missing.add('combined masks');
    const mask = maskShape(shapes[0], missing);
    // How much of the effects shows (the container's color blend).
    const blend = c.fxColorCombiner;
    const strength = blend && blend.compositionMode && blend.compositionMode !== 'off' && Number.isFinite(blend.compositionWeight) && blend.compositionWeight > 0 ? clamp(blend.compositionWeight, 0, 1) : 1;
    masks.push({ id: `lytro${i + 1}`, name: `Lytro effect ${i + 1}`, on: allOn && c.fxEnable !== false, strength, follow: false, anchor: 0, ...mask, fx });
  });
  if (missing.size) unsupported.push(`effects: ${[...missing].join(', ')}`);
  return masks;
}

// A Lytro mask effect -> our mask's kind and shape (the whole picture when
// there is none).
function maskShape(e, missing) {
  const invert = !!(e && e.maskInvert);
  const depthRange = () => {
    const at = (d) => DEPTH_SPAN[0] + clamp(num(d, 0), 0, 1) * (DEPTH_SPAN[1] - DEPTH_SPAN[0]);
    let near = at(e.falloffNear);
    let far = at(e.falloffFar);
    if (near > far) [near, far] = [far, near];
    const mid = (near + far) / 2;
    const half = (far - near) / 2;
    // Lytro fades over the whole range; ours is full between near and far
    // and fades over the feather.
    return { near: mid - half / 2, far: mid + half / 2, feather: clamp(half / 2 + num(e.depthBlurRadius, 0), 0.01, 1) };
  };
  if (e && (e.kind === 'fxEllipticalMask' || e.kind === 'fxEllipticalDepthMask')) {
    if (e.kind === 'fxEllipticalDepthMask') missing.add('masks by both place and depth (kept by place)');
    const p = num(e.dualAspectRatio, 0);
    const sx = p < 0 ? 1 + p : 1;
    const sy = p > 0 ? 1 - p : 1;
    const inner = Math.max(0.01, num(e.radius, 0.25));
    const outer = inner + Math.max(0, num(e.falloffRadius, 0));
    // Sizes are fractions of the picture's height; ours of its width and
    // height (a 3:2 picture assumed for the width).
    let across = outer * sx;
    let down = outer * sy;
    const angle = ((num(e.angle, 0) % 180) + 180) % 180;
    if (angle > 45 && angle < 135) [across, down] = [down, across];
    const w = across / 1.5;
    const h = down;
    if (angle % 90 > 10 && angle % 90 < 80) missing.add('rotated ellipses');
    return { kind: 'radial', invert, x: clamp(num(e.centerX, 0.5), -0.5, 1.5), y: clamp(num(e.centerY, 0.5), -0.5, 1.5), w: clamp(w, 0.02, 1), h: clamp(h, 0.02, 1), feather: clamp(1 - inner / outer, 0, 1) };
  }
  if (e && e.kind === 'fxDepthMask') return { kind: 'depth', invert, ...depthRange() };
  // No mask: the whole picture.
  return { kind: 'depth', invert: false, near: -3, far: 3, feather: 0.2 };
}
