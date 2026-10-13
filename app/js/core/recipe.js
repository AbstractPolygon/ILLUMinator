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
  const tx = num(r.viewTiltX, 0) * LAMBDA_TO_ALPHA;
  const ty = num(r.viewTiltY, 0) * LAMBDA_TO_ALPHA;
  let tilt = (Math.hypot(tx, ty) / FOCUS_RANGE) * 100;
  let rotation = tilt > 0 ? (Math.atan2(ty, tx) * 180) / Math.PI : 0;
  if (rotation > 90) {
    rotation -= 180;
    tilt = -tilt;
  } else if (rotation < -90) {
    rotation += 180;
    tilt = -tilt;
  }
  camera.tilt = Math.round(clamp(tilt, -100, 100));
  camera['tilt-rotation'] = Math.round(rotation);
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
  process['tone-highlights'] = num(r.viewHighlights2, 0);
  process['tone-shadows'] = num(r.viewShadows2, 0);
  process['tone-whites'] = num(r.viewWhites2, 0);
  process['tone-blacks'] = num(r.viewBlacks2, 0);
  process.saturation = num(r.viewSaturation, 0);
  process.vibrance = num(r.viewVibrance, 0);
  for (const h of HUES) process[`hue-${h}`] = num(r[`viewSaturation${h[0].toUpperCase()}${h.slice(1)}`], 0);

  // Details. Lytro's noise reduction defaults to 50 on its own renders,
  // which are noisier than ours; 40% of its strength looks alike.
  details['sharp-amount'] = clamp(num(r.viewSharpness2, 25), 0, 150);
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
  if (r.viewFx && Array.isArray(r.viewFx.fxContainerSequence) && r.viewFx.fxContainerSequence.length) unsupported.push('effects');

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
      view: { u: clamp(num(r.viewPerspectiveU, 0), -1, 1) * radius, v: clamp(num(r.viewPerspectiveV, 0), -1, 1) * radius },
      focusPoint: { x: clamp(num(r.viewFocusX, 0.5), 0, 1), y: clamp(num(r.viewFocusY, 0.5), 0, 1) },
    },
    unsupported,
  };
}
