// Vox-Slice end-to-end runner.
//   node tests/e2e/run.mjs                 run everything
//   node tests/e2e/run.mjs transcribe export   run a subset by name
//   BASE=https://site VOX_USER=u VOX_PASS=p node tests/e2e/run.mjs
//   SKIP_LONG=1 skips the 15-minute test; LIST=1 lists test names.
import { existsSync } from 'node:fs';
import {
  launchShared, repairProfile, results, hygiene, check, info, setCurrentTest, saveResults, hostAllowed, BASE, audio,
} from './lib.mjs';
const MODULES = ['t_transcribe', 't_export', 't_roundtrip', 't_edge', 't_tier2', 't_keys', 't_visual', 't_long'];
const ALL = [];
for (const m of MODULES) {
  if (!existsSync(new URL('./' + m + '.mjs', import.meta.url))) continue;
  ALL.push(...(await import('./' + m + '.mjs')).tests);
}

if (process.env.LIST) { console.log(ALL.map((t) => t.name).join('\n')); process.exit(0); }

const wanted = process.argv.slice(2);
let selected = wanted.length ? ALL.filter((t) => wanted.some((w) => t.name === w || t.name.startsWith(w))) : ALL.slice();
if (process.env.SKIP_LONG) selected = selected.filter((t) => t.name !== 'long');
if (wanted.length && !selected.length) { console.error('No test matches: ' + wanted.join(' ') + '\nAvailable: ' + ALL.map((t) => t.name).join(', ')); process.exit(2); }

const t0 = Date.now();
console.log(`Vox-Slice e2e against ${BASE}  (${selected.length} tests: ${selected.map((t) => t.name).join(', ')})`);
let shared = null;
async function sharedCtx() {
  if (!shared) {
    shared = await launchShared();
    const rep = await repairProfile(shared);
    if (rep === 'deleted') console.log('(repaired a profile DB that lacked its store)');
  }
  return shared;
}

for (const t of selected) {
  console.log(`\n=== ${t.name} ===`);
  setCurrentTest(t.name);
  const start = Date.now();
  try {
    await t.run({ getCtx: sharedCtx });
  } catch (err) {
    check(`${t.name}: test body completed without exception`, false, String((err && err.message) || err).split('\n')[0]);
    console.error(err && err.stack);
  }
  info('seconds', Math.round((Date.now() - start) / 1000));
}
if (shared) await shared.close().catch(() => {});

// ---- hygiene (criterion 9) -------------------------------------------------
setCurrentTest('hygiene');
console.log('\n=== hygiene ===');
const hosts = Object.fromEntries(hygiene.hosts);
info('request hosts', hosts);
const bad = [...hygiene.hosts.keys()].filter((h) => !hostAllowed(h));
check('every request went to localhost / the site itself / huggingface hosts only', bad.length === 0, bad.length ? 'offending: ' + bad.join(', ') : Object.keys(hosts).join(', '));
const nonGet = hygiene.nonGet.filter((r) => { try { return !hostAllowed(new URL(r.url).hostname); } catch { return true; } });
check('no POST/PUT/PATCH to any foreign host', nonGet.length === 0, JSON.stringify(nonGet.slice(0, 3)));
const audioBodies = hygiene.bodies.filter((b) => b.bytes > 4096 || /audio|octet|wav|mpeg/i.test(b.ctype));
check('no request carries a body that looks like audio (>4 KB or audio content-type)', audioBodies.length === 0, JSON.stringify(audioBodies.slice(0, 3)) || `${hygiene.bodies.length} small bodies`);
info('requests with bodies', hygiene.bodies.length);
const unexpected = hygiene.consoleErrors.filter((e) => !e.expected);
const expected = hygiene.consoleErrors.filter((e) => e.expected);
check('no unexpected console errors', unexpected.length === 0, unexpected.slice(0, 4).map((e) => `[${e.test}] ${e.text.slice(0, 120)}`).join(' | '));
check('no uncaught page errors', hygiene.pageErrors.length === 0, hygiene.pageErrors.slice(0, 3).map((e) => `[${e.test}] ${e.text.slice(0, 160)}`).join(' | '));
info('console errors during injected-failure tests (expected)', expected.length);

saveResults();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed in ${Math.round((Date.now() - t0) / 1000)} s`);
if (failed.length) {
  console.log('FAILED:');
  for (const f of failed) console.log(`  [${f.test}] ${f.name}  ${f.detail ? '[' + f.detail + ']' : ''}`);
}
process.exit(failed.length ? 1 : 0);
