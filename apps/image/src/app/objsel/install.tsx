/**
 * Wires the Object Selection tool, Refine Edge, Quick Mask and Color Range into the editor (PRODUCT-PLAN 6.2).
 * Installed after the other modules: it extends the Brush header and hint while Quick Mask is on.
 */

import type { EditorController } from '../../ui/controller';
import type { ToolHandler } from '../../ui/canvas/tools';
import { editBlockers, type EditorSession } from '../../core/session';
import { selectionState } from '../selectionFeature';
import { ObjectSelectControls, ObjectSelectTool, canSelectSubject, objectToolState, paintObjectDraft, selectSubject } from './objectSelect';
import {
  RefineBrushTool, RefineEdgePanel, cancelRefineEdge, commitRefineEdge, openRefineEdge, paintRefineEdge, refineBlocksEditing, refineState,
} from './refineEdge';
import { QuickMaskBrush, QuickMaskExit, paintQuickMask, quickMaskOn, toggleQuickMask } from './quickMask';
import {
  ColorRangePanel, ColorRangeSampler, cancelColorRange, colorRangeBlocksEditing, colorRangeState, commitColorRange, openColorRange, paintColorRange,
} from './colorRange';

/** While a panel owns the canvas, clicks with other tools do nothing (the hand and zoom still navigate). */
const inert: ToolHandler = { down() {}, move() {}, up() {}, cancel() {}, hover: () => 'default' };
const navigates = (session: EditorSession) => session.tool === 'hand' || session.tool === 'zoom';

export function installObjectSelection(controller: EditorController): void {
  const t = controller.t;
  controller.availableTools.add('objectSelect');
  const objectTool = new ObjectSelectTool(controller);
  controller.canvasSetups.push((view) => {
    view.tools.objectSelect = objectTool;
    view.painters.push((context, session) => paintQuickMask(context, session));
    view.painters.push((context, session) => paintColorRange(context, session));
    view.painters.push((context, session) => paintRefineEdge(controller, context, session, view.hoverPoint));
    view.painters.push((context, session) => paintObjectDraft(context, session));
  });
  controller.objectSelectControls = (session) => <ObjectSelectControls controller={controller} session={session} />;
  controller.statusHints.objectSelect = (session) => (objectToolState(session).kind === 'lasso'
    ? t('Draw a loose lasso around an object · Click an object · Shift add · Option-click removes · ⌘D deselect')
    : t('Click an object · Drag a rectangle around it · Shift add · Option-click removes · ⌘D deselect'));

  // W chooses the slot's last tool; Shift-W cycles Magic Wand and Object Selection (Photoshop's tool group cycle).
  let lastOfSlot: 'wand' | 'objectSelect' = 'wand';
  const wandControls = controller.wandControls;
  if (wandControls) controller.wandControls = (session) => { lastOfSlot = 'wand'; return wandControls(session); };
  const objectControls = controller.objectSelectControls;
  controller.objectSelectControls = (session) => { lastOfSlot = 'objectSelect'; return objectControls(session); };
  controller.toolKeyHandlers.w = (shift) => {
    const session = controller.session, tool = session.tool;
    const inSlot = tool === 'wand' || tool === 'objectSelect';
    const next = shift ? (inSlot ? (tool === 'wand' ? 'objectSelect' : 'wand') : (lastOfSlot === 'wand' ? 'objectSelect' : 'wand')) : inSlot ? tool : lastOfSlot;
    lastOfSlot = next;
    // Shift here chose the tool, not the Add mode the selection header shows while Shift is held.
    if (shift) selectionState(session).heldMode = null;
    session.selectTool(next);
  };

  const s = () => controller.session;
  const f = controller.features;
  f.quickMask = { enabled: () => !!s().document && !refineState(s()) && !colorRangeState(s()), checked: () => quickMaskOn(s()), run: () => toggleQuickMask(s()) };
  f.refineEdge = {
    enabled: () => !!s().selection && !!s().services?.flatten && s().canEditLayers,
    run: () => { if (quickMaskOn(s())) toggleQuickMask(s()); void openRefineEdge(controller); },
  };
  f.colorRange = {
    enabled: () => !!s().document && !!s().services?.flatten && s().canEditLayers,
    run: () => { if (quickMaskOn(s())) toggleQuickMask(s()); void openColorRange(controller); },
  };
  f.selectSubject = { enabled: () => canSelectSubject(controller, s()), run: () => void selectSubject(controller, s()) };
  controller.panels.push(() => <RefineEdgePanel controller={controller} />);
  controller.panels.push(() => <ColorRangePanel controller={controller} />);

  // Ahead of the painting module's Option eyedropper: Option-drag with the Refine Edge brush erases.
  const refineBrush = new RefineBrushTool(controller);
  const sampler = new ColorRangeSampler(controller);
  controller.canvasInterceptors.unshift((session) => {
    const refine = refineState(session);
    if (refine) return navigates(session) ? null : refine.brush ? refineBrush : inert;
    if (colorRangeState(session)) return navigates(session) ? null : sampler;
    return null;
  });
  const quickBrush = new QuickMaskBrush();
  controller.canvasInterceptors.push((session, modifiers) => (quickMaskOn(session) && session.tool === 'brush' && !modifiers.option ? quickBrush : null));

  if (!editBlockers.includes(refineBlocksEditing)) editBlockers.push(refineBlocksEditing);
  if (!editBlockers.includes(colorRangeBlocksEditing)) editBlockers.push(colorRangeBlocksEditing);
  controller.selectionOverlayHidden.push((session) => quickMaskOn(session) || !!refineState(session)?.result
    || !!(colorRangeState(session)?.preview && colorRangeState(session)?.mask));

  // Quick Mask turns the Brush into a mask brush: say so in its header and hint.
  const brushBar = controller.contextBars.brush, brushHint = controller.statusHints.brush;
  if (brushBar) {
    controller.contextBars.brush = (session) => (quickMaskOn(session)
      ? <>{brushBar(session)}<QuickMaskExit controller={controller} session={session} /></> : brushBar(session));
  }
  controller.statusHints.brush = (session) => (quickMaskOn(session)
    ? t('Quick Mask · Paint black to mask, white to select · [ ] size · Q exits') : brushHint?.(session) ?? '');

  controller.keyHandlers.push((event) => {
    const session = controller.session, modified = event.metaKey || event.ctrlKey || event.altKey;
    const refine = refineState(session), range = colorRangeState(session);
    if (refine) {
      if (event.key === 'Escape') { cancelRefineEdge(session); return true; }
      if (event.key === 'Enter') { void commitRefineEdge(controller, session); return true; }
      if (refine.brush && !modified && (event.code === 'BracketLeft' || event.code === 'BracketRight')) {
        const d = refine.brushSize;
        refine.brushSize = Math.min(500, Math.max(1, event.code === 'BracketRight' ? Math.max(d + 1, Math.round(d * 1.2)) : Math.min(d - 1, Math.round(d / 1.2))));
        session.notify('ui');
        controller.canvasView?.redraw();
        return true;
      }
      return false;
    }
    if (range) {
      if (event.key === 'Escape') { cancelColorRange(session); return true; }
      if (event.key === 'Enter') { void commitColorRange(controller, session); return true; }
      return false;
    }
    if (!modified && !event.repeat && event.key.toLowerCase() === 'q' && session.document) { toggleQuickMask(session); return true; }
    return false;
  });
}
