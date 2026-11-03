// Detail recovery's base picture: copied on the GPU from the refocused view (splatInputs baseFromView) gives the same texture as the CPU array upload, in a headless browser. Skipped where Playwright or its browser is not installed.
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

test('the Detail recovery base copied on the GPU matches the uploaded array', async (t) => {
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
      const w = 37;
      const h = 23;
      const rgb = new Float32Array(w * h * 3);
      for (let i = 0; i < rgb.length; i++) rgb[i] = ((i * 2654435761) % 1000) / 1000;
      const rgba = new Float32Array(w * h * 4);
      for (let i = 0; i < w * h; i++) { rgba[4 * i] = rgb[3 * i]; rgba[4 * i + 1] = rgb[3 * i + 1]; rgba[4 * i + 2] = rgb[3 * i + 2]; rgba[4 * i + 3] = 1; }
      gpu.outTex = gpu.texture(w, h);
      gl.bindTexture(gl.TEXTURE_2D, gpu.outTex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, w, h, gl.RGBA, gl.FLOAT, rgba);
      const vignetting = { bins: 2, gain: new Float32Array(2 * 2 * 3).fill(1) };
      const read = (tex) => {
        const fb = gl.createFramebuffer();
        gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
        const px = new Float32Array(w * h * 4);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.FLOAT, px);
        return Array.from(px);
      };
      const e0 = gl.getError();
      const a = gpu.splatInputs({ base: rgb, baseW: w, baseH: h, vignetting });
      const e1 = gl.getError();
      const b = gpu.splatInputs({ baseFromView: true, baseW: w, baseH: h, vignetting });
      const e2 = gl.getError();
      return { a: read(a.base), b: read(b.base), err: [e0, e1, e2, gl.getError()].join() };
    });
    if (!res) return t.skip('No float render targets');
    assert.equal(res.err, '0,0,0,0');
    let worst = 0;
    for (let i = 0; i < res.a.length; i++) worst = Math.max(worst, Math.abs(res.a[i] - res.b[i]));
    assert.ok(worst < 1e-3, `max difference ${worst}`);
  } finally {
    await browser.close();
    server.close();
  }
});
