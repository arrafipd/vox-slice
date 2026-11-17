// Rhyme lookup backed by data/rhymes.json (built from the CMU dictionary by
// scripts/build-rhymes.mjs). See that script for the file layout.
import { normToken } from './library.js';

let loading = null;
let data = null;

/** Fetches the rhyme data once. A failed load can be retried by calling again. */
export function loadRhymes() {
  if (data) return Promise.resolve();
  if (!loading) {
    loading = (async () => {
      const res = await fetch(new URL('data/rhymes.json', document.baseURI));
      if (!res.ok) throw new Error(`Could not load rhyme data (${res.status})`);
      data = await res.json();
    })().catch((e) => {
      loading = null;
      throw e;
    });
  }
  return loading;
}

/** Pure version, used by tests and by findRhymes. */
export function rhymesFromData(d, word, candidateTokens) {
  const w = normToken(word);
  const out = { known: false, perfect: [], near: [] };
  if (!d || !d.words || !Object.hasOwn(d.words, w)) return out;
  out.known = true;
  const p = d.words[w];
  const n = d.nearOf[p];
  const perfect = new Set();
  const near = new Set();
  for (const raw of candidateTokens || []) {
    const c = normToken(raw);
    if (!c || c === w || !Object.hasOwn(d.words, c)) continue;
    const cp = d.words[c];
    if (cp === p) perfect.add(c);
    else if (d.nearOf[cp] === n) near.add(c);
  }
  out.perfect = [...perfect].sort();
  out.near = [...near].sort();
  return out;
}

/** Returns { known: false, ... } until loadRhymes() has resolved. */
export function findRhymes(word, candidateTokens) {
  return rhymesFromData(data, word, candidateTokens);
}
