// Independent checks of the PDFs the harness wrote, with tools outside the editor's stack: qpdf (structure, page
// count, encryption) and poppler (pdftotext word boxes for redactions). Missing tools are reported, not fatal.
import { execFile } from 'node:child_process';

function run(command, args, timeoutMs = 30_000) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : (error.killed ? 'timeout' : -1)) : 0, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

let tools = null;
export async function detectTools() {
  if (tools) return tools;
  const has = async (name, args) => (await run(name, args, 5000)).code === 0;
  tools = { qpdf: await has('qpdf', ['--version']), pdftotext: await has('pdftotext', ['-v']), pdfinfo: await has('pdfinfo', ['-v']) };
  return tools;
}

const passwordArgs = (password) => (password ? [`--password=${password}`] : []);

/** qpdf --check: 0 ok, 3 warnings, 2 errors. */
export async function qpdfCheck(file, password = '') {
  const result = await run('qpdf', [...passwordArgs(password), '--check', file], 60_000);
  const status = result.code === 0 ? 'ok' : result.code === 3 ? 'warnings' : 'errors';
  const message = (result.stderr || result.stdout).split('\n').filter((line) => /error|warning|damaged|invalid/i.test(line)).slice(0, 3).join(' | ').slice(0, 300);
  return { status, message };
}

export async function qpdfPages(file, password = '') {
  const result = await run('qpdf', [...passwordArgs(password), '--show-npages', file], 30_000);
  const pages = Number.parseInt(result.stdout.trim(), 10);
  return Number.isFinite(pages) ? pages : null;
}

export async function qpdfEncrypted(file) {
  const result = await run('qpdf', ['--is-encrypted', file], 15_000);
  return result.code === 0;
}

/** Words poppler extracts inside the given PDF-space rectangles of one page (only for unrotated pages). */
export async function popplerWordsInRects(file, pageNumber, rects) {
  const info = await run('pdfinfo', ['-box', '-f', String(pageNumber), '-l', String(pageNumber), file], 15_000);
  const rotation = Number((info.stdout.match(/Page\s+\d+\s+rot:\s+(\d+)/) || [])[1] || 0);
  // pdftotext -bbox reports MediaBox coordinates (CropBox ones only with -cropbox).
  const media = (info.stdout.match(/Page\s+\d+\s+MediaBox:\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)\s+([-\d.]+)/) || []).slice(1).map(Number);
  if (rotation % 360 !== 0 || media.length !== 4) return { skipped: `rotation ${rotation}` };
  const result = await run('pdftotext', ['-f', String(pageNumber), '-l', String(pageNumber), '-bbox', file, '-'], 30_000);
  if (result.code !== 0) return { skipped: `pdftotext exit ${result.code}` };
  const words = [];
  for (const match of result.stdout.matchAll(/<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<\/word>/g)) {
    const [xMin, yMin, xMax, yMax] = match.slice(1, 5).map(Number);
    // poppler: top-left origin of the media box; PDF space: bottom-left of user space.
    const cx = media[0] + (xMin + xMax) / 2;
    const cy = media[3] - (yMin + yMax) / 2;
    if (rects.some((rect) => cx > rect.left && cx < rect.right && cy > rect.bottom && cy < rect.top)) words.push(match[5]);
  }
  return { words };
}
