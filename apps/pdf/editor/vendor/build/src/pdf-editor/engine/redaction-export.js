// Applies the redaction marks of one page of an export copy.
//
// PDFium's native redactor (EPDFAnnot_ApplyRedaction, EmbedPDF fork) removes
// page content under a mark: glyphs whose font box touches it, paths and
// shadings inside it, and image pixels under it. The product handles three remaining
// gaps, which this module closes in front of and behind the native call:
//
// 1. Annotations. The native call only rewrites page content. A FreeText,
//    typed signature, note or link under a mark kept its /Contents and its
//    appearance stream. Annotations that intersect a mark are removed, like
//    Acrobat does, together with their popups and replies.
// Shared image/Form resources, nested transforms and image Matte are handled
// by the native redactor and Form writer.
// 2. Edges. A font without glyph boxes gives the native test a zero-area box
//    at the glyph origin, and the test is strict. A glyph that starts exactly
//    on the left or bottom edge of a mark therefore survived, and the editor's
//    marks start exactly there (object bounds, snapped glyph boxes). A first
//    pass with every mark grown by REDACTION_EDGE_TOLERANCE removes them.
// 3. Degenerate marks. A mark with zero width or height made the native call
//    fail and the whole Save with it. Its rectangle is grown by
//    REDACTION_DEGENERATE_HALF_EXTENT in the empty direction.
//
// Afterwards every page is checked with PDFium's text page: a glyph still
// inside a mark gets a targeted second pass, and if text still survives the
// export fails instead of writing a PDF that leaks it.

export const PDF_ANNOT_REDACT = 28;
const PDF_ANNOT_POPUP = 16;
const PDF_ANNOT_WIDGET = 20;
const PDF_ANNOT_FLAG_HIDDEN = 2;
// A form field widget under a mark is hidden and tagged with this otherwise
// unused annotation flag bit. PDFium cannot edit the AcroForm field tree, so
// the shell's export post-processing (removeRedactedFormFields) removes the
// tagged widgets, the fields left without widgets and their values.
export const REDACTED_WIDGET_FLAG = 1 << 24;

// Grows each mark for the first native pass. Snapped marks keep 0.25 pt
// (REDACTION_CLEARANCE) away from glyphs they must not remove, so 0.1 pt
// cannot reach a neighbour.
export const REDACTION_EDGE_TOLERANCE = 0.1;
// Half height (or width) given to a mark that has none.
export const REDACTION_DEGENERATE_HALF_EXTENT = 0.5;
// A glyph counts as surviving when its box reaches this far into a mark.
export const REDACTION_SURVIVOR_INSET = 0.2;


// ---------------------------------------------------------------------------
// Geometry (PDF user space, { left, bottom, right, top }, y up).

export function normalizeRect(rect) {
  if (!rect) return null;
  const values = [rect.left, rect.bottom, rect.right, rect.top].map(Number);
  if (!values.every(Number.isFinite)) return null;
  return {
    left: Math.min(values[0], values[2]),
    bottom: Math.min(values[1], values[3]),
    right: Math.max(values[0], values[2]),
    top: Math.max(values[1], values[3]),
  };
}

export function rectIsEmpty(rect) {
  return !rect || !(rect.right > rect.left) || !(rect.top > rect.bottom);
}

export function inflateRect(rect, amount) {
  return {
    left: rect.left - amount,
    bottom: rect.bottom - amount,
    right: rect.right + amount,
    top: rect.top + amount,
  };
}

// The native test: strict on every side, so a zero-area box intersects only
// when it lies inside the other rectangle.
export function rectsIntersect(a, b) {
  return a.right > b.left && a.left < b.right && a.top > b.bottom && a.bottom < b.top;
}

export function rectIntersectsAny(rect, rects) {
  return rects.some(other => rectsIntersect(rect, other));
}

export function quadBounds(points, offset = 0) {
  const xs = [points[offset], points[offset + 2], points[offset + 4], points[offset + 6]].map(Number);
  const ys = [points[offset + 1], points[offset + 3], points[offset + 5], points[offset + 7]].map(Number);
  if (![...xs, ...ys].every(Number.isFinite)) return null;
  return { left: Math.min(...xs), bottom: Math.min(...ys), right: Math.max(...xs), top: Math.max(...ys) };
}

// The rectangles the native call removes content in, in its precedence:
// non-empty QuadPoints, else /Rect. A /Rect with no area is grown so the mark
// still covers the line it was drawn on; `repairedRect` is then the /Rect to
// write before the native call.
export function redactionMarkRects({ rect, quadPoints = null } = {}) {
  const fromQuads = [];
  if (Array.isArray(quadPoints) || ArrayBuffer.isView(quadPoints)) {
    for (let offset = 0; offset + 8 <= quadPoints.length; offset += 8) {
      const bounds = quadBounds(quadPoints, offset);
      if (bounds && !rectIsEmpty(bounds)) fromQuads.push(bounds);
    }
  }
  if (fromQuads.length) return { rects: fromQuads, repairedRect: null };
  const normalized = normalizeRect(rect);
  if (!normalized) return { rects: [], repairedRect: null };
  if (!rectIsEmpty(normalized)) return { rects: [normalized], repairedRect: null };
  const repairedRect = { ...normalized };
  if (!(repairedRect.right > repairedRect.left)) {
    repairedRect.left -= REDACTION_DEGENERATE_HALF_EXTENT;
    repairedRect.right += REDACTION_DEGENERATE_HALF_EXTENT;
  }
  if (!(repairedRect.top > repairedRect.bottom)) {
    repairedRect.bottom -= REDACTION_DEGENERATE_HALF_EXTENT;
    repairedRect.top += REDACTION_DEGENERATE_HALF_EXTENT;
  }
  return { rects: [repairedRect], repairedRect };
}

// Which annotations go with the marks. `annotations` are
// { index, subtype, rect, popupIndex, parentIndex, replyToIndex } with -1 for
// a missing link. A redaction mark itself is applied, not removed here. A
// popup only shows its parent's text, so it goes when its parent goes, not
// because of its own position. Replies follow the annotation they answer.
// Widgets stay here: they are tagged (widgetIndicesUnderMarks) and removed
// with their fields by the shell, which can edit the AcroForm tree.
export function widgetIndicesUnderMarks(annotations, rects) {
  return annotations.filter(annotation => annotation.subtype === PDF_ANNOT_WIDGET &&
    rectIntersectsAny(normalizeRect(annotation.rect) || { left: 0, bottom: 0, right: 0, top: 0 }, rects))
    .map(annotation => annotation.index);
}

export function annotationIndicesToRemove(annotations, rects) {
  const byIndex = new Map(annotations.map(annotation => [annotation.index, annotation]));
  const removed = new Set();
  for (const annotation of annotations) {
    if ([PDF_ANNOT_REDACT, PDF_ANNOT_POPUP, PDF_ANNOT_WIDGET].includes(annotation.subtype)) continue;
    const rect = normalizeRect(annotation.rect);
    if (rect && rectIntersectsAny(rect, rects)) removed.add(annotation.index);
  }
  let grew = true;
  while (grew) {
    grew = false;
    for (const annotation of annotations) {
      if (removed.has(annotation.index) || annotation.subtype === PDF_ANNOT_REDACT) continue;
      const follows = (annotation.subtype === PDF_ANNOT_POPUP && removed.has(annotation.parentIndex)) ||
        (annotation.subtype !== PDF_ANNOT_WIDGET && removed.has(annotation.replyToIndex));
      if (follows) {
        removed.add(annotation.index);
        grew = true;
      }
    }
    for (const index of [...removed]) {
      const popupIndex = byIndex.get(index)?.popupIndex;
      if (popupIndex >= 0 && !removed.has(popupIndex) && byIndex.get(popupIndex)?.subtype === PDF_ANNOT_POPUP) {
        removed.add(popupIndex);
        grew = true;
      }
    }
  }
  return [...removed].sort((a, b) => b - a);
}

// Glyphs PDFium's text page still finds inside a mark: ink that has a box, is
// not a space PDFium inferred, and reaches REDACTION_SURVIVOR_INSET into it.
export function survivingGlyphs(glyphs, rects, inset = REDACTION_SURVIVOR_INSET) {
  const inner = rects.map(rect => ({
    left: rect.left + Math.min(inset, (rect.right - rect.left) / 4),
    bottom: rect.bottom + Math.min(inset, (rect.top - rect.bottom) / 4),
    right: rect.right - Math.min(inset, (rect.right - rect.left) / 4),
    top: rect.top - Math.min(inset, (rect.top - rect.bottom) / 4),
  }));
  return glyphs.filter(glyph => glyph.box && !glyph.generated && !/^\s*$/u.test(glyph.char) &&
    inner.some(rect => Math.min(rect.right, glyph.box.right) - Math.max(rect.left, glyph.box.left) > 0 &&
      Math.min(rect.top, glyph.box.top) - Math.max(rect.bottom, glyph.box.bottom) > 0));
}

// Rectangles for a targeted second pass over surviving glyphs: the glyph's
// own box, and a small square around its origin, where a glyph without a
// font box is placed by the native test.
export function survivorRedactionRects(survivors) {
  const rects = [];
  for (const glyph of survivors) {
    rects.push(inflateRect(glyph.box, REDACTION_EDGE_TOLERANCE));
    if (Number.isFinite(glyph.originX) && Number.isFinite(glyph.originY)) {
      rects.push(inflateRect({ left: glyph.originX, bottom: glyph.originY, right: glyph.originX, top: glyph.originY },
        REDACTION_EDGE_TOLERANCE));
    }
  }
  return rects;
}

// ---------------------------------------------------------------------------
// PDFium access.

function heapFloat(pdfium, pointer) {
  return pdfium.pdfium.HEAPF32[pointer >> 2];
}

function withMemory(pdfium, size, callback) {
  const pointer = pdfium.pdfium.wasmExports.malloc(size);
  try {
    return callback(pointer);
  } finally {
    pdfium.pdfium.wasmExports.free(pointer);
  }
}

function readAnnotationRect(pdfium, annotation) {
  return withMemory(pdfium, 16, pointer => {
    if (!pdfium.FPDFAnnot_GetRect(annotation, pointer)) return null;
    // FS_RECTF: left, top, right, bottom.
    return normalizeRect({
      left: heapFloat(pdfium, pointer),
      top: heapFloat(pdfium, pointer + 4),
      right: heapFloat(pdfium, pointer + 8),
      bottom: heapFloat(pdfium, pointer + 12),
    });
  });
}

function writeAnnotationRect(pdfium, annotation, rect) {
  return withMemory(pdfium, 16, pointer => {
    const heap = pdfium.pdfium.HEAPF32;
    heap[pointer >> 2] = rect.left;
    heap[(pointer + 4) >> 2] = rect.top;
    heap[(pointer + 8) >> 2] = rect.right;
    heap[(pointer + 12) >> 2] = rect.bottom;
    return Boolean(pdfium.FPDFAnnot_SetRect(annotation, pointer));
  });
}

function readAnnotationQuadPoints(pdfium, annotation) {
  if (typeof pdfium.FPDFAnnot_CountAttachmentPoints !== 'function') return null;
  const count = Math.min(4096, Number(pdfium.FPDFAnnot_CountAttachmentPoints(annotation) || 0));
  if (count < 1) return null;
  return withMemory(pdfium, 32, pointer => {
    const points = [];
    for (let index = 0; index < count; index += 1) {
      if (!pdfium.FPDFAnnot_GetAttachmentPoints(annotation, index, pointer)) break;
      for (let value = 0; value < 8; value += 1) points.push(heapFloat(pdfium, pointer + value * 4));
    }
    return points;
  });
}

function linkedAnnotationIndex(pdfium, pageHandle, annotation, key) {
  if (typeof pdfium.FPDFAnnot_GetLinkedAnnot !== 'function') return -1;
  const linked = pdfium.FPDFAnnot_GetLinkedAnnot(annotation, key);
  if (!linked) return -1;
  try {
    return Number(pdfium.FPDFPage_GetAnnotIndex(pageHandle, linked));
  } finally {
    pdfium.FPDFPage_CloseAnnot(linked);
  }
}

function readPageAnnotations(pdfium, pageHandle) {
  const count = Number(pdfium.FPDFPage_GetAnnotCount(pageHandle) || 0);
  const annotations = [];
  for (let index = 0; index < count; index += 1) {
    const annotation = pdfium.FPDFPage_GetAnnot(pageHandle, index);
    if (!annotation) continue;
    try {
      const subtype = Number(pdfium.FPDFAnnot_GetSubtype(annotation));
      const record = { index, subtype, rect: readAnnotationRect(pdfium, annotation) };
      if (subtype === PDF_ANNOT_REDACT) {
        record.quadPoints = readAnnotationQuadPoints(pdfium, annotation);
      } else {
        record.popupIndex = linkedAnnotationIndex(pdfium, pageHandle, annotation, 'Popup');
        record.parentIndex = subtype === PDF_ANNOT_POPUP
          ? linkedAnnotationIndex(pdfium, pageHandle, annotation, 'Parent') : -1;
        record.replyToIndex = linkedAnnotationIndex(pdfium, pageHandle, annotation, 'IRT');
      }
      annotations.push(record);
    } finally {
      pdfium.FPDFPage_CloseAnnot(annotation);
    }
  }
  return annotations;
}

function removeAnnotationAt(pdfium, pageHandle, index) {
  // EmbedPDF's variant also deletes the indirect object, so the removed text
  // is not written as an orphan.
  if (typeof pdfium.EPDFPage_RemoveAnnot === 'function') return Boolean(pdfium.EPDFPage_RemoveAnnot(pageHandle, index));
  return Boolean(pdfium.FPDFPage_RemoveAnnot(pageHandle, index));
}

function writeQuads(pdfium, rects) {
  const pointer = pdfium.pdfium.wasmExports.malloc(Math.max(1, rects.length) * 32);
  const heap = pdfium.pdfium.HEAPF32;
  rects.forEach((rect, index) => {
    const base = (pointer >> 2) + index * 8;
    // FS_QUADPOINTSF x1 y1 x2 y2 x3 y3 x4 y4; the native code uses its bounds.
    [rect.left, rect.top, rect.right, rect.top, rect.left, rect.bottom, rect.right, rect.bottom]
      .forEach((value, offset) => { heap[base + offset] = value; });
  });
  return pointer;
}

function redactContentInRects(pdfium, pageHandle, rects) {
  if (!rects.length || typeof pdfium.EPDFText_RedactInQuads !== 'function') return false;
  const pointer = writeQuads(pdfium, rects);
  try {
    return Boolean(pdfium.EPDFText_RedactInQuads(pageHandle, pointer, rects.length, true, false));
  } finally {
    pdfium.pdfium.wasmExports.free(pointer);
  }
}

function readPageGlyphs(pdfium, pageHandle) {
  const textPage = pdfium.FPDFText_LoadPage(pageHandle);
  if (!textPage) return null;
  const pointer = pdfium.pdfium.wasmExports.malloc(32);
  try {
    const count = Math.max(0, Number(pdfium.FPDFText_CountChars(textPage) || 0));
    const glyphs = [];
    for (let index = 0; index < count; index += 1) {
      const code = Number(pdfium.FPDFText_GetUnicode(textPage, index)) >>> 0;
      let char = '';
      try { char = code ? String.fromCodePoint(code) : ''; } catch { char = ''; }
      const glyph = { index, char, generated: Number(pdfium.FPDFText_IsGenerated(textPage, index)) === 1, box: null };
      if (pdfium.FPDFText_GetCharOrigin(textPage, index, pointer, pointer + 8)) {
        glyph.originX = Number(pdfium.pdfium.getValue(pointer, 'double'));
        glyph.originY = Number(pdfium.pdfium.getValue(pointer + 8, 'double'));
      }
      if (pdfium.FPDFText_GetCharBox(textPage, index, pointer, pointer + 8, pointer + 16, pointer + 24)) {
        const box = normalizeRect({
          left: Number(pdfium.pdfium.getValue(pointer, 'double')),
          right: Number(pdfium.pdfium.getValue(pointer + 8, 'double')),
          bottom: Number(pdfium.pdfium.getValue(pointer + 16, 'double')),
          top: Number(pdfium.pdfium.getValue(pointer + 24, 'double')),
        });
        if (box && !rectIsEmpty(box)) glyph.box = box;
      }
      glyphs.push(glyph);
    }
    return glyphs;
  } finally {
    pdfium.pdfium.wasmExports.free(pointer);
    pdfium.FPDFText_ClosePage(textPage);
  }
}

// Tags the form widgets under the marks and removes every other annotation
// under them (with popups and replies). Marks stay.
function removeAnnotationsUnderMarks(pdfium, pageHandle, pageIndex, annotations, rects, report, createError) {
  // Form widgets are tagged while the annotation indices still hold.
  for (const index of widgetIndicesUnderMarks(annotations, rects)) {
    const annotation = pdfium.FPDFPage_GetAnnot(pageHandle, index);
    if (!annotation) continue;
    try {
      const flags = Number(pdfium.FPDFAnnot_GetFlags(annotation) || 0);
      if (!pdfium.FPDFAnnot_SetFlags(annotation, flags | PDF_ANNOT_FLAG_HIDDEN | REDACTED_WIDGET_FLAG)) {
        throw createError('PDFIUM_FAILURE', `PDFium could not mark form field ${index + 1} under a redaction on page ${pageIndex + 1}.`);
      }
      report.redactedFormWidgets += 1;
    } finally {
      pdfium.FPDFPage_CloseAnnot(annotation);
    }
  }

  // Annotations go first: the indices of the marks are read again below.
  for (const index of annotationIndicesToRemove(annotations, rects)) {
    if (!removeAnnotationAt(pdfium, pageHandle, index)) {
      throw createError('PDFIUM_FAILURE', `PDFium could not remove annotation ${index + 1} under a redaction on page ${pageIndex + 1}.`);
    }
    report.removedAnnotations += 1;
  }
}

// Applies every redaction mark on one loaded page of an export copy. Returns
// null when the page has none. `createError(codeName, message)` builds the
// engine error to throw. The caller regenerates the page content.
export function applyPageRedactions(pdfium, documentHandle, pageHandle, pageIndex, { createError }) {
  const annotations = readPageAnnotations(pdfium, pageHandle);
  const marks = annotations.filter(annotation => annotation.subtype === PDF_ANNOT_REDACT)
    .map(annotation => ({ ...annotation, ...redactionMarkRects(annotation) }));
  if (!marks.length) return null;
  if (typeof pdfium.EPDFAnnot_ApplyRedaction !== 'function') {
    throw createError('UNSUPPORTED_OPERATION', 'This PDFium build cannot apply redactions.');
  }
  const rects = marks.flatMap(mark => mark.rects);
  const report = { applied: 0, removedAnnotations: 0, redactedFormWidgets: 0, isolatedImages: 0, largeImages: 0,
    detachedForms: 0, rewrittenForms: 0, repairedGlyphs: 0 };

  removeAnnotationsUnderMarks(pdfium, pageHandle, pageIndex, annotations, rects, report, createError);

  redactContentInRects(pdfium, pageHandle, rects.map(rect => inflateRect(rect, REDACTION_EDGE_TOLERANCE)));

  // Applying a mark removes it from /Annots, so walk backwards. The
  // per-annotation entry point also works in the browser WASM build, where
  // the bulk EPDFPage_ApplyRedactions can stall.
  for (let index = Number(pdfium.FPDFPage_GetAnnotCount(pageHandle) || 0) - 1; index >= 0; index -= 1) {
    const annotation = pdfium.FPDFPage_GetAnnot(pageHandle, index);
    if (!annotation) continue;
    try {
      if (Number(pdfium.FPDFAnnot_GetSubtype(annotation)) !== PDF_ANNOT_REDACT) continue;
      const mark = redactionMarkRects({
        rect: readAnnotationRect(pdfium, annotation),
        quadPoints: readAnnotationQuadPoints(pdfium, annotation),
      });
      if (mark.repairedRect && !writeAnnotationRect(pdfium, annotation, mark.repairedRect)) {
        throw createError('PDFIUM_FAILURE', `PDFium could not repair the empty redaction ${index + 1} on page ${pageIndex + 1}.`);
      }
      if (!pdfium.EPDFAnnot_ApplyRedaction(pageHandle, annotation)) {
        throw createError('PDFIUM_FAILURE', `PDFium could not apply redaction ${index + 1} on page ${pageIndex + 1}.`);
      }
      report.applied += 1;
    } finally {
      pdfium.FPDFPage_CloseAnnot(annotation);
    }
  }

  // Check with the text page, which also drives the editor's preview.
  let survivors = survivingGlyphs(readPageGlyphs(pdfium, pageHandle) || [], rects);
  if (survivors.length) {
    report.repairedGlyphs = survivors.length;
    redactContentInRects(pdfium, pageHandle, survivorRedactionRects(survivors));
    survivors = survivingGlyphs(readPageGlyphs(pdfium, pageHandle) || [], rects);
  }
  if (survivors.length) {
    throw createError('PDFIUM_FAILURE',
      `Redaction could not remove all text under the marks on page ${pageIndex + 1} ` +
      `(${survivors.length} character${survivors.length === 1 ? '' : 's'} left). The PDF was not saved.`);
  }
  return report;
}
