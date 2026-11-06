/* global document -- used inside page.evaluate, which runs in the browser */
// Records what the page sends the engine for a few states of its controls: the control values (what the page held) and the settings object (`appliedSettings`).
// test/settings.test.mjs replays the values through app/js/settingsmap.js and compares. Needs Playwright (not a dependency of the project):
//
//   node scripts/capture-settings.mjs OUT.json [PLAYWRIGHT_PATH]
//
// APP_DIR=path records another copy of the page (the code before a change). Run it on the page's code from before a change to the settings and again after: the two files must be identical, apart from changes the change was meant to make.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = process.env.APP_DIR ? path.resolve(process.env.APP_DIR) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../app');
const { chromium } = await import(process.argv[3] || 'playwright');
const types = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.wasm': 'application/wasm' };
const server = http.createServer((q, r) => {
  const u = decodeURIComponent(q.url.split('?')[0]);
  const f = path.join(root, u === '/' ? 'index.html' : u);
  fs.readFile(f, (e, d) => {
    if (e) { r.writeHead(404); r.end(); } else { r.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); r.end(d); }
  });
}).listen(0);
const port = server.address().port;
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`http://localhost:${port}/`);
await page.waitForTimeout(2500);

// A state of the controls: `mode` is 'defaults', or a seed for a deterministic pseudo-random state ('custom-ccm' is one with the color matrix set to custom) (sliders anywhere in their range, checkboxes and selects flipped by chance).
async function capture(mode) {
  return page.evaluate(async (mode) => {
    const random = mode !== 'defaults';
    let seed = typeof mode === 'number' ? mode : 7;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    const skip = /^(file-input|cal-input|dir-input|lut-file|camera-select|qe-|mem-|update-|check-updates|cal-lens|thumb-size|scrub|anim-length|tl-|fps-preset|local-masks|mask-|mx-|mr-|ml-|md-|lut-data|lut-film)/;
    const state = {};
    for (const el of document.querySelectorAll('input, select')) {
      if (!el.id || skip.test(el.id)) continue;
      if (random) {
        if (el.type === 'checkbox') el.checked = rnd() < 0.5;
        else if (el.type === 'range') {
          const min = +el.min || 0;
          const max = el.max === '' ? 100 : +el.max;
          const step = +el.step || 1;
          el.value = String(min + Math.round((rnd() * (max - min)) / step) * step);
        } else if (el.tagName === 'SELECT' && el.options.length) el.selectedIndex = Math.floor(rnd() * el.options.length);
        else if (el.type === 'number') el.value = String(Math.round(rnd() * 10));
        else if (el.id === 'curve-points') el.value = '0,0;0.3,0.45;0.7,0.6;1,1';
      }
      if (mode === 'custom-ccm' && el.id === 'ccm-mode') el.value = 'custom'; // the color matrix is only read when it is custom
      state[el.id] = el.type === 'checkbox' ? el.checked : el.value;
    }
    delete globalThis.__appliedSettings;
    document.getElementById('lens-auto').dispatchEvent(new Event('change', { bubbles: true }));
    for (let i = 0; i < 100 && !globalThis.__appliedSettings; i++) await new Promise((r) => setTimeout(r, 50));
    return { state, settings: JSON.parse(JSON.stringify(globalThis.__appliedSettings ?? null)) };
  }, mode);
}

const out = [];
for (const mode of ['defaults', 11, 29, 47, 'custom-ccm']) out.push({ mode, ...(await capture(mode)) });
// keys in sorted order, so two captures compare with cmp
const sorted = (v) => (Array.isArray(v) ? v.map(sorted) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted(v[k])])) : v);
fs.writeFileSync(process.argv[2], JSON.stringify(out.map(sorted), null, 1) + '\n');
console.log(`${out.length} states written; page errors: ${errors.length ? errors.join(' | ') : 'none'}`);
for (const o of out) if (!o.settings) console.log('no settings captured for', o.mode);
await browser.close();
server.close();
