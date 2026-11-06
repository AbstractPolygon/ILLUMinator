// living filters: moved out of main.js. initLivingFilters() runs where the section used to, with what it uses from the rest of the page.
import { defaultMask, MAX_MASKS } from '../core/local.js';

export function initLivingFilters({ $, state, canRender, getMasks, showNotice, startNoticeTimer, setMasks, renderMasks, renderTimeline }) {
  // Looks built from masks around the current focus; once added they are
  // ordinary masks to adjust.
  function livingFilter(name) {
    const f = +$('focus').value;
    const fx = (o) => ({ exposure: 0, contrast: 0, saturation: 0, temperature: 0, tint: 0, blur: 0, pixelate: 0, sketch: 0, ...o });
    // Depth filters follow the focus: animate it and they move with it.
    const depth = (near, far, feather, invert, effect) => ({ ...defaultMask('depth'), near, far, feather, invert, follow: true, anchor: f, fx: fx(effect) });
    switch (name) {
      case 'pop': // in focus keeps its color, the rest goes gray
        return [depth(f - 0.25, f + 0.25, 0.2, true, { saturation: -1 })];
      case 'spotlight': // darker away from the focus point
        return [{ ...defaultMask('radial'), x: state.focusPoint.x, y: state.focusPoint.y, w: 0.35, h: 0.35, feather: 0.7, invert: true, fx: fx({ exposure: -1.2 }) }];
      case 'haze': // farther away is paler and softer, like air
        return [depth(f + 0.2, 1.8, 0.6, false, { exposure: 0.35, contrast: -0.5, saturation: -0.45, temperature: -0.15 })];
      case 'dreamy': // what is not in focus glows a little
        return [depth(f - 0.2, f + 0.2, 0.25, true, { exposure: 0.4, contrast: -0.4, saturation: -0.2, temperature: 0.15 })];
      case 'noir': // hard black and white, the subject lit a little brighter
        return [
          { ...defaultMask('depth'), near: -3, far: 3, feather: 0.2, fx: fx({ saturation: -1, contrast: 0.55, exposure: -0.15 }) },
          depth(f - 0.2, f + 0.2, 0.2, false, { exposure: 0.35 }),
        ];
      case 'melancholy': // everything but the subject goes muted and blue
        return [depth(f - 0.25, f + 0.25, 0.25, true, { saturation: -0.6, temperature: -0.5, exposure: -0.2, contrast: -0.15 })];
      case 'carnival': // the background turns bright and festive
        return [depth(f - 0.2, f + 0.2, 0.2, true, { saturation: 0.85, temperature: 0.25, tint: 0.2, contrast: 0.2 })];
      case 'pinhole': // a deep vignette that shifts with the viewpoint
        return [{ ...defaultMask('radial'), x: 0.5, y: 0.5, w: 0.48, h: 0.48, feather: 0.85, invert: true, followView: true, fx: fx({ exposure: -1.8, saturation: -0.25 }) }];
      case 'blurplus': // what is out of focus goes softer still
        return [depth(f - 0.15, f + 0.15, 0.25, true, { blur: 0.6 })];
      case 'mosaic': // what is out of focus breaks into tiles
        return [depth(f - 0.15, f + 0.15, 0.15, true, { pixelate: 0.5 })];
      case 'crayon': // what is out of focus turns into a colored-pencil drawing
        return [depth(f - 0.15, f + 0.15, 0.2, true, { sketch: 0.9 })];
      case 'golden': // warm, glowing light on the far background
        return [depth(f + 0.15, 1.8, 0.5, false, { temperature: 0.6, exposure: 0.2, saturation: 0.2, contrast: -0.15 })];
      default:
        return [];
    }
  }

  $('mask-filter').onchange = () => {
    const added = livingFilter($('mask-filter').value);
    // Named after the filter (its group in the keyframe editor, too).
    const name = ($('mask-filter').selectedOptions[0] || {}).textContent || '';
    for (const m of added) m.name = name.trim();
    $('mask-filter').value = '';
    if (!added.length || !canRender()) return;
    const masks = getMasks();
    const room = MAX_MASKS - masks.length;
    if (room < added.length) {
      showNotice(`Up to ${MAX_MASKS} masks: delete one to add this filter.`);
      startNoticeTimer();
      return;
    }
    masks.push(...added);
    state.maskSel = masks.length - 1;
    setMasks(masks);
    renderMasks();
    renderTimeline();
  };
  return { livingFilter };
}
