// Speech-to-text worker. Runs Whisper (transformers.js) off the main thread so
// the page never freezes. The main thread cancels by terminating this worker.
//
// Long audio is cut into windows of at most ~28 s at the quietest nearby point,
// each window is transcribed on its own, and word times are shifted back to
// the full-file timeline. That gives real progress, flat memory use, and no
// cross-window merging to go wrong.
import { pipeline, env } from '@huggingface/transformers';
import { refineWords } from './align.js';

const base = new URL(import.meta.env.BASE_URL, self.location.origin);
env.allowLocalModels = false;
env.backends.onnx.wasm.wasmPaths = {
  mjs: new URL('ort/ort-wasm-simd-threaded.mjs', base).href,
  wasm: new URL('ort/ort-wasm-simd-threaded.wasm', base).href,
};
if (self.crossOriginIsolated) {
  env.backends.onnx.wasm.numThreads = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1));
} else {
  env.backends.onnx.wasm.numThreads = 1;
}

const SR = 16000;
const MAX_WIN = 28 * SR; // hard ceiling per window (Whisper sees 30 s)
const MIN_WIN = 18 * SR; // earliest we look for a quiet place to cut

let asr = null;
let loadedModel = null;

function post(type, data) {
  self.postMessage({ type, ...data });
}

async function load(model) {
  if (asr && loadedModel === model) return;
  asr = null;
  const files = {};
  asr = await pipeline('automatic-speech-recognition', model, {
    dtype: 'q8',
    device: 'wasm',
    progress_callback: (p) => {
      if (p.status === 'progress' && p.file) {
        files[p.file] = { loaded: p.loaded || 0, total: p.total || 0 };
        let loaded = 0;
        let total = 0;
        for (const f of Object.values(files)) {
          loaded += f.loaded;
          total += f.total;
        }
        post('download', { loaded, total });
      }
    },
  });
  loadedModel = model;
}

// Quietest 50 ms frame between lo and hi (sample indexes).
function quietestCut(audio, lo, hi) {
  const frame = 800;
  let best = hi;
  let bestE = Infinity;
  for (let i = lo; i + frame <= hi; i += frame >> 1) {
    let e = 0;
    for (let j = i; j < i + frame; j++) e += audio[j] * audio[j];
    if (e < bestE) {
      bestE = e;
      best = i + (frame >> 1);
    }
  }
  return best;
}

function planWindows(audio) {
  const wins = [];
  let pos = 0;
  while (pos < audio.length) {
    const left = audio.length - pos;
    if (left <= MAX_WIN) {
      wins.push([pos, audio.length]);
      break;
    }
    const cut = quietestCut(audio, pos + MIN_WIN, pos + MAX_WIN);
    wins.push([pos, cut]);
    pos = cut;
  }
  return wins;
}

function cleanWords(chunks, offset, winDur) {
  const out = [];
  for (const c of chunks || []) {
    const text = (c.text || '').trim();
    if (!text) continue;
    let s = c.timestamp ? c.timestamp[0] : null;
    let e = c.timestamp ? c.timestamp[1] : null;
    if (s == null || !Number.isFinite(s)) s = out.length ? out[out.length - 1].end - offset : 0;
    s = Math.max(0, Math.min(winDur, s));
    let guessed = false;
    if (e == null || !Number.isFinite(e) || e <= s) {
      e = Math.min(winDur, s + 0.3);
      guessed = true;
    }
    e = Math.min(winDur, e);
    if (e <= s) e = s + 0.05;
    const w = { text, start: +(s + offset).toFixed(3), end: +(e + offset).toFixed(3) };
    if (guessed) w.guessed = true;
    out.push(w);
  }
  return out;
}

async function transcribe(id, audio) {
  const wins = planWindows(audio);
  const t0 = performance.now();
  for (let i = 0; i < wins.length; i++) {
    const [a, b] = wins[i];
    const seg = audio.subarray(a, b);
    let words = [];
    // Skip windows that are digital silence: Whisper invents words for them.
    let peak = 0;
    for (let j = 0; j < seg.length; j += 16) {
      const v = Math.abs(seg[j]);
      if (v > peak) peak = v;
    }
    if (peak > 0.003) {
      const res = await asr(seg, { return_timestamps: 'word' });
      // Whisper's times are per window; tighten them against the audio, then move them onto the file timeline.
      const off = a / SR;
      words = refineWords(cleanWords(res.chunks, 0, seg.length / SR), seg, SR).map((w) => ({
        ...w,
        start: +(w.start + off).toFixed(3),
        end: +(w.end + off).toFixed(3),
      }));
    }
    post('partial', {
      id,
      words,
      window: i + 1,
      windows: wins.length,
      doneSec: b / SR,
      totalSec: audio.length / SR,
      elapsedMs: performance.now() - t0,
    });
  }
  post('done', { id, elapsedMs: performance.now() - t0 });
}

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === 'load') {
      await load(m.model);
      post('ready', { model: m.model, threads: env.backends.onnx.wasm.numThreads });
    } else if (m.type === 'transcribe') {
      await load(m.model);
      post('ready', { model: m.model, threads: env.backends.onnx.wasm.numThreads });
      await transcribe(m.id, m.audio);
    }
  } catch (err) {
    post('error', { id: m.id, message: String((err && err.message) || err) });
  }
};
