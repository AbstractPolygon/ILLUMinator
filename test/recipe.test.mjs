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
