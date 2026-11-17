import test from 'node:test';
import assert from 'node:assert/strict';
import { sliceAudio, normalizeAudio, trimSilence, joinAudio, computePeaks, probeWavDuration } from '../../src/audio.js';
import { encodeWav } from '../../src/encode.js';
import { fakeBuffer, constant, sine } from './helpers.mjs';

test('sliceAudio bounds and fades', () => {
  const buf = fakeBuffer(1000, [constant(1000, 1)]);
  const a = sliceAudio(buf, 0.1, 0.5, { fadeMs: 10 });
  assert.equal(a.sr, 1000);
  assert.equal(a.chans[0].length, 400);
  assert.equal(a.chans[0][0], 0);
  assert.equal(a.chans[0][399], 0);
  assert.equal(a.chans[0][200], 1);
  assert.ok(a.chans[0][5] > 0 && a.chans[0][5] < 1);
  const out = sliceAudio(buf, -5, 99);
  assert.equal(out.chans[0].length, 1000);
  assert.equal(sliceAudio(buf, 0.9, 0.2).chans[0].length, 0);
  // the slice is a copy
  a.chans[0][100] = 7;
  assert.equal(buf.getChannelData(0)[200], 1);
});

test('sliceAudio keeps all channels', () => {
  const buf = fakeBuffer(1000, [constant(100, 0.5), constant(100, -0.5)]);
  const a = sliceAudio(buf, 0, 0.1, { fadeMs: 0 });
  assert.equal(a.chans.length, 2);
  assert.equal(a.chans[1][50], -0.5);
});

test('normalizeAudio', () => {
  const a = { sr: 8000, chans: [Float32Array.of(0.1, -0.25, 0.2), Float32Array.of(0, 0.05, 0)] };
  const n = normalizeAudio(a, -6);
  const peak = Math.max(...n.chans.flatMap((c) => [...c].map(Math.abs)));
  assert.ok(Math.abs(peak - 10 ** (-6 / 20)) < 1e-6);
  assert.ok(Math.abs(n.chans[0][0] / n.chans[0][1] + 0.4) < 1e-6);
  const silent = { sr: 8000, chans: [new Float32Array(10)] };
  assert.equal(normalizeAudio(silent), silent);
});

test('trimSilence removes leading and trailing silence', () => {
  const sr = 8000;
  const x = new Float32Array(sr * 3);
  x.set(sine(sr, 1, 300, 0.5), sr); // tone from 1 s to 2 s
  const t = trimSilence({ sr, chans: [x] }, { thresholdDb: -45, keepMs: 15 });
  const keep = Math.round(0.015 * sr);
  assert.ok(t.chans[0].length <= sr + 2 * keep + 2);
  assert.ok(t.chans[0].length >= sr);
  assert.equal(t.chans[0][0], 0);
  assert.equal(t.chans[0][t.chans[0].length - 1], 0);
});

test('trimSilence leaves all-silent input unchanged and enforces a minimum length', () => {
  const silent = { sr: 8000, chans: [new Float32Array(500)] };
  assert.equal(trimSilence(silent), silent);
  const x = new Float32Array(8000);
  x[4000] = 0.9;
  const t = trimSilence({ sr: 8000, chans: [x] }, { keepMs: 0 });
  assert.ok(t.chans[0].length >= 80);
});

test('trimSilence considers every channel', () => {
  const l = new Float32Array(1000);
  const r = new Float32Array(1000);
  r[900] = 0.8;
  l[100] = 0.8;
  const t = trimSilence({ sr: 1000, chans: [l, r] }, { keepMs: 0 });
  assert.equal(t.chans[0].length, 801);
});

test('joinAudio length, gaps and mixed sample rates', () => {
  const a = { sr: 1000, chans: [constant(100, 0.5)] };
  const b = { sr: 1000, chans: [constant(50, 0.25)] };
  const j = joinAudio([a, b, a], { gapMs: 20 });
  assert.equal(j.chans[0].length, 100 + 20 + 50 + 20 + 100);
  assert.equal(j.chans[0][105], 0); // inside the gap
  assert.equal(j.chans[0][130], 0.25);
  const c = { sr: 500, chans: [constant(50, 0.3)] }; // 0.1 s at 500 Hz is 100 samples at 1000 Hz
  const m = joinAudio([a, c], { gapMs: 0 });
  assert.equal(m.sr, 1000);
  assert.equal(m.chans[0].length, 200);
  assert.ok(Math.abs(m.chans[0][150] - 0.3) < 1e-6);
});

test('joinAudio upmixes and downmixes to the first part', () => {
  const mono = { sr: 1000, chans: [constant(10, 0.5)] };
  const st = { sr: 1000, chans: [constant(10, 0.2), constant(10, 0.4)] };
  const up = joinAudio([st, mono], { gapMs: 0 });
  assert.equal(up.chans.length, 2);
  assert.ok(Math.abs(up.chans[0][15] - 0.5) < 1e-6 && Math.abs(up.chans[1][15] - 0.5) < 1e-6);
  const down = joinAudio([mono, st], { gapMs: 0 });
  assert.equal(down.chans.length, 1);
  assert.ok(Math.abs(down.chans[0][15] - 0.3) < 1e-6);
  assert.equal(joinAudio([]).chans[0].length, 0);
});

test('computePeaks buckets min and max across channels', async () => {
  const l = Float32Array.from({ length: 100 }, (_, i) => (i === 10 ? 0.5 : 0));
  const r = Float32Array.from({ length: 100 }, (_, i) => (i === 60 ? -0.7 : 0));
  const { min, max } = await computePeaks(fakeBuffer(100, [l, r]), 4);
  assert.equal(min.length, 4);
  assert.equal(max[0], 0.5);
  assert.equal(min[2], Math.fround(-0.7));
  assert.equal(max[3], 0);
});

test('probeWavDuration walks chunks (LIST before data) and handles streaming sizes', async () => {
  const wav = encodeWav({ sr: 16000, chans: [new Float32Array(32000)] }); // 2 s
  const list = new Uint8Array(8 + 20);
  list.set([76, 73, 83, 84], 0);
  new DataView(list.buffer).setUint32(4, 20, true);
  const withList = new Uint8Array(wav.length + list.length);
  withList.set(wav.subarray(0, 36), 0);
  withList.set(list, 36);
  withList.set(wav.subarray(36), 36 + list.length);
  const fileOf = (u8) => new Blob([u8]);
  assert.ok(Math.abs((await probeWavDuration(fileOf(wav))) - 2) < 1e-6);
  assert.ok(Math.abs((await probeWavDuration(fileOf(withList))) - 2) < 1e-6);
  const stream = wav.slice();
  new DataView(stream.buffer).setUint32(40, 0xffffffff, true);
  assert.ok(Math.abs((await probeWavDuration(fileOf(stream))) - 2) < 1e-6);
  assert.equal(await probeWavDuration(fileOf(Uint8Array.of(1, 2, 3))), null);
});
