// The tone curve's graph: shows the combined curve (points and region
// sliders) and lets the user add, drag and remove points.
//
// curveEditor(canvas, { getPoints, getRegions, setPoints(points, final) })

import { CURVE_SIZE, curveTable, parsePoints } from '../core/curve.js';

const HIT = 9; // px
const GAP = 0.01; // closest two points may come (fraction of the range)

export function curveEditor(canvas, { getPoints, getRegions, setPoints }) {
  const c2d = canvas.getContext('2d');
  let drag = null;

  function size() {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    if (canvas.width !== w || canvas.height !== w) {
      canvas.width = w;
      canvas.height = w;
    }
    return w;
  }

  const css = (name, fallback) => getComputedStyle(canvas).getPropertyValue(name).trim() || fallback;

  function draw() {
    const n = size();
    const pad = Math.round(n * 0.04);
    const s = n - 2 * pad;
    const X = (x) => pad + x * s;
    const Y = (y) => pad + (1 - y) * s;
    c2d.clearRect(0, 0, n, n);
    c2d.fillStyle = css('--curve-bg', '#0f1114');
    c2d.fillRect(pad, pad, s, s);
    c2d.strokeStyle = css('--line', '#2a2e35');
    c2d.lineWidth = 1;
    c2d.beginPath();
    for (let i = 1; i < 4; i++) {
      c2d.moveTo(X(i / 4), Y(0));
      c2d.lineTo(X(i / 4), Y(1));
      c2d.moveTo(X(0), Y(i / 4));
      c2d.lineTo(X(1), Y(i / 4));
    }
    c2d.moveTo(X(0), Y(0));
    c2d.lineTo(X(1), Y(1));
    c2d.stroke();
    const table = curveTable({ points: getPoints(), regions: getRegions() });
    c2d.strokeStyle = css('--text', '#e6e6e6');
    c2d.lineWidth = Math.max(1.5, n / 160);
    c2d.beginPath();
    for (let i = 0; i < CURVE_SIZE; i++) {
      const x = i / (CURVE_SIZE - 1);
      const y = table ? table[i] : x;
      if (i) c2d.lineTo(X(x), Y(y));
      else c2d.moveTo(X(x), Y(y));
    }
    c2d.stroke();
    const r = Math.max(3.5, n / 60);
    for (const [i, [x, y]] of getPoints().entries()) {
      c2d.beginPath();
      c2d.arc(X(x), Y(y), r, 0, 2 * Math.PI);
      c2d.fillStyle = drag && drag.index === i ? css('--accent', '#fff') : css('--text', '#e6e6e6');
      c2d.fill();
      c2d.strokeStyle = '#000';
      c2d.lineWidth = 1;
      c2d.stroke();
    }
    return { pad, s };
  }

  function toCurve(e) {
    const rect = canvas.getBoundingClientRect();
    const pad = rect.width * 0.04;
    const s = rect.width - 2 * pad;
    return [
      Math.min(1, Math.max(0, (e.clientX - rect.left - pad) / s)),
      Math.min(1, Math.max(0, 1 - (e.clientY - rect.top - pad) / s)),
      s,
    ];
  }

  function nearest(pts, x, y, s) {
    let best = -1;
    let bestD = HIT;
    pts.forEach(([px, py], i) => {
      const d = Math.hypot((px - x) * s, (py - y) * s);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || canvas.closest('[disabled]')) return;
    const pts = getPoints().map((p) => [...p]);
    const [x, y, s] = toCurve(e);
    let index = nearest(pts, x, y, s);
    if (index < 0) {
      // A new point on the click, between its neighbours.
      if (pts.some(([px]) => Math.abs(px - x) < GAP)) return;
      pts.push([x, y]);
      pts.sort((a, b) => a[0] - b[0]);
      index = pts.findIndex((p) => p[0] === x);
      setPoints(pts, false);
    }
    drag = { index };
    canvas.setPointerCapture(e.pointerId);
    draw();
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const pts = getPoints().map((p) => [...p]);
    const [x, y] = toCurve(e);
    const i = drag.index;
    const last = pts.length - 1;
    // End points keep their place on the edges; the others stay between
    // their neighbours.
    const nx = i === 0 ? 0 : i === last ? 1 : Math.min(pts[i + 1][0] - GAP, Math.max(pts[i - 1][0] + GAP, x));
    pts[i] = [nx, y];
    setPoints(pts, false);
    draw();
  });

  const end = () => {
    if (!drag) return;
    drag = null;
    setPoints(getPoints(), true);
    draw();
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);

  canvas.addEventListener('dblclick', (e) => {
    const pts = getPoints().map((p) => [...p]);
    const [x, y, s] = toCurve(e);
    const i = nearest(pts, x, y, s);
    if (i > 0 && i < pts.length - 1) {
      pts.splice(i, 1);
      setPoints(pts, true);
      draw();
    }
  });

  // Redrawn when the panel opens or the sidebar resizes.
  new ResizeObserver(() => draw()).observe(canvas);
  return { draw, parse: parsePoints };
}
