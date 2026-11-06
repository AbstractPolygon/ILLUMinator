// The project writes American spelling in all text (UI labels, tooltips, wiki, website, release notes): this keeps British spellings from coming back.
// Element ids and setting names (lens-centres, depth-grey, lensCentres) are code, not text, and are left alone.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BRITISH = /(?<![-\w])(colou?r(?:s|ed|ing)?(?<=colour|colours|coloured|colouring)|centres?|centred|greys?|greyscale|behaviours?|favour(?:s|ed|ite|ites)?|neighbours?|neighbouring|licences?|metres?|analyse[sd]?|organis(?:e|es|ed|ing|ation)|recognis(?:e|es|ed|ing)|normalis(?:e|es|ed|ing|ation)|optimis(?:e|es|ed|ing|ation)|artefacts?|catalogues?|grey-?scale)(?![-\w])/gi;

function files() {
  const list = ['app/index.html', 'site/index.html', 'README.md'];
  for (const dir of ['wiki', 'docs/release-notes']) {
    for (const f of fs.readdirSync(path.join(root, dir))) if (f.endsWith('.md')) list.push(path.join(dir, f));
  }
  return list;
}

test('text uses American spelling', () => {
  const found = [];
  for (const f of files()) {
    // data: URIs (embedded images) are not text
    const text = fs.readFileSync(path.join(root, f), 'utf8').replace(/data:[^"')\s]{100,}/g, '');
    text.split('\n').forEach((line, i) => {
      // code comments in the site's style sheet and the like are not user-facing text
      if (/^\s*(\/\*|\*|\/\/)/.test(line)) return;
      for (const m of line.matchAll(BRITISH)) found.push(`${f}:${i + 1}: ${m[0]}`);
    });
  }
  assert.deepEqual(found, [], `British spellings found (use American):\n${found.join('\n')}`);
});
