// The 16-bit picture from the GPU (renderer.presentBits16) against the usual 8-bit one, in a headless browser: the same picture to within one 8-bit step, with far more levels. Skipped where Playwright or its browser is not installed.
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

test('the 16-bit picture matches the 8-bit one and has more levels', async (t) => {
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
    page.setDefaultTimeout(240000);
    await page.goto(`http://localhost:${server.address().port}/t.html`);
    const res = await page.evaluate(async () => {
      const { GpuRenderer } = await import('/js/gpu/renderer.js');
      const canvas = new OffscreenCanvas(1, 1);
      const gl = canvas.getContext('webgl2', { antialias: false, depth: false, stencil: false, premultipliedAlpha: false });
      if (!gl || !gl.getExtension('EXT_color_buffer_float')) return null;
      const gpu = new GpuRenderer(gl);
      const w = 256;
      const h = 64;
      const rgba = new Float32Array(w * h * 4);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          // a smooth ramp left to right (dark to mid), different per row band so the rows can be told apart
          const v = (x / (w - 1)) * 0.2 * (1 + y / h);
          rgba[i] = v;
          rgba[i + 1] = v * 0.8;
          rgba[i + 2] = v * 0.6;
          rgba[i + 3] = 1;
        }
      }
      const src = gpu.texture(w, h, gl.RGBA32F);
      gl.bindTexture(gl.TEXTURE_2D, src);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.FLOAT, rgba);
      const out = {};
      for (const sharpen of [0, 0.4]) {
        const opts = { matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1], exposure: 1, sharpen };
        const bitmap = gpu.present(src, w, h, opts);
        const c2 = new OffscreenCanvas(w, h);
        const g = c2.getContext('2d');
        g.drawImage(bitmap, 0, 0);
        const px8 = g.getImageData(0, 0, w, h).data;
        const px16 = gpu.presentBits16(src, w, h, opts);
        let worst = 0;
        for (let i = 0; i < w * h; i++) for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(px16[3 * i + c] / 257 - px8[4 * i + c]));
        // distinct green levels along the first row
        const levels8 = new Set();
        const levels16 = new Set();
        for (let x = 0; x < w; x++) {
          levels8.add(px8[4 * x + 1]);
          levels16.add(px16[3 * x + 1]);
        }
        out[`sharpen${sharpen}`] = { worst, levels8: levels8.size, levels16: levels16.size, top: [px16[0], px16[1], px16[2]], err: gl.getError() };
      }
      return out;
    });
    if (!res) return t.skip('No float render targets');
    console.log(JSON.stringify(res));
    for (const k of Object.keys(res)) {
      assert.equal(res[k].err, 0, k);
      assert.ok(res[k].worst <= 1.01, `${k}: differs from the 8-bit picture by ${res[k].worst} steps`);
      assert.ok(res[k].levels16 > res[k].levels8 * 2, `${k}: ${res[k].levels16} levels against ${res[k].levels8}`);
    }
  } finally {
    await browser.close();
    server.close();
  }
});
