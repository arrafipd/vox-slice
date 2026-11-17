// The AI Rap Pack round trip: transcript / prompt downloads for the library,
// and the "Import phrases" panel that matches a pasted list against every speech.
import { transcriptText, allTranscriptsText, aiPromptText, parsePhraseList, matchPhrases } from '../phrases.js';
import { state, on, emit, getSource, hasAudio, srcMeta, addClip, textFor, setStatus } from './state.js';
import { el, ico, tid, clear, fmtTime, saveBlob, baseName, copyText, pluralise, debounce } from './dom.js';
import { playTake, stopAll, playing } from './transport.js';
import { showError } from './notices.js';

// ---- 1) transcripts out ----------------------------------------------------

const TEXT = { type: 'text/plain;charset=utf-8' };

/** Speeches whose words are final (not still being transcribed). */
export function readySources() {
  return state.sources.filter((s) => s.words.length && !['queued', 'decoding', 'transcribing'].includes(srcMeta(s.id).status));
}

export function downloadTranscript(sourceId) {
  const src = getSource(sourceId);
  if (!src || !src.words.length) return;
  const name = `${baseName(src.name)}_transcript.txt`;
  saveBlob(new Blob([transcriptText(src)], TEXT), name);
  setStatus(`Saved ${name}.`);
}

function downloadAllTranscripts() {
  const list = readySources();
  if (!list.length) return;
  saveBlob(new Blob([allTranscriptsText(list)], TEXT), 'all-transcripts.txt');
  setStatus(`Saved all-transcripts.txt with ${pluralise(list.length, 'speech', 'speeches')}.`);
}

function downloadPrompt() {
  const list = readySources();
  if (!list.length) return;
  saveBlob(new Blob([aiPromptText(list)], TEXT), 'ai-prompt.txt');
  setStatus(`Saved ai-prompt.txt (the prompt plus ${pluralise(list.length, 'transcript')}). Paste it into your AI of choice.`);
}

async function copyPrompt(btn) {
  const list = readySources();
  if (!list.length) return;
  const ok = await copyText(aiPromptText(list));
  const span = btn.querySelector('span');
  span.textContent = ok ? 'Copied' : 'Copy failed';
  setTimeout(() => { span.textContent = 'Copy AI prompt'; }, 1600);
  setStatus(ok ? `AI prompt copied (the prompt plus ${pluralise(list.length, 'transcript')}). Paste it into your AI of choice.` : 'Could not copy. Use Download AI prompt instead.');
}

function initTranscriptTools() {
  const all = tid('dl-all-transcripts-btn');
  const dl = tid('dl-prompt-btn');
  const copy = tid('copy-prompt-btn');
  all.addEventListener('click', downloadAllTranscripts);
  dl.addEventListener('click', downloadPrompt);
  copy.addEventListener('click', () => copyPrompt(copy));
  const refresh = () => {
    const n = readySources().length;
    all.hidden = state.sources.length < 2;
    all.disabled = n < 2;
    dl.disabled = copy.disabled = n === 0;
  };
  for (const ev of ['sources', 'words']) on(ev, refresh);
  refresh();
}

// ---- 2) phrases in ----------------------------------------------------------

let input, listBox, summary, emptyNote, btnExact, btnNone, btnAdd;
let results = null;            // [{ text, quality, matches }]
let lastText = '';
const checked = new Set();     // "phrase text|sourceId|i0|i1"

const keyOf = (r, m) => `${r.text}|${m.sourceId}|${m.i0}|${m.i1}`;
const BADGE = { exact: ['exact', 'chip ok'], close: ['close match', 'chip warn'], none: ['not found', 'chip bad'] };
const badge = (q) => el('span', { class: BADGE[q][1], text: BADGE[q][0] });

function inRack(m) {
  return state.clips.some((c) => c.sourceId === m.sourceId && c.i0 === m.i0 && c.i1 === m.i1);
}

function renderResults() {
  clear(listBox);
  const has = !!(results && results.length);
  emptyNote.hidden = has;
  if (!has) { summary.textContent = ''; paintButtons(); return; }
  results.forEach((r, ri) => {
    const row = el('li', { class: `phrase q-${r.quality}`, dataset: { phrase: ri } });
    row.append(el('div', { class: 'phrase-head' },
      el('span', { class: 'bnum num', text: String(ri + 1).padStart(2, '0') }),
      el('p', { class: 'phrase-text', text: r.text }),
      badge(r.quality)));
    if (!r.matches.length) {
      row.append(el('p', { class: 'phrase-none', text: 'Not in any loaded speech. The AI may have made this one up or reworded it.' }));
    } else {
      const places = el('ul', { class: 'places' });
      r.matches.forEach((m, mi) => {
        const src = getSource(m.sourceId);
        if (!src) return;
        const k = keyOf(r, m);
        const cb = el('input', { type: 'checkbox', checked: checked.has(k), 'aria-label': `Use the take of “${r.text}” in ${src.name} at ${fmtTime(src.words[m.i0].start, 1)}` });
        cb.dataset.key = k;
        const play = el('button', { type: 'button', class: 'mini icon-only', title: hasAudio(src) ? 'Preview this take' : 'Audio missing, drop the original file to relink', 'aria-label': `Preview “${r.text}” in ${src.name}`, disabled: !hasAudio(src) }, ico('play'));
        play.dataset.act = 'play';
        const place = el('li', { class: 'place', dataset: { match: mi } },
          el('label', { class: 'check' }, cb,
            el('span', { class: 'place-where' },
              el('span', { class: 'place-src', text: src.name, title: src.name }),
              el('span', { class: 'num', text: fmtTime(src.words[m.i0].start, 1) }))),
          play, badge(m.quality));
        if (inRack(m)) place.append(el('span', { class: 'chip', text: 'in rack' }));
        if (m.quality === 'close') place.append(el('span', { class: 'place-heard', text: `Speech says: ${textFor(src, m.i0, m.i1)}` }));
        places.append(place);
      });
      row.append(places);
    }
    listBox.append(row);
  });
  const n = { exact: 0, close: 0, none: 0 };
  for (const r of results) n[r.quality]++;
  summary.textContent = `${pluralise(results.length, 'phrase')}: ${n.exact} exact, ${n.close} close, ${n.none} not found.`;
  paintButtons();
}

function paintButtons() {
  const has = !!(results && results.some((r) => r.matches.length));
  btnExact.disabled = !has || !results.some((r) => r.matches.some((m) => m.quality === 'exact'));
  btnNone.disabled = checked.size === 0;
  btnAdd.disabled = checked.size === 0;
  btnAdd.querySelector('span').textContent = checked.size ? `Add ${checked.size} checked to Clips Rack` : 'Add checked to Clips Rack';
}

function syncBoxes() {
  for (const cb of listBox.querySelectorAll('input[type="checkbox"]')) cb.checked = checked.has(cb.dataset.key);
  paintButtons();
}

function run({ quiet = false } = {}) {
  const text = input.value;
  lastText = text;
  if (!text.trim()) {
    results = null; checked.clear(); renderResults();
    if (!quiet) setStatus('Paste the AI’s reply (or just a list of phrases, one per line) first.');
    return;
  }
  if (!state.sources.some((s) => s.words.length)) {
    if (!quiet) setStatus('Load and transcribe a speech first, then import phrases.');
    return;
  }
  const { phrases, usedMarker } = parsePhraseList(text);
  results = matchPhrases(state.sources, phrases);
  const live = new Set();
  for (const r of results) for (const m of r.matches) live.add(keyOf(r, m));
  for (const k of [...checked]) if (!live.has(k)) checked.delete(k);
  renderResults();
  if (quiet) return;
  if (!phrases.length) { setStatus('No phrases found in that text. Put one phrase per line.'); return; }
  const n = { exact: 0, close: 0, none: 0 };
  for (const r of results) n[r.quality]++;
  setStatus(`${usedMarker ? 'Read the list under “### PHRASES”' : 'No “### PHRASES” line, so every line counted'}: ${pluralise(phrases.length, 'phrase')}, ${n.exact} exact, ${n.close} close, ${n.none} not found.`);
}

function addChecked() {
  if (!results || !checked.size) return;
  const added = [];
  let dupes = 0;
  for (const r of results) {
    for (const m of r.matches) {
      if (!checked.has(keyOf(r, m))) continue;
      if (inRack(m)) { dupes++; continue; }
      const c = getSource(m.sourceId) && addClip(m.sourceId, m.i0, m.i1, { silent: true });
      if (c) added.push(c);
    }
  }
  checked.clear();
  if (added.length) emit('clips', { added });
  renderResults();
  setStatus(added.length
    ? `Added ${pluralise(added.length, 'clip')} to the Clips Rack with ${state.settings.padMs} ms padding.${dupes ? ` ${dupes} already there, skipped.` : ''} Fine-tune the edges there, then export.`
    : `Nothing new to add. ${pluralise(dupes, 'take')} already in the Clips Rack.`);
}

async function readFiles(files) {
  const texts = [];
  for (const f of files) {
    if (!/\.(txt|md|text)$/i.test(f.name) && !/^text\//.test(f.type)) { setStatus(`${f.name} is not a text file. Use a .txt file.`); continue; }
    if (f.size > 2 * 1048576) { setStatus(`${f.name} is too big to be a phrase list (over 2 MB).`); continue; }
    texts.push(await f.text());
  }
  if (!texts.length) return;
  input.value = texts.join('\n');
  run();
}

function initImport() {
  input = tid('phrase-input');
  listBox = tid('phrase-results');
  summary = tid('phrase-summary');
  emptyNote = document.getElementById('phrase-empty');
  btnExact = tid('phrase-check-exact-btn');
  btnNone = tid('phrase-uncheck-btn');
  btnAdd = tid('phrase-add-btn');

  tid('phrase-match-btn').addEventListener('click', () => run());
  input.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); run(); } });

  const file = tid('phrase-file-input');
  file.addEventListener('change', async () => {
    try { await readFiles([...file.files]); } catch (err) { showError(err); }
    file.value = '';
  });

  // Dropping a .txt anywhere on the panel loads it. voxHandled tells the
  // window-level audio drop handler (dropzone.js) to leave this drop alone.
  const panel = document.getElementById('phrase-panel');
  const isFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  for (const ev of ['dragenter', 'dragover']) {
    panel.addEventListener(ev, (e) => { if (!isFiles(e)) return; e.preventDefault(); panel.classList.add('over'); });
  }
  panel.addEventListener('dragleave', (e) => { if (!panel.contains(e.relatedTarget)) panel.classList.remove('over'); });
  panel.addEventListener('drop', async (e) => {
    if (!isFiles(e)) return;
    e.preventDefault(); e.voxHandled = true;
    panel.classList.remove('over');
    try { await readFiles([...e.dataTransfer.files]); } catch (err) { showError(err); }
  });

  listBox.addEventListener('change', (e) => {
    const cb = e.target.closest('input[type="checkbox"]');
    if (!cb) return;
    if (cb.checked) checked.add(cb.dataset.key); else checked.delete(cb.dataset.key);
    paintButtons();
  });
  listBox.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-act="play"]');
    if (!b || b.disabled || !results) return;
    const r = results[+b.closest('.phrase').dataset.phrase];
    const m = r && r.matches[+b.closest('.place').dataset.match];
    if (!m) return;
    if (b.classList.contains('on')) { stopAll(); return; }
    playTake(m);
    for (const x of listBox.querySelectorAll('button.on')) x.classList.remove('on');
    if (playing.kind === 'take') b.classList.add('on');
  });
  on('playstate', () => { if (playing.kind !== 'take') for (const x of listBox.querySelectorAll('button.on')) x.classList.remove('on'); });

  btnExact.addEventListener('click', () => {
    if (!results) return;
    for (const r of results) for (const m of r.matches) if (m.quality === 'exact') checked.add(keyOf(r, m));
    syncBoxes();
    setStatus(`Checked ${pluralise(checked.size, 'take')}. A phrase said more than once has every exact place checked.`);
  });
  btnNone.addEventListener('click', () => { checked.clear(); syncBoxes(); });
  btnAdd.addEventListener('click', addChecked);

  // Speeches arriving, finishing or leaving change what matches.
  const rerun = debounce(() => { if (results && lastText.trim()) run({ quiet: true }); }, 400);
  for (const ev of ['sources', 'words', 'relinked']) on(ev, rerun);
  on('clips', (e) => { if (results && !(e.detail && e.detail.refresh)) renderResults(); });
  renderResults();
}

export function initPhrases() {
  initTranscriptTools();
  initImport();
}
