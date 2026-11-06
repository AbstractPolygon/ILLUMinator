// color matrix: moved out of main.js. initColorMatrix() runs where the section used to, with what it uses from the rest of the page.
export function initColorMatrix({ $, state, applySettings, applySettingsSoon }) {
  // Camera: the matrix in the photo's metadata; None: camera RGB as is;
  // Custom: editable, starting from the camera's.
  function showColorMatrix() {
    $('ccm-grid').hidden = $('ccm-mode').value !== 'custom';
  }

  $('ccm-mode').onchange = () => {
    if ($('ccm-mode').value === 'custom') {
      const cam = state.info && state.info.cam && state.info.cam.ccm;
      const m = cam || [1, 0, 0, 0, 1, 0, 0, 0, 1];
      m.forEach((v, i) => { $(`ccm-${i}`).value = +v.toFixed(3); });
    }
    showColorMatrix();
    applySettings();
  };
  for (let i = 0; i < 9; i++) $(`ccm-${i}`).addEventListener('input', () => applySettingsSoon());
  return { showColorMatrix };
}
