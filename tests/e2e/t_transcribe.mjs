// Criterion 1: transcription accuracy, timing, word-timestamp sanity.
import { check, info, openApp, clearCache, chooseFiles, waitLoaded, wordMatch, script, audio, pct, tid } from './lib.mjs';

const FILES = [
  { file: 'clean.wav', ref: 'clean_script.txt', min: 90 },
  { file: 'hard.wav', ref: 'hard_script.txt', min: null },
  { file: 'clean.mp3', ref: 'clean_script.txt', min: 90 },
  { file: 'clean.m4a', ref: 'clean_script.txt', min: 90 },
  { file: 'noisy.mp3', ref: 'hard_script.txt', min: null },
];

export const tests = [{
  name: 'transcribe',
  async run({ getCtx }) {
    const ctx = await getCtx();
    const table = [];
    for (const f of FILES) {
      console.log(` -- ${f.file}`);
      const page = await openApp(ctx);
      await clearCache(page); // force real work, never a cache hit
      const t0 = Date.now();
      await chooseFiles(page, audio(f.file));
      let ok = true;
      let firstWordMs = null;
      try {
        const fw = page.waitForFunction(() => window.__vox.state.sources[0] && window.__vox.state.sources[0].words.length > 0, null, { timeout: 240000, polling: 100 }).then(() => { firstWordMs = Date.now() - t0; });
        await waitLoaded(page, 1, 240000);
        await fw;
      } catch (e) { ok = false; }
      const ms = Date.now() - t0;
      if (!ok) {
        const diag = await page.evaluate(() => ({ n: window.__vox.state.sources.length, busy: window.__vox.state.busy, banner: document.querySelector('[data-testid=error-banner]')?.innerText || '', status: document.querySelector('#status-text')?.textContent }));
        check(`${f.file}: transcribed`, false, JSON.stringify(diag));
        table.push({ file: f.file, ms, pct: null });
        await page.close();
        continue;
      }
      const src = await page.evaluate(() => { const s = window.__vox.state.sources[0]; return { duration: s.duration, model: s.model, words: s.words.map((w) => ({ text: w.text, start: w.start, end: w.end, guessed: !!w.guessed })) }; });
      const hyp = src.words.map((w) => w.text).join(' ');
      const m = wordMatch(script(f.ref), hyp);
      // timestamp sanity
      let badFinite = 0; let badOrder = 0; let backwards = 0; let overlapBig = 0; let beyond = 0; let guessed = 0;
      src.words.forEach((w, i) => {
        if (!Number.isFinite(w.start) || !Number.isFinite(w.end) || !(w.start < w.end)) badFinite++;
        if (w.end > src.duration + 0.05 || w.start < -0.001) beyond++;
        if (w.guessed) guessed++;
        if (i) {
          const p = src.words[i - 1];
          if (w.start < p.start - 0.001) backwards++;
          if (w.start < p.end - 0.30) overlapBig++;
        }
      });
      table.push({ file: f.file, ms, firstWordMs, pct: m.pct, ref: m.ref, hyp: m.hyp, words: src.words.length, dur: src.duration, missed: m.missed.slice(0, 12), guessed });
      info(`${f.file}`, `${pct(m.pct)}% match (${m.match}/${m.ref} script words, ${m.hyp} transcribed), ${(ms / 1000).toFixed(1)} s total for ${src.duration.toFixed(1)} s audio (${(src.duration / (ms / 1000)).toFixed(1)}x real time), model ${src.model}, guessed-timing words ${guessed}, missed: ${m.missed.slice(0, 15).join(' ')}`);
      if (f.min != null) check(`${f.file}: accuracy >= ${f.min}%`, m.pct >= f.min, `${pct(m.pct)}%`);
      check(`${f.file}: every word has finite start < end`, badFinite === 0, `${badFinite} bad of ${src.words.length}`);
      check(`${f.file}: word starts never go backwards`, backwards === 0, `${backwards}`);
      check(`${f.file}: no word overlaps previous by >300 ms`, overlapBig === 0, `${overlapBig}`);
      check(`${f.file}: nothing beyond source duration (${src.duration.toFixed(2)} s)`, beyond === 0, `${beyond}; last end ${src.words.at(-1).end.toFixed(2)}`);
      if (f.file === 'clean.wav') {
        const status = await page.locator('#status-text').textContent();
        check('clean.wav: status line reports done with word count', /Done/.test(status), status);
        const trCount = await page.locator('.transcript .w').count();
        check('clean.wav: transcript renders one span per word', trCount === src.words.length, `${trCount} spans / ${src.words.length} words`);
        check('clean.wav: progress panel hidden after finish', await tid(page, 'progress').isHidden());
      }
      await page.close();
    }
    info('summary', table);
  },
}];
