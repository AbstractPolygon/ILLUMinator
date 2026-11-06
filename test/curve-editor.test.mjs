import test from 'node:test';
import assert from 'node:assert/strict';
import { curveEditor } from '../app/js/ui/curve-editor.js';

// A canvas stand-in: 200 x 200 CSS pixels at the page's origin, which collects the editor's event handlers so a test can play pointer events into them.
function setup(points) {
  const handlers = {};
  const noop = () => {};
  const ctx = new Proxy({}, { get: () => noop, set: () => true });
  const canvas = {
    width: 200,
    height: 200,
    clientWidth: 200,
    getContext: () => ctx,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 200, height: 200 }),
    addEventListener: (name, fn) => { handlers[name] = fn; },
    setPointerCapture: noop,
    closest: () => null,
  };
  globalThis.window = { devicePixelRatio: 1 };
  globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });
  globalThis.ResizeObserver = class { observe() {} };
  const state = { points: points.map((p) => [...p]), calls: [] };
  curveEditor(canvas, {
    getPoints: () => state.points,
    getRegions: () => [0, 0, 0, 0],
    setPoints: (pts, final) => { state.points = pts; state.calls.push(final); },
  });
  // the graph has a 4% margin: curve (x, y) is at pixel (8 + 184 x, 8 + 184 (1 - y))
  const at = (x, y) => ({ button: 0, pointerId: 1, clientX: 8 + 184 * x, clientY: 8 + 184 * (1 - y) });
  return { handlers, state, at };
}

test('clicking empty graph adds a point in order, and the drag ends with a final change', () => {
  const t = setup([[0, 0], [1, 1]]);
  t.handlers.pointerdown(t.at(0.5, 0.8));
  assert.equal(t.state.points.length, 3);
  assert.ok(Math.abs(t.state.points[1][0] - 0.5) < 1e-6 && Math.abs(t.state.points[1][1] - 0.8) < 1e-6);
  t.handlers.pointermove(t.at(0.5, 0.3));
  assert.ok(Math.abs(t.state.points[1][1] - 0.3) < 1e-6);
  t.handlers.pointerup({});
  assert.equal(t.state.calls[t.state.calls.length - 1], true, 'the last change is final (it can be saved)');
  assert.ok(t.state.calls.slice(0, -1).every((c) => c === false), 'the ones while dragging are not');
});

test('a dragged point stays between its neighbours; the end points stay on the edges', () => {
  const t = setup([[0, 0], [0.4, 0.4], [0.6, 0.6], [1, 1]]);
  t.handlers.pointerdown(t.at(0.4, 0.4));
  t.handlers.pointermove(t.at(0.9, 0.2)); // past its right neighbour at 0.6
  assert.ok(t.state.points[1][0] < 0.6 && t.state.points[1][0] > 0);
  t.handlers.pointerup({});
  t.handlers.pointerdown(t.at(0, 0));
  t.handlers.pointermove(t.at(0.3, 0.5));
  assert.equal(t.state.points[0][0], 0, 'the first point cannot leave the left edge');
  assert.ok(Math.abs(t.state.points[0][1] - 0.5) < 1e-6, 'but it moves up and down');
  t.handlers.pointerup({});
});

test('a click too close to an existing point in x adds nothing new', () => {
  const t = setup([[0, 0], [0.5, 0.5], [1, 1]]);
  t.handlers.pointerdown(t.at(0.503, 0.9));
  // within the hit radius of 0.5 in x but far in y: no new point is made at that x
  assert.equal(t.state.points.length, 3);
});

test('double click removes an inner point, never an end point', () => {
  const t = setup([[0, 0], [0.5, 0.5], [1, 1]]);
  t.handlers.dblclick(t.at(0.5, 0.5));
  assert.equal(t.state.points.length, 2);
  t.handlers.dblclick(t.at(0, 0));
  t.handlers.dblclick(t.at(1, 1));
  assert.equal(t.state.points.length, 2);
});

test('a disabled editor ignores clicks', () => {
  setup([[0, 0], [1, 1]]); // installs the browser stand-ins
  // a canvas that says it is inside a disabled group
  const handlers = {};
  const canvas = {
    width: 200, height: 200, clientWidth: 200,
    getContext: () => new Proxy({}, { get: () => () => {}, set: () => true }),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 200, height: 200 }),
    addEventListener: (n, f) => { handlers[n] = f; },
    setPointerCapture() {},
    closest: () => ({}),
  };
  let changed = 0;
  curveEditor(canvas, { getPoints: () => [[0, 0], [1, 1]], getRegions: () => [0, 0, 0, 0], setPoints: () => { changed++; } });
  handlers.pointerdown({ button: 0, pointerId: 1, clientX: 100, clientY: 100 });
  assert.equal(changed, 0);
});
