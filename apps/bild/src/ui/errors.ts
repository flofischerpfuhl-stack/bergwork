/**
 * Error texts for people, not developers: a localized sentence per kind of failure, never a raw browser or
 * decoder message on its own. Technical details (English, from the engines or the browser) follow on their
 * own line so a bug report still has them.
 */

import { ImageImportError } from '../io/imageImport';
import { ProjectError } from '../io/project';

type Translate = (text: string) => string;

/** Messages our own code writes for users; translated when a translation exists. */
const KNOWN_MESSAGES = [
  'The image could not be read. It may be damaged or unavailable.',
  'Choose a JPEG, PNG, HEIC, or TIFF image.',
  'Choose a JPEG, PNG, HEIC, TIFF, WebP, AVIF, or GIF image.',
  'This import exceeds the current 100-megapixel document budget or 30,000-pixel side limit.',
  'This browser cannot decode HEIC. Convert the image to JPEG or PNG and try again.',
  'Image export supports canvases up to 100 megapixels and 30,000 pixels per side.',
  'There is no canvas to export.',
  'Choose what to export.',
  'The artboard no longer exists.',
  'The layer no longer exists.',
  'There is no canvas to save.',
  'Browser storage is full. Automatic recovery copies of this project are paused; save the project to keep your work.',
  'An image inside the project is missing or damaged. The current document has not been replaced.',
  'An image inside the project is damaged (checksum mismatch). The current document has not been replaced.',
];

const PROJECT_CODES: Record<string, string> = {
  'invalid': 'This file is not a valid project, or its contents are damaged. The current document has not been replaced.',
  'version': 'This project was saved by a newer version and cannot be opened here.',
  'missing-image': 'An image inside the project is missing or damaged. The current document has not been replaced.',
  'too-large': 'The document is too large (limit: 100 megapixels and 30,000 pixels per side).',
  'invalid-size': 'The canvas size is not valid.',
  'no-document': 'There is no canvas yet.',
};

const IMPORT_CODES: Record<ImageImportError['code'], string> = {
  unreadable: 'The image could not be read. It may be damaged or unavailable.',
  unsupported: 'This file type cannot be opened. Choose a JPEG, PNG, WebP, HEIC or TIFF image.',
  'too-large': 'This import exceeds the current 100-megapixel document budget or 30,000-pixel side limit.',
};

/** Browser-level failures (DOMException names) that have a clear meaning for people. */
const BROWSER_NAMES: Record<string, string> = {
  NotAllowedError: 'The browser did not allow this action. Try again with a click or a keyboard shortcut.',
  SecurityError: 'The browser blocked this action for security reasons.',
  QuotaExceededError: 'There is not enough storage space for this action.',
  NotReadableError: 'The file could not be read. It may have been moved or changed.',
  NotFoundError: 'The file could not be found.',
  NetworkError: 'The download failed. Check the connection and try again.',
};

/** Whether the failure is only the user cancelling (e.g. closing a save dialog); such failures are not reported. */
export function isCancellation(error: unknown): boolean {
  return (error as { name?: string } | null)?.name === 'AbortError';
}

export interface UserError { message: string; details: string | null }

export function describeError(error: unknown, t: Translate, code = '', fallback = 'Something went wrong. Please try again.'): UserError {
  const raw = error instanceof Error ? error.message : String(error ?? '');
  const name = (error as { name?: string } | null)?.name ?? '';
  const known = (text: string) => KNOWN_MESSAGES.includes(text) || PROJECT_CODES[text] !== undefined;
  let message: string;
  if (error instanceof ImageImportError) message = t(known(raw) ? raw : IMPORT_CODES[error.code]);
  else if (error instanceof ProjectError) message = t(known(raw) ? raw : PROJECT_CODES[error.code] ?? fallback);
  else if (BROWSER_NAMES[name]) message = t(BROWSER_NAMES[name]!);
  else if (/user gesture|user activation/i.test(raw)) message = t(BROWSER_NAMES.NotAllowedError!);
  else if (known(raw)) message = t(raw);
  else if (code === 'import-failed' && /^[^:\n]+: /.test(raw)) {
    // Several import failures, one per file: "name: reason" — keep the names, translate the reasons.
    message = raw.split('\n\n').map((line) => {
      const at = line.indexOf(': ');
      return at > 0 ? `${line.slice(0, at)}: ${t(line.slice(at + 2))}` : t(line);
    }).join('\n\n');
    return { message, details: null };
  } else message = t(fallback);
  const details = raw && t(raw) !== message && raw !== message ? raw : null;
  return { message, details };
}
