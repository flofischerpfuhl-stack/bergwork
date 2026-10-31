// Corpus selection and seeded operation plans. A plan is a pure function of (file, seed, tier), so every failure
// is reproducible with `run-corpus.mjs --file <id> --seed <seed> --tier <tier>`.

export const EDIT_OPS = [
  'page.rotate', 'page.move', 'page.delete', 'page.insertBlank', 'page.duplicate', 'page.import',
  'text.add', 'text.edit', 'text.font', 'text.align', 'text.rotate', 'text.wrap', 'text.style', 'image.add', 'shape.add',
  'object.move', 'object.rotate', 'object.delete',
  'annot.markup', 'annot.shape', 'annot.comment', 'annot.freetext',
  'redact.area', 'redact.find', 'stamp.watermark', 'stamp.pageNumbers', 'ocr.layer', 'ocr.tesseract',
];
export const DOC_OPS = [
  'doc.metadata', 'doc.stripMetadata', 'doc.bookmarks', 'doc.split', 'doc.compress', 'doc.compressImages',
  'doc.encrypt', 'doc.formFill', 'doc.rasterize',
];
export const PHASES = ['open.ui', 'open.engine', 'baseline', 'history.undoAll', 'history.redoAll', 'save.export',
  'verify.pdfium', 'verify.pdfjs', 'project.roundtrip'];

// Coarse categories for the coverage matrix (manifest tags).
export const CATEGORIES = [
  'pdf-1.0', 'pdf-1.1', 'pdf-1.2', 'pdf-1.3', 'pdf-1.4', 'pdf-1.5', 'pdf-1.6', 'pdf-1.7', 'pdf-2.0', 'pdfa', 'pdfua',
  'tagged', 'scanned', 'ocr-layer', 'cjk', 'rtl', 'devanagari', 'cyrillic', 'font-type3', 'font-cid', 'font-not-embedded',
  'acroform', 'xfa', 'signed', 'annotations', 'encrypted', 'linearized', 'incremental', 'object-streams', 'broken',
  'many-pages', 'large-file', 'big-images', 'vector-heavy', 'rotated-pages', 'odd-page-size', 'transparency',
  'layers-ocg', 'presentation', 'invoice', 'scientific', 'government-form', 'book', 'map', 'cad',
];

export function fnv32(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle(list, rng) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i -= 1) { const j = Math.floor(rng() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  return out;
}

export const TIERS = {
  // Every change: a fixed stratified sample, short plans.
  quick: { files: 36, maxBytes: 6e6, maxPages: 60, editOps: 5, docOps: 3, project: 0.35, budgetMs: 45_000, baselinePages: 2, inspectPages: 12, tesseract: false },
  // Larger sample for development runs.
  sample: { files: 150, maxBytes: 40e6, maxPages: 400, editOps: 7, docOps: 4, project: 0.5, budgetMs: 90_000, baselinePages: 3, inspectPages: 20, tesseract: true },
  // Nightly: the whole corpus, longer plans, every document-level operation.
  full: { files: Infinity, maxBytes: Infinity, maxPages: Infinity, editOps: 8, docOps: 9, project: 1, budgetMs: 150_000, baselinePages: 3, inspectPages: 20, tesseract: true },
};

const QUICK_STRATA = [
  'pdf-1.2', 'pdf-1.3', 'pdf-2.0', 'pdfa', 'tagged', 'scanned', 'cjk', 'rtl', 'devanagari', 'font-type3', 'font-cid',
  'font-not-embedded', 'acroform', 'xfa', 'annotations', 'encrypted-user-password', 'encrypted-owner-only', 'linearized',
  'incremental', 'broken', 'vector-heavy', 'rotated-pages', 'odd-page-size', 'transparency', 'layers-ocg', 'signed',
  'presentation', 'invoice', 'scientific', 'government-form', 'book', 'map', 'big-images', 'object-streams', 'text', 'untagged',
];

/** Picks the files of a tier: a deterministic stratified sample (one file per stratum first) or everything. */
export function selectFiles(manifest, tierName, { seed = 1, limit = null, filter = null, ids = null } = {}) {
  const tier = TIERS[tierName];
  let files = manifest.files.filter((file) => !filter || filter(file));
  if (ids?.length) return manifest.files.filter((file) => ids.includes(file.id));
  const eligible = files.filter((file) => file.bytes <= tier.maxBytes && (file.pages == null || file.pages <= tier.maxPages));
  const want = Math.min(limit ?? tier.files, eligible.length);
  if (want >= eligible.length) return eligible;
  const rng = mulberry32(fnv32(`select:${tierName}:${seed}`));
  const order = shuffle(eligible, rng);
  const chosen = new Set();
  const strata = tierName === 'quick' ? QUICK_STRATA : [...QUICK_STRATA, ...CATEGORIES];
  // Round-robin over strata so every category is represented before any gets a second file.
  for (let round = 0; chosen.size < want && round < 50; round += 1) {
    let added = false;
    for (const tag of strata) {
      if (chosen.size >= want) break;
      const candidate = order.filter((file) => file.tags.includes(tag) && !chosen.has(file))[0];
      if (candidate && (round === 0 || rng() < 0.6)) { chosen.add(candidate); added = true; }
    }
    if (!added) break;
  }
  for (const file of order) { if (chosen.size >= want) break; chosen.add(file); }
  return [...chosen].sort((a, b) => a.id.localeCompare(b.id));
}

/** Small untagged, unencrypted, form-free files that page.import can append (merge) into another document. */
export function donorPool(manifest) {
  return manifest.files.filter((file) => file.bytes < 1.5e6 && file.pages && file.pages <= 20 && !file.facts?.encrypted &&
    !file.tags.includes('tagged') && !file.tags.includes('acroform') && !file.tags.includes('broken') && !file.expect?.open)
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * @returns {{ seed: number, ops: Array<{ op: string, params?: object }>, docOps: string[], undo: boolean, project: boolean }}
 */
export function planFor(file, { seed = 1, tierName = 'quick', donors = [], only = null } = {}) {
  const tier = TIERS[tierName];
  const fileSeed = fnv32(`${seed}:${file.id}`);
  const rng = mulberry32(fileSeed);
  const tags = new Set(file.tags || []);
  const applicable = EDIT_OPS.filter((op) => {
    if (op === 'ocr.tesseract') return tier.tesseract && tags.has('scanned');
    return true;
  });
  let ops = shuffle(applicable, rng).slice(0, tier.editOps);
  if (only?.length) ops = only.filter((op) => EDIT_OPS.includes(op));
  // Scanned files always get the OCR path in tiers that run Tesseract.
  if (!only && tier.tesseract && tags.has('scanned') && !ops.includes('ocr.tesseract')) ops[ops.length - 1] = 'ocr.tesseract';
  const planned = ops.map((op) => {
    if (op !== 'page.import' || !donors.length) return { op };
    const donor = donors[Math.floor(rng() * donors.length)];
    return rng() < 0.25 ? { op } : { op, params: { donorId: donor.id, donorUrl: `/__corpus/${donor.id}`, donorPages: donor.pages } };
  });
  const docCandidates = DOC_OPS.filter((op) => {
    if (op === 'doc.formFill') return tags.has('acroform');
    if (op === 'doc.rasterize') return tierName === 'full' && (file.pages || 1) <= 20;
    return true;
  });
  let docOps = shuffle(docCandidates, rng).slice(0, tier.docOps);
  if (tags.has('acroform') && !docOps.includes('doc.formFill')) docOps = [...docOps.slice(0, Math.max(0, tier.docOps - 1)), 'doc.formFill'];
  if (only?.length) docOps = only.filter((op) => DOC_OPS.includes(op));
  return { seed: fileSeed, ops: planned, docOps, undo: true, project: only ? only.includes('project.roundtrip') : rng() < tier.project };
}

const LETTER_OCR_PIXELS = (612 * 2) * (792 * 2);
const OCR_MAX_PIXELS = 16 * 1024 * 1024;

/**
 * How much work a file's steps legitimately take, relative to an ordinary document, from its manifest entry. Step
 * limits and the file budget scale with it, so a 1-page 30 MB map or a 500-page scanned book is measured against its
 * own size instead of failing on a limit made for a ten-page paper.
 *   page: content per page (edits regenerate, probe and re-inspect the whole page): bytes per page over 2 MB or
 *     images per page over 1,000 (PDFium's content regeneration is quadratic in a page's images, e.g. slides stored
 *     as thousands of inline-image strips), 1..4
 *   ocr: pixels the editor renders a page to for OCR (2x, capped at 16 Mpx) over a letter page at 2x, 1..8.5
 *   pages: page count, for whole-document operations that visit every page (image optimisation decodes each image)
 * @returns {{ page: number, ocr: number, pages: number }}
 */
export function workWeights(file) {
  const pages = Math.max(1, Number(file?.pages) || 1);
  const bytesPerPage = Math.max(0, Number(file?.bytes) || 0) / pages;
  const [width, height] = Array.isArray(file?.facts?.maxPageSizePt) ? file.facts.maxPageSizePt.map(Number) : [612, 792];
  const ocrPixels = Math.min(OCR_MAX_PIXELS, (width * 2) * (height * 2)) || LETTER_OCR_PIXELS;
  const imagesPerPage = Math.max(0, Number(file?.facts?.images) || 0) / pages;
  return {
    page: Math.min(4, Math.max(1, bytesPerPage / 2e6, imagesPerPage / 1000)),
    ocr: Math.max(1, ocrPixels / LETTER_OCR_PIXELS),
    pages,
  };
}

/** The file budget: the tier's, scaled by the page weight (at most 2x), plus the expected extra time of planned OCR and image optimisation. */
export function fileBudgetMs(tier, weights, plan) {
  let budget = tier.budgetMs * Math.min(2, weights.page);
  if (plan.ops.some((item) => item.op === 'ocr.tesseract')) budget += 30_000 * (weights.ocr - 1);
  if (plan.docOps.includes('doc.compressImages')) budget += IMAGE_OPTIMIZATION_MS_PER_PAGE * weights.pages;
  return Math.round(budget);
}

// Image optimisation decodes every image it may shrink: JPEG 2000 scans take 0.4-0.7 s per page in WebAssembly on an
// idle machine (Wayside, 336 pages, 672 JPX: 147 s), more with three pages running.
export const IMAGE_OPTIMIZATION_MS_PER_PAGE = 1000;

/** Step limits for the harness (harness/entry.js keeps its own defaults, 30 s per edit and so on, when absent). */
export function stepLimits(weights) {
  return {
    editMs: Math.round(30_000 * weights.page),
    ocrMs: Math.round(30_000 * weights.ocr),
    baselineMs: Math.round(60_000 * weights.page),
    historyFactor: weights.page,
    compressImagesMs: Math.round(60_000 + IMAGE_OPTIMIZATION_MS_PER_PAGE * weights.pages),
  };
}
