// LUT: moved out of main.js. initLut() runs where the section used to, with what it uses from the rest of the page.
import { decodeLut, encodeLut, parseCube } from '../core/lut.js';

export function initLut({ $, engine, showProgress, hideProgress, canRender, showNotice, startNoticeTimer, showError, scheduleSave, applySettingsSoon, TRASH_ICON, showSliderValue }) {
  // Process > LUT: a .cube color lookup table, kept with the photo's edits
  // (core/lut.js) and applied as the last step of the look.
  let lutSent = null;

  function showLut() {
    let saved = null;
    try {
      saved = $('lut-data').value ? JSON.parse($('lut-data').value) : null;
    } catch {
      saved = null;
    }
    // The dropdown shows the LUT in use: a film look by name, an imported
    // one as such, or None.
    const film = saved && saved.film && filmLuts.index ? filmLuts.index.luts.findIndex((l) => l.name === saved.name) : -1;
    const imported = $('lut-film').querySelector('option[value="imported"]');
    imported.hidden = !(saved && film < 0);
    imported.textContent = saved ? `Imported: ${saved.name}` : '';
    $('lut-film').value = film >= 0 ? String(film) : saved ? 'imported' : '';
    $('lut-name').textContent = saved ? saved.name : 'None';
    $('lut-name').title = saved ? `${saved.name} (${saved.size}×${saved.size}×${saved.size})` : '';
    $('lut-remove').hidden = !saved;
    $('lut-amount').disabled = !saved;
    return saved;
  }

  // The worker gets the LUT only when it changes: it is large.
  async function sendLut() {
    const text = $('lut-data').value;
    if (text === lutSent) return;
    lutSent = text;
    const saved = showLut();
    await engine.request('setLut', { lut: saved ? decodeLut(saved) : null });
  }

  // Film looks bundled with the app (app/luts, built by
  // scripts/build-film-luts.mjs): the list loads at start, the LUTs themselves
  // (one file) the first time one is chosen.
  const filmLuts = { index: null, data: null };

  async function loadFilmIndex() {
    try {
      const res = await fetch('luts/film-luts.json');
      if (!res.ok) return;
      filmLuts.index = await res.json();
    } catch {
      return;
    }
    const groups = filmLuts.index.categories.map((cat) => {
      const group = Object.assign(document.createElement('optgroup'), { label: cat });
      filmLuts.index.luts.forEach((l, i) => {
        if (l.category === cat) group.append(Object.assign(document.createElement('option'), { value: String(i), textContent: l.name }));
      });
      return group;
    });
    $('lut-film').append(...groups);
    showLut();
  }

  async function filmLut(i) {
    const entry = filmLuts.index.luts[i];
    if (!filmLuts.data) {
      showProgress('Loading film looks', 0);
      try {
        filmLuts.data = await (await fetch('luts/film-luts.bin')).arrayBuffer();
      } finally {
        hideProgress();
      }
    }
    const n = entry.size ** 3 * 3;
    const q = new Uint16Array(filmLuts.data, entry.offset, n);
    const data = new Float32Array(n);
    for (let k = 0; k < n; k++) data[k] = q[k] / 65535;
    return { title: entry.name, size: entry.size, min: [0, 0, 0], max: [1, 1, 1], data };
  }

  $('lut-film').onchange = async () => {
    const i = $('lut-film').value;
    if (i === 'imported') return;
    if (i === '') {
      $('lut-remove').click();
      return;
    }
    if (!filmLuts.index) return;
    if (!canRender()) {
      showLut();
      showNotice('Open a photo first: a LUT is kept with the photo.');
      startNoticeTimer();
      return;
    }
    try {
      const lut = await filmLut(+i);
      $('lut-data').value = JSON.stringify({ ...encodeLut(lut, lut.title), film: true });
    } catch (err) {
      showError(err);
      showLut();
      return;
    }
    showLut();
    scheduleSave();
    applySettingsSoon();
  };
  loadFilmIndex();

  $('lut-remove').innerHTML = TRASH_ICON;
  $('lut-import').onclick = () => {
    if (!canRender()) {
      showNotice('Open a photo first: a LUT is kept with the photo.');
      startNoticeTimer();
      return;
    }
    $('lut-file').click();
  };
  $('lut-file').onchange = async () => {
    const file = $('lut-file').files[0];
    $('lut-file').value = '';
    if (!file) return;
    try {
      const lut = parseCube(await file.text());
      $('lut-data').value = JSON.stringify(encodeLut(lut, file.name.replace(/\.cube$/i, '')));
    } catch (err) {
      showNotice(`Could not use ${file.name}: ${err.message}`);
      startNoticeTimer();
      return;
    }
    showLut();
    scheduleSave();
    applySettingsSoon();
  };
  $('lut-remove').onclick = () => {
    $('lut-data').value = '';
    showLut();
    scheduleSave();
    applySettingsSoon();
  };
  $('lut-amount').addEventListener('input', () => {
    showSliderValue($('lut-amount'));
    applySettingsSoon();
  });
  $('lut-amount').addEventListener('change', () => scheduleSave());
  showLut();
  return { sendLut };
}
