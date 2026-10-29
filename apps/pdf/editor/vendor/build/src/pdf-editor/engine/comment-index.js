// berg:work: the document's comments as a list (Comments panel): every markup annotation with its replies and
// review status, read with pdf-lib from a session checkpoint; replies and status changes are written the way
// Acrobat and PDF-XChange write them (ISO 32000-2, 12.5.6.10 and 12.5.6.4):
//
//   reply  -> /Text /IRT <parent> /RT /R  /Contents …  /T author
//   status -> /Text /IRT <parent> /State /Accepted /StateModel /Review  (latest one wins)
//
// The PDFium render already hides reply annotations, and the worker deletes them with their parent.

import {
  annotationRefs, colorComponents, findAnnotation, indexMaps, loadForEdit, name, numbers, pageAnnots, parsePdfDate,
  pdfDate, pdfText, randomId, saveEdited, text,
} from './measure-annotations.js';
import { readPageMarkupFromDocument } from './markup-annotations.js';

const SKIPPED = new Set(['Popup', 'Widget', 'Link', 'Sound', 'Movie', 'Screen', 'PrinterMark', 'TrapNet', 'Watermark',
  '3D', 'RichMedia', 'Projection']);
export const REVIEW_STATES = Object.freeze(['None', 'Accepted', 'Rejected', 'Cancelled', 'Completed']);

/** A readable type for a subtype and intent: "Note", "Callout", "Distance", "Cloud" … */
export function commentTypeLabel(subtype, intent = '', extra = {}) {
  if (subtype === 'Text') return 'Note';
  if (subtype === 'FreeText') return intent === 'FreeTextCallout' ? 'Callout' : intent === 'FreeTextTypeWriter' ? 'Typewriter' : 'Text box';
  if (subtype === 'Line') return intent === 'LineDimension' || extra.measure ? 'Distance' : intent === 'LineArrow' || extra.arrow ? 'Arrow' : 'Line';
  if (subtype === 'Polygon') return intent === 'PolygonDimension' || extra.measure ? 'Area' : intent === 'PolygonCloud' || extra.cloud ? 'Cloud' : 'Polygon';
  if (subtype === 'PolyLine') return intent === 'PolyLineDimension' || extra.measure ? 'Perimeter' : 'Polyline';
  return ({
    Square: 'Rectangle', Circle: 'Ellipse', Ink: 'Drawing', Highlight: 'Highlight', Underline: 'Underline',
    StrikeOut: 'Strikethrough', Squiggly: 'Squiggly', Stamp: 'Stamp', Redact: 'Redaction', Caret: 'Caret',
    FileAttachment: 'Attachment',
  })[subtype] || subtype;
}

function refKey(ref) {
  return ref ? `${ref.objectNumber} ${ref.generationNumber}` : '';
}

/**
 * All comments of the document: [{ pageIndex, annotationIndex, objectNumber, subtype, intent, type, contents,
 * author, subject, modified, created, color, rect, name, replies: [{ author, contents, modified, objectNumber }],
 * status, statusAuthor, statusModified }].
 */
export function readCommentsFromDocument(PDFLib, document) {
  const top = [];
  const byRef = new Map();
  const children = [];
  document.getPages().forEach((page, pageIndex) => {
    const annots = pageAnnots(PDFLib, page);
    if (!annots) return;
    annots.asArray().forEach((item, annotationIndex) => {
      const ref = item instanceof PDFLib.PDFRef ? item : null;
      const dict = document.context.lookup(item);
      if (!(dict instanceof PDFLib.PDFDict)) return;
      const subtype = name(PDFLib, dict, 'Subtype');
      if (!subtype || SKIPPED.has(subtype)) return;
      const irt = dict.get(PDFLib.PDFName.of('IRT'));
      const color = numbers(PDFLib, dict, 'C');
      const entry = {
        pageIndex,
        annotationIndex,
        objectNumber: ref ? ref.objectNumber : null,
        subtype,
        intent: name(PDFLib, dict, 'IT'),
        contents: text(PDFLib, dict, 'Contents'),
        author: text(PDFLib, dict, 'T'),
        subject: text(PDFLib, dict, 'Subj'),
        modified: parsePdfDate(text(PDFLib, dict, 'M')),
        created: parsePdfDate(text(PDFLib, dict, 'CreationDate')),
        color: color?.length === 3 ? `#${color.map(value => Math.round(Math.max(0, Math.min(1, value)) * 255)
          .toString(16).padStart(2, '0')).join('')}` : '',
        rect: numbers(PDFLib, dict, 'Rect'),
        name: text(PDFLib, dict, 'NM'),
      };
      if (irt instanceof PDFLib.PDFRef) {
        children.push({ ...entry, parent: refKey(irt), state: text(PDFLib, dict, 'State'), stateModel: text(PDFLib, dict, 'StateModel'),
          replyType: name(PDFLib, dict, 'RT') || 'R' });
        return;
      }
      const measure = Boolean(dict.get(PDFLib.PDFName.of('Measure')));
      const border = dict.lookup(PDFLib.PDFName.of('BE'));
      const cloud = border instanceof PDFLib.PDFDict && name(PDFLib, border, 'S') === 'C';
      const lineEndings = dict.lookup(PDFLib.PDFName.of('LE'));
      const arrow = lineEndings instanceof PDFLib.PDFArray && lineEndings.asArray().some(value => value instanceof PDFLib.PDFName && /Arrow/u.test(value.decodeText()));
      const comment = { ...entry, type: commentTypeLabel(subtype, entry.intent, { measure, cloud, arrow }), replies: [],
        status: 'None', statusAuthor: '', statusModified: '' };
      top.push(comment);
      if (ref) byRef.set(refKey(ref), comment);
    });
  });
  const statusTime = value => Date.parse(value.modified || value.created || '') || 0;
  for (const child of children) {
    const parent = byRef.get(child.parent);
    if (!parent) continue;
    if (child.state && (!child.stateModel || child.stateModel === 'Review')) {
      const current = parent.statusEntry;
      if (!current || statusTime(child) >= statusTime(current)) {
        parent.statusEntry = child;
        parent.status = child.state;
        parent.statusAuthor = child.author;
        parent.statusModified = child.modified || child.created;
      }
      continue;
    }
    if (child.state) continue; // Marked / Unmarked and other state models are not shown
    parent.replies.push({ author: child.author, contents: child.contents, modified: child.modified || child.created,
      objectNumber: child.objectNumber });
  }
  for (const comment of top) {
    delete comment.statusEntry;
    comment.replies.sort((a, b) => (Date.parse(a.modified) || 0) - (Date.parse(b.modified) || 0));
  }
  return top;
}

export async function readComments(PDFLib, bytes) {
  const document = await PDFLib.PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true });
  return readCommentsFromDocument(PDFLib, document);
}

/** Add a reply or a review status to a comment. Returns { bytes, objectNumber, annotationIndexMaps, data }. */
export async function writeCommentReply(PDFLib, bytes, {
  pageIndex, parentObjectNumber, value = '', state = '', author = '', now = new Date(),
} = {}) {
  if (state && !REVIEW_STATES.includes(state)) throw new Error(`Unknown review status: ${state}`);
  if (!state && !String(value).trim()) throw new Error('A reply needs text.');
  const document = await loadForEdit(PDFLib, bytes);
  const parent = findAnnotation(PDFLib, document, pageIndex, parentObjectNumber);
  if (!parent || !(parent.dict instanceof PDFLib.PDFDict)) throw new Error('The comment is no longer in the PDF.');
  const before = annotationRefs(PDFLib, document);
  const rect = numbers(PDFLib, parent.dict, 'Rect') || [0, 0, 20, 20];
  const page = document.getPage(pageIndex);
  const dict = document.context.obj({
    Type: 'Annot', Subtype: 'Text', F: 28, Rect: [rect[0], rect[3] - 20, rect[0] + 20, rect[3]], P: page.ref,
    Name: 'Comment', Open: false,
  });
  dict.set(PDFLib.PDFName.of('IRT'), parent.ref);
  dict.set(PDFLib.PDFName.of('NM'), pdfText(PDFLib, `bergwork-reply-${randomId()}`));
  dict.set(PDFLib.PDFName.of('C'), document.context.obj(colorComponents('#facc15')));
  dict.set(PDFLib.PDFName.of('M'), PDFLib.PDFString.of(pdfDate(now)));
  dict.set(PDFLib.PDFName.of('CreationDate'), PDFLib.PDFString.of(pdfDate(now)));
  if (author) dict.set(PDFLib.PDFName.of('T'), pdfText(PDFLib, author));
  if (state) {
    dict.set(PDFLib.PDFName.of('State'), pdfText(PDFLib, state));
    dict.set(PDFLib.PDFName.of('StateModel'), pdfText(PDFLib, 'Review'));
    dict.set(PDFLib.PDFName.of('Contents'), pdfText(PDFLib, author ? `${state} set by ${author}` : state));
  } else {
    dict.set(PDFLib.PDFName.of('RT'), PDFLib.PDFName.of('R'));
    dict.set(PDFLib.PDFName.of('Contents'), pdfText(PDFLib, value));
  }
  const ref = document.context.register(dict);
  page.node.addAnnot(ref);
  const after = annotationRefs(PDFLib, document);
  return {
    bytes: await saveEdited(PDFLib, document),
    objectNumber: ref.objectNumber,
    annotationIndexMaps: indexMaps(before, after),
    data: readPageMarkupFromDocument(PDFLib, document),
  };
}
