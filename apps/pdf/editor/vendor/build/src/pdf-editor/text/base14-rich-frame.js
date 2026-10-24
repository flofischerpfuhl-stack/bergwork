import { createRichTextDocument, richTextDocumentInputMatchesCanonical } from '../model/rich-text-document.js';

const FACE_BY_ID = Object.freeze({
  'base14:Courier': 'Courier', 'base14:Courier-Bold': 'Courier-Bold',
  'base14:Courier-Oblique': 'Courier-Oblique', 'base14:Courier-BoldOblique': 'Courier-BoldOblique',
  'base14:Helvetica': 'Helvetica', 'base14:Helvetica-Bold': 'Helvetica-Bold',
  'base14:Helvetica-Oblique': 'Helvetica-Oblique', 'base14:Helvetica-BoldOblique': 'Helvetica-BoldOblique',
  'base14:Times-Roman': 'Times-Roman', 'base14:Times-Bold': 'Times-Bold',
  'base14:Times-Italic': 'Times-Italic', 'base14:Times-BoldItalic': 'Times-BoldItalic',
});
const ENCODINGS = new Set(['StandardEncoding', 'WinAnsiEncoding']);
const RESOURCE_BY_FACE = Object.freeze(Object.fromEntries(Object.entries(FACE_BY_ID).map(([resourceId, face]) => {
  const family = face.startsWith('Times-') ? 'Times' : face.startsWith('Helvetica') ? 'Helvetica' : 'Courier';
  const weight = /Bold/u.test(face) ? '700' : '400';
  const style = /Oblique/u.test(face) ? 'oblique' : /Italic/u.test(face) ? 'italic' : 'normal';
  return [face, Object.freeze({ resourceId, kind: 'base14', family, weight, style })];
})));
const finitePositive = value => Number.isFinite(value) && value > 0 && Number.isFinite(Math.fround(value)) && Math.fround(value) > 0;
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

export function base14FaceName(resourceId) {
  return FACE_BY_ID[String(resourceId || '')] || null;
}

export function base14RichResourceForFace(face) {
  return RESOURCE_BY_FACE[String(face || '').replace(/^\//u, '')] || null;
}

export function base14RichResourcesForFamily(family) {
  const exactFamily = String(family || '');
  if (!['Courier', 'Helvetica', 'Times'].includes(exactFamily)) return Object.freeze([]);
  return Object.freeze(Object.values(RESOURCE_BY_FACE).filter(resource => resource.family === exactFamily));
}

export function base14RichResources() {
  return Object.freeze(Object.values(RESOURCE_BY_FACE));
}

export function canonicalBase14RichFrameMetadata(value) {
  if (!value || value.version !== 1 || !/^[a-f0-9]{32}$/u.test(String(value.frameResourceId || ''))) {
    throw new TypeError('Base14 rich-frame identity is invalid.');
  }
  const document = createRichTextDocument(value.richTextDocument);
  const canonicalDocument = Object.freeze({ version: 1, ...document });
  if (value.richTextDocument?.version !== 1 ||
      !richTextDocumentInputMatchesCanonical(value.richTextDocument, canonicalDocument)) {
    throw new TypeError('Base14 rich-frame document is not canonical.');
  }
  const resources = canonicalDocument.fontResources.map(resource => {
    const baseFont = base14FaceName(resource.resourceId);
    const supplied = value.fontResources?.find(item => item?.resourceId === resource.resourceId);
    const encoding = String(supplied?.encoding || '').replace(/^\//u, '');
    if (resource.kind !== 'base14' || !baseFont || supplied?.baseFont !== baseFont || !ENCODINGS.has(encoding)) {
      throw new TypeError('Base14 rich-frame font evidence is invalid.');
    }
    return Object.freeze({ ...resource, baseFont, encoding });
  });
  if (!Array.isArray(value.fontResources) || value.fontResources.length !== resources.length ||
      new Set(value.fontResources.map(item => item?.resourceId)).size !== resources.length) {
    throw new TypeError('Base14 rich-frame font catalog is ambiguous or incomplete.');
  }
  const block = {
    width: Number(value.block?.width), height: Number(value.block?.height),
    contentHeight: Number(value.block?.contentHeight), fontSize:Number(value.block?.fontSize),
    autoWidth: value.block?.autoWidth === true,
    lineHeight: Number(value.block?.lineHeight ?? 1.2),
    align: String(value.block?.align || 'left'), verticalAlign: String(value.block?.verticalAlign || 'top'),
    overflow: String(value.block?.overflow || 'visible'),
  };
  if (![block.width, block.height, block.contentHeight, block.fontSize, block.lineHeight].every(finitePositive) ||
      !['left','center','right','justify'].includes(block.align) ||
      !['top','middle','bottom'].includes(block.verticalAlign) || !['visible','clip','shrink'].includes(block.overflow)) {
    throw new TypeError(`Base14 rich-frame block is invalid: ${JSON.stringify(block)}.`);
  }
  const glyphMatrix = {};
  for (const key of ['a', 'b', 'c', 'd']) {
    const number = Number(value.glyphMatrix?.[key]);
    if (!Number.isFinite(number) || !Number.isFinite(Math.fround(number))) {
      throw new TypeError('Base14 rich-frame glyph matrix is invalid.');
    }
    glyphMatrix[key] = number;
  }
  if (Math.abs(glyphMatrix.a * glyphMatrix.d - glyphMatrix.b * glyphMatrix.c) <= 1e-9) {
    throw new TypeError('Base14 rich-frame glyph matrix is singular.');
  }
  const frameOffset = { x:Number(value.frameOffset?.x ?? 0), y:Number(value.frameOffset?.y ?? 0) };
  if (![frameOffset.x, frameOffset.y].every(number => Number.isFinite(number) && Number.isFinite(Math.fround(number)))) {
    throw new TypeError('Base14 rich-frame offset is invalid.');
  }
  const layoutWidthAllowance=Number(value.layoutWidthAllowance??0);
  if(!Number.isFinite(layoutWidthAllowance)||layoutWidthAllowance<0||layoutWidthAllowance>100000||!Number.isFinite(Math.fround(layoutWidthAllowance))){
    throw new TypeError('Base14 rich-frame layout width allowance is invalid.');
  }
  return Object.freeze({
    version: 1, frameResourceId: value.frameResourceId,
    fontResources: Object.freeze(resources), richTextDocument: canonicalDocument,
    block: Object.freeze(block), glyphMatrix: Object.freeze(glyphMatrix), frameOffset:Object.freeze(frameOffset),
    layoutWidthAllowance,
  });
}

// Validates the exact dictionary belonging to an owner-bound Form resource.
// The caller must resolve the dictionary from that Form's own /Resources.
export function validateBase14RichFontDictionary(font, expected) {
  const actual = {
    subtype: String(font?.subtype || '').replace(/^\//u, ''),
    baseFont: String(font?.baseFont || '').replace(/^\//u, ''),
    encoding: font?.encoding == null ? 'StandardEncoding' : String(font.encoding).replace(/^\//u, ''),
    fontDescriptorPresent: font?.fontDescriptorPresent === true,
    widthsPresent: font?.widthsPresent === true,
    firstCharPresent: font?.firstCharPresent === true,
    lastCharPresent: font?.lastCharPresent === true,
    toUnicodePresent: font?.toUnicodePresent === true,
  };
  return actual.subtype === 'Type1' && actual.baseFont === expected.baseFont &&
    actual.encoding === expected.encoding && !actual.fontDescriptorPresent && !actual.widthsPresent &&
    !actual.firstCharPresent && !actual.lastCharPresent && !actual.toUnicodePresent;
}
