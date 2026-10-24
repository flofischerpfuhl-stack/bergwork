// Picks the standard (always embeddable) face that looks closest to a source
// font which cannot take the typed characters. Descriptor flags are unreliable
// on subset fonts (many producers write only Symbolic/Nonsymbolic), so the
// PostScript name is read as well; either signal is enough.

const SERIF_NAME = new RegExp([
  'times', 'tinos', 'serif', 'roman', 'nimbusrom', 'georgia', 'garamond', 'palatino', 'palladio', 'pagella',
  'bookman', 'bookantiqua', 'schoolbook', 'century', 'cambria', 'caladea', 'constantia', 'charter', 'utopia',
  'libertine', 'libertinus', 'baskerville', 'caslon', 'didot', 'bodoni', 'minion', 'sabon', 'merriweather',
  'playfair', 'crimson', 'lora', 'ptserif', 'notoserif', 'dejavuserif', 'liberationserif', 'sourceserif',
  'slab', 'rockwell', 'clarendon', 'antiqua', 'mincho', 'termes', 'lmroman', 'sfrm', 'ecrm',
  // Computer Modern text faces: cmr10, cmbx12, cmti10, cmsl10, cmcsc10 …
  '^cm(?:r|bx|b|ti|sl|csc|u|dunh|bxti|bxsl)\\d',
].join('|'), 'u');

const SANS_NAME = /sans|grotesk|gothic|helvet|arial|arimo|verdana|tahoma|calibri|carlito|segoe|roboto|lato|futura|frutiger|univers|avenir|^cmss|lmsans|sfss/u;

const MONO_NAME = new RegExp([
  'courier', 'cousine', 'mono', 'typewriter', 'consolas', 'menlo', 'monaco', 'inconsolata', 'fixed', 'terminal',
  'nimbusmon', 'lucidaconsole', 'sourcecode', 'firacode', 'jetbrains',
  // Computer Modern / Latin Modern / EC typewriter: cmtt10, lmtt, sftt1000, ectt
  '^(?:cm|lm|sf|ec)(?:tt|tl|vtt|itt|sltt|tcsc)',
].join('|'), 'u');

const BOLD_NAME = /bold|black|heavy|demi|semibold|extrabold|ultrabold|(?:^|[-_ ,])(?:medi|medium|bd|blk)(?=$|[-_ ,\d])|^cm(?:bx|b|bxti|bxsl)\d|^(?:sf|ec)(?:bx|rb|sx)/u;

const ITALIC_NAME = /italic|oblique|kursiv|slanted|(?:^|[-_ ,])(?:it|ital|obl)(?=$|[-_ ,\d])|^cm(?:ti|sl|bxti|bxsl|u)\d|^(?:sf|ec)(?:ti|sl|bi)/u;

function normalizedFontName(fontName) {
  return String(fontName || '')
    .replace(/^[A-Z]{6}\+/u, '')
    .toLowerCase()
    .replace(/\s+/gu, '');
}

export function classifySourceFont(fontName, traits = null) {
  const name = normalizedFontName(fontName);
  const mono = traits?.fixedPitch === true || MONO_NAME.test(name);
  // An explicit sans name wins over a stray Serif flag ("MiloSlab" keeps serif).
  const serif = !mono && (SERIF_NAME.test(name) || (traits?.serif === true && !SANS_NAME.test(name)));
  return {
    family: mono ? 'courier' : serif ? 'times' : 'helvetica',
    bold: traits?.bold === true || BOLD_NAME.test(name),
    italic: traits?.italic === true || ITALIC_NAME.test(name),
  };
}

export function standardFontFallback(fontName, traits = null, declared = {}) {
  const source = classifySourceFont(fontName, traits);
  const declaredWeight = String(declared.fontWeight ?? '');
  const declaredStyle = String(declared.fontStyle ?? '').toLowerCase();
  const bold = source.bold || declaredWeight === 'bold' || Number(declaredWeight) >= 600;
  const italic = source.italic || declaredStyle === 'italic' || declaredStyle === 'oblique';
  const suffix = bold && italic ? 'BoldItalic' : bold ? 'Bold' : italic ? 'Italic' : '';
  return {
    fontKey: `${source.family}${suffix}`,
    fontWeight: bold ? '700' : '400',
    fontStyle: italic ? 'italic' : 'normal',
  };
}
