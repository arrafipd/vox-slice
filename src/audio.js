// Audio decoding and pure PCM helpers. The pure functions work on the plain
// shape Audio = { sr, chans: Float32Array[] } and run in Node for unit tests.
import { VoxError } from './errors.js';

export const MAX_SECONDS = 900;
const TOO_LONG_TOLERANCE = 0.5;
const PROBE_TIMEOUT_MS = 8000;

let sharedCtx = null;

/** One AudioContext shared by decoding and playback. Created on first use. */
export function getAudioContext() {
  if (!sharedCtx || sharedCtx.state === 'closed') {
    const Ctor = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!Ctor) throw new VoxError('DECODE_FAILED', 'Web Audio is not available');
    sharedCtx = new Ctor();
  }
  return sharedCtx;
}

/* ---------- probing ---------- */

async function readBytes(file, start, length) {
  const end = Math.min(file.size, start + length);
  if (start >= end) return new DataView(new ArrayBuffer(0));
  return new DataView(await file.slice(start, end).arrayBuffer());
}

const fourcc = (dv, o) =>
  String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));

/** Reads the WAV header (not just a 44-byte one). Returns seconds, or null. */
export async function probeWavDuration(file) {
  const head = await readBytes(file, 0, 65536);
  if (head.byteLength < 12 || fourcc(head, 0) !== 'RIFF' || fourcc(head, 8) !== 'WAVE') return null;
  let byteRate = 0;
  let blockAlign = 0;
  let sampleRate = 0;
  let offset = 12;
  for (let guard = 0; guard < 128 && offset + 8 <= file.size; guard++) {
    // Chunk headers may lie beyond the first 64 KB (big LIST chunks); fetch them on demand.
    let dv = head;
    let at = offset;
    if (offset + 8 > head.byteLength) {
      dv = await readBytes(file, offset, 64);
      at = 0;
      if (dv.byteLength < 8) return null;
    }
    const id = fourcc(dv, at);
    const size = dv.getUint32(at + 4, true);
    if (id === 'fmt ') {
      let f = dv;
      let fo = at + 8;
      if (fo + 16 > f.byteLength) {
        f = await readBytes(file, offset + 8, 16);
        fo = 0;
        if (f.byteLength < 16) return null;
      }
      sampleRate = f.getUint32(fo + 4, true);
      byteRate = f.getUint32(fo + 8, true);
      blockAlign = f.getUint16(fo + 12, true);
    } else if (id === 'data') {
      if (!sampleRate) return null;
      const dataStart = offset + 8;
      let bytes = size;
      // Streamed or unfinished files carry 0 or 0xFFFFFFFF; trust the file size instead.
      if (size === 0 || size === 0xffffffff || dataStart + size > file.size) bytes = file.size - dataStart;
      const rate = byteRate || sampleRate * blockAlign;
      if (!rate) return null;
      const d = bytes / rate;
      return Number.isFinite(d) ? d : null;
    }
    offset += 8 + size + (size & 1);
  }
  return null;
}

function probeWithElement(file) {
  return new Promise((resolve) => {
    let url = null;
    let el = null;
    let timer = null;
    let finished = false;
    const finish = (v) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (el) {
        el.removeAttribute('src');
        try { el.load(); } catch { /* ignore */ }
      }
      if (url) URL.revokeObjectURL(url);
      resolve(Number.isFinite(v) && v >= 0 ? v : null);
    };
    try {
      url = URL.createObjectURL(file);
      el = document.createElement('audio');
      el.preload = 'metadata';
      el.onloadedmetadata = () => finish(el.duration);
      el.onerror = () => finish(null);
      timer = setTimeout(() => finish(null), PROBE_TIMEOUT_MS);
      el.src = url;
    } catch {
      finish(null);
    }
  });
}

/** Cheap duration read. Never decodes the whole file. Null when unknown. */
export async function probeDuration(file) {
  try {
    const wav = await probeWavDuration(file);
    if (wav != null) return wav;
  } catch { /* fall through to the element probe */ }
  return probeWithElement(file);
}

/* ---------- decoding ---------- */

const NON_AUDIO_EXT = /\.(txt|pdf|png|jpe?g|gif|webp|bmp|svg|zip|json|csv|docx?|xlsx?|pptx?|html?|js|exe|md)$/i;

async function looksLikeNonAudio(file) {
  const t = (file.type || '').toLowerCase();
  if (t && !t.startsWith('audio/') && !t.startsWith('video/') && t !== 'application/ogg' && t !== 'application/octet-stream') {
    return true;
  }
  if (!t && NON_AUDIO_EXT.test(file.name || '')) return true;
  try {
    const b = new Uint8Array(await file.slice(0, 8).arrayBuffer());
    const is = (...sig) => sig.every((v, i) => b[i] === v);
    if (is(0x89, 0x50, 0x4e, 0x47) || is(0xff, 0xd8, 0xff) || is(0x25, 0x50, 0x44, 0x46) || is(0x47, 0x49, 0x46, 0x38) || is(0x50, 0x4b, 0x03, 0x04)) {
      return true;
    }
  } catch { /* ignore */ }
  return false;
}

function tooLong(duration) {
  return new VoxError('TOO_LONG', 'Audio is too long', { duration });
}

export async function decodeFile(file) {
  if (!file || !file.size) throw new VoxError('NOT_AUDIO', 'Empty file');
  if (await looksLikeNonAudio(file)) throw new VoxError('NOT_AUDIO', 'Not an audio file');

  const probed = await probeDuration(file);
  if (probed != null && probed > MAX_SECONDS + TOO_LONG_TOLERANCE) throw tooLong(probed);

  let buffer;
  try {
    const bytes = await file.arrayBuffer();
    buffer = await getAudioContext().decodeAudioData(bytes);
  } catch (e) {
    if (probed == null) throw new VoxError('NOT_AUDIO', 'Could not read as audio', { cause: e });
    throw new VoxError('DECODE_FAILED', 'Could not decode audio', { cause: e });
  }
  if (!buffer || buffer.length === 0) throw new VoxError('DECODE_FAILED', 'Decoded audio is empty');
  if (buffer.duration > MAX_SECONDS + TOO_LONG_TOLERANCE) throw tooLong(buffer.duration);
  return buffer;
}

/** Mono 16 kHz Float32Array, the format Whisper wants. */
export async function to16kMono(buffer) {
  const sr = 16000;
  const length = Math.max(1, Math.ceil(buffer.duration * sr));
  const ctx = new OfflineAudioContext(1, length, sr);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.connect(ctx.destination);
  src.start(0);
  const out = await ctx.startRendering();
  return Float32Array.from(out.getChannelData(0));
}

export async function hashFile(file) {
  const bytes = await file.arrayBuffer();
  if (globalThis.crypto && crypto.subtle) {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  }
  // Insecure context fallback: FNV-1a over the bytes, tagged so it never looks like a SHA-256.
  const u8 = new Uint8Array(bytes);
  let h = 0x811c9dc5;
  for (let i = 0; i < u8.length; i++) {
    h ^= u8[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `fnv-${h.toString(16)}-${u8.length}`;
}

const yieldToEventLoop = () => new Promise((r) => setTimeout(r, 0));

/** Min/max per bucket across all channels. Yields so long files never freeze the tab. */
export async function computePeaks(buffer, buckets) {
  const n = buffer.length;
  const nb = Math.max(1, Math.floor(buckets));
  const min = new Float32Array(nb);
  const max = new Float32Array(nb);
  const chans = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) chans.push(buffer.getChannelData(c));
  let sinceYield = 0;
  for (let b = 0; b < nb; b++) {
    const a = Math.floor((b * n) / nb);
    let e = Math.floor(((b + 1) * n) / nb);
    if (e <= a) e = Math.min(n, a + 1);
    let lo = 0;
    let hi = 0;
    for (const d of chans) {
      for (let i = a; i < e; i++) {
        const v = d[i];
        if (v < lo) lo = v;
        else if (v > hi) hi = v;
      }
    }
    min[b] = lo;
    max[b] = hi;
    sinceYield += (e - a) * chans.length;
    if (sinceYield >= 2_000_000) {
      sinceYield = 0;
      await yieldToEventLoop();
    }
  }
  return { min, max };
}

/* ---------- pure PCM helpers ---------- */

function applyFade(chan, fadeSamples) {
  const n = chan.length;
  const f = Math.min(fadeSamples, Math.floor(n / 2));
  for (let i = 0; i < f; i++) {
    const g = i / f;
    chan[i] *= g;
    chan[n - 1 - i] *= g;
  }
}

export function sliceAudio(buffer, start, end, { fadeMs = 5 } = {}) {
  const sr = buffer.sampleRate;
  const a = Math.max(0, Math.min(buffer.length, Math.floor(start * sr)));
  const b = Math.max(a, Math.min(buffer.length, Math.ceil(end * sr)));
  const fade = Math.round((fadeMs / 1000) * sr);
  const chans = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const out = Float32Array.from(buffer.getChannelData(c).subarray(a, b));
    applyFade(out, fade);
    chans.push(out);
  }
  return { sr, chans };
}

export function normalizeAudio(audio, peakDb = -1) {
  let peak = 0;
  for (const c of audio.chans) {
    for (let i = 0; i < c.length; i++) {
      const v = Math.abs(c[i]);
      if (v > peak) peak = v;
    }
  }
  if (peak < 1e-6) return audio;
  const gain = 10 ** (peakDb / 20) / peak;
  return { sr: audio.sr, chans: audio.chans.map((c) => c.map((v) => v * gain)) };
}

export function trimSilence(audio, { thresholdDb = -45, keepMs = 15 } = {}) {
  const thr = 10 ** (thresholdDb / 20);
  const n = audio.chans[0] ? audio.chans[0].length : 0;
  let first = -1;
  let last = -1;
  for (let i = 0; i < n && first < 0; i++) {
    for (const c of audio.chans) if (Math.abs(c[i]) > thr) { first = i; break; }
  }
  if (first < 0) return audio;
  for (let i = n - 1; i >= first && last < 0; i--) {
    for (const c of audio.chans) if (Math.abs(c[i]) > thr) { last = i; break; }
  }
  const keep = Math.round((keepMs / 1000) * audio.sr);
  const minLen = Math.min(n, Math.ceil(0.01 * audio.sr));
  let a = Math.max(0, first - keep);
  let b = Math.min(n, last + 1 + keep);
  if (b - a < minLen) {
    const need = minLen - (b - a);
    a = Math.max(0, a - Math.ceil(need / 2));
    b = Math.min(n, a + minLen);
    a = Math.max(0, b - minLen);
  }
  const fade = Math.round(0.003 * audio.sr);
  const chans = audio.chans.map((c) => {
    const out = Float32Array.from(c.subarray(a, b));
    applyFade(out, fade);
    return out;
  });
  return { sr: audio.sr, chans };
}

export function resampleLinear(data, from, to) {
  if (from === to || data.length === 0) return data;
  const outLen = Math.max(1, Math.round((data.length * to) / from));
  const out = new Float32Array(outLen);
  const ratio = from / to;
  const last = data.length - 1;
  for (let i = 0; i < outLen; i++) {
    const p = i * ratio;
    const i0 = Math.min(last, Math.floor(p));
    const i1 = Math.min(last, i0 + 1);
    const f = p - i0;
    out[i] = data[i0] * (1 - f) + data[i1] * f;
  }
  return out;
}

/** Forces a part to `sr` and `nc` channels (mono duplicated up, extra channels averaged down). */
function conform(part, sr, nc) {
  const chans = part.chans.map((c) => resampleLinear(c, part.sr, sr));
  if (chans.length === nc) return chans;
  if (chans.length === 0) return Array.from({ length: nc }, () => new Float32Array(0));
  if (nc === 1) {
    const len = chans[0].length;
    const m = new Float32Array(len);
    for (const c of chans) for (let i = 0; i < len; i++) m[i] += c[i] / chans.length;
    return [m];
  }
  const out = [];
  for (let c = 0; c < nc; c++) out.push(chans[Math.min(c, chans.length - 1)]);
  return out;
}

export function joinAudio(parts, { gapMs = 60 } = {}) {
  if (!parts.length) return { sr: 44100, chans: [new Float32Array(0)] };
  const sr = parts[0].sr;
  const nc = parts[0].chans.length || 1;
  const gap = Math.round((gapMs / 1000) * sr);
  const conformed = parts.map((p) => conform(p, sr, nc));
  const total = conformed.reduce((s, c) => s + c[0].length, 0) + gap * (parts.length - 1);
  const chans = Array.from({ length: nc }, () => new Float32Array(total));
  let pos = 0;
  conformed.forEach((cc, idx) => {
    for (let c = 0; c < nc; c++) chans[c].set(cc[c], pos);
    pos += cc[0].length;
    if (idx < conformed.length - 1) pos += gap;
  });
  return { sr, chans };
}

export function audioToBuffer(ctx, audio) {
  const nc = audio.chans.length;
  const len = Math.max(1, audio.chans[0].length);
  const buf = ctx.createBuffer(nc, len, audio.sr);
  for (let c = 0; c < nc; c++) buf.copyToChannel(audio.chans[c], c);
  return buf;
}
