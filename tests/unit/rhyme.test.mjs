import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { rhymesFromData } from '../../src/rhyme.js';

const file = fileURLToPath(new URL('../../public/data/rhymes.json', import.meta.url));
if (!existsSync(file)) execFileSync(process.execPath, [fileURLToPath(new URL('../../scripts/build-rhymes.mjs', import.meta.url))]);
const data = JSON.parse(readFileSync(file, 'utf8'));

test('real data: perfect rhymes', () => {
  const r = rhymesFromData(data, 'nation', ['station', 'nation', 'cat', 'hat', 'creation', 'banana']);
  assert.equal(r.known, true);
  assert.ok(r.perfect.includes('station'));
  assert.ok(r.perfect.includes('creation'));
  assert.ok(!r.perfect.includes('nation'));
  assert.deepEqual(rhymesFromData(data, 'Cat', ['hat', 'bat', 'dog', 'Hat!']).perfect, ['bat', 'hat']);
});

test('real data: near rhymes and sorting', () => {
  const r = rhymesFromData(data, 'cat', ['hat', 'bag', 'cap', 'back', 'dog', 'bat']);
  const b = rhymesFromData(data, 'bottle', ['model', 'throttle', 'cat']);
  assert.deepEqual(b.perfect, ['throttle']);
  assert.deepEqual(b.near, ['model']);
  assert.deepEqual(r.perfect, ['bat', 'hat']);

  assert.ok(!r.near.includes('hat'));
  assert.deepEqual([...r.near], [...r.near].sort());
});

test('real data: unknown words', () => {
  const r = rhymesFromData(data, 'qwertyzzz', ['hat']);
  assert.deepEqual(r, { known: false, perfect: [], near: [] });
  assert.equal(rhymesFromData(null, 'cat', ['hat']).known, false);
  assert.equal(rhymesFromData(data, 'valueof', ['hat']).known, false);
});

test('data size is sane', () => {
  assert.ok(Object.keys(data.words).length > 100000);
});
