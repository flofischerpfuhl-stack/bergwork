/**
 * UI strings of File › Batch… and the recipes (PRODUCT-PLAN 6.9), merged into the translator by ui/i18n.ts.
 * German follows Photoshop's German UI (Stapelverarbeitung, Ausführen) and the product terms Rezept/Rezepte.
 */

export const BATCH_DE: Readonly<Record<string, string>> = {
  'Batch…': 'Stapelverarbeitung …', 'Batch': 'Stapelverarbeitung', 'Batch export': 'Stapelexport',
  'Recipe': 'Rezept', 'Recipes': 'Rezepte', 'Save Recipe…': 'Rezept speichern …', 'Save Recipe': 'Rezept speichern',
  'Apply Recipe': 'Rezept anwenden', 'Queue': 'Warteschlange', 'Target Folder': 'Zielordner', 'File Names': 'Dateinamen',
  'Progress': 'Fortschritt', 'Failed': 'Fehlgeschlagen', 'Waiting': 'Wartet', 'Processing…': 'Wird verarbeitet …',
  'Exported': 'Exportiert', 'Source': 'Quelle', 'Artboards': 'Zeichenflächen',
  'Add Files…': 'Dateien hinzufügen …', 'Clear Queue': 'Warteschlange leeren', 'Remove from queue': 'Aus der Warteschlange entfernen',
  'Choose Folder…': 'Ordner wählen …', 'No recipe': 'Kein Rezept', 'Run': 'Ausführen', 'Continue': 'Fortsetzen',
  'Retry Failed': 'Fehlgeschlagene wiederholen', 'Cancelling…': 'Wird abgebrochen …',
  '{done} exported · {failed} failed · {pending} waiting': '{done} exportiert · {failed} fehlgeschlagen · {pending} ausstehend',
  '{done} of {total}': '{done} von {total}',
  'Drop images, PSD files or .fwimg projects here, or add them with Add Files….':
    'Bilder, PSD-Dateien oder .fwimg-Projekte hier ablegen oder mit „Dateien hinzufügen …“ wählen.',
  'This document has no artboards.': 'Dieses Dokument hat keine Zeichenflächen.',
  'This document has no layers to export.': 'Dieses Dokument hat keine Ebenen zum Exportieren.',
  'Open a document to export its artboards or layers.': 'Öffne ein Dokument, um seine Zeichenflächen oder Ebenen zu exportieren.',
  'Choose a target folder.': 'Wähle einen Zielordner.', 'The queue is empty.': 'Die Warteschlange ist leer.',
  'This browser saves the files as one ZIP archive.': 'Dieser Browser sichert die Dateien als ein ZIP-Archiv.',
  '{name} = file name · {index} = number · {w} × {h} = pixel size': '{name} = Dateiname · {index} = Nummer · {w} × {h} = Pixelmaße',
  'Add {name} or {index} so that every file gets its own name.': 'Füge {name} oder {index} hinzu, damit jede Datei einen eigenen Namen bekommt.',
  'Steps': 'Schritte', '1 step': '1 Schritt', '{n} steps': '{n} Schritte',
  'Crop to aspect ratio': 'Auf Seitenverhältnis zuschneiden', 'Long edge': 'Lange Kante', 'Export settings': 'Exporteinstellungen',
  'Crop {w}:{h}': 'Zuschnitt {w}:{h}', 'Long edge {n} px': 'Lange Kante {n} px', 'Width {n} px': 'Breite {n} px', 'Height {n} px': 'Höhe {n} px',
  'Used by Batch: crop, size and export settings.': 'Für die Stapelverarbeitung: Zuschnitt, Größe und Exporteinstellungen.',
  'This layer has no adjustments, filters or layer style to save.': 'Diese Ebene hat keine Einstellungen, Filter oder Ebenenstile zum Speichern.',
  'Apply to Files…': 'Auf Dateien anwenden …', 'Manage Recipes…': 'Rezepte verwalten …', 'Export…': 'Exportieren …', 'Import…': 'Importieren …',
  'No recipes yet': 'Noch keine Rezepte',
  'Save the adjustments, filters and layer style of a layer as a recipe, then apply it to other layers or files.':
    'Speichere die Einstellungen, Filter und den Ebenenstil einer Ebene als Rezept und wende es auf andere Ebenen oder Dateien an.',
  'Double-click to rename': 'Doppelklick zum Umbenennen', 'Apply to selected layers': 'Auf ausgewählte Ebenen anwenden',
  'Select layers to apply a recipe.': 'Wähle Ebenen aus, um ein Rezept anzuwenden.',
  'This file is not a Fernwork recipe.': 'Diese Datei ist kein Fernwork-Rezept.',
  'This recipe was saved by a newer version and cannot be used here.': 'Dieses Rezept wurde mit einer neueren Version gesichert und kann hier nicht verwendet werden.',
  'The recipe is damaged.': 'Das Rezept ist beschädigt.',
  'The recipe contains a step this version cannot use.': 'Das Rezept enthält einen Schritt, den diese Version nicht verwenden kann.',
  'The recipe is empty.': 'Das Rezept ist leer.', 'The recipe could not be applied.': 'Das Rezept konnte nicht angewendet werden.',
  'Recipes apply to image, shape, text and embedded layers.': 'Rezepte gelten für Bild-, Form-, Text- und eingebettete Ebenen.',
  'The layer is locked.': 'Die Ebene ist gesperrt.', 'Some layers were not changed': 'Einige Ebenen wurden nicht geändert',
  'The recipe could not be imported': 'Das Rezept konnte nicht importiert werden',
  'The recipe library could not be stored. It stays available until the app is closed.':
    'Die Rezeptbibliothek konnte nicht gespeichert werden. Sie bleibt verfügbar, bis die App geschlossen wird.',
  'This host cannot write into folders.': 'Dieser Host kann nicht in Ordner schreiben.',
};
