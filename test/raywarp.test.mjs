import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRayWarp, FOCUS_FIELD } from '../app/js/core/raywarp.js';

const MAGIC = 0xaf0990fa;
const r = Math.fround;

// A calibration table as a raw ILLUM file carries it (see core/raywarp.js for the layout). `radial(ia)` is the shift along the image radius at radial node `ia`
// (A, first value); everything else is zero. Every node is valid.
function table(radial = () => 0) {
  const steps = [0.125, 0.125, 0.125, 0.125];
  const border = 2;
  const [aMax, bMax, stepA, stepB, stepC] = [0.58, 0.58, 0.008, 0.03, 0.05].map(r);
  const na = Math.ceil(r(r(r(1) / stepA) * aMax)) + 2;
  const nb = Math.ceil(r(r(r(1) / stepB) * bMax)) + 2;
  const nc = Math.ceil(r(r(r(1) / stepC) * 2)) + 2;
  const nodes = na * nb * nc;
  const bytes = new Uint8Array(104 + 18 * nodes);
  const v = new DataView(bytes.buffer);
  v.setUint32(0, MAGIC, true);
  v.setInt32(4, 3, true);
  v.setInt32(16, bytes.length, true);
  [-0.5, -0.5, -0.5, -0.5].forEach((m, k) => v.setFloat32(28 + 4 * k, m, true));
  [1, 1, 1, 1].forEach((e, k) => v.setFloat32(44 + 4 * k, e, true));
  steps.forEach((s, k) => v.setFloat32(60 + 4 * k, s, true));
  v.setInt32(76, border, true);
  v.setInt32(80, 0, true);
  [aMax, bMax, stepA, stepB, stepC].forEach((p, k) => v.setFloat32(84 + 4 * k, p, true));
  for (let ic = 0; ic < nc; ic++) {
    for (let ib = 0; ib < nb; ib++) {
      for (let ia = 0; ia < na; ia++) {
        const q = ia + na * (ic + nc * ib);
        v.setFloat32(104 + 4 * (2 * q), radial(ia), true);
      }
    }
  }
  bytes.fill(1, 104 + 16 * nodes); // both validity masks: every node is valid
  return bytes;
}

test('FOCUS_FIELD starts off, with the grid the focus map uses', () => {
  assert.equal(FOCUS_FIELD.on, false);
  assert.equal(FOCUS_FIELD.gain, 1);
});

test('bad tables give null', () => {
  assert.equal(parseRayWarp(null, 100, 80), null);
  assert.equal(parseRayWarp(new Uint8Array(50), 100, 80), null);
  const wrongMagic = table();
  wrongMagic[0] ^= 0xff;
  assert.equal(parseRayWarp(wrongMagic, 100, 80), null);
  const wrongSize = table();
  assert.equal(parseRayWarp(wrongSize.subarray(0, wrongSize.length - 1), 100, 80), null);
});

test('a table that corrects nothing leaves the picture as it is', () => {
  const warp = parseRayWarp(table(), 100, 80);
  assert.ok(warp);
  assert.ok(Math.abs(warp.scale - 1) < 1e-6);
  assert.ok(Math.abs(warp.tilt[0]) < 1e-6 && Math.abs(warp.tilt[1]) < 1e-6);
  const profile = warp.distortionProfile(100, 80, 10);
  assert.ok(profile.length > 0);
  for (const { ratio } of profile) assert.ok(Math.abs(ratio - 1) < 1e-4);
});

test('a plain magnification is scaled away: the picture fills the frame again, so no distortion is left', () => {
  const k = 0.1;
  const stepA = Math.fround(0.008);
  const warp = parseRayWarp(table((ia) => k * ia * stepA), 100, 80);
  assert.ok(warp);
  assert.ok(Math.abs(warp.scale - 1 / (1 + k)) < 2e-3, `scale ${warp.scale}`);
  for (const { ratio } of warp.distortionProfile(100, 80, 10)) assert.ok(Math.abs(ratio - 1) < 5e-3, `ratio ${ratio}`);
});

test('the grid images the GPU reads match the grid size and mark covered nodes', () => {
  const warp = parseRayWarp(table(), 100, 80);
  const g = warp.gridImages();
  assert.deepEqual(g.nodes, [13, 13, 13, 13]);
  assert.equal(g.width, 13 * 13);
  assert.equal(g.height, 13 * 13);
  assert.equal(g.grid.length, g.width * g.height * 4);
  assert.equal(g.cover.length, g.width * g.height);
  assert.ok(g.cover.some((c) => c === 1));
});
