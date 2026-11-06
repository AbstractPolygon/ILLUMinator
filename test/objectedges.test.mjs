// Object edges: the steps at object outlines made a ramp by the Smooth edges setting (core/segments.js softenObjectEdges).
import test from 'node:test';
import assert from 'node:assert/strict';
import { softenObjectEdges } from '../app/js/core/segments.js';

test('softening turns the depth step at an object outline into a ramp and leaves the rest alone', () => {
  const w = 60, h = 8;
  const objects = new Uint16Array(w * h);
  const depth = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { objects[y * w + x] = x < 30 ? 1 : 2; depth[y * w + x] = x < 30 ? 0 : 1; }
  const out = softenObjectEdges(depth, objects, w, h, 3);
  const row = (x) => out[3 * w + x];
  // far from the outline: untouched
  assert.equal(row(2), 0);
  assert.equal(row(57), 1);
  // at the outline: between the two levels, and rising across it
  assert.ok(row(29) > 0.1 && row(29) < 0.5, `${row(29)}`);
  assert.ok(row(30) > 0.5 && row(30) < 0.9, `${row(30)}`);
  for (let x = 24; x < 36; x++) assert.ok(row(x + 1) >= row(x) - 1e-6);
  // a hard step jumps by 1 between neighbours, the ramp by well under that
  let widest = 0;
  for (let x = 0; x < w - 1; x++) widest = Math.max(widest, Math.abs(row(x + 1) - row(x)));
  assert.ok(widest < 0.4, `${widest}`);
  // no softening: the same array back
  assert.equal(softenObjectEdges(depth, objects, w, h, 0), depth);
});

test('a wider setting softens over more pixels', () => {
  const w = 80, h = 5;
  const objects = new Uint16Array(w * h);
  const depth = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { objects[y * w + x] = x < 40 ? 1 : 2; depth[y * w + x] = x < 40 ? 0 : 1; }
  const reach = (sigma) => { const o = softenObjectEdges(depth, objects, w, h, sigma); let n = 0; for (let x = 0; x < w; x++) if (o[2 * w + x] > 0.01 && o[2 * w + x] < 0.99) n++; return n; };
  assert.ok(reach(6) > reach(2) + 4);
});
