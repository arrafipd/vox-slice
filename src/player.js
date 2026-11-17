// Web Audio playback: one voice at a time, short fades so nothing clicks,
// loops whose edges can move while they play, and stitched previews.
import { getAudioContext, audioToBuffer } from './audio.js';

const FADE = 0.006; // seconds
let cur = null; // the active voice
let rafId = 0;

function ctx() {
  const c = getAudioContext();
  if (c.state === 'suspended') c.resume().catch(() => {});
  return c;
}

function tickLoop() {
  rafId = 0;
  if (!cur) return;
  if (cur.onTick) {
    try { cur.onTick(position()); } catch { /* UI errors must not stop audio */ }
  }
  rafId = requestAnimationFrame(tickLoop);
}

function finish(voice, natural) {
  if (cur !== voice) return;
  cur = null;
  if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
  if (voice.onEnded) {
    try { voice.onEnded(natural); } catch { /* ignore */ }
  }
}

/** Stop whatever is playing (with a quick fade-out). */
export function stop() {
  const v = cur;
  if (!v) return;
  const c = getAudioContext();
  try {
    const t = c.currentTime;
    v.gain.gain.cancelScheduledValues(t);
    v.gain.gain.setValueAtTime(v.gain.gain.value, t);
    v.gain.gain.linearRampToValueAtTime(0, t + FADE);
    v.src.onended = null;
    v.src.stop(t + FADE + 0.004);
  } catch { /* already stopped */ }
  finish(v, false);
}

export function isPlaying() { return !!cur; }
export function currentKind() { return cur ? cur.kind : null; }

/** Current position on the source timeline in seconds (null when idle or for stitched audio). */
export function position() {
  const v = cur;
  if (!v || v.kind !== 'range') return null;
  const c = getAudioContext();
  const elapsed = Math.max(0, c.currentTime - v.t0);
  if (v.loop) {
    const len = Math.max(0.001, v.end - v.start);
    return v.start + (((v.base - v.start) + elapsed) % len + len) % len;
  }
  return Math.min(v.end, v.base + elapsed);
}

/**
 * Play buffer[start, end]. With loop, repeats until stop().
 * Returns a handle { stop }.
 */
export function playRange(buffer, start, end, { loop = false, onEnded, onTick } = {}) {
  stop();
  if (!buffer) return null;
  const c = ctx();
  start = Math.max(0, start);
  end = Math.min(buffer.duration, end);
  if (end - start < 0.02) end = Math.min(buffer.duration, start + 0.02);
  const src = c.createBufferSource();
  src.buffer = buffer;
  const gain = c.createGain();
  src.connect(gain).connect(c.destination);
  const now = c.currentTime + 0.01;
  const dur = end - start;
  const v = { kind: 'range', src, gain, start, end, base: start, t0: now, loop, onEnded, onTick };
  if (loop) {
    src.loop = true;
    src.loopStart = start;
    src.loopEnd = end;
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(1, now + FADE);
    src.start(now, start);
  } else {
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(1, now + Math.min(FADE, dur / 3));
    const f = Math.min(FADE, dur / 3);
    gain.gain.setValueAtTime(1, now + dur - f);
    gain.gain.linearRampToValueAtTime(0, now + dur);
    src.start(now, start, dur);
  }
  src.onended = () => finish(v, true);
  cur = v;
  if (onTick) rafId = requestAnimationFrame(tickLoop);
  return { stop: () => { if (cur === v) stop(); } };
}

/** Move the loop edges while it plays. The playhead keeps its place when it can. */
export function updateLoop(start, end) {
  const v = cur;
  if (!v || v.kind !== 'range' || !v.loop) return;
  const c = getAudioContext();
  start = Math.max(0, start);
  end = Math.min(v.src.buffer.duration, end);
  if (end - start < 0.02) end = Math.min(v.src.buffer.duration, start + 0.02);
  const pos = position();
  v.base = Math.min(end, Math.max(start, pos == null ? start : pos));
  v.t0 = c.currentTime;
  v.start = start;
  v.end = end;
  try {
    // Set the end first when moving later, the start first when moving earlier,
    // so loopStart is never briefly greater than loopEnd.
    if (end >= v.src.loopEnd) { v.src.loopEnd = end; v.src.loopStart = start; }
    else { v.src.loopStart = start; v.src.loopEnd = end; }
  } catch { /* ignore */ }
}

/** Play stitched PCM (builder previews). */
export function playAudio(audio, { onEnded } = {}) {
  stop();
  const c = ctx();
  const buf = audioToBuffer(c, audio);
  const src = c.createBufferSource();
  src.buffer = buf;
  const gain = c.createGain();
  src.connect(gain).connect(c.destination);
  const now = c.currentTime + 0.01;
  gain.gain.setValueAtTime(0, now);
  gain.gain.linearRampToValueAtTime(1, now + FADE);
  const dur = buf.duration;
  gain.gain.setValueAtTime(1, now + Math.max(0, dur - FADE));
  gain.gain.linearRampToValueAtTime(0, now + dur);
  const v = { kind: 'audio', src, gain, onEnded };
  src.onended = () => finish(v, true);
  src.start(now);
  cur = v;
  return { stop: () => { if (cur === v) stop(); }, duration: dur };
}

/** Resume the audio context on the first user gesture (browsers start it suspended). */
export function unlockOnGesture() {
  const go = () => {
    try { ctx(); } catch { /* ignore */ }
    window.removeEventListener('pointerdown', go, true);
    window.removeEventListener('keydown', go, true);
  };
  window.addEventListener('pointerdown', go, true);
  window.addEventListener('keydown', go, true);
}
