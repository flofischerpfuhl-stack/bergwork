import { dragCrossesPage } from './drag-composition-identity.js';

// The TextItem's legacy appearance can remain an outline while the separate
// native B/S/U compositor paints exact moved ink. Only a determined fallback
// may describe the visible gesture as an outline.
export function textDragPreviewStatus(drag, legacyStatus = '') {
  if (!drag?.armed) return '';
  if (drag.handle || drag.nativeReflow || !drag.compositionTarget) return legacyStatus;
  if (drag.compositionOverlay?.previewKind === 'raster' &&
      drag.compositionDestinationPrepared === true) return '';
  if (drag.compositionCrossPageCold || dragCrossesPage(drag)) {
    return 'Text crossing pages is shown as an outline while moving.';
  }
  if (drag.pendingHeldComposition && !drag.compositionTransferDenied && !drag.compositionOverlay) return '';
  if (drag.compositionLease && !drag.compositionOutcome && !drag.compositionLease.cancelled &&
      !drag.compositionTransferDenied && !drag.compositionOverlay) return '';
  const reason = String(drag.compositionOutcome?.reason || drag.appearance?.reason || '');
  if (/upper-paint|backdrop-dependent|paint-order/u.test(reason)) {
    return 'Overlapping PDF layers are shown as an outline while moving.';
  }
  return legacyStatus || 'Complex PDF appearance is shown as an outline while moving.';
}
