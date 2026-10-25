// berg:work PDF corpus harness: runs inside one long-lived headless page and drives the editor's own engine
// (PdfEngineSessionOrchestrator over the pinned PDFium worker), its semantic kernel (journal, undo/redo) and the
// document-level helpers of pdf-tools-shell.jsx (export post-processing, stamps, forms, compression, encryption,
// projects) directly, without the React UI. One PDFium worker is shared by every document the page runs; the runner
// (tests/run-corpus.mjs) sends one job per file and receives a JSON result. Exported PDFs are POSTed to /__out/ so the
// runner can check them with qpdf and poppler.
import * as Shell from 'bergwork-shell-internals';
import { PdfEngineSessionOrchestrator } from '@editor/pdf-editor/engine/session-orchestrator.js';
import { PdfEngineWorkerTransport } from '@editor/pdf-editor/engine/worker-transport.js';
import { CommandType, createPdfCommand } from '@editor/pdf-editor/model/commands.js';
import { MemoryCommandJournalStore, IndexedDbCommandJournalStore } from '@editor/pdf-editor/model/journal-store.js';
import { PdfSemanticKernel } from '@editor/pdf-editor/model/semantic-kernel.js';
import { PAGE_STAMP_KINDS, stampPdfPages } from '@editor/pdf-editor/model/page-stamps.js';
import { findGlyphTextMatches, glyphsFromTextGlyphResult } from '@editor/pdf-editor/model/redaction-geometry.js';
import { createAdvanceMeasurer, subsetTrueTypeFont } from '@editor/pdf-editor/ocr/truetype-subset.js';
import { withOcrWorker } from '@editor/pdf-editor/ocr/runtime.js';
import { ocrTextLayerWords } from '@editor/pdf-editor/ocr/text-layer.js';

const VENDOR = '/tools/vendor/';
const WASM_URL = `${VENDOR}pdf-tools/pdfium.wasm`;

let transport = null;
// The editor's own transport timeout (PdfEngineWorkerTransport default).
let config = { requestTimeoutMs: 45_000, renderScale: 0.2, baselinePages: 3 };
let notoSans = null;

class SharedTransport {
  request(request, transfer) { return transport.request(request, transfer); }
  close() {}
}

export async function init(options = {}) {
  config = { ...config, ...options };
  if (!globalThis.PDFLib || !globalThis.pdfjsLib) throw new Error('harness.html must load pdf-lib and PDF.js first');
  resetWorker();
  return { missingInternals: Shell.__harnessMissingInternals };
}

/** Replaces the shared PDFium worker (after a timeout or a crash, and every N files). */
export function resetWorker() {
  try { transport?.close(); } catch { /* already gone */ }
  transport = new PdfEngineWorkerTransport({ timeoutMs: config.requestTimeoutMs });
}

// ---------------------------------------------------------------------------------------------------------------
// Small utilities

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (rng, list) => list[Math.floor(rng() * list.length) % list.length];
let uidCounter = 0;
const uid = (prefix = 'bw') => `${prefix}-${Date.now().toString(36)}-${(uidCounter += 1).toString(36)}`;
const asBytes = (value) => (value instanceof Uint8Array ? value : new Uint8Array(value || []));
async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
function fnv(bytes) {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i += 1) { h ^= bytes[i]; h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}
function errorInfo(error) {
  return {
    message: String(error?.message || error).slice(0, 600),
    code: typeof error?.code === 'string' ? error.code : (error?.name || 'error'),
    ...(error?.details?.code ? { detailCode: String(error.details.code) } : {}),
  };
}
// Errors after which the shared PDFium worker cannot be trusted: a WebAssembly trap leaves PDFium's memory and
// stack in an unknown state, and a timed-out request may still be running. The file stops there and the worker is
// replaced, so the next file starts clean and the failure is attributed to the file that caused it.
const POISON = /function signature mismatch|memory access out of bounds|unreachable|RuntimeError|table index is out of bounds|call stack size|Worker timed out|Worker failed|transport closed|unreadable message/i;
const REFUSAL_CODES = new Set(['transaction-rejected', 'unsupported-operation', 'resource-limit', 'font-unavailable', 'page-stamp-unreadable']);
// Like the editor, which inspects every page progressively after opening, content edits use pages inspected up front.
let INSPECT_ALL_LIMIT = 40;
const codePointsText = (codes) => {
  if (!codes) return '';
  const values = Array.isArray(codes) ? codes : Object.values(codes);
  let out = '';
  for (const code of values) if (Number.isFinite(code) && code > 0 && code < 0x110000) out += String.fromCodePoint(code);
  return out;
};
const normText = (text) => String(text || '').replace(/\s+/g, '');
function rectsIntersect(a, b, eps = 0.05) {
  return a.left < b.right - eps && a.right > b.left + eps && a.bottom < b.top - eps && a.top > b.bottom + eps;
}
function pixelDiff(a, b) {
  if (!a || !b || a.width !== b.width || a.height !== b.height) return { comparable: false, ratio: 1 };
  let differing = 0;
  const pa = a.pixels; const pb = b.pixels;
  const total = a.width * a.height;
  for (let i = 0; i < pa.length; i += 4) {
    if (Math.abs(pa[i] - pb[i]) > 40 || Math.abs(pa[i + 1] - pb[i + 1]) > 40 || Math.abs(pa[i + 2] - pb[i + 2]) > 40) differing += 1;
  }
  return { comparable: true, ratio: differing / Math.max(1, total) };
}
async function withTimeout(promise, ms, label) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error(`${label} timed out after ${ms} ms`), { code: 'timeout' })), ms);
    })]);
  } finally { clearTimeout(timer); }
}
/** BGRA render -> PNG upload, for failed pixel checks. */
async function uploadRender(name, render) {
  try {
    const canvas = new OffscreenCanvas(render.width, render.height);
    const rgba = new Uint8ClampedArray(render.width * render.height * 4);
    const stride = render.pixels.length / render.height;
    for (let y = 0; y < render.height; y += 1) for (let x = 0; x < render.width; x += 1) {
      const i = y * stride + x * 4; const o = (y * render.width + x) * 4;
      rgba[o] = render.pixels[i + 2]; rgba[o + 1] = render.pixels[i + 1]; rgba[o + 2] = render.pixels[i]; rgba[o + 3] = 255;
    }
    canvas.getContext('2d').putImageData(new ImageData(rgba, render.width, render.height), 0, 0);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    await upload(name, new Uint8Array(await blob.arrayBuffer()));
    return name;
  } catch { return null; }
}

// Chunked: DevTools reports every request body to the runner (Network.requestWillBeSent postData), and a single
// 100 MB body exceeds the protocol's maximum message size and kills the runner.
const UPLOAD_CHUNK = 4 * 1024 * 1024;
async function upload(name, bytes) {
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

class Session {
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
      engine, store: store || new MemoryCommandJournalStore(), documentKey, checkpointEvery: 0,
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
    const dirty = this.refreshAll
      ? this.pageIds.map((_, index) => index).slice(0, INSPECT_ALL_LIMIT)
      : (result?.dirtyPages || []).map((id) => this.pageIds.indexOf(id)).filter((index) => index >= 0).slice(0, 3);
    for (const index of dirty) {
      try { await this.inspect(index); } catch { /* a failed inspection surfaces in the next step */ }
    }
  }

  async close() {
    try { await this.engine.close(); } catch { /* the worker may be gone */ }
  }
}

const command = (prefix, type, targetId, payload) => createPdfCommand({ commandId: `${prefix}:${type}`, type, targetId, payload });

// ---------------------------------------------------------------------------------------------------------------
// Operations. Each returns { status: 'ok' | 'n/a', detail } or throws. They update `state.model`:
//   pages: [{ id, rotation (quarter turns), width, height, touched, origin }]
//   markers: [{ pageId, text, kind }]   text that must be extractable after export
//   redactions: [{ pageId, rect, words }] areas in which no glyph may survive export

function pageBox(inspection) {
  const box = inspection?.pageBox || { left: 0, bottom: 0, right: inspection?.unrotatedWidth || 612, top: inspection?.unrotatedHeight || 792 };
  return { ...box, width: box.right - box.left, height: box.top - box.bottom };
}
function placeRect(box, rng, w, h) {
  const width = Math.min(w, box.width * 0.6); const height = Math.min(h, box.height * 0.3);
  const left = box.left + (box.width - width) * (0.1 + 0.8 * rng());
  const bottom = box.bottom + (box.height - height) * (0.1 + 0.8 * rng());
  return { left, bottom, right: left + width, top: bottom + height };
}
function marker(rng) {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let out = 'BW';
  for (let i = 0; i < 6; i += 1) out += letters[Math.floor(rng() * letters.length)];
  return out;
}
function touch(state, pageId) {
  const page = state.model.pages.find((item) => item.id === pageId);
  if (page) page.touched = true;
}
function textObjects(inspection, { replaceable = false } = {}) {
  return (inspection?.objects || []).filter((object) => object.typeName === 'text' && !object.nested &&
    String(object.text || '').trim().length >= 3 && object.bounds &&
    (!replaceable || /replace/.test(String(object.editPolicy || ''))));
}
function topLevelObjects(inspection) {
  return (inspection?.objects || []).filter((object) => !object.nested && object.stableId && object.bounds &&
    ['text', 'image', 'path'].includes(object.typeName));
}
const editablePageCount = (state) => Math.min(state.session.pageIds.length, INSPECT_ALL_LIMIT);
async function choosePage(state, rng) {
  const index = Math.floor(rng() * editablePageCount(state));
  return { index, id: state.session.pageIds[index], inspection: await state.session.inspect(index) };
}
async function choosePageWith(state, rng, predicate, tries = 4) {
  const count = editablePageCount(state);
  const start = Math.floor(rng() * count);
  for (let attempt = 0; attempt < Math.min(tries, count); attempt += 1) {
    const index = (start + attempt) % count;
    const inspection = await state.session.inspect(index);
    const value = predicate(inspection);
    if (value && (!Array.isArray(value) || value.length)) return { index, id: state.session.pageIds[index], inspection, value };
  }
  return null;
}

async function topology(state, prefix, type, targetId, payload, label) {
  const { session } = state;
  const before = await session.snapshot({ retain: true });
  const extraResources = payload.__resources || [];
  for (const resource of extraResources) await session.kernel.registerResource(resource);
  const { __resources, ...clean } = payload;
  return session.execute(label, [command(prefix, type, targetId, { ...clean, rollbackResourceHash: before.hash })],
    [session.restoreCommand(prefix, before)]);
}

function syncPageIds(state) {
  state.session.pageIds = state.model.pages.map((page) => page.id);
}

const OPS = {
  async 'page.rotate'(state, rng) {
    const { session, model } = state;
    const index = Math.floor(rng() * session.pageIds.length);
    const page = model.pages[index];
    if (page.rotation == null) page.rotation = Number((await session.inspect(index))?.rotation || 0);
    const delta = pick(rng, [1, 2, 3]);
    const next = (page.rotation + delta) % 4;
    const prefix = uid('rot');
    await session.execute('Rotate page', [command(prefix, CommandType.PAGE_ROTATE, page.id, { pageIndex: index, rotation: next })],
      [command(`${prefix}:inv`, CommandType.PAGE_ROTATE, page.id, { pageIndex: index, rotation: page.rotation })]);
    page.rotation = next; page.touched = true;
    return { status: 'ok', detail: { page: index, rotation: next * 90 } };
  },

  async 'page.move'(state, rng) {
    const { model } = state;
    if (model.pages.length < 2) return { status: 'n/a', detail: 'single page' };
    const from = Math.floor(rng() * model.pages.length);
    let to = Math.floor(rng() * model.pages.length);
    if (to === from) to = (from + 1) % model.pages.length;
    const page = model.pages[from];
    await topology(state, uid('move'), CommandType.PAGE_MOVE, page.id, { destinationIndex: to }, 'Move page');
    model.pages.splice(from, 1); model.pages.splice(to, 0, page); syncPageIds(state);
    return { status: 'ok', detail: { from, to } };
  },

  async 'page.delete'(state, rng) {
    const { model } = state;
    if (model.pages.length < 2) return { status: 'n/a', detail: 'single page' };
    const index = Math.floor(rng() * model.pages.length);
    const page = model.pages[index];
    await topology(state, uid('del'), CommandType.PAGE_DELETE, page.id, { pageIndex: index }, 'Delete page');
    model.pages.splice(index, 1); syncPageIds(state);
    model.markers = model.markers.filter((item) => item.pageId !== page.id);
    model.redactions = model.redactions.filter((item) => item.pageId !== page.id);
    return { status: 'ok', detail: { page: index } };
  },

  async 'page.insertBlank'(state, rng) {
    const { model } = state;
    const index = Math.floor(rng() * (model.pages.length + 1));
    const [width, height] = pick(rng, [[595.28, 841.89], [612, 792], [842, 595], [300, 300]]);
    const id = uid('page');
    await topology(state, uid('new'), CommandType.PAGE_NEW, id, { pageIndex: index, width, height }, 'Insert blank page');
    model.pages.splice(index, 0, { id, rotation: 0, width, height, touched: true, origin: null, blank: true }); syncPageIds(state);
    return { status: 'ok', detail: { at: index, size: [width, height] } };
  },

  async 'page.duplicate'(state, rng) {
    const { model } = state;
    const index = Math.floor(rng() * model.pages.length);
    const source = model.pages[index];
    const newPageId = uid('dup');
    await topology(state, uid('dup'), CommandType.PAGE_DUPLICATE, source.id, { pageIndex: index + 1, newPageId }, 'Duplicate page');
    model.pages.splice(index + 1, 0, { ...source, id: newPageId, touched: true, duplicateOf: source.id }); syncPageIds(state);
    for (const item of model.markers.filter((entry) => entry.pageId === source.id)) model.markers.push({ ...item, pageId: newPageId });
    return { status: 'ok', detail: { page: index } };
  },

  async 'page.import'(state, rng, params) {
    // Append (merge) pages of a second PDF, or of this document itself when no donor was given.
    const { model } = state;
    let donorBytes = state.originalBytes;
    let donorPassword = state.password;
    if (params?.donorUrl) {
      donorBytes = new Uint8Array(await (await fetch(params.donorUrl)).arrayBuffer());
      donorPassword = params.donorPassword || '';
    }
    if (donorPassword) return { status: 'n/a', detail: 'encrypted donor' };
    const resource = await Shell.pdfSnapshotResourceFromBytes(donorBytes);
    const donorPages = Math.max(1, Number(params?.donorPages || state.originalPageCount));
    const take = Math.min(donorPages, 1 + Math.floor(rng() * 2));
    const first = Math.floor(rng() * Math.max(1, donorPages - take + 1));
    const sourcePageIndices = Array.from({ length: take }, (_, i) => first + i);
    const pageIds = sourcePageIndices.map(() => uid('imp'));
    const at = rng() < 0.7 ? model.pages.length : Math.floor(rng() * (model.pages.length + 1));
    await topology(state, uid('imp'), CommandType.PAGE_IMPORT, state.session.documentKey,
      { pageIndex: at, resourceHash: resource.hash, sourcePageIndices, pageIds, __resources: [resource] }, 'Import pages');
    model.pages.splice(at, 0, ...pageIds.map((id) => ({ id, rotation: null, width: null, height: null, touched: true, origin: 'import' })));
    syncPageIds(state);
    return { status: 'ok', detail: { at, pages: sourcePageIndices, donor: params?.donorId || 'self' } };
  },

  async 'text.add'(state, rng) {
    const { session, model } = state;
    const page = await choosePage(state, rng);
    const box = pageBox(page.inspection);
    if (box.width < 72 || box.height < 72) return { status: 'n/a', detail: `page too small (${Math.round(box.width)}x${Math.round(box.height)} pt)` };
    const text = marker(rng);
    const fontSize = pick(rng, [9, 12, 18]);
    const bounds = placeRect(box, rng, text.length * fontSize * 0.75 + 20, fontSize * 2);
    const id = uid('txt');
    const prefix = uid('addtext');
    await session.execute('Add text', [command(prefix, CommandType.OBJECT_INSERT, id, {
      pageIndex: page.index, bounds, kind: 'text', text, fontName: pick(rng, ['Helvetica', 'Times-Roman', 'Courier-Bold']),
      fontSize, fillColor: Shell.pdfiumColorWithOpacity(pick(rng, ['#111111', '#c62828', '#1565c0']), 1), textBlock: true,
      block: { width: bounds.right - bounds.left, height: bounds.top - bounds.bottom, fontSize, lineHeight: 1.2, align: 'left', verticalAlign: 'top', overflow: 'visible' },
    })], [command(`${prefix}:inv`, CommandType.OBJECT_DELETE, id, {})]);
    model.markers.push({ pageId: page.id, text, kind: 'text.add', bounds });
    touch(state, page.id);
    return { status: 'ok', detail: { page: page.index, text } };
  },

  async 'text.edit'(state, rng) {
    const { session, model } = state;
    const page = await choosePageWith(state, rng, (inspection) => textObjects(inspection, { replaceable: true })
      .filter((object) => normText(object.text).length >= 6));
    if (!page) return { status: 'n/a', detail: 'no replaceable text object' };
    const object = pick(rng, page.value);
    // Built from the object's own characters: the exact (often subset) source font can encode it.
    const words = String(object.text).trim().split(/\s+/u);
    const replacement = words.length > 1 ? [...words.slice(1), words[0]].join(' ') : [...String(object.text).trim()].reverse().join('');
    // The shell undoes an edit of a native text run with a snapshot (replacesNativeTextRun): a semantic inverse
    // retypes the line without its TJ kerning. The draw stays so the seeded plans keep their sequence.
    rng();
    const semantic = false;
    const prefix = uid('edittext');
    const before = semantic ? null : await session.snapshot({ retain: true });
    // The shell's semantic locator: source rectangle from the top-left of the unrotated page box.
    const box = pageBox(page.inspection);
    const locator = {
      semanticText: true,
      sourceX: object.bounds.left - box.left, sourceY: box.top - object.bounds.top,
      sourceW: object.bounds.right - object.bounds.left, sourceH: object.bounds.top - object.bounds.bottom,
    };
    const payload = (text, sourceText) => ({
      pageIndex: page.index, text, sourceText, allowNaturalWidth: true, textBlock: false, ...locator,
      targetSourceX: locator.sourceX, targetSourceY: locator.sourceY, targetSourceW: locator.sourceW, targetSourceH: locator.sourceH,
      fontSize: object.fontSize,
    });
    await session.execute('Edit text', [command(prefix, CommandType.TEXT_REPLACE, object.stableId, payload(replacement, object.text))],
      [semantic ? command(`${prefix}:inv`, CommandType.TEXT_REPLACE, object.stableId, payload(object.text, replacement))
        : session.restoreCommand(prefix, before)]);
    // Checked word by word: extractors may order the runs of a rewritten line differently.
    model.markers.push({ pageId: page.id, text: normText(replacement), words: replacement.split(/\s+/u).map(normText).filter(Boolean),
      kind: 'text.edit', bounds: object.bounds, soft: normText(replacement).length < 4 });
    touch(state, page.id);
    return { status: 'ok', detail: { page: page.index, from: String(object.text).slice(0, 40), to: replacement, inverse: semantic ? 'semantic' : 'snapshot' } };
  },

  async 'text.font'(state, rng) {
    const { session } = state;
    const page = await choosePageWith(state, rng, (inspection) => textObjects(inspection, { replaceable: true }));
    if (!page) return { status: 'n/a', detail: 'no replaceable text object' };
    const object = pick(rng, page.value);
    const [fontKey, pdfFontName] = pick(rng, [['times', 'Times-Roman'], ['courier', 'Courier'], ['helvetica', 'Helvetica-Bold']]);
    const prefix = uid('font');
    const before = await session.snapshot({ retain: true });
    const box = pageBox(page.inspection);
    const sx = object.bounds.left - box.left; const sy = box.top - object.bounds.top;
    const sw = object.bounds.right - object.bounds.left; const sh = object.bounds.top - object.bounds.bottom;
    await session.execute('Change font', [command(prefix, CommandType.TEXT_REPLACE, object.stableId, {
      semanticText: true, sourceX: sx, sourceY: sy, sourceW: sw, sourceH: sh, targetSourceX: sx, targetSourceY: sy, targetSourceW: sw, targetSourceH: sh,
      fontSize: object.fontSize,
      pageIndex: page.index, text: object.text, sourceText: object.text, fontOverride: true, fontKey, pdfFontName,
      fontWeight: /Bold/.test(pdfFontName) ? 'bold' : '', fontStyle: '', allowNaturalWidth: true, textBlock: false,
    })], [session.restoreCommand(prefix, before)]);
    state.model.markers.push({ pageId: page.id, text: String(object.text).trim(), kind: 'text.font', soft: true });
    touch(state, page.id);
    return { status: 'ok', detail: { page: page.index, font: pdfFontName } };
  },

  async 'image.add'(state, rng) {
    const { session } = state;
    const page = await choosePage(state, rng);
    const width = 48 + Math.floor(rng() * 64); const height = 32 + Math.floor(rng() * 48);
    const bytes = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      bytes[i] = (x * 255) / width; bytes[i + 1] = (y * 255) / height; bytes[i + 2] = 128; bytes[i + 3] = rng() < 0.3 ? 160 : 255;
    }
    const resource = { hash: await sha256Hex(bytes), kind: 'rgba8', width, height, bytes };
    await session.kernel.registerResource(resource);
    const bounds = placeRect(pageBox(page.inspection), rng, width * 1.5, height * 1.5);
    const id = uid('img');
    const prefix = uid('addimg');
    await session.execute('Add image', [command(prefix, CommandType.OBJECT_INSERT, id, { pageIndex: page.index, bounds, kind: 'image', resourceHash: resource.hash })],
      [command(`${prefix}:inv`, CommandType.OBJECT_DELETE, id, {})]);
    touch(state, page.id);
    return { status: 'ok', detail: { page: page.index, size: [width, height] } };
  },

  async 'shape.add'(state, rng) {
    const { session } = state;
    const page = await choosePage(state, rng);
    const bounds = placeRect(pageBox(page.inspection), rng, 120, 80);
    const id = uid('shape');
    const prefix = uid('addshape');
    const ellipse = rng() < 0.5;
    const fill = rng() < 0.5 ? Shell.pdfiumColorWithOpacity('#4caf50', 0.6) : undefined;
    const stroke = Shell.pdfiumColorWithOpacity('#1a237e', 1);
    let payload = { pageIndex: page.index, bounds, kind: 'rect', fillColor: fill, strokeColor: stroke, strokeWidth: 2 };
    if (ellipse) {
      const cx = (bounds.left + bounds.right) / 2; const cy = (bounds.bottom + bounds.top) / 2;
      const rx = (bounds.right - bounds.left) / 2; const ry = (bounds.top - bounds.bottom) / 2; const k = 0.5522847498307936;
      payload = { ...payload, kind: 'path', segments: [
        { op: 'move', x: cx + rx, y: cy },
        { op: 'bezier', x1: cx + rx, y1: cy + k * ry, x2: cx + k * rx, y2: cy + ry, x: cx, y: cy + ry },
        { op: 'bezier', x1: cx - k * rx, y1: cy + ry, x2: cx - rx, y2: cy + k * ry, x: cx - rx, y: cy },
        { op: 'bezier', x1: cx - rx, y1: cy - k * ry, x2: cx - k * rx, y2: cy - ry, x: cx, y: cy - ry },
        { op: 'bezier', x1: cx + k * rx, y1: cy - ry, x2: cx + rx, y2: cy - k * ry, x: cx + rx, y: cy },
        { op: 'close' },
      ] };
    }
    if (payload.fillColor === undefined) delete payload.fillColor;
    await session.execute('Add shape', [command(prefix, CommandType.OBJECT_INSERT, id, payload)],
      [command(`${prefix}:inv`, CommandType.OBJECT_DELETE, id, {})]);
    touch(state, page.id);
    return { status: 'ok', detail: { page: page.index, kind: payload.kind } };
  },

  async 'object.move'(state, rng) {
    const { session } = state;
    const page = await choosePageWith(state, rng, topLevelObjects);
    if (!page) return { status: 'n/a', detail: 'no top-level object' };
    const object = pick(rng, page.value);
    const m = object.matrix;
    const dx = (rng() - 0.5) * 60; const dy = (rng() - 0.5) * 60;
    const before = [m.a, m.b, m.c, m.d, m.e, m.f].map(Number);
    const after = [m.a, m.b, m.c, m.d, m.e + dx, m.f + dy].map(Number);
    const prefix = uid('move');
    await session.execute('Move object', [command(prefix, CommandType.OBJECT_TRANSFORM, object.stableId, { pageIndex: page.index, matrix: after })],
      [command(`${prefix}:inv`, CommandType.OBJECT_TRANSFORM, object.stableId, { pageIndex: page.index, matrix: before })]);
    touch(state, page.id);
    return { status: 'ok', detail: { page: page.index, type: object.typeName, dx: Math.round(dx), dy: Math.round(dy) } };
  },

  async 'object.delete'(state, rng) {
    const { session } = state;
    const page = await choosePageWith(state, rng, topLevelObjects);
    if (!page) return { status: 'n/a', detail: 'no top-level object' };
    const object = pick(rng, page.value);
    const prefix = uid('delobj');
    const before = await session.snapshot({ retain: true });
    await session.execute('Delete object', [command(prefix, CommandType.OBJECT_DELETE, object.stableId, { pageIndex: page.index })],
      [session.restoreCommand(prefix, before)]);
    const deletedText = normText(object.text || '');
    state.model.markers = state.model.markers.filter((item) => !(item.pageId === page.id && (
      (deletedText && deletedText.includes(item.text)) || (item.bounds && rectsIntersect(item.bounds, object.bounds)))));
    touch(state, page.id);
    return { status: 'ok', detail: { page: page.index, type: object.typeName } };
  },

  async 'annot.markup'(state, rng) {
    const { session } = state;
    const page = await choosePageWith(state, rng, (inspection) => textObjects(inspection));
    if (!page) return { status: 'n/a', detail: 'no text to mark up' };
    const object = pick(rng, page.value);
    const subtype = pick(rng, ['highlight', 'underline', 'strikeout']);
    const b = object.bounds;
    const id = uid('markup');
    const prefix = uid('markup');
    await session.execute(`Add ${subtype}`, [command(prefix, CommandType.ANNOTATION_SET, id, {
      pageIndex: page.index, subtypeName: subtype, bounds: b, opacity: 1,
      color: { highlight: '#fff176', underline: '#2563eb', strikeout: '#dc2626' }[subtype], borderWidth: 1,
      quadPoints: [b.left, b.top, b.right, b.top, b.left, b.bottom, b.right, b.bottom],
    })], [command(`${prefix}:inv`, CommandType.ANNOTATION_SET, id, { pageIndex: page.index, deleted: true })]);
    touch(state, page.id);
    return { status: 'ok', detail: { page: page.index, subtype } };
  },

  async 'annot.shape'(state, rng) {
    const { session } = state;
    const page = await choosePage(state, rng);
    const subtype = pick(rng, ['square', 'circle', 'line', 'ink']);
    const bounds = placeRect(pageBox(page.inspection), rng, 140, 90);
    const id = uid('annot');
    const prefix = uid('annot');
    const payload = { pageIndex: page.index, subtypeName: subtype, bounds, opacity: 1 };
    if (subtype === 'square' || subtype === 'circle') {
      Object.assign(payload, { fillColor: '#ffeb3b', strokeColor: '#e65100', fillEnabled: rng() < 0.5, strokeEnabled: true, borderWidth: 2 });
    } else if (subtype === 'line') {
      Object.assign(payload, { line: [bounds.left, bounds.bottom, bounds.right, bounds.top], lineEndings: [0, 5],
        arrowTip: 'filled', arrowTipStart: 'none', arrowTipEnd: 'filled', color: '#15803d', borderWidth: 2 });
    } else {
      const points = Array.from({ length: 12 }, (_, i) => [bounds.left + (i / 11) * (bounds.right - bounds.left),
        bounds.bottom + (0.5 + 0.4 * Math.sin(i)) * (bounds.top - bounds.bottom)]);
      Object.assign(payload, { inkPoints: points, color: '#15803d', borderWidth: 2 });
    }
    await session.execute(`Add ${subtype}`, [command(prefix, CommandType.ANNOTATION_SET, id, payload)],
      [command(`${prefix}:inv`, CommandType.ANNOTATION_SET, id, { pageIndex: page.index, deleted: true })]);
    touch(state, page.id);
    return { status: 'ok', detail: { page: page.index, subtype } };
  },

  async 'annot.comment'(state, rng) {
    const { session } = state;
    const page = await choosePage(state, rng);
    const box = pageBox(page.inspection);
    const bounds = placeRect(box, rng, 24, 24);
    const id = uid('note');
    const prefix = uid('note');
    const contents = `Comment ${marker(rng)} äöü €`;
    await session.execute('Add comment', [command(prefix, CommandType.ANNOTATION_SET, id, {
      pageIndex: page.index, subtypeName: 'text', bounds, contents, title: 'Corpus suite', color: '#facc15', opacity: 1,
    })], [command(`${prefix}:inv`, CommandType.ANNOTATION_SET, id, { pageIndex: page.index, deleted: true })]);
    state.model.annotationContents.push({ pageId: page.id, contents, bounds });
    touch(state, page.id);
    return { status: 'ok', detail: { page: page.index } };
  },

  async 'annot.freetext'(state, rng) {
    // FreeText annotation; the signature variant uses the italic standard font as the typed signature does.
    const { session } = state;
    const page = await choosePage(state, rng);
    const signature = rng() < 0.4;
    const text = signature ? `Signed ${marker(rng)}` : `Note ${marker(rng)}`;
    const bounds = placeRect(pageBox(page.inspection), rng, 180, 36);
    const id = uid('freetext');
    const prefix = uid('freetext');
    await session.execute(signature ? 'Add signature' : 'Add text box', [command(prefix, CommandType.ANNOTATION_SET, id, {
      pageIndex: page.index, subtypeName: 'freetext', bounds, contents: text, opacity: 1,
      fontColor: '#111111', fontSize: signature ? 16 : 11, fontFamily: signature ? 7 : 4,
      backgroundColor: signature ? 'transparent' : '#fffde7', borderColor: signature ? 'transparent' : '#9e9e9e', borderWidth: signature ? 0 : 1,
    })], [command(`${prefix}:inv`, CommandType.ANNOTATION_SET, id, { pageIndex: page.index, deleted: true })]);
    state.model.annotationContents.push({ pageId: page.id, contents: text, bounds });
    touch(state, page.id);
    return { status: 'ok', detail: { page: page.index, signature } };
  },

  async 'redact.area'(state, rng) {
    const { session, model } = state;
    const page = await choosePageWith(state, rng, (inspection) => textObjects(inspection));
    if (!page) return { status: 'n/a', detail: 'no text to redact' };
    const object = pick(rng, page.value);
    const rect = { ...object.bounds };
    await addRedaction(state, page, [rect]);
    model.redactions.push({ pageId: page.id, rects: [rect], text: String(object.text).slice(0, 60) });
    touch(state, page.id);
    return { status: 'ok', detail: { page: page.index, text: String(object.text).slice(0, 40) } };
  },

  async 'redact.find'(state, rng) {
    const { session, model } = state;
    const count = editablePageCount(state);
    const start = Math.floor(rng() * count);
    for (let attempt = 0; attempt < Math.min(4, count); attempt += 1) {
      const index = (start + attempt) % count;
      const glyphs = await session.glyphs(index);
      const text = glyphs.map((glyph) => glyph.char || ' ').join('');
      const words = [...new Set(text.match(/[\p{L}\p{N}]{4,}/gu) || [])];
      if (!words.length) continue;
      const word = pick(rng, words);
      const matches = findGlyphTextMatches(glyphs, word, { caseSensitive: true });
      if (!matches.length) continue;
      const rects = matches.flatMap((match) => match.rects);
      const pageId = session.pageIds[index];
      await addRedaction(state, { index, id: pageId }, rects);
      model.redactions.push({ pageId, rects, word, occurrences: matches.length });
      touch(state, pageId);
      return { status: 'ok', detail: { page: index, word, matches: matches.length } };
    }
    return { status: 'n/a', detail: 'no extractable words' };
  },

  async 'stamp.watermark'(state, rng) {
    const text = `${pick(rng, ['CONFIDENTIAL', 'DRAFT', 'ENTWURF'])} ${marker(rng)}`;
    const image = rng() < 0.3;
    let stamp = { kind: PAGE_STAMP_KINDS.watermark, text, color: '#111111', opacity: 0.18 };
    if (image) stamp = { kind: PAGE_STAMP_KINDS.watermark, image: { bytes: tinyPng(), mime: 'image/png' }, opacity: 0.25 };
    await applyStamp(state, 'Add watermark', stamp);
    // Checked on a page that existed when it was stamped (a blank page inserted later has no stamp).
    if (!image) state.model.stampTexts.push({ text, pageIds: state.model.pages.map((page) => page.id) });
    return { status: 'ok', detail: { image, pages: state.model.pages.length } };
  },

  async 'stamp.pageNumbers'(state) {
    await applyStamp(state, 'Add page numbers', {
      kind: PAGE_STAMP_KINDS.pageNumber, replace: true, pageText: (pageIndex) => `${pageIndex + 1}`, fontSize: 12, color: '#111111', opacity: 0.9,
    });
    state.model.pageNumbers = true;
    return { status: 'ok', detail: { pages: state.model.pages.length } };
  },

  async 'ocr.layer'(state, rng) {
    // Make searchable with synthetic recognition results: the same ocr.insert transaction OCR produces.
    const { session } = state;
    const page = await choosePage(state, rng);
    const box = pageBox(page.inspection);
    if (!notoSans) notoSans = new Uint8Array(await (await fetch(`${VENDOR}pdf-tools/fallback-fonts/NotoSans-Regular.ttf`)).arrayBuffer());
    const measure = createAdvanceMeasurer(notoSans);
    const texts = [marker(rng), 'searchable', marker(rng), 'Grüße'];
    // Sized so the whole line stays inside the page: readers drop glyphs outside the crop box.
    const natural = texts.reduce((sum, text) => sum + Math.max(10, measure(text) * 14 || text.length * 14 * 0.55) + 14 * 0.4, 0);
    const size = Math.max(2, Math.min(14, 14 * (box.width * 0.8) / natural));
    let x = box.left + box.width * 0.1; const y = box.bottom + box.height * (0.2 + 0.6 * rng());
    const words = texts.map((text) => {
      const width = Math.max(10, measure(text) * size || text.length * size * 0.55);
      const word = { text, basis: { origin: [x, y], baseline: [x + width, y], ascent: [x, y + size] }, advance: measure(text) };
      x += width + size * 0.4;
      return word;
    });
    await insertOcrWords(state, page, words);
    const ocrBounds = { left: words[0].basis.origin[0], bottom: y - size * 0.3, right: x, top: y + size };
    state.model.markers.push({ pageId: page.id, text: texts[0], kind: 'ocr.layer', bounds: ocrBounds }, { pageId: page.id, text: texts[2], kind: 'ocr.layer', bounds: ocrBounds });
    touch(state, page.id);
    return { status: 'ok', detail: { page: page.index, words: words.length } };
  },

  async 'ocr.tesseract'(state, rng) {
    // Real OCR (Tesseract, as Make searchable runs it) of one page rendered with PDF.js.
    const { session } = state;
    const index = Math.floor(rng() * Math.min(session.pageIds.length, 3));
    const pdf = await Shell.openPdfJsDocument(await session.engine.checkpoint().then((value) => asBytes(value.bytes)));
    let words = [];
    try {
      const pdfPage = await pdf.getPage(index + 1);
      const viewport = pdfPage.getViewport({ scale: 2 });
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(viewport.width)); canvas.height = Math.max(1, Math.round(viewport.height));
      await pdfPage.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      if (!notoSans) notoSans = new Uint8Array(await (await fetch(`${VENDOR}pdf-tools/fallback-fonts/NotoSans-Regular.ttf`)).arrayBuffer());
      const measure = createAdvanceMeasurer(notoSans);
      const data = await withOcrWorker('eng', {}, async (worker) => (await worker.recognize(canvas, {}, { words: true, blocks: true })).data);
      for (const word of ocrTextLayerWords(data)) {
        const origin = viewport.convertToPdfPoint(...word.origin).map(Number);
        const baseline = viewport.convertToPdfPoint(...word.baseline).map(Number);
        const ascent = viewport.convertToPdfPoint(...word.ascent).map(Number);
        const bv = [baseline[0] - origin[0], baseline[1] - origin[1]]; const av = [ascent[0] - origin[0], ascent[1] - origin[1]];
        if (Math.hypot(...bv) < 0.5 || Math.hypot(...av) < 0.5 || Math.abs(bv[0] * av[1] - bv[1] * av[0]) < 0.25) continue;
        words.push({ text: word.text, basis: { origin, baseline, ascent }, advance: measure(word.text) });
      }
    } finally { await pdf.destroy?.(); }
    if (!words.length) return { status: 'n/a', detail: 'OCR recognised no words' };
    words = words.slice(0, 20_000);
    await insertOcrWords(state, { index, id: session.pageIds[index] }, words);
    const sample = words.map((word) => word.text).filter((text) => /^[A-Za-z]{5,}$/.test(text)).slice(0, 3);
    for (const text of sample) state.model.markers.push({ pageId: session.pageIds[index], text, kind: 'ocr.tesseract', soft: true });
    touch(state, session.pageIds[index]);
    return { status: 'ok', detail: { page: index, words: words.length } };
  },
};

function tinyPng() {
  // 2x2 opaque PNG (red/green/blue/white) without a canvas round trip.
  return Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP4z8DAwMDAxMDAwMDAAAANBQEBxQ0d1gAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0));
}

async function addRedaction(state, page, rects) {
  const { session } = state;
  // A redaction removes every glyph it touches, including text this run added earlier.
  state.model.markers = state.model.markers.filter((item) => !(item.pageId === page.id &&
    (!item.bounds || rects.some((rect) => rectsIntersect(rect, item.bounds)))));
  // Annotations under a redaction are removed on export, as in Acrobat.
  state.model.annotationContents = state.model.annotationContents.filter((item) => !(item.pageId === page.id &&
    (!item.bounds || rects.some((rect) => rectsIntersect(rect, item.bounds)))));
  const prefix = uid('redact');
  const commands = []; const inverse = [];
  rects.forEach((rect, i) => {
    const id = uid('redact');
    commands.push(command(`${prefix}:${i}`, CommandType.ANNOTATION_SET, id, {
      pageIndex: page.index, subtypeName: 'redact', bounds: rect, opacity: 1,
      fillColor: '#000000', strokeColor: '#000000', fillEnabled: true, strokeEnabled: true, borderWidth: 0,
    }));
    inverse.unshift(command(`${prefix}:${i}:inv`, CommandType.ANNOTATION_SET, id, { pageIndex: page.index, deleted: true }));
  });
  await session.execute('Mark redactions', commands, inverse);
}

async function applyStamp(state, label, stamp) {
  const { session } = state;
  const before = await Shell.checkpointToPdfSnapshotResource(session.engine);
  const stamped = await stampPdfPages(globalThis.PDFLib, before.bytes, stamp);
  if (stamped.pageCount !== session.pageIds.length) throw new Error(`stamp covered ${stamped.pageCount} of ${session.pageIds.length} pages`);
  const after = await Shell.pdfSnapshotResourceFromBytes(stamped.bytes, before.bindings);
  await session.kernel.registerResource(before);
  await session.kernel.registerResource(after);
  const prefix = uid('stamp');
  await session.execute(label, [command(`${prefix}:stamp`, CommandType.DOCUMENT_RESTORE_SNAPSHOT, session.documentKey, { resourceHash: after.hash })],
    [command(`${prefix}:restore`, CommandType.DOCUMENT_RESTORE_SNAPSHOT, session.documentKey, { resourceHash: before.hash })]);
  for (const page of state.model.pages) page.touched = true;
}

async function insertOcrWords(state, page, words) {
  const { session } = state;
  const used = new Set();
  for (const word of words) for (const char of word.text) used.add(char.codePointAt(0));
  const fontBytes = subsetTrueTypeFont(notoSans, used).bytes;
  const fontResourceHash = await sha256Hex(fontBytes);
  await session.kernel.registerResource({ hash: fontResourceHash, kind: 'font', format: 'ttf', family: 'Noto Sans', bytes: fontBytes });
  const before = await session.snapshot({ retain: true });
  const prefix = uid('ocr');
  await session.execute('Make searchable', [command(prefix, CommandType.OCR_INSERT, `${session.documentKey}:ocr:${prefix}:${page.id}`, {
    pageIndex: page.index, pageId: page.id, language: 'eng', fontResourceHash, layout: 'baseline', words,
  })], [session.restoreCommand(prefix, before)]);
}

// ---------------------------------------------------------------------------------------------------------------
// Document-level operations on exported bytes (each independent; results are uploaded for the runner's checks)

const DOC_OPS = {
  async 'doc.metadata'(ctx) {
    const metadata = { title: `Corpus title ${ctx.tag} Ärger`, author: 'berg:work corpus suite', subject: 'Subject', keywords: 'corpus, test', creator: 'bw', producer: 'bw' };
    const doc = { ...ctx.exportDoc, metadata };
    const bytes = await Shell.postprocessPdfiumExportBytes(ctx.bytes, doc, {});
    const back = await Shell.readPdfMetadata(bytes);
    const ok = String(back?.title || '').includes(ctx.tag);
    return { bytes, checks: [{ name: 'metadata.title', ok, detail: String(back?.title || '').slice(0, 80) }] };
  },
  async 'doc.stripMetadata'(ctx) {
    const bytes = await Shell.postprocessPdfiumExportBytes(ctx.bytes, ctx.exportDoc, { stripMetadata: true });
    const back = await Shell.readPdfMetadata(bytes);
    const leftovers = ['title', 'author', 'subject', 'keywords'].filter((key) => String(back?.[key] || '').trim());
    return { bytes, checks: [{ name: 'metadata.stripped', ok: !leftovers.length, detail: leftovers.join(',') }] };
  },
  async 'doc.bookmarks'(ctx) {
    const pages = ctx.exportDoc.pages;
    const bookmarks = pages.slice(0, 3).map((page, index) => ({ id: uid('bm'), title: `Bookmark ${index + 1} ${ctx.tag}`, pageId: page.id, depth: 0 }));
    const bytes = await Shell.pdfBytesWithBookmarks(ctx.bytes, { ...ctx.exportDoc, bookmarks }, pages);
    const pdf = await Shell.openPdfJsDocument(bytes);
    try {
      const outline = await pdf.getOutline();
      const titles = (outline || []).map((item) => item.title);
      return { bytes, checks: [{ name: 'bookmarks.present', ok: titles.some((title) => title.includes(ctx.tag)), detail: titles.slice(0, 3).join(' | ').slice(0, 120) }] };
    } finally { await pdf.destroy?.(); }
  },
  async 'doc.split'(ctx) {
    const toolkit = await Shell.getPdfToolkit();
    const count = ctx.expectedPages;
    const pages = count > 2 ? [1, count] : [1];
    const bytes = asBytes(await toolkit.extractPages(ctx.bytes, { pages }));
    return { bytes, expectPages: pages.length, checks: [] };
  },
  async 'doc.compress'(ctx) {
    const blob = await Shell.compressEditedPdf(ctx.exportDoc, 'vector', null, ctx.bytes);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return { bytes, expectPages: ctx.expectedPages, checks: [{ name: 'compress.notLarger', ok: bytes.byteLength <= ctx.bytes.byteLength * 1.02, detail: `${ctx.bytes.byteLength} -> ${bytes.byteLength}` }] };
  },
  async 'doc.compressImages'(ctx) {
    const blob = await Shell.compressEditedPdf(ctx.exportDoc, 'images', null, ctx.bytes, { dpi: 96, quality: 0.6 });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return { bytes, expectPages: ctx.expectedPages, checks: [{ name: 'compressImages.notLarger', ok: bytes.byteLength <= ctx.bytes.byteLength * 1.02, detail: `${ctx.bytes.byteLength} -> ${bytes.byteLength}` }] };
  },
  async 'doc.rasterize'(ctx) {
    const blob = await Shell.compressEditedPdf(ctx.exportDoc, 'small', null, ctx.bytes);
    return { bytes: new Uint8Array(await blob.arrayBuffer()), expectPages: ctx.expectedPages, checks: [] };
  },
  async 'doc.encrypt'(ctx) {
    const owner = `own-${ctx.tag}`; const user = `usr-${ctx.tag}`;
    const bytes = await Shell.restrictPdfBytes(ctx.bytes, { print: true, copy: false, modify: false, annotate: true }, owner, user);
    const checks = [];
    // Wrong password must fail, the user password must open it with PDFium.
    let wrongOpened = false;
    try { const s = await Session.open(bytes, { password: 'wrong' }); wrongOpened = true; await s.close(); } catch { /* expected */ }
    checks.push({ name: 'encrypt.wrongPasswordRefused', ok: !wrongOpened });
    const opened = await Session.open(bytes, { password: user });
    checks.push({ name: 'encrypt.userPasswordOpens', ok: opened.pageIds.length === ctx.expectedPages, detail: `${opened.pageIds.length}/${ctx.expectedPages}` });
    await opened.close();
    return { bytes, password: user, checks };
  },
  async 'doc.formFill'(ctx) {
    if (!ctx.formFields?.length) return { na: 'no fillable fields' };
    const values = {};
    for (const field of ctx.formFields.slice(0, 12)) values[field.key] = field.value;
    const flatten = ctx.rng() < 0.4;
    const bytes = asBytes(await Shell.fillMaterializedFormPdfBytes(ctx.bytes, values, flatten));
    const checks = [];
    // Filled text values must be readable back (pdf-lib) unless flattened; flattened ones must appear as page text.
    const pdf = await globalThis.PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    if (!flatten) {
      let readable = 0; let expected = 0;
      try {
        const form = pdf.getForm();
        for (const field of ctx.formFields.slice(0, 12)) {
          if (field.kind !== 'text') continue;
          expected += 1;
          try { if (String(form.getTextField(field.name).getText() || '') === field.value) readable += 1; } catch { /* missing */ }
        }
      } catch { /* no form */ }
      checks.push({ name: 'form.valuesReadBack', ok: readable === expected, detail: `${readable}/${expected}` });
    }
    return { bytes, flatten, checks };
  },
};

async function formFieldsOf(bytes) {
  const out = [];
  try {
    const pdf = await globalThis.PDFLib.PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
    const form = pdf.getForm();
    const seen = new Set();
    for (const field of form.getFields()) {
      const name = field.getName();
      // Separate field dicts may share one full name; they hold one value, so expect it once.
      if (seen.has(name)) continue;
      seen.add(name);
      const { PDFTextField, PDFCheckBox } = globalThis.PDFLib;
      if (field instanceof PDFTextField) {
        if (field.isReadOnly?.()) continue;
        const max = field.getMaxLength?.();
        out.push({ name, key: name, kind: 'text', value: `bw${out.length}`.slice(0, max || 8) });
      } else if (field instanceof PDFCheckBox) out.push({ name, key: name, kind: 'check', value: 'true' });
    }
  } catch { /* not a form */ }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// One file

/**
 * @param {{ id: string, url: string, password?: string|null, seed: number, ops: Array<{op: string, params?: object}>,
 *   docOps: string[], undo: boolean, project: boolean, uiLoad: boolean, outPrefix: string, budgetMs: number }} job
 */
export async function runFile(job) {
  const started = performance.now();
  const steps = [];
  const checks = [];
  const outputs = [];
  const result = { id: job.id, seed: job.seed, steps, checks, outputs };
  const deadline = started + (job.budgetMs || 60_000);
  const rngFor = (salt) => mulberry32((job.seed ^ Math.imul(salt + 1, 0x9E3779B1)) >>> 0);
  const step = async (op, fn, { fatal = false, timeoutMs = 30_000 } = {}) => {
    const t0 = performance.now();
    const entry = { op, status: 'ok', ms: 0 };
    steps.push(entry);
    if (performance.now() > deadline) { entry.status = 'skipped'; entry.detail = 'file budget exhausted'; return null; }
    if (result.workerPoisoned) { entry.status = 'skipped'; entry.detail = 'PDFium worker failed earlier in this file'; return null; }
    const limit = Math.min(timeoutMs, Math.max(1000, deadline - performance.now()));
    try {
      const value = await withTimeout(Promise.resolve().then(fn), limit, op);
      if (value?.status) { entry.status = value.status; entry.detail = value.detail; } else if (value?.detail) entry.detail = value.detail;
      return value ?? true;
    } catch (error) {
      const info = errorInfo(error);
      if (POISON.test(info.message) || info.code === 'timeout' || info.code === 'session-tainted') result.workerPoisoned = info.message.slice(0, 120);
      if (info.code === 'timeout' && limit < timeoutMs) {
        entry.status = 'skipped'; entry.detail = `file budget exhausted during the step (${Math.round(limit)} ms)`;
        if (fatal) throw Object.assign(new Error(`fatal ${op}`), { fatalStep: entry });
        return null;
      }
      // Undo/redo of a committed edit must never be refused: that is a history failure.
      entry.status = REFUSAL_CODES.has(info.code) && !op.startsWith('history.') ? 'refused' : 'fail';
      entry.error = info;
      if (fatal) throw Object.assign(new Error(`fatal ${op}`), { fatalStep: entry });
      return null;
    } finally { entry.ms = Math.round(performance.now() - t0); }
  };
  const check = (name, ok, detail) => { checks.push({ name, ok: Boolean(ok), ...(detail != null ? { detail } : {}) }); return ok; };

  INSPECT_ALL_LIMIT = job.inspectPages ?? 40;
  const state = { model: { pages: [], markers: [], redactions: [], stampTexts: [], annotationContents: [], pageNumbers: false } };
  let session = null; let reopened = null; let uiDoc = null;
  try {
    const original = new Uint8Array(await (await fetch(job.url)).arrayBuffer());
    state.originalBytes = original;
    state.password = job.password || '';
    result.bytes = original.byteLength;

    // UI open path (PDF.js document model the editor builds), then the PDFium session as the editor opens it.
    if (job.uiLoad) {
      await step('open.ui', async () => {
        uiDoc = await Shell.loadPdfFile(new File([original], job.id.split('/').pop() || 'file.pdf', { type: 'application/pdf' }), null, state.password);
        return { detail: { pages: uiDoc.pages?.length, live: Boolean(Shell.sourceForLivePdfiumSession(uiDoc)) } };
      });
    }
    const liveSource = uiDoc ? Shell.sourceForLivePdfiumSession(uiDoc) : null;
    const sessionBytes = liveSource?.bytes?.byteLength ? asBytes(liveSource.bytes).slice() : original.slice();
    await step('open.engine', async () => {
      session = await Session.open(sessionBytes, {
        password: state.password, pageIds: uiDoc?.pages?.length ? uiDoc.pages.map((page) => page.id) : null,
        documentKey: uiDoc?.id || uid('doc'),
      });
      state.session = session;
      session.refreshAll = job.refreshAll === true;
      return { detail: { pages: session.pageIds.length } };
    }, { fatal: true, timeoutMs: 45_000 });
    if (!session) throw Object.assign(new Error('no PDFium session'), { fatalStep: steps[steps.length - 1] });
    state.originalPageCount = session.pageIds.length;
    result.pages = session.pageIds.length;

    // Baseline: inspection, text and low-resolution renders of the first pages.
    const baseline = new Map();
    await step('baseline', async () => {
      const count = Math.min(job.baselinePages ?? config.baselinePages, session.pageIds.length);
      let objects = 0;
      for (let index = 0; index < Math.min(session.pageIds.length, INSPECT_ALL_LIMIT); index += 1) {
        const inspection = await session.inspect(index);
        objects += inspection?.objects?.length || 0;
        if (index >= count) continue;
        const render = await session.render(index);
        baseline.set(session.pageIds[index], { render, text: await session.text(index), rotation: Number(inspection?.rotation || 0),
          width: inspection?.width, height: inspection?.height });
      }
      return { detail: { pages: count, inspected: Math.min(session.pageIds.length, INSPECT_ALL_LIMIT), objects } };
    }, { timeoutMs: 60_000 });
    state.model.pages = session.pageIds.map((id, index) => ({ id, rotation: null, width: null, height: null, touched: false, origin: index }));
    // Rotation of pages is read lazily: rotate needs the current value.
    for (const page of state.model.pages) {
      const known = baseline.get(page.id);
      if (known) page.rotation = known.rotation;
    }

    // Edits
    let index = 0;
    for (const planned of job.ops) {
      const fn = OPS[planned.op];
      const rng = rngFor(index += 1);
      if (!fn) { steps.push({ op: planned.op, status: 'n/a', detail: 'unknown op' }); continue; }
      await step(planned.op, async () => {
        const outcome = await fn(state, rng, planned.params || {});
        // Edits that can remove or rewrite existing text (including the stamp line and earlier markers moved into
        // their way) make the stamp expectations unverifiable.
        if (['redact.area', 'redact.find', 'object.delete', 'object.move', 'text.edit', 'text.font'].includes(planned.op) && outcome?.status === 'ok') {
          for (const stamp of state.model.stampTexts) stamp.soft = true;
          if (planned.op === 'object.move') for (const item of state.model.markers) item.bounds = null;
        }
        return outcome;
      });
      if (session.engine.state === 'tainted') { check('session.notTainted', false, `after ${planned.op}`); break; }
    }
    const editsCommitted = session.kernel.entries.filter((entry) => entry.status === 'committed').length;
    result.committed = editsCommitted;

    // Undo everything, compare with the baseline, redo everything.
    if (job.undo && session.kernel.canUndo && session.engine.state !== 'tainted') {
      let undone = 0;
      const undoOk = await step('history.undoAll', async () => {
        try {
          while (session.kernel.canUndo && undone < 100) {
            const result = await session.kernel.undo(); undone += 1;
            if (Array.isArray(result?.pageIds)) session.pageIds = [...result.pageIds];
            await session.refresh(result);
          }
        } catch (error) {
          throw Object.assign(error, { message: `undo #${undone + 1} (${session.labels?.[session.labels.length - 1 - undone]}): ${error.message}` });
        }
        return { detail: { undone } };
      }, { timeoutMs: 15_000 + 8_000 * editsCommitted });
      if (!undoOk) state.redoOk = null;
      if (undoOk) {
        const checkpoint = await session.engine.checkpoint();
        const ids = checkpoint.pageIds || [];
        check('undo.pageCount', ids.length === state.originalPageCount, `${ids.length}/${state.originalPageCount}`);
        session.pageIds = ids;
        for (const [pageId, base] of baseline) {
          const pageIndex = ids.indexOf(pageId);
          if (pageIndex < 0) { check('undo.pageRestored', false, pageId); continue; }
          const render = await session.render(pageIndex);
          const diff = render.hash === base.render.hash ? { comparable: true, ratio: 0 } : pixelDiff(render, base.render);
          const ok = check('undo.pixels', diff.comparable && diff.ratio <= 0.01, `page ${pageIndex + 1} diff ${(diff.ratio * 100).toFixed(2)}%`);
          if (!ok) {
            const a = await uploadRender(`${job.outPrefix}.undo-p${pageIndex + 1}-before.png`, base.render);
            const b = await uploadRender(`${job.outPrefix}.undo-p${pageIndex + 1}-after.png`, render);
            if (a && b) outputs.push({ kind: 'image', name: a, image: true }, { kind: 'image', name: b, image: true });
          }
        }
        let redone = 0;
        state.redoOk = await step('history.redoAll', async () => {
          try {
            while (session.kernel.canRedo && redone < 100) {
              const result = await session.kernel.redo(); redone += 1;
              if (Array.isArray(result?.pageIds)) session.pageIds = [...result.pageIds];
              await session.refresh(result);
            }
          } catch (error) {
            throw Object.assign(error, { message: `redo #${redone + 1} (${session.labels?.[redone]}): ${error.message}` });
          }
          return { detail: { redone } };
        }, { timeoutMs: 15_000 + 8_000 * editsCommitted });
        const after = await session.engine.checkpoint();
        session.pageIds = after.pageIds || session.pageIds;
        if (state.redoOk) check('redo.pageOrder', JSON.stringify(after.pageIds || []) === JSON.stringify(state.model.pages.map((page) => page.id)),
          `${(after.pageIds || []).length} pages`);
      }
    }

    // Save: the editor's export pipeline.
    let exported = null;
    const exportDoc = {
      ...(uiDoc || {}),
      pages: state.model.pages.map((page) => ({ id: page.id })),
      metadata: uiDoc?.metadata, originalMetadata: uiDoc?.originalMetadata || uiDoc?.metadata,
      formValues: {},
      bookmarks: uiDoc?.bookmarks,
    };
    await step('save.export', async () => {
      const raw = await session.engine.export();
      const commands = session.kernel.entries.filter((entry) => entry.status === 'committed').flatMap((entry) => entry.transaction.commands);
      let bytes = await Shell.repairGeneratedFreeTextAppearances(raw.bytes, commands);
      bytes = await Shell.postprocessPdfiumExportBytes(bytes, exportDoc, {});
      exported = asBytes(bytes);
      if (!Number.isFinite(raw.appliedRedactions) && state.model.redactions.length) throw new Error('export reported no redaction count');
      const name = `${job.outPrefix}.edited.pdf`;
      await upload(name, exported);
      outputs.push({ kind: 'edited', name, bytes: exported.byteLength, expectPages: state.redoOk === null ? null : state.model.pages.length,
        redactions: state.redoOk === null ? [] : state.model.redactions.map((item) => ({ pageIndex: state.model.pages.findIndex((page) => page.id === item.pageId), rects: item.rects, word: item.word })),
        password: '' });
      return { detail: { bytes: exported.byteLength, appliedRedactions: raw.appliedRedactions } };
    }, { timeoutMs: 60_000 });

    // After a failed redo the document no longer matches the model; only structural checks remain meaningful.
    if (exported && state.redoOk === null) check('verify.skippedAfterHistoryFailure', true, 'model checks skipped');
    else if (exported) await verifyExport(state, exported, baseline, { step, check, job });

    // Project save and reopen: the portable native state the .bwpdf project carries, restored through the same path
    // the editor uses for an inactive document (journal store + semantic kernel recovery + export).
    if (job.project && uiDoc && session.engine.state !== 'tainted' && state.redoOk !== null) {
      await step('project.roundtrip', async () => {
        const nativeState = await session.kernel.exportPortableState();
        const project = Shell.serializePdfProjectEntries([{ doc: { ...uiDoc, kernelUiRevision: session.engine.revision }, nativeState }], uiDoc.id);
        const file = new File([JSON.stringify(project)], 'corpus.bwpdf', { type: 'application/json' });
        const loaded = await Shell.loadFernworkPdfProjectFile(file);
        const doc = loaded.docs[0];
        const bytes = await Shell.materializeDurableNativePdfBytes({ ...doc, kernelUiRevision: session.engine.revision });
        if (!bytes?.byteLength) throw new Error('project reopen produced no PDF');
        const name = `${job.outPrefix}.project.pdf`;
        await upload(name, bytes);
        outputs.push({ kind: 'project', name, bytes: bytes.byteLength, expectPages: state.redoOk === null ? null : state.model.pages.length, password: '' });
        const back = await Session.open(asBytes(bytes));
        try { check('project.pageCount', back.pageIds.length === state.model.pages.length, `${back.pageIds.length}/${state.model.pages.length}`); }
        finally { await back.close(); }
        try { await new IndexedDbCommandJournalStore().deleteDocument(doc.id); } catch { /* cleanup only */ }
        return { detail: { bytes: bytes.byteLength } };
      }, { timeoutMs: 60_000 });
    }

    // Document-level operations on the saved bytes.
    // Derived files are compared with what the saved file really has (the model can be off after a history failure).
    const savedPages = exported ? (await Session.open(exported.slice()).then(async (back) => { const n = back.pageIds.length; await back.close(); return n; }).catch(() => state.model.pages.length)) : 0;
    if (exported && job.docOps?.length) {
      const fields = job.docOps.includes('doc.formFill') ? await formFieldsOf(exported) : [];
      let salt = 1000;
      for (const op of job.docOps) {
        const ctx = { bytes: exported, exportDoc, expectedPages: savedPages, tag: marker(rngFor(salt)), rng: rngFor(salt += 1), formFields: fields };
        await step(op, async () => {
          const value = await DOC_OPS[op](ctx);
          if (value?.na) return { status: 'n/a', detail: value.na };
          for (const item of value.checks || []) check(item.name, item.ok, item.detail);
          const name = `${job.outPrefix}.${op.replace(/^doc\./, '')}.pdf`;
          await upload(name, value.bytes);
          outputs.push({ kind: op, name, bytes: value.bytes.byteLength, expectPages: value.expectPages ?? savedPages, password: value.password || '', flatten: value.flatten });
          // Every derived file must reopen in PDFium with the expected page count.
          const back = await Session.open(asBytes(value.bytes), { password: value.password || '' });
          try { check(`${op}.reopen`, back.pageIds.length === (value.expectPages ?? savedPages), `${back.pageIds.length}`); }
          finally { await back.close(); }
          return { detail: { bytes: value.bytes.byteLength } };
        }, { timeoutMs: op === 'doc.rasterize' ? 120_000 : 60_000 });
      }
    }
  } catch (error) {
    if (!error?.fatalStep) steps.push({ op: 'harness', status: 'fail', error: errorInfo(error) });
  } finally {
    if (result.workerPoisoned) {
      resetWorker();
      session = null; reopened = null;
    }
    await session?.close();
    await reopened?.close();
    for (const source of uiDoc?.sources || []) { try { await source.pdf?.destroy?.(); } catch { /* ignore */ } }
    result.ms = Math.round(performance.now() - started);
    result.model = { pages: state.model.pages.length, markers: state.model.markers.length, redactions: state.model.redactions.length };
  }
  return result;
}

async function verifyExport(state, bytes, baseline, { step, check, job }) {
  const { model } = state;
  // 1. PDFium reopen: page count, rotation, blank page size, markers, redactions, pixel stability of untouched pages.
  await step('verify.pdfium', async () => {
    const back = await Session.open(bytes.slice());
    try {
      check('pdfium.pageCount', back.pageIds.length === model.pages.length, `${back.pageIds.length}/${model.pages.length}`);
      const texts = new Map();
      // A page whose text PDFium cannot extract is reported once and its text checks are skipped.
      const textOf = async (pageIndex) => {
        if (!texts.has(pageIndex)) {
          try { texts.set(pageIndex, normText(await back.text(pageIndex))); }
          catch (error) { texts.set(pageIndex, null); check('pdfium.extractText', false, `page ${pageIndex + 1}: ${errorInfo(error).message}`); }
        }
        return texts.get(pageIndex);
      };
      const limit = Math.min(back.pageIds.length, model.pages.length);
      for (let pageIndex = 0; pageIndex < limit; pageIndex += 1) {
        const page = model.pages[pageIndex];
        const needs = page.rotation != null || page.blank || baseline.has(page.id) || model.markers.some((item) => item.pageId === page.id) ||
          model.redactions.some((item) => item.pageId === page.id);
        if (!needs) continue;
        const inspection = await back.inspect(pageIndex);
        if (page.rotation != null) check('pdfium.rotation', Number(inspection?.rotation || 0) === page.rotation, `page ${pageIndex + 1}: ${inspection?.rotation} vs ${page.rotation}`);
        if (page.blank) check('pdfium.blankSize', Math.abs((inspection?.unrotatedWidth || 0) - page.width) < 1 && Math.abs((inspection?.unrotatedHeight || 0) - page.height) < 1,
          `page ${pageIndex + 1}: ${inspection?.unrotatedWidth}x${inspection?.unrotatedHeight}`);
        const base = baseline.get(page.id);
        if (base && !page.touched && !model.pageNumbers && !model.stampTexts.length) {
          const render = await back.render(pageIndex);
          const diff = render.hash === base.render.hash ? { comparable: true, ratio: 0 } : pixelDiff(render, base.render);
          const ok = check('pdfium.untouchedPixels', diff.comparable && diff.ratio <= 0.005, `page ${pageIndex + 1} diff ${(diff.ratio * 100).toFixed(2)}%`);
          if (!ok) {
            await uploadRender(`${job.outPrefix}.saved-p${pageIndex + 1}-before.png`, base.render);
            await uploadRender(`${job.outPrefix}.saved-p${pageIndex + 1}-after.png`, render);
          }
        }
        for (const item of model.markers.filter((entry) => entry.pageId === page.id && !entry.soft)) {
          const pageText = await textOf(pageIndex);
          if (pageText == null) continue;
          check(`pdfium.text.${item.kind}`, (item.words || [item.text]).every((word) => pageText.includes(word)), `page ${pageIndex + 1}: ${item.text}`);
        }
        for (const item of model.redactions.filter((entry) => entry.pageId === page.id)) {
          const glyphs = await back.glyphs(pageIndex);
          const survivors = glyphs.filter((glyph) => glyph.hasBox && !glyph.generated && !/^\s*$/u.test(glyph.char) &&
            item.rects.some((rect) => rectsIntersect(shrink(rect, 0.2), glyph)));
          check('redaction.noGlyphsLeft', survivors.length === 0, `page ${pageIndex + 1}: ${survivors.length} glyphs left${item.word ? ` (${item.word})` : ''}`);
        }
      }
      for (const stamp of model.stampTexts.filter((item) => !item.soft)) {
        const pageIndex = model.pages.findIndex((page) => stamp.pageIds.includes(page.id));
        if (pageIndex < 0 || pageIndex >= back.pageIds.length) continue;
        const pageText = await textOf(pageIndex);
        if (pageText == null) continue;
        // Word by word: a later text edit may have rewritten the stamp line itself.
        check('pdfium.text.stamp', stamp.text.split(/\s+/u).every((word) => pageText.includes(normText(word))), `page ${pageIndex + 1}: ${stamp.text}`);
      }
    } finally { await back.close(); }
    return { detail: { pages: model.pages.length } };
  }, { timeoutMs: 60_000 });

  // 2. PDF.js (an independent parser): open, page count, render the first page, markers in its text content.
  await step('verify.pdfjs', async () => {
    const pdf = await Shell.openPdfJsDocument(bytes.slice());
    try {
      check('pdfjs.pageCount', pdf.numPages === model.pages.length, `${pdf.numPages}/${model.pages.length}`);
      const first = await pdf.getPage(1);
      const viewport = first.getViewport({ scale: 0.25 });
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(viewport.width)); canvas.height = Math.max(1, Math.round(viewport.height));
      await first.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      const pagesWithMarkers = [...new Set(model.markers.filter((item) => !item.soft).map((item) => item.pageId))].slice(0, 6);
      for (const pageId of pagesWithMarkers) {
        const pageIndex = model.pages.findIndex((page) => page.id === pageId);
        if (pageIndex < 0 || pageIndex >= pdf.numPages) continue;
        const content = await (await pdf.getPage(pageIndex + 1)).getTextContent();
        const text = normText(content.items.map((item) => item.str).join(''));
        for (const item of model.markers.filter((entry) => entry.pageId === pageId && !entry.soft)) {
          check(`pdfjs.text.${item.kind}`, (item.words || [item.text]).every((word) => text.includes(word)), `page ${pageIndex + 1}: ${item.text}`);
        }
      }
      // Comments and text boxes must survive as annotations.
      for (const item of model.annotationContents.slice(0, 4)) {
        const pageIndex = model.pages.findIndex((page) => page.id === item.pageId);
        if (pageIndex < 0 || pageIndex >= pdf.numPages) continue;
        const annotations = await (await pdf.getPage(pageIndex + 1)).getAnnotations();
        check('pdfjs.annotationContents', annotations.some((annotation) => String(annotation.contentsObj?.str || annotation.contents || '').includes(item.contents.split(' ')[1])),
          `page ${pageIndex + 1}`);
      }
    } finally { await pdf.destroy?.(); }
    return { detail: { pages: model.pages.length } };
  }, { timeoutMs: 60_000 });
}

function shrink(rect, by) {
  return { left: rect.left + by, right: rect.right - by, bottom: rect.bottom + by, top: rect.top - by };
}

/** Engine limits and the harness build, for the report. */
export async function describe() {
  return { missingInternals: Shell.__harnessMissingInternals, ops: Object.keys(OPS), docOps: Object.keys(DOC_OPS), userAgent: navigator.userAgent };
}
