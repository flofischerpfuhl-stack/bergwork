#!/usr/bin/env node
// Bundles the corpus test harness into apps/pdf/tests/.build/: harness.js (the editor's engine, model and a set of
// document-level helpers from pdf-tools-shell.jsx) and harness.html. The shell's helpers are module-private, so the
// bundle reads the forked shell source and appends an `export { … }` list to it in memory (esbuild plugin below); the
// editor sources in apps/pdf/editor/ are never written. The esbuild options follow scripts/build-editor.mjs.
//
//   node apps/pdf/tests/harness/build-harness.mjs
import esbuild from 'esbuild';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const testsDir = path.dirname(here);
const appDir = path.dirname(testsDir);
// BERGWORK_PDF_EDITOR_SRC points the harness at another checkout's editor sources (a Fernwork worktree's
// vendor/build/src), to test engine fixes there before they are ported; the default is the fork.
const sourceDir = process.env.BERGWORK_PDF_EDITOR_SRC
  ? path.resolve(process.env.BERGWORK_PDF_EDITOR_SRC) : path.join(appDir, 'editor', 'vendor', 'build', 'src');
const shellPath = path.join(sourceDir, 'pdf-tools-shell.jsx');
// Each source tree builds into its own folder, so runs against different checkouts can go on side by side.
export const outDir = process.env.BERGWORK_PDF_EDITOR_SRC
  ? path.join(testsDir, '.build', `src-${createHash('sha256').update(sourceDir).digest('hex').slice(0, 10)}`)
  : path.join(testsDir, '.build');

// Top-level helpers of pdf-tools-shell.jsx the harness calls. Missing names (renamed upstream) are reported and
// skipped; the harness marks the operations that need them as unavailable instead of failing to build.
export const SHELL_INTERNALS = [
  'postprocessPdfiumExportBytes', 'repairGeneratedFreeTextAppearances', 'repairDanglingFontResources',
  'packExportPdfBytes', 'restrictPdfBytes', 'compressEditedPdf', 'fillMaterializedFormPdfBytes',
  'finalizeFlattenedPdfBytes', 'pdfBytesWithBookmarks', 'pdfBytesWithFormValues', 'getPdfToolkit', 'loadPdfFile',
  'readPdfMetadata', 'applyMetadata', 'stripMetadata', 'openPdfJsDocument', 'imageDataUrlToRgbaResource',
  'checkpointToPdfSnapshotResource', 'pdfSnapshotResourceFromBytes', 'PDF_OPT_PROFILES', 'serializePdfProjectEntries',
  'loadFernworkPdfProjectFile', 'pdfiumWorkerRequest', 'formWidgetsForDocument', 'documentHasXfaForm',
  'pdfBytesContainCryptographicSignature', 'sourceForLivePdfiumSession', 'materializeDurableNativePdfBytes',
  'pdfiumColorWithOpacity', 'extractTextForDoc',
];

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

async function shellInternalsPlugin() {
  const source = await fs.readFile(shellPath, 'utf8');
  const present = SHELL_INTERNALS.filter((name) =>
    new RegExp(`^(?:export\\s+)?(?:async\\s+)?(?:function\\s*\\*?\\s*${name}\\b|(?:const|let|class)\\s+${name}\\b)`, 'm').test(source));
  const missing = SHELL_INTERNALS.filter((name) => !present.includes(name));
  const contents = `${source}\nexport { ${present.join(', ')} };\nexport const __harnessMissingInternals = ${JSON.stringify(missing)};\n`;
  return {
    missing,
    digest: createHash('sha256').update(source).digest('hex').slice(0, 16),
    plugin: {
      name: 'shell-internals',
      setup(build) {
        build.onResolve({ filter: /^bergwork-shell-internals$/ }, () => ({ path: shellPath, namespace: 'shell-internals' }));
        build.onLoad({ filter: /.*/, namespace: 'shell-internals' }, () => ({ contents, loader: 'jsx', resolveDir: sourceDir }));
      },
    },
  };
}

export async function buildHarness({ quiet = false } = {}) {
  const internals = await shellInternalsPlugin();
  await fs.mkdir(outDir, { recursive: true });
  const result = await esbuild.build({
    preserveSymlinks: true,
    entryPoints: [path.join(here, 'entry.js')],
    outfile: path.join(outDir, 'harness.js'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: ['es2022'],
    plugins: [browserNodeFallback, internals.plugin],
    minify: false,
    sourcemap: false,
    jsx: 'automatic',
    external: ['/tools/*', '/__harness/*'],
    nodePaths: [path.join(appDir, 'node_modules'), path.join(appDir, '..', '..', 'node_modules')],
    alias: { '@editor': sourceDir },
    loader: { '.js': 'jsx', '.jsx': 'jsx', '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl', '.png': 'dataurl', '.svg': 'dataurl' },
    define: { 'process.env.NODE_ENV': '"production"', global: 'globalThis' },
    logLevel: 'warning',
    metafile: true,
  });
  await fs.copyFile(path.join(here, 'harness.html'), path.join(outDir, 'harness.html'));
  const info = { builtAt: new Date().toISOString(), shellDigest: internals.digest, missingInternals: internals.missing };
  await fs.writeFile(path.join(outDir, 'build-info.json'), JSON.stringify(info, null, 2));
  if (!quiet) {
    const bytes = Object.values(result.metafile.outputs).reduce((sum, item) => sum + item.bytes, 0);
    console.log(`build-harness: ${path.relative(process.cwd(), outDir) || '.'} (${(bytes / 1e6).toFixed(1)} MB)` +
      (internals.missing.length ? `, missing shell internals: ${internals.missing.join(', ')}` : ''));
  }
  return info;
}

if (import.meta.url === `file://${process.argv[1]}`) await buildHarness();
