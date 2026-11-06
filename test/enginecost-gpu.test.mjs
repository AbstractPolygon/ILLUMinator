// The engine depth estimator's cost volume on the GPU (gpu/enginecost.js) against the CPU version (core/enginedepth.js engineCostVolume), in a headless
// browser. Skipped where Playwright or its browser is not installed.
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

test('GPU engine cost volume matches the CPU result', async (t) => {
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
      const W = 61, H = 47;
      const E = await import('/js/core/enginedepth.js');
      const { GpuRenderer } = await import('/js/gpu/renderer.js');
      const { engineCostVolumeGpu, engineCostVolumeResident } = await import('/js/gpu/enginecost.js');
      const { engineSolveGpu } = await import('/js/gpu/depthmatch.js');
      const f = (x, y, c) => 0.5 + 0.25 * Math.sin(0.31 * x + 1.7 * c) * Math.cos(0.23 * y - c) + 0.2 * Math.sin(0.113 * (x + 2 * y) + c);
      const views = [];
      for (let k = 0; k < 9; k++) {
        const [u, v] = k < 8 ? E.RING_UV[k] : [0, 0];
        const rgb = new Float32Array(W * H * 3);
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
          const a = x < W / 2 ? -3 : 2.4;
          for (let c = 0; c < 3; c++) rgb[3 * (y * W + x) + c] = Math.min(1, f(x + a * u, y + a * v, c) * (x > 50 ? 1.6 : 1));
        }
        views.push(rgb);
      }
      const labels = [-6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5];
      const gl = new OffscreenCanvas(1, 1).getContext('webgl2', { antialias: false, depth: false, stencil: false, premultipliedAlpha: false });
      if (!gl || !gl.getExtension('EXT_color_buffer_float')) return null;
      const cpu = E.engineCostVolume(views, W, H, labels);
      const gpu = engineCostVolumeGpu(new GpuRenderer(gl), views, W, H, labels);
      let worst = 0;
      let zeroCpu = 0;
      let zeroMismatch = 0;
      const L = labels.length;
      for (let i = 0; i < W * H; i++) {
        const zc = cpu[i * L] === 0 && cpu[i * L + L - 1] === 0;
        const zg = gpu[i * L] === 0 && gpu[i * L + L - 1] === 0;
        if (zc) zeroCpu++;
        if (zc !== zg) zeroMismatch++;
      }
      for (let i = 0; i < cpu.length; i++) worst = Math.max(worst, Math.abs(cpu[i] - gpu[i]));
      let bad = 0, first = null;
      for (let i = 0; i < cpu.length; i++) if (Math.abs(cpu[i] - gpu[i]) > 1e-3) { bad++; if (!first) first = { px: Math.floor(i / L) % W, py: Math.floor(i / L / W), l: i % L, cpu: cpu[i], gpu: gpu[i] }; }
      const gr = new GpuRenderer(gl);
      const depthCpu = E.engineDepthMap(views, W, H, labels);
      const depthGpu = engineSolveGpu(gr, gpu, views[8], W, H, labels);
      let dWorst = 0, dBad = 0;
      for (let i = 0; i < W * H; i++) { const d = Math.abs(depthCpu[i] - depthGpu[i]); if (d > dWorst) dWorst = d; if (d > 0.05) dBad++; }
      // the volume left on the card: the same array when read back, and the solver gives the same depth from it
      const resident = engineCostVolumeResident(gr, views, W, H, labels);
      const back = resident.toArray();
      let residentDiff = 0;
      for (let i = 0; i < gpu.length; i++) residentDiff = Math.max(residentDiff, Math.abs(gpu[i] - back[i]));
      const depthResident = engineSolveGpu(gr, resident, views[8], W, H, labels);
      resident.dispose();
      let residentDepthDiff = 0;
      for (let i = 0; i < W * H; i++) residentDepthDiff = Math.max(residentDepthDiff, Math.abs(depthGpu[i] - depthResident[i]));
      return { worst, bad, first, zeroCpu, zeroMismatch, dWorst, dBad, residentDiff, residentDepthDiff, error: gl.getError() };
    });
    if (!res) return t.skip('No WebGL2 with float targets');
    t.diagnostic(JSON.stringify(res));
    assert.equal(res.error, 0);
    assert.ok(res.worst < 2e-4, `largest difference ${res.worst} ${JSON.stringify(res)}`);
    assert.ok(res.dBad <= 0.01 * 61 * 47, `depth differs at ${res.dBad} pixels, worst ${res.dWorst}`);
    assert.ok(res.residentDiff < 1e-6, `the volume left on the card differs from the array by ${res.residentDiff}`);
    assert.ok(res.residentDepthDiff < 1e-4, `the solver gives a different depth from the resident volume: ${res.residentDepthDiff}`);
    assert.ok(res.zeroMismatch <= 2, `zeroed pixels differ: ${res.zeroMismatch} of ${res.zeroCpu}`);
  } finally {
    await browser.close();
    server.close();
  }
});

test('GPU depth solver handles the largest label range (136 labels)', async (t) => {
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
      const W = 29, H = 23;
      const E = await import('/js/core/enginedepth.js');
      const { GpuRenderer } = await import('/js/gpu/renderer.js');
      const { engineCostVolumeGpu, engineCostVolumeResident } = await import('/js/gpu/enginecost.js');
      const { engineSolveGpu } = await import('/js/gpu/depthmatch.js');
      const f = (x, y, c) => 0.5 + 0.25 * Math.sin(0.31 * x + 1.7 * c) * Math.cos(0.23 * y - c) + 0.2 * Math.sin(0.113 * (x + 2 * y) + c);
      const views = [];
      for (let k = 0; k < 9; k++) {
        const [u, v] = k < 8 ? E.RING_UV[k] : [0, 0];
        const rgb = new Float32Array(W * H * 3);
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
          const a = x < W / 2 ? -3 : 2.4;
          for (let c = 0; c < 3; c++) rgb[3 * (y * W + x) + c] = Math.min(1, f(x + a * u, y + a * v, c) * (x > 50 ? 1.6 : 1));
        }
        views.push(rgb);
      }
      const labels = []; for (let v = -35; v <= 100; v++) labels.push(v);
      const gl = new OffscreenCanvas(1, 1).getContext('webgl2', { antialias: false, depth: false, stencil: false, premultipliedAlpha: false });
      if (!gl || !gl.getExtension('EXT_color_buffer_float')) return null;
      const cpu = E.engineCostVolume(views, W, H, labels);
      const gpu = engineCostVolumeGpu(new GpuRenderer(gl), views, W, H, labels);
      let worst = 0;
      let zeroCpu = 0;
      let zeroMismatch = 0;
      const L = labels.length;
      for (let i = 0; i < W * H; i++) {
        const zc = cpu[i * L] === 0 && cpu[i * L + L - 1] === 0;
        const zg = gpu[i * L] === 0 && gpu[i * L + L - 1] === 0;
        if (zc) zeroCpu++;
        if (zc !== zg) zeroMismatch++;
      }
      for (let i = 0; i < cpu.length; i++) worst = Math.max(worst, Math.abs(cpu[i] - gpu[i]));
      let bad = 0, first = null;
      for (let i = 0; i < cpu.length; i++) if (Math.abs(cpu[i] - gpu[i]) > 1e-3) { bad++; if (!first) first = { px: Math.floor(i / L) % W, py: Math.floor(i / L / W), l: i % L, cpu: cpu[i], gpu: gpu[i] }; }
      const gr = new GpuRenderer(gl);
      const depthCpu = E.engineDepthMap(views, W, H, labels);
      const depthGpu = engineSolveGpu(gr, gpu, views[8], W, H, labels);
      let dWorst = 0, dBad = 0;
      for (let i = 0; i < W * H; i++) { const d = Math.abs(depthCpu[i] - depthGpu[i]); if (d > dWorst) dWorst = d; if (d > 0.05) dBad++; }
      // the volume left on the card: the same array when read back, and the solver gives the same depth from it
      const resident = engineCostVolumeResident(gr, views, W, H, labels);
      const back = resident.toArray();
      let residentDiff = 0;
      for (let i = 0; i < gpu.length; i++) residentDiff = Math.max(residentDiff, Math.abs(gpu[i] - back[i]));
      const depthResident = engineSolveGpu(gr, resident, views[8], W, H, labels);
      resident.dispose();
      let residentDepthDiff = 0;
      for (let i = 0; i < W * H; i++) residentDepthDiff = Math.max(residentDepthDiff, Math.abs(depthGpu[i] - depthResident[i]));
      return { worst, bad, first, zeroCpu, zeroMismatch, dWorst, dBad, residentDiff, residentDepthDiff, error: gl.getError() };
    });
    if (!res) return t.skip('No WebGL2 with float targets');
    t.diagnostic(JSON.stringify(res));
    assert.equal(res.error, 0);
    assert.ok(res.worst < 2e-4, `largest difference ${res.worst} ${JSON.stringify(res)}`);
    assert.ok(res.dBad <= 0.01 * 29 * 23, `depth differs at ${res.dBad} pixels, worst ${res.dWorst}`);
    assert.ok(res.residentDiff < 1e-6, `the volume left on the card differs from the array by ${res.residentDiff}`);
    assert.ok(res.residentDepthDiff < 1e-4, `the solver gives a different depth from the resident volume: ${res.residentDepthDiff}`);
    assert.ok(res.zeroMismatch <= 2, `zeroed pixels differ: ${res.zeroMismatch} of ${res.zeroCpu}`);
  } finally {
    await browser.close();
    server.close();
  }
});
