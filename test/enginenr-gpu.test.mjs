// The engine's noise reduction on the GPU (gpu/enginenr.js) against the CPU port (core/enginenr.js), in a headless browser. Skipped where Playwright or its
// browser is not installed.
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

test('GPU noise reduction building blocks match the CPU port', async (t) => {
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
      const N = await import('/js/core/enginenr.js');
      const { GpuRenderer } = await import('/js/gpu/renderer.js');
      const { NrGpu, nrFilterGpu } = await import('/js/gpu/enginenr.js');
      const gl = new OffscreenCanvas(1, 1).getContext('webgl2', { antialias: false, depth: false, stencil: false, premultipliedAlpha: false });
      if (!gl || !gl.getExtension('EXT_color_buffer_float')) return null;
      const nr = new NrGpu(new GpuRenderer(gl));
      const out = { lines: [] };
      let seed = 12345;
      const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
      for (const [w, h] of [[24, 17], [15, 22], [9, 9]]) {
        const tiles = 3;
        const data = new Float32Array(tiles * w * h);
        for (let i = 0; i < data.length; i++) data[i] = rnd() * 200;
        const A = nr.atlas(tiles, 1, w, h);
        const B = nr.atlas(tiles, 1, w, h);
        const atl = new Float32Array(tiles * w * h);
        for (let t = 0; t < tiles; t++) for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) atl[y * tiles * w + t * w + x] = data[t * w * h + y * w + x];
        nr.upload(A, atl);
        for (const mi of [1, 2]) {
          const ls = N.__internals.lineSet(w, h, mi);
          const dirs = [...ls.dirs.map((d, i) => ({ d, name: 'dir' + i })), { d: ls.H, name: 'H' }, { d: ls.V, name: 'V' }];
          for (const { d, name } of dirs) for (const r of [0, 1, 3, 4]) {
            nr.lineFilt(A, B, d, r);
            const got = nr.read(B);
            let worst = 0;
            for (let t = 0; t < tiles; t++) {
              const exp = new Float32Array(w * h);
              N.__internals.lineFilt(data.subarray(t * w * h, (t + 1) * w * h), exp, w, h, d, r);
              for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) worst = Math.max(worst, Math.abs(exp[y * w + x] - got[y * tiles * w + t * w + x]));
            }
            out.lines.push({ w, h, mi, name, r, worst });
          }
        }
      }
      out.worstLine = Math.max(...out.lines.map((l) => l.worst));
      out.bad = out.lines.filter((l) => l.worst > 1e-3).slice(0, 5);
      // the whole filter on a noisy picture of several tile shapes
      {
        const W = 250, H = 180, n = W * H;
        const planes = [0, 1, 2].map((c) => { const p = new Float32Array(n); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) p[y * W + x] = Math.max(0, Math.min(255, 90 + 60 * Math.sin(x * 0.05 + c) * Math.cos(y * 0.04) + (x > 120 ? 30 : 0) + (rnd() - 0.5) * 24)); return p; });
        const st = N.nrStrengths(50, 50, 4);
        const tables = N.nrTables(N.nrProfileIndex(4), st.luma, st.lum, st.col, st.col);
        const cpu = N.nrFilter(planes, W, H, tables);
        const gpu = nrFilterGpu(new GpuRenderer(gl), planes, W, H, tables);
        out.whole = [0, 1, 2].map((c) => { let worst = 0, sum = 0; for (let i = 0; i < n; i++) { const d = Math.abs(cpu[c][i] - gpu[c][i]); sum += d; if (d > worst) worst = d; } return { worst, mean: sum / n }; });
        let ch = 0; for (let i = 0; i < n; i++) ch += Math.abs(cpu[0][i] - planes[0][i]);
        out.cpuChange = ch / n;
      }
      out.error = gl.getError();
      return out;
    });
    if (!res) return t.skip('No WebGL2 with float targets');
    t.diagnostic(JSON.stringify({ worstLine: res.worstLine, bad: res.bad, n: res.lines.length, whole: res.whole, cpuChange: res.cpuChange }));
    assert.equal(res.error, 0);
    assert.ok(res.worstLine < 1e-3, `line filter differs: ${JSON.stringify(res.bad)}`);
    for (const c of res.whole) assert.ok(c.worst < 0.05 && c.mean < 0.005, `whole filter differs: ${JSON.stringify(res.whole)}`);
  } finally {
    await browser.close();
    server.close();
  }
});
