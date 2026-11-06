// local adjustments: moved out of main.js. initLocalAdjustments() runs where the section used to, with what it uses from the rest of the page.
import { parseMasks, MAX_MASKS, defaultMask } from '../core/local.js';

export function initLocalAdjustments({ getAnim, $, applySettingsSoon, scheduleSave, state, clearSelection, saveAnimation, renderTimeline, showMenu, confirmInMenu, editName, canRender, showSliderValue, updateKeyButtons, autoKey }) {
  // Masks (core/local.js) kept as JSON in a hidden field, so they are saved
  // with the photo's edits like every other control. The editor shows the
  // selected mask.
  const MASK_NAMES = { radial: 'Radial', linear: 'Gradient', depth: 'Depth' };
  const SHAPE_SLIDERS = {
    radial: { x: ['mr-x', 100], y: ['mr-y', 100], w: ['mr-w', 100], h: ['mr-h', 100], feather: ['mr-feather', 100] },
    linear: { x: ['ml-x', 100], y: ['ml-y', 100], angle: ['ml-angle', 1], width: ['ml-width', 100] },
    depth: { near: ['md-near', 100], far: ['md-far', 100], feather: ['md-feather', 100] },
  };
  const FX_SLIDERS = { exposure: 'mx-exposure', contrast: 'mx-contrast', saturation: 'mx-saturation', temperature: 'mx-temperature', tint: 'mx-tint', blur: 'mx-blur', pixelate: 'mx-pixelate', sketch: 'mx-sketch' };

  function getMasks() {
    return parseMasks($('local-masks').value);
  }

  function setMasks(masks, { final = true } = {}) {
    $('local-masks').value = JSON.stringify(masks);
    applySettingsSoon();
    if (final) scheduleSave();
  }

  // A mask's name: the one given to it (or its living filter's), else its
  // kind and number.
  function maskLabel(m, i) {
    if (m.name) return m.name;
    const same = getMasks().slice(0, i + 1).filter((x) => x.kind === m.kind).length;
    return `${MASK_NAMES[m.kind]} ${same}`;
  }

  const PENCIL_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" d="M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4"/></svg>';
  const TRASH_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>';

  function deleteMask(i) {
    const list = getMasks();
    if (!list[i]) return;
    // Its animation goes with it.
    const prefix = `mask:${list[i].id}:`;
    let keyed = false;
    for (const k of Object.keys(getAnim().tracks)) {
      if (!k.startsWith(prefix)) continue;
      keyed = keyed || getAnim().tracks[k].length > 0;
      delete getAnim().tracks[k];
    }
    list.splice(i, 1);
    if (state.maskSel >= i) state.maskSel = Math.max(list.length ? 0 : -1, state.maskSel - 1);
    if (!list.length) $('mask-show').checked = false;
    setMasks(list);
    renderMasks();
    clearSelection();
    if (keyed) saveAnimation();
    else renderTimeline();
  }

  // Asks before deleting mask i, in a small menu by `anchor`.
  function askDeleteMask(i, anchor) {
    const m = getMasks()[i];
    if (!m) return;
    showMenu(anchor, []);
    confirmInMenu(`Delete ${maskLabel(m, i)}? Its effect is removed from the photo.`, 'Delete', () => deleteMask(i));
  }

  function renderMasks() {
    const masks = getMasks();
    if (state.maskSel >= masks.length) state.maskSel = masks.length - 1;
    $('mask-list').replaceChildren(...masks.map((m, i) => {
      const li = document.createElement('li');
      li.className = i === state.maskSel ? 'current' : '';
      if (!m.on) li.classList.add('off');
      const name = Object.assign(document.createElement('button'), { type: 'button', className: 'mask-name', textContent: maskLabel(m, i) });
      name.onclick = () => {
        state.maskSel = i;
        renderMasks();
        applySettingsSoon();
      };
      name.title = 'Double-click to rename';
      const rename = () => editName(li, maskLabel(m, i), (text) => {
        if (text) {
          const list = getMasks();
          if (list[i]) list[i].name = text;
          setMasks(list);
        }
        renderMasks();
        renderTimeline();
      }, 'Mask name');
      name.ondblclick = rename;
      const edit = Object.assign(document.createElement('button'), { type: 'button', className: 'icon-only mask-rename', title: 'Rename' });
      edit.innerHTML = PENCIL_ICON;
      edit.setAttribute('aria-label', `Rename ${maskLabel(m, i)}`);
      edit.onclick = (e) => {
        e.stopPropagation();
        rename();
      };
      const del = Object.assign(document.createElement('button'), { type: 'button', className: 'icon-only mask-del', title: 'Delete mask' });
      del.innerHTML = TRASH_ICON;
      del.setAttribute('aria-label', `Delete ${maskLabel(m, i)}`);
      del.onclick = (e) => {
        e.stopPropagation();
        askDeleteMask(i, del);
      };
      li.append(name, edit, del);
      return li;
    }));
    // Masks belong to a photo: none can be added until one is open.
    for (const kind of Object.keys(MASK_NAMES)) $(`mask-add-${kind}`).disabled = masks.length >= MAX_MASKS || !canRender();
    $('mask-filter').disabled = masks.length >= MAX_MASKS || !canRender();
    const m = masks[state.maskSel];
    $('mask-editor').hidden = !m;
    if (!m) {
      $('mask-show').checked = false;
      return;
    }
    for (const kind of Object.keys(SHAPE_SLIDERS)) $(`mask-shape-${kind}`).hidden = kind !== m.kind;
    for (const [key, [id, k]] of Object.entries(SHAPE_SLIDERS[m.kind])) $(id).value = Math.round(m[key] * k);
    for (const [key, id] of Object.entries(FX_SLIDERS)) $(id).value = Math.round(m.fx[key] * 100);
    $('mask-on').checked = m.on;
    // Disabled: only Enabled (and Delete) show.
    $('mask-editor').classList.toggle('off', !m.on);
    $('mask-invert').checked = m.invert;
    $('mx-strength').value = Math.round((m.strength ?? 1) * 100);
    $('mask-follow').checked = !!m.follow;
    for (const input of document.querySelectorAll('.local-panel input[type=range]')) showSliderValue(input);
    updateKeyButtons();
  }

  // Editor controls -> the selected mask.
  function maskFromEditor(final) {
    const masks = getMasks();
    const m = masks[state.maskSel];
    if (!m) return;
    for (const [key, [id, k]] of Object.entries(SHAPE_SLIDERS[m.kind])) m[key] = +$(id).value / k;
    for (const [key, id] of Object.entries(FX_SLIDERS)) m.fx[key] = +$(id).value / 100;
    // Turned off: its keyframes leave the editor, so nothing hidden stays selected.
    if (m.on && !$('mask-on').checked) clearSelection();
    m.on = $('mask-on').checked;
    if (!m.on && $('mask-show').checked) $('mask-show').checked = false;
    m.invert = $('mask-invert').checked;
    m.strength = +$('mx-strength').value / 100;
    // Following the focus from where it is now.
    const follow = $('mask-follow').checked;
    if (follow && !m.follow) m.anchor = +$('focus').value;
    m.follow = follow;
    setMasks(masks, { final });
    if (final) {
      renderMasks();
      autoKey();
      renderTimeline();
    }
  }

  for (const kind of Object.keys(MASK_NAMES)) {
    $(`mask-add-${kind}`).onclick = () => {
      const masks = getMasks();
      if (masks.length >= MAX_MASKS || !canRender()) return;
      masks.push(defaultMask(kind));
      state.maskSel = masks.length - 1;
      $('mask-show').checked = true;
      setMasks(masks);
      renderMasks();
    };
  }

  for (const input of document.querySelectorAll('.local-panel input[type=range]')) {
    input.addEventListener('input', () => {
      showSliderValue(input);
      maskFromEditor(false);
    });
    input.addEventListener('change', () => maskFromEditor(true));
    input.addEventListener('dblclick', () => {
      input.value = input.dataset.default;
      showSliderValue(input);
      maskFromEditor(true);
    });
  }
  for (const id of ['mask-on', 'mask-invert', 'mask-follow']) $(id).addEventListener('change', () => maskFromEditor(true));
  $('mask-show').addEventListener('change', () => applySettingsSoon());
  $('mask-delete').onclick = () => askDeleteMask(state.maskSel, $('mask-delete'));

  renderMasks();

  function localSettings() {
    return { masks: $('local-masks').value, show: $('mask-show').checked ? state.maskSel : -1 };
  }
  return { getMasks, setMasks, maskLabel, TRASH_ICON, renderMasks, localSettings };
}
