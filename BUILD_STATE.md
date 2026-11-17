# BUILD_STATE

Vox-Slice is **free, open source (MIT) and public**. Everyone gets the full tool.

## Setup
- Hosting: Cloudflare Pages (`vox-slice.pages.dev`), build `npm run build`, output `dist`, Node 22 (`.node-version`).
  `public/_headers` supplies the security headers and the COOP/COEP isolation headers. No Netlify features are used.
- `scripts/prune-dist.mjs` runs after the build: it deletes the unused ~25 MB `ort-wasm-simd-threaded.asyncify-*.wasm`
  and fails the build if any file is over Cloudflare's 25 MiB limit.
- No password gate. `extras/password-gate/` keeps the old Netlify edge function and how to switch it back on.
- `src/tier.js`: `FREE_FOR_ALL = true` makes `getUserTier()` return 'pro' for everyone. The 20-second free tier,
  Go Pro banner, tier label and How-to note are dormant (UI nodes tagged `data-tier-ui` are removed while the switch is on).
- `/pricing` is the "free and open source" page with a Support button. Its link lives in ONE constant,
  `SUPPORT_URL` in `src/pricing.js` (empty = "Tip jar coming soon", not clickable).
- Footer link: Report a bug / Suggest a feature goes to GitHub Issues.

## Testing
- `npm test`: unit tests. `npm run build && npm run serve:dist`, then `npm run test:e2e` (production build, real headers).
- Browser checks must show zero CSP errors in the console, and transcription must be multi-threaded (`crossOriginIsolated`).
