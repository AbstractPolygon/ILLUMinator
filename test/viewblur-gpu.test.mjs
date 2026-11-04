// The blur of the engine's depth views after the splat: the GPU version (gpu/lytroengine.js blurViewsGpu, views stacked in one texture) against the CPU one (core/viewblur.js), in a headless browser. Skipped where Playwright or its browser is not installed.
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

test('the GPU view blur matches the CPU version, view by view', async (t) => {
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
      const { blurViewsGpu } = await import('/js/gpu/lytroengine.js');
      const { filterPremultiplied } = await import('/js/core/viewblur.js');
      const gl = new OffscreenCanvas(1, 1).getContext('webgl2', { antialias: false, depth: false, stencil: false, premultipliedAlpha: false });
      if (!gl || !gl.getExtension('EXT_color_buffer_float')) return null;
      const gpu = new GpuRenderer(gl);
      const W = 37;
      const H = 29;
      const nV = 3;
      let seed = 5;
      const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
      const out = {};
      for (const [name, kx, ky] of [['3 taps', [0.1688, 0.6624, 0.1688], [0.1688, 0.6624, 0.1688]], ['5 and 3 taps', [0.1, 0.2, 0.4, 0.2, 0.1], [0.25, 0.5, 0.25]]]) {
        const data = new Float32Array(W * H * nV * 4);
        for (let i = 0; i < data.length; i++) data[i] = rnd();
        const t = gpu.texture(W, H * nV, gl.RGBA32F);
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, W, H * nV, gl.RGBA, gl.FLOAT, data);
        blurViewsGpu(gpu, t, W, H, nV, kx, ky);
        gpu.target(t, W, H * nV);
        const got = new Float32Array(W * H * nV * 4);
        gl.readPixels(0, 0, W, H * nV, gl.RGBA, gl.FLOAT, got);
        let worst = 0;
        for (let v = 0; v < nV; v++) {
          const ref = data.slice(v * W * H * 4, (v + 1) * W * H * 4);
          filterPremultiplied(ref, W, H, kx, ky);
          for (let i = 0; i < ref.length; i++) worst = Math.max(worst, Math.abs(ref[i] - got[v * W * H * 4 + i]));
        }
        out[name] = worst;
      }
      return out;
    });
    if (!res) return t.skip('No float-renderable WebGL2');
    for (const [name, worst] of Object.entries(res)) assert.ok(worst < 1e-5, `${name}: largest difference ${worst}`);
  } finally {
    server.close();
    await browser.close();
  }
});
