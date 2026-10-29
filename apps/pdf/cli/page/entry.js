// berg:work PDF agent CLI, in-page side: runs inside a headless page (served by headless/server.mjs, driven by
// cli/lib/engine-host.mjs) and performs one operation per call with the editor's own engine: the PDFium session
// (PdfEngineSessionOrchestrator over the pinned worker), the semantic kernel that journals every edit, and the
// document-level helpers of pdf-tools-shell.jsx (open, export pipeline, forms, compression, encryption, OCR). Each
// operation sends the commands the shell sends for the same action; nothing here draws or rewrites PDF content on
// its own. Inputs are fetched from /__corpus/<name> (the CLI's input folder), outputs POSTed to /__out/<name>.
import * as Shell from 'bergwork-shell-internals';
import { findGlyphTextMatches, replaceQueryInText, textContainsQuery } from '@editor/pdf-editor/model/redaction-geometry.js';
import { createAdvanceMeasurer, subsetTrueTypeFont } from '@editor/pdf-editor/ocr/truetype-subset.js';
import { OCR_LANGUAGES, ocrRenderScale, withOcrWorker } from '@editor/pdf-editor/ocr/runtime.js';
import { ocrTextLayerWords } from '@editor/pdf-editor/ocr/text-layer.js';
import {
  VENDOR, CommandType, configure, resetWorker, uid, asBytes, sha256Hex, errorInfo, upload, Session, command, pageBox,
} from '../../headless/engine.js';

// Engine refusals: the editor declines the edit with a typed reason, as it would in the UI.
const REFUSAL_CODES = new Set(['transaction-rejected', 'unsupported-operation', 'resource-limit', 'font-unavailable', 'page-stamp-unreadable']);
const POISON = /function signature mismatch|memory access out of bounds|unreachable|RuntimeError|table index is out of bounds|call stack size|Aborted\(|Worker timed out|Worker failed|transport closed|unreadable message/i;

export async function init(options = {}) {
  configure(options);
  if (!globalThis.PDFLib || !globalThis.pdfjsLib) throw new Error('cli.html must load pdf-lib and PDF.js first');
  resetWorker();
  return { missingInternals: Shell.__harnessMissingInternals };
}

class CliError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}
const fail = (code, message, details) => { throw new CliError(code, message, details); };

/** Runs one operation; never throws. */
export async function run(op, params = {}) {
  const fn = OPERATIONS[op];
  if (!fn) return { ok: false, error: { code: 'bad-argument', message: `Unknown operation ${op}` } };
  const contexts = [];
  outputPrefix = String(params.prefix || '').replace(/[^A-Za-z0-9._-]/g, '_');
  try {
    const result = await fn(params, contexts);
    return { ok: true, result };
  } catch (error) {
    const info = errorInfo(error);
    let code = error instanceof CliError ? error.code : info.code;
    if (!(error instanceof CliError) && (REFUSAL_CODES.has(info.code) || REFUSAL_CODES.has(info.detailCode))) code = 'refused';
    if (POISON.test(info.message) || info.code === 'timeout' || info.code === 'session-tainted') resetWorker();
    return {
      ok: false,
      error: { code, message: info.message, ...(info.detailCode ? { engineCode: info.detailCode } : {}),
        ...(error instanceof CliError ? {} : { engineCode: info.code }), ...(error?.details !== undefined && error instanceof CliError ? { details: error.details } : {}) },
    };
  } finally {
    for (const ctx of contexts) await closeInput(ctx);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Opening and saving, as the editor does

async function openInput(input, contexts, { session: wantSession = true } = {}) {
  const response = await fetch(input.url);
  if (!response.ok) fail('input-unreadable', `Cannot read ${input.name}`);
  const original = new Uint8Array(await response.arrayBuffer());
  const name = input.name || 'document.pdf';
  const password = String(input.password || '');
  let uiDoc;
  try {
    // The editor's open path: password unlock or permissions-only decryption, damage recovery, the PDF.js model.
    uiDoc = await Shell.loadPdfFile(new File([original], /\.pdf$/i.test(name) ? name : `${name}.pdf`, { type: 'application/pdf' }), null, password);
  } catch (error) {
    const message = String(error?.message || error);
    if (error?.name === 'PasswordException' || [1, 2].includes(Number(error?.code)) || /password/i.test(message)) {
      fail(password ? 'wrong-password' : 'password-required',
        password ? 'The password did not unlock this PDF.' : 'This PDF is encrypted and needs a password (--password).');
    }
    if (/not a PDF|PDF header/i.test(message)) fail('not-pdf', message);
    fail('input-unreadable', `The editor could not open ${name}: ${message}`);
  }
  const ctx = { input, name, original, password, uiDoc, session: null, metadata: null, formValues: {} };
  contexts.push(ctx);
  const live = Shell.sourceForLivePdfiumSession(uiDoc);
  ctx.liveSource = live || null;
  ctx.readableBytes = live?.bytes?.byteLength ? asBytes(live.bytes) : original;
  if (wantSession) {
    ctx.session = await Session.open(ctx.readableBytes.slice(), {
      password, pageIds: uiDoc.pages.map((page) => page.id), documentKey: uiDoc.id,
    });
  }
  return ctx;
}

async function closeInput(ctx) {
  await ctx.session?.close();
  for (const source of ctx.uiDoc?.sources || []) { try { await source.pdf?.destroy?.(); } catch { /* ignore */ } }
}

/** Editing goes through the live PDFium session, which the editor only opens for a writable, unmodified page set. */
function requireEditable(ctx) {
  if (!ctx.liveSource) fail('unsupported', 'The editor cannot open a native editing session for this PDF (damaged page tree or rebuilt document).');
  if (ctx.session.engine.state === 'tainted') fail('engine-error', 'The editing session failed earlier.');
}

const committedCommands = (ctx) => (ctx.session?.kernel.entries || [])
  .filter((entry) => entry.status === 'committed').flatMap((entry) => entry.transaction.commands);

function exportDoc(ctx) {
  const byId = new Map(ctx.uiDoc.pages.map((page) => [page.id, page]));
  return {
    ...ctx.uiDoc,
    pages: (ctx.session?.pageIds || ctx.uiDoc.pages.map((page) => page.id)).map((id) => byId.get(id) || { id }),
    metadata: ctx.metadata || ctx.uiDoc.metadata,
    originalMetadata: ctx.uiDoc.originalMetadata || ctx.uiDoc.metadata,
    formValues: ctx.formValues,
  };
}

/**
 * The bytes the editor would save (materializeLiveRuntimePdfBytes): the source when nothing changed, otherwise
 * engine.export (redactions applied) -> repairGeneratedFreeTextAppearances -> postprocessPdfiumExportBytes.
 * `options.pages` exports a subset (Export range), `stripMetadata` drops Info and XMP.
 */
async function materialize(ctx, options = {}) {
  const doc = exportDoc(ctx);
  const commands = committedCommands(ctx);
  const pages = options.pages ? options.pages.map((index) => doc.pages[index]) : undefined;
  const exportOptions = { ...(pages ? { pages } : {}), ...(options.stripMetadata ? { stripMetadata: true } : {}) };
  if (!commands.length && Shell.canReturnOriginalPdfBytes(doc, exportOptions)) {
    return { bytes: asBytes(await Shell.materializeCurrentPdfBytes(doc, exportOptions)), appliedRedactions: 0 };
  }
  const exported = await ctx.session.engine.export();
  let bytes = await Shell.repairGeneratedFreeTextAppearances(exported.bytes, commands);
  bytes = await Shell.postprocessPdfiumExportBytes(bytes, doc, exportOptions);
  return { bytes: asBytes(bytes), appliedRedactions: exported.appliedRedactions };
}

// Output names carry the caller's per-call prefix (cli/lib/engine-host.mjs collects the files by it).
let outputPrefix = '';
async function save(name, bytes, extra = {}) {
  const full = `${outputPrefix}${name}`;
  await upload(full, bytes);
  return { name: full, bytes: bytes.byteLength, ...extra };
}

async function countPages(bytes, password = '') {
  const back = await Session.open(asBytes(bytes).slice(), { password });
  try { return back.pageIds.length; } finally { await back.close(); }
}

// ---------------------------------------------------------------------------------------------------------------
// Page selections ("1-3,5,8-", "all", "odd", "even", "last"); 1-based in, 0-based out, in the given order.

function parsePages(spec, total, { allowEmpty = false, unique = true } = {}) {
  const text = String(spec ?? 'all').trim().toLowerCase();
  if (!text || text === 'all') return Array.from({ length: total }, (_, index) => index);
  const out = [];
  for (const raw of text.split(',')) {
    const part = raw.trim();
    if (!part) continue;
    if (part === 'odd' || part === 'even') {
      for (let n = part === 'odd' ? 1 : 2; n <= total; n += 2) out.push(n - 1);
      continue;
    }
    const match = /^(\d+|last)?\s*(-)?\s*(\d+|last)?$/.exec(part);
    const num = (value) => (value === 'last' ? total : Number(value));
    if (!match || (!match[1] && !match[3])) fail('bad-argument', `Invalid page selection "${part}"`);
    const start = match[1] ? num(match[1]) : 1;
    const end = match[2] ? (match[3] ? num(match[3]) : total) : start;
    for (const n of [start, end]) if (!(n >= 1 && n <= total)) fail('bad-argument', `Page ${n} is out of range (the PDF has ${total} page${total === 1 ? '' : 's'})`);
    const step = end >= start ? 1 : -1;
    for (let n = start; step > 0 ? n <= end : n >= end; n += step) out.push(n - 1);
  }
  const result = unique ? [...new Set(out)] : out;
  if (!result.length && !allowEmpty) fail('bad-argument', 'The page selection is empty');
  return result;
}

// ---------------------------------------------------------------------------------------------------------------
// Kernel edits, with the commands and inverses the shell uses

async function topology(session, type, targetId, payload, label, resources = []) {
  const prefix = uid('cli');
  const before = await session.snapshot({ retain: true });
  for (const resource of resources) await session.kernel.registerResource(resource);
  return session.execute(label, [command(prefix, type, targetId, { ...payload, rollbackResourceHash: before.hash })],
    [session.restoreCommand(prefix, before)]);
}

async function markRedactions(session, pageIndex, rects) {
  const prefix = uid('redact');
  const commands = []; const inverse = [];
  rects.forEach((rect, i) => {
    const id = uid('redact');
    commands.push(command(`${prefix}:${i}`, CommandType.ANNOTATION_SET, id, {
      pageIndex, subtypeName: 'redact', bounds: rect, opacity: 1,
      fillColor: '#000000', strokeColor: '#000000', fillEnabled: true, strokeEnabled: true, borderWidth: 0,
    }));
    inverse.unshift(command(`${prefix}:${i}:inv`, CommandType.ANNOTATION_SET, id, { pageIndex, deleted: true }));
  });
  await session.execute('Mark redactions', commands, inverse);
}

// ---------------------------------------------------------------------------------------------------------------
// Operations

const pdfVersion = (bytes) => /%PDF-(\d\.\d)/.exec(new TextDecoder('latin1').decode(bytes.subarray(0, 1024)))?.[1] || null;
const degrees = (quarterTurns) => ((Number(quarterTurns) || 0) % 4 + 4) % 4 * 90;

async function pageSummary(session, index, withText) {
  const inspection = await session.engine.inspectPage({ pageId: session.pageIds[index], pageIndex: index, objectBatchSize: 1 });
  const rotation = degrees(inspection?.rotation);
  const uw = Number(inspection?.unrotatedWidth || inspection?.width || 0); const uh = Number(inspection?.unrotatedHeight || inspection?.height || 0);
  const summary = {
    page: index + 1,
    width: Math.round((rotation % 180 ? uh : uw) * 100) / 100,
    height: Math.round((rotation % 180 ? uw : uh) * 100) / 100,
    rotation,
  };
  if (withText) summary.textChars = (await session.text(index)).replace(/\s+/gu, '').length;
  return summary;
}

async function formFieldList(bytes) {
  const fields = [];
  try {
    const pdf = await globalThis.PDFLib.PDFDocument.load(asBytes(bytes), { ignoreEncryption: true, updateMetadata: false });
    const { PDFTextField, PDFCheckBox, PDFRadioGroup, PDFDropdown, PDFOptionList, PDFButton, PDFSignature } = globalThis.PDFLib;
    const seen = new Set();
    for (const field of pdf.getForm().getFields()) {
      const name = field.getName();
      if (seen.has(name)) continue;
      seen.add(name);
      const entry = { name, type: 'unknown', readOnly: Boolean(field.isReadOnly?.()) };
      try {
        if (field instanceof PDFTextField) Object.assign(entry, { type: 'text', value: field.getText() ?? '', maxLength: field.getMaxLength?.() ?? null });
        else if (field instanceof PDFCheckBox) Object.assign(entry, { type: 'checkbox', value: field.isChecked() });
        else if (field instanceof PDFRadioGroup) Object.assign(entry, { type: 'radio', value: field.getSelected() ?? null, options: field.getOptions() });
        else if (field instanceof PDFDropdown) Object.assign(entry, { type: 'dropdown', value: field.getSelected(), options: field.getOptions() });
        else if (field instanceof PDFOptionList) Object.assign(entry, { type: 'list', value: field.getSelected(), options: field.getOptions() });
        else if (field instanceof PDFButton) entry.type = 'button';
        else if (field instanceof PDFSignature) entry.type = 'signature';
      } catch { /* value unreadable */ }
      fields.push(entry);
    }
  } catch { /* no AcroForm */ }
  return fields;
}

/** BaseFont names (subset tag removed) of one page's font resources, including Form XObjects one level down. */
async function pageFontNames(bytes, pageIndex) {
  const names = [];
  try {
    const { PDFDocument, PDFDict, PDFName, PDFStream } = globalThis.PDFLib;
    const pdf = await PDFDocument.load(asBytes(bytes), { ignoreEncryption: true, updateMetadata: false });
    const page = pdf.getPage(pageIndex);
    const collect = (resources, depth) => {
      if (!(resources instanceof PDFDict)) return;
      const fonts = resources.lookup(PDFName.of('Font'));
      if (fonts instanceof PDFDict) {
        for (const ref of fonts.values()) {
          const font = pdf.context.lookup(ref);
          const base = font instanceof PDFDict ? font.lookup(PDFName.of('BaseFont')) : null;
          if (base) names.push(String(base).replace(/^\//, '').replace(/^[A-Z]{6}\+/, ''));
        }
      }
      const xobjects = depth < 2 ? resources.lookup(PDFName.of('XObject')) : null;
      if (xobjects instanceof PDFDict) {
        for (const ref of xobjects.values()) {
          const stream = pdf.context.lookup(ref);
          if (stream instanceof PDFStream) collect(stream.dict.lookup(PDFName.of('Resources')), depth + 1);
        }
      }
    };
    collect(page.node.Resources(), 0);
  } catch { /* unreadable: no names */ }
  return names;
}

async function outlineTitles(ctx) {
  const titles = [];
  const pdf = ctx.uiDoc.sources?.[0]?.pdf;
  const walk = (items) => { for (const item of items || []) { titles.push(String(item.title || '')); walk(item.items); } };
  try { walk(await pdf?.getOutline?.()); } catch { /* none */ }
  return titles;
}

async function xmpPacket(ctx) {
  try { return (await ctx.uiDoc.sources?.[0]?.pdf?.getMetadata?.())?.metadata?.getRaw?.() || ''; } catch { return ''; }
}

const OPERATIONS = {
  async info({ input, textPages = 200 }, contexts) {
    const ctx = await openInput(input, contexts);
    const { session, uiDoc } = ctx;
    const toolkit = await Shell.getPdfToolkit();
    const encrypted = await toolkit.isEncrypted(ctx.original).catch(() => null);
    const pages = [];
    for (let index = 0; index < session.pageIds.length; index += 1) pages.push(await pageSummary(session, index, index < textPages));
    const fields = await formFieldList(ctx.readableBytes);
    return {
      file: ctx.name,
      bytes: ctx.original.byteLength,
      pdfVersion: pdfVersion(ctx.original),
      pageCount: session.pageIds.length,
      encrypted,
      protectionRemovedOnOpen: uiDoc.protectionRemoved?.kind || null,
      damageRecovery: uiDoc.damageRecovery || null,
      editable: Boolean(ctx.liveSource),
      metadata: await Shell.readPdfMetadata(ctx.readableBytes),
      xmpMetadata: Boolean(await xmpPacket(ctx)),
      bookmarks: (await outlineTitles(ctx)).length,
      form: { fields: fields.length, fillable: fields.filter((field) => !field.readOnly && !['button', 'signature', 'unknown'].includes(field.type)).length, xfa: await Shell.documentHasXfaForm(uiDoc) },
      signed: await Shell.pdfBytesContainCryptographicSignature(ctx.original).catch(() => false),
      pages,
      ...(session.pageIds.length > textPages ? { textCharsCountedForPages: textPages } : {}),
    };
  },

  async text({ input, pages: spec, engine = 'pdfium' }, contexts) {
    const ctx = await openInput(input, contexts, { session: engine === 'pdfium' });
    const total = ctx.uiDoc.pages.length;
    const indices = parsePages(spec, total);
    const out = [];
    if (engine === 'pdfjs') {
      // The editor's Extract text (PDF.js text content, items joined with spaces).
      const texts = await Shell.extractTextForDoc(ctx.uiDoc, indices, ctx.readableBytes, { pages: true });
      indices.forEach((index, order) => out.push({ page: index + 1, text: texts[order] || '' }));
    } else if (engine === 'pdfium') {
      for (const index of indices) out.push({ page: index + 1, text: (await ctx.session.text(index)).replace(/\r\n?/g, '\n') });
    } else fail('bad-argument', `Unknown text engine ${engine} (pdfium, pdfjs)`);
    return { pageCount: total, engine, pages: out };
  },

  async render({ input, pages: spec, dpi = 150, outPrefix = 'render' }, contexts) {
    const ctx = await openInput(input, contexts);
    const indices = parsePages(spec, ctx.session.pageIds.length);
    const scale = Number(dpi) / 72;
    if (!(scale > 0 && scale <= 1200 / 72)) fail('bad-argument', 'dpi must be between 1 and 1200');
    const outputs = [];
    for (const index of indices) {
      const pageId = ctx.session.pageIds[index];
      const inspection = await ctx.session.engine.inspectPage({ pageId, pageIndex: index, objectBatchSize: 1 });
      const area = Number(inspection?.width || 612) * Number(inspection?.height || 792) * scale * scale;
      // A canvas holds about 268 Mpx in Chrome; the raster copy keeps pages under 64 Mpx, so do the renders here.
      if (area > 64 * 1024 * 1024) fail('bad-argument', `Page ${index + 1} at ${dpi} dpi would be ${Math.round(area / 1e6)} Mpx; use a lower dpi`);
      const result = await ctx.session.engine.render({ pageId, pageIndex: index, scale, byteOrder: 'RGBA', jobId: uid('render') });
      const width = Math.max(1, Number(result.width)); const height = Math.max(1, Number(result.height));
      const pixels = new Uint8ClampedArray(asBytes(result.pixels));
      for (let i = 3; i < pixels.length; i += 4) pixels[i] = 255;
      const canvas = new OffscreenCanvas(width, height);
      canvas.getContext('2d').putImageData(new ImageData(pixels, width, height), 0, 0);
      const png = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
      outputs.push(await save(`${outPrefix}-${index + 1}.png`, png, { page: index + 1, width, height }));
    }
    return { dpi: Number(dpi), outputs };
  },

  async ocr({ input, pages: spec, lang = 'eng', layer = false, out = 'ocr.pdf' }, contexts) {
    if (!OCR_LANGUAGES.includes(lang)) fail('bad-argument', `OCR language ${lang} is not installed (${OCR_LANGUAGES.join(', ')})`);
    const ctx = await openInput(input, contexts);
    if (layer) requireEditable(ctx);
    const indices = parsePages(spec, ctx.session.pageIds.length);
    // As Make searchable / OCR in the shell: the current bytes rendered with PDF.js at the OCR scale, Tesseract
    // words in reading order, one ocr.insert per page with a subset of Noto Sans.
    const recognitionPdf = await Shell.openPdfJsDocument((await materialize(ctx)).bytes);
    const fullFont = layer ? new Uint8Array(await (await fetch(`${VENDOR}pdf-tools/fallback-fonts/NotoSans-Regular.ttf`)).arrayBuffer()) : null;
    const measure = layer ? createAdvanceMeasurer(fullFont) : () => 0;
    const pages = []; const ocrPages = [];
    try {
      await withOcrWorker(lang, {}, async (worker) => {
        for (const pageIndex of indices) {
          const pdfPage = await recognitionPdf.getPage(pageIndex + 1);
          const unscaled = pdfPage.getViewport({ scale: 1 });
          const viewport = pdfPage.getViewport({ scale: ocrRenderScale(unscaled.width, unscaled.height) });
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(viewport.width)); canvas.height = Math.max(1, Math.round(viewport.height));
          await pdfPage.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
          const { data } = await worker.recognize(canvas, {}, { words: true, blocks: true });
          const words = [];
          for (const word of ocrTextLayerWords(data)) {
            const origin = viewport.convertToPdfPoint(...word.origin).map(Number);
            const baseline = viewport.convertToPdfPoint(...word.baseline).map(Number);
            const ascent = viewport.convertToPdfPoint(...word.ascent).map(Number);
            const bv = [baseline[0] - origin[0], baseline[1] - origin[1]]; const av = [ascent[0] - origin[0], ascent[1] - origin[1]];
            if (Math.hypot(...bv) < 0.5 || Math.hypot(...av) < 0.5 || Math.abs(bv[0] * av[1] - bv[1] * av[0]) < 0.25) continue;
            words.push({ text: word.text, basis: { origin, baseline, ascent }, advance: measure(word.text) });
          }
          pages.push({ page: pageIndex + 1, text: String(data.text || '').trim(), words: words.length, confidence: Math.round(Number(data.confidence) || 0) });
          if (layer && words.length) ocrPages.push({ pageId: ctx.session.pageIds[pageIndex], pageIndex, words });
        }
      });
    } finally { await recognitionPdf.destroy?.(); }
    const result = { lang, pages };
    if (layer) {
      if (!ocrPages.length) fail('no-match', 'OCR recognised no words, so there is no text layer to add.', { pages });
      const used = new Set();
      for (const item of ocrPages) for (const word of item.words) for (const char of word.text) used.add(char.codePointAt(0));
      const fontBytes = subsetTrueTypeFont(fullFont, used).bytes;
      const fontResourceHash = await sha256Hex(fontBytes);
      const { session } = ctx;
      await session.kernel.registerResource({ hash: fontResourceHash, kind: 'font', format: 'ttf', family: 'Noto Sans', bytes: fontBytes });
      const before = await session.snapshot({ retain: true });
      const prefix = uid('ocr'); const markerId = uid('ocrlayer');
      await session.execute('Make searchable', ocrPages.map((item, index) => command(`${prefix}:page-${index + 1}`, CommandType.OCR_INSERT,
        `${session.documentKey}:ocr:${markerId}:${item.pageId}`,
        { pageIndex: item.pageIndex, pageId: item.pageId, language: lang, fontResourceHash, layout: 'baseline', words: item.words })),
      [session.restoreCommand(prefix, before)]);
      const { bytes } = await materialize(ctx);
      result.output = await save(out, bytes, { pages: await countPages(bytes) });
    }
    return result;
  },

  async redact({ input, terms = [], regex = null, caseSensitive = false, wholeWord = false, pages: spec, scrubMetadata = false, out = 'redacted.pdf' }, contexts) {
    if (!terms.length && !regex) fail('bad-argument', 'Give at least one --term or --regex');
    let expression = null;
    if (regex) {
      try { expression = new RegExp(regex, `g${caseSensitive ? '' : 'i'}u`); } catch (error) { fail('bad-argument', `Invalid regular expression: ${error.message}`); }
    }
    const ctx = await openInput(input, contexts);
    requireEditable(ctx);
    const { session } = ctx;
    const indices = parsePages(spec, session.pageIds.length);
    const options = { caseSensitive, wholeWord };
    const found = []; let total = 0; let missed = 0;
    for (const index of indices) {
      // Search-and-redact reads PDFium's glyphs, so the marks cover exactly what PDFium's redaction removes.
      const glyphs = await session.glyphs(index);
      const matches = [];
      for (const term of terms) matches.push(...findGlyphTextMatches(glyphs, term, options));
      if (expression) matches.push(...regexGlyphMatches(glyphs, expression, wholeWord));
      const unique = dedupeMatches(matches);
      if (!unique.length) continue;
      const rects = unique.flatMap((match) => match.rects);
      await markRedactions(session, index, rects);
      total += unique.length;
      missed += unique.reduce((sum, match) => sum + (match.missed || 0), 0);
      found.push({ page: index + 1, matches: unique.map((match) => match.text) });
    }
    // Occurrences outside the page content, as the shell's Find & redact reports them.
    const elsewhere = { metadata: [], bookmarks: 0, xmp: false };
    const queryHits = (value) => terms.some((term) => textContainsQuery(value, term, options)) || (expression ? new RegExp(expression.source, expression.flags.replace('g', '')).test(String(value || '')) : false);
    const metadata = ctx.uiDoc.metadata || {};
    elsewhere.metadata = Object.entries(metadata).filter(([, value]) => typeof value === 'string' && queryHits(value)).map(([key]) => key);
    elsewhere.bookmarks = (await outlineTitles(ctx)).filter(queryHits).length;
    elsewhere.xmp = queryHits(await xmpPacket(ctx));
    if (!total && !(scrubMetadata && elsewhere.metadata.length)) fail('no-match', 'No match found on the selected pages; nothing was redacted.', { elsewhere });
    if (scrubMetadata && elsewhere.metadata.length) {
      const scrub = (value) => {
        let text = String(value);
        for (const term of terms) text = replaceQueryInText(text, term, '', options).text;
        if (expression) text = text.replace(expression, '');
        return text.replace(/\s{2,}/gu, ' ').trim();
      };
      ctx.metadata = Object.fromEntries(Object.entries(metadata).map(([key, value]) => [key, elsewhere.metadata.includes(key) ? scrub(value) : value]));
    }
    const { bytes, appliedRedactions } = await materialize(ctx);
    // Check the saved file: no glyph may be left inside a redaction mark.
    const verify = await verifyRedactions(bytes, session, found, terms, expression, options);
    if (!verify.ok) fail('verification-failed', `Redacted text is still extractable on page ${verify.page}`, verify);
    return {
      matches: total, appliedRedactions, pages: found, unredactableGlyphs: missed, elsewhere,
      metadataScrubbed: scrubMetadata ? elsewhere.metadata : [],
      ...(elsewhere.xmp ? { warning: 'The XMP metadata packet still contains a match: run `metadata --strip` on the result.' } : {}),
      output: await save(out, bytes, { pages: await countPages(bytes) }),
    };
  },

  async replaceText({ input, find, replace, caseSensitive = false, pages: spec, partial = false, keepFonts = false, out = 'replaced.pdf' }, contexts) {
    if (!find) fail('bad-argument', 'Give the text to find (--find)');
    if (replace == null) fail('bad-argument', 'Give the replacement (--replace)');
    if (/[\r\n]/.test(String(replace))) fail('bad-argument', 'The replacement must be a single line');
    const ctx = await openInput(input, contexts);
    requireEditable(ctx);
    const { session } = ctx;
    const indices = parsePages(spec, session.pageIds.length);
    const options = { caseSensitive };
    const replaced = []; const refused = []; const unreachable = [];
    for (const index of indices) {
      const pageText = await session.text(index);
      const occurrences = replaceQueryInText(pageText, find, '', options).count;
      if (!occurrences) continue;
      const inspection = await session.inspect(index);
      const box = pageBox(inspection);
      // Only top-level native text runs the engine marks as replaceable (editPolicy replace-…): their font is kept
      // or swapped for a compatible embedded one by the engine; nested Form text, rich text frames, text split across
      // runs and runs the engine cannot re-encode are left alone and reported.
      const candidates = (inspection?.objects || []).filter((object) => object.typeName === 'text' && !object.nested && object.bounds &&
        object.stableId && /replace/.test(String(object.editPolicy || '')) && !object.complexText && !object.textFrame &&
        textContainsQuery(object.text, find, options));
      let done = 0;
      for (const object of candidates) {
        const sourceText = String(object.text);
        const next = replaceQueryInText(sourceText, find, replace, options);
        if (!next.count || next.text === sourceText) continue;
        const locator = {
          semanticText: true,
          sourceX: object.bounds.left - box.left, sourceY: box.top - object.bounds.top,
          sourceW: object.bounds.right - object.bounds.left, sourceH: object.bounds.top - object.bounds.bottom,
        };
        const prefix = uid('replace');
        // Retyping a native run cannot regenerate its TJ kerning in an inverse, so the shell undoes it with a snapshot.
        const before = await session.snapshot({ retain: true });
        try {
          await session.execute('Edit text', [command(prefix, CommandType.TEXT_REPLACE, object.stableId, {
            pageIndex: index, text: next.text, sourceText, allowNaturalWidth: true, textBlock: false, ...locator,
            targetSourceX: locator.sourceX, targetSourceY: locator.sourceY, targetSourceW: locator.sourceW, targetSourceH: locator.sourceH,
            fontSize: object.fontSize,
          })], [session.restoreCommand(prefix, before)]);
          done += next.count;
          replaced.push({ page: index + 1, from: sourceText, to: next.text, count: next.count });
        } catch (error) {
          const info = errorInfo(error);
          if (!REFUSAL_CODES.has(info.code) && !REFUSAL_CODES.has(info.detailCode)) throw error;
          refused.push({ page: index + 1, text: sourceText, reason: info.detailCode || info.code, message: info.message });
        }
      }
      if (done < occurrences) unreachable.push({ page: index + 1, occurrences, replaced: done });
    }
    const totalFound = unreachable.reduce((sum, item) => sum + item.occurrences, 0) + replaced.reduce((sum, item) => sum + item.count, 0) -
      unreachable.reduce((sum, item) => sum + item.replaced, 0);
    if (!replaced.length && !refused.length && !unreachable.length) fail('no-match', `"${find}" was not found on the selected pages.`);
    const report = { replaced, refused, notReplaceable: unreachable.filter((item) => item.occurrences > item.replaced) };
    if (!replaced.length) fail('unsupported', 'The engine cannot replace this text safely here (see details); nothing was changed.', report);
    if ((refused.length || report.notReplaceable.length) && !partial) {
      fail('unsupported', 'Only some occurrences can be replaced safely; nothing was written. Pass --partial to save the safe replacements.', report);
    }
    const { bytes } = await materialize(ctx);
    // Characters the source font cannot encode are drawn by the engine with a compatible embedded fallback font
    // (as in the editor); report that, and refuse it with keepFonts.
    const fontChanges = [];
    for (const pageNumber of [...new Set(replaced.map((item) => item.page))]) {
      const before = new Set(await pageFontNames(ctx.readableBytes, pageNumber - 1));
      const added = (await pageFontNames(bytes, pageNumber - 1)).filter((font) => !before.has(font));
      if (added.length) fontChanges.push({ page: pageNumber, fontsAdded: [...new Set(added)] });
    }
    if (fontChanges.length && keepFonts) fail('unsupported', 'The source fonts cannot draw the replacement; the engine would add a fallback font. Nothing was written.', { fontChanges });
    // Check the saved file with PDFium: every replacement must read back.
    const back = await Session.open(bytes.slice());
    try {
      for (const item of replaced) {
        const text = (await back.text(item.page - 1)).replace(/\s+/gu, '');
        if (!text.includes(String(item.to).replace(/\s+/gu, ''))) fail('verification-failed', `The replacement on page ${item.page} does not read back from the saved PDF`, item);
      }
    } finally { await back.close(); }
    return {
      occurrences: totalFound, ...report, fontChanges,
      ...(fontChanges.length ? { warning: `Fallback fonts were embedded for characters the source fonts cannot encode (${fontChanges.flatMap((item) => item.fontsAdded).join(', ')}).` } : {}),
      output: await save(out, bytes, { pages: await countPages(bytes) }),
    };
  },

  async formFields({ input }, contexts) {
    const ctx = await openInput(input, contexts, { session: false });
    return { fields: await formFieldList(ctx.readableBytes), xfa: await Shell.documentHasXfaForm(ctx.uiDoc) };
  },

  async fillForm({ input, values = {}, flatten = false, out = 'filled.pdf' }, contexts) {
    const ctx = await openInput(input, contexts);
    const fields = await formFieldList(ctx.readableBytes);
    if (!fields.length) fail('unsupported', 'This PDF has no AcroForm fields to fill.');
    const byName = new Map(fields.map((field) => [field.name, field]));
    const unknown = Object.keys(values).filter((name) => !byName.has(name));
    if (unknown.length) fail('unknown-field', `Unknown form field${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`, { unknown, fields: fields.map((field) => field.name) });
    const readOnly = Object.keys(values).filter((name) => byName.get(name).readOnly || ['button', 'signature', 'unknown'].includes(byName.get(name).type));
    if (readOnly.length) fail('unsupported', `Not fillable (read-only, button or signature): ${readOnly.join(', ')}`, { readOnly });
    // Values as the Forms panel stores them: strings, check boxes 'true'/'false', radio/choice by export value.
    const normalized = Object.fromEntries(Object.entries(values).map(([name, value]) => [name, value === true ? 'true' : value === false ? 'false' : Array.isArray(value) ? String(value[0] ?? '') : String(value ?? '')]));
    const { bytes: base } = await materialize(ctx);
    const bytes = asBytes(await Shell.fillMaterializedFormPdfBytes(base, normalized, Boolean(flatten)));
    const after = flatten ? [] : await formFieldList(bytes);
    const mismatched = flatten ? [] : Object.entries(normalized).filter(([name, value]) => {
      const field = after.find((item) => item.name === name);
      if (!field) return true;
      if (field.type === 'text') return String(field.value) !== (field.maxLength > 0 ? value.slice(0, field.maxLength) : value);
      if (field.type === 'checkbox') return field.value !== (value === 'true' || value === 'on' || value === '1');
      return false;
    }).map(([name]) => name);
    if (mismatched.length) fail('verification-failed', `Values did not read back: ${mismatched.join(', ')}`, { mismatched });
    return {
      filled: Object.keys(normalized).length, flattened: Boolean(flatten), xfaRemoved: await Shell.documentHasXfaForm(ctx.uiDoc),
      output: await save(out, bytes, { pages: await countPages(bytes) }),
    };
  },

  async pages({ input, action, pages: spec, angle = 90, to, every, ranges, out = 'pages.pdf', outPrefix = 'part' }, contexts) {
    const ctx = await openInput(input, contexts);
    const { session } = ctx;
    const total = session.pageIds.length;
    if (['rotate', 'delete', 'move'].includes(action)) requireEditable(ctx);
    if (action === 'rotate') {
      const turns = Number(angle) / 90;
      if (!Number.isInteger(turns)) fail('bad-argument', '--angle must be a multiple of 90');
      const indices = parsePages(spec, total);
      for (const index of indices) {
        const pageId = session.pageIds[index];
        const current = Number((await session.inspect(index))?.rotation || 0);
        const next = ((current + turns) % 4 + 4) % 4;
        const prefix = uid('rot');
        await session.execute('Rotate page', [command(prefix, CommandType.PAGE_ROTATE, pageId, { pageIndex: index, rotation: next })],
          [command(`${prefix}:inv`, CommandType.PAGE_ROTATE, pageId, { pageIndex: index, rotation: current })]);
      }
      const { bytes } = await materialize(ctx);
      return { action, pages: indices.map((index) => index + 1), angle: Number(angle), output: await save(out, bytes, { pages: await countPages(bytes) }) };
    }
    if (action === 'delete') {
      const indices = parsePages(spec, total);
      if (indices.length >= total) fail('bad-argument', 'Cannot delete every page');
      for (const index of [...indices].sort((a, b) => b - a)) {
        const pageId = session.pageIds[index];
        const result = await topology(session, CommandType.PAGE_DELETE, pageId, { pageIndex: index }, 'Delete page');
        if (!Array.isArray(result?.pageIds)) session.pageIds.splice(index, 1);
        if (session.pageIds.includes(pageId)) fail('engine-error', `Page ${index + 1} was not deleted`);
      }
      const { bytes } = await materialize(ctx);
      return { action, deleted: indices.map((index) => index + 1).sort((a, b) => a - b), output: await save(out, bytes, { pages: await countPages(bytes) }) };
    }
    if (action === 'move') {
      const indices = parsePages(spec, total, { unique: true });
      const target = Number(to);
      if (!Number.isInteger(target) || target < 1 || target > total) fail('bad-argument', `--to must be a page position from 1 to ${total}`);
      // The selected pages keep their order and the first lands at position --to.
      const moving = indices.map((index) => session.pageIds[index]);
      const rest = session.pageIds.filter((id) => !moving.includes(id));
      const insertAt = Math.min(target - 1, rest.length);
      const wanted = [...rest.slice(0, insertAt), ...moving, ...rest.slice(insertAt)];
      for (let position = 0; position < wanted.length; position += 1) {
        const from = session.pageIds.indexOf(wanted[position]);
        if (from === position) continue;
        const result = await topology(session, CommandType.PAGE_MOVE, wanted[position], { destinationIndex: position }, 'Move page');
        if (!Array.isArray(result?.pageIds)) { session.pageIds.splice(from, 1); session.pageIds.splice(position, 0, wanted[position]); }
        if (session.pageIds[position] !== wanted[position]) fail('engine-error', 'The page order did not change as requested');
      }
      const { bytes } = await materialize(ctx);
      return { action, order: wanted.map((id) => ctx.uiDoc.pages.findIndex((page) => page.id === id) + 1), output: await save(out, bytes, { pages: await countPages(bytes) }) };
    }
    if (action === 'extract') {
      // Export range: the export pipeline with a page subset, in the given order.
      const indices = parsePages(spec, total, { unique: false });
      const { bytes } = await materialize(ctx, { pages: indices });
      return { action, pages: indices.map((index) => index + 1), output: await save(out, bytes, { pages: await countPages(bytes) }) };
    }
    if (action === 'split') {
      let groups;
      if (ranges) groups = String(ranges).split(/[;|]/).map((part) => part.trim()).filter(Boolean).map((part) => parsePages(part, total));
      else {
        const size = Number(every || 1);
        if (!Number.isInteger(size) || size < 1) fail('bad-argument', '--every must be a positive whole number');
        groups = [];
        for (let start = 0; start < total; start += size) groups.push(Array.from({ length: Math.min(size, total - start) }, (_, i) => start + i));
      }
      const outputs = [];
      for (const [order, group] of groups.entries()) {
        const { bytes } = await materialize(ctx, { pages: group });
        outputs.push(await save(`${outPrefix}-${order + 1}.pdf`, bytes, { part: order + 1, sourcePages: group.map((index) => index + 1), pages: await countPages(bytes) }));
      }
      return { action, parts: outputs.length, outputs };
    }
    fail('bad-argument', `Unknown pages action ${action} (rotate, delete, move, extract, split; merge is its own operation)`);
  },

  async merge({ inputs = [], out = 'merged.pdf' }, contexts) {
    if (inputs.length < 2) fail('bad-argument', 'merge needs at least two PDFs');
    const ctx = await openInput(inputs[0], contexts);
    requireEditable(ctx);
    const { session } = ctx;
    const appended = [];
    for (const input of inputs.slice(1)) {
      // Insert pages from another PDF: page.import of a snapshot resource of the donor's readable bytes.
      const donor = await openInput(input, contexts, { session: false });
      const resource = await Shell.pdfSnapshotResourceFromBytes(donor.readableBytes);
      const count = donor.uiDoc.pages.length;
      const pageIds = Array.from({ length: count }, () => uid('imp'));
      const result = await topology(session, CommandType.PAGE_IMPORT, session.documentKey,
        { pageIndex: session.pageIds.length, resourceHash: resource.hash, sourcePageIndices: Array.from({ length: count }, (_, i) => i), pageIds },
        'Import pages', [resource]);
      if (!Array.isArray(result?.pageIds)) session.pageIds.push(...pageIds);
      appended.push({ file: donor.name, pages: count });
    }
    const { bytes } = await materialize(ctx);
    const pages = await countPages(bytes);
    const expected = ctx.uiDoc.pages.length + appended.reduce((sum, item) => sum + item.pages, 0);
    if (pages !== expected) fail('verification-failed', `The merged PDF has ${pages} pages, expected ${expected}`);
    return { files: [{ file: ctx.name, pages: ctx.uiDoc.pages.length }, ...appended], output: await save(out, bytes, { pages }) };
  },

  async optimize({ input, profile = 'vector', dpi, quality, out = 'optimized.pdf' }, contexts) {
    if (!Shell.PDF_OPT_PROFILES[profile]) fail('bad-argument', `Unknown profile ${profile} (${Object.keys(Shell.PDF_OPT_PROFILES).join(', ')})`);
    const ctx = await openInput(input, contexts);
    const { bytes: current } = await materialize(ctx);
    const imageOptions = {};
    if (dpi != null) imageOptions.dpi = Number(dpi);
    if (quality != null) imageOptions.quality = Number(quality);
    if (Object.keys(imageOptions).length && !Shell.PDF_OPT_PROFILES[profile].imageOnly) fail('bad-argument', '--dpi and --quality apply to the images profile only');
    const blob = await Shell.compressEditedPdf(exportDoc(ctx), profile, null, current, imageOptions);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const info = { ...(blob.fernworkOptimization || {}) };
    delete info.losslessAlternative;
    return {
      profile, label: Shell.PDF_OPT_PROFILES[profile].label, inputBytes: ctx.original.byteLength, outputBytes: bytes.byteLength,
      textPreserved: info.semanticPreserved !== false, report: info,
      output: await save(out, bytes, { pages: await countPages(bytes) }),
    };
  },

  async protect({ input, ownerPassword, userPassword = '', restrict = [], out = 'protected.pdf' }, contexts) {
    if (!ownerPassword) fail('bad-argument', 'An owner password is required (--owner-password)');
    const known = { print: 'noPrint', edit: 'noEdit', copy: 'noCopy', annotate: 'noAnnotate' };
    const bad = restrict.filter((item) => !known[item]);
    if (bad.length) fail('bad-argument', `Unknown restriction ${bad.join(', ')} (print, edit, copy, annotate)`);
    const ctx = await openInput(input, contexts);
    const { bytes: current } = await materialize(ctx);
    const flags = Object.fromEntries(Object.values(known).map((flag) => [flag, false]));
    for (const item of restrict) flags[known[item]] = true;
    // Security > Export restricted PDF: qpdf AES-256 with one switch per permission.
    const bytes = asBytes(await Shell.restrictPdfBytes(current, flags, ownerPassword, userPassword));
    return {
      encryption: 'AES-256', userPassword: Boolean(userPassword), restricted: restrict,
      output: await save(out, bytes, { pages: await countPages(bytes, userPassword) }),
    };
  },

  async unlock({ input, out = 'unlocked.pdf' }, contexts) {
    const response = await fetch(input.url);
    if (!response.ok) fail('input-unreadable', `Cannot read ${input.name}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const toolkit = await Shell.getPdfToolkit();
    if (!(await toolkit.isEncrypted(bytes).catch(() => false))) fail('no-match', 'This PDF is not encrypted.');
    // Security > Unlock: qpdf decryption of the file as it is, without opening it in the editor.
    let unlocked;
    try { unlocked = asBytes(await toolkit.unlock(bytes, { password: String(input.password || '') })); } catch (error) {
      fail(input.password ? 'wrong-password' : 'password-required', input.password ? 'The password did not unlock this PDF.' : `This PDF needs its password (--password): ${String(error?.message || error).slice(0, 200)}`);
    }
    if (!unlocked.byteLength || await toolkit.isEncrypted(unlocked)) fail('wrong-password', 'The password did not unlock this PDF.');
    return { output: await save(out, unlocked, { pages: await countPages(unlocked) }) };
  },

  async metadata({ input, set = null, strip = false, out = 'metadata.pdf' }, contexts) {
    const editable = ['title', 'author', 'subject', 'keywords', 'creator', 'producer'];
    const changes = set || {};
    const bad = Object.keys(changes).filter((key) => !editable.includes(key));
    if (bad.length) fail('bad-argument', `Not an editable field: ${bad.join(', ')} (${editable.join(', ')})`);
    if (strip && Object.keys(changes).length) fail('bad-argument', '--strip and --set exclude each other');
    const ctx = await openInput(input, contexts, { session: Boolean(strip || Object.keys(changes).length) });
    const current = await Shell.readPdfMetadata(ctx.readableBytes);
    const result = { metadata: current, xmpMetadata: Boolean(await xmpPacket(ctx)) };
    if (!strip && !Object.keys(changes).length) return result;
    if (!strip) ctx.metadata = { ...(ctx.uiDoc.metadata || {}), ...Object.fromEntries(Object.entries(changes).map(([key, value]) => [key, String(value ?? '')])) };
    const { bytes } = await materialize(ctx, { stripMetadata: strip });
    const after = await Shell.readPdfMetadata(bytes);
    return { ...result, metadata: after, previous: current, stripped: Boolean(strip), output: await save(out, bytes, { pages: await countPages(bytes) }) };
  },
};

// Regular-expression search over the same page text findGlyphTextMatches builds: each regex match becomes a literal
// query and only the editor's matches with the same span are kept, so the rectangles come from the editor's code.
function regexGlyphMatches(glyphs, expression, wholeWord) {
  let text = '';
  for (const glyph of glyphs) text += glyph.char || ' ';
  const out = [];
  const cache = new Map();
  for (const match of text.matchAll(expression)) {
    const raw = match[0];
    const lead = raw.length - raw.trimStart().length;
    const literal = raw.trim();
    if (!literal) continue;
    const start = match.index + lead;
    if (!cache.has(literal)) cache.set(literal, findGlyphTextMatches(glyphs, literal, { caseSensitive: true, wholeWord }));
    const hit = cache.get(literal).find((candidate) => candidate.start === start);
    if (hit) out.push(hit);
  }
  return out;
}

function dedupeMatches(matches) {
  const seen = new Set();
  return matches.filter((match) => {
    const key = `${match.start}:${match.end}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function verifyRedactions(bytes, session, found, terms, expression, options) {
  const back = await Session.open(bytes.slice());
  try {
    for (const item of found) {
      const glyphs = await back.glyphs(item.page - 1);
      const left = [];
      for (const term of terms) left.push(...findGlyphTextMatches(glyphs, term, options));
      if (expression) left.push(...regexGlyphMatches(glyphs, expression, options.wholeWord));
      if (left.length) return { ok: false, page: item.page, left: left.map((match) => match.text) };
    }
    return { ok: true };
  } finally { await back.close(); }
}
