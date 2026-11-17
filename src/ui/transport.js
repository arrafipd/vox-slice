// Playback coordination: what is playing, loop state, playhead ticks.
import * as player from '../player.js';
import { state, emit, getSource, getClip, hasAudio, selectionTimes, setStatus, padSec, rangeFor } from './state.js';

export const playing = { kind: null, clipId: null, sourceId: null };

function noAudio(src) {
  setStatus(`The audio for ${src ? src.name : 'this speech'} is not loaded. Drop the original file to relink it.`);
}

function clearPlaying() {
  playing.kind = null; playing.clipId = null; playing.sourceId = null;
  emit('playstate');
  emit('tick', { sourceId: null, t: null });
}

function start(kind, src, a, b, { loop = false, clipId = null } = {}) {
  if (!hasAudio(src)) { noAudio(src); return false; }
  const token = Symbol('play');
  playing.token = null; // callbacks from the voice we are about to replace become no-ops
  const h = player.playRange(src.buffer, a, b, {
    loop,
    onTick: (t) => emit('tick', { sourceId: src.id, t }),
    onEnded: () => {
      if (playing.token !== token) return;
      if (state.loopClipId && kind === 'loop') state.loopClipId = null;
      clearPlaying();
      emit('clips', { refresh: true });
    },
  });
  if (!h) return false;
  playing.token = token;
  playing.kind = kind; playing.clipId = clipId; playing.sourceId = src.id;
  emit('playstate');
  return true;
}

export function stopAll() {
  const wasLoop = state.loopClipId;
  state.loopClipId = null;
  playing.token = null;
  player.stop();
  if (playing.kind) clearPlaying();
  if (wasLoop) emit('clips', { refresh: true });
}

export function isPlaying() { return player.isPlaying(); }

export function playSelection() {
  if (playing.kind === 'sel') { stopAll(); return; }
  const t = selectionTimes();
  if (!t) return;
  start('sel', getSource(t.sourceId), t.start, t.end);
}

export function playClip(id) {
  const c = getClip(id);
  if (!c) return;
  if (playing.kind === 'clip' && playing.clipId === id) { stopAll(); return; }
  state.loopClipId = null;
  start('clip', getSource(c.sourceId), c.start, c.end, { clipId: id });
  emit('clips', { refresh: true });
}

export function toggleLoop(id) {
  const c = getClip(id);
  if (!c) return;
  if (state.loopClipId === id) { stopAll(); return; }
  const src = getSource(c.sourceId);
  if (!hasAudio(src)) { noAudio(src); return; }
  state.loopClipId = id;
  if (!start('loop', src, c.start, c.end, { loop: true, clipId: id })) state.loopClipId = null;
  emit('clips', { refresh: true });
}

export function playWord(sourceId, i) {
  const src = getSource(sourceId);
  if (!src || !src.words[i]) return;
  const r = rangeFor(src, i, i, padSec());
  state.loopClipId = null;
  start('word', src, r.start, r.end);
}

export function playTake(match) {
  const src = getSource(match.sourceId);
  if (!src) return;
  const r = rangeFor(src, match.i0, match.i1, padSec());
  state.loopClipId = null;
  start('take', src, r.start, r.end);
}

/** Click on the waveform: play from that point (to the region end if inside it). */
export function playFrom(sourceId, t, regionEnd) {
  const src = getSource(sourceId);
  if (!src) return;
  state.loopClipId = null;
  start('seek', src, t, regionEnd != null && regionEnd > t ? regionEnd : src.duration);
}

/** Space bar: stop if playing, else the selected clip, else the selection. */
export function togglePlay() {
  if (player.isPlaying()) { stopAll(); return; }
  if (state.selClipId) playClip(state.selClipId);
  else playSelection();
}

/** A clip's edges moved: keep a running loop in sync. */
export function clipEdgesChanged(clip) {
  if (state.loopClipId === clip.id && player.isPlaying()) player.updateLoop(clip.start, clip.end);
}

export function stitched(audio, onEnded) {
  stopAll();
  playing.token = null;
  playing.kind = 'audio';
  emit('playstate');
  return player.playAudio(audio, { onEnded: () => { playing.kind = null; emit('playstate'); if (onEnded) onEnded(); } });
}
