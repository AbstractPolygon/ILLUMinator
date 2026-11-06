// number fields: moved out of main.js. initNumberFields() runs where the section used to, with what it uses from the rest of the page.
export function initNumberFields() {
  // Number fields get plain up/down arrows in place of the browser's spinner
  // (which draws a box behind them).
  const CHEVRON = (d) => `<svg viewBox="0 0 10 6" width="10" height="6" aria-hidden="true"><path d="${d}" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  function addSteppers(input) {
    const wrap = Object.assign(document.createElement('span'), { className: 'num' });
    input.replaceWith(wrap);
    const arrows = Object.assign(document.createElement('span'), { className: 'num-arrows' });
    for (const [dir, d, label] of [[1, 'M1 5l4-4 4 4', 'Increase'], [-1, 'M1 1l4 4 4-4', 'Decrease']]) {
      const b = Object.assign(document.createElement('button'), { type: 'button', tabIndex: -1, innerHTML: CHEVRON(d) });
      b.setAttribute('aria-label', label);
      b.onclick = () => {
        if (input.disabled) return;
        if (dir > 0) input.stepUp();
        else input.stepDown();
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      };
      arrows.append(b);
    }
    wrap.append(input, arrows);
  }
  for (const input of document.querySelectorAll('input[type=number]')) addSteppers(input);
}
