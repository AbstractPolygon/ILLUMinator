// curves view: moved out of main.js. initCurvesView() runs where the section used to, with what it uses from the rest of the page.
import { isSettingTrack, isMaskTrack, valueAt, segmentBezier } from '../core/keyframes.js';

export function initCurvesView({ trackGroups, shownTracks, trackName, $, state, settingControl, MASK_LIMITS, parseMaskTrack, F_STOPS, groupHeading, groupCollapsed, tlCurves, viewWindow, tickStep, selectedKey, groupHidden, animLength, tlSel, playheadTime, renderTimeline, saveAnimation, tracks, layoutCanvas, seekTimeline, selectedKeys, selectKey, moveKeys, timeAt, showValue, clearSelection, seekTo, scheduleSave }) {
  // The keyframe editor's Curves view (like Blender's Graph Editor): each
  // setting as a curve over time, each part of a viewpoint
  // separately, each fitted to the height of the view. Drag a keyframe to
  // change its time and value; drag anywhere else to move the playhead.

  const CHANNELS = [
    { k: 'focus', c: 0, name: 'Focus', color: '#4fc3f7' },
    { k: 'aperture', c: 0, name: 'Aperture', color: '#ffb74d' },
    { k: 'depth', c: 0, name: 'Depth', color: '#ba68c8' },
    { k: 'view', c: 0, name: 'Viewpoint X', color: '#ef5350' },
    { k: 'view', c: 1, name: 'Viewpoint Y', color: '#66bb6a' },
    { k: 'zoom', c: 0, name: 'Zoom', color: '#fff176' },
    { k: 'panX', c: 0, name: 'Pan X', color: '#f48fb1' },
    { k: 'panY', c: 0, name: 'Pan Y', color: '#aed581' },
    { k: 'pivot', c: 0, name: 'Pivot depth', color: '#90caf9' },
    { k: 'pointX', c: 0, name: 'Focus point X', color: '#4dd0e1' },
    { k: 'pointY', c: 0, name: 'Focus point Y', color: '#9ccc65' },
    { k: 'spread', c: 0, name: 'Spread', color: '#7986cb' },
    { k: 'spreadSmooth', c: 0, name: 'Smoothing', color: '#4db6ac' },
    { k: 'spreadBlur', c: 0, name: 'Blur', color: '#9575cd' },
    { k: 'tilt', c: 0, name: 'Tilt', color: '#ff8a65' },
    { k: 'tiltRotation', c: 0, name: 'Rotation', color: '#a1887f' },
    { k: 'highlights', c: 0, name: 'Highlights', color: '#f06292' },
    { k: 'amount', c: 0, name: 'Amount', color: '#4fc3f7' },
    { k: 'near', c: 0, name: 'Near', color: '#ba68c8' },
    { k: 'far', c: 0, name: 'Far', color: '#81c784' },
  ];
  const channelId = (ch) => `${ch.k}.${ch.c}`;
  const MASK_COLORS = ['#ff8a65', '#4db6ac', '#9575cd', '#e0e0e0', '#81c784', '#64b5f6', '#ffd54f', '#f06292', '#a1887f', '#90a4ae', '#ce93d8'];

  // The Curves view's channels, by group (a viewpoint is two).
  function channelList() {
    const out = [];
    for (const grp of trackGroups()) {
      if (grp.off) continue;
      if (grp.sections) continue;
      const shown = shownTracks(grp);
      for (const k of shown) {
        // Named channels (a viewpoint is two); the others colored by place in
        // the group, so a curve keeps its color when others are hidden.
        const named = CHANNELS.filter((ch) => ch.k === k);
        if (named.length) out.push(...named.map((ch) => ({ ...ch, group: grp })));
        else out.push({ k, c: 0, name: trackName(k), color: MASK_COLORS[grp.tracks.indexOf(k) % MASK_COLORS.length], group: grp });
      }
    }
    return out;
  }
  // Room at the plot's sides so keyframes at the ends show whole.
  const PLOT_PAD = 8;

  // The plot's time axis on screen (its box without the side room).
  function plotBox() {
    const r = $('tl-plot').getBoundingClientRect();
    return { left: r.left + PLOT_PAD, top: r.top, width: r.width - 2 * PLOT_PAD, height: r.height };
  }

  // A channel's value as plotted (aperture in f-stops: log scale).
  function channelValue(ch, v) {
    const x = Array.isArray(v) ? v[ch.c] : v;
    return ch.k === 'aperture' ? Math.log2(x) : x;
  }

  function channelRange(ch) {
    let lo = Infinity;
    let hi = -Infinity;
    for (const key of state.anim.tracks[ch.k]) {
      const y = channelValue(ch, key.v);
      lo = Math.min(lo, y);
      hi = Math.max(hi, y);
    }
    if (!(hi > lo)) {
      lo -= 0.5;
      hi += 0.5;
    }
    const pad = (hi - lo) * 0.12;
    return [lo - pad, hi + pad];
  }

  // The limits each channel's value is kept within.
  function channelLimits(ch) {
    if (isSettingTrack(ch.k)) return [+settingControl(ch.k).min, +settingControl(ch.k).max];
    if (isMaskTrack(ch.k)) return MASK_LIMITS[parseMaskTrack(ch.k).attr] || [-1, 1];
    const r = (state.info && state.info.radius) || 4.5;
    switch (ch.k) {
      case 'aperture': return [Math.log2(Math.min(...F_STOPS)), Math.log2(Math.max(...F_STOPS))];
      case 'depth': return [-100, 100];
      case 'focus': return [-2, 2];
      case 'view': return [-r, r];
      case 'zoom': return [1, 3];
      case 'pivot': return [-100, 100];
      case 'pointX':
      case 'pointY':
      case 'highlights': return [0, 1];
      case 'spread':
      case 'spreadSmooth': return [0, 100];
      case 'spreadBlur': return [0, 100];
      case 'tilt': return [-100, 100];
      case 'tiltRotation': return [-90, 90];
      case 'amount': return [0.1, 1];
      case 'near': return [-1.6, 0];
      case 'far': return [0, 1.6];
      default: return [-1, 1];
    }
  }

  function setChannelValue(ch, key, y) {
    const [lo, hi] = channelLimits(ch);
    y = Math.min(hi, Math.max(lo, y));
    const x = ch.k === 'aperture' ? 2 ** y : y;
    if (Array.isArray(key.v)) {
      key.v = [...key.v];
      key.v[ch.c] = x;
    } else {
      key.v = x;
    }
  }

  function renderChannels() {
    const rows = [];
    let group = null;
    let parent = null;
    const groups = trackGroups();
    for (const ch of channelList()) {
      const p = ch.group.parent || null;
      if (p && p !== parent) rows.push(groupHeading(groups.find((g) => g.id === p)));
      parent = p;
      if (p && groupCollapsed(p)) continue;
      if (ch.group !== group) {
        group = ch.group;
        const g = group;
        rows.push(groupHeading(g));
      }
      if (groupCollapsed(ch.group.id)) continue;
      const id = channelId(ch);
      const row = Object.assign(document.createElement('label'), { className: 'tl-channel' });
      if (!state.anim.tracks[ch.k].length) row.classList.add('empty');
      const box = Object.assign(document.createElement('input'), { type: 'checkbox', checked: !tlCurves.hidden.has(id) });
      box.onchange = () => {
        if (box.checked) tlCurves.hidden.delete(id);
        else tlCurves.hidden.add(id);
        drawCurves();
      };
      const sw = Object.assign(document.createElement('span'), { className: 'tl-swatch' });
      sw.style.background = ch.color;
      row.append(box, sw, document.createTextNode(ch.name));
      row.dataset.group = ch.group.id;
      rows.push(row);
    }
    $('tl-channels').replaceChildren(...rows);
  }

  function drawCurves() {
    const c = $('tl-plot');
    const dpr = window.devicePixelRatio || 1;
    const cssW = c.clientWidth || 600;
    const cssH = c.clientHeight || 200;
    if (c.width !== Math.round(cssW * dpr) || c.height !== Math.round(cssH * dpr)) {
      c.width = Math.round(cssW * dpr);
      c.height = Math.round(cssH * dpr);
    }
    renderChannels();
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, cssW, cssH);
    const { start, span } = viewWindow();
    const top = 18;
    const bottom = cssH - 6;
    const plotW = cssW - 2 * PLOT_PAD;
    const xOf = (t) => PLOT_PAD + ((t - start) / span) * plotW;
    // Time grid and labels.
    const step = tickStep(span);
    g.font = '10px system-ui, sans-serif';
    g.textBaseline = 'top';
    for (let n = Math.ceil(start / step - 1e-6); n * step <= start + span + 1e-6; n++) {
      const t = n * step;
      const x = Math.round(xOf(t)) + 0.5;
      g.strokeStyle = 'rgba(255,255,255,0.07)';
      g.beginPath();
      g.moveTo(x, top - 4);
      g.lineTo(x, cssH);
      g.stroke();
      g.fillStyle = 'rgba(255,255,255,0.45)';
      if (t < start + span * 0.94) g.fillText(`${+t.toFixed(step < 1 ? 2 : 0)}s`, x + 3, 3);
    }
    tlCurves.hits = [];
    const sel = selectedKey();
    for (const ch of channelList()) {
      const keys = state.anim.tracks[ch.k];
      if (!keys.length || groupHidden(ch.group) || tlCurves.hidden.has(channelId(ch))) continue;
      const [lo, hi] = tlCurves.drag && tlCurves.drag.id === channelId(ch) ? tlCurves.drag.range : channelRange(ch);
      const yOf = (y) => bottom - ((y - lo) / (hi - lo)) * (bottom - top);
      // The curve, sampled every two pixels.
      g.strokeStyle = ch.color;
      g.lineWidth = 1.5;
      g.beginPath();
      for (let x = 0; x <= cssW + 2; x += 2) {
        const t = Math.min(animLength(), Math.max(0, start + ((x - PLOT_PAD) / plotW) * span));
        const y = yOf(channelValue(ch, valueAt(state.anim, ch.k, t)));
        if (x === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      g.stroke();
      // Keyframes.
      for (const key of keys) {
        const x = xOf(key.t);
        const y = yOf(channelValue(ch, key.v));
        if (x < -6 || x > cssW + 6) continue;
        const on = key === sel || tlSel.has(key);
        if (on) {
          // Selected: a bright ring around a white key.
          g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--key-selected');
          g.beginPath();
          g.arc(x, y, 7, 0, 2 * Math.PI);
          g.fill();
        }
        g.fillStyle = on ? '#fff' : ch.color;
        g.strokeStyle = '#15181c';
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(x, y - 3.5);
        g.lineTo(x + 3.5, y);
        g.lineTo(x, y + 3.5);
        g.lineTo(x - 3.5, y);
        g.closePath();
        g.fill();
        g.stroke();
        tlCurves.hits.push({ x, y, ch, key, range: [lo, hi] });
      }
      // The selected keyframe's handles: where the curve leaves it and where
      // it arrives, as in Blender.
      const i = sel && state.keySel.k === ch.k ? keys.indexOf(sel) : -1;
      if (i >= 0) {
        for (const hd of keyHandles(ch, i)) {
          const hx = xOf(hd.t);
          const hy = yOf(hd.y);
          const kx = xOf(sel.t);
          const ky = yOf(channelValue(ch, sel.v));
          g.strokeStyle = 'rgba(255,255,255,0.75)';
          g.lineWidth = 1;
          g.beginPath();
          g.moveTo(kx, ky);
          g.lineTo(hx, hy);
          g.stroke();
          g.fillStyle = '#fff';
          g.strokeStyle = '#15181c';
          g.beginPath();
          g.arc(hx, hy, 3, 0, 2 * Math.PI);
          g.fill();
          g.stroke();
          tlCurves.hits.push({ x: hx, y: hy, ch, key: sel, handle: hd, range: [lo, hi] });
        }
      }
    }
    if (tlCurves.box) {
      const b = tlCurves.box;
      g.fillStyle = 'rgba(200, 205, 213, 0.08)';
      g.strokeStyle = 'rgba(200, 205, 213, 0.7)';
      g.setLineDash([4, 3]);
      g.lineWidth = 1;
      g.fillRect(b.x, b.y, b.w, b.h);
      g.strokeRect(b.x + 0.5, b.y + 0.5, b.w, b.h);
      g.setLineDash([]);
    }
    // Playhead.
    const head = playheadTime();
    if (head >= start && head <= start + span) {
      const x = Math.round(xOf(head)) + 0.5;
      g.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--live');
      g.lineWidth = 1.5;
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x, cssH);
      g.stroke();
    }
  }

  // Handles of keyframe i on a channel: { seg, end, t, y } for the curve
  // leaving it (end 1 of segment i) and arriving at it (end 2 of i - 1).
  function keyHandles(ch, i) {
    const keys = state.anim.tracks[ch.k];
    const out = [];
    const val = (key) => channelValue(ch, key.v);
    const after = segmentBezier(state.anim, ch.k, i, ch.c);
    if (after) {
      const a = keys[i];
      const b = keys[i + 1];
      out.push({ seg: i, end: 1, t: a.t + after[0] * (b.t - a.t), y: val(a) + after[1] * (val(b) - val(a)) });
    }
    const before = i > 0 ? segmentBezier(state.anim, ch.k, i - 1, ch.c) : null;
    if (before) {
      const a = keys[i - 1];
      const b = keys[i];
      out.push({ seg: i - 1, end: 2, t: a.t + before[2] * (b.t - a.t), y: val(a) + before[3] * (val(b) - val(a)) });
    }
    return out;
  }

  // Drags a handle of the selected keyframe: the segment becomes a custom
  // curve, and the handle on the other side turns with it so the curve stays
  // smooth through the keyframe.
  function dragHandle(e, hit, r) {
    e.preventDefault();
    const { ch, handle } = hit;
    const keys = state.anim.tracks[ch.k];
    const i = keys.indexOf(hit.key);
    const [lo, hi] = hit.range;
    const top = 18;
    const bottom = r.height - 6;
    const { start, span } = viewWindow();
    const val = (key) => channelValue(ch, key.v);
    // Both curves at the keyframe become custom, starting as they look now.
    for (const seg of [i - 1, i]) {
      if (seg < 0 || seg >= keys.length - 1 || keys[seg].ease.type === 'hold') continue;
      keys[seg].ease = { type: 'custom', bezier: segmentBezier(state.anim, ch.k, seg, ch.c) };
    }
    tlCurves.drag = { id: channelId(ch), range: hit.range };
    const other = keyHandles(ch, i).find((h) => h.end !== handle.end);
    const move = (ev) => {
      const t = start + ((ev.clientX - r.left) / r.width) * span;
      const y = lo + ((bottom - (ev.clientY - r.top)) / (bottom - top)) * (hi - lo);
      const k0 = keys[handle.seg];
      const k1 = keys[handle.seg + 1];
      const d = val(k1) - val(k0);
      const bz = k0.ease.bezier;
      const x = Math.min(1, Math.max(0, (t - k0.t) / (k1.t - k0.t)));
      const at = handle.end === 1 ? 0 : 2;
      bz[at] = x;
      if (Math.abs(d) > 1e-9) bz[at + 1] = (y - val(k0)) / d;
      // Aligned: the other handle keeps its length in time and takes the
      // same slope through the keyframe.
      const key = keys[i];
      const dt = handle.end === 1 ? bz[0] * (k1.t - k0.t) : (1 - bz[2]) * (k1.t - k0.t);
      const dy = handle.end === 1 ? bz[1] * d : (1 - bz[3]) * d;
      if (other && dt > 1e-9) {
        const slope = dy / dt;
        const o0 = keys[other.seg];
        const o1 = keys[other.seg + 1];
        const od = val(o1) - val(o0);
        const obz = o0.ease.bezier;
        if (Math.abs(od) > 1e-9) {
          if (other.end === 2) {
            const odt = (1 - obz[2]) * (o1.t - o0.t);
            obz[3] = (val(key) - slope * odt - val(o0)) / od;
          } else {
            const odt = obz[0] * (o1.t - o0.t);
            obz[1] = (slope * odt) / od;
          }
        }
      }
      renderTimeline();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      tlCurves.drag = null;
      saveAnimation();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  function setCurvesView(on) {
    // The curves take the room the tracks had: switching views keeps the
    // editor's height.
    const tracks = $('tl-grid').offsetHeight;
    if (on && tracks) $('timeline').style.setProperty('--tl-natural', `${tracks}px`);
    tlCurves.on = on;
    $('tl-view-keys').classList.toggle('active', !on);
    $('tl-view-curves').classList.toggle('active', on);
    $('tl-view-keys').setAttribute('aria-pressed', String(!on));
    $('tl-view-curves').setAttribute('aria-pressed', String(on));
    renderTimeline();
    layoutCanvas();
  }
  // Drag the editor's top edge to make it taller or shorter (the picture
  // gets the rest); a double-click goes back to the natural height.
  // `h`: the height of the tracks in pixels, down to 0 (only the editor's
  // toolbar shows), or null for their natural height.
  function setTimelineHeight(h) {
    const tl = $('timeline');
    const sized = Number.isFinite(h) && h >= 0;
    tl.classList.toggle('sized', sized);
    // All the way down: only the toolbar.
    tl.classList.toggle('collapsed', sized && h === 0);
    if (sized) tl.style.setProperty('--tl-h', `${h}px`);
    else tl.style.removeProperty('--tl-h');
    try {
      if (sized) localStorage.setItem('illuminator.timelineHeight', String(h));
      else localStorage.removeItem('illuminator.timelineHeight');
    } catch {
      // Not kept between sessions then.
    }
    layoutCanvas();
    if (tlCurves.on && !tl.hidden) drawCurves();
  }
  $('tl-resize').addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const handle = $('tl-resize');
    const startY = e.clientY;
    const startH = document.querySelector('.tl-main').getBoundingClientRect().height;
    handle.classList.add('dragging');
    // As tall as every track needs, as long as an 80px strip of the picture
    // (and the bars around the editor) stays in view. Measured once: while
    // dragging, the layout is changing under the pointer.
    const stage = document.querySelector('.stage').getBoundingClientRect().height;
    const h = (el) => (el ? el.getBoundingClientRect().height : 0);
    const others = h(document.querySelector('.modes-row')) + h(document.querySelector('.transport')) + h($('timeline')) - startH;
    const max = Math.max(120, stage - others - 80);
    const move = (ev) => {
      setTimelineHeight(Math.round(Math.min(max, Math.max(0, startH - (ev.clientY - startY)))));
    };
    const up = () => {
      handle.classList.remove('dragging');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
  $('tl-resize').ondblclick = () => setTimelineHeight(null);

  // The right sidebar's width: drag its left edge (double-click for the
  // normal width). Remembered between sessions.
  function setSidebarWidth(w) {
    const side = $('controls');
    if (w === null) side.style.removeProperty('width');
    else side.style.width = `${Math.round(w)}px`;
    layoutCanvas();
    try {
      if (w === null) localStorage.removeItem('illuminator.sidebarWidth');
      else localStorage.setItem('illuminator.sidebarWidth', String(Math.round(w)));
    } catch {
      // Not remembered; it still applies now.
    }
  }
  $('controls-resize').addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const handle = $('controls-resize');
    const startX = e.clientX;
    const startW = $('controls').getBoundingClientRect().width;
    // Room is kept for the picture.
    const max = Math.max(280, Math.min(640, window.innerWidth - 520));
    handle.classList.add('dragging');
    let frame = 0;
    const move = (ev) => {
      const w = Math.min(max, Math.max(260, startW - (ev.clientX - startX)));
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setSidebarWidth(w));
    };
    const up = () => {
      handle.classList.remove('dragging');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
  $('controls-resize').ondblclick = () => setSidebarWidth(null);
  try {
    const saved = +localStorage.getItem('illuminator.sidebarWidth');
    if (saved >= 260) $('controls').style.width = `${Math.min(640, saved)}px`;
  } catch {
    // Storage unavailable: the normal width.
  }
  try {
    const saved = localStorage.getItem('illuminator.timelineHeight');
    const h = saved === null ? NaN : +saved;
    if (h >= 0) {
      $('timeline').classList.add('sized');
      $('timeline').classList.toggle('collapsed', h === 0);
      $('timeline').style.setProperty('--tl-h', `${h}px`);
    }
  } catch {
    // Natural height.
  }
  $('tl-view-keys').onclick = () => setCurvesView(false);
  $('tl-view-curves').onclick = () => setCurvesView(true);

  $('tl-plot').addEventListener('pointerdown', (e) => {
    const c = $('tl-plot');
    const r = plotBox();
    const px = e.clientX - r.left + PLOT_PAD;
    const py = e.clientY - r.top;
    let hit = null;
    let best = 8;
    for (const h of tlCurves.hits) {
      const d = Math.hypot(h.x - px, h.y - py);
      if (d < best) {
        best = d;
        hit = h;
      }
    }
    if (!hit) {
      // Along the time labels: scrub. Elsewhere: box select.
      if (py < 18) seekTimeline(e, c, r);
      else boxSelectCurves(e, r);
      return;
    }
    if (hit.handle) {
      dragHandle(e, hit, r);
      return;
    }
    e.preventDefault();
    const { ch, key } = hit;
    if (e.shiftKey) {
      if (tlSel.has(key)) {
        tlSel.delete(key);
        const first = selectedKeys()[0];
        state.keySel = first ? { k: first.k, t: first.key.t } : null;
      } else {
        selectKey(ch.k, key, true);
      }
      renderTimeline();
      return;
    }
    const id = channelId(ch);
    const startX = e.clientX;
    const startY = e.clientY;
    const top = 18;
    const bottom = r.height - 6;
    // The value scale stays put while dragging.
    tlCurves.drag = { id, range: hit.range };
    if (!tlSel.has(key)) selectKey(ch.k, key);
    else state.keySel = { k: ch.k, t: key.t };
    const t0 = key.t;
    // Every selected keyframe moves in time; those on this curve also move
    // up or down by the same amount.
    const items = selectedKeys().map((i) => ({ ...i, t0: i.key.t, y0: i.k === ch.k ? channelValue(ch, i.key.v) : null }));
    let moved = false;
    const move = (ev) => {
      if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 3) return;
      moved = true;
      moveKeys(items, timeAt(ev, r) - t0);
      const [lo, hi] = hit.range;
      const dy = -((ev.clientY - startY) / (bottom - top)) * (hi - lo);
      for (const i of items) if (i.y0 !== null) setChannelValue(ch, i.key, i.y0 + dy);
      state.keySel = { k: ch.k, t: key.t };
      renderTimeline();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      tlCurves.drag = null;
      if (moved) {
        saveAnimation();
      } else {
        selectKey(ch.k, key);
        state.keyTime = key.t;
        showValue(ch.k, key.v);
      }
      renderTimeline();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    renderTimeline();
  });
  window.addEventListener('resize', () => {
    if (tlCurves.on && !$('timeline').hidden) drawCurves();
  });

  // Box select in the Curves view (Shift adds); a click without dragging
  // moves the playhead and clears the selection.
  function boxSelectCurves(e, r) {
    e.preventDefault();
    const c = $('tl-plot');
    const cr = c.getBoundingClientRect();
    const x0 = e.clientX - cr.left;
    const y0 = e.clientY - cr.top;
    const base = e.shiftKey ? [...tlSel] : [];
    const move = (ev) => {
      const x1 = ev.clientX - cr.left;
      const y1 = ev.clientY - cr.top;
      if (!tlCurves.box && Math.hypot(x1 - x0, y1 - y0) < 4) return;
      const b = { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
      tlCurves.box = b;
      tlSel.clear();
      for (const key of base) tlSel.add(key);
      for (const h of tlCurves.hits) {
        if (h.handle) continue;
        if (h.x >= b.x && h.x <= b.x + b.w && h.y >= b.y && h.y <= b.y + b.h) tlSel.add(h.key);
      }
      const first = selectedKeys()[0];
      state.keySel = first ? { k: first.k, t: first.key.t } : null;
      drawCurves();
    };
    const up = (ev) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (tlCurves.box) {
        tlCurves.box = null;
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
  return { plotBox, drawCurves };
}
