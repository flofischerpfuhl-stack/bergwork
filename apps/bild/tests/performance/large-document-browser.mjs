import fs from 'node:fs';
import { chromium } from 'playwright';

const output = process.env.A4C_RESULT ?? '/tmp/a4c-chromium.json';
const baseURL = process.env.A4C_URL ?? 'http://127.0.0.1:5471/?harness=ui';
const profile = fs.mkdtempSync('/tmp/a4c-chromium-profile-');
const context = await chromium.launchPersistentContext(profile, { headless: true });
let rootPid = 0;
for (const name of fs.readdirSync('/proc').filter((value) => /^\d+$/.test(value))) {
  try {
    const stat = fs.readFileSync(`/proc/${name}/stat`, 'utf8'), end = stat.lastIndexOf(')');
    if (Number(stat.slice(end + 2).split(' ')[1]) === process.pid) { rootPid = Number(name); break; }
  } catch { /* exited */ }
}
if (!rootPid) throw new Error('Cannot find the persistent Chromium process');
let peakRssBytes = 0, peakHwmBytes = 0, diskFloorBytes = Number.POSITIVE_INFINITY, diskFailure = false;

function processTree(root) {
  const rows = fs.readFileSync('/proc/self/mountinfo', 'utf8'); void rows;
  const processes = fs.readdirSync('/proc').filter((name) => /^\d+$/.test(name)).map(Number);
  const parents = new Map();
  for (const pid of processes) {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const end = stat.lastIndexOf(')');
      parents.set(pid, Number(stat.slice(end + 2).split(' ')[1]));
    } catch { /* exited */ }
  }
  const found = new Set([root]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [pid, parent] of parents) if (found.has(parent) && !found.has(pid)) { found.add(pid); changed = true; }
  }
  return found;
}

function sampleResources() {
  let rss = 0, hwm = 0;
  for (const pid of processTree(rootPid)) {
    try {
      const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
      rss += Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1] ?? 0) * 1024;
      hwm += Number(status.match(/^VmHWM:\s+(\d+)/m)?.[1] ?? 0) * 1024;
    } catch { /* exited */ }
  }
  peakRssBytes = Math.max(peakRssBytes, rss); peakHwmBytes = Math.max(peakHwmBytes, hwm);
  const stat = fs.statfsSync('/');
  const free = stat.bavail * stat.bsize;
  diskFloorBytes = Math.min(diskFloorBytes, free);
  if (free < 10 * 1024 ** 3 && !diskFailure) { diskFailure = true; void context.close(); }
}

const timer = setInterval(sampleResources, 1000);
try {
  const page = context.pages()[0] ?? await context.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });
  page.on('console', (message) => { if (message.text().startsWith('[A4c]')) console.log(message.text()); });
  page.setDefaultTimeout(0);
  await page.goto(baseURL);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Storage.overrideQuotaForOrigin', { origin: new URL(baseURL).origin, quotaSize: 24 * 1024 ** 3 });
  const metrics = await page.evaluate(async () => {
    document.body.style.cssText = 'margin:0;width:100vw;height:100vh;overflow:hidden';
    const load = (path) => import(/* @vite-ignore */ path);
    const { mountEditor } = await load('/src/index.ts');
    const { createBrowserHost } = await load('/src/platform/browserHost.ts');
    const { runLargeDocumentAcceptance } = await load('/src/platform/largeDocumentAcceptance.ts');
    const base = createBrowserHost();
    const root = await navigator.storage.getDirectory();
    // Keep the output outside the scratch host's flat key namespace so journal GC cannot touch it.
    const outputDirectory = await root.getDirectoryHandle('a4c-output', { create: true });
    const archiveHandle = await outputDirectory.getFileHandle('a4c-200mp.fwimg', { create: true });
    const chunkedArchive = async () => {
      const archiveSize = (await archiveHandle.getFile()).size;
      const makeRange = (start, end, type = 'application/zip') => {
        const size = Math.max(0, end - start);
        const stream = () => {
        let offset = 0;
        return new ReadableStream({
          async pull(streamController) {
            if (offset >= size) { streamController.close(); return; }
            // Chromium's File.stream() fails on this >4 GiB OPFS file; fresh bounded snapshots do not
            // retain the complete archive and match the native host's chunked read contract.
            const current = await archiveHandle.getFile();
            const bytes = new Uint8Array(await current.slice(start + offset,
              start + Math.min(size, offset + 4 * 1024 * 1024)).arrayBuffer());
            if (!bytes.byteLength) { streamController.error(new Error('OPFS archive ended unexpectedly')); return; }
            offset += bytes.byteLength;
            streamController.enqueue(bytes);
          },
        });
        };
        return { size, type, stream,
          slice(relativeStart = 0, relativeEnd = size, contentType = '') {
            const normalize = (value) => value < 0 ? Math.max(size + value, 0) : Math.min(value, size);
            const from = normalize(relativeStart), to = Math.max(from, normalize(relativeEnd));
            return makeRange(start + from, start + to, contentType);
          },
          async arrayBuffer() {
            if (size > 64 * 1024 * 1024) throw new Error('Acceptance archive must stay streamed');
            const output = new Uint8Array(size), reader = stream().getReader();
            let offset = 0;
            for (;;) {
              const { value, done } = await reader.read();
              if (done) break;
              output.set(value, offset); offset += value.byteLength;
            }
            return output.buffer;
          } };
      };
      return makeRange(0, archiveSize);
    };
    const host = {
      ...base, editorProfile: 'pro', tileBudgetBytes: 1536 * 1024 * 1024,
      async chooseSaveTarget() { return { name: 'a4c-200mp.fwimg' }; },
      async openFileSink() {
        const writable = await archiveHandle.createWritable();
        return { async write(chunk) { await writable.write(chunk); }, async close() { await writable.close(); },
          async abort() { await writable.abort(); } };
      },
      async saveFile() { throw new Error('Acceptance must use the streaming file sink'); },
      reportError(error) { throw new Error(`${error.code}: ${error.message}`); },
    };
    const editorRoot = document.getElementById('root');
    await mountEditor(editorRoot, { host, locale: 'en', theme: 'dark' });
    const controller = window.__editorForTests;
    const io = {
      async save() {
        await controller.save(true);
        const archive = await chunkedArchive();
        return { archive, bytes: archive.size };
      },
      async closeAndReopen() {
        const old = controller.workspace.current.id;
        controller.workspace.removeTab(old);
        await controller.openArchive(await chunkedArchive(), 'A4c 200 MP.fwimg');
      },
    };
    return runLargeDocumentAcceptance(controller, io);
  });
  sampleResources();
  const result = { runtime: 'chromium', pid: rootPid, peakRssBytes, summedVmHwmBytes: peakHwmBytes,
    diskFloorBytes, diskFailure, ...metrics };
  fs.writeFileSync(output, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} finally {
  clearInterval(timer);
  try { await context.close(); }
  finally {
    if (process.env.A4C_KEEP_PROFILE === '1') console.error(`[A4c] retained profile ${profile}`);
    else fs.rmSync(profile, { recursive: true, force: true });
  }
}
