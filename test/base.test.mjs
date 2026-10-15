import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lytroCurve, lytroColor, LYTRO_EXPOSURE } from '../app/js/core/base.js';

const Y = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

test('Lytro curve rises from black to white', () => {
  assert.equal(lytroCurve(0), 0);
  assert.ok(lytroCurve(LYTRO_EXPOSURE) > 0.95);
  for (let x = 2 ** -12; x < 4; x *= 1.1) assert.ok(lytroCurve(x * 1.1) >= lytroCurve(x));
});

test('Lytro color keeps gray and brightness, saturation 0 gives gray', () => {
  assert.deepEqual(lytroColor([0.4, 0.4, 0.4]), [0.4, 0.4, 0.4]);
  const c = [0.7, 0.4, 0.2];
  const y = Y(c);
  assert.ok(Math.abs(Y(lytroColor([...c])) - y) < 1e-9);
  const g = lytroColor([...c], 0);
  for (const v of g) assert.ok(Math.abs(v - y) < 1e-9);
});
