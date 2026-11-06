// Brings the folder behind the hosted test page (an Artifact page, which keeps its files next to page.html) up to date with app/, and prints what changed.
//
//   node scripts/pages/sync-test-page.mjs MIRROR_DIR
//
// Copies app/js/**, app/luts/** and app/styles.css into MIRROR_DIR when they differ, rebuilds MIRROR_DIR/page.html from app/index.html (the page body, the style sheet link and
// js/share.js, the Artifact page's own script), and prints the changed paths as JSON: pass them as `files` (with `root` = MIRROR_DIR and the same list as `overwrite_unread`)
// when publishing page.html. Files that exist only in MIRROR_DIR (js/share.js) are left alone.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../app');
const mirror = path.resolve(process.argv[2] || '');
if (!process.argv[2] || !fs.existsSync(mirror)) {
  console.error('usage: node scripts/pages/sync-test-page.mjs MIRROR_DIR');
  process.exit(1);
}

const changed = [];
function copyTree(rel) {
  const from = path.join(app, rel);
  if (!fs.existsSync(from)) return;
  if (fs.statSync(from).isDirectory()) {
    for (const name of fs.readdirSync(from)) copyTree(path.join(rel, name));
    return;
  }
  const to = path.join(mirror, rel);
  const data = fs.readFileSync(from);
  if (fs.existsSync(to) && fs.readFileSync(to).equals(data)) return;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.writeFileSync(to, data);
  changed.push(rel.split(path.sep).join('/'));
}
for (const rel of ['js', 'luts', 'styles.css']) copyTree(rel);

const html = fs.readFileSync(path.join(app, 'index.html'), 'utf8');
const body = html.split('<body>')[1].split('</body>')[0].replace(/^\n+/, '').trimEnd();
const page = `<title>Illuminator</title>\n  <link rel="stylesheet" href="styles.css">\n${body}\n  <script type="module" src="js/share.js"></script>\n`;
const pagePath = path.join(mirror, 'page.html');
if (!fs.existsSync(pagePath) || fs.readFileSync(pagePath, 'utf8') !== page) {
  fs.writeFileSync(pagePath, page);
  console.error('page.html rebuilt');
}
console.log(JSON.stringify(changed));
