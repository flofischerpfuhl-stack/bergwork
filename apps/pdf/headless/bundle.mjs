// Bundles a headless engine page (the corpus harness, the agent CLI page): an entry module that drives the editor's
// engine, model and a set of document-level helpers from pdf-tools-shell.jsx, plus its HTML page. The shell's
// helpers are module-private, so the bundle reads the forked shell source and appends an `export { … }` list to it in
// memory (esbuild plugin below); the editor sources in apps/pdf/editor/ are never written. The esbuild options follow
// scripts/build-editor.mjs.
import esbuild from 'esbuild';
import { createHash } from 'node:crypto';
import { existsSync, promises as fs, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const appDir = path.dirname(here);
// BERGWORK_PDF_EDITOR_SRC points the bundle at another checkout's editor sources (a Fernwork worktree's
// vendor/build/src), to test engine fixes there before they are ported; the default is the fork.
export const sourceDir = process.env.BERGWORK_PDF_EDITOR_SRC
  ? path.resolve(process.env.BERGWORK_PDF_EDITOR_SRC) : path.join(appDir, 'editor', 'vendor', 'build', 'src');
export const shellPath = path.join(sourceDir, 'pdf-tools-shell.jsx');

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

async function shellInternalsPlugin(internals) {
  const source = await fs.readFile(shellPath, 'utf8');
  const present = internals.filter((name) =>
    new RegExp(`^(?:export\\s+)?(?:async\\s+)?(?:function\\s*\\*?\\s*${name}\\b|(?:const|let|class)\\s+${name}\\b)`, 'm').test(source));
  const missing = internals.filter((name) => !present.includes(name));
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

/**
 * Bundles `entry` into `<outDir>/<bundleName>` and copies `html` next to it.
 * @param {{ entry: string, html: string, outDir: string, internals: string[], bundleName?: string }} options
 * @returns {Promise<{ info: object, bytes: number }>}
 */
export async function bundleEnginePage({ entry, html, outDir, internals, bundleName = 'harness.js' }) {
  const plugin = await shellInternalsPlugin(internals);
  await fs.mkdir(outDir, { recursive: true });
  const result = await esbuild.build({
    preserveSymlinks: true,
    entryPoints: [entry],
    outfile: path.join(outDir, bundleName),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: ['es2022'],
    plugins: [browserNodeFallback, plugin.plugin],
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
  await fs.copyFile(html, path.join(outDir, path.basename(html)));
  const info = { builtAt: new Date().toISOString(), shellDigest: plugin.digest, missingInternals: plugin.missing };
  await fs.writeFile(path.join(outDir, 'build-info.json'), JSON.stringify(info, null, 2));
  // The inputs, so a cached bundle can tell whether it is stale (bundleIsFresh).
  const inputs = [...Object.keys(result.metafile.inputs).filter((input) => !input.includes(':')).map((input) => path.resolve(input)), shellPath, html];
  await fs.writeFile(path.join(outDir, 'inputs.json'), JSON.stringify(inputs));
  const bytes = Object.values(result.metafile.outputs).reduce((sum, item) => sum + item.bytes, 0);
  return { info, bytes };
}

/** True when `<outDir>/<bundleName>` exists and none of the inputs of its last build changed since. */
export function bundleIsFresh(outDir, bundleName) {
  const bundle = path.join(outDir, bundleName);
  const list = path.join(outDir, 'inputs.json');
  if (!existsSync(bundle) || !existsSync(list)) return false;
  const builtAt = statSync(bundle).mtimeMs;
  try {
    const inputs = JSON.parse(readFileSync(list, 'utf8'));
    return inputs.every((input) => existsSync(input) && statSync(input).mtimeMs <= builtAt);
  } catch { return false; }
}
