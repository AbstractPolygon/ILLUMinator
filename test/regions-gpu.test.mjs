// The region cleanup's per-pixel filters on the GPU (gpu/regions.js) against the CPU versions (core/segments.js), in a headless browser, on a synthetic picture with colour blocks, noise and depth steps. Skipped where Playwright or its browser is not installed.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'app');
const types = { '.js': 'text/javascript', '.html': 'text/html' };

async function playwright() {
  for (const spec of ['playwright', '/opt/node-tools/node_modules/playwright/index.mjs']) {
    try {
      return await import(spec);
    } catch {}
  }
  return null;
}

test('the GPU region filters match the CPU versions', async (t) => {
  const pw = await playwright();
  if (!pw) return t.skip('Playwright is not installed');
  let browser;
  try {
    browser = await pw.chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  } catch {
    return t.skip('No browser available');
  }
  const server = http.createServer((q, r) => {
    const u = decodeURIComponent(q.url.split('?')[0]);
    if (u === '/t.html') {
      r.writeHead(200, { 'content-type': 'text/html' });
      return r.end('<!doctype html><meta charset=utf8>');
    }
    fs.readFile(path.join(root, u), (e, d) => {
      r.writeHead(e ? 404 : 200, { 'content-type': types[path.extname(u)] || 'application/octet-stream' });
      r.end(e ? undefined : d);
    });
  }).listen(0);
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(300000);
    await page.goto(`http://localhost:${server.address().port}/t.html`);
    const res = await page.evaluate(async () => {
      const { GpuRenderer } = await import('/js/gpu/renderer.js');
      const { regionsGpu } = await import('/js/gpu/regions.js');
      const S = await import('/js/core/segments.js');
      const gl = new OffscreenCanvas(1, 1).getContext('webgl2', { antialias: false, depth: false, stencil: false, premultipliedAlpha: false });
      if (!gl || !gl.getExtension('EXT_color_buffer_float')) return null;
      const gpu = new GpuRenderer(gl);
      const g = regionsGpu(gpu);
      if (!g) return null;
      const w = 97;
      const h = 71;
      const n = w * h;
      let seed = 3;
      const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
      const lab = new Float32Array(n * 3);
      const depth = new Float32Array(n);
      const objects = new Uint32Array(n);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const p = y * w + x;
          const blk = ((x / 24) | 0) + ((y / 18) | 0) * 5;
          lab[3 * p] = 20 + ((blk * 37) % 60) + 3 * rnd();
          lab[3 * p + 1] = ((blk * 53) % 50) - 25 + 2 * rnd();
          lab[3 * p + 2] = ((blk * 29) % 50) - 25 + 2 * rnd();
          depth[p] = 0.1 * (blk % 5) + 0.004 * rnd() + 0.2 * (x / w);
          objects[p] = blk % 3;
        }
      }
      const cmp = (a, b) => {
        let worst = 0;
        let off = 0;
        for (let i = 0; i < a.length; i++) {
          const d = Math.abs(a[i] - b[i]);
          worst = Math.max(worst, d);
          if (d > 1e-4) off++;
        }
        return { worst, off: off / a.length };
      };
      const out = {};
      out.smoothRamps = cmp(S.smoothRamps(depth, lab, w, h, 0.25), g.smoothRamps(depth, lab, w, h, 0.25));
      out.smoothRampsObjects = cmp(S.smoothRamps(depth, lab, w, h, Infinity, objects, 8, 4, 10), g.smoothRamps(depth, lab, w, h, Infinity, objects, 8, 4, 10));
      out.colorMedian = cmp(S.colorMedian(depth, lab, w, h), g.colorMedian(depth, lab, w, h));
      out.snapToObjects = cmp(S.snapToObjects(depth, objects, w, h), g.snapToObjects(depth, objects, w, h));
      out.layerSnap = cmp(S.layerSnap(depth, lab, w, h), g.layerSnap(depth, lab, w, h));
      out.layerSnapHard = cmp(S.layerSnap(depth, lab, w, h, { hard: true }), g.layerSnap(depth, lab, w, h, { hard: true }));
      // the whole cleanup, both ways
      const rgb = new Float32Array(n * 3);
      for (let p = 0; p < n; p++) for (let c = 0; c < 3; c++) rgb[3 * p + c] = Math.min(1, Math.max(0, (lab[3 * p + c] + 60) / 160));
      const conf = new Float32Array(n).fill(0.7);
      out.segmentDepth = cmp(S.segmentDepth(depth, conf, rgb, w, h, { count: 120 }), S.segmentDepth(depth, conf, rgb, w, h, { count: 120, gpu: g }));
      out.segmentDepthObjects = cmp(S.segmentDepth(depth, conf, rgb, w, h, { count: 120, objects }), S.segmentDepth(depth, conf, rgb, w, h, { count: 120, objects, gpu: g }));
      return out;
    });
    if (!res) return t.skip('No float-renderable WebGL2');
    for (const [name, { worst, off }] of Object.entries(res)) {
      t.diagnostic(`${name}: largest difference ${worst.toExponential(2)}, ${(off * 100).toFixed(3)}% of pixels differ`);
      // float32 against double: a few ties may fall the other way in the medians
      const limit = name === 'smoothRamps' || name === 'smoothRampsObjects' ? 1e-3 : Infinity;
      assert.ok(worst < limit, `${name}: largest difference ${worst}`);
      assert.ok(off < 0.01, `${name}: ${(off * 100).toFixed(2)}% of pixels differ by more than 1e-4`);
    }
  } finally {
    server.close();
    await browser.close();
  }
});
