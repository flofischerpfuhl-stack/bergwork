/**
 * Installs the Phase-2 adjustment UI: the full New Adjustment Layer list, the Filter menu's live filters, the
 * live filter rows of the Layers panel and their context-menu commands. Called by installAdjustments.
 */

import type { EditorController } from '../../ui/controller';
import type { MenuEntry } from '../../ui/menus';
import { editBlockers, type EditorSession } from '../../core/session';
import type { AdjustmentKind } from '../../core/document';
import { adjustmentCommands, type AdjustmentCommandName } from '../../core/adjust';
import { ADJUSTMENT_MENU, adjustmentName } from './controls';
import { LiveFilterRows, liveFilterLayerItems } from './filterRows';
import { beginNewLiveFilter, canAddLiveFilter, LIVE_FILTER_COMMANDS, LIVE_FILTER_KINDS, liveFilterEditState } from './liveFilters';

const liveFilterOpen = (session: EditorSession) => !!liveFilterEditState(session);

export function installAdjustP2(controller: EditorController): void {
  const t = controller.t;
  controller.adjustmentLayerItems = (withEllipsis) => {
    const session = controller.session;
    return ADJUSTMENT_MENU.map((kind): MenuEntry => kind === 'separator' ? 'separator' : {
      label: `${t(adjustmentName(kind))}${withEllipsis ? '…' : ''}`, enabled: session.canEditLayers,
      testId: `adjustment-kind-${kind.replace(/\W+/g, '-').toLowerCase()}`,
      // The engine accepts every LayerAdjustmentKind; the legacy parameter type lists the first six.
      run: () => session.addAdjustment(kind as AdjustmentKind),
    });
  };

  // Filter menu: the filters go on the layer's live stack. With a selection they stay destructive and limited to it,
  // since a live filter has no filter mask yet.
  const destructive = new WeakMap<EditorSession, ReturnType<typeof adjustmentCommands>>();
  const pixelCommand = (session: EditorSession, name: AdjustmentCommandName) => {
    let registry = destructive.get(session);
    if (!registry) { registry = adjustmentCommands(session); destructive.set(session, registry); }
    return registry[name];
  };
  for (const kind of LIVE_FILTER_KINDS) {
    const name = LIVE_FILTER_COMMANDS[kind] as AdjustmentCommandName;
    controller.features[name] = {
      enabled: () => { const session = controller.session; return session.selection ? pixelCommand(session, name).enabled() : canAddLiveFilter(session); },
      run: () => {
        const session = controller.session;
        if (session.selection) pixelCommand(session, name).run();
        else beginNewLiveFilter(session, kind);
        session.notify('ui');
      },
    };
  }
  if (!editBlockers.includes(liveFilterOpen)) editBlockers.push(liveFilterOpen);
  controller.layerSubRows.push((session, entry) => (entry.layer.filters.length
    ? <LiveFilterRows key={`filters-${entry.layer.id}`} controller={controller} session={session} entry={entry} /> : null));
  controller.layerMenuItems.push((session, id) => liveFilterLayerItems(controller, session, id));
}
