// Builds public/data/rhymes.json from the CMU pronouncing dictionary.
// Runs automatically before `npm run dev` and `npm run build`.
//
// Output layout (compact on purpose):
//   { v: 1,
//     perfect: [string],   // distinct rhyme keys, e.g. "EY SH AH N"
//     near:    [string],   // distinct near keys, e.g. "EY AH N"
//     nearOf:  [number],   // nearOf[p] = index into `near` for perfect key p
//     words:   { word: p } // word -> index into `perfect`
//   }
import { mkdirSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dictionary } from 'cmu-pronouncing-dictionary';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outFile = join(root, 'public', 'data', 'rhymes.json');

const isVowel = (ph) => /\d$/.test(ph);

// Phonemes from the last stressed (1 or 2) vowel to the end; if no vowel is
// stressed (e.g. "the"), from the last vowel.
function keysFor(pron) {
  const ph = pron.trim().split(/\s+/);
  let at = -1;
  for (let i = ph.length - 1; i >= 0; i--) {
    if (/[12]$/.test(ph[i])) { at = i; break; }
  }
  if (at < 0) {
    for (let i = ph.length - 1; i >= 0; i--) {
      if (isVowel(ph[i])) { at = i; break; }
    }
  }
  if (at < 0) return null;
  const tail = ph.slice(at).map((p) => p.replace(/\d/g, ''));
  const vowels = ph.slice(at).filter(isVowel).map((p) => p.replace(/\d/g, ''));
  const last = ph[ph.length - 1];
  const near = [...vowels, ...(isVowel(last) ? [] : [last])].join(' ');
  return { perfect: tail.join(' '), near };
}

const entries = new Map(); // word -> pronunciation
for (const [raw, pron] of Object.entries(dictionary)) {
  const alt = /^(.*)\((\d+)\)$/.exec(raw);
  const word = (alt ? alt[1] : raw).toLowerCase();
  if (!/^[a-z']+$/.test(word)) continue;
  if (alt) {
    if (!entries.has(word)) entries.set(word, pron);
  } else {
    entries.set(word, pron);
  }
}

const perfect = [];
const near = [];
const nearOf = [];
const pIdx = new Map();
const nIdx = new Map();
const words = {};
for (const [word, pron] of entries) {
  const k = keysFor(pron);
  if (!k) continue;
  let n = nIdx.get(k.near);
  if (n === undefined) { n = near.length; near.push(k.near); nIdx.set(k.near, n); }
  let p = pIdx.get(k.perfect);
  if (p === undefined) { p = perfect.length; perfect.push(k.perfect); pIdx.set(k.perfect, p); nearOf.push(n); }
  words[word] = p;
}

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, JSON.stringify({ v: 1, perfect, near, nearOf, words }));
console.log(`build-rhymes: ${Object.keys(words).length} words, ${(statSync(outFile).size / 1e6).toFixed(2)} MB -> public/data/rhymes.json`);
