// Enlarging a 16-bit picture (gpu/upscale.js upscaleBits16) against enlarging the same picture at 8 bits (upscaleImage), in a headless browser: the same result to within a step or two of 8 bits. Skipped where Playwright or its browser is not installed.
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

test('enlarging a 16-bit picture agrees with enlarging it at 8 bits', async (t) => {
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
      const { upscaleImage, upscaleBits16 } = await import('/js/gpu/upscale.js');
      const w = 40;
      const h = 30;
      const img = new ImageData(w, h);
      const rgb16 = new Uint16Array(w * h * 3);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          // a gradient, an edge and a diagonal, different in every channel and row (so a flipped picture would show)
          const r = Math.round(255 * (x / (w - 1)));
          const g = x > 20 ? 220 : 30 + y * 3;
          const b = Math.round(255 * Math.abs(Math.sin((x + y) / 6)));
          img.data.set([r, g, b, 255], i * 4);
          rgb16.set([r * 257, g * 257, b * 257], i * 3);
        }
      }
      const out = {};
      for (const method of ['lanczos', 'smooth', 'fsr']) {
        for (const sharpen of [0, 0.25]) {
          for (const [W, H] of [[80, 60], [60, 45]]) {
            const big8 = upscaleImage(img, W, H, { method, sharpen });
            const c2 = new OffscreenCanvas(W, H);
            const g = c2.getContext('2d');
            g.drawImage(big8, 0, 0);
            const px8 = g.getImageData(0, 0, W, H).data;
            const big16 = upscaleBits16(rgb16, w, h, W, H, { method, sharpen });
            if (!big16) { out[`${method} ${sharpen} ${W}`] = null; continue; }
            let worst = 0;
            for (let i = 0; i < W * H; i++) for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs(big16[3 * i + c] / 257 - px8[4 * i + c]));
            out[`${method} ${sharpen} ${W}`] = Math.round(worst * 100) / 100;
          }
        }
      }
      return out;
    });
    console.log(JSON.stringify(res));
    for (const [k, v] of Object.entries(res)) {
      assert.notEqual(v, null, `${k}: no result`);
      assert.ok(v <= 1.6, `${k}: differs from the 8-bit result by ${v} steps`);
    }
  } finally {
    await browser.close();
    server.close();
  }
});
