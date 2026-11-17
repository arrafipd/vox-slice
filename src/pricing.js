// Styles, fonts and the Support button for the "free and open source" page (pricing.html).
import '@fontsource/bebas-neue/400.css';
import '@fontsource-variable/inter';
import './style.css';

// ============================================================================
// TODO-ROBBIE: paste your tip-jar link here (Ko-fi or Buy Me a Coffee), e.g.
//   const SUPPORT_URL = 'https://ko-fi.com/yourname';
// While this is empty the button says "Tip jar coming soon" and is NOT clickable.
// ============================================================================
const SUPPORT_URL = '';

const btn = document.getElementById('support-btn');
if (btn && SUPPORT_URL) {
  btn.href = SUPPORT_URL;
  btn.textContent = 'Support Vox-Slice';
  btn.removeAttribute('aria-disabled');
  btn.removeAttribute('role');
}
