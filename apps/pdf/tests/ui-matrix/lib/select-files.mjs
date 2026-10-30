// Which PDFs the matrix drives: one per profile, picked from the corpus manifest by tags and producer, so the matrix has
// no collection of its own. A profile takes the smallest file that fits and is on disk.
import { existsSync } from 'node:fs';
import path from 'node:path';

const usable = file => !file.tags.includes('broken') && !file.tags.includes('encrypted') && !file.tags.includes('xfa') &&
  !file.tags.includes('large-file') && !file.tags.includes('many-pages') && file.pages <= 30 && file.bytes <= 6_000_000 &&
  !file.expect?.open;

export const PROFILES = Object.freeze([
  { id: 'word-tagged', label: 'Word, tagged, fonts not embedded',
    match: file => /Word/i.test(`${file.producer} ${file.facts?.creator || ''}`) && file.tags.includes('tagged') &&
      file.tags.includes('font-not-embedded') && file.tags.includes('text') },
  { id: 'chrome-skia', label: 'Chrome/Skia', match: file => /Skia/i.test(file.producer) && file.tags.includes('text') },
  { id: 'latex', label: 'LaTeX', match: file => /pdfTeX|LaTeX/i.test(file.producer) && file.tags.includes('text') },
  { id: 'scan', label: 'Scan', match: file => file.tags.includes('scanned') },
  { id: 'form', label: 'AcroForm', match: file => file.tags.includes('acroform') && file.tags.includes('text') },
  { id: 'rotated-page', label: 'Rotated page', match: file => file.tags.includes('rotated-pages') && file.tags.includes('text') },
]);

/** @returns {{ profile: string, label: string, id: string, path: string }[]} */
export function selectFiles(manifest, corpusRoot, { profiles = PROFILES.map(item => item.id), extra = [] } = {}) {
  const selected = [];
  for (const profile of PROFILES.filter(item => profiles.includes(item.id))) {
    const file = manifest.files
      .filter(candidate => usable(candidate) && profile.match(candidate) && existsSync(path.join(corpusRoot, candidate.id)))
      .sort((left, right) => left.bytes - right.bytes)[0];
    if (file) selected.push({ profile: profile.id, label: profile.label, id: file.id, path: path.join(corpusRoot, file.id) });
  }
  for (const file of extra) {
    selected.unshift({ profile: path.basename(file, '.pdf'), label: 'Extra file', id: path.basename(file), path: path.resolve(file) });
  }
  return selected;
}
