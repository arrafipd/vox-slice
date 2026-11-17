// Error banner (dismissible, aria role=alert), the "Go Pro" banner for files over the
// tier limit, the tier label, and the "best on desktop Chrome" notice.
import { el, tid, lsGet, lsSet, clear } from './dom.js';
import { friendlyMessage } from '../errors.js';
import { FREE_FOR_ALL, UPGRADE_URL, getTierLimits, tierSummary, limitText, isLocalPro } from '../tier.js';

let messages = [];

function paint() {
  const box = tid('error-banner');
  if (!box) return;
  const list = box.querySelector('.err-list');
  clear(list);
  for (const m of messages) list.append(el('li', { text: m }));
  box.hidden = messages.length === 0;
}

/** Show a message in the error banner. err can be a string or an Error. */
export function showError(err, prefix) {
  let msg = typeof err === 'string' ? err : friendlyMessage(err);
  if (prefix) msg = `${prefix}: ${msg}`;
  if (!messages.includes(msg)) messages.push(msg);
  if (messages.length > 4) messages = messages.slice(-4);
  paint();
}

export function clearErrors() { messages = []; paint(); }

/** Friendly "this file is over your limit" banner with a Go Pro button. */
export function showUpgrade(err, fileName) {
  const box = tid('tier-banner');
  if (!box) { showError(err, fileName); return; }
  box.querySelector('.upsell-msg').textContent = `${fileName ? `${fileName}: ` : ''}${friendlyMessage(err)}`;
  box.hidden = false;
}

/** Tier label, Go Pro links and the "up to N seconds" wording, all from tier.js. */
function paintTier() {
  if (FREE_FOR_ALL) {
    // Free for everyone: drop every piece of tier UI (label, Go Pro banner, How-to note).
    for (const n of document.querySelectorAll('[data-tier-ui]')) n.remove();
  }
  const limits = getTierLimits();
  for (const a of document.querySelectorAll('[data-upgrade-link]')) a.href = UPGRADE_URL;
  for (const n of document.querySelectorAll('[data-tier-summary]')) n.textContent = tierSummary();
  for (const n of document.querySelectorAll('[data-tier-limit]')) n.textContent = limitText(limits.maxSeconds);
  document.body.dataset.tier = limits.id;
  // Owner's local full copy: a corner badge so it is always obvious which version this is.
  if (isLocalPro() && !document.querySelector('.local-pro-badge')) {
    document.body.append(el('div', { class: 'local-pro-badge', text: 'LOCAL PRO', title: 'Full version running on this computer only. No 20 second limit.', 'data-testid': 'local-pro-badge' }));
  }
}

export function initNotices() {
  const box = tid('error-banner');
  box.querySelector('.err-close').addEventListener('click', clearErrors);
  paint();

  paintTier();
  const upsell = tid('tier-banner');
  if (upsell) upsell.querySelector('.upsell-close').addEventListener('click', () => { upsell.hidden = true; });

  // Best on desktop Chrome
  const note = document.getElementById('desktop-notice');
  if (!note) return;
  const ua = navigator.userAgent || '';
  const brands = (navigator.userAgentData && navigator.userAgentData.brands) || [];
  const chromium = brands.some((b) => /Chromium|Google Chrome|Microsoft Edge/i.test(b.brand)) || (/Chrome\//.test(ua) && !/OPR|Firefox/.test(ua));
  const small = window.matchMedia('(pointer: coarse)').matches || window.innerWidth < 760;
  if ((!chromium || small) && lsGet('vox.noticeDismissed') !== '1') note.hidden = false;
  note.querySelector('button').addEventListener('click', () => { note.hidden = true; lsSet('vox.noticeDismissed', '1'); });
}
