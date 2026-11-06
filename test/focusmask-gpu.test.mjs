// The focus mask shaders (and the depth of field step that reads them) compile and run in a headless browser. Skipped where Playwright or its browser is not installed.
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

test('the focus mask shaders compile and the depth of field step takes a mask', async (t) => {
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
      const gl = new OffscreenCanvas(1, 1).getContext('webgl2', { antialias: false, depth: false, stencil: false, premultipliedAlpha: false });
      if (!gl || !gl.getExtension('EXT_color_buffer_float')) return null;
      const gpu = new GpuRenderer(gl);
      // every program is linked when first used: the three mask shaders and the depth of field prep
      for (const name of ['focusScore', 'focusMask', 'focusSpread', 'dofPrep']) void gpu.programs[name].p;
      // the depth of field with a mask: a picture, a depth map and a mask of its size
      const w = 64;
      const h = 48;
      const src = gpu.texture(w, h, gl.RGBA32F);
      gl.bindTexture(gl.TEXTURE_2D, src);
      const rgba = new Float32Array(w * h * 4).fill(0.5);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.FLOAT, rgba);
      gpu.setDepth(new Float32Array(w * h).fill(1), w, h);
      const mask = gpu.scratch(w, h, 'testMask');
      const out = gpu.depthOfField(src, w, h, { focus: 0, strength: 8, sharp: mask });
      return { ok: !!out, err: gl.getError() };
    });
    if (!res) return t.skip('No float render targets');
    assert.equal(res.ok, true);
    assert.equal(res.err, 0);
  } finally {
    await browser.close();
    server.close();
  }
});

test('the Blur under Focus Spread feathers the blur map on the GPU', async (t) => {
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
      const gl = new OffscreenCanvas(1, 1).getContext('webgl2', { antialias: false, depth: false, stencil: false, premultipliedAlpha: false });
      if (!gl || !gl.getExtension('EXT_color_buffer_float')) return null;
      const gpu = new GpuRenderer(gl);
      const w = 64;
      const h = 16;
      const src = gpu.texture(w, h, gl.RGBA32F);
      gl.bindTexture(gl.TEXTURE_2D, src);
      const rgba = new Float32Array(w * h * 4);
      for (let i = 0; i < w * h; i++) rgba.fill(0.1 + 0.8 * ((i % w) % 2), i * 4, i * 4 + 3);   // fine stripes
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.FLOAT, rgba);
      const depth = new Float32Array(w * h);
      for (let y = 0; y < h; y++) for (let x = 32; x < w; x++) depth[y * w + x] = 1.2;   // right half far behind the focus
      gpu.setDepth(depth, w, h);
      const read = (tex) => {
        gpu.target(tex, w, h);
        const buf = new Float32Array(w * h * 4);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, buf);
        return buf;
      };
      const contrast = (buf, x) => { let m = 0; for (let y = 0; y < h; y++) m += Math.abs(buf[(y * w + x) * 4] - buf[(y * w + x + 1) * 4]); return m / h; };
      const hard = read(gpu.depthOfField(src, w, h, { focus: 0, strength: 4, spread: 0.5 }));
      const hardC = [2, 28, 36, 60].map((x) => contrast(hard, x));
      const soft = read(gpu.depthOfField(src, w, h, { focus: 0, strength: 4, spread: 0.5, feather: 10 }));
      const softC = [2, 28, 36, 60].map((x) => contrast(soft, x));
      return { hardC, softC, err: gl.getError() };
    });
    if (!res) return t.skip('No float render targets');
    assert.equal(res.err, 0);
    // far from the boundary nothing changes
    assert.ok(Math.abs(res.hardC[0] - res.softC[0]) < 1e-3, JSON.stringify(res));
    assert.ok(Math.abs(res.hardC[3] - res.softC[3]) < 0.05, JSON.stringify(res));
    // beside it the sharp side starts to blur (less contrast) and the blurred side is less blurred
    assert.ok(res.softC[1] < res.hardC[1] - 0.02, `blur does not reach into the sharp side: ${JSON.stringify(res)}`);
    assert.ok(res.softC[2] > res.hardC[2] + 0.02, `blur does not ease on the blurred side: ${JSON.stringify(res)}`);
  } finally {
    await browser.close();
    server.close();
  }
});
