// keyframes: moved out of main.js. initKeyframes() runs where the section used to, with what it uses from the rest of the page.
import { setKey, isSettingTrack, isMaskTrack, emptyAnimation, parseAnimation, valueAt, PRESETS, cubicBezier, frameCount, hasKeys, sample } from '../core/keyframes.js';

export function initKeyframes({ $, getMasks, maskLabel, state, canRender, F_STOPS, scheduleSave, invalidateAnimation, backToCamera, renderCamera, showSliderValue, setMasks, renderMasks, showFNumber, showFocusPoint, applySettingsSoon, cameraChanged, layoutCanvas, drawCurves, setPlaying, showFrame, updateFrameLabel, plotBox, animationSettingsChanged, draw, apertureFor, view, bokehParams, colorSettings }) {
  // Keyframed animation (core/keyframes.js): a track per property on the
  // timeline under the picture. Each track's diamonds are its keyframes: drag
  // to move, click to select (and show), Delete to remove; the selected one
  // sets the curve to the next. Framing (zoom and pan) is applied when the
  // picture is drawn, like the pivot.
  const TRACK_NAMES = {
    aperture: 'Aperture', depth: 'Depth of field', focus: 'Focus', view: 'Viewpoint', zoom: 'Zoom', panX: 'Pan X', panY: 'Pan Y', pivot: 'Pivot depth',
    pointX: 'Focus point X', pointY: 'Focus point Y', spread: 'Spread', spreadSmooth: 'Smoothing', spreadBlur: 'Blur', tilt: 'Tilt', tiltRotation: 'Rotation', highlights: 'Highlights',
    amount: 'Amount', near: 'Near', far: 'Far',
  };

  // The camera's tracks by section of the Camera panel (and the Animation
  // panel's framing), each a group of its own under Camera.
  const CAMERA_SECTIONS = [
    { id: 'cam-depth', name: 'Depth', tracks: ['aperture', 'depth', 'focus'] },
    { id: 'cam-spread', name: 'Focus Spread', tracks: ['pointX', 'pointY', 'spread', 'spreadSmooth', 'spreadBlur'] },
    // Tilt and Pivot depth show (and count) only while they are on.
    { id: 'cam-tilt', name: 'Tilt', tracks: ['tilt', 'tiltRotation'], when: () => $('tilt-on').checked },
    { id: 'cam-perspective', name: 'Perspective', tracks: ['view', 'pivot'] },
    { id: 'cam-bokeh', name: 'Bokeh', tracks: ['highlights'] },
  ];

  // The Animation panel's tracks, by what is animated: Framing with
  // keyframes, Amount with the viewpoint path, Near and Far with the focus
  // sweep.
  const ANIMATION_SECTIONS = [
    { id: 'anim-framing', name: 'Framing', tracks: ['zoom', 'panX', 'panY'], mode: 'keyframes' },
    { id: 'anim-viewpoint', name: 'Viewpoint path', tracks: ['amount'], mode: 'viewpoint' },
    { id: 'anim-focus', name: 'Focus sweep', tracks: ['near', 'far'], mode: 'focus' },
  ];
  // The Animate setting each Animation panel track works with (the others
  // work with Keyframes).
  const TRACK_MODE = { amount: 'viewpoint', near: 'focus', far: 'focus' };

  // Every setting of a local adjustment (living filters included) has a
  // track too: 'mask:<id>:<attr>'.
  const MASK_FX = ['exposure', 'contrast', 'saturation', 'temperature', 'tint', 'blur', 'pixelate', 'sketch'];
  const MASK_SHAPE = { radial: ['x', 'y', 'w', 'h', 'feather'], linear: ['x', 'y', 'angle', 'width'], depth: ['near', 'far', 'feather'] };
  const MASK_ATTR_NAMES = {
    strength: 'Strength', exposure: 'Exposure', contrast: 'Contrast', saturation: 'Saturation', temperature: 'Temperature', tint: 'Tint', blur: 'Blur', pixelate: 'Pixelate', sketch: 'Sketch',
    x: 'Center X', y: 'Center Y', w: 'Width', h: 'Height', feather: 'Feather', angle: 'Angle', width: 'Width', near: 'Near', far: 'Far',
  };
  const MASK_LIMITS = { strength: [0, 1], blur: [0, 1], pixelate: [0, 1], sketch: [0, 1], exposure: [-2, 2], x: [0, 1], y: [0, 1], w: [0.01, 1], h: [0.01, 1], feather: [0, 1], angle: [-180, 180], width: [0.01, 1], near: [-1.6, 1.6], far: [-1.6, 1.6] };
  const maskAttrs = (m) => ['strength', ...MASK_SHAPE[m.kind], ...MASK_FX];

  function parseMaskTrack(k) {
    const [, id, attr] = k.split(':');
    return { id, attr };
  }

  function maskAttr(m, a) {
    if (MASK_FX.includes(a)) return m.fx[a];
    return a === 'strength' ? m.strength ?? 1 : m[a];
  }

  function setMaskAttr(m, a, v) {
    const [lo, hi] = MASK_LIMITS[a] || [-1, 1];
    v = Math.min(hi, Math.max(lo, v));
    if (MASK_FX.includes(a)) m.fx[a] = v;
    else m[a] = v;
  }

  // The tracks in groups: Camera (with a group for each of its sections,
  // `parent: 'camera'`; Camera itself has `sections` and no tracks of its
  // own to show), then one for each local adjustment, named after the living
  // filter that made it (or the mask).
  // Every group is a section (a sidebar panel: `sections`, with every track
  // of its subsections) or a subsection of one (`parent`). With `mode` (an
  // Animate setting, default the current one) only the groups that animate
  // in that mode: Camera, Local Adjustments and Framing with Keyframes; the
  // viewpoint path's or focus sweep's settings with those.
  function trackGroups(mode = $('anim').value) {
    const groups = [];
    const section = (id, name, subs) => {
      if (!subs.length) return;
      groups.push({ id, name, sections: true, tracks: subs.filter((g) => !g.off).flatMap((g) => g.tracks) }, ...subs.map((g) => ({ ...g, parent: id })));
    };
    // A setting's track shows (and counts) while its slider can be used.
    const settingSection = (panel) => section(panel.id, panel.name, panel.subs.map((sub) => ({
      id: sub.id, name: sub.name, tracks: sub.tracks.filter((k) => !settingControl(k).matches(':disabled')),
    })).filter((sub) => sub.tracks.length));
    const [processPanel, opticsPanel] = settingPanels();
    // In the sidebar's order.
    if (mode === 'keyframes') {
      settingSection(processPanel);
      // `off`: a disabled adjustment, whose keyframes the editor hides.
      section('local', 'Local Adjustments', getMasks().map((m, i) => ({ id: m.id, name: m.name || maskLabel(m, i), off: !m.on, tracks: maskAttrs(m).map((a) => `mask:${m.id}:${a}`) })));
      section('camera', 'Camera', CAMERA_SECTIONS
        .filter((sec) => !sec.when || sec.when())
        .map((sec) => ({ id: sec.id, name: sec.name, tracks: sec.tracks.filter((k) => k !== 'pivot' || $('pivot-on').checked) })));
      settingSection(opticsPanel);
    }
    section('animation', 'Animation', ANIMATION_SECTIONS.filter((sec) => sec.mode === mode).map((sec) => ({ id: sec.id, name: sec.name, tracks: sec.tracks })));
    for (const g of groups) for (const k of g.tracks) if (!state.anim.tracks[k]) state.anim.tracks[k] = [];
    return groups;
  }

  function tracks(mode) {
    return trackGroups(mode).filter((g) => !g.sections && !g.off).flatMap((g) => g.tracks);
  }

  // Keyframe buttons in the sidebar: a ◆ at the right of each setting that
  // can be animated. Lit while the setting has keyframes; clicking it starts
  // animating the setting (a keyframe at the playhead) or stops (removes its
  // keyframes). Filled when a keyframe sits at the playhead.
  const KEY_CONTROLS = {
    fstop: ['aperture'], 'dof-depth': ['depth'], 'focus-point': ['focus', 'pointX', 'pointY'],
    spread: ['spread'], 'spread-smooth': ['spreadSmooth'], 'spread-blur': ['spreadBlur'], tilt: ['tilt'], 'tilt-rotation': ['tiltRotation'],
    viewpoint: ['view'], pivot: ['pivot'], highlights: ['highlights'],
    'frame-zoom': ['zoom'], 'frame-pan-x': ['panX'], 'frame-pan-y': ['panY'],
    amount: ['amount'], near: ['near'], far: ['far'],
  };
  // Settings of the selected local adjustment: control id -> attribute.
  const KEY_MASK_CONTROLS = {
    'mx-strength': 'strength', 'mr-x': 'x', 'mr-y': 'y', 'mr-w': 'w', 'mr-h': 'h', 'mr-feather': 'feather',
    'ml-x': 'x', 'ml-y': 'y', 'ml-angle': 'angle', 'ml-width': 'width', 'md-near': 'near', 'md-far': 'far', 'md-feather': 'feather',
    ...Object.fromEntries(MASK_FX.map((a) => [`mx-${a}`, a])),
  };

  // The tracks behind a keyframe button (none while they are not shown).
  // The Animate setting a sidebar setting's keyframes work with.
  const keyButtonMode = (id) => (KEY_CONTROLS[id] && TRACK_MODE[KEY_CONTROLS[id][0]]) || 'keyframes';

  function keyButtonTracks(id) {
    const shown = new Set(tracks(keyButtonMode(id)));
    if (KEY_CONTROLS[id]) return KEY_CONTROLS[id].filter((k) => shown.has(k));
    const m = getMasks()[state.maskSel];
    const k = m && `mask:${m.id}:${KEY_MASK_CONTROLS[id]}`;
    return k && shown.has(k) ? [k] : [];
  }

  function setupKeyButtons() {
    // Thin chevrons, so the three take little room; the tip sits on the
    // diamond's middle row of pixels.
    const chevron = (dir) => `<svg viewBox="0 0 7 12" width="7" height="12" aria-hidden="true"><path d="${dir < 0 ? 'M5.5 2 1.5 6.5 5.5 11' : 'M1.5 2 5.5 6.5 1.5 11'}" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    for (const id of [...Object.keys(KEY_CONTROLS), ...Object.keys(KEY_MASK_CONTROLS)]) {
      const el = $(id);
      const label = el && el.closest('label');
      if (!label) continue;
      // ◀ ◆ ▶ as in DaVinci Resolve's Inspector: the arrows (shown while the
      // setting is animated) jump to its previous and next keyframe.
      const nav = Object.assign(document.createElement('span'), { className: 'key-nav' });
      nav.dataset.keyFor = id;
      nav.hidden = true;
      const prev = Object.assign(document.createElement('button'), { type: 'button', className: 'key-step', innerHTML: chevron(-1), title: 'Previous keyframe' });
      const b = Object.assign(document.createElement('button'), { type: 'button', className: 'key-toggle' });
      b.append(Object.assign(document.createElement('span'), { className: 'key-diamond' }));
      const next = Object.assign(document.createElement('button'), { type: 'button', className: 'key-step', innerHTML: chevron(1), title: 'Next keyframe' });
      // Not the label's control.
      nav.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
      };
      prev.onclick = () => stepKey(id, -1);
      next.onclick = () => stepKey(id, 1);
      b.onclick = () => {
        // (The diamonds show only while animation is enabled; the mode is switched here if needed.)
        const mode = keyButtonMode(id);
        if (!$('anim-on').checked || $('anim').value !== mode) {
          $('anim-on').checked = true;
          $('anim').value = mode;
          for (const c of ['anim-on', 'anim']) $(c).dispatchEvent(new Event('change'));
        }
        const ks = keyButtonTracks(id);
        if (!ks.length) return;
        if (ks.some((k) => state.anim.tracks[k].length)) {
          for (const k of ks) state.anim.tracks[k] = [];
          clearSelection();
        } else {
          const t = Math.round(playheadTime() * state.fps) / state.fps;
          tlSel.clear();
          for (const k of ks) {
            setKey(state.anim, k, t, currentValue(k), state.fps);
            selectAt(k, t, true);
          }
        }
        saveAnimation();
      };
      nav.append(prev, b, next);
      label.append(nav);
    }
  }
  // Process and Optics sliders can be keyframed too ('set:<id>' tracks), by
  // panel and section as the sidebar has them. Read from the sidebar once.
  const SETTING_PANELS = ['Process', 'Optics'];
  let settingPanelList = null;
  function settingPanels() {
    if (settingPanelList) return settingPanelList;
    settingPanelList = SETTING_PANELS.map((title) => {
      const panel = [...document.querySelectorAll('details.panel')].find((d) => {
        const h = d.querySelector(':scope > summary h2');
        return h && h.textContent.trim() === title;
      });
      const subs = panel ? [...panel.querySelectorAll(':scope > details.subpanel')].map((sub) => {
        const name = sub.querySelector(':scope > summary h3').textContent.trim();
        return {
          id: `set-${name.toLowerCase().replace(/[^a-z]+/g, '-')}`,
          name,
          tracks: [...sub.querySelectorAll('input[type=range]')].filter((el) => el.closest('label')).map((el) => `set:${el.id}`),
        };
      }).filter((sub) => sub.tracks.length) : [];
      return { id: title.toLowerCase(), name: title, subs };
    });
    return settingPanelList;
  }
  const settingControl = (k) => $(k.slice(4));
  // A setting track's name: its slider's label.
  function settingName(k) {
    const label = settingControl(k).closest('label');
    return label.firstChild.textContent.trim();
  }
  for (const panel of settingPanels()) for (const sub of panel.subs) for (const k of sub.tracks) KEY_CONTROLS[k.slice(4)] = [k];

  setupKeyButtons();

  // The keyframe times of a sidebar setting's tracks, in order.
  function keyTimes(id) {
    const times = new Set();
    for (const k of keyButtonTracks(id)) for (const key of state.anim.tracks[k]) times.add(Math.round(key.t * state.fps));
    return [...times].sort((a, b) => a - b).map((f) => f / state.fps);
  }

  // Moves the playhead to the setting's previous (dir -1) or next keyframe.
  function stepKey(id, dir) {
    const now = playheadTime();
    const eps = 0.5 / state.fps;
    const times = keyTimes(id);
    const t = dir < 0 ? times.filter((x) => x < now - eps).pop() : times.find((x) => x > now + eps);
    if (t !== undefined) seekTo(t);
  }

  function updateKeyButtons() {
    // Keyframe controls show only while Animation > Enabled is on.
    const on = canRender() && state.mode === 'camera' && $('anim-on').checked;
    const navs = document.querySelectorAll('.key-nav');
    if (!on) {
      for (const nav of navs) nav.hidden = true;
      showKeyedSections();
      return;
    }
    const now = playheadTime();
    const eps = 0.5 / state.fps;
    for (const nav of navs) {
      const id = nav.dataset.keyFor;
      const ks = keyButtonTracks(id);
      nav.hidden = !ks.length;
      if (!ks.length) continue;
      // Lit only while its keyframes are in use (animation on, in their mode).
      const animating = $('anim-on').checked && $('anim').value === keyButtonMode(id);
      const times = animating ? keyTimes(id) : [];
      const keyed = times.length > 0;
      const here = times.some((x) => Math.abs(x - now) < eps);
      const [prev, b, next] = nav.children;
      nav.classList.toggle('on', keyed);
      b.classList.toggle('on', keyed);
      b.classList.toggle('here', here);
      prev.disabled = !times.some((x) => x < now - eps);
      next.disabled = !times.some((x) => x > now + eps);
      const name = nav.closest('label').firstChild.textContent.trim().toLowerCase();
      b.title = keyed ? `Stop animating ${name} (removes its keyframes)` : `Animate ${name}: a keyframe at the playhead`;
    }
    showKeyedSections();
  }

  // Sections and subsections holding a keyframed setting are marked, so the
  // keyframes show while they are collapsed.
  function showKeyedSections() {
    for (const d of document.querySelectorAll('aside details.panel, aside details.subpanel')) {
      const keyed = !!d.querySelector('.key-nav.on:not([hidden])');
      d.classList.toggle('keyed', keyed);
      const s = d.querySelector(':scope > summary');
      if (s) s.title = keyed ? 'Has keyframed settings' : '';
    }
  }

  // Camera starts open, with the sections the keyframes began with (Depth,
  // Perspective, Framing); the others, and each adjustment's group, closed.
  const OPEN_AT_FIRST = new Set(['camera', 'cam-depth', 'cam-perspective', 'local', 'animation', 'anim-framing', 'anim-viewpoint', 'anim-focus']);
  const tlGroups = { closed: new Set(), opened: new Set() };
  const groupCollapsed = (id) => (OPEN_AT_FIRST.has(id) ? tlGroups.closed.has(id) : !tlGroups.opened.has(id));
  // Only keyed: the editor shows only the settings that have keyframes (and
  // the groups holding them). Remembered between sessions.
  function onlyKeyed() {
    return $('tl-only-keyed').checked;
  }
  try {
    $('tl-only-keyed').checked = localStorage.getItem('illuminator.tlOnlyKeyed') === '1';
  } catch {
    // Storage unavailable: start with every setting shown.
  }
  $('tl-only-keyed').onchange = () => {
    try {
      localStorage.setItem('illuminator.tlOnlyKeyed', onlyKeyed() ? '1' : '0');
    } catch {
      // Not remembered; it still applies now.
    }
    renderTimeline();
  };

  // A group's tracks as the editor shows them.
  function shownTracks(g) {
    return onlyKeyed() ? g.tracks.filter((k) => state.anim.tracks[k] && state.anim.tracks[k].length) : g.tracks;
  }

  // Closed itself or inside a closed group.
  const groupHidden = (g) => groupCollapsed(g.id) || (!!g.parent && groupCollapsed(g.parent));

  function toggleGroup(id) {
    const set = OPEN_AT_FIRST.has(id) ? tlGroups.closed : tlGroups.opened;
    if (set.has(id)) set.delete(id);
    else set.add(id);
    renderTimeline();
  }

  function trackName(k) {
    if (isSettingTrack(k)) return settingName(k);
    return isMaskTrack(k) ? MASK_ATTR_NAMES[parseMaskTrack(k).attr] || k : TRACK_NAMES[k];
  }

  // With the group's name, for tooltips.
  function trackTitle(k) {
    if (!isMaskTrack(k) && !isSettingTrack(k)) return TRACK_NAMES[k];
    const g = trackGroups().find((x) => !x.sections && x.tracks.includes(k));
    return `${g ? g.name : 'Mask'} ${trackName(k).toLowerCase()}`;
  }
  // Every selected keyframe (keySel's among them).
  const tlSel = new Set();
  // The Curves view of the keyframe editor (see drawCurves).
  const tlCurves = { on: false, hidden: new Set(), hits: [] };

  function keyframesOn() {
    return $('anim-on').checked && $('anim').value === 'keyframes';
  }

  // The keyframe editor shows with any animation: with Keyframes every
  // group, with a viewpoint path or focus sweep the settings of that.
  function keyEditorOn() {
    return $('anim-on').checked;
  }

  // The editor's length: the keyframed animation's, or the viewpoint path's
  // or focus sweep's (one frame per step, at the frame rate).
  function animLength() {
    const mode = $('anim').value;
    if (mode === 'viewpoint') return Math.max(1, +$('frames').value - 1) / state.fps;
    if (mode === 'focus') return Math.max(1, +$('steps').value - 1) / state.fps;
    return state.anim.length;
  }

  // Earlier versions kept a plain list of keyframes, evenly spaced.
  function loadAnimation() {
    let raw = null;
    try {
      raw = JSON.parse($('anim-keys').value || 'null');
    } catch {
      raw = null;
    }
    if (Array.isArray(raw) && raw.length) {
      state.anim = emptyAnimation();
      raw.forEach((k, i) => {
        const t = i * 2;
        setKey(state.anim, 'aperture', t, F_STOPS[k.fstop] ?? 2);
        setKey(state.anim, 'focus', t, k.focus || 0);
        setKey(state.anim, 'view', t, [k.u || 0, k.v || 0]);
        setKey(state.anim, 'zoom', t, k.zoom || 1);
        setKey(state.anim, 'panX', t, k.panX || 0);
        setKey(state.anim, 'panY', t, k.panY || 0);
      });
      state.anim.length = Math.max(1, (raw.length - 1) * 2);
    } else {
      state.anim = parseAnimation($('anim-keys').value);
    }
    clearSelection();
    showAnimationLength();
    renderTimeline();
  }

  function saveAnimation() {
    $('anim-keys').value = JSON.stringify(state.anim);
    scheduleSave();
    invalidateAnimation();
    if (state.showingFrames) {
      backToCamera();
      renderCamera();
    }
    renderTimeline();
  }

  // Zoom (1..3) and pan (-1..1 each way) -> a picture shift and zoom.
  function framing(zoom, panX, panY) {
    const room = (1 - 1 / zoom) / 2;
    return { shift: [-panX * room, -panY * room], zoom };
  }

  function liveFraming() {
    return framing(+$('frame-zoom').value / 100, +$('frame-pan-x').value / 100, +$('frame-pan-y').value / 100);
  }

  // Pivot and framing together.
  function combineMotion(a, b) {
    if (!a) return b;
    if (!b) return a;
    return { shift: [a.shift[0] + b.shift[0], a.shift[1] + b.shift[1]], zoom: a.zoom * b.zoom };
  }

  function currentValue(k) {
    if (isSettingTrack(k)) return +settingControl(k).value;
    if (isMaskTrack(k)) {
      const { id, attr } = parseMaskTrack(k);
      const m = getMasks().find((x) => x.id === id);
      return m ? maskAttr(m, attr) : 0;
    }
    switch (k) {
      case 'aperture': return F_STOPS[+$('fstop').value] ?? 2;
      case 'depth': return +$('dof-depth').value;
      case 'focus': return +$('focus').value;
      case 'view': return [state.camera.u, state.camera.v];
      case 'zoom': return +$('frame-zoom').value / 100;
      case 'panX': return +$('frame-pan-x').value / 100;
      case 'pivot': return +$('pivot').value;
      case 'pointX': return state.focusPoint.x;
      case 'pointY': return state.focusPoint.y;
      case 'spread': return +$('spread').value;
      case 'spreadSmooth': return +$('spread-smooth').value;
      case 'spreadBlur': return +$('spread-blur').value;
      case 'tilt': return +$('tilt').value;
      case 'tiltRotation': return +$('tilt-rotation').value;
      case 'highlights': return +$('highlights').value;
      case 'amount': return +$('amount').value;
      case 'near': return +$('near').value;
      case 'far': return +$('far').value;
      default: return +$('frame-pan-y').value / 100;
    }
  }

  // Camera tracks set straight from a slider.
  const TRACK_SLIDERS = { spread: 'spread', spreadSmooth: 'spread-smooth', spreadBlur: 'spread-blur', tilt: 'tilt', tiltRotation: 'tilt-rotation', highlights: 'highlights', amount: 'amount', near: 'near', far: 'far' };

  // Shows a keyframe's value in the controls (and the picture).
  // Sets the control behind track k to v.
  function applyValue(k, v) {
    if (isSettingTrack(k)) {
      const el = settingControl(k);
      el.value = v;
      showSliderValue(el);
      // Sent to the worker once the values are all set (see settingsShown).
      settingsDirty = true;
      return;
    }
    if (isMaskTrack(k)) {
      const { id, attr } = parseMaskTrack(k);
      const masks = getMasks();
      const m = masks.find((x) => x.id === id);
      if (!m) return;
      setMaskAttr(m, attr, v);
      setMasks(masks, { final: false });
      if (masks.indexOf(m) === state.maskSel) renderMasks();
      return;
    }
    if (k === 'aperture') {
      let best = 0;
      F_STOPS.forEach((n, i) => { if (Math.abs(Math.log(n / v)) < Math.abs(Math.log(F_STOPS[best] / v))) best = i; });
      $('fstop').value = best;
      showFNumber();
    } else if (k === 'depth') {
      $('dof-depth').value = Math.round(v);
      showSliderValue($('dof-depth'));
    } else if (k === 'focus') {
      $('focus').value = v;
    } else if (k === 'view') {
      state.camera = { u: v[0], v: v[1] };
    } else if (k === 'pivot') {
      $('pivot').value = Math.round(v);
      showSliderValue($('pivot'));
    } else if (k === 'pointX' || k === 'pointY') {
      state.focusPoint = { ...state.focusPoint, [k === 'pointX' ? 'x' : 'y']: Math.min(1, Math.max(0, v)) };
      showFocusPoint();
    } else if (TRACK_SLIDERS[k]) {
      const el = $(TRACK_SLIDERS[k]);
      // Whole numbers for sliders that step in them.
      el.value = +el.step >= 1 ? Math.round(v) : v;
      showSliderValue(el);
    } else if (k === 'zoom') {
      $('frame-zoom').value = Math.round(v * 100);
      showSliderValue($('frame-zoom'));
    } else {
      const id = k === 'panX' ? 'frame-pan-x' : 'frame-pan-y';
      $(id).value = Math.round(v * 100);
      showSliderValue($(id));
    }
  }

  // Process and Optics values shown from keyframes go to the worker in one go.
  let settingsDirty = false;
  function settingsShown() {
    if (!settingsDirty) return;
    settingsDirty = false;
    applySettingsSoon();
  }

  function showValue(k, v) {
    applyValue(k, v);
    settingsShown();
    // Showing a keyframe is not a change to record.
    autoKeyBase = currentValues();
    if (state.showingFrames) backToCamera();
    cameraChanged({ final: true });
  }

  // Shows the animation's settings at time t (no frames rendered yet).
  function previewAt(t) {
    let any = false;
    for (const k of tracks()) {
      const v = valueAt(state.anim, k, t);
      if (v === undefined) continue;
      applyValue(k, v);
      any = true;
    }
    autoKeyBase = currentValues();
    if (!any) return;
    settingsShown();
    if (state.showingFrames) backToCamera();
    cameraChanged({ final: false });
  }

  // Auto key: when on, a change to an animatable setting records a keyframe
  // at the playhead, on that setting's track only (settings left alone get
  // no keyframes).
  let autoKeyBase = null;

  function sameValue(k, a, b) {
    if (a === undefined || b === undefined) return a === b;
    if (Array.isArray(a)) return Math.abs(a[0] - b[0]) < 1e-4 && Math.abs(a[1] - b[1]) < 1e-4;
    return Math.abs(a - b) < (k === 'aperture' || k === 'depth' ? 1e-3 : 1e-4);
  }

  function currentValues() {
    return Object.fromEntries(tracks().map((k) => [k, currentValue(k)]));
  }

  function autoKey() {
    const now = currentValues();
    const base = autoKeyBase;
    autoKeyBase = now;
    if (!$('tl-autokey').checked || !keyEditorOn() || state.mode !== 'camera' || state.restoring) return;
    const t = Math.round(playheadTime() * state.fps) / state.fps;
    let added = false;
    for (const k of tracks()) {
      if (!base || base[k] === undefined || sameValue(k, base[k], now[k])) continue;
      setKey(state.anim, k, t, now[k], state.fps);
      selectAt(k, t, added);
      added = true;
    }
    if (added) saveAnimation();
  }
  $('tl-autokey').onchange = () => {
    autoKeyBase = currentValues();
  };

  function playheadTime() {
    if (state.showingFrames && state.frames.length > 1) return (state.drawFrame ?? state.index) / state.fps;
    return Math.min(animLength(), state.keyTime || 0);
  }

  function clearSelection() {
    tlSel.clear();
    state.keySel = null;
  }

  // Selects a keyframe (`add`: keeping the others selected).
  function selectKey(k, key, add = false) {
    if (!add) tlSel.clear();
    tlSel.add(key);
    state.keySel = { k, t: key.t };
  }

  function selectAt(k, t, add = false) {
    const key = state.anim.tracks[k].find((x) => Math.abs(x.t - t) < 1e-6);
    if (key) selectKey(k, key, add);
  }

  // The selected keyframes: [{ k, key }].
  function selectedKeys() {
    const out = [];
    for (const k of tracks()) for (const key of state.anim.tracks[k]) if (tlSel.has(key)) out.push({ k, key });
    return out;
  }

  const isSelected = (k, key) => tlSel.has(key) || (state.keySel && state.keySel.k === k && Math.abs(state.keySel.t - key.t) < 1e-6);

  // Moves the selected keyframes `items` ({ k, key, t0 }) by dt seconds,
  // all together: kept within the animation and clear of other keyframes.
  function moveKeys(items, dt) {
    const t0s = items.map((i) => i.t0);
    dt = Math.min(animLength() - Math.max(...t0s), Math.max(-Math.min(...t0s), dt));
    dt = Math.round(dt * state.fps) / state.fps;
    const moving = new Set(items.map((i) => i.key));
    const next = items.map((i) => Math.round((i.t0 + dt) * state.fps) / state.fps);
    const blocked = items.some((i, n) => state.anim.tracks[i.k].some((o) => !moving.has(o) && Math.abs(o.t - next[n]) < 0.5 / state.fps));
    if (blocked) return;
    items.forEach((i, n) => {
      i.key.t = next[n];
    });
    for (const k of new Set(items.map((i) => i.k))) state.anim.tracks[k].sort((a, b) => a.t - b.t);
  }

  function selectedKey() {
    if (!state.keySel) return null;
    return state.anim.tracks[state.keySel.k].find((key) => Math.abs(key.t - state.keySel.t) < 1e-6) || null;
  }

  const fmtTime = (t) => `${t.toFixed(2)} s`;

  // The part of the animation the timeline shows: from `start`, `span`
  // seconds wide (span 0: all of it).
  const tlView = { start: 0, span: 0 };

  function viewWindow() {
    const len = animLength();
    const span = tlView.span > 0 ? Math.min(len, tlView.span) : len;
    const start = Math.min(Math.max(0, tlView.start), len - span);
    tlView.start = start;
    return { start, span };
  }

  // Zooms the timeline by `factor` (> 1 zooms in) around time `at`.
  function zoomTimeline(factor, at) {
    const len = animLength();
    const { start, span } = viewWindow();
    const next = Math.min(len, Math.max(4 / state.fps, span / factor));
    const pivot = at ?? Math.min(start + span, Math.max(start, playheadTime()));
    tlView.span = next >= len ? 0 : next;
    tlView.start = pivot - ((pivot - start) / span) * next;
    renderTimeline();
  }

  // Tick spacing that gives at most about ten labels.
  function tickStep(span) {
    return [1 / state.fps, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30].find((s) => span / s <= 10) || 60;
  }

  // Moves the playhead without redrawing the timeline (while playing).
  function updatePlayhead() {
    if ($('timeline').hidden) return;
    const head = playheadTime();
    const { start, span } = viewWindow();
    for (const el of $('tl-grid').querySelectorAll('.tl-playhead')) {
      el.style.left = `${(100 * (head - start)) / span}%`;
      el.hidden = head < start - 1e-6 || head > start + span + 1e-6;
    }
    $('tl-time').textContent = `${fmtTime(head)} / ${fmtTime(animLength())}`;
    // The sidebar's arrows and diamonds follow the playhead.
    updateKeyButtons();
  }

  const CHEVRON_RIGHT = '<svg viewBox="0 0 10 10" width="9" height="9" aria-hidden="true"><path d="M3 1.5 6.5 5 3 8.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  // A group's heading: open / close it, key all its tracks, and a summary of
  // its keyframes (drag one to move every keyframe at that time).
  // A group's heading (chevron, ◆ to key the whole group, name), the same in
  // the Keyframes and Curves views.
  function groupHeading(grp) {
    const label = Object.assign(document.createElement('div'), { className: `tl-label tl-group${grp.parent ? ' tl-section' : ''}` });
    if (!groupCollapsed(grp.id)) label.classList.add('open');
    const toggle = Object.assign(document.createElement('button'), { type: 'button', className: 'tl-chevron', innerHTML: CHEVRON_RIGHT, title: groupCollapsed(grp.id) ? 'Show its tracks' : 'Hide its tracks' });
    toggle.setAttribute('aria-expanded', String(!groupCollapsed(grp.id)));
    toggle.onclick = () => toggleGroup(grp.id);
    const name = Object.assign(document.createElement('span'), { className: 'tl-group-name', textContent: grp.name });
    name.onclick = () => toggleGroup(grp.id);
    const add = Object.assign(document.createElement('button'), { type: 'button', textContent: '◆', title: `Keyframe every ${grp.name} setting at the playhead` });
    add.onclick = () => {
      const t = Math.round(playheadTime() * state.fps) / state.fps;
      tlSel.clear();
      for (const k of grp.tracks) {
        setKey(state.anim, k, t, currentValue(k), state.fps);
        selectAt(k, t, true);
      }
      saveAnimation();
    };
    label.append(toggle, add, name);
    label.dataset.group = grp.id;
    return label;
  }

  function groupRow(grp, { pos, inView, head }) {
    const label = groupHeading(grp);
    const track = Object.assign(document.createElement('div'), { className: 'tl-track tl-summary' });
    track.onpointerdown = (e) => {
      if (e.target.classList.contains('tl-playhead')) seekTimeline(e, track);
      else if (e.target === track) boxSelectKeys(e, track);
    };
    const times = new Map();
    for (const k of grp.tracks) {
      for (const key of state.anim.tracks[k]) {
        const t = Math.round(key.t * state.fps);
        if (!times.has(t)) times.set(t, []);
        times.get(t).push({ k, key });
      }
    }
    for (const list of times.values()) {
      const t = list[0].key.t;
      if (!inView(t)) continue;
      const d = Object.assign(document.createElement('span'), { className: 'tl-key tl-sum', style: `left:${pos(t)}` });
      if (list.every((i) => isSelected(i.k, i.key))) d.classList.add('selected');
      d.title = `${grp.name}: ${list.length} keyframe${list.length > 1 ? 's' : ''} at ${fmtTime(t)}`;
      d.tlKeys = list;
      d.onpointerdown = (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!e.shiftKey) tlSel.clear();
        for (const i of list) tlSel.add(i.key);
        state.keySel = { k: list[0].k, t: list[0].key.t };
        if (e.shiftKey) {
          renderTimeline();
          return;
        }
        dragKey(e, list[0].k, list[0].key, track, { keep: true });
      };
      track.append(d);
    }
    const playhead = Object.assign(document.createElement('span'), { className: 'tl-playhead', style: `left:${pos(head)}` });
    playhead.hidden = !inView(head);
    track.append(playhead);
    return [label, track];
  }

  function renderTimeline() {
    updateKeyButtons();
    const on = keyEditorOn() && state.mode === 'camera';
    if ($('timeline').hidden === on) {
      $('timeline').hidden = !on;
      // The picture gets less (or more) room.
      layoutCanvas();
    }
    if (!on) return;
    const grid = $('tl-grid');
    const len = animLength();
    const { start, span } = viewWindow();
    const pos = (t) => `${(100 * (t - start)) / span}%`;
    const inView = (t) => t >= start - 1e-6 && t <= start + span + 1e-6;
    const head = playheadTime();
    const rows = [];
    const step = tickStep(span);
    const digits = step < 0.1 ? 2 : step < 1 ? 2 : 0;
    const ruler = Object.assign(document.createElement('div'), { className: 'tl-ruler' });
    for (let n = Math.ceil(start / step - 1e-6); n * step <= start + span + 1e-6; n++) {
      const t = n * step;
      // The last label would hang off the end.
      const label = t > start + span * 0.94 ? '' : `${+t.toFixed(digits)}s`;
      ruler.append(Object.assign(document.createElement('span'), { className: 'tl-tick', textContent: label, style: `left:${pos(t)}` }));
    }
    const rulerHead = Object.assign(document.createElement('span'), { className: 'tl-playhead', style: `left:${pos(head)}` });
    rulerHead.hidden = !inView(head);
    ruler.append(rulerHead);
    ruler.onpointerdown = (e) => seekTimeline(e, ruler);
    rows.push(Object.assign(document.createElement('div'), { className: 'tl-label tl-ruler-label' }), ruler);
    for (const grp of trackGroups()) {
      if (grp.off || (grp.parent && groupCollapsed(grp.parent))) continue;
      const shown = shownTracks(grp);
      if (!shown.length) continue;
      const heading = groupRow(grp, { pos, inView, head });
      for (const el of heading) el.dataset.group = grp.id;
      rows.push(...heading);
      if (groupCollapsed(grp.id) || grp.sections) continue;
      for (const k of shown) {
      const label = Object.assign(document.createElement('div'), { className: `tl-label tl-sub${grp.parent ? ' tl-deep' : ''}` });
      const add = Object.assign(document.createElement('button'), { type: 'button', textContent: '◆', title: `Keyframe ${trackTitle(k).toLowerCase()} at the playhead` });
      add.setAttribute('aria-label', `Add a ${trackTitle(k).toLowerCase()} keyframe`);
      add.onclick = () => {
        const t = Math.round(playheadTime() * state.fps) / state.fps;
        setKey(state.anim, k, t, currentValue(k), state.fps);
        selectAt(k, t);
        saveAnimation();
      };
      label.append(add, document.createTextNode(trackName(k)));
      const track = Object.assign(document.createElement('div'), { className: 'tl-track' });
      track.onpointerdown = (e) => {
        if (e.target.classList.contains('tl-playhead')) seekTimeline(e, track);
        else if (e.target === track) boxSelectKeys(e, track);
      };
      for (const key of state.anim.tracks[k]) {
        if (!inView(key.t)) continue;
        const d = Object.assign(document.createElement('span'), { className: 'tl-key', style: `left:${pos(key.t)}` });
        if (isSelected(k, key)) d.classList.add('selected');
        d.tlKey = { k, key };
        if (key.ease.type === 'hold') d.classList.add('hold');
        d.title = `${trackTitle(k)} at ${fmtTime(key.t)}`;
        d.onpointerdown = (e) => dragKey(e, k, key, track);
        track.append(d);
      }
      const trackHead = Object.assign(document.createElement('span'), { className: 'tl-playhead', style: `left:${pos(head)}` });
      trackHead.hidden = !inView(head);
      track.append(trackHead);
      label.dataset.group = grp.id;
      track.dataset.group = grp.id;
      rows.push(label, track);
    }
    }
    grid.replaceChildren(...rows);
    const sel = selectedKey();
    $('tl-delete').disabled = !sel && !tlSel.size;
    $('tl-ease').disabled = !sel;
    if (sel) $('tl-ease').value = sel.ease.type;
    // The Curves view shows the handles on the curve itself.
    const box = !!(sel && sel.ease.type === 'custom') && !tlCurves.on;
    $('tl-curve').hidden = !box;
    if (box) drawCurve();
    $('tl-time').textContent = `${fmtTime(head)} / ${fmtTime(len)}`;
    $('tl-zoom-label').textContent = span >= len ? 'All' : `${Math.round((100 * len) / span)}%`;
    const scroll = $('tl-scroll');
    scroll.hidden = span >= len;
    scroll.max = String(Math.max(0, len - span));
    scroll.step = String(1 / state.fps);
    scroll.value = String(start);
    const curves = tlCurves.on;
    $('tl-grid').hidden = curves;
    $('tl-curves').hidden = !curves;
    if (curves) drawCurves();
  }

  // The time under the pointer; `r` is the track's (or ruler's) box, taken
  // when a drag starts since the timeline is redrawn as it goes.
  function timeAt(e, r) {
    const { start, span } = viewWindow();
    const t = Math.min(animLength(), Math.max(0, start + ((e.clientX - r.left) / r.width) * span));
    return Math.round(t * state.fps) / state.fps;
  }

  // Click or drag on the ruler or a track: the playhead follows the pointer,
  // showing the rendered frame there (or the animation's settings).
  function seekTimeline(e, el, box) {
    e.preventDefault();
    const r = box || el.getBoundingClientRect();
    let last = -1;
    const seek = (ev) => {
      const t = timeAt(ev, r);
      if (t === last) return;
      last = t;
      seekTo(t);
    };
    const up = () => {
      window.removeEventListener('pointermove', seek);
      window.removeEventListener('pointerup', up);
      if (!state.frames.length) scheduleSave();
    };
    window.addEventListener('pointermove', seek);
    window.addEventListener('pointerup', up);
    seek(e);
  }

  // Moves the playhead to time t.
  function seekTo(t) {
    state.keyTime = t;
    if (state.playing) setPlaying(false);
    if (state.frames.length) {
      const i = Math.min(state.frames.length - 1, Math.round(t * state.fps));
      state.showingFrames = true;
      state.index = i;
      showFrame(i);
      // The slider follows the time (an animation of one frame stays on it).
      $('scrub').value = String(Math.round(t * state.fps));
    } else {
      previewAt(t);
      $('scrub').value = String(Math.round(t * state.fps));
    }
    renderTimeline();
    updateFrameLabel();
  }

  // Drag on an empty part of a track: select the keyframes in a box (Shift
  // adds to the selection). A click without dragging moves the playhead
  // there and clears the selection.
  function boxSelectKeys(e, track) {
    e.preventDefault();
    const grid = $('tl-grid');
    const r = track.getBoundingClientRect();
    const x0 = e.clientX;
    const y0 = e.clientY;
    const base = e.shiftKey ? [...tlSel] : [];
    let box = null;
    const move = (ev) => {
      if (!box && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 4) return;
      const g = grid.getBoundingClientRect();
      if (!box) {
        box = Object.assign(document.createElement('div'), { className: 'tl-box' });
        grid.append(box);
      }
      const left = Math.min(x0, ev.clientX);
      const right = Math.max(x0, ev.clientX);
      const top = Math.min(y0, ev.clientY);
      const bottom = Math.max(y0, ev.clientY);
      Object.assign(box.style, { left: `${left - g.left}px`, top: `${top - g.top + grid.scrollTop}px`, width: `${right - left}px`, height: `${bottom - top}px` });
      tlSel.clear();
      for (const key of base) tlSel.add(key);
      state.keySel = null;
      for (const el of grid.querySelectorAll('.tl-key')) {
        const b = el.getBoundingClientRect();
        const cx = (b.left + b.right) / 2;
        const cy = (b.top + b.bottom) / 2;
        const inside = cx >= left && cx <= right && cy >= top && cy <= bottom;
        const keys = el.tlKeys ? el.tlKeys.map((i) => i.key) : [el.tlKey.key];
        if (inside) for (const key of keys) tlSel.add(key);
        el.classList.toggle('selected', keys.every((key) => tlSel.has(key)));
      }
    };
    const up = (ev) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (box) {
        box.remove();
        const first = selectedKeys()[0];
        state.keySel = first ? { k: first.k, t: first.key.t } : null;
        renderTimeline();
      } else {
        if (!e.shiftKey) clearSelection();
        seekTo(timeAt(ev, r));
        if (!state.frames.length) scheduleSave();
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  // Drag a keyframe along its track (with every other selected keyframe); a
  // click without moving selects just it and shows its value. Shift-click
  // adds it to the selection or takes it out.
  function dragKey(e, k, key, track, { keep = false } = {}) {
    e.preventDefault();
    e.stopPropagation();
    if (e.shiftKey && !keep) {
      if (tlSel.has(key)) {
        tlSel.delete(key);
        const first = selectedKeys()[0];
        state.keySel = first ? { k: first.k, t: first.key.t } : null;
      } else {
        selectKey(k, key, true);
      }
      renderTimeline();
      return;
    }
    if (!tlSel.has(key)) selectKey(k, key);
    else state.keySel = { k, t: key.t };
    const startX = e.clientX;
    const r = track.getBoundingClientRect();
    const t0 = key.t;
    const items = selectedKeys().map((i) => ({ ...i, t0: i.key.t }));
    let moved = false;
    const move = (ev) => {
      if (!moved && Math.abs(ev.clientX - startX) < 3) return;
      moved = true;
      moveKeys(items, timeAt(ev, r) - t0);
      state.keySel = { k, t: key.t };
      renderTimeline();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (moved) {
        saveAnimation();
      } else {
        if (!keep) selectKey(k, key);
        state.keyTime = key.t;
        showValue(k, key.v);
        renderTimeline();
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    renderTimeline();
  }

  function deleteSelectedKey() {
    const sel = selectedKey();
    if (!sel && !tlSel.size) return;
    for (const k of tracks()) state.anim.tracks[k] = state.anim.tracks[k].filter((key) => key !== sel && !tlSel.has(key));
    clearSelection();
    saveAnimation();
  }

  $('tl-delete').onclick = deleteSelectedKey;
  $('tl-zoom-in').onclick = () => zoomTimeline(2);
  $('tl-zoom-out').onclick = () => zoomTimeline(0.5);
  $('tl-zoom-label').onclick = () => {
    tlView.span = 0;
    renderTimeline();
  };
  $('tl-scroll').oninput = () => {
    tlView.start = +$('tl-scroll').value;
    renderTimeline();
  };
  // Ctrl / ⌘ + wheel zooms around the pointer; Shift + wheel (or a sideways
  // swipe) scrolls along the animation.
  $('tl-grid').parentElement.addEventListener('wheel', (e) => {
    const track = e.target.closest('.tl-track, .tl-ruler, .tl-plot');
    if (!track) return;
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const r = track.classList.contains('tl-plot') ? plotBox() : track.getBoundingClientRect();
      const { start, span } = viewWindow();
      zoomTimeline(e.deltaY < 0 ? 1.25 : 0.8, start + ((e.clientX - r.left) / r.width) * span);
    } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      e.preventDefault();
      const { span } = viewWindow();
      const d = e.shiftKey ? e.deltaY || e.deltaX : e.deltaX;
      tlView.start += (d / 400) * span;
      renderTimeline();
    }
  }, { passive: false });
  $('tl-key-all').onclick = () => {
    const t = Math.round(playheadTime() * state.fps) / state.fps;
    // Every track of the open groups.
    for (const g of trackGroups()) if (!g.off && !g.sections && !groupHidden(g)) for (const k of g.tracks) setKey(state.anim, k, t, currentValue(k), state.fps);
    saveAnimation();
  };
  $('tl-ease').onchange = () => {
    const sel = selectedKey();
    const list = new Set([...selectedKeys().map((i) => i.key), ...(sel ? [sel] : [])]);
    if (!list.size) return;
    const type = $('tl-ease').value;
    for (const key of list) {
      // A custom curve starts from the one chosen before.
      if (type === 'custom' && key.ease.type !== 'custom' && PRESETS[key.ease.type]) key.ease.bezier = [...PRESETS[key.ease.type]];
      key.ease.type = type;
    }
    saveAnimation();
  };
  document.addEventListener('keydown', (e) => {
    if ($('timeline').hidden) return;
    // Not while typing (sliders, checkboxes and buttons may keep the focus).
    if (e.target.matches('textarea, select, input:not([type=range], [type=checkbox], [type=radio], [type=button])')) return;
    // Ctrl / ⌘ + A: select every keyframe.
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a' && state.mode === 'camera') {
      e.preventDefault();
      for (const k of tracks()) for (const key of state.anim.tracks[k]) tlSel.add(key);
      const first = selectedKeys()[0];
      state.keySel = first ? { k: first.k, t: first.key.t } : null;
      renderTimeline();
      return;
    }
    if (!state.keySel && !tlSel.size) return;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      deleteSelectedKey();
    }
  });

  // The custom curve: from (0, 0) to (1, 1), two handles to drag.
  const curvePad = 14;
  function curveGeom() {
    const c = $('tl-curve-canvas');
    const dpr = window.devicePixelRatio || 1;
    const size = c.clientWidth || 150;
    if (c.width !== size * dpr) {
      c.width = size * dpr;
      c.height = size * dpr;
    }
    // y from -0.5 to 1.5, so curves can overshoot.
    const s = size - 2 * curvePad;
    return { c, dpr, size, X: (x) => curvePad + x * s, Y: (y) => curvePad + (1.5 - y) / 2 * s, s };
  }

  function drawCurve() {
    const sel = selectedKey();
    if (!sel) return;
    const { c, dpr, size, X, Y } = curveGeom();
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, size, size);
    g.fillStyle = '#0f1114';
    g.fillRect(X(0), Y(1.5), X(1) - X(0), Y(-0.5) - Y(1.5));
    g.strokeStyle = '#2a2e35';
    g.strokeRect(X(0), Y(1), X(1) - X(0), Y(0) - Y(1));
    const [x1, y1, x2, y2] = sel.ease.bezier;
    const f = cubicBezier(x1, y1, x2, y2);
    g.strokeStyle = '#e6e6e6';
    g.lineWidth = 1.6;
    g.beginPath();
    for (let i = 0; i <= 60; i++) {
      const x = i / 60;
      if (i) g.lineTo(X(x), Y(f(x)));
      else g.moveTo(X(x), Y(f(x)));
    }
    g.stroke();
    g.lineWidth = 1;
    g.strokeStyle = '#888';
    for (const [ax, ay, hx, hy] of [[0, 0, x1, y1], [1, 1, x2, y2]]) {
      g.beginPath();
      g.moveTo(X(ax), Y(ay));
      g.lineTo(X(hx), Y(hy));
      g.stroke();
      g.beginPath();
      g.arc(X(hx), Y(hy), 5, 0, 2 * Math.PI);
      g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--live');
      g.fill();
    }
  }

  $('tl-curve-canvas').addEventListener('pointerdown', (e) => {
    const sel = selectedKey();
    if (!sel) return;
    const { c, X, Y, s } = curveGeom();
    const r = c.getBoundingClientRect();
    const px = e.clientX - r.left;
    const py = e.clientY - r.top;
    const b = sel.ease.bezier;
    const d1 = Math.hypot(px - X(b[0]), py - Y(b[1]));
    const d2 = Math.hypot(px - X(b[2]), py - Y(b[3]));
    const h = d1 <= d2 ? 0 : 2;
    c.setPointerCapture(e.pointerId);
    const move = (ev) => {
      const x = Math.min(1, Math.max(0, (ev.clientX - r.left - curvePad) / s));
      const y = Math.min(1.5, Math.max(-0.5, 1.5 - ((ev.clientY - r.top - curvePad) / s) * 2));
      b[h] = x;
      b[h + 1] = y;
      drawCurve();
    };
    const up = () => {
      c.removeEventListener('pointermove', move);
      c.removeEventListener('pointerup', up);
      saveAnimation();
    };
    c.addEventListener('pointermove', move);
    c.addEventListener('pointerup', up);
    move(e);
  });

  // Length, beside the play bar: of the keyframed animation, the viewpoint
  // path, or the focus sweep (their numbers of frames).
  function showAnimationLength() {
    const kind = $('anim').value;
    $('anim-length').value = kind === 'keyframes' ? frameCount(state.anim, state.fps) : +$(kind === 'focus' ? 'steps' : 'frames').value;
    $('anim-length').max = kind === 'focus' ? $('steps').max : String(Math.round(120 * state.fps) + 1);
  }

  // Length in frames (as the play bar counts them).
  $('anim-length').onchange = () => {
    const frames = Math.min(Math.round(120 * state.fps) + 1, Math.max(2, Math.round(+$('anim-length').value) || 2));
    if ($('anim').value === 'keyframes') {
      state.anim.length = (frames - 1) / state.fps;
      saveAnimation();
    } else if ($('anim').value === 'focus') {
      // Steps: odd, so the sweep has a middle frame.
      const steps = $('steps');
      $('steps').value = Math.min(+steps.max, Math.max(+steps.min, frames | 1));
      scheduleSave();
      animationSettingsChanged();
    } else {
      $('frames').value = frames;
      scheduleSave();
      animationSettingsChanged();
    }
    showAnimationLength();
    updateFrameLabel();
  };

  for (const id of ['frame-zoom', 'frame-pan-x', 'frame-pan-y']) {
    $(id).oninput = () => {
      showSliderValue($(id));
      if (state.lastImage) draw(state.lastImage);
    };
    $(id).onchange = () => {
      autoKey();
      scheduleSave();
    };
  }

  // Values of every track at every frame: camera settings for the worker and
  // framing for drawing.
  function keyframeFrames() {
    if (!hasKeys(state.anim)) return null;
    const live = { aperture: F_STOPS[+$('fstop').value] ?? 2, depth: +$('dof-depth').value, focus: +$('focus').value };
    const path = [];
    const frames = [];
    const maskTracks = tracks().filter((k) => isMaskTrack(k) && state.anim.tracks[k].length);
    // Keyframed Process and Optics sliders: each frame carries its color
    // settings.
    const colorKeyed = tracks().some((k) => isSettingTrack(k) && state.anim.tracks[k].length);
    for (const v of sample(state.anim, state.fps)) {
      // Local adjustment settings this frame: { id: { attr: value } }.
      let masks = null;
      for (const k of maskTracks) {
        if (v[k] === undefined) continue;
        const { id, attr } = parseMaskTrack(k);
        masks = masks || {};
        (masks[id] = masks[id] || {})[attr] = v[k];
      }
      const lens = apertureFor(v.aperture ?? live.aperture);
      const depth = v.depth ?? live.depth;
      const view = v.view ?? [state.camera.u, state.camera.v];
      path.push({ u: view[0], v: view[1], alpha: v.focus ?? live.focus, aperture: lens.aperture, dof: lens.dof * 4 ** (-depth / 50), masks, pivot: v.pivot ?? null, bokeh: bokehParams(v),
        color: colorKeyed ? colorSettings((id) => v[`set:${id}`] ?? +$(id).value) : null });
      const z = v.zoom ?? +$('frame-zoom').value / 100;
      const panX = v.panX ?? +$('frame-pan-x').value / 100;
      const panY = v.panY ?? +$('frame-pan-y').value / 100;
      frames.push(framing(z, panX, panY));
    }
    return { path, framing: frames };
  }
  return { MASK_LIMITS, parseMaskTrack, trackGroups, tracks, KEY_CONTROLS, settingControl, updateKeyButtons, groupCollapsed, shownTracks, groupHidden, trackName, tlSel, tlCurves, keyframesOn, animLength, loadAnimation, saveAnimation, liveFraming, combineMotion, showValue, previewAt, autoKey, playheadTime, clearSelection, selectKey, selectedKeys, moveKeys, selectedKey, viewWindow, tickStep, updatePlayhead, groupHeading, renderTimeline, timeAt, seekTimeline, seekTo, showAnimationLength, keyframeFrames };
}
