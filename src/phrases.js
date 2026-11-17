// The "AI Rap Pack" round trip: transcript text out, a phrase list back in,
// and each phrase matched against the word timings of every loaded speech.
// Pure functions only (no DOM), so all of this runs in Node for tests.
import { normToken } from './library.js';

// ---- transcript and prompt text --------------------------------------------

export const PHRASES_MARKER = '### PHRASES';

/** The words of a speech as readable text, broken into lines at sentence ends. */
export function transcriptBody(source) {
  const lines = [];
  let line = '';
  for (const w of (source && source.words) || []) {
    const t = String(w.text || '').trim();
    if (!t) continue;
    line += (line ? ' ' : '') + t;
    if (line.length >= 80 && /[.!?]["')\]]?$/.test(t)) { lines.push(line); line = ''; }
  }
  if (line) lines.push(line);
  return lines.join('\n');
}

/** Output A: plain text with the source file name as a header. */
export function transcriptText(source) {
  const name = (source && source.name) || 'speech';
  return `${name}\n${'='.repeat(Math.min(60, Math.max(8, name.length)))}\n\n${transcriptBody(source)}\n`;
}

export function allTranscriptsText(sources) {
  return (sources || []).map(transcriptText).join('\n\n');
}

/** Output B: a ready-to-paste prompt followed by the full transcript(s). */
export function aiPromptText(sources) {
  const list = sources || [];
  const many = list.length > 1;
  const head = [
    `You are helping me make a funny parody rap out of ${many ? 'some real speeches' : 'a real speech'}.`,
    `The word-for-word transcript${many ? 's are' : ' is'} at the bottom of this message.`,
    '',
    'Do these two things, in this order:',
    '',
    `1) Write a funny rap (about 12 to 16 lines) built from lines and phrases that appear in the transcript${many ? 's' : ''}. Reuse the speaker's actual words as much as you can.`,
    '',
    '2) After the rap, output a section that starts with this exact line:',
    PHRASES_MARKER,
    'Under that line, list the key words and phrases from the transcript that you used in the rap.',
    'Rules for the list:',
    '- ONE phrase per line.',
    '- Copy each phrase WORD FOR WORD from the transcript. Do not paraphrase. Do not fix grammar or spelling.',
    '- No numbering, no bullets, no quotes, no extra commentary.',
    '- Keep each phrase short (about 1 to 8 words). The words must appear together, in that order, in the transcript.',
    '- Do not write anything after the list.',
    '',
    many ? 'TRANSCRIPTS' : 'TRANSCRIPT',
    '==========',
    '',
  ].join('\n');
  return head + allTranscriptsText(list);
}

// ---- reading a pasted phrase list ------------------------------------------

const QUOTES = /["“”„‟«»‹›]/g;

function cleanPhraseLine(raw) {
  let s = String(raw || '').trim();
  if (!s || /^(```|~~~)/.test(s)) return '';
  s = s.replace(/^(?:[-*+•·▪◦‣–—>]+\s*)+/, '');           // bullets and quote markers
  s = s.replace(/^\(?\d{1,3}[.):\]]\s+/, '');             // 1.  1)  (1)  1:
  s = s.replace(/^[-*+•]\s+/, '');                        // a bullet after the number
  s = s.replace(/[*_`~]+/g, '');                          // markdown emphasis
  s = s.replace(QUOTES, '');
  s = s.replace(/^[‘’']+|[‘’']+$/g, '');                  // wrapping single quotes
  s = s.replace(/^[\s.,;:!?…\-–—()[\]{}]+|[\s.,;:!?…\-–—()[\]{}]+$/g, '');
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Turns pasted text into a list of phrases. If it contains "### PHRASES", only
 * the lines after it count; otherwise every non-empty line does. Returns
 * { phrases, usedMarker }. Duplicates (after normalizing) are dropped.
 */
export function parsePhraseList(text) {
  const src = String(text || '').replace(/\r\n?/g, '\n');
  const m = /^[ \t>*_]*#{1,6}[ \t]*PHRASES\b.*$/im.exec(src);
  const body = m ? src.slice(m.index + m[0].length) : src;
  const phrases = [];
  const seen = new Set();
  for (const row of body.split('\n')) {
    const p = cleanPhraseLine(row);
    if (!p) continue;
    const key = canonTokens(p).join(' ');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    phrases.push(p);
  }
  return { phrases, usedMarker: !!m };
}

// ---- matching ---------------------------------------------------------------

const WHOLE = {
  "won't": ['will', 'not'], "can't": ['can', 'not'], cannot: ['can', 'not'], "shan't": ['shall', 'not'],
  "ain't": ['is', 'not'], "let's": ['let', 'us'], "y'all": ['you', 'all'],
  gonna: ['going', 'to'], wanna: ['want', 'to'], gotta: ['got', 'to'], gimme: ['give', 'me'], lemme: ['let', 'me'],
  kinda: ['kind', 'of'], sorta: ['sort', 'of'], outta: ['out', 'of'],
};
const IS_WORDS = new Set(['it', 'that', 'there', 'here', 'he', 'she', 'what', 'who', 'where', 'how', 'when', 'why']);
const SUFFIX = [["n't", 'not'], ["'re", 'are'], ["'ve", 'have'], ["'ll", 'will'], ["'d", 'would'], ["'m", 'am']];

/** One spoken word -> the canonical tokens used for matching ("we've" -> we, have). */
export function canonWord(text) {
  const t = normToken(text);
  if (!t) return [];
  if (WHOLE[t]) return WHOLE[t];
  for (const [suf, word] of SUFFIX) {
    if (t.length > suf.length && t.endsWith(suf)) return [t.slice(0, -suf.length).replace(/'/g, ''), word].filter(Boolean);
  }
  if (t.endsWith("'s") && IS_WORDS.has(t.slice(0, -2))) return [t.slice(0, -2), 'is'];
  const bare = t.replace(/'/g, '');           // possessives and dropped letters: trump's = trumps, goin' = goin
  return bare ? [bare] : [];
}

export function canonTokens(line) {
  const out = [];
  for (const raw of String(line || '').split(/\s+/)) out.push(...canonWord(raw));
  return out;
}

const cache = new WeakMap();

// Canonical token stream for a source. widx[k] is the word a token came from;
// first/last say whether the token starts/ends that word.
function indexOf(source) {
  const words = source.words || [];
  let ix = cache.get(words);
  if (ix && ix.len === words.length) return ix;
  const toks = [], widx = [], first = [], last = [];
  const starts = new Map();
  for (let i = 0; i < words.length; i++) {
    const parts = canonWord(words[i].text);
    parts.forEach((t, k) => {
      const p = toks.length;
      toks.push(t); widx.push(i); first.push(k === 0); last.push(k === parts.length - 1);
      const l = starts.get(t);
      if (l) l.push(p); else starts.set(t, [p]);
    });
  }
  ix = { len: words.length, toks, widx, first, last, starts };
  cache.set(words, ix);
  return ix;
}

function charDistance(a, b, cap) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      cur.push(v);
      if (v < best) best = v;
    }
    if (best > cap) return cap + 1;
    prev = cur;
  }
  return prev[b.length];
}

/** Near-miss spellings: one letter off for mid-length words, two for long ones. */
export function similarTokens(a, b) {
  if (a === b) return true;
  const n = Math.min(a.length, b.length);
  if (n < 4) return false;
  const cap = n >= 8 ? 2 : 1;
  return charDistance(a, b, cap) <= cap;
}

// Word-level edit distance in half-word units: same word 0, near-miss spelling 1,
// a wrong, extra or dropped word 2.
function windowCost(P, toks, p, len, limit) {
  const L = P.length;
  let prev = Array.from({ length: len + 1 }, (_, j) => j * 2);
  for (let i = 1; i <= L; i++) {
    const cur = [i * 2];
    let best = cur[0];
    for (let j = 1; j <= len; j++) {
      const a = P[i - 1], b = toks[p + j - 1];
      const sub = a === b ? 0 : similarTokens(a, b) ? 1 : 2;
      const v = Math.min(prev[j] + 2, cur[j - 1] + 2, prev[j - 1] + sub);
      cur.push(v);
      if (v < best) best = v;
    }
    if (best > limit) return limit + 1;
    prev = cur;
  }
  return prev[len];
}

function fuzzyLimit(P) {
  const L = P.length;
  if (L >= 8) return 4;                       // two words off in a long phrase
  if (L >= 3) return 2;                       // one word off
  if (L === 2) return 1;                      // one near-miss spelling
  return P[0].length >= 5 ? 1 : 0;            // single word: near-miss spelling, long words only
}

function exactIn(source, P) {
  const { toks, widx, first, last, starts } = indexOf(source);
  const out = [];
  const L = P.length;
  for (const p of starts.get(P[0]) || []) {
    if (p + L > toks.length) break;
    let ok = true;
    for (let k = 1; k < L; k++) if (toks[p + k] !== P[k]) { ok = false; break; }
    if (!ok) continue;
    // A match that starts or ends in the middle of a contraction ("have got" inside
    // "we've got") is real, but the clip carries the whole word, so call it close.
    const clean = first[p] && last[p + L - 1];
    out.push({ sourceId: source.id, i0: widx[p], i1: widx[p + L - 1], quality: clean ? 'exact' : 'close', cost: clean ? 0 : 1 });
  }
  return out;
}

function closeIn(source, P) {
  const limit = fuzzyLimit(P);
  if (!limit) return [];
  const { toks, widx } = indexOf(source);
  const L = P.length;
  const cands = [];
  for (let p = 0; p < toks.length; p++) {
    let best = null;
    for (const len of [L, L - 1, L + 1]) {
      if (len < 1 || p + len > toks.length) continue;
      const cost = windowCost(P, toks, p, len, limit);
      if (cost <= limit && (!best || cost < best.cost)) best = { cost, len };
    }
    if (best) cands.push({ p, end: p + best.len - 1, cost: best.cost, len: best.len });
  }
  // Overlapping windows describe the same spot: keep the cheapest of each cluster.
  // Ties go to the window whose first and last words are the phrase's own.
  const anchored = (c) => (similarTokens(P[0], toks[c.p]) ? 1 : 0) + (similarTokens(P[L - 1], toks[c.end]) ? 1 : 0);
  cands.sort((a, b) => a.cost - b.cost || anchored(b) - anchored(a) || Math.abs(a.len - L) - Math.abs(b.len - L) || a.p - b.p);
  const kept = [];
  for (const c of cands) {
    if (kept.some((k) => c.p <= k.end && k.p <= c.end)) continue;
    kept.push(c);
  }
  kept.sort((a, b) => a.p - b.p);
  return kept.map((c) => ({ sourceId: source.id, i0: widx[c.p], i1: widx[c.end], quality: 'close', cost: c.cost }));
}

/**
 * Matches each phrase against every source that has words.
 * Returns [{ text, quality: 'exact' | 'close' | 'none', matches: [{ sourceId, i0, i1, quality }] }].
 * The fuzzy pass only runs for a phrase with no exact match anywhere.
 */
export function matchPhrases(sources, phrases) {
  const live = (sources || []).filter((s) => s && s.words && s.words.length);
  return (phrases || []).map((text) => {
    const P = canonTokens(text);
    let matches = [];
    if (P.length) {
      for (const s of live) matches.push(...exactIn(s, P));
      if (!matches.some((m) => m.quality === 'exact')) {
        const seen = new Set(matches.map((m) => `${m.sourceId}|${m.i0}|${m.i1}`));
        for (const s of live) {
          for (const m of closeIn(s, P)) {
            const k = `${m.sourceId}|${m.i0}|${m.i1}`;
            if (!seen.has(k)) { seen.add(k); matches.push(m); }
          }
        }
      }
    }
    const order = new Map(live.map((s, i) => [s.id, i]));
    matches.sort((a, b) => (a.quality === b.quality ? 0 : a.quality === 'exact' ? -1 : 1) || a.cost - b.cost || order.get(a.sourceId) - order.get(b.sourceId) || a.i0 - b.i0);
    matches = matches.map(({ cost, ...m }) => m);
    const quality = matches.some((m) => m.quality === 'exact') ? 'exact' : matches.length ? 'close' : 'none';
    return { text, quality, matches };
  });
}

// ---- file names -------------------------------------------------------------

const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

/** A file-name-safe version of some text for Windows: "We've got the underground!" -> "we've-got-the-underground". */
export function windowsSafe(text, max = 60) {
  let s = String(text || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[‘’‛ʼ′`´]/g, "'")
    .toLowerCase()
    .split(/[^a-z0-9']+/)
    .map((w) => w.replace(/^'+|'+$/g, '').replace(/'{2,}/g, "'"))   // keep the apostrophe inside we've, drop wrapping quotes
    .filter(Boolean)
    .join('-');
  if (s.length > max) s = s.slice(0, max).replace(/[-']+$/g, '');
  if (RESERVED.test(s)) s += '-clip';
  return s;
}

/** "01_we've-got-the-underground.wav". Three digits once there are 100 or more clips. */
export function phraseFileName({ index, text, ext, total = 0 }) {
  const width = total >= 100 ? 3 : 2;
  const n = String(Math.max(0, Math.floor(index || 0)) + 1).padStart(width, '0');
  const e = String(ext || 'wav').replace(/^\./, '').toLowerCase();
  return `${n}_${windowsSafe(text) || 'clip'}.${e}`;
}

/** A ZIP name the user typed, made safe. Returns '' when nothing usable is left. */
export function packFileName(name) {
  let s = String(name || '').trim().replace(/\.zip$/i, '');
  s = s.replace(/[<>:"/\\|?*\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').replace(/^[\s.]+|[\s.]+$/g, '');
  if (s.length > 80) s = s.slice(0, 80).replace(/[\s.]+$/g, '');
  if (!s) return '';
  if (RESERVED.test(s)) s += '-pack';
  return `${s}.zip`;
}
