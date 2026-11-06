/* global document, ImageData -- used inside page.evaluate, which runs in the browser */
// FSR 1 on the graphics card (gpu/upscale.js upscaleImage) puts the picture where it belongs, with and without its sharpening pass: no shift and no zoom at 1.5x, 2x and 3x,
// the same check core/fsr.js passes on the processor (test/fsr.test.mjs). Runs in a headless browser; skipped where Playwright or a browser is not installed.
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

test('FSR 1 on the graphics card enlarges in place: no shift and no zoom', async (t) => {
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
      const { upscaleImage } = await import('/js/gpu/upscale.js');
      const scene = (u, v) => 0.5 + 0.25 * Math.sin(2 * Math.PI * 3.1 * u + 0.7) * Math.cos(2 * Math.PI * 2.3 * v) + 0.2 * Math.exp(-(((u - 0.4) ** 2 + (v - 0.6) ** 2) / 0.01)) + 0.15 * Math.sin(2 * Math.PI * (2 * u + 3 * v));
      const w = 48;
      const h = 32;
      const img = new ImageData(w, h);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) img.data.set([0, 0, 0, 255].map((a, i) => (i < 3 ? scene((x + 0.5) / w, (y + 0.5) / h) * 255 : a)), (y * w + x) * 4);
      const out = [];
      for (const sharpen of [0, 0.25]) {
        for (const k of [1.5, 2, 3]) {
          const W = Math.round(w * k);
          const H = Math.round(h * k);
          const cv = upscaleImage(img, W, H, { method: 'fsr', sharpen });
          const c2 = document.createElement('canvas');
          c2.width = W;
          c2.height = H;
          const g = c2.getContext('2d');
          g.drawImage(cv, 0, 0);
          const d = g.getImageData(0, 0, W, H).data;
          let best = null;
          for (const s of [0.99, 0.995, 1, 1.005, 1.01]) {
            for (let dx = -0.5; dx <= 0.5001; dx += 0.1) {
              for (let dy = -0.5; dy <= 0.5001; dy += 0.1) {
                let e = 0;
                let n = 0;
                for (let y = 6; y < H - 6; y += 2) {
                  for (let x = 6; x < W - 6; x += 2) {
                    const q = d[(y * W + x) * 4] - scene(0.5 + ((x + 0.5 + dx) / W - 0.5) * s, 0.5 + ((y + 0.5 + dy) / H - 0.5) * s) * 255;
                    e += q * q;
                    n++;
                  }
                }
                e = Math.sqrt(e / n);
                if (!best || e < best.e - 1e-9) best = { s, dx: +dx.toFixed(1), dy: +dy.toFixed(1), e };
              }
            }
          }
          out.push({ sharpen, k, ...best });
        }
      }
      return out;
    });
    for (const r of res) {
      const what = `${r.k}x, sharpen ${r.sharpen}`;
      assert.equal(r.s, 1, `scale at ${what}`);
      assert.ok(Math.abs(r.dx) <= 0.1 && Math.abs(r.dy) <= 0.1, `shift at ${what}: ${r.dx}, ${r.dy}`);
      assert.ok(r.e < 3, `error at ${what}: ${r.e}`);
    }
  } finally {
    await browser.close();
    server.close();
  }
});
