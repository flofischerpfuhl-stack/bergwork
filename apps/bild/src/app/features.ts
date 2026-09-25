/**
 * Wires feature modules (selection, painting, adjustments, canvas operations…) into the editor UI.
 * Each module registers its menu commands, canvas tools and panels here.
 */

import type { EditorController } from '../ui/controller';
import { installCanvasOps } from './canvasOpsFeature';
import { installSelection } from './selectionFeature';
import { installPainting } from './paintingFeature';
import { installRetouch } from './retouchFeature';
import { installAdjustments } from './adjustmentsFeature';
import { installSubject } from './subjectFeature';
import { installGuides } from './guidesFeature';
import { installLayerStyles } from './layerStylesFeature';
import { installArtboards } from './artboardFeature';
import { installText } from './textFeature';
import { installVector } from './vectorFeature';
import { installEmbedded } from './embeddedFeature';
import { installColor } from './color/colorFeature';
import { installObjectSelection } from './objsel/install';
import { installWarp } from './warpFeature';
import { installRaw } from './rawFeature';
import { installGenAi } from './genaiFeature';
import { installBatch } from './batch/install';
import type { EditorProfile } from './profiles';

export function installFeatures(controller: EditorController, profile: EditorProfile = controller.profile): void {
  installEmbedded(controller);
  installRaw(controller);
  const enabled = new Set(profile.modules);
  if (enabled.has('canvas')) installCanvasOps(controller);
  if (enabled.has('selection')) installSelection(controller);
  if (enabled.has('painting')) installPainting(controller);
  if (enabled.has('retouch')) installRetouch(controller);
  if (enabled.has('adjustments')) installAdjustments(controller);
  if (enabled.has('subject')) installSubject(controller);
  if (enabled.has('guides')) installGuides(controller);
  if (enabled.has('styles')) installLayerStyles(controller);
  if (enabled.has('artboards')) installArtboards(controller);
  if (enabled.has('text')) installText(controller);
  if (enabled.has('vector')) installVector(controller);
  if (enabled.has('color')) installColor(controller);
  installWarp(controller);
  installGenAi(controller);
  if (enabled.has('automation')) installBatch(controller);
  // Last: it extends the Brush header while Quick Mask is on.
  if (enabled.has('selection')) installObjectSelection(controller);
  const tools = new Set(profile.tools);
  for (const tool of controller.availableTools) if (!tools.has(tool)) controller.availableTools.delete(tool);
}
