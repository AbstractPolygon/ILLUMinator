// The engine's modulation plane on the GPU (gpu/enginemod.js) against the CPU version (core/enginemod.js), in a headless browser, on a synthetic white image with lens discs, a vignette and hot pixels. Skipped where Playwright or its browser is not installed.
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

test('the GPU modulation plane matches the CPU version', async (t) => {
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
      const { engineModulation } = await import('/js/core/enginemod.js');
      const { engineModulationGpu, engineModulationGpuAvailable } = await import('/js/gpu/enginemod.js');
      const gl = new OffscreenCanvas(1, 1).getContext('webgl2', { antialias: false, depth: false, stencil: false, premultipliedAlpha: false });
      if (!gl || !gl.getExtension('EXT_color_buffer_float')) return null;
      const gpu = new GpuRenderer(gl);
      const W = 1280;
      const H = 960;
      const cam = { width: W, height: H };
      const dev = { cfa: [[0, 1], [1, 2]], black: [64, 64, 64] };
      const grid = { pitch: 13.4, rowStep: 13.4 * 0.8660254, ox: 6.2, oy: 5.1, rotation: 0.002 };
      let seed = 11;
      const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
      const mod = new Uint16Array(W * H);
      const cs = Math.cos(grid.rotation);
      const sn = Math.sin(grid.rotation);
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          // distance to the nearest lens centre of the hexagonal lattice (found in the lattice's own frame)
          const dx = x - grid.ox;
          const dy = y - grid.oy;
          const u = cs * dx + sn * dy;
          const v = -sn * dx + cs * dy;
          const row = Math.round(v / grid.rowStep);
          let best = 1e9;
          for (let r = row - 1; r <= row + 1; r++) {
            const off = (r & 1) * grid.pitch * 0.5;
            const col = Math.round((u - off) / grid.pitch);
            const du = u - (col * grid.pitch + off);
            const dv = v - r * grid.rowStep;
            best = Math.min(best, du * du + dv * dv);
          }
          const rim = Math.sqrt(best) / (grid.pitch * 0.5);
          const global = 1 - 0.35 * (((x - W / 2) / W) ** 2 + ((y - H / 2) / H) ** 2) * 4;
          const phase = [0.8, 1, 1, 0.55][(y & 1) * 2 + (x & 1)];
          const val = 64 + 900 * phase * global * Math.max(0.02, 1 - 0.9 * rim ** 2.2) + (rnd() - 0.5) * 6;
          mod[y * W + x] = Math.max(0, Math.min(1023, Math.round(val)));
        }
      }
      const hot = [];
      for (let k = 0; k < 300; k++) {
        const x = 4 + Math.floor(rnd() * (W - 8));
        const y = 4 + Math.floor(rnd() * (H - 8));
        mod[y * W + x] = 1023;
        hot.push(y * W + x);
      }
      if (!engineModulationGpuAvailable(gpu, cam)) return { skip: 'GPU not usable' };
      const t0 = performance.now();
      const cpu = engineModulation(mod, cam, dev, grid, hot);
      const t1 = performance.now();
      const out = engineModulationGpu(gpu, mod, cam, dev, grid, hot);
      const t2 = performance.now();
      let worst = 0;
      let over = 0;
      let sum = 0;
      for (let i = 0; i < cpu.length; i++) {
        const d = Math.abs(cpu[i] - out[i]);
        if (d > worst) worst = d;
        if (d > 2) over++;
        sum += d;
      }
      return { worst, over, mean: sum / cpu.length, n: cpu.length, cpuMs: t1 - t0, gpuMs: t2 - t1, unit: out.eUnit, err: gl.getError() };
    });
    if (!res) return t.skip('No float render targets');
    if (res.skip) return t.skip(res.skip);
    console.log(JSON.stringify(res));
    assert.equal(res.err, 0);
    assert.equal(res.unit, 30000);
    assert.ok(res.mean < 0.5, `mean difference ${res.mean} units of 30000`);
    assert.ok(res.over / res.n < 0.001, `${res.over} values differ by more than 2 units`);
    assert.ok(res.worst <= 150, `worst difference ${res.worst}`);
  } finally {
    await browser.close();
    server.close();
  }
});
