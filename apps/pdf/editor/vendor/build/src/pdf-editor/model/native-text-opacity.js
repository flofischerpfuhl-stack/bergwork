import {
  nativeObjectOpacityInversePayload,
  normalizeNativeObjectOpacityPayload,
} from './native-object-opacity.js';

export function nativeTextOpacityPropertyChange({ previousDescriptor, nextOpacity, gestureReason, logicalObjectCount = 1, beforeLocator = {}, afterLocator = {} }) {
  if (gestureReason !== 'text-opacity') return null;
  assertNativeTextOpacityMutationTargetCount(logicalObjectCount);
  const next = normalizeNativeObjectOpacityPayload({ opacity: nextOpacity });
  if (logicalObjectCount > 1) {
    const originals = normalizeNativeTextMemberOpacityPayload({
      memberOpacityChannels: previousDescriptor?.logicalTextMemberOpacityChannels,
    }, logicalObjectCount);
    if (!originals) {
      throw new TypeError('Every native text member requires exact fill and stroke opacity channels.');
    }
    const reference = Math.max(...originals.map(member => member.opacityChannels.fill));
    const scaled = originals.map(member => ({
      ...member,
      opacityChannels: reference === 0
        ? { fill: next.fill, stroke: next.stroke }
        : {
            fill: Math.max(0, Math.min(1, member.opacityChannels.fill * next.fill / reference)),
            stroke: Math.max(0, Math.min(1, member.opacityChannels.stroke * next.fill / reference)),
          },
    }));
    if (scaled.every((member, index) => (
      member.opacityChannels.fill === originals[index].opacityChannels.fill &&
      member.opacityChannels.stroke === originals[index].opacityChannels.stroke
    ))) return null;
    return {
      payload: { ...beforeLocator, memberOpacityChannels: scaled },
      inversePayload: { ...afterLocator, memberOpacityChannels: originals },
    };
  }
  const inverse = nativeObjectOpacityInversePayload(previousDescriptor);
  if (next.fill === inverse.opacityChannels.fill && next.stroke === inverse.opacityChannels.stroke) return null;
  return {
    payload: { ...beforeLocator, opacity: next.fill },
    inversePayload: { ...afterLocator, ...inverse },
  };
}

export function assertNativeTextOpacityMutationTargetCount(actualMatchedObjectCount) {
  if (!Number.isSafeInteger(actualMatchedObjectCount) || actualMatchedObjectCount < 1 || actualMatchedObjectCount > 256) {
    throw new Error('Text opacity requires a bounded, non-empty set of native objects.');
  }
}

export function normalizeNativeTextMemberOpacityPayload(payload, expectedCount = null) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
      !Object.hasOwn(payload, 'memberOpacityChannels')) return null;
  const members = payload.memberOpacityChannels;
  if (!Array.isArray(members) || !members.length || members.length > 256 ||
      (expectedCount != null && members.length !== expectedCount)) {
    throw new TypeError('memberOpacityChannels must match the bounded native text group.');
  }
  return Object.freeze(members.map((member, memberIndex) => {
    if (!member || typeof member !== 'object' || Array.isArray(member) ||
        (member.memberIndex != null && member.memberIndex !== memberIndex)) {
      throw new TypeError('memberOpacityChannels must stay in logical text group order.');
    }
    const opacityChannels = normalizeNativeObjectOpacityPayload({
      opacityChannels: member.opacityChannels,
    });
    const locator = member.locator && typeof member.locator === 'object' && !Array.isArray(member.locator)
      ? member.locator : {};
    return Object.freeze({
      memberIndex,
      locator: Object.freeze({ ...locator }),
      opacityChannels,
    });
  }));
}

export function projectedNativeTextOpacity(edit, nativeTarget) {
  const editedMembers = normalizeNativeTextMemberOpacityPayload(edit);
  if (editedMembers) return Math.max(...editedMembers.map(member => member.opacityChannels.fill));
  const hasEditedOpacity = edit && typeof edit === 'object' &&
    (edit.opacity != null || edit.opacityChannels != null);
  const edited = hasEditedOpacity ? normalizeNativeObjectOpacityPayload(edit) : null;
  if (edited) return edited.fill;
  const nativeMembers = Array.isArray(nativeTarget?.logicalTextMemberOpacityChannels) &&
      nativeTarget.logicalTextMemberOpacityChannels.length
    ? normalizeNativeTextMemberOpacityPayload({
        memberOpacityChannels: nativeTarget.logicalTextMemberOpacityChannels,
      })
    : null;
  if (nativeMembers) return Math.max(...nativeMembers.map(member => member.opacityChannels.fill));
  const candidates = [nativeTarget?.fillOpacity, nativeTarget?.opacity];
  for (const value of candidates) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1) return value;
  }
  const legacyAlpha = nativeTarget?.fillColor?.a;
  return typeof legacyAlpha === 'number' && Number.isFinite(legacyAlpha)
    ? Math.max(0, Math.min(255, legacyAlpha)) / 255
    : 1;
}
