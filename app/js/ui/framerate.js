// frame rate: moved out of main.js. initFrameRate() runs where the section used to, with what it uses from the rest of the page.
import { FPS as DEFAULT_FPS } from '../core/keyframes.js';

export function initFrameRate({ $, state, getKeyFps, setKeyFps, scheduleSave, animationSettingsChanged, showAnimationLength, renderTimeline, updateFrameLabel }) {
  const FPS_PRESETS = ['23.976', '24', '25', '29.97', '30', '48', '50', '59.94', '60'];

  // Shows the frame rate setting (#fps) in the preset list, or as custom.
  function showFrameRate() {
    const fps = Math.min(240, Math.max(1, +$('fps').value || DEFAULT_FPS));
    const preset = FPS_PRESETS.find((p) => Math.abs(+p - fps) < 1e-3);
    if (!state.customFps || !preset) $('fps-preset').value = preset || 'custom';
    $('fps-custom').hidden = $('fps-preset').value !== 'custom';
    setKeyFps(fps);
    state.fps = fps;
  }

  function setFrameRate(fps) {
    // A viewpoint path or focus sweep keeps its length in seconds.
    const seconds = +$('frames').value / getKeyFps();
    $('fps').value = String(+(+fps).toFixed(3));
    showFrameRate();
    $('frames').value = Math.max(2, Math.round(seconds * getKeyFps()));
    scheduleSave();
    animationSettingsChanged();
    showAnimationLength();
    renderTimeline();
    updateFrameLabel();
  }

  $('fps-preset').onchange = () => {
    const v = $('fps-preset').value;
    state.customFps = v === 'custom';
    if (state.customFps) {
      $('fps-custom').hidden = false;
      $('fps').focus();
      return;
    }
    setFrameRate(+v);
  };
  $('fps').onchange = () => setFrameRate(Math.min(240, Math.max(1, +$('fps').value || DEFAULT_FPS)));
  return { showFrameRate };
}
