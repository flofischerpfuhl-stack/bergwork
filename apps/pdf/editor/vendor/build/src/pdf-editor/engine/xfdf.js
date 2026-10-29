// berg:work: XFDF (ISO 19444-1, Adobe XFDF 3.0) export and import of annotations, with pdf-lib.
//
// Export writes every markup annotation with its geometry, colours, author, dates, replies (inreplyto) and review
// states, measurements with their <measure>. Import adds the annotations of an XFDF file to the document (skipping
// names that are already there) and gives each one an appearance, so they show in every viewer; replies attach to
// their parents by name.

import {
  annotationRefs, colorComponents, hex, indexMaps, loadForEdit, measurementAppearance, n, name, numbers,
  pageAnnots, pdfDate, pdfText, plainPdfValue, randomId, saveEdited, text,
} from './measure-annotations.js';
import { readPageMarkupFromDocument, shapeAppearance, stampAppearance, wrapText } from './markup-annotations.js';

// ---------------------------------------------------------------------------------------------------------------
// Minimal XML (enough for XFDF: elements, attributes, text, CDATA, entities; no DTDs)

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decodeEntities = value => String(value).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/giu, (match, code) => {
  if (code[0] === '#') {
    const point = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
    return Number.isFinite(point) ? String.fromCodePoint(point) : match;
  }
  return ENTITIES[code.toLowerCase()] ?? match;
});
const escapeXml = value => String(value ?? '').replace(/[&<>"]/gu, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char])
  // Characters XML 1.0 cannot carry.
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/gu, '');

/** Parse XML into { name, attributes, children, text }. Throws on malformed input. */
export function parseXml(source) {
  const xml = String(source).replace(/^\uFEFF/u, '');
  const root = { name: '#document', attributes: {}, children: [], text: '' };
  const stack = [root];
  let index = 0;
  const top = () => stack[stack.length - 1];
  while (index < xml.length) {
    const lt = xml.indexOf('<', index);
    if (lt < 0) { top().text += decodeEntities(xml.slice(index)); break; }
    if (lt > index) top().text += decodeEntities(xml.slice(index, lt));
    if (xml.startsWith('<!--', lt)) { const end = xml.indexOf('-->', lt + 4); if (end < 0) throw new Error('Unclosed XML comment.'); index = end + 3; continue; }
    if (xml.startsWith('<![CDATA[', lt)) { const end = xml.indexOf(']]>', lt + 9); if (end < 0) throw new Error('Unclosed CDATA.'); top().text += xml.slice(lt + 9, end); index = end + 3; continue; }
    if (xml.startsWith('<?', lt)) { const end = xml.indexOf('?>', lt + 2); if (end < 0) throw new Error('Unclosed XML declaration.'); index = end + 2; continue; }
    if (xml.startsWith('<!', lt)) { const end = xml.indexOf('>', lt + 2); if (end < 0) throw new Error('Unclosed XML declaration.'); index = end + 1; continue; }
    // The tag ends at the first '>' outside a quoted attribute value.
    let close = -1;
    for (let cursor = lt + 1, quote = ''; cursor < xml.length; cursor += 1) {
      const char = xml[cursor];
      if (quote) { if (char === quote) quote = ''; continue; }
      if (char === '"' || char === "'") quote = char;
      else if (char === '>') { close = cursor; break; }
    }
    if (close < 0) throw new Error('Unclosed XML tag.');
    let tag = xml.slice(lt + 1, close);
    if (tag.startsWith('/')) {
      const closing = tag.slice(1).trim().replace(/^.*:/u, '');
      const node = stack.pop();
      if (!node || node === root || node.name !== closing) throw new Error(`Unexpected </${closing}>.`);
      index = close + 1;
      continue;
    }
    const selfClosing = tag.endsWith('/');
    if (selfClosing) tag = tag.slice(0, -1);
    const nameMatch = /^\s*([^\s/>]+)/u.exec(tag);
    if (!nameMatch) throw new Error('XML tag without a name.');
    const node = { name: nameMatch[1].replace(/^.*:/u, ''), attributes: {}, children: [], text: '' };
    for (const match of tag.slice(nameMatch[0].length).matchAll(/([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/gu)) {
      node.attributes[match[1].replace(/^xml:/u, 'xml:')] = decodeEntities(match[3] ?? match[4] ?? '');
    }
    top().children.push(node);
    if (!selfClosing) stack.push(node);
    index = close + 1;
  }
  if (stack.length !== 1) throw new Error(`Unclosed <${top().name}>.`);
  return root;
}

const child = (node, tag) => node?.children?.find(item => item.name === tag) || null;
const allText = node => (node ? node.text + node.children.map(allText).join('') : '');

// ---------------------------------------------------------------------------------------------------------------
// Export

const ELEMENT_FOR_SUBTYPE = {
  Text: 'text', FreeText: 'freetext', Line: 'line', Square: 'square', Circle: 'circle', Polygon: 'polygon',
  PolyLine: 'polyline', Highlight: 'highlight', Underline: 'underline', Squiggly: 'squiggly', StrikeOut: 'strikeout',
  Stamp: 'stamp', Caret: 'caret', Ink: 'ink', FileAttachment: 'fileattachment', Sound: 'sound', Redact: 'redact',
};
const FLAG_NAMES = [[1, 'invisible'], [2, 'hidden'], [4, 'print'], [8, 'nozoom'], [16, 'norotate'], [32, 'noview'],
  [64, 'readonly'], [128, 'locked'], [256, 'togglenoview'], [512, 'lockedcontents']];
const hexColor = values => (values?.length === 3
  ? `#${values.map(value => Math.round(Math.max(0, Math.min(1, value)) * 255).toString(16).padStart(2, '0')).join('').toUpperCase()}` : '');
const pointsAttr = values => {
  const out = [];
  for (let index = 0; index + 1 < values.length; index += 2) out.push(`${n(values[index])},${n(values[index + 1])}`);
  return out.join(';');
};

function measureXml(PDFLib, context, dict) {
  const measure = plainPdfValue(PDFLib, context, dict.get(PDFLib.PDFName.of('Measure')));
  if (!measure || measure.Subtype && measure.Subtype !== 'RL') return '';
  const format = (tag, entry) => (entry ? `<${tag} d="${escapeXml(entry.D ?? 100)}" c="${escapeXml(entry.C ?? 1)}" u="${escapeXml(entry.U ?? '')}" f="${escapeXml(entry.F ?? 'D')}"/>` : '');
  return `<measure rateValue="${escapeXml(measure.R || '')}">${format('axis', measure.X?.[0])}${format('distance', measure.D?.[0])}${format('area', measure.A?.[0])}</measure>`;
}

/** XFDF text of every markup annotation in the document. `fileName` goes into <f href>. */
export function exportXfdfFromDocument(PDFLib, document, { fileName = '' } = {}) {
  const parts = [];
  const nameOf = new Map();
  const context = document.context;
  // Names first, so replies can point to them.
  document.getPages().forEach(page => {
    for (const item of pageAnnots(PDFLib, page)?.asArray() || []) {
      if (!(item instanceof PDFLib.PDFRef)) continue;
      const dict = context.lookup(item);
      if (!(dict instanceof PDFLib.PDFDict)) continue;
      let nm = text(PDFLib, dict, 'NM');
      if (!nm) nm = `bergwork-xfdf-${item.objectNumber}-${item.generationNumber}`;
      nameOf.set(`${item.objectNumber} ${item.generationNumber}`, nm);
    }
  });
  document.getPages().forEach((page, pageIndex) => {
    for (const item of pageAnnots(PDFLib, page)?.asArray() || []) {
      const dict = context.lookup(item);
      if (!(dict instanceof PDFLib.PDFDict)) continue;
      const subtype = name(PDFLib, dict, 'Subtype');
      const tag = ELEMENT_FOR_SUBTYPE[subtype];
      if (!tag) continue;
      const attrs = { page: pageIndex };
      const rect = numbers(PDFLib, dict, 'Rect');
      if (rect) attrs.rect = rect.map(n).join(',');
      const nm = item instanceof PDFLib.PDFRef ? nameOf.get(`${item.objectNumber} ${item.generationNumber}`) : text(PDFLib, dict, 'NM');
      if (nm) attrs.name = nm;
      const flagValue = context.lookup(dict.get(PDFLib.PDFName.of('F')));
      const flags = flagValue instanceof PDFLib.PDFNumber ? flagValue.asNumber() : 0;
      if (flags) attrs.flags = FLAG_NAMES.filter(([bit]) => flags & bit).map(([, label]) => label).join(',');
      for (const [key, attr] of [['T', 'title'], ['Subj', 'subject'], ['M', 'date'], ['CreationDate', 'creationdate']]) {
        const value = text(PDFLib, dict, key);
        if (value) attrs[attr] = value;
      }
      const color = hexColor(numbers(PDFLib, dict, 'C'));
      if (color) attrs.color = color;
      const interior = hexColor(numbers(PDFLib, dict, 'IC'));
      if (interior) attrs['interior-color'] = interior;
      const opacity = context.lookup(dict.get(PDFLib.PDFName.of('CA')));
      if (opacity instanceof PDFLib.PDFNumber && opacity.asNumber() !== 1) attrs.opacity = opacity.asNumber();
      const border = dict.lookup(PDFLib.PDFName.of('BS'));
      const width = border instanceof PDFLib.PDFDict ? context.lookup(border.get(PDFLib.PDFName.of('W'))) : null;
      if (width instanceof PDFLib.PDFNumber) attrs.width = width.asNumber();
      const effect = dict.lookup(PDFLib.PDFName.of('BE'));
      if (effect instanceof PDFLib.PDFDict && name(PDFLib, effect, 'S') === 'C') {
        attrs.style = 'cloudy';
        const intensity = context.lookup(effect.get(PDFLib.PDFName.of('I')));
        attrs.intensity = intensity instanceof PDFLib.PDFNumber ? intensity.asNumber() : 1;
      }
      const intent = name(PDFLib, dict, 'IT');
      if (intent) attrs.intent = intent;
      const irt = dict.get(PDFLib.PDFName.of('IRT'));
      if (irt instanceof PDFLib.PDFRef && nameOf.has(`${irt.objectNumber} ${irt.generationNumber}`)) {
        attrs.inreplyto = nameOf.get(`${irt.objectNumber} ${irt.generationNumber}`);
        attrs.replyType = name(PDFLib, dict, 'RT') === 'Group' ? 'group' : 'reply';
      }
      const state = text(PDFLib, dict, 'State');
      if (state) { attrs.state = state; attrs.statemodel = text(PDFLib, dict, 'StateModel') || 'Review'; }
      const fringe = numbers(PDFLib, dict, 'RD');
      if (fringe) attrs.fringe = fringe.map(n).join(',');
      let body = '';
      if (subtype === 'Text' || subtype === 'Stamp') {
        const icon = name(PDFLib, dict, 'Name');
        if (icon) attrs.icon = icon;
      }
      if (subtype === 'Line') {
        const line = numbers(PDFLib, dict, 'L');
        if (line) { attrs.start = `${n(line[0])},${n(line[1])}`; attrs.end = `${n(line[2])},${n(line[3])}`; }
        const endings = dict.lookup(PDFLib.PDFName.of('LE'));
        if (endings instanceof PDFLib.PDFArray) {
          const [head, tail] = endings.asArray().map(value => (value instanceof PDFLib.PDFName ? value.decodeText() : 'None'));
          attrs.head = head; attrs.tail = tail;
        }
        if (dict.lookup(PDFLib.PDFName.of('Cap')) === PDFLib.PDFBool.True) attrs.caption = 'yes';
      }
      if (subtype === 'Polygon' || subtype === 'PolyLine') {
        body += `<vertices>${pointsAttr(numbers(PDFLib, dict, 'Vertices') || [])}</vertices>`;
      }
      if (subtype === 'Ink') {
        const list = dict.lookup(PDFLib.PDFName.of('InkList'));
        const gestures = list instanceof PDFLib.PDFArray ? list.asArray().map(stroke => {
          const values = context.lookup(stroke);
          return values instanceof PDFLib.PDFArray ? values.asArray().map(value => context.lookup(value)).map(value => (value instanceof PDFLib.PDFNumber ? value.asNumber() : 0)) : [];
        }) : [];
        body += `<inklist>${gestures.map(values => `<gesture>${pointsAttr(values)}</gesture>`).join('')}</inklist>`;
      }
      if (['Highlight', 'Underline', 'Squiggly', 'StrikeOut', 'Redact'].includes(subtype)) {
        const quads = numbers(PDFLib, dict, 'QuadPoints');
        if (quads) attrs.coords = quads.map(n).join(',');
      }
      if (subtype === 'FreeText') {
        const callout = numbers(PDFLib, dict, 'CL');
        if (callout) attrs.callout = callout.map(n).join(',');
        const head = name(PDFLib, dict, 'LE');
        if (head) attrs.head = head;
        const da = text(PDFLib, dict, 'DA');
        if (da) body += `<defaultappearance>${escapeXml(da)}</defaultappearance>`;
      }
      body += measureXml(PDFLib, context, dict);
      const contents = text(PDFLib, dict, 'Contents');
      if (contents) body = `<contents>${escapeXml(contents)}</contents>${body}`;
      const attrText = Object.entries(attrs).map(([key, value]) => ` ${key}="${escapeXml(value)}"`).join('');
      parts.push(`<${tag}${attrText}>${body}</${tag}>`);
    }
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<xfdf xmlns="http://ns.adobe.com/xfdf/" xml:space="preserve">\n<annots>\n${parts.join('\n')}\n</annots>\n${fileName ? `<f href="${escapeXml(fileName)}"/>\n` : ''}</xfdf>\n`;
}

export async function exportXfdf(PDFLib, bytes, options = {}) {
  const document = await PDFLib.PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true });
  return exportXfdfFromDocument(PDFLib, document, options);
}

// ---------------------------------------------------------------------------------------------------------------
// Import

const SUBTYPE_FOR_ELEMENT = Object.fromEntries(Object.entries(ELEMENT_FOR_SUBTYPE).map(([subtype, tag]) => [tag, subtype]));
const numberList = value => String(value || '').split(/[\s,;]+/u).filter(Boolean).map(Number).filter(Number.isFinite);
const pointList = value => {
  const values = numberList(value);
  const points = [];
  for (let index = 0; index + 1 < values.length; index += 2) points.push({ x: values[index], y: values[index + 1] });
  return points;
};
const colorFromHex = value => (/^#?[0-9a-f]{6}$/iu.test(String(value || '')) ? colorComponents(String(value).replace(/^#?/u, '#')) : null);

function flagsFrom(value) {
  if (!value) return 4;
  return String(value).split(/[\s,]+/u).reduce((sum, label) => sum | (FLAG_NAMES.find(([, name2]) => name2 === label.toLowerCase())?.[0] || 0), 0);
}

function ellipseOps(rect, inset) {
  const [l, b, r, t] = [rect[0] + inset, rect[1] + inset, rect[2] - inset, rect[3] - inset];
  const cx = (l + r) / 2, cy = (b + t) / 2, rx = (r - l) / 2, ry = (t - b) / 2, k = 0.5522847498;
  return `${n(cx + rx)} ${n(cy)} m ${n(cx + rx)} ${n(cy + ry * k)} ${n(cx + rx * k)} ${n(cy + ry)} ${n(cx)} ${n(cy + ry)} c ` +
    `${n(cx - rx * k)} ${n(cy + ry)} ${n(cx - rx)} ${n(cy + ry * k)} ${n(cx - rx)} ${n(cy)} c ` +
    `${n(cx - rx)} ${n(cy - ry * k)} ${n(cx - rx * k)} ${n(cy - ry)} ${n(cx)} ${n(cy - ry)} c ` +
    `${n(cx + rx * k)} ${n(cy - ry)} ${n(cx + rx)} ${n(cy - ry * k)} ${n(cx + rx)} ${n(cy)} c h`;
}

/** An appearance { content, rect, resources? } for an imported annotation, or null to let the viewer draw it. */
function importedAppearance(subtype, node, dict, { rect, color, interior, width, contents, fontSize = 10 }) {
  const rgb = color || [0.88, 0.19, 0.19];
  const stroke = `${rgb.join(' ')} RG ${n(width)} w 1 J 1 j`;
  const fill = interior ? `${interior.join(' ')} rg` : '';
  if (!rect) return null;
  if (subtype === 'Square') {
    const inset = width / 2;
    return { content: `${stroke} ${fill} ${n(rect[0] + inset)} ${n(rect[1] + inset)} ${n(rect[2] - rect[0] - width)} ${n(rect[3] - rect[1] - width)} re ${interior ? 'B' : 'S'}`, rect };
  }
  if (subtype === 'Circle') return { content: `${stroke} ${fill} ${ellipseOps(rect, width / 2)} ${interior ? 'B' : 'S'}`, rect };
  if (subtype === 'Ink') {
    const gestures = (child(node, 'inklist')?.children || []).map(gesture => pointList(allText(gesture)));
    const path = gestures.filter(points => points.length).map(points => points.map((point, index) => `${n(point.x)} ${n(point.y)} ${index ? 'l' : 'm'}`).join(' ')).join(' ');
    return path ? { content: `${stroke} ${path} S`, rect } : null;
  }
  if (['Highlight', 'Underline', 'StrikeOut', 'Squiggly'].includes(subtype)) {
    const quads = numberList(node.attributes.coords);
    const ops = [];
    for (let index = 0; index + 7 < quads.length; index += 8) {
      const [x1, y1, x2, y2, x3, y3, x4, y4] = quads.slice(index, index + 8);
      if (subtype === 'Highlight') ops.push(`${n(x1)} ${n(y1)} m ${n(x2)} ${n(y2)} l ${n(x4)} ${n(y4)} l ${n(x3)} ${n(y3)} l h f`);
      else {
        const height = Math.abs(y1 - y3);
        const y = subtype === 'StrikeOut' ? (y1 + y3) / 2 : Math.min(y3, y4) + height * 0.08;
        ops.push(`${n(Math.min(x1, x3))} ${n(y)} m ${n(Math.max(x2, x4))} ${n(y)} l S`);
      }
    }
    if (!ops.length) return null;
    return subtype === 'Highlight'
      ? { content: `/GSm gs ${rgb.join(' ')} rg ${ops.join(' ')}`, rect, resources: { ExtGState: { GSm: { Type: 'ExtGState', BM: 'Multiply', ca: 1 } } } }
      : { content: `${rgb.join(' ')} RG ${n(Math.max(0.5, width))} w ${ops.join(' ')}`, rect };
  }
  if (subtype === 'Line') {
    const start = pointList(node.attributes.start)[0], end = pointList(node.attributes.end)[0];
    if (!start || !end) return null;
    if (child(node, 'measure')) {
      const appearance = measurementAppearance('distance', [start, end], contents || '', { color: hexFromRgb(rgb), width });
      return { content: appearance.content, rect: appearance.rect, resources: 'measure' };
    }
    return { content: `${stroke} ${n(start.x)} ${n(start.y)} m ${n(end.x)} ${n(end.y)} l S`, rect };
  }
  if (subtype === 'Polygon' || subtype === 'PolyLine') {
    const points = pointList(allText(child(node, 'vertices')));
    if (points.length < 2) return null;
    if (child(node, 'measure')) {
      const appearance = measurementAppearance(subtype === 'Polygon' ? 'area' : 'perimeter', points, contents || '', { color: hexFromRgb(rgb), width });
      return { content: appearance.content, rect: appearance.rect, resources: 'measure' };
    }
    const kind = subtype === 'PolyLine' ? 'polyline' : node.attributes.style === 'cloudy' ? 'cloud' : 'polygon';
    const appearance = shapeAppearance(kind, points, { color: hexFromRgb(rgb), width });
    return { content: appearance.content, rect: appearance.rect };
  }
  if (subtype === 'Stamp') {
    const label = String(node.attributes.icon || 'Stamp').replace(/^#/u, '').replace(/([a-z])([A-Z])/gu, '$1 $2').toUpperCase();
    const center = { x: (rect[0] + rect[2]) / 2, y: (rect[1] + rect[3]) / 2 };
    const probe = stampAppearance({ label, color: hexFromRgb(rgb), center });
    const scale = Math.min((rect[2] - rect[0]) / (probe.rect[2] - probe.rect[0]), (rect[3] - rect[1]) / (probe.rect[3] - probe.rect[1]), 4);
    const appearance = stampAppearance({ label, color: hexFromRgb(rgb), center, scale: scale > 0 ? scale : 1 });
    return { content: appearance.content, rect };
  }
  if (subtype === 'FreeText') {
    const fringe = numberList(node.attributes.fringe);
    const box = fringe.length === 4 ? [rect[0] + fringe[0], rect[1] + fringe[1], rect[2] - fringe[2], rect[3] - fringe[3]] : rect;
    const lines = wrapText(contents, Math.max(10, box[2] - box[0] - 6), fontSize);
    const ops = [];
    const callout = pointList(node.attributes.callout);
    if (callout.length >= 2) ops.push(`${stroke} ${callout.map((point, index) => `${n(point.x)} ${n(point.y)} ${index ? 'l' : 'm'}`).join(' ')} S`);
    if (color && node.attributes.intent !== 'FreeTextTypeWriter') ops.push(`${stroke} 1 1 1 rg ${n(box[0])} ${n(box[1])} ${n(box[2] - box[0])} ${n(box[3] - box[1])} re B`);
    ops.push('0 0 0 rg BT', `/Helv ${n(fontSize)} Tf`);
    lines.forEach((line, index) => ops.push(`1 0 0 1 ${n(box[0] + 3)} ${n(box[3] - 3 - fontSize * (index + 0.85) * 1.2 + fontSize * 0.2)} Tm ${hex(line)} Tj`));
    ops.push('ET');
    return { content: ops.join('\n'), rect };
  }
  return null; // Text (note) and others: viewers draw their standard icons
}

function hexFromRgb(rgb) {
  return `#${rgb.map(value => Math.round(value * 255).toString(16).padStart(2, '0')).join('')}`;
}

function measureFromXml(PDFLib, context, node) {
  const measure = child(node, 'measure');
  if (!measure) return null;
  const format = tag => {
    const entry = child(measure, tag);
    if (!entry) return null;
    const dict = context.obj({ Type: 'NumberFormat', C: Number(entry.attributes.c) || 1, D: Number(entry.attributes.d) || 100, F: entry.attributes.f || 'D' });
    dict.set(PDFLib.PDFName.of('U'), pdfText(PDFLib, entry.attributes.u || ''));
    return dict;
  };
  const dict = context.obj({ Type: 'Measure', Subtype: 'RL' });
  dict.set(PDFLib.PDFName.of('R'), pdfText(PDFLib, measure.attributes.rateValue || ''));
  for (const [tag, key] of [['axis', 'X'], ['distance', 'D'], ['area', 'A']]) {
    const entry = format(tag);
    if (entry) dict.set(PDFLib.PDFName.of(key), context.obj([entry]));
  }
  return dict.get(PDFLib.PDFName.of('X')) ? dict : null;
}

/**
 * Add the annotations of an XFDF document. Returns { bytes, added, skipped, objectNumbers, annotationIndexMaps, data }.
 * Names already in the document are skipped; replies (inreplyto) attach to their parents.
 */
export async function importXfdf(PDFLib, bytes, xfdfText, { now = new Date() } = {}) {
  const root = parseXml(xfdfText);
  const xfdf = child(root, 'xfdf');
  const annots = child(xfdf, 'annots');
  if (!xfdf || !annots) throw new Error('This file is not XFDF (no <xfdf><annots>).');
  const document = await loadForEdit(PDFLib, bytes);
  const context = document.context;
  const before = annotationRefs(PDFLib, document);
  const refByName = new Map();
  document.getPages().forEach(page => {
    for (const item of pageAnnots(PDFLib, page)?.asArray() || []) {
      const dict = context.lookup(item);
      if (item instanceof PDFLib.PDFRef && dict instanceof PDFLib.PDFDict) {
        const nm = text(PDFLib, dict, 'NM');
        if (nm) refByName.set(nm, item);
      }
    }
  });
  const pageCount = document.getPageCount();
  const created = [];
  let skipped = 0;
  const pendingReplies = [];
  for (const node of annots.children) {
    const subtype = SUBTYPE_FOR_ELEMENT[node.name];
    const pageIndex = Number(node.attributes.page);
    if (!subtype || !Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= pageCount) { skipped += 1; continue; }
    const nm = node.attributes.name || '';
    if (nm && refByName.has(nm)) { skipped += 1; continue; }
    const page = document.getPage(pageIndex);
    const rect = numberList(node.attributes.rect);
    // Replies without flags get Acrobat's (print, no zoom, no rotate); they show in their parent's thread.
    const flags = node.attributes.flags ? flagsFrom(node.attributes.flags) : node.attributes.inreplyto ? 28 : 4;
    const dict = context.obj({ Type: 'Annot', Subtype: subtype, F: flags, P: page.ref });
    if (rect.length === 4) dict.set(PDFLib.PDFName.of('Rect'), context.obj(rect));
    dict.set(PDFLib.PDFName.of('NM'), pdfText(PDFLib, nm || `bergwork-xfdf-${randomId()}`));
    for (const [attr, key] of [['title', 'T'], ['subject', 'Subj']]) {
      if (node.attributes[attr]) dict.set(PDFLib.PDFName.of(key), pdfText(PDFLib, node.attributes[attr]));
    }
    dict.set(PDFLib.PDFName.of('M'), PDFLib.PDFString.of(/^D:/u.test(node.attributes.date || '') ? node.attributes.date : pdfDate(now)));
    if (/^D:/u.test(node.attributes.creationdate || '')) dict.set(PDFLib.PDFName.of('CreationDate'), PDFLib.PDFString.of(node.attributes.creationdate));
    const contents = allText(child(node, 'contents'));
    if (contents) dict.set(PDFLib.PDFName.of('Contents'), pdfText(PDFLib, contents));
    const color = colorFromHex(node.attributes.color);
    if (color) dict.set(PDFLib.PDFName.of('C'), context.obj(color));
    const interior = colorFromHex(node.attributes['interior-color']);
    if (interior) dict.set(PDFLib.PDFName.of('IC'), context.obj(interior));
    if (node.attributes.opacity) dict.set(PDFLib.PDFName.of('CA'), PDFLib.PDFNumber.of(Number(node.attributes.opacity) || 1));
    const width = Number(node.attributes.width);
    const strokeWidth = Number.isFinite(width) && width >= 0 ? width : 1;
    if (Number.isFinite(width)) dict.set(PDFLib.PDFName.of('BS'), context.obj({ Type: 'Border', W: width, S: 'S' }));
    if (node.attributes.intent) dict.set(PDFLib.PDFName.of('IT'), PDFLib.PDFName.of(node.attributes.intent));
    if (node.attributes.style === 'cloudy') dict.set(PDFLib.PDFName.of('BE'), context.obj({ S: 'C', I: Number(node.attributes.intensity) || 1 }));
    if (node.attributes.fringe) dict.set(PDFLib.PDFName.of('RD'), context.obj(numberList(node.attributes.fringe)));
    if (node.attributes.icon) dict.set(PDFLib.PDFName.of('Name'), PDFLib.PDFName.of(node.attributes.icon));
    if (node.attributes.state) {
      dict.set(PDFLib.PDFName.of('State'), pdfText(PDFLib, node.attributes.state));
      dict.set(PDFLib.PDFName.of('StateModel'), pdfText(PDFLib, node.attributes.statemodel || 'Review'));
    }
    if (subtype === 'Line') {
      const start = pointList(node.attributes.start)[0], end = pointList(node.attributes.end)[0];
      if (start && end) dict.set(PDFLib.PDFName.of('L'), context.obj([start.x, start.y, end.x, end.y]));
      if (node.attributes.head || node.attributes.tail) {
        dict.set(PDFLib.PDFName.of('LE'), context.obj([node.attributes.head || 'None', node.attributes.tail || 'None']));
      }
      if (node.attributes.caption === 'yes') dict.set(PDFLib.PDFName.of('Cap'), PDFLib.PDFBool.True);
    }
    if (subtype === 'Polygon' || subtype === 'PolyLine') {
      dict.set(PDFLib.PDFName.of('Vertices'), context.obj(pointList(allText(child(node, 'vertices'))).flatMap(point => [point.x, point.y])));
    }
    if (subtype === 'Ink') {
      const gestures = (child(node, 'inklist')?.children || []).map(gesture => pointList(allText(gesture)).flatMap(point => [point.x, point.y]));
      dict.set(PDFLib.PDFName.of('InkList'), context.obj(gestures));
    }
    if (node.attributes.coords) dict.set(PDFLib.PDFName.of('QuadPoints'), context.obj(numberList(node.attributes.coords)));
    if (subtype === 'FreeText') {
      if (node.attributes.callout) dict.set(PDFLib.PDFName.of('CL'), context.obj(numberList(node.attributes.callout)));
      if (node.attributes.head) dict.set(PDFLib.PDFName.of('LE'), PDFLib.PDFName.of(node.attributes.head));
      const da = allText(child(node, 'defaultappearance')) || '0 0 0 rg /Helv 10 Tf';
      dict.set(PDFLib.PDFName.of('DA'), PDFLib.PDFString.of(da));
    }
    const measure = measureFromXml(PDFLib, context, node);
    if (measure) dict.set(PDFLib.PDFName.of('Measure'), measure);
    const fontSize = Number(/([\d.]+)\s+Tf/u.exec(allText(child(node, 'defaultappearance')))?.[1]) || 10;
    const appearance = node.attributes.inreplyto ? null
      : importedAppearance(subtype, node, dict, { rect: rect.length === 4 ? rect : null, color, interior, width: strokeWidth, contents, fontSize });
    if (appearance) {
      const resources = appearance.resources === 'measure' || !appearance.resources
        ? { Font: { Helv: { Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica', Encoding: 'WinAnsiEncoding' } },
          ExtGState: { GSbox: { Type: 'ExtGState', ca: 0.82 }, GSfill: { Type: 'ExtGState', ca: 0.14 } } }
        : appearance.resources;
      const stream = context.flateStream(appearance.content, { Type: 'XObject', Subtype: 'Form', BBox: appearance.rect, Matrix: [1, 0, 0, 1, 0, 0], Resources: resources });
      dict.set(PDFLib.PDFName.of('AP'), context.obj({ N: context.register(stream) }));
      dict.set(PDFLib.PDFName.of('Rect'), context.obj(appearance.rect));
    }
    const ref = context.register(dict);
    page.node.addAnnot(ref);
    refByName.set(text(PDFLib, dict, 'NM'), ref);
    if (node.attributes.inreplyto) pendingReplies.push({ dict, parent: node.attributes.inreplyto, replyType: node.attributes.replyType });
    created.push(ref.objectNumber);
  }
  for (const reply of pendingReplies) {
    const parent = refByName.get(reply.parent);
    if (parent) reply.dict.set(PDFLib.PDFName.of('IRT'), parent);
    if (!reply.dict.get(PDFLib.PDFName.of('State'))) reply.dict.set(PDFLib.PDFName.of('RT'), PDFLib.PDFName.of(reply.replyType === 'group' ? 'Group' : 'R'));
  }
  const after = annotationRefs(PDFLib, document);
  return {
    bytes: await saveEdited(PDFLib, document),
    added: created.length,
    skipped,
    objectNumbers: created,
    annotationIndexMaps: indexMaps(before, after),
    data: readPageMarkupFromDocument(PDFLib, document),
  };
}
