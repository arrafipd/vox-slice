// Builds the extra test files from tests/audio/clean.wav (which is made by
// Windows text-to-speech; see README). None of these are committed or deployed.
//   long.wav      ~14.9 min  (clean speech repeated)   -> memory / responsiveness test
//   toolong.wav   ~16.2 min                            -> 15-minute cap test
//   clean.mp3                                           -> MP3 input test
//   notaudio.mp3  a text file with an audio extension  -> bad-file test
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { Mp3Encoder } from '@breezystack/lamejs';

const dir = new URL('./audio/', import.meta.url);
mkdirSync(dir, { recursive: true });
const wav = readFileSync(new URL('clean.wav', dir));

function parseWav(buf) {
  let p = 12;
  let fmt = null;
  let data = null;
  while (p + 8 <= buf.length) {
    const id = buf.toString('ascii', p, p + 4);
    const size = buf.readUInt32LE(p + 4);
    if (id === 'fmt ') fmt = { ch: buf.readUInt16LE(p + 10), sr: buf.readUInt32LE(p + 12), bits: buf.readUInt16LE(p + 22) };
    if (id === 'data') { data = buf.subarray(p + 8, p + 8 + size); break; }
    p += 8 + size + (size & 1);
  }
  return { ...fmt, data };
}

function writeWav(path, { ch, sr, bits }, pcm) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(ch, 22); h.writeUInt32LE(sr, 24);
  h.writeUInt32LE((sr * ch * bits) / 8, 28); h.writeUInt16LE((ch * bits) / 8, 32); h.writeUInt16LE(bits, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  writeFileSync(path, Buffer.concat([h, pcm]));
}

const w = parseWav(wav);
const secs = w.data.length / (w.sr * w.ch * (w.bits / 8));
console.log(`clean.wav: ${w.sr} Hz, ${w.ch} ch, ${w.bits} bit, ${secs.toFixed(1)} s`);

const repeat = (n) => Buffer.concat(Array.from({ length: n }, () => w.data));
const nLong = Math.floor(895 / secs);
writeWav(new URL('long.wav', dir), w, repeat(nLong));
console.log(`long.wav: ${nLong} repeats = ${(nLong * secs / 60).toFixed(2)} min`);
const nOver = Math.ceil(965 / secs);
writeWav(new URL('toolong.wav', dir), w, repeat(nOver));
console.log(`toolong.wav: ${nOver} repeats = ${(nOver * secs / 60).toFixed(2)} min`);

const samples = new Int16Array(w.data.buffer, w.data.byteOffset, w.data.length / 2);
const enc = new Mp3Encoder(1, w.sr, 96);
const parts = [];
for (let i = 0; i < samples.length; i += 1152) {
  const b = enc.encodeBuffer(samples.subarray(i, i + 1152));
  if (b.length) parts.push(Buffer.from(b));
}
const end = enc.flush();
if (end.length) parts.push(Buffer.from(end));
writeFileSync(new URL('clean.mp3', dir), Buffer.concat(parts));
console.log(`clean.mp3: ${(Buffer.concat(parts).length / 1024).toFixed(0)} KB`);

writeFileSync(new URL('notaudio.mp3', dir), 'This is definitely not an audio file. '.repeat(200));
console.log('notaudio.mp3 written');
