// Self-hosted, redistributable font families the editor can embed without an
// upload. scripts/import-pdf-font-library.py owns the generated catalogue and
// files. Faces are fetched lazily, only when a preview or edit needs one.

import catalogue from './bundled-font-catalogue.json' with { type: 'json' };

export const BUNDLED_FONT_BASE = '/tools/vendor/pdf-tools/fallback-fonts/latin/';
export const BUNDLED_FONT_LIBRARY = Object.freeze(catalogue.map(entry => Object.freeze({
  ...entry,
  faces: Object.freeze(entry.faces.map(face => Object.freeze(face))),
  aliases: Object.freeze(entry.aliases || []),
  fits: Object.freeze(entry.fits || []),
  like: Object.freeze(entry.like || []),
})));

export const LIBRARY_FONT_OPTION_PREFIX = 'lib:';

export function libraryFontOptionValue(id) {
  return `${LIBRARY_FONT_OPTION_PREFIX}${id}`;
}

export function libraryFontIdFromOption(value = '') {
  const normalized = String(value || '');
  return normalized.startsWith(LIBRARY_FONT_OPTION_PREFIX)
    ? normalized.slice(LIBRARY_FONT_OPTION_PREFIX.length)
    : '';
}

export function libraryFontById(id) {
  return BUNDLED_FONT_LIBRARY.find(entry => entry.id === id) || null;
}

const STYLE_SUFFIX = /(?:thin|extralight|ultralight|light|regular|book|medium|semibold|demibold|demi|bold|extrabold|ultrabold|black|heavy|italic|oblique|kursiv|reguital|mediital|regu|medi)+$/u;
const FOUNDRY_SUFFIX = /(?:psmt|mt|ps|std|pro)$/u;

// Normalise names such as "ABCDEF+Calibri-BoldItalic", "ArialMT",
// "FuturaPT-Book" and "MyriadPro-Regular". rawStem retains meaningful
// family suffixes such as Pro for an exact same-family alias; stem also
// removes common foundry suffixes for the proprietary-name dictionary.
export function parsePdfFontName(name = '') {
  const raw = String(name || '').replace(/^[A-Z]{6}\+/u, '');
  const lower = raw.toLowerCase();
  const bold = /bold|black|heavy|semibold|demibold|demi|extrabold|ultrabold|(?:^|[-_ ,])medi(?:ital)?(?=$|[-_ ,])/u.test(lower);
  const italic = /italic|oblique|kursiv|(?:regu|medi)ital/u.test(lower);
  let rawStem = lower.replace(/[^a-z0-9]+/gu, '');
  for (let pass = 0; pass < 3; pass += 1) {
    rawStem = rawStem.replace(/(?:psmt|mt)$/u, '').replace(STYLE_SUFFIX, '');
  }
  let stem = rawStem;
  for (let pass = 0; pass < 2; pass += 1) stem = stem.replace(FOUNDRY_SUFFIX, '').replace(STYLE_SUFFIX, '');
  return { stem, rawStem, weight: bold ? '700' : '400', style: italic ? 'italic' : 'normal' };
}

function aliasMatches(stems, alias) {
  const wanted = String(alias || '').toLowerCase().replace(/[^a-z0-9*]+/gu, '');
  if (!wanted) return false;
  if (wanted.endsWith('*')) {
    const prefix = wanted.slice(0, -1);
    return stems.some(stem => stem.startsWith(prefix));
  }
  return stems.includes(wanted);
}

function matchRule(stems, rules = []) {
  for (const rule of rules) {
    if ((rule.aliases || []).some(alias => aliasMatches(stems, alias))) return rule;
  }
  return null;
}

// One explicit tiered dictionary for every automatic library substitution:
// same shipped family, verified metric fit, then a visual equivalent. A caller
// falls through to standardFontFallback when this returns null.
export function resolveLibraryFontSubstitution(pdfFontName = '') {
  const parsed = parsePdfFontName(pdfFontName);
  const stems = [...new Set([parsed.rawStem, parsed.stem].filter(Boolean))];
  if (!stems.length) return null;

  for (const entry of BUNDLED_FONT_LIBRARY) {
    if ((entry.aliases || []).some(alias => aliasMatches(stems, alias))) {
      return {
        entry, face: libraryFace(entry, parsed.weight, parsed.style),
        weight: parsed.weight, style: parsed.style, tier: 'same-family',
        sourceLabel: entry.label, reason: 'the full shipped face of the same family',
      };
    }
  }
  for (const tier of ['fits', 'like']) {
    for (const entry of BUNDLED_FONT_LIBRARY) {
      const rule = matchRule(stems, entry[tier]);
      if (!rule) continue;
      return {
        entry, face: libraryFace(entry, parsed.weight, parsed.style),
        weight: parsed.weight, style: parsed.style,
        tier: tier === 'fits' ? 'metric-compatible' : 'visual-equivalent',
        sourceLabel: rule.label, reason: rule.reason,
      };
    }
  }
  return null;
}

// Backwards-compatible narrow query. Same-family recovery is metric-preserving
// too; visual matches are excluded so they cannot be described as exact fits.
export function metricCompatibleLibraryFont(pdfFontName = '') {
  const match = resolveLibraryFontSubstitution(pdfFontName);
  return match && match.tier !== 'visual-equivalent' ? match : null;
}

export function librarySubstitutionNotice(match, pdfFontName = 'The embedded font') {
  const source = String(pdfFontName || 'The embedded font').replace(/^[A-Z]{6}\+/u, '');
  if (match?.tier === 'same-family') {
    return `${source} cannot take new characters in this PDF, so edited text uses the full ${match.entry.label} face (same family).`;
  }
  if (match?.tier === 'metric-compatible') {
    return `${source} cannot take new characters in this PDF, so edited text uses ${match.entry.label}, which fits ${match.sourceLabel} (same advance widths).`;
  }
  if (match?.tier === 'visual-equivalent') {
    return `${source} cannot take new characters in this PDF, so edited text uses ${match.entry.label}, similar to ${match.sourceLabel}; line widths may differ.`;
  }
  return '';
}

export function libraryFace(entry, weight = '400', style = 'normal') {
  const wanted = entry.faces.find(candidate => candidate.weight === String(weight) && candidate.style === style);
  const sameWeight = entry.faces.find(candidate => candidate.weight === String(weight));
  const sameStyle = entry.faces.find(candidate => candidate.weight === '400' && candidate.style === style);
  return wanted || sameWeight || sameStyle || entry.faces.find(candidate => candidate.weight === '400' && candidate.style === 'normal') || entry.faces[0];
}

export function libraryFaceUrl(faceEntry, base = BUNDLED_FONT_BASE) {
  return `${base}${faceEntry.file}`;
}

export async function fetchLibraryFontFile(entry, faceEntry, { fetchImpl = globalThis.fetch, base = BUNDLED_FONT_BASE } = {}) {
  const response = await fetchImpl(libraryFaceUrl(faceEntry, base));
  if (!response?.ok) throw new Error(`Bundled font ${entry.label} could not be loaded.`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const extension = String(faceEntry.file).split('.').pop()?.toLowerCase() === 'otf' ? 'otf' : 'ttf';
  const suffix = `${faceEntry.weight === '700' ? ' Bold' : ''}${faceEntry.style === 'italic' ? ' Italic' : ''}`;
  return new File([bytes], `${entry.family}${suffix}.${extension}`, { type: `font/${extension}` });
}

export function inferWeightFromRunWidth({ text = '', width = 0, measure }) {
  const sample = String(text || '');
  if (sample.replace(/\s+/gu, '').length < 4 || !(width > 0) || typeof measure !== 'function') return null;
  const regular = Number(measure('400'));
  const bold = Number(measure('700'));
  if (!(regular > 0) || !(bold > 0) || Math.abs(bold - regular) < regular * 0.015) return null;
  const regularError = Math.abs(width - regular);
  const boldError = Math.abs(width - bold);
  if (Math.min(regularError, boldError) > Math.abs(bold - regular) * 1.5) return null;
  return boldError < regularError ? '700' : '400';
}
