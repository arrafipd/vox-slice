# Vox-Slice architecture and module contract

Vox-Slice is a browser-only app (Vite + vanilla ES modules, no framework, no backend).
Drop in speech audio, it is transcribed in the browser with Whisper (transformers.js in a
worker), you select words, turn them into clips, and export WAV / MP3 / ZIP.
Nothing is ever uploaded. A Fire-Press tool, sibling of Roto-Slice.

Dev server: `npm run dev` -> http://localhost:5184 (cross-origin isolated).

## Data shapes

```js
Word   = { text, start, end, guessed? }      // seconds on the source timeline; text keeps punctuation
Source = { id, name, hash, duration, model,   // name = original file name incl. extension
           words: Word[],
           buffer: AudioBuffer | null,        // null when restored from a project file without its audio
           peaks: { min: Float32Array, max: Float32Array } | null }
Clip   = { id, sourceId, i0, i1, text, start, end }  // start/end are absolute seconds, already padded;
                                                     // edge drags and nudges edit start/end directly
Audio  = { sr, chans: Float32Array[] }        // plain PCM, used by all pure audio functions
Match  = { sourceId, i0, i1 }                 // a run of words inside one source
```

## Logic modules (no DOM access except where noted)

### src/errors.js
`class VoxError extends Error { code }` with codes
`NOT_AUDIO | TOO_LONG | TIER_LIMIT | DECODE_FAILED | MODEL_DOWNLOAD | TIMEOUT | CANCELLED | WORKER | BAD_PROJECT`.
`friendlyMessage(err) -> string` plain-language, non-technical, one or two sentences.

### src/tier.js  (ALL tier logic; nothing else decides what a user may do)
- `FREE_FOR_ALL = true` is the one switch: `getUserTier()` returns 'pro' for everyone while it is on. Set it false to bring the 20 s free tier back (code and tests kept).
- `TIERS` = free 20 s, pro `MAX_SECONDS`. `TIER_TOLERANCE = 0.5` s. `UPGRADE_URL = '/pricing'`.
- `getTierLimits(tier?)`, `checkDuration(seconds, tier?) -> { ok, tier, limit, canUpgrade }`,
  `tierSummary(tier?)` ("Free: files up to 20 s"), `limitText(seconds)`.
- Used by `src/ui/loader.js` (`decodeForTier`: checks the DECODED duration, throws `TIER_LIMIT`, the file is
  rejected whole, never truncated) and `src/ui/notices.js` (tier label, Go Pro banner, limit wording).
- `pricing.html` + `src/pricing.js` is the "free and open source" page (Support button, SUPPORT_URL).

### src/audio.js
- `MAX_SECONDS = 900`
- `probeDuration(file) -> Promise<number|null>` cheap duration read (WAV header, else an `<audio>` element's metadata). Never decodes the whole file.
- `decodeFile(file) -> Promise<AudioBuffer>` rejects with `TOO_LONG` (checked BEFORE decoding via probeDuration, and again after), `NOT_AUDIO`, or `DECODE_FAILED`. `err.duration` is set on TOO_LONG.
- `to16kMono(buffer) -> Promise<Float32Array>`
- `hashFile(file) -> Promise<string>` hex SHA-256
- `computePeaks(buffer, buckets) -> Promise<{min,max}>` yields to the event loop on long audio
- `sliceAudio(buffer, start, end, { fadeMs = 5 } = {}) -> Audio`
- `normalizeAudio(audio, peakDb = -1) -> Audio` peak normalize (no-op on silence)
- `trimSilence(audio, { thresholdDb = -45, keepMs = 15 } = {}) -> Audio` trims only the two ends
- `joinAudio(parts: Audio[], { gapMs = 60 } = {}) -> Audio` resamples/upmixes to match the first part
- `audioToBuffer(ctx, audio) -> AudioBuffer`

### src/encode.js
- `encodeWav(audio) -> Uint8Array` 16-bit PCM
- `encodeMp3(audio, kbps = 160) -> Promise<Uint8Array>` (@breezystack/lamejs; yields on long audio)
- `clipFileName({ index, text, ext, sourceName }) -> string` e.g. `003_tremendous_town-hall.wav` (1-based, zero-padded, slugged, max ~60 chars)
- `manifestCsv(rows) -> string` header `filename,source_file,start,end,duration,text`; RFC-4180 quoting
- `makeZip(entries: {name, data}[]) -> Promise<Blob>` (JSZip)
- `renderClip(clip, source, { normalize, trim }) -> Audio`
- `exportClips({ clips, sources, formats, normalize, trim, onProgress }) -> Promise<{ entries, manifest }>` formats is a subset of `['wav','mp3']`; entries include `manifest.csv`

### src/store.js
- Transcript cache (IndexedDB db `vox-slice`, store `transcripts`, key `hash|model|timing-version`):
  `getTranscript(hash, model)`, `putTranscript(hash, model, { name, duration, words })`, `listTranscripts()`, `clearTranscripts()`. Every function degrades to a harmless no-op / null if IndexedDB is unavailable.
- Project files: `serializeProject({ sources, clips, settings }) -> object` (version 1, no audio inside) and
  `parseProject(textOrObject) -> { sources, clips, settings }` (validates; throws `BAD_PROJECT`).

### src/library.js
- `normToken(text) -> string` lower-case, strips punctuation, keeps inner apostrophes and digits
- `tokenize(line) -> string[]`
- `searchLibrary(sources, query) -> Match[]` phrase search across every source
- `wordIndex(sources) -> Map<token, Match[]>` every single-word take
- `planLine(sources, line) -> Slot[]` greedy longest-phrase match;
  `Slot = { tokens, text, takes: Match[], missing }` (a missing slot is exactly one token)
- `planLines(sources, text) -> { lines: { text, slots }[], missing: string[] }` one line per non-empty row; `missing` is unique, in first-seen order

### src/rhyme.js
- `loadRhymes() -> Promise<void>` fetches `data/rhymes.json` (built by `scripts/build-rhymes.mjs` from the CMU dictionary, shipped with the site)
- `findRhymes(word, candidateTokens) -> { known, perfect: string[], near: string[] }`

### src/align.js
Tightens Whisper's word times against the audio. Whisper reports word starts about 0.1 s late and gives a
word before a pause the whole pause; both made clips that chopped the first sound and dragged in the next word.
- `findPauses(audio, sr) -> [startSec, endSec][]` loudness-based pauses (works on noisy audio; `[]` when there is no contrast)
- `refineWords(words, audio, sr) -> Word[]` words after a pause start where the sound starts, the lag measured
  there is taken off the other words, and a word before a pause ends where the sound stops (plus a 40 ms tail).
The worker runs it on every window. Cached transcripts carry a timing version (`TIMING` in `src/store.js`);
bump it whenever this logic changes.

### src/transcriber.js  (owns the worker in src/asr-worker.js)
`createTranscriber() -> { transcribe(audio16k, opts) -> Promise<{ words, elapsedMs, threads }>, cancel(), get busy() }`
`opts = { model, onStage(stage), onDownload({loaded,total}), onPartial({words, doneSec, totalSec, window, windows}) }`
stages: `'loading-model' | 'downloading' | 'transcribing'`.
Rejects with `MODEL_DOWNLOAD` (network / model fetch failed or stalled), `TIMEOUT`, `CANCELLED`, `WORKER`.
`cancel()` terminates the worker; the next call starts a fresh one.

## UI modules
- `index.html`, `src/style.css`, `src/main.js`, `src/ui/*.js`
- `src/waveform.js` canvas waveform with a highlighted clip region and draggable start/end handles
- `src/player.js` Web Audio playback (range, loop, stitched preview)

## Test hooks (the end-to-end tests rely on these; keep them stable)
- `window.__vox = { state, ready: true }` where `state = { sources, clips, busy, settings }` is the live app state.
- `data-testid` attributes: `file-input`, `drop-zone`, `model-select`, `progress`, `cancel-btn`, `status`,
  `error-banner`, `transcript`, `search-input`, `match-count`, `add-matches-btn`, `add-clip-btn`,
  `play-sel-btn`, `waveform`, `clips-list`, `fmt-wav`, `fmt-mp3`, `opt-normalize`, `opt-trim`, `pad-input`,
  `export-zip-btn`, `save-project-btn`, `load-project-input`, `tab-slice`, `tab-builder`, `builder-input`,
  `builder-run-btn`, `builder-lines`, `builder-missing`, `builder-preview-btn`, `builder-export-btn`,
  `rhyme-input`, `rhyme-results`, `library-list`, `howto`.
- Words render as `<span class="w" data-source="<sourceId>" data-i="<index>">`.
- Clips render as `<div class="clip" data-clip-id="...">` containing buttons with
  `data-act="play|loop|wav|mp3|remove|start-|start+|end-|end+"`.

## Hard rules
1. Free only, browser only. No audio, transcript or clip ever leaves the visitor's device.
2. No runtime third-party CDNs for code. Only the Whisper model weights come from Hugging Face (cached after first use).
3. 15-minute hard cap per file, checked before decoding. The tier limit (free: 20 s) is checked after decoding, in `src/tier.js`.
4. Dependency versions are pinned exactly in package.json.
