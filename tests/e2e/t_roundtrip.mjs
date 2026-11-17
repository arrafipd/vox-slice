// Criterion 3: round trip. Export WAV clips, load them back as sources, re-transcribe, compare.
import {
  check, info, openApp, loadAndWait, audio, tid, sourceWords, unzip, downloadVia, wordMatch, pct, setPad, chooseFiles,
} from './lib.mjs';
import { resolveTargets, createClips } from './clipset.mjs';

const PADS = (process.env.PADS || '0,60,120,200').split(',').map(Number);

async function waitIdleWith(page, n, timeout = 300000) {
  await page.waitForFunction((n) => { const s = window.__vox.state; return s.sources.length === n && !s.busy; }, n, { timeout, polling: 150 });
}

export const tests = [{
  name: 'roundtrip',
  async run({ getCtx }) {
    const ctx = await getCtx();
    const summary = {};
    for (const pad of PADS) {
      console.log(` -- padding ${pad} ms`);
      const page = await openApp(ctx);
      await loadAndWait(page, audio('clean.wav'));
      const words = await sourceWords(page);
      await setPad(page, pad);
      const targets = resolveTargets(words);
      await createClips(page, targets);
      const clips = await page.evaluate(() => window.__vox.state.clips.map((c) => ({ text: c.text, start: c.start, end: c.end })));
      const dl = await downloadVia(page, () => tid(page, 'export-zip-btn').click(), `roundtrip_pad${pad}.zip`);
      const files = await unzip(dl.buf);
      const wavs = [...files.keys()].filter((n) => n.endsWith('.wav')).sort();
      check(`pad ${pad}: exported ${clips.length} WAV clips`, wavs.length === clips.length, `${wavs.length}`);
      await page.close();

      // re-transcribe in a fresh page
      const p2 = await openApp(ctx);
      const t0 = Date.now();
      await chooseFiles(p2, wavs.map((n) => ({ name: n, mimeType: 'audio/wav', buffer: files.get(n) })));
      await waitIdleWith(p2, wavs.length);
      const secs = (Date.now() - t0) / 1000;
      const got = await p2.evaluate(() => Object.fromEntries(window.__vox.state.sources.map((s) => [s.name, s.words.map((w) => w.text).join(' ')])));
      await p2.close();

      const rows = [];
      wavs.forEach((n) => {
        const k = +n.slice(0, 3) - 1; const t = targets[k]; const exp = clips[k].text;
        const g = got[n] ?? '';
        const m = wordMatch(exp, g);
        const dur = clips[k].end - clips[k].start;
        rows.push({ n: k + 1, kind: t.kind, label: t.label, expected: exp, got: g, pass: m.ref > 0 && m.match === m.ref, exact: m.ref === m.hyp && m.match === m.ref, dur: +dur.toFixed(3) });
      });
      const agg = (kind) => { const r = rows.filter((x) => x.kind === kind); return { n: r.length, pass: r.filter((x) => x.pass).length, exact: r.filter((x) => x.exact).length }; };
      const s = agg('single'); const ph = agg('phrase');
      summary[pad] = { single: s, phrase: ph, all: { n: rows.length, pass: s.pass + ph.pass, exact: s.exact + ph.exact }, secs: +secs.toFixed(1) };
      for (const r of rows) console.log(`    ${r.pass ? 'ok  ' : 'MISS'} #${String(r.n).padStart(2)} ${r.kind.padEnd(6)} dur ${r.dur.toFixed(2)}s  expected: "${r.expected}"  got: "${r.got}"`);
      info(`pad ${pad} ms`, `single ${s.pass}/${s.n} (${pct(100 * s.pass / s.n)}%), multi-word ${ph.pass}/${ph.n} (${pct(100 * ph.pass / ph.n)}%), exact-text ${s.exact + ph.exact}/${rows.length}, retranscribe ${secs.toFixed(0)} s`);
      info(`pad ${pad} detail`, rows);
      check(`pad ${pad}: every clip file was re-transcribed and loaded`, rows.length === clips.length && Object.keys(got).length === wavs.length);
      if (pad === 60) {
        check('default pad (60 ms): multi-word round trip pass rate >= 80%', ph.pass / ph.n >= 0.8, `${ph.pass}/${ph.n}`);
        check('default pad (60 ms): single-word round trip pass rate >= 70% (target set by QA)', s.pass / s.n >= 0.7, `${s.pass}/${s.n}`);
      }
    }
    info('padding summary', summary);
    const best = Object.entries(summary).sort((a, b) => (b[1].all.pass - a[1].all.pass) || (b[1].all.exact - a[1].all.exact))[0];
    info('best padding by pass count', `${best[0]} ms (${best[1].all.pass}/${best[1].all.n}, exact ${best[1].all.exact})`);
  },
}];
