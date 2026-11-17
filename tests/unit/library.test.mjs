import test from 'node:test';
import assert from 'node:assert/strict';
import { normToken, tokenize, searchLibrary, wordIndex, planLine, planLines } from '../../src/library.js';

const mk = (id, text) => ({ id, name: id, words: text.split(' ').map((t, i) => ({ text: t, start: i, end: i + 0.5 })) });

test('normToken', () => {
  assert.equal(normToken("Don't,"), "don't");
  assert.equal(normToken('14,500'), '14500');
  assert.equal(normToken('don’t'), "don't");
  assert.equal(normToken("'quoted'"), 'quoted');
  assert.equal(normToken('-'), '');
  assert.equal(normToken('...'), '');
  assert.equal(normToken('Hello!'), 'hello');
  assert.deepEqual(tokenize('Hello,  WORLD - again'), ['hello', 'world', 'again']);
});

const A = mk('A', 'we will make America great again, truly great');
const B = mk('B', 'make - America great and make it great again');

test('searchLibrary finds phrases across sources, skipping junk tokens', () => {
  assert.deepEqual(searchLibrary([A, B], 'great'), [
    { sourceId: 'A', i0: 4, i1: 4 },
    { sourceId: 'A', i0: 7, i1: 7 },
    { sourceId: 'B', i0: 3, i1: 3 },
    { sourceId: 'B', i0: 7, i1: 7 },
  ]);
  assert.deepEqual(searchLibrary([A, B], 'make america'), [
    { sourceId: 'A', i0: 2, i1: 3 },
    { sourceId: 'B', i0: 0, i1: 2 }, // spans the "-" word
  ]);
  assert.deepEqual(searchLibrary([A, B], 'zebra'), []);
  assert.deepEqual(searchLibrary([A, B], '  ,, '), []);
});

test('phrases never span two sources', () => {
  const x = mk('X', 'one two');
  const y = mk('Y', 'three four');
  assert.deepEqual(searchLibrary([x, y], 'two three'), []);
});

test('wordIndex skips empty tokens', () => {
  const idx = wordIndex([B]);
  assert.ok(!idx.has(''));
  assert.deepEqual(idx.get('great'), [{ sourceId: 'B', i0: 3, i1: 3 }, { sourceId: 'B', i0: 7, i1: 7 }]);
  assert.equal(idx.get('make').length, 2);
});

test('planLine picks the longest phrase first and lists all takes', () => {
  const slots = planLine([A, B], 'Make America great again');
  assert.equal(slots.length, 1);
  assert.deepEqual(slots[0].tokens, ['make', 'america', 'great', 'again']);
  assert.equal(slots[0].missing, false);
  assert.deepEqual(slots[0].takes, [{ sourceId: 'A', i0: 2, i1: 5 }]);
  assert.equal(slots[0].text, 'Make America great again');
});

test('planLine falls back to shorter phrases and reports missing words', () => {
  const slots = planLine([A, B], 'make America great banana again');
  assert.deepEqual(slots.map((s) => s.tokens.join(' ')), ['make america great', 'banana', 'again']);
  assert.equal(slots[1].missing, true);
  assert.deepEqual(slots[1].takes, []);
  assert.deepEqual(slots[0].takes.map((t) => t.sourceId), ['A', 'B']);
  assert.deepEqual(slots[0].takes[1], { sourceId: 'B', i0: 0, i1: 3 });
});

test('planLine caps phrases at 8 tokens', () => {
  const s = mk('L', 'a b c d e f g h i j');
  const slots = planLine([s], 'a b c d e f g h i j');
  assert.deepEqual(slots.map((x) => x.tokens.length), [8, 2]);
});

test('planLines', () => {
  const r = planLines([A, B], 'make america\n\n  \nfoo great\r\nfoo bar foo\n---');
  assert.equal(r.lines.length, 3);
  assert.deepEqual(r.missing, ['foo', 'bar']);
  assert.equal(r.lines[1].slots[0].missing, true);
  assert.equal(r.lines[1].text, 'foo great');
});

test('planLine is fast on 10 sources of 2500 words', () => {
  const vocab = Array.from({ length: 400 }, (_, i) => 'w' + i);
  const srcs = Array.from({ length: 10 }, (_, k) =>
    mk('S' + k, Array.from({ length: 2500 }, (_, i) => vocab[(i * 7 + k * 13 + (i >> 3)) % 400]).join(' ')));
  const t0 = performance.now();
  for (let i = 0; i < 20; i++) planLine(srcs, vocab.slice(i, i + 30).join(' '));
  assert.ok(performance.now() - t0 < 2000);
});
