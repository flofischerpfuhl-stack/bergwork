/**
 * Wires feature modules (selection, painting, adjustments, canvas operations…) into the editor UI.
 * Each module registers its menu commands, canvas tools and panels here.
 */

import type { EditorController } from '../ui/controller';
import { installCanvasOps } from './canvasOpsFeature';
import { installSelection } from './selectionFeature';

export function installFeatures(controller: EditorController): void {
  installCanvasOps(controller);
  installSelection(controller);
}
