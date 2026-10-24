#!/usr/bin/env node
// Bundles the forked PDF editor (apps/pdf/editor/, see editor-fork.mjs) into apps/pdf/editor-dist/: oo-pdf-tools.js,
// its chunks/ and oo-pdf-tools.css, the three files of Fernwork's tools/vendor/pdf-tools/ that come from the editor's
// UI sources. build-frontend.mjs lays them over the pinned build; workers, WebAssembly and fonts stay pinned.
// The esbuild options follow Fernwork's vendor/build/build.mjs (buildPdfTools) at the forked commit.
import esbuild from 'esbuild';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sourceDir = path.join(appDir, 'editor', 'vendor', 'build', 'src');
const outDir = path.join(appDir, 'editor-dist');
// BERGWORK_BUNDLE_MINIFY=0 keeps function names for CPU profiles.
const minify = process.env.BERGWORK_BUNDLE_MINIFY !== '0';

// pdfstudio's Emscripten wrapper has guarded Node fallbacks for file: URLs that the browser never reaches; esbuild
// still resolves their dynamic `node:` imports, so they become throwing stubs.
const browserNodeFallback = {
  name: 'browser-node-fallback-stubs',
  setup(build) {
    build.onResolve({ filter: /^node:/ }, (args) => ({ path: args.path, namespace: 'browser-node-fallback' }));
    build.onLoad({ filter: /.*/, namespace: 'browser-node-fallback' }, () => ({
      loader: 'js',
      contents: `const unavailable = () => { throw new Error('Node fallback requested in the browser PDF bundle.'); };
        export const readFile = unavailable; export const createRequire = () => unavailable; export default {};`,
    }));
  },
};

await fs.rm(outDir, { recursive: true, force: true });
await esbuild.build({
  preserveSymlinks: true,
  entryPoints: [path.join(sourceDir, 'pdf-tools-shell.jsx')],
  outdir: outDir,
  entryNames: 'oo-pdf-tools',
  chunkNames: 'chunks/[name]-[hash]',
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2020'],
  plugins: [browserNodeFallback],
  minify,
  sourcemap: false,
  jsx: 'automatic',
  loader: { '.js': 'jsx', '.jsx': 'jsx', '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl', '.png': 'dataurl', '.svg': 'dataurl' },
  define: { 'process.env.NODE_ENV': '"production"', global: 'globalThis' },
  logLevel: 'warning',
});
// The editor addresses its workers, WebAssembly, fonts and runtimes as "/tools/vendor/…", the root of fernwork.net.
// berg:work runs it at other paths (/app/pdf/ on bergwork.app), so each such literal starts at the host's vendor root
// (web/src/editor.ts sets globalThis.__bergworkVendor) instead; without it, the path stays as it was.
const FALLBACK = '(globalThis.__bergworkVendor??"/tools/vendor/")+"';
let rewritten = 0;
for (const entry of await fs.readdir(outDir, { recursive: true })) {
  if (!entry.endsWith('.js')) continue;
  const file = path.join(outDir, entry);
  const code = await fs.readFile(file, 'utf8');
  const next = code.replaceAll('"/tools/vendor/', () => { rewritten += 1; return FALLBACK; });
  if (/["'`]\/tools\/vendor\//.test(next.replaceAll('??"/tools/vendor/")', ''))) {
    throw new Error(`build-editor: ${entry} has a /tools/vendor/ path that is not a double-quoted literal; extend the rewrite.`);
  }
  if (next !== code) await fs.writeFile(file, next);
}
await fs.copyFile(path.join(sourceDir, 'pdf-tools-theme.css'), path.join(outDir, 'oo-pdf-tools.css'));
console.log(`build-editor: ${path.relative(process.cwd(), outDir) || '.'} (${rewritten} vendor paths follow the host)`);
