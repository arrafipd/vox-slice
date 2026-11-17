// Tightens Whisper's word times against the audio itself.
//
// Whisper's word times come from its attention maps. Measured against real audio they have two habits:
// a word's start is reported a little late (about 0.1 s), and a word before a pause is given the whole
// pause as well. Both make clips that chop the first sound off a word and drag in the next one.
//
// The fix needs no second model. We find the pauses in the audio (plain loudness), and then:
//   1. a word that follows a pause starts where the sound really starts;
//   2. the lag seen on those words is taken off every other word in the same stretch of audio;
//   3. a word that is followed by a pause ends where the sound stops, plus a short tail.
// Pure functions, no DOM, so they run in the worker and in unit tests.

const HOP_S = 0.01;          // loudness frame step
const MIN_PAUSE_S = 0.14;    // shorter dips are stop consonants, not pauses
const LOOK_BACK_S = 0.32;    // how far before Whisper's start the real start may be
const LOOK_AHEAD_S = 0.05;   // ...and how far after
const DEFAULT_LAG_S = 0.08;  // used when a stretch has too few pauses to measure
const MAX_LAG_S = 0.2;
const TAIL_S = 0.04;         // kept after the sound stops, so endings are not clipped
const MIN_WORD_S = 0.05;

/** Loudness (RMS) per 10 ms frame. */
export function frameLevels(audio, sr) {
  const hop = Math.max(1, Math.round(sr * HOP_S));
  const n = Math.floor(audio.length / hop);
  const out = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    let e = 0;
    const a = f * hop;
    for (let j = a; j < a + hop; j++) e += audio[j] * audio[j];
    out[f] = Math.sqrt(e / hop);
  }
  return { levels: out, hopSec: hop / sr };
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))];
}

/**
 * Pauses in the audio as [startSec, endSec] pairs. The threshold sits between the background level and
 * the speech level, so it still works on a noisy recording. Returns [] when there is no clear contrast.
 */
export function findPauses(audio, sr) {
  const { levels, hopSec } = frameLevels(audio, sr);
  if (levels.length < 10) return [];
  const sorted = Float32Array.from(levels).sort();
  const floor = percentile(sorted, 0.08);
  const speech = percentile(sorted, 0.95);
  if (!(speech > 0) || speech < floor * 4) return []; // no usable contrast: leave the times alone
  const thr = Math.max(floor * 2.2, speech * 0.035);
  const minFrames = Math.round(MIN_PAUSE_S / hopSec);
  const pauses = [];
  let s = -1;
  for (let f = 0; f <= levels.length; f++) {
    const quiet = f < levels.length && levels[f] < thr;
    if (quiet && s < 0) s = f;
    else if (!quiet && s >= 0) {
      // the very start and very end of the audio count as pauses however short they are
      if (f - s >= minFrames || s === 0 || f === levels.length) pauses.push([s * hopSec, f * hopSec]);
      s = -1;
    }
  }
  return pauses;
}

/**
 * words: [{ text, start, end, guessed? }] with times in seconds from the start of `audio`.
 * Returns new word objects with tightened times, in the same order.
 */
export function refineWords(words, audio, sr) {
  if (!words || !words.length) return [];
  const dur = audio.length / sr;
  const pauses = findPauses(audio, sr);
  if (!pauses.length) return words.map((w) => ({ ...w }));

  // 1. words that follow a pause: the real start is where that pause ends
  const snapped = new Array(words.length).fill(null);
  const lags = [];
  let pi = 0;
  for (let i = 0; i < words.length; i++) {
    const s = words[i].start;
    const earliest = i ? Math.max(words[i - 1].start + MIN_WORD_S, s - LOOK_BACK_S) : s - LOOK_BACK_S;
    while (pi < pauses.length && pauses[pi][1] < earliest) pi++;
    let best = null;
    for (let k = pi; k < pauses.length && pauses[k][1] <= s + LOOK_AHEAD_S; k++) best = pauses[k];
    if (best && best[1] >= earliest) {
      snapped[i] = best[1];
      lags.push(s - best[1]);
    }
  }

  // 2. the usual lag in this stretch of audio
  let lag = DEFAULT_LAG_S;
  if (lags.length >= 3) {
    lags.sort((a, b) => a - b);
    lag = lags[lags.length >> 1];
  }
  lag = Math.max(0, Math.min(MAX_LAG_S, lag));

  const starts = words.map((w, i) => (snapped[i] != null ? snapped[i] : Math.max(0, w.start - lag)));
  for (let i = 1; i < starts.length; i++) {
    if (starts[i] < starts[i - 1] + MIN_WORD_S) starts[i] = Math.min(dur, starts[i - 1] + MIN_WORD_S);
  }

  // 3. ends: up to the next word, or to where the sound stops if a pause comes first
  const out = [];
  let pj = 0;
  for (let i = 0; i < words.length; i++) {
    const s = starts[i];
    const next = i + 1 < words.length ? starts[i + 1] : dur;
    let e = i + 1 < words.length ? next : Math.min(dur, Math.max(s + MIN_WORD_S, words[i].end - lag));
    while (pj < pauses.length && pauses[pj][1] <= s + MIN_WORD_S) pj++;
    let q = pj;
    while (q < pauses.length && pauses[q][0] <= s) q++;
    const p = pauses[q];
    // Only a pause that runs right up to the next word (or the end) counts. A dip in the middle of a
    // word, like the stop in "bakery", must not cut the word short.
    if (p && p[0] < e && p[1] >= next - 0.06) e = Math.min(e, p[0] + TAIL_S);
    if (e < s + MIN_WORD_S) e = Math.min(dur, s + MIN_WORD_S);
    if (e <= s) e = s + 0.02;
    let st = s;
    if (e > dur) { e = dur; if (st > e - 0.02) st = Math.max(0, e - 0.02); }
    const w = { ...words[i], start: st, end: e };
    out.push(w);
  }
  return out;
}
