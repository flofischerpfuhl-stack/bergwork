// Applies the redaction marks of one page of an export copy.
//
// PDFium's native redactor (EPDFAnnot_ApplyRedaction, EmbedPDF fork) removes
// page content under a mark: glyphs whose font box touches it, paths and
// shadings inside it, and image pixels under it. On its own it leaves four
// gaps, which this module closes in front of and behind the native call:
//
// 1. Annotations. The native call only rewrites page content. A FreeText,
//    typed signature, note or link under a mark kept its /Contents and its
//    appearance stream. Annotations that intersect a mark are removed, like
//    Acrobat does, together with their popups and replies.
// 2. Shared resources. The native call overwrites an image stream in place
//    and regenerates a Form XObject in place. Both may be used by other pages,
//    which then changed too (a logo on every slide). Every image under a mark
//    is given a page-local copy first, and a shared Form XObject under a mark
//    is detached through the copy-on-write Form writer. The copy is rendered
//    at the image's own pixel size, so a soft mask with /Matte stays correct
//    (the native code drops /Matte and turns premultiplied colours grey).
// 3. Edges. A font without glyph boxes gives the native test a zero-area box
//    at the glyph origin, and the test is strict. A glyph that starts exactly
//    on the left or bottom edge of a mark therefore survived, and the editor's
//    marks start exactly there (object bounds, snapped glyph boxes). A first
//    pass with every mark grown by REDACTION_EDGE_TOLERANCE removes them.
// 4. Degenerate marks. A mark with zero width or height made the native call
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
const PAGE_OBJECT_IMAGE = 3;
const PAGE_OBJECT_FORM = 5;

// Grows each mark for the first native pass. Snapped marks keep 0.25 pt
// (REDACTION_CLEARANCE) away from glyphs they must not remove, so 0.1 pt
// cannot reach a neighbour.
export const REDACTION_EDGE_TOLERANCE = 0.1;
// Half height (or width) given to a mark that has none.
export const REDACTION_DEGENERATE_HALF_EXTENT = 0.5;
// A glyph counts as surviving when its box reaches this far into a mark.
export const REDACTION_SURVIVOR_INSET = 0.2;
// Images above this many pixels keep the native in-place rewrite: a rendered
// copy would need four bytes per pixel more in the WebAssembly heap.
export const REDACTION_IMAGE_COPY_PIXEL_LIMIT = 25 * 1024 * 1024;
// A page PDFium's content generator cannot write back (spot, calibrated or
// pattern colours, generator-color-safety.js) is redacted as an image: at
// this resolution, within this pixel budget.
export const REDACTION_RASTER_DPI = 200;
export const REDACTION_RASTER_PIXEL_LIMIT = 24 * 1024 * 1024;
const FORM_DEPTH_LIMIT = 12;
const OBJECT_VISIT_LIMIT = 200_000;

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

export function multiplyMatrices(first, then) {
  // `first` maps into the space `then` maps from (PDF row-vector convention).
  return {
    a: first.a * then.a + first.b * then.c,
    b: first.a * then.b + first.b * then.d,
    c: first.c * then.a + first.d * then.c,
    d: first.c * then.b + first.d * then.d,
    e: first.e * then.a + first.f * then.c + then.e,
    f: first.e * then.b + first.f * then.d + then.f,
  };
}

export const IDENTITY_MATRIX = Object.freeze({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });

export function transformRect(matrix, rect) {
  const points = [
    [rect.left, rect.bottom], [rect.right, rect.bottom], [rect.left, rect.top], [rect.right, rect.top],
  ].map(([x, y]) => [matrix.a * x + matrix.c * y + matrix.e, matrix.b * x + matrix.d * y + matrix.f]);
  return {
    left: Math.min(...points.map(point => point[0])),
    bottom: Math.min(...points.map(point => point[1])),
    right: Math.max(...points.map(point => point[0])),
    top: Math.max(...points.map(point => point[1])),
  };
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
// A read-only index of the serialized export copy. PDFium has no getter for
// a Form's /Matrix or for the object behind an image, and its own output
// writes every object as a plain indirect object, so a small tokenizer finds
// dictionaries by object number, image streams by their raw bytes, and who
// refers to an object.

const DELIMITERS = new Set(['(', ')', '<', '>', '[', ']', '{', '}', '/', '%']);
const isWhite = char => char === ' ' || char === '\n' || char === '\r' || char === '\t' || char === '\f' || char === '\0';
const SHARING_DEPTH_LIMIT = 16;

class PdfTokenizer {
  constructor(text, position) {
    this.text = text;
    this.position = position;
  }

  skip() {
    const { text } = this;
    while (this.position < text.length) {
      const char = text[this.position];
      if (isWhite(char)) { this.position += 1; continue; }
      if (char === '%') {
        while (this.position < text.length && text[this.position] !== '\n' && text[this.position] !== '\r') this.position += 1;
        continue;
      }
      return;
    }
  }

  token() {
    this.skip();
    const { text } = this;
    const start = this.position;
    if (start >= text.length) return null;
    const char = text[start];
    if (char === '<' && text[start + 1] === '<') { this.position += 2; return { type: '<<' }; }
    if (char === '>' && text[start + 1] === '>') { this.position += 2; return { type: '>>' }; }
    if (char === '[' || char === ']') { this.position += 1; return { type: char }; }
    if (char === '(') { this.position = skipLiteralString(text, start); return { type: 'string' }; }
    if (char === '<') { this.position = (text.indexOf('>', start) + 1) || text.length; return { type: 'string' }; }
    let end = start + 1;
    while (end < text.length && !isWhite(text[end]) && !DELIMITERS.has(text[end])) end += 1;
    this.position = end;
    if (char === '/') return { type: 'name', value: text.slice(start + 1, end) };
    const word = text.slice(start, end);
    const number = Number(word);
    return Number.isFinite(number) && word !== '' ? { type: 'number', value: number } : { type: 'keyword', value: word };
  }

  // One object: numbers, references, names, strings, arrays and dictionaries.
  object(token = this.token(), depth = 0) {
    if (!token || depth > 64) return null;
    if (token.type === 'number') {
      const save = this.position;
      const second = this.token();
      if (second?.type === 'number' && Number.isInteger(token.value) && Number.isInteger(second.value)) {
        const third = this.token();
        if (third?.type === 'keyword' && third.value === 'R') return { ref: token.value };
      }
      this.position = save;
      return token.value;
    }
    if (token.type === 'name') return { name: token.value };
    if (token.type === '[') {
      const items = [];
      for (let next = this.token(); next && next.type !== ']'; next = this.token()) items.push(this.object(next, depth + 1));
      return items;
    }
    if (token.type === '<<') {
      const entries = new Map();
      for (let key = this.token(); key && key.type !== '>>'; key = this.token()) {
        if (key.type !== 'name') continue;
        entries.set(key.value, this.object(this.token(), depth + 1));
      }
      return entries;
    }
    return token.type === 'keyword' ? { keyword: token.value } : null;
  }
}

function skipLiteralString(text, start) {
  let depth = 0;
  for (let position = start; position < text.length; position += 1) {
    const char = text[position];
    if (char === '\\') { position += 1; continue; }
    if (char === '(') depth += 1;
    if (char === ')') {
      depth -= 1;
      if (depth === 0) return position + 1;
    }
  }
  return text.length;
}

function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return false;
  return true;
}

export function createSerializedPdfIndex(bytes) {
  let text = null;
  let starts = null; // object number -> offset after "N G obj"
  let sortedStarts = null; // [offset, object number], ascending
  let references = null; // object number -> offsets of "N G R"
  let images = null; // `${width}x${height}:${length}` -> [{ objectNumber, dataStart }]
  const parsed = new Map();

  const ensureIndex = () => {
    if (starts) return;
    text = new TextDecoder('latin1').decode(bytes);
    starts = new Map();
    for (const match of text.matchAll(/(?:^|[^0-9])(\d+)\s+\d+\s+obj\b/gu)) {
      starts.set(Number(match[1]), match.index + match[0].length);
    }
    sortedStarts = [...starts.entries()].map(([number, offset]) => [offset, number]).sort((x, y) => x[0] - y[0]);
  };
  const object = objectNumber => {
    ensureIndex();
    if (parsed.has(objectNumber)) return parsed.get(objectNumber);
    const start = starts.get(objectNumber);
    let value = null;
    let end = start;
    if (start != null) {
      const tokenizer = new PdfTokenizer(text, start);
      value = tokenizer.object();
      end = tokenizer.position;
    }
    const record = { value, end };
    parsed.set(objectNumber, record);
    return record;
  };
  const resolve = value => (value && typeof value === 'object' && 'ref' in value ? object(value.ref).value : value);
  const containerOf = offset => {
    let low = 0;
    let high = sortedStarts.length - 1;
    let found = null;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (sortedStarts[middle][0] <= offset) { found = sortedStarts[middle][1]; low = middle + 1; } else high = middle - 1;
    }
    return found;
  };
  const ensureReferences = () => {
    ensureIndex();
    if (references) return;
    references = new Map();
    for (const match of text.matchAll(/(?:^|[^0-9.])(\d+)\s+\d+\s+R(?![A-Za-z0-9])/gu)) {
      const number = Number(match[1]);
      if (!references.has(number)) references.set(number, []);
      references.get(number).push(match.index);
    }
  };
  const ensureImages = () => {
    ensureIndex();
    if (images) return;
    images = new Map();
    for (const [number] of starts) {
      const start = starts.get(number);
      // Cheap filter before tokenizing every dictionary.
      if (!/\/Subtype\s*\/Image/u.test(text.slice(start, start + 2048))) continue;
      const { value, end } = object(number);
      if (!(value instanceof Map) || value.get('Subtype')?.name !== 'Image') continue;
      const width = resolve(value.get('Width'));
      const height = resolve(value.get('Height'));
      const length = resolve(value.get('Length'));
      const tokenizer = new PdfTokenizer(text, end);
      const keyword = tokenizer.token();
      if (keyword?.value !== 'stream' || !Number.isInteger(length)) continue;
      let dataStart = tokenizer.position;
      if (text[dataStart] === '\r') dataStart += 1;
      if (text[dataStart] === '\n') dataStart += 1;
      const key = `${width}x${height}:${length}`;
      if (!images.has(key)) images.set(key, []);
      images.get(key).push({ objectNumber: number, dataStart, length });
    }
  };
  // Whether more than one page can reach this object: it is referenced twice,
  // or its one referrer is shared. Unknown counts as shared.
  const isShared = (objectNumber, depth = 0) => {
    ensureReferences();
    if (depth > SHARING_DEPTH_LIMIT) return true;
    const offsets = (references.get(objectNumber) || []).filter(offset => containerOf(offset) !== objectNumber);
    if (offsets.length !== 1) return true;
    const container = containerOf(offsets[0]);
    if (container == null) return true;
    const value = object(container).value;
    if (value instanceof Map && value.get('Type')?.name === 'Page') return false;
    if (value instanceof Map && value.get('Type')?.name === 'Pages') return true;
    return isShared(container, depth + 1);
  };

  return {
    // objectNumber -> { a, b, c, d, e, f } of a Form, identity without /Matrix.
    formMatrix(objectNumber) {
      try {
        const value = object(Number(objectNumber)).value;
        if (!(value instanceof Map)) return null;
        const matrix = resolve(value.get('Matrix'));
        if (matrix == null) return IDENTITY_MATRIX;
        const values = Array.isArray(matrix) ? matrix.map(resolve) : [];
        if (values.length !== 6 || !values.every(Number.isFinite)) return null;
        const [a, b, c, d, e, f] = values;
        return { a, b, c, d, e, f };
      } catch {
        return null;
      }
    },
    // 'single' when exactly one image stream has these raw bytes and only one
    // page reaches it, 'shared' when more can, 'unknown' when none matches
    // (an inline image, or an object PDFium wrote differently).
    imageSharing(raw, width, height) {
      try {
        ensureImages();
        const candidates = (images.get(`${width}x${height}:${raw.length}`) || [])
          .filter(candidate => sameBytes(bytes.subarray(candidate.dataStart, candidate.dataStart + candidate.length), raw));
        if (!candidates.length) return 'unknown';
        if (candidates.length > 1) return 'shared';
        return isShared(candidates[0].objectNumber) ? 'shared' : 'single';
      } catch {
        return 'unknown';
      }
    },
  };
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

function readObjectMatrix(pdfium, objectHandle) {
  return withMemory(pdfium, 24, pointer => {
    if (!pdfium.FPDFPageObj_GetMatrix(objectHandle, pointer)) return null;
    const [a, b, c, d, e, f] = [0, 4, 8, 12, 16, 20].map(offset => heapFloat(pdfium, pointer + offset));
    return { a, b, c, d, e, f };
  });
}

function writeObjectMatrix(pdfium, objectHandle, matrix) {
  return withMemory(pdfium, 24, pointer => {
    const heap = pdfium.pdfium.HEAPF32;
    ['a', 'b', 'c', 'd', 'e', 'f'].forEach((key, index) => { heap[(pointer >> 2) + index] = matrix[key]; });
    return Boolean(pdfium.FPDFPageObj_SetMatrix(objectHandle, pointer));
  });
}

function readObjectBounds(pdfium, objectHandle) {
  return withMemory(pdfium, 16, pointer => {
    if (!pdfium.FPDFPageObj_GetBounds(objectHandle, pointer, pointer + 4, pointer + 8, pointer + 12)) return null;
    return normalizeRect({
      left: heapFloat(pdfium, pointer),
      bottom: heapFloat(pdfium, pointer + 4),
      right: heapFloat(pdfium, pointer + 8),
      top: heapFloat(pdfium, pointer + 12),
    });
  });
}

function readFormSharing(pdfium, formHandle) {
  if (typeof pdfium.EPDFFormObj_GetSharingInfo !== 'function') return null;
  return withMemory(pdfium, 32, pointer => {
    pdfium.pdfium.HEAPU8.fill(0, pointer, pointer + 32);
    pdfium.pdfium.setValue(pointer, 32, 'i32');
    if (!pdfium.EPDFFormObj_GetSharingInfo(formHandle, pointer)) return null;
    return {
      isShared: Number(pdfium.pdfium.getValue(pointer + 8, 'i32')) !== 0,
      streamObjectNumber: Number(pdfium.pdfium.getValue(pointer + 12, 'i32')) >>> 0,
    };
  });
}

function readObjectOpacity(pdfium, objectHandle) {
  if (typeof pdfium.PDFiumExt_GetObjectOpacity !== 'function') return null;
  return withMemory(pdfium, 8, pointer => {
    if (!pdfium.PDFiumExt_GetObjectOpacity(objectHandle, pointer, pointer + 4)) return null;
    return { fill: heapFloat(pdfium, pointer), stroke: heapFloat(pdfium, pointer + 4) };
  });
}

// Renders an image object at its own pixel size, soft mask, decode array and
// colour space applied, and returns a page-local opaque BGR or BGRA bitmap.
function renderImageAtPixelSize(pdfium, documentHandle, pageHandle, objectHandle, width, height) {
  const matrix = readObjectMatrix(pdfium, objectHandle);
  if (!matrix) return 0;
  // FPDFImageObj_GetRenderedBitmap sizes its output from the matrix scale and
  // multiplies the object's fill alpha in. Render with a pixel-sized,
  // unrotated matrix and full alpha, then restore both.
  const opacity = readObjectOpacity(pdfium, objectHandle);
  const resetOpacity = opacity && opacity.fill < 1 && typeof pdfium.PDFiumExt_SetObjectAlphaChannels === 'function';
  let rendered = 0;
  try {
    if (resetOpacity && !pdfium.PDFiumExt_SetObjectAlphaChannels(objectHandle, 1, opacity.stroke)) return 0;
    if (!writeObjectMatrix(pdfium, objectHandle, { a: width, b: 0, c: 0, d: height, e: 0, f: 0 })) return 0;
    rendered = pdfium.FPDFImageObj_GetRenderedBitmap(documentHandle, pageHandle, objectHandle);
  } finally {
    writeObjectMatrix(pdfium, objectHandle, matrix);
    if (resetOpacity) pdfium.PDFiumExt_SetObjectAlphaChannels(objectHandle, opacity.fill, opacity.stroke);
  }
  return rendered;
}

function bitmapToOpaqueBgrIfPossible(pdfium, bitmap) {
  const width = Number(pdfium.FPDFBitmap_GetWidth(bitmap));
  const height = Number(pdfium.FPDFBitmap_GetHeight(bitmap));
  const stride = Number(pdfium.FPDFBitmap_GetStride(bitmap));
  const format = Number(pdfium.FPDFBitmap_GetFormat(bitmap));
  const source = Number(pdfium.FPDFBitmap_GetBuffer(bitmap));
  if (format !== 4) return 0;
  let heap = pdfium.pdfium.HEAPU8;
  for (let y = 0; y < height; y += 1) {
    const row = source + y * stride;
    for (let x = 0; x < width; x += 1) if (heap[row + x * 4 + 3] !== 255) return 0;
  }
  // FPDFBitmap_BGR = 2: written without a soft mask.
  const opaque = pdfium.FPDFBitmap_CreateEx(width, height, 2, 0, 0);
  if (!opaque) return 0;
  // The allocation may have grown the WebAssembly memory and detached the
  // old heap view.
  heap = pdfium.pdfium.HEAPU8;
  const target = Number(pdfium.FPDFBitmap_GetBuffer(opaque));
  const targetStride = Number(pdfium.FPDFBitmap_GetStride(opaque));
  for (let y = 0; y < height; y += 1) {
    const row = source + y * stride;
    const out = target + y * targetStride;
    for (let x = 0; x < width; x += 1) {
      heap[out + x * 3] = heap[row + x * 4];
      heap[out + x * 3 + 1] = heap[row + x * 4 + 1];
      heap[out + x * 3 + 2] = heap[row + x * 4 + 2];
    }
  }
  return opaque;
}

// Gives one image object a page-local copy of its image. The shipped PDFium
// patch makes FPDFImageObj_SetBitmap detach exactly this object from a shared
// CPDF_Image; the unused original drops out of the page resources when the
// holder is regenerated.
function readImageDataRaw(pdfium, objectHandle) {
  if (typeof pdfium.FPDFImageObj_GetImageDataRaw !== 'function') return null;
  const length = Number(pdfium.FPDFImageObj_GetImageDataRaw(objectHandle, 0, 0) || 0);
  if (!(length > 0)) return null;
  return withMemory(pdfium, length, pointer => {
    if (Number(pdfium.FPDFImageObj_GetImageDataRaw(objectHandle, pointer, length)) !== length) return null;
    return pdfium.pdfium.HEAPU8.slice(pointer, pointer + length);
  });
}

// The native rewrite is right for an opaque image only this page uses; a
// copy is needed when other pages share it, or when its transparency (a soft
// mask, perhaps with /Matte) would not survive the rewrite.
function imageNeedsCopy(pdfium, objectHandle, size, imageSharing) {
  if (!imageSharing || typeof pdfium.FPDFPageObj_HasTransparency !== 'function') return true;
  if (pdfium.FPDFPageObj_HasTransparency(objectHandle)) return true;
  const raw = readImageDataRaw(pdfium, objectHandle);
  return !raw || imageSharing(raw, size.width, size.height) !== 'single';
}

function isolateImageObject(pdfium, documentHandle, pageHandle, objectHandle, imageSharing) {
  if (typeof pdfium.FPDFImageObj_GetRenderedBitmap !== 'function' || typeof pdfium.FPDFImageObj_SetBitmap !== 'function') {
    return 'unsupported';
  }
  const size = withMemory(pdfium, 8, pointer => (pdfium.FPDFImageObj_GetImagePixelSize(objectHandle, pointer, pointer + 4)
    ? { width: pdfium.pdfium.HEAPU32[pointer >> 2], height: pdfium.pdfium.HEAPU32[(pointer + 4) >> 2] } : null));
  if (!size || !(size.width > 0 && size.height > 0)) return 'unsupported';
  if (!imageNeedsCopy(pdfium, objectHandle, size, imageSharing)) return 'page-local';
  if (size.width * size.height > REDACTION_IMAGE_COPY_PIXEL_LIMIT) return 'too-large';
  const rendered = renderImageAtPixelSize(pdfium, documentHandle, pageHandle, objectHandle, size.width, size.height);
  if (!rendered) return 'unsupported';
  let opaque = 0;
  try {
    opaque = bitmapToOpaqueBgrIfPossible(pdfium, rendered);
    if (!pdfium.FPDFImageObj_SetBitmap(0, 0, objectHandle, opaque || rendered)) return 'unsupported';
    return 'isolated';
  } finally {
    if (opaque) pdfium.FPDFBitmap_Destroy(opaque);
    pdfium.FPDFBitmap_Destroy(rendered);
  }
}

// Walks the page's object tree in page space. Each visit gets the object, its
// type, its page-space bounds and the chain of Form objects that hold it.
function visitPageObjects(pdfium, pageHandle, visit) {
  let visited = 0;
  const walk = (handles, toPage, formChain) => {
    for (const handle of handles) {
      visited += 1;
      if (visited > OBJECT_VISIT_LIMIT) return;
      const type = Number(pdfium.FPDFPageObj_GetType(handle));
      let bounds = null;
      if (type === PAGE_OBJECT_IMAGE) {
        const matrix = readObjectMatrix(pdfium, handle);
        if (matrix) bounds = transformRect(multiplyMatrices(matrix, toPage), { left: 0, bottom: 0, right: 1, top: 1 });
      } else {
        const local = readObjectBounds(pdfium, handle);
        if (local) bounds = transformRect(toPage, local);
      }
      visit({ handle, type, bounds, formChain });
      if (type === PAGE_OBJECT_FORM && formChain.length < FORM_DEPTH_LIMIT) {
        const matrix = readObjectMatrix(pdfium, handle) || IDENTITY_MATRIX;
        const count = Number(pdfium.FPDFFormObj_CountObjects(handle) || 0);
        const children = [];
        for (let index = 0; index < count; index += 1) {
          const child = pdfium.FPDFFormObj_GetObject(handle, index);
          if (child) children.push(child);
        }
        walk(children, multiplyMatrices(matrix, toPage), [...formChain, handle]);
      }
    }
  };
  const count = Number(pdfium.FPDFPage_CountObjects(pageHandle) || 0);
  const top = [];
  for (let index = 0; index < count; index += 1) {
    const handle = pdfium.FPDFPage_GetObject(pageHandle, index);
    if (handle) top.push(handle);
  }
  walk(top, IDENTITY_MATRIX, []);
}

// Makes everything the native redactor will rewrite under `rects` local to
// this page: image copies, then copy-on-write of each Form path that holds a
// changed object (deepest first, so a Form's new content names the copies).
// The Forms that hold content under a mark: Form object -> { depth, matrix }
// with the Form's /Matrix read before anything is detached (a detached copy
// has a new object number but the same /Matrix).
function marksReachNestedForms(pdfium, pageHandle, rects) {
  let nested = false;
  visitPageObjects(pdfium, pageHandle, ({ type, bounds, formChain }) => {
    if (!nested && type !== PAGE_OBJECT_FORM && formChain.length >= 2 && bounds && rectIntersectsAny(bounds, rects)) nested = true;
  });
  return nested;
}

function formsUnderMarks(pdfium, pageHandle, rects, formMatrixFor) {
  const forms = new Map();
  visitPageObjects(pdfium, pageHandle, ({ type, bounds, formChain }) => {
    if (type === PAGE_OBJECT_FORM || !bounds || !rectIntersectsAny(bounds, rects)) return;
    formChain.forEach((form, depth) => {
      if (forms.has(form)) return;
      // Counting references walks the whole document, so read it once.
      const sharing = readFormSharing(pdfium, form);
      const matrix = sharing?.streamObjectNumber ? formMatrixFor?.(sharing.streamObjectNumber) : null;
      forms.set(form, { depth, matrix: matrix || null, shared: !sharing || sharing.isShared, holdsCopy: false });
    });
  });
  return forms;
}

// Makes everything the native redactor will rewrite under `rects` local to
// this page: image copies, then copy-on-write of each Form path that holds a
// changed object (deepest first, so a Form's new content names the copies).
function isolateSharedContent(pdfium, documentHandle, pageHandle, rects, forms, imageSharing, createError) {
  const result = { isolatedImages: 0, largeImages: 0, detachedForms: 0 };
  visitPageObjects(pdfium, pageHandle, ({ handle, type, bounds, formChain }) => {
    if (type !== PAGE_OBJECT_IMAGE || !bounds || !rectIntersectsAny(bounds, rects)) return;
    const outcome = isolateImageObject(pdfium, documentHandle, pageHandle, handle, imageSharing);
    if (outcome === 'isolated') result.isolatedImages += 1;
    if (outcome === 'too-large') result.largeImages += 1;
    if (outcome === 'isolated') formChain.forEach(form => { if (forms.has(form)) forms.get(form).holdsCopy = true; });
  });
  if (!forms.size) return result;
  if (typeof pdfium.EPDFFormObj_GenerateContent !== 'function') {
    throw createError('UNSUPPORTED_OPERATION', 'This PDFium build cannot redact inside Form XObjects page-locally.');
  }
  // The writer detaches a shared path before writing it. An unshared Form
  // whose content only changes in the native call is left to that call.
  for (const [form, { shared, holdsCopy }] of deepestFirst(forms)) {
    // A Form inside a shared Form counts as shared, so a detached ancestor
    // never leaves an unshared descendant behind.
    if (!shared && !holdsCopy) continue;
    if (!pdfium.EPDFFormObj_GenerateContent(form, 0)) {
      throw createError('PDFIUM_FAILURE', 'PDFium could not make a Form XObject under a redaction page-local.');
    }
    if (shared) result.detachedForms += 1;
  }
  return result;
}

function deepestFirst(forms) {
  return [...forms.entries()].sort((a, b) => b[1].depth - a[1].depth);
}

export function isIdentityMatrix(matrix) {
  return !matrix || ['a', 'b', 'c', 'd', 'e', 'f'].every(key =>
    Math.abs(Number(matrix[key]) - IDENTITY_MATRIX[key]) < 1e-9);
}

export function invertMatrix(matrix) {
  const determinant = matrix.a * matrix.d - matrix.b * matrix.c;
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) return null;
  return {
    a: matrix.d / determinant,
    b: -matrix.b / determinant,
    c: -matrix.c / determinant,
    d: matrix.a / determinant,
    e: (matrix.c * matrix.f - matrix.d * matrix.e) / determinant,
    f: (matrix.b * matrix.e - matrix.a * matrix.f) / determinant,
  };
}

export function transformObjectAndClip(pdfium, handle, matrix) {
  const { a, b, c, d, e, f } = matrix;
  pdfium.FPDFPageObj_Transform(handle, a, b, c, d, e, f);
  const clip = typeof pdfium.FPDFPageObj_GetClipPath === 'function' ? pdfium.FPDFPageObj_GetClipPath(handle) : 0;
  if (clip && Number(pdfium.FPDFClipPath_CountPaths?.(clip) || 0) > 0) {
    const transformClip = typeof pdfium.FPDFPageObj_TransformClipPath === 'function'
      ? pdfium.FPDFPageObj_TransformClipPath.bind(pdfium)
      : pdfium.pdfium?._FPDFPageObj_TransformClipPath;
    transformClip?.(handle, a, b, c, d, e, f);
  }
}

// PDFium parses a Form's children with its /Matrix folded into their
// matrices, and its content writer writes them back like that while /Matrix
// stays in the dictionary: every regenerated Form with a non-identity /Matrix
// is drawn with that matrix twice (a slide background shrinks into a corner).
// Before the final write, take /Matrix out of the direct children again.
function unfoldFormMatrices(pdfium, forms, createError) {
  let rewritten = 0;
  for (const [form, { matrix }] of deepestFirst(forms)) {
    if (isIdentityMatrix(matrix)) continue;
    const inverse = invertMatrix(matrix);
    if (!inverse) continue;
    const count = Number(pdfium.FPDFFormObj_CountObjects(form) || 0);
    for (let index = 0; index < count; index += 1) {
      const child = pdfium.FPDFFormObj_GetObject(form, index);
      if (child) transformObjectAndClip(pdfium, child, inverse);
    }
    if (!pdfium.EPDFFormObj_GenerateContent(form, 0)) {
      throw createError('PDFIUM_FAILURE', 'PDFium could not write a redacted Form XObject.');
    }
    rewritten += 1;
  }
  return rewritten;
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
// `serialized` is createSerializedPdfIndex() of the bytes the copy was loaded
// from; without it every Form keeps PDFium's writer behaviour and every image
// under a mark is copied.
export function applyPageRedactions(pdfium, documentHandle, pageHandle, pageIndex, { createError, serialized = null }) {
  const formMatrixFor = serialized ? objectNumber => serialized.formMatrix(objectNumber) : null;
  const imageSharing = serialized ? (raw, width, height) => serialized.imageSharing(raw, width, height) : null;
  const annotations = readPageAnnotations(pdfium, pageHandle);
  const marks = annotations.filter(annotation => annotation.subtype === PDF_ANNOT_REDACT)
    .map(annotation => ({ ...annotation, ...redactionMarkRects(annotation) }));
  if (!marks.length) return null;
  if (typeof pdfium.EPDFAnnot_ApplyRedaction !== 'function') {
    throw createError('UNSUPPORTED_OPERATION', 'This PDFium build cannot apply redactions.');
  }
  const rects = marks.flatMap(mark => mark.rects);
  // The native redactor composes Form matrices in the wrong order from the
  // second nesting level on, so it would clear the wrong place there. Such
  // pages are redacted as an image instead.
  if (marksReachNestedForms(pdfium, pageHandle, rects)) {
    return rasterizePageRedactions(pdfium, documentHandle, pageHandle, pageIndex, { createError });
  }
  const report = { applied: 0, removedAnnotations: 0, redactedFormWidgets: 0, isolatedImages: 0, largeImages: 0,
    detachedForms: 0, rewrittenForms: 0, repairedGlyphs: 0 };

  removeAnnotationsUnderMarks(pdfium, pageHandle, pageIndex, annotations, rects, report, createError);

  const forms = formsUnderMarks(pdfium, pageHandle, rects, formMatrixFor);
  Object.assign(report, isolateSharedContent(pdfium, documentHandle, pageHandle, rects, forms, imageSharing, createError));
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
  report.rewrittenForms = unfoldFormMatrices(pdfium, forms, createError);
  return report;
}

// Redacts a page as an image: for pages PDFium's content generator cannot
// write back (spot, calibrated or pattern colours: regenerating them paints
// those areas black, generator-color-safety.js), and for marks over content
// in nested Forms, which the native redactor misplaces. The page is rendered without
// its annotations, the marks are filled black in the bitmap, and the bitmap
// replaces every page object, so nothing under a mark survives and the
// colours stay as they were. The page's text is no longer text. Annotations
// under a mark go as in applyPageRedactions; the marks themselves are removed.
// Returns null when the page has no marks.
export function rasterizePageRedactions(pdfium, documentHandle, pageHandle, pageIndex, { createError }) {
  const annotations = readPageAnnotations(pdfium, pageHandle);
  const marks = annotations.filter(annotation => annotation.subtype === PDF_ANNOT_REDACT)
    .map(annotation => ({ ...annotation, ...redactionMarkRects(annotation) }));
  if (!marks.length) return null;
  const rects = marks.flatMap(mark => mark.rects);
  const report = { applied: 0, rasterizedPages: 1, removedAnnotations: 0, redactedFormWidgets: 0 };
  const box = readPageBoundingBox(pdfium, pageHandle);
  if (!box) throw createError('PDFIUM_FAILURE', `PDFium could not read the size of page ${pageIndex + 1} to redact it.`);
  const widthPt = box.right - box.left;
  const heightPt = box.top - box.bottom;
  const scale = Math.max(0.25, Math.min(REDACTION_RASTER_DPI / 72, Math.sqrt(REDACTION_RASTER_PIXEL_LIMIT / (widthPt * heightPt))));
  const width = Math.max(1, Math.round(widthPt * scale));
  const height = Math.max(1, Math.round(heightPt * scale));
  // The page's /Rotate is part of PDFium's display matrix; cancel it so the
  // bitmap is in unrotated user space, where the image object is placed.
  const rotate = (4 - (Number(pdfium.FPDFPage_GetRotation(pageHandle)) || 0)) % 4;

  removeAnnotationsUnderMarks(pdfium, pageHandle, pageIndex, annotations, rects, report, createError);

  const bitmap = pdfium.FPDFBitmap_Create(width, height, 0);
  if (!bitmap) throw createError('PDFIUM_FAILURE', `PDFium could not allocate the image for redacted page ${pageIndex + 1}.`);
  let image = 0;
  try {
    pdfium.FPDFBitmap_FillRect(bitmap, 0, 0, width, height, 0xffffffff);
    pdfium.FPDF_RenderPageBitmap(bitmap, pageHandle, 0, 0, width, height, rotate, 0);
    for (const rect of rects) {
      const corners = [[rect.left, rect.bottom], [rect.right, rect.top], [rect.left, rect.top], [rect.right, rect.bottom]]
        .map(([x, y]) => pageToDevice(pdfium, pageHandle, width, height, rotate, x, y)).filter(Boolean);
      if (corners.length !== 4) throw createError('PDFIUM_FAILURE', `PDFium could not place a redaction on page ${pageIndex + 1}.`);
      const left = Math.max(0, Math.floor(Math.min(...corners.map(point => point.x))) - 1);
      const top = Math.max(0, Math.floor(Math.min(...corners.map(point => point.y))) - 1);
      const right = Math.min(width, Math.ceil(Math.max(...corners.map(point => point.x))) + 1);
      const bottom = Math.min(height, Math.ceil(Math.max(...corners.map(point => point.y))) + 1);
      if (right > left && bottom > top) pdfium.FPDFBitmap_FillRect(bitmap, left, top, right - left, bottom - top, 0xff000000);
    }
    for (let index = Number(pdfium.FPDFPage_CountObjects(pageHandle) || 0) - 1; index >= 0; index -= 1) {
      const object = pdfium.FPDFPage_GetObject(pageHandle, index);
      if (!object || !pdfium.FPDFPage_RemoveObject(pageHandle, object)) {
        throw createError('PDFIUM_FAILURE', `PDFium could not clear redacted page ${pageIndex + 1}.`);
      }
      pdfium.FPDFPageObj_Destroy(object);
    }
    image = pdfium.FPDFPageObj_NewImageObj(documentHandle);
    if (!image || !pdfium.FPDFImageObj_SetBitmap(0, 0, image, bitmap) ||
        !writeObjectMatrix(pdfium, image, { a: widthPt, b: 0, c: 0, d: heightPt, e: box.left, f: box.bottom })) {
      throw createError('PDFIUM_FAILURE', `PDFium could not write redacted page ${pageIndex + 1} as an image.`);
    }
    pdfium.FPDFPage_InsertObject(pageHandle, image);
    image = 0;
  } finally {
    if (image) pdfium.FPDFPageObj_Destroy(image);
    pdfium.FPDFBitmap_Destroy(bitmap);
  }
  for (let index = Number(pdfium.FPDFPage_GetAnnotCount(pageHandle) || 0) - 1; index >= 0; index -= 1) {
    const annotation = pdfium.FPDFPage_GetAnnot(pageHandle, index);
    if (!annotation) continue;
    let isMark = false;
    try {
      isMark = Number(pdfium.FPDFAnnot_GetSubtype(annotation)) === PDF_ANNOT_REDACT;
    } finally {
      pdfium.FPDFPage_CloseAnnot(annotation);
    }
    if (!isMark) continue;
    if (!removeAnnotationAt(pdfium, pageHandle, index)) {
      throw createError('PDFIUM_FAILURE', `PDFium could not remove redaction ${index + 1} on page ${pageIndex + 1}.`);
    }
    report.applied += 1;
  }
  return report;
}

function pageToDevice(pdfium, pageHandle, width, height, rotate, x, y) {
  return withMemory(pdfium, 8, pointer => {
    if (!pdfium.FPDF_PageToDevice(pageHandle, 0, 0, width, height, rotate, x, y, pointer, pointer + 4)) return null;
    return { x: pdfium.pdfium.getValue(pointer, 'i32'), y: pdfium.pdfium.getValue(pointer + 4, 'i32') };
  });
}

// The resolved display box (CropBox clipped to MediaBox, inherited or
// indirect boxes included) in user space.
function readPageBoundingBox(pdfium, pageHandle) {
  return withMemory(pdfium, 16, pointer => {
    if (!pdfium.FPDF_GetPageBoundingBox(pageHandle, pointer)) return null;
    // FS_RECTF is {left, top, right, bottom}.
    const [left, top, right, bottom] = [0, 4, 8, 12].map(offset => heapFloat(pdfium, pointer + offset));
    const box = normalizeRect({ left, bottom, right, top });
    return box && box.right > box.left && box.top > box.bottom ? box : null;
  });
}
