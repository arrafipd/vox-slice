// WAV / MP3 encoding, file naming, manifest and zip export. Everything here
// works on the plain Audio = { sr, chans } shape, so it runs in Node for tests.
import { Mp3Encoder } from '@breezystack/lamejs';
import JSZip from 'jszip';
import { sliceAudio, normalizeAudio, trimSilence, resampleLinear } from './audio.js';
import { phraseFileName } from './phrases.js';

const yieldToEventLoop = () => new Promise((r) => setTimeout(r, 0));

/** 16-bit PCM WAV with a canonical 44-byte header. */
export function encodeWav(audio) {
  const nc = audio.chans.length;
  const n = nc ? audio.chans[0].length : 0;
  const dataBytes = n * nc * 2;
  const out = new Uint8Array(44 + dataBytes);
  const dv = new DataView(out.buffer);
  const str = (o, s) => {
    for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i));
  };
  str(0, 'RIFF');
  dv.setUint32(4, 36 + dataBytes, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, nc, true);
  dv.setUint32(24, audio.sr, true);
  dv.setUint32(28, audio.sr * nc * 2, true);
  dv.setUint16(32, nc * 2, true);
  dv.setUint16(34, 16, true);
  str(36, 'data');
  dv.setUint32(40, dataBytes, true);
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < nc; c++) {
      const v = Math.max(-1, Math.min(1, audio.chans[c][i]));
      dv.setInt16(o, v < 0 ? v * 0x8000 : v * 0x7fff, true);
      o += 2;
    }
  }
  return out;
}

const LAME_RATES = [8000, 11025, 12000, 16000, 22050, 24000, 32000, 44100, 48000];

function mp3Rate(sr) {
  if (LAME_RATES.includes(sr)) return sr;
  if (sr % 44100 === 0) return 44100;
  if (sr % 48000 === 0) return 48000;
  let best = LAME_RATES[0];
  for (const r of LAME_RATES) if (Math.abs(r - sr) < Math.abs(best - sr)) best = r;
  return best;
}

function toInt16(f) {
  const o = new Int16Array(f.length);
  for (let i = 0; i < f.length; i++) {
    const v = Math.max(-1, Math.min(1, f[i]));
    o[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  return o;
}

export async function encodeMp3(audio, kbps = 160) {
  const nc = Math.min(2, audio.chans.length) || 1;
  const rate = mp3Rate(audio.sr);
  // MPEG 2.5 (8-12 kHz) tops out at 64 kbps.
  const rateKbps = rate <= 12000 ? Math.min(kbps, 64) : kbps;
  const src = audio.chans.slice(0, nc).map((c) => resampleLinear(c, audio.sr, rate));
  const L = toInt16(src[0]);
  const R = nc === 2 ? toInt16(src[1]) : null;
  const enc = new Mp3Encoder(nc, rate, rateKbps);
  const parts = [];
  let total = 0;
  const push = (b) => {
    if (b && b.length) {
      const u = new Uint8Array(b);
      parts.push(u);
      total += u.length;
    }
  };
  const BLOCK = 1152;
  let blocks = 0;
  for (let i = 0; i < L.length; i += BLOCK) {
    push(nc === 2 ? enc.encodeBuffer(L.subarray(i, i + BLOCK), R.subarray(i, i + BLOCK)) : enc.encodeBuffer(L.subarray(i, i + BLOCK)));
    if (++blocks % 200 === 0) await yieldToEventLoop();
  }
  push(enc.flush());
  const out = new Uint8Array(total);
  let pos = 0;
  for (const p of parts) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

function slug(text, max) {
  let s = String(text || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (s.length > max) s = s.slice(0, max).replace(/-+$/g, '');
  return s;
}

export function clipFileName({ index, text, ext, sourceName }) {
  const n = String(Math.max(0, Math.floor(index || 0)) + 1).padStart(3, '0');
  const t = slug(text, 32) || 'clip';
  const src = slug(String(sourceName || '').replace(/\.[^./\\]+$/, ''), 20);
  const e = String(ext || 'wav').replace(/^\./, '').toLowerCase();
  return `${n}_${t}${src ? '_' + src : ''}.${e}`;
}

function csvField(v) {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const MANIFEST_COLS = ['filename', 'source_file', 'start', 'end', 'duration', 'text'];

export function manifestCsv(rows) {
  const lines = [MANIFEST_COLS.join(',')];
  for (const r of rows) lines.push(MANIFEST_COLS.map((c) => csvField(r[c])).join(','));
  return lines.join('\r\n') + '\r\n';
}

export async function makeZip(entries) {
  const zip = new JSZip();
  for (const e of entries) {
    const stored = /\.(mp3|zip)$/i.test(e.name);
    zip.file(e.name, e.data, stored ? { compression: 'STORE' } : { compression: 'DEFLATE', compressionOptions: { level: 3 } });
  }
  return zip.generateAsync({ type: 'blob' });
}

export function renderClip(clip, source, { normalize = false, trim = false } = {}) {
  let audio = sliceAudio(source.buffer, clip.start, clip.end);
  if (trim) audio = trimSilence(audio);
  if (normalize) audio = normalizeAudio(audio);
  return audio;
}

export function uniqueName(name, used) {
  const dot = name.lastIndexOf('.');
  const base = name.slice(0, dot);
  const ext = name.slice(dot);
  let candidate = name;
  let k = 2;
  while (used.has(candidate.toLowerCase())) candidate = `${base}-${k++}${ext}`;
  used.add(candidate.toLowerCase());
  return candidate;
}

/**
 * Renders and encodes every clip. Returns { entries, manifest, skipped }:
 * entries are { name, data } (manifest.csv last), manifest is the row array,
 * skipped are clips whose source has no audio loaded.
 */
// phraseNames switches file names from "001_text_source.wav" to "01_the-phrase-text.wav".
export async function exportClips({ clips, sources, formats = ['wav'], normalize = false, trim = false, phraseNames = false, onProgress } = {}) {
  const byId = new Map();
  for (const s of sources instanceof Map ? sources.values() : sources || []) byId.set(s.id, s);
  const fmts = ['wav', 'mp3'].filter((f) => (formats || []).includes(f));

  const skipped = [];
  const todo = [];
  (clips || []).forEach((clip, index) => {
    const source = byId.get(clip.sourceId);
    if (!source || !source.buffer) skipped.push(clip);
    else todo.push({ clip, source, index });
  });

  const entries = [];
  const manifest = [];
  const used = new Set(['manifest.csv']);
  let done = 0;
  for (const { clip, source, index } of todo) {
    const audio = renderClip(clip, source, { normalize, trim });
    const duration = (audio.chans[0] ? audio.chans[0].length : 0) / audio.sr;
    let lastName = '';
    for (const ext of fmts) {
      const name = uniqueName(phraseNames
        ? phraseFileName({ index, text: clip.text, ext, total: (clips || []).length })
        : clipFileName({ index, text: clip.text, ext, sourceName: source.name }), used);
      const data = ext === 'wav' ? encodeWav(audio) : await encodeMp3(audio);
      entries.push({ name, data });
      manifest.push({
        filename: name,
        source_file: source.name,
        start: clip.start.toFixed(3),
        end: clip.end.toFixed(3),
        duration: duration.toFixed(3),
        text: clip.text,
      });
      lastName = name;
    }
    done++;
    if (onProgress) onProgress({ done, total: todo.length, name: lastName });
    await yieldToEventLoop();
  }
  entries.push({ name: 'manifest.csv', data: manifestCsv(manifest) });
  return { entries, manifest, skipped };
}
