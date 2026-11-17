// Keyboard shortcuts. Never fire while typing in a field.
import { state, getClip, clearSelection, removeClip, setStatus } from './state.js';
import { isTypingTarget, tid } from './dom.js';
import { togglePlay, stopAll, toggleLoop, isPlaying } from './transport.js';
import { addSelectionAsClip, adjustSelection } from './workspace.js';
import { nudgeClip } from './clips.js';
import { currentTab } from './tabs.js';

export function initShortcuts() {
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
    if (isTypingTarget(e.target)) return;
    const onButton = e.target.tagName === 'BUTTON' || e.target.tagName === 'A' || e.target.getAttribute('role') === 'button';
    const k = e.key;
    if (currentTab() !== 'slice') {
      if (k === 'Escape') stopAll();
      return;
    }
    const clip = state.selClipId ? getClip(state.selClipId) : null;
    switch (k) {
      case ' ':
        if (onButton) return;
        e.preventDefault();
        togglePlay();
        break;
      case 'Enter':
        if (onButton) return;
        if (state.sel) { e.preventDefault(); addSelectionAsClip(); }
        break;
      case 'l': case 'L':
        if (clip) { e.preventDefault(); toggleLoop(clip.id); }
        break;
      case 'ArrowLeft': case 'ArrowRight':
        if (state.sel && adjustSelection(k === 'ArrowRight' ? 1 : -1, e.shiftKey)) e.preventDefault();
        break;
      case '[': if (clip) { e.preventDefault(); nudgeClip(clip.id, 'start', -0.01); } break;
      case ']': if (clip) { e.preventDefault(); nudgeClip(clip.id, 'start', 0.01); } break;
      case ';': if (clip) { e.preventDefault(); nudgeClip(clip.id, 'end', -0.01); } break;
      case '\'': if (clip) { e.preventDefault(); nudgeClip(clip.id, 'end', 0.01); } break;
      case 'Delete':
        if (clip) { e.preventDefault(); removeClip(clip.id); setStatus('Clip removed.'); }
        break;
      case '/':
        e.preventDefault();
        tid('search-input').focus();
        tid('search-input').select();
        break;
      case 'Escape':
        if (isPlaying()) stopAll();
        else { clearSelection(); }
        break;
      default: break;
    }
  });
}
