import test from 'node:test';
import assert from 'node:assert/strict';
import { autoDefringe } from '../app/js/core/defringe.js';

// A dark field with bright bars; `fringe` colors the pixels next to each bar.
function picture(fringe) {
  const w = 64;
  const h = 32;
  const rgb = new Float32Array(w * h * 3).fill(0.02);
  for (let y = 0; y < h; y++) {
    for (const x0 of [10, 30, 50]) {
      for (let x = x0; x < x0 + 4; x++) rgb.fill(0.9, 3 * (y * w + x), 3 * (y * w + x) + 3);
      if (fringe) for (const x of [x0 - 1, x0 + 4]) rgb.set(fringe, 3 * (y * w + x));
    }
  }
  // Some ordinary color away from edges.
  for (let y = 20; y < 30; y++) for (let x = 0; x < 6; x++) rgb.set([0.3, 0.05, 0.3], 3 * (y * w + x));
  return { rgb, w, h };
}

test('purple fringes along edges are found', () => {
  const { rgb, w, h } = picture([0.35, 0.02, 0.4]);
  const [purple, green] = autoDefringe(rgb, w, h);
  assert.ok(purple[0] >= 0.5, `purple amount ${purple[0]}`);
  assert.ok(purple[1] >= 280 && purple[1] <= 320, `purple hue ${purple[1]}`);
  assert.equal(green[0], 0);
});

test('a picture without fringes gets no defringing', () => {
  const { rgb, w, h } = picture(null);
  assert.ok(autoDefringe(rgb, w, h).every(([amount]) => amount === 0));
});
