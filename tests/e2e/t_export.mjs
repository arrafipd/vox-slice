// Criterion 2: select, clip, export (ZIP, per-clip downloads, normalize + trim).
import {
  check, info, openApp, loadAndWait, audio, tid, sourceWords, unzip, downloadVia, parseWav, parseMp3, wavPeak, parseCsv,
  wordSpan,
} from './lib.mjs';
import { resolveTargets, createClips } from './clipset.mjs';

const NAME_RE = /^(\d{3})_([a-z0-9-]*)_([a-z0-9-]+)\.(wav|mp3)$/;

export const tests = [{
  name: 'export',
  async run({ getCtx }) {
    const ctx = await getCtx();
    const page = await openApp(ctx);
    await loadAndWait(page, audio('clean.wav'));
    const words = await sourceWords(page);
    const dur = await page.evaluate(() => window.__vox.state.sources[0].duration);

    check('pad-input defaults to 60 ms', (await tid(page, 'pad-input').inputValue()) === '60');
    check('export button disabled with no clips', await tid(page, 'export-zip-btn').isDisabled());

    // ---- build clips through the UI
    const targets = resolveTargets(words);
    await createClips(page, targets);
    let clips = await page.evaluate(() => window.__vox.state.clips.map((c) => ({ ...c })));
    check('clips created from word selections', clips.length === targets.length, `${clips.length}/${targets.length}`);
    check('includes single short word, first word, last word and a 5+ word phrase',
      targets.some((t) => t.label === 'first word of file') && targets.some((t) => t.label === 'last word of file')
      && targets.some((t) => t.j - t.i + 1 >= 5) && targets.some((t) => t.kind === 'single' && t.label.length <= 4), targets.map((t) => t.label).join(' / '));
    let padBad = 0;
    clips.forEach((c, k) => {
      const t = targets[k];
      const es = Math.max(0, words[t.i].start - 0.06); const ee = Math.min(dur, words[t.j].end + 0.06);
      if (Math.abs(c.start - es) > 0.002 || Math.abs(c.end - ee) > 0.002) padBad++;
    });
    check('clip start/end = word edges +/- 60 ms padding (clamped to file)', padBad === 0, `${padBad} wrong`);
    check('first-word clip starts at/before the first word and not before 0', clips[0].start >= 0 && clips[0].start <= words[0].start, `${clips[0].start} vs word ${words[0].start}`);
    check('last-word clip ends at or before duration', clips[1].end <= dur + 1e-6, `${clips[1].end} vs ${dur}`);

    // mouse-drag selection
    await wordSpan(page, 40).scrollIntoViewIfNeeded();
    const a = await wordSpan(page, 40).boundingBox(); const b = await wordSpan(page, 43).boundingBox();
    await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 6 });
    await page.mouse.up();
    const sel = await page.evaluate(() => window.__vox.state.sel && { a: window.__vox.state.sel.a, b: window.__vox.state.sel.b });
    check('mouse drag across words selects the range', sel && sel.a === 40 && sel.b === 43, JSON.stringify(sel));
    await page.keyboard.press('Enter');

    // search + add all matches
    const before = await page.evaluate(() => window.__vox.state.clips.length);
    await tid(page, 'search-input').fill('our');
    await page.waitForFunction(() => window.__vox.state.matches.length > 0, null, { timeout: 5000 });
    const nMatch = await page.evaluate(() => window.__vox.state.matches.length);
    const expectOur = words.filter((w) => w.text.toLowerCase().replace(/[^a-z']/g, '') === 'our').length;
    check('search "our" finds every occurrence', nMatch === expectOur, `${nMatch} vs ${expectOur} in transcript`);
    const mc = await tid(page, 'match-count').innerText();
    check('match-count label shows the number', mc.includes(String(nMatch)), mc);
    await tid(page, 'add-matches-btn').click();
    await page.waitForFunction((n) => window.__vox.state.clips.length === n, before + nMatch, { timeout: 5000 }).catch(() => {});
    clips = await page.evaluate(() => window.__vox.state.clips.map((c) => ({ ...c })));
    check('add-matches-btn adds one clip per match', clips.length === before + nMatch, `${clips.length - before} added for ${nMatch} matches`);
    check('>= 8 clips total', clips.length >= 8, String(clips.length));
    await tid(page, 'search-input').fill('');

    // ---- ZIP export, WAV + MP3
    await tid(page, 'fmt-mp3').check();
    check('wav + mp3 ticked', (await tid(page, 'fmt-wav').isChecked()) && (await tid(page, 'fmt-mp3').isChecked()));
    const t0 = Date.now();
    const dl = await downloadVia(page, () => tid(page, 'export-zip-btn').click(), 'export_plain.zip');
    info('zip export time (ms)', Date.now() - t0);
    info('zip name', dl.suggested);
    const files = await unzip(dl.buf);
    const names = [...files.keys()];
    check('zip has clips x 2 + manifest.csv files', names.length === clips.length * 2 + 1, `${names.length} vs ${clips.length * 2 + 1}`);
    check('names unique', new Set(names).size === names.length);
    const bad = names.filter((n) => n !== 'manifest.csv' && !NAME_RE.test(n));
    check('names follow NNN_text-slug_source-slug.ext', bad.length === 0, bad.slice(0, 3).join(', '));
    check('source slug derived from clean.wav', names.filter((n) => n !== 'manifest.csv').every((n) => /_clean\.(wav|mp3)$/.test(n)), names[0]);

    const csv = parseCsv(files.get('manifest.csv').toString('utf8'));
    check('manifest header exact', csv[0].join(',') === 'filename,source_file,start,end,duration,text', csv[0].join(','));
    const dataRows = csv.slice(1).filter((r) => r.length > 1 || r[0]);
    check('manifest one row per file', dataRows.length === clips.length * 2, `${dataRows.length}`);
    const rowBy = new Map(dataRows.map((r) => [r[0], r]));
    let rowBad = 0; let wavBad = 0; let mp3Bad = 0; let hdrBad = 0; const wavErr = []; const mp3Err = [];
    for (let k = 0; k < clips.length; k++) {
      const c = clips[k]; const idx = String(k + 1).padStart(3, '0');
      for (const ext of ['wav', 'mp3']) {
        const fn = names.find((n) => n.startsWith(idx + '_') && n.endsWith('.' + ext));
        if (!fn) { rowBad++; continue; }
        const r = rowBy.get(fn);
        if (!r || r[1] !== 'clean.wav' || Math.abs(+r[2] - c.start) > 0.002 || Math.abs(+r[3] - c.end) > 0.002
          || Math.abs(+r[4] - (c.end - c.start)) > 0.002 || r[5] !== c.text) rowBad++;
        const buf = files.get(fn);
        if (ext === 'wav') {
          const w = parseWav(buf);
          if (!w.ok || !w.sizeMatches) hdrBad++;
          else { const e = Math.abs(w.duration - (c.end - c.start)); wavErr.push(e); if (e > 0.015) wavBad++; }
        } else {
          const m = parseMp3(buf);
          if (!m.ok) hdrBad++;
          else { const e = Math.abs(m.duration - (c.end - c.start)); mp3Err.push(e); if (e > 0.08) mp3Bad++; }
        }
      }
    }
    check('manifest rows match clips (file, source, start, end, duration, text)', rowBad === 0, `${rowBad} mismatching`);
    check('every WAV has valid RIFF/WAVE 16-bit header with matching data size; every MP3 has valid frames', hdrBad === 0, `${hdrBad} bad`);
    check('every WAV duration within 15 ms of end-start', wavBad === 0, `${wavBad} off; max err ${(Math.max(...wavErr) * 1000).toFixed(2)} ms`);
    check('every MP3 duration (frame count) within 80 ms of clip', mp3Bad === 0 && mp3Err.length === clips.length, `${mp3Bad} off; max err ${(Math.max(...mp3Err) * 1000).toFixed(1)} ms`);

    // decode the MP3s in the browser too
    const mp3Names = names.filter((n) => n.endsWith('.mp3'));
    const decoded = await page.evaluate(async (list) => {
      const ac = new AudioContext(); const out = [];
      for (const [n, b64] of list) {
        try { const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)); const ab = await ac.decodeAudioData(bin.buffer); out.push([n, ab.duration]); } catch (e) { out.push([n, -1]); }
      }
      return out;
    }, mp3Names.map((n) => [n, files.get(n).toString('base64')]));
    const decFail = decoded.filter(([, d]) => d < 0);
    const decOff = decoded.filter(([n, d]) => { const c = clips[+n.slice(0, 3) - 1]; return d >= 0 && Math.abs(d - (c.end - c.start)) > 0.08; });
    check('every MP3 decodes in the browser', decFail.length === 0, `${decFail.length} failed`);
    check('browser-decoded MP3 durations within 80 ms', decOff.length === 0, decOff.slice(0, 3).map(([n, d]) => `${n}:${d.toFixed(3)}`).join(' '));

    const plainWavLens = new Map(names.filter((n) => n.endsWith('.wav')).map((n) => [n, parseWav(files.get(n)).frames]));

    // ---- single downloads
    const card = page.locator('.clip').nth(5);
    const sw = await downloadVia(page, () => card.locator('[data-act="wav"]').click(), 'single.wav');
    check('per-clip WAV download is named like the zip entry', NAME_RE.test(sw.suggested) && sw.suggested.startsWith('006_'), sw.suggested);
    const swp = parseWav(sw.buf);
    check('per-clip WAV valid and right length', swp.ok && swp.sizeMatches && Math.abs(swp.duration - (clips[5].end - clips[5].start)) <= 0.015, `${swp.duration}`);
    const sm = await downloadVia(page, () => card.locator('[data-act="mp3"]').click(), 'single.mp3');
    const smp = parseMp3(sm.buf);
    check('per-clip MP3 valid and right length', smp.ok && Math.abs(smp.duration - (clips[5].end - clips[5].start)) <= 0.08, `${smp.duration}`);
    check('per-clip WAV identical to the zip copy', Buffer.compare(sw.buf, files.get(names.find((n) => n.startsWith('006_') && n.endsWith('.wav')))) === 0);

    // ---- normalize + trim export
    await tid(page, 'opt-normalize').check();
    await tid(page, 'opt-trim').check();
    const dl2 = await downloadVia(page, () => tid(page, 'export-zip-btn').click(), 'export_norm_trim.zip');
    const files2 = await unzip(dl2.buf);
    const names2 = [...files2.keys()];
    check('norm+trim export: same file count and names', names2.length === names.length && names2.every((n) => files.has(n)));
    let peakBad = 0; let longer = 0; let empty = 0; const peaks = []; let shorter = 0;
    for (const n of names2.filter((x) => x.endsWith('.wav'))) {
      const buf = files2.get(n); const w = parseWav(buf);
      if (!w.ok) { empty++; continue; }
      const pk = wavPeak(buf, w); const db = 20 * Math.log10(pk || 1e-9); peaks.push(db);
      if (Math.abs(db + 1) > 0.35) peakBad++;
      if (w.frames > plainWavLens.get(n) + 1) longer++;
      if (w.frames < plainWavLens.get(n)) shorter++;
      if (w.frames < 100) empty++;
    }
    check('normalized WAV peaks are near -1 dBFS (within 0.35 dB)', peakBad === 0, `${peakBad} off; range ${Math.min(...peaks).toFixed(2)}..${Math.max(...peaks).toFixed(2)} dBFS`);
    check('trimmed WAVs never longer than untrimmed', longer === 0, `${longer} longer`);
    check('trimmed WAVs not empty', empty === 0, `${empty} empty`);
    info('clips shortened by trim', `${shorter}/${peaks.length}`);
    const csv2 = parseCsv(files2.get('manifest.csv').toString('utf8'));
    check('norm+trim manifest still has header + rows', csv2[0].join(',') === 'filename,source_file,start,end,duration,text' && csv2.filter((r) => r.length > 1).length === clips.length * 2 + 1);
    check('norm+trim MP3s are valid MPEG streams', names2.filter((n) => n.endsWith('.mp3')).every((n) => parseMp3(files2.get(n)).ok));
    await page.close();
  },
}];
