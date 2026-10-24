function normalizedOpacity(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new TypeError(`${label} must be a finite number from 0 to 1.`);
  }
  return value;
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/**
 * Normalizes the opacity portion of an object-properties payload without
 * rejecting unrelated property keys. A scalar intentionally targets both
 * native alpha channels. Returns null when the payload has no opacity edit.
 */
export function normalizeNativeObjectOpacityPayload(payload) {
  if (payload == null) return null;
  if (typeof payload !== 'object' || Array.isArray(payload)) {
    throw new TypeError('Object-properties payload must be an object.');
  }

  const hasScalar = hasOwn(payload, 'opacity');
  const hasChannels = hasOwn(payload, 'opacityChannels');
  if (!hasScalar && !hasChannels) return null;
  if (hasScalar && hasChannels) {
    throw new TypeError('Opacity payload cannot contain both opacity and opacityChannels.');
  }

  if (hasScalar) {
    const opacity = normalizedOpacity(payload.opacity, 'opacity');
    return Object.freeze({ fill: opacity, stroke: opacity });
  }

  const channels = payload.opacityChannels;
  if (!channels || typeof channels !== 'object' || Array.isArray(channels)) {
    throw new TypeError('opacityChannels must be an object with exact fill and stroke keys.');
  }
  const keys = Object.keys(channels).sort();
  if (keys.length !== 2 || keys[0] !== 'fill' || keys[1] !== 'stroke') {
    throw new TypeError('opacityChannels must contain exactly fill and stroke.');
  }
  return Object.freeze({
    fill: normalizedOpacity(channels.fill, 'opacityChannels.fill'),
    stroke: normalizedOpacity(channels.stroke, 'opacityChannels.stroke'),
  });
}

/**
 * Builds the lossless internal inverse payload from independently verified
 * native descriptor channels. The legacy scalar descriptor is intentionally
 * ignored and never used as a fallback.
 */
export function nativeObjectOpacityInversePayload(descriptor) {
  if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) {
    throw new TypeError('A native object descriptor is required for opacity inverse.');
  }
  const fill = normalizedOpacity(descriptor.fillOpacity, 'descriptor.fillOpacity');
  const stroke = normalizedOpacity(descriptor.strokeOpacity, 'descriptor.strokeOpacity');
  return Object.freeze({
    opacityChannels: Object.freeze({ fill, stroke }),
  });
}
