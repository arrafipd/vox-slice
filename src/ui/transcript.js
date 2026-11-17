// The transcript: one span per word, pointer-driven selection, class-only updates.
import { state, on, activeSource, getSource, setSelection, clearSelection, srcMeta } from './state.js';
import { el, tid, clear } from './dom.js';
import { playWord } from './transport.js';

let box;
let els = [];          // word spans of the active source
let shownId = null;
let paintedSel = [-1, -2];
let inClipFlags = [];
let hitFlags = new Set();
let playIdx = -1;
let dragging = false;
let anchor = null;
let touchTimer = 0;
let touchStart = null;

const wordIdx = (n) => {
  const s = n && n.closest ? n.closest('.w') : null;
  return s ? +s.dataset.i : null;
};

export function renderTranscript() {
  const src = activeSource();
  const keepScroll = shownId === (src && src.id) ? box.scrollTop : 0;
  clear(box);
  els = [];
  inClipFlags = [];
  paintedSel = [-1, -2];
  playIdx = -1;
  shownId = src ? src.id : null;
  box.classList.remove('empty');
  if (!src) {
    box.classList.add('empty');
    box.append(el('p', { class: 'empty-note', text: 'Your transcript lands here. Drop a speech file to get started.' }));
    return;
  }
  const m = srcMeta(src.id);
  if (!src.words.length) {
    box.classList.add('empty');
    let msg = 'No words found in this file.';
    if (m.status === 'queued') msg = 'Waiting in the queue...';
    else if (m.status === 'decoding' || m.status === 'transcribing') msg = 'Listening hard. Words will pop up here as they are found.';
    else if (m.status === 'cancelled') msg = 'Cancelled. Use Retry in the library strip to transcribe it again.';
    else if (m.status === 'failed') msg = 'That one failed. Use Retry in the library strip.';
    box.append(el('p', { class: 'empty-note', text: msg }));
    return;
  }
  const frag = document.createDocumentFragment();
  src.words.forEach((w, i) => {
    const s = document.createElement('span');
    s.className = w.guessed ? 'w guess' : 'w';
    s.dataset.source = src.id;
    s.dataset.i = String(i);
    s.textContent = w.text;
    if (w.guessed) s.title = 'Timing is a guess';
    frag.append(s, document.createTextNode(' '));
    els.push(s);
  });
  box.append(frag);
  paintClips();
  paintHits();
  paintSelection();
  if (m.status === 'transcribing') box.scrollTop = box.scrollHeight;
  else box.scrollTop = keepScroll;
}

export function paintSelection() {
  const s = state.sel && state.sel.sourceId === shownId ? state.sel : null;
  const [olo, ohi] = paintedSel;
  const lo = s ? s.a : -1, hi = s ? s.b : -2;
  if (olo === lo && ohi === hi) return;
  for (let i = Math.max(0, olo); i <= ohi && i < els.length; i++) {
    if (i < lo || i > hi) els[i].classList.remove('sel', 'sel-start', 'sel-end');
  }
  for (let i = Math.max(0, lo); i <= hi && i < els.length; i++) {
    const e = els[i];
    e.classList.add('sel');
    e.classList.toggle('sel-start', i === lo);
    e.classList.toggle('sel-end', i === hi);
  }
  paintedSel = [lo, hi];
}

export function paintClips() {
  const flags = new Array(els.length).fill(false);
  for (const c of state.clips) {
    if (c.sourceId !== shownId) continue;
    for (let i = c.i0; i <= c.i1 && i < flags.length; i++) flags[i] = true;
  }
  for (let i = 0; i < els.length; i++) {
    if (flags[i] !== !!inClipFlags[i]) els[i].classList.toggle('inclip', flags[i]);
  }
  inClipFlags = flags;
}

export function paintHits() {
  const next = new Set();
  for (const m of state.matches) {
    if (m.sourceId !== shownId) continue;
    for (let i = m.i0; i <= m.i1; i++) next.add(i);
  }
  for (const i of hitFlags) if (!next.has(i) && els[i]) els[i].classList.remove('hit');
  for (const i of next) if (els[i]) els[i].classList.add('hit');
  hitFlags = next;
}

function wordAtTime(src, t) {
  const w = src.words;
  let lo = 0, hi = w.length - 1, ans = -1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (w[m].start <= t) { ans = m; lo = m + 1; } else hi = m - 1;
  }
  if (ans >= 0 && t > w[ans].end + 0.25) return -1;
  return ans;
}

function paintPlaying(t, sourceId) {
  let idx = -1;
  if (t != null && sourceId === shownId) {
    const src = getSource(sourceId);
    if (src) idx = wordAtTime(src, t);
  }
  if (idx === playIdx) return;
  if (els[playIdx]) els[playIdx].classList.remove('playing');
  playIdx = idx;
  const e = els[idx];
  if (e) {
    e.classList.add('playing');
    const top = e.offsetTop, h = e.offsetHeight;
    if (top < box.scrollTop + 8 || top + h > box.scrollTop + box.clientHeight - 8) {
      box.scrollTo({ top: Math.max(0, top - box.clientHeight / 2), behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    }
  }
}

/** Scroll a word into view (for search jumps and clip selection). */
export function revealWord(i) {
  const e = els[i];
  if (!e) return;
  const top = e.offsetTop;
  if (top < box.scrollTop + 10 || top + e.offsetHeight > box.scrollTop + box.clientHeight - 10) {
    box.scrollTo({ top: Math.max(0, top - box.clientHeight / 2), behavior: 'auto' });
  }
}

// ---- pointer selection -----------------------------------------------------
function endDrag() {
  dragging = false;
  clearTimeout(touchTimer);
  touchStart = null;
  box.classList.remove('dragging');
}

function begin(e, i) {
  const src = activeSource();
  if (!src) return;
  if (e.shiftKey && state.sel && state.sel.sourceId === src.id) {
    const a = state.sel.anchor;
    setSelection(src.id, a, i, a);
  } else {
    anchor = i;
    setSelection(src.id, i, i, i);
  }
  dragging = true;
  box.classList.add('dragging');
}

function onDown(e) {
  if (e.button != null && e.button > 0) return;
  const i = wordIdx(e.target);
  if (i == null) {
    if (e.target === box) clearSelection();
    return;
  }
  if (e.detail > 1) return; // dblclick handled separately
  if (e.pointerType === 'touch') {
    // Tap selects a word; hold for a moment, then drag to sweep a run.
    touchStart = { x: e.clientX, y: e.clientY, i };
    clearTimeout(touchTimer);
    touchTimer = setTimeout(() => {
      if (!touchStart) return;
      begin({ shiftKey: false }, touchStart.i);
      if (navigator.vibrate) { try { navigator.vibrate(8); } catch { /* ignore */ } }
    }, 260);
    return;
  }
  e.preventDefault();
  // preventDefault stops the browser moving focus, so a button clicked earlier would keep it and
  // swallow the next Enter or Space. Park focus on the transcript instead.
  if (document.activeElement !== box) box.focus({ preventScroll: true });
  begin(e, i);
}

function onMove(e) {
  if (e.pointerType === 'touch' && touchStart && !dragging) {
    if (Math.hypot(e.clientX - touchStart.x, e.clientY - touchStart.y) > 9) { clearTimeout(touchTimer); touchStart = null; }
    return;
  }
  if (!dragging) return;
  const n = document.elementFromPoint(e.clientX, e.clientY);
  const i = wordIdx(n);
  if (i == null) return;
  const src = activeSource();
  if (!src) return;
  const a = state.sel ? state.sel.anchor : anchor;
  if (state.sel && state.sel.a === Math.min(a, i) && state.sel.b === Math.max(a, i)) return;
  setSelection(src.id, a, i, a);
}

function onUp(e) {
  if (e.pointerType === 'touch' && touchStart && !dragging) {
    // plain tap
    const src = activeSource();
    if (src) { anchor = touchStart.i; setSelection(src.id, touchStart.i, touchStart.i, touchStart.i); }
  }
  endDrag();
}

export function initTranscript() {
  box = tid('transcript');
  box.setAttribute('role', 'group');
  box.tabIndex = -1;
  box.setAttribute('aria-label', 'Transcript. Click or drag across words to select them.');
  box.addEventListener('pointerdown', onDown);
  box.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', endDrag);
  box.addEventListener('touchmove', (e) => { if (dragging) e.preventDefault(); }, { passive: false });
  box.addEventListener('dblclick', (e) => {
    const i = wordIdx(e.target);
    if (i == null) return;
    const src = activeSource();
    if (src) playWord(src.id, i);
  });
  on('active', renderTranscript);
  on('words', (e) => { if (e.detail === shownId) renderTranscript(); else if (!shownId) renderTranscript(); });
  on('sources', () => {
    const src = activeSource();
    if (!src) { if (shownId) renderTranscript(); return; }
    if (!src.words.length || shownId !== src.id) renderTranscript();
  });
  on('selection', paintSelection);
  on('clips', paintClips);
  on('matches', paintHits);
  on('tick', (e) => paintPlaying(e.detail.t, e.detail.sourceId));
  renderTranscript();
}
