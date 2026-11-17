// Criterion 4: edge and failure cases (cancel, bad file, over cap, model download failure, multi-file, cache).
import {
  check, info, openApp, clearCache, chooseFiles, waitLoaded, loadAndWait, audio, tid, sourceWords, unzip, downloadVia, parseCsv,
  wordMatch, script, pct, allowConsoleErrors, launchFresh, makeClip, findSeq, sleep,
} from './lib.mjs';

const FRIENDLY_BAD = /(Error:|DOMException|EncodingError|undefined|\[object|NaN|\bat [\w.]+ \(|stack|TypeError|NotSupported)/i;
const bannerText = (page) => tid(page, 'error-banner').innerText();
const bannerVisible = (page) => tid(page, 'error-banner').isVisible();

const cancel = {
  name: 'cancel',
  async run({ getCtx }) {
    allowConsoleErrors();
    const ctx = await getCtx();
    const page = await openApp(ctx);
    await clearCache(page); // make sure there is real work to cancel
    await chooseFiles(page, [audio('clean.wav'), audio('hard.wav'), audio('noisy.mp3')]);
    await page.waitForFunction(() => {
      const p = document.querySelector('[data-testid=progress]');
      return p && !p.hidden && /Transcribing/i.test(p.querySelector('.prog-label').textContent);
    }, null, { timeout: 90000, polling: 100 });
    await page.waitForFunction(() => window.__vox.state.sources[0].words.length > 0, null, { timeout: 60000, polling: 100 }).catch(() => {});
    await sleep(300);
    const wordsBefore = await page.evaluate(() => window.__vox.state.sources[0].words.length);
    check('transcription really in flight (busy true, partial words showing)', (await page.evaluate(() => window.__vox.state.busy)) === true, `${wordsBefore} words so far`);
    const t0 = Date.now();
    await tid(page, 'cancel-btn').click();
    await page.waitForFunction(() => !window.__vox.state.busy, null, { timeout: 15000, polling: 50 });
    info('cancel to idle (ms)', Date.now() - t0);
    check('state.busy false after cancel', true, `${Date.now() - t0} ms`);
    check('progress panel hidden after cancel', await tid(page, 'progress').isHidden());
    const chips = await page.locator('[data-testid=library-list] .lib-item .chip').allInnerTexts();
    check('cancelled file and the whole queue are marked cancelled', chips.length === 3 && chips.every((c) => /cancelled/i.test(c)), chips.join(','));
    check('Retry button offered for each cancelled file', (await page.locator('[data-testid=library-list] button:has-text("Retry")').count()) === 3);
    check('cancel did not raise an error banner', !(await bannerVisible(page)));
    const st = await page.locator('#status-text').textContent();
    check('status line says cancelled, not stuck on a percentage', /cancel/i.test(st) && !/%/.test(st), st);
    const nonEmpty = await page.evaluate(() => window.__vox.state.sources.filter((s) => s.words.length).length);
    check('cancelled sources keep no partial words', nonEmpty === 0, `${nonEmpty}`);
    const t1 = Date.now();
    await page.locator('[data-testid=library-list] .lib-item').first().locator('button:has-text("Retry")').click();
    await page.waitForFunction(() => { const s = window.__vox.state; return s.sources[0].words.length > 100 && !s.busy; }, null, { timeout: 300000, polling: 200 });
    const w = await sourceWords(page, 0);
    const m = wordMatch(script('clean_script.txt'), w.map((x) => x.text).join(' '));
    check('Retry after cancel transcribes the file correctly', m.pct >= 90, `${pct(m.pct)}% in ${((Date.now() - t1) / 1000).toFixed(1)} s`);
    await chooseFiles(page, audio('clean.mp3'));
    await page.waitForFunction(() => { const s = window.__vox.state; return s.sources.length === 4 && s.sources[3].words.length > 100 && !s.busy; }, null, { timeout: 120000, polling: 200 });
    check('a new file loads and transcribes after a cancel', true);
    await page.close();
  },
};

const badfile = {
  name: 'badfile',
  async run({ getCtx }) {
    allowConsoleErrors();
    const ctx = await getCtx();
    const page = await openApp(ctx);
    const t0 = Date.now();
    await chooseFiles(page, audio('notaudio.mp3'));
    await page.waitForFunction(() => { const b = document.querySelector('[data-testid=error-banner]'); return b && !b.hidden; }, null, { timeout: 30000, polling: 50 });
    const ms = Date.now() - t0;
    const txt = (await bannerText(page)).replace(/\s+/g, ' ').trim();
    info('bad-file banner', `${ms} ms: ${txt}`);
    check('notaudio.mp3 shows an error banner', true, `${ms} ms`);
    check('banner message is friendly (no stack/DOMException/undefined)', txt.length > 10 && !FRIENDLY_BAD.test(txt), txt);
    check('banner names the file', /notaudio\.mp3/.test(txt), txt);
    await page.waitForFunction(() => !window.__vox.state.busy, null, { timeout: 10000 });
    const n = await page.evaluate(() => window.__vox.state.sources.length);
    check('bad file removed from the library, app idle', n === 0, `${n} sources`);
    check('drop zone and file input still present', (await tid(page, 'file-input').count()) === 1 && (await tid(page, 'drop-zone').isVisible()));
    await page.locator('.err-close').click();
    check('banner can be dismissed', !(await bannerVisible(page)));
    const t1 = Date.now();
    await chooseFiles(page, audio('clean.wav'));
    await waitLoaded(page, 1, 120000);
    check('app still usable: clean.wav loads right after the bad file', true, `${Date.now() - t1} ms`);
    await page.close();
  },
};

const toolong = {
  name: 'toolong',
  async run({ getCtx }) {
    allowConsoleErrors();
    const ctx = await getCtx();
    const page = await openApp(ctx);
    await page.evaluate(() => {
      window.__t = {};
      const inp = document.querySelector('[data-testid=file-input]');
      inp.addEventListener('change', () => { window.__t.change = performance.now(); }, true);
      const b = document.querySelector('[data-testid=error-banner]');
      new MutationObserver(() => { if (!b.hidden && !window.__t.banner) window.__t.banner = performance.now(); }).observe(b, { attributes: true, childList: true, subtree: true });
    });
    const wall0 = Date.now();
    await chooseFiles(page, audio('toolong.wav'));
    await page.waitForFunction(() => { const b = document.querySelector('[data-testid=error-banner]'); return b && !b.hidden; }, null, { timeout: 60000, polling: 25 });
    const wall = Date.now() - wall0;
    const t = await page.evaluate(() => window.__t);
    const ms = Math.round(t.banner - t.change);
    info('toolong.wav refusal time (ms, change event to banner)', ms);
    info('toolong.wav refusal wall time incl. Playwright (ms)', wall);
    const txt = (await bannerText(page)).replace(/\s+/g, ' ').trim();
    info('toolong banner', txt);
    check('toolong.wav (16.2 min) refused with banner', true);
    check('refusal quick (< 2 s from file choice; must not decode 16 min)', ms < 2000, `${ms} ms`);
    check('message mentions 15 minutes', /15\s*minute/i.test(txt), txt);
    check('message is friendly', !FRIENDLY_BAD.test(txt), txt);
    await page.waitForFunction(() => !window.__vox.state.busy, null, { timeout: 10000 });
    const n = await page.evaluate(() => window.__vox.state.sources.length);
    check('refused file not left in library; app idle', n === 0, `${n}`);
    const heap = await page.evaluate(() => performance.memory.usedJSHeapSize / 1048576);
    check('JS heap stays small after refusal (< 150 MB)', heap < 150, `${heap.toFixed(0)} MB`);
    await page.close();
  },
};

const modelfail = {
  name: 'modelfail',
  async run() {
    allowConsoleErrors();
    const { browser, ctx } = await launchFresh();
    try {
      let block = true;
      const blocked = [];
      await ctx.route((url) => /(^|\.)huggingface\.co$|(^|\.)hf\.co$|cdn-lfs/i.test(url.hostname), (route) => {
        if (block) { blocked.push(route.request().url().slice(0, 100)); return route.abort('connectionrefused'); }
        return route.continue();
      });
      const page = await openApp(ctx);
      const t0 = Date.now();
      await chooseFiles(page, audio('clean.wav'));
      let shown = true;
      await page.waitForFunction(() => {
        const b = document.querySelector('[data-testid=error-banner]');
        return b && !b.hidden;
      }, null, { timeout: 180000, polling: 100 }).catch(() => { shown = false; });
      const ms = Date.now() - t0;
      info('model-download failure: time to friendly error (ms)', shown ? ms : 'NO ERROR within 180 s');
      info('blocked requests', blocked.length);
      check('model download blocked by the test', blocked.length > 0, `${blocked.length} aborted`);
      check('a friendly error appears within 60 s', shown && ms < 60000, shown ? `${(ms / 1000).toFixed(1)} s` : 'never');
      if (shown) {
        const txt = (await bannerText(page)).replace(/\s+/g, ' ').trim();
        info('model-fail banner', txt);
        check('error text is friendly (no stack/undefined)', !FRIENDLY_BAD.test(txt) && txt.length > 10, txt);
        check('error text hints at connection / download', /connect|download|internet|network|model/i.test(txt), txt);
      }
      await page.waitForFunction(() => !window.__vox.state.busy, null, { timeout: 30000, polling: 100 }).catch(() => {});
      const st = await page.evaluate(() => ({ busy: window.__vox.state.busy, prog: !document.querySelector('[data-testid=progress]').hidden, status: document.querySelector('#status-text').textContent }));
      check('app not stuck: busy false and progress panel hidden', !st.busy && !st.prog, JSON.stringify(st));
      const retry = page.locator('[data-testid=library-list] button:has-text("Retry")');
      check('library shows a failed file with Retry', (await retry.count()) === 1);
      block = false;
      const t1 = Date.now();
      await retry.first().click();
      let ok = true;
      await page.waitForFunction(() => window.__vox.state.sources[0] && window.__vox.state.sources[0].words.length > 100 && !window.__vox.state.busy, null, { timeout: 360000, polling: 200 }).catch(() => { ok = false; });
      const ms2 = Date.now() - t1;
      check('after unblocking, Retry succeeds (downloads model, transcribes)', ok, ok ? `${(ms2 / 1000).toFixed(1)} s` : JSON.stringify(await page.evaluate(() => ({ b: document.querySelector('[data-testid=error-banner]').innerText, s: document.querySelector('#status-text').textContent }))));
      if (ok) {
        const w = await sourceWords(page);
        const m = wordMatch(script('clean_script.txt'), w.map((x) => x.text).join(' '));
        check('retried transcript is accurate (>= 90%)', m.pct >= 90, `${pct(m.pct)}%`);
      }
      await page.close();
    } finally { await ctx.close(); await browser.close(); }
  },
};

const multifile = {
  name: 'multifile',
  async run({ getCtx }) {
    const ctx = await getCtx();
    const page = await openApp(ctx);
    const ms = await loadAndWait(page, [audio('clean.wav'), audio('hard.wav')], 2, 240000);
    info('two-file load (ms, cached transcripts allowed)', ms);
    check('both files transcribed', true);
    const names = await page.evaluate(() => window.__vox.state.sources.map((s) => s.name));
    check('library lists both files', (await page.locator('[data-testid=library-list] .lib-item').count()) === 2, names.join(','));
    await tid(page, 'search-input').fill('tonight');
    await page.waitForFunction(() => window.__vox.state.matches.length > 0, null, { timeout: 5000 });
    const bySrc = await page.evaluate(() => { const o = {}; for (const m of window.__vox.state.matches) { const n = window.__vox.state.sources.find((s) => s.id === m.sourceId).name; o[n] = (o[n] || 0) + 1; } return o; });
    check('search "tonight" finds matches across both files', Object.keys(bySrc).length === 2, JSON.stringify(bySrc));
    check('match-count mentions both speeches', /2 speeches/.test(await tid(page, 'match-count').innerText()), await tid(page, 'match-count').innerText());
    await tid(page, 'search-input').fill('');
    for (const name of ['clean.wav', 'hard.wav']) {
      await page.locator('[data-testid=library-list] .lib-item', { hasText: name }).locator('.lib-main').click();
      await page.waitForFunction((n) => { const s = window.__vox.state; return s.sources.find((x) => x.id === s.activeId).name === n; }, name);
      const w = await sourceWords(page, names.indexOf(name));
      const i = findSeq(w, [name === 'clean.wav' ? 'bridge' : 'senator']);
      const at = i >= 0 ? i : 10;
      await makeClip(page, at, at + 1);
    }
    const clips = await page.evaluate(() => window.__vox.state.clips.map((c) => ({ text: c.text, src: window.__vox.state.sources.find((s) => s.id === c.sourceId).name })));
    check('a clip made in each file remembers its source', new Set(clips.map((c) => c.src)).size === 2, JSON.stringify(clips));
    const cardSrc = await page.locator('.clip .clip-src').allInnerTexts();
    check('clip cards show their source file names', cardSrc.includes('clean.wav') && cardSrc.includes('hard.wav'), cardSrc.join(','));
    await tid(page, 'search-input').fill('tonight');
    await page.waitForFunction(() => window.__vox.state.matches.length > 0);
    await tid(page, 'add-matches-btn').click();
    await tid(page, 'search-input').fill('');
    const all = await page.evaluate(() => window.__vox.state.clips.map((c) => ({ text: c.text, src: window.__vox.state.sources.find((s) => s.id === c.sourceId).name })));
    const dl = await downloadVia(page, () => tid(page, 'export-zip-btn').click(), 'export_multi.zip');
    check('multi-source ZIP uses the generic name', dl.suggested === 'vox-slice-clips.zip', dl.suggested);
    const files = await unzip(dl.buf);
    const rows = parseCsv(files.get('manifest.csv').toString('utf8')).slice(1).filter((r) => r.length > 1);
    check('manifest has a row per clip', rows.length === all.length, `${rows.length}/${all.length}`);
    let bad = 0;
    rows.forEach((r, k) => { if (r[1] !== all[k].src || r[5] !== all[k].text) bad++; });
    check("manifest source_file column matches each clip's source (clean.wav and hard.wav)", bad === 0 && new Set(rows.map((r) => r[1])).size === 2, `${bad} wrong; sources ${[...new Set(rows.map((r) => r[1]))].join(',')}`);
    check('file names carry their source slug', rows.every((r) => r[0].includes('_' + r[1].replace(/\.wav$/, '') + '.')), rows.map((r) => r[0]).slice(0, 3).join(' '));
    await page.close();
  },
};

const cache = {
  name: 'cache',
  async run({ getCtx }) {
    const ctx = await getCtx();
    const page = await openApp(ctx);
    await loadAndWait(page, audio('clean.wav')); // ensures the transcript is cached
    const first = await sourceWords(page);
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(() => window.__vox && window.__vox.ready === true);
    const hf = [];
    const onReq = (r) => { if (/huggingface|hf\.co/.test(r.url())) hf.push(r.url().slice(0, 90)); };
    ctx.on('request', onReq);
    const t0 = Date.now();
    await chooseFiles(page, audio('clean.wav'));
    await waitLoaded(page, 1, 60000);
    const ms = Date.now() - t0;
    ctx.off('request', onReq);
    info('cached reload of clean.wav (ms)', ms);
    const second = await sourceWords(page);
    check('cached load is fast (< 3 s)', ms < 3000, `${ms} ms`);
    check('cached transcript identical to the first run', JSON.stringify(first) === JSON.stringify(second), `${first.length} vs ${second.length} words`);
    const chip = await page.locator('[data-testid=library-list] .chip').first().innerText();
    const st = await page.locator('#status-text').textContent();
    check('UI says it came from the cache', /cache/i.test(chip) || /cache/i.test(st), `${chip} / ${st}`);
    info('Hugging Face requests during a cached load', hf.length);
    check('cache hit makes no model/network requests', hf.length === 0, hf.join(' ; '));
    await page.close();
  },
};

export const tests = [cancel, badfile, toolong, modelfail, multifile, cache];
