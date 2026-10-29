// The headless engine for the CLI and the MCP server: builds the CLI page (cli/page/entry.js, through the same
// bundler as the corpus harness) when its sources changed, starts the static server and headless Chromium
// (headless/host.mjs) and runs operations in one long-lived page. Input files are linked into a private temporary
// folder the page reads from; outputs come back through the server's upload endpoint into another one. Nothing
// leaves the machine: the server listens on 127.0.0.1 and the page loads only dist/ and the bundle.
import { createHash } from 'node:crypto';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleEnginePage, bundleIsFresh, sourceDir } from '../../headless/bundle.mjs';
import { startHost } from '../../headless/host.mjs';
import { SHELL_INTERNALS } from '../../tests/harness/build-harness.mjs';
import { CliError } from './errors.mjs';

const cliDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const appDir = path.dirname(cliDir);
const pageDir = path.join(cliDir, 'page');
const buildDir = process.env.BERGWORK_PDF_EDITOR_SRC
  ? path.join(cliDir, '.build', `src-${createHash('sha256').update(sourceDir).digest('hex').slice(0, 10)}`)
  : path.join(cliDir, '.build');
const distDir = process.env.BERGWORK_PDF_DIST ? path.resolve(process.env.BERGWORK_PDF_DIST) : path.join(appDir, 'dist');
// The harness's shell helpers plus the two the editor's Save uses to return untouched source bytes.
const CLI_INTERNALS = [...SHELL_INTERNALS, 'canReturnOriginalPdfBytes', 'materializeCurrentPdfBytes'];

/** Builds cli/.build/cli.js unless it is newer than every input of its last build. */
export async function ensureBundle({ force = false } = {}) {
  if (!force && bundleIsFresh(buildDir, 'cli.js')) return { built: false, dir: buildDir };
  // Built next to the final folder and moved in file by file, so concurrent invocations never load a half-written
  // bundle.
  const staging = `${buildDir}.tmp-${process.pid}-${Date.now()}`;
  try {
    const { info } = await bundleEnginePage({
      entry: path.join(pageDir, 'entry.js'), html: path.join(pageDir, 'cli.html'), outDir: staging, internals: CLI_INTERNALS, bundleName: 'cli.js',
    });
    await fs.mkdir(buildDir, { recursive: true });
    for (const name of ['cli.html', 'build-info.json', 'inputs.json', 'cli.js']) await fs.rename(path.join(staging, name), path.join(buildDir, name));
    return { built: true, dir: buildDir, missingInternals: info.missingInternals };
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

function checkSetup() {
  if (!existsSync(path.join(distDir, 'index.html')) || !existsSync(path.join(distDir, 'tools', 'vendor', 'pdf-tools', 'pdfium-worker.js'))) {
    throw new CliError('setup-missing', `The assembled editor is missing (${distDir}): run \`npm run sync:install\` and \`npm run build:web -w @bergwork/pdf\` first.`);
  }
  if (!existsSync(path.join(appDir, '..', 'image', 'node_modules', 'playwright'))) {
    throw new CliError('setup-missing', 'Playwright is missing: run `npm ci --prefix apps/image` (the CLI uses its headless Chromium).');
  }
}

export class EngineHost {
  constructor({ timeoutMs = 300_000 } = {}) {
    this.timeoutMs = timeoutMs;
    this.host = null;
    this.page = null;
    this.counter = 0;
    this.queue = Promise.resolve();
  }

  async start() {
    if (this.host) return;
    checkSetup();
    await ensureBundle();
    this.workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bergwork-pdf-cli-'));
    this.inDir = path.join(this.workDir, 'in');
    this.outDir = path.join(this.workDir, 'out');
    await fs.mkdir(this.inDir, { recursive: true });
    await fs.mkdir(this.outDir, { recursive: true });
    this.host = await startHost({ distDir, harnessDir: buildDir, corpusRoot: this.inDir, outDir: this.outDir });
  }

  async ensurePage() {
    if (this.page && !this.page.isClosed() && !this.page.__events.some((event) => event.type === 'crash')) return this.page;
    await this.page?.close().catch(() => {});
    this.page = await this.host.newEnginePage('cli.html');
    return this.page;
  }

  /**
   * Runs one page operation. `inputs` are local PDF paths with their passwords; the page sees them as `params.input`
   * (one) or `params.inputs` (several). Resolves with `{ result, files }`, files mapping output names to temporary
   * paths the caller moves into place; rejects with a CliError.
   */
  run(op, params, inputs = []) {
    const job = this.queue.then(() => this.#run(op, params, inputs));
    this.queue = job.catch(() => {});
    return job;
  }

  async #run(op, params, inputs) {
    await this.start();
    const call = (this.counter += 1);
    const linked = [];
    for (const [index, input] of inputs.entries()) {
      const source = path.resolve(input.path);
      const stat = await fs.stat(source).catch(() => null);
      if (!stat?.isFile()) throw new CliError('input-unreadable', `Not a readable file: ${input.path}`);
      const name = `c${call}-${index}-${path.basename(source).replace(/[^A-Za-z0-9._-]/g, '_')}`;
      await fs.symlink(source, path.join(this.inDir, name));
      linked.push({ url: `/__corpus/${encodeURIComponent(name)}`, name: path.basename(source), password: input.password || '' });
    }
    const prefix = `c${call}-`;
    const page = await this.ensurePage();
    page.__events = [];
    let timer;
    let response;
    try {
      response = await Promise.race([
        page.evaluate(([name, value]) => window.BW.run(name, value), [op, {
          ...params, prefix,
          ...(linked.length === 1 && !params.multi ? { input: linked[0] } : { inputs: linked }),
        }]),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new CliError('timeout', `The operation took longer than ${Math.round(this.timeoutMs / 1000)} s`)), this.timeoutMs); }),
      ]);
    } catch (error) {
      // A hung or crashed page is replaced before the next call.
      await page.close().catch(() => {});
      this.page = null;
      if (error instanceof CliError) throw error;
      const crashed = page.__events.some((event) => event.type === 'crash');
      throw new CliError('engine-error', crashed ? 'The engine page crashed' : String(error?.message || error).slice(0, 600));
    } finally {
      clearTimeout(timer);
      for (const item of linked) await fs.rm(path.join(this.inDir, decodeURIComponent(item.url.slice('/__corpus/'.length))), { force: true });
    }
    if (!response?.ok) throw new CliError(response?.error?.code || 'engine-error', response?.error?.message || 'Unknown engine error', response?.error?.details, response?.error?.engineCode);
    const files = new Map();
    for (const name of await fs.readdir(this.outDir)) if (name.startsWith(prefix)) files.set(name, path.join(this.outDir, name));
    return { result: response.result, files };
  }

  async close() {
    await this.page?.close().catch(() => {});
    await this.host?.close().catch(() => {});
    if (this.workDir) await fs.rm(this.workDir, { recursive: true, force: true });
    this.host = null; this.page = null;
  }
}
