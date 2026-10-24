/**
 * UI strings of the Object Selection tool, Refine Edge, Quick Mask and Color Range (PRODUCT-PLAN 6.2), merged into
 * the translator by ui/i18n.ts. German follows Photoshop's German UI; our single workspace „Kante verfeinern“ replaces
 * „Auswählen und maskieren“.
 */

import type { EditorController } from '../../ui/controller';

export const OBJSEL_DE: Readonly<Record<string, string>> = {
  // Object Selection tool
  'Object Selection Tool (Shift-W)': 'Objektauswahlwerkzeug (Umschalt-W)', 'Object Selection Tool': 'Objektauswahlwerkzeug',
  'Object Selection': 'Objektauswahl', 'Object mode': 'Objektsuchmodus', 'Download model': 'Modell herunterladen',
  'The object selection model runs on this device. It is downloaded once and then works offline.':
    'Das Modell für die Objektauswahl läuft auf diesem Gerät. Es wird einmal heruntergeladen und funktioniert danach offline.',
  'Loading the model…': 'Modell wird gestartet …', 'Analyzing the image…': 'Bild wird analysiert …',
  'Finding the object…': 'Objekt wird gesucht …', 'Select Subject': 'Motiv auswählen', 'Subject': 'Motiv',
  'Object selection needs a pixel layer.': 'Die Objektauswahl braucht eine Pixelebene.',
  'Download the model to select objects.': 'Lade das Modell herunter, um Objekte auszuwählen.',
  'Click an object · Drag a rectangle around it · Shift add · Option-click removes · ⌘D deselect':
    'Objekt anklicken · Rechteck darum ziehen · Umschalt fügt hinzu · Alt-Klick entfernt · ⌘D hebt auf',
  'Draw a loose lasso around an object · Click an object · Shift add · Option-click removes · ⌘D deselect':
    'Groben Lasso um ein Objekt ziehen · Objekt anklicken · Umschalt fügt hinzu · Alt-Klick entfernt · ⌘D hebt auf',
  // Refine Edge
  'Refine Edge…': 'Kante verfeinern …', 'Refine Edge': 'Kante verfeinern', 'On Black': 'Auf Schwarz', 'On White': 'Auf Weiß',
  'Black & White': 'Schwarzweiß', 'On Layers': 'Auf Ebenen', 'Edge Detection': 'Kantenerkennung', 'Smart Radius': 'Smartradius',
  'Global Refinements': 'Globale Verbesserungen', 'Feather': 'Weiche Kante', 'Output Settings': 'Ausgabeeinstellungen',
  'Decontaminate Colors': 'Farben dekontaminieren', 'Output To': 'Ausgabe an', 'Layer Mask': 'Ebenenmaske',
  'New Layer with Layer Mask': 'Neue Ebene mit Ebenenmaske', 'Refine Edge Brush': 'Kante-verbessern-Pinsel',
  'Paint over hair and fur to recompute their edge · Option-drag erases · [ ] size':
    'Über Haare und Fell malen, um ihre Kante neu zu berechnen · Alt-Ziehen löscht · [ ] Größe',
  'Updating the preview…': 'Vorschau wird berechnet …', 'Decontaminating colors needs a new layer.': 'Farben dekontaminieren braucht eine neue Ebene.',
  'Refine Layer Mask': 'Ebenenmaske verfeinern', 'New Layer from Refine Edge': 'Neue Ebene aus „Kante verfeinern“',
  'New Layer with Refined Mask': 'Neue Ebene mit verfeinerter Maske',
  // Quick Mask
  'Edit in Quick Mask Mode': 'Im Maskierungsmodus bearbeiten', 'Quick Mask': 'Maskierungsmodus',
  'Quick Mask · Paint black to mask, white to select · [ ] size · Q exits':
    'Maskierungsmodus · Schwarz malen maskiert, Weiß wählt aus · [ ] Größe · Q beendet',
  'Exit Quick Mask (Q)': 'Maskierungsmodus beenden (Q)',
  // Color Range
  'Color Range…': 'Farbbereich …', 'Color Range': 'Farbbereich', 'Colour Range': 'Farbbereich', 'Sampled Colors': 'Aufgenommene Farben',
  'Skin Tones': 'Hauttöne', 'Fuzziness': 'Toleranz', 'Localized Color Clusters': 'Lokalisierte Farbgruppen',
  'Click the canvas to sample a color · Shift-click adds a color': 'Klicke auf die Leinwand, um eine Farbe aufzunehmen · Umschalt-Klick fügt eine Farbe hinzu',
  'Clear samples': 'Aufnahmen löschen', 'Samples': 'Aufnahmen',
};

/** Words whose German differs in these panels from the rest of the editor (Overlay is a blend mode elsewhere). */
const CONTEXT_DE: Readonly<Record<string, string>> = { 'Smooth': 'Abrunden', 'Overlay': 'Überlagerung', 'Select': 'Auswählen' };

export function panelTranslator(controller: EditorController): (text: string) => string {
  return (text) => (controller.locale === 'de' ? CONTEXT_DE[text] ?? controller.t(text) : controller.t(text));
}
