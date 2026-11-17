// A fixed set of clip targets on clean.wav, resolved against the actual transcript.
import { findSeq, makeClip } from './lib.mjs';

const SINGLES = [['bread'], ['bridge'], ['library'], ['farmers'], ['schools'], ['new'], ['vote'], ['town'], ['bakery'], ['teachers'], ['family'], ['tomorrow'], ['river'], ['strong']];
const PHRASES = [
  ['thank', 'you', 'very', 'much'],
  ['talk', 'to', 'your', 'friends'],
  ['it', 'will', 'not', 'be', 'easy'],
  ['hard', 'work', 'always', 'pays', 'off'],
  ['the', 'best', 'bread', 'in', 'the', 'county'],
  ['new', 'books', 'and', 'faster', 'computers'],
  ['every', 'voice', 'matters'],
  ['we', 'are', 'stronger', 'when', 'we', 'stand', 'together'],
  ['better', 'roads', 'to', 'bring', 'their', 'crops'],
];

/** Returns [{ i, j, kind, label }] with i..j inclusive word indexes. */
export function resolveTargets(words) {
  const out = [];
  out.push({ i: 0, j: 0, kind: 'single', label: 'first word of file' });
  out.push({ i: words.length - 1, j: words.length - 1, kind: 'single', label: 'last word of file' });
  for (const s of SINGLES) {
    const i = findSeq(words, s, 5);
    if (i >= 0 && i < words.length - 1) out.push({ i, j: i, kind: 'single', label: s[0] });
  }
  for (const p of PHRASES) {
    const i = findSeq(words, p);
    if (i >= 0) out.push({ i, j: i + p.length - 1, kind: 'phrase', label: p.join(' ') });
  }
  return out;
}

/** Create the clips through the real UI (click, shift+click, Enter / add button). */
export async function createClips(page, targets) {
  let n = 0;
  for (const t of targets) {
    await makeClip(page, t.i, t.j, n % 3 === 2 ? 'button' : 'enter');
    n++;
  }
}
