import test from 'node:test';
import assert from 'node:assert/strict';
import { serializeProject, parseProject, getTranscript, putTranscript, listTranscripts, clearTranscripts } from '../../src/store.js';

const words = [
  { text: 'Hello', start: 0, end: 0.4 },
  { text: 'there,', start: 0.4, end: 0.9, guessed: true },
  { text: 'world.', start: 1, end: 1.5 },
];
const sources = [{ id: 's1', name: 'a.mp3', hash: 'abc', duration: 2, model: 'm', words, buffer: { x: 1 }, peaks: { min: 1 } }];
const clips = [{ id: 'c1', sourceId: 's1', i0: 0, i1: 1, text: 'Hello there,', start: 0, end: 0.9 }];

test('project round trip', () => {
  const obj = serializeProject({ sources, clips, settings: { pad: 0.05 } });
  assert.equal(obj.app, 'vox-slice');
  assert.equal(obj.version, 1);
  assert.ok(obj.savedAt);
  assert.ok(!('buffer' in obj.sources[0]));
  for (const input of [obj, JSON.stringify(obj)]) {
    const p = parseProject(input);
    assert.equal(p.sources[0].buffer, null);
    assert.equal(p.sources[0].peaks, null);
    assert.deepEqual(p.sources[0].words, words);
    assert.deepEqual(p.clips, clips);
    assert.deepEqual(p.settings, { pad: 0.05 });
  }
});

test('parseProject drops invalid clips but keeps the project', () => {
  const obj = serializeProject({ sources, clips, settings: {} });
  obj.clips.push(
    { id: 'bad1', sourceId: 'nope', i0: 0, i1: 0, text: 'x', start: 0, end: 1 },
    { id: 'bad2', sourceId: 's1', i0: 0, i1: 9, text: 'x', start: 0, end: 1 },
    { id: 'bad3', sourceId: 's1', i0: 2, i1: 1, text: 'x', start: 0, end: 1 },
    { id: 'bad4', sourceId: 's1', i0: 0, i1: 0, text: 'x', start: 'a', end: 1 },
    null,
    'junk',
  );
  const p = parseProject(obj);
  assert.deepEqual(p.clips.map((c) => c.id), ['c1']);
});

test('parseProject rejects garbage', () => {
  const bad = ['', 'not json', '[]', 'null', '42', '{}', { app: 'other', version: 1, sources: [] }, { app: 'vox-slice', sources: [] }, { app: 'vox-slice', version: 1, sources: 'x' }, null, undefined, 5];
  for (const b of bad) {
    assert.throws(() => parseProject(b), (e) => e.code === 'BAD_PROJECT', String(b));
  }
});

test('transcript cache degrades to no-ops without IndexedDB', async () => {
  assert.equal(await getTranscript('h', 'm'), null);
  await putTranscript('h', 'm', { name: 'a', duration: 1, words: [] });
  assert.deepEqual(await listTranscripts(), []);
  await clearTranscripts();
});
