import test from 'node:test';
import assert from 'node:assert/strict';
import { geometry, apply, invert, rotateOrientation, flipOrientation, orientationParts, straightenScale, fitAspect } from '../app/js/core/geometry.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const nearPt = (p, q) => { near(p[0], q[0]); near(p[1], q[1]); };

test('no geometry maps pixels to themselves', () => {
  const g = geometry(600, 400);
  assert.equal(g.width, 600);
  assert.equal(g.height, 400);
  nearPt(apply(g.matrix, 10, 20), [10, 20]);
});

test('quarter turn clockwise puts the top left corner at the top right', () => {
  const g = geometry(600, 400, { orientation: 6 });
  assert.equal(g.width, 400);
  assert.equal(g.height, 600);
  nearPt(apply(g.matrix, 0, 0), [400, 0]);
  nearPt(apply(g.matrix, 600, 400), [0, 600]);
});

test('mirror swaps left and right', () => {
  const g = geometry(600, 400, { orientation: 2 });
  nearPt(apply(g.matrix, 0, 0), [600, 0]);
});

test('turning and mirroring compose like the picture on screen', () => {
  assert.equal(rotateOrientation(1, 1), 6);
  assert.equal(rotateOrientation(6, 1), 3);
  assert.equal(rotateOrientation(1, -1), 8);
  assert.equal(flipOrientation(1), 2);
  // Mirror after a clockwise turn: same as EXIF 7 (transverse).
  assert.equal(flipOrientation(6), 5);
  const g = geometry(600, 400, { orientation: flipOrientation(6) });
  // Turned clockwise, (0,0) -> (400,0); mirrored on screen -> (0,0).
  nearPt(apply(g.matrix, 0, 0), [0, 0]);
  for (let c = 1; c <= 8; c++) assert.ok(orientationParts(c));
});

test('straightening shrinks the frame so no corner is empty', () => {
  const s = straightenScale(600, 400, 5);
  assert.ok(s < 1 && s > 0.8);
  const g = geometry(600, 400, { angle: 5 });
  const inv = invert(g.matrix);
  for (const [x, y] of [[0, 0], [g.width, 0], [0, g.height], [g.width, g.height]]) {
    const [sx, sy] = apply(inv, x, y);
    assert.ok(sx >= -1e-6 && sx <= 600 + 1e-6 && sy >= -1e-6 && sy <= 400 + 1e-6, `${sx},${sy}`);
  }
});

test('crop takes a part of the frame', () => {
  const g = geometry(600, 400, { crop: { x: 0.5, y: 0.25, w: 0.5, h: 0.5 } });
  assert.equal(g.width, 300);
  assert.equal(g.height, 200);
  nearPt(apply(g.matrix, 300, 100), [0, 0]);
});

test('fitAspect keeps the center and the frame', () => {
  const c = fitAspect({ x: 0, y: 0, w: 1, h: 1 }, 1, 600, 400);
  near(c.h, 1);
  near(c.w * 600, 400);
  near(c.x + c.w / 2, 0.5);
});

test('shift and zoom move the picture before it is cropped', () => {
  const g = geometry(600, 400, { shift: [0.1, 0], zoom: 1.25 });
  assert.equal(g.width, 600);
  // The middle of the picture moves right by 10% of the width, zoomed.
  nearPt(apply(g.matrix, 300, 200), [300 + 60 * 1.25, 200]);
});

test('flipping vertically mirrors top to bottom and undoes itself', async () => {
  const { flipVerticalOrientation, flipOrientation, rotateOrientation } = await import('../app/js/core/geometry.js');
  for (let code = 1; code <= 8; code++) {
    assert.equal(flipVerticalOrientation(flipVerticalOrientation(code)), code);
    // A vertical flip is a horizontal flip and a half turn.
    assert.equal(flipVerticalOrientation(code), rotateOrientation(rotateOrientation(flipOrientation(code), 1), 1));
  }
  assert.equal(flipVerticalOrientation(1), 4);
});

import { autoDistortion, lensParams, lensSource } from '../app/js/core/lens.js';

test('the camera lens distortion is corrected from the zoom step, more at longer zoom', () => {
  const wide = autoDistortion(-500);
  const tele = autoDistortion(479);
  assert.ok(wide.k1 + wide.k2 < 0 && tele.k1 + tele.k2 < wide.k1 + wide.k2);
  assert.deepEqual(autoDistortion(2000), autoDistortion(479));
  assert.equal(autoDistortion(undefined), null);
  const mid = autoDistortion(190);
  assert.ok(mid.k1 > autoDistortion(11).k1 && mid.k1 < autoDistortion(420).k1);
});

test('automatic lens correction leaves the middle alone and pulls the corners in', () => {
  const cam = { capture: { zoomStep: 479 } };
  const p = lensParams({}, cam);
  const [mx, my] = lensSource(p, 500, 300, 1000, 600);
  assert.ok(Math.hypot(mx - 500, my - 300) < 1e-6);
  const [cx, cy] = lensSource(p, 1000, 600, 1000, 600);
  assert.ok(cx < 1000 && cy < 600 && cx > 800);
  assert.equal(lensParams({ auto: false }, cam), null);
  assert.equal(lensParams({}, { capture: {} }), null);
});
