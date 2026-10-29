// Page stamps (text/image watermark, page numbers) are drawn on top of every
// page without rewriting its existing content. PDFium's content generation
// rebuilds a whole page stream, which the transparent-page fidelity gate must
// refuse on many real PDFs. A stamp only needs to append: the existing content
// streams stay byte-identical and are merely wrapped in a q/Q pair so that
// graphics state they leave behind cannot leak into the stamp. The stamp itself
// lives in its own appended content stream with private resources.

export const PAGE_STAMP_KINDS = Object.freeze({
  watermark: 'Watermark',
  pageNumber: 'PageNumber',
  // berg:work: a running header at the top of the page (page numbers and footers stay 'PageNumber'), so a header
  // and a footer can exist side by side and each replaces only itself.
  pageHeader: 'PageHeader',
});

// berg:work: running text kinds (numbers, footers, headers, Bates numbers): one line of text per page.
const RUNNING_TEXT_KINDS = new Set([PAGE_STAMP_KINDS.pageNumber, PAGE_STAMP_KINDS.pageHeader]);

// Stream dictionary key identifying the streams a stamp added (its leading
// "q" stream and its trailing stamp stream), so a stamp kind can be replaced.
export const PAGE_STAMP_STREAM_KEY = 'FernworkStamp';

const WATERMARK_MIN_FONT_SIZE = 8;

export class PageStampError extends Error {
  constructor(message, { pageIndexes = [], code = 'page-stamp-failed' } = {}) {
    super(message);
    this.name = 'PageStampError';
    this.code = code;
    this.pageIndexes = pageIndexes;
  }
}

function numberValue(PDFLib, context, value) {
  const resolved = context.lookup(value);
  if (resolved instanceof PDFLib.PDFNumber) return resolved.asNumber();
  return Number.NaN;
}

// An inheritable page attribute (ISO 32000-1, 7.7.3.4), read the way PDFium
// and PDF.js read it: up the /Parent chain, dictionary by dictionary. pdf-lib's
// own getInheritableAttribute calls ascend() on the parent and throws
// ("ascend is not a function") when a damaged file points /Parent at the
// catalog or another non-/Pages dictionary; a looping chain stops.
export function inheritedPageAttribute(PDFLib, node, key) {
  const name = PDFLib.PDFName.of(key);
  const parentName = PDFLib.PDFName.of('Parent');
  const seen = new Set();
  let current = node;
  while (current instanceof PDFLib.PDFDict && !seen.has(current) && seen.size < 1024) {
    seen.add(current);
    const value = current.get(name);
    if (value !== undefined) return value;
    current = current.context.lookupMaybe(current.get(parentName), PDFLib.PDFDict);
  }
  return undefined;
}

function readBox(PDFLib, node, key) {
  const value = inheritedPageAttribute(PDFLib, node, key);
  const array = node.context.lookupMaybe(value, PDFLib.PDFArray);
  if (!array || array.size() !== 4) return null;
  const [x1, y1, x2, y2] = array.asArray().map(item => numberValue(PDFLib, node.context, item));
  if (![x1, y1, x2, y2].every(Number.isFinite)) return null;
  const box = {
    left: Math.min(x1, x2), bottom: Math.min(y1, y2),
    right: Math.max(x1, x2), top: Math.max(y1, y2),
  };
  return box.right - box.left > 0 && box.top - box.bottom > 0 ? box : null;
}

// The visible page area is the CropBox clipped to the MediaBox (ISO 32000-1,
// 14.11.2); it is what a viewer shows and where a stamp has to be centred.
export function pageStampFrame(PDFLib, node) {
  const media = readBox(PDFLib, node, 'MediaBox') || { left: 0, bottom: 0, right: 612, top: 792 };
  const crop = readBox(PDFLib, node, 'CropBox');
  let box = media;
  if (crop) {
    const clipped = {
      left: Math.max(media.left, crop.left), bottom: Math.max(media.bottom, crop.bottom),
      right: Math.min(media.right, crop.right), top: Math.min(media.top, crop.top),
    };
    if (clipped.right - clipped.left > 0 && clipped.top - clipped.bottom > 0) box = clipped;
  }
  const rotateValue = inheritedPageAttribute(PDFLib, node, 'Rotate');
  const rawRotation = rotateValue ? numberValue(PDFLib, node.context, rotateValue) : 0;
  const rotation = Number.isFinite(rawRotation) && Math.round(rawRotation) % 90 === 0
    ? ((Math.round(rawRotation) % 360) + 360) % 360
    : 0;
  const width = box.right - box.left;
  const height = box.top - box.bottom;
  const swapped = rotation === 90 || rotation === 270;
  return { box, rotation, width: swapped ? height : width, height: swapped ? width : height };
}

// Maps upright display coordinates (origin at the visible bottom-left corner,
// y up, as the page is shown after /Rotate) to PDF user space.
export function pageStampMatrix(frame) {
  const { box, rotation } = frame;
  if (rotation === 90) return [0, 1, -1, 0, box.right, box.bottom];
  if (rotation === 180) return [-1, 0, 0, -1, box.right, box.top];
  if (rotation === 270) return [0, -1, 1, 0, box.left, box.top];
  return [1, 0, 0, 1, box.left, box.bottom];
}

function formatNumber(value) {
  const rounded = Math.round(Number(value) * 10000) / 10000;
  return Object.is(rounded, -0) ? '0' : String(rounded);
}

function colorOperands(color) {
  const match = /^#?([0-9a-f]{6})$/iu.exec(String(color || ''));
  const hex = match ? match[1] : '111111';
  return [0, 2, 4].map(offset => formatNumber(parseInt(hex.slice(offset, offset + 2), 16) / 255)).join(' ');
}

function clampOpacity(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(1, Math.max(0, number)) : fallback;
}

function uniqueResourceName(dict, PDFLib, prefix) {
  for (let index = 1; ; index += 1) {
    const name = `${prefix}${index}`;
    if (!dict.has(PDFLib.PDFName.of(name))) return name;
  }
}

// Page resources can be inherited or shared with other pages. The stamp adds
// its names to a page-owned shallow copy so no other page or form changes.
function ownedResources(PDFLib, node) {
  const { context } = node;
  const inherited = context.lookupMaybe(inheritedPageAttribute(PDFLib, node, 'Resources'), PDFLib.PDFDict);
  const resources = inherited ? inherited.clone(context) : context.obj({});
  node.set(PDFLib.PDFName.of('Resources'), resources);
  return key => {
    const name = PDFLib.PDFName.of(key);
    const current = context.lookupMaybe(resources.get(name), PDFLib.PDFDict);
    const copy = current ? current.clone(context) : context.obj({});
    resources.set(name, copy);
    return copy;
  };
}

function isStampStream(PDFLib, context, ref, kind) {
  const stream = context.lookupMaybe(ref, PDFLib.PDFStream);
  const value = stream?.dict?.get(PDFLib.PDFName.of(PAGE_STAMP_STREAM_KEY));
  return value instanceof PDFLib.PDFName && value.decodeText() === kind;
}

function contentStreamRefs(PDFLib, node) {
  const { context } = node;
  const raw = node.get(PDFLib.PDFName.of('Contents'));
  const contents = raw ? context.lookup(raw) : null;
  if (contents instanceof PDFLib.PDFArray) return contents.asArray();
  if (contents instanceof PDFLib.PDFStream && raw instanceof PDFLib.PDFRef) return [raw];
  return [];
}

function stampStream(PDFLib, context, kind, content) {
  return context.register(context.flateStream(content, {
    [PAGE_STAMP_STREAM_KEY]: PDFLib.PDFName.of(kind),
  }));
}

function textFits(font, text, size, maxWidth) {
  return font.widthOfTextAtSize(text, size) <= maxWidth;
}

function encodeStampText(font, text) {
  try {
    return font.encodeText(text).toString();
  } catch {
    return null;
  }
}

// Base-14 fonts only cover WinAnsi. Callers use this before choosing the
// append-only stamp path for a text watermark.
export async function pageStampTextEncodable(PDFLib, text) {
  const value = String(text || '').trim();
  if (!value) return false;
  const pdf = await PDFLib.PDFDocument.create();
  const font = await pdf.embedFont(PDFLib.StandardFonts.HelveticaBold);
  return encodeStampText(font, value) !== null;
}

function watermarkTextPlacement(font, text, frame, requestedSize) {
  const maxWidth = frame.width * 0.8;
  let size = Number.isFinite(requestedSize) && requestedSize > 0
    ? requestedSize
    : Math.max(28, Math.min(72, frame.width / 10));
  if (!textFits(font, text, size, maxWidth)) {
    size = Math.max(WATERMARK_MIN_FONT_SIZE, size * maxWidth / Math.max(1e-6, font.widthOfTextAtSize(text, size)));
  }
  const width = font.widthOfTextAtSize(text, size);
  const capHeight = font.heightAtSize(size, { descender: false });
  return { size, x: (frame.width - width) / 2, y: (frame.height - capHeight) / 2 };
}

// berg:work: `position` is "<top|bottom>-<left|center|right>" (default: bottom-center, as before); the margin to the
// page edge stays the 22 pt numbers always had, the same at the sides.
function pageNumberPlacement(font, text, frame, size, position = 'bottom-center') {
  const width = font.widthOfTextAtSize(text, size);
  const [vertical, horizontal] = String(position || 'bottom-center').split('-');
  const margin = Math.min(22, frame.height / 4, frame.width / 6);
  const x = horizontal === 'left' ? margin
    : horizontal === 'right' ? frame.width - margin - width
      : (frame.width - width) / 2;
  const y = vertical === 'top' ? frame.height - margin - font.heightAtSize(size, { descender: false }) : margin;
  return { size, x, y };
}

function imagePlacement(image, frame) {
  const maxW = frame.width * 0.58;
  const maxH = frame.height * 0.34;
  const ratio = Math.min(maxW / Math.max(1, image.width || maxW), maxH / Math.max(1, image.height || maxH), 1);
  const width = Math.max(1, (image.width || maxW) * ratio);
  const height = Math.max(1, (image.height || maxH) * ratio);
  return { width, height, x: (frame.width - width) / 2, y: (frame.height - height) / 2 };
}

/**
 * Append a stamp to every page of `bytes`.
 *
 * stamp.kind: PAGE_STAMP_KINDS.watermark | PAGE_STAMP_KINDS.pageNumber
 * stamp.text: watermark text; stamp.pageText(pageIndex, pageCount) for numbers
 * stamp.image: { bytes, mime } for an image watermark
 * stamp.replace: remove streams of an earlier stamp of the same kind first
 *
 * Returns the rewritten PDF and per-page results. Any page that cannot be
 * stamped rejects the whole operation with the failing page indexes, so a
 * caller never commits a partially stamped document.
 */
export async function stampPdfPages(PDFLib, bytes, stamp) {
  const { PDFDocument, PDFName, StandardFonts } = PDFLib;
  const kind = stamp?.kind;
  if (!Object.values(PAGE_STAMP_KINDS).includes(kind)) {
    throw new PageStampError('Unknown page stamp kind.', { code: 'page-stamp-kind' });
  }
  let pdf;
  try {
    pdf = await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (error) {
    throw new PageStampError(
      /encrypt/iu.test(String(error?.message || ''))
        ? 'This PDF is encrypted, so the stamp cannot be added to its pages. Remove the password protection first.'
        : `The PDF structure could not be read to add the stamp: ${error?.message || error}`,
      { code: 'page-stamp-unreadable' },
    );
  }
  const { context } = pdf;
  let pages;
  try {
    pages = pdf.getPages();
  } catch (error) {
    // A catalog whose /Pages is not a page tree, or a tree that loops back on
    // itself (pdf-lib recurses until the stack overflows).
    throw new PageStampError(
      'The page tree of this PDF is damaged, so the stamp cannot be added. Nothing was changed.',
      { code: 'page-stamp-unreadable' },
    );
  }
  const pageCount = pages.length;
  const isImage = kind === PAGE_STAMP_KINDS.watermark && stamp.image;
  let font = null;
  let image = null;
  if (isImage) {
    const mime = String(stamp.image.mime || '').toLowerCase();
    try {
      image = mime === 'image/jpeg' || mime === 'image/jpg'
        ? await pdf.embedJpg(stamp.image.bytes)
        : await pdf.embedPng(stamp.image.bytes);
    } catch (error) {
      throw new PageStampError(`The watermark image could not be embedded: ${error?.message || error}`,
        { code: 'page-stamp-image' });
    }
  } else {
    font = await pdf.embedFont(kind === PAGE_STAMP_KINDS.watermark
      ? StandardFonts.HelveticaBold
      : StandardFonts.Helvetica);
  }
  const opacity = clampOpacity(stamp.opacity, kind === PAGE_STAMP_KINDS.watermark ? 0.18 : 0.9);
  const graphicsState = context.register(context.obj({
    Type: 'ExtGState', ca: opacity, CA: opacity, BM: 'Normal',
  }));
  const artifact = kind === PAGE_STAMP_KINDS.watermark
    ? '/Artifact <</Type /Pagination /Subtype /Watermark>> BDC'
    : kind === PAGE_STAMP_KINDS.pageHeader
      ? '/Artifact <</Type /Pagination /Subtype /Header>> BDC'
      : '/Artifact <</Type /Pagination /Subtype /Footer>> BDC';
  const resourcePrefix = `Fw${kind}`;
  const failed = [];
  const results = [];
  for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
    try {
      const node = pages[pageIndex].node;
      const frame = pageStampFrame(PDFLib, node);
      const existingRefs = contentStreamRefs(PDFLib, node);
      const refs = existingRefs.filter(ref => !(stamp.replace && isStampStream(PDFLib, context, ref, kind)));
      const subDict = ownedResources(PDFLib, node);
      if (refs.length !== existingRefs.length) {
        // The replaced stamp streams were the only users of this kind's
        // private resource names.
        for (const key of ['ExtGState', 'Font', 'XObject']) {
          const resources = context.lookupMaybe(node.get(PDFName.of('Resources')), PDFLib.PDFDict);
          const dict = context.lookupMaybe(resources?.get(PDFName.of(key)), PDFLib.PDFDict);
          if (!dict) continue;
          const owned = subDict(key);
          for (const name of dict.keys()) {
            if (name.decodeText().startsWith(resourcePrefix)) owned.delete(name);
          }
        }
      }
      const extGState = subDict('ExtGState');
      const gsName = uniqueResourceName(extGState, PDFLib, `${resourcePrefix}GS`);
      extGState.set(PDFName.of(gsName), graphicsState);
      const matrix = pageStampMatrix(frame).map(formatNumber).join(' ');
      let body;
      let text = '';
      if (isImage) {
        const xobjects = subDict('XObject');
        const imageName = uniqueResourceName(xobjects, PDFLib, `${resourcePrefix}Im`);
        xobjects.set(PDFName.of(imageName), image.ref);
        const place = imagePlacement(image, frame);
        body = `${formatNumber(place.width)} 0 0 ${formatNumber(place.height)} ${formatNumber(place.x)} ${formatNumber(place.y)} cm /${imageName} Do`;
      } else {
        text = RUNNING_TEXT_KINDS.has(kind)
          ? String(stamp.pageText ? stamp.pageText(pageIndex, pageCount) : pageIndex + 1)
          : String(stamp.text || '').trim();
        if (!text) throw new Error('The stamp text is empty.');
        const encoded = encodeStampText(font, text);
        if (!encoded) throw new Error('The stamp text contains characters outside the built-in font encoding.');
        const fonts = subDict('Font');
        const fontName = uniqueResourceName(fonts, PDFLib, `${resourcePrefix}F`);
        fonts.set(PDFName.of(fontName), font.ref);
        const place = RUNNING_TEXT_KINDS.has(kind)
          ? pageNumberPlacement(font, text, frame, Number(stamp.fontSize) > 0 ? Number(stamp.fontSize) : 12, stamp.position)
          : watermarkTextPlacement(font, text, frame, Number(stamp.fontSize));
        body = `BT /${fontName} ${formatNumber(place.size)} Tf ${colorOperands(stamp.color)} rg ` +
          `${formatNumber(place.x)} ${formatNumber(place.y)} Td ${encoded} Tj ET`;
      }
      const open = stampStream(PDFLib, context, kind, 'q\n');
      const close = stampStream(PDFLib, context, kind,
        `\nQ\nq\n${artifact}\n/${gsName} gs\n${matrix} cm\n${body}\nEMC\nQ\n`);
      node.set(PDFName.of('Contents'), context.obj([open, ...refs, close]));
      results.push({ pageIndex, text, rotation: frame.rotation });
    } catch (error) {
      failed.push({ pageIndex, reason: error?.message || String(error) });
    }
  }
  if (failed.length) {
    const pagesText = failed.map(item => item.pageIndex + 1).join(', ');
    throw new PageStampError(
      `The stamp could not be added to page${failed.length === 1 ? '' : 's'} ${pagesText} of ${pageCount}: ${failed[0].reason} Nothing was changed.`,
      { pageIndexes: failed.map(item => item.pageIndex) },
    );
  }
  const output = await pdf.save({ useObjectStreams: false, addDefaultPage: false, updateFieldAppearances: false });
  return { bytes: new Uint8Array(output), pages: results, pageCount };
}
