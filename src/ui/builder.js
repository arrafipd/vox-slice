// Sentence Builder: type lyric lines, get a row of takes per line, preview and export them stitched.
import { planLines } from '../library.js';
import { sliceAudio, trimSilence, joinAudio, normalizeAudio } from '../audio.js';
import { encodeWav, encodeMp3, manifestCsv, makeZip } from '../encode.js';
import { state, on, emit, getSource, hasAudio, rangeFor, addClip, setBusy, setStatus } from './state.js';
import { el, ico, tid, clear, fmtTime, saveBlob, slug, copyText, pluralise } from './dom.js';
import { playTake, stopAll } from './transport.js';
import { stitched } from './transport.js';
import { showError } from './notices.js';
import { showTab } from './tabs.js';

let input, linesBox, missingBox, optGap, optTrim, optNorm, optFmt;
let plan = null;      // { lines, missing }
let choice = [];      // choice[li][si] = take index
let current = 0;
let previewing = -1;

const pad2 = (n) => String(n + 1).padStart(2, '0');

function takeRange(m) {
  const src = getSource(m.sourceId);
  return src ? rangeFor(src, m.i0, m.i1) : null;
}

function renderLineAudio(li) {
  const line = plan.lines[li];
  const parts = [];
  const used = [];
  let skipped = 0;
  line.slots.forEach((slot, si) => {
    if (slot.missing) return;
    const m = slot.takes[choice[li][si] || 0];
    const src = m && getSource(m.sourceId);
    if (!src || !hasAudio(src)) { skipped++; return; }
    const r = rangeFor(src, m.i0, m.i1);
    let a = sliceAudio(src.buffer, r.start, r.end);
    if (optTrim.checked) a = trimSilence(a);
    parts.push(a);
    if (!used.includes(src.name)) used.push(src.name);
  });
  if (!parts.length) return null;
  let audio = joinAudio(parts, { gapMs: +optGap.value || 0 });
  if (optNorm.checked) audio = normalizeAudio(audio);
  return { audio, used, skipped, count: parts.length };
}

function lineHasAudio(li) {
  return plan.lines[li].slots.some((s, si) => !s.missing && hasAudio(getSource(s.takes[choice[li][si] || 0]?.sourceId)));
}

function previewLine(li) {
  if (!plan || !plan.lines[li]) return;
  current = li;
  if (previewing === li) { stopAll(); previewing = -1; paintPreview(); return; }
  const r = renderLineAudio(li);
  if (!r) { setStatus(lineHasAny(li) ? 'The audio for those takes is not loaded. Drop the original files to relink.' : 'Nothing to play on that line yet. Every word is missing.'); return; }
  previewing = li;
  stitched(r.audio, () => { previewing = -1; paintPreview(); });
  paintPreview();
  setStatus(`Playing line ${li + 1}${r.skipped ? ` (${pluralise(r.skipped, 'take')} skipped, audio missing)` : ''}.`);
}

function lineHasAny(li) { return plan.lines[li].slots.some((s) => !s.missing); }

function paintPreview() {
  for (const row of linesBox.children) {
    const li = +row.dataset.line;
    const b = row.querySelector('[data-act="preview"]');
    if (!b) continue;
    b.classList.toggle('on', li === previewing);
    b.querySelector('span').textContent = li === previewing ? 'Stop' : 'Preview';
  }
  const pb = tid('builder-preview-btn');
  pb.classList.toggle('on', previewing >= 0);
  pb.querySelector('span').textContent = previewing >= 0 ? 'Stop preview' : 'Preview line';
}

function takeLabel(m) {
  const src = getSource(m.sourceId);
  if (!src) return 'source removed';
  return `${src.name} · ${fmtTime(src.words[m.i0].start, 1)}`;
}

function renderChip(li, si, slot) {
  if (slot.missing) {
    return el('div', { class: 'bchip missing', title: 'Not in your library yet' },
      el('span', { class: 'bchip-text', text: slot.text }),
      el('span', { class: 'bchip-sub', text: 'missing' }));
  }
  const n = slot.takes.length;
  const k = choice[li][si] || 0;
  const m = slot.takes[k];
  const chip = el('div', { class: 'bchip found', dataset: { slot: si } });
  const main = el('button', { type: 'button', class: 'bchip-main', title: 'Play this take', 'aria-label': `Play take of ${slot.text}` },
    el('span', { class: 'bchip-text', text: slot.text }));
  main.addEventListener('click', () => {
    current = li;
    const mm = slot.takes[choice[li][si] || 0];
    const src = getSource(mm.sourceId);
    if (!hasAudio(src)) { setStatus('The audio for that take is not loaded. Drop the original file to relink.'); return; }
    playTake(mm);
  });
  const pick = el('div', { class: 'bchip-pick' });
  const prev = el('button', { type: 'button', class: 'nudge', 'aria-label': 'Previous take', title: 'Previous take', text: '‹', disabled: n < 2 });
  const next = el('button', { type: 'button', class: 'nudge', 'aria-label': 'Next take', title: 'Next take', text: '›', disabled: n < 2 });
  const lab = el('span', { class: 'num', text: `take ${k + 1} of ${n}` });
  const go = (d) => { choice[li][si] = (k + d + n) % n; replaceChip(li, si); };
  prev.addEventListener('click', () => go(-1));
  next.addEventListener('click', () => go(1));
  pick.append(prev, lab, next);
  chip.append(main, pick, el('span', { class: 'bchip-sub', text: m ? takeLabel(m) : '', title: m ? takeLabel(m) : '' }));
  return chip;
}

function replaceChip(li, si) {
  const row = linesBox.querySelector(`.bline[data-line="${li}"] .bchips`);
  const old = row && row.children[si];
  if (!old) return;
  const fresh = renderChip(li, si, plan.lines[li].slots[si]);
  old.replaceWith(fresh);
  fresh.querySelector('.nudge:last-child, .bchip-pick button:last-child')?.focus();
}

function actButton(act, label, icon, title) {
  const b = el('button', { type: 'button', class: 'act', title, 'aria-label': title });
  b.dataset.act = act;
  if (icon) b.append(ico(icon));
  b.append(el('span', { text: label }));
  return b;
}

function renderLines() {
  clear(linesBox);
  if (!plan) return;
  plan.lines.forEach((line, li) => {
    const found = line.slots.filter((s) => !s.missing).length;
    const row = el('div', { class: 'bline' + (found ? '' : ' none'), dataset: { line: li } });
    const head = el('div', { class: 'bline-head' },
      el('span', { class: 'bnum num', text: pad2(li) }),
      el('p', { class: 'btext', text: line.text }),
      el('span', { class: 'bcount num', text: `${found}/${line.slots.length}`, title: 'Slots found out of total' }));
    const acts = el('div', { class: 'bline-acts' },
      actButton('preview', 'Preview', 'play', 'Play this line stitched together'),
      actButton('wav', 'WAV', 'down', 'Download this line as one WAV'),
      actButton('mp3', 'MP3', 'down', 'Download this line as one MP3'),
      actButton('toclips', 'To clips', 'plus', 'Send this line’s chosen takes to the clips rack'));
    if (!found) for (const b of acts.children) b.disabled = true;
    const chips = el('div', { class: 'bchips' });
    line.slots.forEach((slot, si) => chips.append(renderChip(li, si, slot)));
    row.append(head, chips, acts);
    linesBox.append(row);
  });
}

function renderMissing() {
  clear(missingBox);
  if (!plan) { missingBox.hidden = true; return; }
  missingBox.hidden = false;
  const miss = plan.missing;
  missingBox.classList.toggle('all-good', !miss.length);
  if (!miss.length) {
    missingBox.append(el('p', { class: 'celebrate' }, ico('spark'), el('span', { text: 'Nothing missing. Every word is in your library. Go make some noise.' })));
    return;
  }
  const head = el('div', { class: 'missing-head' },
    el('h3', { text: `${pluralise(miss.length, 'word')} still to find` }));
  const copy = el('button', { type: 'button', class: 'act', title: 'Copy the list of missing words' }, ico('copy'), el('span', { text: 'Copy list' }));
  copy.addEventListener('click', async () => {
    const ok = await copyText(miss.join('\n'));
    copy.querySelector('span').textContent = ok ? 'Copied' : 'Copy failed';
    setTimeout(() => { copy.querySelector('span').textContent = 'Copy list'; }, 1600);
  });
  head.append(copy);
  missingBox.append(head, el('p', { class: 'hint', text: 'Record or find speech with these words, load it, then build again.' }),
    el('ul', { class: 'missing-list' }, miss.map((w) => el('li', { text: w }))));
}

export function runBuilder() {
  stopAll();
  previewing = -1;
  const text = input.value;
  if (!text.trim()) { plan = null; choice = []; renderLines(); renderMissing(); setStatus('Type or paste some lines first. One line per row.'); return null; }
  plan = planLines(state.sources, text);
  choice = plan.lines.map((l) => l.slots.map(() => 0));
  current = 0;
  renderLines();
  renderMissing();
  document.getElementById('builder-empty').hidden = true;
  paintPreview();
  const found = plan.lines.reduce((n, l) => n + l.slots.filter((s) => !s.missing).length, 0);
  const total = plan.lines.reduce((n, l) => n + l.slots.length, 0);
  setStatus(plan.lines.length ? `Built ${pluralise(plan.lines.length, 'line')}: ${found} of ${total} pieces found${plan.missing.length ? `, ${plan.missing.length} missing` : ''}.` : 'No words to build from.');
  const hasLines = plan.lines.some((l) => l.slots.some((s) => !s.missing));
  tid('builder-export-btn').disabled = !hasLines;
  tid('builder-preview-btn').disabled = !hasLines;
  document.getElementById('builder-toclips-btn').disabled = !hasLines;
  return plan;
}

/** Hand lines in programmatically (e.g. from a future AI lyric writer). */
export function setBuilderLines(text) {
  const t = Array.isArray(text) ? text.join('\n') : String(text || '');
  input.value = t;
  showTab('builder');
  return runBuilder();
}

function outExt() { return optFmt.value === 'both' ? ['wav', 'mp3'] : [optFmt.value]; }

async function encodeLine(li, ext) {
  const r = renderLineAudio(li);
  if (!r) return null;
  const data = ext === 'wav' ? encodeWav(r.audio) : await encodeMp3(r.audio);
  return { data, r };
}

function lineName(li, ext) {
  return `line_${pad2(li)}_${slug(plan.lines[li].text, 36) || 'line'}.${ext}`;
}

async function exportOne(li, ext) {
  setBusy('builder', true);
  try {
    const out = await encodeLine(li, ext);
    if (!out) { setStatus('Nothing to export on that line (no audio loaded for its takes).'); return; }
    saveBlob(new Blob([out.data], { type: ext === 'wav' ? 'audio/wav' : 'audio/mpeg' }), lineName(li, ext));
    setStatus(`Saved ${lineName(li, ext)}.`);
  } catch (err) { console.error(err); showError(err); } finally { setBusy('builder', false); }
}

async function exportAll() {
  if (!plan) return;
  setBusy('builder', true);
  const btn = tid('builder-export-btn');
  btn.disabled = true;
  try {
    const entries = [], rows = [];
    let done = 0, skippedLines = 0;
    const idxs = plan.lines.map((_, i) => i).filter((i) => lineHasAny(i));
    for (const li of idxs) {
      setStatus(`Rendering line ${done + 1} of ${idxs.length}...`);
      for (const ext of outExt()) {
        const out = await encodeLine(li, ext);
        if (!out) { skippedLines++; break; }
        const name = lineName(li, ext);
        entries.push({ name, data: out.data });
        rows.push({ filename: name, source_file: out.r.used.join('; '), start: '0.000', end: out.r.audio.chans[0].length / out.r.audio.sr, duration: (out.r.audio.chans[0].length / out.r.audio.sr).toFixed(3), text: plan.lines[li].text });
      }
      done++;
      await new Promise((r) => setTimeout(r, 0));
    }
    for (const r of rows) r.end = (+r.duration).toFixed(3);
    if (!entries.length) { setStatus('Nothing to export. Load the audio for these takes first.'); return; }
    entries.push({ name: 'manifest.csv', data: manifestCsv(rows) });
    saveBlob(await makeZip(entries), 'vox-slice-lines.zip');
    setStatus(`Saved vox-slice-lines.zip with ${pluralise(rows.length, 'file')} and a manifest.csv. Missing words were skipped.${skippedLines ? ` ${pluralise(skippedLines, 'line')} had no audio loaded.` : ''}`);
  } catch (err) { console.error(err); showError(err); } finally { setBusy('builder', false); btn.disabled = false; }
}

function toClips(lis) {
  const added = [];
  for (const li of lis) {
    plan.lines[li].slots.forEach((slot, si) => {
      if (slot.missing) return;
      const m = slot.takes[choice[li][si] || 0];
      if (m && getSource(m.sourceId)) { const c = addClip(m.sourceId, m.i0, m.i1, { silent: true }); if (c) added.push(c); }
    });
  }
  if (!added.length) return;
  emit('clips', { added });
  setStatus(`Sent ${pluralise(added.length, 'take')} to the clips rack. Switch to Slice to fine-tune them.`);
}

export function initBuilder() {
  input = tid('builder-input');
  linesBox = tid('builder-lines');
  missingBox = tid('builder-missing');
  optGap = document.getElementById('gap-input');
  optTrim = document.getElementById('builder-trim');
  optNorm = document.getElementById('builder-norm');
  optFmt = document.getElementById('builder-format');
  const gapOut = document.getElementById('gap-out');
  const paintGap = () => { gapOut.textContent = `${optGap.value} ms`; optGap.style.setProperty('--fill', `${(optGap.value / optGap.max) * 100}%`); state.settings.gapMs = +optGap.value; };
  optGap.value = String(state.settings.gapMs);
  optGap.addEventListener('input', paintGap);
  paintGap();

  tid('builder-run-btn').addEventListener('click', runBuilder);
  input.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); runBuilder(); } });
  tid('builder-preview-btn').addEventListener('click', () => previewLine(Math.min(current, (plan?.lines.length || 1) - 1)));
  tid('builder-export-btn').addEventListener('click', exportAll);
  document.getElementById('builder-toclips-btn').addEventListener('click', () => plan && toClips(plan.lines.map((_, i) => i)));
  tid('builder-export-btn').disabled = true;
  tid('builder-preview-btn').disabled = true;
  document.getElementById('builder-toclips-btn').disabled = true;

  linesBox.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-act]');
    const row = e.target.closest('.bline');
    if (!row) return;
    const li = +row.dataset.line;
    current = li;
    if (!b || b.disabled) return;
    const act = b.dataset.act;
    if (act === 'preview') previewLine(li);
    else if (act === 'wav') exportOne(li, 'wav');
    else if (act === 'mp3') exportOne(li, 'mp3');
    else if (act === 'toclips') toClips([li]);
  });

  on('builder-insert', (e) => {
    const w = e.detail;
    const pos = input.selectionStart ?? input.value.length;
    const before = input.value.slice(0, pos), after = input.value.slice(pos);
    const sp = before && !/\s$/.test(before) ? ' ' : '';
    input.value = before + sp + w + after;
    input.focus();
    const np = (before + sp + w).length;
    input.setSelectionRange(np, np);
  });
}
