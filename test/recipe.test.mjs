import test from 'node:test';
import assert from 'node:assert/strict';
import { findRecipe, recipeToEdits, LAMBDA_TO_ALPHA } from '../app/js/core/recipe.js';
import { isSidecarName } from '../app/js/platform.js';

test('finds the newest recipe in a view', () => {
  const toc = { views: [{ recipe4: { viewExposure: 1 }, accelerations: [] }] };
  assert.equal(findRecipe(toc).viewExposure, 1);
  assert.equal(findRecipe({ views: [] }), null);
});

test('converts Lytro Desktop edits to ILLUMinator controls', () => {
  const { edits, unsupported } = recipeToEdits({
    viewAperture: 0.5, viewFocus: -10, viewFocusX: 0.3, viewFocusY: 0.6, viewFocusSpread: 5,
    viewTiltX: 0, viewTiltY: 10, viewExposure: 0.5, viewWhiteBalance: 'tungsten',
    viewContrast: 20, viewSaturationBlue: -40, viewSharpness2: 40, viewLuminanceNoiseReduction: 50,
    viewDefringe: true, viewCrop: { angle: 0, top: 0.1, left: 0, bottom: 1, right: 1 },
  }, { nativeF: 2, asShot: 5000, radius: 4, viewWidth: 615 });
  assert.equal(edits.camera.fstop, 5); // f/4
  assert.ok(Math.abs(edits.camera.focus - -10 * LAMBDA_TO_ALPHA) < 1e-9);
  assert.deepEqual(edits.focusPoint, { x: 0.3, y: 0.6 });
  assert.equal(edits.camera['tilt-rotation'], 90);
  assert.equal(edits.process['wb-temperature'], 2850);
  assert.equal(edits.process['hue-blue'], -40);
  assert.equal(edits.details['nr-luminance'], 20);
  assert.equal(edits.defringe['fringe-on'], true);
  assert.equal(edits.camera['pivot-on'], false);
  assert.equal(edits.geometry['crop-y'], 0.1);
  assert.ok(Math.abs(edits.geometry['crop-h'] - 0.9) < 1e-9);
  assert.equal(edits.geometry.orientation, 1);
  assert.deepEqual(unsupported, []);
});

test('recognizes Lytro Desktop edits files', () => {
  assert.equal(isSidecarName('stack.view.lfp'), true);
  assert.equal(isSidecarName('STACK.VIEW.LFP'), true);
  assert.equal(isSidecarName('raw.lfp'), false);
  assert.equal(isSidecarName('stack.lfp'), false);
  assert.equal(isSidecarName('IMG_0001.lfr'), false);
});

import { lytroKeys, recipeAnimation, recipeMasks } from '../app/js/core/recipe.js';
import { parseAnimation, valueAt } from '../app/js/core/keyframes.js';

test('Lytro animations become keyframes, curves included', () => {
  // Times omit 0; missing times come 1 s apart; handles bend a segment.
  const keys = lytroKeys({ values: [1, 3], times: [2], handlePairs: [{ dv0: 0, dt0: 0.5, dv1: 0, dt1: -0.5 }] }, 0.5);
  assert.deepEqual(keys.map((k) => [k.t, k.v]), [[0, 0.5], [2, 1], [3, 3]]);
  assert.deepEqual(keys[0].ease, { type: 'custom', bezier: [0.25, 0, 0.75, 1] });
  assert.equal(keys[1].ease.type, 'linear');
  assert.equal(lytroKeys({ values: [], times: [], handlePairs: [] }, 0), null);

  const anim = recipeAnimation({
    viewFocus: 0, viewFocusAnimation: { values: [10], times: [2] },
    viewAperture: 1, viewApertureAnimation: { initialValue: 1, values: [0.25], times: [4] },
    viewExposure: 0, viewExposureAnimation: { values: [1.5], times: [1] },
    viewZoom: 1, viewZoomAnimation: { values: [2], times: [2] },
    viewPanX: 0.5, viewPanXAnimation: { values: [0.75], times: [2] },
    viewTiltX: 0, viewTiltXAnimation: { values: [5], times: [1] },
    viewSharpness2: 25, viewSharpness2Animation: { values: [60], times: [1] },
  }, { nativeF: 2 });
  assert.equal(anim.length, 4);
  const parsed = parseAnimation(JSON.stringify(anim));
  assert.ok(Math.abs(valueAt(parsed, 'focus', 2) - 10 * LAMBDA_TO_ALPHA) < 1e-9);
  assert.equal(valueAt(parsed, 'aperture', 0), 2);
  assert.equal(valueAt(parsed, 'aperture', 4), 8);
  assert.equal(valueAt(parsed, 'set:ev', 1), 1.5);
  assert.equal(valueAt(parsed, 'zoom', 2), 2);
  // At 2x the window can move a quarter of the picture each way.
  assert.equal(valueAt(parsed, 'panX', 2), 1);
  assert.ok(parsed.tracks.tilt.length === 2 && parsed.tracks.tiltRotation.length === 2);
});

test('animated recipes turn keyframe animation on; sharpening stays still', () => {
  const { edits, unsupported } = recipeToEdits({
    viewFocus: 0, viewFocusAnimation: { values: [5], times: [1] },
    viewSharpness2: 25, viewSharpness2Animation: { values: [60], times: [1] },
    viewTiltY: 0, viewTiltYAnimation: { values: [4], times: [1] },
    viewZoom: 2, viewPanX: 0.75, viewPanY: 0.5,
    viewStereoBaseline: 0.8,
    viewLuminanceToneCurve: { controlPoints: [{ x: 0, y: 0.1 }, { x: 0.5, y: 0.6 }, { x: 1, y: 1 }] },
    viewParametricDarks: -20,
    viewCcm: [1.2, -0.1, -0.1, 0, 1, 0, 0, -0.2, 1.2],
    viewHighlights: -30,
    viewFilterEffect: 'Film Noir',
  });
  assert.equal(edits.animation['anim-on'], true);
  assert.equal(edits.animation.anim, 'keyframes');
  assert.ok(JSON.parse(edits.animation['anim-keys']).tracks.focus.length === 2);
  assert.equal(edits.camera['tilt-on'], true);
  assert.ok(unsupported.includes('sharpening animation'));
  assert.equal(edits.animation['frame-zoom'], 200);
  assert.equal(edits.animation['frame-pan-x'], 100);
  assert.equal(edits.animation['frame-pan-y'], 0);
  assert.equal(edits.rendering['stereo-baseline'], 40);
  assert.equal(edits.process['curve-points'], '0,0.1;0.5,0.6;1,1');
  assert.equal(edits.process['curve-darks'], -20);
  assert.equal(edits.process['ccm-mode'], 'custom');
  assert.equal(edits.process['ccm-8'], 1.2);
  assert.equal(edits.process['tone-highlights'], -30);
  assert.equal(edits.lytroFilter, 'noir');
  // Unknown filters are reported.
  assert.ok(recipeToEdits({ viewFilterEffect: 'Glass' }).unsupported.includes('the Glass filter'));
});

test('Lytro effects become local adjustments', () => {
  const unsupported = [];
  const masks = recipeMasks({
    fxEnable: true,
    fxContainerSequence: [
      { fxEnable: true, fxSequence: [
        { kind: 'fxEllipticalMask', centerX: 0.4, centerY: 0.6, radius: 0.2, falloffRadius: 0.2, falloffOffsetX: 0, falloffOffsetY: 0, falloffBias: 0, maskInvert: true, maskCombiner: { compositionMode: 'on' } },
        { kind: 'fxExposure', exposure: -1 },
        { kind: 'fxSaturation', saturation: -50 },
      ] },
      { fxEnable: false, fxSequence: [
        { kind: 'fxDepthMask', falloffNear: 0.25, falloffFar: 0.75, falloffDepthShape: 'bell', falloffDepthBias: 0, depthBlurRadius: 0, maskInvert: false, maskCombiner: { compositionMode: 'on' } },
        { kind: 'fxColorize', inputChannel: 'luminance', controlPoints: [{ in: 0, r: 0, g: 0, b: 0 }, { in: 1, r: 1, g: 1, b: 1 }] },
        { kind: 'fxHue', hue: 40 },
      ] },
    ],
  }, unsupported);
  assert.equal(masks.length, 2);
  const [a, b] = masks;
  assert.equal(a.kind, 'radial');
  assert.equal(a.invert, true);
  assert.equal(a.x, 0.4);
  assert.equal(a.h, 0.4);
  assert.equal(a.feather, 0.5);
  assert.deepEqual([a.fx.exposure, a.fx.saturation], [-1, -0.5]);
  assert.equal(b.kind, 'depth');
  assert.equal(b.on, false);
  assert.equal(b.fx.saturation, -1);
  assert.ok(b.near < 0 && b.far > 0);
  assert.deepEqual(unsupported, ['effects: hue shift']);
});
