// Cloudflare Pages refuses any single file over 25 MiB. The build emits an
// ort-wasm-simd-threaded.asyncify-*.wasm (~25 MB) that the app never downloads
// (the speech engine is pointed at /ort/ort-wasm-simd-threaded.wasm instead), so
// it is deleted from the deploy output. Then every remaining file is size-checked.
import { readdirSync, statSync, rmSync } from 'node:fs';
import { join } from 'node:path';
const LIMIT = 25 * 1024 * 1024;
const dist = new URL('../dist', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
function walk(d) { return readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)])); }
for (const f of walk(dist)) if (/ort-wasm-simd-threaded\.asyncify-.*\.wasm$/.test(f)) { rmSync(f); console.log('prune-dist: removed unused', f); }
let bad = 0;
for (const f of walk(dist)) if (statSync(f).size > LIMIT) { console.error('prune-dist: OVER 25 MiB:', f); bad++; }
if (bad) process.exit(1);
console.log('prune-dist: every file is under 25 MiB');
