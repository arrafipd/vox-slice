import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { encodeWav, encodeMp3, clipFileName, manifestCsv, makeZip, exportClips, renderClip, uniqueName } from '../../src/encode.js';
import { fakeBuffer, sine } from './helpers.mjs';

const str = (u8, o, n) => String.fromCharCode(...u8.subarray(o, o + n));

test('encodeWav mono header and samples', () => {
  const wav = encodeWav({ sr: 22050, chans: [Float32Array.of(0, 1, -1, 0.5, 2)] });
  const dv = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  assert.equal(str(wav, 0, 4), 'RIFF');
  assert.equal(str(wav, 8, 4), 'WAVE');
  assert.equal(str(wav, 12, 4), 'fmt ');
  assert.equal(dv.getUint16(20, true), 1);
  assert.equal(dv.getUint16(22, true), 1);
  assert.equal(dv.getUint32(24, true), 22050);
  assert.equal(dv.getUint32(28, true), 44100);
  assert.equal(dv.getUint16(32, true), 2);
  assert.equal(dv.getUint16(34, true), 16);
  assert.equal(str(wav, 36, 4), 'data');
  assert.equal(dv.getUint32(40, true), 10);
  assert.equal(dv.getUint32(4, true), 36 + 10);
  assert.equal(wav.length, 54);
  assert.equal(dv.getInt16(44, true), 0);
  assert.equal(dv.getInt16(46, true), 32767);
  assert.equal(dv.getInt16(48, true), -32768);
  assert.equal(dv.getInt16(50, true), Math.trunc(0.5 * 32767));
  assert.equal(dv.getInt16(52, true), 32767); // clipped
});

test('encodeWav stereo interleaves', () => {
  const wav = encodeWav({ sr: 44100, chans: [Float32Array.of(1, 0), Float32Array.of(-1, 0.5)] });
  const dv = new DataView(wav.buffer);
  assert.equal(dv.getUint16(22, true), 2);
  assert.equal(dv.getUint32(28, true), 44100 * 4);
  assert.equal(dv.getUint16(32, true), 4);
  assert.equal(dv.getUint32(40, true), 8);
  assert.equal(dv.getInt16(44, true), 32767);
  assert.equal(dv.getInt16(46, true), -32768);
  assert.equal(dv.getInt16(48, true), 0);
  assert.equal(dv.getInt16(50, true), Math.trunc(0.5 * 32767));
});

function hasMpegSync(u8) {
  if (str(u8, 0, 3) === 'ID3') return true;
  for (let i = 0; i < Math.min(u8.length - 1, 4096); i++) if (u8[i] === 0xff && (u8[i + 1] & 0xe0) === 0xe0) return true;
  return false;
}

for (const [sr, ch] of [[44100, 1], [44100, 2], [96000, 1], [88200, 2], [16000, 1]]) {
  test(`encodeMp3 ${sr} Hz ${ch}ch`, async () => {
    const chans = Array.from({ length: ch }, (_, c) => sine(sr, 0.5, 300 + c * 100));
    const mp3 = await encodeMp3({ sr, chans });
    assert.ok(mp3 instanceof Uint8Array);
    assert.ok(mp3.length > 1000, `size ${mp3.length}`);
    assert.ok(hasMpegSync(mp3));
  });
}

test('clipFileName', () => {
  assert.equal(clipFileName({ index: 2, text: 'Tremendous, town hall!', ext: 'wav', sourceName: 'My Speech.mp3' }), '003_tremendous-town-hall_my-speech.wav');
  assert.equal(clipFileName({ index: 0, text: '', ext: 'mp3', sourceName: 'a.wav' }), '001_clip_a.mp3');
  assert.equal(clipFileName({ index: 11, text: '!!!', ext: 'wav', sourceName: '' }), '012_clip.wav');
  const long = clipFileName({ index: 0, text: 'x'.repeat(100), ext: 'wav', sourceName: 'y'.repeat(50) + '.mp3' });
  assert.equal(long, `001_${'x'.repeat(32)}_${'y'.repeat(20)}.wav`);
  assert.match(clipFileName({ index: 0, text: 'Café Ünïcode 日本', ext: 'wav', sourceName: 'Ça va.m4a' }), /^[a-z0-9_.-]+$/);
  assert.equal(clipFileName({ index: 999, text: 'a', ext: 'wav', sourceName: 'b' }), '1000_a_b.wav');
});

test('manifestCsv quoting', () => {
  const csv = manifestCsv([
    { filename: 'a.wav', source_file: 'x, y.mp3', start: '0.000', end: '1.000', duration: '1.000', text: 'say "hi"\nthere, friend' },
    { filename: 'b.wav', source_file: 'x.mp3', start: '1.000', end: '2.000', duration: '1.000', text: 'plain' },
  ]);
  assert.equal(
    csv,
    'filename,source_file,start,end,duration,text\r\n' +
      'a.wav,"x, y.mp3",0.000,1.000,1.000,"say ""hi""\nthere, friend"\r\n' +
      'b.wav,x.mp3,1.000,2.000,1.000,plain\r\n',
  );
  assert.equal(manifestCsv([]), 'filename,source_file,start,end,duration,text\r\n');
});

function fixture() {
  const sr = 8000;
  const buffer = fakeBuffer(sr, [sine(sr, 3, 300, 0.4)]);
  const sources = [
    { id: 's1', name: 'Speech One.mp3', buffer },
    { id: 's2', name: 'No Audio.mp3', buffer: null },
  ];
  const clips = [
    { id: 'c1', sourceId: 's1', i0: 0, i1: 0, text: 'hello', start: 0.5, end: 1.0 },
    { id: 'c2', sourceId: 's1', i0: 1, i1: 1, text: 'hello', start: 1.0, end: 1.25 },
    { id: 'c3', sourceId: 's2', i0: 0, i1: 0, text: 'ghost', start: 0, end: 1 },
    { id: 'c4', sourceId: 's1', i0: 2, i1: 2, text: 'Wörld, "ok"', start: 2, end: 2.5 },
  ];
  return { sources, clips };
}

test('exportClips builds entries, manifest, skips clips without audio, and the zip round-trips', async () => {
  const { sources, clips } = fixture();
  const progress = [];
  const res = await exportClips({ clips, sources, formats: ['wav', 'mp3'], normalize: true, trim: false, onProgress: (p) => progress.push(p) });
  assert.equal(res.skipped.length, 1);
  assert.equal(res.skipped[0].id, 'c3');
  assert.equal(res.manifest.length, 6); // 3 clips x 2 formats
  const names = res.entries.map((e) => e.name);
  assert.equal(new Set(names).size, names.length);
  assert.equal(names.at(-1), 'manifest.csv');
  assert.ok(names.includes('001_hello_speech-one.wav'));
  assert.ok(names.includes('002_hello_speech-one.mp3'));
  assert.ok(names.includes('004_world-ok_speech-one.wav'));
  const row = res.manifest.find((r) => r.filename === '001_hello_speech-one.wav');
  assert.deepEqual(row, { filename: '001_hello_speech-one.wav', source_file: 'Speech One.mp3', start: '0.500', end: '1.000', duration: '0.500', text: 'hello' });
  assert.equal(progress.at(-1).done, 3);
  assert.equal(progress.at(-1).total, 3);

  const blob = await makeZip(res.entries);
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  assert.deepEqual(Object.keys(zip.files).sort(), [...names].sort());
  const wav = await zip.file('001_hello_speech-one.wav').async('uint8array');
  assert.equal(str(wav, 0, 4), 'RIFF');
  assert.equal(wav.length, 44 + 4000 * 2);
  const csv = await zip.file('manifest.csv').async('string');
  assert.ok(csv.startsWith('filename,source_file,start,end,duration,text\r\n'));
  assert.ok(csv.includes('"Wörld, ""ok"""'));
});

test('exportClips with only wav, no clips, and no audio at all', async () => {
  const { sources, clips } = fixture();
  const wavOnly = await exportClips({ clips: clips.slice(0, 2), sources, formats: ['wav'] });
  assert.equal(wavOnly.entries.length, 3);
  const none = await exportClips({ clips: [clips[2]], sources, formats: ['wav'] });
  assert.equal(none.skipped.length, 1);
  assert.deepEqual(none.entries.map((e) => e.name), ['manifest.csv']);
});

test('uniqueName appends -2, -3 on collisions', () => {
  const used = new Set();
  assert.equal(uniqueName('a.wav', used), 'a.wav');
  assert.equal(uniqueName('a.wav', used), 'a-2.wav');
  assert.equal(uniqueName('A.wav', used), 'A-3.wav');
  assert.equal(uniqueName('b.wav', used), 'b.wav');
});

test('renderClip applies trim and normalize', () => {
  const sr = 8000;
  const x = new Float32Array(sr * 2);
  x.set(sine(sr, 0.5, 300, 0.2), sr / 2);
  const src = { buffer: fakeBuffer(sr, [x]) };
  const clip = { start: 0, end: 2 };
  const plain = renderClip(clip, src);
  const trimmed = renderClip(clip, src, { trim: true });
  assert.ok(trimmed.chans[0].length < plain.chans[0].length / 2);
  const norm = renderClip(clip, src, { normalize: true });
  assert.ok(Math.abs(Math.max(...norm.chans[0]) - 10 ** (-1 / 20)) < 0.01);
});
