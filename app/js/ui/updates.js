// updates: moved out of main.js. initUpdates() runs where the section used to, with what it uses from the rest of the page.
import { VERSION } from '../version.js';
import { releaseHighlights } from '../core/releasenotes.js';

// Whether version `a` is newer than version `b` (dotted numbers).
export function newerVersion(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x > y;
  }
  return false;
}

// Whether the automatic checks are on (Settings > Check for updates): on unless it was turned off.
export function updateCheckOn() {
  try {
    return localStorage.getItem('illuminator.checkUpdates') !== '0';
  } catch {
    return true;
  }
}

export function initUpdates({ showNotice, $ }) {
  // Desktop app: on startup, the newest release on GitHub is compared with
  // this version; when it is newer, a popup lists that release's files with
  // direct download links, this computer's first. "Don't remind me" skips
  // that version.
  const RELEASES_API = 'https://api.github.com/repos/AbstractPolygon/Illuminator/releases/latest';
  const BUILDS = [
    { re: /-win-x64\.exe$/, os: 'win', arch: 'x64', name: 'Windows', detail: 'Intel and AMD' },
    { re: /-win-arm64\.exe$/, os: 'win', arch: 'arm64', name: 'Windows', detail: 'ARM, such as Snapdragon' },
    { re: /-mac-arm64\.dmg$/, os: 'mac', arch: 'arm64', name: 'macOS', detail: 'Apple Silicon' },
    { re: /-mac-x64\.dmg$/, os: 'mac', arch: 'x64', name: 'macOS', detail: 'Intel' },
    { re: /-linux-amd64\.deb$/, os: 'linux', arch: 'x64', name: 'Linux', detail: '.deb for Debian and Ubuntu' },
    { re: /-linux-x86_64\.AppImage$/, os: 'linux', arch: 'x64', name: 'Linux', detail: 'AppImage for other distributions' },
  ];


  function thisOs() {
    const p = `${navigator.userAgentData?.platform || navigator.platform || ''} ${navigator.userAgent}`.toLowerCase();
    return p.includes('win') ? 'win' : p.includes('mac') ? 'mac' : p.includes('linux') ? 'linux' : '';
  }

  // manual: from Help > Check for Updates, which says what it found; the automatic checks (at start, then every few hours) stay silent unless there is a new release.

  async function checkForUpdate(manual = false) {
    if (!window.lytroNative || (!manual && !updateCheckOn())) return;
    let release;
    try {
      const r = await fetch(RELEASES_API, { headers: { Accept: 'application/vnd.github+json' } });
      if (!r.ok) throw new Error(`GitHub answered ${r.status}`);
      release = await r.json();
    } catch (e) {
      if (manual) showNotice('Could not check for a new release', `${e && e.message ? e.message : e}. Check the internet connection and try again.`);
      return;
    }
    const latest = String(release.tag_name || '').replace(/^v/, '');
    if (!newerVersion(latest, VERSION)) {
      if (manual) showNotice('Illuminator is up to date', `Version ${VERSION} is the latest release.`);
      return;
    }
    // "Don't remind me" only stops the pop-up at start: the Update available!
    // message in the toolbar stays, and opens the same pop-up.
    let skipped = false;
    try {
      skipped = localStorage.getItem('illuminator.skipVersion') === latest;
    } catch {
      // No storage: ask every time.
    }
    const os = thisOs();
    const arch = window.lytroNative.arch || '';
    const files = (release.assets || [])
      .map((a) => ({ a, b: BUILDS.find((b) => b.re.test(a.name)) }))
      // Only this computer's platform and this app's architecture (all of them
      // when they cannot be told: an app built before the architecture was passed on).
      .filter((x) => x.b && (!os || x.b.os === os) && (!arch || x.b.arch === arch));
    if (!files.length) {
      if (manual) showNotice(`Illuminator ${latest} is available`, 'No download for this computer is attached to the release yet. Try again later.');
      return;
    }
    $('update-title').textContent = `Illuminator ${latest} is available`;
    $('update-note').replaceChildren(
      `A new release is available (current: ${VERSION} | available: ${latest}).`,
      document.createElement('br'),
      'Download and install for the latest features.',
    );
    // The release's short "What's new" list (core/releasenotes.js), shown above the downloads.
    const news = releaseHighlights(release.body);
    $('update-news').replaceChildren(...news.map(({ lead, text }) => {
      const li = document.createElement('li');
      if (lead) li.append(Object.assign(document.createElement('strong'), { textContent: lead }), ' ');
      li.append(text);
      return li;
    }));
    $('update-news-head').hidden = $('update-news').hidden = !news.length;
    $('update-links').replaceChildren(...files.map(({ a, b }) => {
      const li = document.createElement('li');
      if (b.os === os) li.className = 'mine';
      const name = Object.assign(document.createElement('span'), { className: 'name', textContent: b.name });
      const detail = Object.assign(document.createElement('span'), { className: 'size', textContent: `${b.arch} · ${b.detail}` });
      const spacer = Object.assign(document.createElement('span'), { className: 'spacer' });
      li.append(name, detail);
      const button = Object.assign(document.createElement('a'), { className: 'download-btn', href: a.browser_download_url, target: '_blank', rel: 'noopener', textContent: `Download (${Math.round(a.size / 1e6)} MB)` });
      li.append(spacer, button);
      return li;
    }));
    $('update-skip').checked = false;
    $('update-dialog').onclose = () => {
      try {
        if ($('update-skip').checked) localStorage.setItem('illuminator.skipVersion', latest);
      } catch {
        // Ignore: the reminder comes back next time.
      }
    };
    const open = () => {
      $('update-skip').checked = false;
      if (!$('update-dialog').open) $('update-dialog').showModal();
    };
    $('update-btn').textContent = `Update available! ${latest}`;
    $('update-btn').onclick = open;
    $('update-btn').hidden = false;
    if (!skipped || manual) open();
  }
  setTimeout(checkForUpdate, 3000);
  // A long session hears about a release too.
  setInterval(checkForUpdate, 6 * 3600 * 1000);
  const checkNow = () => checkForUpdate(true); // Help > Check for Updates
  return { checkNow };
}
