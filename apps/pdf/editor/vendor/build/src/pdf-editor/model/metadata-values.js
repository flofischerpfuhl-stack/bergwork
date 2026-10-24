// @ts-check

/** Return readable PDF metadata text without coercing dictionaries to noise. */
export function pdfMetadataText(value) {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value
    .map(item => pdfMetadataText(item).trim())
    .filter(Boolean)
    .join(', ');
}

/** Normalize the PDF-lib keyword setter's array contract at the write edge. */
export function pdfMetadataKeywords(value) {
  const text = pdfMetadataText(value);
  return text.split(',').map(part => part.trim()).filter(Boolean);
}
