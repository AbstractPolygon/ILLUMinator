/* global document, Event, PointerEvent -- used inside page.evaluate, which runs in the browser */
// Loads the page in a browser and plays events into the controls the sections moved out of main.js handle (color matrix, tone curve, frame rate, 3D, white balance, LUT), then
// reports page errors. Needs Playwright (not a dependency of the project):
//
//   node scripts/smoke-page.mjs [PLAYWRIGHT_PATH]
//
// Run it after changes to main.js or the files under app/js/ui: a name main.js still has but a moved section lost shows up here as an error, and the lines it prints must not change.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = await import(process.argv[2] || 'playwright');
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../app');
const types = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.wasm': 'application/wasm' };
const srv = http.createServer((q, r) => { const u = decodeURIComponent(q.url.split('?')[0]); const f = path.join(appRoot, u === '/' ? 'index.html' : u); fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); r.end(); } else { r.writeHead(200, { 'content-type': types[path.extname(f)] || 'application/octet-stream' }); r.end(d); } }); }).listen(0);
const port = srv.address().port;
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const p = await b.newPage({ viewport: { width: 1300, height: 900 } });
const errors = [];
p.on('pageerror', (e) => errors.push('PAGE ' + e.message));
p.on('console', (m) => { if (m.type() === 'error' && !/WebGPU|Failed to load resource/.test(m.text())) errors.push('CONSOLE ' + m.text().slice(0, 200)); });
await p.goto(`http://localhost:${port}/`); await p.waitForTimeout(2500);
const result = await p.evaluate(async () => {
  const $ = (id) => document.getElementById(id);
  const fire = (id, type = 'input') => $(id).dispatchEvent(new Event(type, { bubbles: true }));
  const log = {};
  // color matrix
  $('ccm-mode').value = 'custom'; fire('ccm-mode', 'change'); log.ccmGridShown = !$('ccm-grid').hidden;
  $('ccm-mode').value = 'camera'; fire('ccm-mode', 'change'); log.ccmGridHidden = $('ccm-grid').hidden;
  // tone curve
  $('curve-highlights').value = 30; fire('curve-highlights'); fire('curve-reset', 'click'); $('curve-reset').click(); log.curveReset = $('curve-points').value;
  const cv = $('curve-canvas'); const r = cv.getBoundingClientRect();
  cv.dispatchEvent(new PointerEvent('pointerdown', { button: 0, pointerId: 1, clientX: r.left + r.width * 0.5, clientY: r.top + r.height * 0.4, bubbles: true }));
  cv.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, bubbles: true }));
  log.curveAfterClick = $('curve-points').value;
  // number fields, wb pick, lut
  for (const id of ['wb-pick']) if ($(id)) $(id).click();
  log.pickPressed = $('wb-pick') && $('wb-pick').getAttribute('aria-pressed');
  if ($('lut-amount')) { $('lut-amount').value = 40; fire('lut-amount'); }
  if ($('lut-select')) fire('lut-select', 'change');
  // frame rate and 3D controls
  $('fps-preset').value = '30'; fire('fps-preset', 'change'); log.fps = $('fps').value; log.customHidden = $('fps-custom').hidden;
  $('fps-preset').value = 'custom'; fire('fps-preset', 'change'); log.customShown = !$('fps-custom').hidden;
  if ($('stereo-mode')) { fire('stereo-mode', 'change'); log.stereoMode = $('stereo-mode').value; }
  if ($('stereo-on')) { $('stereo-on').checked = true; fire('stereo-on', 'change'); }
  await new Promise((r) => setTimeout(r, 400));
  return log;
});
console.log(JSON.stringify(result));
console.log(errors.length ? 'ERRORS:\n' + errors.join('\n') : 'no errors');
await b.close(); srv.close();
