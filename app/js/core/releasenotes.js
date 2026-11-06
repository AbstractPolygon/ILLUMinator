// The short "What's new" list of a release: the bullets under the "What's new" heading of the release's notes (the GitHub release body), each a bold lead and one plain sentence,
// e.g. "- **Cleaner depth on shiny things.** Black blotches on metal and glass are gone." Returns [{ lead, text }] for up to `max` bullets, [] when the notes have no such section.

export function releaseHighlights(body, max = 5) {
  const lines = String(body || '').split(/\r?\n/);
  const start = lines.findIndex((l) => /^#{1,6}\s*what['’]s new\s*$/i.test(l.trim()));
  if (start < 0) return [];
  const items = [];
  for (let i = start + 1; i < lines.length && items.length < max; i++) {
    const line = lines[i].trim();
    if (/^#{1,6}\s/.test(line)) break;
    const m = /^[-*]\s+(.*)$/.exec(line);
    if (!m) continue;
    const bold = /^\*\*(.+?)\*\*\s*(.*)$/.exec(m[1]);
    const plain = (s) => s.replace(/\*\*|\*|`/g, '').trim();
    items.push(bold ? { lead: plain(bold[1]), text: plain(bold[2]) } : { lead: '', text: plain(m[1]) });
  }
  return items.filter((x) => x.lead || x.text);
}
