// Loading pipeline: files go into a queue and are processed one at a time.
// hash -> decode -> peaks -> (transcript cache | resample -> Whisper) -> ready.
import { hashFile, decodeFile, computePeaks, to16kMono } from '../audio.js';
import { getTranscript, putTranscript } from '../store.js';
import { createTranscriber } from '../transcriber.js';
import { VoxError } from '../errors.js';
import { checkDuration } from '../tier.js';
import { state, meta, uid, emit, setBusy, setStatus, setActive, getSource, srcMeta } from './state.js';
import { showError, showUpgrade } from './notices.js';
import { fmtClock } from './dom.js';

const transcriber = createTranscriber();
const queue = [];
let running = false;
let current = null;     // { src, file }
let cancelled = false;

export const MODEL_MB = { 'Xenova/whisper-tiny.en': 40, 'Xenova/whisper-base.en': 75, 'Xenova/whisper-small.en': 250 };
const SOFT_FAIL = new Set(['NOT_AUDIO', 'TOO_LONG', 'DECODE_FAILED', 'TIER_LIMIT']);

function setSrc(src, patch) {
  meta.set(src.id, { ...srcMeta(src.id), ...patch });
  emit('sources');
}
function progress(p) { emit('progress', p); }

function makePlaceholder(file) {
  const src = {
    id: uid('s'),
    name: file.name,
    hash: '',
    duration: 0,
    model: state.settings.model,
    words: [],
    buffer: null,
    peaks: null,
  };
  state.sources.push(src);
  meta.set(src.id, { status: 'queued', file });
  return src;
}

export function enqueueFiles(files) {
  const list = [...files];
  if (!list.length) return;
  for (const f of list) {
    const src = makePlaceholder(f);
    queue.push({ src, file: f });
  }
  emit('sources');
  setStatus(list.length === 1 ? `Got ${list[0].name}. Starting up...` : `Got ${list.length} files. Working through them one at a time.`);
  run();
}

export function retrySource(id) {
  const src = getSource(id);
  const m = srcMeta(id);
  if (!src || !m.file || queue.some((q) => q.src === src) || current?.src === src) return;
  src.words = [];
  src.model = state.settings.model;
  setSrc(src, { status: 'queued', error: null });
  queue.push({ src, file: m.file });
  run();
}

export function removeSource(id) {
  const src = getSource(id);
  if (!src) return;
  const qi = queue.findIndex((q) => q.src === src);
  if (qi >= 0) queue.splice(qi, 1);
  if (current && current.src === src) { current.removed = true; cancelled = true; transcriber.cancel(); }
  const gone = state.clips.filter((c) => c.sourceId === id).length;
  state.clips = state.clips.filter((c) => c.sourceId !== id);
  state.sources = state.sources.filter((s) => s.id !== id);
  meta.delete(id);
  if (state.selClipId && !state.clips.some((c) => c.id === state.selClipId)) state.selClipId = null;
  if (state.loopClipId && !state.clips.some((c) => c.id === state.loopClipId)) state.loopClipId = null;
  if (state.activeId === id) {
    const next = state.sources.find((s) => s.words.length) || state.sources[0] || null;
    state.activeId = null;
    state.sel = null; state.selOverride = null;
    setActive(next ? next.id : null);
  }
  emit('sources');
  if (gone) emit('clips', { removed: [] });
  setStatus(`Removed ${src.name}${gone ? ` and its ${gone} clip${gone === 1 ? '' : 's'}` : ''}.`);
}

/** Cancel the current transcription and everything still waiting. */
export function cancelAll() {
  cancelled = true;
  for (const q of queue.splice(0)) setSrc(q.src, { status: 'cancelled' });
  transcriber.cancel();
}

async function run() {
  if (running) return;
  running = true;
  setBusy('load', true);
  while (queue.length) {
    const item = queue.shift();
    current = item;
    cancelled = false;
    try {
      await process(item);
    } catch (err) {
      handleFailure(item, err);
    }
    current = null;
  }
  progress(null);
  running = false;
  setBusy('load', false);
}

function handleFailure(item, err) {
  const { src } = item;
  if (item.removed) return;
  const code = err && err.code;
  if (code === 'CANCELLED') {
    src.words = [];
    setSrc(src, { status: 'cancelled', progress: null });
    setStatus('Cancelled. Nothing was kept. Hit Retry on the file whenever you like.');
    emit('words', src.id);
    return;
  }
  if (SOFT_FAIL.has(code)) {
    if (code === 'TIER_LIMIT') showUpgrade(err, src.name);
    else showError(err, src.name);
    removeSource(src.id);
    setStatus(code === 'TIER_LIMIT' ? 'That file is over the free limit, so it was not loaded. Nothing was cut short.' : 'That file could not be used. The others carry on.');
    return;
  }
  console.error(err);
  src.words = [];
  setSrc(src, { status: 'failed', error: err, progress: null });
  showError(err, src.name);
  setStatus('Something went wrong with that file. Try Retry, or drop the next one.');
  emit('words', src.id);
}

function check() { if (cancelled) throw new VoxError('CANCELLED', 'Cancelled'); }

/** Decode, then apply the tier's length limit to the DECODED duration (never the file size). */
async function decodeForTier(file) {
  const buffer = await decodeFile(file);
  const verdict = checkDuration(buffer.duration);
  if (!verdict.ok) {
    throw new VoxError('TIER_LIMIT', 'Over the tier length limit', { duration: buffer.duration, limit: verdict.limit, tier: verdict.tier });
  }
  return buffer;
}

async function process(item) {
  const { src, file } = item;
  const fileName = src.name;

  // 1. read
  setSrc(src, { status: 'decoding' });
  progress({ name: fileName, label: `Reading ${fileName}`, pct: null });
  setStatus(`Reading ${fileName}...`);
  const hash = await hashFile(file);
  check();

  // Already have this exact file? Relink or skip, never duplicate.
  const dup = state.sources.find((s) => s !== src && s.hash === hash);
  if (dup) {
    if (dup.buffer) {
      removeSource(src.id);
      setActive(dup.id);
      setStatus(`${fileName} is already loaded, so I switched to it.`);
      return;
    }
    const buffer = await decodeForTier(file);
    check();
    dup.buffer = buffer;
    dup.peaks = await computePeaks(buffer, bucketsFor(buffer.duration));
    dup.duration = buffer.duration || dup.duration;
    setSrc(dup, { status: dup.words.length ? 'ready' : srcMeta(dup.id).status });
    removeSource(src.id);
    setActive(dup.id);
    emit('relinked', dup.id);
    setStatus(`Relinked the audio for ${dup.name}. Playback and export are back on.`);
    return;
  }

  setStatus(`Decoding ${fileName}...`);
  const buffer = await decodeForTier(file);
  check();
  src.hash = hash;
  src.buffer = buffer;
  src.duration = buffer.duration;
  src.peaks = await computePeaks(buffer, bucketsFor(buffer.duration));
  check();
  emit('sources');
  if (!state.activeId || !getSource(state.activeId)) setActive(src.id);

  // 2. transcript: cache first
  const model = state.settings.model;
  src.model = model;
  const cached = await getTranscript(hash, model).catch(() => null);
  check();
  if (cached && Array.isArray(cached.words) && cached.words.length) {
    src.words = cached.words;
    setSrc(src, { status: 'cache', progress: null });
    emit('words', src.id);
    finish(src, ' (from cache, instant)');
    return;
  }

  // 3. transcribe
  setSrc(src, { status: 'transcribing', progress: { pct: 0 } });
  progress({ name: fileName, label: 'Preparing the audio', pct: null });
  setStatus(`Preparing ${fileName} for the speech engine...`);
  const audio16 = await to16kMono(buffer);
  check();
  const modelMb = MODEL_MB[model] || 75;

  const result = await transcriber.transcribe(audio16, {
    model,
    onStage(stage) {
      if (stage === 'loading-model') {
        progress({ name: fileName, label: 'Waking up the speech engine', pct: null });
        setStatus('Waking up the speech engine...');
      } else if (stage === 'transcribing') {
        progress({ name: fileName, label: `Transcribing ${fileName}`, pct: 0 });
        setStatus(`Transcribing ${fileName}: 0%`);
      }
    },
    onDownload({ loaded, total }) {
      const tot = total > 1e6 ? total / 1e6 : modelMb;
      const got = Math.min(tot, (loaded || 0) / 1e6);
      const pct = tot ? Math.min(100, (got / tot) * 100) : null;
      const label = `Downloading speech model, first time only: ${Math.round(got)} of ${Math.round(tot)} MB`;
      progress({ name: fileName, label, pct, download: true });
      setStatus(label);
    },
    onPartial({ words, doneSec, totalSec }) {
      src.words = words;
      const pct = totalSec ? Math.min(99, Math.round((doneSec / totalSec) * 100)) : null;
      progress({ name: fileName, label: `Transcribing ${fileName}`, pct, detail: `${words.length} words so far` });
      setStatus(`Transcribing ${fileName}: ${pct ?? 0}% (${words.length} words so far)`);
      emit('words', src.id);
    },
  });
  check();
  src.words = result.words;
  await putTranscript(hash, model, { name: src.name, duration: src.duration, words: src.words }).catch(() => {});
  setSrc(src, { status: 'ready', progress: null });
  emit('words', src.id);
  finish(src, '');
}

function finish(src, suffix) {
  progress({ name: src.name, label: 'Done', pct: 100 });
  const n = src.words.length;
  if (!getSource(state.activeId)) setActive(src.id);
  if (!n) setStatus(`${src.name} finished, but I could not hear any words in it.`);
  else setStatus(`Done${suffix}. ${n} words in ${src.name} (${fmtClock(src.duration)}). Click and drag across words to pick them.`);
  emit('transcribed', src.id);
}

function bucketsFor(duration) {
  return Math.min(120000, Math.max(4000, Math.ceil((duration || 1) * 200)));
}

