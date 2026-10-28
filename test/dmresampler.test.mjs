import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dmResample } from '../app/js/core/dmresampler.js';

// The reference is test/dmresampler_ref.py: the line-by-line Python port of the engine's DmResampler, with the
// engine-fidelity patches listed in its header (float32 arithmetic where the decompile shows float32, and the
// ambiguous pixel sentinel rule). The comparison is BIT EXACT on the float32 output.
const REF = fileURLToPath(new URL('./dmresampler_ref.py', import.meta.url));

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const map = (w, h, f) => {
  const d = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d[y * w + x] = f(x, y);
  return d;
};
function plateaus(w, h, levels, seed) {
  const r = rng(seed);
  return map(w, h, () => levels[Math.floor(r() * levels.length)]);
}

const NEAR = -20;
const FAR = -5;
const LEVELS = [-5, -12.5, -20, -9.25, -3];
const CASES = [
  { name: 'vertical step', w: 10, h: 8, d: map(10, 8, (x) => (x < 5 ? NEAR : FAR)) },
  { name: 'horizontal step', w: 8, h: 10, d: map(8, 10, (x, y) => (y < 5 ? NEAR : FAR)) },
  { name: '45 degree step', w: 10, h: 10, d: map(10, 10, (x, y) => (x + y < 10 ? NEAR : FAR)) },
  { name: 'shallow slope y < 2 + x/3', w: 10, h: 10, d: map(10, 10, (x, y) => (y < 2 + x / 3 ? NEAR : FAR)) },
  { name: 'steep slope x < 2 + y/3', w: 10, h: 10, d: map(10, 10, (x, y) => (x < 2 + y / 3 ? NEAR : FAR)) },
  { name: 'slope 2/3', w: 9, h: 9, d: map(9, 9, (x, y) => (y < 1 + (2 * x) / 3 ? NEAR : FAR)) },
  { name: 'one lens wide line', w: 9, h: 8, d: map(9, 8, (x) => (x === 4 ? NEAR : FAR)) },
  { name: 'diagonal wire', w: 9, h: 9, d: map(9, 9, (x, y) => (x === y ? NEAR : FAR)) },
  { name: 'single lens island', w: 7, h: 7, d: map(7, 7, (x, y) => (x === 3 && y === 3 ? NEAR : FAR)) },
  { name: '2x2 island', w: 8, h: 8, d: map(8, 8, (x, y) => (x >= 3 && x <= 4 && y >= 3 && y <= 4 ? NEAR : FAR)) },
  { name: 'L shaped island', w: 9, h: 9, d: map(9, 9, (x, y) => ((x === 3 && y >= 3 && y <= 6) || (y === 6 && x >= 3 && x <= 6) ? NEAR : FAR)) },
  { name: 'checkerboard (all diagonals)', w: 6, h: 6, d: map(6, 6, (x, y) => ((x + y) & 1 ? NEAR : FAR)) },
  { name: 'flat map', w: 5, h: 4, d: map(5, 4, () => -7.5) },
  { name: 'smooth gradient (blend only)', w: 9, h: 7, d: map(9, 7, (x, y) => -6 - 0.3 * x - 0.2 * y) },
  { name: 'gradient with a step', w: 9, h: 8, d: map(9, 8, (x, y) => -6 - 0.25 * x + (y > 3 ? -9 : 0)) },
  { name: 'tiny 1x1', w: 1, h: 1, d: Float32Array.of(-3) },
  { name: 'tiny 2x1 step', w: 2, h: 1, d: Float32Array.of(-3, -12) },
  { name: 'tiny 3x3 centre', w: 3, h: 3, d: map(3, 3, (x, y) => (x === 1 && y === 1 ? -12 : -3)) },
  { name: 'random plateaus (2 levels) 8x8', w: 8, h: 8, d: plateaus(8, 8, [NEAR, FAR], 1) },
  { name: 'random plateaus (3 levels) 9x7', w: 9, h: 7, d: plateaus(9, 7, LEVELS.slice(0, 3), 2) },
  { name: 'random plateaus (5 levels) 8x8', w: 8, h: 8, d: plateaus(8, 8, LEVELS, 3) },
  { name: 'random plateaus (5 levels) 7x9', w: 7, h: 9, d: plateaus(7, 9, LEVELS, 4) },
  { name: 'random plateaus (2 levels) 10x6', w: 10, h: 6, d: plateaus(10, 6, [NEAR, FAR], 5) },
  // differences exactly at / next to the 0.8 threshold: exercises the float32 comparison
  { name: 'differences around the threshold', w: 8, h: 6, d: plateaus(8, 6, [0, 0.79999995, 0.8, 0.80000013, 1.6, 2.4], 6) },
  { name: 'continuous noise 6x6', w: 6, h: 6, d: map(6, 6, (() => { const r = rng(7); return () => -4 - 10 * r(); })()) },
  { name: 'threshold 0 (exact equality masks)', w: 7, h: 7, d: plateaus(7, 7, LEVELS.slice(0, 3), 8), opts: { similarity: 0 } },
  { name: 'blend off', w: 8, h: 7, d: plateaus(8, 7, LEVELS.slice(0, 3), 9), opts: { blend: false } },
  { name: 'wide threshold 3', w: 8, h: 7, d: plateaus(8, 7, LEVELS, 10), opts: { similarity: 3 } },
  { name: 'factor 3', w: 8, h: 7, d: plateaus(8, 7, LEVELS.slice(0, 3), 11), factor: 3 },
  { name: 'factor 1 (identity-sized)', w: 6, h: 6, d: plateaus(6, 6, LEVELS.slice(0, 3), 12), factor: 1 },
];

function referenceAvailable() {
  try {
    execFileSync('python3', ['-I', '-c', 'import numpy'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function runReference(cases) {
  const req = {
    cases: cases.map((c) => ({
      w: c.w,
      h: c.h,
      data: Array.from(c.d),
      thr: c.opts?.similarity ?? 0.8,
      blend: c.opts?.blend ?? true,
      x: c.factor ?? 5,
    })),
  };
  const out = execFileSync('python3', ['-I', REF], { input: JSON.stringify(req), maxBuffer: 1 << 28, timeout: 600000 });
  return JSON.parse(out.toString());
}

test('dmResample matches the Python reference bit for bit', { skip: !referenceAvailable() && 'python3 with numpy is not available' }, () => {
  const ref = runReference(CASES);
  assert.equal(ref.length, CASES.length);
  CASES.forEach((c, i) => {
    const got = dmResample(c.d, c.w, c.h, c.factor ?? 5, c.opts ?? {});
    const f = c.factor ?? 5;
    assert.equal(got.width, c.w * f, c.name);
    assert.equal(got.height, c.h * f, c.name);
    assert.ok(got.data instanceof Float32Array);
    assert.equal(ref[i].error, undefined, `${c.name}: the reference threw ${ref[i].error}`);
    const want = Float32Array.from(ref[i].data);
    assert.equal(want.length, got.data.length, c.name);
    let bad = 0;
    let first = -1;
    for (let k = 0; k < want.length; k++) {
      if (!Object.is(want[k], got.data[k])) {
        bad++;
        if (first < 0) first = k;
      }
    }
    assert.equal(bad, 0, `${c.name}: ${bad} of ${want.length} pixels differ, first at (${first % got.width}, ${(first / got.width) | 0}): reference ${want[first]}, port ${got.data[first]}`);
  });
});

// ---- properties that do not need the reference ----------------------------------------------------------------

test('a flat map stays flat and every output value comes from the input range', () => {
  const o = dmResample(map(6, 5, () => -7.5), 6, 5, 5);
  assert.equal(o.data.length, 30 * 25);
  assert.ok(o.data.every((v) => v === -7.5));
});

test('an axis aligned step lands exactly on the lens cell border and keeps both plateaus pure', () => {
  const w = 10;
  const h = 8;
  const o = dmResample(map(w, h, (x) => (x < 5 ? NEAR : FAR)), w, h, 5);
  for (let y = 0; y < o.height; y++) {
    for (let x = 0; x < o.width; x++) assert.equal(o.data[y * o.width + x], x < 25 ? NEAR : FAR, `(${x},${y})`);
  }
});

test('a one lens wide line keeps its 5 texel width', () => {
  const o = dmResample(map(9, 8, (x) => (x === 4 ? NEAR : FAR)), 9, 8, 5);
  for (let y = 0; y < o.height; y++) {
    const near = [];
    for (let x = 0; x < o.width; x++) if (o.data[y * o.width + x] === NEAR) near.push(x);
    assert.deepEqual(near, [20, 21, 22, 23, 24], `row ${y}`);
  }
});

test('45 degree steps are straight 45 degree lines at the texel level', () => {
  const n = 12;
  const o = dmResample(map(n, n, (x, y) => (x + y < n ? NEAR : FAR)), n, n, 5);
  // the number of near texels per row drops by exactly one per row
  const counts = [];
  for (let y = 10; y < o.height - 10; y++) {
    let c = 0;
    for (let x = 0; x < o.width; x++) if (o.data[y * o.width + x] === NEAR) c++;
    counts.push(c);
  }
  for (let i = 1; i < counts.length; i++) assert.equal(counts[i - 1] - counts[i], 1, `row ${i + 10}`);
});

test('a smooth ramp is blended without leaving the neighbouring lens values and is quantised to 1e-4', () => {
  const w = 8;
  const h = 6;
  const d = map(w, h, (x, y) => -6 - 0.3 * x - 0.2 * y);
  const o = dmResample(d, w, h, 5);
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of d) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  for (const v of o.data) {
    assert.ok(v >= lo - 1e-4 && v <= hi + 1e-4);
    assert.ok(Math.abs(v * 1e4 - Math.round(v * 1e4)) < 5e-3 * Math.max(1, Math.abs(v)), `${v} is not a multiple of 1e-4`);
  }
});

test('argument checks', () => {
  assert.throws(() => dmResample(new Float32Array(4), 2, 2, 4), /odd integer/);
  assert.throws(() => dmResample(new Float32Array(3), 2, 2, 5), /size/);
  assert.equal(dmResample([1, 2, 3, 4], 2, 2, 3).data.length, 36);
});

test('a 541x376 map of random plateaus runs in a few seconds', () => {
  const w = 541;
  const h = 376;
  // blocky plateaus, like a real lens depth map: 8x8 regions of random depth
  const r = rng(99);
  const blocks = new Float32Array(Math.ceil(w / 8) * Math.ceil(h / 8));
  for (let i = 0; i < blocks.length; i++) blocks[i] = -3 - Math.floor(r() * 6) * 2.5;
  const bw = Math.ceil(w / 8);
  const d = map(w, h, (x, y) => blocks[(y >> 3) * bw + (x >> 3)]);
  const t0 = process.hrtime.bigint();
  const o = dmResample(d, w, h, 5);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  console.log(`dmResample 541x376 -> ${o.width}x${o.height}: ${ms.toFixed(0)} ms`);
  assert.equal(o.data.length, 2705 * 1880);
  assert.ok(o.data.every((v) => Number.isFinite(v) && v !== -100));
  assert.ok(ms < 60000, `took ${ms} ms`);
});
