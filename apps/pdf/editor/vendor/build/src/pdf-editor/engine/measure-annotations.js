// berg:work: PDF measurement annotations and page scales, written and read with pdf-lib.
//
// The pinned PDFium worker cannot write /Measure, /IT, /Vertices or a page's /VP (its annotation.set command
// knows Contents, T, L, ink and quad points, colours and border only). So a measurement is written into a checkpoint
// of the session with pdf-lib and the session switches to that snapshot (document.restore-snapshot, the same way
// the form designer and page stamps work). That keeps Undo exact and the file standard:
//
//   distance  -> /Line     /IT /LineDimension     /L [x1 y1 x2 y2]
//   perimeter -> /PolyLine /IT /PolyLineDimension /Vertices [...]
//   area      -> /Polygon  /IT /PolygonDimension  /Vertices [...]
//
// each with a /Measure dictionary (Subtype /RL, ISO 32000-2 12.10) and an own appearance stream (line, end ticks,
// caption on a light box), so Acrobat, PDF-XChange, PDF.js and PDFium show and read them alike. A calibrated scale
// is stored on the page as a viewport (/VP, 12.10.1), which is also where CAD exports put theirs.

import {
  MEASURE_INTENTS, MEASURE_KINDS, MEASURE_SUBJECTS, MEASURE_SUBTYPES, measureContents, measureDictValues,
  formatMeasure, measureValue, polygonCentroid, scaleFromMeasureDict, scaleForPoint,
} from '../model/pdf-measure.js';

export const MEASURE_APPEARANCE_KEY = 'BWMeasure';
const NAME_PREFIX = 'bergwork-measure-';

// Helvetica advance widths (AFM, 1/1000 em) for the characters a caption uses; others count as 556.
const HELVETICA_WIDTHS = (() => {
  const widths = new Map();
  const ascii = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
    556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015,
    667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667,
    944, 667, 667, 611, 278, 278, 278, 469, 556, 333,
    556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500,
    722, 500, 500, 500, 334, 260, 334, 584];
  ascii.forEach((width, index) => widths.set(32 + index, width));
  for (const [char, width] of Object.entries({ '²': 333, '³': 333, '°': 400, '·': 278, 'µ': 556, '×': 584,
    'ä': 556, 'ö': 556, 'ü': 556, 'Ä': 667, 'Ö': 778, 'Ü': 722, 'ß': 611, '€': 556, '–': 556, '—': 1000 })) {
    widths.set(char.charCodeAt(0), width);
  }
  return widths;
})();
const WIN_ANSI_EXTRA = new Map(Object.entries({ '€': 0x80, '…': 0x85, '•': 0x95, '–': 0x96, '—': 0x97,
  '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94 }).map(([char, code]) => [char.charCodeAt(0), code]));

export function winAnsiCodes(text) {
  return [...String(text)].map(char => {
    const code = char.charCodeAt(0);
    if (WIN_ANSI_EXTRA.has(code)) return WIN_ANSI_EXTRA.get(code);
    if (code >= 32 && code <= 126) return code;
    if (code >= 0xa0 && code <= 0xff) return code;
    return 0x3f;
  });
}

export function captionWidth(text, fontSize) {
  return [...String(text)].reduce((sum, char) => sum + (HELVETICA_WIDTHS.get(char.charCodeAt(0)) ?? 556), 0) *
    fontSize / 1000;
}

export const hex = text => `<${winAnsiCodes(text).map(code => code.toString(16).padStart(2, '0')).join('')}>`;
export const n = value => {
  const rounded = Math.round(Number(value) * 1000) / 1000;
  return Object.is(rounded, -0) ? '0' : String(rounded);
};

export function colorComponents(color = '#e03131') {
  const match = /^#?([0-9a-f]{6})/iu.exec(String(color));
  const value = match ? parseInt(match[1], 16) : 0xe03131;
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255].map(channel => Math.round(channel / 255 * 1000) / 1000);
}

export function pdfDate(date = new Date()) {
  const pad = (value, length = 2) => String(Math.abs(Math.trunc(value))).padStart(length, '0');
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  return `D:${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}` +
    `${pad(date.getMinutes())}${pad(date.getSeconds())}${sign}${pad(offset / 60)}'${pad(offset % 60)}'`;
}

export function parsePdfDate(text = '') {
  const match = /^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?([Z+-])?(\d{2})?'?(\d{2})?/u.exec(String(text));
  if (!match) return '';
  const [, y, mo = '01', d = '01', h = '00', mi = '00', s = '00', zone, zh = '00', zm = '00'] = match;
  const offset = !zone || zone === 'Z' ? 'Z' : `${zone}${zh}:${zm}`;
  const date = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}${offset}`);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

/** A caption on a light box, centred at (cx, cy), turned by `angle` (radians), kept upright. */
export function captionOps(text, cx, cy, angle, fontSize, rgb) {
  let turn = angle;
  if (turn > Math.PI / 2 + 1e-6) turn -= Math.PI;
  if (turn < -Math.PI / 2 - 1e-6) turn += Math.PI;
  const cos = Math.cos(turn), sin = Math.sin(turn);
  const width = captionWidth(text, fontSize);
  const pad = fontSize * 0.25;
  // Text origin: left end of the baseline, so that the text box is centred at (cx, cy).
  const ox = -width / 2, oy = -fontSize * 0.36;
  return [
    'q', `${n(cos)} ${n(sin)} ${n(-sin)} ${n(cos)} ${n(cx)} ${n(cy)} cm`,
    '/GSbox gs 1 1 1 rg', `${n(ox - pad)} ${n(oy - fontSize * 0.25 - pad / 2)} ${n(width + 2 * pad)} ${n(fontSize * 1.2 + pad)} re f`,
    'Q', 'q', `${rgb.join(' ')} rg`, 'BT', `/Helv ${n(fontSize)} Tf`,
    `${n(cos)} ${n(sin)} ${n(-sin)} ${n(cos)} ${n(cx + ox * cos - oy * sin)} ${n(cy + ox * sin + oy * cos)} Tm`,
    `${hex(text)} Tj`, 'ET', 'Q',
  ].join('\n');
}

function captionExtent(text, cx, cy, fontSize) {
  // A generous circle around the caption box, whatever its angle.
  const radius = Math.hypot(captionWidth(text, fontSize) / 2 + fontSize * 0.3, fontSize * 0.8);
  return [{ x: cx - radius, y: cy - radius }, { x: cx + radius, y: cy + radius }];
}

/**
 * Appearance of a measurement: { content, rect }, in user space (the form's BBox is the annotation /Rect and its
 * matrix the identity). Points are PDF user space.
 */
export function measurementAppearance(kind, points, caption, style = {}) {
  const width = Math.max(0.25, Number(style.width) || 1);
  const fontSize = Math.max(4, Number(style.fontSize) || 9);
  const rgb = colorComponents(style.color);
  const ops = [`${rgb.join(' ')} RG`, `${n(width)} w`, '1 J 1 j'];
  const extents = [...points];
  if (kind === 'distance') {
    const [a, b] = [points[0], points[points.length - 1]];
    const angle = Math.atan2(b.y - a.y, b.x - a.x);
    const nx = -Math.sin(angle), ny = Math.cos(angle);
    const tick = Math.max(4, fontSize * 0.55);
    ops.push(`${n(a.x)} ${n(a.y)} m ${n(b.x)} ${n(b.y)} l S`);
    for (const end of [a, b]) {
      ops.push(`${n(end.x - nx * tick)} ${n(end.y - ny * tick)} m ${n(end.x + nx * tick)} ${n(end.y + ny * tick)} l S`);
      extents.push({ x: end.x - nx * tick, y: end.y - ny * tick }, { x: end.x + nx * tick, y: end.y + ny * tick });
    }
    // Caption above the line (on the side the normal points to after keeping the text upright).
    const upright = angle > Math.PI / 2 || angle < -Math.PI / 2 ? -1 : 1;
    const offset = fontSize * 0.9 + width;
    const cx = (a.x + b.x) / 2 + nx * offset * upright;
    const cy = (a.y + b.y) / 2 + ny * offset * upright;
    ops.push(captionOps(caption, cx, cy, angle, fontSize, rgb));
    extents.push(...captionExtent(caption, cx, cy, fontSize));
  } else {
    const path = points.map((point, index) => `${n(point.x)} ${n(point.y)} ${index ? 'l' : 'm'}`).join(' ');
    if (kind === 'area') {
      ops.push('q', `/GSfill gs ${rgb.join(' ')} rg`, `${path} h f`, 'Q', `${path} h S`);
      const centre = polygonCentroid(points);
      ops.push(captionOps(caption, centre.x, centre.y, 0, fontSize, rgb));
      extents.push(...captionExtent(caption, centre.x, centre.y, fontSize));
    } else {
      ops.push(`${path} S`);
      // Caption along the longest segment.
      let best = 0, bestLength = -1;
      for (let index = 1; index < points.length; index += 1) {
        const length = Math.hypot(points[index].x - points[index - 1].x, points[index].y - points[index - 1].y);
        if (length > bestLength) { best = index; bestLength = length; }
      }
      const a = points[Math.max(0, best - 1)], b = points[best] || a;
      const angle = Math.atan2(b.y - a.y, b.x - a.x);
      const upright = angle > Math.PI / 2 || angle < -Math.PI / 2 ? -1 : 1;
      const offset = fontSize * 0.9 + width;
      const cx = (a.x + b.x) / 2 - Math.sin(angle) * offset * upright;
      const cy = (a.y + b.y) / 2 + Math.cos(angle) * offset * upright;
      ops.push(captionOps(caption, cx, cy, angle, fontSize, rgb));
      extents.push(...captionExtent(caption, cx, cy, fontSize));
    }
  }
  const margin = width + 1;
  const xs = extents.map(point => point.x), ys = extents.map(point => point.y);
  const rect = [Math.min(...xs) - margin, Math.min(...ys) - margin, Math.max(...xs) + margin, Math.max(...ys) + margin]
    .map(value => Math.round(value * 1000) / 1000);
  return { content: ops.join('\n'), rect };
}

// ---------------------------------------------------------------------------------------------------------------
// Reading

/** PDF object -> plain JSON values (names and strings become strings), depth-limited. */
export function plainPdfValue(PDFLib, context, value, depth = 0) {
  if (depth > 6 || value == null) return undefined;
  const object = value instanceof PDFLib.PDFRef ? context.lookup(value) : value;
  if (object instanceof PDFLib.PDFNumber) return object.asNumber();
  if (object instanceof PDFLib.PDFName) return object.decodeText();
  if (object instanceof PDFLib.PDFString || object instanceof PDFLib.PDFHexString) return object.decodeText();
  if (object instanceof PDFLib.PDFBool) return object.asBoolean();
  if (object instanceof PDFLib.PDFArray) return object.asArray().map(item => plainPdfValue(PDFLib, context, item, depth + 1));
  if (object instanceof PDFLib.PDFDict && !(object instanceof PDFLib.PDFStream)) {
    const out = {};
    for (const [key, item] of object.entries()) {
      if (key.decodeText() === 'Parent' || key.decodeText() === 'P') continue;
      out[key.decodeText()] = plainPdfValue(PDFLib, context, item, depth + 1);
    }
    return out;
  }
  return undefined;
}

export function text(PDFLib, dict, key) {
  const value = dict.lookup(PDFLib.PDFName.of(key));
  return value instanceof PDFLib.PDFString || value instanceof PDFLib.PDFHexString ? value.decodeText() : '';
}

export function name(PDFLib, dict, key) {
  const value = dict.lookup(PDFLib.PDFName.of(key));
  return value instanceof PDFLib.PDFName ? value.decodeText() : '';
}

export function numbers(PDFLib, dict, key) {
  const value = dict.lookup(PDFLib.PDFName.of(key));
  if (!(value instanceof PDFLib.PDFArray)) return null;
  const out = value.asArray().map(item => {
    const resolved = dict.context.lookup(item);
    return resolved instanceof PDFLib.PDFNumber ? resolved.asNumber() : Number.NaN;
  });
  return out.every(Number.isFinite) ? out : null;
}

export function pageAnnots(PDFLib, page) {
  const annots = page.node.lookup(PDFLib.PDFName.of('Annots'));
  return annots instanceof PDFLib.PDFArray ? annots : null;
}

export function readPageViewports(PDFLib, page) {
  const vp = page.node.lookup(PDFLib.PDFName.of('VP'));
  if (!(vp instanceof PDFLib.PDFArray)) return [];
  const context = page.node.context;
  return vp.asArray().map((item, index) => {
    const dict = context.lookup(item);
    if (!(dict instanceof PDFLib.PDFDict)) return null;
    const bbox = numbers(PDFLib, dict, 'BBox');
    const measureValues = plainPdfValue(PDFLib, context, dict.get(PDFLib.PDFName.of('Measure')));
    const subtype = measureValues?.Subtype || '';
    let scale = null;
    try { scale = scaleFromMeasureDict(measureValues); } catch { scale = null; }
    return bbox ? {
      index, bbox, name: text(PDFLib, dict, 'Name'), scale,
      ...(subtype && subtype !== 'RL' ? { unsupported: subtype } : {}),
      ...(text(PDFLib, dict, 'Name') === 'berg:work scale' ? { own: true } : {}),
    } : null;
  }).filter(Boolean);
}

function measurementKind(subtype, intent, hasMeasure) {
  if (subtype === 'Line' && (intent === 'LineDimension' || hasMeasure)) return 'distance';
  if (subtype === 'PolyLine' && (intent === 'PolyLineDimension' || hasMeasure)) return 'perimeter';
  if (subtype === 'Polygon' && (intent === 'PolygonDimension' || hasMeasure)) return 'area';
  return '';
}

/** One measurement annotation as plain data, or null when `dict` is no measurement. */
export function readMeasurementAnnotation(PDFLib, context, dict, { pageIndex, annotationIndex, ref, viewports = [] }) {
  if (!(dict instanceof PDFLib.PDFDict)) return null;
  const subtype = name(PDFLib, dict, 'Subtype');
  const intent = name(PDFLib, dict, 'IT');
  const measureRaw = dict.get(PDFLib.PDFName.of('Measure'));
  const kind = measurementKind(subtype, intent, Boolean(measureRaw));
  if (!kind) return null;
  let points = [];
  if (kind === 'distance') {
    const line = numbers(PDFLib, dict, 'L');
    if (line?.length === 4) points = [{ x: line[0], y: line[1] }, { x: line[2], y: line[3] }];
  } else {
    const vertices = numbers(PDFLib, dict, 'Vertices') || [];
    for (let index = 0; index + 1 < vertices.length; index += 2) points.push({ x: vertices[index], y: vertices[index + 1] });
  }
  if (points.length < 2) return null;
  let scale = null;
  try { scale = scaleFromMeasureDict(plainPdfValue(PDFLib, context, measureRaw)); } catch { scale = null; }
  if (!scale) scale = scaleForPoint(viewports, points[0]);
  const measured = measureValue(kind, points, scale);
  const color = numbers(PDFLib, dict, 'C');
  const border = dict.lookup(PDFLib.PDFName.of('BS'));
  const borderWidth = border instanceof PDFLib.PDFDict ? context.lookup(border.get(PDFLib.PDFName.of('W'))) : null;
  const nm = text(PDFLib, dict, 'NM');
  return {
    kind,
    pageIndex,
    annotationIndex,
    objectNumber: ref ? ref.objectNumber : null,
    generation: ref ? ref.generationNumber : null,
    name: nm,
    own: nm.startsWith(NAME_PREFIX),
    points,
    scale,
    value: measured.value,
    unitLabel: measured.unitLabel,
    ...(kind === 'area' ? { perimeter: measured.perimeter } : {}),
    contents: text(PDFLib, dict, 'Contents'),
    author: text(PDFLib, dict, 'T'),
    modified: parsePdfDate(text(PDFLib, dict, 'M') || text(PDFLib, dict, 'CreationDate')),
    color: color?.length === 3 ? `#${color.map(value => Math.round(Math.max(0, Math.min(1, value)) * 255)
      .toString(16).padStart(2, '0')).join('')}` : '#e03131',
    width: borderWidth instanceof PDFLib.PDFNumber ? borderWidth.asNumber() : 1,
  };
}

/** Viewports and measurements of every page: { pages: [{ pageIndex, viewports, items }] }. */
export function readMeasureDataFromDocument(PDFLib, document) {
  const pages = document.getPages().map((page, pageIndex) => {
    const viewports = readPageViewports(PDFLib, page);
    const annots = pageAnnots(PDFLib, page);
    const items = [];
    if (annots) {
      annots.asArray().forEach((item, annotationIndex) => {
        const ref = item instanceof PDFLib.PDFRef ? item : null;
        const dict = document.context.lookup(item);
        const measurement = readMeasurementAnnotation(PDFLib, document.context, dict,
          { pageIndex, annotationIndex, ref, viewports });
        if (measurement) items.push(measurement);
      });
    }
    return { pageIndex, viewports, items };
  });
  return { pages };
}

export async function readMeasureData(PDFLib, bytes) {
  const document = await PDFLib.PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true });
  return readMeasureDataFromDocument(PDFLib, document);
}

/**
 * Cheap test before a full parse: does the raw file name /Measure, /VP, a polygon or a stamp? Compressed object streams hide names, so
 * with `objectStreams` a file that has any (/ObjStm) counts as a maybe too.
 */
export function bytesMayHaveMeasurements(bytes, { objectStreams = false } = {}) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  // /Poly and /Stamp: polygons, polylines and stamps (engine/markup-annotations.js) are read at the same time.
  const needles = ['/Measure', '/VP', '/Poly', '/Stamp', ...(objectStreams ? ['/ObjStm'] : [])].map(word => [...word].map(char => char.charCodeAt(0)));
  for (let index = 0; index < view.length; index += 1) {
    if (view[index] !== 0x2f) continue;
    for (const needle of needles) {
      let match = true;
      for (let offset = 1; offset < needle.length; offset += 1) {
        if (view[index + offset] !== needle[offset]) { match = false; break; }
      }
      if (match) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------------------------------------------
// Writing

/** A PDF text string: a literal for printable ASCII (what every reader handles), UTF-16BE otherwise. */
export function pdfText(PDFLib, value) {
  const text = String(value ?? '');
  if (/^[\x20-\x7e]*$/u.test(text)) return PDFLib.PDFString.of(text.replace(/[\\()]/gu, match => `\\${match}`));
  return PDFLib.PDFHexString.fromText(text);
}

function measureDict(PDFLib, context, values) {
  const convert = value => {
    if (Array.isArray(value)) return context.obj(value.map(convert));
    if (value && typeof value === 'object') {
      const dict = context.obj({});
      for (const [key, item] of Object.entries(value)) {
        if (item === undefined) continue;
        dict.set(PDFLib.PDFName.of(key), ['Type', 'Subtype', 'F'].includes(key) && typeof item === 'string'
          ? PDFLib.PDFName.of(item)
          : typeof item === 'string' ? pdfText(PDFLib, item) : convert(item));
      }
      return dict;
    }
    if (typeof value === 'number') return PDFLib.PDFNumber.of(value);
    if (typeof value === 'boolean') return value ? PDFLib.PDFBool.True : PDFLib.PDFBool.False;
    return pdfText(PDFLib, String(value ?? ''));
  };
  return convert(values);
}

export function annotationRefs(PDFLib, document) {
  return document.getPages().map(page => {
    const annots = pageAnnots(PDFLib, page);
    return annots ? annots.asArray().map(item => (item instanceof PDFLib.PDFRef ? `${item.objectNumber} ${item.generationNumber}` : null)) : [];
  });
}

export function indexMaps(before, after) {
  return before.map((refs, pageIndex) => refs.map(ref => (ref ? after[pageIndex].indexOf(ref) : -1)));
}

export function findAnnotation(PDFLib, document, pageIndex, objectNumber) {
  const page = document.getPage(pageIndex);
  const annots = pageAnnots(PDFLib, page);
  if (!annots) return null;
  const items = annots.asArray();
  const index = items.findIndex(item => item instanceof PDFLib.PDFRef && item.objectNumber === Number(objectNumber));
  if (index < 0) return null;
  return { page, annots, index, ref: items[index], dict: document.context.lookup(items[index]) };
}

/** Drop an appearance stream this module wrote (marked with /BWMeasure), so edits leave no orphans behind. */
export function releaseOwnAppearance(PDFLib, document, dict) {
  const ap = dict.lookup(PDFLib.PDFName.of('AP'));
  if (!(ap instanceof PDFLib.PDFDict)) return;
  const normalRef = ap.get(PDFLib.PDFName.of('N'));
  if (!(normalRef instanceof PDFLib.PDFRef)) return;
  const stream = document.context.lookup(normalRef);
  if (stream instanceof PDFLib.PDFStream && stream.dict.get(PDFLib.PDFName.of(MEASURE_APPEARANCE_KEY))) {
    document.context.delete(normalRef);
  }
}

function setAppearance(PDFLib, document, dict, kind, points, caption, style) {
  const { content, rect } = measurementAppearance(kind, points, caption, style);
  const context = document.context;
  const stream = context.flateStream(content, {
    Type: 'XObject', Subtype: 'Form', BBox: rect, Matrix: [1, 0, 0, 1, 0, 0],
    Resources: {
      Font: { Helv: { Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica', Encoding: 'WinAnsiEncoding' } },
      ExtGState: { GSbox: { Type: 'ExtGState', ca: 0.82 }, GSfill: { Type: 'ExtGState', ca: 0.14 } },
    },
  });
  stream.dict.set(PDFLib.PDFName.of(MEASURE_APPEARANCE_KEY), PDFLib.PDFBool.True);
  releaseOwnAppearance(PDFLib, document, dict);
  const ref = context.register(stream);
  dict.set(PDFLib.PDFName.of('AP'), context.obj({ N: ref }));
  dict.set(PDFLib.PDFName.of('Rect'), context.obj(rect));
}

function setGeometry(PDFLib, context, dict, kind, points) {
  if (kind === 'distance') {
    const [a, b] = [points[0], points[points.length - 1]];
    dict.set(PDFLib.PDFName.of('L'), context.obj([a.x, a.y, b.x, b.y]));
    dict.delete(PDFLib.PDFName.of('Vertices'));
  } else {
    dict.set(PDFLib.PDFName.of('Vertices'), context.obj(points.flatMap(point => [point.x, point.y])));
    dict.delete(PDFLib.PDFName.of('L'));
  }
}

export function cleanPoints(points) {
  const clean = (points || []).map(point => ({ x: Number(point.x), y: Number(point.y) }))
    .filter(point => Number.isFinite(point.x) && Number.isFinite(point.y))
    .map(point => ({ x: Math.round(point.x * 1000) / 1000, y: Math.round(point.y * 1000) / 1000 }));
  return clean;
}

function validate(kind, points) {
  if (!MEASURE_KINDS.includes(kind)) throw new Error(`Unknown measurement type: ${kind}`);
  const needed = kind === 'area' ? 3 : 2;
  if (points.length < needed) {
    throw new Error(kind === 'area' ? 'An area needs at least three points.' : 'A measurement needs two points.');
  }
}

export async function loadForEdit(PDFLib, bytes) {
  return PDFLib.PDFDocument.load(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), {
    updateMetadata: false,
    ignoreEncryption: false,
  });
}

export async function saveEdited(PDFLib, document) {
  return new Uint8Array(await document.save({ useObjectStreams: false, addDefaultPage: false, updateFieldAppearances: false }));
}

export function randomId() {
  const values = new Uint8Array(8);
  (globalThis.crypto || { getRandomValues: array => array.map(() => Math.floor(Math.random() * 256)) }).getRandomValues(values);
  return Array.from(values, value => value.toString(16).padStart(2, '0')).join('');
}

/**
 * Add a measurement, or replace the geometry of an existing one (`objectNumber`). The scale is the measurement's
 * own (stored in its /Measure). Returns { bytes, objectNumber, annotationIndex, annotationIndexMaps, data }.
 */
export async function writeMeasurement(PDFLib, bytes, {
  pageIndex, kind, points, scale, style = {}, author = '', locale, objectNumber = null, now = new Date(),
} = {}) {
  const clean = cleanPoints(points);
  validate(kind, clean);
  if (!scale) throw new Error('A measurement needs a scale.');
  const document = await loadForEdit(PDFLib, bytes);
  if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= document.getPageCount()) {
    throw new Error('The measurement page is outside the document.');
  }
  const before = annotationRefs(PDFLib, document);
  const context = document.context;
  const caption = formatMeasure(kind, clean, scale, locale);
  const contents = measureContents(kind, clean, scale, locale);
  let dict;
  let ref;
  if (objectNumber != null) {
    const found = findAnnotation(PDFLib, document, pageIndex, objectNumber);
    if (!found || !(found.dict instanceof PDFLib.PDFDict)) throw new Error('The measurement is no longer in the PDF.');
    dict = found.dict;
    ref = found.ref;
    if (name(PDFLib, dict, 'Subtype') !== MEASURE_SUBTYPES[kind]) throw new Error('The measurement type changed.');
  } else {
    const page = document.getPage(pageIndex);
    dict = context.obj({
      Type: 'Annot',
      Subtype: MEASURE_SUBTYPES[kind],
      F: 4,
      IT: MEASURE_INTENTS[kind],
      P: page.ref,
    });
    dict.set(PDFLib.PDFName.of('NM'), pdfText(PDFLib, `${NAME_PREFIX}${randomId()}`));
    dict.set(PDFLib.PDFName.of('Subj'), pdfText(PDFLib, MEASURE_SUBJECTS[kind]));
    dict.set(PDFLib.PDFName.of('CreationDate'), PDFLib.PDFString.of(pdfDate(now)));
    if (author) dict.set(PDFLib.PDFName.of('T'), pdfText(PDFLib, String(author)));
    if (kind === 'distance') {
      dict.set(PDFLib.PDFName.of('LE'), context.obj(['Butt', 'Butt']));
      dict.set(PDFLib.PDFName.of('Cap'), PDFLib.PDFBool.True);
      dict.set(PDFLib.PDFName.of('CP'), PDFLib.PDFName.of('Top'));
    }
    ref = context.register(dict);
    page.node.addAnnot(ref);
  }
  const rgb = colorComponents(style.color);
  dict.set(PDFLib.PDFName.of('C'), context.obj(rgb));
  dict.set(PDFLib.PDFName.of('BS'), context.obj({ Type: 'Border', W: Math.max(0.25, Number(style.width) || 1), S: 'S' }));
  dict.set(PDFLib.PDFName.of('CA'), PDFLib.PDFNumber.of(1));
  dict.set(PDFLib.PDFName.of('Contents'), pdfText(PDFLib, contents));
  dict.set(PDFLib.PDFName.of('M'), PDFLib.PDFString.of(pdfDate(now)));
  dict.set(PDFLib.PDFName.of('Measure'), measureDict(PDFLib, context, measureDictValues(scale)));
  setGeometry(PDFLib, context, dict, kind, clean);
  setAppearance(PDFLib, document, dict, kind, clean, caption, style);
  const after = annotationRefs(PDFLib, document);
  const data = readMeasureDataFromDocument(PDFLib, document);
  const annotationIndex = pageAnnots(PDFLib, document.getPage(pageIndex)).asArray()
    .findIndex(item => item instanceof PDFLib.PDFRef && item.objectNumber === ref.objectNumber);
  return {
    bytes: await saveEdited(PDFLib, document),
    objectNumber: ref.objectNumber,
    annotationIndex,
    annotationIndexMaps: indexMaps(before, after),
    data,
  };
}

/** Remove a measurement (and its popup). Returns { bytes, annotationIndexMaps, data }. */
export async function removeMeasurement(PDFLib, bytes, { pageIndex, objectNumber } = {}) {
  const document = await loadForEdit(PDFLib, bytes);
  const found = findAnnotation(PDFLib, document, pageIndex, objectNumber);
  if (!found) throw new Error('The measurement is no longer in the PDF.');
  const before = annotationRefs(PDFLib, document);
  const popup = found.dict instanceof PDFLib.PDFDict ? found.dict.get(PDFLib.PDFName.of('Popup')) : null;
  if (found.dict instanceof PDFLib.PDFDict) releaseOwnAppearance(PDFLib, document, found.dict);
  found.page.node.removeAnnot(found.ref);
  if (popup instanceof PDFLib.PDFRef) {
    found.page.node.removeAnnot(popup);
    document.context.delete(popup);
  }
  document.context.delete(found.ref);
  const after = annotationRefs(PDFLib, document);
  return {
    bytes: await saveEdited(PDFLib, document),
    annotationIndexMaps: indexMaps(before, after),
    data: readMeasureDataFromDocument(PDFLib, document),
  };
}

/**
 * Store a scale on the page as a viewport. With other viewports on the page (several drawings at different
 * scales, as CAD exports have) only the one around `at` changes; otherwise one viewport covers the page.
 */
export async function writePageScale(PDFLib, bytes, { pageIndex, scale, at = null } = {}) {
  if (!scale) throw new Error('No scale to store.');
  const document = await loadForEdit(PDFLib, bytes);
  const page = document.getPage(pageIndex);
  const context = document.context;
  const existing = page.node.lookup(PDFLib.PDFName.of('VP'));
  const viewports = readPageViewports(PDFLib, page);
  const box = page.getCropBox();
  const fullPage = [box.x, box.y, box.x + box.width, box.y + box.height];
  const measure = measureDict(PDFLib, context, measureDictValues(scale));
  const target = at ? [...viewports].reverse().find(viewport => {
    const [x1, y1, x2, y2] = viewport.bbox;
    return at.x >= Math.min(x1, x2) && at.x <= Math.max(x1, x2) && at.y >= Math.min(y1, y2) && at.y <= Math.max(y1, y2);
  }) : null;
  if (existing instanceof PDFLib.PDFArray && target) {
    const dict = context.lookup(existing.get(target.index));
    dict.set(PDFLib.PDFName.of('Measure'), measure);
  } else {
    const viewport = context.obj({ Type: 'Viewport', BBox: fullPage });
    viewport.set(PDFLib.PDFName.of('Name'), pdfText(PDFLib, 'berg:work scale'));
    viewport.set(PDFLib.PDFName.of('Measure'), measure);
    if (existing instanceof PDFLib.PDFArray && viewports.length) {
      // Smaller drawings keep their own scales; the page-wide one goes first, so they still win inside their boxes.
      existing.insert(0, viewport);
    } else {
      page.node.set(PDFLib.PDFName.of('VP'), context.obj([viewport]));
    }
  }
  return { bytes: await saveEdited(PDFLib, document), data: readMeasureDataFromDocument(PDFLib, document) };
}
