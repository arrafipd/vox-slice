// Transcript toolbar + waveform wiring.
import { createWaveform } from '../waveform.js';
import {
  state, on, emit, activeSource, getClip, getSource, addClip, selectClip, setSelection, clearSelection, setStatus, hasAudio,
} from './state.js';
import { tid, $ } from './dom.js';
import { playSelection, playFrom, stopAll, clipEdgesChanged, playing } from './transport.js';
import { updateCardTimes } from './clips.js';
import { revealWord } from './transcript.js';
import { normToken } from '../library.js';

let wf;
let focusTimer = 0;
let lastKey = '';
let lastSig = '';

export function addSelectionAsClip() {
  const s = state.sel;
  if (!s) return null;
  const clip = addClip(s.sourceId, s.a, s.b);
  if (!clip) return null;
  state.sel = null; state.selOverride = null;
  selectClip(clip.id);
  const n = state.clips.length;
  setStatus(`Clip ${n} added: "${clip.text}". Drag the pink handles on the waveform to fine-tune the edges.`);
  return clip;
}

/** Move the end (or, with shift, the start) of the word selection by one word. */
export function adjustSelection(dir, shift) {
  const s = state.sel;
  if (!s) return false;
  const src = getSource(s.sourceId);
  if (!src) return false;
  if (!shift) {
    const b = Math.max(s.a, Math.min(src.words.length - 1, s.b + dir));
    setSelection(s.sourceId, s.a, b, s.a);
    revealWord(b);
  } else {
    const a = Math.min(s.b, Math.max(0, s.a + dir));
    setSelection(s.sourceId, a, s.b, s.b);
    revealWord(a);
  }
  return true;
}

function regionNow() {
  if (state.selClipId) {
    const c = getClip(state.selClipId);
    if (c && c.sourceId === state.activeId) return { start: c.start, end: c.end, editable: true, id: c.id, key: 'c' + c.id };
  }
  const s = state.sel;
  if (s && s.sourceId === state.activeId) {
    const src = getSource(s.sourceId);
    const ov = state.selOverride;
    const r = ov || (src && src.words[s.a] && src.words[s.b] ? { start: Math.max(0, src.words[s.a].start - state.settings.padMs / 1000), end: src.words[s.b].end + state.settings.padMs / 1000 } : null);
    if (r) return { start: r.start, end: r.end, editable: true, key: 's' + s.a + '-' + s.b };
  }
  return null;
}

function syncRegion() {
  const r = regionNow();
  if (!r) { wf.setRegion(null); lastKey = ''; return; }
  wf.setRegion(r);
  if (r.key !== lastKey) {
    lastKey = r.key;
    clearTimeout(focusTimer);
    focusTimer = setTimeout(() => wf.focusRegion(), 160);
  }
}

function syncMarkers() {
  const id = state.activeId;
  wf.setMarkers(state.clips.filter((c) => c.sourceId === id).map((c) => ({ id: c.id, start: c.start, end: c.end })));
}

function syncSource() {
  const src = activeSource();
  const sig = src ? `${src.id}|${src.duration}|${src.peaks ? 1 : 0}` : '';
  if (sig !== lastSig) {
    lastSig = sig; lastKey = '';
    wf.setSource(src);
  } else if (src) wf.setWords(src.words);
  syncMarkers();
  syncRegion();
  $('#wave-empty').hidden = !!(src && src.duration);
}

function updateToolbar() {
  const s = state.sel;
  const has = !!s;
  tid('add-clip-btn').disabled = !has;
  tid('play-sel-btn').disabled = !has || !hasAudio(getSource(s.sourceId));
  const single = has && s.a === s.b;
  const rb = document.getElementById('find-rhymes-btn');
  rb.disabled = !single;
  document.getElementById('sel-shrink-btn').disabled = !has;
  document.getElementById('sel-extend-btn').disabled = !has;
  const info = document.getElementById('sel-info');
  if (has) {
    const src = getSource(s.sourceId);
    const n = s.b - s.a + 1;
    const txt = src.words.slice(s.a, s.b + 1).map((w) => w.text).join(' ');
    info.textContent = `${n} ${n === 1 ? 'word' : 'words'} selected: ${txt.length > 70 ? txt.slice(0, 68) + '…' : txt}`;
  } else if (state.selClipId) info.textContent = 'Clip selected. Drag its pink handles to fine-tune.';
  else info.textContent = 'Click or drag across words. Double-click a word to hear it.';
  const ps = tid('play-sel-btn');
  const playingSel = playing.kind === 'sel';
  ps.classList.toggle('on', playingSel);
  ps.querySelector('span').textContent = playingSel ? 'Stop' : 'Play selection';
}

export function initWorkspace() {
  const wrap = tid('waveform');
  wf = createWaveform(wrap, {
    onSeek(t) {
      const src = activeSource();
      if (!src) return;
      const r = regionNow();
      const inside = r && t >= r.start && t <= r.end;
      if (!hasAudio(src)) { setStatus('Audio missing. Drop the original file to relink it.'); return; }
      playFrom(src.id, t, inside ? r.end : null);
    },
    onMarkerClick(id) { selectClip(id); },
    onRegionChange({ start, end }, final) {
      if (state.selClipId) {
        const c = getClip(state.selClipId);
        if (!c) return;
        c.start = start; c.end = end;
        updateCardTimes(c);
        clipEdgesChanged(c);
        wf.setMarkers(state.clips.filter((x) => x.sourceId === state.activeId).map((x) => ({ id: x.id, start: x.start, end: x.end })));
        if (final) emit('clipedit', c);
      } else if (state.sel) {
        state.selOverride = { start, end };
      }
    },
  });
  window.__voxWf = wf; // test hook used by tests/e2e/t_visual.mjs (read-only use)
  wf.setFollow(true);

  tid('add-clip-btn').addEventListener('click', addSelectionAsClip);
  tid('play-sel-btn').addEventListener('click', playSelection);
  document.getElementById('stop-btn').addEventListener('click', stopAll);
  document.getElementById('zoom-in-btn').addEventListener('click', () => wf.zoomIn());
  document.getElementById('zoom-out-btn').addEventListener('click', () => wf.zoomOut());
  document.getElementById('zoom-fit-btn').addEventListener('click', () => wf.fit());
  document.getElementById('zoom-sel-btn').addEventListener('click', () => wf.focusRegion());
  document.getElementById('sel-extend-btn').addEventListener('click', () => adjustSelection(1, false));
  document.getElementById('sel-shrink-btn').addEventListener('click', () => adjustSelection(-1, false));
  document.getElementById('find-rhymes-btn').addEventListener('click', () => {
    const s = state.sel; const src = s && getSource(s.sourceId);
    if (src && s.a === s.b) emit('rhyme-request', normToken(src.words[s.a].text));
  });
  document.getElementById('clear-sel-btn').addEventListener('click', clearSelection);

  on('active', syncSource);
  on('sources', syncSource);
  on('words', syncSource);
  on('relinked', () => { lastSig = ''; syncSource(); });
  on('selection', () => { syncRegion(); updateToolbar(); });
  on('clipselect', () => { syncRegion(); });
  on('clipedit', () => { syncMarkers(); syncRegion(); });
  on('clips', (e) => { if (!(e.detail && e.detail.refresh)) { syncMarkers(); syncRegion(); } });
  on('playstate', updateToolbar);
  on('tick', (e) => { wf.setPlayhead(e.detail.sourceId === state.activeId ? e.detail.t : null); });
  syncSource();
  updateToolbar();
}
