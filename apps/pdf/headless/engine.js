// Headless berg:work PDF engine, shared by the corpus harness (tests/harness/entry.js) and the agent CLI
// (cli/page/entry.js): the editor's PdfEngineSessionOrchestrator over one shared PDFium worker, its semantic kernel
// (journal, undo/redo), and the small helpers both pages need to move bytes to the Node side. Runs inside a headless
// page served by headless/server.mjs; bundled by headless/bundle.mjs with the shell's internals.
import * as Shell from 'bergwork-shell-internals';
import { PdfEngineSessionOrchestrator } from '@editor/pdf-editor/engine/session-orchestrator.js';
import { PdfEngineWorkerTransport } from '@editor/pdf-editor/engine/worker-transport.js';
import { CommandType, createPdfCommand } from '@editor/pdf-editor/model/commands.js';
import { MemoryCommandJournalStore } from '@editor/pdf-editor/model/journal-store.js';
import { PdfSemanticKernel } from '@editor/pdf-editor/model/semantic-kernel.js';
import { glyphsFromTextGlyphResult } from '@editor/pdf-editor/model/redaction-geometry.js';

export const VENDOR = '/tools/vendor/';
export const WASM_URL = `${VENDOR}pdf-tools/pdfium.wasm`;

let transport = null;
// The editor's own transport timeout (PdfEngineWorkerTransport default).
export const config = { requestTimeoutMs: 45_000, renderScale: 0.2, baselinePages: 3 };

class SharedTransport {
  request(request, transfer) { return transport.request(request, transfer); }
  close() {}
}

export function configure(options = {}) {
  Object.assign(config, options);
  return config;
}

/** Replaces the shared PDFium worker (after a timeout or a crash, and every N files). */
export function resetWorker() {
  try { transport?.close(); } catch { /* already gone */ }
  transport = new PdfEngineWorkerTransport({ timeoutMs: config.requestTimeoutMs });
}

// ---------------------------------------------------------------------------------------------------------------
// Small utilities

let uidCounter = 0;
export const uid = (prefix = 'bw') => `${prefix}-${Date.now().toString(36)}-${(uidCounter += 1).toString(36)}`;
export const asBytes = (value) => (value instanceof Uint8Array ? value : new Uint8Array(value || []));
export async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
export function fnv(bytes) {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i += 1) { h ^= bytes[i]; h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}
export function errorInfo(error) {
  return {
    message: String(error?.message || error).slice(0, 600),
    code: typeof error?.code === 'string' ? error.code : (error?.name || 'error'),
    ...(error?.details?.code ? { detailCode: String(error.details.code) } : {}),
  };
}
export const codePointsText = (codes) => {
  if (!codes) return '';
  const values = Array.isArray(codes) ? codes : Object.values(codes);
  let out = '';
  for (const code of values) if (Number.isFinite(code) && code > 0 && code < 0x110000) out += String.fromCodePoint(code);
  return out;
};
export async function withTimeout(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error(`${label} timed out after ${ms} ms`), { code: 'timeout' })), ms);
    })]);
  } finally { clearTimeout(timer); }
}

// Chunked: DevTools reports every request body to the runner (Network.requestWillBeSent postData), and a single
// 100 MB body exceeds the protocol's maximum message size and kills the runner.
const UPLOAD_CHUNK = 4 * 1024 * 1024;
export async function upload(name, bytes) {
  for (let offset = 0; offset === 0 || offset < bytes.byteLength; offset += UPLOAD_CHUNK) {
    const response = await fetch(`/__out/${encodeURIComponent(name)}?append=${offset > 0 ? 1 : 0}`, {
      method: 'POST', body: bytes.subarray(offset, offset + UPLOAD_CHUNK),
    });
    if (!response.ok) throw new Error(`upload ${name}: ${response.status}`);
  }
  return name;
}

// ---------------------------------------------------------------------------------------------------------------
// Engine session wrapper

export class Session {
  constructor(engine, kernel, pageIds) {
    this.engine = engine;
    this.kernel = kernel;
    this.pageIds = [...pageIds];
  }

  static async open(bytes, { password = '', pageIds = null, documentKey = uid('doc'), store = null } = {}) {
    const engine = new PdfEngineSessionOrchestrator({ transport: new SharedTransport() });
    const opened = await engine.open(bytes, {
      ...(pageIds ? { pageIds } : {}),
      wasmUrl: WASM_URL,
      warmFidelityBaseline: false,
      password: String(password || ''),
    });
    const kernel = new PdfSemanticKernel({
      // The editor keeps recovery resources in OPFS (2 GB budget); the memory store's default 256 MB would refuse
      // edits of the corpus's largest files that the editor accepts.
      engine, store: store || new MemoryCommandJournalStore({ resourceByteLimit: 2 * 1024 * 1024 * 1024 }), documentKey, checkpointEvery: 0,
    });
    const session = new Session(engine, kernel, opened.pageIds);
    session.opened = opened;
    session.documentKey = documentKey;
    return session;
  }

  pageIndex(pageId) { return this.pageIds.indexOf(pageId); }

  async inspect(pageIndex) {
    return this.engine.inspectPage({ pageId: this.pageIds[pageIndex], pageIndex });
  }

  async text(pageIndex) {
    const result = await this.engine.extractPageText({ pageId: this.pageIds[pageIndex], pageIndex });
    return codePointsText(result?.codes);
  }

  async glyphs(pageIndex) {
    return glyphsFromTextGlyphResult(await this.engine.pageTextGlyphs({ pageIndex }));
  }

  async render(pageIndex, scale = config.renderScale) {
    const result = await this.engine.render({
      pageId: this.pageIds[pageIndex], pageIndex, scale, jobId: uid('render'),
    });
    const pixels = asBytes(result.pixels);
    return { width: result.width, height: result.height, pixels, hash: fnv(pixels) };
  }

  async snapshot({ retain = true } = {}) {
    const resource = await Shell.checkpointToPdfSnapshotResource(this.engine, { retain });
    await this.kernel.registerResource(resource);
    return resource;
  }

  restoreCommand(prefix, resource, pageIds = this.pageIds) {
    return createPdfCommand({
      commandId: `${prefix}:restore`, type: CommandType.DOCUMENT_RESTORE_SNAPSHOT, targetId: this.documentKey,
      payload: { resourceHash: resource.hash, pageIds: [...pageIds] },
    });
  }

  async execute(label, commands, inverseCommands) {
    const result = await this.kernel.execute({ commands, inverseCommands, label });
    this.labels = [...(this.labels || []), label];
    await this.refresh(result);
    return result;
  }

  /** Re-inspects the first pages a commit dirtied (at most 3, like the editor's immediate visible-page refresh after a commit, undo or redo). */
  async refresh(result) {
    // A page-structure commit returns the new page order: a duplicated, imported or inserted page is found there,
    // as the editor does, before the caller syncs its own list.
    const pageIds = Array.isArray(result?.pageIds) ? result.pageIds : this.pageIds;
    if (pageIds !== this.pageIds) this.pageIds = [...pageIds];
    const dirty = this.refreshAll
      ? pageIds.map((_, index) => index).slice(0, this.refreshAllLimit ?? 40)
      : (result?.dirtyPages || []).map((id) => pageIds.indexOf(id)).filter((index) => index >= 0).slice(0, 3);
    for (const index of dirty) {
      try { await this.inspect(index); } catch { /* a failed inspection surfaces in the next step */ }
    }
  }

  async close() {
    try { await this.engine.close(); } catch { /* the worker may be gone */ }
  }
}


export const command = (prefix, type, targetId, payload) => createPdfCommand({ commandId: `${prefix}:${type}`, type, targetId, payload });

export function pageBox(inspection) {
  const box = inspection?.pageBox || { left: 0, bottom: 0, right: inspection?.unrotatedWidth || 612, top: inspection?.unrotatedHeight || 792 };
  return { ...box, width: box.right - box.left, height: box.top - box.bottom };
}

export { CommandType, createPdfCommand };
