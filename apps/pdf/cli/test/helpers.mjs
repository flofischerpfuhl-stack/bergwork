// Shared helpers for the CLI tests: run the CLI as a subprocess, check results with qpdf and poppler.
import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const appDir = path.resolve(here, '..', '..');
export const bin = path.join(appDir, 'cli', 'bin', 'bergwork-pdf-cli.mjs');
export const smoke = path.join(appDir, 'scripts', 'fixtures', 'smoke.pdf');
export const scanned = path.join(appDir, 'scripts', 'fixtures', 'scanned-page.pdf');

const has = (tool) => { try { execFileSync('which', [tool], { stdio: 'ignore' }); return true; } catch { return false; } };
export const tools = { qpdf: has('qpdf'), pdftotext: has('pdftotext'), pdfinfo: has('pdfinfo') };

/** Why the suite cannot run here, or null. */
export const setupMissing = !existsSync(path.join(appDir, 'dist', 'tools', 'vendor', 'pdf-tools', 'pdfium-worker.js'))
  ? 'apps/pdf/dist is missing (npm run build:web -w @bergwork/pdf)'
  : !existsSync(path.join(appDir, '..', 'image', 'node_modules', 'playwright')) ? 'Playwright is missing (npm ci --prefix apps/image)' : null;

export function tempDir(t) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'bergwork-pdf-cli-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Runs the CLI with --json; resolves { code, out } with the parsed JSON line. */
export function cli(args, { input } = {}) {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [bin, ...args, '--json'], { maxBuffer: 64 * 1024 * 1024, timeout: 280_000 }, (error, stdout, stderr) => {
      let out = null;
      try { out = JSON.parse(stdout.trim().split('\n').pop()); } catch { /* not JSON */ }
      resolve({ code: error ? (error.code ?? 1) : 0, out, stdout, stderr });
    });
    if (input != null) child.stdin.end(input);
  });
}

export const qpdfCheck = (file, password) => {
  try {
    execFileSync('qpdf', ['--check', ...(password ? [`--password=${password}`] : []), file], { stdio: 'pipe' });
    return true;
  } catch (error) { return error.status === 3; } // 3: warnings only
};
export const pdftotext = (file, { first, last } = {}) => execFileSync('pdftotext', [...(first ? ['-f', String(first)] : []), ...(last ? ['-l', String(last)] : []), file, '-'], { encoding: 'utf8' });
export function pdfinfo(file, { password, first, last } = {}) {
  const text = execFileSync('pdfinfo', [...(password ? ['-upw', password] : []), ...(first ? ['-f', String(first), '-l', String(last ?? first)] : []), file], { encoding: 'utf8' });
  const fields = {};
  for (const line of text.split('\n')) { const at = line.indexOf(':'); if (at > 0) fields[line.slice(0, at).trim()] = line.slice(at + 1).trim(); }
  return { text, fields, pages: Number(fields.Pages) };
}
