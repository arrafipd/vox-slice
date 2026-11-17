// Slice / Builder tabs and the collapsible how-to panel.
import { tid, lsGet, lsSet } from './dom.js';
import { emit } from './state.js';

let current = 'slice';
export const currentTab = () => current;

export function showTab(name) {
  if (name === current) return;
  current = name;
  for (const n of ['slice', 'builder']) {
    const on = n === name;
    document.getElementById(`view-${n}`).hidden = !on;
    const t = tid(`tab-${n}`);
    t.classList.toggle('on', on);
    t.setAttribute('aria-selected', on ? 'true' : 'false');
    t.tabIndex = on ? 0 : -1;
  }
  // The rhyme panel lives in whichever tab is showing.
  const panel = document.getElementById('rhyme-panel');
  document.getElementById(`rhyme-slot-${name}`).append(panel);
  emit('tab', name);
}

export function initTabs() {
  for (const n of ['slice', 'builder']) {
    tid(`tab-${n}`).addEventListener('click', () => showTab(n));
  }
  const bar = document.querySelector('.tools');
  bar.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const next = current === 'slice' ? 'builder' : 'slice';
      showTab(next);
      tid(`tab-${next}`).focus();
      e.preventDefault();
    }
  });
}

export function initHowto() {
  const box = tid('howto');
  const toggles = [...document.querySelectorAll('[data-howto-toggle]')];
  const saved = lsGet('vox.howto');
  const set = (open) => {
    box.classList.toggle('open', open);
    box.querySelector('.howto-body').hidden = !open;
    for (const t of toggles) { t.setAttribute('aria-expanded', open ? 'true' : 'false'); t.classList.toggle('on', open); }
    lsSet('vox.howto', open ? 'open' : 'closed');
  };
  set(saved !== 'closed');
  for (const t of toggles) {
    t.addEventListener('click', () => {
      const open = !box.classList.contains('open');
      set(open);
      if (open && t.classList.contains('tab')) box.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }
}
