import test from 'node:test';
import assert from 'node:assert/strict';
import {
  transcriptText, aiPromptText, parsePhraseList, canonTokens, matchPhrases,
  windowsSafe, phraseFileName, packFileName, PHRASES_MARKER,
} from '../../src/phrases.js';
import { exportClips } from '../../src/encode.js';
import { fakeBuffer, sine } from './helpers.mjs';

const mk = (id, text) => ({ id, name: `${id}.wav`, words: text.split(' ').map((t, i) => ({ text: t, start: i, end: i + 0.5 })) });
const A = mk('A', "We've got the underground, and we're not going to stop. Nobody builds walls better than me.");
const B = mk('B', 'They said it could not be done but we did it anyway, believe me.');

test('transcript text has the file name as a header', () => {
  const t = transcriptText(A);
  assert.ok(t.startsWith('A.wav\n'));
  assert.ok(t.includes("We've got the underground,"));
});

test('ai prompt carries the marker, the rules and every transcript', () => {
  const p = aiPromptText([A, B]);
  assert.ok(p.includes(`\n${PHRASES_MARKER}\n`));
  assert.ok(/WORD FOR WORD/.test(p));
  assert.ok(p.indexOf('A.wav') > p.indexOf(PHRASES_MARKER));
  assert.ok(p.includes('believe me.'));
});

test('parsePhraseList uses only the lines after the marker', () => {
  const r = parsePhraseList("Yo, here is the rap\nline two of the rap\n\n### PHRASES\nwe've got the underground\nbelieve me\n");
  assert.equal(r.usedMarker, true);
  assert.deepEqual(r.phrases, ["we've got the underground", 'believe me']);
});

test('parsePhraseList without a marker takes every line and strips decoration', () => {
  const r = parsePhraseList('1. "We\'ve got the underground!"\n- believe me,\n\n  * **nobody builds walls**\n2) “believe me”\n(3) \'done\'\n```\n');
  assert.equal(r.usedMarker, false);
  assert.deepEqual(r.phrases, ["We've got the underground", 'believe me', 'nobody builds walls', 'done']);
});

test('marker is tolerant of case and markdown wrapping', () => {
  assert.deepEqual(parsePhraseList('rap\n**### Phrases:**\none\ntwo').phrases, ['one', 'two']);
});

test('canonTokens normalizes case, punctuation and contractions', () => {
  assert.deepEqual(canonTokens("We've GOT it, don't we?"), ['we', 'have', 'got', 'it', 'do', 'not', 'we']);
  assert.deepEqual(canonTokens('gonna win'), ['going', 'to', 'win']);
  assert.deepEqual(canonTokens('Trump’s wall'), ['trumps', 'wall']);
});

test('exact match, with word ranges', () => {
  const [r] = matchPhrases([A, B], ['got the underground']);
  assert.equal(r.quality, 'exact');
  assert.deepEqual(r.matches, [{ sourceId: 'A', i0: 1, i1: 3, quality: 'exact' }]);
});

test('contractions match their long form', () => {
  const [r] = matchPhrases([A, B], ['we have got the underground and we are not going to stop']);
  assert.equal(r.quality, 'exact');
  assert.deepEqual(r.matches[0], { sourceId: 'A', i0: 0, i1: 9, quality: 'exact' });
});

test('a match that starts inside a contraction is only close', () => {
  const [r] = matchPhrases([A], ['have got the underground']);
  assert.equal(r.quality, 'close');
  assert.deepEqual(r.matches[0], { sourceId: 'A', i0: 0, i1: 3, quality: 'close' });
});

test('one word off falls back to a close match', () => {
  const [sub, extra, dropped] = matchPhrases([A, B], [
    'nobody builds bridges better than me',
    'nobody really builds walls better than me',
    'nobody builds walls than me',
  ]);
  for (const r of [sub, extra, dropped]) {
    assert.equal(r.quality, 'close');
    assert.equal(r.matches.length, 1);
    assert.equal(r.matches[0].sourceId, 'A');
    assert.equal(r.matches[0].i0, 10);
    assert.equal(r.matches[0].i1, 15);
  }
});

test('small spelling slips are close, made-up phrases are not found', () => {
  const [typo, fake, short] = matchPhrases([A, B], ['got the undergrund', 'tremendous purple elephants', 'the']);
  assert.equal(typo.quality, 'close');
  assert.deepEqual(typo.matches[0], { sourceId: 'A', i0: 1, i1: 3, quality: 'close' });
  assert.equal(fake.quality, 'none');
  assert.deepEqual(fake.matches, []);
  assert.equal(short.quality, 'exact');
});

test('no fuzzy pass when an exact match exists; all exact places are listed', () => {
  const C = mk('C', 'believe me folks believe me');
  const [r] = matchPhrases([B, C], ['believe me']);
  assert.deepEqual(r.matches.map((m) => [m.sourceId, m.i0, m.quality]), [['B', 12, 'exact'], ['C', 0, 'exact'], ['C', 3, 'exact']]);
});

test('file names are safe on Windows', () => {
  assert.equal(windowsSafe("We've got the underground!"), "we've-got-the-underground");
  assert.equal(windowsSafe('a/b\\c:d*e?"f<g>h|i'), 'a-b-c-d-e-f-g-h-i');
  assert.equal(windowsSafe('CON'), 'con-clip');
  assert.equal(windowsSafe("'quoted' ... end."), 'quoted-end');
  assert.ok(windowsSafe('x'.repeat(200)).length <= 60);
  assert.equal(phraseFileName({ index: 0, text: "We've got the underground", ext: 'wav' }), "01_we've-got-the-underground.wav");
  assert.equal(phraseFileName({ index: 4, text: '???', ext: 'mp3', total: 120 }), '005_clip.mp3');
  assert.equal(packFileName('  My Rap: Pack?.zip '), 'My Rap Pack.zip');
  assert.equal(packFileName('...'), '');
  assert.equal(packFileName('nul'), 'nul-pack.zip');
});

test('exportClips can name files from the phrase text', async () => {
  const sr = 8000;
  const src = { id: 's', name: 'speech one.wav', buffer: fakeBuffer(sr, [sine(sr, 2)]) };
  const clips = [
    { id: 'c1', sourceId: 's', text: "We've got the underground", start: 0, end: 0.5 },
    { id: 'c2', sourceId: 's', text: "We've got the underground", start: 1, end: 1.5 },
  ];
  const { entries, manifest } = await exportClips({ clips, sources: [src], formats: ['wav'], phraseNames: true });
  assert.deepEqual(entries.map((e) => e.name), ["01_we've-got-the-underground.wav", "02_we've-got-the-underground.wav", 'manifest.csv']);
  assert.equal(manifest[0].filename, "01_we've-got-the-underground.wav");
});
