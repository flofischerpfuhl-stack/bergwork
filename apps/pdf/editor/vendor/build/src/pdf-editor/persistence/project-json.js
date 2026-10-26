// A Fernwork PDF project (.fwpdf / .bwpdf) is one JSON text: every PDF source,
// the native checkpoint and each undo snapshot are inlined as base64. A
// JavaScript string holds at most 2^29 - 24 characters (V8), so a large scan
// with an edit history (wikimedia-commons/NDL1235439_part1.pdf: a 143 MB
// source, its checkpoint and an undo snapshot, about 570 M characters) made
// JSON.stringify throw "Invalid string length", and a file that large could
// not be read back with file.text() either. Such a workspace is refused with
// a calm, typed reason instead; the PDF itself still saves.

export const PDF_PROJECT_MAX_JSON_CHARS = 448 * 1024 * 1024;

const megabytes = characters => Math.max(1, Math.ceil(characters / (1024 * 1024)));

export class PdfProjectSizeError extends Error {
  constructor(characters, limit = PDF_PROJECT_MAX_JSON_CHARS, message = '') {
    super(message || `This workspace is too large to save as a project file (about ${megabytes(characters)} MB with `
      + `its edit history; the limit is ${megabytes(limit)} MB). Save the PDF instead.`);
    this.name = 'PdfProjectSizeError';
    this.code = 'resource-limit';
    this.details = { reason: 'project-json-size', characters, limit };
  }
}

// The inlined byte payloads dominate a project; everything else is small.
function inlinedBase64Characters(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 12) return 0;
  let total = 0;
  for (const [key, item] of Object.entries(value)) {
    if (key === 'bytesBase64' && typeof item === 'string') total += item.length;
    else if (item && typeof item === 'object') total += inlinedBase64Characters(item, depth + 1);
  }
  return total;
}

/** JSON text of a serialized project, or a PdfProjectSizeError. */
export function pdfProjectJsonText(project, { maxChars = PDF_PROJECT_MAX_JSON_CHARS } = {}) {
  const estimate = inlinedBase64Characters(project);
  if (estimate > maxChars) throw new PdfProjectSizeError(estimate, maxChars);
  let text;
  try {
    text = JSON.stringify(project);
  } catch (error) {
    if (error instanceof RangeError) throw new PdfProjectSizeError(Math.max(estimate, 2 ** 29), maxChars);
    throw error;
  }
  if (text.length > maxChars) throw new PdfProjectSizeError(text.length, maxChars);
  return text;
}

/** Refuses a project file that cannot be read as one JSON text. */
export function assertPdfProjectFileReadable(file, { maxChars = PDF_PROJECT_MAX_JSON_CHARS } = {}) {
  const size = Number(file?.size) || 0;
  if (size > maxChars) {
    throw new PdfProjectSizeError(size, maxChars,
      `This project file is too large to open (about ${megabytes(size)} MB; the limit is ${megabytes(maxChars)} MB).`);
  }
}
