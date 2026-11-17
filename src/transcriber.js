// Main-thread side of the speech-to-text worker (src/asr-worker.js).
// One transcription at a time. Any failure or cancel terminates the worker, and
// the next call builds a fresh one. A worker that finishes cleanly is kept warm
// so the model does not have to be loaded again.
import { VoxError } from './errors.js';

const LOAD_TIMEOUT_MS = 60_000;
const WORK_TIMEOUT_MS = 180_000;

export function createTranscriber() {
  let worker = null;
  let pending = null; // { id, words, opts, ready, threads, timer, resolve, reject }
  let nextId = 0;

  function clearTimer() {
    if (pending && pending.timer) {
      clearTimeout(pending.timer);
      pending.timer = null;
    }
  }

  function killWorker() {
    if (worker) {
      worker.onmessage = null;
      worker.onerror = null;
      try { worker.terminate(); } catch { /* ignore */ }
      worker = null;
    }
  }

  function fail(err) {
    const p = pending;
    pending = null;
    if (p && p.timer) clearTimeout(p.timer);
    killWorker();
    if (p) p.reject(err);
  }

  function armTimer() {
    if (!pending) return;
    clearTimer();
    const loading = !pending.ready;
    pending.timer = setTimeout(() => {
      fail(loading
        ? new VoxError('MODEL_DOWNLOAD', 'Timed out waiting for the speech model')
        : new VoxError('TIMEOUT', 'Transcription stalled'));
    }, loading ? LOAD_TIMEOUT_MS : WORK_TIMEOUT_MS);
  }

  function handleMessage(e) {
    const m = e.data || {};
    const p = pending;
    if (!p) return;
    const opts = p.opts;
    switch (m.type) {
      case 'download':
        if (!p.downloading) {
          p.downloading = true;
          opts.onStage?.('downloading');
        }
        armTimer();
        opts.onDownload?.({ loaded: m.loaded, total: m.total });
        break;
      case 'ready':
        if (!p.ready) {
          p.ready = true;
          p.threads = m.threads;
          opts.onStage?.('transcribing');
        }
        armTimer();
        break;
      case 'partial':
        if (m.id !== p.id) break;
        armTimer();
        p.words.push(...m.words);
        opts.onPartial?.({
          words: p.words.slice(),
          newWords: m.words,
          doneSec: m.doneSec,
          totalSec: m.totalSec,
          window: m.window,
          windows: m.windows,
        });
        break;
      case 'done':
        if (m.id !== p.id) break;
        clearTimer();
        pending = null;
        p.resolve({ words: p.words, elapsedMs: m.elapsedMs, threads: p.threads });
        break;
      case 'error':
        if (m.id !== undefined && m.id !== p.id) break;
        fail(p.ready
          ? new VoxError('WORKER', m.message || 'Worker error')
          : new VoxError('MODEL_DOWNLOAD', m.message || 'Could not load the speech model'));
        break;
      default:
        break;
    }
  }

  function handleWorkerError(e) {
    if (!pending) return;
    const msg = (e && e.message) || 'Worker failed to start';
    fail(pending.ready ? new VoxError('WORKER', msg) : new VoxError('MODEL_DOWNLOAD', msg));
  }

  function transcribe(audio16k, opts = {}) {
    if (pending) return Promise.reject(new VoxError('WORKER', 'busy'));
    return new Promise((resolve, reject) => {
      try {
        if (!worker) {
          worker = new Worker(new URL('./asr-worker.js', import.meta.url), { type: 'module' });
        }
        worker.onmessage = handleMessage;
        worker.onerror = handleWorkerError;
        const id = ++nextId;
        pending = { id, words: [], opts, ready: false, downloading: false, threads: undefined, timer: null, resolve, reject };
        opts.onStage?.('loading-model');
        armTimer();
        worker.postMessage({ type: 'transcribe', id, model: opts.model, audio: audio16k });
      } catch (err) {
        const ve = new VoxError('WORKER', (err && err.message) || 'Could not start the transcriber');
        if (pending) fail(ve);
        else {
          killWorker();
          reject(ve);
        }
      }
    });
  }

  function cancel() {
    if (pending) fail(new VoxError('CANCELLED', 'Cancelled'));
  }

  return {
    transcribe,
    cancel,
    get busy() {
      return pending !== null;
    },
  };
}
