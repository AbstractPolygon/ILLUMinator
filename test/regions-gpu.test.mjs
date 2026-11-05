// The region cleanup's per-pixel filters on the GPU (gpu/regions.js) against the CPU versions (core/segments.js), in a headless browser, on a synthetic picture with colour blocks, noise and depth steps. Skipped where Playwright or its browser is not installed.
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

test('the GPU region filters match the CPU versions', async (t) => {
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
      const { regionsGpu } = await import('/js/gpu/regions.js');
      const S = await import('/js/core/segments.js');
      const gl = new OffscreenCanvas(1, 1).getContext('webgl2', { antialias: false, depth: false, stencil: false, premultipliedAlpha: false });
      if (!gl || !gl.getExtension('EXT_color_buffer_float')) return null;
      const gpu = new GpuRenderer(gl);
      const g = regionsGpu(gpu);
      if (!g) return null;
      const w = 97;
      const h = 71;
      const n = w * h;
      let seed = 3;
      const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
      const lab = new Float32Array(n * 3);
      const depth = new Float32Array(n);
      const objects = new Uint32Array(n);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const p = y * w + x;
          const blk = ((x / 24) | 0) + ((y / 18) | 0) * 5;
          lab[3 * p] = 20 + ((blk * 37) % 60) + 3 * rnd();
          lab[3 * p + 1] = ((blk * 53) % 50) - 25 + 2 * rnd();
          lab[3 * p + 2] = ((blk * 29) % 50) - 25 + 2 * rnd();
          depth[p] = 0.1 * (blk % 5) + 0.004 * rnd() + 0.2 * (x / w);
          objects[p] = blk % 3;
        }
      }
      const rgb = new Float32Array(n * 3);
      for (let p = 0; p < n; p++) for (let c = 0; c < 3; c++) rgb[3 * p + c] = Math.min(1, Math.max(0, (lab[3 * p + c] + 60) / 160));
      const cmp = (a, b) => {
        let worst = 0;
        let off = 0;
        for (let i = 0; i < a.length; i++) {
          const d = Math.abs(a[i] - b[i]);
          worst = Math.max(worst, d);
          if (d > 1e-4) off++;
        }
        return { worst, off: off / a.length };
      };
      const out = {};
      out.smoothRamps = cmp(S.smoothRamps(depth, lab, w, h, 0.25), g.smoothRamps(depth, lab, w, h, 0.25));
      out.smoothRampsObjects = cmp(S.smoothRamps(depth, lab, w, h, Infinity, objects, 8, 4, 10), g.smoothRamps(depth, lab, w, h, Infinity, objects, 8, 4, 10));
      out.colorMedian = cmp(S.colorMedian(depth, lab, w, h), g.colorMedian(depth, lab, w, h));
      out.snapToObjects = cmp(S.snapToObjects(depth, objects, w, h), g.snapToObjects(depth, objects, w, h));
      out.guidedFilter = cmp(S.guidedFilter(depth, lab, w, h, 5, 0.003), g.guidedFilter(depth, lab, w, h, 5, 0.003));
      out.layerSnap = cmp(S.layerSnap(depth, lab, w, h), g.layerSnap(depth, lab, w, h));
      out.layerSnapHard = cmp(S.layerSnap(depth, lab, w, h, { hard: true }), g.layerSnap(depth, lab, w, h, { hard: true }));
      // flattenHalos: two big objects with planar depth and a halo of too-near depth along their border, as around a near object
      {
        const obj2 = new Uint32Array(n);
        const dep2 = new Float32Array(n);
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const p = y * w + x;
            obj2[p] = x < w / 2 ? 7 : 9;
            let d = 0.1 + 0.3 * (x / w) + 0.2 * (y / h) + 0.003 * rnd();
            if (Math.abs(x - w / 2) < 6 && y % 3 !== 0) d -= 0.25;
            dep2[p] = d;
          }
        }
        const c = S.flattenHalos(dep2, obj2, w, h);
        const gp = g.flattenHalos(dep2, obj2, w, h);
        let changed = 0;
        for (let i = 0; i < n; i++) if (c[i] !== dep2[i]) changed++;
        out.flattenHalos = cmp(c, gp);
        out.flattenHalosChanged = { worst: 0, off: 0, note: changed / n };
      }
      // Lab from rgb
      {
        const cpuLab = new Float32Array(n * 3);
        for (let p = 0; p < n; p++) S.toLab(rgb[3 * p], rgb[3 * p + 1], rgb[3 * p + 2], cpuLab, 3 * p);
        const gpuLab = g.labOf(rgb, w, h);
        let worst = 0;
        for (let i = 0; i < cpuLab.length; i++) worst = Math.max(worst, Math.abs(cpuLab[i] - gpuLab[i]));
        out.lab = { worst: worst / 100, off: 0 };
      }
      // the superpixels
      {
        const cpuL = S.slic(lab, w, h, 120).label;
        const gpuL = g.slicLabels(lab, w, h, 120);
        let off = 0;
        for (let i = 0; i < n; i++) if (cpuL[i] !== gpuL[i]) off++;
        out.slicLabels = { worst: 0, off: off / n };
      }
      out.guidedFilterColor = cmp(S.guidedFilterColor(depth, rgb, w, h), S.guidedFilterColor(depth, rgb, w, h, 5, 0.003, g));
      // object finding from masks: discs and boxes of different sizes, some nearly the same, some too big or too small or unsure
      {
        const O = await import('/js/core/objects.js');
        const mw = 61;
        const mh = 47;
        const masks = [];
        const add = (cx, cy, rx, ry, quality, box) => {
          const bin = new Uint8Array(mw * mh);
          let area = 0;
          for (let y = 0; y < mh; y++) {
            for (let x = 0; x < mw; x++) {
              const inside = box ? Math.abs(x - cx) <= rx && Math.abs(y - cy) <= ry : ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
              if (inside) { bin[y * mw + x] = 1; area++; }
            }
          }
          masks.push({ bin, area, quality });
        };
        add(30, 23, 28, 20, 0.95);          // large
        add(30, 23, 27, 19, 0.93);          // nearly the same: dropped
        add(15, 15, 9, 8, 0.97);
        add(45, 30, 10, 9, 0.9, true);
        add(46, 30, 10, 9, 0.9, true);      // nearly the same box
        add(30, 10, 6, 5, 0.99);
        add(10, 38, 7, 6, 0.8);              // unsure: dropped
        add(52, 8, 1, 1, 0.99);              // speck: dropped
        add(30, 23, 40, 30, 0.99, true);     // the whole picture: dropped
        add(22, 30, 8, 8, 0.91);
        add(40, 12, 5, 7, 0.88, true);
        const outW = 97;
        const outH = 71;
        const cpu = O.upsampleLabels(O.signatures(O.pickObjects(masks, mw, mh), mw, mh), mw, mh, outW, outH);
        const gp = g.findObjects(masks, mw, mh, outW, outH);
        let diff = 0;
        let nonzero = 0;
        for (let i = 0; i < cpu.length; i++) { if (cpu[i] !== gp[i]) diff++; if (cpu[i]) nonzero++; }
        out.findObjects = { worst: 0, off: diff / cpu.length };
        out.findObjectsCovered = { worst: 0, off: 0, note: nonzero / cpu.length };
      }
      // the object model's input
      {
        const { segmentInput } = await import('/js/core/segmodel.js');
        const cpu = segmentInput(rgb, w, h);
        const gp = g.segInput(rgb, w, h);
        let worst = 0;
        for (let i = 0; i < cpu.input.length; i++) worst = Math.max(worst, Math.abs(cpu.input[i] - gp.input[i]));
        out.segInput = { worst: worst / 255, off: gp.nw === cpu.nw && gp.nh === cpu.nh ? 0 : 1 };
      }
      // the whole cleanup, both ways
      const conf = new Float32Array(n);
      for (let i = 0; i < n; i++) conf[i] = 0.3 + 0.7 * rnd();  // varied, as real confidences are (equal ones tie exactly at the median)
      out.segmentDepth = cmp(S.segmentDepth(depth, conf, rgb, w, h, { count: 120 }), S.segmentDepth(depth, conf, rgb, w, h, { count: 120, gpu: g }));
      out.segmentDepthObjects = cmp(S.segmentDepth(depth, conf, rgb, w, h, { count: 120, objects }), S.segmentDepth(depth, conf, rgb, w, h, { count: 120, objects, gpu: g }));
      return out;
    });
    if (!res) return t.skip('No float-renderable WebGL2');
    for (const [name, { worst, off }] of Object.entries(res)) {
      if (name === 'findObjectsCovered') { t.diagnostic(`object labels cover ${(100 * res[name].note).toFixed(0)}% of the test picture`); assert.ok(res[name].note > 0.3, 'the object test must label something'); continue; }
      if (name === 'flattenHalosChanged') { t.diagnostic(`flattenHalos moved ${(100 * Object.values({ v: res[name].note })[0]).toFixed(1)}% of the pixels on the CPU`); assert.ok(res[name].note > 0.02, 'the halo test must change something'); continue; }
      t.diagnostic(`${name}: largest difference ${worst.toExponential(2)}, ${(off * 100).toFixed(3)}% of pixels differ`);
      // float32 against double: a few ties may fall the other way in the medians
      const limit = name === 'smoothRamps' || name === 'smoothRampsObjects' ? 1e-3 : Infinity;
      assert.ok(worst < limit, `${name}: largest difference ${worst}`);
      assert.ok(off < 0.01, `${name}: ${(off * 100).toFixed(2)}% of pixels differ by more than 1e-4`);
    }
  } finally {
    server.close();
    await browser.close();
  }
});
