// white balance eyedropper: moved out of main.js. initWhiteBalancePicker() runs where the section used to, with what it uses from the rest of the page.
export function initWhiteBalancePicker({ state, canRender, $, canvas, viewPoint, engine, showSliderValue, applySettings, scheduleSave, showError }) {
  // Click the eyedropper, then something in the photo that should be neutral:
  // the worker finds the temperature and tint that make it so.
  function setPicking(on) {
    state.picking = on && canRender() && state.mode === 'camera';
    $('wb-pick').setAttribute('aria-pressed', String(state.picking));
    canvas.classList.toggle('picking', state.picking);
  }

  async function pickWhiteBalance(event) {
    const [x, y] = viewPoint(event);
    setPicking(false);
    try {
      const res = await engine.request('whiteBalanceAt', { x, y });
      if (!res || !res.kelvin) return;
      $('awb').checked = false;
      $('wb-temperature').value = res.kelvin;
      $('wb-tint').value = res.tint;
      showSliderValue($('wb-temperature'));
      showSliderValue($('wb-tint'));
      await applySettings();
      scheduleSave();
    } catch (err) {
      showError(err);
    }
  }

  $('wb-pick').onclick = () => setPicking(!state.picking);
  return { setPicking, pickWhiteBalance };
}
