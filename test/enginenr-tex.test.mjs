// The noise reduction between two textures (gpu/enginenr.js nrFilterTex) against the CPU port (core/enginenr.js engineDenoise), in a headless browser. Skipped where Playwright or its browser is not installed.
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

test('the GPU noise reduction between textures matches the CPU port', async (t) => {
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
      const N = await import('/js/core/enginenr.js');
      const { GpuRenderer } = await import('/js/gpu/renderer.js');
      const { nrFilterTex } = await import('/js/gpu/enginenr.js');
      const gl = new OffscreenCanvas(1, 1).getContext('webgl2', { antialias: false, depth: false, stencil: false, premultipliedAlpha: false });
      if (!gl || !gl.getExtension('EXT_color_buffer_float')) return null;
      const gpu = new GpuRenderer(gl);
      const w = 300;
      const h = 220;
      let seed = 7;
      const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
      const rgb = new Float32Array(w * h * 3);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 3;
          const base = [0.2 + 0.5 * x / w, 0.3 + 0.4 * y / h, 0.25 + 0.3 * Math.sin(x / 40)];
          for (let c = 0; c < 3; c++) rgb[i + c] = Math.min(1, Math.max(0, base[c] + (rnd() - 0.5) * 0.08));
        }
      }
      const opts = { gain: 4, luminance: 50, color: 50 };
      const cpu = N.engineDenoise(rgb, w, h, opts);
      const src = gpu.texture(w, h, gl.RGBA32F);
      const rgba = new Float32Array(w * h * 4);
      for (let i = 0; i < w * h; i++) { rgba[4 * i] = rgb[3 * i]; rgba[4 * i + 1] = rgb[3 * i + 1]; rgba[4 * i + 2] = rgb[3 * i + 2]; rgba[4 * i + 3] = 1; }
      gl.bindTexture(gl.TEXTURE_2D, src);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.FLOAT, rgba);
      const tables = N.engineNrTables(opts);
      const outTex = nrFilterTex(gpu, src, w, h, tables, N.NR_SPACE);
      gpu.target(outTex, w, h);
      const px = new Float32Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, px);
      let sum = 0;
      let max = 0;
      let noisy = 0;
      let cleaned = 0;
      for (let i = 0; i < w * h; i++) {
        for (let c = 0; c < 3; c++) {
          const d = Math.abs(px[4 * i + c] - cpu[3 * i + c]);
          sum += d;
          if (d > max) max = d;
          noisy += Math.abs(rgb[3 * i + c] - cpu[3 * i + c]);
        }
      }
      cleaned = noisy / (w * h * 3);
      return { mean: sum / (w * h * 3), max, filterChange: cleaned };
    });
    if (!res) return t.skip('No float render targets');
    // The filter changes the picture (so a copy would not pass), and the GPU result is the CPU result to within float rounding.
    assert.ok(res.filterChange > 0.0005, `the filter changed the picture by ${res.filterChange}`);
    assert.ok(res.mean < 0.002, `mean difference ${res.mean}`);
    assert.ok(res.max < 0.05, `largest difference ${res.max}`);
    t.diagnostic(`GPU against CPU: mean ${res.mean.toExponential(2)}, largest ${res.max.toExponential(2)}, the filter changes the picture by ${res.filterChange.toExponential(2)}`);
  } finally {
    await browser.close();
    server.close();
  }
});

test('the whole GPU noise reduction chain gives the CPU path\'s picture', async (t) => {
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
      const N = await import('/js/core/enginenr.js');
      const R = await import('/js/core/render.js');
      const { GpuRenderer } = await import('/js/gpu/renderer.js');
      const { nrFilterTex } = await import('/js/gpu/enginenr.js');
      const canvas = new OffscreenCanvas(1, 1);
      const gl = canvas.getContext('webgl2', { antialias: false, depth: false, stencil: false, premultipliedAlpha: false });
      if (!gl || !gl.getExtension('EXT_color_buffer_float')) return null;
      const gpu = new GpuRenderer(gl, canvas);
      const w = 300;
      const h = 220;
      let seed = 11;
      const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
      // linear camera colour, a colour matrix with some mixing, an exposure
      const rgb = new Float32Array(w * h * 3);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 3;
        const base = [0.15 + 0.45 * x / w, 0.2 + 0.3 * y / h, 0.1 + 0.2 * Math.abs(Math.sin(x / 50))];
        for (let c = 0; c < 3; c++) rgb[i + c] = Math.max(0, base[c] + (rnd() - 0.5) * 0.06);
      }
      const matrix = [1.6, -0.4, -0.2, -0.3, 1.5, -0.2, -0.05, -0.3, 1.35];
      const exposure = 1.2;
      // CPU: matrix, filter, tone
      const m = matrix.map((v) => v * exposure);
      const lin = new Float32Array(rgb.length);
      for (let i = 0; i < w * h; i++) for (let c = 0; c < 3; c++) lin[3 * i + c] = m[3 * c] * rgb[3 * i] + m[3 * c + 1] * rgb[3 * i + 1] + m[3 * c + 2] * rgb[3 * i + 2];
      const clean = N.engineDenoise(lin, w, h, { gain: 4, luminance: 50, color: 50 });
      const cpu = R.toneMap(clean, [1, 0, 0, 0, 1, 0, 0, 0, 1], 1, undefined, null, null, null, { saturation: 1, exact: true });
      // GPU: the stages of finishGpu
      const src = gpu.texture(w, h, gl.RGBA32F);
      const rgba = new Float32Array(w * h * 4);
      for (let i = 0; i < w * h; i++) { rgba[4 * i] = rgb[3 * i]; rgba[4 * i + 1] = rgb[3 * i + 1]; rgba[4 * i + 2] = rgb[3 * i + 2]; rgba[4 * i + 3] = 1; }
      gl.bindTexture(gl.TEXTURE_2D, src);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.FLOAT, rgba);
      const mid = gpu.texture(w, h, gl.RGBA32F);
      gpu.present(src, w, h, { matrix, exposure, toTexture: mid });
      const out = nrFilterTex(gpu, mid, w, h, N.engineNrTables({ gain: 4, luminance: 50, color: 50 }), N.NR_SPACE);
      const bmp = gpu.present(out, w, h, { matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1], exposure: 1, lytro: { saturation: 1, exact: true } });
      const c2 = new OffscreenCanvas(w, h);
      const g2 = c2.getContext('2d');
      g2.drawImage(bmp, 0, 0);
      const px = g2.getImageData(0, 0, w, h).data;
      let sum = 0;
      let max = 0;
      for (let i = 0; i < w * h; i++) for (let c = 0; c < 3; c++) {
        const d = Math.abs(px[4 * i + c] - cpu[4 * i + c]);
        sum += d;
        if (d > max) max = d;
      }
      return { mean: sum / (w * h * 3), max };
    });
    if (!res) return t.skip('No float render targets');
    t.diagnostic(`GPU chain against the CPU path, in 8 bit levels: mean ${res.mean.toFixed(3)}, largest ${res.max}`);
    assert.ok(res.mean < 0.6, `mean difference ${res.mean} levels`);
    assert.ok(res.max <= 4, `largest difference ${res.max} levels`);
  } finally {
    await browser.close();
    server.close();
  }
});
