// Criterion 5: the second-tier features. Project save / load / relink, Sentence Builder, rhyme finder, library remove.
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  check, info, openApp, loadAndWait, audio, tid, sourceWords, unzip, downloadVia, parseWav, parseMp3, parseCsv, findSeq,
  makeClip, chooseFiles, allowConsoleErrors, DL, normWords,
} from './lib.mjs';

const state = (page, fn) => page.evaluate(fn);
const statusText = (page) => page.locator('#status-text').textContent();

const project = {
  name: 'project',
  async run({ getCtx }) {
    allowConsoleErrors(); // the bad-project step logs nothing today, but a parse error is allowed to
    const ctx = await getCtx();
    const page = await openApp(ctx);
    await loadAndWait(page, audio('clean.wav'));
    const words = await sourceWords(page);
    const iBridge = Math.max(0, findSeq(words, ['bridge']));
    await makeClip(page, iBridge, iBridge);
    await makeClip(page, 3, 7);
    await makeClip(page, words.length - 4, words.length - 1);
    // a manual edge tweak must survive the round trip
    await page.locator('.clip').nth(1).locator('[data-act="start-"]').click();
    await page.locator('.clip').nth(1).locator('[data-act="end+"]').click({ modifiers: ['Shift'] });
    await tid(page, 'fmt-mp3').check();
    await tid(page, 'opt-normalize').check();
    await page.evaluate(() => { const el = document.querySelector('[data-testid="pad-input"]'); el.value = '120'; el.dispatchEvent(new Event('input', { bubbles: true })); });
    const before = await state(page, () => ({
      clips: window.__vox.state.clips.map((c) => ({ i0: c.i0, i1: c.i1, text: c.text, start: c.start, end: c.end })),
      settings: { ...window.__vox.state.settings },
      src: { name: window.__vox.state.sources[0].name, hash: window.__vox.state.sources[0].hash, duration: window.__vox.state.sources[0].duration, n: window.__vox.state.sources[0].words.length },
    }));
    const dl = await downloadVia(page, () => tid(page, 'save-project-btn').click(), 'project.voxslice.json');
    check('project file is named after the speech', dl.suggested === 'clean.voxslice.json', dl.suggested);
    const text = dl.buf.toString('utf8');
    let json = null;
    try { json = JSON.parse(text); } catch { /* checked below */ }
    check('project file is valid JSON with app + version', !!json && json.app === 'vox-slice' && json.version === 1, json ? `${json.app} v${json.version}` : 'not JSON');
    check('project file holds transcript and clips', !!json && json.sources.length === 1 && json.sources[0].words.length === before.src.n && json.clips.length === 3, json ? `${json.sources[0].words.length} words, ${json.clips.length} clips` : '');
    check('project file contains no audio (small, no buffer / peaks keys)', dl.buf.length < 200000 && !/"buffer"|"peaks"|"chans"/.test(text), `${(dl.buf.length / 1024).toFixed(1)} KB`);
    await page.close();

    // ---- load into a fresh page: no audio yet
    const p2 = await openApp(ctx);
    await tid(p2, 'load-project-input').setInputFiles(dl.file);
    await p2.waitForFunction(() => window.__vox.state.sources.length === 1 && window.__vox.state.clips.length === 3, null, { timeout: 10000 });
    const after = await state(p2, () => ({
      clips: window.__vox.state.clips.map((c) => ({ i0: c.i0, i1: c.i1, text: c.text, start: c.start, end: c.end })),
      settings: { ...window.__vox.state.settings },
      src: { name: window.__vox.state.sources[0].name, hash: window.__vox.state.sources[0].hash, duration: window.__vox.state.sources[0].duration, n: window.__vox.state.sources[0].words.length, buffer: !!window.__vox.state.sources[0].buffer },
      busy: window.__vox.state.busy,
    }));
    check('loaded project restores every clip exactly (indexes, text, tweaked edges)', JSON.stringify(after.clips) === JSON.stringify(before.clips), `${after.clips.length} clips`);
    check('loaded project restores the transcript', after.src.n === before.src.n && after.src.name === 'clean.wav' && after.src.hash === before.src.hash, `${after.src.n} words`);
    const sk = ['padMs', 'gapMs', 'wav', 'mp3', 'normalize', 'trim'];
    check('loaded project restores settings (padding, formats, options)', sk.every((k) => after.settings[k] === before.settings[k]), JSON.stringify(Object.fromEntries(sk.map((k) => [k, after.settings[k]]))));
    check('controls reflect the restored settings', (await tid(p2, 'pad-input').inputValue()) === '120' && (await tid(p2, 'fmt-mp3').isChecked()) && (await tid(p2, 'opt-normalize').isChecked()) && !(await tid(p2, 'opt-trim').isChecked()));
    check('transcript renders from the project without audio', (await p2.locator('.transcript .w').count()) === before.src.n);
    check('source is flagged "audio missing" and the app is idle', !after.src.buffer && !after.busy && /audio missing/i.test(await p2.locator('[data-testid=library-list] .chip').first().innerText()));
    const cards = p2.locator('.clip');
    check('clip cards show as unlinked with play / download disabled', (await cards.count()) === 3 && (await p2.locator('.clip.unlinked').count()) === 3 && await cards.first().locator('[data-act="wav"]').isDisabled());
    check('status asks for the original audio', /relink|original/i.test(await statusText(p2)), await statusText(p2));
    check('export hint explains the clips will be skipped', /skipped|relink/i.test(await p2.locator('#export-hint').innerText()), await p2.locator('#export-hint').innerText());

    // ---- relink by dropping the original file
    const t0 = Date.now();
    await chooseFiles(p2, audio('clean.wav'));
    await p2.waitForFunction(() => { const s = window.__vox.state; return s.sources.length === 1 && !!s.sources[0].buffer && !s.busy; }, null, { timeout: 60000, polling: 100 });
    info('relink time (ms)', Date.now() - t0);
    const relinked = await state(p2, () => ({ n: window.__vox.state.sources.length, clips: window.__vox.state.clips.map((c) => ({ i0: c.i0, i1: c.i1, text: c.text, start: c.start, end: c.end })), words: window.__vox.state.sources[0].words.length }));
    check('dropping the original relinks instead of adding a duplicate', relinked.n === 1 && relinked.words === before.src.n, `${relinked.n} source`);
    check('clips untouched by relinking', JSON.stringify(relinked.clips) === JSON.stringify(before.clips));
    check('clip cards are playable again after relink', (await p2.locator('.clip.unlinked').count()) === 0 && !(await cards.first().locator('[data-act="wav"]').isDisabled()));
    check('status confirms the relink', /relink/i.test(await statusText(p2)), await statusText(p2));
    const zip = await downloadVia(p2, () => tid(p2, 'export-zip-btn').click(), 'project_relinked.zip');
    const files = await unzip(zip.buf);
    const wavs = [...files.keys()].filter((n) => n.endsWith('.wav')).sort();
    let durBad = 0;
    wavs.forEach((n, k) => { const w = parseWav(files.get(n)); if (!w.ok || Math.abs(w.duration - (before.clips[k].end - before.clips[k].start)) > 0.015) durBad++; });
    check('export after relink produces the saved clips (WAV + MP3, right lengths)', wavs.length === 3 && durBad === 0 && [...files.keys()].filter((n) => n.endsWith('.mp3')).length === 3, `${wavs.length} wav, ${durBad} wrong length`);

    // ---- loading the same project twice must not duplicate the speech
    await tid(p2, 'load-project-input').setInputFiles(dl.file);
    await p2.waitForFunction(() => /Project loaded/.test(document.querySelector('#status-text').textContent), null, { timeout: 10000 });
    check('loading the same project again does not duplicate the speech', (await state(p2, () => window.__vox.state.sources.length)) === 1);
    await p2.close();

    // ---- rubbish project files
    const p3 = await openApp(ctx);
    const bad1 = path.join(DL, 'bad_notjson.json'); writeFileSync(bad1, 'this is not json {');
    const bad2 = path.join(DL, 'bad_otherapp.json'); writeFileSync(bad2, JSON.stringify({ app: 'something-else', version: 1, sources: [] }));
    for (const [f, label] of [[bad1, 'non-JSON file'], [bad2, 'JSON from another app']]) {
      await tid(p3, 'load-project-input').setInputFiles(f);
      await p3.waitForFunction(() => !document.querySelector('[data-testid=error-banner]').hidden, null, { timeout: 5000 }).catch(() => {});
      const txt = (await tid(p3, 'error-banner').innerText()).replace(/\s+/g, ' ').trim();
      check(`${label}: friendly error, nothing loaded`, (await tid(p3, 'error-banner').isVisible()) && !/Error:|undefined|SyntaxError|Unexpected token|\bat [\w.]+ \(/.test(txt) && (await state(p3, () => window.__vox.state.sources.length)) === 0, txt);
      await p3.locator('.err-close').click();
    }
    await p3.close();
  },
};

const builder = {
  name: 'builder',
  async run({ getCtx }) {
    const ctx = await getCtx();
    const page = await openApp(ctx);
    await loadAndWait(page, [audio('clean.wav'), audio('hard.wav')], 2, 240000);
    const words = await sourceWords(page, 0);
    const toks = words.map((w) => normWords(w.text).join(''));
    // a word that occurs several times, for the take picker
    const counts = new Map(); toks.forEach((t) => counts.set(t, (counts.get(t) || 0) + 1));
    const multi = ['our', 'the', 'we', 'and', 'to'].find((t) => (counts.get(t) || 0) >= 2) || toks.find((t) => counts.get(t) >= 2);
    const iPhrase = findSeq(words, ['thank', 'you', 'very', 'much']);
    const phrase = iPhrase >= 0 ? 'thank you very much' : toks.slice(10, 14).join(' ');
    const lines = [`${phrase}`, `${multi} zyzzyva bridge quokkas`, 'xylophonic', `Bridge, ${multi}!`];

    await tid(page, 'tab-builder').click();
    check('Builder tab shows the builder view and hides Slice', (await page.locator('#view-builder').isVisible()) && !(await page.locator('#view-slice').isVisible()));
    check('builder buttons disabled before anything is built', (await tid(page, 'builder-export-btn').isDisabled()) && (await tid(page, 'builder-preview-btn').isDisabled()));
    await tid(page, 'builder-run-btn').click();
    check('Build with an empty box asks for lines', /type or paste/i.test(await statusText(page)), await statusText(page));

    await tid(page, 'builder-input').fill(lines.join('\n') + '\n\n   \n');
    await tid(page, 'builder-run-btn').click();
    const rows = page.locator('[data-testid=builder-lines] .bline');
    check('one row per non-empty line', (await rows.count()) === 4, `${await rows.count()}`);
    const l0 = rows.nth(0);
    check('a phrase found whole becomes one chip (longest-phrase match)', (await l0.locator('.bchip').count()) === 1 && (await l0.locator('.bchip.found .bchip-text').innerText()).toLowerCase() === phrase, await l0.locator('.bchip-text').allInnerTexts().then((a) => a.join(' | ')));
    const l1 = rows.nth(1);
    const l1chips = await l1.locator('.bchip').evaluateAll((els) => els.map((e) => [e.classList.contains('missing') ? 'missing' : 'found', e.querySelector('.bchip-text').textContent]));
    check('missing words are flagged per slot, found words kept', JSON.stringify(l1chips.map((c) => c[0])) === JSON.stringify(['found', 'missing', 'found', 'missing']), JSON.stringify(l1chips));
    check('line counter shows found / total', (await l1.locator('.bcount').innerText()) === '2/4', await l1.locator('.bcount').innerText());
    const l2 = rows.nth(2);
    check('an all-missing line has its actions disabled', (await l2.locator('[data-act="preview"]').isDisabled()) && (await l2.locator('[data-act="wav"]').isDisabled()));
    check('punctuation and capitals do not stop a match', (await rows.nth(3).locator('.bchip.found').count()) === 2 && (await rows.nth(3).locator('.bchip.missing').count()) === 0);
    const miss = await page.locator('[data-testid=builder-missing] .missing-list li').allInnerTexts();
    check('missing list is unique and in first-seen order', JSON.stringify(miss) === JSON.stringify(['zyzzyva', 'quokkas', 'xylophonic']), miss.join(','));
    check('missing box headline counts the words', /3 words/i.test(await page.locator('[data-testid=builder-missing] h3').innerText()), await page.locator('[data-testid=builder-missing] h3').innerText());
    check('status summarises the build', /Built 4 lines/.test(await statusText(page)), await statusText(page));

    // ---- take picker
    const chip = () => l1.locator('.bchip.found').first();
    const lab0 = await chip().locator('.bchip-pick .num').innerText();
    const n = +lab0.match(/of (\d+)/)[1];
    check(`"${multi}" offers every take in the library`, n === await page.evaluate((t) => { let k = 0; for (const s of window.__vox.state.sources) for (const w of s.words) if (w.text.toLowerCase().replace(/[^a-z0-9']/g, '') === t) k++; return k; }, multi) && n >= 2, lab0);
    const sub0 = await chip().locator('.bchip-sub').innerText();
    await chip().locator('button[aria-label="Next take"]').click();
    const lab1 = await chip().locator('.bchip-pick .num').innerText();
    const sub1 = await chip().locator('.bchip-sub').innerText();
    check('Next take moves to take 2 and shows where it comes from', /take 2 of/.test(lab1) && sub1 !== sub0, `${lab1}: ${sub0} -> ${sub1}`);
    await chip().locator('button[aria-label="Previous take"]').click();
    await chip().locator('button[aria-label="Previous take"]').click();
    check('Previous take wraps around to the last take', new RegExp(`take ${n} of ${n}`).test(await chip().locator('.bchip-pick .num').innerText()), await chip().locator('.bchip-pick .num').innerText());
    await chip().locator('button[aria-label="Next take"]').click(); // back to take 1
    await chip().locator('button[aria-label="Next take"]').click(); // take 2, used for the export below
    const take2 = await page.evaluate((t) => { for (const s of window.__vox.state.sources) { let k = 0; for (const w of s.words) if (w.text.toLowerCase().replace(/[^a-z0-9']/g, '') === t && ++k === 2) return { start: w.start, end: w.end }; } return null; }, multi);

    // ---- preview
    await l0.locator('[data-act="preview"]').click();
    check('Preview plays the stitched line (button turns into Stop)', (await l0.locator('[data-act="preview"] span').innerText()) === 'Stop' && /Stop preview/.test(await tid(page, 'builder-preview-btn').innerText()));
    await l0.locator('[data-act="preview"]').click();
    check('clicking again stops the preview', (await l0.locator('[data-act="preview"] span').innerText()) === 'Preview');
    await l0.locator('[data-act="preview"]').click();
    await page.waitForFunction(() => document.querySelector('[data-testid=builder-preview-btn] span').textContent === 'Preview line', null, { timeout: 15000 }).catch(() => {});
    check('preview ends on its own and the buttons reset', (await l0.locator('[data-act="preview"] span').innerText()) === 'Preview');

    // ---- single line export: length = takes + gaps
    const pad = 0.06; const gap = 0.06;
    const bridge = words[findSeq(words, ['bridge'])];
    const expect1 = (take2.end - take2.start + 2 * pad) + gap + (bridge.end - bridge.start + 2 * pad);
    const one = await downloadVia(page, () => l1.locator('[data-act="wav"]').click(), 'line2.wav');
    const w1 = parseWav(one.buf);
    check('per-line WAV named line_NN_slug.wav', /^line_02_[a-z0-9-]+\.wav$/.test(one.suggested), one.suggested);
    check('per-line WAV = chosen takes + gap, missing words skipped', w1.ok && w1.sizeMatches && Math.abs(w1.duration - expect1) < 0.03, `${w1.duration?.toFixed(3)} s vs expected ${expect1.toFixed(3)} s`);
    const oneMp3 = await downloadVia(page, () => l1.locator('[data-act="mp3"]').click(), 'line2.mp3');
    const m1 = parseMp3(oneMp3.buf);
    check('per-line MP3 is a valid stream of the same length', m1.ok && Math.abs(m1.duration - expect1) < 0.09, `${m1.duration?.toFixed(3)} s`);

    // ---- gap setting changes the length
    await page.evaluate(() => { const g = document.getElementById('gap-input'); g.value = '300'; g.dispatchEvent(new Event('input', { bubbles: true })); });
    const wide = parseWav((await downloadVia(page, () => l1.locator('[data-act="wav"]').click(), 'line2_gap300.wav')).buf);
    check('gap slider changes the stitched length by the right amount', Math.abs((wide.duration - w1.duration) - 0.24) < 0.01, `${((wide.duration - w1.duration) * 1000).toFixed(0)} ms longer`);
    await page.evaluate(() => { const g = document.getElementById('gap-input'); g.value = '60'; g.dispatchEvent(new Event('input', { bubbles: true })); });

    // ---- export all lines
    await page.locator('#builder-format').selectOption('both');
    const zip = await downloadVia(page, () => tid(page, 'builder-export-btn').click(), 'lines.zip');
    check('lines ZIP is named vox-slice-lines.zip', zip.suggested === 'vox-slice-lines.zip', zip.suggested);
    const files = await unzip(zip.buf);
    const names = [...files.keys()].sort();
    check('ZIP holds WAV + MP3 for each line that has audio, plus manifest.csv', names.length === 7 && names.filter((x) => x.endsWith('.wav')).length === 3 && !names.some((x) => x.startsWith('line_03')), names.join(' '));
    const csv = parseCsv(files.get('manifest.csv').toString('utf8'));
    const data = csv.slice(1).filter((r) => r.length > 1);
    let rowBad = 0;
    for (const r of data) {
      const buf = files.get(r[0]); if (!buf) { rowBad++; continue; }
      const d = r[0].endsWith('.wav') ? parseWav(buf).duration : parseMp3(buf).duration;
      if (Math.abs(d - +r[4]) > 0.09 || r[2] !== '0.000' || Math.abs(+r[3] - +r[4]) > 0.0015 || !r[1].includes('clean.wav')) rowBad++;
    }
    check('lines manifest: header, one row per file, durations match the audio', csv[0].join(',') === 'filename,source_file,start,end,duration,text' && data.length === 6 && rowBad === 0, `${data.length} rows, ${rowBad} bad`);
    check('lines manifest keeps the lyric text, including commas and capitals', data.some((r) => r[5] === lines[3]), data.map((r) => r[5]).join(' / '));
    check('builder left the app idle', !(await state(page, () => window.__vox.state.busy)));

    // ---- send to clips rack
    const c0 = await state(page, () => window.__vox.state.clips.length);
    await l1.locator('[data-act="toclips"]').click();
    const sent = await state(page, () => window.__vox.state.clips.map((c) => ({ text: c.text, start: c.start })));
    check('"To clips" sends the chosen takes (not the missing words) to the rack', sent.length === c0 + 2 && Math.abs(sent[sent.length - 2].start - Math.max(0, take2.start - pad)) < 0.002, JSON.stringify(sent.slice(c0)));
    await tid(page, 'tab-slice').click();
    check('the rack on the Slice tab shows them', (await page.locator('.clip').count()) === c0 + 2);

    // ---- Ctrl+Enter builds, all-found celebration
    await tid(page, 'tab-builder').click();
    await tid(page, 'builder-input').fill('bridge');
    await tid(page, 'builder-input').press('Control+Enter');
    check('Ctrl+Enter in the box builds', (await rows.count()) === 1);
    check('nothing-missing state is celebrated, not left blank', /nothing missing/i.test(await tid(page, 'builder-missing').innerText()), await tid(page, 'builder-missing').innerText());
    await page.close();
  },
};

const rhyme = {
  name: 'rhyme',
  async run({ getCtx }) {
    const ctx = await getCtx();
    const page = await openApp(ctx);
    check('empty rhyme box shows a hint', /type a word/i.test(await tid(page, 'rhyme-results').innerText()));
    await loadAndWait(page, audio('clean.wav'));
    const lib = await page.evaluate(() => [...new Set(window.__vox.state.sources[0].words.map((w) => w.text.toLowerCase().replace(/[^a-z']/g, '')).filter(Boolean))]);
    // pick probe words whose obvious rhymes are in the speech
    const pairs = [['head', 'bread'], ['down', 'town'], ['boat', 'vote'], ['song', 'strong'], ['giver', 'river'], ['cool', 'school'], ['day', 'today'], ['borrow', 'tomorrow'], ['ridge', 'bridge']];
    const usable = pairs.filter(([, hit]) => lib.includes(hit));
    info('rhyme probes available in clean.wav', usable.map((p) => p.join('->')).join(', '));
    check('test speech contains rhyme targets to probe', usable.length >= 2, `${usable.length}`);
    let found = 0; const detail = [];
    for (const [probe, hit] of usable.slice(0, 5)) {
      await tid(page, 'rhyme-input').fill(probe);
      await page.waitForFunction((p) => { const r = document.querySelector('[data-testid=rhyme-results]'); return r.querySelector('.rchip') || (r.textContent && !/Type a word/.test(r.textContent)); }, probe, { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(350);
      const chips = await page.locator('[data-testid=rhyme-results] .rchip span').allInnerTexts();
      detail.push(`${probe}: ${chips.slice(0, 6).join(' ')}`);
      if (chips.includes(hit)) found++;
    }
    info('rhyme results', detail);
    check('rhyme finder returns the expected rhymes from the library', found === Math.min(5, usable.length), `${found}/${Math.min(5, usable.length)}: ${detail.join(' | ')}`);
    const only = await page.locator('[data-testid=rhyme-results] .rchip span').allInnerTexts();
    check('every rhyme offered is a word that is really in the library', only.every((w) => lib.includes(w)), only.filter((w) => !lib.includes(w)).join(','));
    const cnt = await page.locator('[data-testid=rhyme-results] .rchip b').first().innerText();
    check('rhyme chips show how many takes exist', /^×\d+$/.test(cnt), cnt);

    // clicking a chip on Slice searches for it
    const first = await page.locator('[data-testid=rhyme-results] .rchip span').first().innerText();
    await page.locator('[data-testid=rhyme-results] .rchip').first().click();
    await page.waitForFunction(() => window.__vox.state.matches.length > 0, null, { timeout: 5000 }).catch(() => {});
    check('clicking a rhyme on Slice searches the transcript for it', (await tid(page, 'search-input').inputValue()) === first && (await state(page, () => window.__vox.state.matches.length)) > 0, first);
    await tid(page, 'search-input').fill('');

    await tid(page, 'rhyme-input').fill('qzxv');
    await page.waitForFunction(() => /not in the rhyme dictionary/.test(document.querySelector('[data-testid=rhyme-results]').textContent), null, { timeout: 5000 }).catch(() => {});
    check('unknown word gets a plain explanation', /not in the rhyme dictionary/.test(await tid(page, 'rhyme-results').innerText()), await tid(page, 'rhyme-results').innerText());

    // "Find rhymes" from a selected word
    const words = await sourceWords(page);
    const iTown = findSeq(words, [usable[0][1]]);
    await page.locator(`.transcript .w[data-i="${iTown}"]`).click();
    check('Find rhymes enabled for a single selected word', !(await page.locator('#find-rhymes-btn').isDisabled()));
    await page.locator('#find-rhymes-btn').click();
    check('Find rhymes fills the rhyme box with the selected word', (await tid(page, 'rhyme-input').inputValue()) === usable[0][1], await tid(page, 'rhyme-input').inputValue());
    await page.locator(`.transcript .w[data-i="${iTown + 1}"]`).click({ modifiers: ['Shift'] });
    check('Find rhymes disabled for a multi-word selection', await page.locator('#find-rhymes-btn').isDisabled());

    // on the Builder tab the panel moves across and chips insert into the lyric box
    await tid(page, 'tab-builder').click();
    check('rhyme panel follows you to the Builder tab', await page.locator('#view-builder #rhyme-panel').isVisible());
    await tid(page, 'builder-input').fill('we cross the');
    await tid(page, 'rhyme-input').fill(usable[0][0]);
    await page.waitForFunction(() => !!document.querySelector('[data-testid=rhyme-results] .rchip'), null, { timeout: 5000 });
    await page.waitForTimeout(300);
    const pick = await page.locator('[data-testid=rhyme-results] .rchip span').first().innerText();
    await page.locator('[data-testid=rhyme-results] .rchip').first().click();
    const val = await tid(page, 'builder-input').inputValue();
    check('clicking a rhyme on Builder adds it to the lyric', val === `we cross the ${pick}`, JSON.stringify(val));
    await page.close();
  },
};

const library = {
  name: 'library',
  async run({ getCtx }) {
    const ctx = await getCtx();
    const page = await openApp(ctx);
    await loadAndWait(page, [audio('clean.wav'), audio('hard.wav')], 2, 240000);
    const w0 = await sourceWords(page, 0);
    await makeClip(page, 2, 4);
    await makeClip(page, 10, 10);
    await page.locator('[data-testid=library-list] .lib-item', { hasText: 'hard.wav' }).locator('.lib-main').click();
    await page.waitForFunction(() => { const s = window.__vox.state; return s.sources.find((x) => x.id === s.activeId).name === 'hard.wav'; });
    await makeClip(page, 1, 2);
    check('library count pill shows 2', (await page.locator('#library-count').innerText()) === '2');
    check('switching speech swaps the transcript', (await page.locator('.transcript .w').count()) === (await state(page, () => window.__vox.state.sources[1].words.length)));

    // same file again: no duplicate
    await chooseFiles(page, audio('clean.wav'));
    await page.waitForFunction(() => /already loaded/.test(document.querySelector('#status-text').textContent), null, { timeout: 30000 }).catch(() => {});
    await page.waitForFunction(() => !window.__vox.state.busy, null, { timeout: 30000 });
    const st = await state(page, () => ({ n: window.__vox.state.sources.length, active: window.__vox.state.sources.find((x) => x.id === window.__vox.state.activeId).name }));
    check('dropping a file that is already loaded switches to it instead of duplicating', st.n === 2 && st.active === 'clean.wav', `${st.n} sources, active ${st.active}; ${await statusText(page)}`);

    // remove the speech that owns two clips
    await page.locator('[data-testid=library-list] .lib-item', { hasText: 'clean.wav' }).locator('button[aria-label="Remove clean.wav"]').click();
    const after = await state(page, () => ({ n: window.__vox.state.sources.length, clips: window.__vox.state.clips.length, active: window.__vox.state.sources.find((x) => x.id === window.__vox.state.activeId)?.name, sel: window.__vox.state.sel, selClip: window.__vox.state.selClipId }));
    check('removing a speech removes it and its clips, and activates the other one', after.n === 1 && after.clips === 1 && after.active === 'hard.wav', JSON.stringify(after));
    check('rack and counters follow', (await page.locator('.clip').count()) === 1 && (await page.locator('[data-clip-count]').first().innerText()) === '1' && (await page.locator('#library-count').innerText()) === '1');
    check('status says what was removed', /Removed clean\.wav and its 2 clips/.test(await statusText(page)), await statusText(page));
    check('transcript now shows the remaining speech', (await page.locator('.transcript .w').first().getAttribute('data-source')) === (await state(page, () => window.__vox.state.sources[0].id)));

    // remove the last one: back to the empty state
    await page.locator('[data-testid=library-list] button[aria-label="Remove hard.wav"]').click();
    const empty = await state(page, () => ({ n: window.__vox.state.sources.length, clips: window.__vox.state.clips.length, active: window.__vox.state.activeId, has: document.body.classList.contains('has-sources') }));
    check('removing the last speech returns to the empty start screen', empty.n === 0 && empty.clips === 0 && empty.active === null && !empty.has && await page.locator('#library').isHidden(), JSON.stringify(empty));
    check('export disabled again with nothing loaded', await tid(page, 'export-zip-btn').isDisabled());

    // and it can start over (from the transcript cache)
    await loadAndWait(page, audio('clean.wav'));
    check('a speech loads again after the library was emptied', (await page.locator('.transcript .w').count()) === w0.length);

    // Clear all is two-step
    await makeClip(page, 2, 4);
    await makeClip(page, 6, 6);
    const clr = page.locator('#clear-clips-btn');
    await clr.click();
    check('Clear all asks "Sure?" first and keeps the clips', (await clr.innerText()).trim() === 'Sure?' && (await state(page, () => window.__vox.state.clips.length)) === 2);
    await clr.click();
    check('second click clears the rack', (await state(page, () => window.__vox.state.clips.length)) === 0 && (await page.locator('#clips-empty').isVisible()) && await clr.isDisabled());
    await makeClip(page, 6, 6);
    await clr.click();
    await page.waitForTimeout(3000);
    check('an unconfirmed Clear all disarms itself', (await clr.innerText()).trim() === 'Clear all' && (await state(page, () => window.__vox.state.clips.length)) === 1);
    await page.close();
  },
};

export const tests = [project, builder, rhyme, library];
