import {
  BUNDLED_FONT_LIBRARY,
  libraryFace,
  libraryFaceUrl,
  libraryFontOptionValue,
} from './bundled-font-library.js';

export const PDF_STANDARD_FONT_OPTIONS = Object.freeze([
  { id: 'helvetica', label: 'Helvetica', family: 'Arial, Helvetica, sans-serif', pdf: 'helvetica' },
  { id: 'helveticaBold', label: 'Helvetica Bold', family: 'Arial, Helvetica, sans-serif', pdf: 'helveticaBold' },
  { id: 'helveticaItalic', label: 'Helvetica Italic', family: 'Arial, Helvetica, sans-serif', pdf: 'helveticaItalic' },
  { id: 'helveticaBoldItalic', label: 'Helvetica Bold Italic', family: 'Arial, Helvetica, sans-serif', pdf: 'helveticaBoldItalic' },
  { id: 'times', label: 'Times', family: '"Times New Roman", Times, serif', pdf: 'timesRoman' },
  { id: 'timesBold', label: 'Times Bold', family: '"Times New Roman", Times, serif', pdf: 'timesBold' },
  { id: 'timesItalic', label: 'Times Italic', family: '"Times New Roman", Times, serif', pdf: 'timesItalic' },
  { id: 'timesBoldItalic', label: 'Times Bold Italic', family: '"Times New Roman", Times, serif', pdf: 'timesBoldItalic' },
  { id: 'courier', label: 'Courier', family: '"Courier New", Courier, monospace', pdf: 'courier' },
  { id: 'courierBold', label: 'Courier Bold', family: '"Courier New", Courier, monospace', pdf: 'courierBold' },
  { id: 'courierItalic', label: 'Courier Italic', family: '"Courier New", Courier, monospace', pdf: 'courierItalic' },
  { id: 'courierBoldItalic', label: 'Courier Bold Italic', family: '"Courier New", Courier, monospace', pdf: 'courierBoldItalic' },
  { id: 'impact', label: 'Helvetica Bold (legacy Impact)', family: 'Arial, Helvetica, sans-serif', pdf: 'helveticaBold' },
  { id: 'script', label: 'Times Italic (legacy Script)', family: '"Times New Roman", Times, serif', pdf: 'timesItalic' },
]);

// Both the whole-text and range-aware inspectors consume this builder. The
// callers only adapt document-resource values and standard-face values to the
// kind of edit they perform; the four groups and bundled catalogue stay one
// canonical list.
export function buildPdfFontOptionGroups({
  documentOptions = [],
  standardValue = option => option.id,
  allowLibrary = false,
} = {}) {
  const groups = [{ label: 'This PDF', options: documentOptions }];
  groups.push({
    label: 'Standard PDF fonts',
    options: PDF_STANDARD_FONT_OPTIONS.map(option => ({
      value: standardValue(option),
      label: option.label,
      fontFamily: option.family,
    })),
  });
  if (!allowLibrary) return groups;
  groups.push({
    label: 'Fits Office fonts',
    options: BUNDLED_FONT_LIBRARY.filter(entry => entry.fits?.length).map(entry => {
      const face = libraryFace(entry);
      return {
        value: libraryFontOptionValue(entry.id),
        label: entry.label,
        tag: `fits ${entry.fits.map(rule => rule.label).join(', ')}`,
        preview: { url: libraryFaceUrl(face), weight: face.weight, style: face.style },
      };
    }),
  });
  groups.push({
    label: 'Library',
    options: BUNDLED_FONT_LIBRARY.filter(entry => !entry.fits?.length).map(entry => {
      const face = libraryFace(entry);
      const like = entry.like?.map(rule => rule.label).join(', ');
      return {
        value: libraryFontOptionValue(entry.id),
        label: entry.label,
        tag: like ? `like ${like}` : ['mono', 'display', 'handwriting'].includes(entry.category) ? entry.category : '',
        preview: { url: libraryFaceUrl(face), weight: face.weight, style: face.style },
      };
    }),
  });
  return groups;
}
