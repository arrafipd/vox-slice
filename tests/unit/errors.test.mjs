import test from 'node:test';
import assert from 'node:assert/strict';
import { VoxError, friendlyMessage } from '../../src/errors.js';

test('friendlyMessage', () => {
  const codes = ['NOT_AUDIO', 'TOO_LONG', 'DECODE_FAILED', 'MODEL_DOWNLOAD', 'TIMEOUT', 'CANCELLED', 'WORKER', 'BAD_PROJECT'];
  for (const c of codes) {
    const m = friendlyMessage(new VoxError(c, 'internal detail'));
    assert.ok(m.length > 10 && !m.includes('internal detail') && !m.includes('—'), c);
  }
  assert.match(friendlyMessage(new VoxError('TOO_LONG', 'x', { duration: 1334 })), /22:14/);
  assert.ok(friendlyMessage(new Error('boom')).length > 5);
  assert.ok(friendlyMessage(null).length > 5);
  assert.equal(new VoxError('WORKER', 'busy').code, 'WORKER');
});
