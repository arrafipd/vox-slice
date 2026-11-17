// Search across every loaded speech, plus the rhyme finder.
import { searchLibrary, wordIndex } from '../library.js';
import { loadRhymes, findRhymes } from '../rhyme.js';
import { state, on, emit, getSource, setActive, setSelection, addClip, setStatus } from './state.js';
import { el, tid, clear, debounce, pluralise } from './dom.js';
import { revealWord } from './transcript.js';
import { showTab } from './tabs.js';

let input, countEl, addBtn, results;
let cursor = -1;

function snippet(src, m) {
  const w = src.words;
  const a = Math.max(0, m.i0 - 3), b = Math.min(w.length - 1, m.i1 + 3);
  const frag = document.createDocumentFragment();
  if (a > 0) frag.append('… ');
  for (let i = a; i <= b; i++) {
    const hit = i >= m.i0 && i <= m.i1;
    frag.append(hit ? el('mark', { text: w[i].text }) : w[i].text, i < b ? ' ' : '');
  }
  if (b < w.length - 1) frag.append(' …');
  return frag;
}

export function selectMatch(m) {
  showTab('slice');
  setActive(m.sourceId);
  setSelection(m.sourceId, m.i0, m.i1, m.i0);
  requestAnimationFrame(() => revealWord(m.i0));
}

function renderResults() {
  clear(results);
  const ms = state.matches;
  if (!ms.length) { results.hidden = true; return; }
  results.hidden = false;
  const groups = new Map();
  ms.forEach((m, idx) => {
    if (!groups.has(m.sourceId)) groups.set(m.sourceId, []);
    groups.get(m.sourceId).push([m, idx]);
  });
  let shown = 0;
  for (const [sid, items] of groups) {
    const src = getSource(sid);
    if (!src) continue;
    const g = el('li', { class: 'res-group' }, el('div', { class: 'res-head' }, el('span', { text: src.name }), el('b', { class: 'num', text: String(items.length) })));
    const ul = el('ul', { class: 'res-items' });
    for (const [m, idx] of items) {
      if (shown >= 40) break;
      shown++;
      const b = el('button', { type: 'button', class: 'res-item', dataset: { idx } });
      b.append(snippet(src, m));
      b.addEventListener('click', () => { cursor = idx; selectMatch(m); });
      ul.append(el('li', {}, b));
    }
    g.append(ul);
    results.append(g);
  }
  if (ms.length > shown) results.append(el('li', { class: 'res-more', text: `Showing ${shown} of ${ms.length}. Narrow the search to see the rest.` }));
}

export function runSearch(q = input.value) {
  const query = q.trim();
  state.matches = query ? searchLibrary(state.sources, query) : [];
  cursor = -1;
  const n = state.matches.length;
  const srcs = new Set(state.matches.map((m) => m.sourceId)).size;
  countEl.textContent = !query ? '' : n ? `${pluralise(n, 'match', 'matches')}${state.sources.length > 1 ? ` in ${pluralise(srcs, 'speech', 'speeches')}` : ''}` : 'No matches';
  addBtn.disabled = n === 0;
  renderResults();
  emit('matches');
}

export function setSearch(text) {
  input.value = text;
  runSearch(text);
}

// ---- rhymes ------------------------------------------------------------
let rhymeInput, rhymeOut;
let rhymeMode = 'slice';
export function setRhymeMode(m) { rhymeMode = m; }
let rhymeLoad = null;

function chip(word, count) {
  const b = el('button', { type: 'button', class: 'rchip', title: rhymeMode === 'builder' ? `Add "${word}" to your lyrics` : `Search for "${word}"` },
    el('span', { text: word }), el('b', { class: 'num', text: `×${count}` }));
  b.addEventListener('click', () => {
    if (rhymeMode === 'builder') emit('builder-insert', word);
    else { showTab('slice'); setSearch(word); }
  });
  return b;
}

async function runRhymes(word) {
  const w = word.trim();
  clear(rhymeOut);
  if (!w) { rhymeOut.append(el('p', { class: 'hint', text: 'Type a word to see what rhymes with it in your speeches.' })); return; }
  if (!rhymeLoad) rhymeLoad = loadRhymes();
  try { await rhymeLoad; } catch { rhymeLoad = null; clear(rhymeOut); rhymeOut.append(el('p', { class: 'hint warn', text: 'Could not load the rhyme dictionary. Check your connection and try again.' })); return; }
  if (rhymeInput.value.trim() !== w) return; // stale
  const idx = wordIndex(state.sources);
  const r = findRhymes(w, [...idx.keys()]);
  clear(rhymeOut);
  if (!r.known) { rhymeOut.append(el('p', { class: 'hint', text: `"${w}" is not in the rhyme dictionary. Try a simpler spelling or a different word.` })); return; }
  if (!r.perfect.length && !r.near.length) {
    rhymeOut.append(el('p', { class: 'hint', text: state.sources.length ? 'No rhymes in your library yet. Load more speech and they will show up here.' : 'No rhymes in your library yet. Load a speech first.' }));
    return;
  }
  for (const [label, arr] of [['Perfect', r.perfect], ['Near', r.near]]) {
    if (!arr.length) continue;
    const g = el('div', { class: 'rgroup' }, el('h4', { text: `${label} rhymes` }));
    const row = el('div', { class: 'rchips' });
    for (const x of arr) row.append(chip(x, (idx.get(x) || []).length));
    g.append(row);
    rhymeOut.append(g);
  }
}

export function findRhymesFor(word) {
  rhymeInput.value = word;
  runRhymes(word);
}

export function initSearch() {
  input = tid('search-input');
  countEl = tid('match-count');
  addBtn = tid('add-matches-btn');
  results = document.getElementById('search-results');
  const deb = debounce(() => runSearch(), 120);
  input.addEventListener('input', deb);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && state.matches.length) {
      e.preventDefault();
      cursor = (cursor + 1) % state.matches.length;
      selectMatch(state.matches[cursor]);
    } else if (e.key === 'Escape') { input.value = ''; runSearch(); input.blur(); }
  });
  addBtn.addEventListener('click', () => {
    const added = state.matches.map((m) => addClip(m.sourceId, m.i0, m.i1, { silent: true })).filter(Boolean);
    if (!added.length) return;
    emit('clips', { added });
    setStatus(`Added ${pluralise(added.length, 'clip')} to the rack.`);
  });
  on('sources', debounce(() => { if (input.value.trim()) runSearch(); }, 150));
  on('words', debounce(() => { if (input.value.trim()) runSearch(); }, 300));

  rhymeInput = tid('rhyme-input');
  rhymeOut = tid('rhyme-results');
  rhymeInput.addEventListener('input', debounce(() => runRhymes(rhymeInput.value), 180));
  rhymeInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); runRhymes(rhymeInput.value); } });
  on('rhyme-request', (e) => { findRhymesFor(e.detail); document.getElementById('rhyme-panel').scrollIntoView({ block: 'nearest' }); });
  on('sources', debounce(() => { if (rhymeInput.value.trim()) runRhymes(rhymeInput.value); }, 300));
  on('tab', (e) => { rhymeMode = e.detail === 'builder' ? 'builder' : 'slice'; runRhymes(rhymeInput.value); });
  runRhymes('');
}
