// The engine's automatic white balance (core/enginewb.js): the stages after the weighted mean against gains read from the running engine.
import test from 'node:test';
import assert from 'node:assert/strict';
import { awbPost, awbCct, engineAwb } from '../app/js/core/enginewb.js';

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: ${a} vs ${b}`);

test('cct from the gains follows the engine table', () => {
  near(awbCct([0.5293794870376587, 1, 1]), 2800, 1e-3, 'knot');
  near(awbCct([1, 1, 1.8182]) , 2905, 25, 'b4-2');
  assert.equal(awbCct([0.1, 1, 1]), 2300);
  assert.equal(awbCct([9, 1, 1]), 10640);
});

test('the correction by temperature reproduces the engine (b4-2: 1, 1.0826, 2.0577 -> 1, 1.0206, 1.8182)', () => {
  const r = awbPost([1, 1.0826, 2.0577], 0);
  near(r.cct, 2610.4, 1, 'cct');
  near(r.gains[0], 1, 1e-9, 'r');
  near(r.gains[1], 1.0206, 5e-4, 'g');
  near(r.gains[2], 1.8182, 5e-4, 'b');
  // warm photos without a correction at their temperature stay as measured (b4-4: 1.1368, 1, 1.7749)
  const q = awbPost([1.1368, 1, 1.7749], 0);
  near(q.gains[0], 1.1368, 1e-4, 'b4-4 r');
  near(q.gains[2], 1.7749, 1e-4, 'b4-4 b');
});

test('a picture without usable statistics keeps the camera gains', () => {
  const W = 8;
  const H = 8;
  const image = new Float32Array(4 * W * H); // black: no pixel in the luma window
  const r = engineAwb({ image, W, H, exposure: 0.01, gain: 1, responses: [0.76, 1, 0.74], camera: [1.2, 1, 1.4] });
  assert.deepEqual(r.gains.map((g) => +g.toFixed(4)), [1.2 / 1, 1, 1.4]);
});
