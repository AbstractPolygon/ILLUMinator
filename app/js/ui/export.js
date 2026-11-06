// export: moved out of main.js. initExport() runs where the section used to, with what it uses from the rest of the page.
import { methodModel, readModel } from '../core/upscalemodels.js';
import { upscaleImage, upscaleBits16 } from '../gpu/upscale.js';
import { invert, isIdentity, geometry } from '../core/geometry.js';
import { download } from '../platform.js';
import { fitsMemory, exportRam, memoryProblem } from '../core/memorybudget.js';
import { aiUpscale, denoiseRgb16 } from '../core/aiupscale.js';
import { encodePng16 } from '../core/png16.js';
import { VIDEO_FORMATS, videoType, VIDEO_CODECS, videoFrame, chooseVideoType, videoBitrate } from '../core/video-format.js';
import { toImageData } from '../engine.js';

export function initExport({ state, $, canvas, ctx, layoutCanvas, showsCamera, stereoShown, showNotice, engine, cameraParams, showProgress, hideProgress, modelUpscaleParams, finishModelEnlargement, showError, showSliderValue, scheduleSave, draw, cropValues, animationRequest, eyeOffset, eyeParams, ensureAnimation, drawGeometry, stereoTag }) {
  function baseName() {
    return state.current ? state.current.name.replace(/\.[^.]+$/, '') : 'lytro';
  }

  // Saved photos and 3D images are enlarged by Render Settings > Photo >
  // Size, and video frames to Video > Size, both with Upscaling.
  function upscaleSettings() {
    // (an upscaling model works when a photo is saved; the picture on show, videos and 3D images use Lanczos)
    const method = $('upscale-method').value;
    if (!method || methodModel(method)) {
      // (the picture on show, videos and 3D images use the Lanczos settings, whatever the model's)
      const p = readParams('upscale-params').lanczos || {};
      return { method: 'lanczos', sharpen: (p.sharpen ?? 25) / 100, lobes: p.lobes ?? 3 };
    }
    return { method, sharpen: +$('upscale-sharpen').value / 100, lobes: +$('upscale-lobes').value };
  }

  // The scale a picture of w x h is shown at: the Photo Size for a picture, the Video Size (when it is a height, as 1080p) for an animation frame. At most 4096 px wide.
  function shownScale(w, h) {
    let k = 1;
    if (state.showingFrames) {
      const v = $('video-size').value;
      if (/^\d+$/.test(v)) k = +v / Math.min(w, h);
    } else {
      k = +$('photo-size').value || 1;
    }
    return Math.max(1, Math.min(k, 4096 / Math.max(w, 1)));
  }

  // A picture is shown enlarged with the Upscaling settings, exactly as it will be saved (the picture already on the canvas, through crop and rotation, is
  // enlarged; clicks map back through the same scale). Save then writes the canvas as it is.
  function showAtPhotoSize(k = +$('photo-size').value || 1) {
    if (!(k > 1) || state.enlarged) return;
    const big = upscaleImage(canvas, Math.round(canvas.width * k), Math.round(canvas.height * k), upscaleSettings());
    canvas.width = big.width;
    canvas.height = big.height;
    ctx.drawImage(big, 0, 0);
    layoutCanvas();
    if (state.geom) state.geom = { ...state.geom, inverse: invert(state.geom.matrix.map((v) => v * k)) };
    state.enlarged = true;
  }

  function enlargeForSave(source) {
    if (source === canvas && state.enlarged) return source;
    const k = +$('photo-size').value || 1;
    if (k === 1) return source;
    return upscaleImage(source, Math.round(source.width * k), Math.round(source.height * k), upscaleSettings());
  }

  // Photo > File format: PNG, or JPEG at its quality.
  function savePhoto(source, name) {
    const model = methodModel($('upscale-method').value);
    const k = +$('photo-size').value || 1;
    // 16-bit PNG, and enlarging with an upscaling model, start from the picture made again at 16 bits (below).
    if ((($('photo-format').value === 'png16') || (model && k > 1)) && source === canvas && showsCamera() && !stereoShown() && state.info) {
      savePhotoRendered(name, model, k);
      return;
    }
    saveAs8Bit(source, name);
  }

  function saveAs8Bit(source, name) {
    const jpeg = $('photo-format').value === 'jpeg';
    const type = jpeg ? 'image/jpeg' : 'image/png';
    enlargeForSave(source).toBlob((blob) => download(blob, `${name}.${jpeg ? 'jpg' : 'png'}`), type, jpeg ? +$('photo-quality').value / 100 : undefined);
  }

  // The picture on show made again by the graphics card with the high and low byte of every value kept (worker finishGpu, bits16): the source of a 16-bit PNG, which then has the
  // fine tonal steps the 8-bit canvas drops, and of an enlargement by an upscaling model, which takes the full precision in. Enlarged by the Photo Size at 16 bits too
  // (the model, then the graphics card's Lanczos to the exact size; or the Upscaling method). Without the graphics card, or for a view that is not the picture (stereo, depth,
  // lenslets), the usual 8-bit picture is saved and a notice says so.
  async function savePhotoRendered(name, model, k) {
    const format = $('photo-format').value;
    const eightBit = (why) => {
      showNotice(format === 'png16' ? 'Saved at 8 bits per channel' : 'Saved without the upscaling model', why);
      saveAs8Bit(canvas, name);
    };
    try {
      const passes = +$('still-passes').value;
      let msg;
      if (state.fullRes && state.still) {
        const { promise } = engine.job('superRes', 'superres', { ...(state.stillFrame || cameraParams()), scale: +$('still-scale').value, passes, bits16: true }, { onProgress: showProgress });
        msg = await promise;
      } else if (passes > 0 && state.info.hasRaw) {
        const { promise } = engine.job('superRes', 'superres', { ...cameraParams(), scale: +$('detail').value, passes, label: 'Processing', bits16: true }, { onProgress: showProgress });
        msg = await promise;
      } else {
        msg = await engine.request('view', { ...cameraParams(), final: true, bits16: true }, { onProgress: showProgress });
      }
      hideProgress();
      if (!msg || !msg.pixels16) {
        eightBit('The picture needs the graphics card (and its noise reduction) to be made at 16 bits; this one was made without it.');
        return;
      }
      let rgb = new Uint16Array(msg.pixels16);
      let width = msg.width;
      let height = msg.height;
      const W = Math.round(width * k);
      const H = Math.round(height * k);
      // the memory limit (Settings > Memory): the 16-bit picture, its enlarged copy and the PNG's rows
      if (!fitsMemory('ram', exportRam(width, height, k))) {
        showNotice('Not saved', memoryProblem('ram', exportRam(width, height, k), `Saving ${W}×${H} at 16 bits`, 'Lower the Photo Size or raise the limit.'));
        return;
      }
      if (k !== 1) {
        let big = null;
        if (model) {
          try {
            const P = modelUpscaleParams();
            const grown = await aiUpscale(model, () => readModel(model), denoiseRgb16(rgb, width, height, P.denoise), width, height, showProgress);
            hideProgress();
            big = grown;
            // to the exact Photo Size (the model makes 4 times; fewer needs a reduction)
            if (grown.width !== W) {
              const sized = upscaleBits16(grown.rgb, grown.width, grown.height, W, H, { method: 'lanczos', sharpen: 0 });
              big = sized ? { rgb: sized, width: W, height: H } : grown;
            }
            big = finishModelEnlargement(big, rgb, width, height, P);
          } catch (err) {
            hideProgress();
            showNotice('Could not enlarge with the model', `${err && err.message ? err.message : err} The picture is enlarged with Lanczos instead.`);
          }
        }
        if (!big) {
          const plain = upscaleBits16(rgb, width, height, W, H, upscaleSettings());
          if (plain) big = { rgb: plain, width: W, height: H };
          else showNotice('Saved at the picture\'s size', `The graphics card cannot enlarge a 16-bit picture to ${W}×${H}; it is saved at ${width}×${height}.`);
        }
        if (big) ({ rgb, width, height } = big);
      }
      if (format === 'png16') {
        const png = await encodePng16(rgb, width, height);
        await download(new Blob([png], { type: 'image/png' }), `${name}.png`);
        return;
      }
      // 8-bit file from the 16-bit values
      const jpeg = format === 'jpeg';
      const data = new ImageData(width, height);
      for (let i = 0, j = 0; i < rgb.length; i += 3, j += 4) {
        data.data[j] = (rgb[i] + 128) >> 8;
        data.data[j + 1] = (rgb[i + 1] + 128) >> 8;
        data.data[j + 2] = (rgb[i + 2] + 128) >> 8;
        data.data[j + 3] = 255;
      }
      const c = new OffscreenCanvas(width, height);
      c.getContext('2d').putImageData(data, 0, 0);
      const blob = await c.convertToBlob(jpeg ? { type: 'image/jpeg', quality: +$('photo-quality').value / 100 } : { type: 'image/png' });
      await download(blob, `${name}.${jpeg ? 'jpg' : 'png'}`);
    } catch (err) {
      hideProgress();
      showError(err);
    }
  }

  function showPhotoFormat() {
    const format = $('photo-format').value;
    const jpeg = format === 'jpeg';
    $('photo-quality-row').hidden = !jpeg;
    $('png-btn').textContent = jpeg ? 'Save JPEG' : format === 'png16' ? 'Save 16-bit PNG' : 'Save PNG';
  }
  $('photo-format').addEventListener('change', showPhotoFormat);
  $('photo-quality').oninput = () => showSliderValue($('photo-quality'));
  $('photo-quality').ondblclick = () => {
    $('photo-quality').value = $('photo-quality').dataset.default;
    showSliderValue($('photo-quality'));
    scheduleSave();
  };

  function savePng() {
    try {
      savePhoto(canvas, baseName());
    } catch (err) {
      showError(err);
    }
  }
  // Video: the compression kinds of the chosen file format, those this
  // browser cannot record marked and disabled.
  const canRecord = (t) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t);
  function showVideoCodecs() {
    for (const o of $('video-format').options) {
      const ok = VIDEO_FORMATS[o.value].codecs.some((c) => videoType(o.value, c, canRecord));
      o.disabled = !ok;
      o.textContent = VIDEO_FORMATS[o.value].name + (ok ? '' : ' (not available here)');
    }
    if ($('video-format').selectedOptions[0].disabled) {
      const usable = [...$('video-format').options].find((o) => !o.disabled);
      if (usable) $('video-format').value = usable.value;
    }
    const format = $('video-format').value;
    const select = $('video-codec');
    const fits = VIDEO_FORMATS[format].codecs;
    for (const o of select.options) {
      const ok = fits.includes(o.value) && !!videoType(format, o.value, canRecord);
      o.hidden = !fits.includes(o.value);
      o.disabled = !ok;
      o.textContent = VIDEO_CODECS[o.value].name + (fits.includes(o.value) && !ok ? ' (not available here)' : '');
    }
    const current = select.selectedOptions[0];
    if (!current || current.hidden || current.disabled) {
      const first = fits.find((c) => videoType(format, c, canRecord)) || fits[0];
      select.value = first;
    }
  }
  $('video-format').addEventListener('change', showVideoCodecs);
  showVideoCodecs();
  $('video-quality').oninput = () => showSliderValue($('video-quality'));
  $('video-quality').ondblclick = () => {
    $('video-quality').value = $('video-quality').dataset.default;
    showSliderValue($('video-quality'));
    scheduleSave();
  };
  // Each upscaling method keeps its own settings (Sharpen, Lobes, Model strength, Clean up first, Grain): the sliders show the chosen method's, and every method's are kept
  // together in the hidden `upscale-params` (saved with the photo).
  const UPSCALE_SLIDERS = { sharpen: 'upscale-sharpen', lobes: 'upscale-lobes', strength: 'upscale-strength', denoise: 'upscale-denoise', grain: 'upscale-grain' };
  function readParams(id) {
    try {
      const p = JSON.parse($(id).value || '{}');
      return p && typeof p === 'object' ? p : {};
    } catch {
      return {};
    }
  }
  function rememberUpscale() {
    const all = readParams('upscale-params');
    all[state.upscaleShown ?? $('upscale-method').value] = Object.fromEntries(Object.entries(UPSCALE_SLIDERS).map(([k, id]) => [k, +$(id).value]));
    $('upscale-params').value = JSON.stringify(all);
  }
  for (const id of Object.values(UPSCALE_SLIDERS)) {
    $(id).oninput = () => {
      showSliderValue($(id));
      rememberUpscale();
    };
    $(id).ondblclick = () => {
      $(id).value = $(id).dataset.default;
      showSliderValue($(id));
      rememberUpscale();
      scheduleSave();
    };
  }
  // The controls of the chosen method: Sharpen for all (FSR 1's is its RCAS sharpness), Lobes for Lanczos, and for a downloaded model Model strength, Clean up first and Grain.
  // `loaded`: the settings were just read from a photo's saved edits, so the sliders already hold the chosen method's values.
  function showUpscaleControls(loaded = false) {
    const method = $('upscale-method').value;
    const model = !!methodModel(method);
    if (state.upscaleShown !== method) {
      const saved = readParams('upscale-params')[method];
      if (!loaded || saved) {
        for (const [k, id] of Object.entries(UPSCALE_SLIDERS)) {
          $(id).value = saved && saved[k] !== undefined ? saved[k] : $(id).dataset.default;
          showSliderValue($(id));
        }
      }
      state.upscaleShown = method;
    }
    $('upscale-lobes-row').hidden = method !== 'lanczos';
    for (const id of ['upscale-strength-row', 'upscale-denoise-row', 'upscale-grain-row']) $(id).hidden = !model;
    $('upscale-sharpen-label').textContent = method === 'fsr' ? 'Sharpness (RCAS)' : 'Sharpen';
  }
  $('upscale-method').addEventListener('change', () => {
    rememberUpscale(); // the old method's settings, still in the sliders
    showUpscaleControls();
    scheduleSave();
  });
  // The picture shown follows the Photo Size, Video Size and Upscaling settings.
  for (const id of ['photo-size', 'video-size', 'upscale-method', 'upscale-sharpen']) {
    $(id).addEventListener('change', () => { if (state.lastImage && !state.lastImage.pair && !state.depthShown) draw(state.lastImage); });
  }

  // The crop, rotation and this frame's pivot, pan and zoom, for frame i of
  // the animation (an image w x h), or null when there is nothing to apply.
  function frameGeometry(i, w, h) {
    const s = {
      ...((state.framePivots && state.framePivots[i]) || null),
      orientation: +$('orientation').value || 1,
      angle: +$('straighten').value,
      crop: cropValues(),
    };
    return isIdentity(s) ? null : geometry(w, h, s);
  }

  // Each frame of the animation rendered at full resolution (Rendering >
  // Full resolution: Scale and Detail recovery), with that frame's camera and
  // local adjustment settings. Kept as JPEGs: a hundred full resolution
  // frames would not fit in memory as pixels.
  // Every animation frame's render settings.
  function frameList() {
    const req = animationRequest();
    const a = req.args;
    return req.type === 'frames'
      ? a.path.map((f) => ({ u: f.u, v: f.v, alpha: f.alpha ?? a.alpha, aperture: f.aperture ?? a.aperture, dof: f.dof ?? a.dof, bokeh: f.bokeh ?? a.bokeh, masks: f.masks || null, color: f.color || null }))
      : a.alphas.map((alpha) => ({ u: a.u, v: a.v, alpha, aperture: a.aperture, dof: a.dof, bokeh: a.bokeh }));
  }

  // 3D video: each frame for both eyes (Show 3D's Baseline), as
  // [{ left, right }] of images (full sensor: JPEG blobs, as fullResFrames).
  async function stereoEyes(n, full) {
    const b = eyeOffset();
    const list = frameList().slice(0, n).flatMap((f) => [eyeParams(f, f.u - b), eyeParams(f, f.u + b)]);
    let shots;
    if (full) {
      shots = await fullResFrames(list.length, list);
    } else {
      shots = new Array(list.length);
      const { promise } = engine.job('frames', 'frames', { path: list }, {
        onProgress: () => {},
        onFrame: async (msg) => {
          shots[msg.index] = msg.bitmap || (await createImageBitmap(toImageData(msg)));
          showProgress('Rendering 3D frames', shots.filter(Boolean).length / list.length);
        },
      });
      await promise;
      if (shots.some((x) => !x)) throw new Error('3D rendering was stopped');
    }
    return Array.from({ length: list.length / 2 }, (_, i) => ({ left: shots[2 * i], right: shots[2 * i + 1] }));
  }

  async function fullResFrames(n, list = frameList()) {
    const scale = +$('still-scale').value;
    const passes = +$('still-passes').value;
    const count = Math.min(n, list.length);
    const render = (i) => engine.job('superRes', 'superres', { ...list[i], scale, passes }, {
      onProgress: (_, p) => showProgress(`Rendering frame ${i + 1} of ${n} from the full sensor`, (i + (p || 0)) / n),
    }).promise;
    const encode = async (msg) => {
      if (!msg || !(msg.pixels || msg.bitmap)) throw new Error('Full sensor rendering was stopped');
      const img = toImageData(msg);
      const c = new OffscreenCanvas(img.width, img.height);
      const g = c.getContext('2d');
      if (img instanceof ImageData) g.putImageData(img, 0, 0);
      else g.drawImage(img, 0, 0);
      return { blob: await c.convertToBlob({ type: 'image/jpeg', quality: 0.95 }), width: img.width, height: img.height };
    };
    // The worker renders the next frame while this one is encoded.
    const out = [];
    let next = count ? render(0) : null;
    for (let i = 0; i < count; i++) {
      const msg = await next;
      next = i + 1 < count ? render(i + 1) : null;
      out.push(await encode(msg));
    }
    return out;
  }

  async function exportVideo() {
    $('webm-btn').disabled = true;
    try {
      await ensureAnimation();
      const frames = state.frames.filter(Boolean);
      if (frames.length < 2) return;
      const order = state.loop === 'pingpong'
        ? [...frames.keys(), ...[...frames.keys()].reverse().slice(1, -1)]
        : [...frames.keys(), ...frames.keys()];
      // Full resolution on: every frame rendered again from the whole sensor.
      const fullOn = !!(state.fullResMode && state.info && state.info.hasRaw);
      // Show 3D on: both eyes of every frame, combined in the 3D type.
      const stereo = stereoShown() ? await stereoEyes(frames.length, fullOn) : null;
      const mode = $('stereo-mode').value;
      const full = fullOn && !stereo ? await fullResFrames(frames.length) : null;
      const size = stereo ? stereo[0].left : full ? full[0] : frames[0];
      const g0 = frameGeometry(0, size.width, size.height);
      const eyeW = g0 ? g0.width : size.width;
      const w = stereo && mode !== 'anaglyph' ? 2 * eyeW : eyeW;
      const h = g0 ? g0.height : size.height;
      // Sized to the chosen Video size: a height (the short side, as in
      // 1080p) keeps the picture's shape; a social media size takes the
      // largest centered part with its shape. Even pixels for the encoder.
      const frame = videoFrame($('video-size').value, w, h);
      const c = document.createElement('canvas');
      c.width = frame.width;
      c.height = frame.height;
      const cctx = c.getContext('2d');
      cctx.imageSmoothingQuality = 'high';
      // Each frame is drawn at its own size, cut to the video's shape, then
      // enlarged (or reduced) by the upscaler.
      const native = Object.assign(document.createElement('canvas'), { width: Math.round(w), height: Math.round(h) });
      const nctx = native.getContext('2d');
      const cut = frame.crop;
      const whole = cut.x === 0 && cut.y === 0 && cut.w === w && cut.h === h;
      const part = whole ? native : Object.assign(document.createElement('canvas'), { width: Math.max(1, Math.round(cut.w)), height: Math.max(1, Math.round(cut.h)) });
      const opts = upscaleSettings();
      const stream = c.captureStream(state.fps);
      const pick = chooseVideoType($('video-format').value, $('video-codec').value, canRecord);
      if (!pick) throw new Error('This browser cannot record video.');
      const mime = pick.type;
      if (pick.fallback) showNotice(`Recording as ${VIDEO_FORMATS[pick.format].name} ${VIDEO_CODECS[pick.codec].name}: this browser cannot record the chosen kind.`);
      const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: videoBitrate($('video-quality').value) });
      const chunks = [];
      recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      const done = new Promise((r) => { recorder.onstop = r; });
      // Frames go out on the frame rate's beat, however long one takes to
      // prepare (a full resolution frame is decoded first).
      const t0 = performance.now();
      recorder.start();
      const eye = stereo ? Object.assign(document.createElement('canvas'), { width: Math.round(eyeW), height: Math.round(h) }) : null;
      const eyeCtx = eye ? eye.getContext('2d', { willReadFrequently: mode === 'anaglyph' }) : null;
      const decode = async (x) => (x && x.blob ? createImageBitmap(x.blob) : x);
      for (let n = 0; n < order.length; n++) {
        const i = order[n];
        let img = null;
        if (stereo) {
          // Each eye through the frame's crop and rotation, then side by side
          // (right eye first for cross-eyed) or as an anaglyph (red from the
          // left eye, green and blue from the right).
          const eyes = [await decode(stereo[i].left), await decode(stereo[i].right)];
          const drawn = eyes.map((img) => {
            const g = frameGeometry(i, img.width, img.height);
            eyeCtx.clearRect(0, 0, eye.width, eye.height);
            if (g) drawGeometry(eyeCtx, img, g, eye.width / g.width);
            else eyeCtx.drawImage(img, 0, 0, eye.width, eye.height);
            if (fullOn) img.close();
            return eyeCtx.getImageData(0, 0, eye.width, eye.height);
          });
          const [L, R] = drawn;
          if (mode === 'anaglyph') {
            for (let k = 0; k < L.data.length; k += 4) R.data[k] = 0.299 * L.data[k] + 0.587 * L.data[k + 1] + 0.114 * L.data[k + 2];
            nctx.putImageData(R, 0, 0);
          } else {
            const [first, second] = mode === 'cross' ? [R, L] : [L, R];
            nctx.putImageData(first, 0, 0);
            nctx.putImageData(second, eye.width, 0);
          }
        } else {
          img = full ? await createImageBitmap(full[i].blob) : frames[i];
          const g = frameGeometry(i, img.width, img.height);
          if (g) drawGeometry(nctx, img, g, native.width / g.width);
          else nctx.drawImage(img, 0, 0, native.width, native.height);
        }
        if (!whole) part.getContext('2d').drawImage(native, cut.x, cut.y, cut.w, cut.h, 0, 0, part.width, part.height);
        const big = upscaleImage(part, c.width, c.height, opts);
        const wait = t0 + (n * 1000) / state.fps - performance.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        cctx.drawImage(big, 0, 0);
        if (full && img) img.close();
        showProgress('Recording video', n / order.length);
      }
      await new Promise((r) => setTimeout(r, 1000 / state.fps));
      recorder.stop();
      await done;
      const ext = VIDEO_FORMATS[pick.format].ext;
      download(new Blob(chunks, { type: mime }), `${baseName()}-${$('anim').value}${stereo ? stereoTag(mode) : ''}.${ext}`);
    } catch (err) {
      showError(err);
    } finally {
      hideProgress();
      $('webm-btn').disabled = false;
    }
  }
  return { baseName, shownScale, showAtPhotoSize, savePhoto, showPhotoFormat, savePng, showVideoCodecs, readParams, showUpscaleControls, frameList, exportVideo };
}
