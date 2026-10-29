// berg:work: page tools – crop and resize pages (CropBox/MediaBox), split a PDF into several files, insert pages
// at a position. Pure helpers plus the pdf-lib pass that rewrites the page boxes; the shell commits the result as
// one snapshot transaction (one Undo step) and saves split parts.

export const PAGE_TOOL_UNITS = Object.freeze({ mm: 72 / 25.4, pt: 1, in: 72 });
// Smaller pages are refused: PDF viewers clamp boxes under 3 pt, and a 1 cm page is never what was meant.
export const MIN_PAGE_SIDE_PT = 18;

const SIDES = ['top', 'right', 'bottom', 'left'];

export function normalizedQuarterRotation(rotation) {
  const value = ((Math.round(Number(rotation) / 90) * 90) % 360 + 360) % 360;
  return Number.isFinite(value) ? value : 0;
}

/** Margins as the page is seen (top/right/bottom/left) mapped to the sides of the unrotated page box. */
export function boxInsetsForVisualMargins(margins = {}, rotation = 0) {
  const m = Object.fromEntries(SIDES.map(side => [side, Math.max(0, Number(margins[side]) || 0)]));
  switch (normalizedQuarterRotation(rotation)) {
    // /Rotate turns the page clockwise for display: the box's left edge is seen at the top after 90°.
    case 90: return { left: m.top, top: m.right, right: m.bottom, bottom: m.left };
    case 180: return { left: m.right, top: m.bottom, right: m.left, bottom: m.top };
    case 270: return { left: m.bottom, top: m.left, right: m.top, bottom: m.right };
    default: return { left: m.left, top: m.top, right: m.right, bottom: m.bottom };
  }
}

/** The box `{x, y, width, height}` (PDF units, y up) cut by visual margins; null when too little would stay. */
export function croppedBox(box, margins, rotation = 0, minSide = MIN_PAGE_SIDE_PT) {
  const inset = boxInsetsForVisualMargins(margins, rotation);
  const width = Number(box.width) - inset.left - inset.right;
  const height = Number(box.height) - inset.top - inset.bottom;
  if (!(width >= minSide) || !(height >= minSide)) return null;
  return { x: Number(box.x) + inset.left, y: Number(box.y) + inset.bottom, width, height };
}

/**
 * A new page size for a visible box. `target` is the size as seen (width × height, rotation applied).
 * With `scaleContent` the content is scaled uniformly to fit and centred on a page that starts at the origin;
 * without, the page grows or shrinks around the content's centre and nothing moves.
 * Returns the new box and, when the content moves, the matrix [a, b, c, d, e, f] to wrap it in.
 */
export function resizedPagePlan(box, rotation, target, { scaleContent = true } = {}) {
  const quarter = normalizedQuarterRotation(rotation) % 180 !== 0;
  const width = Number(quarter ? target.height : target.width);
  const height = Number(quarter ? target.width : target.height);
  if (!(width >= MIN_PAGE_SIDE_PT) || !(height >= MIN_PAGE_SIDE_PT)) return null;
  const bw = Number(box.width);
  const bh = Number(box.height);
  if (!(bw > 0) || !(bh > 0)) return null;
  if (!scaleContent) {
    const cx = Number(box.x) + bw / 2;
    const cy = Number(box.y) + bh / 2;
    return { box: { x: cx - width / 2, y: cy - height / 2, width, height }, matrix: null };
  }
  const scale = Math.min(width / bw, height / bh);
  const e = (width - scale * bw) / 2 - scale * Number(box.x);
  const f = (height - scale * bh) / 2 - scale * Number(box.y);
  return { box: { x: 0, y: 0, width, height }, matrix: [scale, 0, 0, scale, e, f], scale };
}

/**
 * The ink of an RGBA raster as visual margins in fractions of its size, or null for a blank page. A pixel counts
 * as ink when any channel is darker than `threshold` (and it is not transparent). Rows and columns with fewer
 * than `minInk` ink pixels are treated as speckle.
 */
export function inkMarginsFromRaster(data, width, height, { threshold = 244, minInk = 1, stride = width * 4 } = {}) {
  if (!data || !(width > 0) || !(height > 0)) return null;
  const rowInk = new Uint32Array(height);
  const colInk = new Uint32Array(width);
  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    for (let x = 0; x < width; x += 1) {
      const i = row + x * 4;
      if (data[i + 3] < 16) continue;
      if (data[i] < threshold || data[i + 1] < threshold || data[i + 2] < threshold) {
        rowInk[y] += 1;
        colInk[x] += 1;
      }
    }
  }
  const first = counts => counts.findIndex(count => count >= minInk);
  const last = counts => {
    for (let index = counts.length - 1; index >= 0; index -= 1) if (counts[index] >= minInk) return index;
    return -1;
  };
  const top = first(rowInk);
  if (top < 0) return null;
  const bottom = last(rowInk);
  const left = first(colInk);
  const right = last(colInk);
  return {
    top: top / height,
    bottom: (height - 1 - bottom) / height,
    left: left / width,
    right: (width - 1 - right) / width,
  };
}

/** Fractional margins in points of a visual page size, less a small breathing space, never negative. */
export function marginsFromFractions(fractions, size, padPt = 2) {
  if (!fractions) return null;
  const pad = value => Math.max(0, value - padPt);
  return {
    top: pad(fractions.top * size.height),
    bottom: pad(fractions.bottom * size.height),
    left: pad(fractions.left * size.width),
    right: pad(fractions.right * size.width),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Split plans. Ranges are 0-based and inclusive: { from, to, title? }.

export function splitEveryN(pageCount, n) {
  const per = Math.floor(Number(n));
  if (!(pageCount > 0) || !(per >= 1)) return [];
  const parts = [];
  for (let from = 0; from < pageCount; from += per) parts.push({ from, to: Math.min(pageCount, from + per) - 1 });
  return parts;
}

/**
 * One part per top-level bookmark: from its page up to the page before the next top-level bookmark. Pages before
 * the first bookmark make their own part. Bookmarks that point to the same page as an earlier one are merged
 * into it (the first title wins); bookmarks out of page order are taken in page order.
 */
export function splitAtBookmarks(pageCount, bookmarks = []) {
  const starts = new Map();
  for (const bookmark of bookmarks) {
    if ((bookmark?.depth || 0) !== 0) continue;
    const index = Number(bookmark.pageIndex);
    if (!Number.isSafeInteger(index) || index < 0 || index >= pageCount || starts.has(index)) continue;
    starts.set(index, String(bookmark.title || '').trim());
  }
  if (!starts.size || !(pageCount > 0)) return [];
  const indices = [...starts.keys()].sort((a, b) => a - b);
  const parts = [];
  if (indices[0] > 0) parts.push({ from: 0, to: indices[0] - 1, title: '' });
  indices.forEach((from, k) => {
    parts.push({ from, to: (k + 1 < indices.length ? indices[k + 1] : pageCount) - 1, title: starts.get(from) });
  });
  return parts;
}

/**
 * Parts of at most `maxBytes` each, as long as possible. `measure(from, to)` resolves to the byte size of a part
 * holding those pages. A single page larger than the limit becomes a part of its own (reported as `oversize`).
 * Grows each part by doubling, then narrows by bisection: about 2·log2(n) measurements per part.
 */
export async function splitBySize(pageCount, maxBytes, measure) {
  const limit = Number(maxBytes);
  if (!(pageCount > 0) || !(limit > 0)) return [];
  const parts = [];
  let from = 0;
  while (from < pageCount) {
    const fits = async to => (await measure(from, to)) <= limit;
    if (!await fits(from)) {
      parts.push({ from, to: from, oversize: true });
      from += 1;
      continue;
    }
    let good = from;
    let step = 1;
    let bad = -1;
    while (good < pageCount - 1) {
      const probe = Math.min(pageCount - 1, good + step);
      if (await fits(probe)) { good = probe; step *= 2; } else { bad = probe; break; }
    }
    if (bad > 0) {
      let low = good;
      let high = bad;
      while (high - low > 1) {
        const mid = Math.floor((low + high) / 2);
        if (await fits(mid)) low = mid; else high = mid;
      }
      good = low;
    }
    parts.push({ from, to: good });
    from = good + 1;
  }
  return parts;
}

function safeFileStem(text) {
  return String(text || '')
    .normalize('NFC')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/^\.+/u, '')
    .slice(0, 80)
    .trim();
}

/** File names for split parts: "<base> – <bookmark>.pdf" or "<base> – pages 4–6.pdf", unique, filesystem-safe. */
export function splitPartFileNames(baseName, parts) {
  const base = safeFileStem(String(baseName || 'document').replace(/\.pdf$/iu, '')) || 'document';
  const digits = String(parts.length).length;
  const used = new Set();
  return parts.map((part, index) => {
    const pages = part.from === part.to ? `page ${part.from + 1}` : `pages ${part.from + 1}-${part.to + 1}`;
    const label = safeFileStem(part.title);
    let stem = `${base} - ${String(index + 1).padStart(digits, '0')} ${label || pages}`;
    let name = `${stem}.pdf`;
    for (let n = 2; used.has(name.toLowerCase()); n += 1) name = `${stem} (${n}).pdf`;
    used.add(name.toLowerCase());
    return name;
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Insertion

/** `incoming` placed at `index` (clamped to 0 … pages.length). */
export function pagesInsertedAt(pages, incoming, index) {
  const at = Math.max(0, Math.min(pages.length, Number.isSafeInteger(index) ? index : pages.length));
  return [...pages.slice(0, at), ...incoming, ...pages.slice(at)];
}

// ---------------------------------------------------------------------------------------------------------------
// The pdf-lib pass

function transformPoint(matrix, x, y) {
  const [a, b, c, d, e, f] = matrix;
  return [a * x + c * y + e, b * x + d * y + f];
}

function transformNumberArray(PDFLib, context, array, matrix) {
  if (!(array instanceof PDFLib.PDFArray)) return null;
  const values = array.asArray().map(item => (item instanceof PDFLib.PDFNumber ? item.asNumber() : NaN));
  if (values.some(value => !Number.isFinite(value)) || values.length % 2) return null;
  const out = [];
  for (let index = 0; index < values.length; index += 2) out.push(...transformPoint(matrix, values[index], values[index + 1]));
  return context.obj(out);
}

// Annotation geometry follows scaled page content: the rectangle (its appearance stream is fitted to it), and
// the point lists of markup, ink, line and polygon annotations.
function transformAnnotation(PDFLib, context, annot, matrix) {
  const name = PDFLib.PDFName.of;
  const rect = annot.lookup(name('Rect'));
  if (rect instanceof PDFLib.PDFArray && rect.size() === 4) {
    const v = rect.asArray().map(item => (item instanceof PDFLib.PDFNumber ? item.asNumber() : NaN));
    if (v.every(Number.isFinite)) {
      const [x0, y0] = transformPoint(matrix, Math.min(v[0], v[2]), Math.min(v[1], v[3]));
      const [x1, y1] = transformPoint(matrix, Math.max(v[0], v[2]), Math.max(v[1], v[3]));
      annot.set(name('Rect'), context.obj([Math.min(x0, x1), Math.min(y0, y1), Math.max(x0, x1), Math.max(y0, y1)]));
    }
  }
  for (const key of ['QuadPoints', 'Vertices', 'L', 'CL']) {
    const next = transformNumberArray(PDFLib, context, annot.lookup(name(key)), matrix);
    if (next) annot.set(name(key), next);
  }
  const ink = annot.lookup(name('InkList'));
  if (ink instanceof PDFLib.PDFArray) {
    const strokes = ink.asArray().map(stroke => transformNumberArray(PDFLib, context, context.lookup(stroke), matrix));
    if (strokes.every(Boolean)) annot.set(name('InkList'), context.obj(strokes));
  }
}

/** With `matchOrientation`, a landscape page gets the target size turned to landscape too (and vice versa). */
export function orientedTarget(resize, visible, rotation = 0) {
  if (!resize?.matchOrientation) return resize;
  const quarter = normalizedQuarterRotation(rotation) % 180 !== 0;
  const seenLandscape = (quarter ? visible.height : visible.width) > (quarter ? visible.width : visible.height);
  const targetLandscape = resize.width > resize.height;
  return seenLandscape === targetLandscape || resize.width === resize.height
    ? resize : { ...resize, width: resize.height, height: resize.width };
}

function setAllBoxes(PDFLib, page, box) {
  page.setMediaBox(box.x, box.y, box.width, box.height);
  page.setCropBox(box.x, box.y, box.width, box.height);
  // Trim, bleed and art boxes of the old size would point outside the new page.
  for (const key of ['TrimBox', 'BleedBox', 'ArtBox']) page.node.delete(PDFLib.PDFName.of(key));
}

/**
 * Crop or resize pages in PDF bytes. `pageIndices`: the 0-based pages to change. One of
 *   `crop: { top, right, bottom, left }` (points, as the page is seen; cuts the visible box, sets the CropBox),
 *   `cropByIndex: { [pageIndex]: margins }` (a crop of its own per page, e.g. its white margins), or
 *   `resize: { width, height, scaleContent, matchOrientation }` (points as seen; sets MediaBox and CropBox).
 * Existing page objects keep their order and object numbers. Returns the bytes and the pages that changed; a page
 * the cut would leave too small is reported in `skipped`.
 */
export async function applyPageBoxes(PDFLib, bytes, { pageIndices = [], crop = null, cropByIndex = null, resize = null } = {}) {
  const pdf = await PDFLib.PDFDocument.load(bytes, { updateMetadata: false });
  const pages = pdf.getPages();
  const changed = [];
  const skipped = [];
  for (const index of [...new Set(pageIndices)].sort((a, b) => a - b)) {
    const page = pages[index];
    if (!page) continue;
    const rotation = page.getRotation().angle;
    const visible = page.getCropBox();
    const pageCrop = cropByIndex ? cropByIndex[index] : crop;
    if (crop || cropByIndex) {
      if (!pageCrop) continue;
      const box = croppedBox(visible, pageCrop, rotation);
      if (!box) { skipped.push(index); continue; }
      page.setCropBox(box.x, box.y, box.width, box.height);
      changed.push(index);
    } else if (resize) {
      const plan = resizedPagePlan(visible, rotation, orientedTarget(resize, visible, rotation),
        { scaleContent: resize.scaleContent !== false });
      if (!plan) { skipped.push(index); continue; }
      if (plan.matrix) {
        const [a, b, c, d, e, f] = plan.matrix;
        page.node.normalize();
        const start = page.doc.context.flateStream(`q ${[a, b, c, d, e, f].map(value => +value.toFixed(6)).join(' ')} cm\n`);
        const end = page.doc.context.flateStream('\nQ');
        page.node.wrapContentStreams(page.doc.context.register(start), page.doc.context.register(end));
        const annots = page.node.Annots();
        for (let k = 0; annots && k < annots.size(); k += 1) {
          const annot = annots.lookup(k);
          if (annot instanceof PDFLib.PDFDict) transformAnnotation(PDFLib, pdf.context, annot, plan.matrix);
        }
      }
      setAllBoxes(PDFLib, page, plan.box);
      changed.push(index);
    }
  }
  if (!changed.length) return { bytes: null, changed, skipped };
  const out = await pdf.save({ useObjectStreams: false, addDefaultPage: false, updateFieldAppearances: false });
  return { bytes: new Uint8Array(out), changed, skipped };
}
