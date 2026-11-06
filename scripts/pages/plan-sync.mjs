// Rebuilds the hosted plan page's editable copy of itself after its visible text has been changed.
//
//   node scripts/pages/plan-sync.mjs PLAN.html
//
// The plan page is an Artifact that republishes itself when its owner edits it in the page: it carries its own source as JSON in <script id="edit-src">, which must say
// the same as the visible part. After editing the visible part (everything before that script), run this, then publish PLAN.html. The source is the visible part without the
// Artifact skeleton (the first line, up to <title>), with "<" written as < so the script block cannot end early.
import fs from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/pages/plan-sync.mjs PLAN.html');
  process.exit(1);
}
const text = fs.readFileSync(file, 'utf8');
const open = '<script id="edit-src" type="application/json">';
const start = text.indexOf(open);
const end = text.indexOf('</script>', start);
if (start < 0 || end < 0) throw new Error('no <script id="edit-src"> in the page');
const head = text.slice(0, start);
const skeleton = head.indexOf('<title>');
if (skeleton < 0) throw new Error('no <title> in the page');
const source = JSON.stringify(head.slice(skeleton)).replace(/</g, '\\u003c');
const out = head + open + source + text.slice(end);
if (out === text) console.error('already in sync');
else fs.writeFileSync(file, out);
