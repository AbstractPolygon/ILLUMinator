import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCube, sampleLut, encodeLut, decodeLut } from '../app/js/core/lut.js';

// A size-n identity LUT, optionally with each entry changed by f.
function cube(n, f = (r, g, b) => [r, g, b], header = '') {
  const rows = [];
  for (let b = 0; b < n; b++) for (let g = 0; g < n; g++) for (let r = 0; r < n; r++) rows.push(f(r / (n - 1), g / (n - 1), b / (n - 1)).map((v) => v.toFixed(6)).join(' '));
  return `# test\nTITLE "Test look"\n${header}LUT_3D_SIZE ${n}\n${rows.join('\n')}\n`;
}

const near = (a, b, eps = 1e-4) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('a .cube parses, and an identity LUT leaves colors alone', () => {
  const lut = parseCube(cube(5));
  assert.equal(lut.title, 'Test look');
  assert.equal(lut.size, 5);
  const out = [0, 0, 0];
  sampleLut(lut, 0.3, 0.62, 0.9, out);
  near(out[0], 0.3);
  near(out[1], 0.62);
  near(out[2], 0.9);
});

test('red changes fastest, and values between entries are interpolated', () => {
  // Swap red and blue.
  const lut = parseCube(cube(3, (r, g, b) => [b, g, r]));
  const out = sampleLut(lut, 0.25, 0.5, 1, [0, 0, 0]);
  near(out[0], 1);
  near(out[1], 0.5);
  near(out[2], 0.25);
});

test('domains, bad files and the saved form', () => {
  const lut = parseCube(cube(3, (r, g, b) => [r * 2, g * 2, b * 2], 'DOMAIN_MIN 0 0 0\nDOMAIN_MAX 2 2 2\n'));
  near(sampleLut(lut, 1, 1, 1, [0, 0, 0])[0], 1, 1e-3);
  assert.throws(() => parseCube('LUT_1D_SIZE 4\n0 0 0'), /1D/);
  assert.throws(() => parseCube('LUT_3D_SIZE 3\n0 0 0'), /entries/);
  const back = decodeLut(JSON.parse(JSON.stringify(encodeLut(parseCube(cube(4, (r, g, b) => [r * r, g, 1 - b]))))));
  const out = sampleLut(back, 0.5, 0.25, 0.75, [0, 0, 0]);
  near(out[1], 0.25, 1e-3);
  near(out[2], 0.25, 1e-3);
  assert.equal(back.title, 'Test look');
});
