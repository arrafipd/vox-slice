// Copies the speech engine's WebAssembly runtime out of node_modules into
// public/ort so the site serves it itself (no third-party CDN at runtime).
// Runs automatically before `npm run dev` and `npm run build`.
import { copyFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const from = join(root, 'node_modules', 'onnxruntime-web', 'dist');
const to = join(root, 'public', 'ort');
const files = ['ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm'];

mkdirSync(to, { recursive: true });
for (const f of files) {
  const src = join(from, f);
  if (!existsSync(src)) {
    console.error(`copy-ort: missing ${src}. Did onnxruntime-web change its file names? Run npm install.`);
    process.exit(1);
  }
  copyFileSync(src, join(to, f));
  console.log(`copy-ort: ${f} (${(statSync(src).size / 1e6).toFixed(1)} MB)`);
}
