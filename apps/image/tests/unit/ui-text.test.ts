import { describe, expect, it } from 'vitest';
import { platformKeys, translator } from '../../src/ui/i18n';
import { describeError, isCancellation } from '../../src/ui/errors';
import { ImageImportError } from '../../src/io/imageImport';
import { ProjectError } from '../../src/io/project';

describe('platform key names', () => {
  it('keeps ⌘/Option on Apple devices and says Ctrl/Strg and Alt elsewhere', () => {
    const text = 'Option-click to set the source · ⌘-drag moves pixels · ⌘D deselect';
    expect(platformKeys(text, 'en', true)).toBe(text);
    expect(platformKeys(text, 'en', false)).toBe('Alt-click to set the source · Ctrl-drag moves pixels · Ctrl+D deselect');
    expect(platformKeys('⌘D Auswahl aufheben · Optionen', 'de', false)).toBe('Strg+D Auswahl aufheben · Optionen');
    expect(platformKeys('mit ⌘ den Farbton · ⌘ halten', 'de', false)).toBe('mit Strg den Farbton · Strg halten');
  });
});

describe('user-facing errors', () => {
  const de = translator('de');
  it('never shows a raw browser message on its own', () => {
    const gesture = new DOMException("Failed to execute 'showSaveFilePicker' on 'Window': Must be handling a user gesture to show a file picker.", 'SecurityError');
    const result = describeError(gesture, de, 'save-failed');
    expect(result.message).toBe('Der Browser hat diese Aktion aus Sicherheitsgründen blockiert.');
    expect(result.details).toContain('showSaveFilePicker');
    expect(describeError(new TypeError('Illegal invocation'), de).message).toBe('Das hat nicht geklappt. Bitte versuche es erneut.');
  });
  it('translates project and import errors by their code', () => {
    expect(describeError(new ProjectError('invalid', 'This is not a valid project (unknown format).'), de).message)
      .toBe('Diese Datei ist kein gültiges Projekt oder ihr Inhalt ist beschädigt. Das aktuelle Dokument wurde nicht ersetzt.');
    expect(describeError(new ImageImportError('unsupported', 'Unknown magic bytes'), de).message)
      .toBe('Dieser Dateityp kann nicht geöffnet werden. Wähle ein JPEG-, PNG-, WebP-, HEIC- oder TIFF-Bild.');
  });
  it('keeps file names and translates reasons for several failed imports', () => {
    const raw = 'a.png: The image could not be read. It may be damaged or unavailable.\n\nb.heic: This browser cannot decode HEIC. Convert the image to JPEG or PNG and try again.';
    expect(describeError(new Error(raw), de, 'import-failed').message).toBe(
      'a.png: Das Bild konnte nicht gelesen werden. Es ist vielleicht beschädigt oder nicht verfügbar.\n\nb.heic: Dieser Browser kann HEIC nicht lesen. Wandle das Bild in JPEG oder PNG um und versuche es erneut.');
  });
  it('treats a closed dialog as cancellation, not an error', () => {
    expect(isCancellation(new DOMException('The user aborted a request.', 'AbortError'))).toBe(true);
    expect(isCancellation(new Error('x'))).toBe(false);
  });
});
