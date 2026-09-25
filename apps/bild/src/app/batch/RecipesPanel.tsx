/**
 * The Recipes panel (PRODUCT-PLAN 6.9 „kleines Panel“): a movable, non-modal panel like the adjustment panels, opened
 * with Layer › Apply Recipe › Manage Recipes… and after Save Recipe…. It lists the saved recipes; Save Recipe… and
 * Import… on top; for the selected recipe Apply (to the selected layers, one undo step), Apply to Files… (File ›
 * Batch… with it), Export… (`.fwrecipe`) and Delete. Double-clicking a name renames it.
 */

import { useState } from 'react';
import { useStore } from 'zustand';
import styles from '../../ui/editor.module.css';
import css from './batch.module.css';
import type { EditorController } from '../../ui/controller';
import { useSession } from '../../ui/hooks';
import { Icon } from '../../ui/icons';
import { applyRecipeToSelection, exportRecipeFile, importRecipeFiles, openBatchWith } from './actions';
import { deleteRecipe, recipeLibrary, renameRecipe, showRecipesPanel } from './library';
import { FloatingPanel } from '../panels';
import { recipeSummary } from './describe';

export function RecipesPanel({ controller }: { controller: EditorController }) {
  const t = controller.t;
  const session = useSession(controller.session);
  const { recipes, lastUsedId, storageFailed, panelOpen } = useStore(recipeLibrary(controller));
  const [selectedId, setSelectedId] = useState<string | null>(lastUsedId);
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null);
  const selected = recipes.find((recipe) => recipe.id === selectedId) ?? recipes.at(-1) ?? null;
  const canApply = !!selected?.steps.length && !!session.document && session.canEditLayers && session.selectedLayerIds.size > 0;
  const commitRename = () => {
    if (renaming) renameRecipe(controller, renaming.id, renaming.value);
    setRenaming(null);
  };

  if (!panelOpen) return null;
  return (
    <FloatingPanel name="recipes" title={t('Recipes')} testId="recipes-panel" className={css.recipesPanel} closeLabel={t('Close')}
      onClose={() => showRecipesPanel(controller, false)}>
      <div className={css.panelTools}>
        <button type="button" className={styles.pill} disabled={!controller.features.saveRecipe?.enabled()} data-testid="recipes-save"
          onClick={() => controller.features.saveRecipe?.run()}>{t('Save Recipe…')}</button>
        <span className={css.spacer} />
        <button type="button" className={styles.pill} data-testid="recipes-import" onClick={() => void importRecipeFiles(controller)}>{t('Import…')}</button>
      </div>
      {recipes.length ? (
        <ul className={css.list} aria-label={t('Recipes')}>
          {recipes.map((recipe) => (
            <li key={recipe.id}>
              {renaming?.id === recipe.id ? (
                <div className={`${css.recipe} ${css.recipeSelected}`}>
                  <input className={css.renameInput} autoFocus value={renaming.value} aria-label={t('Name')} data-testid="recipe-rename"
                    onChange={(e) => setRenaming({ id: recipe.id, value: e.target.value })} onBlur={commitRename}
                    onKeyDown={(e) => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setRenaming(null); }} />
                  <span className={css.recipeMeta}>{recipeSummary(controller, recipe)}</span>
                </div>
              ) : (
                <button type="button" className={`${css.recipe} ${selected?.id === recipe.id ? css.recipeSelected : ''}`} data-testid="recipe-row"
                  aria-pressed={selected?.id === recipe.id} title={t('Double-click to rename')}
                  onClick={() => setSelectedId(recipe.id)} onDoubleClick={() => setRenaming({ id: recipe.id, value: recipe.name })}>
                  <span className={css.recipeName}>{recipe.name}</span>
                  <span className={css.recipeMeta}>{recipeSummary(controller, recipe)}</span>
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <div className={css.empty}>
          <span className={css.emptyTitle}>{t('No recipes yet')}</span>
          <p className={styles.panelNote}>{t('Save the adjustments, filters and layer style of a layer as a recipe, then apply it to other layers or files.')}</p>
        </div>
      )}
      {selected ? (
        <div className={css.footer}>
          <div className={css.footerRow}>
            <button type="button" className={`${styles.pill} ${styles.pillPrimary}`} disabled={!canApply} title={t('Apply to selected layers')}
              data-testid="recipe-apply" onClick={() => applyRecipeToSelection(controller, selected)}>{t('Apply')}</button>
            <button type="button" className={styles.pill} data-testid="recipe-batch" disabled={!controller.workspace.canSwitch}
              onClick={() => openBatchWith(controller, selected.id)}>{t('Apply to Files…')}</button>
          </div>
          <div className={css.footerRow}>
            <button type="button" className={styles.pill} data-testid="recipe-export-file"
              onClick={() => void exportRecipeFile(controller, selected)}>{t('Export…')}</button>
            <span className={css.spacer} />
            <button type="button" className={styles.iconButton} aria-label={t('Delete')} title={t('Delete')} data-testid="recipe-delete"
              onClick={() => deleteRecipe(controller, selected.id)}><Icon name="trash" size={16} /></button>
          </div>
          {!canApply && selected.steps.length > 0 && !!session.document && session.selectedLayerIds.size === 0
            ? <p className={css.footerNote}>{t('Select layers to apply a recipe.')}</p> : null}
          {storageFailed ? <p className={css.footerNote}>{t('The recipe library could not be stored. It stays available until the app is closed.')}</p> : null}
        </div>
      ) : null}
    </FloatingPanel>
  );
}
