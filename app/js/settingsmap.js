// How the page's controls become the settings object the engine renders with.
//
// Most settings are one control read one way, so they are rows in a table: [path in the settings object, control id, how to read it]. A new slider that changes the picture is
// one row here (and its id in EDIT_GROUPS in edits.js, so it is saved with the photo; test/settings-saved.test.mjs checks both), plus the worker reading the setting. The few
// that are built from several controls (the curve, the color matrix, the fringe colors) are written out below the tables.
//
// The functions take `c`, a way to read the controls: `c.el(id)` is the element, `c.num(id)` the number a slider holds (an animation frame's keyframed value, when one is
// being rendered). That keeps this file free of the page, so it can be tested with plain objects (test/settings.test.mjs).

import { parsePoints } from './core/curve.js';

export const TONES = ['contrast', 'highlights', 'shadows', 'whites', 'blacks'];
export const HUE_SLIDERS = ['red', 'yellow', 'green', 'cyan', 'blue', 'magenta'];
export const FRINGES = ['purple', 'green', 'red', 'blue'];
export const CURVE_REGIONS = ['shadows', 'darks', 'lights', 'highlights'];

// How a control's value is read: a name here, or a function (element, num) => value.
const READ = {
  num: (el, num) => num,
  pct: (el, num) => num / 100, // a slider in percent that the engine takes as 0..1
  gain: (el, num) => 1 + num / 100, // a slider in percent around 0 that the engine takes as a factor around 1
  bool: (el) => el.checked,
  str: (el) => el.value,
};

// Process and Optics: what the color pass applies.
export const COLOR_SETTINGS = [
  ['lutAmount', 'lut-amount', 'pct'],
  ['ev', 'ev', 'num'],
  ['lytroLook', 'base-look', (el) => el.value !== 'flat'],
  ['saturation', 'saturation', 'gain'],
  ['autoWb', 'awb', 'bool'],
  ['wb.kelvin', 'wb-temperature', 'num'],
  ['wb.tint', 'wb-tint', 'num'],
  ...TONES.map((k) => [`tone.${k}`, `tone-${k}`, 'pct']),
  ['useCcm', 'ccm-mode', (el) => el.value !== 'none'],
  ['color.vibrance', 'vibrance', 'pct'],
  ...HUE_SLIDERS.map((k) => [`color.${k}`, `hue-${k}`, 'pct']),
  ['flare.on', 'flare-on', 'bool'],
  ['flare.amount', 'flare-amount', 'pct'],
  ['lens.auto', 'lens-auto', 'bool'],
  ['lens.distortion', 'lens-distortion', 'num'],
  ['lens.vignetting', 'lens-vignetting', 'num'],
  ['lens.midpoint', 'lens-midpoint', 'num'],
  ['defringe.on', 'fringe-on', 'bool'],
  ['defringe.auto', 'fringe-auto', 'bool'],
  ['defringe.radius', 'fringe-radius', 'num'],
  ['defringe.threshold', 'fringe-threshold', 'num'],
];

// Everything else the engine is sent along with the color settings.
export const RENDER_SETTINGS = [
  ['mvDenoise.on', 'mv-on', 'bool'],
  ['mvDenoise.blend', 'mv-blend', 'pct'],
  ['hotPixels', 'nr-hot', 'bool'],
  ['depthSmoothing', 'depth-smooth', 'pct'],
  ['depthQuality', 'depth-hq', (el) => (el.checked ? 'high' : 'normal')],
  ['depthStyle', 'depth-style', 'str'],
  ['depthBlend', 'depth-blend', 'pct'],
  ['depthModelBlend', 'depth-model-blend', 'pct'],
  ['depthModelSmooth', 'depth-model-smooth', 'pct'],
  ['depthModelCurve', 'depth-model-curve', 'pct'],
  ['depthContrast', 'depth-contrast', 'pct'],
  ['depthObjects', 'depth-objects', 'bool'],
  ['depthObjectSoft', 'depth-objects-soft', 'pct'],
  ['lytroDepth', 'lytro-depth', 'bool'],
  ['lensCentres', 'lens-centres', 'str'],
  ['latticeOn', 'lattice-on', 'bool'],
  ['latticeStrength', 'lattice-strength', 'pct'],
  ['latticeDetect', 'lattice-detect', 'pct'],
  ['details.amount', 'sharp-amount', 'num'],
  ['details.radius', 'sharp-radius', 'num'],
  ['details.detail', 'sharp-detail', 'num'],
  ['details.masking', 'sharp-masking', 'num'],
  ['details.luminance', 'nr-luminance', 'num'],
  ['details.color', 'nr-color', 'num'],
  ['details.dust', 'nr-dust', 'num'],
  ['details.speckle', 'nr-speckle', 'num'],
  ['details.speckleSize', 'nr-speckle-size', 'num'],
  ['detail', 'detail', 'num'],
];

function setPath(object, path, value) {
  const keys = path.split('.');
  let at = object;
  for (const key of keys.slice(0, -1)) at = at[key] ??= {};
  at[keys[keys.length - 1]] = value;
}

// The table's rows read through `c` into a new object.
export function readTable(table, c) {
  const out = {};
  for (const [path, id, how] of table) {
    const read = typeof how === 'function' ? how : READ[how];
    if (!read) throw new Error(`settings table: no way to read "${how}" (${path})`);
    setPath(out, path, read(c.el(id), c.num(id)));
  }
  return out;
}

// The settings the color pass applies (Process and Optics).
export function colorSettings(c) {
  const settings = readTable(COLOR_SETTINGS, c);
  settings.curve = { points: parsePoints(c.el('curve-points').value), regions: CURVE_REGIONS.map((k) => c.num(`curve-${k}`) / 100) };
  settings.ccm = c.el('ccm-mode').value === 'custom' ? Array.from({ length: 9 }, (_, i) => +c.el(`ccm-${i}`).value || 0) : null;
  // [amount, hue] for purple, green, red and blue fringes.
  settings.defringe.colors = FRINGES.map((key) => [c.num(`fringe-${key}`), (c.num(`fringe-${key}-hue`) + 360) % 360]);
  return settings;
}

// All the settings the page sends the engine: the color ones, the rest of the table, and `local` (the local adjustments, which the page builds).
export function renderSettings(c, local) {
  return { ...colorSettings(c), ...readTable(RENDER_SETTINGS, c), local };
}
