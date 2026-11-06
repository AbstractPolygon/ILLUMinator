// 3D: moved out of main.js. initStereo() runs where the section used to, with what it uses from the rest of the page.
import { toImageData } from '../engine.js';
import { geometry } from '../core/geometry.js';
import { showInVr, vrSupported } from '../vr.js';

export function initStereo({ $, state, engine, showProgress, backToCamera, setFullRes, refresh, cameraParams, withPivotZoom, pivotFor, cropValues, drawGeometry, canRender, savePhoto, baseName, showError, hideProgress, showSliderValue }) {
  // Show 3D: the live picture in the chosen 3D type.
  function stereoShown() {
    return $('stereo-on').checked && !!(state.info && state.info.hasRaw);
  }

  function eyeOffset() {
    return (state.info.radius || 4.5) * (+$('stereo-baseline').value / 100);
  }

  // One eye's render settings. At a wide aperture every view would use the
  // whole lens and both eyes would match, so each eye looks through its own
  // smaller part of the aperture.
  function eyeParams(p, u) {
    return { ...p, u, aperture: Math.min(p.aperture || 1, 0.5) };
  }

  // The live 3D picture in the chosen 3D type: an anaglyph, or both eyes
  // side by side (drawn by drawPair).
  async function stereoPreview(p) {
    const b = eyeOffset();
    const imgs = [];
    for (const u of [p.u - b, p.u + b]) {
      const msg = await engine.request('view', eyeParams(p, u), { onProgress: showProgress });
      if (!msg || !(msg.pixels || msg.bitmap)) return null;
      imgs.push(toImageData(msg));
    }
    const [L, R] = imgs.map((img) => {
      if (img instanceof ImageData) return img;
      const c = Object.assign(document.createElement('canvas'), { width: img.width, height: img.height });
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0);
      return g.getImageData(0, 0, img.width, img.height);
    });
    const mode = $('stereo-mode').value;
    if (mode !== 'anaglyph') return { pair: [L, R], mode, width: L.width, height: L.height };
    const out = new ImageData(new Uint8ClampedArray(R.data), R.width, R.height);
    for (let i = 0; i < out.data.length; i += 4) out.data[i] = 0.299 * L.data[i] + 0.587 * L.data[i + 1] + 0.114 * L.data[i + 2];
    return out;
  }

  $('stereo-on').onchange = () => {
    if (state.showingFrames) backToCamera();
    setFullRes(false, { restore: false });
    refresh();
  };
  $('stereo-mode').addEventListener('change', () => {
    if (stereoShown()) refresh();
  });
  $('stereo-baseline').addEventListener('input', () => {
    if (stereoShown()) refresh();
  });

  // A stereo pair from two viewpoints across the lens aperture: anaglyph
  // (red / cyan glasses), side by side (parallel viewing) or cross-eyed.
  // Crop, rotation and the pivot apply to both eyes alike.
  // Both eyes of the current picture as canvases [left, right], each through
  // the crop and rotation (and the pivot, for its own viewpoint).
  async function stereoPair() {
    const p = cameraParams();
    const b = eyeOffset();
    const eyes = [p.u - b, p.u + b];
    const shots = [];
    for (const u of eyes) {
      showProgress('Rendering 3D', shots.length / 2);
      const msg = await engine.request('view', eyeParams(p, u), { onProgress: () => {} });
      shots.push(toImageData(msg));
    }
    const pivots = withPivotZoom(eyes.map((u) => pivotFor(u, p.v, p.alpha, eyeParams(p, u).aperture)));
    const base = { orientation: +$('orientation').value || 1, angle: +$('straighten').value, crop: cropValues() };
    return shots.map((img, i) => {
      const g = geometry(img.width, img.height, { ...base, ...(pivots[i] || {}) });
      const c = Object.assign(document.createElement('canvas'), { width: g.width, height: g.height });
      drawGeometry(c.getContext('2d'), img, g);
      return c;
    });
  }

  // File name tag for a 3D type: VR players recognize side by side files by
  // "_3D_SBS" in the name.
  function stereoTag(mode) {
    return mode === 'vr' ? '_3D_SBS' : `-3d-${mode}`;
  }

  // A stereo pair from two viewpoints across the lens aperture: anaglyph
  // (red / cyan glasses), side by side (parallel viewing or a VR headset) or
  // cross-eyed. Crop, rotation and the pivot apply to both eyes alike.
  async function saveStereo() {
    if (!canRender() || !state.info.hasRaw) return;
    $('stereo-btn').disabled = true;
    try {
      const [L, R] = await stereoPair();
      const mode = $('stereo-mode').value;
      let out;
      if (mode === 'anaglyph') {
        // Red from the left eye, green and blue from the right.
        out = Object.assign(document.createElement('canvas'), { width: L.width, height: L.height });
        const o = out.getContext('2d');
        const l = L.getContext('2d').getImageData(0, 0, L.width, L.height);
        const r = R.getContext('2d').getImageData(0, 0, R.width, R.height);
        for (let i = 0; i < l.data.length; i += 4) {
          r.data[i] = 0.299 * l.data[i] + 0.587 * l.data[i + 1] + 0.114 * l.data[i + 2];
        }
        o.putImageData(r, 0, 0);
      } else {
        const [first, second] = mode === 'cross' ? [R, L] : [L, R];
        out = Object.assign(document.createElement('canvas'), { width: L.width * 2, height: L.height });
        const o = out.getContext('2d');
        o.drawImage(first, 0, 0);
        o.drawImage(second, L.width, 0);
      }
      savePhoto(out, `${baseName()}${stereoTag(mode)}`);
    } catch (err) {
      showError(err);
    } finally {
      hideProgress();
      $('stereo-btn').disabled = !canRender();
      refresh();
    }
  }

  // View in VR (browsers with WebXR, such as the Meta Quest Browser): the 3D
  // picture on a large screen in front of you, each eye seeing its own view.
  async function viewInVr() {
    if (!canRender() || !state.info.hasRaw) return;
    try {
      const [L, R] = await stereoPair();
      hideProgress();
      await showInVr(L, R);
    } catch (err) {
      hideProgress();
      showError(err);
    }
  }
  $('vr-btn').onclick = viewInVr;
  vrSupported().then((ok) => {
    $('vr-btn').hidden = !ok;
  });
  $('stereo-btn').onclick = saveStereo;
  $('stereo-baseline').oninput = () => showSliderValue($('stereo-baseline'));
  return { stereoShown, eyeOffset, eyeParams, stereoPreview, stereoTag };
}
