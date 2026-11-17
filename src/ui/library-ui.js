// The library strip (every loaded speech) and the load progress panel.
import { state, on, srcMeta, setActive, setStatus } from './state.js';
import { el, ico, tid, clear, fmtClock } from './dom.js';
import { removeSource, retrySource, cancelAll } from './loader.js';
import { downloadTranscript } from './phrases-ui.js';

function statusInfo(src) {
  const m = srcMeta(src.id);
  const st = m.status || 'ready';
  if (st === 'queued') return { text: 'queued', cls: 'queued' };
  if (st === 'decoding') return { text: 'reading', cls: 'busy' };
  if (st === 'transcribing') return { text: 'transcribing', cls: 'busy' };
  if (st === 'cancelled') return { text: 'cancelled', cls: 'bad' };
  if (st === 'failed') return { text: 'failed', cls: 'bad' };
  if (!src.buffer && src.words.length) return { text: 'audio missing', cls: 'warn' };
  if (st === 'cache') return { text: 'from cache', cls: 'ok' };
  return { text: 'ready', cls: 'ok' };
}

export function initLibraryUi() {
  const list = tid('library-list');
  const strip = document.getElementById('library');
  const count = document.getElementById('library-count');

  function render() {
    clear(list);
    strip.hidden = state.sources.length === 0;
    count.textContent = String(state.sources.length);
    for (const src of state.sources) {
      const info = statusInfo(src);
      const m = srcMeta(src.id);
      const active = src.id === state.activeId;
      const li = el('li', { class: 'lib-item' + (active ? ' on' : ''), dataset: { sourceId: src.id, status: info.cls } });
      const main = el('button', {
        type: 'button', class: 'lib-main',
        'aria-pressed': active ? 'true' : 'false',
        title: src.buffer || !src.words.length ? `Open ${src.name}` : `${src.name}: audio missing, drop the original file to relink`,
      });
      main.append(
        el('span', { class: 'lib-name', text: src.name }),
        el('span', { class: 'lib-meta' },
          el('span', { class: 'num', text: src.duration ? fmtClock(src.duration) : '--:--' }),
          el('span', { class: 'dot', text: '·' }),
          el('span', { class: 'num', text: `${src.words.length} words` }),
        ),
      );
      main.addEventListener('click', () => { if (src.id !== state.activeId) setActive(src.id); });
      const chip = el('span', { class: `chip ${info.cls}`, text: info.text });
      li.append(main, chip);
      if (info.text === 'audio missing') {
        li.append(el('span', { class: 'lib-hint', text: 'Drop the original file to relink' }));
      }
      if (m.status === 'cancelled' || m.status === 'failed') {
        const r = el('button', { type: 'button', class: 'mini', title: 'Try this file again', 'aria-label': `Retry ${src.name}` }, ico('retry'), el('span', { text: 'Retry' }));
        r.addEventListener('click', () => retrySource(src.id));
        li.append(r);
      }
      const busy = ['queued', 'decoding', 'transcribing'].includes(m.status);
      const dl = el('button', {
        type: 'button', class: 'mini lib-dl', disabled: busy || !src.words.length,
        title: busy ? 'Ready once the transcription finishes' : 'Download this speech as a plain text transcript',
        'aria-label': `Download transcript of ${src.name}`,
      }, ico('down'), el('span', { text: 'Download transcript' }));
      dl.dataset.testid = 'dl-transcript-btn';
      dl.addEventListener('click', () => downloadTranscript(src.id));
      li.append(dl);
      const rm = el('button', { type: 'button', class: 'mini icon-only', title: 'Remove from library', 'aria-label': `Remove ${src.name}` }, ico('x'));
      rm.addEventListener('click', () => removeSource(src.id));
      li.append(rm);
      list.append(li);
    }
  }
  on('sources', render);
  on('active', render);
  on('words', render);
  render();
}

export function initProgressUi() {
  const box = tid('progress');
  const label = box.querySelector('.prog-label');
  const detail = box.querySelector('.prog-detail');
  const bar = box.querySelector('.bar');
  const fill = bar.firstElementChild;
  const cancel = tid('cancel-btn');
  cancel.addEventListener('click', () => { cancelAll(); setStatus('Cancelling...'); });

  on('progress', (e) => {
    const p = e.detail;
    if (!p) { box.hidden = true; box.classList.remove('indeterminate'); return; }
    box.hidden = false;
    label.textContent = p.label;
    detail.textContent = p.detail || '';
    box.classList.toggle('download', !!p.download);
    if (p.pct == null) {
      box.classList.add('indeterminate');
      bar.removeAttribute('aria-valuenow');
      fill.style.width = '';
    } else {
      box.classList.remove('indeterminate');
      const v = Math.max(0, Math.min(100, p.pct));
      fill.style.width = v + '%';
      bar.setAttribute('aria-valuenow', String(Math.round(v)));
    }
  });
}
