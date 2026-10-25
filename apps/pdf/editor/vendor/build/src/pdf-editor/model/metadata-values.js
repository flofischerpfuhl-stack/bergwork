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

const PDF_METADATA_TEXT_FIELDS = Object.freeze(['title', 'author', 'subject', 'keywords', 'creator', 'producer']);

function pdfMetadataDate(value) {
  return value instanceof Date && !Number.isNaN(value.getTime()) ? value.toISOString().slice(0, 10) : '';
}

/**
 * Read the Info fields of a pdf-lib document one by one. pdf-lib's getters
 * throw on a value that is not a PDF string or date (old writers put dates
 * like "Monday, July 30, 2001 9:48:59 AM" into /CreationDate); such a field
 * reads as empty instead of blanking every other field.
 */
export function readPdfLibMetadata(pdf) {
  const read = getter => {
    try { return getter(); } catch { return undefined; }
  };
  return {
    title: pdfMetadataText(read(() => pdf.getTitle())),
    author: pdfMetadataText(read(() => pdf.getAuthor())),
    subject: pdfMetadataText(read(() => pdf.getSubject())),
    keywords: pdfMetadataText(read(() => pdf.getKeywords())),
    creator: pdfMetadataText(read(() => pdf.getCreator())),
    producer: pdfMetadataText(read(() => pdf.getProducer())),
    creationDate: pdfMetadataDate(read(() => pdf.getCreationDate())),
    modificationDate: pdfMetadataDate(read(() => pdf.getModificationDate())),
  };
}

/**
 * Write the editable Info fields into a pdf-lib document and stamp the
 * modification date. With `original` (the fields as the document had them
 * when it was opened) only the fields that differ from it are written, so a
 * field the editor could not read, or did not touch, keeps its bytes.
 */
export function applyPdfLibMetadata(pdf, metadata = {}, original = null) {
  const setters = {
    title: value => pdf.setTitle(value),
    author: value => pdf.setAuthor(value),
    subject: value => pdf.setSubject(value),
    keywords: value => pdf.setKeywords(pdfMetadataKeywords(value)),
    creator: value => pdf.setCreator(value),
    producer: value => pdf.setProducer(value),
  };
  for (const key of PDF_METADATA_TEXT_FIELDS) {
    const value = pdfMetadataText(metadata?.[key]);
    if (original && value === pdfMetadataText(original[key])) continue;
    setters[key](value);
  }
  pdf.setModificationDate(new Date());
}
