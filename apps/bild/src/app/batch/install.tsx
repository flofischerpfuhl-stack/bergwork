/**
 * Automation module (PRODUCT-PLAN 6.9, deliberately narrow): File › Batch…, Layer › Save Recipe… / Apply Recipe and
 * the small, movable Recipes panel (Apply Recipe › Manage Recipes…). No recorded actions or scripting (Phase 4).
 * The batch dialog loads on first use.
 */

import { lazy, Suspense } from 'react';
import { useStore } from 'zustand';
import type { EditorController } from '../../ui/controller';
import { recipeLibrary, showRecipesPanel } from './library';
import type { MenuEntry } from '../../ui/menus';

// Everything but the menu entries loads on first use (A10: the start chunk only gets this module and the library).
const BatchDialog = lazy(async () => ({ default: (await import('./BatchDialog')).BatchDialog }));
const SaveRecipeDialog = lazy(async () => ({ default: (await import('./SaveRecipeDialog')).SaveRecipeDialog }));
const RecipesPanel = lazy(async () => ({ default: (await import('./RecipesPanel')).RecipesPanel }));

function RecipesPanelHost({ controller }: { controller: EditorController }) {
  const open = useStore(recipeLibrary(controller), (state) => state.panelOpen);
  return open ? <Suspense fallback={null}><RecipesPanel controller={controller} /></Suspense> : null;
}

export function installBatch(controller: EditorController): void {
  const t = controller.t;
  controller.features.batch = {
    enabled: () => controller.workspace.canSwitch,
    run: () => controller.showDialog({ kind: 'custom', name: 'batch' }),
  };
  controller.features.saveRecipe = {
    enabled: () => !!controller.session.document && !!controller.session.activeLayerId,
    run: () => controller.showDialog({ kind: 'custom', name: 'saveRecipe' }),
  };
  controller.dialogs.batch = (close) => <Suspense fallback={null}><BatchDialog controller={controller} close={close} /></Suspense>;
  controller.dialogs.saveRecipe = (close) => <Suspense fallback={null}><SaveRecipeDialog controller={controller} close={close} /></Suspense>;
  controller.panels.push(() => <RecipesPanelHost controller={controller} />);
  controller.recipeMenu = () => {
    const session = controller.session;
    const usable = !!session.document && session.canEditLayers && session.selectedLayerIds.size > 0;
    const recipes = recipeLibrary(controller).getState().recipes.filter((recipe) => recipe.steps.length > 0)
      .map((recipe): MenuEntry => ({ label: recipe.name, enabled: usable,
        run: () => void import('./actions').then(({ applyRecipeToSelection }) => applyRecipeToSelection(controller, recipe)) }));
    return [...recipes, ...(recipes.length ? ['separator' as const] : []),
      { label: t('Manage Recipes…'), enabled: true, run: () => showRecipesPanel(controller), testId: 'menu-manage-recipes' }];
  };
}
