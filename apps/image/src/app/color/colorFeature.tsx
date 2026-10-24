/**
 * Colour module (PRODUCT-PLAN 6.1/6.4): the Colour side-panel tab, the colour picker's extra rows, the armed canvas
 * eyedropper (screen-eyedropper fallback) and swatch drops onto shape and text layers.
 */

import type { EditorController } from '../../ui/controller';
import type { ToolHandler } from '../../ui/canvas/tools';
import type { CanvasView } from '../../ui/canvas/CanvasView';
import type { EditorSession } from '../../core/session';
import type { RGB } from '../../core/model/types';
import { containsPoint, type Point } from '../../core/geometry';
import { validSwatchColor } from '../../core/color/swatches';
import { noteColorUsed } from '../../core/color/recent';
import { setVectorStyle } from '../../core/vector/commands';
import { sampleComposite } from '../paintingFeature';
import { colorState } from './state';
import { ColorPanel, PickerExtras, SWATCH_MIME } from './ColorPanel';

/** The topmost visible shape or text layer under a document point. */
export function fillableLayerAt(session: EditorSession, point: Point) {
  const layers = session.document?.layers ?? [];
  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = layers[i]!;
    if (!layer.visible || (layer.kind !== 'vector' && layer.kind !== 'text')) continue;
    if (containsPoint(session.displayedTransform(layer), point)) return layer;
  }
  return null;
}

/** Photoshop: dropping a swatch on a shape fills it; on a text layer it colours all of its text. One undo step. */
export function applySwatchToLayer(session: EditorSession, layerId: string, color: RGB): boolean {
  const layer = session.layer(layerId);
  if (!layer || !session.canEditLayers) return false;
  const plain = { red: color.red, green: color.green, blue: color.blue };
  let applied = false;
  if (layer.kind === 'vector') {
    applied = setVectorStyle(session, layer.id, { ...layer.style, fill: { kind: 'solid', schemaVersion: 1, color: plain } });
  } else if (layer.kind === 'text' && layer.text.length && !session.refuseLayerEdit(layer.id, 'appearance')) {
    session.edit('Set Text Color', () => session.applyTextStyle(layer.id, 0, layer.text.length, { color: { ...plain, alpha: 1 } }));
    applied = true;
  }
  if (applied) noteColorUsed(session, plain);
  return applied;
}

function readDroppedColor(transfer: DataTransfer | null): RGB | null {
  if (!transfer) return null;
  try {
    const value: unknown = JSON.parse(transfer.getData(SWATCH_MIME));
    return validSwatchColor(value) ? value : null;
  } catch { return null; }
}

function installSwatchDrop(controller: EditorController, view: CanvasView): void {
  const element = view.element;
  element.addEventListener('dragover', (event) => {
    if (!event.dataTransfer || ![...event.dataTransfer.types].includes(SWATCH_MIME)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'copy';
  });
  element.addEventListener('drop', (event) => {
    if (!event.dataTransfer || ![...event.dataTransfer.types].includes(SWATCH_MIME)) return;
    event.preventDefault();
    event.stopPropagation();
    const color = readDroppedColor(event.dataTransfer);
    const session = controller.session, document = session.document;
    if (!color || !document) return;
    const rect = (element.parentElement ?? element).getBoundingClientRect();
    const point = session.viewport.documentPoint({ x: event.clientX - rect.left, y: event.clientY - rect.top }, document);
    const layer = fillableLayerAt(session, point);
    if (layer) applySwatchToLayer(session, layer.id, color);
  });
}

/** One canvas click after the panel's eyedropper fell back to the canvas: samples into the panel's chip. */
class ArmedCanvasPick implements ToolHandler {
  constructor(private readonly controller: EditorController) {}
  private sample(point: Point): void {
    const color = sampleComposite(this.controller, point);
    const session = this.controller.session;
    if (color && session.canEditPalette) session.setPaletteColor(color, colorState(this.controller).getState().target === 'background');
  }
  down(c: Parameters<ToolHandler['down']>[0]): void { this.sample(c.pixel); }
  move(c: Parameters<ToolHandler['move']>[0]): void { this.sample(c.pixel); }
  up(): void { colorState(this.controller).setState({ canvasPickArmed: false }); }
  cancel(): void { colorState(this.controller).setState({ canvasPickArmed: false }); }
  hover(): string { return 'crosshair'; }
}

export function installColor(controller: EditorController): void {
  const store = colorState(controller);
  controller.sidePanels.push({ id: 'color', label: controller.t('Color'), render: () => <ColorPanel controller={controller} /> });
  controller.colorPickerExtras = (color, set) => <PickerExtras controller={controller} color={color} set={set} />;
  const armed = new ArmedCanvasPick(controller);
  controller.canvasInterceptors.push(() => (store.getState().canvasPickArmed ? armed : null));
  controller.keyHandlers.push((event) => {
    if (event.key !== 'Escape' || !store.getState().canvasPickArmed) return false;
    store.setState({ canvasPickArmed: false });
    return true;
  });
  controller.canvasSetups.push((view) => installSwatchDrop(controller, view));
}
