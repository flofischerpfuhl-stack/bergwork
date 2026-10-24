import { createRichTextDocument } from './rich-text-document.js';

/** Inspector controls use flat UI properties; the native PDF stores these in
 * its verified block. Reopening must not fall back to unrelated UI defaults. */
export function verifiedTextFrameLayoutProperties(item = {}) {
  if (item.textFrame !== true || !item.block) return {};
  const block = item.block;
  return {
    textAlign: block.align || 'left',
    verticalAlign: block.verticalAlign || 'top',
    textOverflow: block.overflow || 'visible',
    lineHeight: block.lineHeight ?? 1.2,
    minFontSize: block.minFontSize ?? 4,
    maxLines: Number.isSafeInteger(block.maxLines) ? block.maxLines : undefined,
  };
}

/** Only current native, verified frame metadata can seed character styles.
 * File names, PDF.js family labels and geometry matches are not font identity. */
export function richTextDocumentForVerifiedFrame(item = {}) {
  const claimsBase14Rich = item.base14Rich === true || Boolean(item.richTextCapability);
  const verifiedBase14Rich = item.richTextCapability === 'verified-base14-rich-v1';
  // Base14 character editing is a separate native capability. Never let a
  // partial/forged claim fall through to the embedded-frame eligibility path.
  if (claimsBase14Rich && !verifiedBase14Rich) return null;
  if (verifiedBase14Rich) {
    const nativeType = String(item.nativeTypeName || item.typeName || '').toLowerCase();
    const verifiedOriginal = item.textFrame !== true && item.complexText !== true && nativeType === 'text';
    const verifiedFrame = item.textFrame === true && item.complexText === true && nativeType === 'form';
    if (!verifiedOriginal && !verifiedFrame) return null;
  } else if (item.textFrame !== true || item.complexText !== true) return null;
  const text = String(item.text ?? item.str ?? '').replace(/\r\n?/gu, '\n');
  if (item.richTextDocument) {
    try {
      if (item.richTextDocument.version !== 1) return null;
      const document = createRichTextDocument(item.richTextDocument);
      if (document.text !== text) return null;
      if (verifiedBase14Rich && (
        !document.fontResources.length ||
        document.fontResources.some(resource => resource.kind !== 'base14')
      )) return null;
      return Object.freeze({ version: 1, ...document });
    } catch {
      return null;
    }
  }
  if (verifiedBase14Rich) return null;
  if (item.uniformTextAppearance !== true) return null;
  const resources = item.richTextFontResources;
  if (!Array.isArray(resources) || !resources.length) return null;
  const selected = resources.find(resource => resource.resourceId === item.requestedFontResourceHash) || resources[0];
  const fontSize = Number(item.fontSize);
  const color = String(item.color || '').toLowerCase();
  if (!Number.isFinite(fontSize) || fontSize <= 0 || !/^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/u.test(color)) return null;
  try {
    const document = createRichTextDocument({
      text, fontResources: resources,
      defaultCharacterStyle: {
        resourceId: selected.resourceId, family: selected.family,
        weight: selected.weight, style: selected.style,
        fontSize, color: color.length === 7 ? `${color}ff` : color,
      },
    });
    return Object.freeze({ version: 1, ...document });
  } catch {
    return null;
  }
}

const NATIVE_RICH_FRAME_FIELDS = Object.freeze([
  'textFrame', 'textBlock', 'complexText', 'nativeTypeName',
  'base14Rich', 'richTextCapability',
  'uniformTextAppearance',
  'richTextFontResources', 'richTextAvailableFontResources', 'fontResourceHashes', 'fontFamilies',
  'usedFontResourceHashes', 'usedFontFamilies', 'frameResourceId',
  'fontSize', 'color', 'block',
  'textAlign', 'verticalAlign', 'textOverflow', 'lineHeight', 'minFontSize', 'maxLines',
]);

/** A UI edit may carry geometry and an optimistic canonical rich document, but
 * it cannot replace provenance or actual appearance read from the currently
 * verified native Form with stale defaults. */
export function richTextInspectorPropertyItem(nativeItem = {}, confirmedEdit = null) {
  if (!confirmedEdit) return nativeItem;
  const merged = { ...nativeItem, ...confirmedEdit };
  const verifiedNativeRich = (nativeItem.textFrame === true && nativeItem.complexText === true) ||
    nativeItem.richTextCapability === 'verified-base14-rich-v1';
  if (!verifiedNativeRich) return merged;
  for (const field of NATIVE_RICH_FRAME_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(nativeItem, field)) merged[field] = nativeItem[field];
  }
  if (confirmedEdit.richTextDocument) merged.richTextDocument = confirmedEdit.richTextDocument;
  else if (nativeItem.richTextDocument) merged.richTextDocument = nativeItem.richTextDocument;
  else delete merged.richTextDocument;
  return merged;
}
