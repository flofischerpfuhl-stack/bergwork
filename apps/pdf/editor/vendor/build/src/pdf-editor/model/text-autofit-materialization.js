import { createRichTextDocument } from './rich-text-document.js';

const positive = value => Number.isFinite(Number(value)) && Number(value) > 0;

export function isLegacyTextAutofitFrame(value = {}) {
  return value.textFrame === true && value.block?.overflow === 'shrink';
}

function boundedMinimum(block, sizes) {
  const smallest = Math.min(...sizes);
  const current = Number(block?.minFontSize);
  return positive(current) ? Math.min(current, smallest) : smallest;
}

/**
 * Materialize a verified legacy AutoFit frame at its already-painted native
 * sizes before an explicit resize. This is deliberately not an open-time
 * migration: callers apply the returned patch only to a user resize draft and
 * its matching commit.
 *
 * `nativeFrame` must be the current inspected native descriptor. `edit` may be
 * an optimistic UI draft; it supplies no font-size authority.
 */
export function materializeLegacyTextAutofitForResize(nativeFrame = {}, edit = nativeFrame) {
  const block = nativeFrame.block;
  const nativeType = String(nativeFrame.nativeTypeName || nativeFrame.typeName || '').toLowerCase();
  if (!isLegacyTextAutofitFrame(nativeFrame) || nativeType !== 'form') return null;

  const effective = Number(block.fontSize);
  if (!positive(effective)) return null;
  const base14 = nativeFrame.base14Rich === true || Boolean(nativeFrame.richTextCapability);
  const verifiedBase14 = nativeFrame.richTextCapability === 'verified-base14-rich-v1';
  if (base14 && !verifiedBase14) return null;

  const sourceDocument = nativeFrame.richTextDocument;
  if (sourceDocument != null) {
    if (nativeFrame.complexText !== true) return null;
    let document;
    try {
      if (sourceDocument.version !== 1) return null;
      document = createRichTextDocument(sourceDocument);
      if (document.text !== String(nativeFrame.text ?? nativeFrame.str ?? '').replace(/\r\n?/gu, '\n')) return null;
    } catch {
      return null;
    }
    const nominalSizes = [document.defaultCharacterStyle.fontSize, ...document.runs.map(run => run.style.fontSize)];
    if (!nominalSizes.every(positive)) return null;

    // The Base14 writer currently paints the canonical run sizes themselves;
    // its trial shrink size affects neither glyph creation nor metrics. Making
    // overflow visible therefore preserves those nominal physical sizes.
    const scale = verifiedBase14 ? 1 : effective / Math.max(...nominalSizes);
    if (!positive(scale) || scale > 1 + 1e-6) return null;
    const scaled = value => Number(value) * Math.min(1, scale);
    let richTextDocument;
    try {
      richTextDocument = Object.freeze({ version: 1, ...createRichTextDocument({
        ...document,
        defaultCharacterStyle: { ...document.defaultCharacterStyle,
          fontSize: scaled(document.defaultCharacterStyle.fontSize) },
        runs: document.runs.map(run => ({ ...run, style: { ...run.style, fontSize: scaled(run.style.fontSize) } })),
      }) });
    } catch {
      return null;
    }
    const physicalSizes = [richTextDocument.defaultCharacterStyle.fontSize,
      ...richTextDocument.runs.map(run => run.style.fontSize)];
    const blockFontSize = verifiedBase14 ? Math.max(...physicalSizes) : effective;
    return Object.freeze({
      fontSize: blockFontSize,
      sourceFontSize: blockFontSize,
      ...(edit.primitives && typeof edit.primitives === 'object'
        ? { primitives: Object.freeze({ ...edit.primitives, fontSize: blockFontSize }) }
        : {}),
      textOverflow: 'visible',
      richTextDocument,
      block: Object.freeze({ ...block, ...(edit.block || {}), overflow: 'visible',
        fontSize: blockFontSize, minFontSize: boundedMinimum(block, physicalSizes) }),
    });
  }

  // Native UI projection uses null for the absence of a RichDoc on a verified
  // standard Form. Any non-null malformed RichDoc was rejected above.
  if (nativeFrame.complexText === true || base14) return null;
  return Object.freeze({
    fontSize: effective,
    sourceFontSize: effective,
    ...(edit.primitives && typeof edit.primitives === 'object'
      ? { primitives: Object.freeze({ ...edit.primitives, fontSize: effective }) }
      : {}),
    textOverflow: 'visible',
    block: Object.freeze({ ...block, ...(edit.block || {}), overflow: 'visible', fontSize: effective,
      minFontSize: boundedMinimum(block, [effective]) }),
  });
}

/** Keep the user's formatting result authoritative after the inspector was
 * seeded with a materialized physical-size document. */
export function legacyTextAutofitRichInspectorCommit(materialization, nextDocument) {
  if (!materialization?.richTextDocument || materialization.textOverflow !== 'visible') return null;
  let document;
  try {
    document = Object.freeze({ version:1, ...createRichTextDocument(nextDocument) });
  } catch {
    return null;
  }
  return Object.freeze({ ...materialization, richTextDocument:document });
}

/** Materialize exactly at an explicit text layout/format boundary. The
 * requested property wins; the caller keeps the unmodified native frame as
 * the history baseline. */
export function legacyTextAutofitPropertyPatch(nativeFrame, edit, patch) {
  if (!patch || typeof patch !== 'object') return null;
  if (!isLegacyTextAutofitFrame(nativeFrame)) return Object.freeze({ ...patch });
  const materialization = materializeLegacyTextAutofitForResize(nativeFrame, edit);
  if (!materialization) return null;
  return Object.freeze({ ...materialization, ...patch });
}
