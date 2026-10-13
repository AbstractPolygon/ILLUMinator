import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePoints, formatPoints, monotoneCurve, curveTable, curveAt, CURVE_SIZE } from '../app/js/core/curve.js';

test('points parse with end points added and format back', () => {
  assert.deepEqual(parsePoints('0.5,0.6'), [[0, 0], [0.5, 0.6], [1, 1]]);
  assert.deepEqual(parsePoints(''), [[0, 0], [1, 1]]);
  assert.equal(formatPoints(parsePoints('0,0.1;0.5,0.6;1,0.9')), '0,0.1;0.5,0.6;1,0.9');
});

test('the curve goes through its points and never reverses', () => {
  const f = monotoneCurve([[0, 0], [0.3, 0.5], [0.4, 0.52], [1, 1]]);
  assert.ok(Math.abs(f(0.3) - 0.5) < 1e-9);
  let prev = -1;
  for (let x = 0; x <= 1; x += 0.01) {
    const y = f(x);
    assert.ok(y >= prev - 1e-9, `reverses at ${x}`);
    prev = y;
  }
});

test('an unchanged curve is no table; a changed one is looked up', () => {
  assert.equal(curveTable({}), null);
  const t = curveTable({ points: '0.5,0.7' });
  assert.equal(t.length, CURVE_SIZE);
  assert.ok(Math.abs(curveAt(t, 0.5) - 0.7) < 1e-6);
  const lifted = curveTable({ regions: [0.5, 0, 0, 0] });
  assert.ok(curveAt(lifted, 0.125) > 0.125 + 0.05);
  assert.ok(Math.abs(curveAt(lifted, 0.8) - 0.8) < 1e-6);
});
