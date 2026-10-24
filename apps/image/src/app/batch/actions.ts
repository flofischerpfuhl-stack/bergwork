/** Recipe commands shared by the Layer menu, the Recipes panel and File › Batch…. */

import { applyRecipeInSession, parseRecipe, recipeFileName, serializeRecipe, RECIPE_EXTENSION, type Recipe } from '../../core/recipes';
import type { FileTargetHost } from '../../platform/browserHost';
import type { EditorController } from '../../ui/controller';
import { addRecipe, markRecipeUsed } from './library';
import { batchJob } from './job';

/** Apply Recipe to the selected layers: one undo step; layers that could not take it are listed afterwards. */
export function applyRecipeToSelection(controller: EditorController, recipe: Recipe): void {
  const t = controller.t, session = controller.session;
  const result = applyRecipeInSession(session, [...session.selectedLayerIds], recipe);
  if (!result) return;
  markRecipeUsed(controller, recipe.id);
  if (!result.skipped.length) return;
  const names = result.skipped.map(({ id, reason }) => `${session.layer(id)?.name ?? '—'}: ${t(reason)}`);
  controller.alert(t(result.applied.length ? 'Some layers were not changed' : 'The recipe could not be applied.'), names.join('\n'));
}

/** Saves a recipe as `.fwrecipe` (save dialog where the host has one, else a download). */
export async function exportRecipeFile(controller: EditorController, recipe: Recipe): Promise<void> {
  const name = recipeFileName(recipe);
  const blob = new Blob([serializeRecipe(recipe)], { type: 'application/json' });
  try {
    const files = controller.capabilities.files;
    if (files) {
      const target = await files.chooseSaveTarget(name, 'recipe');
      if (target) await files.writeFile(target, blob);
      return;
    }
    await (controller.host as FileTargetHost).saveFile(blob, name);
  } catch (error) { controller.reportError('recipe-export-failed', error); }
}

function pickRecipeFiles(): Promise<File[]> {
  return new Promise((resolve) => {
    const input = globalThis.document.createElement('input');
    input.type = 'file';
    input.accept = `.${RECIPE_EXTENSION},application/json`;
    input.multiple = true;
    input.style.display = 'none';
    let settled = false;
    const finish = (files: File[]) => { if (settled) return; settled = true; input.remove(); resolve(files); };
    input.addEventListener('change', () => finish([...(input.files ?? [])]));
    input.addEventListener('cancel', () => finish([]));
    globalThis.document.body.append(input);
    input.click();
  });
}

/** Import… : reads `.fwrecipe` files into the library; a damaged file is reported by name, the others are kept. */
export async function importRecipeFiles(controller: EditorController, files?: readonly File[]): Promise<number> {
  const t = controller.t;
  const chosen = files ?? await pickRecipeFiles();
  const failures: string[] = [];
  let imported = 0;
  for (const file of chosen) {
    try { addRecipe(controller, parseRecipe(await file.text())); imported++; }
    catch (error) { failures.push(`${file.name}: ${t(error instanceof Error ? error.message : String(error))}`); }
  }
  if (failures.length) controller.alert(t('The recipe could not be imported'), failures.join('\n'));
  return imported;
}

/** Apply to Files… : File › Batch… with this recipe chosen. */
export function openBatchWith(controller: EditorController, recipeId: string): void {
  const job = batchJob(controller);
  if (!job.getState().running) job.setState({ recipeId });
  markRecipeUsed(controller, recipeId);
  controller.showDialog({ kind: 'custom', name: 'batch' });
}
