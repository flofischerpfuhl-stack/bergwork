/**
 * UI strings of the Phase-2 adjustment UI (adjustment layers, smart filters, brush modes), merged into the
 * translator by ui/i18n.ts. German follows Photoshop and Lightroom Classic (German UI).
 */

export const ADJUST_P2_DE: Readonly<Record<string, string>> = {
  // Adjustment layer kinds
  'Basic': 'Basis', 'Color Lookup': 'Farbtabelle', 'Colour Lookup': 'Farbtabelle', 'Colour': 'Farbe', 'Threshold': 'Schwellenwert',
  'Posterize': 'Tontrennung', 'Brightness/Contrast': 'Helligkeit/Kontrast', 'Photo Filter': 'Fotofilter', 'Channel Mixer': 'Kanalmixer',
  // Basic
  'Light': 'Licht', 'Presence': 'Präsenz', 'Whites': 'Weiß', 'Blacks': 'Schwarz', 'Texture': 'Struktur', 'Clarity': 'Klarheit',
  'Dehaze': 'Dunst entfernen', 'Vibrance': 'Dynamik', 'Temperature': 'Temperatur', 'Tint': 'Tönung',
  'Double-click the name to reset': 'Doppelklick auf den Namen setzt zurück',
  // Color Lookup
  'This file is not a usable .cube LUT.': 'Diese Datei ist keine verwendbare .cube-Farbtabelle.', 'Untitled LUT': 'Unbenannte Farbtabelle',
  'No LUT loaded': 'Keine Farbtabelle geladen', 'Replace…': 'Ersetzen …', 'Load .cube File…': '.cube-Datei laden …',
  'Interpolation': 'Interpolation', 'Tetrahedral': 'Tetraedrisch', 'Trilinear': 'Trilinear',
  '3D and 1D .cube files (Adobe/Resolve) up to 65 points are supported. The file is stored in the project.':
    '3D- und 1D-.cube-Dateien (Adobe/Resolve) bis 65 Stützstellen werden unterstützt. Die Datei wird im Projekt gespeichert.',
  // Color: Black & White, Color Balance, Selective Color
  'Black & White': 'Schwarzweiß', 'Color Balance': 'Farbbalance', 'Selective Color': 'Selektive Farbkorrektur',
  'Convert to black & white': 'In Schwarzweiß umwandeln', 'Mix the gray from the colors under this layer': 'Graumischung aus den Farben unter dieser Ebene bestimmen',
  'Tinted': 'Farbton', 'Tint color': 'Farbe der Tönung', 'Apply color balance': 'Farbbalance anwenden', 'Tone': 'Ton', 'Midtones': 'Mitteltöne',
  'Cyan': 'Cyan', 'Magenta': 'Magenta', 'Preserve Luminosity': 'Luminanz erhalten', 'Neutrals': 'Neutrale Farben',
  'Method': 'Methode', 'Relative': 'Relativ', 'Absolute': 'Absolut',
  // Photo Filter, Channel Mixer, Threshold, Brightness/Contrast, Invert
  'Warming Filter (85)': 'Warmfilter (85)', 'Warming Filter (LBA)': 'Warmfilter (LBA)', 'Warming Filter (81)': 'Warmfilter (81)',
  'Cooling Filter (80)': 'Kaltfilter (80)', 'Cooling Filter (LBB)': 'Kaltfilter (LBB)', 'Cooling Filter (82)': 'Kaltfilter (82)', 'Sepia': 'Sepia',
  'Filter color': 'Filterfarbe', 'Density': 'Dichte', 'Output Channel': 'Ausgabekanal', 'Monochrome': 'Monochrom', 'Total': 'Gesamt',
  'Above 100 % the channel can clip': 'Über 100 % kann der Kanal beschnitten werden', 'Constant': 'Konstante',
  'Histogram of the pixels under this layer': 'Histogramm der Pixel unter dieser Ebene', 'Threshold Level': 'Schwellenwert',
  'Brightness': 'Helligkeit', 'Use Legacy': 'Früheren Wert verwenden',
  'Invert has no settings: it turns every color into its opposite. Use the layer’s opacity or mask to limit it.':
    'Umkehren hat keine Einstellungen: Jede Farbe wird zu ihrem Gegenteil. Deckkraft oder Maske der Ebene begrenzen die Wirkung.',
  // Filters and smart filters
  'Unsharp Mask': 'Unscharf maskieren', 'Smart Sharpen': 'Selektiver Scharfzeichner', 'High Pass': 'Hochpass', 'Denoise': 'Rauschen reduzieren',
  'Reduce Noise': 'Rauschen reduzieren', 'Luminance': 'Luminanz', 'Color Noise': 'Farbrauschen',
  'Smart Filter': 'Smartfilter', 'Smart Filters': 'Smartfilter', 'Apply Smart Filters': 'Smartfilter anwenden',
  'Clear Smart Filters': 'Alle Smartfilter löschen', 'Edit Smart Filter': 'Smartfilter bearbeiten', 'Hide Smart Filter': 'Smartfilter ausblenden',
  'Show Smart Filter': 'Smartfilter einblenden', 'Delete Smart Filter': 'Smartfilter löschen', 'Hide Smart Filters': 'Alle Smartfilter ausblenden',
  'Show Smart Filters': 'Alle Smartfilter einblenden', 'Reorder Smart Filters': 'Smartfilter neu anordnen',
  'Hide smart filters list': 'Smartfilter-Liste ausblenden', 'Show smart filters list': 'Smartfilter-Liste einblenden',
  'Double-click to edit · Drag to reorder': 'Doppelklick zum Bearbeiten · Ziehen zum Neuordnen',
  'Add Live Filter': 'Smartfilter hinzufügen', 'Edit Live Filter': 'Smartfilter bearbeiten', 'Remove Live Filter': 'Smartfilter löschen',
  'Reorder Live Filters': 'Smartfilter neu anordnen', 'Apply Live Filters': 'Smartfilter anwenden',
  // Brush modes
  'Dodge': 'Abwedler', 'Burn': 'Nachbelichter', 'Sponge': 'Schwamm', 'Flow': 'Fluss',
  'Saturate': 'Sättigung erhöhen', 'Desaturate': 'Sättigung verringern',
  'Drag to dodge': 'Ziehen hellt auf', 'Drag to burn': 'Ziehen dunkelt ab', 'Drag to change saturation': 'Ziehen ändert die Sättigung',
  'Brush mode': 'Pinselmodus',
  '[ ] size · Shift-[ ] hardness · 1–0 exposure · Escape cancel · Space to pan': '[ ] Größe · Umschalt-[ ] Härte · 1–0 Belichtung · Esc abbrechen · Leertaste verschiebt die Ansicht',
  '[ ] size · Shift-[ ] hardness · 1–0 flow · Escape cancel · Space to pan': '[ ] Größe · Umschalt-[ ] Härte · 1–0 Fluss · Esc abbrechen · Leertaste verschiebt die Ansicht',
};

/** English display names where the engine's identifiers differ from the (American English) UI. */
export const ADJUST_P2_EN: Readonly<Record<string, string>> = {
  'Colour Lookup': 'Color Lookup', 'Colour': 'Color',
  // The engine calls Reduce Noise "Denoise"; the menu, panel, smart filter row and History use Photoshop's name.
  'Denoise': 'Reduce Noise',
  'New Colour Lookup Adjustment': 'New Color Lookup Adjustment', 'Edit Colour Lookup Adjustment': 'Edit Color Lookup Adjustment',
  'New Colour Adjustment': 'New Color Adjustment', 'Edit Colour Adjustment': 'Edit Color Adjustment',
  'Add Live Filter': 'Add Smart Filter', 'Edit Live Filter': 'Edit Smart Filter', 'Remove Live Filter': 'Delete Smart Filter',
  'Reorder Live Filters': 'Reorder Smart Filters', 'Apply Live Filters': 'Apply Smart Filters',
};
