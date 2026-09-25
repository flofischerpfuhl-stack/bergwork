/**
 * The menu bar and its keyboard shortcuts, ported from CompositorApp.swift's command groups.
 * Items whose feature has not been ported are listed disabled with an explanation rather than
 * silently missing or pretending to work.
 */

import { ADJUSTMENT_KINDS } from '../core/document';
import type { EditorController } from './controller';
import { profileHasFeature } from '../app/profiles';

export interface MenuItem {
  label: string;
  /** Shortcut in the form 'mod+shift+z' (mod = ⌘ on macOS, Ctrl elsewhere). */
  shortcut?: string;
  /** Further shortcuts for the same command, not shown (e.g. ⌘N, which browsers keep but desktop shells pass on). */
  aliases?: string[];
  enabled: boolean;
  checked?: boolean;
  run?: () => void;
  submenu?: MenuEntry[];
  note?: string;
  testId?: string;
}
export type MenuEntry = MenuItem | 'separator';
export interface Menu { title: string; items: MenuEntry[] }

/** Features whose module is registered at runtime (selection, brushes, adjustments…). */
export interface FeatureRegistry {
  [command: string]: { enabled: () => boolean; run: () => void; checked?: () => boolean } | undefined;
}

export function buildMenus(controller: EditorController, features: FeatureRegistry): Menu[] {
  const t = controller.t;
  const session = controller.session;
  const document = session.document;
  const canStart = controller.workspace.canSwitch;
  const layer = session.activeLayer;
  const pending = t('Not yet available in the browser port');
  const feature = (key: string, label: string, shortcut?: string): MenuItem => {
    const f = features[key];
    return f ? { label, shortcut, enabled: f.enabled(), run: f.run, checked: f.checked?.() } : { label, shortcut, enabled: false, note: pending };
  };
  const mergePlan = session.mergePlan();
  return [
    {
      title: t('File'),
      items: [
        { label: t('New Canvas…'), shortcut: 'mod+alt+n', aliases: ['mod+n'], enabled: canStart, run: () => { controller.workspace.newCanvas(); }, testId: 'menu-new-canvas' },
        { label: t('Open Project…'), shortcut: 'mod+o', enabled: canStart, run: () => void controller.chooseAndOpen() },
        { label: t('Open Mac Project Folder (.comp)…'), enabled: canStart, run: () => void controller.chooseCompFolder() },
        { label: t('Import Images…'), enabled: !session.isImporting && !session.isProjectBusy, run: () => void controller.chooseAndImport(), testId: 'menu-import' },
        feature('placeEmbedded', t('Place Embedded…')),
        feature('placeLinked', t('Place Linked…')),
        'separator',
        { label: t('Save'), shortcut: 'mod+s', enabled: !!document && canStart, run: () => void controller.save(), testId: 'menu-save' },
        { label: t('Save As…'), shortcut: 'mod+shift+s', enabled: !!document && canStart, run: () => void controller.save(true) },
        'separator',
        // The one export path (P4): Photoshop's Export As shortcut, plus this editor's earlier export shortcuts.
        { label: t('Export As…'), shortcut: 'mod+alt+shift+w', aliases: ['mod+shift+e', 'mod+alt+shift+s'], enabled: !!document && canStart,
          run: () => controller.showDialog({ kind: 'export' }), testId: 'menu-export' },
        'separator',
        { label: t('Close Project'), shortcut: 'mod+alt+w', aliases: ['mod+w'], enabled: canStart, run: () => void controller.closeTab(controller.workspace.selectedId) },
      ],
    },
    {
      title: t('Edit'),
      items: [
        { label: session.history.canUndo ? `${t('Undo')} ${t(session.history.undoName)}` : t('Undo'), shortcut: 'mod+z', enabled: session.canUndo, run: () => session.undo(), testId: 'menu-undo' },
        { label: session.history.canRedo ? `${t('Redo')} ${t(session.history.redoName)}` : t('Redo'), shortcut: 'mod+shift+z', enabled: session.canRedo, run: () => session.redo(), testId: 'menu-redo' },
        'separator',
        feature('cut', t('Cut'), 'mod+x'),
        feature('copy', t('Copy'), 'mod+c'),
        feature('copyMerged', t('Copy Merged'), 'mod+shift+c'),
        feature('paste', t('Paste'), 'mod+v'),
        'separator',
        feature('fillForeground', t('Fill with Foreground Color'), 'alt+backspace'),
        feature('fillBackground', t('Fill with Background Color'), 'mod+backspace'),
        feature('clearSelection', t('Clear Selection Pixels')),
        feature('contentAwareFill', t('Content-Aware Fill…'), 'shift+backspace'),
        'separator',
        feature('fillPath', t('Fill Path')),
        feature('strokePath', t('Stroke Path')),
      ],
    },
    {
      title: t('Select'),
      items: [
        feature('selectAll', t('All'), 'mod+a'),
        feature('deselect', t('Deselect'), 'mod+d'),
        feature('inverse', t('Inverse'), 'mod+shift+i'),
        feature('loadLayerSelection', t("Layer's Pixels")),
        feature('loadMaskSelection', t("Mask's Black Areas")),
        feature('selectionFromPath', t('Load Selection from Path')),
        'separator',
        feature('colorRange', t('Color Range…')),
        feature('selectSubject', t('Subject')),
        'separator',
        feature('refineEdge', t('Refine Edge…'), 'mod+alt+r'),
        'separator',
        feature('expandSelection', `${t('Expand')}…`),
        feature('contractSelection', `${t('Contract')}…`),
        'separator',
        feature('quickMask', t('Edit in Quick Mask Mode')),
      ],
    },
    {
      title: t('Image'),
      items: [
        feature('curves', t('Curves…'), 'mod+m'),
        feature('levels', t('Levels…'), 'mod+l'),
        feature('hueSaturation', t('Hue/Saturation…'), 'mod+u'),
        feature('exposure', t('Exposure…')),
        feature('gradientMap', t('Gradient Map…')),
        feature('grain', t('Grain…')),
        feature('invert', session.isMaskSelected ? t('Invert Mask') : t('Invert'), 'mod+i'),
        'separator',
        feature('canvasSize', t('Canvas Size…'), 'mod+alt+c'),
        feature('imageSize', t('Image Size…'), 'mod+alt+i'),
        'separator',
        { label: t('Flip Canvas Horizontal'), enabled: session.canEditLayers, run: () => session.flipCanvas(true, controller.mirrorSelection ? (d) => controller.mirrorSelection!(d, true) : undefined) },
        { label: t('Flip Canvas Vertical'), enabled: session.canEditLayers, run: () => session.flipCanvas(false, controller.mirrorSelection ? (d) => controller.mirrorSelection!(d, false) : undefined) },
      ],
    },
    {
      title: t('Filter'),
      items: [
        feature('gaussianBlur', `${t('Gaussian Blur')}…`),
        feature('motionBlur', `${t('Motion Blur')}…`),
        feature('lensCorrection', `${t('Lens Correction')}…`),
        'separator',
        feature('noise', `${t('Add Noise')}…`),
        feature('denoise', `${t('Reduce Noise')}…`),
        'separator',
        feature('unsharpMask', `${t('Unsharp Mask')}…`),
        feature('smartSharpen', `${t('Smart Sharpen')}…`),
        feature('highPass', `${t('High Pass')}…`),
        'separator',
        feature('removeBackground', `${t('Remove Background')}…`),
      ],
    },
    {
      title: t('Layer'),
      items: [
        {
          label: t('New Adjustment Layer'), enabled: session.canEditLayers && !!document,
          submenu: controller.adjustmentLayerItems?.(true)
            ?? ADJUSTMENT_KINDS.map((kind) => ({ label: `${t(kind)}…`, enabled: session.canEditLayers, run: () => session.addAdjustment(kind) })),
        },
        feature('editAdjustment', t('Edit Adjustment…')),
        feature('editEmbedded', t('Edit Contents')),
        feature('replaceEmbedded', t('Replace Contents…')),
        feature('relinkEmbedded', t('Relink…')),
        feature('refreshLinked', t('Update Linked Content')),
        feature('convertEmbeddedPixels', t('Convert to Pixels')),
        feature('convertToEmbedded', t('Convert to Embedded')),
        'separator',
        { label: t('Transform Layer'), shortcut: 'mod+t', enabled: session.canTransform, run: () => { features.transformCommand ? features.transformCommand.run() : session.beginTransform(); } },
        { label: session.selection ? t('Layer via Copy') : t('Duplicate Layer'), shortcut: 'mod+j',
          enabled: session.selection ? !!features.layerViaCopy?.enabled() : session.canEditLayers && !!layer && layer.kind !== 'group',
          run: () => { if (session.selection && features.layerViaCopy) features.layerViaCopy.run(); else session.duplicateActiveLayer(); } },
        'separator',
        { label: layer?.maskSourceId ? t('Release Clipping Mask') : t('Create Clipping Mask'), shortcut: 'mod+alt+g',
          enabled: !!layer && session.canToggleClippingMask(layer.id), run: () => layer && session.toggleClippingMask(layer.id) },
        controller.layerStyles
          ? { label: t('Layer Style'), enabled: !!layer && controller.layerStyles.styleable(layer.id), testId: 'menu-layer-style',
            submenu: layer ? controller.layerStyles.menu(layer.id) : [] }
          : { label: t('Layer Style'), enabled: false, note: pending },
        { label: t('Layer Mask'), enabled: !!layer && session.canEditMask && !layer.mask, testId: 'menu-layer-mask', submenu: [
          { label: t('Reveal All'), enabled: !session.selection, run: () => controller.addMask(true) },
          { label: t('Hide All'), enabled: !session.selection, run: () => controller.addMask(false) },
          { label: t('Reveal Selection'), enabled: !!session.selection, run: () => controller.addMask(true) },
          { label: t('Hide Selection'), enabled: !!session.selection, run: () => controller.addMask(false) },
        ] },
        { label: t('Vector Mask'), enabled: !!features.vectorMaskRevealAll && !!layer, testId: 'menu-vector-mask', submenu: [
          feature('vectorMaskRevealAll', t('Reveal All')), feature('vectorMaskHideAll', t('Hide All')), feature('vectorMaskCurrentPath', t('Current Path')),
          'separator', feature('vectorMaskToggle', layer?.vectorMask?.enabled === false ? t('Enable Vector Mask') : t('Disable Vector Mask')),
          feature('vectorMaskDelete', t('Delete Vector Mask')),
        ] },
        { label: t('Combine Shapes'), enabled: !!features.mergeShapes, testId: 'menu-combine-shapes', submenu: [
          feature('combineUnite', t('Unite Shapes')), feature('combineSubtract', t('Subtract Front Shape')),
          feature('combineIntersect', t('Intersect Shape Areas')), feature('combineExclude', t('Exclude Overlapping Shapes')),
          'separator', feature('mergeShapes', t('Merge Shapes')),
        ] },
        'separator',
        { label: t('Group Selected Layers'), shortcut: 'mod+g', enabled: session.canEditLayers && !!document, run: () => session.groupSelectedLayers() },
        { label: t('Move Out of Folder'), enabled: session.canEditLayers && !!layer?.parentId, run: () => session.moveActiveLayerOutOfGroup() },
        { label: t('New Blank Layer'), shortcut: 'mod+shift+n', enabled: session.canEditLayers, run: () => session.addBlankLayer(), testId: 'menu-new-layer' },
        { label: t('Rename Layer…'), enabled: session.canEditLayers && !!layer, run: () => layer && controller.showDialog({ kind: 'rename', layerId: layer.id }) },
        { label: layer?.visible === false ? t('Show Layer') : t('Hide Layer'), enabled: session.canEditLayers && !!layer, run: () => layer && session.toggleLayerVisibility(layer.id) },
        'separator',
        { label: t('Move Layer Up'), shortcut: 'mod+]', enabled: session.canMoveActiveLayer(1), run: () => session.moveActiveLayer(1) },
        { label: t('Move Layer Down'), shortcut: 'mod+[', enabled: session.canMoveActiveLayer(-1), run: () => session.moveActiveLayer(-1) },
        { label: t(mergePlan?.action ?? 'Merge Down'), shortcut: 'mod+e', enabled: !!mergePlan, run: () => void controller.mergeLayers() },
        'separator',
        { label: t('Align'), enabled: !!features['align-left']?.enabled(), submenu: [
          feature('align-left', t('Left Edges')), feature('align-hcenter', t('Horizontal Centers')), feature('align-right', t('Right Edges')),
          feature('align-top', t('Top Edges')), feature('align-vcenter', t('Vertical Centers')), feature('align-bottom', t('Bottom Edges')),
        ] },
        { label: t('Distribute'), enabled: !!features['distribute-hcenters']?.enabled(), submenu: [
          feature('distribute-hcenters', t('Horizontal Centers')), feature('distribute-vcenters', t('Vertical Centers')),
          feature('distribute-hspacing', t('Horizontal Spacing')), feature('distribute-vspacing', t('Vertical Spacing')),
        ] },
        'separator',
        { label: t('Flip Layer Horizontal'), enabled: session.canTransform, run: () => session.flipLayers(true) },
        { label: t('Flip Layer Vertical'), enabled: session.canTransform, run: () => session.flipLayers(false) },
        'separator',
        { label: session.isMaskSelected && layer?.mask ? t('Delete Layer Mask') : session.selectedLayerIds.size > 1 ? t('Delete Layers') : t('Delete Layer'),
          enabled: session.canEditLayers && !!layer, run: () => void session.deleteLayerOrMask() },
      ],
    },
    {
      title: t('View'),
      items: [
        { label: t('Fit Canvas'), shortcut: 'mod+0', enabled: !!document, run: () => session.fit() },
        { label: t('Actual Pixels'), shortcut: 'mod+1', enabled: !!document, run: () => session.zoomTo(1) },
        { label: t('Zoom In'), shortcut: 'mod+=', enabled: !!document, run: () => session.zoomTo(session.viewport.zoom * 1.25) },
        { label: t('Zoom Out'), shortcut: 'mod+-', enabled: !!document, run: () => session.zoomTo(session.viewport.zoom / 1.25) },
        'separator',
        { label: t('Pixel Grid (800% and above)'), enabled: true, checked: session.showsPixelGrid, run: () => { session.showsPixelGrid = !session.showsPixelGrid; session.notify('view'); } },
        ...(profileHasFeature(controller.profile, 'softproof', controller.capabilities) ? [
          'separator' as const,
          { label: t('Proof Setup…'), enabled: !!document, run: () => controller.showDialog({ kind: 'proofSetup' }), testId: 'menu-proof-setup' },
          { label: t('Proof Colors'), shortcut: 'mod+y', enabled: !!document, checked: session.proofColors,
            run: () => { void controller.toggleProofColors(); }, testId: 'menu-proof-colors' },
          { label: t('Gamut Warning'), shortcut: 'mod+shift+y', enabled: !!document, checked: session.gamutWarning,
            run: () => { void controller.toggleGamutWarning(); }, testId: 'menu-gamut-warning' },
        ] satisfies MenuEntry[] : []),
        feature('toggleRulers', t('Rulers'), 'mod+r'),
        feature('toggleGuides', t('Show Guides'), 'mod+;'),
        feature('snapToGuides', t('Snap to Guides')),
        feature('lockGuides', t('Lock Guides'), 'mod+alt+;'),
        feature('newGuide', t('New Guide…')),
        feature('clearGuides', t('Clear Guides')),
        'separator',
        { label: t('Show Transform Controls'), shortcut: 'mod+h', enabled: session.tool === 'move' && !!document, checked: session.showsTransformControls,
          run: () => { session.showsTransformControls = !session.showsTransformControls; session.notify('document'); } },
      ],
    },
    {
      title: t('Help'),
      items: [
        { label: t('About Fernwork Image Editor'), enabled: true, run: () => controller.showAbout(), testId: 'menu-about' },
      ],
    },
  ];
}

/** Flattens menus into shortcut → item, for the key handler. */
export function shortcutMap(menus: Menu[]): Map<string, MenuItem> {
  const map = new Map<string, MenuItem>();
  const visit = (items: MenuEntry[]) => {
    for (const item of items) {
      if (item === 'separator') continue;
      if (item.shortcut) map.set(item.shortcut, item);
      for (const alias of item.aliases ?? []) map.set(alias, item);
      if (item.submenu) visit(item.submenu);
    }
  };
  for (const menu of menus) visit(menu.items);
  return map;
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** Normalises a keyboard event to the shortcut notation. */
export function shortcutOf(event: KeyboardEvent): string {
  const parts: string[] = [];
  if (isMac ? event.metaKey : event.ctrlKey) parts.push('mod');
  if (event.altKey) parts.push('alt');
  if (event.shiftKey) parts.push('shift');
  let key = event.key.toLowerCase();
  if (event.code.startsWith('Key')) key = event.code.slice(3).toLowerCase();
  else if (event.code.startsWith('Digit')) key = event.code.slice(5);
  else if (event.code === 'BracketRight') key = ']';
  else if (event.code === 'BracketLeft') key = '[';
  else if (event.code === 'Equal') key = '=';
  else if (event.code === 'Minus') key = '-';
  else if (key === 'delete') key = 'backspace';
  parts.push(key);
  return parts.join('+');
}

/** Human-readable shortcut, with macOS symbols on Apple platforms. */
let labelLocale: 'de' | 'en' = 'en';
/** Key names as the keyboard labels them in the UI language (German keyboards: Strg, Umschalt, Rücktaste). */
export function setShortcutLocale(locale: 'de' | 'en'): void { labelLocale = locale; }

export function shortcutLabel(shortcut: string): string {
  const parts = shortcut.split('+');
  const key = parts.pop()!;
  const names: Record<string, string> = isMac
    ? { mod: '⌘', alt: '⌥', shift: '⇧', backspace: '⌫' }
    : labelLocale === 'de'
      ? { mod: 'Strg+', alt: 'Alt+', shift: 'Umschalt+', backspace: 'Rücktaste' }
      : { mod: 'Ctrl+', alt: 'Alt+', shift: 'Shift+', backspace: 'Backspace' };
  const order = isMac ? ['alt', 'shift', 'mod'] : ['mod', 'alt', 'shift'];
  const mods = order.filter((m) => parts.includes(m)).map((m) => names[m]).join('');
  return mods + (names[key] ?? key.toUpperCase());
}
