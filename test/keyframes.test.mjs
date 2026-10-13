import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAnimation, emptyAnimation, setKey, valueAt, sample, frameCount, cubicBezier, FPS } from '../app/js/core/keyframes.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('cubic bezier matches its end points and a linear curve', () => {
  const lin = cubicBezier(0, 0, 1, 1);
  near(lin(0.3), 0.3, 1e-4);
  const ease = cubicBezier(0.42, 0, 0.58, 1);
  near(ease(0.5), 0.5, 1e-4);
  assert.ok(ease(0.2) < 0.2);
  // Overshoot.
  const back = cubicBezier(0.3, 0, 0.6, 1.5);
  assert.ok([0.7, 0.8, 0.9].some((x) => back(x) > 1));
});

test('tracks interpolate on their own, each with its own curve', () => {
  const a = emptyAnimation();
  setKey(a, 'focus', 0, 0);
  setKey(a, 'focus', 2, 1);
  a.tracks.focus[0].ease = { type: 'linear', bezier: [0, 0, 1, 1] };
  setKey(a, 'aperture', 1, 2);
  setKey(a, 'aperture', 3, 8);
  near(valueAt(a, 'focus', 1), 0.5);
  near(valueAt(a, 'aperture', 0), 2); // before its first key
  near(valueAt(a, 'aperture', 2), 4, 1e-3); // halfway in stops: f/2 -> f/8 passes f/4
  assert.equal(valueAt(a, 'zoom', 1), undefined);
  a.tracks.focus[0].ease = { type: 'hold', bezier: [0, 0, 1, 1] };
  near(valueAt(a, 'focus', 1.9), 0);
  setKey(a, 'focus', 2, 0.7); // replaces the key at 2 s
  assert.equal(a.tracks.focus.length, 2);
  near(valueAt(a, 'focus', 2), 0.7);
});

test('animations parse safely and sample every frame', () => {
  const a = parseAnimation(JSON.stringify({ length: 2, tracks: { view: [{ t: 0, v: [1, 2] }, { t: 1, v: 'bad' }], zoom: [{ t: 1, v: 2 }] } }));
  assert.equal(a.tracks.view.length, 1);
  assert.equal(frameCount(a), 2 * FPS + 1);
  const s = sample(a);
  assert.deepEqual(s[0].view, [1, 2]);
  assert.equal(s[0].zoom, 2);
  assert.deepEqual(parseAnimation('nonsense').tracks.focus, []);
});
