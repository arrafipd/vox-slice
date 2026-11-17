// Canvas waveform with word ticks, zoom/pan, a highlighted region with
// draggable start/end handles, other-clip markers and a moving playhead.
//
// Cheap by design: the waveform, ticks and ruler are painted once into an
// offscreen layer and only re-painted when the view/size/source changes.
// The region, handles and playhead are drawn on top every frame.

const CYAN = '#00E6FF';
const PINK = '#FF00B8';
const YELLOW = '#E8FF00';
const MIN_SPAN = 0.25;
const OVERVIEW_H = 20;
const RULER_H = 16;
const WORD_BAND = 18;
const GRAB = 10;

function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function niceStep(span, targetTicks) {
  const raw = span / targetTicks;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / pow;
  const m = n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10;
  return m * pow;
}

function fmt(t, dec = 1) {
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return m + ':' + s.toFixed(dec).padStart(dec ? 3 + dec - 0 : 2, '0');
}

export function createWaveform(root, hooks = {}) {
  const canvas = document.createElement('canvas');
  canvas.className = 'wave-canvas';
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', 'Waveform of the selected speech. Drag the pink handles to fine-tune a clip.');
  root.appendChild(canvas);
  const g = canvas.getContext('2d');
  const base = document.createElement('canvas'); // cached layer
  const bg = base.getContext('2d');

  let W = 0, H = 0, dpr = 1;
  let dur = 0, peaks = null, words = [], peakScale = 1;
  let t0 = 0, t1 = 1;
  let region = null;       // { start, end, editable }
  let markers = [];        // [{ id, start, end }]
  let playhead = null;
  let follow = false;
  let ov = null;           // overview min/max columns
  let dirtyBase = true, dirtyAny = true, raf = 0;
  let dragLabel = null;    // 'start' | 'end' while dragging a handle
  let hoverCursor = '';
  const pointers = new Map();
  let mode = null, drag = null;

  const fontMono = () => cssVar('--gauge', 'Orbitron, monospace');
  const fontBody = () => cssVar('--body-font', 'Inter Variable, Inter, system-ui, sans-serif');

  const waveTop = WORD_BAND;
  const waveBottom = () => H - OVERVIEW_H - RULER_H;
  const xOf = (t) => ((t - t0) / (t1 - t0)) * W;
  const tOf = (x) => t0 + (x / W) * (t1 - t0);

  function schedule(baseToo) {
    if (baseToo) dirtyBase = true;
    dirtyAny = true;
    if (!raf) raf = requestAnimationFrame(draw);
  }

  function clampView() {
    if (dur <= 0) { t0 = 0; t1 = 1; return; }
    let span = Math.min(dur, Math.max(MIN_SPAN, t1 - t0));
    if (t0 < 0) t0 = 0;
    t1 = t0 + span;
    if (t1 > dur) { t1 = dur; t0 = Math.max(0, dur - span); }
    span = t1 - t0;
  }

  function resize() {
    const r = root.getBoundingClientRect();
    const w = Math.max(10, Math.round(r.width));
    const h = Math.max(60, Math.round(r.height));
    dpr = Math.min(3, window.devicePixelRatio || 1);
    if (w === W && h === H && canvas.width === Math.round(w * dpr)) return;
    W = w; H = h;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    base.width = canvas.width;
    base.height = canvas.height;
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    ov = null;
    schedule(true);
  }
  const ro = new ResizeObserver(resize);
  ro.observe(root);

  // ---- peaks lookup -------------------------------------------------------
  function columnRange(ta, tb) {
    const n = peaks.min.length;
    let lo = Math.floor((ta / dur) * n);
    let hi = Math.ceil((tb / dur) * n);
    if (lo < 0) lo = 0;
    if (hi > n) hi = n;
    if (hi <= lo) hi = Math.min(n, lo + 1);
    let mn = 0, mx = 0;
    for (let i = lo; i < hi; i++) {
      const a = peaks.min[i], b = peaks.max[i];
      if (a < mn) mn = a;
      if (b > mx) mx = b;
    }
    return [mn, mx];
  }

  function paintBase() {
    dirtyBase = false;
    bg.setTransform(dpr, 0, 0, dpr, 0, 0);
    bg.clearRect(0, 0, W, H);
    const wb = waveBottom();
    const mid = (waveTop + wb) / 2;
    const amp = (wb - waveTop) / 2 - 3;

    // faint centre line + time grid + ruler
    bg.strokeStyle = 'rgba(200,203,214,0.10)';
    bg.lineWidth = 1;
    bg.beginPath(); bg.moveTo(0, Math.round(mid) + 0.5); bg.lineTo(W, Math.round(mid) + 0.5); bg.stroke();

    if (dur > 0) {
      const span = t1 - t0;
      const step = niceStep(span, Math.max(3, W / 110));
      const dec = step >= 1 ? 0 : step >= 0.1 ? 1 : 2;
      bg.font = `600 10px ${fontMono()}`;
      bg.textBaseline = 'alphabetic';
      bg.fillStyle = 'rgba(200,203,214,0.75)';
      bg.strokeStyle = 'rgba(138,0,255,0.22)';
      for (let t = Math.ceil(t0 / step) * step; t <= t1 + 1e-9; t += step) {
        const x = Math.round(xOf(t)) + 0.5;
        bg.beginPath(); bg.moveTo(x, waveTop); bg.lineTo(x, wb + 4); bg.stroke();
        bg.fillText(fmt(t, dec), x + 3, wb + 13);
      }
    }

    if (peaks && dur > 0) {
      const grad = bg.createLinearGradient(0, waveTop, 0, wb);
      grad.addColorStop(0, CYAN);
      grad.addColorStop(0.5, '#BFF4FF');
      grad.addColorStop(1, CYAN);
      const path = new Path2D();
      const colW = 1;
      const spanPerPx = (t1 - t0) / W;
      for (let x = 0; x < W; x += colW) {
        const ta = t0 + x * spanPerPx;
        const tb = ta + spanPerPx * colW;
        if (tb < 0 || ta > dur) continue;
        const [mn, mx] = columnRange(Math.max(0, ta), Math.min(dur, tb));
        const y1 = mid - Math.min(1, mx / peakScale) * amp;
        const y2 = mid - Math.max(-1, mn / peakScale) * amp;
        path.rect(x, y1, colW + 0.4, Math.max(1.2, y2 - y1));
      }
      bg.save();
      bg.shadowColor = 'rgba(0,230,255,0.85)';
      bg.shadowBlur = 9;
      bg.fillStyle = grad;
      bg.fill(path);
      bg.restore();
    } else if (dur > 0) {
      bg.fillStyle = 'rgba(200,203,214,0.7)';
      bg.font = `600 13px ${fontBody()}`;
      bg.textAlign = 'center';
      bg.fillText('Audio missing. Drop the original file to relink it.', W / 2, mid + 4);
      bg.textAlign = 'start';
    }

    // word ticks + labels
    if (words.length && dur > 0) {
      const pxPerSec = W / (t1 - t0);
      if (pxPerSec > 22) {
        let lo = 0, hi = words.length - 1, first = words.length;
        while (lo <= hi) { const m = (lo + hi) >> 1; if (words[m].end >= t0) { first = m; hi = m - 1; } else lo = m + 1; }
        bg.font = `500 11px ${fontBody()}`;
        bg.textBaseline = 'middle';
        for (let i = first; i < words.length; i++) {
          const w = words[i];
          if (w.start > t1) break;
          const x = Math.round(xOf(w.start)) + 0.5;
          const x2 = xOf(w.end);
          bg.strokeStyle = w.guessed ? 'rgba(232,255,0,0.35)' : 'rgba(255,0,184,0.45)';
          bg.setLineDash(w.guessed ? [3, 3] : []);
          bg.beginPath(); bg.moveTo(x, 0); bg.lineTo(x, wb); bg.stroke();
          bg.setLineDash([]);
          const room = x2 - x - 5;
          if (room > 26) {
            let label = w.text;
            while (label.length > 1 && bg.measureText(label).width > room) label = label.slice(0, -1);
            if (label.length < w.text.length) label = label.slice(0, -1) + '…';
            bg.fillStyle = 'rgba(232,236,248,0.92)';
            bg.fillText(label, x + 4, WORD_BAND / 2 + 1);
          }
        }
        bg.textBaseline = 'alphabetic';
      }
    }

    // overview strip
    const oy = H - OVERVIEW_H;
    bg.fillStyle = 'rgba(11,11,20,0.55)';
    bg.fillRect(0, oy, W, OVERVIEW_H);
    if (peaks && dur > 0) {
      if (!ov || ov.length !== W) {
        ov = new Float32Array(W);
        for (let x = 0; x < W; x++) {
          const [mn, mx] = columnRange((x / W) * dur, ((x + 1) / W) * dur);
          ov[x] = Math.min(1, Math.max(-mn, mx) / peakScale);
        }
      }
      bg.fillStyle = 'rgba(0,230,255,0.55)';
      const oc = oy + OVERVIEW_H / 2;
      for (let x = 0; x < W; x++) {
        const h = Math.max(1, ov[x] * (OVERVIEW_H / 2 - 2));
        bg.fillRect(x, oc - h, 1, h * 2);
      }
    }
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function draw() {
    raf = 0;
    if (!W) return;
    if (dirtyBase) paintBase();
    dirtyAny = false;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, canvas.width, canvas.height);
    g.drawImage(base, 0, 0);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (dur <= 0) return;
    const wb = waveBottom();
    const oy = H - OVERVIEW_H;

    // other clips
    for (const m of markers) {
      if (region && region.id && m.id === region.id) continue;
      const xa = xOf(m.start), xb = xOf(m.end);
      if (xb < 0 || xa > W) continue;
      g.fillStyle = 'rgba(138,0,255,0.20)';
      g.fillRect(xa, waveTop, Math.max(2, xb - xa), wb - waveTop);
      g.fillStyle = 'rgba(138,0,255,0.9)';
      g.fillRect(xa, waveTop, 1.5, wb - waveTop);
      g.fillRect(xb - 1.5, waveTop, 1.5, wb - waveTop);
    }

    // region
    if (region) {
      const xa = xOf(region.start), xb = xOf(region.end);
      const ca = Math.max(-2, xa), cb = Math.min(W + 2, xb);
      if (cb > ca) {
        g.fillStyle = 'rgba(255,0,184,0.20)';
        g.fillRect(ca, 0, cb - ca, wb);
        g.fillStyle = 'rgba(255,0,184,0.06)';
        g.fillRect(ca, wb, cb - ca, RULER_H);
      }
      const edge = (x, which) => {
        if (x < -12 || x > W + 12) return;
        g.save();
        g.shadowColor = PINK; g.shadowBlur = 10;
        g.fillStyle = PINK;
        g.fillRect(Math.round(x) - 1, 0, 2, wb);
        g.restore();
        if (region.editable) {
          const dir = which === 'start' ? -1 : 1;
          const kw = 14, kh = 34, ky = (waveTop + wb) / 2 - kh / 2;
          const kx = dir < 0 ? x - kw : x;
          g.save();
          g.shadowColor = 'rgba(255,0,184,0.9)'; g.shadowBlur = dragLabel === which ? 16 : 8;
          g.fillStyle = dragLabel === which ? '#fff' : PINK;
          roundRect(g, kx, ky, kw, kh, 5);
          g.fill();
          g.restore();
          g.strokeStyle = dragLabel === which ? PINK : '#0B0B14';
          g.lineWidth = 1.5;
          g.beginPath();
          for (const o of [-3, 0, 3]) { g.moveTo(kx + kw / 2 + o, ky + 9); g.lineTo(kx + kw / 2 + o, ky + kh - 9); }
          g.stroke();
        }
      };
      edge(xa, 'start');
      edge(xb, 'end');

      if (dragLabel) {
        const t = dragLabel === 'start' ? region.start : region.end;
        const x = dragLabel === 'start' ? xa : xb;
        const txt = fmt(t, 3);
        g.font = `700 11px ${fontMono()}`;
        const tw = g.measureText(txt).width + 12;
        let lx = dragLabel === 'start' ? x - tw - 16 : x + 16;
        lx = Math.max(2, Math.min(W - tw - 2, lx));
        g.fillStyle = 'rgba(11,11,20,0.92)';
        roundRect(g, lx, waveTop + 4, tw, 20, 6); g.fill();
        g.strokeStyle = PINK; g.lineWidth = 1; g.stroke();
        g.fillStyle = '#fff';
        g.fillText(txt, lx + 6, waveTop + 18);
      }
    }

    // playhead
    if (playhead != null && playhead >= t0 && playhead <= t1) {
      const x = Math.round(xOf(playhead));
      g.save();
      g.shadowColor = YELLOW; g.shadowBlur = 12;
      g.fillStyle = '#fff';
      g.fillRect(x - 1, 0, 2, wb);
      g.beginPath(); g.moveTo(x - 6, 0); g.lineTo(x + 6, 0); g.lineTo(x, 8); g.closePath();
      g.fillStyle = YELLOW; g.fill();
      g.restore();
    }

    // overview viewport + region + playhead
    if (dur > 0) {
      const vx = (t0 / dur) * W, vw = Math.max(6, ((t1 - t0) / dur) * W);
      g.fillStyle = 'rgba(0,230,255,0.14)';
      g.fillRect(vx, oy, vw, OVERVIEW_H);
      g.strokeStyle = CYAN; g.lineWidth = 1.5;
      g.strokeRect(vx + 0.75, oy + 0.75, vw - 1.5, OVERVIEW_H - 1.5);
      if (region) {
        g.fillStyle = 'rgba(255,0,184,0.85)';
        g.fillRect((region.start / dur) * W, oy, Math.max(2, ((region.end - region.start) / dur) * W), 4);
      }
      if (playhead != null) {
        g.fillStyle = '#fff';
        g.fillRect((playhead / dur) * W - 1, oy, 2, OVERVIEW_H);
      }
    }
  }

  // ---- view control -------------------------------------------------------
  function setView(a, b, quiet) {
    t0 = a; t1 = b;
    clampView();
    schedule(true);
    if (!quiet && hooks.onView) hooks.onView(t0, t1);
  }
  function zoomAt(factor, tAnchor) {
    if (dur <= 0) return;
    const span = t1 - t0;
    const ns = Math.min(dur, Math.max(MIN_SPAN, span * factor));
    const frac = span > 0 ? (tAnchor - t0) / span : 0.5;
    setView(tAnchor - frac * ns, tAnchor - frac * ns + ns);
  }
  function anchorTime() {
    if (region) return (region.start + region.end) / 2;
    if (playhead != null && playhead >= t0 && playhead <= t1) return playhead;
    return (t0 + t1) / 2;
  }

  // ---- pointer interaction ------------------------------------------------
  function handleAt(x, y) {
    if (!region || !region.editable) return null;
    if (y > waveBottom() || y < 0) return null;
    const xa = xOf(region.start), xb = xOf(region.end);
    const da = Math.abs(x - xa), db = Math.abs(x - xb);
    // knobs sit outside the region, so widen the target on the outer side
    const near = (xe, outer) => (x >= xe - (outer < 0 ? GRAB + 8 : GRAB) && x <= xe + (outer > 0 ? GRAB + 8 : GRAB));
    const hitA = near(xa, -1), hitB = near(xb, 1);
    if (hitA && hitB) return da <= db ? 'start' : 'end';
    if (hitA) return 'start';
    if (hitB) return 'end';
    return null;
  }

  function localXY(e) {
    const r = canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  function setCursor(c) {
    if (c !== hoverCursor) { hoverCursor = c; canvas.style.cursor = c; }
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (dur <= 0) return;
    canvas.setPointerCapture(e.pointerId);
    const [x, y] = localXY(e);
    pointers.set(e.pointerId, { x, y });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      mode = 'pinch';
      drag = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1 };
      return;
    }
    if (y >= H - OVERVIEW_H) {
      mode = 'overview';
      const span = t1 - t0;
      const c = (x / W) * dur;
      setView(c - span / 2, c + span / 2);
      return;
    }
    const h = handleAt(x, y);
    if (h) {
      mode = 'handle';
      const edgeT = h === 'start' ? region.start : region.end;
      drag = { which: h, off: tOf(x) - edgeT };
      dragLabel = h;
      schedule(false);
      return;
    }
    mode = 'pan';
    drag = { x0: x, y0: y, t0at: t0, span: t1 - t0, moved: false };
  });

  canvas.addEventListener('pointermove', (e) => {
    const [x, y] = localXY(e);
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x, y });
    if (mode === 'pinch' && pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const mx = (a.x + b.x) / 2;
      zoomAt(drag.d / d, tOf(mx));
      drag.d = d;
      return;
    }
    if (mode === 'overview') {
      const span = t1 - t0;
      const c = (Math.max(0, Math.min(W, x)) / W) * dur;
      setView(c - span / 2, c + span / 2);
    } else if (mode === 'handle') {
      let t = tOf(Math.max(0, Math.min(W, x))) - drag.off;
      t = Math.max(0, Math.min(dur, t));
      if (drag.which === 'start') region.start = Math.min(t, region.end - 0.02);
      else region.end = Math.max(t, region.start + 0.02);
      schedule(false);
      if (hooks.onRegionChange) hooks.onRegionChange({ start: region.start, end: region.end, which: drag.which }, false);
    } else if (mode === 'pan') {
      const dx = x - drag.x0;
      if (!drag.moved && Math.abs(dx) > 4) { drag.moved = true; canvas.classList.add('panning'); }
      if (drag.moved) {
        const dt = (dx / W) * drag.span;
        const a = drag.t0at - dt;
        setView(a, a + drag.span);
      }
    } else if (!e.buttons) {
      if (y >= H - OVERVIEW_H) setCursor('ew-resize');
      else if (handleAt(x, y)) setCursor('col-resize');
      else setCursor('pointer');
    }
  });

  function endPointer(e, cancelled) {
    const [x] = localXY(e);
    pointers.delete(e.pointerId);
    if (mode === 'pinch') { if (pointers.size < 2) mode = null; return; }
    if (mode === 'handle') {
      dragLabel = null;
      schedule(false);
      if (!cancelled && hooks.onRegionChange) hooks.onRegionChange({ start: region.start, end: region.end, which: drag.which }, true);
    } else if (mode === 'pan') {
      canvas.classList.remove('panning');
      if (!cancelled && !drag.moved) {
        const t = tOf(x);
        const hit = markers.find((m) => t >= m.start && t <= m.end && !(region && region.id === m.id));
        if (hit && hooks.onMarkerClick && !(region && t >= region.start && t <= region.end)) hooks.onMarkerClick(hit.id, t);
        else if (hooks.onSeek) hooks.onSeek(t);
      }
    }
    mode = null; drag = null;
  }
  canvas.addEventListener('pointerup', (e) => endPointer(e, false));
  canvas.addEventListener('pointercancel', (e) => endPointer(e, true));

  canvas.addEventListener('wheel', (e) => {
    if (dur <= 0) return;
    e.preventDefault();
    const [x] = localXY(e);
    if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      const d = (e.deltaX || e.deltaY) / W * (t1 - t0);
      setView(t0 + d, t1 + d);
    } else {
      zoomAt(Math.exp(e.deltaY * 0.0018), tOf(x));
    }
  }, { passive: false });

  canvas.addEventListener('dblclick', () => { /* reserved: double-click does nothing special */ });

  // ---- public API ---------------------------------------------------------
  const api = {
    setSource(src) {
      pointers.clear(); mode = null;
      if (!src) { dur = 0; peaks = null; words = []; ov = null; region = null; markers = []; playhead = null; schedule(true); return; }
      dur = src.duration || 0;
      peaks = src.peaks || null;
      words = src.words || [];
      peakScale = 0.2;
      if (peaks) {
        for (let i = 0; i < peaks.max.length; i += 1) {
          const a = Math.max(peaks.max[i], -peaks.min[i]);
          if (a > peakScale) peakScale = a;
        }
      }
      ov = null;
      region = null; markers = []; playhead = null;
      t0 = 0; t1 = dur || 1;
      clampView();
      schedule(true);
    },
    /** Words changed (live transcription) without resetting the view. */
    setWords(w) { words = w || []; schedule(true); },
    setRegion(r, opts = {}) {
      region = r ? { start: r.start, end: r.end, editable: !!r.editable, id: r.id || null } : null;
      if (region && opts.focus) api.focusRegion();
      schedule(false);
    },
    setMarkers(list) { markers = list || []; schedule(false); },
    setPlayhead(t, opts = {}) {
      playhead = t == null ? null : t;
      if (playhead != null && (opts.follow || follow) && (playhead < t0 || playhead > t1) && !mode) {
        const span = t1 - t0;
        setView(playhead - span * 0.1, playhead + span * 0.9, true);
      }
      schedule(false);
    },
    setFollow(v) { follow = !!v; },
    zoomIn() { zoomAt(0.5, anchorTime()); },
    zoomOut() { zoomAt(2, anchorTime()); },
    fit() { setView(0, dur || 1); },
    focusRegion() {
      if (!region || dur <= 0) return;
      const span = region.end - region.start;
      const margin = Math.max(0.35, span * 0.6);
      let a = region.start - margin, b = region.end + margin;
      if (b - a < 0.8) { const c = (a + b) / 2; a = c - 0.4; b = c + 0.4; }
      setView(a, b, true);
    },
    /** Scroll (don't zoom) so a time is visible. */
    reveal(t) {
      if (t >= t0 && t <= t1) return;
      const span = t1 - t0;
      setView(t - span / 2, t + span / 2, true);
    },
    get view() { return [t0, t1]; },
    get duration() { return dur; },
    resize,
    redraw() { schedule(true); },
    canvas,
    destroy() { ro.disconnect(); if (raf) cancelAnimationFrame(raf); },
  };
  resize();
  return api;
}
