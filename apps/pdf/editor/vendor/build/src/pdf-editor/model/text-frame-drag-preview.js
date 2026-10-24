import { textPreviewRasterSafety } from './text-preview-paint-order.js';

const MAX_EDGE = 2048;

function canonicalStrings(values) {
  if (!Array.isArray(values)) return null;
  const normalized = values.map(value => String(value));
  return normalized.every((value, index) => value && (index === 0 || normalized[index - 1] < value))
    ? normalized
    : null;
}

export function textFrameDragPreviewKey(input = {}) {
  const hiddenNativeStableIds = canonicalStrings(input.hiddenNativeStableIds || []);
  const hiddenAnnotationObjectNumbers = Array.isArray(input.hiddenAnnotationObjectNumbers)
    ? input.hiddenAnnotationObjectNumbers.map(Number)
    : null;
  if (typeof input.sessionId !== 'string' || !input.sessionId || typeof input.stableId !== 'string' || !input.stableId ||
      !Number.isSafeInteger(input.revision) || input.revision < 0 ||
      !Number.isSafeInteger(input.pageEpoch) || input.pageEpoch < 0 ||
      !Number.isSafeInteger(input.pageIndex) || input.pageIndex < 0 ||
      !Number.isInteger(input.rotation) || input.rotation < 0 || input.rotation > 3 ||
      (input.displayRotation != null && (!Number.isInteger(input.displayRotation) || input.displayRotation < 0 || input.displayRotation > 3)) ||
      !Number.isFinite(input.scale) || input.scale <= 0 || !hiddenNativeStableIds ||
      !hiddenAnnotationObjectNumbers || hiddenAnnotationObjectNumbers.some((value, index) =>
        !Number.isSafeInteger(value) || value <= 0 || (index > 0 && hiddenAnnotationObjectNumbers[index - 1] >= value))) return null;
  return JSON.stringify([input.sessionId, input.revision, input.pageEpoch, input.pageIndex, input.stableId,
    input.rotation, input.displayRotation ?? input.rotation, input.scale, hiddenNativeStableIds, hiddenAnnotationObjectNumbers]);
}

export function validateTextFrameDragPreview(result, expected = {}) {
  const key = textFrameDragPreviewKey(expected);
  const echoedNative = canonicalStrings(result?.hiddenNativeStableIds || []);
  const echoedAnnotations = Array.isArray(result?.hiddenAnnotationObjectNumbers)
    ? result.hiddenAnnotationObjectNumbers.map(Number)
    : null;
  if (!key || !result || result.stableId !== expected.stableId || result.revision !== expected.revision ||
      result.pageEpoch !== expected.pageEpoch || result.pageIndex !== expected.pageIndex ||
      result.rotation !== expected.rotation || result.scale !== expected.scale ||
      !echoedNative || JSON.stringify(echoedNative) !== JSON.stringify(expected.hiddenNativeStableIds || []) ||
      !echoedAnnotations || JSON.stringify(echoedAnnotations) !== JSON.stringify(expected.hiddenAnnotationObjectNumbers || []) ||
      result.coordinateSpace !== 'page-display-aabb') return null;
  const width = Number(result.width), height = Number(result.height), stride = Number(result.stride);
  const bounds = result.bounds;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 ||
      width > MAX_EDGE || height > MAX_EDGE || stride !== width * 4 ||
      !bounds || ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) ||
      bounds.width <= 0 || bounds.height <= 0) return null;
  if (result.previewKind === 'outline') {
    if (result.reason !== 'backdrop-dependent-native-paint' || result.format != null ||
        result.foregroundPixels != null || result.backgroundPixels != null) return null;
    return Object.freeze({
      key, previewKind: 'outline', reason: result.reason, width, height, stride,
      bounds: Object.freeze({ ...bounds }),
    });
  }
  if (result.previewKind !== 'raster' || result.format !== 'RGBA') return null;
  const foreground = ArrayBuffer.isView(result.foregroundPixels)
    ? new Uint8Array(result.foregroundPixels.buffer, result.foregroundPixels.byteOffset, result.foregroundPixels.byteLength)
    : result.foregroundPixels instanceof ArrayBuffer ? new Uint8Array(result.foregroundPixels) : null;
  const background = ArrayBuffer.isView(result.backgroundPixels)
    ? new Uint8Array(result.backgroundPixels.buffer, result.backgroundPixels.byteOffset, result.backgroundPixels.byteLength)
    : result.backgroundPixels instanceof ArrayBuffer ? new Uint8Array(result.backgroundPixels) : null;
  if (!foreground || !background || foreground.byteLength !== stride * height || background.byteLength !== stride * height) return null;
  return Object.freeze({ key, previewKind: 'raster', width, height, stride, bounds: Object.freeze({ ...bounds }),
    paintOrder: result.paintOrder || Object.freeze({ valid: false, reason: 'unproven-paint-order' }), foreground, background });
}

export function textFrameDragPreviewAppearance(preview, item = {}, urls = {}) {
  if (!preview || !Number.isFinite(item.x) || !Number.isFinite(item.y)) return null;
  if (preview.previewKind === 'outline') {
    return Object.freeze({
      nativeTextFrameDragPreview: true,
      previewKind: 'outline',
      reason: preview.reason,
      previewKey: preview.key,
    });
  }
  if (preview.previewKind !== 'raster' || typeof urls.foregroundUrl !== 'string' || !urls.foregroundUrl ||
      typeof urls.backgroundUrl !== 'string' || !urls.backgroundUrl) return null;
  return Object.freeze({
    glyphDataUrl: urls.foregroundUrl,
    sourceCoverDataUrl: urls.backgroundUrl,
    sourceCoverX: preview.bounds.x,
    sourceCoverY: preview.bounds.y,
    sourceCoverW: preview.bounds.width,
    sourceCoverH: preview.bounds.height,
    snapshotOffsetX: preview.bounds.x - item.x,
    snapshotOffsetY: preview.bounds.y - item.y,
    snapshotW: preview.bounds.width,
    snapshotH: preview.bounds.height,
    nativeTextFrameDragPreview: true,
    previewKind: 'raster',
    previewKey: preview.key,
    paintOrder: preview.paintOrder,
  });
}

export function textFrameDragPreviewForTranslation(appearance, dx, dy) {
  if (!appearance?.nativeTextFrameDragPreview || appearance.previewKind !== 'raster') return appearance;
  const safety = textPreviewRasterSafety(appearance.paintOrder, {
    sourceBounds: { x: appearance.sourceCoverX, y: appearance.sourceCoverY,
      width: appearance.sourceCoverW, height: appearance.sourceCoverH }, dx, dy,
  });
  if (safety.safe) return appearance;
  return Object.freeze({ nativeTextFrameDragPreview: true, previewKind: 'outline',
    reason: safety.reason === 'destination-outside-proven-page' ? safety.reason : 'upper-paint-overlap',
    safetyReason: safety.reason, previewKey: appearance.previewKey });
}
