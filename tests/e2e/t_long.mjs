// Criterion 10: a file right at the 15-minute cap. Speed, memory, the page staying responsive, and
// everything still working at the far end of a long transcript. Skipped with SKIP_LONG=1.
import { existsSync } from 'node:fs';
import {
  check, info, openApp, clearCache, chooseFiles, audio, tid, sourceWords, wordMatch, script, pct, makeClip, wordSpan,
  downloadVia, unzip, parseWav, parseCsv, sleep,
} from './lib.mjs';

const heapMb = (page) => page.evaluate(() => { if (window.gc) window.gc(); return performance.memory.usedJSHeapSize / 1048576; });

export const tests = [{
  name: 'long',
  async run({ getCtx }) {
    if (!existsSync(audio('long.wav'))) { check('long.wav exists (run: node tests/make-fixtures.mjs)', false); return; }
    const ctx = await getCtx();
    const page = await openApp(ctx);
    await clearCache(page);
    const heap0 = await heapMb(page);

    // a frame-gap recorder: how long does the page ever freeze?
    await page.evaluate(() => {
      window.__gaps = { max: 0, over250: 0, over1000: 0, frames: 0, last: performance.now() };
      const tick = (t) => { const g = window.__gaps; const d = t - g.last; g.last = t; g.frames++; if (d > g.max) g.max = d; if (d > 250) g.over250++; if (d > 1000) g.over1000++; requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    });

    const t0 = Date.now();
    await chooseFiles(page, audio('long.wav'));
    let firstWordMs = null; let peak = heap0; let lastPct = -1; let backwards = 0; let clicksOk = 0; let clicks = 0; let ok = true;
    while (true) {
      const st = await page.evaluate(() => { const s = window.__vox.state; const b = document.querySelector('[data-testid=progress] .bar'); return { busy: s.busy, n: s.sources[0] ? s.sources[0].words.length : 0, pct: +(b.getAttribute('aria-valuenow') || -1), label: document.querySelector('[data-testid=progress] .prog-label').textContent, heap: performance.memory.usedJSHeapSize / 1048576, banner: !document.querySelector('[data-testid=error-banner]').hidden }; });
      if (st.n > 0 && firstWordMs == null) firstWordMs = Date.now() - t0;
      if (st.heap > peak) peak = st.heap;
      if (/Transcribing/.test(st.label)) { if (st.pct < lastPct) backwards++; lastPct = Math.max(lastPct, st.pct); }
      if (st.banner) { ok = false; break; }
      if (!st.busy && st.n > 0) break;
      if (Date.now() - t0 > 30 * 60000) { ok = false; break; }
      // the page must stay usable while it works: a click on the How-to toggle has to land promptly
      if (st.n > 50 && clicks < 6) {
        clicks++;
        const c0 = Date.now();
        const before = await page.locator('.howto-head [data-howto-toggle]').getAttribute('aria-expanded');
        await page.locator('.howto-head [data-howto-toggle]').click({ timeout: 5000 }).catch(() => {});
        const after = await page.locator('.howto-head [data-howto-toggle]').getAttribute('aria-expanded');
        if (after !== before && Date.now() - c0 < 1500) clicksOk++;
      }
      await sleep(2000);
    }
    const ms = Date.now() - t0;
    if (!ok) {
      check('long.wav: transcribed without an error or a stall', false, await page.evaluate(() => document.querySelector('[data-testid=error-banner]').innerText + ' / ' + document.querySelector('#status-text').textContent));
      await page.close();
      return;
    }
    const src = await page.evaluate(() => { const s = window.__vox.state.sources[0]; return { duration: s.duration, n: s.words.length }; });
    const words = await sourceWords(page);
    const gaps = await page.evaluate(() => window.__gaps);
    const heapEnd = await heapMb(page);
    info('long.wav', `${(src.duration / 60).toFixed(2)} min, ${src.n} words, ${(ms / 1000).toFixed(0)} s total (${(src.duration / (ms / 1000)).toFixed(1)}x real time), first words after ${(firstWordMs / 1000).toFixed(1)} s`);
    info('heap MB (start / peak seen / end after gc)', `${heap0.toFixed(0)} / ${peak.toFixed(0)} / ${heapEnd.toFixed(0)}`);
    info('frame gaps', `longest ${Math.round(gaps.max)} ms, ${gaps.over250} over 250 ms, ${gaps.over1000} over 1 s, ${gaps.frames} frames`);

    check('long.wav (14.9 min) transcribes to the end', src.duration > 880 && words.at(-1).end > src.duration - 20, `last word at ${words.at(-1).end.toFixed(1)} s of ${src.duration.toFixed(1)} s`);
    check('faster than real time', ms / 1000 < src.duration, `${(ms / 1000).toFixed(0)} s for ${src.duration.toFixed(0)} s of audio`);
    check('first words show up within 60 s (you are not left staring at a spinner)', firstWordMs != null && firstWordMs < 60000, `${(firstWordMs / 1000).toFixed(1)} s`);
    check('progress percentage never goes backwards', backwards === 0, `${backwards} times`);
    check('page stays responsive while transcribing (clicks land within 1.5 s)', clicks > 0 && clicksOk === clicks, `${clicksOk}/${clicks}`);
    check('no freeze longer than 1 s', gaps.over1000 === 0, `longest ${Math.round(gaps.max)} ms`);
    check('JS heap stays under 1 GB', peak < 1024, `peak ${peak.toFixed(0)} MB`);

    // accuracy: the file is clean.wav repeated, so the script repeats too
    const reps = Math.round(src.duration / 74.6);
    const ref = Array.from({ length: reps }, () => script('clean_script.txt')).join(' ');
    const m = wordMatch(ref, words.map((w) => w.text).join(' '));
    info('long.wav accuracy', `${pct(m.pct)}% (${m.match}/${m.ref}), ${reps} repeats`);
    check('accuracy holds over the whole 15 minutes (>= 90%)', m.pct >= 90, `${pct(m.pct)}%`);
    let bad = 0; let back = 0;
    words.forEach((w, i) => { if (!(w.start < w.end) || w.end > src.duration + 0.05) bad++; if (i && w.start < words[i - 1].start - 0.001) back++; });
    check('timestamps stay sane across chunk joins (ordered, inside the file)', bad === 0 && back === 0, `${bad} bad, ${back} backwards`);
    // no chunk boundary may drop or double a stretch of speech: gaps and repeats
    let bigGap = 0; for (let i = 1; i < words.length; i++) if (words[i].start - words[i - 1].end > 6) bigGap++;
    check('no holes in the transcript (no silent gap over 6 s)', bigGap === 0, `${bigGap}`);

    // ---- still snappy with ~3000 words on screen
    const spans = await page.locator('.transcript .w').count();
    check('every word is on screen as its own span', spans === words.length, `${spans}/${words.length}`);
    const last = words.length - 1;
    const t1 = Date.now();
    await wordSpan(page, last - 3).scrollIntoViewIfNeeded();
    await makeClip(page, last - 3, last - 1);
    await makeClip(page, 0, 2);
    await makeClip(page, Math.floor(last / 2), Math.floor(last / 2) + 4);
    info('3 clips made in a 15-min transcript (ms)', Date.now() - t1);
    check('selecting and clipping stays quick in a long transcript', Date.now() - t1 < 6000, `${Date.now() - t1} ms`);
    const s0 = Date.now();
    await tid(page, 'search-input').fill('bridge');
    await page.waitForFunction(() => window.__vox.state.matches.length > 0, null, { timeout: 5000 });
    const nm = await page.evaluate(() => window.__vox.state.matches.length);
    check('search across the long transcript is instant and finds every repeat', Date.now() - s0 < 1500 && nm >= reps - 1, `${nm} matches in ${Date.now() - s0} ms`);
    check('long result lists are capped with a "showing N of M" note', nm <= 40 || /Showing 40 of/.test(await page.locator('#search-results .res-more').innerText().catch(() => '')));
    await tid(page, 'search-input').fill('');

    const clips = await page.evaluate(() => window.__vox.state.clips.map((c) => ({ start: c.start, end: c.end, text: c.text })));
    const e0 = Date.now();
    const dl = await downloadVia(page, () => tid(page, 'export-zip-btn').click(), 'export_long.zip');
    info('export of 3 clips from the 15-min file (ms)', Date.now() - e0);
    const files = await unzip(dl.buf);
    const wavs = [...files.keys()].filter((n) => n.endsWith('.wav')).sort();
    let durBad = 0; wavs.forEach((n, k) => { const w = parseWav(files.get(n)); if (!w.ok || Math.abs(w.duration - (clips[k].end - clips[k].start)) > 0.015) durBad++; });
    check('clips from the start, middle and very end of the file export correctly', wavs.length === 3 && durBad === 0, `${wavs.length} files, ${durBad} wrong length`);
    const rows = parseCsv(files.get('manifest.csv').toString('utf8')).slice(1).filter((r) => r.length > 1);
    check('manifest times near the 15-minute mark are right', rows.length === 3 && Math.abs(+rows[0][2] - clips[0].start) < 0.002 && +rows[0][2] > 850, rows[0] ? rows[0].slice(2, 5).join(' ') : '');

    // ---- second visit: from the cache, no re-transcribing
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => window.__vox && window.__vox.ready === true);
    const r0 = Date.now();
    await chooseFiles(page, audio('long.wav'));
    await page.waitForFunction(() => { const s = window.__vox.state; return s.sources.length === 1 && s.sources[0].words.length > 0 && !s.busy; }, null, { timeout: 120000, polling: 100 });
    const reload = Date.now() - r0;
    info('long.wav second load, from cache (ms)', reload);
    check('second load of the 15-min file comes from the cache (under 15 s)', reload < 15000 && (await page.evaluate(() => window.__vox.state.sources[0].words.length)) === words.length, `${reload} ms`);
    await page.close();
  },
}];
