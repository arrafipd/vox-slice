# Contributing to Vox-Slice

Thanks for helping! Vox-Slice is a small, free tool and contributions of any size are welcome.

## Report a bug or suggest a feature
Open an issue: https://github.com/robbiefromramona-press/vox-slice/issues/new/choose
Please do not attach private audio. Describe what happened (and your browser) instead.

## Run it locally
```
npm install
npm run dev        # http://localhost:5184 (Chrome works best)
npm test           # unit tests
npm run build && npm run serve:dist   # test the production build with the real headers (port 5190)
npm run test:e2e   # browser tests; run against the production server above
```

## Ground rules
- **Audio never leaves the computer.** No uploads, no analytics, no third-party calls at runtime (the speech model download from huggingface.co is the one exception).
- Keep the security headers in `public/_headers` working: changes that need a looser Content-Security-Policy need a good reason.
- Keep changes small and explain them in the pull request. Add or update a test when you fix a bug.
- By contributing you agree your work is released under the MIT license.
