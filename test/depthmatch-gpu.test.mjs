// The Lytro-style depth on the GPU (gpu/depthmatch.js) against the CPU
// version (core/depthmatch.js), in a headless browser. Skipped where
// Playwright or its browser is not installed.
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

test('GPU Lytro-style depth matches the CPU result', async (t) => {
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
    await page.goto(`http://localhost:${server.address().port}/t.html`);
    const res = await page.evaluate(async () => {
      const W = 40, H = 30, G = 3;
      const depth = await import('/js/core/depth.js');
      const dm = await import('/js/core/depthmatch.js');
      const { GpuRenderer } = await import('/js/gpu/renderer.js');
      const { measureMatchGpu } = await import('/js/gpu/depthmatch.js');
      depth.setDepthStyle('match');
      Object.assign(dm.DEPTH_PASSES, { first: -8, top: 8, lambda: 0.1, adapt: { on: true, fine: 12, lowQ: 0.005, highQ: 0.995, pad: 1 } });
      const f = (x, y, c) => 0.5 + 0.25 * Math.sin(0.31 * x + 1.7 * c) * Math.cos(0.23 * y - c) + 0.2 * Math.sin(0.113 * (x + 2 * y) + c);
      const views = [];
      for (let j = 0; j < G; j++) {
        for (let i = 0; i < G; i++) {
          const u = i - 1, v = j - 1;
          const rgb = new Float32Array(W * H * 3);
          for (let y = 0; y < H; y++) {
            for (let x = 0; x < W; x++) {
              const a = x < W / 2 ? -0.5 : 0.4;
              for (let c = 0; c < 3; c++) rgb[3 * (y * W + x) + c] = f(x + a * u * 4, y + a * v * 4, c);
            }
          }
          views.push({ u, v, rgb, gain: 1, detail: 1 });
        }
      }
      const gl = new OffscreenCanvas(1, 1).getContext('webgl2', { antialias: false, depth: false, stencil: false, premultipliedAlpha: false });
      if (!gl || !gl.getExtension('EXT_color_buffer_float')) return null;
      const cpu = dm.measureMatch(views, W, H);
      const gpu = measureMatchGpu(new GpuRenderer(gl), views, W, H);
      let worst = 0;
      for (const key of ['alpha', 'cost', 'meanCost']) for (let i = 0; i < cpu[key].length; i++) worst = Math.max(worst, Math.abs(cpu[key][i] - gpu[key][i]));
      return { worst, error: gl.getError() };
    });
    if (!res) return t.skip('No WebGL2 with float targets');
    assert.equal(res.error, 0);
    assert.ok(res.worst < 1e-3, `largest difference ${res.worst}`);
  } finally {
    await browser.close();
    server.close();
  }
});
