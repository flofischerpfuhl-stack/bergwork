// berg:work: comment annotations the pinned worker cannot write, written and read with pdf-lib.
//
//   polyline -> /PolyLine /Vertices
//   polygon  -> /Polygon  /Vertices
//   cloud    -> /Polygon  /Vertices /IT /PolygonCloud /BE << /S /C /I 1 >>
//   stamp    -> /Stamp    /Name /Approved … (or an own image), appearance with text, date and name
//   callout  -> /FreeText /IT /FreeTextCallout /CL [tip knee end] /LE /OpenArrow /RD, appearance with box, text
//               and leader line
//
// Each gets its own appearance stream, so every viewer shows it. Changes go through a snapshot transaction in the
// shell (see commitMeasureChange), like measurements.

import {
  MEASURE_APPEARANCE_KEY, annotationRefs, captionWidth, cleanPoints, colorComponents, findAnnotation, hex,
  indexMaps, loadForEdit, n, name, numbers, pageAnnots, parsePdfDate, pdfDate, pdfText, randomId,
  readMeasureDataFromDocument, saveEdited, text,
} from './measure-annotations.js';

const NAME_PREFIX = 'bergwork-markup-';
export const STAMP_NAMES = Object.freeze({
  approved: 'Approved', draft: 'Draft', confidential: 'Confidential', reviewed: '#Reviewed', rejected: 'NotApproved',
  image: '#Image',
});

// ---------------------------------------------------------------------------------------------------------------
// Appearances (user space; BBox = Rect, identity matrix)

function boundsOf(points, margin = 0) {
  const xs = points.map(point => point.x), ys = points.map(point => point.y);
  return [Math.min(...xs) - margin, Math.min(...ys) - margin, Math.max(...xs) + margin, Math.max(...ys) + margin]
    .map(value => Math.round(value * 1000) / 1000);
}

function signedArea(points) {
  let sum = 0;
  for (let index = 0; index < points.length; index += 1) {
    const a = points[index], b = points[(index + 1) % points.length];
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
}

/** Path operators of a cloudy border around a closed polygon: one outward half circle per ~2·radius of edge. */
export function cloudPath(points, radius = 5) {
  const ops = [];
  const outward = signedArea(points) >= 0 ? 1 : -1; // counter-clockwise in user space: outward is to the right
  const k = 0.5522847498;
  let started = false;
  for (let index = 0; index < points.length; index += 1) {
    const a = points[index], b = points[(index + 1) % points.length];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length < 0.01) continue;
    const count = Math.max(1, Math.round(length / (radius * 2)));
    const ux = (b.x - a.x) / length, uy = (b.y - a.y) / length;
    const nx = uy * outward, ny = -ux * outward;
    for (let step = 0; step < count; step += 1) {
      const sx = a.x + ux * length * step / count, sy = a.y + uy * length * step / count;
      const ex = a.x + ux * length * (step + 1) / count, ey = a.y + uy * length * (step + 1) / count;
      const r = length / count / 2;
      const mx = (sx + ex) / 2, my = (sy + ey) / 2;
      const px = mx + nx * r, py = my + ny * r; // top of the arc
      if (!started) { ops.push(`${n(sx)} ${n(sy)} m`); started = true; }
      ops.push(`${n(sx + nx * r * k)} ${n(sy + ny * r * k)} ${n(px - ux * r * k)} ${n(py - uy * r * k)} ${n(px)} ${n(py)} c`);
      ops.push(`${n(px + ux * r * k)} ${n(py + uy * r * k)} ${n(ex + nx * r * k)} ${n(ey + ny * r * k)} ${n(ex)} ${n(ey)} c`);
    }
  }
  if (started) ops.push('h');
  return ops.join(' ');
}

export function shapeAppearance(kind, points, style = {}) {
  const width = Math.max(0.25, Number(style.width) || 1.5);
  const rgb = colorComponents(style.color);
  const ops = [`${rgb.join(' ')} RG`, `${n(width)} w`, '1 J 1 j'];
  let margin = width + 1;
  if (kind === 'cloud') {
    const radius = Math.max(3, Number(style.cloudRadius) || 6);
    ops.push(`${cloudPath(points, radius)} S`);
    margin += radius * 1.2;
  } else {
    const path = points.map((point, index) => `${n(point.x)} ${n(point.y)} ${index ? 'l' : 'm'}`).join(' ');
    ops.push(kind === 'polygon' ? `${path} h S` : `${path} S`);
  }
  return { content: ops.join('\n'), rect: boundsOf(points, margin) };
}

/** Lines of `value` wrapped to `width` (Helvetica widths); explicit line breaks are kept. */
export function wrapText(value, width, fontSize) {
  const lines = [];
  for (const paragraph of String(value || '').split(/\r\n|\r|\n/u)) {
    let line = '';
    for (const word of paragraph.split(/(\s+)/u)) {
      const candidate = line + word;
      if (line && captionWidth(candidate.trimEnd(), fontSize) > width) {
        lines.push(line.trimEnd());
        line = word.trimStart();
      } else {
        line = candidate;
      }
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

/** Stamp appearance: a rounded frame with the stamp text, a second line with date and name. */
export function stampAppearance({ label, detail = '', color = '#2b8a3e', center, scale = 1 }) {
  const rgb = colorComponents(color);
  const big = 16 * scale, small = 7.5 * scale, pad = 7 * scale;
  const width = Math.max(captionWidth(label, big) * 1.06, detail ? captionWidth(detail, small) : 0) + pad * 2;
  const height = big + pad * 1.6 + (detail ? small * 1.5 : 0);
  const x = center.x - width / 2, y = center.y - height / 2;
  const radius = 4 * scale;
  const k = 0.5522847498 * radius;
  const r = [x, y, x + width, y + height];
  const frame = [
    `${n(r[0] + radius)} ${n(r[1])} m`, `${n(r[2] - radius)} ${n(r[1])} l`,
    `${n(r[2] - radius + k)} ${n(r[1])} ${n(r[2])} ${n(r[1] + radius - k)} ${n(r[2])} ${n(r[1] + radius)} c`,
    `${n(r[2])} ${n(r[3] - radius)} l`,
    `${n(r[2])} ${n(r[3] - radius + k)} ${n(r[2] - radius + k)} ${n(r[3])} ${n(r[2] - radius)} ${n(r[3])} c`,
    `${n(r[0] + radius)} ${n(r[3])} l`,
    `${n(r[0] + radius - k)} ${n(r[3])} ${n(r[0])} ${n(r[3] - radius + k)} ${n(r[0])} ${n(r[3] - radius)} c`,
    `${n(r[0])} ${n(r[1] + radius)} l`,
    `${n(r[0])} ${n(r[1] + radius - k)} ${n(r[0] + radius - k)} ${n(r[1])} ${n(r[0] + radius)} ${n(r[1])} c h`,
  ].join(' ');
  const labelY = r[3] - pad * 0.8 - big * 0.78;
  const ops = [
    'q /GSbox gs 1 1 1 rg', `${frame} f`, 'Q',
    `${rgb.join(' ')} RG ${rgb.join(' ')} rg`, `${n(1.6 * scale)} w`, `${frame} S`,
    'BT', `/Helv ${n(big)} Tf`, `2 Tr ${n(0.45 * scale)} w`,
    `1 0 0 1 ${n(center.x - captionWidth(label, big) * 1.03 / 2)} ${n(labelY)} Tm`, `${n(big * 0.03)} Tc`, `${hex(label)} Tj`, 'ET',
  ];
  if (detail) {
    ops.push('BT', `/Helv ${n(small)} Tf`, '0 Tr 0 Tc',
      `1 0 0 1 ${n(center.x - captionWidth(detail, small) / 2)} ${n(r[1] + pad * 0.75)} Tm`, `${hex(detail)} Tj`, 'ET');
  }
  return { content: ops.join('\n'), rect: r.map(value => Math.round(value * 1000) / 1000) };
}

/** Callout: box with text at `box` (its top-left corner), leader line from the box to `tip` with an open arrow. */
export function calloutAppearance({ tip, anchor, value, style = {} }) {
  const fontSize = Math.max(4, Number(style.fontSize) || 12);
  const boxWidth = Math.max(40, Number(style.boxWidth) || 160);
  const pad = 4;
  const lines = wrapText(value, boxWidth - pad * 2, fontSize);
  const textWidth = Math.max(...lines.map(line => captionWidth(line, fontSize)), 10);
  const width = Math.min(boxWidth, textWidth + pad * 2 + 1);
  const height = lines.length * fontSize * 1.2 + pad * 2;
  // The box sits on the side of the anchor that faces away from the tip.
  const left = anchor.x >= tip.x ? anchor.x : anchor.x - width;
  const bottom = anchor.y - height / 2;
  const box = [left, bottom, left + width, bottom + height];
  const end = { x: anchor.x >= tip.x ? box[0] : box[2], y: (box[1] + box[3]) / 2 };
  const knee = { x: end.x + (anchor.x >= tip.x ? -12 : 12), y: end.y };
  const text = colorComponents(style.textColor || '#111111');
  const border = colorComponents(style.borderColor || '#e03131');
  const lineWidth = Math.max(0.5, Number(style.borderWidth) || 1);
  const angle = Math.atan2(knee.y - tip.y, knee.x - tip.x);
  const arrow = 7;
  const spread = Math.PI / 7;
  const ops = [
    `${border.join(' ')} RG ${n(lineWidth)} w 1 J 1 j`,
    `${n(tip.x)} ${n(tip.y)} m ${n(knee.x)} ${n(knee.y)} l ${n(end.x)} ${n(end.y)} l S`,
    `${n(tip.x + Math.cos(angle + spread) * arrow)} ${n(tip.y + Math.sin(angle + spread) * arrow)} m ${n(tip.x)} ${n(tip.y)} l ` +
      `${n(tip.x + Math.cos(angle - spread) * arrow)} ${n(tip.y + Math.sin(angle - spread) * arrow)} l S`,
    '1 1 1 rg', `${n(box[0])} ${n(box[1])} ${n(width)} ${n(height)} re B`,
    `${text.join(' ')} rg`, 'BT', `/Helv ${n(fontSize)} Tf`,
  ];
  lines.forEach((line, index) => {
    ops.push(`1 0 0 1 ${n(box[0] + pad)} ${n(box[3] - pad - fontSize * (index + 0.85) * 1.2 + fontSize * 0.2)} Tm`, `${hex(line)} Tj`);
  });
  ops.push('ET');
  const all = [tip, knee, end, { x: box[0], y: box[1] }, { x: box[2], y: box[3] }];
  const rect = boundsOf(all, arrow + lineWidth);
  return { content: ops.join('\n'), rect, box, callout: [tip, knee, end], fontSize, lines };
}

// ---------------------------------------------------------------------------------------------------------------
// Reading

function hasCloudBorder(PDFLib, dict) {
  const border = dict.lookup(PDFLib.PDFName.of('BE'));
  return border instanceof PDFLib.PDFDict && name(PDFLib, border, 'S') === 'C';
}

/** Polygons, polylines, clouds and stamps that are not measurements, as plain data. */
export function readMarkupItemsFromDocument(PDFLib, document) {
  const items = [];
  document.getPages().forEach((page, pageIndex) => {
    const annots = pageAnnots(PDFLib, page);
    if (!annots) return;
    annots.asArray().forEach((item, annotationIndex) => {
      const ref = item instanceof PDFLib.PDFRef ? item : null;
      const dict = document.context.lookup(item);
      if (!ref || !(dict instanceof PDFLib.PDFDict)) return;
      const subtype = name(PDFLib, dict, 'Subtype');
      const intent = name(PDFLib, dict, 'IT');
      if (!['Polygon', 'PolyLine', 'Stamp'].includes(subtype)) return;
      if (dict.get(PDFLib.PDFName.of('Measure')) || /Dimension$/u.test(intent)) return;
      const nm = text(PDFLib, dict, 'NM');
      const color = numbers(PDFLib, dict, 'C');
      const border = dict.lookup(PDFLib.PDFName.of('BS'));
      const widthValue = border instanceof PDFLib.PDFDict ? document.context.lookup(border.get(PDFLib.PDFName.of('W'))) : null;
      const base = {
        pageIndex,
        annotationIndex,
        objectNumber: ref.objectNumber,
        name: nm,
        own: nm.startsWith(NAME_PREFIX),
        contents: text(PDFLib, dict, 'Contents'),
        author: text(PDFLib, dict, 'T'),
        modified: parsePdfDate(text(PDFLib, dict, 'M') || text(PDFLib, dict, 'CreationDate')),
        color: color?.length === 3 ? `#${color.map(value => Math.round(Math.max(0, Math.min(1, value)) * 255)
          .toString(16).padStart(2, '0')).join('')}` : '#e03131',
        width: widthValue instanceof PDFLib.PDFNumber ? widthValue.asNumber() : 1,
        rect: numbers(PDFLib, dict, 'Rect'),
      };
      if (subtype === 'Stamp') {
        if (!base.rect) return;
        items.push({ ...base, kind: 'stamp', stampName: name(PDFLib, dict, 'Name'), points: [] });
        return;
      }
      const vertices = numbers(PDFLib, dict, 'Vertices') || [];
      const points = [];
      for (let index = 0; index + 1 < vertices.length; index += 2) points.push({ x: vertices[index], y: vertices[index + 1] });
      if (points.length < 2) return;
      const kind = subtype === 'PolyLine' ? 'polyline'
        : intent === 'PolygonCloud' || hasCloudBorder(PDFLib, dict) ? 'cloud' : 'polygon';
      items.push({ ...base, kind, points });
    });
  });
  return items;
}

/** Measurements, page scales and these markups in one read: { pages, markups }. */
export function readPageMarkupFromDocument(PDFLib, document) {
  return { ...readMeasureDataFromDocument(PDFLib, document), markups: readMarkupItemsFromDocument(PDFLib, document) };
}

export async function readPageMarkup(PDFLib, bytes) {
  const document = await PDFLib.PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true });
  return readPageMarkupFromDocument(PDFLib, document);
}

// ---------------------------------------------------------------------------------------------------------------
// Writing

/** Drop an own appearance (and an own stamp image in it). */
function releaseAppearance(PDFLib, document, dict) {
  const ap = dict.lookup(PDFLib.PDFName.of('AP'));
  if (!(ap instanceof PDFLib.PDFDict)) return;
  const normalRef = ap.get(PDFLib.PDFName.of('N'));
  if (!(normalRef instanceof PDFLib.PDFRef)) return;
  const stream = document.context.lookup(normalRef);
  if (!(stream instanceof PDFLib.PDFStream) || !stream.dict.get(PDFLib.PDFName.of(MEASURE_APPEARANCE_KEY))) return;
  const resources = stream.dict.lookup(PDFLib.PDFName.of('Resources'));
  const xobjects = resources instanceof PDFLib.PDFDict ? resources.lookup(PDFLib.PDFName.of('XObject')) : null;
  const image = xobjects instanceof PDFLib.PDFDict ? xobjects.get(PDFLib.PDFName.of('Img')) : null;
  if (image instanceof PDFLib.PDFRef) document.context.delete(image);
  document.context.delete(normalRef);
}

function setAppearance(PDFLib, document, dict, content, rect, extraResources = {}) {
  const stream = document.context.flateStream(content, {
    Type: 'XObject', Subtype: 'Form', BBox: rect, Matrix: [1, 0, 0, 1, 0, 0],
    Resources: {
      Font: { Helv: { Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica', Encoding: 'WinAnsiEncoding' } },
      ExtGState: { GSbox: { Type: 'ExtGState', ca: 0.85 } },
      ...extraResources,
    },
  });
  stream.dict.set(PDFLib.PDFName.of(MEASURE_APPEARANCE_KEY), PDFLib.PDFBool.True);
  releaseAppearance(PDFLib, document, dict);
  dict.set(PDFLib.PDFName.of('AP'), document.context.obj({ N: document.context.register(stream) }));
  dict.set(PDFLib.PDFName.of('Rect'), document.context.obj(rect));
}

function newAnnotation(PDFLib, document, pageIndex, subtype, { author = '', subject = '', now = new Date() } = {}) {
  const page = document.getPage(pageIndex);
  const dict = document.context.obj({ Type: 'Annot', Subtype: subtype, F: 4, P: page.ref });
  dict.set(PDFLib.PDFName.of('NM'), pdfText(PDFLib, `${NAME_PREFIX}${randomId()}`));
  if (subject) dict.set(PDFLib.PDFName.of('Subj'), pdfText(PDFLib, subject));
  dict.set(PDFLib.PDFName.of('CreationDate'), PDFLib.PDFString.of(pdfDate(now)));
  if (author) dict.set(PDFLib.PDFName.of('T'), pdfText(PDFLib, author));
  const ref = document.context.register(dict);
  page.node.addAnnot(ref);
  return { dict, ref };
}

async function finish(PDFLib, document, before, ref, pageIndex) {
  const after = annotationRefs(PDFLib, document);
  const data = readPageMarkupFromDocument(PDFLib, document);
  const annotationIndex = ref
    ? pageAnnots(PDFLib, document.getPage(pageIndex)).asArray()
      .findIndex(item => item instanceof PDFLib.PDFRef && item.objectNumber === ref.objectNumber)
    : -1;
  return {
    bytes: await saveEdited(PDFLib, document),
    ...(ref ? { objectNumber: ref.objectNumber, annotationIndex } : {}),
    annotationIndexMaps: indexMaps(before, after),
    data,
  };
}

const SHAPE_SUBJECTS = { polyline: 'Polyline', polygon: 'Polygon', cloud: 'Cloud' };

/** Add a polyline, polygon or cloud, or replace the corners of one (`objectNumber`). */
export async function writeShapeAnnotation(PDFLib, bytes, {
  pageIndex, kind, points, style = {}, author = '', objectNumber = null, now = new Date(),
} = {}) {
  const clean = cleanPoints(points);
  if (!SHAPE_SUBJECTS[kind]) throw new Error(`Unknown shape: ${kind}`);
  if (clean.length < (kind === 'polyline' ? 2 : 3)) {
    throw new Error(kind === 'polyline' ? 'A polyline needs two points.' : 'A closed shape needs three points.');
  }
  const document = await loadForEdit(PDFLib, bytes);
  const before = annotationRefs(PDFLib, document);
  let dict, ref;
  if (objectNumber != null) {
    const found = findAnnotation(PDFLib, document, pageIndex, objectNumber);
    if (!found || !(found.dict instanceof PDFLib.PDFDict)) throw new Error('The shape is no longer in the PDF.');
    ({ dict, ref } = found);
  } else {
    ({ dict, ref } = newAnnotation(PDFLib, document, pageIndex, kind === 'polyline' ? 'PolyLine' : 'Polygon',
      { author, subject: SHAPE_SUBJECTS[kind], now }));
    if (kind === 'cloud') {
      dict.set(PDFLib.PDFName.of('IT'), PDFLib.PDFName.of('PolygonCloud'));
      dict.set(PDFLib.PDFName.of('BE'), document.context.obj({ S: 'C', I: 1 }));
    }
  }
  dict.set(PDFLib.PDFName.of('C'), document.context.obj(colorComponents(style.color)));
  dict.set(PDFLib.PDFName.of('BS'), document.context.obj({ Type: 'Border', W: Math.max(0.25, Number(style.width) || 1.5), S: 'S' }));
  dict.set(PDFLib.PDFName.of('Vertices'), document.context.obj(clean.flatMap(point => [point.x, point.y])));
  dict.set(PDFLib.PDFName.of('M'), PDFLib.PDFString.of(pdfDate(now)));
  const { content, rect } = shapeAppearance(kind, clean, style);
  setAppearance(PDFLib, document, dict, content, rect);
  if (kind === 'cloud') {
    // /RD: the cloud's arcs lie outside the polygon by about their radius.
    const box = [Math.min(...clean.map(p => p.x)), Math.min(...clean.map(p => p.y)), Math.max(...clean.map(p => p.x)), Math.max(...clean.map(p => p.y))];
    dict.set(PDFLib.PDFName.of('RD'), document.context.obj([box[0] - rect[0], box[1] - rect[1], rect[2] - box[2], rect[3] - box[3]]
      .map(value => Math.max(0, Math.round(value * 1000) / 1000))));
  }
  return finish(PDFLib, document, before, ref, pageIndex);
}

function dataUrlBytes(dataUrl) {
  const base64 = String(dataUrl).split(',')[1] || '';
  const binary = globalThis.atob ? globalThis.atob(base64) : Buffer.from(base64, 'base64').toString('binary');
  const out = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) out[index] = binary.charCodeAt(index);
  return out;
}

/** The stamp's second line: date (in the locale) and name. */
export function stampDetail({ withDate = true, withName = true, author = '', locale, now = new Date() } = {}) {
  const parts = [];
  if (withDate) {
    try {
      parts.push(new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(now));
    } catch {
      parts.push(now.toISOString().slice(0, 16).replace('T', ' '));
    }
  }
  if (withName && author) parts.push(author);
  return parts.join(' · ');
}

/**
 * Place a stamp centred at `center`: a preset ({ preset: { id, text, color } }) or an image
 * ({ image: { dataUrl, width, height } }). With `objectNumber` an existing stamp moves to `center` instead.
 */
export async function writeStampAnnotation(PDFLib, bytes, {
  pageIndex, center, preset = null, image = null, detail = '', author = '', objectNumber = null, now = new Date(),
} = {}) {
  const document = await loadForEdit(PDFLib, bytes);
  const before = annotationRefs(PDFLib, document);
  if (objectNumber != null) {
    const found = findAnnotation(PDFLib, document, pageIndex, objectNumber);
    if (!found || !(found.dict instanceof PDFLib.PDFDict)) throw new Error('The stamp is no longer in the PDF.');
    const rect = numbers(PDFLib, found.dict, 'Rect');
    if (!rect) throw new Error('The stamp has no position.');
    const dx = center.x - (rect[0] + rect[2]) / 2, dy = center.y - (rect[1] + rect[3]) / 2;
    // Moving the Rect moves the appearance with it (the BBox is mapped onto the Rect).
    found.dict.set(PDFLib.PDFName.of('Rect'), document.context.obj([rect[0] + dx, rect[1] + dy, rect[2] + dx, rect[3] + dy]
      .map(value => Math.round(value * 1000) / 1000)));
    found.dict.set(PDFLib.PDFName.of('M'), PDFLib.PDFString.of(pdfDate(now)));
    return finish(PDFLib, document, before, found.ref, pageIndex);
  }
  const { dict, ref } = newAnnotation(PDFLib, document, pageIndex, 'Stamp', { author, subject: 'Stamp', now });
  dict.set(PDFLib.PDFName.of('M'), PDFLib.PDFString.of(pdfDate(now)));
  if (image?.dataUrl) {
    const bytesOfImage = dataUrlBytes(image.dataUrl);
    const embedded = /^data:image\/png/u.test(image.dataUrl)
      ? await document.embedPng(bytesOfImage) : await document.embedJpg(bytesOfImage);
    const width = Math.min(220, Math.max(24, Number(image.displayWidth) || 150));
    const height = width * (Number(image.height) || embedded.height) / Math.max(1, Number(image.width) || embedded.width);
    const rect = [center.x - width / 2, center.y - height / 2, center.x + width / 2, center.y + height / 2]
      .map(value => Math.round(value * 1000) / 1000);
    dict.set(PDFLib.PDFName.of('Name'), PDFLib.PDFName.of(STAMP_NAMES.image.slice(1)));
    if (image.name) dict.set(PDFLib.PDFName.of('Contents'), pdfText(PDFLib, image.name));
    // pdf-lib writes the image object on save; the appearance points at it.
    setAppearance(PDFLib, document, dict, `q ${n(width)} 0 0 ${n(height)} ${n(rect[0])} ${n(rect[1])} cm /Img Do Q`, rect,
      { XObject: { Img: embedded.ref } });
    return finish(PDFLib, document, before, ref, pageIndex);
  }
  const chosen = preset || { id: 'approved', text: 'APPROVED', color: '#2b8a3e' };
  const stampName = STAMP_NAMES[chosen.id] || '#Custom';
  dict.set(PDFLib.PDFName.of('Name'), PDFLib.PDFName.of(stampName.replace(/^#/u, '')));
  dict.set(PDFLib.PDFName.of('C'), document.context.obj(colorComponents(chosen.color)));
  dict.set(PDFLib.PDFName.of('Contents'), pdfText(PDFLib, detail ? `${chosen.text} · ${detail}` : chosen.text));
  const { content, rect } = stampAppearance({ label: chosen.text, detail, color: chosen.color, center });
  setAppearance(PDFLib, document, dict, content, rect);
  return finish(PDFLib, document, before, ref, pageIndex);
}

/** A callout: FreeText with a leader line from the box at `anchor` to `tip`. */
export async function writeCalloutAnnotation(PDFLib, bytes, {
  pageIndex, tip, anchor, value, style = {}, author = '', now = new Date(),
} = {}) {
  if (!String(value || '').trim()) throw new Error('A callout needs text.');
  const document = await loadForEdit(PDFLib, bytes);
  const before = annotationRefs(PDFLib, document);
  const { dict, ref } = newAnnotation(PDFLib, document, pageIndex, 'FreeText', { author, subject: 'Callout', now });
  const appearance = calloutAppearance({ tip, anchor, value, style });
  const textRgb = colorComponents(style.textColor || '#111111');
  dict.set(PDFLib.PDFName.of('IT'), PDFLib.PDFName.of('FreeTextCallout'));
  dict.set(PDFLib.PDFName.of('Contents'), pdfText(PDFLib, value));
  dict.set(PDFLib.PDFName.of('DA'), PDFLib.PDFString.of(`${textRgb.join(' ')} rg /Helv ${n(appearance.fontSize)} Tf`));
  dict.set(PDFLib.PDFName.of('CL'), document.context.obj(appearance.callout.flatMap(point => [n(point.x), n(point.y)].map(Number))));
  dict.set(PDFLib.PDFName.of('LE'), PDFLib.PDFName.of('OpenArrow'));
  dict.set(PDFLib.PDFName.of('C'), document.context.obj(colorComponents(style.borderColor || '#e03131')));
  dict.set(PDFLib.PDFName.of('BS'), document.context.obj({ Type: 'Border', W: Math.max(0.5, Number(style.borderWidth) || 1), S: 'S' }));
  dict.set(PDFLib.PDFName.of('M'), PDFLib.PDFString.of(pdfDate(now)));
  setAppearance(PDFLib, document, dict, appearance.content, appearance.rect);
  const [l, b, r, t] = appearance.rect;
  dict.set(PDFLib.PDFName.of('RD'), document.context.obj([appearance.box[0] - l, appearance.box[1] - b, r - appearance.box[2], t - appearance.box[3]]
    .map(value2 => Math.max(0, Math.round(value2 * 1000) / 1000))));
  return finish(PDFLib, document, before, ref, pageIndex);
}

/** Move any own or foreign polygon, polyline, cloud or stamp by (dx, dy) in user space. */
export async function translateMarkupAnnotation(PDFLib, bytes, { pageIndex, objectNumber, dx, dy, style = null } = {}) {
  const document = await loadForEdit(PDFLib, bytes);
  const found = findAnnotation(PDFLib, document, pageIndex, objectNumber);
  if (!found) throw new Error('The annotation is no longer in the PDF.');
  const before = annotationRefs(PDFLib, document);
  const rect = numbers(PDFLib, found.dict, 'Rect');
  if (rect) found.dict.set(PDFLib.PDFName.of('Rect'), document.context.obj([rect[0] + dx, rect[1] + dy, rect[2] + dx, rect[3] + dy]));
  const vertices = numbers(PDFLib, found.dict, 'Vertices');
  if (vertices) found.dict.set(PDFLib.PDFName.of('Vertices'), document.context.obj(vertices.map((value, index) => value + (index % 2 ? dy : dx))));
  void style;
  return finish(PDFLib, document, before, found.ref, pageIndex);
}

/** Remove any annotation by object number (and its popup). Returns { bytes, annotationIndexMaps, data }. */
export async function removeAnnotationObject(PDFLib, bytes, { pageIndex, objectNumber } = {}) {
  const document = await loadForEdit(PDFLib, bytes);
  const found = findAnnotation(PDFLib, document, pageIndex, objectNumber);
  if (!found) throw new Error('The annotation is no longer in the PDF.');
  const before = annotationRefs(PDFLib, document);
  const popup = found.dict instanceof PDFLib.PDFDict ? found.dict.get(PDFLib.PDFName.of('Popup')) : null;
  if (found.dict instanceof PDFLib.PDFDict) releaseAppearance(PDFLib, document, found.dict);
  found.page.node.removeAnnot(found.ref);
  if (popup instanceof PDFLib.PDFRef) {
    found.page.node.removeAnnot(popup);
    document.context.delete(popup);
  }
  document.context.delete(found.ref);
  return finish(PDFLib, document, before, null, pageIndex);
}
