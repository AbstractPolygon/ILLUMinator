// tone curve: moved out of main.js. initToneCurve() runs where the section used to, with what it uses from the rest of the page.
import { CURVE_REGIONS } from '../settingsmap.js';
import { curveEditor } from './curve-editor.js';
import { parsePoints, formatPoints } from '../core/curve.js';

export function initToneCurve({ $, applySettingsSoon, scheduleSave, showSliderValue }) {
  function curveRegions() {
    return CURVE_REGIONS.map((k) => $(`curve-${k}`).value / 100);
  }

  const curve = curveEditor($('curve-canvas'), {
    getPoints: () => parsePoints($('curve-points').value),
    getRegions: curveRegions,
    setPoints: (pts, final) => {
      $('curve-points').value = formatPoints(pts);
      applySettingsSoon();
      if (final) scheduleSave();
    },
  });
  for (const k of CURVE_REGIONS) $(`curve-${k}`).addEventListener('input', () => curve.draw());
  $('curve-reset').onclick = () => {
    $('curve-points').value = '0,0;1,1';
    for (const k of CURVE_REGIONS) {
      $(`curve-${k}`).value = 0;
      showSliderValue($(`curve-${k}`));
    }
    curve.draw();
    applySettingsSoon();
    scheduleSave();
  };
  return { curve };
}
