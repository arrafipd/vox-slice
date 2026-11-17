// The clips rack: cards, nudges, loop, single downloads, padding control.
import { renderClip, encodeWav, encodeMp3, clipFileName } from '../encode.js';
import { phraseFileName } from '../phrases.js';
import {
  state, on, emit, getSource, getClip, clipIndex, hasAudio, removeClip, selectClip, setStatus, rangeFor, padSec,
} from './state.js';
import { el, ico, tid, clear, fmtTime, saveBlob, pluralise } from './dom.js';
import { playClip, toggleLoop, clipEdgesChanged, playing } from './transport.js';
import { showError } from './notices.js';

let list, emptyEl, countEls;
const MIN = 0.02;

function pad2(n) { return String(n).padStart(2, '0'); }

function edgeGroup(edge, label) {
  const minus = el('button', {
    type: 'button', class: 'nudge', title: `${label} 10 ms earlier (Shift = 50 ms)`, 'aria-label': `${label} 10 milliseconds earlier`, text: '−',
  });
  minus.dataset.act = edge + '-';
  const plus = el('button', {
    type: 'button', class: 'nudge', title: `${label} 10 ms later (Shift = 50 ms)`, 'aria-label': `${label} 10 milliseconds later`, text: '+',
  });
  plus.dataset.act = edge + '+';
  return el('div', { class: 'edge', role: 'group', 'aria-label': `${label} edge` },
    minus, el('span', { class: 'edge-lbl', text: label }), el('b', { class: 'num', dataset: { f: edge } }), plus);
}

function actBtn(act, label, icon, title, cls = '') {
  const b = el('button', { type: 'button', class: 'act ' + cls, title, 'aria-label': title });
  b.dataset.act = act;
  if (icon) b.append(ico(icon));
  if (label) b.append(el('span', { text: label }));
  return b;
}

function buildCard(c, i) {
  const src = getSource(c.sourceId);
  const linked = hasAudio(src);
  const card = el('div', { class: 'clip', dataset: { clipId: c.id }, tabindex: '0', role: 'group', 'aria-label': `Clip ${i + 1}: ${c.text}` });
  card.append(
    el('div', { class: 'clip-head' },
      el('span', { class: 'clip-num num', text: pad2(i + 1) }),
      el('p', { class: 'clip-text', text: c.text })),
    el('div', { class: 'clip-meta' },
      el('span', { class: 'clip-src', text: src ? src.name : 'unknown source', title: src ? src.name : '' }),
      el('span', { class: 'clip-dur num', dataset: { f: 'dur' } })),
    el('div', { class: 'clip-edges' }, edgeGroup('start', 'Start'), edgeGroup('end', 'End')),
    el('div', { class: 'clip-acts' },
      actBtn('play', 'Play', 'play', linked ? 'Play this clip' : 'Audio missing, drop the original file to relink', 'play'),
      actBtn('loop', 'Loop', 'loop', linked ? 'Loop this clip. Edge changes keep looping.' : 'Audio missing, drop the original file to relink'),
      el('span', { class: 'spacer' }),
      actBtn('wav', 'WAV', 'down', linked ? 'Download this clip as WAV' : 'Audio missing, drop the original file to relink'),
      actBtn('mp3', 'MP3', 'down', linked ? 'Download this clip as MP3' : 'Audio missing, drop the original file to relink'),
      actBtn('remove', '', 'x', 'Remove this clip', 'danger icon-only')),
  );
  if (!linked) {
    card.classList.add('unlinked');
    for (const a of ['play', 'loop', 'wav', 'mp3']) card.querySelector(`[data-act="${a}"]`).disabled = true;
    card.querySelector('.clip-meta').append(el('span', { class: 'chip warn', text: 'audio missing' }));
  }
  fillTimes(card, c);
  return card;
}

function fillTimes(card, c) {
  card.querySelector('[data-f="start"]').textContent = fmtTime(c.start, 3);
  card.querySelector('[data-f="end"]').textContent = fmtTime(c.end, 3);
  card.querySelector('[data-f="dur"]').textContent = (c.end - c.start).toFixed(3) + ' s';
}

export function updateCardTimes(c) {
  const card = list.querySelector(`.clip[data-clip-id="${c.id}"]`);
  if (card) fillTimes(card, c);
}

function updateStates() {
  for (const card of list.children) {
    const id = card.dataset.clipId;
    card.classList.toggle('sel', id === state.selClipId);
    const isLoop = state.loopClipId === id;
    const isPlay = playing.kind === 'clip' && playing.clipId === id;
    const loopBtn = card.querySelector('[data-act="loop"]');
    loopBtn.classList.toggle('on', isLoop);
    loopBtn.setAttribute('aria-pressed', isLoop ? 'true' : 'false');
    const playBtn = card.querySelector('[data-act="play"]');
    playBtn.classList.toggle('on', isPlay);
    const lbl = playBtn.querySelector('span');
    if (lbl) lbl.textContent = isPlay ? 'Stop' : 'Play';
  }
}

export function renderClips(added = []) {
  clear(list);
  state.clips.forEach((c, i) => {
    const card = buildCard(c, i);
    if (added.includes(c)) card.classList.add('landing');
    list.append(card);
  });
  const n = state.clips.length;
  emptyEl.hidden = n > 0;
  for (const e of countEls) e.textContent = String(n);
  tid('clip-count-label').textContent = pluralise(n, 'clip');
  document.getElementById('clear-clips-btn').disabled = n === 0;
  document.getElementById('reapply-pad-btn').disabled = n === 0;
  updateStates();
}

export function nudgeClip(id, edge, deltaSec) {
  const c = getClip(id);
  if (!c) return;
  const src = getSource(c.sourceId);
  const dur = src && src.duration ? src.duration : Infinity;
  if (edge === 'start') c.start = Math.max(0, Math.min(c.end - MIN, c.start + deltaSec));
  else c.end = Math.min(dur, Math.max(c.start + MIN, c.end + deltaSec));
  updateCardTimes(c);
  clipEdgesChanged(c);
  emit('clipedit', c);
}

async function download(c, ext) {
  const src = getSource(c.sourceId);
  if (!hasAudio(src)) return;
  try {
    setStatus(`Rendering ${ext.toUpperCase()}...`);
    const audio = renderClip(c, src, { normalize: state.settings.normalize, trim: state.settings.trim });
    const data = ext === 'wav' ? encodeWav(audio) : await encodeMp3(audio);
    const name = state.settings.phraseNames
      ? phraseFileName({ index: clipIndex(c.id), text: c.text, ext, total: state.clips.length })
      : clipFileName({ index: clipIndex(c.id), text: c.text, ext, sourceName: src.name });
    saveBlob(new Blob([data], { type: ext === 'wav' ? 'audio/wav' : 'audio/mpeg' }), name);
    setStatus(`Saved ${name}.`);
  } catch (err) {
    console.error(err);
    showError(err);
  }
}

export function reapplyPadding() {
  let n = 0;
  for (const c of state.clips) {
    const src = getSource(c.sourceId);
    if (!src || !src.words[c.i0] || !src.words[c.i1]) continue;
    const r = rangeFor(src, c.i0, c.i1, padSec());
    c.start = r.start; c.end = Math.max(r.end, r.start + MIN);
    clipEdgesChanged(c);
    n++;
  }
  for (const c of state.clips) updateCardTimes(c);
  emit('clipedit', null);
  setStatus(`Re-applied ${state.settings.padMs} ms padding to ${pluralise(n, 'clip')}. Manual edge tweaks were reset.`);
}

export function initClips() {
  list = tid('clips-list');
  emptyEl = document.getElementById('clips-empty');
  countEls = [...document.querySelectorAll('[data-clip-count]')];

  list.addEventListener('click', (e) => {
    const card = e.target.closest('.clip');
    if (!card) return;
    const id = card.dataset.clipId;
    const b = e.target.closest('button[data-act]');
    if (!b) { selectClip(id); return; }
    if (b.disabled) return;
    const act = b.dataset.act;
    const step = e.shiftKey ? 0.05 : 0.01;
    if (state.selClipId !== id && act !== 'remove' && act !== 'wav' && act !== 'mp3') selectClip(id);
    switch (act) {
      case 'play': playClip(id); break;
      case 'loop': toggleLoop(id); break;
      case 'start-': nudgeClip(id, 'start', -step); break;
      case 'start+': nudgeClip(id, 'start', step); break;
      case 'end-': nudgeClip(id, 'end', -step); break;
      case 'end+': nudgeClip(id, 'end', step); break;
      case 'wav': download(getClip(id), 'wav'); break;
      case 'mp3': download(getClip(id), 'mp3'); break;
      case 'remove': removeClip(id); setStatus('Clip removed.'); break;
      default: break;
    }
  });

  // Padding
  const pad = tid('pad-input');
  const out = document.getElementById('pad-out');
  const paint = () => { out.textContent = `${pad.value} ms`; pad.style.setProperty('--fill', `${(pad.value / pad.max) * 100}%`); };
  pad.value = String(state.settings.padMs);
  paint();
  pad.addEventListener('input', () => { state.settings.padMs = Math.max(0, Math.min(300, +pad.value || 0)); paint(); });
  document.getElementById('reapply-pad-btn').addEventListener('click', reapplyPadding);

  // Clear all (two-step)
  const clr = document.getElementById('clear-clips-btn');
  let armed = 0;
  clr.addEventListener('click', () => {
    if (!armed) {
      clr.querySelector('span').textContent = 'Sure?';
      clr.classList.add('armed');
      armed = setTimeout(() => { armed = 0; clr.querySelector('span').textContent = 'Clear all'; clr.classList.remove('armed'); }, 2600);
      return;
    }
    clearTimeout(armed); armed = 0;
    clr.querySelector('span').textContent = 'Clear all';
    clr.classList.remove('armed');
    const n = state.clips.length;
    const ids = state.clips.map((c) => c.id);
    state.clips = []; state.selClipId = null; state.loopClipId = null;
    emit('clips', { removed: ids });
    emit('selection');
    setStatus(`Cleared ${pluralise(n, 'clip')}.`);
  });

  on('clips', (e) => {
    const d = e.detail || {};
    if (d.refresh) { updateStates(); return; }
    renderClips(d.added || []);
    if (d.added && d.added.length) {
      const last = list.querySelector(`.clip[data-clip-id="${d.added[d.added.length - 1].id}"]`);
      if (last) last.scrollIntoView({ block: 'nearest' });
    }
  });
  on('clipselect', () => {
    updateStates();
    const card = state.selClipId && list.querySelector(`.clip[data-clip-id="${state.selClipId}"]`);
    if (card) card.scrollIntoView({ block: 'nearest' });
  });
  on('selection', updateStates);
  on('playstate', updateStates);
  on('sources', () => renderClips());
  on('relinked', () => renderClips());
  renderClips();
}
