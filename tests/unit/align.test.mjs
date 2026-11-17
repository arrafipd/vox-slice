import test from 'node:test';
import assert from 'node:assert/strict';
import { findPauses, refineWords } from '../../src/align.js';

const SR = 16000;
/** Builds audio from [seconds, amplitude] runs: a 220 Hz tone, or near-silence when amplitude is 0. */
function build(runs) {
  const total = runs.reduce((n, [s]) => n + Math.round(s * SR), 0);
  const out = new Float32Array(total);
  let p = 0;
  for (const [secs, amp] of runs) {
    const n = Math.round(secs * SR);
    for (let i = 0; i < n; i++) out[p + i] = amp ? amp * Math.sin((2 * Math.PI * 220 * i) / SR) : 0.0004 * Math.sin(i);
    p += n;
  }
  return out;
}
const near = (a, b, tol = 0.025) => assert.ok(Math.abs(a - b) <= tol, `${a} is not within ${tol} of ${b}`);

// silence 0.5 | speech 1.0 | silence 0.6 | speech 1.2 | silence 0.4
const audio = build([[0.5, 0], [1.0, 0.4], [0.6, 0], [1.2, 0.4], [0.4, 0]]);

test('findPauses finds the gaps between speech', () => {
  const p = findPauses(audio, SR);
  assert.equal(p.length, 3);
  near(p[0][0], 0); near(p[0][1], 0.5);
  near(p[1][0], 1.5); near(p[1][1], 2.1);
  near(p[2][0], 3.3); near(p[2][1], 3.7);
});

test('findPauses ignores dips shorter than a real pause', () => {
  const a = build([[0.3, 0], [0.5, 0.4], [0.08, 0], [0.5, 0.4], [0.3, 0]]);
  assert.equal(findPauses(a, SR).length, 2);
});

test('findPauses returns nothing for flat noise or silence', () => {
  assert.deepEqual(findPauses(new Float32Array(SR * 2), SR), []);
  assert.deepEqual(findPauses(build([[2, 0.3]]), SR), []);
});

test('late word starts are pulled back to where the sound starts', () => {
  // Whisper-style times: every start 0.1 s late, the word before a pause owns the whole pause
  const words = [
    { text: 'one', start: 0.6, end: 1.1 },
    { text: 'two', start: 1.1, end: 2.2 },
    { text: 'three', start: 2.2, end: 2.8 },
    { text: 'four', start: 2.8, end: 3.7 },
  ];
  const r = refineWords(words, audio, SR);
  near(r[0].start, 0.5);
  near(r[2].start, 2.1);
  assert.deepEqual(r.map((w) => w.text), ['one', 'two', 'three', 'four']);
});

test('a word before a pause ends where the sound stops, not where the next word starts', () => {
  const words = [
    { text: 'one', start: 0.6, end: 1.1 },
    { text: 'two', start: 1.1, end: 2.2 },
    { text: 'three', start: 2.2, end: 2.8 },
    { text: 'four', start: 2.8, end: 3.7 },
  ];
  const r = refineWords(words, audio, SR);
  near(r[1].end, 1.54, 0.03);
  near(r[3].end, 3.34, 0.03);
  assert.ok(r[1].end < r[2].start);
});

test('words in the middle of speech move back by the lag seen at the pauses', () => {
  const a = build([[0.5, 0], [1.0, 0.4], [0.5, 0], [1.0, 0.4], [0.5, 0], [1.0, 0.4], [0.5, 0]]);
  const lag = 0.12;
  const words = [
    { text: 'a', start: 0.5 + lag, end: 1.0 + lag }, { text: 'b', start: 1.0 + lag, end: 2.0 + lag },
    { text: 'c', start: 2.0 + lag, end: 2.5 + lag }, { text: 'd', start: 2.5 + lag, end: 3.5 + lag },
    { text: 'e', start: 3.5 + lag, end: 4.0 + lag }, { text: 'f', start: 4.0 + lag, end: 5.0 + lag },
  ];
  const r = refineWords(words, a, SR);
  near(r[1].start, 1.0); near(r[3].start, 2.5); near(r[5].start, 4.0);
  near(r[0].end, 1.0); // contiguous words still meet
});

test('times stay ordered, inside the audio, and never collapse', () => {
  const words = [
    { text: 'x', start: 0.0, end: 0.01 }, { text: 'y', start: 0.01, end: 0.02 }, { text: 'z', start: 0.02, end: 9 },
    { text: 'late', start: 3.69, end: 3.7, guessed: true },
  ];
  const r = refineWords(words, audio, SR);
  const dur = audio.length / SR;
  r.forEach((w, i) => {
    assert.ok(w.end > w.start, `word ${i} has no length`);
    assert.ok(w.start >= 0 && w.end <= dur + 1e-6, `word ${i} outside the audio`);
    if (i) assert.ok(w.start >= r[i - 1].start, `word ${i} goes backwards`);
  });
  assert.equal(r[3].guessed, true);
});

test('audio with no clear pauses leaves the times untouched', () => {
  const words = [{ text: 'a', start: 0.2, end: 0.9 }, { text: 'b', start: 0.9, end: 1.5 }];
  assert.deepEqual(refineWords(words, build([[2, 0.3]]), SR), words);
  assert.deepEqual(refineWords([], audio, SR), []);
});
