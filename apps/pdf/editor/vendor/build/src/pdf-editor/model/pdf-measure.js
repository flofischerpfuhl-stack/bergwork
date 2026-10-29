// berg:work: measuring with a drawing scale (distance, perimeter, area), as PDF measurement annotations.
//
// Pure geometry and number handling, no PDF objects: the PDF side lives in engine/measure-annotations.js.
// Points are PDF user space (pt, y up). A scale says how many real-world units one pt on the page stands for,
// which is exactly the conversion factor C of the first /X number format of a PDF /Measure dictionary
// (ISO 32000-2, 12.10.2). Values: distance = pt · factor, area = pt² · areaFactor.

export const MEASURE_KINDS = Object.freeze(['distance', 'perimeter', 'area']);

export const MEASURE_UNITS = Object.freeze({
  mm: { id: 'mm', label: 'mm', meters: 0.001, precision: 0, area: 'mm²', pdfArea: 'sq mm' },
  cm: { id: 'cm', label: 'cm', meters: 0.01, precision: 1, area: 'cm²', pdfArea: 'sq cm' },
  m: { id: 'm', label: 'm', meters: 1, precision: 2, area: 'm²', pdfArea: 'sq m' },
  km: { id: 'km', label: 'km', meters: 1000, precision: 3, area: 'km²', pdfArea: 'sq km' },
  in: { id: 'in', label: 'in', meters: 0.0254, precision: 2, area: 'in²', pdfArea: 'sq in' },
  ft: { id: 'ft', label: 'ft', meters: 0.3048, precision: 2, area: 'ft²', pdfArea: 'sq ft' },
});
export const MEASURE_UNIT_IDS = Object.freeze(['m', 'cm', 'mm', 'km', 'ft', 'in']);

// One pt on paper, in metres (1/72 in).
export const PT_IN_METERS = 0.0254 / 72;

export const MEASURE_LABELS = Object.freeze({ distance: 'Distance', perimeter: 'Perimeter', area: 'Area' });
export const MEASURE_SUBJECTS = Object.freeze({
  distance: 'Distance Measurement', perimeter: 'Perimeter Measurement', area: 'Area Measurement',
});
export const MEASURE_INTENTS = Object.freeze({
  distance: 'LineDimension', perimeter: 'PolyLineDimension', area: 'PolygonDimension',
});
export const MEASURE_SUBTYPES = Object.freeze({ distance: 'Line', perimeter: 'PolyLine', area: 'Polygon' });

const finite = value => Number.isFinite(Number(value));

/** Map a unit label written by any program ("m", "Meter", "sq m", "m²", "ft", "'") to one of ours, or ''. */
export function normalizeUnitId(label = '') {
  const text = String(label || '').trim().toLowerCase()
    .replace(/^sq\.?\s*/u, '').replace(/[²2]$/u, '').replace(/\s+/gu, ' ').trim();
  if (['m', 'meter', 'metre', 'meters', 'metres', 'mtr'].includes(text)) return 'm';
  if (['cm', 'centimeter', 'centimetre', 'centimeters'].includes(text)) return 'cm';
  if (['mm', 'millimeter', 'millimetre', 'millimeters'].includes(text)) return 'mm';
  if (['km', 'kilometer', 'kilometre'].includes(text)) return 'km';
  if (['in', 'inch', 'inches', '"'].includes(text)) return 'in';
  if (['ft', 'foot', 'feet', "'"].includes(text)) return 'ft';
  return '';
}

/** Paper scale 1:ratio in a unit: one pt on paper stands for ratio pt in reality. */
export function scaleFromRatio(ratio, unitId = 'm') {
  const unit = MEASURE_UNITS[unitId] || MEASURE_UNITS.m;
  const value = Number(ratio);
  if (!(value > 0) || !Number.isFinite(value)) throw new Error('The scale ratio must be a positive number.');
  const factor = value * PT_IN_METERS / unit.meters;
  return makeScale({ unit: unit.id, factor, source: 'ratio' });
}

/** Two clicked points (pt apart) and the real length between them. */
export function scaleFromCalibration(lengthPt, realLength, unitId = 'm') {
  const pt = Number(lengthPt);
  const real = Number(realLength);
  if (!(pt > 0.5)) throw new Error('Pick two points that are further apart.');
  if (!(real > 0) || !Number.isFinite(real)) throw new Error('Enter the real length as a positive number.');
  const unit = MEASURE_UNITS[unitId] || MEASURE_UNITS.m;
  return makeScale({ unit: unit.id, factor: real / pt, source: 'calibrated' });
}

/** The scale when the page has none: 1:1, in millimetres on paper. */
export function defaultScale() {
  return makeScale({ unit: 'mm', factor: PT_IN_METERS / MEASURE_UNITS.mm.meters, source: 'default' });
}

/**
 * Normalised scale: { unit, unitLabel, areaLabel, factor, areaFactor, ratio, label, precision, source }.
 * `ratio` is the paper ratio (1:ratio) when the unit is a length unit; `label` is what /R says.
 */
export function makeScale({ unit = 'm', unitLabel = '', areaLabel = '', factor, areaFactor, label = '', precision,
  source = 'pdf' } = {}) {
  const value = Number(factor);
  if (!(value > 0) || !Number.isFinite(value)) throw new Error('A scale needs a positive conversion factor.');
  const known = MEASURE_UNITS[normalizeUnitId(unit) || unit] || null;
  const area = Number(areaFactor);
  const ratio = known ? value * known.meters / PT_IN_METERS : null;
  return Object.freeze({
    unit: known ? known.id : String(unitLabel || unit || ''),
    unitLabel: unitLabel || (known ? known.label : String(unit || '')),
    areaLabel: areaLabel || (known ? known.area : `${unitLabel || unit}²`),
    factor: value,
    areaFactor: area > 0 && Number.isFinite(area) ? area : value * value,
    ratio,
    label: label || (ratio ? ratioLabel(ratio) : ''),
    precision: Number.isInteger(precision) && precision >= 0 && precision <= 6 ? precision : (known ? known.precision : 2),
    source,
  });
}

/** "1:500", "1:333.3", "2:1" for scales larger than life. */
export function ratioLabel(ratio) {
  const value = Number(ratio);
  if (!(value > 0)) return '';
  if (value < 1) {
    const up = 1 / value;
    return `${roundForLabel(up)}:1`;
  }
  return `1:${roundForLabel(value)}`;
}

function roundForLabel(value) {
  // Snap to a whole number when it is within 0.2 %, as calibrations by hand land close to the printed ratio.
  const whole = Math.round(value);
  if (whole > 0 && Math.abs(value - whole) / value < 0.002) return String(whole);
  return String(Number(value.toPrecision(4)));
}

/** Read a /Measure dictionary that was converted to plain values (see engine/measure-annotations.js). */
export function scaleFromMeasureDict(measure) {
  if (!measure || String(measure.Subtype || 'RL') !== 'RL') return null;
  const x = Array.isArray(measure.X) ? measure.X : [];
  const d = Array.isArray(measure.D) && measure.D.length ? measure.D : null;
  const a = Array.isArray(measure.A) && measure.A.length ? measure.A : null;
  const x0 = x[0];
  if (!x0 || !(Number(x0.C) > 0)) return null;
  // Chained number formats (ft, then in) convert further; the first entry is the one shown.
  const xFactor = Number(x0.C);
  const dFactor = d && Number(d[0].C) > 0 ? Number(d[0].C) : 1;
  const unitText = String((d ? d[0].U : '') || x0.U || '');
  const unit = normalizeUnitId(unitText) || unitText;
  const aFactor = a && Number(a[0].C) > 0 ? Number(a[0].C) : 1;
  const areaText = a ? String(a[0].U || '') : '';
  const known = MEASURE_UNITS[unit];
  const areaUnit = normalizeUnitId(areaText);
  const precisionFrom = format => {
    const denominator = Number(format?.D);
    return String(format?.F || 'D') === 'D' && denominator >= 1 ? Math.round(Math.log10(denominator)) : undefined;
  };
  return makeScale({
    unit,
    unitLabel: known ? known.label : unitText,
    areaLabel: areaUnit && MEASURE_UNITS[areaUnit] ? MEASURE_UNITS[areaUnit].area : (areaText || ''),
    factor: xFactor * dFactor,
    areaFactor: xFactor * xFactor * aFactor,
    label: String(measure.R || ''),
    precision: precisionFrom(d ? d[0] : x0),
    source: 'pdf',
  });
}

/** Plain values for a /Measure dictionary of this scale (Subtype RL). */
export function measureDictValues(scale) {
  const unit = MEASURE_UNITS[scale.unit];
  const denominator = 10 ** Math.max(0, Math.min(6, scale.precision ?? 2));
  const numberFormat = (label, conversion) => ({ Type: 'NumberFormat', U: label, C: conversion, D: denominator, F: 'D', SS: '' });
  const areaLabel = unit ? unit.pdfArea : `sq ${scale.unitLabel}`;
  return {
    Type: 'Measure',
    Subtype: 'RL',
    R: scale.label || (scale.ratio ? ratioLabel(scale.ratio) : ''),
    X: [numberFormat(unit ? unit.label : scale.unitLabel, scale.factor)],
    Y: [numberFormat(unit ? unit.label : scale.unitLabel, scale.factor)],
    D: [numberFormat(unit ? unit.label : scale.unitLabel, 1)],
    A: [numberFormat(areaLabel, scale.areaFactor / (scale.factor * scale.factor))],
    T: [numberFormat('°', 1)],
    O: [{ Type: 'NumberFormat', U: '', C: 1 }],
  };
}

export function distance(a, b) {
  return Math.hypot(Number(b.x) - Number(a.x), Number(b.y) - Number(a.y));
}

export function polylineLength(points = [], closed = false) {
  let total = 0;
  for (let index = 1; index < points.length; index += 1) total += distance(points[index - 1], points[index]);
  if (closed && points.length > 2) total += distance(points[points.length - 1], points[0]);
  return total;
}

/** Shoelace area, always positive. */
export function polygonArea(points = []) {
  if (points.length < 3) return 0;
  let sum = 0;
  for (let index = 0; index < points.length; index += 1) {
    const a = points[index];
    const b = points[(index + 1) % points.length];
    sum += Number(a.x) * Number(b.y) - Number(b.x) * Number(a.y);
  }
  return Math.abs(sum) / 2;
}

/** Area centroid; the vertex average for degenerate polygons. */
export function polygonCentroid(points = []) {
  const average = {
    x: points.reduce((sum, point) => sum + Number(point.x), 0) / Math.max(1, points.length),
    y: points.reduce((sum, point) => sum + Number(point.y), 0) / Math.max(1, points.length),
  };
  if (points.length < 3) return average;
  let cross = 0, cx = 0, cy = 0;
  for (let index = 0; index < points.length; index += 1) {
    const a = points[index];
    const b = points[(index + 1) % points.length];
    const f = a.x * b.y - b.x * a.y;
    cross += f;
    cx += (a.x + b.x) * f;
    cy += (a.y + b.y) * f;
  }
  if (Math.abs(cross) < 1e-9) return average;
  return { x: cx / (3 * cross), y: cy / (3 * cross) };
}

/** Raw value of a measurement in pt (distance, perimeter) or pt² (area). */
export function measureRawValue(kind, points = []) {
  if (kind === 'distance') return points.length >= 2 ? distance(points[0], points[points.length - 1]) : 0;
  if (kind === 'perimeter') return polylineLength(points, false);
  if (kind === 'area') return polygonArea(points);
  return 0;
}

/** { value, unitLabel, perimeter? } in real-world units. */
export function measureValue(kind, points, scale) {
  const raw = measureRawValue(kind, points);
  if (kind === 'area') {
    return { value: raw * scale.areaFactor, unitLabel: scale.areaLabel,
      perimeter: polylineLength(points, true) * scale.factor };
  }
  return { value: raw * scale.factor, unitLabel: scale.unitLabel };
}

export function formatNumber(value, precision = 2, locale = undefined) {
  const digits = Math.max(0, Math.min(6, Number.isInteger(precision) ? precision : 2));
  try {
    return new Intl.NumberFormat(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
  } catch {
    return Number(value).toFixed(digits);
  }
}

/** The caption written into the annotation and shown at the pointer: "12.35 m", "48.20 m²". */
export function formatMeasure(kind, points, scale, locale = undefined) {
  const { value, unitLabel } = measureValue(kind, points, scale);
  return `${formatNumber(value, scale.precision, locale)} ${unitLabel}`.trim();
}

/** Contents of the annotation: the value, for an area also the perimeter, and the scale. */
export function measureContents(kind, points, scale, locale = undefined) {
  const measured = measureValue(kind, points, scale);
  const main = `${formatNumber(measured.value, scale.precision, locale)} ${measured.unitLabel}`.trim();
  const perimeter = kind === 'area'
    ? ` · perimeter ${formatNumber(measured.perimeter, scale.precision, locale)} ${scale.unitLabel}` : '';
  return `${main}${perimeter}${scale.label ? ` (${scale.label})` : ''}`;
}

/** Constrain `point` to the nearest multiple of 45° around `anchor` (Shift while drawing). */
export function constrainTo45(anchor, point) {
  const dx = Number(point.x) - Number(anchor.x);
  const dy = Number(point.y) - Number(anchor.y);
  const length = Math.hypot(dx, dy);
  if (!length) return { x: anchor.x, y: anchor.y };
  const step = Math.PI / 4;
  const angle = Math.round(Math.atan2(dy, dx) / step) * step;
  // Project onto the snapped direction, so the pointer's distance along it is kept.
  const along = dx * Math.cos(angle) + dy * Math.sin(angle);
  return { x: anchor.x + Math.cos(angle) * along, y: anchor.y + Math.sin(angle) * along };
}

/** The nearest candidate within `threshold` (same space as the points), or null. */
export function nearestPoint(point, candidates = [], threshold = 6) {
  let best = null;
  let bestDistance = threshold;
  for (const candidate of candidates) {
    if (!candidate || !finite(candidate.x) || !finite(candidate.y)) continue;
    const d = Math.hypot(candidate.x - point.x, candidate.y - point.y);
    if (d <= bestDistance) {
      best = candidate;
      bestDistance = d;
    }
  }
  return best;
}

/**
 * Corner and end points of PDF path objects from a page inspection (object.path.sampledSegments with the
 * object's pageMatrix), in PDF user space. Bézier control points are skipped; only segment ends count.
 */
export function pathVerticesFromObjects(objects = [], limit = 20000) {
  const points = [];
  for (const object of objects) {
    if (String(object?.typeName || '').toLowerCase() !== 'path') continue;
    const segments = object?.path?.sampledSegments;
    if (!Array.isArray(segments) || !segments.length) continue;
    const m = object.pageMatrix || object.matrix || { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
    const a = Number(m.a ?? 1), b = Number(m.b ?? 0), c = Number(m.c ?? 0), d = Number(m.d ?? 1);
    const e = Number(m.e ?? 0), f = Number(m.f ?? 0);
    let bezierRun = 0;
    for (const segment of segments) {
      const point = segment?.point;
      if (!point || !finite(point.x) || !finite(point.y)) continue;
      // FPDF_SEGMENT_LINETO 0, BEZIERTO 1, MOVETO 2: a Bézier is three BEZIERTO entries, the last is its end.
      if (Number(segment.type) === 1) {
        bezierRun += 1;
        if (bezierRun % 3 !== 0) continue;
      } else {
        bezierRun = 0;
      }
      points.push({ x: a * point.x + c * point.y + e, y: b * point.x + d * point.y + f });
      if (points.length >= limit) return points;
    }
  }
  return points;
}

/** The viewport (from the page's /VP) that holds `point`: the last one in the array that contains it. */
export function viewportForPoint(viewports = [], point) {
  for (let index = viewports.length - 1; index >= 0; index -= 1) {
    const viewport = viewports[index];
    const box = viewport?.bbox;
    if (!box || !point) continue;
    const left = Math.min(box[0], box[2]), right = Math.max(box[0], box[2]);
    const bottom = Math.min(box[1], box[3]), top = Math.max(box[1], box[3]);
    if (point.x >= left - 0.01 && point.x <= right + 0.01 && point.y >= bottom - 0.01 && point.y <= top + 0.01) {
      return viewport;
    }
  }
  return null;
}

/** The scale for a new measurement at `point`: the page viewport's, else the fallback. */
export function scaleForPoint(viewports = [], point, fallback = null) {
  const viewport = viewportForPoint(viewports, point);
  return viewport?.scale || fallback || defaultScale();
}

function csvCell(value, separator) {
  const text = value == null ? '' : String(value);
  return /["\n\r]/u.test(text) || text.includes(separator) ? `"${text.replace(/"/gu, '""')}"` : text;
}

/**
 * CSV of all measurements. Where the locale writes decimal commas the separator is ";" (as spreadsheets in those
 * locales expect); numbers carry the locale's decimal mark and no grouping.
 */
export function measurementsToCsv(items = [], { locale = undefined, pageLabel = item => item.pageNumber } = {}) {
  let decimal = '.';
  try {
    decimal = new Intl.NumberFormat(locale).formatToParts(1.5).find(part => part.type === 'decimal')?.value || '.';
  } catch { /* default */ }
  const separator = decimal === ',' ? ';' : ',';
  const number = (value, digits) => Number.isFinite(value)
    ? Number(value).toFixed(Math.max(0, Math.min(6, digits))).replace('.', decimal) : '';
  const header = ['Page', 'Type', 'Value', 'Unit', 'Perimeter', 'Perimeter unit', 'Scale', 'Points', 'Author',
    'Modified', 'Label'];
  const rows = items.map(item => {
    const digits = item.scale?.precision ?? 2;
    return [
      pageLabel(item),
      MEASURE_LABELS[item.kind] || item.kind,
      number(item.value, digits),
      item.unitLabel || '',
      item.kind === 'area' ? number(item.perimeter, digits) : '',
      item.kind === 'area' ? item.scale?.unitLabel || '' : '',
      item.scale?.label || '',
      item.points?.length || 0,
      item.author || '',
      item.modified || '',
      item.contents || '',
    ];
  });
  return [header, ...rows].map(row => row.map(cell => csvCell(cell, separator)).join(separator)).join('\r\n') + '\r\n';
}
