// Small DOM helpers. Text always goes in through textContent, never innerHTML.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const tid = (id, root = document) => root.querySelector(`[data-testid="${id}"]`);

export function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k === 'dataset') Object.assign(n.dataset, v);
    else if (k === 'on') for (const [ev, fn] of Object.entries(v)) n.addEventListener(ev, fn);
    else if (k in n && k !== 'list' && typeof v !== 'object') n[k] = v;
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return n;
}

const SVG = 'http://www.w3.org/2000/svg';
/** <svg><use href="#i-name"/></svg> pointing at the sprite in index.html */
export function ico(name, cls = 'ico') {
  const s = document.createElementNS(SVG, 'svg');
  s.setAttribute('class', cls);
  s.setAttribute('aria-hidden', 'true');
  const u = document.createElementNS(SVG, 'use');
  u.setAttribute('href', `#i-${name}`);
  s.appendChild(u);
  return s;
}

/** Icon + label button. */
export function btn(label, { icon, cls = '', title, act, aria, on, disabled, testid } = {}) {
  const b = el('button', { type: 'button', class: cls, title: title || false, 'aria-label': aria || false, on, disabled: !!disabled });
  if (act) b.dataset.act = act;
  if (testid) b.dataset.testid = testid;
  if (icon) b.append(ico(icon));
  if (label) b.append(el('span', { text: label }));
  return b;
}

export function clear(node) { node.replaceChildren(); return node; }

/** m:ss.mmm (ms=true) or m:ss */
export function fmtTime(t, decimals = 2) {
  if (!Number.isFinite(t)) return '0:00';
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return m + ':' + s.toFixed(decimals).padStart(decimals ? 3 + decimals : 2, '0');
}
export const fmtClock = (t) => fmtTime(t, 0);
export const fmtSec = (t) => t.toFixed(2) + 's';

export function slug(s, max = 40) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/, '');
}

export function baseName(name) { return String(name || 'audio').replace(/\.[^./\\]+$/, ''); }

export function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

export function pluralise(n, one, many) { return `${n} ${n === 1 ? one : (many || one + 's')}`; }

export function lsGet(key) { try { return localStorage.getItem(key); } catch { return null; } }
export function lsSet(key, v) { try { localStorage.setItem(key, v); } catch { /* private mode etc. */ } }

export function debounce(fn, ms) {
  let t = 0;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through */ }
  const ta = el('textarea', { value: text, style: 'position:fixed;opacity:0' });
  document.body.appendChild(ta); ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { /* ignore */ }
  ta.remove();
  return ok;
}

/** A word's first/last time for display, e.g. "0:12.34". */
export function isTypingTarget(t) {
  if (!t || !t.tagName) return false;
  const tag = t.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable;
}
