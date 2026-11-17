// ALL tier logic lives in this one file. Nothing else in the app decides what a
// user is allowed to do: other modules only call the functions exported here.
//
// Vox-Slice is FREE FOR EVERYONE. Pure module (no DOM), runs in Node for the
// unit tests.
import { MAX_SECONDS } from './audio.js';

/**
 * THE SWITCH. While this is true, every visitor gets the full 'pro' limits
 * (15 minutes per file) and all the free-tier / Go Pro UI stays hidden.
 *
 * To bring the free tier back (for example if the site ever passes ~100 users):
 *   1. set FREE_FOR_ALL = false below,
 *   2. restore the pricing copy in pricing.html if you want a paid plan,
 *   3. run `npm test` (tests/unit/tier.test.mjs checks both modes).
 * The 20-second free limit, the Go Pro banner, the tier label and the How-to
 * note are all still in the code; they just stay dormant while this is true.
 */
export const FREE_FOR_ALL = true;

/** Where the "Go Pro" buttons point. A placeholder page for now. */
export const UPGRADE_URL = '/pricing';

/** A 20.0 s file can decode to 20.02 s; this slack stops it failing on rounding. */
export const TIER_TOLERANCE = 0.5;

export const TIERS = {
  free: { id: 'free', label: 'Free', maxSeconds: 20 },
  pro: { id: 'pro', label: 'Pro', maxSeconds: MAX_SECONDS },
};

/**
 * Which tier is this visitor on? Returns 'free' or 'pro'.
 *
 * ============================================================================
 * PLUG THE REAL MEMBERSHIP / STRIPE CHECK IN HERE.
 *
 * This is the only place that needs to change. Replace the `return 'free'`
 * at the bottom with the real answer, e.g. read a membership flag that the
 * sign-in code stored after asking the server "is this person a paying
 * member?". Keep it synchronous (read a cached value) so the callers do not
 * change; refresh that cached value from the sign-in code.
 *
 * Remember that anything decided in the browser can be bypassed by a
 * determined user. The server must be the one that knows who has paid.
 * ============================================================================
 */
export function getUserTier() {
  if (FREE_FOR_ALL) return 'pro';
  if (isLocalPro()) return 'pro';
  return 'free';
}

/**
 * LOCAL PRO: the owner's full-featured copy, running on their own machine.
 *
 * It is on only when BOTH of these are true:
 *   1. the app is running from the local dev server (`npm run dev`), and
 *   2. the file `.env.local` says VITE_VOX_TIER=pro (that file is git-ignored,
 *      so it is never pushed or deployed), or the browser tests asked for it.
 *
 * `import.meta.env.DEV` is replaced with the literal `false` when the site is
 * built for production, so the bundler deletes this whole block from the live
 * site. There is no URL parameter, cookie or localStorage value a visitor can
 * set to reach it, and a production build ignores VITE_VOX_TIER even if
 * `.env.local` is sitting next to it.
 */
export function isLocalPro() {
  if (import.meta.env?.DEV) {
    if (import.meta.env.VITE_VOX_TIER === 'pro') return true;
    try {
      // Browser tests only (their fixtures are longer than 20 s).
      if (globalThis.localStorage?.getItem('vox.devTier') === 'pro') return true;
    } catch { /* storage blocked: stay on free */ }
  }
  return false;
}

export function getTierLimits(tier = getUserTier()) {
  return TIERS[tier] || TIERS.free;
}

/** Is a file of this decoded length allowed? Pass the DECODED duration in seconds. */
export function checkDuration(seconds, tier = getUserTier()) {
  const limits = getTierLimits(tier);
  return {
    ok: !(seconds > limits.maxSeconds + TIER_TOLERANCE),
    tier: limits.id,
    limit: limits.maxSeconds,
    canUpgrade: limits.id !== 'pro',
  };
}

/** "20 seconds" / "15 minutes" */
export function limitText(seconds) {
  if (seconds < 60) return `${seconds} seconds`;
  const m = Math.round(seconds / 60);
  return `${m} minute${m === 1 ? '' : 's'}`;
}

/** Short label for the UI, e.g. "Free: files up to 20 s". */
export function tierSummary(tier = getUserTier()) {
  const l = getTierLimits(tier);
  const short = l.maxSeconds < 60 ? `${l.maxSeconds} s` : `${Math.round(l.maxSeconds / 60)} min`;
  return `${l.label}: files up to ${short}`;
}
