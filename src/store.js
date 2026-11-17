// Persistence: an IndexedDB transcript cache and project save/load.
// Nothing here ever leaves the device.
import { VoxError } from './errors.js';

const DB_NAME = 'vox-slice';
const STORE = 'transcripts';

let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve) => {
      try {
        if (typeof indexedDB === 'undefined') return resolve(null);
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
  }
  return dbPromise;
}

// Runs one request against the store. Resolves to `fallback` on any failure.
async function run(mode, fn, fallback) {
  try {
    const db = await openDb();
    if (!db) return fallback;
    return await new Promise((resolve) => {
      try {
        const tx = db.transaction(STORE, mode);
        const req = fn(tx.objectStore(STORE));
        let result = fallback;
        if (req) req.onsuccess = () => { result = req.result === undefined ? fallback : req.result; };
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => resolve(fallback);
        tx.onabort = () => resolve(fallback);
      } catch {
        resolve(fallback);
      }
    });
  } catch {
    return fallback;
  }
}

// The trailing tag is the word-timing version. Bump it whenever the way word times are worked out
// changes, so nobody keeps getting old timings from their cache.
const TIMING = 't2';
const keyOf = (hash, model) => `${hash}|${model}|${TIMING}`;

export async function getTranscript(hash, model) {
  const rec = await run('readonly', (s) => s.get(keyOf(hash, model)), null);
  if (!rec || !Array.isArray(rec.words)) return null;
  return { name: rec.name, duration: rec.duration, words: rec.words };
}

export async function putTranscript(hash, model, { name, duration, words }) {
  await run('readwrite', (s) => s.put({ key: keyOf(hash, model), hash, model, name, duration, words, savedAt: Date.now() }), null);
}

export async function listTranscripts() {
  const all = await run('readonly', (s) => s.getAll(), []);
  return (Array.isArray(all) ? all : []).map((r) => ({
    hash: r.hash,
    model: r.model,
    name: r.name,
    duration: r.duration,
    words: r.words ? r.words.length : 0,
    savedAt: r.savedAt,
  }));
}

export async function clearTranscripts() {
  await run('readwrite', (s) => s.clear(), null);
}

/* ---------- project files ---------- */

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

export function serializeProject({ sources = [], clips = [], settings = {} } = {}) {
  return {
    app: 'vox-slice',
    version: 1,
    savedAt: new Date().toISOString(),
    settings: { ...settings },
    sources: sources.map((s) => ({
      id: s.id,
      name: s.name,
      hash: s.hash,
      duration: s.duration,
      model: s.model,
      words: s.words.map((w) => {
        const o = { text: w.text, start: w.start, end: w.end };
        if (w.guessed) o.guessed = true;
        return o;
      }),
    })),
    clips: clips.map((c) => ({ id: c.id, sourceId: c.sourceId, i0: c.i0, i1: c.i1, text: c.text, start: c.start, end: c.end })),
  };
}

function parseWords(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const w of list) {
    if (!w || typeof w.text !== 'string' || !isNum(w.start) || !isNum(w.end)) return null;
    const o = { text: w.text, start: w.start, end: w.end };
    if (w.guessed) o.guessed = true;
    out.push(o);
  }
  return out;
}

export function parseProject(input) {
  let data = input;
  if (typeof input === 'string') {
    try {
      data = JSON.parse(input);
    } catch {
      throw new VoxError('BAD_PROJECT', 'Not valid JSON');
    }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data) || data.app !== 'vox-slice') {
    throw new VoxError('BAD_PROJECT', 'Not a Vox-Slice project');
  }
  if (!isNum(data.version) || data.version < 1) throw new VoxError('BAD_PROJECT', 'Missing project version');
  if (!Array.isArray(data.sources)) throw new VoxError('BAD_PROJECT', 'Project has no sources list');

  const sources = [];
  const ids = new Set();
  for (const s of data.sources) {
    if (!s || typeof s !== 'object' || typeof s.id !== 'string' || !s.id || ids.has(s.id)) continue;
    const words = parseWords(s.words);
    if (!words) continue;
    ids.add(s.id);
    sources.push({
      id: s.id,
      name: typeof s.name === 'string' ? s.name : 'Untitled',
      hash: typeof s.hash === 'string' ? s.hash : '',
      duration: isNum(s.duration) ? s.duration : words.length ? words[words.length - 1].end : 0,
      model: typeof s.model === 'string' ? s.model : '',
      words,
      buffer: null,
      peaks: null,
    });
  }

  const byId = new Map(sources.map((s) => [s.id, s]));
  const clips = [];
  if (Array.isArray(data.clips)) {
    for (const c of data.clips) {
      if (!c || typeof c !== 'object') continue;
      const src = byId.get(c.sourceId);
      if (!src || typeof c.id !== 'string' || !c.id) continue;
      if (!Number.isInteger(c.i0) || !Number.isInteger(c.i1)) continue;
      if (c.i0 < 0 || c.i1 < c.i0 || c.i1 >= src.words.length) continue;
      if (!isNum(c.start) || !isNum(c.end) || c.end <= c.start || c.start < 0) continue;
      const text = typeof c.text === 'string' ? c.text : src.words.slice(c.i0, c.i1 + 1).map((w) => w.text).join(' ');
      clips.push({ id: c.id, sourceId: c.sourceId, i0: c.i0, i1: c.i1, text, start: c.start, end: c.end });
    }
  }

  const settings = data.settings && typeof data.settings === 'object' && !Array.isArray(data.settings) ? { ...data.settings } : {};
  return { sources, clips, settings };
}
