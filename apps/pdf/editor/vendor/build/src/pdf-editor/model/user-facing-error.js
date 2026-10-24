// @ts-check

const TECHNICAL_PDF_ERROR = /\b(?:stable\s*(?:id|binding)?|binding|page\s*epoch|(?:native|object|page)\s+matrix|object\s+mapping|pdfium|checkpoint|locator|descriptor|handle|transaction)\b/iu;
const USER_RELEVANT_PDF_ERROR = /\b(?:glyph|font|password|encrypted|permission|read[ -]?only|unsupported\s+(?:font|file|image|pdf)|ttf|otf|ttc|xfa)\b/iu;
const PAGE_CHANGED_ERROR = /\b(?:stable\s*(?:id|binding)?|binding|page\s*epoch|(?:native|object|page)\s+matrix|object\s+mapping)\b/iu;

function sentence(value, fallback) {
  const text = String(value || fallback || 'This PDF action could not be completed.').trim();
  return /[.!?]$/u.test(text) ? text : `${text}.`;
}

/**
 * Keeps implementation details out of notifications while retaining the raw
 * error for console/debug capture. Genuine user-actionable reasons remain
 * verbatim (missing glyphs, passwords, unsupported fonts, permissions).
 */
export function userFacingError(error, actionLabel = 'This PDF action could not be completed.') {
  const raw = String(error?.message || error || '').trim();
  if (!raw) return sentence(actionLabel);
  if (USER_RELEVANT_PDF_ERROR.test(raw) && !PAGE_CHANGED_ERROR.test(raw)) return raw;
  if (!TECHNICAL_PDF_ERROR.test(raw)) return raw;

  console.warn('[PDF action details]', {
    action: sentence(actionLabel),
    code: error?.code || '',
    message: raw,
    details: error?.details || null,
  });
  globalThis.__fernworkDebugLog?.write?.('warn', 'pdf.user-facing-error-mapped', {
    action: sentence(actionLabel),
    code: error?.code || '',
    error: raw,
  });
  if (PAGE_CHANGED_ERROR.test(raw)) {
    return "Couldn't change this object because the page changed. Select it again and retry.";
  }
  return sentence(actionLabel);
}

export function refreshableBindingError(error) {
  if (error?.bindingRefreshAttempted === true) return false;
  const text = String(error?.message || error || '');
  return PAGE_CHANGED_ERROR.test(text) || [
    'binding-not-found',
    'binding-ambiguous',
    'stale-page-epoch',
  ].includes(String(error?.code || ''));
}
