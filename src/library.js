// Searching and planning across every transcribed source ("the library").
// Words are matched on a normalized token. A word that normalizes to nothing
// (a lone dash, say) is invisible to matching but still occupies a word index,
// so a phrase that spans it returns an i0..i1 range that includes it.

const MAX_PHRASE = 8;

export function normToken(text) {
  return String(text == null ? '' : text)
    .toLowerCase()
    .replace(/[‘’‛ʼ′`´]/g, "'")
    .replace(/[^\p{L}\p{N}']/gu, '')
    .replace(/^'+|'+$/g, '');
}

export function tokenize(line) {
  return String(line || '')
    .split(/\s+/)
    .map(normToken)
    .filter(Boolean);
}

// Per-source token index, built once and reused. Keyed by the words array.
const cache = new WeakMap();

function indexOf(source) {
  const words = source.words || [];
  let ix = cache.get(words);
  if (ix && ix.len === words.length) return ix;
  const toks = [];
  const idx = [];
  const first = new Map();
  for (let i = 0; i < words.length; i++) {
    const t = normToken(words[i].text);
    if (!t) continue;
    const p = toks.length;
    toks.push(t);
    idx.push(i);
    const list = first.get(t);
    if (list) list.push(p);
    else first.set(t, [p]);
  }
  ix = { len: words.length, toks, idx, first };
  cache.set(words, ix);
  return ix;
}

function findTokens(sources, tokens) {
  const out = [];
  const L = tokens.length;
  if (!L) return out;
  for (const source of sources) {
    const { toks, idx, first } = indexOf(source);
    const starts = first.get(tokens[0]);
    if (!starts) continue;
    for (const p of starts) {
      if (p + L > toks.length) break;
      let ok = true;
      for (let k = 1; k < L; k++) {
        if (toks[p + k] !== tokens[k]) {
          ok = false;
          break;
        }
      }
      if (ok) out.push({ sourceId: source.id, i0: idx[p], i1: idx[p + L - 1] });
    }
  }
  return out;
}

export function searchLibrary(sources, query) {
  return findTokens(sources, tokenize(query));
}

export function wordIndex(sources) {
  const map = new Map();
  for (const source of sources) {
    const words = source.words || [];
    for (let i = 0; i < words.length; i++) {
      const t = normToken(words[i].text);
      if (!t) continue;
      const m = { sourceId: source.id, i0: i, i1: i };
      const list = map.get(t);
      if (list) list.push(m);
      else map.set(t, [m]);
    }
  }
  return map;
}

export function planLine(sources, line) {
  const items = [];
  for (const raw of String(line || '').split(/\s+/)) {
    const token = normToken(raw);
    if (token) items.push({ raw, token });
  }
  const tokens = items.map((x) => x.token);
  const slots = [];
  let i = 0;
  while (i < tokens.length) {
    let chosen = null;
    for (let L = Math.min(MAX_PHRASE, tokens.length - i); L >= 1; L--) {
      const takes = findTokens(sources, tokens.slice(i, i + L));
      if (takes.length) {
        chosen = { L, takes };
        break;
      }
    }
    if (chosen) {
      const part = items.slice(i, i + chosen.L);
      slots.push({ tokens: part.map((x) => x.token), text: part.map((x) => x.raw).join(' '), takes: chosen.takes, missing: false });
      i += chosen.L;
    } else {
      slots.push({ tokens: [tokens[i]], text: items[i].raw, takes: [], missing: true });
      i += 1;
    }
  }
  return slots;
}

export function planLines(sources, text) {
  const lines = [];
  const missing = [];
  const seen = new Set();
  for (const row of String(text || '').split(/\r?\n/)) {
    if (!row.trim() || !tokenize(row).length) continue;
    const slots = planLine(sources, row);
    lines.push({ text: row.trim(), slots });
    for (const s of slots) {
      if (!s.missing) continue;
      const t = s.tokens[0];
      if (!seen.has(t)) {
        seen.add(t);
        missing.push(t);
      }
    }
  }
  return { lines, missing };
}
