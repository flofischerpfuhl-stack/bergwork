// @ts-check

export function freeTextCapabilityProbeRequest(annotation, context = {}) {
  if (!annotation || annotation.imported !== true || annotation.sourceSubtype !== 'freetext' ||
      annotation.appearanceReconstructible !== false) return null;
  const objectNumber = Number(annotation.annotationObjectNumber);
  const annotationIndex = Number(annotation.annotationIndex);
  if (typeof annotation.id !== 'string' || !annotation.id ||
      typeof annotation.liveStableId !== 'string' || !annotation.liveStableId ||
      !Number.isSafeInteger(objectNumber) || objectNumber <= 0 ||
      !Number.isSafeInteger(annotationIndex) || annotationIndex < 0 ||
      typeof context.documentId !== 'string' || !context.documentId ||
      !Number.isSafeInteger(context.revision) || context.revision < 0 ||
      !Number.isSafeInteger(context.pageIndex) || context.pageIndex < 0 ||
      !Number.isSafeInteger(context.pageEpoch) || context.pageEpoch < 0) return null;
  return Object.freeze({
    documentId: context.documentId,
    annotationId: annotation.id,
    stableId: annotation.liveStableId,
    annotationIndex,
    annotationObjectNumber: objectNumber,
    pageIndex: context.pageIndex,
    pageEpoch: context.pageEpoch,
    revision: context.revision,
  });
}

export function pdfiumStandardFontPresentation(fontFamily) {
  const presentations = {
    0: { fontKey: 'courier', fontWeight: '400', fontStyle: 'normal' },
    1: { fontKey: 'courierBold', fontWeight: '700', fontStyle: 'normal' },
    2: { fontKey: 'courierBoldItalic', fontWeight: '700', fontStyle: 'italic' },
    3: { fontKey: 'courierItalic', fontWeight: '400', fontStyle: 'italic' },
    4: { fontKey: 'helvetica', fontWeight: '400', fontStyle: 'normal' },
    5: { fontKey: 'helveticaBold', fontWeight: '700', fontStyle: 'normal' },
    6: { fontKey: 'helveticaBoldItalic', fontWeight: '700', fontStyle: 'italic' },
    7: { fontKey: 'helveticaItalic', fontWeight: '400', fontStyle: 'italic' },
    8: { fontKey: 'times', fontWeight: '400', fontStyle: 'normal' },
    9: { fontKey: 'timesBold', fontWeight: '700', fontStyle: 'normal' },
    10: { fontKey: 'timesBoldItalic', fontWeight: '700', fontStyle: 'italic' },
    11: { fontKey: 'timesItalic', fontWeight: '400', fontStyle: 'italic' },
  };
  return presentations[Number(fontFamily)] || presentations[4];
}

export function applyFreeTextCapabilityProbe(annotation, request, result, context = {}) {
  if (!annotation || !request || !result ||
      context.documentId !== request.documentId || context.revision !== request.revision ||
      context.pageEpoch !== request.pageEpoch ||
      annotation.id !== request.annotationId || annotation.appearanceReconstructible !== false ||
      annotation.liveStableId !== request.stableId ||
      Number(annotation.annotationObjectNumber) !== request.annotationObjectNumber ||
      result.stableId !== request.stableId || result.pageIndex !== request.pageIndex ||
      result.pageEpoch !== request.pageEpoch || result.revision !== request.revision ||
      result.annotationObjectNumber !== request.annotationObjectNumber ||
      result.appearanceReconstructible !== true) return annotation;
  return {
    ...annotation,
    appearanceReconstructible: true,
    ...(Number.isSafeInteger(result.fontFamily)
      ? { fontFamily: result.fontFamily, ...pdfiumStandardFontPresentation(result.fontFamily) } : {}),
    ...(Number.isFinite(result.fontSize) && result.fontSize > 0 ? { fontSize: result.fontSize } : {}),
    ...(typeof result.fontColor === 'string' ? { color: result.fontColor } : {}),
    ...(typeof result.backgroundColor === 'string' ? { backgroundColor: result.backgroundColor } : {}),
    ...(typeof result.borderColor === 'string' ? { borderColor: result.borderColor } : {}),
    ...(Number.isFinite(result.borderWidth) ? { borderWidth: result.borderWidth } : {}),
    ...(Number.isFinite(result.opacity) ? { opacity: result.opacity } : {}),
    ...(typeof result.appearanceTextOverflow === 'boolean'
      ? { appearanceTextOverflow: result.appearanceTextOverflow } : {}),
  };
}
