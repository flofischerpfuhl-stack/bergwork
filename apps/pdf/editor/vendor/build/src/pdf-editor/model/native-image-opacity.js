import { nativeObjectOpacityInversePayload, normalizeNativeObjectOpacityPayload } from './native-object-opacity.js';

export const NATIVE_IMAGE_OPACITY_MODE = 'native-channels-v1';

// Old journal scalar commands intentionally retain their bitmap-baking
// interpretation. Only an explicit new UI opacity gesture emits native pairs;
// geometry gestures may carry legacy UI opacity without applying it again.
export function nativeImageOpacityPropertyChange({ descriptor, nextOpacity, gestureReason }) {
  if (gestureReason !== 'image-opacity') return null;
  const channels = normalizeNativeObjectOpacityPayload({ opacity: nextOpacity });
  const inversePayload = nativeObjectOpacityInversePayload(descriptor);
  if (channels.fill === inversePayload.opacityChannels.fill &&
      channels.stroke === inversePayload.opacityChannels.stroke) return null;
  return { payload: { opacityChannels: channels }, inversePayload };
}

export function nativeImageOpacityControlValue(edit, descriptor) {
  if (edit?.opacityMode === NATIVE_IMAGE_OPACITY_MODE &&
      typeof edit.opacity === 'number' && Number.isFinite(edit.opacity) &&
      edit.opacity >= 0 && edit.opacity <= 1) return edit.opacity;
  // A legacy scalar describes already-baked pixels, not native graphics alpha.
  // The current intrinsic image is authoritative; lost old alpha cannot be
  // reconstructed by applying that scalar a second time.
  const value = descriptor?.fillOpacity ?? descriptor?.opacity;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : 1;
}
