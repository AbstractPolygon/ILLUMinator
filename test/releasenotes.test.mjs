import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseHighlights } from '../app/js/core/releasenotes.js';

const body = `Illuminator 0.5.80.

## What's new

- **Cleaner depth on shiny things.** Black blotches on metal and glass are gone.
- **Diamond pattern fix.** A new *Lattice filter* setting lets you adjust it.
- Plain bullet with no lead.

## Downloads

- **Windows:** \`x.exe\`
`;

test('bullets under What\'s new, split into a lead and a sentence', () => {
  const items = releaseHighlights(body);
  assert.equal(items.length, 3);
  assert.deepEqual(items[0], { lead: 'Cleaner depth on shiny things.', text: 'Black blotches on metal and glass are gone.' });
  assert.equal(items[2].lead, '');
  assert.equal(items[2].text, 'Plain bullet with no lead.');
  assert.equal(items[1].text, 'A new Lattice filter setting lets you adjust it.');
});

test('stops at the next heading and keeps at most max bullets', () => {
  assert.equal(releaseHighlights(body).some((x) => /Windows/.test(x.lead + x.text)), false);
  assert.equal(releaseHighlights(body, 2).length, 2);
});

test('no What\'s new section, or no body, gives an empty list', () => {
  assert.deepEqual(releaseHighlights('Illuminator 0.5.71.\n\n- **Windows:** x'), []);
  assert.deepEqual(releaseHighlights(null), []);
});
