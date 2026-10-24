// AcroForm fields as the page shows them. The widget geometry and labels come
// from the PDF.js annotation data of the source page; the values the user
// enters live in `doc.formValues` (field name -> string) and are written into
// the PDF on export. Pure functions only, so the mapping is unit-testable.

export const FORM_CHECKED = 'true';
export const FORM_UNCHECKED = 'false';

// "topmostSubform[0].Page1[0].f1_01[0]" is an XFA path, not a label.
export function readableFieldName(fieldName = '') {
  const last = String(fieldName || '').split('.').filter(Boolean).pop() || '';
  const plain = last
    .replace(/\[\d+\]/gu, '')
    .replace(/[_-]+/gu, ' ')
    .replace(/([a-z\d])([A-Z])/gu, '$1 $2')
    .replace(/\s+/gu, ' ')
    .trim();
  return plain ? plain[0].toUpperCase() + plain.slice(1) : '';
}

export function formFieldLabel(widget = {}) {
  const tooltip = String(widget.alternativeText || '').replace(/\s+/gu, ' ').trim();
  return tooltip || String(widget.nearbyLabel || '') || readableFieldName(widget.name) || 'Form field';
}

const LABEL_MAX_LENGTH = 80;

function cleanLabel(text) {
  const label = String(text || '').replace(/\s+/gu, ' ').replace(/[\s:._\u2026]+$/u, '').trim();
  if (label.length <= LABEL_MAX_LENGTH) return label;
  return `${label.slice(0, LABEL_MAX_LENGTH - 1).replace(/\s+\S*$/u, '').replace(/[\s.,;:\u2026]+$/u, '')}\u2026`;
}

// The printed caption of a field without a tooltip (/TU), read off the page:
// the text right of a check box, otherwise the closest text to the left on the
// same row or directly above. `textBoxes` are unrotated text items in the same
// unzoomed page pixels as the widget: { x, y, w, h, text }.
export function nearbyLabelForWidget(widget, textBoxes = []) {
  const boxes = textBoxes.filter(box => box && String(box.text || '').trim() && box.w > 0 && box.h > 0);
  const centerY = widget.y + widget.h / 2;
  const onRow = box => Math.abs((box.y + box.h / 2) - centerY) <= Math.max(widget.h, box.h) / 2;
  const joinRow = (start, direction) => {
    // Captions are often split into several text items; follow the row while
    // the gap stays a word space.
    const row = boxes.filter(box => Math.abs((box.y + box.h / 2) - (start.y + start.h / 2)) <= start.h / 2)
      .sort((left, right) => left.x - right.x);
    // Numbering ("2  Business name") sits a little further off than a word space.
    const wordGap = Math.max(start.h * 1.2, 12);
    const parts = [start];
    let edge = start;
    for (;;) {
      const next = direction < 0
        ? row.filter(box => box.x + box.w <= edge.x + 1 && edge.x - (box.x + box.w) < wordGap).at(-1)
        : row.find(box => box.x >= edge.x + edge.w - 1 && box.x - (edge.x + edge.w) < wordGap);
      if (!next || parts.includes(next)) break;
      if (direction < 0) parts.unshift(next); else parts.push(next);
      edge = next;
    }
    return cleanLabel(parts.map(part => part.text).join(' '));
  };
  if (widget.kind === 'checkbox' || widget.kind === 'radio') {
    const right = boxes
      .filter(box => onRow(box) && box.x >= widget.x + widget.w - 2 && box.x - (widget.x + widget.w) < Math.max(40, widget.w * 4))
      .sort((left, right) => left.x - right.x)[0];
    if (right) return joinRow(right, 1);
  }
  const left = boxes
    .filter(box => onRow(box) && box.x + box.w <= widget.x + 2 && widget.x - (box.x + box.w) < 220)
    .sort((a, b) => (b.x + b.w) - (a.x + a.w))[0];
  const above = boxes
    .filter(box => box.y + box.h <= widget.y + widget.h * 0.5 && widget.y - (box.y + box.h) < 16 &&
      box.x < widget.x + widget.w && box.x + box.w > widget.x - 4)
    .sort((a, b) => (b.y + b.h) - (a.y + a.h) || a.x - b.x)[0];
  const rowStart = line => boxes
    .filter(box => Math.abs((box.y + box.h / 2) - (line.y + line.h / 2)) <= line.h / 2 &&
      box.x + box.w > widget.x - 4 && box.x < widget.x + widget.w)
    .sort((a, b) => a.x - b.x)[0] || line;
  // A caption above may run over several lines; read it from its first line.
  const aboveCaption = () => {
    if (!above) return '';
    const lines = [above];
    while (lines.length < 2) {
      const current = lines[0];
      const previous = boxes
        .filter(box => box.y + box.h <= current.y + current.h * 0.3 && current.y - (box.y + box.h) < current.h * 1.2 &&
          box.x < current.x + current.w && box.x + box.w > current.x - 4 && !lines.includes(box))
        .sort((a, b) => (b.y + b.h) - (a.y + a.h) || a.x - b.x)[0];
      // Text that starts well left of the field belongs to a neighbouring cell.
      if (!previous || rowStart(previous).x < widget.x - 24) break;
      lines.unshift(previous);
    }
    return cleanLabel(lines.map(line => joinRow(rowStart(line), 1)).join(' '));
  };
  // "2", "–" or "(" next to a field is numbering or decoration, not a caption.
  const meaningful = label => /\p{L}{3,}/u.test(label);
  const leftGap = left ? widget.x - (left.x + left.w) : Infinity;
  const aboveGap = above ? Math.max(0, widget.y - (above.y + above.h)) : Infinity;
  const leftLabel = left ? joinRow(left, -1) : '';
  const aboveLabel = aboveCaption();
  if (meaningful(leftLabel) && (leftGap <= aboveGap + 6 || !meaningful(aboveLabel))) return leftLabel;
  return meaningful(aboveLabel) ? aboveLabel : '';
}

function widgetKind(annotation) {
  const type = String(annotation.fieldType || '');
  if (type === 'Tx') return 'text';
  if (type === 'Ch') return 'choice';
  if (type === 'Btn') {
    if (annotation.checkBox) return 'checkbox';
    if (annotation.radioButton) return 'radio';
  }
  return '';
}

function sourceValue(annotation, kind) {
  const raw = annotation.fieldValue;
  if (kind === 'checkbox') {
    const on = String(annotation.exportValue ?? '');
    return raw != null && String(raw) !== 'Off' && (on ? String(raw) === on : Boolean(raw))
      ? FORM_CHECKED
      : FORM_UNCHECKED;
  }
  if (kind === 'radio') return raw == null || String(raw) === 'Off' ? '' : String(raw);
  if (Array.isArray(raw)) return raw.length ? String(raw[0] ?? '') : '';
  return raw == null ? '' : String(raw);
}

// One fillable widget from a PDF.js annotation, or null for everything the
// editor does not fill (signature fields, push buttons, hidden or read-only
// widgets). `toViewportRect` maps a PDF rect into unzoomed page pixels.
export function formWidgetFromAnnotation(annotation, toViewportRect, keyPrefix = '') {
  if (!annotation || String(annotation.subtype || '').toLowerCase() !== 'widget') return null;
  const kind = widgetKind(annotation);
  const name = String(annotation.fieldName || '');
  if (!kind || !name || annotation.hidden || annotation.readOnly) return null;
  if (!Array.isArray(annotation.rect) || annotation.rect.length !== 4) return null;
  const rect = toViewportRect(annotation.rect);
  const box = {
    x: Math.min(rect[0], rect[2]),
    y: Math.min(rect[1], rect[3]),
    w: Math.abs(rect[2] - rect[0]),
    h: Math.abs(rect[3] - rect[1]),
  };
  if (!(box.w > 1) || !(box.h > 1)) return null;
  const declaredSize = Number(annotation.defaultAppearanceData?.fontSize || 0);
  const options = kind === 'choice'
    ? (annotation.options || []).map(option => ({
        value: String(option?.exportValue ?? option?.displayValue ?? ''),
        label: String(option?.displayValue ?? option?.exportValue ?? ''),
      }))
    : [];
  return {
    key: `${keyPrefix}${annotation.id || name}`,
    name,
    kind,
    annotationId: String(annotation.id || ''),
    required: annotation.required === true,
    ...box,
    alternativeText: String(annotation.alternativeText || ''),
    sourceValue: sourceValue(annotation, kind),
    onValue: kind === 'checkbox' || kind === 'radio'
      ? String((kind === 'radio' ? annotation.buttonValue : annotation.exportValue) ?? '')
      : '',
    options,
    listBox: kind === 'choice' && annotation.combo !== true,
    multiLine: kind === 'text' && annotation.multiLine === true,
    password: kind === 'text' && annotation.password === true,
    maxLength: kind === 'text' && Number(annotation.maxLen) > 0 ? Number(annotation.maxLen) : 0,
    comb: kind === 'text' && annotation.comb === true && Number(annotation.maxLen) > 0,
    align: ['left', 'center', 'right'][Number(annotation.textAlignment) || 0] || 'left',
    fontSize: declaredSize > 0 ? declaredSize : 0,
  };
}

// A field widget the Forms panel lists without an input, so the field count
// matches the PDF and nothing is silently hidden: push buttons (often image
// fields), signature fields, read-only and hidden fields. Call it for widgets
// that formWidgetFromAnnotation() rejected; returns null for non-widgets.
export function nonFillableFormField(annotation) {
  if (!annotation || String(annotation.subtype || '').toLowerCase() !== 'widget') return null;
  const name = String(annotation.fieldName || '');
  if (!name) return null;
  const type = String(annotation.fieldType || '');
  const reason = type === 'Sig' ? 'signature'
    : type === 'Btn' && !widgetKind(annotation) ? 'button'
      : annotation.readOnly ? 'read-only'
        : annotation.hidden ? 'hidden'
          : 'unsupported';
  return { name, reason, alternativeText: String(annotation.alternativeText || '') };
}

const NON_FILLABLE_DESCRIPTIONS = {
  button: 'Button \u2013 not fillable here',
  signature: 'Signature field \u2013 sign it in the Sign panel',
  'read-only': 'Read-only field',
  hidden: 'Hidden field \u2013 not fillable here',
  unsupported: 'Not fillable here',
};

export function nonFillableFormFieldDescription(reason) {
  return NON_FILLABLE_DESCRIPTIONS[reason] || NON_FILLABLE_DESCRIPTIONS.unsupported;
}

// Text size in unzoomed page pixels. An "auto" size (0) follows the field
// height like PDF viewers do, within readable bounds.
export function formWidgetFontSize(widget) {
  if (widget.fontSize > 0) return widget.fontSize;
  if (widget.multiLine) return 10;
  return Math.max(6, Math.min(12, widget.h * 0.68));
}

export function normalizeFormValues(values) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) return {};
  return Object.fromEntries(Object.entries(values)
    .filter(([name, value]) => name && typeof value === 'string'));
}

export function formValueFor(formValues, widget) {
  const entered = formValues?.[widget.name];
  return typeof entered === 'string' ? entered : widget.sourceValue;
}

// The value map after the user changed one widget. Entering the source value
// again removes the entry, so an untouched-looking form is not "unsaved".
export function formValuesWithChange(formValues, widget, value) {
  const next = { ...normalizeFormValues(formValues) };
  const normalized = String(value ?? '');
  if (normalized === widget.sourceValue) delete next[widget.name];
  else next[widget.name] = normalized;
  return next;
}

export function hasFormValueChanges(doc) {
  return Object.keys(normalizeFormValues(doc?.formValues)).length > 0;
}

// Values entered while the document's editing session is still opening wait
// in an ordered queue on the document (`doc.pendingFormValues`) and are applied
// in that order once the session is ready. Entering a field again moves it to
// the end with its latest value, so the last value per field wins.
export function normalizeFormValueQueue(queue) {
  return Array.isArray(queue)
    ? queue.filter(entry => entry && typeof entry.name === 'string' && entry.name && typeof entry.value === 'string')
    : [];
}

export function queueFormValue(queue, widget, value) {
  const name = String(widget?.name || '');
  const entries = normalizeFormValueQueue(queue);
  if (!name) return entries;
  return [
    ...entries.filter(entry => entry.name !== name),
    { name, sourceValue: String(widget.sourceValue ?? ''), value: String(value ?? '') },
  ];
}

// The value map with the queue applied, for display and for the final commit.
export function formValuesWithQueue(formValues, queue) {
  return normalizeFormValueQueue(queue)
    .reduce((values, entry) => formValuesWithChange(values, entry, entry.value), normalizeFormValues(formValues));
}

// Reading order for Tab: top to bottom in rows, then left to right.
export function sortWidgetsForTabOrder(widgets) {
  return [...widgets].sort((left, right) => {
    const sameRow = Math.abs(left.y - right.y) < Math.min(left.h, right.h) * 0.6;
    return sameRow ? left.x - right.x : left.y - right.y;
  });
}
