import test from 'node:test';
import assert from 'node:assert/strict';
import { FREE_FOR_ALL, getUserTier, getTierLimits, checkDuration, tierSummary, limitText, TIERS, UPGRADE_URL } from '../../src/tier.js';
import { VoxError, friendlyMessage } from '../../src/errors.js';

test('Vox-Slice is free for everyone: every visitor gets the pro limits', () => {
  assert.equal(FREE_FOR_ALL, true);
  assert.equal(getUserTier(), 'pro');
  assert.equal(getTierLimits().maxSeconds, 900);
  assert.equal(UPGRADE_URL, '/pricing');
});

test('free limit: 20 s with a small tolerance', () => {
  assert.equal(checkDuration(15, 'free').ok, true);
  assert.equal(checkDuration(20, 'free').ok, true);
  assert.equal(checkDuration(20.02, 'free').ok, true, 'rounding slack');
  assert.equal(checkDuration(20.5, 'free').ok, true, 'exactly at the tolerance');
  assert.equal(checkDuration(20.51, 'free').ok, false);
  assert.equal(checkDuration(45, 'free').ok, false);
  const r = checkDuration(45, 'free');
  assert.deepEqual([r.tier, r.limit, r.canUpgrade], ['free', 20, true]);
});

test('pro limit is the 15 minute cap', () => {
  assert.equal(TIERS.pro.maxSeconds, 900);
  assert.equal(checkDuration(45, 'pro').ok, true);
  assert.equal(checkDuration(901, 'pro').ok, false);
  assert.equal(checkDuration(901, 'pro').canUpgrade, false);
});

test('unknown tier falls back to free', () => {
  assert.equal(getTierLimits('platinum').id, 'free');
});

test('labels', () => {
  assert.equal(tierSummary('free'), 'Free: files up to 20 s');
  assert.equal(tierSummary('pro'), 'Pro: files up to 15 min');
  assert.equal(limitText(20), '20 seconds');
  assert.equal(limitText(900), '15 minutes');
});

test('TIER_LIMIT message is friendly and names both lengths', () => {
  const m = friendlyMessage(new VoxError('TIER_LIMIT', 'internal detail', { duration: 45, limit: 20 }));
  assert.match(m, /0:45/);
  assert.match(m, /20 seconds/);
  assert.ok(!m.includes('internal detail') && !m.includes('—'));
});
