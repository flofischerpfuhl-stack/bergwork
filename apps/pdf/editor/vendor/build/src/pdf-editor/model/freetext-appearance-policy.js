const close = (left, right, tolerance = 0.0001) =>
  Number.isFinite(Number(left)) && Number.isFinite(Number(right)) &&
  Math.abs(Number(left) - Number(right)) <= tolerance;

const CUSTOM_REPLACEMENT_FONTS = Object.freeze([
  'Courier','Courier-Bold','Courier-BoldOblique','Courier-Oblique',
  'Helvetica','Helvetica-Bold','Helvetica-BoldOblique','Helvetica-Oblique',
  'Times-Roman','Times-Bold','Times-BoldItalic','Times-Italic',
]);
const CUSTOM_REPLACEMENT_FONT_INDEX = new Map(CUSTOM_REPLACEMENT_FONTS.map((name,index)=>[name,index]));
const color = value => value === 'transparent' || /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/iu.test(String(value || ''));

export function validateCustomFreeTextAppearanceReplacement(edit = {}) {
  if (edit.replaceCustomAppearance !== true) return null;
  const fontName=String(edit.replacementFontName || '');
  const fontFamily=Number(edit.fontFamily);
  const bounds=edit.bounds;
  if (String(edit.subtypeName || '').toLowerCase() !== 'freetext' ||
      typeof edit.contents !== 'string' || edit.contents.length<1 || edit.contents.length>10000 ||
      !bounds || !['left','bottom','right','top'].every(key=>Number.isFinite(Number(bounds[key]))) ||
      Number(bounds.right)<=Number(bounds.left) || Number(bounds.top)<=Number(bounds.bottom) ||
      CUSTOM_REPLACEMENT_FONT_INDEX.get(fontName)!==fontFamily ||
      !Number.isFinite(Number(edit.fontSize)) || Number(edit.fontSize)<=0 || Number(edit.fontSize)>10000 ||
      !/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/iu.test(String(edit.fontColor || '')) ||
      !color(edit.backgroundColor) || !color(edit.borderColor) ||
      !Number.isFinite(Number(edit.borderWidth)) || Number(edit.borderWidth)<0 || Number(edit.borderWidth)>10000 ||
      !Number.isFinite(Number(edit.opacity)) || Number(edit.opacity)<0 || Number(edit.opacity)>1) {
    throw new TypeError('Explicit custom FreeText replacement requires complete bounds, text, opacity, colors, border, and one named Base14 face.');
  }
  return Object.freeze({fontName,fontFamily});
}

export function annotationRotationPayload(angle, { gestureReason = '', previousAngle, inverse = false } = {}) {
  if (gestureReason === 'annotation-drop' || !Number.isFinite(angle)) return Object.freeze({});
  // An annotation that was never turned has no angle of its own: its Undo turns it back to 0.
  const before = Number.isFinite(previousAngle) ? Number(previousAngle) : 0;
  if (inverse && Math.abs(Number(angle) - before) <= 0.000001) return Object.freeze({});
  const selectedAngle = inverse ? before : Number(angle);
  return Object.freeze({ rotation: selectedAngle * 180 / Math.PI });
}

export function classifyFreeTextAppearanceMutation({
  existing = true,
  previousBounds = null,
  nextBounds = null,
  contentsChanged = false,
  styleChanged = false,
  opacityChanged = false,
  rotationChanged = false,
  simpleReconstructibleAppearance = false,
} = {}) {
  if (!existing) return Object.freeze({ action: 'regenerate', reason: 'insert' });
  const hasBounds = previousBounds && nextBounds;
  const boundsChanged = Boolean(hasBounds) && ['left', 'bottom', 'right', 'top']
    .some(key => !close(previousBounds[key], nextBounds[key]));
  const sizeChanged = Boolean(hasBounds) && (
    !close(previousBounds.right - previousBounds.left, nextBounds.right - nextBounds.left) ||
    !close(previousBounds.top - previousBounds.bottom, nextBounds.top - nextBounds.bottom)
  );
  // `/CA` alone does not affect an existing explicit appearance stream in
  // PDFium or external readers. Opacity therefore needs the same proven AP
  // regeneration capability as text/style/size instead of being labelled as
  // a lossless metadata-only edit.
  const needsVisualRebuild = contentsChanged || styleChanged || rotationChanged || sizeChanged;
  if (opacityChanged && !needsVisualRebuild && !simpleReconstructibleAppearance) {
    return Object.freeze({ action: 'preserve-opacity', reason: 'opaque-appearance-wrapper' });
  }
  const needsRegeneration = needsVisualRebuild || opacityChanged;
  if (needsRegeneration && !simpleReconstructibleAppearance) {
    return Object.freeze({ action: 'reject', reason: 'complex-appearance' });
  }
  if (needsRegeneration) return Object.freeze({ action: 'regenerate', reason: 'simple-appearance' });
  if (boundsChanged) return Object.freeze({ action: 'preserve', reason: 'translation' });
  return Object.freeze({ action: 'preserve', reason: 'no-appearance-change' });
}
