// The one shared app state, a tiny event bus, and helpers every UI module uses.

export const state = {
  sources: [],
  clips: [],
  busy: false,
  settings: {
    model: 'Xenova/whisper-base.en',
    padMs: 60,
    gapMs: 60,
    wav: true,
    mp3: false,
    normalize: false,
    trim: false,
    phraseNames: false, // name exported files from the phrase text
    packName: '',       // custom ZIP name (blank = automatic)
  },
  // UI state (not saved in projects)
  activeId: null,
  sel: null,          // { sourceId, anchor, a, b } word range, a <= b
  selOverride: null,  // { start, end } edge drag on a word selection
  selClipId: null,
  loopClipId: null,
  matches: [],
};

/** Per-source extras kept out of the source objects so projects stay clean. */
export const meta = new Map(); // sourceId -> { status, file, progress, error, note }

const target = new EventTarget();
export const on = (name, fn) => { target.addEventListener(name, fn); return () => target.removeEventListener(name, fn); };
export const emit = (name, detail) => target.dispatchEvent(new CustomEvent(name, { detail }));

let counter = 0;
export const uid = (p) => `${p}${Date.now().toString(36)}${(counter++).toString(36)}`;

export const getSource = (id) => state.sources.find((s) => s.id === id) || null;
export const activeSource = () => getSource(state.activeId);
export const getClip = (id) => state.clips.find((c) => c.id === id) || null;
export const srcMeta = (id) => meta.get(id) || {};
export const hasAudio = (s) => !!(s && s.buffer);

const busyReasons = new Set();
export function setBusy(reason, on_) {
  const before = state.busy;
  if (on_) busyReasons.add(reason); else busyReasons.delete(reason);
  state.busy = busyReasons.size > 0;
  if (before !== state.busy) {
    document.body.classList.toggle('is-busy', state.busy);
    emit('busy', state.busy);
  }
}

export const padSec = () => Math.max(0, state.settings.padMs) / 1000;

/** Absolute start/end seconds for a run of words, with padding. */
export function rangeFor(source, i0, i1, pad = padSec()) {
  const w = source.words;
  const dur = source.duration || (w.length ? w[w.length - 1].end : 0);
  return {
    start: Math.max(0, w[i0].start - pad),
    end: Math.min(dur || Infinity, w[i1].end + pad),
  };
}

export function textFor(source, i0, i1) {
  return source.words.slice(i0, i1 + 1).map((w) => w.text).join(' ');
}

// ---- status line (aria-live) ----------------------------------------------
export function setStatus(text) {
  emit('status', text);
}

// ---- active source / selection --------------------------------------------
export function setActive(id, { keepSel = false } = {}) {
  if (state.activeId === id) return;
  state.activeId = id;
  if (!keepSel) {
    state.sel = null;
    state.selOverride = null;
    state.selClipId = null;
  }
  emit('active', id);
  emit('selection');
}

export function setSelection(sourceId, a, b, anchor) {
  const src = getSource(sourceId);
  if (!src || !src.words.length) return;
  const max = src.words.length - 1;
  a = Math.max(0, Math.min(max, a));
  b = Math.max(0, Math.min(max, b));
  const lo = Math.min(a, b), hi = Math.max(a, b);
  state.sel = { sourceId, anchor: anchor == null ? lo : anchor, a: lo, b: hi };
  state.selOverride = null;
  state.selClipId = null;
  emit('selection');
}

export function clearSelection() {
  if (!state.sel && !state.selOverride) return;
  state.sel = null;
  state.selOverride = null;
  emit('selection');
}

export function selectClip(id) {
  state.selClipId = id;
  if (id) {
    state.sel = null;
    state.selOverride = null;
    const c = getClip(id);
    if (c && c.sourceId !== state.activeId) {
      state.activeId = c.sourceId;
      emit('active', c.sourceId);
    }
  }
  emit('selection');
  emit('clipselect', id);
}

/** Times of the current word selection (override from edge drags wins). */
export function selectionTimes() {
  const s = state.sel;
  if (!s) return null;
  const src = getSource(s.sourceId);
  if (!src) return null;
  if (state.selOverride) return { ...state.selOverride, sourceId: s.sourceId };
  const r = rangeFor(src, s.a, s.b);
  return { ...r, sourceId: s.sourceId };
}

// ---- clips ----------------------------------------------------------------
export function addClip(sourceId, i0, i1, { silent = false } = {}) {
  const src = getSource(sourceId);
  if (!src) return null;
  const r = state.selOverride && state.sel && state.sel.sourceId === sourceId && state.sel.a === i0 && state.sel.b === i1
    ? state.selOverride
    : rangeFor(src, i0, i1);
  const clip = {
    id: uid('c'),
    sourceId,
    i0, i1,
    text: textFor(src, i0, i1),
    start: r.start,
    end: Math.max(r.end, r.start + 0.02),
  };
  state.clips.push(clip);
  if (!silent) emit('clips', { added: [clip] });
  return clip;
}

export function removeClip(id) {
  const i = state.clips.findIndex((c) => c.id === id);
  if (i < 0) return;
  state.clips.splice(i, 1);
  if (state.selClipId === id) state.selClipId = null;
  if (state.loopClipId === id) state.loopClipId = null;
  emit('clips', { removed: [id] });
  emit('selection');
}

export function clipIndex(id) { return state.clips.findIndex((c) => c.id === id); }
